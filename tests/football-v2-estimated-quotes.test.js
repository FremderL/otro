'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeasonClubs } = require('../lib/football/teams');
const { mulberry32 } = require('../lib/football/prng');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { makeCommitment, verifyCommitment, cleanCommitment } = require('../lib/football/v2/commitment');
const Q = require('../lib/football/v2/quotes');
const O = require('../lib/football/odds');

function input() {
  const clubs = buildSeasonClubs(mulberry32(177));
  const match = { seasonMonth: '2026-11', homeId: clubs[0].id, awayId: clubs[1].id };
  const league = { seasonMonth: '2026-11', config: clubs, calendar: { matches: [] } };
  return { match, league, data: prepareMatchInputs({ league, match, asOf: Date.UTC(2026, 10, 1), seed: 0 }) };
}

test('el modelo aproximado publica todos los mercados prepartido y permanece ligado a la entrada congelada', () => {
  const { data, match } = input();
  const model = Q.createEstimatedModel(data);
  assert.equal(model.version, Q.ESTIMATED_VERSION);
  assert.ok(Q.validModel(model, data));
  const catalog = Q.preMatchMarkets(model);
  for (const key of ['1x2', 'double_chance', 'handicap_home_minus1', 'handicap_home_plus1',
    'over_under_1.5', 'over_under_2.5', 'over_under_3.5', 'btts', 'correct_score',
    'win_to_nil_home', 'win_to_nil_away', 'team_total_home_0.5', 'team_total_home_1.5',
    'team_total_away_0.5', 'team_total_away_1.5']) {
    const book = catalog[key];
    assert.ok(book && !book.degenerate, key);
    assert.ok(book.selections.length >= 2, key);
    assert.ok(book.selections.every(s => s.price >= O.PRICE_MIN && s.price <= O.PRICE_MAX), key);
    if (!book.independent) assert.ok(O.overround(book.selections.map(s => s.price)) >= 1 + O.MIN_MARGIN - 1e-9, key);
  }
  assert.equal(catalog['1x2'].selections.length, 3);
  assert.ok(catalog.correct_score.selections.some(s => s.key === 'other'));
  const record = makeCommitment(data, '99'.repeat(32), data.asOf, model);
  assert.equal(verifyCommitment(record, match), true);
  const loaded = cleanCommitment(JSON.parse(JSON.stringify(record)), match);
  assert.deepEqual(Q.preMatchMarkets(loaded.pricing), catalog);
  const changed = JSON.parse(JSON.stringify(record));
  changed.pricing.matrix[0][0] += 0.001; changed.pricing.matrix[0][1] -= 0.001;
  assert.equal(verifyCommitment(changed, match), false);
});

test('la cotización en vivo aproximada cubre estados revelados y no recibe la duración privada', () => {
  const model = Q.createEstimatedModel(input().data);
  for (let minute = 0; minute < 98; minute++) {
    for (const score of [{ home: 0, away: 0 }, { home: 2, away: 1 }, { home: 0, away: 4 }, { home: 7, away: 8 }]) {
      for (const redCards of [{ home: 0, away: 0 }, { home: 1, away: 0 }, { home: 0, away: 2 }]) {
        const state = { minute, score, half: minute < 47 ? 1 : 2, redCards, playStopped: false };
        const market = Q.liveMarket(model, '1x2', state);
        assert.ok(market && !market.degenerate, JSON.stringify(state));
        assert.deepEqual(market.selections.map(s => s.key), ['home', 'draw', 'away']);
        assert.ok(O.overround(market.selections.map(s => s.price)) >= 1 + O.MIN_MARGIN - 1e-9);
        assert.deepEqual(Q.liveMarket(model, '1x2', { ...state, matchEnd: 90 }),
          Q.liveMarket(model, '1x2', { ...state, matchEnd: 98 }), 'no filtra duración futura');
      }
    }
  }
  assert.equal(Q.liveMarket(model, '1x2', { minute: 30, half: 1, score: { home: 0, away: 0 },
    redCards: { home: 0, away: 0 }, playStopped: true }), null);
});

test('rating y contexto alteran las estimaciones nuevas, no la cuota de un snapshot anterior', () => {
  const { data } = input();
  const base = Q.createEstimatedModel(data), before = Q.preMatchMarket(base, '1x2');
  const updated = JSON.parse(JSON.stringify(data));
  updated.home.ratings.elo += 250; updated.home.ratings.att = 1.3; updated.context.leagueAvg = 1.8;
  const changed = Q.createEstimatedModel(updated);
  assert.notDeepEqual(Q.scoreMatrix(changed), Q.scoreMatrix(base));
  assert.deepEqual(Q.preMatchMarket(base, '1x2'), before);
  assert.equal(Q.validModel(changed, data), false);
});
