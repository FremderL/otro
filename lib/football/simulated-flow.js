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
//
// Cadencia («Volumen y cadencia», §11.6). Antes del partido el libro sintético
// NO aparece completo de golpe: los apostadores simulados van colocando sus
// aportes durante la ventana previa al saque inicial (12 h por defecto), cada vez
// más seguido conforme se acerca el partido. Por eso la cuota abre en el precio
// del modelo, se mueve mientras llegan los aportes y cierra en el libro de
// siempre (`distribute`). El calendario es una función pura de (seed, mercado,
// saque inicial): no guarda estado, sobrevive a un reinicio y da el mismo
// resultado en cualquier proceso. Ver `schedule` y `stakesAt`.

const { mulberry32, hash32, randRange } = require('./prng');
const { MONEY_WEIGHT } = require('./odds');

const SIM_WEIGHT = Number(process.env.FOOTBALL_SIM_WEIGHT) || 0.6;
const SIM_SOFTENER = Number(process.env.FOOTBALL_SIM_SOFTENER) || 2000;
const PUBLIC_BIAS = 1.6;              // >1 sobreapuesta al favorito (patrón real de mercado)
const OVER_TILT = 1.15;               // sesgo adicional del público hacia «altas de goles»
const VOLUME_MIN = 500, VOLUME_MAX = 5000;
const INPLAY_FACTOR = 0.2;            // en vivo el volumen baja a ~20 % (§11.6)
const BLOCK_FACTOR = { matutino: 0.8, vespertino: 1.0, estelar: 1.4 };

