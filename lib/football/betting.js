'use strict';

// Fase D — Colocación, escrow, liquidación y reembolso de apuestas (§12).
//
// Este módulo es el único que mueve fichas del Estadio, y lo hace sobre los
// primitivos del casino: debit()/credit()/recordOutcome() de lib/progression.js
// y touch()/saveNow() del store de perfiles. Nunca llama a getOrCreate (no crea
// perfiles: §12.7, hallazgo 10) ni usa credit() como débito (hallazgo 1).
//
// Dos propiedades no negociables:
//   · Una apuesta NUNCA queda 'open' sin que el stake haya salido del perfil. El
//     orden WAL (A8) es: intención pending → comprobar+debitar (sin await entre
//     medio, TOCTOU-safe) → flush duradero del perfil → confirmar 'open'.
//   · Una apuesta se liquida EXACTAMENTE UNA VEZ (§12.3): el store solo hace
//     transitar una fila 'open', así que un sweep duplicado o un arranque que
//     reconcilie dos veces no puede pagar dos veces.
//
// Convención de liquidación (A9): al ganar, `profile.chips += payout` en crudo
// (NO credit(), que duplicaría el historial) + recordOutcome(net = payout−stake,
// eligible:false) + touch(). Eso escribe UNA transacción y UN punto de saldo (T35).

const { createHash, randomUUID } = require('node:crypto');
const { outcome } = require('./ratings');
const { matchContextFor } = require('./match-context');
const { createLineups } = require('./match-state');
const O = require('./odds');
const V2Quotes = require('./v2/quotes');
const { verifyCommitment, commitmentId } = require('./v2/commitment');
const { FutureMarketService, seasonOutcome, MAX_STAKE: FUTURE_MAX_STAKE } = require('./future-market');
const { verifyPolicy } = require('./v2/season-policy');
const { withSeasonAdmission } = require('./season-admission');
const { debit, credit, recordOutcome } = require('../progression');
const { FixedWindowRateLimiter } = require('../rate-limit');
const { combine: combineFlow } = require('./simulated-flow');
const { monthKey, CASINO_TIME_ZONE } = require('../profile-store-shared');
const {
  BALLON_DOR_MARKET, MAX_PAYOUT: BALLON_DOR_MAX_PAYOUT,
  closeDeadline: ballonDorCloseDeadline,
  ballonDorResultAnnouncementAt,
  isOfficialBallonDorResult
} = require('./ballon-dor-market');

const GAME = 'football';

