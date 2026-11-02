'use strict';

// Fase A — Piezas compartidas del store de fútbol (§13.1).
//
// Igual que lib/profile-store-shared.js para los perfiles, aquí vive la limpieza
// y normalización que el backend de archivo (football-store.js) y el de Postgres
// (football-store-pg.js, Fase F) deben aplicar IDÉNTICAMENTE sin importar dónde
// se guarden los datos. También incluye la tabla de posiciones, que es pura y
// determinista: se deriva de los partidos asentados, nunca se acumula a mano
// (misma filosofía que §3.2 — el estado se recalcula, no se arrastra).

// La zona horaria y la clave de temporada mensual son las canónicas del casino;
// se reexportan para que todo el módulo de fútbol use UNA sola definición y no
// haya deriva entre el reset mensual de fichas y el cierre de la liga (§5.2).
const { monthKey, calendarParts, CASINO_TIME_ZONE } = require('./profile-store-shared');
const { daysInMonth, parseSeasonMonth } = require('./football/fixtures');
const { cleanBallonDorEvent } = require('./football/ballon-dor');
const { cleanFantasyStats } = require('./football/fantasy');
const { cleanHighlights } = require('./football/highlights');
const { cleanCommitment } = require('./football/v2/commitment');
const { cleanPolicy } = require('./football/v2/season-policy');
const { INITIAL_LEAGUE_AVG, INITIAL_HOME_ADV } = require('./football/ratings');

// --- Estados (§6.1) ---
const MATCH_STATUS = ['scheduled', 'live', 'halftime', 'extra_time', 'shootout', 'finished', 'settled', 'postponed'];
const BET_STATUS = ['pending', 'open', 'won', 'lost', 'void', 'cashed'];
const MARKET_STATUS = ['open', 'suspended', 'closed', 'settled', 'void'];

// Puntos por resultado (§5.1): 3 ganar, 1 empatar, 0 perder.
const POINTS_WIN = 3;
const POINTS_DRAW = 1;

