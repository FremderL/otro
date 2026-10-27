'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { cleanMatch } = require('../lib/football-store-shared');
const { aggregateBallonDorMatch } = require('../lib/football/ballon-dor-stats');
const { createBallonDorEvent, cleanBallonDorEvent } = require('../lib/football/ballon-dor');
const { generateTimeline } = require('../lib/football/match-engine');
const { createLineups } = require('../lib/football/match-state');
const { buildSeasonClubs } = require('../lib/football/teams');
const { hash32, mulberry32 } = require('../lib/football/prng');

const SEASON = '2026-10';

function buildAwardFixture(match, home, away, homeCandidate, awayCandidate) {
  const lineups = createLineups(home, away);
  const events = [];
  let order = 0;
  const push = event => events.push({ ...event, i: order++ });

  const activateCandidate = (side, lineup, candidate, excludedIds = []) => {
    const player = lineup.players.find(item => item.id === candidate.playerId);
    assert.ok(player, `${candidate.playerId} debe estar en la plantilla completa`);
    if (player.initialStatus === 'active') return;
    const outgoing = lineup.players.find(item => item.initialStatus === 'active'
      && item.id !== candidate.playerId && !excludedIds.includes(item.id));
    assert.ok(outgoing, 'hay un titular disponible para el cambio de fixture');
    push({
      t: 5, type: 'substitution', team: side, half: 1,
      playerInId: player.id, playerOutId: outgoing.id
    });
  };

  const homeScorer = lineups.home.players.find(player => player.initialStatus === 'active'
    && player.id !== homeCandidate.playerId);
  assert.ok(homeScorer, 'hay un goleador local distinto del candidato');
  activateCandidate('home', lineups.home, homeCandidate, [homeScorer.id]);
  activateCandidate('away', lineups.away, awayCandidate);

  // Un gol regular válido acredita la asistencia al candidato local.
  push({ t: 10, type: 'goal', team: 'home', half: 1, playerId: homeScorer.id, assistId: homeCandidate.playerId });
  // Un penal convertido es gol, pero no concede asistencia aunque viniera un ID.
  push({ t: 20, type: 'penalty_scored', team: 'home', half: 1, playerId: homeCandidate.playerId, assistId: homeScorer.id });
  push({ t: 25, type: 'yellow_card', team: 'home', half: 1, playerId: homeCandidate.playerId });
  push({ t: 30, type: 'second_yellow', team: 'home', half: 1, playerId: homeCandidate.playerId });
  // Una asistencia de otro club no es válida y no debe acreditarse.
  push({ t: 40, type: 'goal', team: 'away', half: 1, playerId: awayCandidate.playerId, assistId: homeCandidate.playerId });
  push({ t: 50, type: 'red_card', team: 'away', half: 2, playerId: awayCandidate.playerId });
  push({ t: 90, type: 'full_time', team: null, half: 2 });
  // Incluso si una timeline trae tiempo extra, sus eventos no cuentan para J1–30.
  push({ t: 90, type: 'extra_time_start', team: null, half: 3 });
  push({ t: 105, type: 'goal', team: 'home', half: 3, playerId: homeCandidate.playerId });

  return { match, lineups, timeline: events };
}

