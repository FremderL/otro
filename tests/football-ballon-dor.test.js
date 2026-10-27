'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hash32, mulberry32 } = require('../lib/football/prng');
const { buildSeasonClubs } = require('../lib/football/teams');
const { cleanLeague } = require('../lib/football-store-shared');
const {
  BALLON_DOR_STATUSES,
  calculateBallonDorPoints,
  calculateBallonDorResult,
  candidateIdFor,
  cleanBallonDorEvent,
  createBallonDorEvent,
  eventIdFor,
  finalizeBallonDorEvent,
  selectBallonDorCandidates,
  transitionBallonDorStatus
} = require('../lib/football/ballon-dor');

function seasonClubs(month = '2026-10') {
  return buildSeasonClubs(mulberry32(hash32(`${month}plantillas`)));
}

function resultFor(event) {
  const ranking = event.candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    rank: index + 1,
    score: candidate.points.total
  }));
  return {
    winnerCandidateId: ranking[0].candidateId,
    winnerScore: ranking[0].score,
    finalizedAt: 1030,
    ranking
  };
}

test('selección determinista: 16 candidatos ST, uno por club, ordenado por ID de club', () => {
  const clubs = seasonClubs();
  const a = selectBallonDorCandidates('2026-10', clubs);
  const b = selectBallonDorCandidates('2026-10', clubs.slice().reverse());

  assert.equal(a.length, 16);
  assert.deepEqual(a, b, 'el orden de entrada de los clubes no cambia el resultado');
  assert.deepEqual(a.map(candidate => candidate.clubId), a.map(candidate => candidate.clubId).slice().sort());
  assert.equal(new Set(a.map(candidate => candidate.clubId)).size, 16);
  assert.equal(new Set(a.map(candidate => candidate.id)).size, 16);

  for (const candidate of a) {
    const club = clubs.find(item => item.id === candidate.clubId);
    const selected = club.squad.filter(player => player.pos === 'ST').sort((x, y) =>
      (y.attrs.sho - x.attrs.sho) || (y.attrs.pac - x.attrs.pac) || (x.num - y.num)
    )[0];
    assert.equal(candidate.position, 'ST');
    assert.equal(candidate.playerId, selected.id);
    assert.equal(candidate.playerName, selected.name);
    assert.equal(candidate.attributes.shooting, selected.attrs.sho);
    assert.equal(candidate.attributes.pace, selected.attrs.pac);
    assert.equal(candidate.stats.goals, 0);
    assert.equal(candidate.stats.assists, 0);
    assert.equal(candidate.points.total, 0);
    assert.equal(candidate.id, candidateIdFor('2026-10', candidate.clubId, candidate.playerId));
  }
});

test('selección de ST: prioriza tiro, luego velocidad y después dorsal', () => {
  const clubs = seasonClubs();
  const club = clubs[0];
  const [first, second] = club.squad.filter(player => player.pos === 'ST').sort((a, b) => a.num - b.num);

  first.attrs.sho = 90; first.attrs.pac = 70;
  second.attrs.sho = 89; second.attrs.pac = 99;
  assert.equal(selectBallonDorCandidates('2026-10', clubs).find(candidate => candidate.clubId === club.id).playerId, first.id,
    'la velocidad no supera un atributo de tiro superior');

  first.attrs.sho = 90; first.attrs.pac = 70;
  second.attrs.sho = 90; second.attrs.pac = 71;
  assert.equal(selectBallonDorCandidates('2026-10', clubs).find(candidate => candidate.clubId === club.id).playerId, second.id,
    'a igual tiro, gana mayor velocidad');

  first.attrs.pac = 71; second.attrs.pac = 71;
  assert.equal(selectBallonDorCandidates('2026-10', clubs).find(candidate => candidate.clubId === club.id).playerId, first.id,
    'a igual tiro y velocidad, gana menor dorsal');
});

test('selección rechaza plantillas incompletas o ambiguas', () => {
  const clubs = seasonClubs();
  assert.throws(() => selectBallonDorCandidates('2026-10', clubs.slice(0, 15)), /Se esperan 16 clubes/);
  const noStriker = seasonClubs();
  noStriker[0].squad = noStriker[0].squad.filter(player => player.pos !== 'ST');
  assert.throws(() => selectBallonDorCandidates('2026-10', noStriker), /no tiene un delantero ST/);
  const duplicate = seasonClubs();
  duplicate[1].id = duplicate[0].id;
  assert.throws(() => selectBallonDorCandidates('2026-10', duplicate), /ID único/);
});