function normalizeSeasonMonth(value) {
  const { year, month } = parseSeasonMonth(value);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function toInt(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toStr(value, fallback = '') {
  return typeof value === 'string' && value.length ? value : fallback;
}

// Insumos CONGELADOS con los que se generó la línea de tiempo de un partido
// (§3.2). Se persisten junto al partido porque el generador NO depende solo del
// seed: λ sale de los ratings de los clubes y del contexto rodante de la liga
// (leagueAvg/homeAdv), y ambos cambian cada vez que se asienta un resultado. Sin
// esta foto, regenerar el mismo seed después produce OTRO partido — otro
// marcador — y la pantalla termina contradiciendo al resultado asentado, a la
// tabla y a las apuestas.
function cleanGenerationInputs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const ratings = value => (value && typeof value === 'object' ? {
    elo: num(value.elo, 1500),
    att: num(value.att, 1),
    def: num(value.def, 1),
    gk: num(value.gk, 1)
  } : null);
  const home = ratings(raw.home);
  const away = ratings(raw.away);
  if (!home || !away) return null;
  const rho = raw.rho == null ? NaN : Number(raw.rho);
  const frozenAt = Number(raw.frozenAt);
  return {
    leagueAvg: num(raw.leagueAvg, INITIAL_LEAGUE_AVG),
    homeAdv: num(raw.homeAdv, INITIAL_HOME_ADV),
    rho: Number.isFinite(rho) ? rho : null,
    home,
    away,
    frozenAt: Number.isFinite(frozenAt) ? Math.floor(frozenAt) : null
  };
}

// Diario de la Quiniela (league.quiniela): bote acumulado y rondas con boletos.
// Defensivo como el resto del store: cualquier campo inválido se descarta entero
// (el boleto que no se pueda reconstruir se anula en la liquidación, nunca se
// inventa). El resultado público del round nunca trae profileIds.
const QUINIELA_PICKS = new Set(['home', 'draw', 'away']);
const QUINIELA_TICKET_STATUS = new Set(['pending_debit', 'open', 'won', 'lost', 'refunded']);
const QUINIELA_ROUND_STATUS = new Set(['open', 'settled', 'cancelled']);
function cleanQuiniela(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const carry = raw.bank && Number.isFinite(raw.bank.carry) && raw.bank.carry >= 0 ? Math.floor(raw.bank.carry) : 0;
  const rounds = {};
  if (raw.rounds && typeof raw.rounds === 'object') {
    for (const [key, r] of Object.entries(raw.rounds)) {
      const jornada = Number(key);
      if (!Number.isSafeInteger(jornada) || jornada < 1 || !r || typeof r !== 'object') continue;
      if (!Array.isArray(r.matchIds) || !r.matchIds.length || !r.matchIds.every(id => typeof id === 'string' && id.length <= 80)) continue;
      if (!Number.isSafeInteger(r.closesAt)) continue;
      if (!QUINIELA_ROUND_STATUS.has(r.status)) continue;
      const tickets = {};
      if (r.tickets && typeof r.tickets === 'object') {
        for (const [pid, t] of Object.entries(r.tickets)) {
          if (typeof pid !== 'string' || !pid || pid.length > 200 || !t || typeof t !== 'object') continue;
          if (!Array.isArray(t.picks) || !t.picks.length || t.picks.length > 16) continue;
          if (!t.picks.every(p => p && typeof p.matchId === 'string' && QUINIELA_PICKS.has(p.pick))) continue;
          if (!Number.isSafeInteger(t.placedAt)) continue;
          if (!QUINIELA_TICKET_STATUS.has(t.status)) continue;
          tickets[pid] = {
            profileId: pid,
            picks: t.picks.map(p => ({ matchId: p.matchId, pick: p.pick })),
            placedAt: t.placedAt,
            status: t.status,
            payout: Number.isFinite(t.payout) && t.payout >= 0 ? Math.floor(t.payout) : 0
          };
        }
      }
      rounds[jornada] = {
        season: toStr(r.season, ''),
        jornada,
        matchIds: r.matchIds.slice(),
        closesAt: r.closesAt,
        status: r.status,
        result: r.result && typeof r.result === 'object' ? r.result : null,
        tickets
      };
    }
  }
  return { bank: { carry }, rounds };
}

// Normaliza un partido persistido. Defensivo como cleanProfile: un JSON viejo o
// corrupto no debe tumbar el arranque. `timeline` NO se persiste (§13.2) — se
// regenera desde el seed en Fase B — así que aquí nunca se guarda. Lo que SÍ se
// guarda son los insumos congelados de esa generación (`generationInputs`), que
// son lo que hace determinista la regeneración.
function cleanMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = MATCH_STATUS.includes(raw.status) ? raw.status : 'scheduled';
  // El resultado asentado guarda también el descanso, el primer goleador y el
  // conteo de tarjetas: son la foto contra la que se liquidan sus mercados. Si el
  // partido se asentó sin cronología verificada no vienen, y esos boletos se
  // anulan (nunca se rellena un dato inventado).
  const resultCards = raw.result ? cleanCards(raw.result.cards) : null;
  const result = raw.result && Number.isFinite(raw.result.home) && Number.isFinite(raw.result.away)
    ? {
      home: toInt(raw.result.home), away: toInt(raw.result.away), winner: toStr(raw.result.winner, null),
      ...(raw.result.halftime && Number.isFinite(raw.result.halftime.home) && Number.isFinite(raw.result.halftime.away)
        ? { halftime: { home: toInt(raw.result.halftime.home), away: toInt(raw.result.halftime.away) } } : {}),
      ...(raw.result.firstScorer === null ? { firstScorer: null } : cleanFirstScorer(raw.result.firstScorer)),
      ...(resultCards ? { cards: resultCards } : {})
    }
    : null;
  return {
    id: toStr(raw.id),
    seasonMonth: toStr(raw.seasonMonth),
    jornada: toInt(raw.jornada, 1),
    block: toStr(raw.block, 'estelar'),
    featured: Boolean(raw.featured),
    // El desempate por el campeonato puede elegir la bonificación del premio,
    // pero nunca aporta minutos, goles, asistencias ni tarjetas individuales.
    desempate: Boolean(raw.desempate),
    homeId: toStr(raw.homeId),
    awayId: toStr(raw.awayId),
    seed: toInt(raw.seed, 0) >>> 0,
    // Foto de ratings/contexto con la que se generó la línea de tiempo. Los
    // partidos anteriores a esta corrección no la tienen: el motor la crea la
    // primera vez y, si el partido ya tiene resultado, lo usa como marcador
    // forzado (ver engine._ensureTimeline).
    generationInputs: cleanGenerationInputs(raw.generationInputs),
    scheduledKickoffAt: toInt(raw.scheduledKickoffAt, 0),
    day: toInt(raw.day, 1),
    wave: toInt(raw.wave, 0),
    actualKickoffAt: raw.actualKickoffAt == null ? null : toInt(raw.actualKickoffAt),
    ...(Number.isSafeInteger(raw.autoRescheduledAt) && raw.autoRescheduledAt > 0
      ? { autoRescheduledAt: raw.autoRescheduledAt, autoReschedulePreviousKickoffAt: toInt(raw.autoReschedulePreviousKickoffAt, 0) } : {}),
    status,
    result,
    fantasyStats: status === 'settled' ? cleanFantasyStats(raw.fantasyStats, raw) : null,
    highlights: status === 'settled' ? cleanHighlights(raw.highlights, { result }) : null,
    settledAt: raw.settledAt == null ? null : toInt(raw.settledAt),
    ...(raw.simulation == null ? {} : { simulation: cleanCommitment(raw.simulation, raw) })
  };
}

