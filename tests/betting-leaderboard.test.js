'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBettingLeaderboard, isPlacedWager } = require('../lib/betting-leaderboard');

function profile(id, name, casinoWagered, extra = {}) {
  return {
    id, name, avatar: 'owl', createdAt: 1,
    stats: { totalWagered: casinoWagered },
    ...extra
  };
}

function storeWith({ bets = [], parlays = [], futures = [] } = {}) {
  return {
    getBets: () => bets,
    getParlays: () => parlays,
    getFutures: () => futures
  };
}

test('combina volumen del casino con simples, combinadas y futuros del Estadio', () => {
  const profiles = new Map([
    ['ada', profile('ada', 'Ada', 1000)],
    ['beto', profile('beto', 'Beto', 5000)],
    ['carla', profile('carla', 'Carla', 0)],
    ['bot', profile('bot', 'Bot', 20000, { flags: { bot: true } })]
  ]);
  const footballStore = storeWith({
    bets: [
      { profileId: 'ada', stake: 300, status: 'open', debited: true },
      { profileId: 'ada', stake: 200, status: 'lost', payout: 0, debited: true },
      { profileId: 'ada', stake: 9000, status: 'pending', debited: true },
      { profileId: 'ada', stake: 9000, status: 'void', debited: false },
      { profileId: 'beto', stake: 1000, status: 'won', payout: 1800, debited: true },
      { profileId: 'beto', stake: 500, status: 'void', payout: 500, debited: true },
      { profileId: 'carla', stake: 800, status: 'cashed', payout: 1200, debited: true },
      { profileId: 'deleted-profile', stake: 50000, status: 'won', debited: true }
    ],
    parlays: [{ profileId: 'ada', stake: 500, status: 'open', debited: true }],
    futures: [{ profileId: 'carla', stake: 100, status: 'won', payout: 200, debited: true }]
  });

  const result = buildBettingLeaderboard({ profiles, footballStore, profileId: 'ada', now: 1234 });

  assert.equal(result.updatedAt, 1234);
  assert.equal(result.participants, 3);
  assert.equal(result.totalWagered, 9400);
  assert.deepEqual(result.ranking.total.map(row => [row.place, row.name, row.totalWagered]), [
    [1, 'Beto', 6500], [2, 'Ada', 2000], [3, 'Carla', 900]
  ]);
  assert.deepEqual(result.ranking.casino.map(row => [row.place, row.name, row.casinoWagered]), [
    [1, 'Beto', 5000], [2, 'Ada', 1000]
  ]);
  assert.deepEqual(result.ranking.stadium.map(row => [row.place, row.name, row.stadiumWagered]), [
    [1, 'Beto', 1500], [2, 'Ada', 1000], [3, 'Carla', 900]
  ]);
  assert.deepEqual(result.me, {
    name: 'Ada', avatar: 'owl', totalWagered: 2000, casinoWagered: 1000,
    stadiumWagered: 1000, stadiumBets: 3, stadiumWins: 0, stadiumLosses: 1,
    stadiumDecisions: 1, stadiumSettledBets: 1, stadiumHitRate: 0, stadiumNet: -200,
    totalRank: 2, casinoRank: 2, stadiumRank: 2
  });
  const beto = buildBettingLeaderboard({ profiles, footballStore, profileId: 'beto' }).me;
  assert.equal(beto.stadiumHitRate, 100, 'un void no reduce el porcentaje de acierto');
  assert.equal(beto.stadiumDecisions, 1, 'solo las apuestas ganadas/perdidas miden aciertos');
  assert.equal(beto.stadiumSettledBets, 2);
  assert.equal(beto.stadiumNet, 800, 'el reembolso del void deja el neto intacto');
  const carla = buildBettingLeaderboard({ profiles, footballStore, profileId: 'carla' }).me;
  assert.equal(carla.stadiumHitRate, 100, 'el cashout no se cuenta como predicción acertada');
  assert.equal(carla.stadiumNet, 500, 'el neto incluye cashouts y futuros liquidados');
  assert.ok(!JSON.stringify(result.ranking).includes('profileId'));
  assert.ok(!JSON.stringify(result.ranking).includes('stadiumNet'), 'el neto se reserva al resumen personal');
  assert.ok(!JSON.stringify(result.ranking).includes('ada'));
});

test('sin historial se conserva el espacio personal y los puestos quedan vacíos', () => {
  const result = buildBettingLeaderboard({
    profiles: new Map([['new', profile('new', 'Nueva', 0)]]),
    footballStore: storeWith(), profileId: 'new'
  });
  assert.equal(result.participants, 0);
  assert.equal(result.totalWagered, 0);
  assert.deepEqual(result.ranking, { total: [], casino: [], stadium: [] });
  assert.deepEqual(result.me, {
    name: 'Nueva', avatar: 'owl', totalWagered: 0, casinoWagered: 0,
    stadiumWagered: 0, stadiumBets: 0, stadiumWins: 0, stadiumLosses: 0,
    stadiumDecisions: 0, stadiumSettledBets: 0, stadiumHitRate: null, stadiumNet: 0,
    totalRank: null, casinoRank: null, stadiumRank: null
  });
});

test('el límite es acotado y los empates tienen un orden estable', () => {
  const profiles = new Map([
    ['b', profile('b', 'Beto', 100)],
    ['a', profile('a', 'Ana', 100)],
    ['c', profile('c', 'Ciro', 100)]
  ]);
  const result = buildBettingLeaderboard({ profiles, limit: 1, now: 10 });
  assert.equal(result.ranking.total.length, 1);
  assert.equal(result.ranking.total[0].name, 'Ana');
});

test('solo cuenta apuestas aceptadas; los reembolsos de una colocación rechazada no cuentan', () => {
  assert.equal(isPlacedWager({ stake: 20, status: 'pending', debited: true }), false);
  assert.equal(isPlacedWager({ stake: 20, status: 'void', debited: false }), false);
  assert.equal(isPlacedWager({ stake: 20, status: 'void', debited: true }), true);
  assert.equal(isPlacedWager({ stake: 20, status: 'lost', debited: true }), true);
});
