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

const { scoreMatrix, RHO, poissonPmf } = require('./match-engine');
const { POS_GROUP } = require('./match-state');

// --- Márgenes por mercado (calibrados contra casas reales, octubre 2026) ---
//
// Un margen plano no existe en ninguna casa: el 1X2 y el hándicap (los mercados
// más líquidos y más comparados) van finos, y el marcador exacto —veinte
// resultados, el mercado donde el modelo tiene más error— lleva el triple. La
// banda de cada uno y su fuente están en docs/estadio-cuotas-realistas.md; el
// auditor (`npm run football:odds-audit`) comprueba que se cumplan.
//
//   mercado            antes   ahora   banda real (casa recreativa)
//   1X2                 7 %     6 %    5–8 %
//   doble oportunidad   6 %     6 %    3–8 %
//   hándicap            7 %     6 %    4–7 % (europeo 3 vías)
//   hándicap asiático   —       2,5 %  1–4 % (2 vías, empuje devuelto)
//   altas/bajas         7 %     5 %    4–6 %
//   ambos marcan        8 %     6 %    5–8 %
//   gana a cero         9 %     7 %    5–9 %
//   goles por equipo    8 %   6,5 %    5–8 %
//   descanso/final      —      14 %    12–20 %
//   marcador exacto    12 %    18 %    15–25 %
//   primer goleador     —      22 %    20–40 % (veinte nombres, casi ninguno se ve caro)
const MARGINS = {
  '1x2': 0.06,
  double_chance: 0.06,
  handicap: 0.06,
  asian_handicap: 0.025,
  over_under: 0.05,
  btts: 0.06,
  correct_score: 0.18,
  win_to_nil: 0.07,
  team_total: 0.065,
  ht_ft: 0.14,
  first_scorer: 0.22,
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

// Hándicap asiático de DOS vías (§ catálogo C). La línea se expresa como hándicap
// del local en cuartos: -0.25 significa «local −1/4». Una línea de cuarto NO es
// una línea: son dos apuestas de media unidad a las líneas vecinas de medio punto
// (−0.5 y 0), y por eso puede terminar en media victoria o media derrota.
//
// El precio se calcula con la probabilidad CONDICIONADA a que no haya empuje:
//   q_local = P(gana el local) / (1 − P(empuje))
// Con eso el libro de dos selecciones vuelve a sumar 1 y el margen declarado es
// el margen real (Σ 1/precio = 1 + m). El empuje se devuelve al liquidar.
const ASIAN_QUARTER_STEP = 0.25;
// El piso anti-arbitraje general (4 %) es más alto que el margen real del hándicap
// asiático (2,5 %). Se publica con su propio piso: 2 % sigue siendo un libro con
// margen positivo (nunca arbitrable) y deja que el redondeo caiga dentro de la
// banda 1–4 % que publican las casas.
const ASIAN_MIN_MARGIN = 0.02;

function asianLegs(line) {
  const l = Math.round(Number(line) / ASIAN_QUARTER_STEP) * ASIAN_QUARTER_STEP;
  const isQuarter = Math.abs(l * 2 - Math.round(l * 2)) > 1e-9;
  return isQuarter ? [Number((l - 0.25).toFixed(2)), Number((l + 0.25).toFixed(2))] : [Number(l.toFixed(2))];
}

// Clave del mercado: la línea va en cuartos con signo explícito («minus0.25»).
function asianHandicapKey(line) {
  const sign = line < 0 ? 'minus' : 'plus';
  const abs = Math.abs(Number(line)).toFixed(2).replace(/\.?0+$/, '') || '0';
  return `asian_handicap_home_${sign}${abs}`;
}

function probAsianHandicap(matrix, line) {
  const legs = asianLegs(line);
  const weight = 1 / legs.length;
  let winHome = 0, winAway = 0;
  for (const leg of legs) {
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) {
        const diff = i + leg - j;
        if (diff > 0) winHome += weight * matrix[i][j];
        else if (diff < 0) winAway += weight * matrix[i][j];
      }
    }
  }
  const decided = winHome + winAway;
  const q = decided > 0 ? winHome / decided : 0.5;
  return { home: q, away: 1 - q };
}

// Proporción de goles que caen en el primer tiempo (liga real ≈ 0.45).
const FIRST_HALF_GOAL_SHARE = 0.45;
// Nombres ofrecidos en el mercado de primer goleador (más «otro» y «sin goles»).
const FIRST_SCORER_TOP = 12;

// Momentos de la matriz (la matriz ya está normalizada por scoreMatrix).
function matrixMeans(matrix) {
  let home = 0, away = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      home += i * matrix[i][j];
      away += j * matrix[i][j];
    }
  }
  return { home, away };
}

