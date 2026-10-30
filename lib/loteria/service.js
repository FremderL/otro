'use strict';

// Servicio compartido de Lotería mexicana: UNA partida para todo el casino,
// con inscripción de 60 s, canto automático y bote común (ver docs/loteria.md).
//
// Dinero: los saldos solo se tocan a través del ProfileStore en memoria
// (debit/credit/recordOutcome de lib/progression.js), nunca con un segundo
// escritor en SQL — por eso el antiguo adaptador transaccional quedó retirado.
// Cada movimiento lleva una clave de operación determinista que queda marcada
// en el propio perfil (`appliedChipOperations`): repetir un cobro o un pago
// tras un reinicio es un no-op.
//
// Diario: antes de mover fichas se guarda el estado de la partida en el
// almacén de lotería (lib/loteria/store.js); después se confirman los perfiles
// (`saveNow`) y al final se marca el movimiento como aplicado en el diario.
// Si el proceso cae entre pasos, el siguiente `tick()` (que también es la
// recuperación de arranque) encuentra el trabajo a medias y lo reintenta sin
// duplicar importes. La partida avanza por reloj (lib/loteria/game.js), así
// que un reinicio en pleno canto reanuda la partida donde el reloj diga.
const { randomUUID, createHash } = require('node:crypto');
const Game = require('./game');
const { cleanLoteriaState } = require('./store');
const { debit, credit, recordWager, recordOutcome } = require('../progression');

const DEFAULT_INTERMISSION_MS = 12_000;
const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{8,100}$/;

function operationKey(kind, gameId, profileId, requestId) {
  const digest = createHash('sha256')
    .update(JSON.stringify([String(gameId), String(profileId), String(requestId || '')]))
    .digest('hex');
  return `loteria:${kind}:${digest}`;
}

function operationApplied(profile, operationId) {
  if (!profile || !operationId) return false;
  return (Array.isArray(profile.appliedChipOperations) && profile.appliedChipOperations.includes(operationId))
    || (Array.isArray(profile.transactions) && profile.transactions.some(item => item?.operationId === operationId));
}

const JOIN_ERRORS = {
  closed: 'La inscripción de esta partida ya cerró. Espera a la siguiente.',
  full: 'Esta partida ya llegó a 100 cartones. Espera a la siguiente.',
  duplicate: 'Ya tienes un cartón en esta partida.',
  profile: 'No pudimos confirmar tu perfil para inscribirte.'
};

class LoteriaService {
  constructor({
    store, profiles, now = () => Date.now(), random,
    registrationMs, callIntervalMs,
    intermissionMs = DEFAULT_INTERMISSION_MS,
    onState = () => {}, onProfileEvents = () => {}, log = () => {}
  } = {}) {
    if (!store?.getState) throw new TypeError('LoteriaService requiere un almacén de lotería');
    if (!profiles) throw new TypeError('LoteriaService requiere el ProfileStore');
    this.store = store;
    this.profiles = profiles;
    this.now = now;
    this.random = random;
    this.registrationMs = registrationMs;
    this.callIntervalMs = callIntervalMs;
    this.intermissionMs = Number.isSafeInteger(intermissionMs) && intermissionMs >= 0 ? intermissionMs : DEFAULT_INTERMISSION_MS;
    this.onState = onState;
    this.onProfileEvents = onProfileEvents;
    this.log = log;
    this.state = null;
    this._tail = Promise.resolve();
  }

  // Carga el diario SIN mover fichas: permite consultar hasOpenStake() para la
  // puerta del reset mensual antes de que ensureSeason() corra en el arranque.
  load() {
    this.state = cleanLoteriaState(this.store.getState());
    return this.state;
  }

  // Recuperación de arranque: reaplica lo pendiente y reanuda la partida.
  async recover() {
    if (!this.state) this.load();
    await this.tick();
    const game = this.state.game;
    this.log('loteria_recovered', {
      game: game?.id || null, status: game?.status || null,
      players: game?.players?.length || 0, pendingRefunds: this.state.pendingRefunds.length
    });
  }

  serialize() { return this.state; }

  snapshotFor(profileId) {
    const game = this.state?.game || null;
    return {
      serverNow: this.now(),
      nextGameAt: this.state?.nextGameAt ?? null,
      game: game ? Game.publicState(game, typeof profileId === 'string' ? profileId : '') : null
    };
  }

  // ¿Hay fichas de alguien comprometidas ahora mismo? Lo consulta la puerta
  // del cierre mensual para no reiniciar saldos a mitad de una partida.
  hasOpenStake() {
    if (!this.state) return false;
    if (this.state.pendingRefunds.length) return true;
    const game = this.state.game;
    if (!game) return false;
    if (game.status === 'calling') return true;
    if (game.status === 'registration') return game.players.length > 0;
    return !game.paymentsApplied; // settled/cancelled aún sin pagar
  }