// Normaliza una liga persistida. `config` son los 16 clubes de la temporada,
// `calendar` el calendario generado, `standings` la tabla (recalculable).
function cleanLeague(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = ['active', 'closed', 'truncated'].includes(raw.status) ? raw.status : 'active';
  const seasonMonth = normalizeSeasonMonth(toStr(raw.seasonMonth, monthKey()));
  return {
    seasonMonth,
    seed: toInt(raw.seed, 0) >>> 0,
    ...(raw.simulationPolicy == null ? {} : { simulationPolicy: cleanPolicy(raw.simulationPolicy, seasonMonth) }),
    config: Array.isArray(raw.config) ? raw.config : [],
    calendar: raw.calendar && typeof raw.calendar === 'object' ? raw.calendar : null,
    standings: Array.isArray(raw.standings) ? raw.standings : [],
    carryover: raw.carryover && typeof raw.carryover === 'object' ? raw.carryover : {},
    // Las temporadas antiguas no tenían premio: se conservan sin inventar un
    // evento retroactivo. Los ciclos nuevos reciben el evento al generarse.
    ballonDor: raw.ballonDor == null ? null : cleanBallonDorEvent(raw.ballonDor, seasonMonth),
    // Diario de la quiniela (§Quiniela): viaja con la liga en archivo y PG.
    quiniela: cleanQuiniela(raw.quiniela),
    // Contexto rodante de la liga (leagueAvg/homeAdv, §10.1). Se preserva tal
    // cual; el store lo rellena con los valores iniciales si falta.
    ctx: raw.ctx && typeof raw.ctx === 'object' ? raw.ctx : null,
    status,
    createdAt: toInt(raw.createdAt, Date.now()),
    closedAt: raw.closedAt == null ? null : toInt(raw.closedAt)
  };
}

// Celdas del mercado de marcador exacto ("1-0", "2-2"…) que se publicaron cuando
// se colocó la apuesta. Se guardan con la apuesta porque la selección `other`
// significa "fuera de ESTAS doce", no de las que la matriz dé al liquidar.
function cleanCorrectScoreCells(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 40) return null;
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !/^\d{1,2}-\d{1,2}$/.test(item) || out.includes(item)) return null;
    out.push(item);
  }
  return out;
}

// Primer goleador asentado: { id, name, team, minute } o null si no hubo goles.
// Un gol en propia puerta se guarda con ownGoal y sin id (ningún boleto cobra).
function cleanFirstScorer(raw) {
  if (!raw || typeof raw !== 'object') return {};
  // El reloj V2 tiene fracciones de minuto; no truncar la cronología al recargar.
  const minute = raw.minute != null && Number.isFinite(Number(raw.minute)) && Number(raw.minute) >= 0
    ? Number(raw.minute) : null;
  if (raw.ownGoal) return { firstScorer: { id: null, name: toStr(raw.name, ''), team: raw.team === 'away' ? 'away' : 'home', minute, ownGoal: true } };
  const id = toStr(raw.id, null);
  if (!id) return {};
  return {
    firstScorer: {
      id,
      name: toStr(raw.name, ''),
      team: raw.team === 'away' ? 'away' : 'home',
      minute
    }
  };
}

