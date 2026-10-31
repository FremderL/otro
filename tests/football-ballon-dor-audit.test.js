'use strict';

// El acumulado del Balón de Oro contra el archivo por partido.
//
// El resumen de un partido y la ficha del premio deben decir lo mismo: si el
// jugador hizo 2 goles y 3 asistencias en el partido, el acumulado tiene que ser
// exactamente esa suma. La auditoría rehace el acumulado desde
// `match.fantasyStats` (el archivo asentado con la misma línea de tiempo que el
// resultado) y la reparación lo corrige cuando un partido se contó dos veces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { createLineups } = require('../lib/football/match-state');
const { calculateBallonDorPoints } = require('../lib/football/ballon-dor');
const { generateTimeline } = require('../lib/football/match-engine');
const { mulberry32 } = require('../lib/football/prng');
const { auditBallonDor, planBallonDorRepair, archivedContribution } = require('../lib/football/ballon-dor-audit');

const SEASON = '2026-10';

// Línea de tiempo con el caso del reporte: el delantero local hace 2 goles y
// reparte 3 asistencias; el visitante marca una vez. 5–1.
function buildFixture(match, home, away, candidateIds) {
  const lineups = createLineups(home, away);
  const events = [];
  let order = 0;
  const push = event => events.push({ ...event, i: order++ });

  const activate = (side, lineup, playerId) => {
    const player = lineup.players.find(item => item.id === playerId);
    assert.ok(player, 'el candidato debe estar en la plantilla');
    if (player.initialStatus === 'active') return;
    const outgoing = lineup.players.find(item => item.initialStatus === 'active' && item.id !== playerId);
    push({ t: 2, type: 'substitution', team: side, half: 1, playerInId: playerId, playerOutId: outgoing.id });
  };
  activate('home', lineups.home, candidateIds.home);
  activate('away', lineups.away, candidateIds.away);

  const homeMates = lineups.home.players.filter(player => player.initialStatus === 'active'
    && player.id !== candidateIds.home);
  assert.ok(homeMates.length >= 3, 'hacen falta tres compañeros para las asistencias');

  push({ t: 10, type: 'goal', team: 'home', half: 1, playerId: candidateIds.home, assistId: homeMates[0].id });
  push({ t: 15, type: 'goal', team: 'home', half: 1, playerId: homeMates[0].id, assistId: candidateIds.home });
  push({ t: 20, type: 'goal', team: 'home', half: 1, playerId: homeMates[1].id, assistId: candidateIds.home });
  push({ t: 25, type: 'goal', team: 'home', half: 2, playerId: homeMates[2].id, assistId: candidateIds.home });
  push({ t: 30, type: 'yellow_card', team: 'home', half: 1, playerId: candidateIds.home });
  push({ t: 55, type: 'goal', team: 'away', half: 2, playerId: candidateIds.away });
  push({ t: 70, type: 'goal', team: 'home', half: 2, playerId: candidateIds.home });
  push({ t: 90, type: 'full_time', team: null, half: 2 });
  return { lineups, timeline: events };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballon-dor-audit-'));
  const store = new FootballStore(path.join(dir, 'league.json'));
  const league = store.generateSeason(SEASON);
  const match = league.calendar.jornadas[0].matches[0];
  const home = league.config.find(club => club.id === match.homeId);
  const away = league.config.find(club => club.id === match.awayId);
  const homeCandidate = league.ballonDor.candidates.find(candidate => candidate.clubId === match.homeId);
  const awayCandidate = league.ballonDor.candidates.find(candidate => candidate.clubId === match.awayId);
  const fixture = buildFixture(match, home, away, {
    home: homeCandidate.playerId, away: awayCandidate.playerId
  });
  return { dir, store, league, match, homeCandidate, awayCandidate, fixture };
}

function rebuildPoints(event) {
  event.candidates = event.candidates.map(candidate => ({
    ...candidate,
    points: calculateBallonDorPoints(candidate.stats, candidate.points.teamBonus)
  }));
  return event;
}

