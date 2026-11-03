'use strict';

// Parche de elegibilidad: el Balón de Oro ya no exige 240/240. Con más del 90%
// asentado (217/240) y archivo estadístico completo puede cerrarse en su ventana.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { PgFootballStore } = require('../lib/football-store-pg');
const { generateTimeline } = require('../lib/football/match-engine');
const { mulberry32 } = require('../lib/football/prng');
const { zonedTimeToMs } = require('../lib/football/fixtures');
const { CASINO_TIME_ZONE } = require('../lib/profile-store-shared');
const {
  BALLON_DOR_REGULAR_MATCH_COUNT, BALLON_DOR_MIN_COMPLETION_PERCENT,
  BALLON_DOR_MIN_SETTLED_MATCH_COUNT, ballonDorReadiness
} = require('../lib/football/ballon-dor-readiness');
const {
  BallonDorMarketService, officialPositions, closeDeadline,
  ballonDorFinalizationSchedule, ballonDorResultAnnouncementAt
} = require('../lib/football/ballon-dor-market');
const { buildClubNews } = require('../lib/football/club-news');
const { cleanBallonDorEvent } = require('../lib/football/ballon-dor');

const SEASON = '2099-11';
const OPEN_AT = zonedTimeToMs({ year: 2099, month: 11, day: 1 }, CASINO_TIME_ZONE);
const MATCH_RUNTIME_MS = 90 * 60 * 1000;

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdo-readiness-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason(SEASON, { createdAt: OPEN_AT });
  store.saveNow = () => {};
  t.after(() => {
    try { store.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, league };
}

// Pool simulado con la misma costura que tests/football-store-pg.test.js.
function mockPool() {
  return {
    connectionString: 'postgres://mock-host/mockdb',
    on() {},
    async query() { return { rows: [] }; },
    async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
    async end() {}
  };
}

async function pgHarness(t) {
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool: mockPool() });
  t.after(() => { try { store.close(); } catch (_) {} });
  await store.ready;
  const league = store.generateSeason(SEASON, { createdAt: OPEN_AT });
  store.saveNow = () => {};
  return { store, league };
}

function teamOrder(league) {
  return new Map(league.config.map((club, index) => [club.id, index]));
}

function deterministicResult(match, order) {
  return order.get(match.homeId) < order.get(match.awayId)
    ? { home: 2, away: 0 } : { home: 0, away: 2 };
}

// Asienta con cronología real para que `fantasyStats` quede archivado y la
// muestra parcial sea verificable candidato por candidato.
function settleMatches(store, league, count, { startAt = OPEN_AT + 1000, resultFn } = {}) {
  const order = teamOrder(league);
  const matches = league.calendar.matches.filter(m => !m.desempate).slice(0, count);
  let lastAt = startAt;
  for (const [index, match] of matches.entries()) {
    if (match.status === 'settled' && match.result) {
      lastAt = Math.max(lastAt, match.settledAt || startAt + index);
      continue;
    }
    const home = league.config.find(club => club.id === match.homeId);
    const away = league.config.find(club => club.id === match.awayId);
    const ctx = league.ctx || {};
    const forced = resultFn ? resultFn(match, order) : deterministicResult(match, order);
    const simulation = generateTimeline(home, away, {
      leagueAvg: ctx.leagueAvg, homeAdv: ctx.homeAdv, rho: ctx.rho,
      forcedScore: forced
    }, mulberry32(match.seed));
    const settledAt = Math.max(startAt + index, match.scheduledKickoffAt + MATCH_RUNTIME_MS);
    const settled = store.settleMatch(match.id, simulation.score, {
      seasonMonth: SEASON, now: settledAt,
      timeline: simulation.timeline, lineups: simulation.lineups
    });
    assert.equal(settled.ok, true, `${match.id}: ${settled.reason || settled.detail || ''}`);
    lastAt = Math.max(lastAt, settledAt);
  }
  return lastAt;
}

