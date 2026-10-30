'use strict';

// Servicio de la Lotería mexicana: una sola partida compartida por todo el
// casino, con inscripción autenticada, canto automático y pagos exactos.
//
// Diseño (decisión acordada para recuperación): se reembolsa mientras el
// resultado no está confirmado y se paga el resultado ya confirmado. Cada
// movimiento de fichas se identifica con un `operationId` determinista y se
// apoya en `lib/progression.js`, que guarda esos identificadores dentro del
// propio perfil (`appliedChipOperations`). Así, repetir un movimiento nunca
// duplica saldo, aunque el proceso caiga entre el cobro y el guardado.
//
// Orden de escritura de cada transición:
//   1. Se persiste el estado de la ronda (jugador inscrito / resultado) en el
//      archivo JSON, ANTES de tocar los saldos.
//   2. Se anotan los movimientos en `pending` y se aplican con su operationId.
//   3. Se confirma el perfil (`persistProfile`) y solo entonces se retira el
//      movimiento de `pending`.
// Al arrancar, `recover()` termina lo que haya quedado a medias. El servicio
// asume un único proceso escritor (la instancia de Render del proyecto); no
// pretende coordinar varias réplicas sobre el mismo archivo.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const Game = require('./game');
const { credit, debit, recordWager, recordOutcome } = require('../progression');

const STATE_VERSION = 1;
const DEFAULT_BREAK_MS = 12_000;
const MAX_PENDING = 2_000;
const MAX_NAME = 18;
const AVATAR_RE = /^[a-z]{3,16}$/;

const STATUSES = new Set(['registration', 'calling', 'settled', 'cancelled']);

function operationId(kind, gameId, profileId, extra = '') {
  const digest = createHash('sha256').update(JSON.stringify([gameId, profileId, extra])).digest('hex');
  return `loteria:${kind}:${digest.slice(0, 40)}`;
}

function cleanDisplayName(value, fallback = 'Jugador') {
  const name = String(value == null ? '' : value).replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
  return name || fallback;
}

function cleanAvatar(value, fallback = 'fox') {
  const avatar = String(value || '').trim().toLowerCase();
  return AVATAR_RE.test(avatar) ? avatar : fallback;
}

function alreadyApplied(profile, id) {
  return Array.isArray(profile?.appliedChipOperations) && profile.appliedChipOperations.includes(id);
}

// Descarta un jugador o una partida corrupta en lugar de confiar en el archivo.
function normalizeBoard(raw) {
  if (!Array.isArray(raw) || raw.length !== Game.BOARD_SIZE) return null;
  const board = raw.map(Number);
  if (!board.every(number => Number.isInteger(number) && number >= 1 && number <= Game.CARD_COUNT)) return null;
  return new Set(board).size === Game.BOARD_SIZE ? board : null;
}

