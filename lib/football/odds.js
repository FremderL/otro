'use strict';

// Fase D — Motor de cuotas (§10).
//
// Todo el precio sale del MISMO modelo que genera el partido (la matriz de
// Poisson con corrección Dixon-Coles de match-engine). Esa es la garantía de
// honradez del margen declarado (§3.3/R3): si las cuotas salieran de otro sitio,
// el margen sería falso y el juego estaría sesgado.
//
// Tres invariantes económicas no negociables:
//   1. Σ (1/precio_k) == 1 + margen del mercado (T2), con el redondeo «de libro»
//      ajustado para no desviarse más de ~0.001.
//   2. Σ (1/precio_k) >= 1 + MARGEN_MINIMO SIEMPRE (§10.3). Si el peso del dinero
//      o el redondeo la rompieran, se renormaliza antes de publicar y se registra
//      odds_invariant_repair. Sin esto, mover por responsabilidad puede crear un
//      LIBRO ARBITRABLE (apostar a todo y ganar siempre): el bug económico más
//      grave posible (T3).
//   3. La ventaja real medida por simulación coincide con el margen declarado
//      (6.54 % para el 7 % en 1X2) — T22.
//
// Este módulo es PURO: no mueve fichas ni toca perfiles. La colocación, el escrow
// y la liquidación viven en betting.js.

const { scoreMatrix, RHO } = require('./match-engine');

// --- Márgenes por mercado (decisión C4: se conserva el 7 %) ---
const MARGINS = {
  '1x2': 0.07,
  double_chance: 0.06,
  handicap: 0.07,
  over_under: 0.07,
  btts: 0.08,
  correct_score: 0.12,
  win_to_nil: 0.09,
  team_total: 0.08,
  ht_ft: 0.12,
  future: 0.10
};
const MIN_MARGIN = Number(process.env.FOOTBALL_MIN_MARGIN_INVARIANT) || 0.04; // piso anti-arbitraje
const LIVE_MARGIN_BUMP = 0.01;   // en vivo: base + 1 % (§10.3)
const CASHOUT_MARGIN = 0.10;     // §10.7
const PRICE_MIN = 1.05, PRICE_MAX = 101;
const MONEY_WEIGHT = 0.30;             // w (§10.4)
const MAX_MOVE_PER_UPDATE = 0.06;      // ±6 % por actualización (§10.4)
const MAX_CUMULATIVE_DEVIATION = 0.25; // ±25 % respecto del precio de apertura (§10.4)

// --- Redondeo «de libro» (§10.3) ---

function gridStep(price) {
  if (price < 2) return 0.01;
  if (price <= 4) return 0.05;
  return 0.10;
}
function clampPrice(price) {
  return Math.max(PRICE_MIN, Math.min(PRICE_MAX, price));
}
function roundBook(price) {
  const p = clampPrice(price);
  const step = gridStep(p);
  return Number((Math.round(p / step) * step).toFixed(2));
}
function floorGrid(price) {
  const p = clampPrice(price);
  const step = gridStep(p);
  return Number((Math.floor(p / step + 1e-9) * step).toFixed(2));
}
function ceilGrid(price) {
  const p = clampPrice(price);
  const step = gridStep(p);
  return Number((Math.ceil(p / step - 1e-9) * step).toFixed(2));
}
function impliedProb(price) {
  return price > 0 ? 1 / price : 0;
}
function overround(prices) {
  return prices.reduce((acc, p) => acc + impliedProb(p), 0);
}

// --- Probabilidades justas desde la matriz (§10.2) ---

// matrix[i][j] = P(local marca i, visita marca j).
function prob1x2(matrix) {
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (i > j) home += matrix[i][j];
      else if (i === j) draw += matrix[i][j];
      else away += matrix[i][j];
    }
  }
  return { home, draw, away };
}

function probDoubleChance(matrix) {
  const { home, draw, away } = prob1x2(matrix);
  return { '1X': home + draw, '12': home + away, 'X2': draw + away };
}

function probOverUnder(matrix, line) {
  let over = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (i + j > line) over += matrix[i][j];
    }
  }
  return { over, under: 1 - over };
}

function probBtts(matrix) {
  let yes = 0;
  for (let i = 1; i < matrix.length; i++) {
    for (let j = 1; j < matrix[i].length; j++) yes += matrix[i][j];
  }
  return { yes, no: 1 - yes };
}

