'use strict';

// Investigación fuera de línea: las cuotas deben proceder de una distribución
// del MISMO motor, no de Poisson V1. No activa ni vende mercados por sí sola.
const crypto = require('node:crypto');
const simulator = require('./simulator');
const { secureRandom, derivedKey } = require('./secure-random');

const VERSION = 'v2-calibration-2';
const MIN_TRAIN = 2048;
const MIN_HOLDOUT = 2048;
// Umbrales fijados antes de contrastar las muestras: diferencias absolutas
// para 1X2, ambos anotan y total >2.5; son un filtro, no garantía de equidad.
const MAX_ABSOLUTE_DIFFERENCE = 0.045;
const scoreKey = score => `${score.home}-${score.away}`;
const liveStateKey = (score, half, redCards) => `${scoreKey(score)}|${half}|${redCards.home}-${redCards.away}`;
const hashInputs = input => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

function createCalibration(input, keyHex, samples) {
  if (!input || input.version !== simulator.VERSION || !input.home?.lineup || !input.away?.lineup) throw new Error('entradas V2 inválidas');
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 50000) throw new Error('muestra inválida');
  const counts = {};
  const live = Array.from({ length: simulator.MAX_END / 60 + 1 }, () => ({}));
  const liveByState = Array.from({ length: simulator.MAX_END / 60 + 1 }, () => ({}));
  for (let index = 0; index < samples; index++) {
    // Una muestra nunca usa la clave ni la trayectoria del partido real.
    const sampleKey = derivedKey(keyHex, `calibration:${index}`);
    const simulation = simulator.createMatch({ ...input, random: secureRandom(sampleKey, 'game') });
    const snapshots = [simulation.snapshot()];
    while (!snapshots.at(-1).ended) snapshots.push(simulation.step(60 / simulator.STEP));
    const result = snapshots.at(-1).score;
    const key = scoreKey(result);
    counts[key] = (counts[key] || 0) + 1;
    const outcome = result.home > result.away ? 'home' : result.home < result.away ? 'away' : 'draw';
    // El añadido cuenta para el resultado. No se genera una cotización para
    // instantes posteriores al pitazo final de cada réplica.
    for (let minute = 0; minute < snapshots.length - 1; minute++) {
      const current = scoreKey(snapshots[minute].score);
      const bucket = live[minute][current] || { home: 0, draw: 0, away: 0 };
      bucket[outcome]++;
      live[minute][current] = bucket;
      const snapshot = snapshots[minute];
      // Precio en vivo condicionado a mitad, marcador, expulsiones y balón en
      // juego. Un agregado por marcador solo mezcla estados distintos tras una roja.
      if (snapshot.phase === 'play') {
        const redCards = { home: 0, away: 0 };
        snapshot.players.filter(player => player.status === 'sent_off').forEach(player => { redCards[player.side]++; });
        const stateKey = liveStateKey(snapshot.score, snapshot.half, redCards);
        const stateBucket = liveByState[minute][stateKey] || { home: 0, draw: 0, away: 0 };
        stateBucket[outcome]++;
        liveByState[minute][stateKey] = stateBucket;
      }
    }
  }
  return { version: VERSION, simulatorVersion: simulator.VERSION, inputHash: hashInputs(input),
    keyCommitment: crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex'), samples, counts, live, liveByState };
}

function probabilities(calibration) {
  if (!calibration || !Number.isSafeInteger(calibration.samples) || calibration.samples <= 0) throw new Error('calibración inválida');
  const result = { home: 0, draw: 0, away: 0, btts: 0, over25: 0 };
  let total = 0;
  for (const [key, value] of Object.entries(calibration.counts || {})) {
    const match = /^(\d+)-(\d+)$/.exec(key);
    if (!match || !Number.isSafeInteger(value) || value < 0) throw new Error('conteo inválido');
    const home = Number(match[1]), away = Number(match[2]);
    total += value;
    result[home > away ? 'home' : home < away ? 'away' : 'draw'] += value;
    if (home && away) result.btts += value;
    if (home + away > 2.5) result.over25 += value;
  }
  if (total !== calibration.samples) throw new Error('conteos incompletos');
  for (const key of Object.keys(result)) result[key] /= total;
  return result;
}

function validateCalibration(training, holdout) {
  if (!training || !holdout || training.version !== VERSION || holdout.version !== VERSION
      || training.simulatorVersion !== simulator.VERSION || holdout.simulatorVersion !== simulator.VERSION
      || training.inputHash !== holdout.inputHash) return { ok: false, reason: 'entradas_distintas' };
  if (!training.keyCommitment || !holdout.keyCommitment || training.keyCommitment === holdout.keyCommitment) {
    return { ok: false, reason: 'muestra_no_independiente' };
  }
  if (training.samples < MIN_TRAIN || holdout.samples < MIN_HOLDOUT) return { ok: false, reason: 'muestra_insuficiente' };
  const a = probabilities(training), b = probabilities(holdout);
  const differences = Object.fromEntries(Object.keys(a).map(key => [key, Number(Math.abs(a[key] - b[key]).toFixed(6))]));
  return { ok: Object.values(differences).every(value => value <= MAX_ABSOLUTE_DIFFERENCE),
    reason: Object.values(differences).every(value => value <= MAX_ABSOLUTE_DIFFERENCE) ? null : 'desviacion', differences };
}