function normalizeGame(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!STATUSES.has(raw.status)) return null;
  if (!Number.isSafeInteger(raw.openedAt) || !Number.isSafeInteger(raw.closesAt)) return null;
  if (!Array.isArray(raw.deck) || raw.deck.length !== Game.CARD_COUNT) return null;
  const deck = raw.deck.map(Number);
  if (!deck.every(number => Number.isInteger(number) && number >= 1 && number <= Game.CARD_COUNT)) return null;
  if (new Set(deck).size !== Game.CARD_COUNT) return null;
  if (!Array.isArray(raw.called) || raw.called.length > Game.CARD_COUNT) return null;
  const called = raw.called.map(Number);
  if (!called.every(number => Number.isInteger(number) && number >= 1 && number <= Game.CARD_COUNT)) return null;
  const players = [];
  const seen = new Set();
  for (const player of Array.isArray(raw.players) ? raw.players : []) {
    if (!player || typeof player.profileId !== 'string' || !player.profileId || player.profileId.length > 80) continue;
    if (seen.has(player.profileId)) continue;
    const board = normalizeBoard(player.board);
    if (!board) continue;
    seen.add(player.profileId);
    players.push({
      profileId: player.profileId,
      board,
      name: cleanDisplayName(player.name),
      avatar: cleanAvatar(player.avatar),
      attempt: Math.max(1, Math.floor(Number(player.attempt) || 1)),
      joinedAt: Math.max(0, Number(player.joinedAt) || 0)
    });
  }
  const result = raw.result && typeof raw.result === 'object'
    ? {
      pot: Math.max(0, Math.floor(Number(raw.result.pot) || 0)),
      carry: Math.max(0, Math.floor(Number(raw.result.carry) || 0)),
      winners: Array.isArray(raw.result.winners)
        ? raw.result.winners
          .filter(winner => winner && typeof winner.profileId === 'string')
          .map(winner => ({ profileId: winner.profileId, amount: Math.max(0, Math.floor(Number(winner.amount) || 0)) }))
        : [],
      refunds: Array.isArray(raw.result.refunds)
        ? raw.result.refunds
          .filter(refund => refund && typeof refund.profileId === 'string')
          .map(refund => ({ profileId: refund.profileId, amount: Math.max(0, Math.floor(Number(refund.amount) || 0)) }))
        : []
    }
    : null;
  if (raw.status === 'settled' && (!result || !result.winners.length)) return null;
  if (raw.status !== 'registration' && raw.status !== 'calling' && !result) return null;
  const attempts = {};
  if (raw.entryAttempts && typeof raw.entryAttempts === 'object') {
    for (const [profileId, value] of Object.entries(raw.entryAttempts).slice(0, Game.MAX_PLAYERS * 2)) {
      const attempt = Math.floor(Number(value) || 0);
      if (profileId && attempt > 0) attempts[profileId.slice(0, 80)] = attempt;
    }
  }
  return {
    id: raw.id.slice(0, 80),
    openedAt: raw.openedAt,
    closesAt: raw.closesAt,
    registrationMs: Math.max(0, Math.floor(Number(raw.registrationMs) || Game.REGISTRATION_MS)),
    callIntervalMs: Math.max(1, Math.floor(Number(raw.callIntervalMs) || Game.CALL_INTERVAL_MS)),
    status: raw.status,
    carry: Math.max(0, Math.floor(Number(raw.carry) || 0)),
    players,
    deck,
    called,
    result,
    entryAttempts: attempts
  };
}

function normalizeMovement(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 160) return null;
  if (typeof raw.gameId !== 'string' || !raw.gameId) return null;
  if (typeof raw.profileId !== 'string' || !raw.profileId || raw.profileId.length > 80) return null;
  if (!['entry', 'refund', 'prize', 'round'].includes(raw.kind)) return null;
  const amount = Math.floor(Number(raw.amount) || 0);
  const net = Math.floor(Number(raw.net) || 0);
  if (raw.kind === 'round') {
    if (!Number.isSafeInteger(net)) return null;
  } else if (!Number.isSafeInteger(amount) || amount < 0) return null;
  return {
    id: raw.id,
    kind: raw.kind,
    gameId: raw.gameId.slice(0, 80),
    profileId: raw.profileId,
    amount: raw.kind === 'round' ? 0 : amount,
    net: raw.kind === 'round' ? net : 0,
    roundId: typeof raw.roundId === 'string' ? raw.roundId.slice(0, 160) : null
  };
}

class LoteriaService {
  constructor({
    profiles, statePath = null, now = () => Date.now(), random,
    log = () => {}, onProgress = () => {}, onStateChange = () => {},
    registrationMs = Game.REGISTRATION_MS, callIntervalMs = Game.CALL_INTERVAL_MS,
    breakMs = DEFAULT_BREAK_MS, tickMs = 1000
  } = {}) {
    if (!profiles || typeof profiles.getProfile !== 'function' || typeof profiles.touch !== 'function') {
      throw new TypeError('La Lotería requiere el almacén de perfiles del casino');
    }
    if (!Number.isSafeInteger(registrationMs) || registrationMs < 0) throw new TypeError('Inscripción inválida');
    if (!Number.isSafeInteger(callIntervalMs) || callIntervalMs < 1) throw new TypeError('Ritmo de canto inválido');
    if (!Number.isSafeInteger(breakMs) || breakMs < 0) throw new TypeError('Descanso inválido');
    this.profiles = profiles;
    this.statePath = statePath ? path.resolve(statePath) : null;
    this.now = now;
    this.random = random;
    this.log = log;
    this.onProgress = onProgress;
    this.onStateChange = onStateChange;
    this.registrationMs = registrationMs;
    this.callIntervalMs = callIntervalMs;
    this.breakMs = breakMs;
    this.tickMs = Math.max(50, tickMs);
    this.state = { version: STATE_VERSION, game: null, nextOpensAt: null, pending: [], updatedAt: 0 };
    this.chain = Promise.resolve();
    this.timer = null;
    this.started = false;
  }