// Hándicap entero de una línea: 3-vías (local / empate tras hándicap / visita).
function probHandicap(matrix, line) {
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      const diff = i + line - j;
      if (diff > 0) home += matrix[i][j];
      else if (diff === 0) draw += matrix[i][j];
      else away += matrix[i][j];
    }
  }
  return { home, draw, away };
}

function probWinToNil(matrix) {
  let homeYes = 0, awayYes = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (i >= 1 && j === 0) homeYes += matrix[i][j];
      if (j >= 1 && i === 0) awayYes += matrix[i][j];
    }
  }
  return { home_yes: homeYes, home_no: 1 - homeYes, away_yes: awayYes, away_no: 1 - awayYes };
}

function probTeamTotal(matrix, team, line) {
  let over = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      const goals = team === 'home' ? i : j;
      if (goals > line) over += matrix[i][j];
    }
  }
  return { over, under: 1 - over };
}

// Marcador exacto: las `top` celdas más probables + «otro» (§11.1).
function probCorrectScore(matrix, top = 12) {
  const cells = [];
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) cells.push({ key: `${i}-${j}`, prob: matrix[i][j] });
  }
  cells.sort((a, b) => b.prob - a.prob);
  const picked = cells.slice(0, top);
  const otherProb = Math.max(0, 1 - picked.reduce((s, c) => s + c.prob, 0));
  const out = {};
  for (const c of picked) out[c.key] = c.prob;
  out.other = otherProb;
  return out;
}

// --- Publicación: del precio justo al precio de libro (§10.3) ---

// Candidatos de precio alrededor del objetivo: una ventana de ±2 pasos de rejilla
// (no solo floor/ceil), para que el ajuste al margen tenga margen de maniobra y
// clave Σ 1/precio en 1+margen incluso con la rejilla gruesa de cuotas altas.
function priceCandidates(target) {
  const t = clampPrice(target);
  const step = gridStep(t);
  const out = [];
  for (let d = -2; d <= 2; d++) {
    const raw = clampPrice(t + d * step);
    const snapped = Number((Math.round(raw / gridStep(raw)) * gridStep(raw)).toFixed(2));
    if (!out.includes(snapped)) out.push(snapped);
  }
  return out.sort((a, b) => a - b);
}

const FIT_BRUTE_LIMIT = 200000;

// Ajusta los precios a la rejilla de libro minimizando |Σ 1/precio − (1+margen)|.
// Para pocos candidatos combina en fuerza bruta; para muchos (marcador exacto)
// hace una búsqueda local voraz.
function fitToMargin(keys, probs, margin) {
  const target = 1 + margin;
  const candidates = probs.map(p => priceCandidates(p > 0 ? (1 / p) / (1 + margin) : PRICE_MAX));
  const n = keys.length;
  const sumOf = (choice) => choice.reduce((acc, idx, k) => acc + impliedProb(candidates[k][idx]), 0);

  let best, bestErr = Infinity;
  const combos = candidates.reduce((acc, c) => acc * c.length, 1);
  if (combos <= FIT_BRUTE_LIMIT) {
    for (let mask = 0; mask < combos; mask++) {
      const choice = [];
      let m = mask;
      for (let k = 0; k < n; k++) { choice.push(m % candidates[k].length); m = Math.floor(m / candidates[k].length); }
      const err = Math.abs(sumOf(choice) - target);
      if (err < bestErr) { bestErr = err; best = choice; }
    }
  } else {
    // Voraz: arranca en el candidato más cercano al objetivo y hace búsqueda local.
    best = candidates.map((c, k) => {
      const t = clampPrice((1 / probs[k]) / (1 + margin));
      let bi = 0, bd = Infinity;
      c.forEach((price, i) => { const d = Math.abs(price - t); if (d < bd) { bd = d; bi = i; } });
      return bi;
    });
    bestErr = Math.abs(sumOf(best) - target);
    let improved = true;
    while (improved) {
      improved = false;
      for (let k = 0; k < n; k++) {
        for (const dir of [-1, 1]) {
          const ni = best[k] + dir;
          if (ni < 0 || ni >= candidates[k].length) continue;
          const prev = best[k];
          best[k] = ni;
          const err = Math.abs(sumOf(best) - target);
          if (err < bestErr - 1e-12) { bestErr = err; improved = true; }
          else best[k] = prev;
        }
      }
    }
  }

  const prices = best.map((idx, k) => candidates[k][idx]);
  return { prices, overround: sumOf(best) };
}

