'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeasonClubs } = require('../lib/football/teams');
const { mulberry32 } = require('../lib/football/prng');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { createCalibration } = require('../lib/football/v2/calibration');
const { calibrateInWorker } = require('../lib/football/v2/calibration-async');

function matchInput() {
  const clubs = buildSeasonClubs(mulberry32(123));
  return prepareMatchInputs({ league: { seasonMonth: '2026-11', config: clubs, calendar: { matches: [] } },
    match: { seasonMonth: '2026-11', homeId: clubs[0].id, awayId: clubs[1].id },
    asOf: Date.UTC(2026, 10, 1), seed: 0 });
}

test('la calibración en worker coincide con la sincrónica sin bloquear el proceso principal', async () => {
  const input = matchInput(), key = 'a2'.repeat(32);
  let completed = false;
  const pending = calibrateInWorker(input, key, 2).then(result => { completed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  const sample = await pending;
  assert.deepEqual(sample, createCalibration(input, key, 2));
});

test('la calibración en worker se puede cancelar y propaga errores sin mutar las entradas', async () => {
  const input = matchInput(), before = JSON.stringify(input);
  const controller = new AbortController();
  const pending = calibrateInWorker(input, 'a1'.repeat(32), 2048, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelada/);
  await assert.rejects(calibrateInWorker(input, 'inválida', 1), /256 bits/);
  await assert.rejects(calibrateInWorker(input, 'a1'.repeat(32), 0), /muestra inválida/);
  assert.equal(JSON.stringify(input), before);
});