// Conteo de tarjetas asentado: { yellow, red, homeYellow, awayYellow, homeRed,
// awayRed }. Son la foto contra la que se liquidan los mercados de tarjetas;
// si falta algún campo (partido viejo) no se devuelve y el boleto se anula.
function cleanCards(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fields = ['yellow', 'red', 'homeYellow', 'awayYellow', 'homeRed', 'awayRed'];
  const out = {};
  for (const key of fields) {
    if (!Number.isFinite(raw[key]) || raw[key] < 0) return null;
    out[key] = toInt(raw[key]);
  }
  return out;
}

// Jugadores ofrecidos en el mercado de primer goleador: la selección `other`
// significa «fuera de ESTA lista», así que viaja con el boleto (igual que las
// celdas del marcador exacto).
function cleanFirstScorerIds(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 40) return null;
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item || item.length > 64 || out.includes(item)) return null;
    out.push(item);
  }
  return out;
}

function cleanBet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bet = {
    id: toStr(raw.id),
    idempotencyKey: toStr(raw.idempotencyKey),
    profileId: toStr(raw.profileId),
    deviceToken: raw.deviceToken == null ? null : toStr(raw.deviceToken),
    matchId: toStr(raw.matchId),
    ...(/^\d{4}-(0[1-9]|1[0-2])$/.test(String(raw.seasonMonth || '')) ? { seasonMonth: raw.seasonMonth } : {}),
    market: toStr(raw.market),
    selection: toStr(raw.selection),
    ...(/^[0-9a-f]{64}$/i.test(String(raw.simulationId || '')) ? { simulationId: raw.simulationId } : {}),
    stake: toInt(raw.stake, 0),
    oddsAtPlacement: Number(raw.oddsAtPlacement) || 1,
    placedAt: toInt(raw.placedAt, Date.now()),
    minuteAtPlacement: raw.minuteAtPlacement == null ? null : toInt(raw.minuteAtPlacement),
    inPlay: Boolean(raw.inPlay),
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open',
    ...(typeof raw.payoutApplied === 'boolean' ? { payoutApplied: raw.payoutApplied } : {}),
    ...(typeof raw.payoutReason === 'string' ? { payoutReason: raw.payoutReason.slice(0, 160) } : {}),
    ...(raw.escrowProtocol === 'durable-1' ? { escrowProtocol: 'durable-1' } : {}),
    // WAL del backend de archivo (A8): marca que el débito ya salió del perfil.
    // Una apuesta `pending` con debited=true se reembolsa al reconciliar; sin él,
    // solo se anula. En PG la atomicidad la da la transacción y este campo sobra.
    debited: Boolean(raw.debited),
    potentialPayout: toInt(raw.potentialPayout, 0),
    cashoutAvailable: Boolean(raw.cashoutAvailable),
    settledAt: raw.settledAt == null ? null : toInt(raw.settledAt),
    payout: raw.payout == null ? null : toInt(raw.payout),
    parlayId: raw.parlayId == null ? null : toStr(raw.parlayId)
  };
  // Solo las apuestas de marcador exacto lo llevan; las demás conservan su forma.
  const cells = cleanCorrectScoreCells(raw.correctScoreCells);
  if (cells) bet.correctScoreCells = cells;
  const scorers = cleanFirstScorerIds(raw.firstScorerIds);
  if (scorers) bet.firstScorerIds = scorers;
  return bet;
}

function cleanParlayLeg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const leg = {
    matchId: toStr(raw.matchId),
    market: toStr(raw.market),
    selection: toStr(raw.selection),
    ...(/^[0-9a-f]{64}$/i.test(String(raw.simulationId || '')) ? { simulationId: raw.simulationId } : {}),
    oddsAtPlacement: Number(raw.oddsAtPlacement) || 1,
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open'
  };
  const cells = cleanCorrectScoreCells(raw.correctScoreCells);
  if (cells) leg.correctScoreCells = cells;
  const scorers = cleanFirstScorerIds(raw.firstScorerIds);
  if (scorers) leg.firstScorerIds = scorers;
  return leg;
}

