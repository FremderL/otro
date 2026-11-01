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

// Réplica de la fórmula anterior (v1), congelada: debe coincidir con
// calculateMatrixLegacy de estimated-quotes.js. Si cambia algo, este test
// falla a propósito: los modelos preparados antes de v2-tilt-2 no pueden
// revalidarse con otra fórmula.
function legacyMatrixOf(input) {
  const prior = require('../lib/football/v2/score-prior.json');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rating = (team, key, fb) => { const v = Number(team?.ratings?.[key]); return Number.isFinite(v) && v > 0 ? v : fb; };
  const meanAttr = (lineup, name) => {
    const players = lineup?.players?.filter(p => p.initialStatus === 'active' && p.pos !== 'GK') || [];
    const values = players.map(p => Number(p.attrs?.[name])).filter(Number.isFinite);
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 65;
  };
  const home = input.home, away = input.away;
  const eloDiff = clamp((rating(home, 'elo', 1500) - rating(away, 'elo', 1500)) / 400, -1, 1);
  const avg = Number(input.context?.leagueAvg);
  const climate = clamp(Math.log((Number.isFinite(avg) && avg > 0 ? avg : 1.35) / 1.35) * 0.55, -0.22, 0.2);
  const tilt = (team, rival, sign) => clamp(climate + sign * eloDiff * 0.06
    + 0.40 * (clamp(rating(team, 'att', 1), 0.7, 1.35) - 1)
    + 0.26 * (clamp(rating(rival, 'def', 1), 0.7, 1.35) - 1)
    - 0.22 * (clamp(rating(rival, 'gk', 1), 0.7, 1.35) - 1)
    + 0.003 * (meanAttr(team.lineup, 'sho') - 63)
    + 0.002 * (meanAttr(team.lineup, 'pas') - 70), -0.42, 0.42);
  let sum = 0;
  const matrix = Array.from({ length: 9 }, (_, h) => Array.from({ length: 9 }, (_, a) => {
    const w = ((prior.counts[`${h}-${a}`] || 0) + 0.2) * Math.exp(tilt(home, away, 1) * h + tilt(away, home, -1) * a);
    sum += w; return w;
  }));
  return matrix.map(row => row.map(v => v / sum));
}

test('los modelos preparados con la fórmula anterior siguen validándose (compatibilidad)', () => {
  const { data, match } = input();
  const legacy = { version: Q.ESTIMATED_VERSION, simulatorVersion: data.version,
    inputHash: require('../lib/football/v2/calibration').hashInputs(data),
    priorVersion: require('../lib/football/v2/score-prior.json').version,
    knockout: false, matrix: legacyMatrixOf(data) };
  assert.ok(Q.validModel(legacy), 'sin entrada: consistencia interna');
  assert.ok(Q.validModel(legacy, data), 'con entrada: matriz recalculada con la fórmula congelada');
  assert.ok(Q.preMatchMarkets(legacy), 'mercados desde la matriz congelada');
  const record = { version: data.version, inputs: JSON.parse(JSON.stringify(data)),
    inputsHash: require('../lib/football/v2/calibration').hashInputs(data),
    privateSeed: '42'.repeat(32), preparedAt: data.asOf, pricing: legacy };
  assert.equal(verifyCommitment(record, match), true);
  const loaded = cleanCommitment(JSON.parse(JSON.stringify(record)), match);
  assert.ok(!loaded.invalid, 'rehidrata sin invalidar');
  // Rehidratar reconstruye la cuota desde las entradas congeladas con la
  // fórmula vigente; el compromiso y su huella no cambian.
  assert.equal(loaded.version, record.version);
  assert.equal(loaded.inputsHash, record.inputsHash);
  assert.equal(loaded.privateSeed, record.privateSeed);
  assert.ok(Q.validModel(loaded.pricing, loaded.inputs));
  // El drift de la fórmula anterior debe detectarse: matriz alterada -> inválido.
  const drifted = JSON.parse(JSON.stringify(record));
  drifted.pricing.matrix[3][3] += 0.001; drifted.pricing.matrix[3][4] -= 0.001;
  assert.equal(verifyCommitment(drifted, match), false);
});

test('calibración v2-tilt-2: baseline de gemelos, pendiente att/def y clima de goles', () => {
  const { data } = input();
  const oneX2 = matrix => {
    let h = 0, x = 0, a = 0;
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++)
      if (i > j) h += matrix[i][j]; else if (i === j) x += matrix[i][j]; else a += matrix[i][j];
    return { h, x, a };
  };
  // Baseline de gemelos del motor: H .367 / X .276 / A .357 (Monte Carlo 16×200).
  const twin = JSON.parse(JSON.stringify(data));
  twin.away = JSON.parse(JSON.stringify(twin.home));
  twin.away.id = 'clone_de_local';
  twin.away.lineup.teamId = 'clone_de_local';
  twin.away.lineup.players.forEach(p => { p.id = 'clone_' + p.id; });
  const base = oneX2(Q.scoreMatrix(Q.createEstimatedModel(twin)));
  assert.ok(Math.abs(base.h - 0.367) < 0.015 && Math.abs(base.x - 0.276) < 0.015 && Math.abs(base.a - 0.357) < 0.015,
    `baseline ${JSON.stringify(base)}`);
  // Pendiente att/def espejo ±0.18: el motor da +12 pts al local (Monte Carlo 300).
  const mirror = JSON.parse(JSON.stringify(twin));
  mirror.home.ratings.att = Number(mirror.home.ratings.att.toFixed(3)) + 0;
  const attBase = mirror.home.ratings.att;
  mirror.home.ratings.att = Math.min(1.35, attBase + 0.18);
  mirror.home.ratings.def = Math.max(0.70, mirror.home.ratings.def - 0.18);
  mirror.away.ratings.att = Math.max(0.70, attBase - 0.18);
  mirror.away.ratings.def = Math.min(1.35, mirror.away.ratings.def + 0.18);
  const shifted = oneX2(Q.scoreMatrix(Q.createEstimatedModel(mirror)));
  assert.ok(shifted.h - base.h > 0.08, `pendiente att/def ${JSON.stringify({ base, shifted })}`);
  // Clima: leagueAvg alto baja los empates (motor: .276 -> .200 con avg 1.6).
  const wet = JSON.parse(JSON.stringify(twin));
  wet.context.leagueAvg = 1.6;
  const wetProbs = oneX2(Q.scoreMatrix(Q.createEstimatedModel(wet)));
  assert.ok(wetProbs.x < base.x - 0.03, `clima ${JSON.stringify({ base, wetProbs })}`);
  // El modelo nuevo lleva etiqueta de fórmula; el prior no se toca.
  const model = Q.createEstimatedModel(data);
  assert.equal(model.formula, 'v2-tilt-2');
  assert.equal(model.priorVersion, require('../lib/football/v2/score-prior.json').version);
});
