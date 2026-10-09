'use strict';

// Fase D — Flujo de apuestas simulado (§11.6, decisión D8).
//
// Da volumen al cálculo del peso del dinero (§10.4) para que las cuotas se muevan
// incluso cuando no hay nadie apostando: un mercado congelado durante horas no
// parece vivo. Es un contador sintético por mercado, NADA más:
//
//   · NO mueve fichas: nunca llama a credit/debit ni toca un perfil.
//   · NO cuenta para la exposición ni la responsabilidad de la casa: los techos de
//     §11.3 se calculan solo con fichas reales. Si contara, el dinero sintético
//     consumiría los topes y cerraría mercados sin que nadie real hubiera apostado.
//   · NO es visible: nunca aparece como jugador, ni en chat, rankings, historial
//     de ganadores ni ningún payload dirigido al cliente (T19). Solo se registra
//     en logs de auditoría (football_simulated_flow) y como total en /healthz.
//   · La invariante anti-arbitraje se aplica igual: el flujo no puede crear un
//     libro arbitrable porque el piso de margen se verifica antes de publicar.
//
// Regla de oro: el dinero real siempre termina mandando. El decaimiento hace que,
// en cuanto hay personas apostando, el flujo simulado se vuelva irrelevante.
// Todo se genera con el seed del partido (`seed + '|flow'`), así que es
// reproducible en auditoría: se puede regenerar exactamente qué flujo movió una
// cuota.

const { mulberry32, hash32, randRange } = require('./prng');

const SIM_WEIGHT = Number(process.env.FOOTBALL_SIM_WEIGHT) || 0.6;
const SIM_SOFTENER = Number(process.env.FOOTBALL_SIM_SOFTENER) || 2000;
const PUBLIC_BIAS = 1.6;              // >1 sobreapuesta al favorito (patrón real de mercado)
const OVER_TILT = 1.15;               // sesgo adicional del público hacia «altas de goles»
const VOLUME_MIN = 500, VOLUME_MAX = 5000;
const INPLAY_FACTOR = 0.2;            // en vivo el volumen baja a ~20 % (§11.6)
const BLOCK_FACTOR = { matutino: 0.8, vespertino: 1.0, estelar: 1.4 };

// decaimiento(x) = 1 / (1 + x / SOFTENER). Con SOFTENER=2000:
//   0 reales → 1.0 (100 % influencia) · 2.000 → 0.5 · 10.000 → ~0.17 · 40.000 → ~0.05.
function decay(realTotal, softener = SIM_SOFTENER) {
  const x = Math.max(0, Number(realTotal) || 0);
  return 1 / (1 + x / softener);
}

// pesoSimulado = SIM_WEIGHT · decaimiento(realTotal).
function simWeight(realTotal, opts = {}) {
  const w = opts.simWeight != null ? opts.simWeight : SIM_WEIGHT;
  const softener = opts.simSoftener != null ? opts.simSoftener : SIM_SOFTENER;
  return w * decay(realTotal, softener);
}

// Reparte un volumen sintético entre las selecciones de un mercado: sesgo de
// público (favorito y «altas» sobreapostados) + ruido sembrado. Determinista.
function distribute(match, marketKey, openProbs, opts = {}) {
  const keys = Object.keys(openProbs);
  if (!keys.length) return {};
  const inPlay = Boolean(opts.inPlay);
  const seedStr = `${match && match.seed != null ? match.seed : match && match.id}|flow|${marketKey}|${inPlay ? 'live' : 'pre'}`;
  const rng = mulberry32(hash32(seedStr));

  const blockFactor = BLOCK_FACTOR[(match && match.block) || 'vespertino'] || 1.0;
  const featuredFactor = match && match.featured ? 1.3 : 1.0;
  const volume = Math.round(randRange(rng, VOLUME_MIN, VOLUME_MAX) * blockFactor * featuredFactor * (inPlay ? INPLAY_FACTOR : 1));

  const weights = keys.map(k => {
    const p = Math.max(1e-6, openProbs[k]);
    let w = Math.pow(p, PUBLIC_BIAS);           // el favorito atrae más dinero
    if (/^over_under_/.test(marketKey) && k === 'over') w *= OVER_TILT; // público ama las altas
    if (/^btts$/.test(marketKey) && k === 'yes') w *= OVER_TILT;
    w *= 0.8 + 0.4 * rng();                     // ruido sembrado por selección
    return w;
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const stakes = {};
  keys.forEach((k, i) => { stakes[k] = Math.round(volume * weights[i] / sum); });
  return stakes;
}

// Combina fichas reales + sintéticas ponderadas para el peso del dinero (§11.6):
//   share_k = (real_k + sim_k·peso) / (realTotal + simTotal·peso)
// Devuelve stakes combinados; la exposición se calcula aparte SOLO con reales.
function combine(realStakes, simStakes, opts = {}) {
  const keys = new Set([...Object.keys(realStakes || {}), ...Object.keys(simStakes || {})]);
  const realTotal = Object.values(realStakes || {}).reduce((a, b) => a + b, 0);
  const peso = simWeight(realTotal, opts);
  const combined = {};
  for (const k of keys) {
    const real = (realStakes && realStakes[k]) || 0;
    const sim = ((simStakes && simStakes[k]) || 0) * peso;
    combined[k] = real + sim;
  }
  return { stakes: combined, peso, realTotal };
}

// Influencia del flujo simulado sobre el total ponderado (0..1). Útil para T20.
function influence(realTotal, simTotal, opts = {}) {
  const peso = simWeight(realTotal, opts);
  const denom = realTotal + simTotal * peso;
  return denom > 0 ? (simTotal * peso) / denom : 0;
}

// Generador con caché por (partido, mercado) y registro de auditoría. Lo usa
// betting.js para mover cuotas y el scheduler para aportar volumen con cadencia.
class SimulatedFlow {
  constructor({ log = () => {}, config = {} } = {}) {
    this.log = log;
    this.config = { simWeight: SIM_WEIGHT, simSoftener: SIM_SOFTENER, ...config };
    this.cache = new Map();   // `${matchId}|${market}|${inPlay}` → stakes
    this.totals = new Map();  // matchId → volumen sintético total (para /healthz)
  }

  stakesFor(match, marketKey, openProbs, { inPlay = false } = {}) {
    const key = `${match.id}|${marketKey}|${inPlay ? 'live' : 'pre'}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const stakes = distribute(match, marketKey, openProbs, { inPlay });
    this.cache.set(key, stakes);
    const total = Object.values(stakes).reduce((a, b) => a + b, 0);
    this.totals.set(match.id, (this.totals.get(match.id) || 0) + total);
    this.log('football_simulated_flow', { match: match.id, market: marketKey, inPlay, total, stakes });
    return stakes;
  }

  totalForMatch(matchId) {
    return this.totals.get(matchId) || 0;
  }

  // Peso vigente dado el total real apostado en un mercado.
  weight(realTotal) {
    return simWeight(realTotal, this.config);
  }

  reset(matchId) {
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${matchId}|`)) this.cache.delete(key);
    this.totals.delete(matchId);
  }
}

module.exports = {
  SimulatedFlow, decay, simWeight, distribute, combine, influence,
  SIM_WEIGHT, SIM_SOFTENER, PUBLIC_BIAS, OVER_TILT, VOLUME_MIN, VOLUME_MAX, INPLAY_FACTOR, BLOCK_FACTOR
};