test('agregador acredita goles/asistencias válidos, minutos, apariciones y disciplina regular', () => {
  const clubs = buildSeasonClubs(mulberry32(hash32(`${SEASON}plantillas`)));
  const event = createBallonDorEvent(SEASON, clubs, 1000);
  const match = { id: 'fixture_regular', seasonMonth: SEASON, jornada: 1, homeId: clubs[0].id, awayId: clubs[1].id };
  const homeCandidate = event.candidates.find(candidate => candidate.clubId === match.homeId);
  const awayCandidate = event.candidates.find(candidate => candidate.clubId === match.awayId);
  const fixture = buildAwardFixture(match, clubs[0], clubs[1], homeCandidate, awayCandidate);

  const aggregated = aggregateBallonDorMatch(event, match, fixture.timeline, fixture.lineups, {
    expectedScore: { home: 2, away: 1 }, at: 1010
  });
  assert.equal(aggregated.ok, true);
  const home = aggregated.event.candidates.find(candidate => candidate.id === homeCandidate.id);
  const away = aggregated.event.candidates.find(candidate => candidate.id === awayCandidate.id);
  const homeStarted = fixture.lineups.home.players.find(player => player.id === homeCandidate.playerId).initialStatus === 'active';
  const awayStarted = fixture.lineups.away.players.find(player => player.id === awayCandidate.playerId).initialStatus === 'active';

  assert.deepEqual(home.stats, {
    goals: 1, assists: 1, appearances: 1, minutes: homeStarted ? 30 : 25, yellowCards: 2, redCards: 1
  });
  assert.deepEqual(home.points, {
    goals: 5, assists: 3, appearances: 1, yellowCards: -2, redCards: -3, teamBonus: 0, total: 4
  });
  assert.deepEqual(away.stats, {
    goals: 1, assists: 0, appearances: 1, minutes: awayStarted ? 50 : 45, yellowCards: 0, redCards: 1
  });
  assert.deepEqual(away.points, {
    goals: 5, assists: 0, appearances: 1, yellowCards: 0, redCards: -3, teamBonus: 0, total: 3
  });
  assert.equal(cleanBallonDorEvent(aggregated.event, SEASON).candidates.length, 16);

  const mismatch = aggregateBallonDorMatch(event, match, fixture.timeline, fixture.lineups, {
    expectedScore: { home: 1, away: 1 }, at: 1010
  });
  assert.deepEqual(mismatch, { ok: false, reason: 'marcador_no_coincide_con_timeline' });
  assert.equal(event.candidates.find(candidate => candidate.id === homeCandidate.id).stats.goals, 0,
    'un fallo no muta el evento original');

  const tiebreakMatch = cleanMatch({ ...match, jornada: 31, desempate: true });
  assert.equal(tiebreakMatch.desempate, true, 'la limpieza preserva el marcador especial para los replays');
  const tiebreak = aggregateBallonDorMatch(event, tiebreakMatch, fixture.timeline, fixture.lineups);
  assert.equal(tiebreak.ok, true);
  assert.equal(tiebreak.included, false, 'el desempate no aporta estadísticas');
  assert.deepEqual(tiebreak.event, event);
});