function lambdasOf(matrix, lambdas) {
  if (lambdas && Number.isFinite(lambdas.lambdaHome) && Number.isFinite(lambdas.lambdaAway)) {
    return { lambdaHome: lambdas.lambdaHome, lambdaAway: lambdas.lambdaAway };
  }
  const means = matrixMeans(matrix);
  return { lambdaHome: means.home, lambdaAway: means.away };
}

// Descanso/final (HT/FT, 9 resultados). Cada tiempo se modela como Poisson
// independiente con su parte de λ (45 % antes del descanso) — la aproximación
// estándar de las casas: el marcador del descanso y el del segundo tiempo no se
// condicionan entre sí, y el reparto por tiempos sí respeta el total esperado.
function pmfVector(lambda, max = 8) {
  const out = [];
  for (let k = 0; k <= max; k++) out.push(poissonPmf(k, lambda));
  const total = out.reduce((a, b) => a + b, 0) || 1;
  return out.map(v => v / total);
}

function probHtFt(matrix, lambdas = null, share = FIRST_HALF_GOAL_SHARE) {
  const { lambdaHome: lh, lambdaAway: la } = lambdasOf(matrix, lambdas);
  const h1 = pmfVector(lh * share), a1 = pmfVector(la * share);
  const h2 = pmfVector(lh * (1 - share)), a2 = pmfVector(la * (1 - share));
  const out = {};
  for (const first of ['home', 'draw', 'away']) {
    for (const second of ['home', 'draw', 'away']) out[`${first}_${second}`] = 0;
  }
  const side = (x, y) => (x > y ? 'home' : x === y ? 'draw' : 'away');
  for (let x1 = 0; x1 < h1.length; x1++) {
    for (let y1 = 0; y1 < a1.length; y1++) {
      const p1 = h1[x1] * a1[y1];
      if (p1 < 1e-9) continue;
      const first = side(x1, y1);
      for (let x2 = 0; x2 < h2.length; x2++) {
        for (let y2 = 0; y2 < a2.length; y2++) {
          const p = p1 * h2[x2] * a2[y2];
          if (p < 1e-12) continue;
          out[`${first}_${side(x1 + x2, y1 + y2)}`] += p;
        }
      }
    }
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0) || 1;
  for (const key of Object.keys(out)) out[key] = out[key] / total;
  return out;
}

// Peso de tiro por jugador: el mismo criterio con el que el motor elige al
// rematador (lib/football/match-engine.js, shootWeight). Si el mercado saliera de
// otro peso, el precio no describiría el partido que se juega.
const SHOOT_WEIGHT = { FW: 5.0, MF: 2.6, DF: 0.9, GK: 0.02 };

function shootWeight(player) {
  const attrs = player && player.attrs ? player.attrs : {};
  return SHOOT_WEIGHT[POS_GROUP[player && player.pos] || 'MF'] * (0.6 + (Number(attrs.sho) || 70) / 100);
}

// Primer goleador: carrera de Poisson entre los dos equipos.
//   P(primer gol del local) = λ_home / (λ_home + λ_away)
//   P(un jugador concreto)  = P(equipo marca primero) · peso_jugador / Σ pesos
//   P(sin goles)            = e^−(λ_home+λ_away)
// Sale la lista completa de titulares (sin porteros) + «sin goles»: no hace falta
// una celda «otros» porque ningún goleador posible queda fuera del mercado.
function probFirstScorer(lambdas, lineups, top = FIRST_SCORER_TOP) {
  const total = lambdas.lambdaHome + lambdas.lambdaAway;
  const noGoal = Math.exp(-total);
  const share = { home: total > 0 ? lambdas.lambdaHome / total : 0.5, away: total > 0 ? lambdas.lambdaAway / total : 0.5 };
  const players = [];
  for (const side of ['home', 'away']) {
    const lineup = lineups && lineups[side];
    const squad = ((lineup && lineup.players) || []).filter(p => p.initialStatus === 'active' && POS_GROUP[p.pos] !== 'GK');
    const totalWeight = squad.reduce((sum, p) => sum + shootWeight(p), 0) || 1;
    for (const player of squad) {
      players.push({ id: player.id, name: player.name, prob: (1 - noGoal) * share[side] * shootWeight(player) / totalWeight });
    }
  }
  players.sort((a, b) => b.prob - a.prob);
  const offered = players.slice(0, top);
  const out = {};
  for (const player of offered) out[player.id] = player.prob;
  // «Otro jugador» recoge a quien no está entre los doce nombres ofrecidos (un
  // suplente que entra y marca, un defensa con un córner…): así el mercado cubre
  // todos los goles posibles y siempre hay una selección que cobra.
  const covered = offered.reduce((sum, p) => sum + p.prob, 0);
  out.other = Math.max(0, 1 - noGoal - covered);
  out.none = noGoal;
  return out;
}