function fakeProjectOdds({ league, afterJornada, updatedAt }) {
  const { SIMULATIONS, OVERROUND, oddsFromProbability } = require('../lib/football/ballon-dor-market');
  const wins = SIMULATIONS / 16;
  return {
    updatedAt: Math.max(updatedAt, league.ballonDor.updatedAt),
    afterJornada, simulations: SIMULATIONS, seed: 1, overround: OVERROUND,
    selections: league.ballonDor.candidates.map(candidate => ({
      candidateId: candidate.id, wins, probability: wins / SIMULATIONS,
      odds: oddsFromProbability(wins / SIMULATIONS)
    })).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  };
}

test('el umbral es estrictamente mayor que 90%: 216 no basta, 217 sí', () => {
  assert.equal(BALLON_DOR_REGULAR_MATCH_COUNT, 240);
  assert.equal(BALLON_DOR_MIN_COMPLETION_PERCENT, 90);
  assert.equal(BALLON_DOR_MIN_SETTLED_MATCH_COUNT, 217);
});

test('216/240 sigue bloqueado y 217/240 con archivo completo es elegible', t => {
  const { store, league } = harness(t);
  let lastAt = settleMatches(store, league, 216);
  let readiness = ballonDorReadiness(league, { asOf: lastAt });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, 'cobertura_insuficiente');
  assert.equal(readiness.played, 216);

  lastAt = settleMatches(store, league, 217);
  readiness = ballonDorReadiness(league, { asOf: lastAt });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.complete, false);
  assert.deepEqual(readiness.coverage, { played: 217, total: 240, minimum: 217 });
  assert.equal(readiness.matches.length, 217);
});

test('sin archivo estadístico suficiente la cobertura por sí sola no habilita el cierre', t => {
  const { store, league } = harness(t);
  const lastAt = settleMatches(store, league, 217);
  const counted = league.calendar.matches.find(m => !m.desempate && m.status === 'settled');
  const archived = counted.fantasyStats;
  counted.fantasyStats = null;
  const readiness = ballonDorReadiness(league, { asOf: lastAt });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, 'estadisticas_insuficientes');
  counted.fantasyStats = archived;
  assert.equal(ballonDorReadiness(league, { asOf: lastAt }).ok, true);
});

test('un acta tardía fuera del corte no entra en la muestra parcial', t => {
  const { store, league } = harness(t);
  const cutoff = settleMatches(store, league, 216);
  const next = league.calendar.matches.filter(m => !m.desempate)[216];
  const home = league.config.find(club => club.id === next.homeId);
  const away = league.config.find(club => club.id === next.awayId);
  const simulation = generateTimeline(home, away, { forcedScore: { home: 1, away: 0 } }, mulberry32(next.seed));
  store.settleMatch(next.id, simulation.score, {
    seasonMonth: SEASON, now: cutoff + 60_000,
    timeline: simulation.timeline, lineups: simulation.lineups
  });
  assert.equal(ballonDorReadiness(league, { asOf: cutoff }).ok, false);
  const readiness = ballonDorReadiness(league, { asOf: cutoff + 60_000 });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.played, 217);
});

test('officialPositions sigue exigiendo 240/240 por defecto y solo admite parcial con opt-in', t => {
  const { store, league } = harness(t);
  const lastAt = settleMatches(store, league, 217);
  assert.equal(officialPositions(league).ok, false);
  const partial = officialPositions(league, { allowPartial: true, asOf: lastAt });
  assert.equal(partial.ok, true);
  assert.equal(partial.positions.length, 16);
});

test('el store persiste un cierre parcial con coverage y rechaza 216/240', async t => {
  const { store, league } = harness(t);
  await store.transitionBallonDor(SEASON, 'active', { at: OPEN_AT + 1 });
  let lastAt = settleMatches(store, league, 216);
  const positions = league.config.map((club, index) => ({ teamId: club.id, position: index + 1 }));
  const early = await store.finalizeBallonDor(SEASON, positions, { at: lastAt, cutoffAt: lastAt });
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'temporada_incompleta');

  lastAt = settleMatches(store, league, 217);
  const finalized = await store.finalizeBallonDor(SEASON, positions, { at: lastAt, cutoffAt: lastAt });
  assert.equal(finalized.ok, true);
  assert.deepEqual(finalized.event.result.coverage, { played: 217, total: 240, minimum: 217 });
  assert.equal(cleanBallonDorEvent(JSON.parse(JSON.stringify(finalized.event))).result.coverage.played, 217);
});

