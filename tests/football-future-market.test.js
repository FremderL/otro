'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { projectSeasonFutures, seasonOutcome } = require('../lib/football/future-market');
const P = require('../lib/progression');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-market-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason('2026-11');
  const now = Math.min(...league.calendar.matches.map(match => match.scheduledKickoffAt)) - 60000;
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const profile = profiles.getOrCreate('future-player', 'Futurista');
  profile.chips = 1000;
  profile.achievements = P.ACHIEVEMENTS.map(item => item.id);
  profile.challenges = Object.fromEntries(P.CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
  P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false });
  profile.rotatingChallenges.daily.completed = true;
  profile.rotatingChallenges.weekly.completed = true;
  profiles.saveNow();
  const betting = createBettingService({ store, profiles, now: () => now });
  return { dir, store, league, profiles, profile, betting, now,
    close() { store.close(); profiles.saveNow(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('la proyección de futuros es reproducible y nunca toma la cuota o la jornada del cliente', async () => {
  const h = setup();
  try {
    const first = h.betting.futureMarket.getMarket('2026-11');
    assert.ok(first);
    assert.equal(first.simulations, 2000);
    assert.equal(first.afterJornada, 0);
    assert.equal(first.markets.champion.length, 16);
    assert.equal(first.markets.champion.reduce((sum, item) => sum + item.wins, 0), 2000);
    assert.ok(first.markets.champion.reduce((sum, item) => sum + 1 / item.odds, 0) > 1);
    assert.ok(first.markets.golden_boot.length > 16);
    assert.deepEqual(projectSeasonFutures(h.league, { at: h.now, sourceId: first.sourceId }), first);
    const selection = first.markets.champion[0].selection;
    const expected = first.markets.champion[0].odds;
    const placed = await h.betting.placeFuture({ profile: h.profile, seasonMonth: '2026-11', market: 'champion',
      selection, stake: 100, odds: 999999, placedAtJornada: 29, placedAt: h.now });
    assert.equal(placed.ok, true, placed.code);
    assert.equal(placed.future.odds, expected);
    assert.equal(placed.future.placedAtJornada, 0);
    assert.equal(placed.future.potentialPayout, Math.floor(100 * expected));
    assert.equal(h.profile.chips, 900);
    const invalid = await h.betting.placeFuture({ profile: h.profile, seasonMonth: '2026-11', market: 'champion',
      selection: 'club_inventado', stake: 100, odds: 100000, placedAt: h.now });
    assert.equal(invalid.code, 'seleccion_invalida');
  } finally { h.close(); }
});

test('el reintento idempotente recupera un futuro sin segundo débito incluso si cambia el saldo o cierra el mercado', async () => {
  const h = setup();
  try {
    const quote = h.betting.futureMarket.getMarket().markets.champion[0];
    const request = { profile: h.profile, seasonMonth: '2026-11', market: 'champion',
      selection: quote.selection, stake: 500, idempotencyKey: 'future-request-123', placedAt: h.now };
    const first = await h.betting.placeFuture(request);
    assert.equal(first.ok, true, first.code);
    assert.equal(h.profile.chips, 500);
    h.league.calendar.matches[0].status = 'live';
    const second = await h.betting.placeFuture(request);
    assert.equal(second.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(second.future.id, first.future.id);
    assert.equal(h.profile.chips, 500);
    assert.equal((await h.betting.placeFuture({ ...request, stake: 400 })).code, 'conflicto_idempotencia');
  } finally { h.close(); }
});

test('el mercado se recalcula al asentarse un resultado y no se cotiza con un partido en curso', () => {
  const h = setup();
  try {
    const first = h.betting.futureMarket.getMarket();
    const match = h.league.calendar.matches[0];
    match.status = 'live';
    assert.equal(h.betting.futureMarket.getMarket(), null);
    match.status = 'settled'; match.result = { home: 1, away: 0 };
    match.fantasyStats = null;
    const updated = h.betting.futureMarket.getMarket();
    assert.ok(updated);
    assert.notEqual(updated.sourceId, first.sourceId);
    assert.equal(updated.markets.golden_boot, undefined, 'no inventar estadísticas de goleadores ausentes');
    for (const game of h.league.calendar.matches.filter(item => item.jornada <= 20)) {
      game.status = 'settled'; game.result = { home: 0, away: 0 };
    }
    assert.equal(h.betting.futureMarket.getMarket(), null, 'el mercado cierra después de la jornada 20');
  } finally { h.close(); }
});

test('el cierre liquida campeón y goleador, y anula empates en los cortes de top 2 y top 4', () => {
  const h = setup();
  try {
    const champion = h.league.config[0];
    const scorer = champion.squad[0].id;
    const clubs = new Map(h.league.config.map(club => [club.id, club]));
    for (const match of h.league.calendar.matches) {
      const home = match.homeId === champion.id ? 2 : 0;
      const away = match.awayId === champion.id ? 2 : 0;
      match.status = 'settled'; match.result = { home, away };
      match.fantasyStats = [
        { id: clubs.get(match.homeId).squad[0].id, teamId: match.homeId, played: true, goals: home, assists: 0, reds: 0 },
        { id: clubs.get(match.awayId).squad[0].id, teamId: match.awayId, played: true, goals: away, assists: 0, reds: 0 }
      ];
    }
    const result = seasonOutcome(h.league);
    assert.equal(result.championTeamId, champion.id);
    assert.equal(result.goldenBootPlayerId, scorer);
    const tied = h.league.config[1].id;
    assert.ok(result.voidSelections.top2.includes(tied));
    assert.ok(result.voidSelections.top4.includes(tied));
    const tickets = [['champion', champion.id], ['top2', tied], ['top4', tied], ['golden_boot', scorer]];
    for (const [index, [market, selection]] of tickets.entries()) {
      h.store.insertFuture({ id: `season-${index}`, profileId: h.profile.id, seasonMonth: '2026-11',
        market, selection, stake: 100, odds: 2, potentialPayout: 200, debited: true,
        status: 'open', escrowProtocol: 'durable-1', placedAt: h.now });
    }
    h.profile.chips = 600;
    h.profiles.saveNow();
    assert.equal(h.betting.reconcileSeasonFutures(h.now).settled, 4);
    assert.deepEqual(tickets.map((_, index) => h.store.getFuture(`season-${index}`).status), ['won', 'void', 'void', 'won']);
    assert.equal(h.profile.chips, 1200);
    assert.ok(tickets.every((_, index) => h.store.getFuture(`season-${index}`).payoutApplied));
    assert.equal(h.betting.reconcileSeasonFutures(h.now).settled, 0);
    assert.equal(h.profile.chips, 1200);
  } finally { h.close(); }
});

test('la temporada incompleta se reembolsa al cambiar de mes, incluso tras reiniciar', async () => {
  const h = setup();
  try {
    const quote = h.betting.futureMarket.getMarket().markets.champion[0];
    const placed = await h.betting.placeFuture({ profile: h.profile, seasonMonth: '2026-11', market: 'champion',
      selection: quote.selection, stake: 100, placedAt: h.now });
    assert.equal(placed.ok, true);
    assert.equal(h.profile.chips, 900);
    const result = h.betting.reconcileSeasonFutures(Date.UTC(2026, 11, 2));
    assert.equal(result.refunded, 1);
    assert.equal(h.store.getFuture(placed.future.id).status, 'void');
    assert.equal(h.profile.chips, 1000);
    const store = new FootballStore(path.join(h.dir, 'football.json'));
    const profiles = new ProfileStore(path.join(h.dir, 'profiles.json'));
    const restarted = createBettingService({ store, profiles });
    restarted.reconcileEscrow();
    assert.equal(profiles.getProfile(h.profile.id).chips, 1000);
    assert.equal(store.getFuture(placed.future.id).payoutApplied, true);
    store.close(); profiles.saveNow();
  } finally { h.close(); }
});

test('el futuro de campeón espera el desempate y el scheduler recupera ese partido de un mes anterior', async () => {
  const h = setup();
  try {
    const { officialPositions } = require('../lib/football/ballon-dor-market');
    const { FootballEngine } = require('../lib/football/engine');
    const { FootballScheduler } = require('../lib/football/scheduler');
    for (const match of h.league.calendar.matches) {
      match.status = 'settled'; match.result = { home: 0, away: 0 }; match.fantasyStats = [];
    }
    const tied = officialPositions(h.league);
    assert.equal(tied.reason, 'desempate_requerido');
    h.league.ballonDor.status = 'locked';
    const kickoff = Date.UTC(2026, 11, 2, 12);
    const created = await h.store.createBallonDorTiebreak('2026-11', {
      homeId: tied.homeId, awayId: tied.awayId, kickoffAt: kickoff
    });
    assert.equal(created.ok, true);
    h.store.insertFuture({ id: 'champion-pending', profileId: h.profile.id, seasonMonth: '2026-11',
      market: 'champion', selection: tied.homeId, stake: 100, odds: 2, potentialPayout: 200,
      debited: true, status: 'open', escrowProtocol: 'durable-1', placedAt: h.now });
    h.profile.chips = 900;
    h.profiles.saveNow();
    h.store.ensureSeason(new Date(kickoff));
    const pending = h.betting.reconcileSeasonFutures(kickoff - 1);
    assert.equal(pending.refunded, 0);
    assert.equal(h.store.getFuture('champion-pending').status, 'open');

    const engine = new FootballEngine(h.store, { settleBets: (match, score) => h.betting.settleMatchBets(match, score) });
    const scheduler = new FootballScheduler(engine);
    scheduler.runKickoffSweep(kickoff);
    assert.equal(created.match.status, 'live');
    assert.ok(engine.active().some(match => match.id === created.match.id));
    scheduler.runSchedulerSweep(kickoff + 3000000);
    assert.equal(created.match.status, 'settled');
    assert.equal(h.betting.reconcileSeasonFutures(kickoff + 3000000).settled, 1);
    const future = h.store.getFuture('champion-pending');
    assert.ok(['won', 'lost'].includes(future.status));
    assert.equal(h.profile.chips, 900 + (future.status === 'won' ? 200 : 0));
  } finally { h.close(); }
});