// Garantiza el piso anti-arbitraje (§10.3): Σ 1/precio >= 1 + MARGEN_MINIMO.
// Si el clamp de precios (favoritos > ~93.5 % que no bajan de 1.05) hundió el
// overround, baja los precios que aún pueden bajar hasta restaurar el piso. Si
// ni así se alcanza (todos en el mínimo), el mercado es DEGENERADO y no debe
// ofrecerse: betting.js lo suspende en vez de publicar un libro arbitrable.
function enforceInvariant(prices, minMargin = MIN_MARGIN) {
  const floor = 1 + minMargin;
  const repaired = prices.slice();
  let current = overround(repaired);
  if (current >= floor - 1e-9) return { prices: repaired, repaired: false, overround: current, degenerate: false };
  let guard = 0;
  while (current < floor - 1e-9 && guard < 5000) {
    guard++;
    let moved = false;
    for (let k = 0; k < repaired.length; k++) {
      const step = gridStep(repaired[k]);
      const next = clampPrice(repaired[k] - step);
      if (next < repaired[k]) { repaired[k] = Number(next.toFixed(2)); moved = true; }
    }
    current = overround(repaired);
    if (!moved) break; // todos en PRICE_MIN y aún por debajo del piso
  }
  return { prices: repaired, repaired: true, overround: current, degenerate: current < floor - 1e-9 };
}

// Publica un mercado: probs {key: p} (suman 1) → { selections, overround, margin,
// repaired, degenerate }. Un mercado degenerate NO es arbitrable porque no se
// ofrece: quien lo consuma debe comprobar el flag antes de aceptarlo.
function publishMarket(probs, margin, opts = {}) {
  const keys = Object.keys(probs);
  const probArr = keys.map(k => probs[k]);
  const fitted = fitToMargin(keys, probArr, margin);
  const inv = enforceInvariant(fitted.prices, opts.minMargin != null ? opts.minMargin : MIN_MARGIN);
  const selections = keys.map((k, i) => ({
    key: k,
    prob: Number(probArr[i].toFixed(6)),
    price: inv.prices[i],
    implied: Number(impliedProb(inv.prices[i]).toFixed(4))
  }));
  return {
    selections,
    overround: Number(inv.overround.toFixed(5)),
    margin: Number((inv.overround - 1).toFixed(5)),
    repaired: inv.repaired,
    degenerate: inv.degenerate,
    targetMargin: margin
  };
}

// Mercados de selecciones NO exclusivas (doble oportunidad: 1X, 12, X2 se solapan
// y suman 2). No llevan overround de partición; cada selección se precio por
// separado con el margen. Anti-arbitraje: como cada resultado de partido lo cubren
// exactamente dos selecciones, basta con que la suma de sus probabilidades
// implícitas sea >= 1 (se verifica y, si el clamp la rompe, se marca degenerate).
const DOUBLE_CHANCE_COVER = { home: ['1X', '12'], draw: ['1X', 'X2'], away: ['12', 'X2'] };

function publishIndependent(probs, margin, opts = {}) {
  const keys = Object.keys(probs);
  const selections = keys.map(k => {
    const p = probs[k];
    const price = roundBook(clampPrice(p > 0 ? (1 / p) / (1 + margin) : PRICE_MAX));
    return { key: k, prob: Number(p.toFixed(6)), price, implied: Number(impliedProb(price).toFixed(4)) };
  });
  const impliedByKey = {};
  selections.forEach(s => { impliedByKey[s.key] = s.implied; });
  // Verifica que ningún resultado quede cubierto por debajo de 1 (arbitraje).
  let degenerate = false;
  if (opts.cover) {
    for (const outcome of Object.keys(opts.cover)) {
      const sum = opts.cover[outcome].reduce((acc, k) => acc + (impliedByKey[k] || 0), 0);
      if (sum < 1 - 1e-9) degenerate = true;
    }
  }
  return {
    selections,
    independent: true,
    overround: Number(selections.reduce((s, x) => s + x.implied, 0).toFixed(5)),
    margin,
    targetMargin: margin,
    repaired: false,
    degenerate
  };
}

// --- Movimiento por peso del dinero (§10.4) ---

