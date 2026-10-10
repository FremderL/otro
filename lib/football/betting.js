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

const { expectedGoals, outcome, INITIAL_LEAGUE_AVG, INITIAL_HOME_ADV } = require('./ratings');
const { scoreMatrix, RHO } = require('./match-engine');
const O = require('./odds');
const { debit, credit, recordOutcome } = require('../progression');
const { hash32 } = require('./prng');
const { FixedWindowRateLimiter } = require('../rate-limit');
const { combine: combineFlow } = require('./simulated-flow');

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
  if ((g = m.match(/^team_total_(home|away)_(\d+(?:\.\d+)?)$/))) return { type: 'team_total', team: g[1], line: Number(g[2]) };
  if ((g = m.match(/^win_to_nil_(home|away)$/))) return { type: 'win_to_nil', team: g[1] };
  return { type: 'unknown' };
}

// Devuelve 'won' | 'lost' | 'void'. `ctx.correctScoreCells` (las 12 celdas
// ofrecidas) permite resolver la selección 'other' del marcador exacto.
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
    default:
      return 'void';
  }
}

// --- Servicio de apuestas ---

class BettingService {
  constructor({ store, profiles, idempotency = null, simulatedFlow = null, config = {}, log = () => {}, now = () => Date.now() }) {
    if (!store) throw new Error('BettingService requiere el store de fútbol');
    if (!profiles) throw new Error('BettingService requiere el store de perfiles');
    this.store = store;
    this.profiles = profiles;
    this.idempotency = idempotency;
    this.simulatedFlow = simulatedFlow; // §11.6: mueve cuotas, nunca cuenta para exposición
    this.config = { ...LIMITS, ...config };
    this.log = log;
    this.now = now;
    this.rateLimiter = new FixedWindowRateLimiter({ limit: this.config.rateLimit, windowMs: this.config.rateWindowMs, now });
    this.suspended = new Map();  // matchId → Map(marketKey → untilMs)
    this.closed = new Map();     // matchId → Set(marketKey) cerrados definitivamente
  }

  // --- Contexto y precios de un partido ---

  getMatchContext(match) {
    if (!match) return null;
    const league = this.store.getLeague(match.seasonMonth);
    if (!league) return null;
    const homeClub = league.config.find(c => c.id === match.homeId);
    const awayClub = league.config.find(c => c.id === match.awayId);
    if (!homeClub || !awayClub) return null;
    const ctx = league.ctx || { leagueAvg: INITIAL_LEAGUE_AVG, homeAdv: INITIAL_HOME_ADV };
    const lambdas = expectedGoals(homeClub.ratings, awayClub.ratings, ctx);
    const matrix = scoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, RHO);
    return { league, homeClub, awayClub, ctx, lambdas, matrix };
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

  // Precios vigentes de un mercado: modelo + peso del dinero. En vivo recalcula
  // desde el estado revelado (§10.5). Devuelve null si el mercado no aplica.
  getMarket(match, marketKey, state = {}) {
    const mc = this.getMatchContext(match);
    if (!mc) return null;
    const inPlay = state.minute != null && state.score != null;
    let published;
    if (inPlay) {
      if (marketKey !== '1x2') return null; // §11.2: el resto de mercados en vivo, en una iteración posterior
      published = O.publishLive(mc.lambdas, {
        minute: state.minute, score: state.score, matchEnd: state.matchEnd || 90,
        redCards: state.redCards
      });
    } else {
      published = O.buildPreMatchMarkets(mc.matrix)[marketKey];
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
      selections = published.selections.map(s => ({
        ...s, price: moved.prices[s.key], implied: Number(O.impliedProb(moved.prices[s.key]).toFixed(4))
      }));
    }
    return {
      marketKey, inPlay, selections,
      suspended: Boolean(state.playStopped) || this.isSuspended(match.id, marketKey),
      closed: this.isClosed(match.id, marketKey)
    };
  }