// Momento del descanso de una línea de tiempo (0-0 si el motor no la expone):
// el mercado de descanso/final se liquida con el marcador REAL al descanso, no
// con una estimación.
function halfTimeScoreFromTimeline(timeline) {
  const events = Array.isArray(timeline) ? timeline : [];
  let home = 0, away = 0;
  for (const event of events) {
    if (!event || (event.type !== 'goal' && event.type !== 'penalty_scored')) continue;
    const half = Number(event.half);
    const minute = Number(event.t);
    const beforeBreak = half === 1 || (!Number.isFinite(half) && Number.isFinite(minute) && minute <= 45);
    if (!beforeBreak) continue;
    if (event.team === 'home') home++;
    else if (event.team === 'away') away++;
  }
  return { home, away };
}

// Primer goleador real de la línea de tiempo: { id, name, team, minute } o null
// si el partido acabó 0-0. Un gol en propia puerta no acredita a nadie (el boleto
// se anula al liquidar), de ahí que se devuelva el id explícito del rematador.
function firstScorerFromTimeline(timeline) {
  const events = Array.isArray(timeline) ? timeline : [];
  for (const event of events) {
    if (!event || (event.type !== 'goal' && event.type !== 'penalty_scored')) continue;
    const id = event.playerId || event.shooterId || null;
    // Gol sin rematador = en propia puerta: no acredita a ningún jugador y el
    // mercado de primer goleador se anula (se devuelve el boleto).
    if (!id) return { id: null, name: '', team: event.team === 'away' ? 'away' : 'home', minute: null, ownGoal: true };
    return {
      id: String(id),
      name: event.playerName || event.shooterName || '',
      team: event.team === 'away' ? 'away' : 'home',
      minute: Number.isFinite(Number(event.t)) ? Number(event.t) : null
    };
  }
  return null;
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

  // Hándicap asiático de dos vías: la escalera se centra en la línea justa del
  // modelo (la supremacía esperada) y ofrece la principal más sus dos vecinas de
  // cuarto. Así el mercado siempre cotiza el partido real y no una línea muerta.
  const lambdas = lambdasOf(matrix, opts.lambdas);
  const supremacy = lambdas.lambdaHome - lambdas.lambdaAway;
  const mainLine = Number((-Math.round(supremacy / ASIAN_QUARTER_STEP) * ASIAN_QUARTER_STEP).toFixed(2));
  for (const line of [mainLine - 0.5, mainLine - 0.25, mainLine, mainLine + 0.25, mainLine + 0.5]) {
    const rounded = Number(line.toFixed(2));
    markets[asianHandicapKey(rounded)] = publishMarket(
      probAsianHandicap(matrix, rounded), margins.asian_handicap,
      { ...opts, minMargin: Math.min(opts.minMargin != null ? opts.minMargin : ASIAN_MIN_MARGIN, ASIAN_MIN_MARGIN) }
    );
  }

  markets.ht_ft = publishMarket(probHtFt(matrix, lambdas), margins.ht_ft, opts);

  // Primer goleador: necesita las alineaciones (son deterministas a partir de la
  // plantilla, así que se conocen desde antes del partido). Sin alineaciones el
  // mercado no se publica en vez de inventarse nombres.
  if (opts.lineups && opts.lineups.home && opts.lineups.away) {
    const probs = probFirstScorer(lambdas, opts.lineups);
    const market = publishMarket(probs, margins.first_scorer, opts);
    market.labels = {};
    for (const side of ['home', 'away']) {
      for (const player of opts.lineups[side].players || []) {
        if (probs[player.id] != null) market.labels[player.id] = player.name;
      }
    }
    market.labels.other = 'Otro jugador';
    market.labels.none = 'Sin goles';
    markets.first_scorer = market;
  }

  return markets;
}

module.exports = {
  // constantes
  MARGINS, MIN_MARGIN, LIVE_MARGIN_BUMP, CASHOUT_MARGIN, PRICE_MIN, PRICE_MAX,
  MONEY_WEIGHT, MAX_MOVE_PER_UPDATE, MAX_CUMULATIVE_DEVIATION, ASIAN_MIN_MARGIN,
  // redondeo y precio
  gridStep, clampPrice, roundBook, floorGrid, ceilGrid, impliedProb, overround,
  // probabilidades justas
  prob1x2, probDoubleChance, probOverUnder, probBtts, probHandicap, probWinToNil,
  probTeamTotal, probCorrectScore, probAsianHandicap, probHtFt, probFirstScorer,
  asianLegs, asianHandicapKey, matrixMeans, halfTimeScoreFromTimeline, firstScorerFromTimeline,
  FIRST_HALF_GOAL_SHARE, FIRST_SCORER_TOP,
  // publicación
  fitToMargin, enforceInvariant, publishMarket, publishIndependent, DOUBLE_CHANCE_COVER,
  // movimiento y vivo
  applyMoneyWeight, liveLambdas, liveProbabilities, publishLive,
  // cash-out y catálogo
  cashoutValue, buildPreMatchMarkets
};