// Ajusta las probabilidades de apertura según la responsabilidad acumulada y
// re-publica, respetando el tope de movimiento acumulado (±25 % del precio de
// apertura). openPrices y openProbs son los de la apertura; stakes {key: fichas}.
function applyMoneyWeight(openProbs, openPrices, stakes, margin, opts = {}) {
  const w = opts.moneyWeight != null ? opts.moneyWeight : MONEY_WEIGHT;
  const keys = Object.keys(openProbs);
  const total = keys.reduce((s, k) => s + (stakes[k] || 0), 0);
  if (total <= 0) {
    // Sin dinero apostado aún: se publican los precios de apertura tal cual.
    // `prices` es un objeto {seleccion: precio} en TODAS las ramas (quien consume
    // hace moved.prices[key]); devolver aquí un array rompería ese contrato.
    const open = {};
    keys.forEach(k => { open[k] = openPrices[k]; });
    return { prices: open, capped: [], overround: overround(keys.map(k => openPrices[k])), moved: false };
  }
  // desvio_k = w · (share_k − p_k); lo muy apostado sube de probabilidad ⇒ baja su cuota.
  const adjusted = {};
  for (const k of keys) {
    const share = (stakes[k] || 0) / total;
    adjusted[k] = Math.max(1e-6, openProbs[k] + w * (share - openProbs[k]));
  }
  const norm = keys.reduce((s, k) => s + adjusted[k], 0);
  for (const k of keys) adjusted[k] /= norm;

  const published = publishMarket(adjusted, margin, opts);
  const priceByKey = {};
  published.selections.forEach(s => { priceByKey[s.key] = s.price; });

  // Tope acumulado: ±25 % respecto de la apertura. Al tocarlo, la selección deja
  // de moverse (betting.js la suspende si la responsabilidad sigue creciendo).
  const capped = [];
  const finalPrices = {};
  for (const k of keys) {
    const open = openPrices[k];
    const lo = open * (1 - MAX_CUMULATIVE_DEVIATION);
    const hi = open * (1 + MAX_CUMULATIVE_DEVIATION);
    let p = priceByKey[k];
    if (p < lo) { p = roundBook(lo); capped.push(k); }
    else if (p > hi) { p = roundBook(hi); capped.push(k); }
    finalPrices[k] = p;
  }
  // El tope puede haber movido el overround: garantizar el piso otra vez.
  const inv = enforceInvariant(keys.map(k => finalPrices[k]), opts.minMargin != null ? opts.minMargin : MIN_MARGIN);
  keys.forEach((k, i) => { finalPrices[k] = inv.prices[i]; });
  return { prices: finalPrices, capped, overround: inv.overround, moved: true, adjustedProbs: adjusted };
}

// --- Cuotas en vivo (§10.5) ---

// λ restantes según minuto, marcador, tarjetas y momentum; con ellas la matriz
// condicional del resto del partido, sumada al marcador actual.
function liveLambdas(baseLambdas, ctx) {
  const { minute, score, redCards = { home: 0, away: 0 }, matchEnd = 90 } = ctx;
  const remaining = Math.max(0, matchEnd - minute);
  const scale = remaining / 90;
  const diff = score.home - score.away;

  // Factores de estado de juego (§10.5).
  const factor = (teamDiff, ownRed, rivalRed) => {
    let att = 1, defVuln = 1;
    if (teamDiff <= -2) { att *= 1.14; defVuln *= 1.12; }       // perdiendo por 2+
    else if (teamDiff === -1) { att *= 1.09; defVuln *= 1.07; }  // perdiendo por 1
    else if (teamDiff >= 1 && minute >= 75) { att *= 0.92; defVuln *= 0.94; } // ganando en los últimos 15'
    if (ownRed > 0) { att *= Math.pow(0.78, ownRed); defVuln *= Math.pow(1.26, ownRed); }
    if (rivalRed > 0) { att *= Math.pow(1.10, rivalRed); }
    if (minute >= 85) att *= 1.05; // partido roto al final
    return { att, defVuln };
  };
  const fh = factor(diff, redCards.home, redCards.away);
  const fa = factor(-diff, redCards.away, redCards.home);

  // λ restante = λ_base · (minRestantes/90) · ataque propio · vulnerabilidad rival.
  const lambdaHome = baseLambdas.lambdaHome * scale * fh.att * fa.defVuln;
  const lambdaAway = baseLambdas.lambdaAway * scale * fa.att * fh.defVuln;
  return { lambdaHome: Math.max(0.01, lambdaHome), lambdaAway: Math.max(0.01, lambdaAway) };
}

