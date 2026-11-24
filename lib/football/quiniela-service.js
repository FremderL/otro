'use strict';

// Servicio operativo de la Quiniela (cierra el trabajo pendiente de
// docs/quiniela-traspasos.md §Quiniela): las reglas puras viven en quiniela.js y
// el diario PG aislado en quiniela-pg.js; AQUÍ se cablean de verdad:
//
//   · Diario persistente: `league.quiniela` ({ bank: { carry }, rounds }) viaja con
//     la liga en AMBOS backends del store (archivo: _serializeLeague; PG: columna
//     data JSONB de football_leagues), así no hace falta tabla nueva ni migración.
//   · Cartera real: entrada = debit() y premio/reembolso = credit() de
//     progression.js con operationId fijo por (season, jornada, perfil, clase).
//     Son idempotentes (appliedChipOperations + transactions), así que un crash
//     entre diario y cartera se repara con recover() sin pagar dos veces.
//   · Orden seguro de escritura: primero se persiste el boleto como
//     `pending_debit`, luego se debita y se confirma el perfil; recover() aplica
//     el débito pendiente y marca el boleto abierto. Nunca queda un boleto
//     gratis ni un débito sin boleto.
//   · Liquidación derive-not-accumulate: sweep() (barrido del scheduler) y
//     notifyMatch() (hook del motor al asentarse un partido) liquidan la jornada
//     cuando sus 8 partidos ya tienen resultado (o pospuesto sin resultado ⇒
//     reembolso). settleJornada es idempotente: un round ya asentado devuelve su
//     resultado guardado sin pagar de nuevo.
//   · Bote entre temporadas: `carry` vive en el STORE (store.quinielaCarry), no
//     en la liga. Guardarlo dentro de `league.quiniela` lo hacía desaparecer en
//     cada rotación de mes, y con él lo apostado por una jornada sin acertantes.
//   · Nada se queda sin liquidar al rotar el mes: sweep() y recover() recorren
//     también las temporadas cerradas con rondas abiertas. Antes, una jornada
//     pendiente en el mes que acababa de cerrarse quedaba congelada para siempre
//     (el boleto quedaba «open» y la entrada de 50 fichas no volvía ni pagaba).
//   · Privacidad: el resultado público del round nunca lleva profileIds.

const Rules = require('./quiniela');
const { debit, credit } = require('../progression');

const ENTRY_COST = Rules.ENTRY_COST;
const TICKET_STATUSES = new Set(['pending_debit', 'open', 'won', 'lost', 'refunded']);
const ROUND_STATUSES = new Set(['open', 'settled', 'cancelled']);

function operationId(season, jornada, profileId, kind) {
  return `quiniela:${season}:${jornada}:${profileId}:${kind}`;
}

// ¿El movimiento ya quedó asentado en el perfil? (mismo criterio que
// BettingService._applyTicketPayout: memoria + disco, nunca uno solo).
function isApplied(profile, op) {
  return Boolean(profile)
    && (Array.isArray(profile.appliedChipOperations) && profile.appliedChipOperations.includes(op))
    || (Array.isArray(profile.footballPendingPayments) && profile.footballPendingPayments.includes(op))
    || (Array.isArray(profile.transactions) && profile.transactions.some(t => t && t.operationId === op));
}

function publicTicket(ticket) {
  if (!ticket) return null;
  return {
    picks: ticket.picks.map(p => ({ matchId: p.matchId, pick: p.pick })),
    placedAt: ticket.placedAt,
    status: ticket.status === 'pending_debit' ? 'open' : ticket.status,
    payout: ticket.payout
  };
}

// El bote pertenece a la liga; el store es su única fuente de verdad. Las ligas
// viejas (o un archivo/PG anterior a este cambio) todavía traen `bank.carry`
// dentro de la temporada: se rescata una sola vez en el arranque para no perder
// el sobrante ya acumulado.
function storeCarry(store) {
  return Number.isFinite(store.quinielaCarry) && store.quinielaCarry > 0 ? Math.floor(store.quinielaCarry) : 0;
}

