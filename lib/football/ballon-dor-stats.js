'use strict';

// Agregador puro de estadísticas del Balón de Oro desde la fuente autoritativa
// de cada partido: timeline + alineaciones. El store aplica el evento devuelto
// junto con el resultado, en una sola transición persistida.

const { cleanBallonDorEvent, calculateBallonDorPoints } = require('./ballon-dor');

const REGULAR_HALVES = new Set([1, 2]);
const TERMINAL_EVENT_STATUSES = new Set(['settled', 'cancelled']);
const TIME_EPSILON = 1e-9;

function isRegularBallonDorMatch(match) {
  const jornada = Number(match && match.jornada);
  return Boolean(match && !match.desempate && Number.isInteger(jornada) && jornada >= 1 && jornada <= 30);
}

function invalid(reason) { return { ok: false, reason }; }

function extractBallonDorMatchStats(match, timeline, lineups = timeline && timeline.lineups) {
  if (!isRegularBallonDorMatch(match)) {
    return { ok: true, included: false, score: { home: 0, away: 0 }, players: new Map() };
  }
  if (!Array.isArray(timeline) || !lineups || typeof lineups !== 'object') return invalid('fuente_de_partido_requerida');

  const fullTime = timeline.find(event => event && event.type === 'full_time' && Number(event.half) === 2);
  const regularEnd = Number(fullTime && fullTime.t);
  if (!Number.isFinite(regularEnd) || regularEnd <= 0) return invalid('final_regular_ausente');

  const teamIds = { home: String(match.homeId || ''), away: String(match.awayId || '') };
  if (!teamIds.home || !teamIds.away || teamIds.home === teamIds.away) return invalid('clubes_del_partido_invalidos');

  const playerById = new Map();
  const active = new Set();
  const players = new Map();
  for (const side of ['home', 'away']) {
    const lineup = lineups[side];
    if (!lineup || !Array.isArray(lineup.players)) return invalid('alineacion_invalida');
    if (lineup.teamId != null && String(lineup.teamId) !== teamIds[side]) return invalid('club_de_alineacion_invalido');
    for (const player of lineup.players) {
      if (!player || typeof player.id !== 'string' || !player.id
          || !['active', 'bench'].includes(player.initialStatus) || playerById.has(player.id)) {
        return invalid('jugador_de_alineacion_invalido');
      }
      const entry = { playerId: player.id, teamId: teamIds[side], side };
      playerById.set(player.id, entry);
      players.set(player.id, {
        teamId: teamIds[side],
        elapsed: 0,
        minutes: 0,
        appearances: 0,
        goals: 0,
        assists: 0,
        yellowCards: 0,
        redCards: 0
      });
      if (player.initialStatus === 'active') active.add(player.id);
    }
  }

  const ordered = timeline.map((event, index) => ({ event, index }))
    .sort((a, b) => (Number(a.event && a.event.t) - Number(b.event && b.event.t))
      || ((Number.isInteger(a.event && a.event.i) ? a.event.i : a.index)
        - (Number.isInteger(b.event && b.event.i) ? b.event.i : b.index))
      || (a.index - b.index));
  if (ordered.some(({ event }) => !event || !Number.isFinite(Number(event.t)) || Number(event.t) < 0)) {
    return invalid('tiempo_de_evento_invalido');
  }

  const score = { home: 0, away: 0 };
  let lastTime = 0;
  const accumulateMinutesUntil = time => {
    const delta = time - lastTime;
    if (delta < -TIME_EPSILON) return false;
    for (const playerId of active) players.get(playerId).elapsed += Math.max(0, delta);
    lastTime = time;
    return true;
  };

  for (const { event } of ordered) {
    const time = Number(event.t);
    if (time > regularEnd + TIME_EPSILON) break;
    if (!accumulateMinutesUntil(Math.min(time, regularEnd))) return invalid('timeline_fuera_de_orden');
    if (!REGULAR_HALVES.has(Number(event.half))) continue;

    if (event.type === 'substitution') {
      const side = event.team;
      const incomingId = event.playerInId || event.playerId;
      const outgoingId = event.playerOutId;
      const incoming = playerById.get(incomingId);
      const outgoing = playerById.get(outgoingId);
      if (!teamIds[side] || !incomingId || !outgoingId || !incoming || !outgoing
          || incoming.teamId !== teamIds[side] || outgoing.teamId !== teamIds[side]
          || active.has(incomingId) || !active.has(outgoingId)) {
        return invalid('cambio_de_jugador_invalido');
      }
      active.delete(outgoingId);
      active.add(incomingId);
      continue;
    }

    if (event.type === 'goal' || event.type === 'penalty_scored') {
      const side = event.team;
      const scorer = playerById.get(event.playerId);
      if (!teamIds[side] || !scorer || scorer.teamId !== teamIds[side] || !active.has(scorer.playerId)) {
        return invalid('goleador_invalido');
      }
      score[side]++;
      players.get(scorer.playerId).goals++;

      // Solo un gol regular puede generar asistencia. Se exige ID del mismo club,
      // presente en la plantilla y distinto del goleador; penales nunca asisten.
      if (event.type === 'goal' && event.assistId) {
        const assister = playerById.get(event.assistId);
        if (assister && assister.teamId === teamIds[side] && active.has(assister.playerId)
            && assister.playerId !== scorer.playerId) {
          players.get(assister.playerId).assists++;
        }
      }
      continue;
    }

    if (event.type === 'yellow_card' || event.type === 'second_yellow' || event.type === 'red_card') {
      const side = event.team;
      const player = playerById.get(event.playerId);
      if (!teamIds[side] || !player || player.teamId !== teamIds[side] || !active.has(player.playerId)) {
        return invalid('jugador_de_tarjeta_invalido');
      }
      const stats = players.get(player.playerId);
      if (event.type === 'yellow_card' || event.type === 'second_yellow') stats.yellowCards++;
      if (event.type === 'red_card' || event.type === 'second_yellow') {
        stats.redCards++;
        active.delete(player.playerId);
      }
    }
  }

  if (!accumulateMinutesUntil(regularEnd)) return invalid('timeline_fuera_de_orden');
  for (const stats of players.values()) {
    stats.minutes = Math.floor(stats.elapsed + TIME_EPSILON);
    stats.appearances = stats.elapsed >= 1 - TIME_EPSILON ? 1 : 0;
    delete stats.elapsed;
  }
  return { ok: true, included: true, score, players };
}