// Probabilidades 1X2 finales (marcador actual + resto) para el mercado en vivo.
function liveProbabilities(baseLambdas, ctx, rho = RHO) {
  const { score } = ctx;
  const rem = liveLambdas(baseLambdas, ctx);
  const matrix = scoreMatrix(rem.lambdaHome, rem.lambdaAway, rho);
  const rest = prob1x2(matrix);
  // Convoluciona el resto con el marcador actual para el resultado final.
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      const fh = score.home + i, fa = score.away + j;
      const p = matrix[i][j];
      if (fh > fa) home += p; else if (fh === fa) draw += p; else away += p;
    }
  }
  return { home, draw, away, restLambdas: rem, restProb: rest };
}

// Publica el 1X2 en vivo con el margen base + 1 % (§10.3).
function publishLive(baseLambdas, ctx, baseMargin = MARGINS['1x2'], rho = RHO) {
  const probs = liveProbabilities(baseLambdas, ctx, rho);
  return publishMarket({ home: probs.home, draw: probs.draw, away: probs.away }, baseMargin + LIVE_MARGIN_BUMP);
}

// --- Cash-out (§10.7) ---

function cashoutValue(stake, placedOdds, currentProb, opts = {}) {
  const margin = opts.cashoutMargin != null ? opts.cashoutMargin : CASHOUT_MARGIN;
  const potentialPayout = stake * placedOdds;
  const currentValue = stake * placedOdds * currentProb;
  const cashout = currentValue * (1 - margin);
  return Number(Math.max(0, Math.min(potentialPayout, cashout)).toFixed(2));
}

// --- Catálogo de mercados pre-partido (§11.1) ---

// Deriva todos los mercados pre-partido desde la matriz y los publica con su margen.
function buildPreMatchMarkets(matrix, opts = {}) {
  const margins = { ...MARGINS, ...(opts.margins || {}) };
  const markets = {};
  markets['1x2'] = publishMarket(prob1x2(matrix), margins['1x2'], opts);
  markets.double_chance = publishIndependent(probDoubleChance(matrix), margins.double_chance, { ...opts, cover: DOUBLE_CHANCE_COVER });
  markets.handicap_home_minus1 = publishMarket(probHandicap(matrix, -1), margins.handicap, opts);
  markets.handicap_home_plus1 = publishMarket(probHandicap(matrix, 1), margins.handicap, opts);
  for (const line of [1.5, 2.5, 3.5]) {
    markets[`over_under_${line}`] = publishMarket(probOverUnder(matrix, line), margins.over_under, opts);
  }
  markets.btts = publishMarket(probBtts(matrix), margins.btts, opts);
  markets.correct_score = publishMarket(probCorrectScore(matrix, 12), margins.correct_score, opts);
  // «gana a cero» son DOS mercados binarios independientes (uno por equipo), no
  // uno de cuatro selecciones: cada uno debe sumar probabilidad 1 por separado.
  const wtn = probWinToNil(matrix);
  markets.win_to_nil_home = publishMarket({ yes: wtn.home_yes, no: wtn.home_no }, margins.win_to_nil, opts);
  markets.win_to_nil_away = publishMarket({ yes: wtn.away_yes, no: wtn.away_no }, margins.win_to_nil, opts);
  for (const team of ['home', 'away']) {
    for (const line of [0.5, 1.5]) {
      markets[`team_total_${team}_${line}`] = publishMarket(probTeamTotal(matrix, team, line), margins.team_total, opts);
    }
  }
  return markets;
}

module.exports = {
  // constantes
  MARGINS, MIN_MARGIN, LIVE_MARGIN_BUMP, CASHOUT_MARGIN, PRICE_MIN, PRICE_MAX,
  MONEY_WEIGHT, MAX_MOVE_PER_UPDATE, MAX_CUMULATIVE_DEVIATION,
  // redondeo y precio
  gridStep, clampPrice, roundBook, floorGrid, ceilGrid, impliedProb, overround,
  // probabilidades justas
  prob1x2, probDoubleChance, probOverUnder, probBtts, probHandicap, probWinToNil,
  probTeamTotal, probCorrectScore,
  // publicación
  fitToMargin, enforceInvariant, publishMarket, publishIndependent, DOUBLE_CHANCE_COVER,
  // movimiento y vivo
  applyMoneyWeight, liveLambdas, liveProbabilities, publishLive,
  // cash-out y catálogo
  cashoutValue, buildPreMatchMarkets
};
