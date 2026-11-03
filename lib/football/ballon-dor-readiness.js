'use strict';

// Elegibilidad compartida por el ciclo y los stores JSON/PostgreSQL.
// El 90% exacto NO basta: con 240 partidos se necesitan al menos 217.
// Una edición parcial solo puede cerrarse con el archivo estadístico completo
// de sus 16 candidatos. Nunca se inventan ni se proyectan los partidos faltantes.
const {
  BALLON_DOR_CANDIDATE_COUNT, BALLON_DOR_REGULAR_MATCH_COUNT: REGULAR_MATCH_COUNT,
  BALLON_DOR_MIN_COMPLETION_PERCENT: MIN_COMPLETION_PERCENT,
  BALLON_DOR_MIN_SETTLED_MATCH_COUNT: MIN_SETTLED_MATCH_COUNT,
  cleanBallonDorEvent, calculateBallonDorPoints
} = require('./ballon-dor');
const { isRegularBallonDorMatch } = require('./ballon-dor-stats');
const { archivedContribution } = require('./ballon-dor-audit');

const STAT_KEYS = ['goals', 'assists', 'appearances', 'minutes', 'yellowCards', 'redCards'];

function hasValidSettlement(match, asOf) {
  return Boolean(match && match.status === 'settled' && match.result
    && Number.isSafeInteger(match.result.home) && match.result.home >= 0
    && Number.isSafeInteger(match.result.away) && match.result.away >= 0
    && Number.isSafeInteger(match.settledAt) && match.settledAt > 0
    && match.settledAt <= asOf);
}

function ballonDorReadiness(league, { asOf = Infinity } = {}) {
  const fail = (reason, extra = {}) => ({
    ok: false, reason, played: 0, total: REGULAR_MATCH_COUNT,
    minimum: MIN_SETTLED_MATCH_COUNT, matches: [], ...extra
  });
  if (!league || !Array.isArray(league.config) || league.config.length !== BALLON_DOR_CANDIDATE_COUNT
      || !league.calendar || !Array.isArray(league.calendar.matches)) return fail('calendario_incompleto');
  if (asOf !== Infinity && (!Number.isSafeInteger(asOf) || asOf < 1)) return fail('timestamp_invalido');

  const clubIds = new Set(league.config.map(club => club && club.id));
  const regular = league.calendar.matches.filter(isRegularBallonDorMatch);
  const perClub = new Map([...clubIds].map(id => [id, 0]));
  const perRound = new Map();
  for (const match of regular) {
    perClub.set(match.homeId, (perClub.get(match.homeId) || 0) + 1);
    perClub.set(match.awayId, (perClub.get(match.awayId) || 0) + 1);
    perRound.set(match.jornada, (perRound.get(match.jornada) || 0) + 1);
  }
  if (clubIds.size !== BALLON_DOR_CANDIDATE_COUNT || [...clubIds].some(id => typeof id !== 'string' || !id)
      || regular.length !== REGULAR_MATCH_COUNT
      || new Set(regular.map(match => match.id)).size !== REGULAR_MATCH_COUNT
      || regular.some(match => !match.id || match.seasonMonth !== league.seasonMonth
        || match.homeId === match.awayId || !clubIds.has(match.homeId) || !clubIds.has(match.awayId))
      || [...perClub.values()].some(count => count !== 30)
      || [...perRound.values()].some(count => count !== 8)) return fail('calendario_incompleto');

  const event = cleanBallonDorEvent(league.ballonDor, league.seasonMonth);
  if (!event || event.candidates.some(candidate => !clubIds.has(candidate.clubId))) return fail('candidatos_invalidos');
  const matches = regular.filter(match => hasValidSettlement(match, asOf));
  const played = matches.length;
  const summary = { played, total: regular.length, minimum: MIN_SETTLED_MATCH_COUNT };
  // Comparación entera, sin redondear: 216/240 = 90% sigue siendo insuficiente.
  if (played * 100 <= regular.length * MIN_COMPLETION_PERCENT) {
    return fail('cobertura_insuficiente', summary);
  }
  if (played === regular.length) {
    // Compatibilidad con ediciones completas históricas que no archivaban todos
    // los campos de fantasía. La relajación parcial nunca degrada esa vía.
    return { ...summary, ok: true, reason: null, complete: true, matches, event };
  }

  const archivedLeague = { ...league, calendar: { ...league.calendar, matches } };
  const candidates = [];
  for (const candidate of event.candidates) {
    const archived = archivedContribution(archivedLeague, candidate);
    if (!archived.complete || !archived.minutesComplete || !archived.yellowsComplete || archived.matches < 1) {
      return fail('estadisticas_insuficientes', summary);
    }
    const stats = Object.fromEntries(STAT_KEYS.map(key => [key, archived.totals[key]]));
    let points;
    try { points = calculateBallonDorPoints(stats, candidate.points.teamBonus); }
    catch (_) { return fail('estadisticas_insuficientes', summary); }
    candidates.push({ ...candidate, stats, points });
  }
  // Foto del corte: si un acta tardía llega después de `asOf`, no cambia el
  // premio. El archivo verificado permite reconstruir exactamente sus 16 filas.
  const snapshot = cleanBallonDorEvent({ ...event, candidates }, league.seasonMonth);
  if (!snapshot) return fail('estadisticas_insuficientes', summary);
  return {
    ...summary, ok: true, reason: null, complete: false, matches, event: snapshot,
    coverage: { played, total: regular.length, minimum: MIN_SETTLED_MATCH_COUNT }
  };
}

module.exports = {
  BALLON_DOR_REGULAR_MATCH_COUNT: REGULAR_MATCH_COUNT,
  BALLON_DOR_MIN_COMPLETION_PERCENT: MIN_COMPLETION_PERCENT,
  BALLON_DOR_MIN_SETTLED_MATCH_COUNT: MIN_SETTLED_MATCH_COUNT,
  hasValidSettlement,
  ballonDorReadiness
};