function cleanParlay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const legs = Array.isArray(raw.legs) ? raw.legs.map(cleanParlayLeg).filter(Boolean) : [];
  if (!legs.length) return null;
  return {
    id: toStr(raw.id),
    ...(typeof raw.idempotencyKey === 'string' && raw.idempotencyKey.length <= 256
      ? { idempotencyKey: raw.idempotencyKey } : {}),
    profileId: toStr(raw.profileId),
    seasonMonth: toStr(raw.seasonMonth),
    legs,
    combinedOdds: Number(raw.combinedOdds) || 1,
    stake: toInt(raw.stake, 0),
    potentialPayout: toInt(raw.potentialPayout, 0),
    debited: Boolean(raw.debited),
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open',
    ...(typeof raw.payoutApplied === 'boolean' ? { payoutApplied: raw.payoutApplied } : {}),
    ...(typeof raw.payoutReason === 'string' ? { payoutReason: raw.payoutReason.slice(0, 160) } : {}),
    ...(raw.escrowProtocol === 'durable-1' ? { escrowProtocol: 'durable-1' } : {}),
    payout: raw.payout == null ? null : toInt(raw.payout),
    placedAt: toInt(raw.placedAt, Date.now()),
    settledAt: raw.settledAt == null ? null : toInt(raw.settledAt)
  };
}

function cleanFuture(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: toStr(raw.id),
    idempotencyKey: toStr(raw.idempotencyKey).slice(0, 128),
    profileId: toStr(raw.profileId),
    seasonMonth: toStr(raw.seasonMonth),
    market: toStr(raw.market),
    selection: toStr(raw.selection),
    ...(/^[0-9a-f]{64}$/i.test(String(raw.simulationPolicyId || '')) ? { simulationPolicyId: raw.simulationPolicyId } : {}),
    ...(Array.isArray(raw.simulationCommitments) ? { simulationCommitments: raw.simulationCommitments
      .filter(item => item && typeof item.matchId === 'string' && item.matchId.length <= 120
        && /^[0-9a-f]{64}$/i.test(String(item.id || '')))
      .slice(0, 300).map(item => ({ matchId: item.matchId, id: item.id })) } : {}),
    odds: Number(raw.odds) || 1,
    stake: toInt(raw.stake, 0),
    potentialPayout: toInt(raw.potentialPayout, 0),
    debited: Boolean(raw.debited),
    payoutApplied: Boolean(raw.payoutApplied),
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open',
    ...(typeof raw.payoutReason === 'string' ? { payoutReason: raw.payoutReason.slice(0, 160) } : {}),
    ...(raw.escrowProtocol === 'durable-1' ? { escrowProtocol: 'durable-1' } : {}),
    payout: raw.payout == null ? null : toInt(raw.payout),
    placedAtJornada: toInt(raw.placedAtJornada, 0),
    placedAt: toInt(raw.placedAt, Date.now()),
    settledAt: raw.settledAt == null ? null : toInt(raw.settledAt)
  };
}

// --- Tabla de posiciones (§5.1) ---
// Se deriva de los partidos asentados, en orden cronológico. Nunca se acumula a
// mano: si un resultado se corrige, se recalcula toda la tabla y queda coherente.

function emptyStandingsRow(teamId) {
  return {
    teamId, played: 0, won: 0, drawn: 0, lost: 0,
    goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0,
    form: [], streak: { type: null, count: 0 }
  };
}

function emptyStandings(teamIds) {
  return teamIds.map(emptyStandingsRow);
}

function pushForm(row, letter) {
  row.form.push(letter);
  if (row.form.length > 5) row.form.shift(); // últimos 5 (§5.1)
  if (row.streak.type === letter) row.streak.count += 1;
  else row.streak = { type: letter, count: 1 };
}

// Orden cronológico estable: por jornada y luego por kickoff programado.
function byChronology(a, b) {
  return (a.jornada - b.jornada) || (a.scheduledKickoffAt - b.scheduledKickoffAt);
}

