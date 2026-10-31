'use strict';

// Preparación experimental: calcula dos muestras fuera del proceso principal y
// confirma instantánea y cuotas en UNA escritura. No la conecta al scheduler:
// faltan cobertura live, futuros y desempates para hacer V2 oficial.
const { prepareMatchInputs, previousMonth } = require('./inputs');
const { makeCommitment, verifyCommitment } = require('./commitment');
const { MIN_TRAIN, MIN_HOLDOUT, hashInputs } = require('./calibration');
const { calibrateInWorker } = require('./calibration-async');
const { hasPriorObligations } = require('./prepare');
const { withSeasonAdmission } = require('../season-admission');
const { newKey } = require('./secure-random');

const pending = new WeakMap();
const copy = value => JSON.parse(JSON.stringify(value));

function markUnconfirmed(match, value) {
  Object.defineProperty(match, 'simulationUnconfirmed', { value, writable: true, configurable: true, enumerable: false });
}

function eligible(store, match, now) {
  if (!store || !match || store.getMatch?.(match.id, match.seasonMonth) !== match) return 'partido_inexistente';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(match.seasonMonth)) || match.seasonMonth < '2026-11') return 'temporada_anterior';
  if (match.status !== 'scheduled' || match.desempate || !Number.isSafeInteger(now) || now < 1
      || !Number.isSafeInteger(match.scheduledKickoffAt) || now >= match.scheduledKickoffAt) return 'partido_no_preparable';
  if (typeof store.saveStrict !== 'function') return 'persistencia_no_confirmable';
  return null;
}

async function prepareOnce({ store, match, clock, keyFactory, calibrate, signal }) {
  const startedAt = clock();
  const problem = eligible(store, match, startedAt);
  if (problem) return { ok: false, reason: problem };
  if (match.simulation) return { ok: false, reason: 'compromiso_existente' };
  if (hasPriorObligations(store, match)) return { ok: false, reason: 'compromisos_anteriores' };

  let inputs, key, trainingKey, holdoutKey, inputHash;
  try {
    const league = store.getLeague(match.seasonMonth);
    const previous = store.getLeague(previousMonth(match.seasonMonth));
    inputs = prepareMatchInputs({ league, previousLeague: previous, match, asOf: startedAt, seed: 0 });
    inputHash = hashInputs(inputs);
    key = keyFactory(); trainingKey = keyFactory(); holdoutKey = keyFactory();
    if (![key, trainingKey, holdoutKey].every(item => /^[0-9a-f]{64}$/i.test(String(item)))
        || new Set([key.toLowerCase(), trainingKey.toLowerCase(), holdoutKey.toLowerCase()]).size !== 3) {
      throw new Error('claves de muestreo no independientes');
    }
  } catch (error) {
    return { ok: false, reason: 'entradas_invalidas', message: String(error?.message || error) };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let training, holdout;
  try {
    const run = (sampleKey, count) => Promise.resolve().then(() =>
      calibrate(copy(inputs), sampleKey, count, { signal: controller.signal }));
    [training, holdout] = await Promise.all([run(trainingKey, MIN_TRAIN), run(holdoutKey, MIN_HOLDOUT)]);
  } catch (error) {
    controller.abort();
    return { ok: false, reason: 'calibracion_fallida', message: String(error?.message || error) };
  } finally { signal?.removeEventListener('abort', abort); }
  if (controller.signal.aborted) return { ok: false, reason: 'calibracion_cancelada' };

  return withSeasonAdmission(store, match.seasonMonth, async () => {
    if (signal?.aborted) return { ok: false, reason: 'calibracion_cancelada' };
    const endedAt = clock();
    const problemAtCommit = eligible(store, match, endedAt);
    if (problemAtCommit || endedAt < startedAt) return { ok: false, reason: problemAtCommit || 'reloj_invalido' };
    // Mientras se calcula, una apuesta, una preparación manual o el kickoff
    // pueden ganar la carrera. Nunca convertir silenciosamente su compromiso.
    if (match.simulation) return { ok: false, reason: 'compromiso_existente' };
    if (hasPriorObligations(store, match)) return { ok: false, reason: 'compromisos_anteriores' };
    let record;
    try {
      if (hashInputs(inputs) !== inputHash) throw new Error('entradas alteradas durante la calibración');
      record = makeCommitment(inputs, key, startedAt, { training, holdout });
      if (!verifyCommitment(record, match)) throw new Error('identidad del partido alterada');
    } catch (error) {
      return { ok: false, reason: 'calibracion_invalida', message: String(error?.message || error) };
    }
    match.simulation = record;
    markUnconfirmed(match, true);
    // Ante una respuesta incierta se conserva el mismo compromiso, ya con
    // cuotas, para que prepareV2Match confirme o recupere esa misma escritura.
    try { if (!(await store.saveStrict())) return { ok: false, reason: 'persistencia_pendiente' }; }
    catch (_) { return { ok: false, reason: 'persistencia_pendiente' }; }
    markUnconfirmed(match, false);
    return { ok: true, existing: false };
  });
}

function preparePricedV2Match({ store, match, clock = Date.now, keyFactory = newKey,
  calibrate = calibrateInWorker, signal } = {}) {
  if (!store || !match || typeof match !== 'object' || typeof clock !== 'function'
      || typeof keyFactory !== 'function' || typeof calibrate !== 'function') {
    return Promise.resolve({ ok: false, reason: 'partido_inexistente' });
  }
  let byMatch = pending.get(store);
  if (!byMatch) { byMatch = new Map(); pending.set(store, byMatch); }
  if (byMatch.has(match.id)) return byMatch.get(match.id);
  const operation = prepareOnce({ store, match, clock, keyFactory, calibrate, signal });
  byMatch.set(match.id, operation);
  return operation.finally(() => { if (byMatch.get(match.id) === operation) byMatch.delete(match.id); });
}

module.exports = { preparePricedV2Match };
