'use strict';

// Auditoría del acumulado del Balón de Oro contra el archivo de cada partido.
//
// El evento del premio acumula la contribución de cada partido en el momento de
// asentarse. El archivo por partido (`match.fantasyStats`, generado con la MISMA
// línea de tiempo que el resultado y que el resumen) permite rehacer esa suma:
// goles, asistencias, apariciones y rojas son verificables; minutos y amarillas
// lo son en los partidos asentados desde que el archivo los guarda.
//
// Si el acumulado no es la suma del archivo, ese club se contó más de una vez
// —el doble asentado que la guarda vieja del store permitía— y el jugador
// aparece con más goles/asistencias de los que tuvo. Esta auditoría lo detecta y
// el plan de reparación devuelve el evento corregido.

const { isRegularBallonDorMatch } = require('./ballon-dor-stats');
const { cleanFantasyStats } = require('./fantasy');
const { calculateBallonDorPoints, cleanBallonDorEvent } = require('./ballon-dor');

const STAT_KEYS = ['goals', 'assists', 'appearances', 'minutes', 'yellowCards', 'redCards'];
const VERIFIABLE_KEYS = ['goals', 'assists', 'appearances', 'redCards'];
// Estados en los que el premio ya terminó: tienen ceremonia, resultado y pagos.
// Cualquier otro (`scheduled`, `active`, `locked`) sigue acumulando partidos.
const CLOSED_STATUSES = ['settled', 'cancelled'];

// Partidos regulares ya asentados en los que participó el club del candidato.
function candidateMatches(league, clubId) {
  return (league && league.calendar && Array.isArray(league.calendar.matches) ? league.calendar.matches : [])
    .filter(match => match && isRegularBallonDorMatch(match)
      && match.status === 'settled' && match.result
      && (match.homeId === clubId || match.awayId === clubId));
}

// Suma el archivo de esos partidos para un jugador concreto.
function archivedContribution(league, candidate) {
  const matches = candidateMatches(league, candidate.clubId);
  const totals = { goals: 0, assists: 0, appearances: 0, minutes: 0, yellowCards: 0, redCards: 0 };
  const detail = [];
  let complete = true;
  let minutesComplete = true;
  let yellowsComplete = true;
  for (const match of matches) {
    const rows = cleanFantasyStats(match.fantasyStats, match);
    const row = Array.isArray(rows) ? rows.find(item => item.id === candidate.playerId) : null;
    // Sin archivo (partido viejo o plantilla incompleta) no se puede verificar:
    // la auditoría se declara incompleta y NO propone reparar a este candidato.
    if (!row) { complete = false; continue; }
    totals.goals += row.goals;
    totals.assists += row.assists;
    totals.appearances += row.played ? 1 : 0;
    totals.redCards += row.reds;
    if (Number.isInteger(row.minutes)) totals.minutes += row.minutes;
    else minutesComplete = false;
    if (Number.isInteger(row.yellows)) totals.yellowCards += row.yellows;
    else yellowsComplete = false;
    detail.push({
      matchId: match.id,
      jornada: match.jornada,
      createdAt: match.settledAt,
      score: { home: match.result.home, away: match.result.away },
      played: row.played,
      goals: row.goals,
      assists: row.assists,
      minutes: Number.isInteger(row.minutes) ? row.minutes : null,
      yellowCards: Number.isInteger(row.yellows) ? row.yellows : null,
      redCards: row.reds
    });
  }
  detail.sort((a, b) => (a.jornada - b.jornada) || String(a.matchId).localeCompare(String(b.matchId)));
  return { matches: matches.length, complete, minutesComplete, yellowsComplete, totals, detail };
}

function difference(eventStats, totals, keys) {
  const delta = {};
  for (const key of keys) delta[key] = eventStats[key] - totals[key];
  return delta;
}

function hasDifference(delta) {
  return Object.values(delta).some(value => value !== 0);
}