  join(profile, requestId) { return this._enqueue(() => this._join(profile, requestId)); }
  leave(profileId) { return this._enqueue(() => this._leave(profileId)); }
  handleDisconnect(profileId) { return this._enqueue(() => this._leave(profileId, { disconnect: true })); }
  tick() { return this._enqueue(() => this._tick()); }

  // Todas las operaciones comparten una sola partida: se serializan para que
  // dos inscripciones simultáneas (o un tick a mitad de un pago) no se pisen.
  _enqueue(work) {
    const run = this._tail.then(work, work);
    this._tail = run.catch(error => {
      this.log('loteria_error', { message: String(error?.message || error) });
    });
    return run;
  }

  _profile(profileId) {
    if (!profileId) return null;
    if (typeof this.profiles.getProfile === 'function') return this.profiles.getProfile(profileId);
    return this.profiles.profiles?.get(profileId) || null;
  }

  async _persist() {
    await this.store.saveNow(this.state);
  }

  _openNext(carry, now) {
    this.state.game = Game.newGame({
      id: randomUUID(), openedAt: now, carry, random: this.random,
      registrationMs: this.registrationMs, callIntervalMs: this.callIntervalMs
    });
    this.state.game.refundedRequestIds = [];
    this.state.game.paymentsApplied = false;
    this.state.nextGameAt = null;
    return this.state.game;
  }

  // Abre la primera partida o la siguiente cuando termina el intermedio.
  // Devuelve true si el estado cambió.
  _ensureGame(now) {
    const game = this.state.game;
    if (!game) { this._openNext(0, now); return true; }
    const terminal = game.status === 'settled' || game.status === 'cancelled';
    if (terminal && game.paymentsApplied && this.state.nextGameAt !== null && now >= this.state.nextGameAt) {
      this._openNext(game.result?.carry || 0, now);
      return true;
    }
    return false;
  }