test('evento mensual crea un contrato versionado y limpio, sin alterar clubes', () => {
  const clubs = seasonClubs();
  const before = JSON.stringify(clubs);
  const event = createBallonDorEvent('2026-10', clubs, 1000);

  assert.equal(event.id, eventIdFor('2026-10'));
  assert.equal(event.seasonMonth, '2026-10');
  assert.equal(event.formulaVersion, 1);
  assert.equal(event.status, 'scheduled');
  assert.equal(event.createdAt, 1000);
  assert.equal(event.updatedAt, 1000);
  assert.equal(event.startedAt, null);
  assert.equal(event.lockedAt, null);
  assert.equal(event.settledAt, null);
  assert.equal(event.cancelledAt, null);
  assert.equal(event.result, null);
  assert.equal(event.candidates.length, 16);
  assert.deepEqual(cleanBallonDorEvent(event, '2026-10'), event);
  assert.equal(cleanBallonDorEvent(event, '2026-11'), null, 'no puede inyectarse en otra temporada');
  assert.equal(JSON.stringify(clubs), before, 'la selección no muta las plantillas');
  assert.deepEqual(BALLON_DOR_STATUSES, ['scheduled', 'active', 'locked', 'settled', 'cancelled']);
});

test('cleanBallonDorEvent rechaza estados, candidatos y resultados corruptos', () => {
  const event = createBallonDorEvent('2026-10', seasonClubs(), 1000);
  assert.equal(cleanBallonDorEvent({ ...event, status: 'pending' }), null);
  assert.equal(cleanBallonDorEvent({ ...event, id: 'otro-evento' }), null);
  assert.equal(cleanBallonDorEvent({ ...event, candidates: event.candidates.slice(0, 15) }), null);
  assert.equal(cleanBallonDorEvent({ ...event, candidates: [event.candidates[0], ...event.candidates.slice(1).map(() => event.candidates[0])] }), null);

  const malformedCandidate = { ...event, candidates: event.candidates.map(candidate => ({ ...candidate })) };
  malformedCandidate.candidates[0].position = 'CAM';
  assert.equal(cleanBallonDorEvent(malformedCandidate), null);

  const started = transitionBallonDorStatus(event, 'active', { at: 1010 }).event;
  const locked = transitionBallonDorStatus(started, 'locked', { at: 1020 }).event;
  const result = resultFor(locked);
  assert.equal(transitionBallonDorStatus(locked, 'settled', { at: 1030, result: { ...result, winnerCandidateId: 'invalid' } }).reason,
    'resultado_invalido');
  assert.equal(transitionBallonDorStatus(locked, 'settled', { at: 1030, result: { ...result, ranking: result.ranking.slice(1) } }).reason,
    'resultado_invalido');
  const misordered = { ...result, ranking: result.ranking.map((row, index) => index === 1 ? { ...row, score: 101 } : row) };
  assert.equal(transitionBallonDorStatus(locked, 'settled', { at: 1030, result: misordered }).reason,
    'resultado_invalido');
  assert.equal(cleanBallonDorEvent({ ...locked, status: 'settled', startedAt: null, settledAt: 1030, updatedAt: 1030, result }), null,
    'el evento settled requiere todos los tiempos intermedios');
});

test('transiciones del ciclo permiten solo el camino definido y son idempotentes', () => {
  const scheduled = createBallonDorEvent('2026-10', seasonClubs(), 1000);
  assert.equal(transitionBallonDorStatus(scheduled, 'locked', { at: 1020 }).reason, 'transicion_no_permitida');

  const activeResult = transitionBallonDorStatus(scheduled, 'active', { at: 1010 });
  assert.equal(activeResult.ok, true);
  assert.equal(activeResult.event.startedAt, 1010);
  assert.equal(transitionBallonDorStatus(activeResult.event, 'active', { at: 1015 }).already, true);

  const lockedResult = transitionBallonDorStatus(activeResult.event, 'locked', { at: 1020 });
  assert.equal(lockedResult.ok, true);
  assert.equal(lockedResult.event.lockedAt, 1020);
  const settledResult = transitionBallonDorStatus(lockedResult.event, 'settled', { at: 1030, result: resultFor(lockedResult.event) });
  assert.equal(settledResult.ok, true);
  assert.equal(settledResult.event.status, 'settled');
  assert.equal(settledResult.event.result.finalizedAt, settledResult.event.settledAt);
  assert.equal(settledResult.event.result.ranking.length, 16);
  assert.equal(transitionBallonDorStatus(settledResult.event, 'cancelled', { at: 1040, reason: 'fallo' }).reason,
    'transicion_no_permitida');
  assert.equal(transitionBallonDorStatus(settledResult.event, 'settled', { at: 1040 }).already, true);

  const cancelledResult = transitionBallonDorStatus(scheduled, 'cancelled', { at: 1010, reason: 'temporada truncada' });
  assert.equal(cancelledResult.ok, true);
  assert.equal(cancelledResult.event.status, 'cancelled');
  assert.equal(cancelledResult.event.cancellationReason, 'temporada truncada');
  assert.equal(transitionBallonDorStatus(cancelledResult.event, 'active', { at: 1020 }).reason, 'transicion_no_permitida');
  assert.equal(transitionBallonDorStatus(scheduled, 'cancelled', { at: 1010 }).reason, 'motivo_cancelacion_requerido');
  assert.equal(transitionBallonDorStatus(scheduled, 'active', { at: 999 }).reason, 'timestamp_invalido');
});