test('el archivo por partido guarda goles, asistencias, minutos y amarillas del jugador', t => {
  const ctx = setup();
  t.after(() => { ctx.store.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });
  const settled = ctx.store.settleMatch(ctx.match.id, { home: 5, away: 1 }, {
    seasonMonth: SEASON, now: ctx.league.ballonDor.createdAt + 10,
    timeline: ctx.fixture.timeline, lineups: ctx.fixture.lineups
  });
  assert.equal(settled.ok, true);
  const row = ctx.match.fantasyStats.find(item => item.id === ctx.homeCandidate.playerId);
  assert.ok(row, 'el candidato figura en el archivo del partido');
  assert.equal(row.goals, 2);
  assert.equal(row.assists, 3);
  assert.equal(row.yellows, 1);
  assert.ok(Number.isInteger(row.minutes) && row.minutes > 0, 'los minutos quedan archivados');
  const archiveRow = ctx.match.fantasyStats.find(item => item.id === ctx.awayCandidate.playerId);
  assert.equal(archiveRow.goals, 1);
});

test('el acumulado limpio cuadra con el archivo: nada que reparar', t => {
  const ctx = setup();
  t.after(() => { ctx.store.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });
  ctx.store.settleMatch(ctx.match.id, { home: 5, away: 1 }, {
    seasonMonth: SEASON, now: ctx.league.ballonDor.createdAt + 10,
    timeline: ctx.fixture.timeline, lineups: ctx.fixture.lineups
  });
  const audit = auditBallonDor(ctx.league);
  assert.equal(audit.ok, true);
  assert.equal(audit.mismatched, 0);
  const home = audit.candidates.find(candidate => candidate.candidateId === ctx.homeCandidate.id);
  assert.deepEqual(
    { goals: home.event.goals, assists: home.event.assists },
    { goals: 2, assists: 3 },
    'el premio y el resumen del partido coinciden'
  );
  const plan = planBallonDorRepair(ctx.league, { at: Date.now() });
  assert.equal(plan.ok, true);
  assert.equal(plan.already, true);
  assert.deepEqual(plan.changes, []);
});

test('el doble conteo de un partido se detecta y la reparación devuelve las cifras del archivo', async t => {
  const ctx = setup();
  t.after(() => { ctx.store.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });
  ctx.store.settleMatch(ctx.match.id, { home: 5, away: 1 }, {
    seasonMonth: SEASON, now: ctx.league.ballonDor.createdAt + 10,
    timeline: ctx.fixture.timeline, lineups: ctx.fixture.lineups
  });

  // Simulación exacta del doble asentado: el partido se aplicó dos veces y el
  // jugador aparece con un gol y una asistencia de más (1/2 → 2/3 del reporte).
  const candidate = ctx.league.ballonDor.candidates.find(item => item.id === ctx.homeCandidate.id);
  candidate.stats = { ...candidate.stats, goals: 3, assists: 4, appearances: 2, minutes: candidate.stats.minutes * 2 };
  rebuildPoints(ctx.league.ballonDor);

  const audit = auditBallonDor(ctx.league);
  assert.equal(audit.mismatched, 1);
  assert.equal(audit.repairable, true);
  const found = audit.candidates.find(item => item.candidateId === ctx.homeCandidate.id);
  assert.equal(found.consistent, false);
  assert.deepEqual(found.delta.goals, 1);
  assert.deepEqual(found.delta.assists, 1);

  const applied = await ctx.store.repairBallonDor(SEASON, { apply: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.already, false);
  assert.equal(applied.changes.length, 1);
  const repaired = ctx.store.getBallonDor(SEASON).candidates.find(item => item.id === ctx.homeCandidate.id);
  assert.deepEqual(
    { goals: repaired.stats.goals, assists: repaired.stats.assists, appearances: repaired.stats.appearances },
    { goals: 2, assists: 3, appearances: 1 }
  );
  assert.deepEqual(repaired.points, calculateBallonDorPoints(repaired.stats, repaired.points.teamBonus));
  assert.equal(auditBallonDor(ctx.league).mismatched, 0, 'la reparación es idempotente');

  // El resto de candidatos sin partidos no se toca.
  const untouched = ctx.store.getBallonDor(SEASON).candidates.find(item => item.id === ctx.awayCandidate.id);
  assert.equal(untouched.stats.goals, 1);
});

test('un evento ya cerrado no se reescribe: solo se reporta', t => {
  const ctx = setup();
  t.after(() => { ctx.store.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });
  ctx.store.settleMatch(ctx.match.id, { home: 5, away: 1 }, {
    seasonMonth: SEASON, now: ctx.league.ballonDor.createdAt + 10,
    timeline: ctx.fixture.timeline, lineups: ctx.fixture.lineups
  });
  ctx.league.ballonDor.status = 'settled';
  const candidate = ctx.league.ballonDor.candidates.find(item => item.id === ctx.homeCandidate.id);
  candidate.stats = { ...candidate.stats, goals: 3, assists: 4 };
  rebuildPoints(ctx.league.ballonDor);
  const plan = planBallonDorRepair(ctx.league, { at: Date.now() });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'evento_cerrado');
  assert.deepEqual(plan.changes, []);
});