// Compara cada candidato con su archivo. No muta nada.
function auditBallonDor(league) {
  const event = league && league.ballonDor;
  if (!event || !Array.isArray(event.candidates)) return { ok: false, reason: 'sin_evento' };
  const candidates = event.candidates.map(candidate => {
    const archived = archivedContribution(league, candidate);
    const delta = difference(candidate.stats, archived.totals, STAT_KEYS);
    const verifiableDelta = difference(candidate.stats, archived.totals, VERIFIABLE_KEYS);
    return {
      candidateId: candidate.id,
      playerId: candidate.playerId,
      playerName: candidate.playerName,
      clubId: candidate.clubId,
      event: { ...candidate.stats },
      archived: { ...archived.totals },
      delta,
      verifiable: archived.complete,
      consistent: archived.complete && !hasDifference(verifiableDelta),
      matches: archived.detail
    };
  });
  const checked = candidates.filter(item => item.verifiable);
  const mismatched = checked.filter(item => !item.consistent);
  return {
    ok: true,
    seasonMonth: event.seasonMonth,
    status: event.status,
    repairable: !CLOSED_STATUSES.includes(event.status),
    checked: checked.length,
    mismatched: mismatched.length,
    candidates
  };
}

// Minutos coherentes con las apariciones corregidas cuando el archivo no los
// guarda (partidos anteriores a este cambio): se conserva el ritmo del jugador.
function scaledMinutes(stats, appearances) {
  const currentAppearances = Math.max(0, Number(stats.appearances) || 0);
  const currentMinutes = Math.max(0, Number(stats.minutes) || 0);
  const ratio = currentAppearances > 0 ? currentMinutes / currentAppearances : 0;
  return Math.max(appearances, Math.round(ratio * appearances));
}

// Devuelve el evento corregido a partir del archivo por partido. No persiste:
// el store decide si aplica. Solo repara eventos que todavía acumulan; uno ya
// `settled`/`cancelled` es un resultado oficial con ceremonia y pagos, y no se
// reescribe en silencio.
function planBallonDorRepair(league, options = {}) {
  const event = league && league.ballonDor;
  if (!event || !Array.isArray(event.candidates)) return { ok: false, reason: 'sin_evento' };
  if (CLOSED_STATUSES.includes(event.status)) {
    return { ok: false, reason: 'evento_cerrado', status: event.status, changes: [] };
  }
  const at = Number.isFinite(Number(options.at)) && Number(options.at) > 0
    ? Math.floor(Number(options.at)) : Date.now();
  const changes = [];
  let skipped = 0;
  const candidates = event.candidates.map(candidate => {
    const archived = archivedContribution(league, candidate);
    if (!archived.complete) { skipped++; return candidate; }
    const stats = {
      goals: archived.totals.goals,
      assists: archived.totals.assists,
      appearances: archived.totals.appearances,
      redCards: archived.totals.redCards,
      minutes: archived.minutesComplete
        ? archived.totals.minutes
        : scaledMinutes(candidate.stats, archived.totals.appearances),
      yellowCards: archived.yellowsComplete
        ? archived.totals.yellowCards
        : candidate.stats.yellowCards
    };
    if (stats.minutes < stats.appearances) stats.minutes = stats.appearances;
    if (STAT_KEYS.every(key => stats[key] === candidate.stats[key])) return candidate;
    let points;
    try {
      points = calculateBallonDorPoints(stats, candidate.points && candidate.points.teamBonus);
    } catch (_) {
      return candidate; // el plan no puede quedar en un estado inválido
    }
    changes.push({
      candidateId: candidate.id,
      playerId: candidate.playerId,
      playerName: candidate.playerName,
      clubId: candidate.clubId,
      from: { ...candidate.stats },
      to: { ...stats },
      pointsFrom: candidate.points && candidate.points.total,
      pointsTo: points.total,
      verifiedMinutes: archived.minutesComplete,
      verifiedYellowCards: archived.yellowsComplete
    });
    return { ...candidate, stats, points };
  });
  if (!changes.length) return { ok: true, already: true, changes: [], skipped };
  const next = cleanBallonDorEvent({
    ...event,
    candidates,
    updatedAt: Math.max(event.updatedAt || 0, at)
  }, event.seasonMonth);
  if (!next) return { ok: false, reason: 'evento_invalido_despues_de_reparar', changes: [] };
  return { ok: true, already: false, event: next, changes, skipped };
}

module.exports = {
  candidateMatches,
  archivedContribution,
  auditBallonDor,
  planBallonDorRepair
};
