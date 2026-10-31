'use strict';

// Regresiones entre el motor oficial V2 y el catálogo/resultado autoritativo de V1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { FootballEngine } = require('../lib/football/engine');
const { createBettingService, resolveSelection } = require('../lib/football/betting');
const { createOfficialV2 } = require('../lib/football/v2/official');
const { commitmentId } = require('../lib/football/v2/commitment');
const { matchContextFor } = require('../lib/football/match-context');
const { auditSeason } = require('../lib/football/odds-audit');
const { outcome } = require('../lib/football/ratings');
const O = require('../lib/football/odds');
const P = require('../lib/progression');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-main-merge-'));
  const footballPath = path.join(dir, 'football.json');
  const profilePath = path.join(dir, 'profiles.json');
  const store = new FootballStore(footballPath);
  const league = store.generateSeason('2026-11');
  const now = Math.min(...league.calendar.matches.map(match => match.scheduledKickoffAt)) - 60000;
  const profiles = new ProfileStore(profilePath);
  const person = id => {
    const profile = profiles.getOrCreate(id, id);
    profile.chips = 1000;
    profile.achievements = P.ACHIEVEMENTS.map(item => item.id);
    profile.challenges = Object.fromEntries(P.CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
    P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false });
    profile.rotatingChallenges.daily.completed = true;
    profile.rotatingChallenges.weekly.completed = true;
    profiles.saveNow();
    return profile;
  };
  const officialV2 = createOfficialV2({ store, now: () => now });
  const betting = createBettingService({ store, profiles, officialV2, now: () => now });
  const engine = new FootballEngine(store, { officialV2, settleBets: (match, score) => betting.settleMatchBets(match, score) });
  return { dir, footballPath, profilePath, store, league, profiles, person, officialV2, betting, engine, now,
    close() { store.close(); profiles.saveNow(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function winningSelections(replay, scorerMarket) {
  const halftime = O.halfTimeScoreFromTimeline(replay.timeline);
  const firstScorer = O.firstScorerFromTimeline(replay.timeline);
  const offered = scorerMarket.selections.map(item => item.key);
  const scorer = firstScorer ? (offered.includes(firstScorer.id) ? firstScorer.id : 'other') : 'none';
  return { halftime, firstScorer, scorer,
    htft: `${outcome(halftime.home, halftime.away)}_${outcome(replay.score.home, replay.score.away)}` };
}

function payoutFor(bet, resolution) {
  const half = Math.floor(bet.stake / 2), other = bet.stake - half;
  if (resolution === 'won') return Math.floor(bet.stake * bet.oddsAtPlacement);
  if (resolution === 'half_won') return Math.floor(half * bet.oddsAtPlacement) + other;
  if (resolution === 'half_lost') return other;
  if (resolution === 'void') return bet.stake;
  return 0;
}

test('V2 publica y paga hándicap asiático, descanso/final y primer goleador con su replay', async () => {
  const h = setup();
  try {
    const match = h.league.calendar.matches[0];
    assert.ok(h.betting.getMarket(match, 'first_scorer'), 'la vista provisional no prepara el partido');
    assert.equal(match.simulation, undefined);
    assert.ok((await h.officialV2.prepareMatch(match)).ok);
    const keys = h.betting.marketKeysFor(match);
    const asian = keys.find(key => {
      const line = Number(key.replace(/^asian_handicap_home_(?:plus|minus)/, ''));
      return key.startsWith('asian_handicap_home_') && O.asianLegs(line).length === 2;
    });
    assert.ok(asian && keys.includes('ht_ft') && keys.includes('first_scorer'));
    assert.ok(keys.every(key => h.betting.getMarket(match, key)), 'el catálogo solo enumera mercados cotizables');
    const scorerMarket = h.betting.getMarket(match, 'first_scorer');
    assert.ok(scorerMarket.selections.some(item => item.label && item.key !== 'other' && item.key !== 'none'));
    const frozen = JSON.stringify(scorerMarket);
    h.league.config.find(club => club.id === match.homeId).squad[0].name = 'Cambio posterior';
    assert.equal(JSON.stringify(h.betting.getMarket(match, 'first_scorer')), frozen, 'la plantilla V2 está congelada');
    const replay = h.engine._ensureTimeline(match);
    const expected = winningSelections(replay, scorerMarket);
    const cases = [
      { market: 'ht_ft', selection: expected.htft, profile: h.person('ht') },
      { market: 'first_scorer', selection: expected.scorer, profile: h.person('scorer') },
      { market: asian, selection: 'home', profile: h.person('asian') }
    ];
    for (const [index, item] of cases.entries()) {
      const placed = await h.betting.placeBet({ ...item, matchId: match.id, stake: 100,
        idempotencyKey: `cross-market-${index}` });
      assert.ok(placed.ok, placed.code);
      item.bet = placed.bet;
      assert.equal(item.bet.simulationId, commitmentId(match.simulation));
    }
    assert.ok(cases[1].bet.firstScorerIds.length > 0, 'la lista vendida se conserva');
    const end = match.scheduledKickoffAt + replay.clock.matchEnd * 15000 + 1;
    assert.ok(h.engine.startMatch(match, match.scheduledKickoffAt));
    assert.ok(h.engine.advance(match, end).ended);
    assert.deepEqual(match.result.halftime, expected.halftime);
    assert.deepEqual(match.result.firstScorer, expected.firstScorer);
    for (const item of cases) {
      const resolution = resolveSelection(item.market, item.selection, replay.score, {
        halftime: expected.halftime, firstScorer: expected.firstScorer, firstScorerIds: item.bet.firstScorerIds
      });
      const stored = h.store.getBet(item.bet.id);
      assert.equal(stored.payout, payoutFor(item.bet, resolution));
      assert.equal(stored.payoutApplied, true);
      assert.equal(item.profile.chips, 900 + stored.payout);
    }
    const balances = cases.map(item => item.profile.chips);
    assert.ok(h.engine._settleResult(match, replay, end + 1).alreadySettled);
    h.betting.reconcileEscrow();
    assert.deepEqual(cases.map(item => item.profile.chips), balances, 'el reinicio no paga dos veces');
  } finally { h.close(); }
});

test('una combinada V2 conserva descanso y goleadores al reconciliar después de reiniciar', async () => {
  const h = setup();
  try {
    const matches = h.league.calendar.matches.slice(0, 2);
    for (const match of matches) assert.ok((await h.officialV2.prepareMatch(match)).ok);
    const replays = matches.map(match => h.engine._ensureTimeline(match));
    const picks = matches.map((match, i) => winningSelections(replays[i], h.betting.getMarket(match, 'first_scorer')));
    const profile = h.person('combined');
    const placed = await h.betting.placeParlay({ profile, stake: 100, idempotencyKey: 'cross-parlay-1', legs: [
      { matchId: matches[0].id, market: 'ht_ft', selection: picks[0].htft },
      { matchId: matches[1].id, market: 'first_scorer', selection: picks[1].scorer }
    ] });
    assert.ok(placed.ok, placed.code);
    assert.ok(placed.parlay.legs[1].firstScorerIds.length);
    for (const [i, match] of matches.entries()) {
      const result = h.store.settleMatch(match.id, replays[i].score, { seasonMonth: '2026-11',
        now: match.scheduledKickoffAt + replays[i].clock.matchEnd * 15000 + 1,
        timeline: replays[i].timeline, lineups: replays[i].lineups });
      assert.ok(result.ok, result.detail || result.reason);
    }
    assert.equal(h.store.getParlay(placed.parlay.id).status, 'open');
    h.store.saveNow(); h.profiles.saveNow();
    const restoredStore = new FootballStore(h.footballPath);
    const restoredProfiles = new ProfileStore(h.profilePath);
    const restoredBetting = createBettingService({ store: restoredStore, profiles: restoredProfiles, now: () => h.now });
    restoredBetting.reconcileEscrow();
    const settled = restoredStore.getParlay(placed.parlay.id);
    assert.equal(settled.status, 'won');
    assert.equal(settled.payoutApplied, true);
    assert.equal(restoredProfiles.getProfile(profile.id).chips, 900 + settled.payout);
    restoredBetting.reconcileEscrow();
    assert.equal(restoredProfiles.getProfile(profile.id).chips, 900 + settled.payout);
    restoredStore.close(); restoredProfiles.saveNow();
  } finally { h.close(); }
});

test('un V2 del mes anterior no se liquida antes de que termine su reloj', async () => {
  const h = setup();
  try {
    const target = h.league.calendar.matches[0];
    assert.ok((await h.officialV2.prepareMatch(target)).ok);
    for (const match of h.league.calendar.matches) if (match !== target) match.status = 'postponed';
    const boundary = Date.parse('2026-12-01T06:05:00Z');
    target.scheduledKickoffAt = boundary - 5 * 15000;
    target.status = 'live';
    const replay = h.engine._ensureTimeline(target);
    const early = h.engine._settleStaleSeasons(boundary);
    assert.equal(early.liquidados, 0);
    assert.equal(target.status, 'live');
    assert.equal(target.result, null);
    const end = target.scheduledKickoffAt + replay.clock.matchEnd * 15000 + 1;
    const completed = h.engine._settleStaleSeasons(end);
    assert.equal(completed.liquidados, 1);
    assert.equal(target.status, 'settled');
    assert.deepEqual({ home: target.result.home, away: target.result.away }, replay.score);
  } finally { h.close(); }
});

test('la auditoría de cuotas V2 usa la matriz y el catálogo reales del compromiso', async () => {
  const h = setup();
  try {
    const match = h.league.calendar.matches[0];
    assert.ok((await h.officialV2.prepareMatch(match)).ok);
    const expected = h.betting.getMatchContext(match);
    const actual = matchContextFor(h.store, match);
    assert.deepEqual(actual.matrix, expected.matrix);
    assert.deepEqual(actual.lambdas, expected.lambdas);
    const source = { getLeague: () => h.league, getMatches: () => [match] };
    const report = auditSeason(source, '2026-11');
    assert.equal(report.matches, 1);
    assert.equal(report.distribution.goalsPerMatch,
      Number((expected.lambdas.lambdaHome + expected.lambdas.lambdaAway).toFixed(3)));
    assert.equal(report.margins.first_scorer.selections, h.betting.getMarket(match, 'first_scorer').selections.length);
  } finally { h.close(); }
});

test('un asentado V2 fallido queda activo y se reintenta sin perder sus boletos', async () => {
  const h = setup();
  try {
    const match = h.league.calendar.matches[0], profile = h.person('retry');
    assert.ok((await h.officialV2.prepareMatch(match)).ok);
    const replay = h.engine._ensureTimeline(match);
    const selection = outcome(replay.score.home, replay.score.away);
    const placed = await h.betting.placeBet({ profile, matchId: match.id, market: '1x2', selection,
      stake: 100, idempotencyKey: 'settlement-retry-1' });
    assert.ok(placed.ok, placed.code);
    assert.ok(h.engine.startMatch(match, match.scheduledKickoffAt));
    const end = match.scheduledKickoffAt + replay.clock.matchEnd * 15000 + 1;
    const settle = h.store.settleMatch.bind(h.store);
    h.store.settleMatch = () => ({ ok: false, reason: 'fallo_temporal' });
    h.engine.advance(match, end);
    assert.equal(match.status, 'live');
    assert.equal(match.result, null);
    assert.equal(h.store.getBet(placed.bet.id).status, 'open');
    h.store.settleMatch = settle;
    h.engine.advance(match, end + 1);
    assert.equal(match.status, 'settled');
    assert.equal(h.store.getBet(placed.bet.id).status, 'won');
    assert.equal(profile.chips, 900 + placed.bet.potentialPayout);
    const audit = h.store.auditBallonDor('2026-11');
    assert.ok(audit.ok);
    assert.equal(audit.mismatched, 0, 'el premio coincide con el archivo del replay');
  } finally { h.close(); }
});