// Lee una fracción de env en (0, 1]; si falta o es inválida, usa el defecto.
function clampFraction(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

// Límites (§11.3). Provisionales por diseño: todos viven en env y se ajustan sin
// desplegar. Decisión de producto (ronda 9): la apuesta debe ser MATERIAL respecto
// al saldo para que la ventaja de la casa se note — mínimo 10 % y máximo 50 % de las
// fichas actuales (sustituye al antiguo tope fijo de 10 / 25 % de la decisión C5).
const LIMITS = {
  stakeMinFraction: clampFraction(process.env.FOOTBALL_STAKE_MIN_FRAC, 0.10),
  stakeMaxFraction: clampFraction(process.env.FOOTBALL_STAKE_MAX_FRAC, 0.50),
  maxStakeAbsolute: Number(process.env.FOOTBALL_MAX_STAKE) || 25000,
  denominations: [10, 25, 50, 100, 250, 500, 1000],
  maxOpenBetsPerProfileMatch: 20,
  maxExposurePerProfileMatch: 50000,
  maxExposurePerMatch: 250000,
  maxPayoutPerBet: 500000,
  maxParlayLegs: 6,
  rateLimit: 10,
  rateWindowMs: 10000,
  idempotencyRoundMs: 2000
};

const LIVE_STATUSES = ['live', 'halftime', 'extra_time', 'shootout'];

// Historial y pagos (§34). Estados terminales = ya movieron fichas y no cambian.
const HISTORY_TERMINAL = ['won', 'lost', 'void', 'cashed'];
const HISTORY_LIMIT_MAX = 200;

function emptyHistorySummary() {
  return {
    total: 0, open: 0, byStatus: {},
    staked: 0, returned: 0, net: 0,
    openStake: 0, openPotentialPayout: 0,
    latestSettlementAt: null
  };
}

// --- Resolución de una selección contra el marcador final (puro, testeable) ---

function parseMarket(market) {
  const m = String(market || '');
  let g;
  if (m === '1x2') return { type: '1x2' };
  if (m === 'double_chance') return { type: 'double_chance' };
  if (m === 'btts') return { type: 'btts' };
  if (m === 'correct_score') return { type: 'correct_score' };
  if ((g = m.match(/^over_under_(\d+(?:\.\d+)?)$/))) return { type: 'over_under', line: Number(g[1]) };
  if ((g = m.match(/^handicap_home_(minus|plus)(\d+)$/))) return { type: 'handicap', line: (g[1] === 'minus' ? -1 : 1) * Number(g[2]) };
  // Hándicap asiático de dos vías: la línea va en cuartos (−0.25, +0.75, 0…).
  if ((g = m.match(/^asian_handicap_home_(minus|plus)(\d+(?:\.\d+)?)$/))) {
    return { type: 'asian_handicap', line: Number(((g[1] === 'minus' ? -1 : 1) * Number(g[2])).toFixed(2)) };
  }
  if (m === 'ht_ft') return { type: 'ht_ft' };
  if (m === 'first_scorer') return { type: 'first_scorer' };
  if ((g = m.match(/^yellow_cards_over_under_(\d+(?:\.\d+)?)$/))) return { type: 'yellow_cards', line: Number(g[1]) };
  if (m === 'both_teams_booked') return { type: 'both_teams_booked' };
  if (m === 'red_card') return { type: 'red_card' };
  if ((g = m.match(/^team_total_(home|away)_(\d+(?:\.\d+)?)$/))) return { type: 'team_total', team: g[1], line: Number(g[2]) };
  if ((g = m.match(/^win_to_nil_(home|away)$/))) return { type: 'win_to_nil', team: g[1] };
  return { type: 'unknown' };
}

// Devuelve 'won' | 'lost' | 'void' | 'half_won' | 'half_lost'. Las dos últimas
// existen solo para el hándicap asiático de línea partida (cuartos): media
// apuesta gana o pierde y la otra media se devuelve, así que el pago es parcial.
//
// Contexto de liquidación (`ctx`), siempre una foto del partido asentado:
//   · correctScoreCells: las celdas ofrecidas al vender ('other' = fuera de ellas)
//   · halftime:          { home, away } al descanso (mercado de descanso/final)
//   · firstScorer:       { id, name, team, minute, ownGoal? } | null (0-0)
//   · firstScorerIds:    los jugadores ofrecidos al vender ('other' = fuera de ellos)
//   · cards:             { yellow, red, homeYellow, awayYellow, homeRed, awayRed }
//                        conteo real de tarjetas del resultado asentado
function resolveSelection(market, selection, score, ctx = {}) {
  if (!score || !Number.isInteger(score.home) || !Number.isInteger(score.away)) return 'void';
  const total = score.home + score.away;
  const winner = outcome(score.home, score.away); // 'home'|'draw'|'away'
  const p = parseMarket(market);
  switch (p.type) {
    case '1x2':
      return selection === winner ? 'won' : 'lost';
    case 'double_chance': {
      const covers = { '1X': ['home', 'draw'], '12': ['home', 'away'], 'X2': ['draw', 'away'] };
      return (covers[selection] || []).includes(winner) ? 'won' : 'lost';
    }
    case 'over_under':
      if (total === p.line) return 'void'; // línea entera alcanzada (empuje)
      return selection === 'over' ? (total > p.line ? 'won' : 'lost') : (total < p.line ? 'won' : 'lost');
    case 'btts': {
      const both = score.home >= 1 && score.away >= 1;
      return selection === 'yes' ? (both ? 'won' : 'lost') : (both ? 'lost' : 'won');
    }
    case 'correct_score': {
      const sc = `${score.home}-${score.away}`;
      if (selection === 'other') {
        const cells = ctx.correctScoreCells || [];
        return cells.includes(sc) ? 'lost' : 'won';
      }
      return selection === sc ? 'won' : 'lost';
    }
    case 'handicap': {
      const diff = score.home + p.line - score.away;
      const hw = diff > 0 ? 'home' : diff === 0 ? 'draw' : 'away';
      return selection === hw ? 'won' : 'lost';
    }
    case 'win_to_nil': {
      const yes = p.team === 'home' ? (score.home >= 1 && score.away === 0) : (score.away >= 1 && score.home === 0);
      return selection === 'yes' ? (yes ? 'won' : 'lost') : (yes ? 'lost' : 'won');
    }
    case 'team_total': {
      const goals = p.team === 'home' ? score.home : score.away;
      if (goals === p.line) return 'void';
      return selection === 'over' ? (goals > p.line ? 'won' : 'lost') : (goals < p.line ? 'won' : 'lost');
    }
    case 'asian_handicap': {
      if (selection !== 'home' && selection !== 'away') return 'void';
      // Una línea de cuarto son dos medias apuestas a las líneas vecinas de medio
      // punto: de ahí los desenlaces parciales (media victoria / media derrota).
      const legs = O.asianLegs(p.line).map(leg => {
        const diff = score.home + leg - score.away;
        return diff > 0 ? 'won' : diff === 0 ? 'void' : 'lost';
      });
      const results = selection === 'away'
        ? legs.map(r => (r === 'won' ? 'lost' : r === 'lost' ? 'won' : 'void'))
        : legs;
      const wins = results.filter(r => r === 'won').length;
      const pushes = results.filter(r => r === 'void').length;
      if (wins === results.length) return 'won';
      if (pushes === results.length) return 'void';
      if (wins > 0) return 'half_won';
      if (pushes > 0) return 'half_lost';
      return 'lost';
    }
    case 'ht_ft': {
      // Sin marcador del descanso no se puede resolver: se anula en vez de
      // adivinar (el descanso se archiva con el resultado asentado).
      const ht = ctx.halftime;
      if (!ht || !Number.isInteger(ht.home) || !Number.isInteger(ht.away)) return 'void';
      const first = outcome(ht.home, ht.away);
      return selection === `${first}_${winner}` ? 'won' : 'lost';
    }
    case 'first_scorer': {
      const info = ctx.firstScorer;
      if (info === undefined) return 'void'; // sin fuente verificada: no se inventa
      if (info === null) return selection === 'none' ? 'won' : 'lost'; // 0-0
      if (info.ownGoal) return 'void'; // el primer gol fue en propia puerta
      if (selection === 'none') return 'lost';
      if (selection === 'other') {
        const offered = Array.isArray(ctx.firstScorerIds) ? ctx.firstScorerIds : null;
        if (!offered) return 'void';
        return offered.includes(String(info.id)) ? 'lost' : 'won';
      }
      return selection === String(info.id) ? 'won' : 'lost';
    }
    case 'yellow_cards': {
      // Sin conteo verificado de tarjetas no se adivina: se anula el boleto.
      const cards = ctx.cards;
      if (!cards || !Number.isInteger(cards.yellow)) return 'void';
      const total = cards.yellow;
      if (total === p.line) return 'void';
      return selection === 'over' ? (total > p.line ? 'won' : 'lost') : (total < p.line ? 'won' : 'lost');
    }
    case 'both_teams_booked': {
      const cards = ctx.cards;
      if (!cards || !Number.isInteger(cards.homeYellow) || !Number.isInteger(cards.awayYellow)) return 'void';
      const both = cards.homeYellow >= 1 && cards.awayYellow >= 1;
      return selection === 'yes' ? (both ? 'won' : 'lost') : (both ? 'lost' : 'won');
    }
    case 'red_card': {
      // Roja directa o segunda amarilla: ambas cuentan como expulsión.
      const cards = ctx.cards;
      if (!cards || !Number.isInteger(cards.red)) return 'void';
      const any = cards.red >= 1;
      return selection === 'yes' ? (any ? 'won' : 'lost') : (any ? 'lost' : 'won');
    }
    default:
      return 'void';
  }
}

// --- Servicio de apuestas ---

class BettingService {
  constructor({ store, profiles, idempotency = null, simulatedFlow = null, futureMarket = null, officialV2 = null, config = {}, log = () => {}, now = () => Date.now() }) {
    if (!store) throw new Error('BettingService requiere el store de fútbol');
    if (!profiles) throw new Error('BettingService requiere el store de perfiles');
    this.store = store;
    this.profiles = profiles;
    this.idempotency = idempotency;
    this.officialV2 = officialV2;
    this.simulatedFlow = simulatedFlow; // §11.6: mueve cuotas, nunca cuenta para exposición
    this.config = { ...LIMITS, ...config };
    this.log = log;
    this.now = now;
    this.futureMarket = futureMarket || new FutureMarketService({ store, now });
    this.rateLimiter = new FixedWindowRateLimiter({ limit: this.config.rateLimit, windowMs: this.config.rateWindowMs, now });
    this.suspended = new Map();  // matchId → Map(marketKey → untilMs)
    this.closed = new Map();     // matchId → Set(marketKey) cerrados definitivamente
    this.ballondorPlacements = new Map(); // idempotencia en memoria para solicitudes simultáneas
    this.ballondorPayouts = new Map(); // evita aplicar dos veces un payout/reembolso concurrente
    this.ticketPayouts = new Map(); // serializa pagos/reembolsos de simples y combinadas
    this.ticketPlacements = new Set(); // no cancelar una colocación todavía en curso
    this.v2MarketCache = new WeakMap(); // catálogo prepartido del snapshot confirmado
    this.lineupCache = new Map();      // alineaciones titulares por partido (mercado de primer goleador)
  }

  // --- Contexto y precios de un partido ---

  // Un boleto puede apuntar a un partido de la temporada anterior (mes recién
  // cerrado): se busca en todas las temporadas cargadas antes de darlo por
  // inexistente y anularlo.
  _matchOf(matchId) {
    if (matchId && typeof this.store.getMatchAnywhere === 'function') {
      const found = this.store.getMatchAnywhere(matchId);
      if (found) return found;
    }
    return this.store.getMatch(matchId);
  }

  // Una sola definición de «con qué λ y con qué matriz se pinta este partido»
  // (lib/football/match-context.js): la comparten las cuotas y el auditor.
  getMatchContext(match) {
    if (!match) return null;
    if (match.simulation) {
      const simulation = match.simulation;
      if (match.simulationUnconfirmed || !simulation.pricing || !verifyCommitment(simulation, match)) return null;
      let cached = this.v2MarketCache.get(simulation.pricing);
      if (!cached) {
        try {
          const context = matchContextFor(this.store, match);
          if (!context) return null;
          const markets = V2Quotes.preMatchMarkets(simulation.pricing, this._catalogOptions(match, context));
          if (!markets) return null;
          cached = { ...context, markets };
          this.v2MarketCache.set(simulation.pricing, cached);
        } catch (_) { return null; }
      }
      return cached;
    }
    return matchContextFor(this.store, match, { officialV2: this.officialV2, at: this.now() });
  }

  // Stake abierto acumulado por selección (para el peso del dinero, §10.4).
  _stakesFor(matchId, marketKey) {
    const stakes = {};
    for (const bet of this.store.getBets({ matchId, status: 'open' })) {
      if (bet.market !== marketKey) continue;
      stakes[bet.selection] = (stakes[bet.selection] || 0) + bet.stake;
    }
    return stakes;
  }

  // Alineaciones titulares del partido. `createLineups` es determinista a partir
  // de la plantilla y las tácticas (las mismas que usa el motor al generar la
  // línea de tiempo), así que el mercado de primer goleador ofrece exactamente a
  // los jugadores que pueden marcar. Se cachea por partido: se pide un mercado
  // por precio y no tiene sentido rehacer 25 alineaciones cada vez.
  _lineupsFor(match) {
    if (!match) return null;
    const key = `${match.seasonMonth || ''}:${match.homeId}:${match.awayId}`;
    if (this.lineupCache.has(key)) return this.lineupCache.get(key);
    let lineups = null;
    try {
      const league = typeof this.store.getLeague === 'function' ? this.store.getLeague(match.seasonMonth) : null;
      const clubs = league && Array.isArray(league.config) ? league.config : null;
      const home = clubs && clubs.find(c => c.id === match.homeId);
      const away = clubs && clubs.find(c => c.id === match.awayId);
      if (home && away) lineups = createLineups(home, away);
    } catch (_) {
      lineups = null; // sin clubes no hay mercado de primer goleador, nunca un nombre inventado
    }
    if (this.lineupCache.size > 64) this.lineupCache.delete(this.lineupCache.keys().next().value);
    this.lineupCache.set(key, lineups);
    return lineups;
  }

  // Opciones del catálogo pre-partido: λ (para descanso/final y primer goleador) y
  // alineaciones (solo primer goleador).
  _catalogOptions(match, mc) {
    const lambdas = mc && mc.lambdas ? mc.lambdas : null;
    // Las alineaciones V2 provienen del compromiso, no de la plantilla mutable.
    return { lambdas, lineups: (mc && mc.lineups) || this._lineupsFor(match) };
  }

  // Precios vigentes de un mercado: modelo + peso del dinero. En vivo recalcula
  // desde el estado revelado (§10.5). Devuelve null si el mercado no aplica.
  getMarket(match, marketKey, state = {}) {
    const mc = this.getMatchContext(match);
    if (!mc) return null;
    const inPlay = state.minute != null && state.score != null;
    let published;
    if (inPlay) {
      if (mc.quoteModel) {
        // Nunca usar la duración final privada del replay para cotizar.
        published = V2Quotes.liveMarket(mc.quoteModel, marketKey, state);
      } else {
        if (marketKey !== '1x2') return null; // §11.2: solo 1X2 en vivo
        published = O.publishLive(mc.lambdas, {
          minute: state.minute, score: state.score, matchEnd: state.matchEnd || 90,
          redCards: state.redCards
        });
      }
    } else {
      if (LIVE_STATUSES.includes(match.status)) return null; // nunca cotizar pre-partido durante el juego
      const options = this._catalogOptions(match, mc);
      const markets = mc.markets || (mc.quoteModel
        ? V2Quotes.preMatchMarkets(mc.quoteModel, options)
        : O.buildPreMatchMarkets(mc.matrix, options));
      published = markets && markets[marketKey];
    }
    if (!published || published.degenerate) return null;

    let selections = published.selections;
    if (!published.independent) {
      const openProbs = {}, openPrices = {};
      published.selections.forEach(s => { openProbs[s.key] = s.prob; openPrices[s.key] = s.price; });
      // Stakes REALES (los únicos que cuentan para exposición) + flujo simulado
      // ponderado (§11.6). El simulado solo empuja las cuotas, nunca los techos.
      const realStakes = this._stakesFor(match.id, marketKey);
      let stakes = realStakes;
      if (this.simulatedFlow) {
        const simStakes = this.simulatedFlow.stakesFor(match, marketKey, openProbs, { inPlay });
        stakes = combineFlow(realStakes, simStakes, this.simulatedFlow.config).stakes;
      }
      const moved = O.applyMoneyWeight(openProbs, openPrices, stakes, published.targetMargin);
      selections = published.selections.map(s => {
        // El peso del dinero nunca puede superar el techo conservador V2.
        const protectedV2Price = [V2Quotes.VERSION].includes(mc.quoteModel?.version)
          || V2Quotes.isEstimatedVersion(mc.quoteModel?.version);
        const price = protectedV2Price ? Math.min(s.price, moved.prices[s.key]) : moved.prices[s.key];
        return { ...s, price, implied: Number(O.impliedProb(price).toFixed(4)) };
      });
    }
    // Nombres para la UI (primer goleador): el cliente no tiene las plantillas.
    const labels = published.labels || null;
    if (labels) selections = selections.map(s => (labels[s.key] ? { ...s, label: labels[s.key] } : s));
    const publishedOverround = O.overround(selections.map(selection => selection.price))
      / (published.independent ? 2 : 1);
    const publishedMargin = publishedOverround - 1;
    return {
      marketKey, inPlay, selections, label: labels ? 'Primer goleador' : null,
      overround: Number(publishedOverround.toFixed(5)),
      margin: Number(publishedMargin.toFixed(5)),
      hold: Number((publishedOverround > 0 ? publishedMargin / publishedOverround : 0).toFixed(5)),
      targetMargin: published.targetMargin ?? published.margin ?? null,
      suspended: Boolean(state.playStopped) || this.isSuspended(match.id, marketKey),
      closed: this.isClosed(match.id, marketKey)
    };
  }

  // Catálogo pre-partido VIGENTE de un partido. Las líneas del hándicap asiático
  // dependen de la supremacía esperada, así que la lista no puede ser una
  // constante: se pregunta al mismo motor que publica los precios.
  marketKeysFor(match) {
    const mc = this.getMatchContext(match);
    if (!mc) return [];
    const options = this._catalogOptions(match, mc);
    const markets = mc.markets || (mc.quoteModel
      ? V2Quotes.preMatchMarkets(mc.quoteModel, options)
      : O.buildPreMatchMarkets(mc.matrix, options));
    return Object.keys(markets || {}).filter(key => markets[key] && !markets[key].degenerate);
  }

  // Celdas de marcador exacto ofrecidas (para resolver 'other' al liquidar).
  _correctScoreCells(match) {
    const mc = this.getMatchContext(match);
    if (!mc) return [];
    return Object.keys(O.probCorrectScore(mc.matrix, 12)).filter(k => k !== 'other');
  }

  // Celdas que se publicaron con la apuesta. La selección `other` se resuelve
  // contra ESTA lista: recalcularlas al liquidar (la matriz ya se movió con los
  // resultados de la liga) cambiaba el significado del boleto vendido.
  _cellsForBet(bet, match) {
    if (bet && Array.isArray(bet.correctScoreCells) && bet.correctScoreCells.length) {
      return bet.correctScoreCells;
    }
    return this._correctScoreCells(match);
  }

  // --- Suspensión y cierre de mercados (§10.6) ---

  suspend(matchId, marketKey, untilMs) {
    if (!this.suspended.has(matchId)) this.suspended.set(matchId, new Map());
    this.suspended.get(matchId).set(marketKey, untilMs == null ? Infinity : untilMs);
  }
  resume(matchId, marketKey) {
    this.suspended.get(matchId)?.delete(marketKey);
  }
  isSuspended(matchId, marketKey, now = this.now()) {
    const until = this.suspended.get(matchId)?.get(marketKey);
    if (until == null) return false;
    if (until <= now) { this.suspended.get(matchId).delete(marketKey); return false; }
    return true;
  }
  closeMarket(matchId, marketKey) {
    if (!this.closed.has(matchId)) this.closed.set(matchId, new Set());
    this.closed.get(matchId).add(marketKey);
  }
  isClosed(matchId, marketKey) {
    return Boolean(this.closed.get(matchId)?.has(marketKey));
  }

  // --- Límites (§11.3, ronda 9): mínimo 10 % y máximo 50 % de las fichas actuales ---

  stakeBounds(profile) {
    const chips = Math.max(0, Math.floor(profile.chips || 0));
    let max = Math.min(Math.floor(chips * this.config.stakeMaxFraction), this.config.maxStakeAbsolute);
    // El mínimo es el 10 % del saldo (apuesta material), con piso de 1 ficha y sin
    // pasar nunca el saldo disponible.
    let min = Math.min(Math.max(1, Math.floor(chips * this.config.stakeMinFraction)), chips);
    if (min > max) min = max; // saldo bajo: el mínimo se ajusta al tope (T21)
    return { min: Math.max(0, min), max: Math.max(0, max), chips };
  }
  availableDenominations(profile) {
    const { min, max } = this.stakeBounds(profile);
    return this.config.denominations.filter(d => d >= min && d <= max);
  }
  validateStake(profile, stake) {
    const { min, max } = this.stakeBounds(profile);
    if (!Number.isInteger(stake) || stake <= 0) return { ok: false, code: 'stake_invalido' };
    if (stake > max) return { ok: false, code: 'stake_excede_tope', max };
    if (stake < min) return { ok: false, code: 'stake_bajo_minimo', min };
    if (stake > profile.chips) return { ok: false, code: 'insufficient_chips' };
    return { ok: true, min, max };
  }

  // Exposición agregada (§11.3). Devuelve el código de rechazo o null.
  _checkExposure(profile, match, stake, potentialPayout) {
    if (potentialPayout > this.config.maxPayoutPerBet) return 'pago_maximo_excedido';
    const mine = this.store.getBets({ profileId: profile.id, matchId: match.id, status: 'open' });
    if (mine.length >= this.config.maxOpenBetsPerProfileMatch) return 'max_apuestas_por_partido';
    const myStake = mine.reduce((s, b) => s + b.stake, 0) + stake;
    if (myStake > this.config.maxExposurePerProfileMatch) return 'exposicion_perfil_excedida';
    const matchStake = this.store.sumOpenStake(match.id) + stake;
    if (matchStake > this.config.maxExposurePerMatch) return 'exposicion_casa_excedida';
    return null;
  }

  // ¿Se puede apostar a este partido ahora?
  _bettingWindow(match, inPlay) {
    if (match.status === 'scheduled') return inPlay ? { ok: false, code: 'aun_no_en_vivo' } : { ok: true, inPlay: false };
    if (LIVE_STATUSES.includes(match.status)) return inPlay ? { ok: true, inPlay: true } : { ok: false, code: 'estado_no_disponible' };
    return { ok: false, code: 'mercado_cerrado' }; // finished/settled/postponed
  }

  _idempotencyKey(deviceToken, profileId, placedAt, matchId, market, selection, stake) {
    const rounded = Math.floor(placedAt / this.config.idempotencyRoundMs) * this.config.idempotencyRoundMs;
    return `${deviceToken || profileId}:${rounded}:${matchId}:${market}:${selection}:${stake}`;
  }

  // --- Una sola selección por categoría (mercado) y partido ---

  // ¿El perfil ya tiene dinero comprometido en este mercado de este partido, ya sea
  // en una apuesta individual o como pierna de una combinada? Cuenta cualquier
  // estado vivo o liquidado (incluidas las cobradas en cash-out, para que no se
  // pueda "cubrir" re-apostando la misma categoría). Solo se ignoran las apuestas
  // anuladas que nunca llegaron a debitarse (fallo de saldo durante el WAL).
  _marketTaken(profileId, matchId, market) {
    const bet = this.store.getBets({ profileId, matchId }).find(b =>
      b.market === market && (b.status !== 'void' || b.debited));
    if (bet) return { kind: 'bet', id: bet.id };
    const parlay = this.store.getParlays({ profileId }).find(p =>
      (p.status !== 'void' || p.debited) &&
      (p.legs || []).some(l => l.matchId === matchId && l.market === market));
    if (parlay) return { kind: 'parlay', id: parlay.id };
    return null;
  }

  // --- Colocación (orden WAL, decisión A8) ---

  async placeBet({ profile, deviceToken = null, matchId, market, selection, stake, state = {}, refreshState = null, placedAt = this.now(), idempotencyKey = null }) {
    stake = Math.floor(Number(stake) || 0);
    if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
    if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 128)) {
      return { ok: false, code: 'idempotency_key_invalida' };
    }
    const key = idempotencyKey || this._idempotencyKey(deviceToken, profile.id, placedAt, matchId, market, selection, stake);
    const request = { profileId: profile.id, matchId, market, selection, stake };
    const existing = this._findByIdempotencyKey(key);
    if (existing) return this._replayBet(existing, request);
    const match = this.store.getMatch(matchId);
    if (!match) return { ok: false, code: 'no_match' };
    if (this.officialV2 && match.status === 'scheduled') {
      const ready = await this.officialV2.prepareMatch(match, this.now());
      if (!ready.ok && !ready.legacy) return { ok: false, code: ready.reason || 'persistencia_pendiente' };
    }

    const inPlay = state.minute != null && state.score != null;
    if (inPlay && match.simulation && typeof refreshState !== 'function') return { ok: false, code: 'estado_no_disponible' };
    const window = this._bettingWindow(match, inPlay);
    if (!window.ok) return { ok: false, code: window.code };
    if (inPlay && state.playStopped) return { ok: false, code: 'market_suspended' };
    if (this.isClosed(matchId, market)) return { ok: false, code: 'selection_closed' };
    if (this.isSuspended(matchId, market)) return { ok: false, code: 'market_suspended' };

    const pricedSimulation = match.simulation || null;
    const mkt = this.getMarket(match, market, state);
    if (!mkt) return { ok: false, code: 'market_unavailable' };
    const sel = mkt.selections.find(s => s.key === selection);
    if (!sel) return { ok: false, code: 'selection_invalida' };
    const odds = sel.price;
    // Foto del mercado publicado: `other` significa "fuera de estas doce".
    const publishedCells = parseMarket(market).type === 'correct_score'
      ? mkt.selections.map(item => item.key).filter(key => key !== 'other') : null;
    // Misma regla para el primer goleador: «otros» significa «fuera de ESTOS
    // jugadores», así que la lista viaja con el boleto.
    const publishedScorers = parseMarket(market).type === 'first_scorer'
      ? mkt.selections.map(item => item.key).filter(key => key !== 'other' && key !== 'none') : null;

    // El reintento ya se resolvió antes de consultar el mercado; una solicitud
    // distinta no puede volver a apostar en la misma categoría.
    if (this._marketTaken(profile.id, matchId, market)) return { ok: false, code: 'mercado_ya_apostado' };

    const v = this.validateStake(profile, stake);
    if (!v.ok) return { ok: false, code: v.code, ...v };
    const exposure = this._checkExposure(profile, match, stake, Math.floor(stake * odds));
    if (exposure) return { ok: false, code: exposure };

    const rate = this.rateLimiter.consume(`bet:${profile.id}`);
    if (!rate.allowed) return { ok: false, code: 'rate_limit', retryAfterMs: rate.retryAfterMs };

    // Idempotencia (§12.2): un reintento o doble clic devuelve la apuesta original.
    if (this.idempotency) {
      const claim = await this.idempotency.begin({ actorId: profile.id, key, operation: 'football_bet', requestHash: key });
      if (claim.state === 'completed') {
        const completed = this._findByIdempotencyKey(key);
        return completed ? this._replayBet(completed, request) : { ok: false, code: 'persistencia_pendiente' };
      }
      if (claim.state === 'processing') return { ok: false, code: 'en_proceso' };
      if (claim.state === 'conflict') return { ok: false, code: 'conflicto_idempotencia' };
    }
    // Otra solicitud pudo insertarse mientras esperaba begin(). No divulgar un
    // boleto de otro perfil aunque alguien reutilice deliberadamente su clave.
    const raced = this._findByIdempotencyKey(key);
    if (raced) return this._replayBet(raced, request);

    const bet = {
      id: `b_${randomUUID().replace(/-/g, '')}`,
      idempotencyKey: key, profileId: profile.id, deviceToken: null,
      matchId, seasonMonth: match.seasonMonth, market, selection, stake, oddsAtPlacement: odds,
      ...(pricedSimulation ? { simulationId: commitmentId(pricedSimulation) } : {}),
      inPlay: Boolean(inPlay), minuteAtPlacement: inPlay ? state.minute : null,
      status: 'pending', debited: false, escrowProtocol: 'durable-1', placedAt,
      potentialPayout: Math.min(this.config.maxPayoutPerBet, Math.floor(stake * odds)),
      cashoutAvailable: true, parlayId: null,
      ...(publishedCells && publishedCells.length ? { correctScoreCells: publishedCells } : {}),
      ...(publishedScorers && publishedScorers.length ? { firstScorerIds: publishedScorers } : {})
    };

    // Revalidar la ventana y la cotización después de cada espera. En vivo el
    // socket proporciona una lectura autoritativa nueva; jamás viene del cliente.
    const stillValid = () => {
      if ((match.simulation || null) !== pricedSimulation || !this._bettingWindow(match, inPlay).ok
          || this.isClosed(matchId, market) || this.isSuspended(matchId, market)) return false;
      if (!inPlay && this.now() >= match.scheduledKickoffAt) return false;
      let current = state;
      if (inPlay && typeof refreshState === 'function') {
        try { current = refreshState(); } catch (_) { return false; }
        if (!current || current.playStopped || current.phase === 'halftime' || current.phase === 'ended'
            || !Number.isFinite(current.minute) || Math.floor(current.minute) !== Math.floor(state.minute)
            || current.half !== state.half || current.score?.home !== state.score.home || current.score?.away !== state.score.away
            || current.redCards?.home !== state.redCards?.home || current.redCards?.away !== state.redCards?.away) return false;
      }
      const latest = this.getMarket(match, market, current);
      return Boolean(latest && !latest.suspended && !latest.closed && latest.selections.find(item => item.key === selection)?.price === odds);
    };
    if (!stillValid()) return { ok: false, code: 'mercado_cambio' };
    // Re-chequeo síncrono (sin await desde aquí hasta insertBet): cierra la carrera
    // entre dos apuestas simultáneas del mismo perfil en el mismo mercado.
    if (this._marketTaken(profile.id, matchId, market)) return { ok: false, code: 'mercado_ya_apostado' };

    // WAL: la intención (pending) es duradera ANTES de mover una sola ficha.
    const ins = this.store.insertBet(bet);
    if (!ins.ok) return { ok: false, code: `store_${ins.reason}` };

    const committed = await this._commitTicketStake('bet', ins.bet, profile, stillValid);
    if (!committed.ok) return committed;

    if (this.idempotency) {
      try { await this.idempotency.complete({ actorId: profile.id, key, statusCode: 200, responseBody: { betId: bet.id } }); }
      catch (error) { this.log('football_idempotency_complete_error', { message: String(error && error.message || error) }); }
    }
    this.log('football_bet_placed', { betId: bet.id, matchId, market, selection, stake, odds, inPlay: bet.inPlay });
    return { ok: true, bet: this.store.getBet(bet.id) };
  }

  async _commitTicketStake(kind, ticket, profile, stillValid = () => true) {
    const lock = `${kind}:${ticket.id}`;
    this.ticketPlacements.add(lock);
    const voidTicket = () => kind === 'bet' ? this.store.voidBet(ticket.id)
      : kind === 'parlay' ? this.store.voidParlay(ticket.id) : this.store.voidFuture(ticket.id, { payout: 0 });
    const markDebited = () => kind === 'bet' ? this.store.markBetDebited(ticket.id)
      : kind === 'parlay' ? this.store.markParlayDebited(ticket.id) : this.store.markFutureDebited(ticket.id);
    const confirm = () => kind === 'bet' ? this.store.confirmBet(ticket.id)
      : kind === 'parlay' ? this.store.confirmParlay(ticket.id) : this.store.confirmFuture(ticket.id);
    try {
      if (typeof this.store.saveStrict !== 'function' || !(await this.store.saveStrict())) return { ok: false, code: 'persistencia_pendiente' };
      // Entre el cálculo del precio y el primer flush puede arrancar el partido
      // o cambiar el compromiso. No debitar por una cotización ya obsoleta.
      if (!stillValid()) { voidTicket(); await this.store.saveStrict(); return { ok: false, code: 'mercado_cambio' }; }
      // No hay await entre comprobar saldo y debitar, incluso con varias apuestas.
      if (ticket.stake > profile.chips) { voidTicket(); await this.store.saveStrict(); return { ok: false, code: 'insufficient_chips' }; }
      const operationId = `football:${kind}:stake:${ticket.id}`;
      const description = kind === 'bet' ? 'Apuesta Estadio' : kind === 'parlay' ? 'Combinada Estadio' : 'Futuro Estadio';
      const debitResult = debit(profile, ticket.stake, description, { operationId });
      if (!debitResult.ok) { voidTicket(); await this.store.saveStrict(); return { ok: false, code: debitResult.error || 'debito_fallido' }; }
      if (!Array.isArray(profile.footballPendingStakes)) profile.footballPendingStakes = [];
      if (!profile.footballPendingStakes.includes(operationId)) profile.footballPendingStakes.push(operationId);
      markDebited();
      if (typeof this.profiles.persistProfile !== 'function' || !(await this.profiles.persistProfile(profile))) {
        return { ok: false, code: 'persistencia_pendiente' };
      }
      // Si cambió el partido mientras se persistía el débito, el boleto no se
      // acepta: se anula con reembolso recuperable usando la misma marca WAL.
      if (!stillValid()) {
        const details = { payout: ticket.stake, reason: 'la cotización cambió durante la colocación' };
        const cancelled = kind === 'bet' ? this.store.voidBet(ticket.id, details)
          : kind === 'parlay' ? this.store.voidParlay(ticket.id, details) : this.store.voidFuture(ticket.id, details);
        if (!cancelled.ok) return { ok: false, code: 'persistencia_pendiente' };
        const refund = await this._applyTicketPayout(kind, ticket);
        return { ok: false, code: refund?.ok ? 'mercado_cambio' : 'persistencia_pendiente' };
      }
      if (!confirm().ok || !(await this.store.saveStrict())) return { ok: false, code: 'persistencia_pendiente' };
      profile.footballPendingStakes = profile.footballPendingStakes.filter(id => id !== operationId);
      this.profiles.touch(profile); // se retira el marcador solo después del compromiso durable
      return { ok: true };
    } catch (error) {
      this.log('football_stake_persist_error', { kind, ticketId: ticket.id, message: String(error?.message || error) });
      return { ok: false, code: 'persistencia_pendiente' };
    } finally {
      this.ticketPlacements.delete(lock);
    }
  }

  _findByIdempotencyKey(key) {
    for (const bet of this.store.bets.values()) if (bet.idempotencyKey === key) return bet;
    return null;
  }

  async _replayBet(bet, request) {
    if (['profileId', 'matchId', 'market', 'selection', 'stake'].some(field => bet[field] !== request[field])) {
      return { ok: false, code: 'conflicto_idempotencia' };
    }
    if (bet.status === 'pending' || this.ticketPlacements.has(`bet:${bet.id}`)) return { ok: false, code: 'persistencia_pendiente' };
    if (bet.status === 'void' && (!bet.debited || /colocaci[oó]n/i.test(bet.payoutReason || ''))) {
      return { ok: false, code: 'boleto_anulado' };
    }
    try {
      if (bet.escrowProtocol === 'durable-1' && !(await this.store.saveStrict())) return { ok: false, code: 'persistencia_pendiente' };
    } catch (_) { return { ok: false, code: 'persistencia_pendiente' }; }
    return { ok: true, bet, replayed: true };
  }

  // --- Liquidación exactamente una vez (§12.3, A9) ---

  // Reproduce una liquidación persistida hasta que el perfil confirme el
  // crédito. La marca en el perfil evita volver a pagar si el proceso cae entre
  // el guardado del perfil y la confirmación final del boleto. Devuelve un
  // resultado síncrono en archivo y una promesa en Postgres.
  _applyTicketPayout(kind, ticket) {
    if (!ticket || ticket.payoutApplied !== false) return { ok: true, alreadyApplied: true };
    const lock = `${kind}:${ticket.id}`;
    if (this.ticketPayouts.has(lock)) return this.ticketPayouts.get(lock);
    const failed = reason => ({ ok: false, reason });
    const after = (value, next, reason) => {
      if (value && typeof value.then === 'function') return Promise.resolve(value).then(next).catch(() => failed(reason));
      try { return next(value); } catch (_) { return failed(reason); }
    };
    const save = next => {
      if (typeof this.store.saveStrict !== 'function') return failed('persistencia_no_confirmable');
      try { return after(this.store.saveStrict(), ok => ok === true ? next() : failed('boleto_no_persistido'), 'boleto_no_persistido'); }
      catch (_) { return failed('boleto_no_persistido'); }
    };
    const markApplied = (profile, operationId) => {
      const marked = kind === 'bet' ? this.store.markBetPayoutApplied(ticket.id)
        : kind === 'parlay' ? this.store.markParlayPayoutApplied(ticket.id) : this.store.markFuturePayoutApplied(ticket.id);
      if (!marked.ok) return failed(marked.reason || 'boleto_no_liquidado');
      const confirmation = save(() => ({ ok: true, payout: ticket.payout || 0, status: ticket.status }));
      return after(confirmation, result => {
        if (!result.ok) ticket.payoutApplied = false; // volver a intentar; el perfil ya recuerda la operación
        else if (profile && operationId && Array.isArray(profile.footballPendingPayments)) {
          profile.footballPendingPayments = profile.footballPendingPayments.filter(id => id !== operationId);
          if (ticket.status === 'void' && ticket.escrowProtocol === 'durable-1' && Array.isArray(profile.footballPendingStakes)) {
            profile.footballPendingStakes = profile.footballPendingStakes.filter(id => id !== `football:${kind}:stake:${ticket.id}`);
          }
          this.profiles.touch(profile); // limpieza diferida: el boleto ya está confirmado
        }
        return result;
      }, 'boleto_no_persistido');
    };
    const operation = save(() => {
      const profile = this.profiles.getProfile(ticket.profileId);
      if (!profile) return failed('perfil_no_disponible');
      const operationId = `football:${kind}:payout:${ticket.id}`;
      const applied = profile.footballPendingPayments?.includes(operationId)
        || profile.appliedChipOperations?.includes(operationId)
        || profile.transactions?.some(item => item?.operationId === operationId);
      if (!applied) {
        const payout = Math.max(0, Math.floor(Number(ticket.payout) || 0));
        if (ticket.status === 'void') {
          if (payout) credit(profile, payout, `Anulación: ${ticket.payoutReason || 'boleto anulado'}`, { operationId });
          else return markApplied(); // no hubo débito que reembolsar
        } else if (['won', 'lost', 'cashed'].includes(ticket.status)) {
          profile.chips += payout;
          recordOutcome(profile, { game: GAME, net: payout - ticket.stake, eligible: false, operationId });
        } else return failed('boleto_no_liquidado');
      }
      if (!Array.isArray(profile.footballPendingPayments)) profile.footballPendingPayments = [];
      if (!profile.footballPendingPayments.includes(operationId)) profile.footballPendingPayments.push(operationId);
      if (typeof this.profiles.persistProfile !== 'function') return failed('perfil_no_confirmable');
      try {
        return after(this.profiles.persistProfile(profile), ok => ok === true ? markApplied(profile, operationId) : failed('perfil_no_persistido'), 'perfil_no_persistido');
      } catch (_) { return failed('perfil_no_persistido'); }
    });
    if (!operation || typeof operation.then !== 'function') return operation;
    const tracked = operation.finally(() => { if (this.ticketPayouts.get(lock) === tracked) this.ticketPayouts.delete(lock); });
    this.ticketPayouts.set(lock, tracked);
    return tracked;
  }

  // Paga una apuesta contra el perfil. `resolution` es
  // 'won'|'lost'|'void'|'half_won'|'half_lost'.
  //
  // Media victoria (línea de cuarto): la mitad ganadora cobra a la cuota y la otra
  // mitad se devuelve → stake/2·cuota + stake/2. Media derrota: se pierde una
  // mitad y la otra vuelve → stake/2.
  _payoutBet(bet, resolution, reason = '') {
    const stake = bet.stake;
    const halfStake = Math.floor(stake / 2);
    const otherHalf = stake - halfStake;
    const payout = resolution === 'won' ? Math.min(this.config.maxPayoutPerBet, Math.floor(stake * bet.oddsAtPlacement))
      : resolution === 'half_won' ? Math.min(this.config.maxPayoutPerBet, Math.floor(halfStake * bet.oddsAtPlacement) + otherHalf)
      : resolution === 'half_lost' ? otherHalf
      : resolution === 'void' ? stake : 0;
    const status = resolution === 'won' || resolution === 'half_won' ? 'won'
      : resolution === 'void' ? 'void' : 'lost';
    const out = this.store.settleBet(bet.id, { status, payout, reason });
    if (!out.ok) return { ok: false, reason: out.reason };
    if (out.alreadySettled) return { ok: true, alreadySettled: true, payout: 0 };
    const applied = this._applyTicketPayout('bet', out.bet);
    this.log('football_bet_settled', { betId: bet.id, status, payout, stake: bet.stake });
    if (applied && typeof applied.then === 'function') return { ok: true, pending: true, payout, status, completion: applied };
    return applied.ok ? { ok: true, payout, status } : applied;
  }

  // Contexto del resultado ASENTADO (§15.4): el marcador del descanso, el primer
  // goleador y el conteo de tarjetas son parte del resultado oficial, no un
  // recalculo de la cronología en el momento de pagar. Un partido antiguo
  // (asentado antes de existir estos mercados) no los tiene: el boleto se anula
  // en vez de inventarse el dato.
  _settlementMeta(match) {
    const official = (match && typeof this.store.getMatchAnywhere === 'function' ? this.store.getMatchAnywhere(match.id) : null)
      || (match && this.store.getMatch(match.id)) || match;
    const result = (official && official.result) || {};
    return { halftime: result.halftime, firstScorer: result.firstScorer, cards: result.cards };
  }

  _contextForBet(bet, match, meta) {
    return {
      correctScoreCells: this._cellsForBet(bet, match),
      halftime: meta ? meta.halftime : undefined,
      firstScorer: meta ? meta.firstScorer : undefined,
      firstScorerIds: bet && Array.isArray(bet.firstScorerIds) && bet.firstScorerIds.length ? bet.firstScorerIds : null,
      cards: meta ? meta.cards : undefined
    };
  }

  // Hook del motor (§15): paga todas las apuestas de un partido al terminar.
  settleMatchBets(match, score) {
    if (!match || !score) return { settled: 0, paid: 0 };
    const result = { home: score.home, away: score.away, winner: outcome(score.home, score.away) };
    const meta = this._settlementMeta(match);
    const cells = this._correctScoreCells(match);
    let settled = 0, paid = 0;
    for (const bet of this.store.getOpenBetsForMatch(match.id)) {
      const resolution = resolveSelection(bet.market, bet.selection, result, this._contextForBet(bet, match, meta));
      const out = this._payoutBet(bet, resolution);
      if (out.ok && !out.alreadySettled) { settled++; paid += out.payout; }
    }
    for (const parlay of this.store.getOpenParlaysForMatch(match.id)) {
      this.settleParlayLeg(parlay.id, match.id, result, cells, '', meta);
    }
    return { settled, paid };
  }

  // Hook del motor (§15): reembolsa las apuestas de un partido pospuesto.
  refundMatchBets(match, reason = 'partido pospuesto') {
    if (!match) return { refunded: 0 };
    let refunded = 0;
    for (const bet of this.store.getBets({ matchId: match.id, status: 'open' })) {
      const out = this._payoutBet(bet, 'void', reason);
      if (out.ok && !out.alreadySettled) refunded++;
    }
    for (const parlay of this.store.getOpenParlaysForMatch(match.id)) {
      this.settleParlayLeg(parlay.id, match.id, null, [], reason);
    }
    return { refunded };
  }

  // --- Cash-out (§10.7) ---

  cashout(profile, betId, state = {}) {
    const bet = this.store.getBet(betId);
    if (!bet || bet.profileId !== profile.id) return { ok: false, code: 'no_bet' };
    // Un corte después de fijar el cash-out puede dejar su pago por confirmar.
    // El reintento recupera ese mismo importe, incluso si el partido ya terminó.
    if (bet.status === 'cashed') {
      const applied = this._applyTicketPayout('bet', bet);
      const replay = payment => payment.ok
        ? { ok: true, cashout: bet.payout, replayed: true }
        : { ok: false, code: payment.reason || 'persistencia_pendiente' };
      return applied && typeof applied.then === 'function' ? applied.then(replay) : replay(applied);
    }
    if (bet.status !== 'open') return { ok: false, code: 'not_open' };
    const match = this._matchOf(bet.matchId);
    if (!match) return { ok: false, code: 'no_match' };
    if (match.status === 'finished' || match.status === 'settled' || match.status === 'postponed') return { ok: false, code: 'match_ended' };
    if (state.playStopped) return { ok: false, code: 'market_suspended' };
    if (this.isSuspended(bet.matchId, bet.market)) return { ok: false, code: 'market_suspended' };
    // §11.2: en vivo solo se publica precio para 1X2; el resto de mercados no
    // admite cash-out hasta que tengan precio en vivo (código propio, no «no_price»).
    const inPlay = state.minute != null && state.score != null;
    if (inPlay && bet.market !== '1x2') return { ok: false, code: 'market_not_cashable' };
    const mkt = this.getMarket(match, bet.market, state);
    if (!mkt) return { ok: false, code: 'price_unavailable' };
    const sel = mkt.selections.find(s => s.key === bet.selection);
    if (!sel) return { ok: false, code: 'price_unavailable' };
    // Las fichas son enteras; el historial, el boleto y el saldo deben coincidir.
    const value = Math.floor(O.cashoutValue(bet.stake, bet.oddsAtPlacement, sel.cashoutProbability ?? sel.prob));
    const out = this.store.settleBet(betId, { status: 'cashed', payout: value });
    if (!out.ok) return { ok: false, code: out.reason };
    if (out.alreadySettled) return { ok: false, code: 'already_settled' };
    const applied = this._applyTicketPayout('bet', out.bet);
    const result = payment => {
      if (!payment.ok) return { ok: false, code: payment.reason || 'persistencia_pendiente' };
      this.log('football_cashout', { betId, value, stake: bet.stake });
      return { ok: true, cashout: value };
    };
    return applied && typeof applied.then === 'function' ? applied.then(result) : result(applied);
  }

  // --- Combinadas (§11.4) ---

  async placeParlay({ profile, legs, stake, idempotencyKey = null, placedAt = this.now() }) {
    stake = Math.floor(Number(stake) || 0);
    if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
    if (!Array.isArray(legs) || legs.length < 2) return { ok: false, code: 'piernas_insuficientes' };
    if (legs.length > this.config.maxParlayLegs) return { ok: false, code: 'max_piernas' };
    if (legs.some(leg => !leg || typeof leg.matchId !== 'string' || typeof leg.market !== 'string'
        || typeof leg.selection !== 'string')) return { ok: false, code: 'pierna_invalida' };
    if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 128)) {
      return { ok: false, code: 'idempotency_key_invalida' };
    }
    const matchIds = new Set(legs.map(l => l.matchId));
    if (matchIds.size !== legs.length) return { ok: false, code: 'partidos_duplicados' };
    const requested = legs.map(({ matchId, market, selection }) => ({ matchId, market, selection }));
    const key = idempotencyKey || `parlay:${createHash('sha256').update(JSON.stringify([profile.id, placedAt, requested, stake])).digest('hex')}`;
    const existing = this.store.getParlays({ profileId: profile.id }).find(parlay => parlay.idempotencyKey === key);
    if (existing) {
      const sameLegs = existing.legs.length === requested.length && requested.every((leg, index) =>
        ['matchId', 'market', 'selection'].every(field => existing.legs[index][field] === leg[field]));
      if (existing.stake !== stake || !sameLegs) return { ok: false, code: 'conflicto_idempotencia' };
      if (existing.status === 'pending' || this.ticketPlacements.has(`parlay:${existing.id}`)) return { ok: false, code: 'persistencia_pendiente' };
      if (existing.status === 'void' && (!existing.debited || /colocaci[oó]n/i.test(existing.payoutReason || ''))) {
        return { ok: false, code: 'boleto_anulado' };
      }
      try {
        if (existing.escrowProtocol === 'durable-1' && !(await this.store.saveStrict())) return { ok: false, code: 'persistencia_pendiente' };
      } catch (_) { return { ok: false, code: 'persistencia_pendiente' }; }
      return { ok: true, parlay: existing, replayed: true };
    }

    const resolvedLegs = [], pricedMatches = [];
    let combinedOdds = 1;
    for (const leg of legs) {
      const match = this.store.getMatch(leg.matchId);
      if (!match) return { ok: false, code: 'no_match' };
      if (this.officialV2 && match.status === 'scheduled') {
        const ready = await this.officialV2.prepareMatch(match, this.now());
        if (!ready.ok && !ready.legacy) return { ok: false, code: ready.reason || 'persistencia_pendiente' };
      }
      const window = this._bettingWindow(match, false);
      if (!window.ok) return { ok: false, code: window.code };
      if (this.now() >= match.scheduledKickoffAt || this.isClosed(match.id, leg.market) || this.isSuspended(match.id, leg.market)) {
        return { ok: false, code: 'mercado_cerrado' };
      }
      if (pricedMatches.length && pricedMatches[0].match.seasonMonth !== match.seasonMonth) return { ok: false, code: 'temporadas_distintas' };
      const mkt = this.getMarket(match, leg.market, {});
      if (!mkt) return { ok: false, code: 'market_unavailable' };
      const sel = mkt.selections.find(s => s.key === leg.selection);
      if (!sel) return { ok: false, code: 'selection_invalida' };
      pricedMatches.push({ match, simulation: match.simulation || null, market: leg.market, selection: leg.selection, odds: sel.price });
      if (this._marketTaken(profile.id, leg.matchId, leg.market)) return { ok: false, code: 'mercado_ya_apostado' };
      combinedOdds *= sel.price;
      const parsedLeg = parseMarket(leg.market);
      // Una línea de cuarto puede acabar en media victoria / media derrota y eso no
      // se puede multiplicar en una combinada sin un estado de pata parcial: la
      // regla del Estadio es que las líneas partidas se juegan a boleto simple.
      if (parsedLeg.type === 'asian_handicap' && O.asianLegs(parsedLeg.line).length > 1) {
        return { ok: false, code: 'linea_cuarto_no_combinable' };
      }
      const legCells = parsedLeg.type === 'correct_score'
        ? mkt.selections.map(item => item.key).filter(key => key !== 'other') : null;
      const legScorers = parsedLeg.type === 'first_scorer'
        ? mkt.selections.map(item => item.key).filter(key => key !== 'other' && key !== 'none') : null;
      resolvedLegs.push({
        matchId: leg.matchId, market: leg.market, selection: leg.selection,
        oddsAtPlacement: sel.price, status: 'open',
        ...(match.simulation ? { simulationId: commitmentId(match.simulation) } : {}),
        ...(legCells && legCells.length ? { correctScoreCells: legCells } : {}),
        ...(legScorers && legScorers.length ? { firstScorerIds: legScorers } : {})
      });
    }
    // Se paga el producto de las cuotas pactadas, sin redondear la cuota
    // intermedia: el potencial anunciado debe coincidir con la liquidación.
    const exactCombinedOdds = combinedOdds;
    combinedOdds = Number(combinedOdds.toFixed(2));
    // La columna PG es NUMERIC(8,2); no aceptar un boleto que no puede guardar.
    if (!Number.isFinite(combinedOdds) || combinedOdds > 999999.99) return { ok: false, code: 'cuota_combinada_excesiva' };
    const v = this.validateStake(profile, stake);
    if (!v.ok) return { ok: false, code: v.code, ...v };
    const potentialPayout = Math.min(this.config.maxPayoutPerBet * legs.length, Math.floor(stake * exactCombinedOdds));
    const rate = this.rateLimiter.consume(`parlay:${profile.id}`);
    if (!rate.allowed) return { ok: false, code: 'rate_limit' };

    const parlay = {
      id: `pl_${randomUUID().replace(/-/g, '')}`, idempotencyKey: key,
      profileId: profile.id, seasonMonth: this.store.getMatch(legs[0].matchId).seasonMonth,
      legs: resolvedLegs, combinedOdds, stake, potentialPayout,
      status: 'pending', debited: false, escrowProtocol: 'durable-1', placedAt
    };
    const ins = this.store.insertParlay(parlay);
    if (!ins.ok) return { ok: false, code: `store_${ins.reason}` };
    const committed = await this._commitTicketStake('parlay', ins.parlay, profile, () => pricedMatches.every(item => {
      if ((item.match.simulation || null) !== item.simulation || !this._bettingWindow(item.match, false).ok
          || this.now() >= item.match.scheduledKickoffAt || this.isClosed(item.match.id, item.market)
          || this.isSuspended(item.match.id, item.market)) return false;
      const current = this.getMarket(item.match, item.market, {});
      return Boolean(current && current.selections.find(selection => selection.key === item.selection)?.price === item.odds);
    }));
    if (!committed.ok) return committed;
    this.log('football_parlay_placed', { parlayId: parlay.id, legs: legs.length, stake, combinedOdds });
    return { ok: true, parlay: this.store.getParlay(parlay.id) };
  }

  settleParlayLeg(parlayId, matchId, result, cells = [], voidReason = '', meta = null) {
    const parlay = this.store.getParlay(parlayId);
    if (!parlay || parlay.status !== 'open') return { ok: false };
    const leg = parlay.legs.find(l => l.matchId === matchId);
    const legCells = leg && Array.isArray(leg.correctScoreCells) && leg.correctScoreCells.length
      ? leg.correctScoreCells : cells;
    const resolution = result ? resolveSelection(leg?.market, leg?.selection, result, {
      correctScoreCells: legCells,
      halftime: meta ? meta.halftime : undefined,
      firstScorer: meta ? meta.firstScorer : undefined,
      firstScorerIds: leg && Array.isArray(leg.firstScorerIds) && leg.firstScorerIds.length ? leg.firstScorerIds : null,
      cards: meta ? meta.cards : undefined
    }) : 'void';
    this.store.settleParlayLeg(parlayId, matchId, resolution);
    return this._evaluateParlay(parlayId, voidReason);
  }

  _evaluateParlay(parlayId, voidReason = '') {
    const p = this.store.getParlay(parlayId);
    if (!p || p.status !== 'open') return { ok: true, alreadySettled: true };
    const legs = p.legs;
    if (legs.some(l => l.status === 'lost')) return this._payParlay(p, 'lost', 0);
    if (legs.every(l => l.status === 'void')) return this._payParlay(p, 'void', p.stake, voidReason || 'todas las patas anuladas');
    if (legs.every(l => l.status === 'won' || l.status === 'void')) {
      const effOdds = legs.reduce((acc, l) => acc * (l.status === 'void' ? 1 : l.oddsAtPlacement), 1);
      return this._payParlay(p, 'won', Math.min(this.config.maxPayoutPerBet * legs.length, Math.floor(p.stake * effOdds)));
    }
    return { ok: true, pending: true }; // aún hay patas por resolver
  }

  _payParlay(p, status, payout, reason = '') {
    const out = this.store.settleParlay(p.id, { status, payout, reason });
    if (!out.ok) return { ok: false, reason: out.reason };
    if (out.alreadySettled) return { ok: true, alreadySettled: true };
    const applied = this._applyTicketPayout('parlay', out.parlay);
    this.log('football_parlay_settled', { parlayId: p.id, status, payout });
    if (applied && typeof applied.then === 'function') return { ok: true, pending: true, payout, status, completion: applied };
    return applied.ok ? { ok: true, payout, status } : applied;
  }

  // Captura compromisos ya existentes sin exponer semillas. Si un partido se
  // prepara después, una apuesta de temporada anterior impide sustituirlo.
  _seasonSimulationCommitments(seasonMonth) {
    const records = [];
    for (const match of this.store.getMatches(seasonMonth)) {
      if (!match.simulation) continue;
      if (match.simulationUnconfirmed || !verifyCommitment(match.simulation, match)) return null;
      const id = commitmentId(match.simulation);
      if (!id) return null;
      records.push({ matchId: match.id, id });
    }
    return records;
  }

  _seasonPolicyId(seasonMonth) {
    const league = this.store.getLeague(seasonMonth);
    if (!league?.simulationPolicy) return null;
    if (league.simulationPolicyUnconfirmed || !verifyPolicy(league.simulationPolicy, seasonMonth)) return false;
    if (this.officialV2 && (this.store.getMatches(seasonMonth) || []).some(match => match.status === 'scheduled'
        && !match.simulation && this.officialV2.requiresLegacy(match))) return false;
    return league.simulationPolicy.id;
  }

  // --- Mercado del Balón de Oro (§Fase 4) ---

  placeBallonDorBet(args = {}) {
    const profileId = args.profile && args.profile.id;
    const requestKey = args.idempotencyKey;
    if (!profileId || typeof requestKey !== 'string') return this._placeBallonDorBet(args);
    const season = monthKey(args.placedAt || this.now(), CASINO_TIME_ZONE);
    const inFlightKey = `${profileId}:${season}:${requestKey}`;
    if (this.ballondorPlacements.has(inFlightKey)) return this.ballondorPlacements.get(inFlightKey);
    const pending = (async () => {
      if (this.officialV2) {
        const ready = await this.officialV2.ensureSeason(season, this.now());
        if (!ready.ok && !ready.legacy) return { ok: false, code: ready.reason || 'persistencia_pendiente' };
      }
      return withSeasonAdmission(this.store, season, () => this._placeBallonDorBet(args));
    })();
    this.ballondorPlacements.set(inFlightKey, pending);
    return pending.finally(() => this.ballondorPlacements.delete(inFlightKey));
  }

  async _replayOrResumeBallonDorBet(profile, prior, { selection, stake, idempotencyKey } = {}) {
    const sameRequest = prior.idempotencyKey === idempotencyKey
      && prior.selection === selection && prior.stake === stake;
    if (!sameRequest) return { ok: false, code: 'boleto_ya_colocado' };
    if (prior.status === 'open' && prior.debited) return { ok: true, future: prior, replayed: true };
    if (prior.status === 'pending' && prior.debited) {
      const debitOperationId = `football:bdo:stake:${prior.id}`;
      const profileHasDebit = profile.appliedChipOperations?.includes(debitOperationId)
        || profile.transactions?.some(item => item?.operationId === debitOperationId);
      if (!profileHasDebit) return { ok: false, code: 'persistencia_pendiente' };
      const persisted = await this._persistBallonDorProfile(profile);
      if (!persisted) return { ok: false, code: 'persistencia_pendiente' };
      const confirmed = this.store.confirmFuture(prior.id);
      if (!confirmed.ok && this.store.getFuture(prior.id)?.status !== 'open') {
        return { ok: false, code: 'persistencia_pendiente' };
      }
      if (typeof this.store.saveNow === 'function') await this.store.saveNow();
      return { ok: true, future: this.store.getFuture(prior.id), replayed: true };
    }
    return { ok: false, code: prior.status === 'void' ? 'boleto_anulado' : 'persistencia_pendiente' };
  }

  async _placeBallonDorBet({ profile, selection, stake, idempotencyKey, placedAt = this.now() } = {}) {
    stake = Math.floor(Number(stake) || 0);
    if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_.-]{8,128}$/.test(idempotencyKey)) {
      return { ok: false, code: 'idempotency_key_invalida' };
    }
    const v = this.validateStake(profile, stake);
    if (!v.ok) return { ok: false, code: v.code, ...v };

    const at = Math.floor(Number(placedAt) || this.now());
    const seasonMonth = monthKey(at, CASINO_TIME_ZONE);
    if (this.store.getCurrentSeasonMonth() !== seasonMonth
        || (this.profiles.seasons?.current && this.profiles.seasons.current !== seasonMonth)) {
      return { ok: false, code: 'temporada_no_actual' };
    }
    const prior = this.store.getFutures({ profileId: profile.id, seasonMonth })
      .find(future => future.market === BALLON_DOR_MARKET);
    if (prior) return this._replayOrResumeBallonDorBet(profile, prior, { selection, stake, idempotencyKey });

    const event = this.store.getBallonDor(seasonMonth);
    if (!event) return { ok: false, code: 'evento_no_disponible' };
    if (event.status !== 'active' || at >= ballonDorCloseDeadline(seasonMonth, CASINO_TIME_ZONE)) {
      return { ok: false, code: 'mercado_cerrado' };
    }
    const j20 = this.store.getMatches(seasonMonth).filter(match => !match.desempate && match.jornada === 20);
    if (j20.length === 8 && j20.every(match => match.status === 'settled')) {
      await this.store.transitionBallonDor(seasonMonth, 'locked', { at: Math.max(at, event.updatedAt) });
      return { ok: false, code: 'mercado_cerrado' };
    }
    if (!Array.isArray(event.candidates) || !event.candidates.some(candidate => candidate.id === selection)) {
      return { ok: false, code: 'seleccion_invalida' };
    }
    const quote = event.oddsSnapshot?.selections?.find(item => item.candidateId === selection);
    if (!quote || !Number.isFinite(quote.odds) || quote.odds < 1 || quote.odds > 51) {
      return { ok: false, code: 'cuota_no_disponible' };
    }

    const rate = this.rateLimiter.consume(`ballon-dor:${profile.id}`);
    if (!rate.allowed) return { ok: false, code: 'rate_limit', retryAfterMs: rate.retryAfterMs };
    const ceiling = Math.min(500000, BALLON_DOR_MAX_PAYOUT, this.config.maxPayoutPerBet);
    const potentialPayout = Math.min(ceiling, Math.floor(stake * quote.odds));
    const simulationCommitments = this._seasonSimulationCommitments(seasonMonth);
    const simulationPolicyId = this._seasonPolicyId(seasonMonth);
    if (!simulationCommitments || simulationPolicyId === false) return { ok: false, code: 'persistencia_pendiente' };
    const future = {
      id: `bdo_${randomUUID().replace(/-/g, '')}`,
      idempotencyKey,
      profileId: profile.id,
      seasonMonth,
      market: BALLON_DOR_MARKET,
      selection,
      simulationCommitments,
      ...(simulationPolicyId ? { simulationPolicyId } : {}),
      odds: quote.odds, // snapshot del servidor; nunca se usa el dato del cliente
      stake,
      potentialPayout,
      status: 'pending',
      debited: false,
      payoutApplied: false,
      placedAtJornada: event.oddsSnapshot.afterJornada,
      placedAt: at
    };
    const inserted = await this.store.insertBallonDorFuture(future);
    if (!inserted.ok) {
      const existing = inserted.future || this.store.getFuture(future.id);
      if (existing && existing.market === BALLON_DOR_MARKET) {
        return this._replayOrResumeBallonDorBet(profile, existing, { selection, stake, idempotencyKey });
      }
      return { ok: false, code: `store_${inserted.reason || 'duplicada'}` };
    }

    const commitAt = Math.floor(Number(this.now()) || at);
    const currentEvent = this.store.getBallonDor(seasonMonth);
    const currentJ20 = this.store.getMatches(seasonMonth).filter(match => !match.desempate && match.jornada === 20);
    const j20Settled = currentJ20.length === 8 && currentJ20.every(match => match.status === 'settled');
    if (this.store.getCurrentSeasonMonth() !== seasonMonth || currentEvent?.status !== 'active'
        || commitAt >= ballonDorCloseDeadline(seasonMonth, CASINO_TIME_ZONE) || j20Settled) {
      this.store.voidFuture(future.id, { settledAt: commitAt, payout: 0 });
      await this.store.markFuturePayoutApplied(future.id);
      if (typeof this.store.saveNow === 'function') await this.store.saveNow();
      return { ok: false, code: 'mercado_cerrado' };
    }

    const debitOperationId = `football:bdo:stake:${future.id}`;
    const debitResult = debit(profile, stake, 'Predicción Balón de Oro', { operationId: debitOperationId });
    if (!debitResult.ok) {
      this.store.voidFuture(future.id, { settledAt: commitAt, payout: 0 });
      await this.store.markFuturePayoutApplied(future.id);
      if (typeof this.store.saveNow === 'function') await this.store.saveNow();
      return { ok: false, code: debitResult.error || 'debito_fallido' };
    }
    this.store.markFutureDebited(future.id);
    try {
      const persisted = await this._persistBallonDorProfile(profile);
      if (!persisted) throw new Error('el perfil no confirmó la escritura');
      this.store.confirmFuture(future.id);
      if (typeof this.store.saveNow === 'function') await this.store.saveNow();
    } catch (error) {
      // Dejarlo en pending + debited: reconcile lo reembolsa en el siguiente ciclo.
      this.log('football_ballon_dor_bet_persist_failed', { futureId: future.id, error: error.message });
      return { ok: false, code: 'persistencia_pendiente' };
    }
    this.log('football_ballon_dor_bet_placed', {
      futureId: future.id, seasonMonth, selection, stake, odds: quote.odds
    });
    return { ok: true, future: this.store.getFuture(future.id) };
  }

  async _persistBallonDorProfile(profile) {
    if (typeof this.profiles.persistProfile === 'function') {
      return (await this.profiles.persistProfile(profile)) === true;
    }
    if (typeof this.profiles.touch === 'function') this.profiles.touch(profile);
    if (typeof this.profiles.saveNow === 'function') {
      const result = await this.profiles.saveNow();
      return result !== false;
    }
    return true;
  }

  _applyBallonDorFuturePayout(future) {
    if (!future || future.payoutApplied) return Promise.resolve({ ok: true, alreadyApplied: true });
    const pending = this.ballondorPayouts.get(future.id);
    if (pending) return pending;
    const operation = this._applyBallonDorFuturePayoutOnce(future);
    this.ballondorPayouts.set(future.id, operation);
    return operation.finally(() => {
      if (this.ballondorPayouts.get(future.id) === operation) this.ballondorPayouts.delete(future.id);
    });
  }

  async _applyBallonDorFuturePayoutOnce(future) {
    if (!future || future.payoutApplied) return { ok: true, alreadyApplied: true };
    const casinoMonth = this.profiles.seasons?.current;
    const observedMonth = monthKey(this.now(), CASINO_TIME_ZONE);
    if (casinoMonth && casinoMonth <= future.seasonMonth && observedMonth > future.seasonMonth) {
      // No acreditar justo antes del reset: el saldo se reiniciaría y borraría el
      // premio. Queda como terminal no aplicado para recovery tras el reset.
      return { ok: false, reason: 'pendiente_reset_mensual' };
    }
    const profile = this.profiles.getProfile(future.profileId);
    if (!profile) return { ok: false, reason: 'perfil_no_disponible' };
    const operationId = `football:bdo:${future.id}`;
    const alreadyInProfile = profile.appliedChipOperations?.includes(operationId)
      || profile.transactions?.some(item => item?.operationId === operationId);
    let changed = false;
    if (!alreadyInProfile) {
      if (future.status === 'void') {
        if (future.payout > 0) {
          credit(profile, future.payout, 'Reembolso Balón de Oro', { operationId });
          changed = true;
        }
      } else if (future.status === 'won' || future.status === 'lost') {
        profile.chips += Math.max(0, Math.floor(Number(future.payout) || 0));
        recordOutcome(profile, {
          game: GAME,
          net: (Number(future.payout) || 0) - future.stake,
          eligible: false,
          operationId
        });
        changed = true;
      } else return { ok: false, reason: 'boleto_no_liquidado' };
    }
    // Si un intento previo mutó la copia en memoria pero no pudo confirmarla en
    // Postgres, repetir el UPSERT del perfil con el mismo operationId es seguro;
    // solo después se marca el boleto como aplicado.
    if ((changed || alreadyInProfile) && !(await this._persistBallonDorProfile(profile))) {
      return { ok: false, reason: 'perfil_no_persistido' };
    }
    await this.store.markFuturePayoutApplied(future.id);
    if (typeof this.store.saveNow === 'function') await this.store.saveNow();
    return { ok: true, payout: future.payout || 0 };
  }

  async settleBallonDorBets(seasonMonth, winnerCandidateId, at = this.now()) {
    let settled = 0;
    let paid = 0;
    const bets = this.store.getFutures({ seasonMonth, status: 'open' })
      .filter(future => future.market === BALLON_DOR_MARKET);
    for (const bet of bets) {
      const status = bet.selection === winnerCandidateId ? 'won' : 'lost';
      const payout = status === 'won'
        ? Math.min(500000, BALLON_DOR_MAX_PAYOUT, Math.floor(bet.stake * bet.odds)) : 0;
      const result = this.store.settleFuture(bet.id, { status, payout, settledAt: at });
      if (!result.ok) continue;
      const fresh = this.store.getFuture(bet.id);
      if (!result.alreadySettled) {
        if (typeof this.store.saveNow === 'function') await this.store.saveNow();
        settled++;
      }
      const applied = await this._applyBallonDorFuturePayout(fresh);
      if (applied.ok && !result.alreadySettled) paid += payout;
      this.log('football_ballon_dor_bet_settled', { futureId: bet.id, status, payout });
    }
    // Recupera una caída ocurrida después del estado terminal y antes de acreditar.
    const recovery = await this.reconcileBallonDorPayouts(seasonMonth);
    return { ok: true, settled, paid, recovered: recovery?.applied || 0 };
  }

  _ballonDorStakeWasDebited(future) {
    const profile = this.profiles.getProfile(future.profileId);
    if (!profile) return Boolean(future.debited);
    const operationId = `football:bdo:stake:${future.id}`;
    return Boolean(profile.appliedChipOperations?.includes(operationId)
      || profile.transactions?.some(item => item?.operationId === operationId));
  }

  async refundBallonDorBets(seasonMonth, reason = 'cancelación del ciclo', at = this.now()) {
    let refunded = 0;
    for (const bet of this.store.getFutures({ seasonMonth })) {
      if (bet.market !== BALLON_DOR_MARKET || !['pending', 'open', 'void'].includes(bet.status)) continue;
      if (bet.status === 'pending') {
        const debitWasApplied = this._ballonDorStakeWasDebited(bet);
        this.store.voidFuture(bet.id, { settledAt: at, payout: debitWasApplied ? bet.stake : 0 });
        if (!debitWasApplied) this.store.markFuturePayoutApplied(bet.id);
        if (typeof this.store.saveNow === 'function') await this.store.saveNow();
      } else if (bet.status === 'open') {
        this.store.voidFuture(bet.id, { settledAt: at, payout: bet.stake });
        if (typeof this.store.saveNow === 'function') await this.store.saveNow();
      }
      const fresh = this.store.getFuture(bet.id);
      if (fresh && fresh.status === 'void' && !fresh.payoutApplied) {
        const applied = await this._applyBallonDorFuturePayout(fresh);
        if (applied.ok) {
          refunded += fresh.payout || 0;
          if (!applied.alreadyApplied && fresh.payout > 0) {
            this.log('football_ballon_dor_bet_refunded', {
              futureId: bet.id, payout: fresh.payout, reason
            });
          }
        }
      }
    }
    return { ok: true, refunded };
  }

  async reconcileBallonDorPayouts(seasonMonth = null) {
    let applied = 0;
    const bets = this.store.getFutures(seasonMonth ? { seasonMonth } : {});
    const announcementBySeason = new Map();
    for (const bet of bets) {
      if (bet.market !== BALLON_DOR_MARKET || bet.payoutApplied
          || !['won', 'lost', 'void'].includes(bet.status)) continue;
      if (bet.status === 'won' || bet.status === 'lost') {
        let announcement = announcementBySeason.get(bet.seasonMonth);
        if (announcement === undefined) {
          const event = this.store.getBallonDor(bet.seasonMonth);
          const blocked = event?.status === 'settled';
          const at = blocked && isOfficialBallonDorResult(event)
            ? ballonDorResultAnnouncementAt(this.store, event, CASINO_TIME_ZONE) : null;
          announcement = { blocked, due: at != null && this.now() >= at };
          announcementBySeason.set(bet.seasonMonth, announcement);
        }
        if (announcement.blocked && !announcement.due) continue;
      }
      const result = await this._applyBallonDorFuturePayout(bet);
      if (result.ok) applied++;
    }
    return { ok: true, applied };
  }

  // --- Futuros (§11.5) ---

  async placeFuture(args = {}) {
    if (this.officialV2) {
      const ready = await this.officialV2.ensureSeason(args.seasonMonth, this.now());
      if (!ready.ok && !ready.legacy) return { ok: false, code: ready.reason || 'persistencia_pendiente' };
    }
    return withSeasonAdmission(this.store, args.seasonMonth, () => this._placeFuture(args));
  }

  async _placeFuture({ profile, seasonMonth, market, selection, stake, idempotencyKey = null, placedAt = this.now() }) {
    if (market === BALLON_DOR_MARKET) return { ok: false, code: 'usa_mercado_balon_de_oro' };
    stake = Math.floor(Number(stake) || 0);
    if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
    if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_.-]{8,128}$/.test(idempotencyKey))) {
      return { ok: false, code: 'idempotency_key_invalida' };
    }
    const key = idempotencyKey || `future:${createHash('sha256').update(JSON.stringify([profile.id, seasonMonth, market, selection, stake, placedAt])).digest('hex')}`;
    const existing = this.store.getFutures({ profileId: profile.id }).find(future => future.idempotencyKey === key);
    if (existing) {
      if (existing.seasonMonth !== seasonMonth || existing.market !== market || existing.selection !== selection
          || existing.stake !== stake) return { ok: false, code: 'conflicto_idempotencia' };
      if (existing.status === 'pending' || this.ticketPlacements.has(`future:${existing.id}`)) return { ok: false, code: 'persistencia_pendiente' };
      if (existing.status === 'void' && (!existing.debited || /colocaci[oó]n/i.test(existing.payoutReason || ''))) {
        return { ok: false, code: 'boleto_anulado' };
      }
      try {
        if (existing.escrowProtocol === 'durable-1' && !(await this.store.saveStrict())) return { ok: false, code: 'persistencia_pendiente' };
      } catch (_) { return { ok: false, code: 'persistencia_pendiente' }; }
      return { ok: true, future: existing, replayed: true };
    }
    const v = this.validateStake(profile, stake);
    if (!v.ok) return { ok: false, code: v.code, ...v };
    if (stake > FUTURE_MAX_STAKE) return { ok: false, code: 'stake_excede_tope', max: FUTURE_MAX_STAKE };
    if (this.store.getCurrentSeasonMonth() !== seasonMonth) return { ok: false, code: 'temporada_no_actual' };
    const snapshot = this.futureMarket.getMarket(seasonMonth);
    if (!snapshot) return { ok: false, code: 'cuota_no_disponible' };
    const quote = snapshot.markets?.[market]?.find(item => item.selection === selection);
    if (!quote || !Number.isFinite(quote.odds) || quote.odds < 1.01 || quote.odds > 51) {
      return { ok: false, code: 'seleccion_invalida' };
    }
    const odds = quote.odds;
    const simulationCommitments = this._seasonSimulationCommitments(seasonMonth);
    const simulationPolicyId = this._seasonPolicyId(seasonMonth);
    if (!simulationCommitments || simulationPolicyId === false) return { ok: false, code: 'persistencia_pendiente' };
    // Una sola apuesta abierta por (perfil, mercado, selección) — índice único en PG.
    const dup = this.store.getFutures({ profileId: profile.id, seasonMonth })
      .find(f => ['pending', 'open'].includes(f.status) && f.market === market && f.selection === selection);
    if (dup) return { ok: false, code: 'futuro_duplicado' };
    const rate = this.rateLimiter.consume(`future:${profile.id}`);
    if (!rate.allowed) return { ok: false, code: 'rate_limit' };

    const future = {
      id: `fu_${randomUUID().replace(/-/g, '')}`, idempotencyKey: key,
      profileId: profile.id, seasonMonth, market, selection, odds, stake, simulationCommitments,
      ...(simulationPolicyId ? { simulationPolicyId } : {}),
      potentialPayout: Math.min(this.config.maxPayoutPerBet, Math.floor(stake * odds)),
      status: 'pending', debited: false, escrowProtocol: 'durable-1', placedAtJornada: snapshot.afterJornada, placedAt
    };
    const ins = this.store.insertFuture(future);
    if (!ins.ok) return { ok: false, code: `store_${ins.reason}` };
    const committed = await this._commitTicketStake('future', ins.future, profile, () => {
      const latest = this.futureMarket.getMarket(seasonMonth);
      return this.store.getCurrentSeasonMonth() === seasonMonth && this.store.getLeague(seasonMonth)?.status === 'active'
        && latest?.sourceId === snapshot.sourceId
        && latest.markets?.[market]?.find(item => item.selection === selection)?.odds === odds;
    });
    if (!committed.ok) return committed;
    this.log('football_future_placed', { futureId: future.id, market, selection, stake, odds });
    return { ok: true, future: this.store.getFuture(future.id) };
  }

  // Al cerrar la temporada: resuelve campeón/top4/bota contra el resultado real.
  settleFutures(seasonMonth, { championTeamId = null, top4TeamIds = null, top2TeamIds = null,
    goldenBootPlayerId = null, goldenBootTeamId = null, voidSelections = {} } = {}) {
    let settled = 0, paid = 0;
    const positions = { top4: top4TeamIds && new Set(top4TeamIds), top2: top2TeamIds && new Set(top2TeamIds) };
    for (const f of this.store.getOpenFutures(seasonMonth)) {
      if (f.market === BALLON_DOR_MARKET) continue;
      let resolution;
      if (Array.isArray(voidSelections[f.market]) && voidSelections[f.market].includes(f.selection)) resolution = 'void';
      else if (f.market === 'champion') {
        if (!championTeamId) continue;
        resolution = f.selection === championTeamId ? 'won' : 'lost';
      } else if (f.market === 'top4' || f.market === 'top2') {
        if (!positions[f.market]) continue;
        resolution = positions[f.market].has(f.selection) ? 'won' : 'lost';
      } else if (f.market === 'golden_boot') {
        const winner = goldenBootPlayerId || goldenBootTeamId;
        if (!winner) continue;
        resolution = f.selection === winner ? 'won' : 'lost';
      } else resolution = 'void';
      const payout = resolution === 'won' ? Math.min(this.config.maxPayoutPerBet, Math.floor(f.stake * f.odds)) : resolution === 'void' ? f.stake : 0;
      const status = resolution === 'won' ? 'won' : resolution === 'void' ? 'void' : 'lost';
      const out = this.store.settleFuture(f.id, { status, payout, reason: 'futuro sin mercado' });
      if (!out.ok || out.alreadySettled) continue;
      if (f.escrowProtocol === 'durable-1') {
        this._applyTicketPayout('future', out.future);
      } else {
        // Boletos antiguos: conservan su comportamiento previo; nunca se
        // interpreta la falta de marca como un pago pendiente nuevo.
        const profile = this.profiles.getProfile(f.profileId);
        if (profile) {
          if (status === 'void') credit(profile, payout, 'Anulación: futuro sin mercado');
          else { profile.chips += payout; recordOutcome(profile, { game: GAME, net: payout - f.stake, eligible: false }); }
          this.profiles.touch(profile);
          if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
        }
      }
      settled++; paid += payout;
    }
    return { settled, paid };
  }

  // Temporada truncada (§11.5): anula y reembolsa todos los futuros abiertos.
  refundFutures(seasonMonth, reason = 'temporada truncada', { excludeMarkets = [] } = {}) {
    let refunded = 0;
    for (const f of this.store.getOpenFutures(seasonMonth)) {
      if (f.market === BALLON_DOR_MARKET || excludeMarkets.includes(f.market)) continue;
      const out = this.store.voidFuture(f.id, f.escrowProtocol === 'durable-1' ? { payout: f.stake, reason } : {});
      if (!out.ok || out.alreadyVoid) continue;
      if (f.escrowProtocol === 'durable-1') this._applyTicketPayout('future', out.future);
      else {
        const profile = this.profiles.getProfile(f.profileId);
        if (profile) { credit(profile, f.stake, `Anulación: ${reason}`); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); }
      }
      refunded++;
    }
    return { refunded };
  }

  // Resuelve los futuros completos o reembolsa los que quedaron sin resultado
  // al terminar el mes. Es idempotente y también se llama tras un reinicio.
  reconcileSeasonFutures(at = this.now()) {
    let settled = 0, refunded = 0;
    const current = monthKey(new Date(at), CASINO_TIME_ZONE);
    for (const seasonMonth of this.store.getSeasonMonths()) {
      const futures = this.store.getOpenFutures(seasonMonth).filter(future => future.market !== BALLON_DOR_MARKET);
      if (!futures.length) continue;
      const league = this.store.getLeague(seasonMonth);
      if (!league) continue;
      const result = seasonOutcome(league);
      if (result.complete && league.status !== 'truncated') settled += this.settleFutures(seasonMonth, result).settled;
      if ((current > seasonMonth || league.status === 'truncated')
          && this.store.getOpenFutures(seasonMonth).some(future => future.market !== BALLON_DOR_MARKET)) {
        // Un desempate oficial aún pendiente conserva el futuro de campeón,
        // incluso tras el cambio de mes; se liquida contra ese mismo partido.
        const excludeMarkets = result.championPending && league.status !== 'truncated' ? ['champion'] : [];
        refunded += this.refundFutures(seasonMonth, result.complete ? 'resultado de futuro no disponible' : 'temporada truncada', { excludeMarkets }).refunded;
      }
    }
    return { settled, refunded };
  }

  // --- Reconciliación de arranque (§15.6, T34) ---

  _cancelDurablePending(kind, ticket) {
    if (this.ticketPlacements.has(`${kind}:${ticket.id}`)) return false;
    const profile = this.profiles.getProfile(ticket.profileId);
    if (!profile) return false; // no inferir un débito si el perfil no está disponible
    const operationId = `football:${kind}:stake:${ticket.id}`;
    const debited = profile.footballPendingStakes?.includes(operationId)
      || profile.appliedChipOperations?.includes(operationId);
    const details = { payout: debited ? ticket.stake : 0, reason: 'colocación interrumpida' };
    const out = kind === 'bet' ? this.store.voidBet(ticket.id, details)
      : kind === 'parlay' ? this.store.voidParlay(ticket.id, details) : this.store.voidFuture(ticket.id, details);
    if (!out.ok) return false;
    const result = this._applyTicketPayout(kind, ticket);
    if (result && typeof result.then === 'function') result.catch(error => this.log('football_refund_recovery_error', { message: String(error?.message || error) }));
    return true;
  }

  // Anula las apuestas 'pending' huérfanas (el proceso murió a mitad del WAL).
  // Para el protocolo nuevo, la marca persistida en el perfil determina si el
  // débito realmente ocurrió; no basta con la marca `debited` del boleto.
  cancelPendingBets(options = {}) {
    const onlyDurable = Boolean(options?.onlyDurable);
    let cancelled = 0;
    for (const bet of this.store.getBets({ status: 'pending' })) {
      if (bet.escrowProtocol === 'durable-1') { if (this._cancelDurablePending('bet', bet)) cancelled++; continue; }
      if (onlyDurable) continue;
      this.store.voidBet(bet.id);
      if (bet.debited) {
        const profile = this.profiles.getProfile(bet.profileId);
        if (profile) { credit(profile, bet.stake, 'Anulación: colocación interrumpida'); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); }
      }
      cancelled++;
    }
    for (const p of this.store.getParlays({ status: 'pending' })) {
      if (p.escrowProtocol === 'durable-1') { if (this._cancelDurablePending('parlay', p)) cancelled++; continue; }
      if (onlyDurable) continue;
      this.store.voidParlay(p.id);
      if (p.debited) { const profile = this.profiles.getProfile(p.profileId); if (profile) { credit(profile, p.stake, 'Anulación: colocación interrumpida'); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); } }
      cancelled++;
    }
    for (const f of this.store.getFutures({ status: 'pending' })) {
      if (f.escrowProtocol === 'durable-1' && f.market !== BALLON_DOR_MARKET) {
        if (this._cancelDurablePending('future', f)) cancelled++;
        continue;
      }
      if (onlyDurable) continue;
      if (f.market === BALLON_DOR_MARKET) {
        const debitWasApplied = this._ballonDorStakeWasDebited(f);
        this.store.voidFuture(f.id, { settledAt: this.now(), payout: debitWasApplied ? f.stake : 0 });
        if (!debitWasApplied) this.store.markFuturePayoutApplied(f.id);
        else this._applyBallonDorFuturePayout(this.store.getFuture(f.id))
          .catch(error => this.log('football_ballon_dor_refund_failed', { futureId: f.id, error: error.message }));
      } else {
        this.store.voidFuture(f.id);
        if (f.debited) { const profile = this.profiles.getProfile(f.profileId); if (profile) { credit(profile, f.stake, 'Anulación: colocación interrumpida'); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); } }
      }
      cancelled++;
    }
    if (cancelled) this.log('football_pending_cancelled', { count: cancelled });
    return cancelled;
  }

  // Fuerza la liquidación de apuestas 'open' cuyo partido ya terminó (§12.5) y
  // devuelve el número de descuadres de escrow detectados.
  reconcileEscrow() {
    let forced = 0, mismatch = 0;
    this.cancelPendingBets({ onlyDurable: true });
    // Las filas terminales antiguas no tenían esta marca y se consideran ya
    // pagadas. Solo se recuperan liquidaciones nuevas explícitamente pendientes.
    for (const bet of this.store.getBets({})) {
      if (bet.payoutApplied !== false || !HISTORY_TERMINAL.includes(bet.status)) continue;
      const result = this._applyTicketPayout('bet', bet);
      if (result && typeof result.then === 'function') result.catch(error => this.log('football_payout_recovery_error', { message: String(error?.message || error) }));
    }
    for (const parlay of this.store.getParlays({})) {
      if (parlay.payoutApplied !== false || !HISTORY_TERMINAL.includes(parlay.status)) continue;
      const result = this._applyTicketPayout('parlay', parlay);
      if (result && typeof result.then === 'function') result.catch(error => this.log('football_payout_recovery_error', { message: String(error?.message || error) }));
    }
    for (const future of this.store.getFutures({})) {
      if (future.escrowProtocol !== 'durable-1' || future.market === BALLON_DOR_MARKET
          || future.payoutApplied !== false || !HISTORY_TERMINAL.includes(future.status)) continue;
      const result = this._applyTicketPayout('future', future);
      if (result && typeof result.then === 'function') result.catch(error => this.log('football_payout_recovery_error', { message: String(error?.message || error) }));
    }
    // Apuestas simples abiertas cuyo partido ya terminó o se pospuso.
    for (const bet of this.store.getBets({ status: 'open' })) {
      const match = this._matchOf(bet.matchId);
      if (!match) { this._payoutBet(bet, 'void', 'partido inexistente'); forced++; mismatch++; continue; }
      if ((match.status === 'settled' || match.status === 'finished') && match.result) {
        const resolution = resolveSelection(bet.market, bet.selection, match.result,
          this._contextForBet(bet, match, this._settlementMeta(match)));
        this._payoutBet(bet, resolution); forced++;
      } else if (match.status === 'postponed') {
        this._payoutBet(bet, 'void', 'partido pospuesto'); forced++;
      }
    }
    // Combinadas abiertas: liquida cada pata cuyo partido ya terminó o se
    // pospuso y evalúa la combinada (paga o reembolsa) en cuanto todas sus
    // patas estén resueltas. Cubre el caso en que el servidor estuvo caído
    // cuando se jugaron los partidos o el jugador no estaba presente.
    for (const parlay of this.store.getParlays({ status: 'open' })) {
      for (const leg of parlay.legs) {
        if (leg.status !== 'open') continue;
        const match = this._matchOf(leg.matchId);
        if (!match) {
          this.settleParlayLeg(parlay.id, leg.matchId, null, [], 'partido inexistente');
          forced++;
          continue;
        }
        if ((match.status === 'settled' || match.status === 'finished') && match.result) {
          const cells = this._correctScoreCells(match);
          this.settleParlayLeg(parlay.id, leg.matchId, match.result, cells, '', this._settlementMeta(match));
          forced++;
        } else if (match.status === 'postponed') {
          this.settleParlayLeg(parlay.id, leg.matchId, null, [], 'partido pospuesto');
          forced++;
        }
      }
    }
    if (forced) this.log('football_escrow_reconcile', { forced, mismatch });
    if (typeof this.store.getSeasonMonths === 'function') this.reconcileSeasonFutures(this.now());
    return mismatch;
  }

  // --- Hooks de consulta para el motor (§15.8, A7) ---

  hasOpenBets(seasonMonth) {
    if (this.store.hasOpenBets(seasonMonth ? { seasonMonth } : {})) return true;
    // No permitir el reset del saldo antes de aplicar una liquidación pendiente.
    const pendingBet = this.store.getBets({}).some(bet => bet.payoutApplied === false
      && HISTORY_TERMINAL.includes(bet.status)
      && (!seasonMonth || this.store.getMatch(bet.matchId)?.seasonMonth === seasonMonth));
    const pendingParlay = this.store.getParlays({}).some(parlay => (!seasonMonth || parlay.seasonMonth === seasonMonth)
      && (['pending', 'open'].includes(parlay.status) || (parlay.payoutApplied === false && HISTORY_TERMINAL.includes(parlay.status))));
    const pendingFuture = this.store.getFutures({ seasonMonth: seasonMonth || null }).some(future => future.market !== BALLON_DOR_MARKET
      && (['pending', 'open'].includes(future.status) || (future.escrowProtocol === 'durable-1'
        && future.payoutApplied === false && HISTORY_TERMINAL.includes(future.status))));
    return pendingBet || pendingParlay || pendingFuture;
  }
  countOpenBets() {
    return this.store.getBets({}).filter(bet => ['open', 'pending'].includes(bet.status) || bet.payoutApplied === false).length
      + this.store.getParlays({}).filter(parlay => ['open', 'pending'].includes(parlay.status) || parlay.payoutApplied === false).length
      + this.store.getFutures({}).filter(future => ['open', 'pending'].includes(future.status)
        || (future.escrowProtocol === 'durable-1' && future.payoutApplied === false)).length;
  }
  countEscrow() {
    let total = 0;
    for (const bet of this.store.getBets({ status: 'open' })) total += bet.stake;
    for (const p of this.store.getParlays({ status: 'open' })) total += p.stake;
    for (const f of this.store.getFutures({ status: 'open' })) total += f.stake;
    return total;
  }

  // Panel «Mis apuestas» (§12.1): stakes, cuotas y pagos potenciales del perfil.
  // Solo apuestas ABIERTAS: es lo que la mesa necesita para bloquear mercados.
  getBetsForProfile(profileId) {
    return {
      bets: this.store.getBets({ profileId, status: 'open' }),
      parlays: this.store.getParlays({ profileId, status: 'open' }),
      futures: this.store.getFutures({ profileId, status: 'open' })
    };
  }

  // Contexto público del partido al que pertenece una apuesta. Se congela en el
  // historial porque el jugador puede volver cuando el partido ya terminó (o
  // incluso cuando la jornada ya se cerró): necesita ver contra quién jugaba,
  // cuándo y cómo quedó para entender su pago.
  _historyMatch(matchId) {
    const match = this.store.getMatch(matchId);
    if (!match) return null;
    const finished = match.status === 'settled' || match.status === 'finished';
    return {
      id: match.id,
      homeId: match.homeId,
      awayId: match.awayId,
      jornada: match.jornada,
      seasonMonth: match.seasonMonth,
      kickoffAt: match.actualKickoffAt || match.scheduledKickoffAt || null,
      status: match.status,
      result: finished && match.result
        ? { home: match.result.home, away: match.result.away }
        : null
    };
  }

  // Historial completo + pagos (§12.1 ampliado, §34).
  //
  // Motivo del método: la liquidación es AUTOMÁTICA y ocurre en el servidor aunque
  // el jugador esté desconectado, así que las fichas ya están en su perfil cuando
  // vuelve. Lo que faltaba era poder verlo. Este registro une apuestas simples,
  // combinadas y futuros en una sola línea de tiempo, con el desenlace de cada
  // partido y el pago acreditado, y resume lo apostado/devuelto/neto.
  //
  // `since` (ms) activa el bloque `unseen`: lo liquidado DESPUÉS de ese instante,
  // que es exactamente lo que el jugador no pudo ver en vivo. La marca de «visto»
  // vive en el cliente (localStorage por perfil), no en el servidor: una lectura
  // GET no debe escribir estado.
  getBetHistory(profileId, { limit = 40, since = 0 } = {}) {
    const cap = Math.max(1, Math.min(HISTORY_LIMIT_MAX, Math.floor(Number(limit)) || 40));
    const sinceMs = Number.isFinite(Number(since)) && Number(since) > 0 ? Math.floor(Number(since)) : 0;
    if (!profileId) {
      return { entries: [], summary: emptyHistorySummary(), unseen: null, serverNow: this.now() };
    }

    const entries = [];
    for (const bet of this.store.getBets({ profileId })) {
      entries.push({
        kind: 'bet', id: bet.id, matchId: bet.matchId,
        market: bet.market, selection: bet.selection,
        stake: bet.stake, odds: bet.oddsAtPlacement, potentialPayout: bet.potentialPayout,
        status: bet.status, payout: bet.payout == null ? null : bet.payout,
        inPlay: Boolean(bet.inPlay), minuteAtPlacement: bet.minuteAtPlacement,
        placedAt: bet.placedAt || 0, settledAt: bet.settledAt == null ? null : bet.settledAt,
        legs: null, match: this._historyMatch(bet.matchId)
      });
    }
    for (const parlay of this.store.getParlays({ profileId })) {
      entries.push({
        kind: 'parlay', id: parlay.id, matchId: (parlay.legs[0] || {}).matchId || null,
        market: null, selection: null,
        stake: parlay.stake, odds: parlay.combinedOdds, potentialPayout: parlay.potentialPayout,
        status: parlay.status, payout: parlay.payout == null ? null : parlay.payout,
        inPlay: false, minuteAtPlacement: null,
        placedAt: parlay.placedAt || 0, settledAt: parlay.settledAt == null ? null : parlay.settledAt,
        legs: parlay.legs.map(leg => ({
          matchId: leg.matchId, market: leg.market, selection: leg.selection,
          odds: leg.oddsAtPlacement, status: leg.status, match: this._historyMatch(leg.matchId)
        })),
        match: this._historyMatch((parlay.legs[0] || {}).matchId)
      });
    }
    for (const future of this.store.getFutures({ profileId })) {
      let visibleStatus = future.status;
      let visiblePayout = future.payout == null ? null : future.payout;
      let visibleSettledAt = future.settledAt == null ? null : future.settledAt;
      if (future.market === BALLON_DOR_MARKET && ['won', 'lost'].includes(future.status)) {
        const event = this.store.getBallonDor(future.seasonMonth);
        if (event?.status === 'settled') {
          const announcedAt = isOfficialBallonDorResult(event)
            ? ballonDorResultAnnouncementAt(this.store, event, CASINO_TIME_ZONE) : null;
          if (announcedAt == null || this.now() < announcedAt) {
            visibleStatus = 'open';
            visiblePayout = null;
            visibleSettledAt = null;
          }
        }
      }
      entries.push({
        kind: 'future', id: future.id, matchId: null,
        market: future.market, selection: future.selection,
        seasonMonth: future.seasonMonth,
        stake: future.stake, odds: future.odds, potentialPayout: future.potentialPayout,
        status: visibleStatus, payout: visiblePayout,
        inPlay: false, minuteAtPlacement: null,
        placedAt: future.placedAt || 0, settledAt: visibleSettledAt,
        legs: null, match: null
      });
    }

    // Lo más reciente primero: es el orden en el que el jugador quiere leer
    // «qué pasó mientras no estaba». `settledAt` manda en lo ya resuelto.
    entries.sort((a, b) => (b.settledAt || b.placedAt || 0) - (a.settledAt || a.placedAt || 0) || String(b.id).localeCompare(String(a.id)));

    const summary = emptyHistorySummary();
    let latestSettlement = 0;
    for (const entry of entries) {
      const terminal = HISTORY_TERMINAL.includes(entry.status);
      summary.total += 1;
      summary.byStatus[entry.status] = (summary.byStatus[entry.status] || 0) + 1;
      if (entry.status === 'open' || entry.status === 'pending') {
        summary.open += 1;
        summary.openStake += entry.stake;
        summary.openPotentialPayout += entry.potentialPayout || 0;
        continue;
      }
      if (!terminal) continue;
      summary.staked += entry.stake;
      summary.returned += entry.payout || 0;
      if (entry.settledAt) latestSettlement = Math.max(latestSettlement, entry.settledAt);
    }
    summary.net = summary.returned - summary.staked;
    summary.latestSettlementAt = latestSettlement || null;

    // `unseen`: liquidaciones posteriores a la última visita del jugador.
    let unseen = null;
    if (sinceMs > 0) {
      const fresh = entries.filter(e => HISTORY_TERMINAL.includes(e.status) && (e.settledAt || 0) > sinceMs);
      if (fresh.length) {
        unseen = {
          count: fresh.length,
          credited: fresh.reduce((sum, e) => sum + (e.payout || 0), 0),
          staked: fresh.reduce((sum, e) => sum + e.stake, 0),
          net: fresh.reduce((sum, e) => sum + (e.payout || 0) - e.stake, 0),
          throughAt: fresh.reduce((max, e) => Math.max(max, e.settledAt || 0), 0),
          items: fresh.slice(0, 5)
        };
      }
    }

    return {
      entries: entries.slice(0, cap),
      summary,
      unseen,
      // Total sin truncar, para que el cliente sepa que hay más historial.
      totalEntries: entries.length,
      serverNow: this.now()
    };
  }
}

function createBettingService(deps) {
  return new BettingService(deps);
}

module.exports = {
  BettingService, createBettingService, resolveSelection, parseMarket, LIMITS, GAME, LIVE_STATUSES
};
