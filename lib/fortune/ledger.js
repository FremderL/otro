'use strict';

// Diario transaccional de la Rueda de la Fortuna.
//
// La Rueda reutiliza el modelo de mesas en memoria (`rooms`): la apuesta se
// descuenta al confirmarla y el premio se acredita ~1 s después de lanzar la
// ronda. Si el proceso cae en medio de ese hueco, las mesas desaparecen y el
// saldo quedaría inconsistente. Este diario cierra ese hueco:
//
//   * cada ronda (y cada apuesta) se anota en un archivo JSON antes de tocar
//     el saldo;
//   * cada movimiento usa un `operationId` determinista guardado dentro del
//     propio perfil (`appliedChipOperations` de lib/progression.js), así que
//     repetirlo nunca cobra ni paga dos veces;
//   * al arrancar se aplica la decisión acordada: **se reembolsa lo que no
//     tiene resultado confirmado y se paga el resultado ya confirmado**.
//
// El archivo se escribe de forma atómica (`.tmp` + `rename`) y se conservan
// las rondas cerradas 24 h para poder reconfirmar sus pagos si un guardado de
// perfil no llegó a disco. Está pensado para un único proceso escritor, igual
// que el resto de la persistencia del casino.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { credit, debit, recordOutcome } = require('../progression');
const { monthKey } = require('../profile-store-shared');

const STATE_VERSION = 1;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ROUNDS = 500;
const MAX_BETS_PER_ROUND = 12;
const MAX_AMOUNT = 1_000_000_000;
const ROUND_STATUSES = new Set(['open', 'resolved', 'paid', 'refunded']);

function operationId(kind, roundId, profileId) {
  const digest = createHash('sha256').update(JSON.stringify([roundId, profileId])).digest('hex');
  return `fortune:${kind}:${digest.slice(0, 40)}`;
}

function alreadyApplied(profile, id) {
  return Array.isArray(profile?.appliedChipOperations) && profile.appliedChipOperations.includes(id);
}

function cleanRoundId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^[a-zA-Z0-9:_-]{1,120}$/.test(id) ? id : null;
}

function cleanRound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanRoundId(raw.id);
  if (!id) return null;
  if (!ROUND_STATUSES.has(raw.status)) return null;
  const bets = [];
  for (const bet of Array.isArray(raw.bets) ? raw.bets : []) {
    if (!bet || typeof bet.profileId !== 'string' || !bet.profileId || bet.profileId.length > 80) continue;
    const amount = Math.floor(Number(bet.amount));
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) continue;
    if (bets.some(entry => entry.profileId === bet.profileId)) continue;
    bets.push({
      profileId: bet.profileId,
      name: typeof bet.name === 'string' ? bet.name.replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, 18) : 'Jugador',
      amount,
      choice: String(bet.choice || '').slice(0, 8),
      at: Math.max(0, Number(bet.at) || 0),
      operationId: typeof bet.operationId === 'string' && bet.operationId.length <= 160
        ? bet.operationId
        : operationId('bet', id, bet.profileId),
      refundedAt: Number(bet.refundedAt) || null,
      refundReason: typeof bet.refundReason === 'string' ? bet.refundReason.slice(0, 40) : null
    });
    if (bets.length >= MAX_BETS_PER_ROUND) break;
  }
  const payouts = Array.isArray(raw.payouts)
    ? raw.payouts.slice(0, MAX_BETS_PER_ROUND).map(payout => ({
      profileId: String(payout?.profileId || '').slice(0, 80),
      amount: Math.max(0, Math.min(MAX_AMOUNT, Math.floor(Number(payout?.amount) || 0))),
      net: Math.max(-MAX_AMOUNT, Math.min(MAX_AMOUNT, Math.floor(Number(payout?.net) || 0)))
    })).filter(payout => payout.profileId)
    : [];
  const value = Number(raw.result?.value);
  return {
    id,
    roomCode: typeof raw.roomCode === 'string' ? raw.roomCode.slice(0, 12) : '',
    createdAt: Math.max(0, Number(raw.createdAt) || 0),
    status: raw.status,
    result: Number.isInteger(value) && value >= 1 && value <= 40 ? { value } : null,
    bets,
    payouts,
    paidAt: Number(raw.paidAt) || null
  };
}