  // Celdas de marcador exacto ofrecidas (para resolver 'other' al liquidar).
  _correctScoreCells(match) {
    const mc = this.getMatchContext(match);
    if (!mc) return [];
    return Object.keys(O.probCorrectScore(mc.matrix, 12)).filter(k => k !== 'other');
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
    if (LIVE_STATUSES.includes(match.status)) return inPlay ? { ok: true, inPlay: true } : { ok: true, inPlay: false };
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

  async placeBet({ profile, deviceToken = null, matchId, market, selection, stake, state = {}, placedAt = this.now(), idempotencyKey = null }) {
    stake = Math.floor(Number(stake) || 0);
    if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
    const match = this.store.getMatch(matchId);
    if (!match) return { ok: false, code: 'no_match' };

    const inPlay = state.minute != null && state.score != null;
    const window = this._bettingWindow(match, inPlay);
    if (!window.ok) return { ok: false, code: window.code };
    if (inPlay && state.playStopped) return { ok: false, code: 'market_suspended' };
    if (this.isClosed(matchId, market)) return { ok: false, code: 'selection_closed' };
    if (this.isSuspended(matchId, market)) return { ok: false, code: 'market_suspended' };

    const mkt = this.getMarket(match, market, state);
    if (!mkt) return { ok: false, code: 'market_unavailable' };
    const sel = mkt.selections.find(s => s.key === selection);
    if (!sel) return { ok: false, code: 'selection_invalida' };
    const odds = sel.price;

    // Una sola selección por categoría: si ya hay una apuesta en este mercado, solo
    // se acepta el reintento idempotente de ESA misma apuesta (doble clic / red).
    const key = idempotencyKey || this._idempotencyKey(deviceToken, profile.id, placedAt, matchId, market, selection, stake);
    const taken = this._marketTaken(profile.id, matchId, market);
    if (taken) {
      const same = taken.kind === 'bet' ? this.store.getBet(taken.id) : null;
      if (same && same.idempotencyKey === key) return { ok: true, bet: same, replayed: true };
      return { ok: false, code: 'mercado_ya_apostado' };
    }

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
        const existing = this._findByIdempotencyKey(key);
        return { ok: true, bet: existing, replayed: true };
      }
      if (claim.state === 'processing') return { ok: false, code: 'en_proceso' };
      if (claim.state === 'conflict') return { ok: false, code: 'conflicto_idempotencia' };
    } else {
      const existing = this._findByIdempotencyKey(key);
      if (existing) return { ok: true, bet: existing, replayed: true };
    }

    const bet = {
      id: `b_${hash32(key).toString(36)}_${placedAt.toString(36)}`,
      idempotencyKey: key, profileId: profile.id, deviceToken: null,
      matchId, market, selection, stake, oddsAtPlacement: odds,
      inPlay: Boolean(inPlay), minuteAtPlacement: inPlay ? state.minute : null,
      status: 'pending', debited: false, placedAt,
      potentialPayout: Math.min(this.config.maxPayoutPerBet, Math.floor(stake * odds)),
      cashoutAvailable: true, parlayId: null
    };

    // Re-chequeo síncrono (sin await desde aquí hasta insertBet): cierra la carrera
    // entre dos apuestas simultáneas del mismo perfil en el mismo mercado.
    if (this._marketTaken(profile.id, matchId, market)) return { ok: false, code: 'mercado_ya_apostado' };

    // WAL: la intención (pending) es duradera ANTES de mover una sola ficha.
    const ins = this.store.insertBet(bet);
    if (!ins.ok) return { ok: false, code: `store_${ins.reason}` };

    // Sección crítica síncrona: comprobar saldo y debitar SIN await entre medio
    // cierra el TOCTOU (dos apuestas simultáneas no pueden superar el saldo).
    if (stake > profile.chips) { this.store.voidBet(bet.id); return { ok: false, code: 'insufficient_chips' }; }
    const d = debit(profile, stake, 'Apuesta Estadio');
    if (!d.ok) { this.store.voidBet(bet.id); return { ok: false, code: d.error || 'debito_fallido' }; }