  // ---------- Cola de operaciones ----------
  // Todo acceso de escritura pasa por aquí: la partida es única y compartida,
  // así que dos peticiones simultáneas nunca mutan el mismo estado a la vez.
  enqueue(work) {
    const run = this.chain.then(work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    this.load();
    await this.enqueue(async () => {
      await this.recover();
      await this.tick();
    });
    this.timer = setInterval(() => {
      this.enqueue(() => this.tick()).catch(error => this.log('loteria_tick_error', { message: String(error?.message || error) }));
    }, this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  // Espera a que la cola termine (pruebas y apagado ordenado).
  async drain() {
    await this.chain;
  }

  // ---------- Persistencia ----------
  load() {
    if (!this.statePath) return this.state;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const game = normalizeGame(raw?.game);
      const pending = (Array.isArray(raw?.pending) ? raw.pending : []).map(normalizeMovement).filter(Boolean).slice(-MAX_PENDING);
      this.state = {
        version: STATE_VERSION,
        game,
        nextOpensAt: Number.isSafeInteger(raw?.nextOpensAt) ? raw.nextOpensAt : null,
        pending,
        updatedAt: Math.max(0, Number(raw?.updatedAt) || 0)
      };
      this.log('loteria_state_loaded', { gameId: game?.id || null, status: game?.status || null, pending: pending.length });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('loteria_state_corrupt', { message: String(error?.message || error) });
        this.state = { version: STATE_VERSION, game: null, nextOpensAt: null, pending: [], updatedAt: 0 };
      }
    }
    return this.state;
  }

  save() {
    if (!this.statePath) return true;
    this.state.updatedAt = this.now();
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.state));
      fs.renameSync(temporary, this.statePath);
      return true;
    } catch (error) {
      this.log('loteria_state_save_failed', { message: String(error?.message || error) });
      return false;
    }
  }

  // ---------- Recuperación tras un reinicio ----------
  async recover() {
    // 1. Termina los movimientos cuya confirmación quedó pendiente.
    await this.flushPending();
    const game = this.state.game;
    if (!game) return;
    if (game.status === 'registration' || game.status === 'calling') {
      // 2. Cobra las entradas que quedaron anotadas sin confirmar (cobro
      //    idempotente: si ya se había aplicado, no se repite).
      for (const player of game.players) {
        const id = operationId('entry', game.id, player.profileId, player.attempt);
        if (alreadyApplied(this.profiles.getProfile(player.profileId), id)) continue;
        if (this.state.pending.some(movement => movement.id === id)) continue;
        this.state.pending.push({ id, kind: 'entry', gameId: game.id, profileId: player.profileId, amount: Game.ENTRY_COST, net: 0, roundId: null });
      }
      this.save();
      await this.flushPending();
      this.log('loteria_round_resumed', { gameId: game.id, status: game.status, players: game.players.length });
      return;
    }
    // 3. Una ronda ya resuelta vuelve a confirmar sus pagos (idempotentes).
    if (game.status === 'settled') this.prepareSettlement(game);
    if (game.status === 'cancelled') this.prepareCancellation(game);
    if (this.state.nextOpensAt == null) this.state.nextOpensAt = this.now() + this.breakMs;
    this.save();
    await this.flushPending();
    this.log('loteria_settlement_recovered', { gameId: game.id, status: game.status });
  }

  // ---------- Movimientos de fichas ----------
  // Devuelve { status: 'applied'|'replayed'|'failed'|'retry' }.
  async applyMovement(movement) {
    const profile = this.profiles.getProfile(movement.profileId);
    if (!profile) return { status: 'failed', reason: 'profile_missing' };
    // El marcador vive en el perfil, así que puede estar aplicado en memoria y
    // no confirmado en disco (un guardado que falló). Se vuelve a confirmar:
    // nunca se cobra ni se paga dos veces, pero sí se asegura la durabilidad.
    if (alreadyApplied(profile, movement.id)) {
      this.profiles.touch(profile);
      if (typeof this.profiles.persistProfile === 'function') {
        const persisted = await this.profiles.persistProfile(profile);
        if (persisted === false) return { status: 'retry' };
      }
      return { status: 'applied', replayed: true };
    }
    let changed = false;
    if (movement.kind === 'entry') {
      const result = debit(profile, movement.amount, 'Lotería mexicana: entrada', { operationId: movement.id });
      if (!result.ok) return { status: 'failed', reason: result.error || 'debit' };
      const events = recordWager(profile, result.amount);
      if (events.length) {
        try { this.onProgress(movement.profileId, events); } catch (_) { /* avisar no debe romper el cobro */ }
      }
      changed = true;
    } else if (movement.kind === 'prize') {
      const amount = credit(profile, movement.amount, 'Lotería mexicana: premio', { operationId: movement.id });
      changed = amount > 0;
    } else if (movement.kind === 'refund') {
      const amount = credit(profile, movement.amount, 'Lotería mexicana: entrada reembolsada', { operationId: movement.id });
      changed = amount > 0;
    } else if (movement.kind === 'round') {
      const events = recordOutcome(profile, {
        game: 'loteria',
        net: movement.net,
        eligible: true,
        roundId: movement.roundId || `loteria:${movement.gameId}`,
        passportEligible: false,
        operationId: movement.id
      });
      // Las estadísticas cambian incluso cuando no hay logros que anunciar:
      // el perfil siempre debe confirmarse para que el resultado no dependa del
      // guardado diferido del almacén.
      changed = true;
      if (events.length) {
        try { this.onProgress(movement.profileId, events); } catch (_) { /* avisar no debe romper el pago */ }
      }
    } else return { status: 'failed', reason: 'kind' };
    if (!changed) return { status: 'replayed' };
    this.profiles.touch(profile);
    if (typeof this.profiles.persistProfile === 'function') {
      const persisted = await this.profiles.persistProfile(profile);
      if (persisted === false) return { status: 'retry' };
    }
    return { status: 'applied' };
  }

  async flushPending() {
    if (!this.state.pending.length) return { applied: 0, retry: 0, failed: 0 };
    let applied = 0;
    let retry = 0;
    let failed = 0;
    const remaining = [];
    for (const movement of this.state.pending) {
      const result = await this.applyMovement(movement);
      if (result.status === 'retry') { remaining.push(movement); retry++; continue; }
      if (result.status === 'failed') {
        failed++;
        this.log('loteria_movement_failed', { kind: movement.kind, reason: result.reason, gameId: movement.gameId });
        continue;
      }
      applied++;
    }
    this.state.pending = remaining.slice(-MAX_PENDING);
    this.save();
    return { applied, retry, failed };
  }

  prepareSettlement(game) {
    const winners = game.result?.winners || [];
    const amounts = new Map(winners.map(winner => [winner.profileId, winner.amount]));
    for (const winner of winners) {
      const id = operationId('prize', game.id, winner.profileId, 'prize');
      if (!this.state.pending.some(movement => movement.id === id)) {
        this.state.pending.push({ id, kind: 'prize', gameId: game.id, profileId: winner.profileId, amount: winner.amount, net: 0, roundId: null });
      }
    }
    // Estadísticas para todos los participantes, ganen o no.
    for (const player of game.players) {
      const id = operationId('round', game.id, player.profileId, 'round');
      if (this.state.pending.some(movement => movement.id === id)) continue;
      this.state.pending.push({
        id, kind: 'round', gameId: game.id, profileId: player.profileId,
        amount: 0, net: (amounts.get(player.profileId) || 0) - Game.ENTRY_COST,
        roundId: `loteria:${game.id}`
      });
    }
    this.state.pending = this.state.pending.slice(-MAX_PENDING);
  }

  prepareCancellation(game) {
    for (const refund of game.result?.refunds || []) {
      const id = operationId('refund', game.id, refund.profileId, 'refund');
      if (this.state.pending.some(movement => movement.id === id)) continue;
      this.state.pending.push({ id, kind: 'refund', gameId: game.id, profileId: refund.profileId, amount: refund.amount, net: 0, roundId: null });
    }
    this.state.pending = this.state.pending.slice(-MAX_PENDING);
  }

  // ---------- Ciclo de la ronda ----------
  openRound(now, carry = null) {
    const previous = this.state.game;
    const nextCarry = carry == null ? Math.max(0, Math.floor(Number(previous?.result?.carry) || 0)) : carry;
    this.state.game = Game.newGame({
      id: randomUUID(), openedAt: now, carry: nextCarry, random: this.random,
      registrationMs: this.registrationMs, callIntervalMs: this.callIntervalMs
    });
    this.state.nextOpensAt = null;
    this.save();
    this.log('loteria_round_opened', { gameId: this.state.game.id, carry: nextCarry });
    return this.state.game;
  }

  ensureOpen(now = this.now()) {
    const game = this.state.game;
    if (!game) return this.openRound(now);
    if (['settled', 'cancelled'].includes(game.status) && (this.state.nextOpensAt == null || now >= this.state.nextOpensAt)) {
      return this.openRound(now);
    }
    return game;
  }

  async tick() {
    const now = this.now();
    let changed = false;
    const previousGameId = this.state.game?.id || null;
    this.ensureOpen(now);
    // Una ronda nueva debe anunciarse aunque todavía no se haya cantado nada.
    if ((this.state.game?.id || null) !== previousGameId) changed = true;
    const game = this.state.game;
    if (game && (game.status === 'registration' || game.status === 'calling')) {
      const events = Game.advance(game, now);
      if (events.length) {
        // El estado (resultado y reparto) se guarda antes de mover fichas.
        this.save();
        const terminal = events.find(event => event.type === 'settled' || event.type === 'cancelled');
        if (terminal) {
          await this.flushPending();
          if (terminal.type === 'settled') this.prepareSettlement(game);
          else this.prepareCancellation(game);
          this.save();
          await this.flushPending();
        }
        changed = true;
      }
    }
    const current = this.state.game;
    if (current && ['settled', 'cancelled'].includes(current.status)) {
      if (this.state.nextOpensAt == null) {
        this.state.nextOpensAt = now + this.breakMs;
        this.save();
        changed = true;
      } else if (now >= this.state.nextOpensAt) {
        this.openRound(now);
        changed = true;
      }
    }
    if (this.state.pending.length) {
      const flushed = await this.flushPending();
      if (flushed.applied || flushed.failed) changed = true;
    }
    if (changed) this.notify();
    return this.snapshotFor(null);
  }

  notify() {
    try { this.onStateChange(this.snapshotFor(null)); } catch (error) {
      this.log('loteria_notify_failed', { message: String(error?.message || error) });
    }
  }

  // ---------- Operaciones públicas ----------
  join(profileId, { name, avatar } = {}) {
    return this.enqueue(async () => {
      const now = this.now();
      this.ensureOpen(now);
      const game = this.state.game;
      const profile = this.profiles.getProfile(profileId);
      if (!profile) return { ok: false, code: 'profile', error: 'No encontramos tu perfil. Recarga la página.' };
      if (game.players.some(player => player.profileId === profileId)) {
        return { ok: false, code: 'already_joined', error: 'Ya tienes un cartón en esta ronda.', state: this.snapshotFor(profileId) };
      }
      if (game.status !== 'registration') {
        return { ok: false, code: 'closed', error: 'La inscripción de esta ronda ya cerró. Espera la siguiente.', state: this.snapshotFor(profileId) };
      }
      if (game.players.length >= Game.MAX_PLAYERS) {
        return { ok: false, code: 'full', error: `La ronda está llena (${Game.MAX_PLAYERS} cartones).`, state: this.snapshotFor(profileId) };
      }
      if (profile.chips < Game.ENTRY_COST) {
        return { ok: false, code: 'insufficient', error: `Necesitas ${Game.ENTRY_COST} fichas para entrar. Tienes ${profile.chips}.` };
      }
      const joined = Game.join(game, profileId, now, this.random);
      if (!joined.ok) {
        const messages = {
          closed: 'La inscripción de esta ronda ya cerró. Espera la siguiente.',
          duplicate: 'Ya tienes un cartón en esta ronda.',
          full: `La ronda está llena (${Game.MAX_PLAYERS} cartones).`,
          profile: 'No pudimos identificar tu perfil.'
        };
        return { ok: false, code: joined.reason, error: messages[joined.reason] || 'No pudimos inscribirte.' };
      }
      const attempt = Math.max(1, Math.floor(Number(game.entryAttempts?.[profileId]) || 0) + 1);
      game.entryAttempts = game.entryAttempts && typeof game.entryAttempts === 'object' ? game.entryAttempts : {};
      game.entryAttempts[profileId] = attempt;
      const player = game.players[game.players.length - 1];
      player.name = cleanDisplayName(name || profile.name);
      player.avatar = cleanAvatar(avatar, profile.avatar);
      player.attempt = attempt;
      player.joinedAt = now;
      const id = operationId('entry', game.id, profileId, attempt);
      this.state.pending.push({ id, kind: 'entry', gameId: game.id, profileId, amount: Game.ENTRY_COST, net: 0, roundId: null });
      this.save();
      const applied = await this.applyMovement({ id, kind: 'entry', gameId: game.id, profileId, amount: Game.ENTRY_COST, net: 0, roundId: null });
      if (applied.status === 'failed') {
        // Se deshace la inscripción: nadie paga una entrada que no se cobró.
        game.players = game.players.filter(entry => entry.profileId !== profileId);
        this.state.pending = this.state.pending.filter(movement => movement.id !== id);
        this.save();
        this.notify();
        const insufficient = applied.reason === 'saldo_insuficiente';
        return {
          ok: false,
          code: insufficient ? 'insufficient' : 'payment_failed',
          error: insufficient
            ? `Necesitas ${Game.ENTRY_COST} fichas para entrar. Tienes ${profile.chips}.`
            : 'No pudimos confirmar el cobro de la entrada. Inténtalo de nuevo.'
        };
      }
      if (applied.status === 'applied' || applied.status === 'replayed') {
        this.state.pending = this.state.pending.filter(movement => movement.id !== id);
        this.save();
      }
      // 'retry' deja el movimiento en `pending`: el cobro ya está en memoria y
      // se reintenta guardarlo en el siguiente ciclo, sin volver a cobrar.
      this.notify();
      return { ok: true, board: [...player.board], state: this.snapshotFor(profileId) };
    });
  }

  leave(profileId) {
    return this.enqueue(async () => {
      const game = this.state.game;
      if (!game) return { ok: false, code: 'no_game', error: 'Todavía no hay una ronda abierta.' };
      const player = game.players.find(entry => entry.profileId === profileId);
      if (!player) return { ok: false, code: 'not_joined', error: 'No tienes cartón en esta ronda.' };
      if (game.status !== 'registration') return { ok: false, code: 'already_started', error: 'La ronda ya empezó: tu cartón sigue jugando.' };
      const entryId = operationId('entry', game.id, profileId, player.attempt);
      const removed = Game.disconnect(game, profileId, this.now());
      if (!removed.ok) return { ok: false, code: removed.reason, error: 'No puedes salir de esta ronda.' };
      // Si el cobro nunca se confirmó en el perfil, no se devuelve nada: solo
      // se anula el movimiento pendiente para que no se cobre más tarde.
      const neverCharged = !alreadyApplied(this.profiles.getProfile(profileId), entryId);
      this.state.pending = this.state.pending.filter(movement => movement.id !== entryId);
      if (!neverCharged) {
        this.state.pending.push({
          id: operationId('refund', game.id, profileId, player.attempt),
          kind: 'refund', gameId: game.id, profileId, amount: removed.refund, net: 0, roundId: null
        });
      }
      this.save();
      await this.flushPending();
      this.notify();
      return { ok: true, refunded: !neverCharged, state: this.snapshotFor(profileId) };
    });
  }

  // ---------- Lectura ----------
  snapshotFor(profileId = null) {
    const now = this.now();
    const base = {
      enabled: true,
      serverNow: now,
      entryCost: Game.ENTRY_COST,
      minPlayers: Game.MIN_PLAYERS,
      maxPlayers: Game.MAX_PLAYERS,
      boardSize: Game.BOARD_SIZE,
      cardCount: Game.CARD_COUNT,
      registrationMs: this.registrationMs,
      callIntervalMs: this.callIntervalMs,
      nextOpensAt: this.state.nextOpensAt
    };
    const game = this.state.game;
    if (!game) return { ...base, game: null };
    const me = profileId ? game.players.find(player => player.profileId === profileId) || null : null;
    const publicView = Game.publicState(game, profileId || null);
    const names = new Map(game.players.map(player => [player.profileId, player.name]));
    const result = publicView.result
      ? {
        ...publicView.result,
        winners: (game.result?.winners || []).map(winner => ({
          name: names.get(winner.profileId) || 'Jugador', amount: winner.amount
        }))
      }
      : null;
    return {
      ...base,
      game: {
        id: game.id,
        status: game.status,
        openedAt: game.openedAt,
        closesAt: game.closesAt,
        count: game.players.length,
        pot: game.carry + Game.ENTRY_COST * game.players.length,
        carry: game.carry,
        called: [...game.called],
        board: me ? [...me.board] : null,
        joined: Boolean(me),
        players: game.players.map(player => ({ name: player.name, avatar: player.avatar })),
        result
      }
    };
  }

  youFor(profileId) {
    const profile = this.profiles.getProfile(profileId);
    if (!profile) return null;
    const game = this.state.game;
    const me = game ? game.players.find(player => player.profileId === profileId) : null;
    return {
      name: profile.name,
      avatar: profile.avatar,
      chips: profile.chips,
      joined: Boolean(me),
      board: me ? [...me.board] : null
    };
  }
}

module.exports = { LoteriaService, operationId, normalizeGame, cleanDisplayName, cleanAvatar, STATE_VERSION, DEFAULT_BREAK_MS };
