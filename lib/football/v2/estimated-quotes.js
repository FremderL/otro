'use strict';

// Probabilidades estimadas a partir de Monte Carlo del motor causal actual.
// El prior se genera con partidos completos y sintéticos; no son líneas de casas
// ni resultados reales. Margen y normalización se aplican después de estimar la
// distribución, y cada snapshot queda ligado a su fórmula y simulador.
//
// v2-estimated-3 / fórmula v2-mc-2. El prior sigue siendo el Monte Carlo de
// v2-causal-4 (score-prior-causal-4.json, 2.048 partidos de entrenamiento y
// 2.048 de control); lo que se recalibra es el TILT que lo repondera por fuerza
// de los equipos. La fórmula anterior (v2-mc-1, congelada en
// estimated-quotes-v2.js) medía la fuerza casi solo con los ratings att/def/gk
// y dejaba FUERA los atributos que mueven el simulador: la velocidad media del
// once (pac) llega a valer +24 puntos porcentuales de victoria local en el
// motor y cotizaba 0, el defensa del portero (gk) cotizaba 10 veces menos de lo
// que el motor lo usa, y el elo se llevaba la cuarta parte de su efecto real.
// Consecuencia medida en jornada 9: casi todos los favoritos cotizaban por
// encima de 2.00 y en varios partidos la fórmula declaraba favorito al equipo
// que el motor favorecía menos.
//
// Calibración de v2-mc-2 contra v2-causal-4 (réplicas de partidos completos,
// ~350 semillas por escenario, protocolo «baseline gemelos + un factor a la
// vez» de v2-tilt-2, más cruces de plantillas reales y dos climas de goles):
//  - Baseline gemelos: H .348 / X .259 / A .394 y ~2.48 goles -> KAPPA0 y
//    EDGE0. El residuo de local de este motor es NEGATIVO (el simulador no
//    tiene ventaja de local real; ~-5 pp en gemelos), así que EDGE0 es negativo
//    y la cuota refleja lo que el generador produce, no lo que produce el
//    fútbol real (la banda de realismo se mide aparte con football:odds-audit).
//  - Un factor a la vez (respuesta medida del simulador -> pesos):
//      att/def ±0.18 espejo  -> +8 pp local  -> att y def 0.20 c/u (antes 0.27);
//      elo ±150 espejo      -> +7.7 pp      -> elo 0.14 (antes 0.04);
//      gk rating ±0.18      -> +8 pp        -> gk 0.27;
//      once sho ±10         -> +9.4 pp      -> sho 0.008;
//      once pas ±10         -> +2.6 pp      -> pas 0.007 (antes 0.0028);
//      once def attr ±10    -> +5.7 pp      -> defAttr 0.009 (antes INEXISTENTE);
//      once pac ±10         -> +24 pp       -> pac 0.017 (antes INEXISTENTE);
//      portero gk 92/70     -> +8.3 pp      -> gkAttr 0.009 (antes 0.0006);
//      clima leagueAvg 1.05/1.70 -> goles 2.08/2.85 -> KAPPA_L 0.55 (antes 2:
//        la respuesta del generador al clima es suave y el tilt anterior
//        hundía los empates solo por observar una liga goleadora).
//  - KAPPA_Q 0.6 sobre la fuerza media de ambos (los equipos fuertes
//    producen partidos con más goles: 2.23-3.23 según el cruce).
// El ajuste deja el error por escenario dentro de ~±3.5 pp en la mayoría de los
// cruces (medición con ruido ~±2.5 pp); persiste un desfase de hasta ~9 pp en
// ciertos cruces de plantillas cuya fuerza no capturan las medias de atributos
// (estructura por puesto). Los modelos anteriores conservan su matriz congelada
// y se validan con sus fórmulas intactas: una cuota comprometida nunca se
// recalcula con otra fórmula.
const prior = require('./score-prior-causal-4.json');
const odds = require('../odds');
const { hashInputs } = require('./calibration');
const { simulatorFor } = require('./versions');

const VERSION = 'v2-estimated-3';
const FORMULA = 'v2-mc-2';
const SIZE = 9;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// Constantes de la calibración (ver cabecera); no son libres en producción.
const KAPPA0 = -0.14;
const EDGE0 = -0.03;
const KAPPA_L = 0.55;
const KAPPA_Q = 0.6;
const TILT_LIMIT = 0.9;
const EDGE_WEIGHTS = { elo: 0.14, att: 0.20, oneMinusDef: 0.20, gk: 0.27, sho: 0.008, pas: 0.007, defAttr: 0.009, pac: 0.017, gkAttr: 0.009 };

