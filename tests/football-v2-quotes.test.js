'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildSeasonClubs } = require('../lib/football/teams');
const { mulberry32 } = require('../lib/football/prng');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const C = require('../lib/football/v2/calibration');
const Q = require('../lib/football/v2/quotes');
const O = require('../lib/football/odds');
const { VERSION } = require('../lib/football/v2/simulator');

function setup() {
  const clubs = buildSeasonClubs(mulberry32(22));
  const match = { seasonMonth: '2026-11', homeId: clubs[0].id, awayId: clubs[1].id };
  const input = prepareMatchInputs({ league: { seasonMonth: '2026-11', config: clubs, calendar: { matches: [] } },
    match, asOf: Date.UTC(2026, 10, 1), seed: 0 });
  const base = { version: C.VERSION, simulatorVersion: VERSION, inputHash: C.hashInputs(input), samples: 2048,
    counts: { '0-0': 400, '1-0': 500, '0-1': 360, '1-1': 420, '2-0': 150, '2-1': 130, '1-2': 88 },
    liveByState: [{ '0-0|1|0-0': { home: 90, draw: 60, away: 50 }, '0-0|1|1-0': { home: 30, draw: 70, away: 100 } }] };
  const training = { ...base, keyCommitment: 'a'.repeat(64) };
  const holdout = { ...base, keyCommitment: 'b'.repeat(64) };
  const matchKey = 'bd'.repeat(32);
  return { input, matchKey, training, holdout };
}

test('las cuotas prepartido se derivan de la matriz empírica congelada y no del Poisson V1', () => {
  const { input, matchKey, training, holdout } = setup();
  const model = Q.createQuoteModel(input, matchKey, training, holdout);
  const expected = O.buildPreMatchMarkets(C.scoreMatrix(training));
  for (const key of ['1x2', 'double_chance', 'over_under_2.5', 'btts', 'correct_score', 'team_total_home_1.5']) {
    const market = Q.preMatchMarket(model, key);
    assert.ok(market);
    for (const selection of market.selections) {
      const original = expected[key].selections.find(item => item.key === selection.key);
      assert.equal(selection.prob, original.prob);
      assert.ok(selection.price >= O.PRICE_MIN && selection.price <= original.price);
      assert.ok(selection.cashoutProbability <= selection.prob);
      const margin = expected[key].targetMargin ?? O.MARGINS.double_chance;
      assert.ok(selection.price * Q.probabilityBound(selection.prob, training.samples, true) * (1 + margin) <= 1 + 1e-9);
    }
    if (!market.independent && !market.incomplete) assert.ok(O.overround(market.selections.map(item => item.price)) >= 1 + O.MIN_MARGIN - 1e-9);
  }
  const priced = Q.preMatchMarket(model, '1x2');
  training.counts['0-0'] = 1; // el modelo propio no depende del objeto del llamador
  assert.deepEqual(Q.preMatchMarket(model, '1x2'), priced);
  assert.equal(JSON.stringify(model).includes(matchKey), false);
  assert.equal(Q.preMatchMarket(model, 'mercado_inexistente'), null);
});

test('las cuotas y cashout en vivo usan sólo el estado revelado y una muestra de control separada', () => {
  const { input, matchKey, training, holdout } = setup();
  const model = Q.createQuoteModel(input, matchKey, training, holdout);
  const state = { minute: 0, half: 1, score: { home: 0, away: 0 }, redCards: { home: 0, away: 0 }, playStopped: false };
  const normal = Q.liveMarket(model, '1x2', state);
  const red = Q.liveMarket(model, '1x2', { ...state, redCards: { home: 1, away: 0 } });
  assert.ok(normal && red);
  assert.ok(normal.selections.find(s => s.key === 'home').prob > red.selections.find(s => s.key === 'home').prob);
  const probability = normal.selections.find(s => s.key === 'home').prob;
  assert.ok(O.cashoutValue(100, 2, probability) > O.cashoutValue(100, 2, red.selections.find(s => s.key === 'home').prob));
  assert.equal(Q.liveMarket(model, 'btts', state), null);
  assert.equal(Q.liveMarket(model, '1x2', { ...state, playStopped: true }), null);
  assert.equal(Q.liveMarket(model, '1x2', { ...state, score: { home: 9, away: 0 } }), null);
});

test('la versión anterior de cuotas se recupera sin cambiar compromisos aceptados', () => {
  const { input, matchKey, training, holdout } = setup();
  const { makeCommitment, cleanCommitment } = require('../lib/football/v2/commitment');
  const legacy = Q.createQuoteModel(input, matchKey, training, holdout, Q.LEGACY_VERSION);
  const record = makeCommitment(input, matchKey, input.asOf, legacy);
  const match = { homeId: input.home.id, awayId: input.away.id, seasonMonth: input.source.currentSeason };
  const restored = cleanCommitment(JSON.parse(JSON.stringify(record)), match);
  assert.equal(restored.pricing.version, Q.LEGACY_VERSION);
  assert.deepEqual(Q.preMatchMarket(restored.pricing, '1x2'), O.buildPreMatchMarkets(C.scoreMatrix(training))['1x2']);
});

test('se rechazan muestras pequeñas, iguales, de otra entrada o relacionadas con la clave del partido', () => {
  const { input, matchKey, training, holdout } = setup();
  assert.throws(() => Q.createQuoteModel(input, matchKey, training, { ...holdout, samples: 10 }), /muestra_insuficiente/);
  assert.throws(() => Q.createQuoteModel(input, matchKey, training, { ...holdout, keyCommitment: 'a'.repeat(64) }), /muestra_no_independiente/);
  assert.throws(() => Q.createQuoteModel(input, matchKey, training, { ...holdout, inputHash: 'otra' }), /otras entradas/);
  const secretHash = crypto.createHash('sha256').update(Buffer.from(matchKey, 'hex')).digest('hex');
  assert.throws(() => Q.createQuoteModel(input, matchKey, { ...training, keyCommitment: secretHash }, holdout), /clave del partido/);
});