// --- Cadencia de los aportes pre-partido ---
const HOUR_MS = 60 * 60 * 1000;
// Un valor vacío o inválido usa el valor por defecto; 0 es una elección válida.
function nonNegativeEnv(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
// Ventana en la que llegan los aportes, contada hacia atrás desde el saque
// inicial. FOOTBALL_SIM_WINDOW_MS=0 la apaga: el libro completo desde el primer
// momento (cuota fija salvo por dinero real), que era el comportamiento anterior.
const WINDOW_MS = nonNegativeEnv(process.env.FOOTBALL_SIM_WINDOW_MS, 12 * HOUR_MS);
// Ritmo de llegada: tiempoRestante = ventana · (e^(a·u) − 1) / (e^a − 1), con u
// uniforme. Cuanto mayor es `a`, más dinero llega cerca del saque inicial. Con
// a = 3 y 12 h: ~21 % en las primeras seis horas, ~58 % en las tres últimas,
// ~32 % en la última hora y ~11 % en el último cuarto de hora, como en un mercado
// real: la sala se anima justo cuando la gente entra a verla. A diferencia de una
// potencia (u^curva), no amontona los boletos en los segundos finales: menos del
// 1 % llega en el último minuto, así que la cuota no se desploma en el silbatazo.
const ARRIVAL_CURVE = 3;
// Aportes por mercado (sembrado). El 1X2 es el mercado principal: recibe más
// boletos y más pequeños, así que es el que más se mueve.
const APORTES_MIN = 14, APORTES_MAX = 30;
const MAIN_MARKET = '1x2';
const MAIN_MARKET_FACTOR = 3;
// Ningún aporte mueve por sí solo una cuota más de ~4 % (el diseño pide ≤ 6 % por
// actualización, §10.4). Un aporte de s fichas sube la probabilidad ajustada de
// su selección en w·(s/total)·(1−p), o sea, baja su cuota ≈ w·(s/total)·(1−p)/p:
// cuanto menos probable es la selección, más pequeños tienen que ser sus boletos.
const MAX_APORTE_MOVE = 0.04;
const PLAN_CACHE_MAX = 4096;          // calendarios en memoria (≈ 150 partidos completos)

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

// --- Calendario de aportes (cadencia) ---

// Parte `total` fichas enteras en `parts` boletos de tamaño desigual (≥ 1 ficha
// cada uno). Los pesos van de 0,5 a 1,5: el boleto más grande nunca llega al
// triple del promedio, que es lo que usa `schedule` para acotar su impacto.
function splitStake(total, parts, rng) {
  const count = Math.max(1, Math.min(parts, total));
  const weights = [];
  for (let i = 0; i < count; i++) weights.push(0.5 + rng());
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map(w => Math.max(1, Math.floor(total * w / sum)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % count) {
    if (diff > 0) { out[i] += 1; diff -= 1; }
    else if (out[i] > 1) { out[i] -= 1; diff += 1; }
  }
  return out;
}

// Calendario determinista de un mercado pre-partido: la lista de aportes
// { at, selection, stake } (ordenada por hora) que llena el libro sintético. Su
// suma es EXACTAMENTE `distribute(...)`, el libro de cierre de siempre: cambia
// cuándo llega el dinero, no cuánto ni a qué selección.
//
// Cada selección recibe su dinero a su propio ritmo (unas pronto, otras a última
// hora), así que a media ventana la mezcla llegada no es la del cierre: la cuota
// sube y baja por el camino en vez de deslizarse en línea recta.
//
// Sin saque inicial conocido o con la ventana apagada no hay calendario
// (`bets: []`): el libro vale `closing` en todo momento.
function schedule(match, marketKey, openProbs, opts = {}) {
  const closing = distribute(match, marketKey, openProbs, {});
  const keys = Object.keys(closing);
  const total = keys.reduce((s, k) => s + closing[k], 0);
  const windowMs = opts.windowMs != null ? Number(opts.windowMs) : WINDOW_MS;
  const kickoff = Number(match && match.scheduledKickoffAt);
  if (!(windowMs > 0) || !Number.isFinite(kickoff) || !(total > 0)) {
    return { closing, total, bets: [], opensAt: null, closesAt: null };
  }
  const seed = match && match.seed != null ? match.seed : match && match.id;
  const rng = mulberry32(hash32(`${seed}|flow|${marketKey}|aportes`));
  const target = Math.round(randRange(rng, APORTES_MIN, APORTES_MAX) * (marketKey === MAIN_MARKET ? MAIN_MARKET_FACTOR : 1));
  const bets = [];
  for (const k of keys) {
    const stake = closing[k];
    if (!(stake > 0)) continue;
    const curve = ARRIVAL_CURVE * (0.75 + 0.5 * rng()); // ritmo propio de la selección
    const span = Math.expm1(curve);
    // Tamaño máximo de un boleto para respetar MAX_APORTE_MOVE, y los boletos
    // necesarios para que ni el mayor (< 3× el promedio) lo supere.
    const prob = Math.min(0.99, Math.max(0.01, Number(openProbs[k]) || 0));
    const largest = total * MAX_APORTE_MOVE * prob / (MONEY_WEIGHT * (1 - prob));
    const count = Math.max(Math.round(target * stake / total), Math.ceil(3 * stake / largest));
    const sizes = splitStake(stake, count, rng);
    for (const size of sizes) {
      bets.push({ at: Math.round(kickoff - windowMs * Math.expm1(curve * rng()) / span), selection: k, stake: size });
    }
  }
  // Orden total y estable: dos aportes en el mismo milisegundo no dependen del motor.
  bets.sort((a, b) => a.at - b.at || (a.selection < b.selection ? -1 : a.selection > b.selection ? 1 : 0) || a.stake - b.stake);
  return { closing, total, bets, opensAt: kickoff - windowMs, closesAt: kickoff };
}

// Libro sintético vigente en `now`: lo que ya llegó + el resto todavía NEUTRO
// (repartido según la probabilidad de apertura, que no empuja ninguna cuota).
//
//   sim_k(now) = llegado_k(now) + (total − llegado(now)) · p_k
//
// El volumen total es constante durante toda la ventana, así que la influencia
// frente al dinero real (tabla de §11.6, T20) es la misma a cualquier hora: lo
// único que cambia es la mezcla, de neutra (apertura) al libro de cierre.
function stakesAt(plan, openProbs, now) {
  const bets = (plan && plan.bets) || [];
  if (!bets.length || now >= plan.closesAt) {
    return { stakes: plan.closing, arrived: bets.length, pending: 0, nextAt: null };
  }
  const arrived = {};
  let arrivedTotal = 0, count = 0;
  for (const bet of bets) {
    if (bet.at > now) break;
    arrived[bet.selection] = (arrived[bet.selection] || 0) + bet.stake;
    arrivedTotal += bet.stake;
    count += 1;
  }
  const keys = Object.keys(plan.closing);
  const prob = k => Math.max(0, Number(openProbs && openProbs[k]) || 0);
  const probSum = keys.reduce((s, k) => s + prob(k), 0) || 1;
  const pending = plan.total - arrivedTotal;
  const stakes = {};
  for (const k of keys) stakes[k] = (arrived[k] || 0) + pending * prob(k) / probSum;
  return { stakes, arrived: count, pending, nextAt: count < bets.length ? bets[count].at : null };
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
// betting.js para mover cuotas; el barrido de cuotas (scheduler → sockets) le
// pregunta si llegó algún aporte para saber qué mercados volver a difundir.
class SimulatedFlow {
  constructor({ log = () => {}, config = {} } = {}) {
    this.log = log;
    this.config = { simWeight: SIM_WEIGHT, simSoftener: SIM_SOFTENER, windowMs: WINDOW_MS, ...config };
    this.cache = new Map();   // `${matchId}|${market}|${inPlay}` → stakes (libro fijo)
    this.plans = new Map();   // `${matchId}|${market}` → calendario pre-partido (LRU)
    this.counted = new Set(); // libros ya sumados a `totals` y registrados
    this.totals = new Map();  // matchId → volumen sintético total (para /healthz)
  }

  // Libro sintético de un mercado. Con `now` y antes del partido devuelve lo que
  // llevan apostado los simulados A ESA HORA; sin reloj, o en vivo, el libro fijo.
  stakesFor(match, marketKey, openProbs, { inPlay = false, now = null } = {}) {
    if (!inPlay && now != null && this._timed(match)) {
      return stakesAt(this._planFor(match, marketKey, openProbs), openProbs, Number(now)).stakes;
    }
    const key = `${match.id}|${marketKey}|${inPlay ? 'live' : 'pre'}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const stakes = distribute(match, marketKey, openProbs, { inPlay });
    this.cache.set(key, stakes);
    const total = Object.values(stakes).reduce((a, b) => a + b, 0);
    this._account(match, marketKey, inPlay, total, stakes);
    return stakes;
  }

  // ¿Llegó algún aporte a este mercado en (from, to]? true/false cuando se sabe;
  // null cuando el calendario no está en memoria (quien pregunta debe recalcular
  // el mercado: al cotizarlo se reconstruye). Nunca consulta un reloj propio.
  arrivedBetween(match, marketKey, from, to) {
    if (!this._timed(match)) return false;
    const kickoff = Number(match.scheduledKickoffAt);
    if (!(to > from) || to < kickoff - this.config.windowMs || from >= kickoff) return false;
    const plan = this.plans.get(`${match.id}|${marketKey}`);
    if (!plan || plan.closesAt !== kickoff) return null;
    return plan.bets.some(bet => bet.at > from && bet.at <= to);
  }

  totalForMatch(matchId) {
    return this.totals.get(matchId) || 0;
  }

  // Peso vigente dado el total real apostado en un mercado.
  weight(realTotal) {
    return simWeight(realTotal, this.config);
  }

  reset(matchId) {
    const prefix = `${matchId}|`;
    for (const store of [this.cache, this.plans]) {
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
    }
    for (const key of [...this.counted]) if (key.startsWith(prefix)) this.counted.delete(key);
    this.totals.delete(matchId);
  }

  _timed(match) {
    return this.config.windowMs > 0 && Boolean(match) && Number.isFinite(Number(match.scheduledKickoffAt));
  }

  // El calendario depende del saque inicial y de las probabilidades de apertura:
  // si cambia cualquiera de los dos (reprogramación, alineación nueva) se rehace.
  _planFor(match, marketKey, openProbs) {
    const key = `${match.id}|${marketKey}`;
    const kickoff = Number(match.scheduledKickoffAt);
    const signature = Object.keys(openProbs).map(k => `${k}:${Math.round(openProbs[k] * 1e6)}`).join(',');
    let plan = this.plans.get(key);
    if (plan && plan.closesAt === kickoff && plan.signature === signature) {
      this.plans.delete(key); this.plans.set(key, plan); // más reciente al final
      return plan;
    }
    plan = schedule(match, marketKey, openProbs, { windowMs: this.config.windowMs });
    plan.signature = signature;
    this.plans.delete(key); this.plans.set(key, plan);
    if (this.plans.size > PLAN_CACHE_MAX) this.plans.delete(this.plans.keys().next().value);
    this._account(match, marketKey, false, plan.total, plan.closing,
      { aportes: plan.bets.length, opensAt: plan.opensAt, closesAt: plan.closesAt });
    return plan;
  }

  // Una sola vez por (partido, mercado, modo): total para /healthz y registro de
  // auditoría. Rehacer un calendario no vuelve a sumar el mismo libro.
  _account(match, marketKey, inPlay, total, stakes, extra = {}) {
    const key = `${match.id}|${marketKey}|${inPlay ? 'live' : 'pre'}`;
    if (this.counted.has(key)) return;
    this.counted.add(key);
    this.totals.set(match.id, (this.totals.get(match.id) || 0) + total);
    this.log('football_simulated_flow', { match: match.id, market: marketKey, inPlay, total, stakes, ...extra });
  }
}

module.exports = {
  SimulatedFlow, decay, simWeight, distribute, schedule, stakesAt, combine, influence,
  SIM_WEIGHT, SIM_SOFTENER, PUBLIC_BIAS, OVER_TILT, VOLUME_MIN, VOLUME_MAX, INPLAY_FACTOR, BLOCK_FACTOR,
  WINDOW_MS, ARRIVAL_CURVE, APORTES_MIN, APORTES_MAX, MAIN_MARKET_FACTOR, MAX_APORTE_MOVE
};
