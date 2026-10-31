'use strict';

// Investigación de cuotas del mismo simulador. No activa mercados ni persiste
// partidos; la integración debe confirmar el snapshot y la liquidación de fichas.
const crypto = require('node:crypto');
const calibration = require('./calibration');
const odds = require('../odds');
const { simulatorFor } = require('./versions');
const estimated = require('./estimated-quotes');

const VERSION = 'v2-quotes-2';
const LEGACY_VERSION = 'v2-quotes-1';
const CONFIDENCE_Z = 3.3;

function createQuoteModel(input, matchKey, training, holdout, version = VERSION) {
  if (![VERSION, LEGACY_VERSION].includes(version)) throw new Error('versión de cuotas inválida');
  if (!input || !simulatorFor(input.version) || !/^[0-9a-f]{64}$/i.test(String(matchKey || ''))) {
    throw new Error('partido o clave V2 inválidos');
  }
  const inputHash = calibration.hashInputs(input);
  if (!/^[0-9a-f]{64}$/i.test(String(training?.keyCommitment || ''))
      || !/^[0-9a-f]{64}$/i.test(String(holdout?.keyCommitment || ''))) throw new Error('huella de calibración inválida');
  if (training?.simulatorVersion !== input.version || holdout?.simulatorVersion !== input.version
      || training?.inputHash !== inputHash || holdout?.inputHash !== inputHash) {
    throw new Error('la calibración corresponde a otras entradas');
  }
  const matchCommitment = crypto.createHash('sha256').update(Buffer.from(matchKey, 'hex')).digest('hex');
  if (training.keyCommitment === matchCommitment || holdout.keyCommitment === matchCommitment) {
    throw new Error('la muestra no es independiente de la clave del partido');
  }
  const validation = calibration.validateCalibration(training, holdout);
  if (!validation.ok) throw new Error(`calibración rechazada: ${validation.reason}`);
  // Se persisten solo los histogramas necesarios; la tabla agregada antigua de
  // entrenamiento en vivo no debe duplicar los buckets por estado.
  const compact = sample => ({ version: sample.version, simulatorVersion: sample.simulatorVersion,
    inputHash: sample.inputHash, keyCommitment: sample.keyCommitment, samples: sample.samples,
    counts: sample.counts, liveByState: sample.liveByState });
  const result = JSON.parse(JSON.stringify({ version, simulatorVersion: input.version, inputHash,
    training: compact(training), holdout: compact(holdout) }));
  if (JSON.stringify(result).length > 2000000) throw new Error('calibración demasiado grande');
  const freeze = object => {
    if (!object || typeof object !== 'object' || Object.isFrozen(object)) return object;
    Object.values(object).forEach(freeze);
    return Object.freeze(object);
  };
  return freeze(result);
}

function validModel(model, input) {
  if (model?.version === estimated.VERSION) return estimated.validModel(model, input);
  if (!model || ![VERSION, LEGACY_VERSION].includes(model.version) || !simulatorFor(model.simulatorVersion)
      || model.training?.simulatorVersion !== model.simulatorVersion || model.holdout?.simulatorVersion !== model.simulatorVersion
      || !/^[0-9a-f]{64}$/i.test(String(model.training?.keyCommitment || ''))
      || !/^[0-9a-f]{64}$/i.test(String(model.holdout?.keyCommitment || ''))
      || model.training?.inputHash !== model.inputHash || model.holdout?.inputHash !== model.inputHash) return false;
  try { return calibration.validateCalibration(model.training, model.holdout).ok; }
  catch (_) { return false; }
}

// Intervalo de Wilson: protege de parte del error de muestreo, no de errores
// estructurales del modelo ni de diferencias entre múltiples partidos.
function probabilityBound(probability, samples, upper) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !Number.isSafeInteger(samples) || samples < 1) return null;
  const z2 = CONFIDENCE_Z ** 2;
  const center = probability + z2 / (2 * samples);
  const spread = CONFIDENCE_Z * Math.sqrt((probability * (1 - probability) + z2 / (4 * samples)) / samples);
  return Math.max(0, Math.min(1, (center + (upper ? spread : -spread)) / (1 + z2 / samples)));
}

function protectMarket(book, samples, margin, { allOrNothing = false } = {}) {
  if (!book || book.degenerate) return null;
  const selections = [];
  for (const selection of book.selections) {
    const upper = probabilityBound(selection.prob, samples, true);
    const lower = probabilityBound(selection.prob, samples, false);
    if (upper == null || lower == null || upper <= 0) return null;
    const cap = 1 / (upper * (1 + margin));
    // En marcador exacto no se puede quitar una celda sin redefinir «otros».
    // En los demás mercados se puede omitir solo la selección sin precio seguro.
    if (cap < odds.PRICE_MIN) {
      if (allOrNothing) return null;
      continue;
    }
    const price = Math.min(selection.price, odds.floorGrid(cap));
    selections.push({ ...selection, price, implied: Number(odds.impliedProb(price).toFixed(4)), cashoutProbability: lower });
  }
  if (!selections.length) return null;
  const overround = odds.overround(selections.map(item => item.price));
  return { ...book, selections, incomplete: selections.length !== book.selections.length, overround: Number(overround.toFixed(5)),
    ...(book.independent ? {} : { margin: Number((overround - 1).toFixed(5)) }) };
}

function preMatchMarkets(model) {
  if (!validModel(model)) return null;
  if (model.version === estimated.VERSION) return estimated.preMatchMarkets(model);
  try {
    const markets = odds.buildPreMatchMarkets(calibration.scoreMatrix(model.training));
    if (model.version === LEGACY_VERSION) return markets;
    return Object.fromEntries(Object.entries(markets).map(([key, book]) => [key,
      protectMarket(book, model.training.samples, book.targetMargin ?? odds.MARGINS.double_chance, { allOrNothing: key === 'correct_score' })]));
  } catch (_) { return null; }
}

function preMatchMarket(model, marketKey) {
  const market = preMatchMarkets(model)?.[marketKey];
  return market && !market.degenerate ? market : null;
}

// El llamador debe suministrar exclusivamente un estado autoritativo ya
// revelado; la clave, duración final y eventos futuros no participan del precio.
function liveMarket(model, marketKey, state, options) {
  if (marketKey !== '1x2' || !validModel(model)) return null;
  if (model.version === estimated.VERSION) return estimated.liveMarket(model, state);
  const checked = calibration.validateLiveCalibration(model.training, model.holdout, state, options);
  if (!checked.ok) return null;
  const { home, draw, away } = checked.probabilities;
  const margin = odds.MARGINS['1x2'] + odds.LIVE_MARGIN_BUMP;
  const book = odds.publishMarket({ home, draw, away }, margin);
  const market = model.version === LEGACY_VERSION ? book : protectMarket(book, checked.samples.training, margin);
  return !market || market.degenerate ? null : { ...market, sampleSizes: checked.samples };
}

function scoreMatrix(model) {
  if (!validModel(model)) throw new Error('modelo de cuotas inválido');
  return model.version === estimated.VERSION ? estimated.scoreMatrix(model) : calibration.scoreMatrix(model.training);
}

module.exports = { VERSION, LEGACY_VERSION, ESTIMATED_VERSION: estimated.VERSION, CONFIDENCE_Z,
  createQuoteModel, createEstimatedModel: estimated.createModel, validModel, scoreMatrix,
  probabilityBound, protectMarket, preMatchMarkets, preMatchMarket, liveMarket };