  async _join(profile, requestId) {
    if (!profile?.id) return { ok: false, code: 'profile', error: JOIN_ERRORS.profile };
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
      return { ok: false, code: 'request_id', error: 'Falta el identificador de tu inscripción; vuelve a intentarlo.' };
    }
    const now = this.now();
    if (this._ensureGame(now)) await this._persist();
    const game = this.state.game;
    if (!game || game.status !== 'registration' || now >= game.closesAt) {
      return { ok: false, code: 'closed', error: JOIN_ERRORS.closed };
    }
    const existing = game.players.find(player => player.profileId === profile.id);
    if (existing) {
      if (existing.requestId === requestId) {
        // Reintento de la misma inscripción (doble clic, reconexión…): se
        // confirma la entrada si faltaba y se devuelve el mismo cartón.
        if (!existing.entryApplied && await this._applyEntry(game, existing)) {
          existing.entryApplied = true;
          await this._persist();
        }
        return { ok: true, code: 'already_joined', state: this.snapshotFor(profile.id) };
      }
      return { ok: false, code: 'duplicate', error: JOIN_ERRORS.duplicate };
    }
    if ((game.refundedRequestIds || []).includes(requestId)) {
      return { ok: false, code: 'cancelled_request', error: 'Esa inscripción ya fue cancelada y reembolsada; pulsa de nuevo para comprar otro cartón.' };
    }
    if (!Number.isSafeInteger(profile.chips) || profile.chips < Game.ENTRY_COST) {
      return { ok: false, code: 'insufficient_funds', error: `Necesitas ${Game.ENTRY_COST} fichas virtuales para comprar tu cartón.` };
    }
    const joined = Game.join(game, profile.id, now, this.random);
    if (!joined.ok) return { ok: false, code: joined.reason, error: JOIN_ERRORS[joined.reason] || JOIN_ERRORS.closed };
    const player = game.players.find(item => item.profileId === profile.id);
    player.requestId = requestId;
    player.entryApplied = false;
    player.paymentApplied = false;
    await this._persist(); // diario primero: el cartón existe antes del cobro
    if (!await this._applyEntry(game, player)) {
      // El saldo cambió entre la comprobación y el cobro: se retira el cartón
      // sin cargos (nunca se llegó a debitar).
      game.players = game.players.filter(item => item.profileId !== profile.id);
      await this._persist();
      return { ok: false, code: 'insufficient_funds', error: `Necesitas ${Game.ENTRY_COST} fichas virtuales para comprar tu cartón.` };
    }
    player.entryApplied = true;
    await this._persist();
    this.log('loteria_joined', { game: game.id, players: game.players.length });
    this.onState();
    return { ok: true, code: 'joined', state: this.snapshotFor(profile.id) };
  }

  // Cobra la entrada de forma idempotente y confirma el perfil en disco.
  // Devuelve false solo si el cobro no puede hacerse (saldo o perfil).
  async _applyEntry(game, player) {
    const profile = this._profile(player.profileId);
    if (!profile) return false;
    const operationId = operationKey('entry', game.id, player.profileId, player.requestId);
    const result = debit(profile, Game.ENTRY_COST, 'Entrada de lotería', { operationId });
    if (!result.ok) return false;
    if (!result.replayed && result.amount > 0) {
      const events = recordWager(profile, Game.ENTRY_COST);
      if (events.length) this.onProfileEvents(profile, events);
    }
    this.profiles.touch(profile);
    await this.profiles.saveNow();
    return true;
  }

  async _leave(profileId, { disconnect = false } = {}) {
    const game = this.state?.game;
    if (!game || !profileId) return { ok: false, code: 'not_joined', error: 'No tienes un cartón en esta partida.' };
    const player = game.players.find(item => item.profileId === profileId);
    if (!player) return { ok: false, code: 'not_joined', error: 'No tienes un cartón en esta partida.' };
    const result = Game.disconnect(game, profileId, this.now());
    if (!result.ok) {
      return {
        ok: false, code: result.reason,
        error: result.reason === 'already_started'
          ? 'La partida ya empezó: tu cartón sigue participando con marcado automático.'
          : 'No tienes un cartón en esta partida.'
      };
    }
    game.refundedRequestIds = [...(game.refundedRequestIds || []), player.requestId].filter(Boolean).slice(-200);
    // Tras un reinicio, el cobro puede estar marcado ya en el perfil aunque el
    // diario aún no lo confirme: en ese caso el reembolso también procede.
    const profile = this._profile(profileId);
    const charged = player.entryApplied
      || operationApplied(profile, operationKey('entry', game.id, profileId, player.requestId));
    if (charged) {
      this.state.pendingRefunds.push({
        gameId: game.id, profileId, requestId: player.requestId || '', amount: result.refund
      });
    }
    await this._persist(); // el reembolso queda en el diario antes de pagarlo
    try {
      await this._applyPendingRefunds();
    } catch (error) {
      // El diario garantiza el reembolso aunque este intento falle (p. ej.
      // Postgres no responde): se reintentará en el siguiente tick.
      this.log('loteria_refund_deferred', { game: game.id, message: String(error?.message || error) });
    }
    this.log('loteria_left', { game: game.id, disconnect, players: game.players.length });
    this.onState();
    return { ok: true, code: disconnect ? 'disconnected_refunded' : 'left_refunded', state: this.snapshotFor(profileId) };
  }

  async _applyPendingRefunds() {
    if (!this.state.pendingRefunds.length) return;
    const notifications = [];
    let touched = false;
    for (const refund of this.state.pendingRefunds) {
      const profile = this._profile(refund.profileId);
      if (!profile) {
        // Perfil borrado (p. ej. depuración de cuentas inactivas): no hay a
        // quién devolverle las fichas; se descarta para no bloquear la cola.
        this.log('loteria_refund_skipped_missing_profile', { game: refund.gameId });
        continue;
      }
      // Un asiento rescatado de un diario dañado solo se paga si el perfil
      // trae la marca del cobro original: sin ella, «reembolsar» crearía
      // fichas que nunca se cobraron.
      if (refund.salvaged
        && !operationApplied(profile, operationKey('entry', refund.gameId, refund.profileId, refund.requestId))) {
        this.log('loteria_salvaged_refund_skipped_uncharged', { game: refund.gameId });
        continue;
      }
      const operationId = operationKey('refund', refund.gameId, refund.profileId, refund.requestId);
      const applied = operationApplied(profile, operationId)
        ? 0 : credit(profile, refund.amount, 'Reembolso de lotería', { operationId });
      this.profiles.touch(profile);
      touched = true;
      if (applied > 0) notifications.push([profile, [{ type: 'loteria_refund', amount: applied }]]);
    }
    if (touched) await this.profiles.saveNow(); // primero el saldo confirmado…
    this.state.pendingRefunds = [];
    await this._persist(); // …después se cierra el asiento en el diario
    for (const [profile, events] of notifications) this.onProfileEvents(profile, events);
  }

  async _applyPayments(game) {
    const notifications = [];
    let touched = false;
    const ordered = [...game.players].sort((a, b) => a.profileId.localeCompare(b.profileId));
    if (game.status === 'settled') {
      const payoutById = new Map((game.result?.winners || []).map(item => [item.profileId, item.amount]));
      for (const player of ordered) {
        if (player.paymentApplied) continue;
        const profile = this._profile(player.profileId);
        if (!profile) {
          player.paymentApplied = true;
          this.log('loteria_payment_skipped_missing_profile', { game: game.id });
          continue;
        }
        const payout = payoutById.get(player.profileId) || 0;
        const operationId = operationKey('outcome', game.id, player.profileId, player.requestId);
        if (!operationApplied(profile, operationId)) {
          // Mismo patrón que las apuestas del Estadio: fichas en crudo +
          // recordOutcome (nunca credit(), que duplicaría el historial).
          // Ambas mutaciones son síncronas sobre el perfil: el snapshot que
          // se guarda después las confirma o ninguna.
          if (payout > 0) profile.chips += payout;
          const events = recordOutcome(profile, {
            game: 'loteria', net: payout - Game.ENTRY_COST, eligible: true,
            roundId: `loteria:${game.id}`, operationId
          });
          this.profiles.touch(profile);
          touched = true;
          const personal = [...events];
          if (payout > 0) personal.push({ type: 'loteria_prize', amount: payout, pot: game.result.pot, gameId: game.id });
          if (personal.length) notifications.push([profile, personal]);
        }
        player.paymentApplied = true;
      }
      this.log('loteria_settled', {
        game: game.id, players: game.players.length, pot: game.result?.pot || 0,
        winners: game.result?.winners?.length || 0, carry: game.result?.carry || 0
      });
    } else if (game.status === 'cancelled') {
      const refundById = new Map((game.result?.refunds || []).map(item => [item.profileId, item.amount]));
      for (const player of ordered) {
        if (player.paymentApplied) continue;
        const amount = refundById.get(player.profileId) || 0;
        const profile = this._profile(player.profileId);
        if (profile && amount > 0) {
          const operationId = operationKey('refund', game.id, player.profileId, player.requestId);
          const applied = operationApplied(profile, operationId)
            ? 0 : credit(profile, amount, 'Reembolso de lotería: partida cancelada', { operationId });
          this.profiles.touch(profile);
          touched = true;
          if (applied > 0) notifications.push([profile, [{ type: 'loteria_refund', amount: applied, cancelled: true }]]);
        } else if (!profile) {
          this.log('loteria_payment_skipped_missing_profile', { game: game.id });
        }
        player.paymentApplied = true;
      }
      // El ciclo compartido abre partidas aunque no haya nadie: solo se
      // registra la cancelación cuando alguien tenía fichas dentro.
      if (game.players.length) this.log('loteria_cancelled', { game: game.id, players: game.players.length, carry: game.result?.carry || 0 });
    }
    if (touched) await this.profiles.saveNow(); // saldos confirmados antes de avisar
    for (const [profile, events] of notifications) this.onProfileEvents(profile, events);
  }

  // Reconcilia entradas cuyo cobro quedó a medias (reinicio entre el diario y
  // la confirmación del perfil). Devuelve true si el estado cambió.
  async _reconcileEntries(game) {
    let changed = false;
    for (const player of [...game.players]) {
      if (player.entryApplied) continue;
      if (await this._applyEntry(game, player)) {
        player.entryApplied = true;
        changed = true;
      } else if (game.status === 'registration') {
        // Aún no cierra la inscripción y nunca se cobró: fuera sin cargos.
        game.players = game.players.filter(item => item.profileId !== player.profileId);
        changed = true;
      } else {
        // La partida ya arrancó con este cartón dentro y el cobro es
        // imposible (p. ej. perfil borrado): se deja constancia y se sigue;
        // su premio, si lo hubiera, también se omitirá por falta de perfil.
        player.entryApplied = true;
        changed = true;
        this.log('loteria_entry_unpayable', { game: game.id });
      }
    }
    return changed;
  }

  async _tick() {
    if (!this.state) this.load();
    const now = this.now();
    let changed = false;
    if (this.state.pendingRefunds.length) {
      await this._applyPendingRefunds();
      changed = true;
    }
    if (this._ensureGame(now)) {
      await this._persist();
      changed = true;
    }
    const game = this.state.game;
    if (!game) {
      if (changed) this.onState();
      return changed;
    }
    if (await this._reconcileEntries(game)) {
      await this._persist();
      changed = true;
    }
    const events = Game.advance(game, now);
    const terminal = events.find(event => event.type === 'settled' || event.type === 'cancelled');
    if (terminal) {
      this.state.nextGameAt = now + this.intermissionMs;
      await this._persist(); // el resultado queda en el diario antes de pagar
      await this._applyPayments(game);
      game.paymentsApplied = true;
      await this._persist();
      changed = true;
    } else if (events.length) {
      await this._persist();
      changed = true;
    } else if ((game.status === 'settled' || game.status === 'cancelled') && !game.paymentsApplied) {
      // Partida terminal recuperada sin pagar (caída entre el resultado y el pago).
      if (this.state.nextGameAt === null) this.state.nextGameAt = now + this.intermissionMs;
      await this._applyPayments(game);
      game.paymentsApplied = true;
      await this._persist();
      changed = true;
    }
    if (changed) this.onState();
    return changed;
  }
}

module.exports = { LoteriaService, operationKey, DEFAULT_INTERMISSION_MS };