function aggregateBallonDorMatch(event, match, timeline, lineups = timeline && timeline.lineups, options = {}) {
  const current = cleanBallonDorEvent(event);
  if (!current) return invalid('evento_invalido');
  if (TERMINAL_EVENT_STATUSES.has(current.status)) {
    return { ok: true, included: false, event: current, alreadyFinal: true };
  }
  if (!isRegularBallonDorMatch(match)) return { ok: true, included: false, event: current };

  const extracted = extractBallonDorMatchStats(match, timeline, lineups);
  if (!extracted.ok) return extracted;
  const expectedScore = options.expectedScore;
  if (expectedScore && (Number(expectedScore.home) !== extracted.score.home
      || Number(expectedScore.away) !== extracted.score.away)) {
    return invalid('marcador_no_coincide_con_timeline');
  }

  const participatingClubIds = new Set([String(match.homeId), String(match.awayId)]);
  const candidates = current.candidates.map(candidate => {
    if (!participatingClubIds.has(candidate.clubId)) return candidate;
    const contribution = extracted.players.get(candidate.playerId);
    if (!contribution || contribution.teamId !== candidate.clubId) return null;
    const stats = {
      goals: candidate.stats.goals + contribution.goals,
      assists: candidate.stats.assists + contribution.assists,
      appearances: candidate.stats.appearances + contribution.appearances,
      minutes: candidate.stats.minutes + contribution.minutes,
      yellowCards: candidate.stats.yellowCards + contribution.yellowCards,
      redCards: candidate.stats.redCards + contribution.redCards
    };
    let points;
    try { points = calculateBallonDorPoints(stats, candidate.points.teamBonus); }
    catch (_) { return null; }
    return { ...candidate, stats, points };
  });
  if (candidates.some(candidate => !candidate)) return invalid('candidato_ausente_de_alineacion');

  const rawAt = options.at == null ? Date.now() : Number(options.at);
  if (!Number.isSafeInteger(rawAt) || rawAt < 1) return invalid('timestamp_invalido');
  const next = { ...current, updatedAt: Math.max(current.updatedAt, rawAt), candidates };
  const clean = cleanBallonDorEvent(next, current.seasonMonth);
  if (!clean) return invalid('evento_invalido_despues_de_agregar');
  return { ok: true, included: true, event: clean, score: extracted.score };
}

module.exports = {
  isRegularBallonDorMatch,
  extractBallonDorMatchStats,
  aggregateBallonDorMatch
};