test('la fórmula aplica puntos negativos por segunda amarilla y roja', () => {
  assert.deepEqual(calculateBallonDorPoints({
    goals: 2, assists: 1, appearances: 3, minutes: 270, yellowCards: 2, redCards: 1
  }), { goals: 10, assists: 3, appearances: 3, yellowCards: -2, redCards: -3, teamBonus: 0, total: 11 });
  assert.deepEqual(calculateBallonDorPoints({
    goals: 0, assists: 0, appearances: 0, minutes: 0, yellowCards: 0, redCards: 0
  }, 5), { goals: 0, assists: 0, appearances: 0, yellowCards: 0, redCards: 0, teamBonus: 5, total: 5 });
  assert.throws(() => calculateBallonDorPoints({ goals: 0, assists: 0, appearances: 0, minutes: 0,
    yellowCards: 0, redCards: 0 }, 2), /Bonificación/);
});

test('cierre aplica bonus oficial y desempata con la regla completa, sin mutar el evento', () => {
  const initial = createBallonDorEvent('2026-10', seasonClubs(), 1000);
  const active = transitionBallonDorStatus(initial, 'active', { at: 1010 }).event;
  const locked = transitionBallonDorStatus(active, 'locked', { at: 1020 }).event;
  const candidates = locked.candidates.map((candidate, index) => {
    const stats = index === 0
      ? { goals: 2, assists: 1, appearances: 3, minutes: 270, yellowCards: 2, redCards: 1 }
      : index === 1
        ? { goals: 2, assists: 1, appearances: 3, minutes: 270, yellowCards: 0, redCards: 0 }
        : index === 2
          ? { goals: 2, assists: 1, appearances: 3, minutes: 270, yellowCards: 1, redCards: 0 }
          : index === 3
            ? { goals: 2, assists: 1, appearances: 2, minutes: 180, yellowCards: 0, redCards: 0 }
            : candidate.stats;
    return { ...candidate, stats, points: calculateBallonDorPoints(stats) };
  });
  const withStats = { ...locked, candidates };
  const original = JSON.stringify(withStats);
  const positions = candidates.map((candidate, index) => ({ teamId: candidate.clubId, position: index + 1 }));

  const calculated = calculateBallonDorResult(withStats, positions, 1030);
  assert.equal(calculated.ok, true);
  assert.equal(JSON.stringify(withStats), original, 'el cálculo es puro');
  assert.equal(calculated.candidates[0].points.teamBonus, 5, 'campeón +5');
  assert.equal(calculated.candidates[1].points.teamBonus, 3, 'subcampeón +3');
  assert.equal(calculated.candidates[2].points.teamBonus, 1, 'tercero +1');
  assert.equal(calculated.candidates[3].points.teamBonus, 1, 'cuarto +1');
  assert.equal(calculated.candidates[4].points.teamBonus, 0, 'resto +0');
  assert.equal(calculated.result.winnerCandidateId, candidates[1].id, 'el bonus puede decidir al ganador');
  assert.equal(calculated.result.ranking[1].candidateId, candidates[3].id,
    'a igual puntaje, goles y asistencias, menor penalización disciplinaria gana');
  assert.equal(calculated.result.ranking[2].candidateId, candidates[2].id);
  assert.deepEqual(calculated.result.ranking.slice(4).map(row => row.candidateId),
    candidates.slice(4).map(candidate => candidate.id), 'último desempate estable por club:dorsal');
  assert.equal(calculated.result.ranking.length, 16);

  const finalized = finalizeBallonDorEvent(withStats, positions, 1030);
  assert.equal(finalized.ok, true);
  assert.equal(finalized.event.status, 'settled');
  assert.equal(finalized.event.settledAt, 1030);
  assert.deepEqual(finalized.event.result, calculated.result);
  assert.equal(finalized.event.candidates[1].points.total, finalized.event.result.winnerScore);
  assert.equal(calculateBallonDorResult(locked, positions, 1030).ok, true,
    'también puede finalizarse desde stats válidas antes de aplicar el bonus');
  assert.equal(calculateBallonDorResult(initial, positions, 1030).reason, 'evento_no_bloqueado');
  assert.equal(calculateBallonDorResult(withStats, positions.slice(1), 1030).reason, 'clasificacion_invalida');
  assert.equal(calculateBallonDorResult(withStats, positions.map((row, index) => index === 1
    ? { ...row, position: positions[0].position } : row), 1030).reason, 'clasificacion_invalida');
});

test('cleanLeague mantiene temporadas antiguas sin evento y rehidrata contratos válidos', () => {
  const baseLeague = { seasonMonth: '2026-10', status: 'active', config: [], standings: [] };
  assert.equal(cleanLeague(baseLeague).ballonDor, null, 'no se inventa un premio retroactivo');
  const event = createBallonDorEvent('2026-10', seasonClubs(), 1000);
  assert.deepEqual(cleanLeague({ ...baseLeague, ballonDor: event }).ballonDor, event);
  assert.equal(cleanLeague({ ...baseLeague, ballonDor: { ...event, seasonMonth: '2026-11', id: 'bdo_2026-11' } }).ballonDor,
    null, 'un evento de otro mes no se adhiere a la liga');
});