    // El débito sale del perfil y se hace DURADERO antes de confirmar la apuesta:
    // así nunca existe una apuesta 'open' cuyo stake no esté descontado (T34).
    this.store.markBetDebited(bet.id);
    this.profiles.touch(profile);
    if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
    this.store.confirmBet(bet.id);

    if (this.idempotency) {
      try { await this.idempotency.complete({ actorId: profile.id, key, statusCode: 200, responseBody: { betId: bet.id } }); }
      catch (error) { this.log('football_idempotency_complete_error', { message: String(error && error.message || error) }); }
    }
    this.log('football_bet_placed', { betId: bet.id, matchId, market, selection, stake, odds, inPlay: bet.inPlay });
    return { ok: true, bet: this.store.getBet(bet.id) };
  }

  _findByIdempotencyKey(key) {
    for (const bet of this.store.bets.values()) if (bet.idempotencyKey === key) return bet;
    return null;
  }

  // --- Liquidación exactamente una vez (§12.3, A9) ---

  // Paga una apuesta contra el perfil. `resolution` es 'won'|'lost'|'void'.
  _payoutBet(bet, resolution, reason = '') {
    const payout = resolution === 'won' ? Math.min(this.config.maxPayoutPerBet, Math.floor(bet.stake * bet.oddsAtPlacement))
      : resolution === 'void' ? bet.stake : 0;
    const status = resolution === 'won' ? 'won' : resolution === 'void' ? 'void' : 'lost';
    const out = this.store.settleBet(bet.id, { status, payout });
    if (!out.ok) return { ok: false, reason: out.reason };
    if (out.alreadySettled) return { ok: true, alreadySettled: true, payout: 0 };

    const profile = this.profiles.getProfile(bet.profileId);
    if (profile) {
      if (status === 'void') {
        // Reembolso (§12.4): credit escribe UNA transacción con motivo legible.
        credit(profile, payout, `Anulación: ${reason || 'apuesta anulada'}`);
      } else {
        // Ganada/perdida: chips en crudo + recordOutcome(net). Nunca credit(payout)
        // junto a recordOutcome: duplicaría el historial (§12.7, hallazgo 8 / T35).
        profile.chips += payout;
        recordOutcome(profile, { game: GAME, net: payout - bet.stake, eligible: false });
      }
      this.profiles.touch(profile);
      if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
    }
    this.log('football_bet_settled', { betId: bet.id, status, payout, stake: bet.stake });
    return { ok: true, payout, status };
  }

  // Hook del motor (§15): paga todas las apuestas de un partido al terminar.
  settleMatchBets(match, score) {
    if (!match || !score) return { settled: 0, paid: 0 };
    const result = { home: score.home, away: score.away, winner: outcome(score.home, score.away) };
    const cells = this._correctScoreCells(match);
    let settled = 0, paid = 0;
    for (const bet of this.store.getOpenBetsForMatch(match.id)) {
      const resolution = resolveSelection(bet.market, bet.selection, result, { correctScoreCells: cells });
      const out = this._payoutBet(bet, resolution);
      if (out.ok && !out.alreadySettled) { settled++; paid += out.payout; }
    }
    for (const parlay of this.store.getOpenParlaysForMatch(match.id)) {
      this.settleParlayLeg(parlay.id, match.id, result, cells);
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
    if (bet.status !== 'open') return { ok: false, code: 'not_open' };
    const match = this.store.getMatch(bet.matchId);
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
    const value = O.cashoutValue(bet.stake, bet.oddsAtPlacement, sel.prob);
    const out = this.store.settleBet(betId, { status: 'cashed', payout: value });
    if (!out.ok) return { ok: false, code: out.reason };
    if (out.alreadySettled) return { ok: false, code: 'already_settled' };
    profile.chips += value;
    recordOutcome(profile, { game: GAME, net: value - bet.stake, eligible: false });
    this.profiles.touch(profile);
    if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
    this.log('football_cashout', { betId, value, stake: bet.stake });
    return { ok: true, cashout: value };
  }

  // --- Combinadas (§11.4) ---

  async placeParlay({ profile, legs, stake, placedAt = this.now() }) {
    stake = Math.floor(Number(stake) || 0);
    if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
    if (!Array.isArray(legs) || legs.length < 2) return { ok: false, code: 'piernas_insuficientes' };
    if (legs.length > this.config.maxParlayLegs) return { ok: false, code: 'max_piernas' };
    const matchIds = new Set(legs.map(l => l.matchId));
    if (matchIds.size !== legs.length) return { ok: false, code: 'partidos_duplicados' };

    const resolvedLegs = [];
    let combinedOdds = 1;
    for (const leg of legs) {
      const match = this.store.getMatch(leg.matchId);
      if (!match) return { ok: false, code: 'no_match' };
      const window = this._bettingWindow(match, false);
      if (!window.ok) return { ok: false, code: window.code };
      const mkt = this.getMarket(match, leg.market, {});
      if (!mkt) return { ok: false, code: 'market_unavailable' };
      const sel = mkt.selections.find(s => s.key === leg.selection);
      if (!sel) return { ok: false, code: 'selection_invalida' };
      if (this._marketTaken(profile.id, leg.matchId, leg.market)) return { ok: false, code: 'mercado_ya_apostado' };
      combinedOdds *= sel.price;
      resolvedLegs.push({ matchId: leg.matchId, market: leg.market, selection: leg.selection, oddsAtPlacement: sel.price, status: 'open' });
    }
    combinedOdds = Number(combinedOdds.toFixed(2));

    const v = this.validateStake(profile, stake);
    if (!v.ok) return { ok: false, code: v.code, ...v };
    const potentialPayout = Math.min(this.config.maxPayoutPerBet * legs.length, Math.floor(stake * combinedOdds));
    const rate = this.rateLimiter.consume(`parlay:${profile.id}`);
    if (!rate.allowed) return { ok: false, code: 'rate_limit' };

    const key = `parlay:${profile.id}:${placedAt}:${hash32(JSON.stringify(resolvedLegs))}:${stake}`;
    const parlay = {
      id: `pl_${hash32(key).toString(36)}_${placedAt.toString(36)}`,
      profileId: profile.id, seasonMonth: this.store.getMatch(legs[0].matchId).seasonMonth,
      legs: resolvedLegs, combinedOdds, stake, potentialPayout,
      status: 'pending', debited: false, placedAt
    };
    const ins = this.store.insertParlay(parlay);
    if (!ins.ok) return { ok: false, code: `store_${ins.reason}` };
    if (stake > profile.chips) { this.store.voidParlay(parlay.id); return { ok: false, code: 'insufficient_chips' }; }
    const d = debit(profile, stake, 'Combinada Estadio');
    if (!d.ok) { this.store.voidParlay(parlay.id); return { ok: false, code: d.error || 'debito_fallido' }; }
    this.store.markParlayDebited(parlay.id);
    this.profiles.touch(profile);
    if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
    this.store.confirmParlay(parlay.id);
    this.log('football_parlay_placed', { parlayId: parlay.id, legs: legs.length, stake, combinedOdds });
    return { ok: true, parlay: this.store.getParlay(parlay.id) };
  }

  settleParlayLeg(parlayId, matchId, result, cells = [], voidReason = '') {
    const parlay = this.store.getParlay(parlayId);
    if (!parlay || parlay.status !== 'open') return { ok: false };
    const resolution = result ? resolveSelection(
      parlay.legs.find(l => l.matchId === matchId)?.market,
      parlay.legs.find(l => l.matchId === matchId)?.selection, result, { correctScoreCells: cells }
    ) : 'void';
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
    const out = this.store.settleParlay(p.id, { status, payout });
    if (!out.ok) return { ok: false, reason: out.reason };
    if (out.alreadySettled) return { ok: true, alreadySettled: true };
    const profile = this.profiles.getProfile(p.profileId);
    if (profile) {
      if (status === 'void') credit(profile, payout, `Anulación: ${reason}`);
      else { profile.chips += payout; recordOutcome(profile, { game: GAME, net: payout - p.stake, eligible: false }); }
      this.profiles.touch(profile);
      if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
    }
    this.log('football_parlay_settled', { parlayId: p.id, status, payout });
    return { ok: true, payout, status };
  }

  // --- Futuros (§11.5) ---

  async placeFuture({ profile, seasonMonth, market, selection, odds, stake, placedAtJornada, placedAt = this.now() }) {
    stake = Math.floor(Number(stake) || 0);
    if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
    const v = this.validateStake(profile, stake);
    if (!v.ok) return { ok: false, code: v.code, ...v };
    // Una sola apuesta abierta por (perfil, mercado, selección) — índice único en PG.
    const dup = this.store.getFutures({ profileId: profile.id, status: 'open', seasonMonth })
      .find(f => f.market === market && f.selection === selection);
    if (dup) return { ok: false, code: 'futuro_duplicado' };
    const rate = this.rateLimiter.consume(`future:${profile.id}`);
    if (!rate.allowed) return { ok: false, code: 'rate_limit' };

    const key = `future:${profile.id}:${seasonMonth}:${market}:${selection}:${stake}`;
    const future = {
      id: `fu_${hash32(key).toString(36)}_${placedAt.toString(36)}`,
      profileId: profile.id, seasonMonth, market, selection, odds, stake,
      potentialPayout: Math.min(this.config.maxPayoutPerBet, Math.floor(stake * odds)),
      status: 'pending', debited: false, placedAtJornada: placedAtJornada || 0, placedAt
    };
    const ins = this.store.insertFuture(future);
    if (!ins.ok) return { ok: false, code: `store_${ins.reason}` };
    if (stake > profile.chips) { this.store.voidFuture(future.id); return { ok: false, code: 'insufficient_chips' }; }
    const d = debit(profile, stake, 'Futuro Estadio');
    if (!d.ok) { this.store.voidFuture(future.id); return { ok: false, code: d.error || 'debito_fallido' }; }
    this.store.markFutureDebited(future.id);
    this.profiles.touch(profile);
    if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
    this.store.confirmFuture(future.id);
    this.log('football_future_placed', { futureId: future.id, market, selection, stake, odds });
    return { ok: true, future: this.store.getFuture(future.id) };
  }

  // Al cerrar la temporada: resuelve campeón/top4/bota contra el resultado real.
  settleFutures(seasonMonth, { championTeamId = null, top4TeamIds = [], goldenBootTeamId = null } = {}) {
    let settled = 0, paid = 0;
    const top4 = new Set(top4TeamIds);
    for (const f of this.store.getOpenFutures(seasonMonth)) {
      let resolution = 'lost';
      if (f.market === 'champion') resolution = f.selection === championTeamId ? 'won' : 'lost';
      else if (f.market === 'top4') resolution = top4.has(f.selection) ? 'won' : 'lost';
      else if (f.market === 'golden_boot') resolution = f.selection === goldenBootTeamId ? 'won' : 'lost';
      else resolution = 'void';
      const payout = resolution === 'won' ? Math.min(this.config.maxPayoutPerBet, Math.floor(f.stake * f.odds)) : resolution === 'void' ? f.stake : 0;
      const status = resolution === 'won' ? 'won' : resolution === 'void' ? 'void' : 'lost';
      const out = this.store.settleFuture(f.id, { status, payout });
      if (!out.ok || out.alreadySettled) continue;
      const profile = this.profiles.getProfile(f.profileId);
      if (profile) {
        if (status === 'void') credit(profile, payout, 'Anulación: futuro sin mercado');
        else { profile.chips += payout; recordOutcome(profile, { game: GAME, net: payout - f.stake, eligible: false }); }
        this.profiles.touch(profile);
        if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow();
      }
      settled++; paid += payout;
    }
    return { settled, paid };
  }

  // Temporada truncada (§11.5): anula y reembolsa todos los futuros abiertos.
  refundFutures(seasonMonth, reason = 'temporada truncada') {
    let refunded = 0;
    for (const f of this.store.getOpenFutures(seasonMonth)) {
      const out = this.store.voidFuture(f.id);
      if (!out.ok || out.alreadyVoid) continue;
      const profile = this.profiles.getProfile(f.profileId);
      if (profile) { credit(profile, f.stake, `Anulación: ${reason}`); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); }
      refunded++;
    }
    return { refunded };
  }

  // --- Reconciliación de arranque (§15.6, T34) ---

  // Anula las apuestas 'pending' huérfanas (el proceso murió a mitad del WAL).
  // Si el débito llegó a marcarse, reembolsa: nunca se le roba al jugador.
  cancelPendingBets() {
    let cancelled = 0;
    for (const bet of this.store.getBets({ status: 'pending' })) {
      this.store.voidBet(bet.id);
      if (bet.debited) {
        const profile = this.profiles.getProfile(bet.profileId);
        if (profile) { credit(profile, bet.stake, 'Anulación: colocación interrumpida'); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); }
      }
      cancelled++;
    }
    for (const p of this.store.getParlays({ status: 'pending' })) {
      this.store.voidParlay(p.id);
      if (p.debited) { const profile = this.profiles.getProfile(p.profileId); if (profile) { credit(profile, p.stake, 'Anulación: colocación interrumpida'); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); } }
      cancelled++;
    }
    for (const f of this.store.getFutures({ status: 'pending' })) {
      this.store.voidFuture(f.id);
      if (f.debited) { const profile = this.profiles.getProfile(f.profileId); if (profile) { credit(profile, f.stake, 'Anulación: colocación interrumpida'); this.profiles.touch(profile); if (typeof this.profiles.saveNow === 'function') this.profiles.saveNow(); } }
      cancelled++;
    }
    if (cancelled) this.log('football_pending_cancelled', { count: cancelled });
    return cancelled;
  }

  // Fuerza la liquidación de apuestas 'open' cuyo partido ya terminó (§12.5) y
  // devuelve el número de descuadres de escrow detectados.
  reconcileEscrow() {
    let forced = 0, mismatch = 0;
    for (const bet of this.store.getBets({ status: 'open' })) {
      const match = this.store.getMatch(bet.matchId);
      if (!match) { this._payoutBet(bet, 'void', 'partido inexistente'); forced++; mismatch++; continue; }
      if (match.status === 'settled' && match.result) {
        const cells = this._correctScoreCells(match);
        const resolution = resolveSelection(bet.market, bet.selection, match.result, { correctScoreCells: cells });
        this._payoutBet(bet, resolution); forced++;
      } else if (match.status === 'postponed') {
        this._payoutBet(bet, 'void', 'partido pospuesto'); forced++;
      }
    }
    if (forced) this.log('football_escrow_reconcile', { forced, mismatch });
    return mismatch;
  }

  // --- Hooks de consulta para el motor (§15.8, A7) ---

  hasOpenBets(seasonMonth) {
    return this.store.hasOpenBets(seasonMonth ? { seasonMonth } : {});
  }
  countOpenBets() {
    return this.store.getBets({ status: 'open' }).length + this.store.getParlays({ status: 'open' }).length + this.store.getFutures({ status: 'open' }).length;
  }
  countEscrow() {
    let total = 0;
    for (const bet of this.store.getBets({ status: 'open' })) total += bet.stake;
    for (const p of this.store.getParlays({ status: 'open' })) total += p.stake;
    for (const f of this.store.getFutures({ status: 'open' })) total += f.stake;
    return total;
  }

  // Panel «Mis apuestas» (§12.1): stakes, cuotas y pagos potenciales del perfil.
  getBetsForProfile(profileId) {
    return {
      bets: this.store.getBets({ profileId, status: 'open' }),
      parlays: this.store.getParlays({ profileId, status: 'open' }),
      futures: this.store.getFutures({ profileId, status: 'open' })
    };
  }
}

function createBettingService(deps) {
  return new BettingService(deps);
}

module.exports = {
  BettingService, createBettingService, resolveSelection, parseMarket, LIMITS, GAME, LIVE_STATUSES
};
