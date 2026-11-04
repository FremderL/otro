'use strict';

// MonteCristo News — edición diaria inmutable y guion causal.
// No simula partidos, no mueve fichas y no rellena días ausentes. Consume las
// mismas fuentes autoritativas que el tablero de clubes y el mercado.
const { calendarParts, CASINO_TIME_ZONE, monthKey } = require('../football-store-shared');
const { buildClubNews } = require('./club-news');
const { publicTransfers } = require('./transfers');
const { evaluateSeasonManagers } = require('./managers');
const { CLUB_BY_ID } = require('./teams');

const DAILY_NEWS_VERSION = 1;
const MAX_ITEMS = 7;
const MAX_SCRIPT_CHARS = 1900;
const RECOVERED_DELAY_MS = 2 * 60 * 60 * 1000;

function dayKey(at, timeZone = CASINO_TIME_ZONE) {
  const p = calendarParts(new Date(at), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
function previousDay(day) {
  const at = Date.parse(`${day}T12:00:00Z`) - 86400000;
  return new Date(at).toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))) return 0;
  return Math.max(0, Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000));
}
function nameOf(id, league) {
  return league?.config?.find(c => c.id === id)?.name || CLUB_BY_ID[id]?.name || 'Club';
}
function officialResult(match) {
  if (!match || match.status !== 'settled' || !match.result) return null;
  const home = Number(match.result.home), away = Number(match.result.away);
  if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) return null;
  return { home, away };
}
function localDate(at, timeZone) {
  return Number.isSafeInteger(at) && at > 0 ? dayKey(at, timeZone) : null;
}
function dateLabel(day) {
  if (!day) return 'fecha no disponible';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${day}T12:00:00Z`));
}
function timeLabel(at, timeZone) {
  return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(at));
}
function allMatches(leagues, cutoff) {
  return leagues.flatMap(league => (league?.calendar?.matches || [])
    .filter(match => officialResult(match) && Number.isSafeInteger(match.settledAt) && match.settledAt <= cutoff));
}
function resultImportance(match) {
  const score = officialResult(match);
  return (match.featured ? 20 : 0) + (match.desempate ? 30 : 0)
    + score.home + score.away + (Math.abs(score.home - score.away) <= 1 ? 8 : 0);
}
function resultItem(match, league, recovered, timeZone) {
  const score = officialResult(match);
  const homeName = nameOf(match.homeId, league), awayName = nameOf(match.awayId, league);
  const scheduledDay = localDate(match.scheduledKickoffAt, timeZone);
  const settledDay = localDate(match.settledAt, timeZone);
  const scoreText = `${homeName} ${score.home}, ${awayName} ${score.away}`;
  const when = recovered
    ? `Jornada del ${dateLabel(scheduledDay)}; resultado incorporado el ${dateLabel(settledDay)} tras la recuperación.`
    : `Jornada del ${dateLabel(scheduledDay)} · Resultado oficial.`;
  return {
    id: `result:${match.id}`, type: 'match_result', priority: recovered ? 94 : 90,
    badge: recovered ? 'RESULTADO RECUPERADO' : 'RESULTADO OFICIAL',
    clubId: match.homeId, clubIds: [match.homeId, match.awayId], matchId: match.id,
    homeId: match.homeId, awayId: match.awayId, score,
    scheduledAt: match.scheduledKickoffAt, settledAt: match.settledAt,
    freshness: recovered ? 'recovered' : 'new', resultOnly: Boolean(match.resultOnly),
    headline: scoreText, subtitle: when,
    summary: `${scoreText}. ${when}`,
    spoken: recovered
      ? `Entre los resultados incorporados tras la recuperación figura ${scoreText}, correspondiente a la jornada del ${dateLabel(scheduledDay)}.`
      : `En la jornada del ${dateLabel(scheduledDay)}, ${scoreText}.`
  };
}

// Una identidad estable distingue un hecho de su seguimiento. Los ids existentes
// de liderato/presión incluyen PJ: son actualizaciones, no otro fichaje de DT.
function factIdentity(item) {
  return String(item.id || '').replace(/:(\d+)$/, ':*');
}
function clubFreshness(item, previousEdition, editionDay, league, previousLeague, timeZone, cutoff) {
  const old = (previousEdition?.clubNews || []).find(n => n.id === item.id);
  if (old) return 'context';
  let occurredAt = null;
  if (item.id.startsWith('coach-hired:') || item.type === 'prestige_alert') occurredAt = league.createdAt;
  if (item.type === 'season_champion') occurredAt = previousLeague?.closedAt || null;
  if (['tactical_shift', 'season_leader', 'coach_pressure'].includes(item.type)) {
    occurredAt = Math.max(0, ...(league.calendar?.matches || [])
      .filter(m => officialResult(m) && m.settledAt <= cutoff)
      .map(m => m.settledAt));
  }
  if (occurredAt && localDate(occurredAt, timeZone) === editionDay) return 'new';
  const familySeen = (previousEdition?.clubNews || []).some(n => factIdentity(n) === factIdentity(item));
  return familySeen ? 'update' : 'confirmed';
}
function dailyClubItem(item, freshness) {
  const prefix = freshness === 'context' ? 'En seguimiento. '
    : freshness === 'update' ? 'Se actualiza el panorama. '
      : freshness === 'new' ? 'Novedad confirmada. ' : 'Comunicado confirmado. ';
  return { ...item, freshness, spoken: prefix + String(item.spoken || item.summary || item.headline) };
}
function agendaItem(matches, day, cutoff, timeZone, league) {
  const scheduled = matches.filter(m => m.status === 'scheduled' && m.scheduledKickoffAt >= cutoff);
  const featured = scheduled.find(m => m.featured) || scheduled[0];
  const publicMatches = matches.slice(0, 16).map(m => ({
    id: m.id, homeId: m.homeId, awayId: m.awayId, status: m.status,
    scheduledKickoffAt: m.scheduledKickoffAt, featured: Boolean(m.featured),
    score: officialResult(m)
  }));
  const headline = matches.length ? `Cartelera del ${dateLabel(day)}` : `Día de cierre · ${dateLabel(day)}`;
  const detail = featured
    ? `${scheduled.length} encuentro${scheduled.length === 1 ? '' : 's'} programado${scheduled.length === 1 ? '' : 's'} al preparar la edición. Destacado: ${nameOf(featured.homeId, league)} contra ${nameOf(featured.awayId, league)}, ${timeLabel(featured.scheduledKickoffAt, timeZone)}.`
    : matches.length ? 'La cartelera de esta edición ya estaba en marcha al preparar el boletín. Consulta los marcadores oficiales en el Estadio.'
      : 'El calendario no registra jornada regular para esta fecha. No se inventan partidos de relleno.';
  return {
    id: `agenda:${day}`, type: 'daily_agenda', priority: 65, badge: 'CARTELERA DE LA EDICIÓN',
    clubId: featured?.homeId || null, clubIds: featured ? [featured.homeId, featured.awayId] : [],
    headline, subtitle: 'Horario del Estadio · consulta el estado actual en la cartelera',
    summary: detail, spoken: detail, freshness: 'new', day, matches: publicMatches
  };
}

function buildDailyEdition({ league, previousLeague = null, leagues = [], at, fanRanking = [],
  previousEdition = null, operational = {}, timeZone = CASINO_TIME_ZONE } = {}) {
  if (!league?.config?.length || !league.calendar || !Number.isSafeInteger(at)) return null;
  const day = dayKey(at, timeZone);
  if (monthKey(new Date(at), timeZone) !== league.seasonMonth) return null;
  const knownLeagues = leagues.length ? leagues : [previousLeague, league].filter(Boolean);
  const settled = allMatches(knownLeagues, at);
  const yesterday = previousDay(day);
  const recent = settled.filter(m => localDate(m.scheduledKickoffAt, timeZone) === yesterday && !m.desempate);
  const recovered = settled.filter(m => !m.desempate
    && m.settledAt - m.scheduledKickoffAt > RECOVERED_DELAY_MS
    && localDate(m.scheduledKickoffAt, timeZone) < day
    && (operational.lastReadyAt != null ? m.settledAt > operational.lastReadyAt
      : localDate(m.settledAt, timeZone) === day && localDate(m.scheduledKickoffAt, timeZone) < yesterday));
  const gapDays = daysBetween(operational.lastReadyDay, day);
  const isReturn = gapDays > 1 || recovered.length > 0;
  const leagueOf = match => knownLeagues.find(l => l.seasonMonth === match.seasonMonth) || league;
  const selected = (isReturn && recovered.length ? recovered : recent).slice()
    .sort((a, b) => resultImportance(b) - resultImportance(a) || a.id.localeCompare(b.id));
  const items = [];
  if (isReturn) {
    const period = operational.lastReadyDay
      ? `Desde el último parte operativo del ${dateLabel(operational.lastReadyDay)} hasta el ${dateLabel(day)}.`
      : `Primera edición disponible tras revisar el archivo del Estadio, con corte del ${dateLabel(day)}.`;
    const summary = `${period} ${recovered.length ? `Se incorporaron ${recovered.length} resultados pendientes; destacamos los principales, sin reconstruir emisiones pasadas.` : 'No hubo una emisión diaria en cada fecha ausente. Retomamos con la información verificada disponible.'}`;
    items.push({ id: `return:${day}`, type: 'service_return', priority: 110, badge: 'EDICIÓN DE REGRESO',
      headline: 'Volvemos a MonteCristo News', subtitle: period, summary,
      spoken: `Volvemos a MonteCristo News. ${recovered.length ? `Tras recuperar ${recovered.length} resultados pendientes, esta es la situación verificada del Estadio.` : 'Retomamos con la información verificada disponible; no se emitieron boletines durante la ausencia.'}`,
      freshness: 'recovered', clubId: null, clubIds: [] });
  }
  selected.slice(0, 2).forEach(match => items.push(resultItem(match, leagueOf(match), isReturn && recovered.length > 0, timeZone)));
  if (selected.length > 2) {
    const count = selected.length, sourceDay = localDate(selected[0].scheduledKickoffAt, timeZone);
    items.push({ id: `results:${sourceDay}:${count}`, type: 'match_roundup', priority: 89,
      badge: 'RESUMEN DE JORNADA', headline: `${count} resultados confirmados`,
      subtitle: `Jornada del ${dateLabel(sourceDay)} · detalle completo en el Estadio`,
      summary: `Hay ${count} resultados oficiales en este resumen. Los marcadores completos pueden consultarse en el Estadio.`,
      spoken: `El archivo confirma ${count} resultados en este corte. Puedes consultar todos los marcadores en el Estadio.`,
      freshness: isReturn ? 'recovered' : 'new', clubId: null, clubIds: [] });
  }
  const clubNews = buildClubNews({ league, previousLeague, at, fanRanking });
  const rows = evaluateSeasonManagers(league, { asOf: at });
  if (rows[0]?.stats.played > 0) {
    const top = rows[0], oldTop = previousEdition?.table?.leaderClubId;
    const changed = Boolean(oldTop && oldTop !== top.clubId);
    const summary = `${top.clubName} ocupa el primer lugar con ${top.stats.points} puntos en ${top.stats.played} partidos, ${top.stats.wins} victorias y diferencia de goles de ${top.stats.goalDiff}.`;
    items.push({ id: `table:${league.seasonMonth}:${top.clubId}:${top.stats.played}`, type: 'daily_table',
      priority: changed ? 96 : 82, badge: changed ? 'CAMBIO EN LA CIMA' : 'ASÍ VA LA TABLA',
      headline: `${top.clubName} · ${top.stats.points} puntos`, subtitle: `${top.stats.played} PJ · ${top.stats.goalDiff} DG`,
      summary, spoken: changed ? `Hay nuevo líder: ${summary}` : summary,
      freshness: changed ? 'new' : 'update', clubId: top.clubId, clubIds: [top.clubId] });
  }
  const market = publicTransfers(league, at, { previousLeague, fanRanking });
  const marketNew = market.status === 'announced' && previousEdition?.market?.status !== 'announced';
  if (marketNew && market.moves.length) {
    items.push({ id: `market:${league.seasonMonth}`, type: 'transfer_roundup', priority: 105,
      badge: 'MERCADO DE FICHAJES', headline: `${market.moves.length} fichajes anunciados`,
      subtitle: `Entran en vigor en ${market.effectiveSeason} · conferencia completa disponible`,
      summary: `El mercado anunció ${market.moves.length} operaciones solicitadas por los DT. Entran en vigor en ${market.effectiveSeason}; sus valoraciones son informativas.`,
      spoken: `Protagonismo del mercado: ${market.moves.length} fichajes anunciados para ${market.effectiveSeason}. La conferencia completa permite conocer cada operación; las valoraciones no alteran partidos ni premios.`,
      freshness: 'new', clubId: market.moves[0].toId, clubIds: [...new Set(market.moves.map(m => m.toId))] });
  }
  const clubCandidates = clubNews.filter(n => n.type !== 'season_leader')
    .map(n => dailyClubItem(n, clubFreshness(n, previousEdition, day, league, previousLeague, timeZone, at)))
    .sort((a, b) => {
      const weight = item => item.freshness === 'new' ? 20 : item.freshness === 'confirmed' ? 10 : 0;
      return (b.priority + weight(b)) - (a.priority + weight(a)) || a.id.localeCompare(b.id);
    });
  for (const item of clubCandidates) {
    if (items.length >= MAX_ITEMS - 1) break;
    items.push(item);
  }
  const today = (league.calendar.matches || []).filter(m => !m.desempate
    && ['scheduled', 'live', 'halftime', 'extra_time', 'shootout'].includes(m.status)
    && m.scheduledKickoffAt >= at
    && localDate(m.scheduledKickoffAt, timeZone) === day);
  items.push(agendaItem(today, day, at, timeZone, league));
  // Acota también la duración hablada, no solo el número de tarjetas.
  const bounded = [];
  let chars = 0;
  for (const item of items.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    if (bounded.length >= MAX_ITEMS) break;
    if (item.type === 'daily_agenda' && chars + item.spoken.length > MAX_SCRIPT_CHARS - 240 && bounded.length) {
      item.spoken = 'Consulta la cartelera y los horarios de esta edición en el Estadio.';
    }
    if (chars + item.spoken.length > MAX_SCRIPT_CHARS - 180 && bounded.length >= 3) continue;
    bounded.push(item); chars += item.spoken.length;
  }
  if (!bounded.some(item => item.type === 'daily_agenda')) bounded.push(agendaItem(today, day, at, timeZone, league));
  const intro = isReturn
    ? `MonteCristo News, edición de regreso del ${dateLabel(day)}.`
    : `Bienvenidos a MonteCristo News. Edición del ${dateLabel(day)}. Este es el corte informativo del día.`;
  const outro = 'Esta edición permanece disponible para repetición. Consulta el estado actual y los marcadores oficiales en el Estadio.';
  const script = [{ role: 'narrador', text: intro, itemId: null }];
  bounded.forEach((item, index) => script.push({ role: index % 2 ? 'narrador' : 'analista', text: item.spoken, itemId: item.id }));
  script.push({ role: 'narrador', text: outro, itemId: null });
  const totalChars = script.reduce((sum, line) => sum + line.text.length, 0);
  return {
    version: DAILY_NEWS_VERSION, id: `daily:${day}`, day, seasonMonth: league.seasonMonth,
    generatedAt: at, cutoffAt: at, timeZone, mode: isReturn ? 'return' : 'daily',
    headline: isReturn ? 'Volvemos con la actualidad del Estadio' : 'La actualidad del Estadio, día a día',
    summary: isReturn ? 'Una sola edición de regreso con hechos recuperados y confirmados.' : 'Resultados, clubes y cartelera de una edición diaria estable.',
    coverage: { fromDay: operational.lastReadyDay || null, toDay: day, gapDays,
      recoveredMatches: recovered.length, selectedResults: Math.min(2, selected.length), availableResults: selected.length },
    market: { status: market.status, seasonMonth: market.seasonMonth,
      effectiveSeason: market.effectiveSeason || null, moveCount: market.moves.length },
    table: { leaderClubId: rows[0]?.stats.played ? rows[0].clubId : null,
      rows: rows.slice(0, 3).map(r => ({ clubId: r.clubId, points: r.stats.points, played: r.stats.played })) },
    items: bounded, clubNews, script,
    estimatedDurationSeconds: Math.round(totalChars / 13.5), scriptCharacters: totalChars
  };
}

module.exports = { DAILY_NEWS_VERSION, MAX_ITEMS, MAX_SCRIPT_CHARS, dayKey, previousDay, daysBetween, buildDailyEdition };