// Construye la tabla a partir de los partidos con result ya asentado.
function buildStandings(matches, teamIds) {
  const rows = new Map(teamIds.map(id => [id, emptyStandingsRow(id)]));
  const settled = (Array.isArray(matches) ? matches : [])
    .filter(match => match && !match.desempate && match.result
      && Number.isFinite(match.result.home) && Number.isFinite(match.result.away))
    .sort(byChronology);

  for (const match of settled) {
    const home = rows.get(match.homeId);
    const away = rows.get(match.awayId);
    if (!home || !away) continue;
    const gh = match.result.home;
    const ga = match.result.away;

    home.played++; away.played++;
    home.goalsFor += gh; home.goalsAgainst += ga;
    away.goalsFor += ga; away.goalsAgainst += gh;

    if (gh > ga) {
      home.won++; away.lost++;
      home.points += POINTS_WIN;
      pushForm(home, 'W'); pushForm(away, 'L');
    } else if (gh < ga) {
      away.won++; home.lost++;
      away.points += POINTS_WIN;
      pushForm(away, 'W'); pushForm(home, 'L');
    } else {
      home.drawn++; away.drawn++;
      home.points += POINTS_DRAW; away.points += POINTS_DRAW;
      pushForm(home, 'D'); pushForm(away, 'D');
    }
  }

  for (const row of rows.values()) {
    row.goalDiff = row.goalsFor - row.goalsAgainst;
  }
  return sortStandings([...rows.values()]);
}

// Ordena por el desempate de §5.1: puntos → diferencia de goles → goles a favor.
// El «resultado directo» es el último recurso y solo importa para decidir el 1.º
// puesto (A14); como no es transitivo para >2 equipos, no se mete en el
// comparador general — se resuelve aparte con headToHead() al cierre (§7.5).
// Cierre determinista: goles en contra (asc) y luego id de club.
function sortStandings(rows) {
  return rows.slice().sort((a, b) =>
    (b.points - a.points) ||
    (b.goalDiff - a.goalDiff) ||
    (b.goalsFor - a.goalsFor) ||
    (a.goalsAgainst - b.goalsAgainst) ||
    String(a.teamId).localeCompare(String(b.teamId))
  );
}

// Puntos del resultado directo entre dos clubes en los partidos ya jugados:
// devuelve { a, b } con los puntos que cada uno sumó en sus enfrentamientos.
// Lo usa la lógica de cierre para decidir si el 1.º puesto sigue empatado y hay
// que jugar el partido de desempate (§7.5, A14).
function headToHead(matches, teamA, teamB) {
  const tally = { a: 0, b: 0 };
  for (const match of (Array.isArray(matches) ? matches : [])) {
    if (!match || match.desempate || !match.result) continue;
    const involves = (match.homeId === teamA && match.awayId === teamB) || (match.homeId === teamB && match.awayId === teamA);
    if (!involves) continue;
    const homeIsA = match.homeId === teamA;
    const gh = match.result.home;
    const ga = match.result.away;
    if (gh === ga) { tally.a += POINTS_DRAW; tally.b += POINTS_DRAW; continue; }
    const homeWon = gh > ga;
    if (homeIsA) { if (homeWon) tally.a += POINTS_WIN; else tally.b += POINTS_WIN; }
    else { if (homeWon) tally.b += POINTS_WIN; else tally.a += POINTS_WIN; }
  }
  return tally;
}

module.exports = {
  monthKey,
  calendarParts,
  CASINO_TIME_ZONE,
  daysInMonth,
  parseSeasonMonth,
  normalizeSeasonMonth,
  MATCH_STATUS,
  BET_STATUS,
  MARKET_STATUS,
  POINTS_WIN,
  POINTS_DRAW,
  cleanMatch,
  cleanGenerationInputs,
  cleanLeague,
  cleanQuiniela,
  cleanFirstScorer, cleanFirstScorerIds, cleanBet,
  cleanParlay,
  cleanParlayLeg,
  cleanFuture,
  emptyStandings,
  emptyStandingsRow,
  buildStandings,
  sortStandings,
  headToHead,
  byChronology
};