function legacyCarry(league) {
  const value = Number(league?.quiniela?.bank?.carry);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

class QuinielaService {
  constructor({ store, profiles, log = () => {}, now = () => Date.now(), enabled = true }) {
    if (!store) throw new Error('QuinielaService requiere el store de fútbol');
    if (!profiles) throw new Error('QuinielaService requiere el store de perfiles');
    this.store = store;
    this.profiles = profiles;
    this.log = log;
    this.now = now;
    this.enabled = Boolean(enabled);
  }

  // Diario dentro de la liga (se persiste con ella en archivo y PG).
  journalOf(league) {
    if (!league.quiniela || typeof league.quiniela !== 'object') {
      league.quiniela = { bank: { carry: 0 }, rounds: {} };
    }
    if (!league.quiniela.bank || !Number.isFinite(league.quiniela.bank.carry)) league.quiniela.bank = { carry: 0 };
    if (!league.quiniela.rounds || typeof league.quiniela.rounds !== 'object') league.quiniela.rounds = {};
    return league.quiniela;
  }

  _openRound(league, jornada) {
    const matches = Rules.jornadaMatches(league, jornada);
    if (!matches) return null;
    const journal = this.journalOf(league);
    const round = {
      season: league.seasonMonth,
      jornada,
      matchIds: matches.map(m => m.id).sort(),
      closesAt: Math.min(...matches.map(m => m.scheduledKickoffAt)),
      status: 'open',
      result: null,
      tickets: {}
    };
    journal.rounds[jornada] = round;
    return round;
  }

  // Jornadas con 8 partidos regulares; la próxima abierta es la primera cuyos 8
  // siguen programados y cuyo primer saque aún no ocurre.
  jornadasOf(league) {
    const seen = new Set();
    const out = [];
    for (const m of league?.calendar?.matches || []) {
      if (!m || m.desempate || seen.has(m.jornada)) continue;
      seen.add(m.jornada);
      const matches = Rules.jornadaMatches(league, m.jornada);
      if (matches) out.push({ jornada: m.jornada, matches, closesAt: Math.min(...matches.map(x => x.scheduledKickoffAt)) });
    }
    return out.sort((a, b) => a.jornada - b.jornada);
  }

  nextOpenJornada(league, now) {
    return this.jornadasOf(league).find(j => now < j.closesAt && j.matches.every(m => m.status === 'scheduled' && !m.autoRescheduledAt && !m.autoReschedulePending)) || null;
  }

  // Vista pública para la UI. `profileId` sólo añade SU boleto; el broadcast usa
  // publicSnapshot (sin boletos de nadie).
  snapshot(league, profileId = null, now = this.now()) {
    if (!league) return { available: false, season: null, jornada: null, closesAt: null, entryCost: ENTRY_COST, carry: 0, matches: [], myTicket: null, lastResult: null };
    const journal = this.journalOf(league);
    const next = this.nextOpenJornada(league, now);
    const last = Object.values(journal.rounds)
      .filter(r => r.status !== 'open' && r.result)
      .sort((a, b) => (b.result.settledAt || 0) - (a.result.settledAt || 0))[0] || null;
    const openRound = next ? (journal.rounds[next.jornada] || null) : null;
    return {
      available: Boolean(next),
      season: league.seasonMonth,
      jornada: next ? next.jornada : null,
      closesAt: next ? next.closesAt : null,
      entryCost: ENTRY_COST,
      carry: storeCarry(this.store),
      matches: next ? next.matches.map(m => ({ id: m.id, homeId: m.homeId, awayId: m.awayId, scheduledKickoffAt: m.scheduledKickoffAt })) : [],
      myTicket: (profileId && openRound && openRound.tickets[profileId]) ? publicTicket(openRound.tickets[profileId]) : null,
      lastResult: last ? { jornada: last.jornada, ...last.result } : null
    };
  }

  publicSnapshot(league, now = this.now()) {
    const s = this.snapshot(league, null, now);
    return { ...s, myTicket: null };
  }

  // Entrada de un boleto. Reintento idempotente: mismo perfil + mismos picks ⇒
  // devuelve el boleto original; picks distintos ⇒ already_entered.
  async enter({ league, jornada, profile, picks }) {
    if (!this.enabled) return { ok: false, code: 'unavailable' };
    if (!league || !profile || !profile.id) return { ok: false, code: 'no_identity' };
    if (!Number.isSafeInteger(jornada) || jornada < 1) return { ok: false, code: 'invalid_round' };
    const season = league.seasonMonth;
    const journal = this.journalOf(league);
    const existingRound = journal.rounds[jornada];
    const existing = existingRound && existingRound.tickets[profile.id];
    if (existing) {
      const same = Array.isArray(picks) && picks.length === existing.picks.length
        && existing.picks.every(p => picks.some(x => x && x.matchId === p.matchId && x.pick === p.pick));
      return same
        ? { ok: true, replayed: true, ticket: publicTicket(existing) }
        : { ok: false, code: 'already_entered' };
    }
    const checked = Rules.validateEntry(league, jornada, picks, false, this.now());
    if (!checked.ok) return { ok: false, code: checked.code };
    // Fail-closed ANTES de tocar el diario: sin saldo no hay boleto.
    if (profile.chips < checked.stake) return { ok: false, code: 'saldo_insuficiente' };

    const round = existingRound || this._openRound(league, jornada);
    if (!round) return { ok: false, code: 'invalid_round' };
    if (round.status !== 'open') return { ok: false, code: 'closed' };
    // El round debe corresponder exactamente a la jornada vigente.
    const matches = Rules.jornadaMatches(league, jornada);
    if (JSON.stringify(round.matchIds) !== JSON.stringify(matches.map(m => m.id).sort())) return { ok: false, code: 'round_changed' };

    // 1) Persiste el boleto como pendiente de débito (write-through del diario).
    const ticket = { profileId: profile.id, picks: checked.picks, placedAt: this.now(), status: 'pending_debit', payout: 0 };
    round.tickets[profile.id] = ticket;
    if (!await this.store.saveStrict()) {
      delete round.tickets[profile.id];
      return { ok: false, code: 'save_pending' };
    }
    // 2) Débito idempotente de la entrada.
    const debited = debit(profile, checked.stake, `Entrada quiniela ${season} J${jornada}`, { operationId: operationId(season, jornada, profile.id, 'entry') });
    if (!debited.ok) {
      ticket.status = 'refunded';
      ticket.payout = 0;
      await this.store.saveStrict();
      return { ok: false, code: debited.error || 'debit_failed' };
    }
    ticket.status = 'open';
    // 3) Confirma el perfil (el débito ya quedó asentado por operationId).
    const persisted = await this.profiles.persistProfile(profile);
    if (!await this.store.saveStrict()) {
      return { ok: false, code: 'save_pending', ticket: publicTicket(ticket) };
    }
    if (!persisted) {
      // recover() aplicará el débito pendiente; el boleto ya quedó asentado.
      return { ok: false, code: 'save_pending', ticket: publicTicket(ticket) };
    }
    // Sin profileId en la telemetría (mismo convenio que football_bet_placed).
    this.log('football_quiniela_entry', { season, jornada, stake: checked.stake });
    return { ok: true, ticket: publicTicket(ticket), chips: profile.chips };
  }

  // Liquida una jornada abierta cuando sus 8 partidos ya tienen estado terminal.
  // Idempotente: los pagos llevan operationId y un round asentado no se repaga.
  async settleJornada(league, jornada) {
    if (!this.enabled) return { status: 'skipped' };
    const journal = this.journalOf(league);
    const round = journal.rounds[jornada];
    if (!round) return { status: 'empty' };
    if (round.status !== 'open') return { ...(round.result || { status: round.status }), alreadySettled: true };
    const matches = Rules.jornadaMatches(league, jornada);
    if (!matches || JSON.stringify(round.matchIds) !== JSON.stringify(matches.map(m => m.id).sort())) return { status: 'invalid' };

    const entries = Object.values(round.tickets).filter(t => TICKET_STATUSES.has(t.status) && t.status !== 'pending_debit');
    const outcome = Rules.evaluate(league, jornada, entries.map(t => ({ profileId: t.profileId, picks: t.picks })), storeCarry(this.store));
    if (outcome.status !== 'settled' && outcome.status !== 'cancelled') return outcome;

    const awards = new Map((outcome.status === 'settled' ? outcome.winners : outcome.refunds).map(x => [x.profileId, x.amount]));
    let touchedProfiles = 0;
    for (const ticket of Object.values(round.tickets)) {
      const amount = awards.get(ticket.profileId) || 0;
      ticket.status = outcome.status === 'cancelled' ? 'refunded' : (amount > 0 ? 'won' : 'lost');
      ticket.payout = amount;
      if (amount <= 0) continue;
      const profile = this.profiles.getProfile(ticket.profileId);
      if (!profile) continue;
      const kind = outcome.status === 'cancelled' ? 'refund' : 'prize';
      credit(profile, amount, `${kind === 'refund' ? 'Reembolso' : 'Premio'} quiniela ${league.seasonMonth} J${jornada}`, { operationId: operationId(league.seasonMonth, jornada, ticket.profileId, kind) });
      if (await this.profiles.persistProfile(profile)) touchedProfiles++;
    }
    this.store.quinielaCarry = outcome.carry;
    round.status = outcome.status;
    round.result = {
      status: outcome.status,
      pot: outcome.pot ?? null,
      winners: outcome.winners ? outcome.winners.length : 0,
      carry: outcome.carry,
      entries: entries.length,
      settledAt: this.now()
    };
    const saved = await this.store.saveStrict();
    if (!saved) this.log('football_quiniela_settle_save_error', { season: league.seasonMonth, jornada });
    this.log('football_quiniela_settled', {
      season: league.seasonMonth, jornada, status: outcome.status,
      pot: round.result.pot, winners: round.result.winners, entries: round.result.entries, carry: outcome.carry, profilesTouched: touchedProfiles
    });
    return round.result;
  }

  async refundMatchObligations(match, reason = 'partido cerrado sin resultado') {
    if (!match || match.desempate) return { ok: true, refunded: 0 };
    const league = this.store.getLeague(match.seasonMonth);
    const round = league?.quiniela?.rounds?.[match.jornada];
    if (!round || !['open', 'cancelled'].includes(round.status)) return { ok: true, refunded: 0 };
    const active = Object.values(round.tickets || {}).filter(ticket => ['pending_debit', 'open'].includes(ticket.status));
    const at = this.now();
    for (const ticket of active) {
      const profile = this.profiles.getProfile(ticket.profileId);
      if (!profile) return { ok: false, reason: 'perfil_no_disponible' };
    }
    const records = Object.values(round.tickets || {}).filter(ticket => ['pending_debit', 'open'].includes(ticket.status)
      || (ticket.status === 'refunded' && ticket.payout > 0)).map(ticket => ({
      ticket, profile: this.profiles.getProfile(ticket.profileId)
    }));
    if (records.some(item => !item.profile)) return { ok: false, reason: 'perfil_no_disponible' };

    for (const { ticket, profile } of records) {
      if (!['pending_debit', 'open'].includes(ticket.status)) continue;
      const entryOperation = operationId(league.seasonMonth, round.jornada, ticket.profileId, 'entry');
      const debited = ticket.status === 'open' || isApplied(profile, entryOperation);
      ticket.status = 'refunded';
      ticket.payout = debited ? ENTRY_COST : 0;
    }
    if (round.status !== 'cancelled') {
      round.status = 'cancelled';
      round.result = { status: 'cancelled', reason: String(reason).slice(0, 120), pot: null,
        winners: 0, carry: storeCarry(this.store), entries: active.length, settledAt: at };
      if (!(await this.store.saveStrict())) return { ok: false, reason: 'persistencia_pendiente' };
    }

    for (const { ticket, profile } of records) {
      if (!ticket.payout) continue;
      const op = operationId(league.seasonMonth, round.jornada, ticket.profileId, 'refund');
      if (!isApplied(profile, op)) {
        credit(profile, ticket.payout, `Reembolso quiniela ${league.seasonMonth} J${round.jornada}`, { operationId: op });
      }
      // Incluso si la marca ya está en memoria por un intento fallido, repetir
      // el UPSERT con el mismo operationId confirma la escritura sin duplicar.
      if (!(await this.profiles.persistProfile(profile))) return { ok: false, reason: 'reembolso_pendiente' };
    }
    if (!(await this.store.saveStrict())) return { ok: false, reason: 'reembolso_pendiente' };
    this.log('football_quiniela_refunded', { season: league.seasonMonth, jornada: round.jornada, entries: active.length });
    return { ok: true, refunded: active.length };
  }

  // Hook del motor: al asentarse (o posponerse) un partido, liquidar su jornada
  // si ya quedó completa. Best-effort: el barrido del scheduler lo reintenta.
  notifyMatch(match) {
    if (!this.enabled || !match || match.desempate) return null;
    const league = this.store.getLeague(match.seasonMonth);
    if (!league) return null;
    const promise = this.settleJornada(league, match.jornada).catch(error => {
      this.log('football_quiniela_settle_error', { matchId: match.id, message: String(error?.message || error) });
    });
    return promise;
  }

  // Barrido: repara la cartera tras un crash y liquida jornadas completas.
  // Derivar, no acumular: se puede correr todas las veces que haga falta.
  async sweep(_now = this.now()) {
    if (!this.enabled) return { skipped: true };
    const league = this.store.getLeague(this.store.getCurrentSeasonMonth());
    if (!league) return { skipped: true };
    const recovered = await this.recoverWallet(league);
    const settled = [];
    // La temporada vigente primero y después las cerradas que aún tengan rondas
    // abiertas: al rotar el mes, la última jornada del mes que sale puede quedar
    // sin asentar (su barrido corre cada minuto, la rotación es instantánea).
    // Antes esas rondas se quedaban «open» para siempre: la entrada no volvía ni
    // se pagaba, y el boleto del jugador se quedaba colgado.
    let changed = false;
    for (const season of this.pendingSeasons(league)) {
      const target = this.store.getLeague(season);
      if (!target) continue;
      if (target !== league && await this.recoverWallet(target)) changed = true;
      for (const { jornada, matches } of this.jornadasOf(target)) {
        const round = this.journalOf(target).rounds[jornada];
        if (!round || round.status !== 'open') continue;
        if (!matches.every(m => m.status === 'settled' || (m.status === 'postponed' && !m.result))) continue;
        const result = await this.settleJornada(target, jornada);
        if (result && (result.status === 'settled' || result.status === 'cancelled')) {
          settled.push({ season, jornada, status: result.status });
          changed = true;
        }
      }
      // Antes se programaba un guardado por temporada en CADA vuelta, aunque no
      // hubiera nada que hacer: el store reescribe la liga completa (654 KB en un
      // mes con su calendario), así que el barrido de cada minuto gastaba disco y
      // CPU para reescribir lo mismo. Ahora solo se guarda si hubo cambios.
      if (changed && this.store.scheduleSave) this.store.scheduleSave();
    }
    return { recovered, settled };
  }

  // Temporadas con alguna ronda abierta, la vigente primero. Las cerradas se
  // recorren solo si el diario les dejó trabajo pendiente: es un barrido barato
  // (los rounds viven en memoria con la liga).
  pendingSeasons(current) {
    const out = [current.seasonMonth];
    for (const [season, league] of this.store.leagues) {
      if (season === current.seasonMonth) continue;
      const rounds = league?.quiniela?.rounds;
      if (!rounds || typeof rounds !== 'object') continue;
      if (Object.values(rounds).some(round => round && round.status === 'open')) out.push(season);
    }
    return out;
  }

  // Recuperación al arranque (y en cada barrido): aplica con operationId los
  // movimientos del diario que quedaron a medias por un crash, sin duplicarlos.
  async recoverWallet(league) {
    const journal = this.journalOf(league);
    let recovered = 0;
    let journalTouched = false;
    for (const round of Object.values(journal.rounds)) {
      if (!ROUND_STATUSES.has(round.status)) continue;
      for (const ticket of Object.values(round.tickets || {})) {
        if (!TICKET_STATUSES.has(ticket.status)) continue;
        const profile = this.profiles.getProfile(ticket.profileId);
        if (!profile) continue;
        const season = league.seasonMonth;
        if (ticket.status === 'pending_debit' || ticket.status === 'open') {
          const op = operationId(season, round.jornada, ticket.profileId, 'entry');
          if (!isApplied(profile, op)) {
            debit(profile, ENTRY_COST, `Entrada quiniela ${season} J${round.jornada}`, { operationId: op });
            if (await this.profiles.persistProfile(profile)) recovered++;
          }
          if (ticket.status === 'pending_debit') { ticket.status = 'open'; journalTouched = true; }
        }
        if ((ticket.status === 'won' || ticket.status === 'refunded') && ticket.payout > 0) {
          const kind = ticket.status === 'refunded' ? 'refund' : 'prize';
          const op = operationId(season, round.jornada, ticket.profileId, kind);
          if (!isApplied(profile, op)) {
            credit(profile, ticket.payout, `${kind === 'refund' ? 'Reembolso' : 'Premio'} quiniela ${season} J${round.jornada}`, { operationId: op });
            if (await this.profiles.persistProfile(profile)) recovered++;
          }
        }
      }
    }
    if (journalTouched) await this.store.saveStrict();
    return recovered;
  }

  // Barrido de arranque: recuperación de cartera antes de aceptar tráfico.
  async recover() {
    if (!this.enabled) return { skipped: true };
    const league = this.store.getLeague(this.store.getCurrentSeasonMonth());
    if (!league) return { skipped: true };
    const adopted = await this.adoptLegacyCarry();
    return { recovered: await this.recoverWallet(league), adoptedCarry: adopted };
  }

  // Rescata el bote que versiones anteriores guardaban dentro de cada liga
  // (`league.quiniela.bank.carry`). Se suma el de todas las temporadas —la que
  // estaba vigente al desplegar y la que iba a heredarlo— y se fija en el store,
  // que es desde ahora la única fuente. Idempotente: los diarios se limpian.
  async adoptLegacyCarry() {
    let total = storeCarry(this.store);
    let touched = false;
    for (const league of this.store.leagues.values()) {
      const legacy = legacyCarry(league);
      if (!legacy) continue;
      total += legacy;
      if (league.quiniela) league.quiniela.bank = { carry: 0 };
      touched = true;
    }
    if (!touched) return 0;
    this.store.quinielaCarry = total;
    if (this.store.saveStrict) await this.store.saveStrict();
    this.log('football_quiniela_carry_adopted', { carry: total });
    return total;
  }
}

module.exports = { QuinielaService, ENTRY_COST, operationId, publicTicket };