test('el asentado persiste estadísticas en la misma transición y un replay no duplica', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballon-dor-settle-'));
  const filePath = path.join(dir, 'league.json');
  try {
    const store = new FootballStore(filePath);
    const league = store.generateSeason(SEASON);
    const match = league.calendar.jornadas[0].matches[0];
    const home = league.config.find(club => club.id === match.homeId);
    const away = league.config.find(club => club.id === match.awayId);
    const homeCandidate = league.ballonDor.candidates.find(candidate => candidate.clubId === match.homeId);
    const awayCandidate = league.ballonDor.candidates.find(candidate => candidate.clubId === match.awayId);
    const fixture = buildAwardFixture(match, home, away, homeCandidate, awayCandidate);
    const settled = store.settleMatch(match.id, { home: 2, away: 1 }, {
      seasonMonth: SEASON, now: league.ballonDor.createdAt + 10,
      timeline: fixture.timeline, lineups: fixture.lineups
    });
    assert.equal(settled.ok, true);
    assert.equal(match.status, 'settled');
    const snapshot = JSON.parse(JSON.stringify(league.ballonDor));
    assert.equal(snapshot.candidates.find(candidate => candidate.id === homeCandidate.id).stats.appearances, 1);
    assert.equal(snapshot.candidates.find(candidate => candidate.id === awayCandidate.id).stats.goals, 1);

    const replay = store.settleMatch(match.id, { home: 0, away: 0 }, {
      seasonMonth: SEASON, now: league.ballonDor.createdAt + 20,
      timeline: [], lineups: fixture.lineups
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.alreadySettled, true);
    assert.deepEqual(league.ballonDor, snapshot, 'el reintento no suma ni altera estadísticas');
    store.close();

    const reloaded = new FootballStore(filePath);
    assert.deepEqual(reloaded.getBallonDor(SEASON), snapshot, 'stats y puntos se rehidratan desde el mismo snapshot JSON');
    const afterRestart = reloaded.settleMatch(match.id, { home: 2, away: 1 }, { seasonMonth: SEASON });
    assert.equal(afterRestart.alreadySettled, true);
    assert.deepEqual(reloaded.getBallonDor(SEASON), snapshot, 'replay post-reinicio tampoco duplica');
    reloaded.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function independentlyReconstructSeason(expected, candidates, match, timeline, lineups) {
  const end = timeline.find(event => event.type === 'full_time' && event.half === 2).t;
  const roster = new Map();
  const onPitch = new Set();
  const elapsed = new Map();
  for (const side of ['home', 'away']) {
    for (const player of lineups[side].players) {
      roster.set(player.id, { clubId: side === 'home' ? match.homeId : match.awayId, side });
      elapsed.set(player.id, 0);
      if (player.initialStatus === 'active') onPitch.add(player.id);
    }
  }

  let clock = 0;
  const ordered = timeline.slice().sort((a, b) => a.t - b.t || a.i - b.i);
  for (const event of ordered) {
    if (event.t > end) break;
    const elapsedSinceEvent = event.t - clock;
    for (const playerId of onPitch) elapsed.set(playerId, elapsed.get(playerId) + elapsedSinceEvent);
    clock = event.t;
    if (event.half !== 1 && event.half !== 2) continue;
    if (event.type === 'substitution') {
      onPitch.delete(event.playerOutId);
      onPitch.add(event.playerInId || event.playerId);
    } else if (event.type === 'red_card' || event.type === 'second_yellow') {
      onPitch.delete(event.playerId);
    }
  }
  for (const playerId of onPitch) elapsed.set(playerId, elapsed.get(playerId) + end - clock);

  const candidateByPlayer = new Map(candidates.map(candidate => [candidate.playerId, candidate]));
  for (const candidate of candidates) {
    if (candidate.clubId !== match.homeId && candidate.clubId !== match.awayId) continue;
    const minutesPlayed = elapsed.get(candidate.playerId) || 0;
    const totalMinutes = Math.floor(minutesPlayed + 1e-9);
    const row = expected.get(candidate.id);
    row.minutes += totalMinutes;
    row.appearances += minutesPlayed >= 1 - 1e-9 ? 1 : 0;
  }

  for (const event of timeline) {
    if (event.t > end || (event.half !== 1 && event.half !== 2)) continue;
    const sideClub = event.team === 'home' ? match.homeId : event.team === 'away' ? match.awayId : null;
    const scorer = event.playerId && roster.get(event.playerId);
    if ((event.type === 'goal' || event.type === 'penalty_scored') && scorer && scorer.clubId === sideClub) {
      const candidate = candidateByPlayer.get(event.playerId);
      if (candidate && candidate.clubId === sideClub) expected.get(candidate.id).goals++;
      if (event.type === 'goal' && event.assistId && event.assistId !== event.playerId) {
        const assister = roster.get(event.assistId);
        const assisterCandidate = candidateByPlayer.get(event.assistId);
        if (assister && assister.clubId === sideClub && assisterCandidate && assisterCandidate.clubId === sideClub) {
          expected.get(assisterCandidate.id).assists++;
        }
      }
    }
    if (['yellow_card', 'second_yellow', 'red_card'].includes(event.type)) {
      const cardPlayer = roster.get(event.playerId);
      const candidate = candidateByPlayer.get(event.playerId);
      if (cardPlayer && candidate && candidate.clubId === sideClub) {
        const stats = expected.get(candidate.id);
        if (event.type === 'yellow_card' || event.type === 'second_yellow') stats.yellowCards++;
        if (event.type === 'red_card' || event.type === 'second_yellow') stats.redCards++;
      }
    }
  }
}

test('los agregados de los 240 partidos coinciden con una reconstrucción independiente de la temporada', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballon-dor-season-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FootballStore(path.join(dir, 'unused.json'));
  // En esta prueba se verifica la unidad de persistencia en memoria, no la E/S repetida.
  store.saveNow = () => undefined;
  const league = store.generateSeason(SEASON);
  const candidates = league.ballonDor.candidates;
  const expected = new Map(candidates.map(candidate => [candidate.id, {
    goals: 0, assists: 0, appearances: 0, minutes: 0, yellowCards: 0, redCards: 0
  }]));
  const startedAt = league.ballonDor.createdAt;
  await store.transitionBallonDor(SEASON, 'active', { at: startedAt + 1 });
  await store.transitionBallonDor(SEASON, 'locked', { at: startedAt + 2 });
  const beforeClose = await store.finalizeBallonDor(SEASON, [], { at: startedAt + 3 });
  assert.equal(beforeClose.ok, false);
  assert.equal(beforeClose.reason, 'temporada_incompleta', 'no se calcula el resultado antes de cerrar J30');

  for (const [index, match] of league.calendar.matches.entries()) {
    const home = league.config.find(club => club.id === match.homeId);
    const away = league.config.find(club => club.id === match.awayId);
    const context = league.ctx || {};
    const simulation = generateTimeline(home, away, {
      leagueAvg: context.leagueAvg, homeAdv: context.homeAdv, rho: context.rho,
      esDesempate: Boolean(match.desempate)
    }, mulberry32(match.seed));
    independentlyReconstructSeason(expected, candidates, match, simulation.timeline, simulation.lineups);
    const settled = store.settleMatch(match.id, simulation.score, {
      seasonMonth: SEASON,
      now: startedAt + index + 100,
      timeline: simulation.timeline,
      lineups: simulation.lineups
    });
    assert.equal(settled.ok, true, `asentado ${match.id}: ${settled.detail || settled.reason || ''}`);
  }

  const actual = store.getBallonDor(SEASON);
  assert.equal(actual.candidates.length, 16);
  for (const candidate of actual.candidates) {
    const stats = expected.get(candidate.id);
    assert.deepEqual(candidate.stats, stats, `estadísticas reconstruidas: ${candidate.clubShort}`);
    assert.deepEqual(candidate.points, {
      goals: stats.goals * 5,
      assists: stats.assists * 3,
      appearances: stats.appearances,
      yellowCards: stats.yellowCards ? -stats.yellowCards : 0,
      redCards: stats.redCards ? -3 * stats.redCards : 0,
      teamBonus: 0,
      total: 5 * stats.goals + 3 * stats.assists + stats.appearances - stats.yellowCards - 3 * stats.redCards
    }, `desglose de puntos: ${candidate.clubShort}`);
  }
  assert.equal(league.calendar.matches.filter(match => match.status === 'settled').length, 240);

  const officialPositions = league.standings.map((row, index) => ({ teamId: row.teamId, position: index + 1 }));
  const finalized = await store.finalizeBallonDor(SEASON, officialPositions, { at: startedAt + 1000 });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.event.status, 'settled');
  assert.equal(finalized.event.result.ranking.length, 16);
  assert.equal(finalized.event.result.winnerCandidateId, finalized.event.result.ranking[0].candidateId);
  for (const candidate of finalized.event.candidates) {
    const position = officialPositions.find(row => row.teamId === candidate.clubId).position;
    const bonus = position === 1 ? 5 : position === 2 ? 3 : position <= 4 ? 1 : 0;
    assert.equal(candidate.points.teamBonus, bonus);
  }
  const resultSnapshot = JSON.stringify(finalized.event);
  const replayClose = await store.finalizeBallonDor(SEASON, officialPositions, { at: startedAt + 1001 });
  assert.equal(replayClose.already, true);
  assert.equal(JSON.stringify(store.getBallonDor(SEASON)), resultSnapshot, 'finalizar de nuevo no vuelve a puntuar');
  store.close();
});