class FortuneLedger {
  constructor({
    profiles, statePath, now = () => Date.now(), log = () => {}, seasonMonth = null
  } = {}) {
    if (!profiles || typeof profiles.getProfile !== 'function' || typeof profiles.touch !== 'function') {
      throw new TypeError('La Rueda requiere el almacén de perfiles del casino');
    }
    this.profiles = profiles;
    this.statePath = statePath ? path.resolve(statePath) : null;
    this.now = now;
    this.log = log;
    this.seasonMonth = seasonMonth || (() => profiles.seasons?.current || monthKey());
    this.state = { version: STATE_VERSION, rounds: {}, updatedAt: 0 };
    this.ready = false;
  }

  // ---------- Persistencia ----------
  load() {
    if (!this.statePath) {
      this.state = { version: STATE_VERSION, rounds: {}, updatedAt: 0 };
      this.ready = true;
      return this.state;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const rounds = {};
      for (const value of Object.values(raw?.rounds || {})) {
        const round = cleanRound(value);
        if (round) rounds[round.id] = round;
      }
      this.state = { version: STATE_VERSION, rounds, updatedAt: Math.max(0, Number(raw?.updatedAt) || 0) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('fortune_state_corrupt', { message: String(error?.message || error) });
        // Se conserva el archivo dañado para diagnóstico y se arranca limpio:
        // un JSON corrupto nunca debe impedir que el casino abra.
        try { fs.renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`); } catch (_) { /* solo diagnóstico */ }
      }
      this.state = { version: STATE_VERSION, rounds: {}, updatedAt: 0 };
    }
    this.ready = true;
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
      this.log('fortune_state_save_failed', { message: String(error?.message || error) });
      return false;
    }
  }

  get rounds() { return this.state.rounds; }

  pendingRounds() {
    return Object.values(this.state.rounds).filter(round => round.status === 'open' || round.status === 'resolved').length;
  }

  // ---------- Ciclo de vida ----------
  start() {
    this.load();
    const summary = this.recover();
    this.purge();
    this.save();
    this.log('fortune_ledger_started', { statePath: this.statePath, ...summary });
    return summary;
  }

  // Aplica lo que quedó a medias: devuelve las apuestas sin resultado y paga
  // los resultados ya confirmados. Repetirlo es seguro (operaciones idempotentes).
  recover() {
    let refunded = 0;
    let paid = 0;
    let skipped = 0;
    for (const round of Object.values(this.state.rounds)) {
      if (round.status === 'open') {
        for (const bet of round.bets) {
          if (bet.refundedAt) continue;
          const result = this.refundBetInRound(round, bet, 'server_restart');
          if (result.refunded > 0) refunded++;
          else skipped++;
        }
        if (round.bets.every(bet => bet.refundedAt)) {
          round.status = 'refunded';
          round.paidAt = this.now();
        }
      } else if (round.status === 'resolved' || round.status === 'paid') {
        this.applyPayouts(round);
        paid++;
      }
    }
    return { refunded, paid, skipped };
  }

  purge() {
    const now = this.now();
    const rounds = Object.values(this.state.rounds)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const keep = new Set();
    for (const round of rounds) {
      const closedAt = round.paidAt || round.createdAt;
      const closed = round.status === 'paid' || round.status === 'refunded';
      if (closed && now - closedAt > RETENTION_MS) continue;
      keep.add(round.id);
    }
    let kept = [...keep];
    if (kept.length > MAX_ROUNDS) {
      const ordered = rounds.filter(round => keep.has(round.id));
      kept = ordered.slice(ordered.length - MAX_ROUNDS).map(round => round.id);
    }
    for (const id of Object.keys(this.state.rounds)) {
      if (!kept.includes(id)) delete this.state.rounds[id];
    }
    return kept.length;
  }

  // ---------- Apuestas ----------
  ensureRound(roundId, roomCode = '') {
    const id = cleanRoundId(roundId);
    if (!id) return null;
    let round = this.state.rounds[id];
    if (!round) {
      round = {
        id,
        roomCode: typeof roomCode === 'string' ? roomCode.slice(0, 12) : '',
        createdAt: this.now(),
        status: 'open',
        result: null,
        bets: [],
        payouts: [],
        paidAt: null
      };
      this.state.rounds[id] = round;
    }
    return round;
  }

  placeBet({ roundId, roomCode = '', profileId, name = '', amount, choice = '' } = {}) {
    if (!this.ready) return { ok: false, code: 'unavailable', error: 'La Rueda no está disponible en este momento.' };
    const numericAmount = Math.floor(Number(amount));
    if (typeof profileId !== 'string' || !profileId || profileId.length > 80 || !Number.isSafeInteger(numericAmount) || numericAmount < 1) {
      return { ok: false, code: 'invalid', error: 'Apuesta inválida.' };
    }
    const round = this.ensureRound(roundId, roomCode);
    if (!round) return { ok: false, code: 'invalid', error: 'Ronda inválida.' };
    if (round.status !== 'open') return { ok: false, code: 'closed', error: 'La ronda ya se resolvió.' };
    if (round.bets.some(bet => bet.profileId === profileId && !bet.refundedAt)) {
      return { ok: false, code: 'duplicate', error: 'Ya confirmaste tu apuesta para esta ronda.' };
    }
    if (round.bets.filter(bet => !bet.refundedAt).length >= MAX_BETS_PER_ROUND) {
      return { ok: false, code: 'full', error: 'La ronda no admite más apuestas.' };
    }
    const profile = this.profiles.getProfile(profileId);
    if (!profile) return { ok: false, code: 'profile', error: 'No encontramos tu perfil.' };
    if (profile.chips < numericAmount) {
      return { ok: false, code: 'insufficient', error: `Necesitas ${numericAmount} fichas disponibles.` };
    }
    const bet = {
      profileId,
      name: String(name || profile.name || '').replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, 18) || 'Jugador',
      amount: numericAmount,
      choice: String(choice || '').slice(0, 8),
      at: this.now(),
      operationId: operationId('bet', round.id, profileId),
      refundedAt: null,
      refundReason: null
    };
    // 1) Intención en disco. Si el proceso cae aquí, la recuperación comprueba
    //    si el cobro llegó a aplicarse antes de devolver nada.
    round.bets.push(bet);
    this.save();
    // 2) Cobro idempotente.
    const moved = debit(profile, bet.amount, 'Rueda de la Fortuna: apuesta', { operationId: bet.operationId });
    if (!moved.ok) {
      round.bets = round.bets.filter(entry => entry !== bet);
      if (!round.bets.length) delete this.state.rounds[round.id];
      this.save();
      return { ok: false, code: 'insufficient', error: 'No hay fichas suficientes para esa apuesta.' };
    }
    this.save();
    this.confirmProfile(profile);
    return { ok: true, bet, profile };
  }

  refundBet({ roundId, profileId, reason = 'left_before_result' } = {}) {
    const round = this.state.rounds[cleanRoundId(roundId)];
    if (!round) return { ok: false, code: 'unknown_round' };
    const bet = round.bets.find(entry => entry.profileId === profileId && !entry.refundedAt);
    if (!bet) return { ok: false, code: 'no_bet' };
    if (round.status !== 'open') return { ok: false, code: 'closed' };
    const { refunded } = this.refundBetInRound(round, bet, reason);
    if (round.bets.every(entry => entry.refundedAt)) {
      round.status = 'refunded';
      round.paidAt = this.now();
    }
    this.save();
    return { ok: true, refunded };
  }

  refundOpenRound({ roundId, reason = 'room_closed' } = {}) {
    const round = this.state.rounds[cleanRoundId(roundId)];
    if (!round || round.status !== 'open') return { ok: false, refunded: 0 };
    let total = 0;
    for (const bet of round.bets) {
      if (bet.refundedAt) continue;
      total += this.refundBetInRound(round, bet, reason).refunded;
    }
    if (round.bets.every(bet => bet.refundedAt)) {
      round.status = 'refunded';
      round.paidAt = this.now();
    }
    this.save();
    return { ok: true, refunded: total };
  }

  refundBetInRound(round, bet, reason) {
    let refunded = 0;
    const profile = this.profiles.getProfile(bet.profileId);
    // Si el cierre mensual ya reinició el saldo, la ficha apostada desapareció
    // con el reinicio: devolverla crearía fichas de la nada. Se anota igual.
    const sameSeason = monthKey(new Date(round.createdAt)) === this.seasonMonth();
    if (profile && sameSeason && alreadyApplied(profile, bet.operationId)) {
      refunded = credit(profile, bet.amount, 'Rueda de la Fortuna: devolución', {
        operationId: operationId('refund', round.id, bet.profileId)
      });
      if (refunded > 0) this.confirmProfile(profile);
    }
    bet.refundedAt = this.now();
    bet.refundReason = String(reason || 'refund').slice(0, 40);
    return { refunded };
  }

  // ---------- Liquidación ----------
  settleRound({ roundId, roomCode = '', result, payouts = [] } = {}) {
    if (!this.ready) return { ok: false, code: 'unavailable', events: [] };
    const round = this.ensureRound(roundId, roomCode);
    if (!round) return { ok: false, code: 'invalid', events: [] };
    if (round.status === 'paid' || round.status === 'refunded') return { ok: true, replayed: true, events: [] };
    if (round.status === 'open') {
      const value = Number(result?.value);
      round.status = 'resolved';
      round.result = Number.isInteger(value) && value >= 1 && value <= 40 ? { value } : null;
      round.payouts = (Array.isArray(payouts) ? payouts : []).slice(0, MAX_BETS_PER_ROUND).map(payout => ({
        profileId: String(payout?.profileId || '').slice(0, 80),
        amount: Math.max(0, Math.min(MAX_AMOUNT, Math.floor(Number(payout?.amount) || 0))),
        net: Math.max(-MAX_AMOUNT, Math.min(MAX_AMOUNT, Math.floor(Number(payout?.net) || 0)))
      })).filter(payout => payout.profileId);
      // Una apuesta sin fila en el desenlace (la persona desapareció de la mesa
      // antes de liquidar) se devuelve: nadie puede perder fichas sin resultado.
      const covered = new Set(round.payouts.map(payout => payout.profileId));
      for (const bet of round.bets) {
        if (bet.refundedAt || covered.has(bet.profileId)) continue;
        this.refundBetInRound(round, bet, 'settled_without_player');
      }
      // El resultado se confirma en disco ANTES de mover fichas: si el proceso
      // cae después, la recuperación paga exactamente este desenlace.
      this.save();
    }
    return this.applyPayouts(round);
  }

  applyPayouts(round) {
    const events = [];
    for (const payout of round.payouts) {
      const profile = this.profiles.getProfile(payout.profileId);
      if (!profile) {
        this.log('fortune_payout_missing_profile', { roundId: round.id, profileId: payout.profileId });
        continue;
      }
      credit(profile, payout.amount, 'Rueda de la Fortuna: premio', {
        operationId: operationId('prize', round.id, payout.profileId)
      });
      const progress = recordOutcome(profile, {
        game: 'fortune',
        net: payout.net,
        eligible: true,
        roundId: round.id,
        passportEligible: false,
        operationId: operationId('round', round.id, payout.profileId)
      });
      this.confirmProfile(profile);
      if (progress.length) events.push({ profileId: payout.profileId, events: progress });
    }
    round.status = 'paid';
    round.paidAt = round.paidAt || this.now();
    this.save();
    return { ok: true, events };
  }

  confirmProfile(profile) {
    this.profiles.touch(profile);
    if (typeof this.profiles.persistProfile !== 'function') return;
    try {
      const pending = this.profiles.persistProfile(profile);
      if (pending && typeof pending.catch === 'function') {
        pending.catch(error => this.log('fortune_profile_persist_failed', { message: String(error?.message || error) }));
      }
    } catch (error) {
      this.log('fortune_profile_persist_failed', { message: String(error?.message || error) });
    }
  }
}

module.exports = { FortuneLedger, operationId, RETENTION_MS, MAX_ROUNDS };
