'use strict';

const { randomInt } = require('node:crypto');

// Reglas puras de una partida. No modifica saldos ni confirma pagos: el
// adaptador de persistencia debe registrar cada transición y sus movimientos
// juntos antes de publicar estados o aceptar operaciones.
const CARD_COUNT = 54;
const BOARD_SIZE = 16;
const ENTRY_COST = 50;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 100;
const REGISTRATION_MS = 60_000;
const CALL_INTERVAL_MS = 2_000;

function shuffled(values, random = randomInt) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = random(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError('Índice aleatorio inválido');
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function newGame({ id, openedAt, carry = 0, random = randomInt }) {
  if (typeof id !== 'string' || !id || !Number.isSafeInteger(openedAt) || openedAt < 0 || !Number.isSafeInteger(carry) || carry < 0 || carry > Number.MAX_SAFE_INTEGER - ENTRY_COST * MAX_PLAYERS || openedAt > Number.MAX_SAFE_INTEGER - REGISTRATION_MS - CARD_COUNT * CALL_INTERVAL_MS) throw new TypeError('Parámetros inválidos');
  return {
    id, openedAt, closesAt: openedAt + REGISTRATION_MS, status: 'registration',
    carry, players: [], deck: shuffled(Array.from({ length: CARD_COUNT }, (_, i) => i + 1), random),
    called: [], result: null
  };
}

function join(game, profileId, now, random = randomInt) {
  if (!Number.isSafeInteger(now) || now < game.openedAt || game.status !== 'registration' || now >= game.closesAt) return { ok: false, reason: 'closed' };
  if (typeof profileId !== 'string' || !profileId || profileId.length > 80) return { ok: false, reason: 'profile' };
  if (game.players.some(player => player.profileId === profileId)) return { ok: false, reason: 'duplicate' };
  if (game.players.length >= MAX_PLAYERS) return { ok: false, reason: 'full' };
  const board = shuffled(Array.from({ length: CARD_COUNT }, (_, i) => i + 1), random).slice(0, BOARD_SIZE);
  game.players.push({ profileId, board });
  return { ok: true, debit: ENTRY_COST, board: [...board] };
}

function disconnect(game, profileId, now) {
  if (!Number.isSafeInteger(now) || now < game.openedAt || game.status !== 'registration' || now >= game.closesAt) return { ok: false, reason: 'already_started' };
  const index = game.players.findIndex(player => player.profileId === profileId);
  if (index < 0) return { ok: false, reason: 'not_joined' };
  game.players.splice(index, 1);
  return { ok: true, refund: ENTRY_COST };
}

function advance(game, now) {
  if (!Number.isSafeInteger(now)) throw new TypeError('Hora inválida');
  const events = [];
  if (game.status === 'registration' && now >= game.closesAt) {
    if (game.players.length < MIN_PLAYERS) {
      game.status = 'cancelled';
      game.result = { refunds: game.players.map(player => ({ profileId: player.profileId, amount: ENTRY_COST })), carry: game.carry };
      return [{ type: 'cancelled', ...game.result }];
    }
    game.status = 'calling';
    events.push({ type: 'started' });
  }
  while (game.status === 'calling' && game.called.length < CARD_COUNT && now >= game.closesAt + CALL_INTERVAL_MS * (game.called.length + 1)) {
    const card = game.deck[game.called.length];
    game.called.push(card);
    events.push({ type: 'called', card });
    const called = new Set(game.called);
    const winners = game.players.filter(player => player.board.every(number => called.has(number)));
    if (winners.length) {
      const pot = game.carry + ENTRY_COST * game.players.length;
      if (!Number.isSafeInteger(pot)) throw new RangeError('Bote fuera de rango');
      const amount = Math.floor(pot / winners.length);
      game.status = 'settled';
      game.result = { pot, winners: winners.map(player => ({ profileId: player.profileId, amount })), carry: pot - amount * winners.length };
      events.push({ type: 'settled', ...game.result });
    }
  }
  return events;
}

function publicState(game, profileId) {
  const player = game.players.find(item => item.profileId === profileId);
  const myWin = game.result?.winners?.find(w => w.profileId === profileId);
  const result = game.status === 'settled'
    ? { pot: game.result.pot, winnerCount: game.result.winners.length, payoutPerWinner: game.result.winners[0].amount, carry: game.result.carry, won: Boolean(myWin), myPayout: myWin?.amount || 0 }
    : game.status === 'cancelled' ? { cancelled: true, refunded: Boolean(player), carry: game.result.carry } : null;
  return { id: game.id, status: game.status, closesAt: game.closesAt, count: game.players.length,
    pot: game.carry + ENTRY_COST * game.players.length, called: [...game.called],
    board: player ? [...player.board] : null, result };
}

module.exports = { CARD_COUNT, BOARD_SIZE, ENTRY_COST, MIN_PLAYERS, MAX_PLAYERS, REGISTRATION_MS, CALL_INTERVAL_MS, shuffled, newGame, join, disconnect, advance, publicState };
