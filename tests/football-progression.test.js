'use strict';

// Fase D — Regresiones de lib/progression.js (§12.7 hallazgos 1 y 2, §20 T23-T25).
//
// Estos tests existen para que nadie vuelva a:
//   · usar credit() como débito (hallazgo 1 / T24),
//   · debitar sin comprobar el saldo primero o parcialmente (T23),
//   · dejar que el fútbol cuente para los retos de variedad de juegos (C6 / T25).

const { test } = require('node:test');
const assert = require('node:assert');

const P = require('../lib/progression');

// Perfil mínimo con la forma que progression.js espera (mismo molde que usa el
// store de perfiles). evaluate() recorre logros y retos, así que lleva los campos
// que estas funciones leen.
function blankProfile(chips = 1000) {
  return {
    id: 'p_test', name: 'Prueba', chips,
    transactions: [], balanceHistory: [], gamesPlayed: [], gameStats: {},
    flags: {}, achievements: [], challenges: {},
    stats: {
      roundsPlayed: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0,
      biggestWin: 0, totalWagered: 0, eligibleTracking: false,
      eligibleCurrentStreak: 0, eligibleBestStreak: 0
    }
  };
}

test('T23: debit() falla cerrado con saldo insuficiente y no muta el perfil', () => {
  const profile = blankProfile(100);
  const before = profile.chips;
  const snapshots = profile.balanceHistory.length;
  const res = P.debit(profile, 500, 'Apuesta Estadio');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'saldo_insuficiente');
  assert.strictEqual(res.amount, 0);
  assert.strictEqual(profile.chips, before, 'no debió tocar el saldo');
  assert.strictEqual(profile.balanceHistory.length, snapshots, 'no debió tomar instantánea');
});

test('T23: debit() debita exacto con saldo suficiente y nunca deja saldo negativo', () => {
  const profile = blankProfile(1000);
  const res = P.debit(profile, 250, 'Apuesta Estadio');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.amount, 250);
  assert.strictEqual(profile.chips, 750);
  assert.strictEqual(profile.balanceHistory.length, 1, 'sí toma instantánea del saldo');
  // El borde exacto: debitar todo el saldo deja 0, no negativo.
  const all = P.debit(profile, 750, 'Apuesta Estadio');
  assert.strictEqual(all.ok, true);
  assert.strictEqual(profile.chips, 0);
  // Con saldo 0, cualquier débito falla.
  assert.strictEqual(P.debit(profile, 1, 'x').ok, false);
});

test('T23: debit() rechaza montos inválidos (cero, negativo, NaN)', () => {
  const profile = blankProfile(1000);
  for (const amount of [0, -50, NaN, null, undefined, 'abc']) {
    const res = P.debit(profile, amount, 'x');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'monto_invalido');
    assert.strictEqual(profile.chips, 1000);
  }
});

test('T24: credit() con monto negativo devuelve 0 y no cambia el saldo (regresión)', () => {
  // Esta prueba existe para que nadie vuelva a usar credit(profile, -stake) como
  // débito: el clamp a >= 0 lo convierte en 0 y retorna en silencio (§12.7 h.1).
  const profile = blankProfile(1000);
  const returned = P.credit(profile, -500, 'escrow');
  assert.strictEqual(returned, 0);
  assert.strictEqual(profile.chips, 1000, 'el saldo no debió cambiar');
  assert.strictEqual(profile.transactions.length, 0, 'no debió escribir transacción');
});

test('T25: trackPeriod no agrega football a period.games, pero sí los seis juegos de mesa', () => {
  const profile = blankProfile(1000);
  P.recordOutcome(profile, { game: 'football', net: 100, eligible: false });
  const daily = profile.rotatingChallenges.daily;
  assert.ok(!daily.games.includes('football'), 'el fútbol no debe contar para los retos de variedad');
  // El fútbol sí queda en el historial general y en gameStats (E10).
  assert.ok(profile.gamesPlayed.includes('football'), 'gamesPlayed sí registra el fútbol');
  assert.ok(profile.gameStats.football && profile.gameStats.football.rounds === 1, 'gameStats.football sí cuenta la ronda');

  for (const game of P.AVAILABLE_GAMES) {
    P.recordOutcome(profile, { game, net: 10, eligible: true });
  }
  assert.deepStrictEqual(daily.games.slice().sort(), [...P.AVAILABLE_GAMES].sort(),
    'los seis juegos de mesa sí entran en period.games');
});

test('T25: el reto de variedad es inalcanzable jugando solo al Estadio', () => {
  // «Turista del día» / «Ruta del casino» piden variedad de juegos. Apostando solo
  // al fútbol, period.games nunca crece, así que el reto no se completa (C6).
  const profile = blankProfile(100000);
  for (let i = 0; i < 30; i++) P.recordOutcome(profile, { game: 'football', net: i % 2 ? 50 : -50, eligible: false });
  const daily = profile.rotatingChallenges.daily;
  assert.strictEqual(daily.games.length, 0, 'ni una sola entrada de juego tras 30 apuestas de fútbol');
  assert.ok(daily.rounds >= 30, 'las rondas sí se cuentan (solo la variedad de juegos se filtra)');
});

test('C6: CHALLENGE_GAMES es exactamente AVAILABLE_GAMES', () => {
  assert.ok(P.CHALLENGE_GAMES instanceof Set);
  assert.deepStrictEqual([...P.CHALLENGE_GAMES].sort(), [...P.AVAILABLE_GAMES].sort());
  assert.strictEqual(P.CHALLENGE_GAMES.has('football'), false);
});