test('sin archivo de partido no se inventa nada: el candidato queda sin verificar', t => {
  const ctx = setup();
  t.after(() => { ctx.store.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });
  ctx.match.status = 'settled';
  ctx.match.result = { home: 5, away: 1, winner: 'home' };
  ctx.match.fantasyStats = null;
  const candidate = ctx.league.ballonDor.candidates.find(item => item.id === ctx.homeCandidate.id);
  candidate.stats = { ...candidate.stats, goals: 2, assists: 3, appearances: 1, minutes: 90 };
  rebuildPoints(ctx.league.ballonDor);

  const archived = archivedContribution(ctx.league, candidate);
  assert.equal(archived.matches, 1);
  assert.equal(archived.complete, false);
  const audit = auditBallonDor(ctx.league);
  const unverifiable = audit.candidates.find(item => item.candidateId === ctx.homeCandidate.id);
  assert.equal(unverifiable.verifiable, false, 'sin archivo no hay nada verificable');
  const plan = planBallonDorRepair(ctx.league, { at: Date.now() });
  assert.equal(plan.already, true);
  assert.deepEqual(plan.changes, []);
  assert.ok(plan.skipped >= 1);
});

test('una temporada asentada cuadra con el archivo y no propone reparaciones', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballon-dor-audit-season-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FootballStore(path.join(dir, 'league.json'));
  // La unidad bajo prueba es la aritmética del premio, no la E/S repetida.
  store.saveNow = () => undefined;
  const league = store.generateSeason(SEASON);
  await store.transitionBallonDor(SEASON, 'active', { at: league.ballonDor.createdAt + 1 });
  const matches = league.calendar.matches.filter(match => match.jornada <= 3);
  for (const [index, match] of matches.entries()) {
    const home = league.config.find(club => club.id === match.homeId);
    const away = league.config.find(club => club.id === match.awayId);
    const context = league.ctx || {};
    const simulation = generateTimeline(home, away, {
      leagueAvg: context.leagueAvg, homeAdv: context.homeAdv, rho: context.rho
    }, mulberry32(match.seed));
    const settled = store.settleMatch(match.id, simulation.score, {
      seasonMonth: SEASON,
      now: league.ballonDor.createdAt + 100 + index,
      timeline: simulation.timeline,
      lineups: simulation.lineups
    });
    assert.equal(settled.ok, true, `asentado ${match.id}: ${settled.detail || settled.reason || ''}`);
  }
  const audit = store.auditBallonDor(SEASON);
  assert.equal(audit.ok, true);
  assert.equal(audit.mismatched, 0, 'ningún club se contó dos veces');
  const played = audit.candidates.filter(candidate => candidate.archived.appearances > 0);
  assert.ok(played.length > 0, 'los delanteros de los clubes que jugaron aparecen en el archivo');
  for (const candidate of played) {
    assert.equal(candidate.delta.minutes, 0, `minutos verificables: ${candidate.playerName}`);
    assert.equal(candidate.delta.yellowCards, 0, `amarillas verificables: ${candidate.playerName}`);
  }
  const plan = await store.repairBallonDor(SEASON, { apply: true });
  assert.equal(plan.already, true);
  assert.deepEqual(plan.changes, []);
  store.close();
});

test('los partidos asentados sin minutos ni amarillas siguen cargando el archivo', () => {
  const { cleanFantasyStats } = require('../lib/football/fantasy');
  const match = { id: 'vf', seasonMonth: SEASON, jornada: 1, homeId: 'a', awayId: 'b', status: 'settled' };
  const legacy = [{ id: 'p1', teamId: 'a', played: true, goals: 1, assists: 2, reds: 0 }];
  const cleaned = cleanFantasyStats(legacy, match);
  assert.deepEqual(cleaned, legacy, 'el formato viejo se conserva tal cual');
  const full = [{ id: 'p1', teamId: 'a', played: true, goals: 1, assists: 2, reds: 0, minutes: 77, yellows: 1 }];
  assert.deepEqual(cleanFantasyStats(full, match), full);
});