test('el ciclo automático celebra la muestra parcial en su ventana y no antes', async t => {
  const { store, league } = harness(t);
  const market = new BallonDorMarketService({ store, projectOdds: fakeProjectOdds, log: () => {} });
  await market.sweep(OPEN_AT + 1000);
  const lastAt = settleMatches(store, league, 217);
  const schedule = ballonDorFinalizationSchedule(store, store.getBallonDor(SEASON));
  assert.ok(schedule);

  await market.sweep(lastAt + 1000);
  assert.equal(store.getBallonDor(SEASON).status, 'locked', 'no se adelanta la ceremonia');

  const ceremonyAt = schedule.scheduledAt;
  const closed = await market.sweep(ceremonyAt);
  assert.equal(closed.errors, 0);
  assert.equal(store.getBallonDor(SEASON).status, 'settled');
  assert.deepEqual(store.getBallonDor(SEASON).result.coverage, { played: 217, total: 240, minimum: 217 });
  const publicBefore = market.getMarket(SEASON);
  if (ballonDorResultAnnouncementAt(store, store.getBallonDor(SEASON)) > ceremonyAt) {
    assert.equal(publicBefore.result, null);
  }
});

test('el backend PostgreSQL hereda el mismo cierre parcial', async t => {
  const { store, league } = await pgHarness(t);
  await store.transitionBallonDor(SEASON, 'active', { at: OPEN_AT + 1 });
  const lastAt = settleMatches(store, league, 217);
  const positions = officialPositions(league, { allowPartial: true, asOf: lastAt });
  assert.equal(positions.ok, true);
  const finalized = await store.finalizeBallonDor(SEASON, positions.positions, { at: lastAt, cutoffAt: lastAt });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.event.result.coverage.played, 217);
});

test('MonteCristo News anuncia la cobertura verificada solo después de la ceremonia', async t => {
  const { store, league } = harness(t);
  const market = new BallonDorMarketService({ store, projectOdds: fakeProjectOdds, log: () => {} });
  await market.sweep(OPEN_AT + 1000);
  settleMatches(store, league, 217);
  const schedule = ballonDorFinalizationSchedule(store, store.getBallonDor(SEASON));
  await market.sweep(schedule.scheduledAt);
  const event = store.getBallonDor(SEASON);
  assert.equal(event.status, 'settled');
  const announcementAt = ballonDorResultAnnouncementAt(store, event);
  const before = buildClubNews({ league, at: announcementAt - 1 });
  assert.equal(before.some(item => item.id.startsWith('bdo-coverage:')), false);
  const after = buildClubNews({ league, at: announcementAt });
  const note = after.find(item => item.id.startsWith('bdo-coverage:'));
  assert.ok(note);
  assert.equal(note.type, 'ballon_dor_spotlight');
  assert.match(note.summary, /217 de 240/);
  assert.ok(note.spoken && note.headline && note.subtitle && note.clubId);
});

test('el deadline conserva la causalidad: actas posteriores al cierre no rescatan 216', async t => {
  const { store, league } = harness(t);
  const market = new BallonDorMarketService({ store, projectOdds: fakeProjectOdds, log: () => {} });
  await market.sweep(OPEN_AT + 1000);
  const deadline = closeDeadline(SEASON, CASINO_TIME_ZONE);
  settleMatches(store, league, 216, { startAt: OPEN_AT + 1000 });
  // Una sola acta tardía no debe entrar en la muestra del deadline.
  const next = league.calendar.matches.filter(m => !m.desempate)[216];
  next.status = 'settled';
  next.result = { home: 1, away: 0, winner: 'home' };
  next.settledAt = deadline + 60_000;
  next.fantasyStats = [];
  await market.sweep(deadline + 120_000);
  const event = store.getBallonDor(SEASON);
  assert.equal(event.status, 'cancelled');
  assert.equal(event.cancellationReason, 'temporada_no_cerrada_antes_reset');
});
