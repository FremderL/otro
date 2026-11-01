'use strict';

// Estimación aproximada para el mercado V2, separada del generador de jugadas.
// El prior es una cohorte sintética V2 (no apuestas reales); ni el modelo ni el
// margen publicado prometen una ventaja económica determinada. Las cuotas y
// snapshots antiguos conservan sus propias versiones.
//
// Calibración del tilt (fórmula v2-tilt-2) contra el simulador v2-causal-3 por
// Monte Carlo (multiplicidad 300 por escenario salvo donde se indica):
//  - Baseline «gemelos» (16 clubes × 200, plantillas idénticas a ambos lados):
//    H .367 / X .276 / A .357 y ~2.76 goles por partido -> KAPPA0 y EDGE0.
//    El motor no tiene ventaja de local; EDGE0 es el residuo de esa baseline.
//  - Un factor a la vez sobre la baseline: att/def ±0.18 espejo -> +12 pts
//    local; delanteros 85/65 -> +8.7 pts -> EDGE_WEIGHTS. Los pesos sin
//    medición directa (pas, portero) usan las razones de coeficientes de
//    makePlayer del simulador.
//  - Elo: el motor responde (+9.4 pts con +150, un factor a la vez), pero su
//    efecto directo es pequeño (±0.04 en las tasas) y, verificado por round
//    robin (240 emparejamientos × 15) en ligas generadas, el elo sembrado no
//    correlaciona con la fuerza real que mide el motor (la dirigen att/def/gk
//    y las plantillas); un peso grande invertiría favoritos, así que queda
//    residual.
//  - Clima de goles (200, leagueAvg 1.6): empates .276 -> .200 -> KAPPA_L.
// Los modelos preparados con la fórmula anterior no llevan etiqueta `formula`;
// conservan su matriz congelada y se validan con la fórmula anterior intacta:
// una cuota comprometida nunca se recalcula con otra fórmula.
const prior = require('./score-prior.json');
const odds = require('../odds');
const { hashInputs } = require('./calibration');
const { simulatorFor } = require('./versions');

const VERSION = 'v2-estimated-1';
const FORMULA = 'v2-tilt-2';
const SIZE = 9;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// Constantes de la calibración (ver cabecera); no son libres en producción.
const KAPPA0 = -0.2;
const EDGE0 = 0.034;
const KAPPA_L = 2;
const KAPPA_Q = 0.5;
const TILT_LIMIT = 0.9;
const EDGE_WEIGHTS = { elo: 0.04, att: 0.27, oneMinusDef: 0.27, gk: 0.25, sho: 0.0065, pas: 0.0028, gkAttr: 0.0006 };

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
// Fórmula anterior. Congelada: solo validModel la usa con modelos preparados
// antes de v2-tilt-2 (sin etiqueta `formula`). No modificar.
function calculateMatrixLegacy(input) {
  const home = input.home, away = input.away;
  const eloDiff = clamp((rating(home, 'elo', 1500) - rating(away, 'elo', 1500)) / 400, -1, 1);
  const avg = Number(input.context?.leagueAvg);
  const climate = clamp(Math.log((Number.isFinite(avg) && avg > 0 ? avg : 1.35) / 1.35) * 0.55, -0.22, 0.2);
  const tilt = (team, rival, sign) => clamp(climate + sign * eloDiff * 0.06
    + 0.40 * (clamp(rating(team, 'att', 1), 0.7, 1.35) - 1)
    + 0.26 * (clamp(rating(rival, 'def', 1), 0.7, 1.35) - 1)
    - 0.22 * (clamp(rating(rival, 'gk', 1), 0.7, 1.35) - 1)
    + 0.003 * (meanAttribute(team.lineup, 'sho') - 63)
    + 0.002 * (meanAttribute(team.lineup, 'pas') - 70), -0.42, 0.42);
  return buildMatrix(tilt(home, away, 1), tilt(away, home, -1), input.knockout === true);
}
function createModel(input) {
  if (!simulatorFor(input?.version) || !input.home?.lineup || !input.away?.lineup) throw new Error('entradas estimadas V2 inválidas');
  return { version: VERSION, formula: FORMULA, simulatorVersion: input.version, inputHash: hashInputs(input),
    priorVersion: prior.version, knockout: input.knockout === true, matrix: calculateMatrix(input) };
}
function validModel(model, input) {
  if (!model || model.version !== VERSION || !simulatorFor(model.simulatorVersion)
      || (model.formula !== undefined && model.formula !== FORMULA)
      || model.priorVersion !== prior.version || typeof model.knockout !== 'boolean' || !/^[0-9a-f]{64}$/i.test(String(model.inputHash || ''))
      || !Array.isArray(model.matrix) || model.matrix.length !== SIZE) return false;
  let sum = 0;
  for (const row of model.matrix) {
    if (!Array.isArray(row) || row.length !== SIZE || row.some(value => !Number.isFinite(value) || value <= 0 || value > 1)) return false;
    sum += row.reduce((total, value) => total + value, 0);
  }
  if (Math.abs(sum - 1) > 1e-9) return false;
  if (input) {
    try {
      // La matriz se recalcula con la MISMA fórmula que la generó; una etiqueta
      // desconocida o ausente usa la fórmula congelada, nunca la actual.
      const matrix = (model.formula === FORMULA) ? calculateMatrix(input) : calculateMatrixLegacy(input);
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

module.exports = { VERSION, FORMULA, createModel, validModel, scoreMatrix, preMatchMarkets, liveScoreMatrix, liveMarket };
