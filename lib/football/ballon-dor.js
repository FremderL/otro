'use strict';

// Contrato persistente del premio mensual Balón de Oro MonteCristo.
// La liga (football_leagues.data en PG o `leagues[]` en JSON) contiene el evento,
// para que candidatos, calendario y estado se guarden/re-hidraten como una sola unidad.

const BALLON_DOR_STATUSES = Object.freeze(['scheduled', 'active', 'locked', 'settled', 'cancelled']);
const BALLON_DOR_FORMULA_VERSION = 1;
const BALLON_DOR_CANDIDATE_COUNT = 16;
const MAX_NAME_LENGTH = 120;
const MAX_SHORT_LENGTH = 12;

const ALLOWED_TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(['active', 'cancelled']),
  active: Object.freeze(['locked', 'cancelled']),
  locked: Object.freeze(['settled', 'cancelled']),
  settled: Object.freeze([]),
  cancelled: Object.freeze([])
});

function normalizeSeasonMonth(value) {
  const match = /^(\d{4})-(\d{1,2})$/.exec(String(value || ''));
  if (!match) throw new TypeError(`seasonMonth inválido: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new TypeError(`seasonMonth inválido: ${value}`);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function eventIdFor(seasonMonth) {
  return `bdo_${normalizeSeasonMonth(seasonMonth)}`;
}

function candidateIdFor(seasonMonth, clubId, playerId) {
  const month = normalizeSeasonMonth(seasonMonth);
  const club = String(clubId || '').trim();
  const player = String(playerId || '').trim();
  if (!club || !player) throw new TypeError('clubId y playerId son obligatorios para el candidato');
  return `bdo:${month}:${club}:${player}`;
}

function emptyBallonDorStats() {
  return { goals: 0, assists: 0, appearances: 0, minutes: 0, yellowCards: 0, redCards: 0 };
}

function emptyBallonDorPoints() {
  return { goals: 0, assists: 0, appearances: 0, yellowCards: 0, redCards: 0, teamBonus: 0, total: 0 };
}

// Desglose auditable de la fórmula congelada en Fase 1. Las tarjetas guardan
// una contribución negativa para que la suma de los campos sea el puntaje total.
function calculateBallonDorPoints(stats, teamBonus = 0) {
  if (!isRecord(stats) || !['goals', 'assists', 'appearances', 'minutes', 'yellowCards', 'redCards']
    .every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0)) {
    throw new TypeError('Estadísticas inválidas para calcular puntos');
  }
  if (![0, 1, 3, 5].includes(teamBonus)) throw new TypeError('Bonificación de equipo inválida');
  const points = {
    goals: stats.goals * 5,
    assists: stats.assists * 3,
    appearances: stats.appearances,
    yellowCards: stats.yellowCards ? -stats.yellowCards : 0,
    redCards: stats.redCards ? -3 * stats.redCards : 0,
    teamBonus
  };
  points.total = points.goals + points.assists + points.appearances
    + points.yellowCards + points.redCards + points.teamBonus;
  if (Object.values(points).some(value => !Number.isSafeInteger(value))) {
    throw new TypeError('Puntaje fuera de rango');
  }
  return points;
}

function samePoints(left, right) {
  return Boolean(left && right
    && ['goals', 'assists', 'appearances', 'yellowCards', 'redCards', 'teamBonus', 'total']
      .every(key => left[key] === right[key]));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanString(value, maxLength = MAX_NAME_LENGTH) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength).trim();
}

function cleanSafeInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return fallback;
  return number;
}

function cleanColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function cleanStats(raw) {
  if (!isRecord(raw)) return null;
  const stats = {};
  for (const key of ['goals', 'assists', 'appearances', 'minutes', 'yellowCards', 'redCards']) {
    const value = cleanSafeInt(raw[key]);
    if (value == null) return null;
    stats[key] = value;
  }
  return stats;
}

function cleanPoints(raw) {
  if (!isRecord(raw)) return null;
  const points = {};
  for (const key of ['goals', 'assists', 'appearances', 'yellowCards', 'redCards', 'teamBonus', 'total']) {
    const value = cleanSafeInt(raw[key], { min: -Number.MAX_SAFE_INTEGER });
    if (value == null) return null;
    points[key] = Object.is(value, -0) ? 0 : value;
  }
  return points;
}

function cleanCandidate(raw, seasonMonth) {
  if (!isRecord(raw)) return null;
  const clubId = cleanString(raw.clubId, MAX_SHORT_LENGTH * 4);
  const playerId = cleanString(raw.playerId, MAX_SHORT_LENGTH * 4);
  const playerName = cleanString(raw.playerName);
  const clubName = cleanString(raw.clubName);
  const clubShort = cleanString(raw.clubShort, MAX_SHORT_LENGTH);
  const playerNumber = cleanSafeInt(raw.playerNumber, { min: 1, max: 99 });
  const shooting = cleanSafeInt(raw.attributes && raw.attributes.shooting, { min: 0, max: 100 });
  const pace = cleanSafeInt(raw.attributes && raw.attributes.pace, { min: 0, max: 100 });
  const stats = cleanStats(raw.stats);
  const points = cleanPoints(raw.points);
  const primary = cleanColor(raw.clubColors && raw.clubColors.primary);
  const secondary = cleanColor(raw.clubColors && raw.clubColors.secondary);
  if (!clubId || !playerId || !playerName || !clubName || !clubShort || playerNumber == null
      || raw.position !== 'ST' || shooting == null || pace == null || !stats || !points || !primary || !secondary
      || stats.appearances > 30 || stats.minutes < stats.appearances
      || ![0, 1, 3, 5].includes(points.teamBonus)) {
    return null;
  }
  let expectedPoints;
  try { expectedPoints = calculateBallonDorPoints(stats, points.teamBonus); }
  catch (_) { return null; }
  if (!samePoints(points, expectedPoints)) return null;

  let expectedId;
  try { expectedId = candidateIdFor(seasonMonth, clubId, playerId); }
  catch (_) { return null; }
  if (raw.id !== expectedId) return null;

  return {
    id: expectedId,
    playerId,
    playerName,
    playerNumber,
    position: 'ST',
    clubId,
    clubName,
    clubShort,
    clubColors: { primary, secondary },
    attributes: { shooting, pace },
    stats,
    points
  };
}

function cleanResult(raw, candidates) {
  if (!isRecord(raw) || !Array.isArray(raw.ranking) || raw.ranking.length !== BALLON_DOR_CANDIDATE_COUNT) return null;
  const finalizedAt = cleanSafeInt(raw.finalizedAt, { min: 1 });
  const winnerCandidateId = cleanString(raw.winnerCandidateId, 240);
  const winnerScore = cleanSafeInt(raw.winnerScore, { min: -Number.MAX_SAFE_INTEGER });
  if (finalizedAt == null || winnerScore == null || !winnerCandidateId) return null;

  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const candidateIds = new Set(candidateById.keys());
  const seen = new Set();
  const ranking = [];
  for (const row of raw.ranking) {
    if (!isRecord(row)) return null;
    const candidateId = cleanString(row.candidateId, 240);
    const rank = cleanSafeInt(row.rank, { min: 1, max: BALLON_DOR_CANDIDATE_COUNT });
    const score = cleanSafeInt(row.score, { min: -Number.MAX_SAFE_INTEGER });
    if (!candidateId || rank == null || score == null || !candidateIds.has(candidateId) || seen.has(candidateId)
        || candidateById.get(candidateId).points.total !== score) return null;
    seen.add(candidateId);
    ranking.push({ candidateId, rank, score });
  }
  ranking.sort((a, b) => a.rank - b.rank);
  const expectedRanking = candidates.slice().sort(compareBallonDorCandidates);
  if (new Set(ranking.map(row => row.rank)).size !== BALLON_DOR_CANDIDATE_COUNT
      || ranking.some((row, index) => row.rank !== index + 1
        || row.candidateId !== expectedRanking[index].id
        || row.score !== expectedRanking[index].points.total)
      || ranking[0].candidateId !== winnerCandidateId
      || ranking[0].score !== winnerScore) return null;

  return { winnerCandidateId, winnerScore, finalizedAt, ranking };
}

function cleanOddsSnapshot(raw, candidates) {
  if (!isRecord(raw) || !Array.isArray(raw.selections)
      || raw.selections.length !== BALLON_DOR_CANDIDATE_COUNT) return null;
  const updatedAt = cleanSafeInt(raw.updatedAt, { min: 1 });
  const afterJornada = cleanSafeInt(raw.afterJornada, { min: 0, max: 20 });
  const simulations = cleanSafeInt(raw.simulations, { min: 1, max: 100000 });
  const seed = cleanSafeInt(raw.seed, { min: 0, max: 0xffffffff });
  const overround = Number(raw.overround);
  if (updatedAt == null || afterJornada == null || simulations !== 2000 || seed == null
      || !Number.isFinite(overround) || Math.abs(overround - 1.1) > 1e-12) return null;

  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const selections = [];
  const seen = new Set();
  for (const rawSelection of raw.selections) {
    if (!isRecord(rawSelection)) return null;
    const candidateId = cleanString(rawSelection.candidateId, MAX_SHORT_LENGTH * 8);
    const wins = cleanSafeInt(rawSelection.wins, { min: 0, max: simulations });
    const probability = Number(rawSelection.probability);
    const odds = Number(rawSelection.odds);
    if (!candidateIds.has(candidateId) || seen.has(candidateId) || wins == null
        || !Number.isFinite(probability) || probability < 0 || probability > 1
        || Math.abs(probability - wins / simulations) > 1e-12
        || !Number.isFinite(odds) || odds < 1.01 || odds > 51
        || Math.abs(odds * 100 - Math.round(odds * 100)) > 1e-8) return null;
    seen.add(candidateId);
    selections.push({ candidateId, wins, probability, odds: Number(odds.toFixed(2)) });
  }
  const impliedSum = selections.reduce((sum, selection) => sum + 1 / selection.odds, 0);
  if (seen.size !== BALLON_DOR_CANDIDATE_COUNT
      || selections.reduce((sum, selection) => sum + selection.wins, 0) !== simulations
      || impliedSum + 1e-10 < overround) return null;
  selections.sort((a, b) => a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0);
  return { updatedAt, afterJornada, simulations, seed, overround: 1.1, selections };
}

function cleanBallonDorEvent(raw, expectedSeasonMonth = null) {
  if (!isRecord(raw) || !Array.isArray(raw.candidates) || raw.candidates.length !== BALLON_DOR_CANDIDATE_COUNT) return null;
  let seasonMonth;
  try { seasonMonth = normalizeSeasonMonth(raw.seasonMonth); }
  catch (_) { return null; }
  if (expectedSeasonMonth != null) {
    try { if (seasonMonth !== normalizeSeasonMonth(expectedSeasonMonth)) return null; }
    catch (_) { return null; }
  }

  const id = cleanString(raw.id, 40);
  const status = BALLON_DOR_STATUSES.includes(raw.status) ? raw.status : null;
  const formulaVersion = cleanSafeInt(raw.formulaVersion, { min: 1, max: 999 });
  const createdAt = cleanSafeInt(raw.createdAt, { min: 1 });
  const updatedAt = cleanSafeInt(raw.updatedAt, { min: 1 });
  if (id !== eventIdFor(seasonMonth) || !status || formulaVersion == null || createdAt == null || updatedAt == null) return null;

  const candidates = raw.candidates.map(candidate => cleanCandidate(candidate, seasonMonth));
  if (candidates.some(candidate => !candidate)) return null;
  candidates.sort((a, b) => a.clubId < b.clubId ? -1 : a.clubId > b.clubId ? 1 : 0);
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const clubIds = new Set(candidates.map(candidate => candidate.clubId));
  if (candidateIds.size !== BALLON_DOR_CANDIDATE_COUNT || clubIds.size !== BALLON_DOR_CANDIDATE_COUNT) return null;

  const startedAt = raw.startedAt == null ? null : cleanSafeInt(raw.startedAt, { min: 1 });
  const lockedAt = raw.lockedAt == null ? null : cleanSafeInt(raw.lockedAt, { min: 1 });
  const settledAt = raw.settledAt == null ? null : cleanSafeInt(raw.settledAt, { min: 1 });
  const cancelledAt = raw.cancelledAt == null ? null : cleanSafeInt(raw.cancelledAt, { min: 1 });
  const cancellationReason = raw.cancellationReason == null ? null : cleanString(raw.cancellationReason, 160);
  const result = raw.result == null ? null : cleanResult(raw.result, candidates);
  const oddsSnapshot = raw.oddsSnapshot == null ? null : cleanOddsSnapshot(raw.oddsSnapshot, candidates);
  if ((raw.startedAt != null && startedAt == null) || (raw.lockedAt != null && lockedAt == null)
      || (raw.settledAt != null && settledAt == null) || (raw.cancelledAt != null && cancelledAt == null)
      || (raw.result != null && !result) || (raw.oddsSnapshot != null && (!oddsSnapshot
        || oddsSnapshot.updatedAt < createdAt || oddsSnapshot.updatedAt > updatedAt)) || updatedAt < createdAt
      || (startedAt != null && (startedAt < createdAt || startedAt > updatedAt))
      || (lockedAt != null && (lockedAt < (startedAt || createdAt) || lockedAt > updatedAt))
      || (settledAt != null && (settledAt < (lockedAt || createdAt) || settledAt > updatedAt))
      || (cancelledAt != null && (cancelledAt < createdAt || cancelledAt > updatedAt))) return null;

  if (status === 'scheduled' && (startedAt != null || lockedAt != null || settledAt != null || cancelledAt != null || result || cancellationReason)) return null;
  if (status === 'active' && (startedAt == null || lockedAt != null || settledAt != null || cancelledAt != null || result || cancellationReason)) return null;
  if (status === 'locked' && (startedAt == null || lockedAt == null || settledAt != null || cancelledAt != null || result || cancellationReason)) return null;
  if (status === 'settled' && (startedAt == null || lockedAt == null || settledAt == null || cancelledAt != null || !result || result.finalizedAt !== settledAt || cancellationReason)) return null;
  if (status === 'cancelled' && (cancelledAt == null || !cancellationReason || result || settledAt != null
      || cancelledAt < (lockedAt || startedAt || createdAt))) return null;

  return {
    id,
    seasonMonth,
    formulaVersion,
    status,
    createdAt,
    updatedAt,
    startedAt,
    lockedAt,
    settledAt,
    cancelledAt,
    cancellationReason,
    candidates,
    oddsSnapshot,
    result
  };
}

function selectBallonDorCandidates(seasonMonth, clubs) {
  const month = normalizeSeasonMonth(seasonMonth);
  if (!Array.isArray(clubs) || clubs.length !== BALLON_DOR_CANDIDATE_COUNT) {
    throw new TypeError(`Se esperan ${BALLON_DOR_CANDIDATE_COUNT} clubes para seleccionar candidatos`);
  }
  const seenClubs = new Set();
  const candidates = [];

  for (const club of clubs) {
    if (!isRecord(club) || typeof club.id !== 'string' || !club.id.trim()) {
      throw new TypeError('Cada club debe tener un ID único');
    }
    const clubId = club.id.trim();
    if (seenClubs.has(clubId)) throw new TypeError('Cada club debe tener un ID único');
    seenClubs.add(clubId);
    const strikers = Array.isArray(club.squad) ? club.squad.filter(player => player && player.pos === 'ST') : [];
    if (!strikers.length) throw new TypeError(`El club ${clubId} no tiene un delantero ST`);
    if (strikers.some(player => !Number.isInteger(player.attrs && player.attrs.sho)
        || !Number.isInteger(player.attrs && player.attrs.pac) || !Number.isInteger(player.num)
        || typeof player.id !== 'string' || !player.id || typeof player.name !== 'string' || !player.name)) {
      throw new TypeError(`El club ${clubId} tiene un delantero ST sin atributos o identidad válidos`);
    }

    const selected = strikers.slice().sort((a, b) => {
      const shootingDiff = b.attrs.sho - a.attrs.sho;
      if (shootingDiff) return shootingDiff;
      const paceDiff = b.attrs.pac - a.attrs.pac;
      if (paceDiff) return paceDiff;
      const numberDiff = a.num - b.num;
      if (numberDiff) return numberDiff;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    })[0];

    const primary = cleanColor(club.colors && club.colors.primary);
    const secondary = cleanColor(club.colors && club.colors.secondary);
    const clubShort = club.abbr || club.short;
    if (!club.name || !clubShort || !primary || !secondary) {
      throw new TypeError(`El club ${club.id} no tiene metadatos visuales válidos`);
    }

    const candidate = {
      id: candidateIdFor(month, clubId, selected.id),
      playerId: selected.id.trim(),
      playerName: selected.name.trim(),
      playerNumber: selected.num,
      position: 'ST',
      clubId,
      clubName: club.name,
      clubShort,
      clubColors: { primary, secondary },
      attributes: { shooting: selected.attrs.sho, pace: selected.attrs.pac },
      stats: emptyBallonDorStats(),
      points: emptyBallonDorPoints()
    };
    candidates.push(candidate);
  }

  candidates.sort((a, b) => a.clubId < b.clubId ? -1 : a.clubId > b.clubId ? 1 : 0);
  return candidates;
}

function createBallonDorEvent(seasonMonth, clubs, createdAt = Date.now()) {
  const month = normalizeSeasonMonth(seasonMonth);
  const timestamp = cleanSafeInt(createdAt, { min: 1 });
  if (timestamp == null) throw new TypeError('createdAt debe ser un timestamp positivo');
  const event = {
    id: eventIdFor(month),
    seasonMonth: month,
    formulaVersion: BALLON_DOR_FORMULA_VERSION,
    status: 'scheduled',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    lockedAt: null,
    settledAt: null,
    cancelledAt: null,
    cancellationReason: null,
    candidates: selectBallonDorCandidates(month, clubs),
    oddsSnapshot: null,
    result: null
  };
  const clean = cleanBallonDorEvent(event, month);
  if (!clean) throw new TypeError('No se pudo construir el contrato del Balón de Oro');
  return clean;
}

function updateBallonDorOdds(event, snapshot, at = Date.now()) {
  const current = cleanBallonDorEvent(event);
  if (!current) return { ok: false, reason: 'evento_invalido' };
  if (!['active', 'locked'].includes(current.status)) return { ok: false, reason: 'mercado_no_activo' };
  const cleanSnapshot = cleanOddsSnapshot(snapshot, current.candidates);
  if (!cleanSnapshot) return { ok: false, reason: 'cuotas_invalidas' };
  const timestamp = cleanSafeInt(at, { min: 1 });
  if (timestamp == null || timestamp < current.updatedAt || timestamp !== cleanSnapshot.updatedAt) {
    return { ok: false, reason: 'timestamp_invalido' };
  }
  if (current.oddsSnapshot && cleanSnapshot.afterJornada <= current.oddsSnapshot.afterJornada) {
    return cleanSnapshot.afterJornada === current.oddsSnapshot.afterJornada
      && JSON.stringify(cleanSnapshot) === JSON.stringify(current.oddsSnapshot)
      ? { ok: true, event: current, already: true }
      : { ok: false, reason: 'jornada_de_cuotas_duplicada' };
  }
  const clean = cleanBallonDorEvent({
    ...current, updatedAt: timestamp, oddsSnapshot: cleanSnapshot
  }, current.seasonMonth);
  return clean ? { ok: true, event: clean, already: false } : { ok: false, reason: 'evento_transicion_invalido' };
}

function transitionBallonDorStatus(event, nextStatus, options = {}) {
  const current = cleanBallonDorEvent(event);
  if (!current) return { ok: false, reason: 'evento_invalido' };
  if (!BALLON_DOR_STATUSES.includes(nextStatus)) return { ok: false, reason: 'estado_invalido' };
  if (nextStatus === current.status) return { ok: true, event: current, already: true };
  if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) return { ok: false, reason: 'transicion_no_permitida' };

  const at = cleanSafeInt(options.at == null ? Date.now() : options.at, { min: 1 });
  if (at == null || at < current.updatedAt) return { ok: false, reason: 'timestamp_invalido' };
  const next = { ...current, status: nextStatus, updatedAt: at };
  if (nextStatus === 'active') next.startedAt = at;
  if (nextStatus === 'locked') next.lockedAt = at;
  if (nextStatus === 'settled') {
    const rawResult = isRecord(options.result) ? { ...options.result, finalizedAt: options.result.finalizedAt ?? at } : options.result;
    const result = cleanResult(rawResult, current.candidates);
    if (!result) return { ok: false, reason: 'resultado_invalido' };
    next.result = result;
    next.settledAt = at;
  }
  if (nextStatus === 'cancelled') {
    const reason = cleanString(options.reason, 160);
    if (!reason) return { ok: false, reason: 'motivo_cancelacion_requerido' };
    next.cancellationReason = reason;
    next.cancelledAt = at;
  }

  const clean = cleanBallonDorEvent(next, current.seasonMonth);
  return clean ? { ok: true, event: clean, already: false } : { ok: false, reason: 'evento_transicion_invalido' };
}

function compareBallonDorCandidates(a, b) {
  return (b.points.total - a.points.total)
    || (b.stats.goals - a.stats.goals)
    || (b.stats.assists - a.stats.assists)
    || ((a.stats.yellowCards + 3 * a.stats.redCards) - (b.stats.yellowCards + 3 * b.stats.redCards))
    || compareStableKey(`${a.clubId}:${String(a.playerNumber).padStart(2, '0')}`,
      `${b.clubId}:${String(b.playerNumber).padStart(2, '0')}`);
}

function compareStableKey(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function teamBonusForPosition(position) {
  if (position === 1) return 5;
  if (position === 2) return 3;
  if (position === 3 || position === 4) return 1;
  return 0;
}

// Calcula la tabla final a partir de la clasificación oficial ya resuelta
// (incluido un posible partido de desempate). No muta ni el evento ni los clubes.
function calculateBallonDorResult(event, clubPositions, finalizedAt = Date.now()) {
  const current = cleanBallonDorEvent(event);
  if (!current) return { ok: false, reason: 'evento_invalido' };
  if (current.status !== 'locked') return { ok: false, reason: 'evento_no_bloqueado' };
  if (!Array.isArray(clubPositions) || clubPositions.length !== BALLON_DOR_CANDIDATE_COUNT) {
    return { ok: false, reason: 'clasificacion_invalida' };
  }
  const at = cleanSafeInt(finalizedAt, { min: 1 });
  if (at == null || at < current.updatedAt) return { ok: false, reason: 'timestamp_invalido' };

  const positions = new Map();
  for (const row of clubPositions) {
    if (!isRecord(row)) return { ok: false, reason: 'clasificacion_invalida' };
    const teamId = cleanString(row.teamId, MAX_SHORT_LENGTH * 4);
    const position = cleanSafeInt(row.position, { min: 1, max: BALLON_DOR_CANDIDATE_COUNT });
    if (!teamId || position == null || positions.has(teamId) || [...positions.values()].includes(position)) {
      return { ok: false, reason: 'clasificacion_invalida' };
    }
    positions.set(teamId, position);
  }
  if (positions.size !== BALLON_DOR_CANDIDATE_COUNT) return { ok: false, reason: 'clasificacion_invalida' };

  const candidates = current.candidates.map(candidate => {
    const position = positions.get(candidate.clubId);
    if (position == null) return null;
    return {
      ...candidate,
      points: calculateBallonDorPoints(candidate.stats, teamBonusForPosition(position))
    };
  });
  if (candidates.some(candidate => !candidate)) return { ok: false, reason: 'clasificacion_invalida' };

  const ranking = candidates.slice().sort(compareBallonDorCandidates).map((candidate, index) => ({
    candidateId: candidate.id,
    rank: index + 1,
    score: candidate.points.total
  }));
  const result = {
    winnerCandidateId: ranking[0].candidateId,
    winnerScore: ranking[0].score,
    finalizedAt: at,
    ranking
  };
  return { ok: true, candidates, result };
}

// Finalizador puro reutilizable por la automatización de Fase 4. En una misma
// operación aplica bonificaciones, guarda el ranking y valida la transición.
function finalizeBallonDorEvent(event, clubPositions, at = Date.now()) {
  const current = cleanBallonDorEvent(event);
  if (!current) return { ok: false, reason: 'evento_invalido' };
  const calculated = calculateBallonDorResult(current, clubPositions, at);
  if (!calculated.ok) return calculated;
  const withFinalPoints = { ...current, candidates: calculated.candidates };
  return transitionBallonDorStatus(withFinalPoints, 'settled', { at, result: calculated.result });
}

module.exports = {
  BALLON_DOR_STATUSES,
  BALLON_DOR_FORMULA_VERSION,
  BALLON_DOR_CANDIDATE_COUNT,
  ALLOWED_TRANSITIONS,
  normalizeSeasonMonth,
  eventIdFor,
  candidateIdFor,
  emptyBallonDorStats,
  emptyBallonDorPoints,
  calculateBallonDorPoints,
  cleanBallonDorEvent,
  selectBallonDorCandidates,
  createBallonDorEvent,
  updateBallonDorOdds,
  transitionBallonDorStatus,
  calculateBallonDorResult,
  finalizeBallonDorEvent,
  teamBonusForPosition
};