// Empírico con un único pseudopartido distribuido según las medias observadas.
// Repartir medio caso en cada celda inventaría decenas de partidos, inflando
// especialmente los marcadores altos. La matriz se amplía si aparece un 9–0.
function scoreMatrix(calibration) {
  probabilities(calibration); // verifica conteos y suma antes de publicar nada
  const scores = Object.entries(calibration.counts).map(([key, count]) => {
    const [home, away] = key.split('-').map(Number);
    return { home, away, count };
  });
  const max = Math.max(8, ...scores.map(item => Math.max(item.home, item.away)));
  if (max > 30) throw new Error('marcador fuera de rango de calibración');
  const mean = side => scores.reduce((sum, item) => sum + item[side] * item.count, 0) / calibration.samples;
  const prior = average => {
    const values = [Math.exp(-average)];
    for (let n = 1; n <= max; n++) values.push(values[n - 1] * average / n);
    const total = values.reduce((sum, value) => sum + value, 0);
    return values.map(value => value / total);
  };
  const homePrior = prior(mean('home')), awayPrior = prior(mean('away'));
  const denominator = calibration.samples + 1;
  const matrix = Array.from({ length: max + 1 }, (_, home) =>
    Array.from({ length: max + 1 }, (_, away) => homePrior[home] * awayPrior[away] / denominator));
  for (const item of scores) matrix[item.home][item.away] += item.count / denominator;
  return matrix;
}

function liveProbabilities(calibration, minute, score, minSamples = 200) {
  if (!Number.isFinite(minute) || minute < 0 || minute >= simulator.MAX_END / 60
      || !score || !Number.isSafeInteger(score.home) || !Number.isSafeInteger(score.away)) return null;
  const bucket = calibration?.live?.[Math.floor(minute)]?.[scoreKey(score)];
  if (!bucket) return null;
  const n = bucket.home + bucket.draw + bucket.away;
  if (!Number.isSafeInteger(n) || n < minSamples) return null;
  return { home: (bucket.home + 0.5) / (n + 1.5), draw: (bucket.draw + 0.5) / (n + 1.5),
    away: (bucket.away + 0.5) / (n + 1.5), samples: n };
}

function liveStateProbabilities(calibration, state, minSamples = 200) {
  const { minute, score, half, redCards, playStopped } = state || {};
  if (playStopped || !Number.isFinite(minute) || minute < 0 || minute >= simulator.MAX_END / 60
      || !score || !Number.isSafeInteger(score.home) || score.home < 0
      || !Number.isSafeInteger(score.away) || score.away < 0 || ![1, 2].includes(half)
      || !redCards || !Number.isSafeInteger(redCards.home) || redCards.home < 0
      || !Number.isSafeInteger(redCards.away) || redCards.away < 0
      || !Number.isSafeInteger(minSamples) || minSamples < 1) return null;
  const bucket = calibration?.liveByState?.[Math.floor(minute)]?.[liveStateKey(score, half, redCards)];
  if (!bucket || !['home', 'draw', 'away'].every(key => Number.isSafeInteger(bucket[key]) && bucket[key] >= 0)) return null;
  const n = bucket.home + bucket.draw + bucket.away;
  if (!Number.isSafeInteger(n) || n < minSamples) return null;
  return { home: (bucket.home + 0.5) / (n + 1.5), draw: (bucket.draw + 0.5) / (n + 1.5),
    away: (bucket.away + 0.5) / (n + 1.5), samples: n };
}

// Comprueba el estado observado contra una segunda muestra independiente; no
// basta con que el promedio prepartido pase el control de 1X2 y goles.
function validateLiveCalibration(training, holdout, state, { minSamples = 200, maxDifference = 0.1 } = {}) {
  let pre;
  try { pre = validateCalibration(training, holdout); } catch (_) { return { ok: false, reason: 'calibracion_invalida' }; }
  if (!pre.ok) return { ok: false, reason: pre.reason };
  if (!Number.isFinite(maxDifference) || maxDifference <= 0 || maxDifference > 1) return { ok: false, reason: 'umbral_invalido' };
  const a = liveStateProbabilities(training, state, minSamples);
  const b = liveStateProbabilities(holdout, state, minSamples);
  if (!a || !b) return { ok: false, reason: 'estado_insuficiente' };
  const differences = Object.fromEntries(['home', 'draw', 'away'].map(key => [key, Number(Math.abs(a[key] - b[key]).toFixed(6))]));
  const ok = Object.values(differences).every(value => value <= maxDifference);
  return { ok, reason: ok ? null : 'desviacion_en_vivo', differences, probabilities: a,
    samples: { training: a.samples, holdout: b.samples } };
}

module.exports = { VERSION, MIN_TRAIN, MIN_HOLDOUT, MAX_ABSOLUTE_DIFFERENCE, hashInputs,
  createCalibration, probabilities, validateCalibration, scoreMatrix, liveProbabilities,
  liveStateProbabilities, validateLiveCalibration };
