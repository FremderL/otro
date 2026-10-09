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

// Normaliza un partido persistido. Defensivo como cleanProfile: un JSON viejo o
// corrupto no debe tumbar el arranque. `timeline` NO se persiste (§13.2) — se
// regenera desde el seed en Fase B — así que aquí nunca se guarda.
function cleanMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = MATCH_STATUS.includes(raw.status) ? raw.status : 'scheduled';
  const result = raw.result && Number.isFinite(raw.result.home) && Number.isFinite(raw.result.away)
    ? { home: toInt(raw.result.home), away: toInt(raw.result.away), winner: toStr(raw.result.winner, null) }
    : null;
  return {
    id: toStr(raw.id),
    seasonMonth: toStr(raw.seasonMonth),
    jornada: toInt(raw.jornada, 1),
    block: toStr(raw.block, 'estelar'),
    featured: Boolean(raw.featured),
    homeId: toStr(raw.homeId),
    awayId: toStr(raw.awayId),
    seed: toInt(raw.seed, 0) >>> 0,
    scheduledKickoffAt: toInt(raw.scheduledKickoffAt, 0),
    day: toInt(raw.day, 1),
    wave: toInt(raw.wave, 0),
    actualKickoffAt: raw.actualKickoffAt == null ? null : toInt(raw.actualKickoffAt),
    status,
    result,
    settledAt: raw.settledAt == null ? null : toInt(raw.settledAt)
  };
}

// Normaliza una liga persistida. `config` son los 16 clubes de la temporada,
// `calendar` el calendario generado, `standings` la tabla (recalculable).
function cleanLeague(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = ['active', 'closed', 'truncated'].includes(raw.status) ? raw.status : 'active';
  return {
    seasonMonth: normalizeSeasonMonth(toStr(raw.seasonMonth, monthKey())),
    seed: toInt(raw.seed, 0) >>> 0,
    config: Array.isArray(raw.config) ? raw.config : [],
    calendar: raw.calendar && typeof raw.calendar === 'object' ? raw.calendar : null,
    standings: Array.isArray(raw.standings) ? raw.standings : [],
    carryover: raw.carryover && typeof raw.carryover === 'object' ? raw.carryover : {},
    // Contexto rodante de la liga (leagueAvg/homeAdv, §10.1). Se preserva tal
    // cual; el store lo rellena con los valores iniciales si falta.
    ctx: raw.ctx && typeof raw.ctx === 'object' ? raw.ctx : null,
    status,
    createdAt: toInt(raw.createdAt, Date.now()),
    closedAt: raw.closedAt == null ? null : toInt(raw.closedAt)
  };
}

function cleanBet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: toStr(raw.id),
    idempotencyKey: toStr(raw.idempotencyKey),
    profileId: toStr(raw.profileId),
    deviceToken: raw.deviceToken == null ? null : toStr(raw.deviceToken),
    matchId: toStr(raw.matchId),
    market: toStr(raw.market),
    selection: toStr(raw.selection),
    stake: toInt(raw.stake, 0),
    oddsAtPlacement: Number(raw.oddsAtPlacement) || 1,
    placedAt: toInt(raw.placedAt, Date.now()),
    minuteAtPlacement: raw.minuteAtPlacement == null ? null : toInt(raw.minuteAtPlacement),
    inPlay: Boolean(raw.inPlay),
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open',
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
}

function cleanParlayLeg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    matchId: toStr(raw.matchId),
    market: toStr(raw.market),
    selection: toStr(raw.selection),
    oddsAtPlacement: Number(raw.oddsAtPlacement) || 1,
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open'
  };
}

function cleanParlay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const legs = Array.isArray(raw.legs) ? raw.legs.map(cleanParlayLeg).filter(Boolean) : [];
  if (!legs.length) return null;
  return {
    id: toStr(raw.id),
    profileId: toStr(raw.profileId),
    seasonMonth: toStr(raw.seasonMonth),
    legs,
    combinedOdds: Number(raw.combinedOdds) || 1,
    stake: toInt(raw.stake, 0),
    potentialPayout: toInt(raw.potentialPayout, 0),
    debited: Boolean(raw.debited),
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open',
    payout: raw.payout == null ? null : toInt(raw.payout),
    placedAt: toInt(raw.placedAt, Date.now()),
    settledAt: raw.settledAt == null ? null : toInt(raw.settledAt)
  };
}

function cleanFuture(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: toStr(raw.id),
    profileId: toStr(raw.profileId),
    seasonMonth: toStr(raw.seasonMonth),
    market: toStr(raw.market),
    selection: toStr(raw.selection),
    odds: Number(raw.odds) || 1,
    stake: toInt(raw.stake, 0),
    potentialPayout: toInt(raw.potentialPayout, 0),
    debited: Boolean(raw.debited),
    status: BET_STATUS.includes(raw.status) ? raw.status : 'open',
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
    .filter(match => match && match.result && Number.isFinite(match.result.home) && Number.isFinite(match.result.away))
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
    if (!match || !match.result) continue;
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
  cleanLeague,
  cleanBet,
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