function meanAttribute(lineup, name) {
  const players = lineup?.players?.filter(player => player.initialStatus === 'active' && player.pos !== 'GK') || [];
  const values = players.map(player => Number(player.attrs?.[name])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 65;
}
function goalkeeperAttribute(lineup) {
  const gk = (lineup?.players || []).find(player => player.initialStatus === 'active' && player.pos === 'GK');
  const value = Number(gk?.attrs?.gk);
  return Number.isFinite(value) ? value : 75;
}
function rating(team, key, fallback) {
  const value = Number(team?.ratings?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function teamFeatures(team) {
  return {
    elo: (rating(team, 'elo', 1500) - 1500) / 400,
    att: clamp(rating(team, 'att', 1), 0.7, 1.35) - 1,
    oneMinusDef: 1 - clamp(rating(team, 'def', 1), 0.7, 1.35),
    gk: clamp(rating(team, 'gk', 1), 0.7, 1.35) - 1,
    sho: meanAttribute(team.lineup, 'sho') - 63,
    pas: meanAttribute(team.lineup, 'pas') - 70,
    defAttr: meanAttribute(team.lineup, 'def') - 60,
    pac: meanAttribute(team.lineup, 'pac') - 70,
    gkAttr: goalkeeperAttribute(team.lineup) - 80
  };
}
const weighted = (features, weights) => Object.keys(weights).reduce((sum, key) => sum + weights[key] * features[key], 0);
function buildMatrix(homeTilt, awayTilt, knockout) {
  let sum = 0;
  const matrix = Array.from({ length: SIZE }, (_, h) => Array.from({ length: SIZE }, (_, a) => {
    const weight = ((prior.counts[`${h}-${a}`] || 0) + 0.2) * Math.exp(homeTilt * h + awayTilt * a);
    sum += weight; return weight;
  }));
  const normal = matrix.map(row => row.map(value => value / sum));
  if (!knockout) return normal;
  // Solo los empates al 90 añaden treinta minutos; la tanda no suma goles al
  // marcador de 1X2. Es una aproximación, no consulta el replay comprometido.
  let meanHome = 0, meanAway = 0;
  for (let h = 0; h < SIZE; h++) for (let a = 0; a < SIZE; a++) {
    meanHome += h * normal[h][a]; meanAway += a * normal[h][a];
  }
  const extraHome = poisson(meanHome / 3 * 0.85), extraAway = poisson(meanAway / 3 * 0.85);
  const result = normal.map((row, h) => row.map((value, a) => h === a ? 0 : value));
  for (let score = 0; score < SIZE; score++) for (let h = 0; h < extraHome.length; h++) {
    for (let a = 0; a < extraAway.length; a++) result[Math.min(SIZE - 1, score + h)][Math.min(SIZE - 1, score + a)]
      += normal[score][score] * extraHome[h] * extraAway[a];
  }
  return result;
}
function calculateMatrix(input) {
  const fh = teamFeatures(input.home), fa = teamFeatures(input.away);
  const avg = Number(input.context?.leagueAvg);
  const climate = clamp(Math.log((Number.isFinite(avg) && avg > 0 ? avg : 1.35) / 1.35) * KAPPA_L, -0.45, 0.45);
  const quality = (weighted(fh, EDGE_WEIGHTS) + weighted(fa, EDGE_WEIGHTS)) / 2;
  const base = KAPPA0 + climate + KAPPA_Q * quality;
  const edge = EDGE0 + weighted(fh, EDGE_WEIGHTS) - weighted(fa, EDGE_WEIGHTS);
  return buildMatrix(clamp(base + edge, -TILT_LIMIT, TILT_LIMIT), clamp(base - edge, -TILT_LIMIT, TILT_LIMIT),
    input.knockout === true);
}
function createModel(input) {
  if (input?.version !== prior.simulatorVersion || !simulatorFor(input?.version)
      || !input.home?.lineup || !input.away?.lineup) throw new Error('entradas estimadas V2 inválidas');
  return { version: VERSION, formula: FORMULA, simulatorVersion: input.version, inputHash: hashInputs(input),
    priorVersion: prior.version, monteCarloSamples: prior.samples, holdoutSamples: prior.holdoutSamples,
    knockout: input.knockout === true, matrix: calculateMatrix(input) };
}
function validModel(model, input) {
  if (!model || model.version !== VERSION || model.formula !== FORMULA || !simulatorFor(model.simulatorVersion)
      || model.priorVersion !== prior.version || model.monteCarloSamples !== prior.samples
      || model.holdoutSamples !== prior.holdoutSamples || typeof model.knockout !== 'boolean'
      || !/^[0-9a-f]{64}$/i.test(String(model.inputHash || ''))
      || !Array.isArray(model.matrix) || model.matrix.length !== SIZE) return false;
  let sum = 0;
  for (const row of model.matrix) {
    if (!Array.isArray(row) || row.length !== SIZE || row.some(value => !Number.isFinite(value) || value <= 0 || value > 1)) return false;
    sum += row.reduce((total, value) => total + value, 0);
  }
  if (Math.abs(sum - 1) > 1e-9) return false;
  if (input) {
    try {
      // La matriz se recalcula con la misma fórmula versionada que la generó.
      const matrix = calculateMatrix(input);
      return model.simulatorVersion === input.version && model.inputHash === hashInputs(input)
        && model.knockout === (input.knockout === true)
        && matrix.every((row, h) => row.every((value, a) => value === model.matrix[h][a]));
    } catch (_) { return false; }
  }
  return true;
}
function scoreMatrix(model) {
  if (!validModel(model)) throw new Error('modelo estimado inválido');
  return model.matrix.map(row => row.slice());
}
function preMatchMarkets(model, options = {}) {
  if (!validModel(model)) return null;
  const markets = odds.buildPreMatchMarkets(scoreMatrix(model), options);
  // Una cobertura de doble oportunidad no debe quedar arbitrable por redondeo.
  const dc = markets.double_chance;
  if (dc?.degenerate) {
    for (const selection of dc.selections) {
      selection.price = odds.floorGrid(selection.price * 0.98);
      selection.implied = Number(odds.impliedProb(selection.price).toFixed(4));
    }
    dc.degenerate = Object.values(odds.DOUBLE_CHANCE_COVER).some(keys =>
      keys.reduce((sum, key) => sum + odds.impliedProb(dc.selections.find(item => item.key === key).price), 0) < 1 - 1e-9);
    dc.overround = Number(odds.overround(dc.selections.map(item => item.price)).toFixed(5));
    dc.repaired = true;
  }
  return markets;
}
function poisson(lambda) {
  const probabilities = [Math.exp(-lambda)];
  for (let i = 1; i <= 12; i++) probabilities.push(probabilities[i - 1] * lambda / i);
  const sum = probabilities.reduce((a, b) => a + b, 0);
  return probabilities.map(p => p / sum);
}
function liveScoreMatrix(model, state, { allowStopped = false } = {}) {
  if (!validModel(model) || (!allowStopped && state?.playStopped) || !Number.isFinite(state?.minute) || state.minute < 0
      || (state.half === 3 ? (!model.knockout || state.minute >= 128) : state.minute >= 98)
      || !state.score || !Number.isSafeInteger(state.score.home) || state.score.home < 0 || state.score.home > 30
      || !Number.isSafeInteger(state.score.away) || state.score.away < 0 || state.score.away > 30 || ![1, 2, 3].includes(state.half)
      || !state.redCards || !Number.isSafeInteger(state.redCards.home) || state.redCards.home < 0
      || !Number.isSafeInteger(state.redCards.away) || state.redCards.away < 0) return null;
  const matrix = scoreMatrix(model), mean = { home: 0, away: 0 };
  for (let h = 0; h < matrix.length; h++) for (let a = 0; a < matrix[h].length; a++) {
    mean.home += h * matrix[h][a]; mean.away += a * matrix[h][a];
  }
  // Se usa un final estimado público, nunca el añadido privado del replay.
  const remaining = state.half === 3 ? clamp((125 - state.minute) / 96, 0.006, 1 / 3)
    : clamp((96 - state.minute) / 96, 0.006, 1);
  const diff = state.score.home - state.score.away;
  const factor = (sideDiff, ownRed, rivalRed) => clamp((sideDiff < 0 ? 1.08 : sideDiff > 0 ? 0.96 : 1)
    * Math.pow(0.8, Math.min(ownRed, 5)) * Math.pow(1.13, Math.min(rivalRed, 5)), 0.2, 2);
  const ph = poisson(clamp(mean.home * remaining * factor(diff, state.redCards.home, state.redCards.away), 0.003, 4));
  const pa = poisson(clamp(mean.away * remaining * factor(-diff, state.redCards.away, state.redCards.home), 0.003, 4));
  const final = Array.from({ length: state.score.home + ph.length }, () => new Array(state.score.away + pa.length).fill(0));
  for (let h = 0; h < ph.length; h++) for (let a = 0; a < pa.length; a++) {
    final[state.score.home + h][state.score.away + a] = ph[h] * pa[a];
  }
  return final;
}
function liveMarket(model, state) {
  const matrix = liveScoreMatrix(model, state);
  if (!matrix) return null;
  const probs = { home: 0, draw: 0, away: 0 };
  for (let h = 0; h < matrix.length; h++) for (let a = 0; a < matrix[h].length; a++) {
    probs[h > a ? 'home' : h < a ? 'away' : 'draw'] += matrix[h][a];
  }
  return odds.publishMarket(probs, odds.MARGINS['1x2'] + odds.LIVE_MARGIN_BUMP);
}

module.exports = { VERSION, FORMULA, SIMULATOR_VERSION: prior.simulatorVersion,
  createModel, validModel, scoreMatrix, preMatchMarkets, liveScoreMatrix, liveMarket };
