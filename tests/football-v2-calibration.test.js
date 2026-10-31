'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeasonClubs } = require('../lib/football/teams');
const { mulberry32 } = require('../lib/football/prng');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const C = require('../lib/football/v2/calibration');

function input() {
  const clubs = buildSeasonClubs(mulberry32(11));
  const match = { seasonMonth: '2026-11', homeId: clubs[0].id, awayId: clubs[1].id };
  return prepareMatchInputs({ league: { seasonMonth: '2026-11', config: clubs, calendar: { matches: [] } },
    match, asOf: Date.UTC(2026, 10, 1), seed: 0 });
}

test('calibración empírica usa corrientes independientes y es repetible para las mismas entradas', () => {
  const match = input();
  const a = C.createCalibration(match, '01'.repeat(32), 16);
  const b = C.createCalibration(match, '01'.repeat(32), 16);
  const c = C.createCalibration(match, '02'.repeat(32), 16);
  assert.deepEqual(a, b);
  assert.notEqual(a.keyCommitment, c.keyCommitment);
  assert.notDeepEqual(a.counts, c.counts);
  assert.equal(Object.values(a.counts).reduce((x, y) => x + y, 0), 16);
  assert.equal(a.live.length, require('../lib/football/v2/simulator').MAX_END / 60 + 1);
  assert.equal(Object.values(a.live[0]['0-0']).reduce((x, y) => x + y, 0), 16);
  assert.equal(Object.values(a.liveByState[0]['0-0|1|0-0']).reduce((x, y) => x + y, 0), 16);
  const p = C.probabilities(a);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-12);
  assert.equal(C.validateCalibration(a, b).reason, 'muestra_no_independiente');
  assert.equal(C.validateCalibration(a, c).reason, 'muestra_insuficiente');
  assert.equal(C.liveProbabilities(a, 0, { home: 0, away: 0 }), null, 'no se cotiza un estado con pocas observaciones');
  const quoted = C.liveProbabilities(a, 0, { home: 0, away: 0 }, 1);
  assert.ok(Math.abs(quoted.home + quoted.draw + quoted.away - 1) < 1e-12);
});

test('la calibración incluye goles del añadido y cuenta el resultado tras el pitido final', () => {
  const simulator = require('../lib/football/v2/simulator');
  const { derivedKey, secureRandom } = require('../lib/football/v2/secure-random');
  const match = input(), key = '01'.repeat(32), samples = 4;
  const actual = C.createCalibration(match, key, samples);
  const expected = {};
  let addedGoal = false;
  for (let index = 0; index < samples; index++) {
    const sim = simulator.createMatch({ ...match, random: secureRandom(derivedKey(key, `calibration:${index}`), 'game') });
    while (!sim.snapshot().ended) sim.step(10000);
    const final = sim.snapshot();
    const score = `${final.score.home}-${final.score.away}`;
    expected[score] = (expected[score] || 0) + 1;
    addedGoal ||= sim.eventsAfter(-1).some(e => e.type === 'goal' && e.time >= (final.clock.firstHalfEnd + 45) * 60);
  }
  assert.ok(addedGoal, 'la semilla de prueba debe contener un gol después del minuto reglamentario');
  assert.deepEqual(actual.counts, expected);
});

test('matriz empírica no trunca resultados y rechaza conteos inválidos', () => {
  const calibration = { samples: 4, counts: { '9-0': 1, '1-1': 1, '0-0': 2 } };
  const matrix = C.scoreMatrix(calibration);
  assert.equal(matrix.length, 10);
  assert.ok(matrix[9][0] > matrix[8][0]);
  assert.ok(Math.abs(matrix.flat().reduce((x, y) => x + y, 0) - 1) < 1e-12);
  assert.throws(() => C.scoreMatrix({ samples: 3, counts: { '1-1': 1 } }), /incompletos/);
  assert.throws(() => C.probabilities({ samples: 1, counts: { '1-x': 1 } }), /inválido/);
});

test('la validación en vivo separa mitad y expulsiones y contrasta un control independiente', () => {
  const data = { version: C.VERSION, simulatorVersion: require('../lib/football/v2/simulator').VERSION,
    inputHash: 'same', samples: 2048, counts: { '1-0': 1024, '0-0': 512, '0-1': 512 }, keyCommitment: 'a',
    liveByState: [{ '0-0|1|0-0': { home: 90, draw: 60, away: 50 }, '0-0|1|1-0': { home: 30, draw: 70, away: 100 } }] };
  const holdout = { ...data, keyCommitment: 'b', liveByState: [{
    '0-0|1|0-0': { home: 88, draw: 60, away: 52 }, '0-0|1|1-0': { home: 31, draw: 69, away: 100 }
  }] };
  const state = { minute: 0, score: { home: 0, away: 0 }, half: 1, redCards: { home: 0, away: 0 }, playStopped: false };
  const normal = C.validateLiveCalibration(data, holdout, state);
  assert.equal(normal.ok, true);
  const reduced = C.validateLiveCalibration(data, holdout, { ...state, redCards: { home: 1, away: 0 } });
  assert.equal(reduced.ok, true);
  assert.ok(normal.probabilities.home > reduced.probabilities.home);
  assert.equal(C.validateLiveCalibration(data, holdout, { ...state, half: 2 }).reason, 'estado_insuficiente');
  assert.equal(C.validateLiveCalibration(data, holdout, { ...state, playStopped: true }).reason, 'estado_insuficiente');
  const divergent = { ...holdout, liveByState: [{ '0-0|1|0-0': { home: 10, draw: 80, away: 110 } }] };
  assert.equal(C.validateLiveCalibration(data, divergent, state).reason, 'desviacion_en_vivo');
  assert.equal(C.validateLiveCalibration(data, { ...holdout, keyCommitment: 'a' }, state).reason, 'muestra_no_independiente');
});

test('la puerta estadística exige tamaño, entradas iguales y prueba separada', () => {
  const base = {
    version: C.VERSION, simulatorVersion: require('../lib/football/v2/simulator').VERSION,
    inputHash: 'same', samples: 2048, counts: { '1-0': 1024, '0-0': 512, '0-1': 512 }, keyCommitment: 'a'
  };
  const holdout = { ...base, keyCommitment: 'b' };
  assert.equal(C.validateCalibration(base, holdout).ok, true);
  assert.equal(C.validateCalibration(base, { ...holdout, inputHash: 'different' }).reason, 'entradas_distintas');
  const biased = { ...holdout, counts: { '1-0': 1400, '0-0': 400, '0-1': 248 } };
  assert.equal(C.validateCalibration(base, biased).reason, 'desviacion');
});
