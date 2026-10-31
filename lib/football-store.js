'use strict';

const { matchStats: fantasyMatchStats } = require('./football/fantasy');
const { buildHighlights } = require('./football/highlights');

// Fase A — Store de fútbol, backend de archivo JSON (§13.1, §13.2).
//
// Espejo de lib/profile-store.js: mismo patrón de E/S a disco con guardado
// atómico (tmp + rename), mismo debounce con `unref` para no mantener vivo el
// proceso, y un `saveNow()`/`close()` que gracefulShutdown llamará en la Fase C
// (§15.7). La lógica de limpieza y la tabla de posiciones viven en
// football-store-shared.js, compartidas con el backend de Postgres (Fase F).
//
// Responsabilidades de la Fase A (su aceptación): generar una temporada completa
// para cualquier mes, producir un calendario válido (T17), mantener la tabla de
// posiciones al asentar resultados, y persistir de ida y vuelta en JSON. Sin UI
// y sin sockets: eso llega en fases posteriores detrás de FOOTBALL_ENABLED.

const fs = require('fs');
const path = require('path');
const { hash32, mulberry32 } = require('./football/prng');
const { applyTransfers } = require('./football/transfers');
const { buildSeasonClubs, applySeasonCarryover, CLUB_IDS, refreshPersistedClubNames } = require('./football/teams');
const { generateCalendar } = require('./football/fixtures');
const { generateTimeline } = require('./football/match-engine');
const {
  createBallonDorEvent, updateBallonDorOdds: applyBallonDorOdds,
  transitionBallonDorStatus, finalizeBallonDorEvent
} = require('./football/ballon-dor');
const { aggregateBallonDorMatch, isRegularBallonDorMatch } = require('./football/ballon-dor-stats');
// Extractores puros del resultado asentado: descanso y primer goleador salen de la
// MISMA cronología verificada que alimenta el premio y los destacados.
const { halfTimeScoreFromTimeline, firstScorerFromTimeline } = require('./football/odds');
const { auditBallonDor, planBallonDorRepair } = require('./football/ballon-dor-audit');
const {
  updateAfterMatch, recomputeLeagueStats, outcome,
  INITIAL_LEAGUE_AVG, INITIAL_HOME_ADV
} = require('./football/ratings');
const {
  monthKey, normalizeSeasonMonth, cleanLeague, cleanMatch,
  cleanBet, cleanParlay, cleanFuture, cleanGenerationInputs,
  buildStandings, emptyStandings,
  calendarParts, CASINO_TIME_ZONE
} = require('./football-store-shared');

// Cronología de un asentado que llega sin ella (palanca admin, herramienta,
// reproceso). Solo se acepta si el partido guarda su foto de insumos: con ella la
// regeneración es EXACTAMENTE la que reveló el motor (mismo seed, mismos insumos,
// mismo marcador), así que lo que archiva el asentado coincide con lo que se vio
// en la cancha. Sin foto no hay cronología verificada y no se inventan hechos:
// el marcador se asienta y las estadísticas quedan vacías, como hasta ahora con
// las liquidaciones manuales de un partido que nunca se generó.
function settlementTimeline(match, homeClub, awayClub, score) {
  const frozen = cleanGenerationInputs(match && match.generationInputs);
  if (!frozen) return null;
  const generated = generateTimeline(
    { ...homeClub, ratings: frozen.home },
    { ...awayClub, ratings: frozen.away },
    {
      leagueAvg: frozen.leagueAvg,
      homeAdv: frozen.homeAdv,
      ...(frozen.rho != null ? { rho: frozen.rho } : {}),
      esDesempate: Boolean(match.desempate),
      forcedScore: { home: score.home, away: score.away }
    },
    mulberry32(match.seed)
  );
  if (!generated || !Array.isArray(generated.timeline)) return null;
  if (generated.score.home !== score.home || generated.score.away !== score.away) return null;
  return { timeline: generated.timeline, lineups: generated.lineups };
}

const DEFAULT_STORE_PATH = process.env.FOOTBALL_STORE_PATH || path.join(process.cwd(), 'data', 'football.json');
const SAVE_DELAY_MS = 250;          // datos de temporada: se escriben al generar y al cerrar jornada (§13.2)
const HISTORY_SEASONS = 12;         // cuántas temporadas archivadas se conservan
const ODDS_AUDIT_LIMIT = 2000;      // anillo de auditoría de cambios de cuota (§10.4)

// Ajuste de continuidad entre meses (§5.1): campeón y podio mejoran el elo
// inicial siguiente; las dos últimas posiciones lo penalizan. Acotado a ±40 en
// applySeasonCarryover para que la liga nunca se vuelva predecible de forma
// permanente.
const CARRYOVER = { 0: 25, 1: 12, 14: -12, 15: -25 };

class FootballStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.backend = 'file';
    this.filePath = filePath;
    this.saveDelayMs = SAVE_DELAY_MS;
    this.saveTimer = null;
    this.seasons = { current: monthKey(), history: [] };
    this.leagues = new Map();   // seasonMonth → liga
    // Fase D — apuestas, combinadas, futuros y auditoría de cuotas. Espejo de las
    // tablas football_bets/parlays/futures/odds_audit del backend PG (§13.3). En
    // archivo viven en el mismo JSON; las transiciones de dinero son write-through.
    this.bets = new Map();       // betId → apuesta
    this.parlays = new Map();    // parlayId → combinada
    this.futures = new Map();    // futureId → futuro
    this.oddsAudit = [];         // anillo de cambios de cuota (§10.4)
    this.load();
  }

  // --- E/S a disco ---

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (data && data.seasons && typeof data.seasons === 'object') {
        this.seasons = {
          current: typeof data.seasons.current === 'string' ? data.seasons.current : monthKey(),
          history: Array.isArray(data.seasons.history) ? data.seasons.history.slice(-HISTORY_SEASONS) : []
        };
      }
      for (const raw of Array.isArray(data && data.leagues) ? data.leagues : []) {
        const league = this._hydrateLeague(raw);
        if (league) this.leagues.set(league.seasonMonth, league);
      }
      // Fase D — rehidratar apuestas/combinadas/futuros/auditoría.
      for (const raw of Array.isArray(data && data.bets) ? data.bets : []) {
        const bet = cleanBet(raw);
        if (bet) this.bets.set(bet.id, bet);
      }
      for (const raw of Array.isArray(data && data.parlays) ? data.parlays : []) {
        const parlay = cleanParlay(raw);
        if (parlay) this.parlays.set(parlay.id, parlay);
      }
      for (const raw of Array.isArray(data && data.futures) ? data.futures : []) {
        const future = cleanFuture(raw);
        if (future) this.futures.set(future.id, future);
      }
      if (Array.isArray(data && data.oddsAudit)) this.oddsAudit = data.oddsAudit.slice(-ODDS_AUDIT_LIMIT);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudo cargar la liga de fútbol:', error.message);
    }
  }

  // Reconstruye una liga desde JSON, rehidratando las referencias de partidos
  // (calendar.jornadas guarda matchIds; los objetos viven en calendar.matches).
  _hydrateLeague(raw) {
    const league = cleanLeague(raw);
    if (!league) return null;
    const cal = league.calendar;
    if (cal && Array.isArray(cal.matches)) {
      cal.matches = cal.matches.map(cleanMatch).filter(Boolean);
      const byId = new Map(cal.matches.map(m => [m.id, m]));
      if (Array.isArray(cal.jornadas)) {
        for (const j of cal.jornadas) {
          j.matches = (j.matchIds || []).map(id => byId.get(id)).filter(Boolean);
        }
      }
    }
    return refreshPersistedClubNames(league);
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const leagues = [...this.leagues.values()].map(league => this._serializeLeague(league));
      const payload = {
        seasons: this.seasons,
        leagues,
        bets: [...this.bets.values()],
        parlays: [...this.parlays.values()],
        futures: [...this.futures.values()],
        oddsAudit: this.oddsAudit.slice(-ODDS_AUDIT_LIMIT)
      };
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2));
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.warn('No se pudo guardar la liga de fútbol:', error.message);
    }
  }

  // Al serializar, las jornadas guardan matchIds (no los objetos) para que la
  // ida y vuelta por JSON no duplique los partidos ni rompa la identidad.
  _serializeLeague(league) {
    const cal = league.calendar;
    const serializedCalendar = cal ? {
      daysInMonth: cal.daysInMonth,
      diasDisponibles: cal.diasDisponibles,
      dobles: cal.dobles,
      timeZone: cal.timeZone,
      jornadas: (cal.jornadas || []).map(j => ({
        jornada: j.jornada, day: j.day, wave: j.wave,
        matchIds: (j.matches || []).map(m => m.id)
      })),
      matches: cal.matches || []
    } : null;
    return {
      seasonMonth: league.seasonMonth,
      seed: league.seed,
      status: league.status,
      createdAt: league.createdAt,
      closedAt: league.closedAt,
      config: league.config,
      ctx: league.ctx,
      carryover: league.carryover,
      standings: league.standings,
      ballonDor: league.ballonDor || null,
      calendar: serializedCalendar
    };
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveNow(); }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  close() {
    clearTimeout(this.saveTimer);
    this.saveNow();
  }

  // --- Generación de temporada ---

  // Genera (o devuelve la existente) la liga de un mes. Dos seeds independientes
  // y deterministas: uno para planteles/ratings, otro para el calendario (§5.2).
  generateSeason(seasonMonth, options = {}) {
    const key = normalizeSeasonMonth(seasonMonth);
    const existing = this.leagues.get(key);
    if (existing && !options.force) return existing;

    const clubsSeed = hash32(`${key}plantillas`);
    const clubs = buildSeasonClubs(mulberry32(clubsSeed));

    // Continuidad desde la temporada previa si existe (§5.1).
    const prev = this._previousSeason(key);
    if (prev && prev.carryover) applySeasonCarryover(clubs, prev.carryover);
    if (prev) applyTransfers(prev, clubs, key);

    const calendar = generateCalendar(key, clubs, { timeZone: options.timeZone });

    // Rehidrata referencias: jornadas apuntan a los objetos de calendar.matches.
    const byId = new Map(calendar.matches.map(m => [m.id, m]));
    const jornadas = calendar.jornadas.map(j => ({
      jornada: j.jornada, day: j.day, wave: j.wave,
      matches: j.matches.map(m => byId.get(m.id))
    }));

    const createdAt = Number.isSafeInteger(options.createdAt) && options.createdAt > 0
      ? options.createdAt : Date.now();
    const ballonDor = createBallonDorEvent(key, clubs, createdAt);
    const league = {
      seasonMonth: key,
      seed: calendar.seed,
      status: 'active',
      createdAt,
      closedAt: null,
      config: clubs,
      ctx: { leagueAvg: INITIAL_LEAGUE_AVG, homeAdv: INITIAL_HOME_ADV, sample: 0 },
      carryover: {},
      standings: emptyStandings(clubs.map(c => c.id)),
      ballonDor,
      calendar: {
        daysInMonth: calendar.daysInMonth,
        diasDisponibles: calendar.diasDisponibles,
        dobles: calendar.dobles,
        timeZone: calendar.timeZone,
        jornadas,
        matches: calendar.matches
      }
    };

    this.leagues.set(key, league);
    this.seasons.current = key;
    this.saveNow(); // escribir la temporada completa al generarla (§13.2)
    return league;
  }

  _previousSeason(seasonMonth) {
    const keys = [...this.leagues.keys()].filter(k => k < seasonMonth).sort();
    return keys.length ? this.leagues.get(keys[keys.length - 1]) : null;
  }

  // Asegura la temporada del mes en curso: si no existe, la genera; si el mes
  // cambió, archiva la anterior (status 'closed' + carryover) y genera la nueva.
  // Espejo ligero de ensureSeason() de los perfiles; el cierre completo con
  // campeón/podio y partido de desempate (§7.5) llega en la Fase F.
  ensureSeason(date = new Date()) {
    const current = monthKey(date);
    const existing = this.leagues.get(current);
    if (existing) {
      this.seasons.current = current;
      return existing;
    }
    // Archiva temporadas de meses anteriores que sigan activas.
    for (const [key, league] of this.leagues) {
      if (key < current && league.status === 'active') this.closeSeason(key);
    }
    return this.generateSeason(current);
  }

  // Cierra una temporada: calcula el carryover para la siguiente y la marca
  // 'closed'. No toca fichas (eso es del reset mensual del casino, §5.2).
  closeSeason(seasonMonth) {
    const key = normalizeSeasonMonth(seasonMonth);
    const league = this.leagues.get(key);
    if (!league) return null;
    league.carryover = this.computeCarryover(league);
    league.status = 'closed';
    league.closedAt = Date.now();
    if (!this.seasons.history.includes(key)) {
      this.seasons.history.push(key);
      this.seasons.history = this.seasons.history.slice(-HISTORY_SEASONS);
    }
    this.saveNow(); // transición de temporada: escritura inmediata
    return league;
  }

  // Ajuste de elo por posición final para la temporada siguiente (§5.1).
  computeCarryover(league) {
    const carryover = {};
    const standings = league.standings || [];
    for (const [indexStr, delta] of Object.entries(CARRYOVER)) {
      const row = standings[Number(indexStr)];
      if (row) carryover[row.teamId] = delta;
    }
    return carryover;
  }

  // --- Lectura ---

  getLeague(seasonMonth) {
    const key = seasonMonth ? normalizeSeasonMonth(seasonMonth) : this.seasons.current;
    return this.leagues.get(key) || null;
  }

  getCurrentSeasonMonth() {
    return this.seasons.current;
  }

  getSeasonMonths() {
    return [...this.leagues.keys()].sort();
  }

  getBallonDor(seasonMonth) {
    const league = this.getLeague(seasonMonth);
    return league ? league.ballonDor || null : null;
  }

  // Persiste únicamente transiciones válidas del contrato del evento. El reloj
  // y los disparadores de calendario son responsabilidad de la Fase 4.
  async transitionBallonDor(seasonMonth, nextStatus, options = {}) {
    const league = this.getLeague(seasonMonth);
    if (!league) return { ok: false, reason: 'no_season' };
    if (!league.ballonDor) return { ok: false, reason: 'no_ballon_dor_event' };
    const transition = transitionBallonDorStatus(league.ballonDor, nextStatus, options);
    if (!transition.ok || transition.already) return transition;
    league.ballonDor = transition.event;
    await this.saveNow();
    return transition;
  }

  async updateBallonDorOdds(seasonMonth, snapshot, at = snapshot && snapshot.updatedAt) {
    const league = this.getLeague(seasonMonth);
    if (!league) return { ok: false, reason: 'no_season' };
    if (!league.ballonDor) return { ok: false, reason: 'no_ballon_dor_event' };
    const update = applyBallonDorOdds(league.ballonDor, snapshot, at);
    if (!update.ok || update.already) return update;
    league.ballonDor = update.event;
    await this.saveNow();
    return update;
  }

  // Compara el acumulado del premio con el archivo por partido (goles, asistencias,
  // apariciones y rojas). Es solo lectura: sirve para diagnosticar por qué un
  // jugador aparece con más goles/asistencias de los que el resumen le da.
  auditBallonDor(seasonMonth) {
    const league = this.getLeague(seasonMonth);
    if (!league) return { ok: false, reason: 'no_season' };
    return auditBallonDor(league);
  }

  // Repara el acumulado desde el archivo por partido. Con `apply:false` devuelve
  // solo el plan. Nunca reescribe un evento `settled`/`cancelled`: ese ya tiene
  // ceremonia, resultado y pagos, y requiere decisión explícita del dueño.
  async repairBallonDor(seasonMonth, { apply = false, at = Date.now() } = {}) {
    const league = this.getLeague(seasonMonth);
    if (!league) return { ok: false, reason: 'no_season' };
    if (!league.ballonDor) return { ok: false, reason: 'no_ballon_dor_event' };
    const plan = planBallonDorRepair(league, { at });
    if (!plan.ok || plan.already || !apply) return plan;
    league.ballonDor = plan.event;
    await this.saveNow();
    return plan;
  }

  async createBallonDorTiebreak(seasonMonth, { homeId, awayId, kickoffAt } = {}) {
    const league = this.getLeague(seasonMonth);
    if (!league) return { ok: false, reason: 'no_season' };
    if (!league.ballonDor) return { ok: false, reason: 'no_ballon_dor_event' };
    if (league.ballonDor.status !== 'locked') return { ok: false, reason: 'evento_no_bloqueado' };
    const matches = league.calendar?.matches || [];
    const existing = matches.find(match => match.desempate);
    if (existing) {
      const sameTeams = existing.homeId === homeId && existing.awayId === awayId;
      return sameTeams ? { ok: true, match: existing, already: true, reason: 'already_exists' }
        : { ok: false, reason: 'desempate_conflict', match: existing };
    }
    const regular = matches.filter(isRegularBallonDorMatch);
    if (regular.length !== 240 || regular.some(match => match.status !== 'settled' || !match.result)) {
      return { ok: false, reason: 'temporada_incompleta' };
    }
    const clubs = new Set(league.config.map(club => club.id));
    if (!homeId || !awayId || homeId === awayId || !clubs.has(homeId) || !clubs.has(awayId)) {
      return { ok: false, reason: 'clubes_invalidos' };
    }
    const kickoff = Number(kickoffAt);
    if (!Number.isSafeInteger(kickoff) || kickoff <= 0) return { ok: false, reason: 'kickoff_invalido' };
    const tieSeed = hash32(`desempate|${league.seasonMonth}|${homeId}|${awayId}`);
    const match = cleanMatch({
      id: `m_${league.seasonMonth}_desempate_${tieSeed.toString(36)}`,
      seasonMonth: league.seasonMonth,
      jornada: 31,
      block: 'estelar',
      featured: true,
      desempate: true,
      homeId,
      awayId,
      seed: tieSeed,
      scheduledKickoffAt: kickoff,
      day: Number(calendarParts(new Date(kickoff), league.calendar.timeZone || CASINO_TIME_ZONE).day) || 1,
      wave: 0,
      actualKickoffAt: null,
      status: 'scheduled',
      result: null,
      settledAt: null
    });
    if (!match) return { ok: false, reason: 'desempate_invalido' };
    league.calendar.matches.push(match);
    await this.saveNow();
    return { ok: true, match, already: false };
  }

  // Aplica bonus/ranking y persiste el resultado cuando terminaron las 30
  // jornadas y cualquier partido marcado como desempate. No automatiza el reloj
  // del ciclo (eso corresponde a Fase 4).
  async finalizeBallonDor(seasonMonth, clubPositions, options = {}) {
    const league = this.getLeague(seasonMonth);
    if (!league) return { ok: false, reason: 'no_season' };
    if (!league.ballonDor) return { ok: false, reason: 'no_ballon_dor_event' };
    if (league.ballonDor.status === 'settled') {
      return { ok: true, event: league.ballonDor, already: true };
    }
    if (league.ballonDor.status !== 'locked') return { ok: false, reason: 'evento_no_bloqueado' };

    const matches = league.calendar && Array.isArray(league.calendar.matches) ? league.calendar.matches : [];
    const regularMatches = matches.filter(isRegularBallonDorMatch);
    if (regularMatches.length !== 240) return { ok: false, reason: 'calendario_incompleto' };
    if (matches.some(match => (isRegularBallonDorMatch(match) || match.desempate) && match.status !== 'settled')) {
      return { ok: false, reason: 'temporada_incompleta' };
    }

    const finalized = finalizeBallonDorEvent(league.ballonDor, clubPositions,
      options.at == null ? Date.now() : options.at);
    if (!finalized.ok) return finalized;
    league.ballonDor = finalized.event;
    await this.saveNow();
    return finalized;
  }

  getMatches(seasonMonth) {
    const league = this.getLeague(seasonMonth);
    return league && league.calendar ? league.calendar.matches : [];
  }

  getMatch(matchId, seasonMonth) {
    return this.getMatches(seasonMonth).find(m => m.id === matchId) || null;
  }

  // Busca un partido en cualquier temporada cargada (la vigente primero). Una
  // apuesta puede referirse a un partido del mes anterior: buscarlo solo en la
  // temporada actual lo declaraba inexistente y anulaba un boleto ya ganado.
  getMatchAnywhere(matchId) {
    const current = this.seasons.current;
    const here = this.getMatch(matchId, current);
    if (here) return here;
    for (const seasonMonth of this.getSeasonMonths().slice().reverse()) {
      if (seasonMonth === current) continue;
      const found = this.getMatch(matchId, seasonMonth);
      if (found) return found;
    }
    return null;
  }

  getStandings(seasonMonth) {
    const league = this.getLeague(seasonMonth);
    return league ? league.standings : [];
  }

  // --- Asentado de resultados ---

  // Asienta el resultado de un partido: actualiza el partido, recalcula la tabla
  // desde todos los asentados (nunca a mano), actualiza los ratings Elo/att/def
  // de ambos clubes (§10.1) y el contexto rodante de la liga. Idempotente: un
  // partido ya asentado no se vuelve a procesar.
  //
  // La guarda NO mira solo `status`: el motor marca 'finished' en el objeto
  // compartido antes de llamar aquí, así que un segundo asentamiento (reinicio,
  // reconciliación, palanca admin) pasaba de largo y SOBRESCRIBÍA el marcador, la
  // tabla y volvía a aplicar los ratings. Regla fija (§15.4): el primer resultado
  // asentado es la fuente autoritativa y nunca se reescribe.
  settleMatch(matchId, result, options = {}) {
    const seasonMonth = options.seasonMonth || this.seasons.current;
    const league = this.getLeague(seasonMonth);
    if (!league) return { ok: false, reason: 'no_season' };
    const match = league.calendar.matches.find(m => m.id === matchId);
    if (!match) return { ok: false, reason: 'no_match' };
    if (match.status === 'settled' || match.settledAt != null || match.result) {
      return { ok: true, match, alreadySettled: true };
    }

    const home = Number(result && result.home);
    const away = Number(result && result.away);
    // Goles enteros no negativos. Un valor no entero (1.5) o negativo es un bug
    // aguas arriba (el motor de Fase B siempre produce enteros); se rechaza en
    // vez de truncar en silencio para no corromper la tabla ni los ratings.
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) {
      return { ok: false, reason: 'bad_result' };
    }

    const now = options.now || Date.now();
    const homeClub = league.config.find(c => c.id === match.homeId);
    const awayClub = league.config.find(c => c.id === match.awayId);

    // Ratings PRE-partido y contexto vigente antes de este resultado (§10.1).
    // Si la liga se recargó de un JSON viejo sin ctx, se rellena con los valores
    // iniciales para no romper el asentado.
    const ctx = league.ctx || { leagueAvg: INITIAL_LEAGUE_AVG, homeAdv: INITIAL_HOME_ADV, sample: 0 };
    league.ctx = ctx;
    const ctxBefore = { leagueAvg: ctx.leagueAvg, homeAdv: ctx.homeAdv, rho: ctx.rho };

    // Las estadísticas se calculan antes de mutar el partido. En producción el
    // engine pasa la misma timeline y lineup que reveló; los asentados manuales
    // conservan su marcador y generan una timeline determinista compatible.
    // UNA sola línea de tiempo para el premio, el archivo de Mi Once y los
    // destacados. Manda la que reveló el motor; si el asentado llegó sin ella, se
    // reconstruye desde la foto de insumos (ver settlementTimeline). Si no hay
    // cronología verificada no se acredita nada: antes el premio sumaba una
    // regeneración «a ojo» mientras el resumen del partido quedaba vacío.
    let timeline = options.timeline || (options.matchResult && options.matchResult.timeline);
    let lineups = options.lineups || (options.matchResult && options.matchResult.lineups)
      || (timeline && timeline.lineups);
    let verified = Boolean(timeline);
    if (!timeline && homeClub && awayClub) {
      const generated = settlementTimeline(match, homeClub, awayClub, { home, away });
      if (generated) { timeline = generated.timeline; lineups = generated.lineups; verified = true; }
    }
    if (!verified) { timeline = null; lineups = null; }

    let nextBallonDor = null;
    if (verified && league.ballonDor && !['settled', 'cancelled'].includes(league.ballonDor.status)
        && isRegularBallonDorMatch(match)) {
      const statsUpdate = aggregateBallonDorMatch(league.ballonDor, match, timeline, lineups, {
        expectedScore: { home, away }, at: now
      });
      if (!statsUpdate.ok) {
        return { ok: false, reason: 'ballon_dor_stats_invalid', detail: statsUpdate.reason };
      }
      nextBallonDor = statsUpdate.event;
    }

    // El descanso y el primer goleador son parte del resultado asentado: los
    // mercados de descanso/final y de primer goleador se liquidan contra esta
    // foto (§15.4), no contra una cronología regenerada al pagar. Sin cronología
    // verificada no se escriben (y esos boletos se anulan, nunca se adivinan).
    const halftime = verified ? halfTimeScoreFromTimeline(timeline) : null;
    const firstScorer = verified ? firstScorerFromTimeline(timeline) : undefined;
    match.result = {
      home, away,
      winner: match.desempate && ['home', 'away'].includes(result && result.winner)
        ? result.winner : outcome(home, away),
      ...(halftime ? { halftime } : {}),
      ...(firstScorer !== undefined ? { firstScorer } : {})
    };
    // La misma timeline del premio alimenta Mi Once y los destacados: si el
    // asentado tuvo que reconstruirla, las tres superficies cuentan lo mismo.
    match.fantasyStats = fantasyMatchStats(match, timeline, lineups, { home, away });
    match.highlights = buildHighlights(match, timeline, lineups, { home, away });
    match.status = 'settled';
    match.settledAt = now;
    if (nextBallonDor) league.ballonDor = nextBallonDor;

    // El cierre de mercado ocurre en la misma escritura que asienta el octavo
    // partido de J20: no queda una ventana entre el último resultado y el lock.
    if (!match.desempate && match.jornada === 20 && league.ballonDor?.status === 'active') {
      const j20 = league.calendar.matches.filter(item => !item.desempate && item.jornada === 20);
      if (j20.length === 8 && j20.every(item => item.status === 'settled')) {
        const locked = transitionBallonDorStatus(league.ballonDor, 'locked', {
          at: Math.max(now, league.ballonDor.updatedAt)
        });
        if (locked.ok) league.ballonDor = locked.event;
      }
    }

    // Tabla recalculada desde todos los partidos asentados, en orden (§5.1).
    league.standings = buildStandings(league.calendar.matches, league.config.map(c => c.id));

    // Ratings y forma de los clubes.
    if (homeClub && awayClub) {
      const updated = updateAfterMatch(homeClub.ratings, awayClub.ratings, home, away, ctxBefore);
      homeClub.ratings = updated.home;
      awayClub.ratings = updated.away;
      const homeRow = league.standings.find(r => r.teamId === homeClub.id);
      const awayRow = league.standings.find(r => r.teamId === awayClub.id);
      if (homeRow) homeClub.form = homeRow.form.slice();
      if (awayRow) awayClub.form = awayRow.form.slice();
    }

    // Contexto rodante de la liga (leagueAvg/homeAdv) sobre los últimos 60 (§10.1).
    league.ctx = recomputeLeagueStats(league.calendar.matches);

    // Asentar un resultado es una transición de estado de baja frecuencia (8 por
    // jornada): se escribe al momento (§13.2), no por debounce, para que un
    // crash no pierda el resultado ni lo deje sin reflejarse en la tabla.
    this.saveNow();
    return { ok: true, match, league };
  }

  // Reprograma el horario de kickoff de un partido programado (§28).
  // Solo se permite en partidos con status === 'scheduled'. Actualiza
  // scheduledKickoffAt, recalcula el día calendario en la zona horaria del
  // casino, ajusta el bloque opcionalmente, reordena los partidos del calendario
  // y persiste inmediatamente a disco con saveNow().
  rescheduleMatch(matchId, newKickoffAt, options = {}) {
    const seasonMonth = options.seasonMonth || this.seasons.current;
    const league = this.getLeague(seasonMonth);
    if (!league || !league.calendar) return { ok: false, reason: 'no_season' };
    const match = league.calendar.matches.find(m => m.id === matchId);
    if (!match) return { ok: false, reason: 'no_match' };
    if (match.status !== 'scheduled') {
      return { ok: false, reason: 'match_not_scheduled', status: match.status };
    }

    const kickoff = Number.isFinite(Number(newKickoffAt))
      ? Math.floor(Number(newKickoffAt))
      : Date.parse(String(newKickoffAt || ''));
    if (!Number.isFinite(kickoff) || kickoff <= 0) {
      return { ok: false, reason: 'invalid_kickoff' };
    }

    const now = options.now != null && Number.isFinite(Number(options.now))
      ? Number(options.now)
      : Date.now();
    if (kickoff <= now) {
      return { ok: false, reason: 'kickoff_in_past' };
    }

    const previousKickoffAt = match.scheduledKickoffAt;
    match.scheduledKickoffAt = kickoff;
    const parts = calendarParts(new Date(kickoff), CASINO_TIME_ZONE);
    if (parts && parts.day != null) {
      match.day = Number(parts.day);
    }
    if (options.block) {
      match.block = String(options.block).slice(0, 40);
    }

    // Reordenar partidos del calendario para mantener coherencia (§5.1)
    league.calendar.matches.sort((a, b) => (a.jornada - b.jornada) || (a.scheduledKickoffAt - b.scheduledKickoffAt));

    this.saveNow();
    return { ok: true, match, previousKickoffAt };
  }

  // --- Apuestas (Fase D, §12) ---
  //
  // Backend de archivo, proceso único: la atomicidad de «liquidar una vez» la da
  // el Map en memoria (comprobar status==='open' y mutar es síncrono). Las
  // transiciones de dinero son write-through (saveNow) para que un crash no
  // pierda una apuesta viva ni un pago. En PG (Fase F) esto es UPDATE…WHERE
  // status='open' RETURNING sobre football_bets.

  insertBet(bet) {
    const clean = cleanBet(bet);
    if (!clean || !clean.id || !clean.profileId || !clean.matchId || clean.stake <= 0) {
      return { ok: false, reason: 'apuesta_invalida' };
    }
    if (this.bets.has(clean.id)) return { ok: false, reason: 'duplicada' };
    this.bets.set(clean.id, clean);
    this.saveNow(); // WAL: la intención (pending) es duradera antes de mover fichas
    return { ok: true, bet: clean };
  }

  markBetDebited(betId) {
    const bet = this.bets.get(betId);
    if (!bet) return { ok: false, reason: 'no_existe' };
    bet.debited = true;
    this.saveNow();
    return { ok: true, bet };
  }

  confirmBet(betId) {
    const bet = this.bets.get(betId);
    if (!bet) return { ok: false, reason: 'no_existe' };
    if (bet.status !== 'pending') return { ok: false, reason: 'no_pending', status: bet.status };
    bet.status = 'open';
    this.saveNow();
    return { ok: true, bet };
  }

  getBet(betId) {
    return this.bets.get(betId) || null;
  }

  getBets({ profileId = null, matchId = null, status = null } = {}) {
    const out = [];
    for (const bet of this.bets.values()) {
      if (profileId && bet.profileId !== profileId) continue;
      if (matchId && bet.matchId !== matchId) continue;
      if (status && bet.status !== status) continue;
      out.push(bet);
    }
    return out;
  }

  getOpenBetsForMatch(matchId) {
    return this.getBets({ matchId, status: 'open' });
  }

  countOpenBets(matchId) {
    return matchId ? this.getOpenBetsForMatch(matchId).length : this.getBets({ status: 'open' }).length;
  }

  sumOpenStake(matchId) {
    return this.getOpenBetsForMatch(matchId).reduce((sum, b) => sum + b.stake, 0);
  }

  hasOpenBets({ profileId = null, matchId = null, seasonMonth = null } = {}) {
    for (const bet of this.bets.values()) {
      if (bet.status !== 'open' && bet.status !== 'pending') continue;
      if (profileId && bet.profileId !== profileId) continue;
      if (matchId && bet.matchId !== matchId) continue;
      if (seasonMonth) {
        const match = this.getMatch(bet.matchId, seasonMonth);
        if (!match || match.seasonMonth !== seasonMonth) continue;
      }
      return true;
    }
    return false;
  }

  countOpenBetsByProfile(profileId) {
    return this.getBets({ profileId, status: 'open' }).length;
  }

  // Liquidación exactamente una vez (§12.3): solo una apuesta 'open' transita.
  // Una segunda llamada (sweep duplicado, arranque que reconcilia dos veces) no
  // vuelve a pagar. payout es lo que se acredita al perfil (0 si perdió).
  settleBet(betId, { status, payout = 0, settledAt = Date.now() } = {}) {
    const bet = this.bets.get(betId);
    if (!bet) return { ok: false, reason: 'no_existe' };
    if (bet.status !== 'open') return { ok: true, bet, alreadySettled: true };
    if (!['won', 'lost', 'void', 'cashed'].includes(status)) return { ok: false, reason: 'estado_invalido' };
    bet.status = status;
    bet.payout = Math.max(0, Math.floor(Number(payout) || 0));
    bet.settledAt = settledAt;
    this.saveNow();
    return { ok: true, bet };
  }

  // Anulación (§12.4): la apuesta pasa a 'void'. El reembolso de fichas lo hace
  // betting.js contra el perfil; el store solo cambia el estado de la fila.
  voidBet(betId, { settledAt = Date.now() } = {}) {
    const bet = this.bets.get(betId);
    if (!bet) return { ok: false, reason: 'no_existe' };
    if (bet.status === 'void') return { ok: true, bet, alreadyVoid: true };
    if (['won', 'lost', 'cashed'].includes(bet.status)) return { ok: false, reason: 'ya_liquidada' };
    bet.status = 'void';
    bet.settledAt = settledAt;
    this.saveNow();
    return { ok: true, bet };
  }

  removeBet(betId) {
    const existed = this.bets.delete(betId);
    if (existed) this.saveNow();
    return { ok: existed };
  }

  // --- Combinadas (Fase D, §11.4) ---

  insertParlay(parlay) {
    const clean = cleanParlay(parlay);
    if (!clean || !clean.id || !clean.profileId || clean.stake <= 0) return { ok: false, reason: 'combinada_invalida' };
    if (this.parlays.has(clean.id)) return { ok: false, reason: 'duplicada' };
    this.parlays.set(clean.id, clean);
    this.saveNow();
    return { ok: true, parlay: clean };
  }

  markParlayDebited(parlayId) {
    const p = this.parlays.get(parlayId);
    if (!p) return { ok: false };
    p.debited = true; this.saveNow(); return { ok: true, parlay: p };
  }

  confirmParlay(parlayId) {
    const p = this.parlays.get(parlayId);
    if (!p) return { ok: false, reason: 'no_existe' };
    if (p.status !== 'pending') return { ok: false, reason: 'no_pending' };
    p.status = 'open'; this.saveNow(); return { ok: true, parlay: p };
  }

  getParlay(parlayId) { return this.parlays.get(parlayId) || null; }

  getParlays({ profileId = null, status = null } = {}) {
    const out = [];
    for (const p of this.parlays.values()) {
      if (profileId && p.profileId !== profileId) continue;
      if (status && p.status !== status) continue;
      out.push(p);
    }
    return out;
  }

  getOpenParlaysForMatch(matchId) {
    return this.getParlays({ status: 'open' }).filter(p => p.legs.some(l => l.matchId === matchId));
  }

  settleParlay(parlayId, { status, payout = 0, settledAt = Date.now() } = {}) {
    const p = this.parlays.get(parlayId);
    if (!p) return { ok: false, reason: 'no_existe' };
    if (p.status !== 'open') return { ok: true, parlay: p, alreadySettled: true };
    if (!['won', 'lost', 'void', 'cashed'].includes(status)) return { ok: false, reason: 'estado_invalido' };
    p.status = status; p.payout = Math.max(0, Math.floor(Number(payout) || 0)); p.settledAt = settledAt;
    this.saveNow();
    return { ok: true, parlay: p };
  }

  voidParlay(parlayId, { settledAt = Date.now() } = {}) {
    const p = this.parlays.get(parlayId);
    if (!p) return { ok: false, reason: 'no_existe' };
    if (p.status === 'void') return { ok: true, parlay: p, alreadyVoid: true };
    if (['won', 'lost', 'cashed'].includes(p.status)) return { ok: false, reason: 'ya_liquidada' };
    p.status = 'void'; p.settledAt = settledAt; this.saveNow();
    return { ok: true, parlay: p };
  }

  // Marca una pata (won/lost/void); devuelve la combinada actualizada.
  settleParlayLeg(parlayId, matchId, legStatus) {
    const p = this.parlays.get(parlayId);
    if (!p) return { ok: false, reason: 'no_existe' };
    const leg = p.legs.find(l => l.matchId === matchId);
    if (!leg) return { ok: false, reason: 'no_leg' };
    leg.status = legStatus;
    this.saveNow();
    return { ok: true, parlay: p };
  }

  // --- Futuros (Fase D, §11.5) ---

  insertFuture(future) {
    const clean = cleanFuture(future);
    if (!clean || !clean.id || !clean.profileId || clean.stake <= 0) return { ok: false, reason: 'futuro_invalido' };
    if (this.futures.has(clean.id)) return { ok: false, reason: 'duplicada', future: this.futures.get(clean.id) };
    if (clean.market === 'balon_de_oro') {
      const existing = [...this.futures.values()].find(item => item.market === 'balon_de_oro'
        && item.profileId === clean.profileId && item.seasonMonth === clean.seasonMonth);
      if (existing) return { ok: false, reason: 'bdo_ticket_exists', future: existing };
    }
    this.futures.set(clean.id, clean);
    this.saveNow();
    return { ok: true, future: clean };
  }

  insertBallonDorFuture(future) {
    const clean = cleanFuture(future);
    if (!clean || clean.market !== 'balon_de_oro') return { ok: false, reason: 'futuro_invalido' };
    return this.insertFuture(clean);
  }

  markFutureDebited(futureId) {
    const f = this.futures.get(futureId);
    if (!f) return { ok: false };
    f.debited = true; this.saveNow(); return { ok: true, future: f };
  }

  markFuturePayoutApplied(futureId) {
    const f = this.futures.get(futureId);
    if (!f) return { ok: false, reason: 'no_existe' };
    f.payoutApplied = true;
    this.saveNow();
    return { ok: true, future: f };
  }

  confirmFuture(futureId) {
    const f = this.futures.get(futureId);
    if (!f) return { ok: false, reason: 'no_existe' };
    if (f.status !== 'pending') return { ok: false, reason: 'no_pending' };
    f.status = 'open'; this.saveNow(); return { ok: true, future: f };
  }

  getFuture(futureId) { return this.futures.get(futureId) || null; }

  getFutures({ profileId = null, status = null, seasonMonth = null } = {}) {
    const out = [];
    for (const f of this.futures.values()) {
      if (profileId && f.profileId !== profileId) continue;
      if (status && f.status !== status) continue;
      if (seasonMonth && f.seasonMonth !== seasonMonth) continue;
      out.push(f);
    }
    return out;
  }

  getOpenFutures(seasonMonth) { return this.getFutures({ status: 'open', seasonMonth }); }

  settleFuture(futureId, { status, payout = 0, settledAt = Date.now() } = {}) {
    const f = this.futures.get(futureId);
    if (!f) return { ok: false, reason: 'no_existe' };
    if (f.status !== 'open') return { ok: true, future: f, alreadySettled: true };
    if (!['won', 'lost', 'void', 'cashed'].includes(status)) return { ok: false, reason: 'estado_invalido' };
    f.status = status; f.payout = Math.max(0, Math.floor(Number(payout) || 0)); f.settledAt = settledAt;
    if (f.market === 'balon_de_oro') f.payoutApplied = false;
    this.saveNow();
    return { ok: true, future: f };
  }

  voidFuture(futureId, { settledAt = Date.now(), payout = null } = {}) {
    const f = this.futures.get(futureId);
    if (!f) return { ok: false, reason: 'no_existe' };
    if (f.status === 'void') return { ok: true, future: f, alreadyVoid: true };
    if (['won', 'lost', 'cashed'].includes(f.status)) return { ok: false, reason: 'ya_liquidada' };
    f.status = 'void';
    f.settledAt = settledAt;
    if (payout != null) f.payout = Math.max(0, Math.floor(Number(payout) || 0));
    if (f.market === 'balon_de_oro') f.payoutApplied = false;
    this.saveNow();
    return { ok: true, future: f };
  }

  // --- Auditoría de cuotas (§10.4) ---

  appendOddsAudit(entry) {
    this.oddsAudit.push(entry);
    if (this.oddsAudit.length > ODDS_AUDIT_LIMIT) this.oddsAudit = this.oddsAudit.slice(-ODDS_AUDIT_LIMIT);
    return entry;
  }
}

module.exports = { FootballStore, DEFAULT_STORE_PATH, CARRYOVER, CLUB_IDS, ODDS_AUDIT_LIMIT };
