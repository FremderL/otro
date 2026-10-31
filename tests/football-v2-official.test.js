'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { FootballEngine } = require('../lib/football/engine');
const { FootballScheduler } = require('../lib/football/scheduler');
const { createBettingService } = require('../lib/football/betting');
const { createOfficialV2 } = require('../lib/football/v2/official');
const { verifyCommitment, commitmentId } = require('../lib/football/v2/commitment');
const Policy = require('../lib/football/v2/season-policy');
const Q = require('../lib/football/v2/quotes');
const P = require('../lib/progression');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-official-'));
  const file = path.join(dir, 'football.json'), store = new FootballStore(file);
  const previous = store.generateSeason('2026-10');
  const earlier = previous.calendar.matches[0];
  const at = Date.UTC(2026, 9, 31, 20);
  assert.ok(store.settleMatch(earlier.id, { home: 3, away: 1 }, { seasonMonth: '2026-10', now: at - 1000 }).ok);
  store.closeSeason('2026-10');
  const league = store.generateSeason('2026-11');
  let now = Math.min(...league.calendar.matches.map(match => match.scheduledKickoffAt)) - 60000;
  const profileFile = path.join(dir, 'profiles.json'), profiles = new ProfileStore(profileFile);
  const profile = profiles.getOrCreate('u', 'U'); profile.chips = 1000;
  profile.achievements = P.ACHIEVEMENTS.map(item => item.id);
  profile.challenges = Object.fromEntries(P.CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
  P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false });
  profile.rotatingChallenges.daily.completed = true; profile.rotatingChallenges.weekly.completed = true;
  profiles.saveNow();
  const officialV2 = createOfficialV2({ store, now: () => now });
  const betting = createBettingService({ store, profiles, officialV2, now: () => now });
  const engine = new FootballEngine(store, { officialV2, settleBets: (match, score) => betting.settleMatchBets(match, score) });
  return { dir, file, store, previous, league, profile, profiles, officialV2, betting, engine,
    now: () => now, setNow: value => { now = value; },
    close() { store.close(); profiles.saveNow(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('noviembre selecciona automáticamente V2, usa octubre y congela solo el partido preparado', async () => {
  const h = setup();
  try {
    const match = h.league.calendar.matches[0], later = h.league.calendar.matches.at(-1);
    assert.equal(match.simulation, undefined);
    const provisional = h.betting.getMarket(later, '1x2');
    assert.ok(provisional, 'también se cotizan partidos aún no preparados');
    assert.equal(later.simulation, undefined, 'consultar no congela la temporada entera');
    assert.throws(() => h.engine._ensureTimeline(match), /aún no preparado/);
    assert.equal((await h.officialV2.prepareMatch(match)).ok, true);
    assert.ok(verifyCommitment(match.simulation, match));
    assert.equal(match.simulation.pricing.version, Q.ESTIMATED_VERSION);
    assert.equal(match.simulation.inputs.source.previousSeason, '2026-10');
    assert.ok(match.simulation.inputs.context.previousSample > 0);
    assert.ok(Policy.verifyPolicy(h.league.simulationPolicy, '2026-11'));
    assert.equal(match.simulation.privateSeed, Policy.matchKey(h.league.simulationPolicy, match));
    const frozen = JSON.stringify(match.simulation.inputs), firstPrice = h.betting.getMarket(match, '1x2');
    const newResult = h.league.calendar.matches.find(item => item.id !== match.id);
    h.setNow(h.now() + 1000);
    assert.ok(h.store.settleMatch(newResult.id, { home: 5, away: 0 }, { seasonMonth: '2026-11', now: h.now() }).ok);
    assert.equal((await h.officialV2.prepareMatch(later)).ok, true);
    assert.equal(match.simulation.inputs.source.home.currentMatches, 0);
    assert.ok(later.simulation.inputs.context.sample > 0);
    assert.equal(JSON.stringify(match.simulation.inputs), frozen);
    assert.deepEqual(h.betting.getMarket(match, '1x2'), firstPrice);
    const loaded = new FootballStore(h.file);
    assert.ok(Policy.verifyPolicy(loaded.getLeague('2026-11').simulationPolicy, '2026-11'));
    assert.deepEqual(loaded.getMatch(match.id).simulation, match.simulation);
    assert.equal(h.engine._ensureTimeline(match).version, match.simulation.version);
    loaded.close();
  } finally { h.close(); }
});

test('una apuesta y un futuro aceptados sobreviven reinicio y permiten preparar otro encuentro', async () => {
  const h = setup();
  try {
    assert.equal((await h.officialV2.ensureSeason('2026-11')).ok, true);
    const futureQuote = h.betting.futureMarket.getMarket().markets.champion[0];
    const future = await h.betting.placeFuture({ profile: h.profile, seasonMonth: '2026-11', market: 'champion',
      selection: futureQuote.selection, stake: 100, idempotencyKey: 'future-00001', placedAt: h.now() });
    assert.equal(future.ok, true, future.code);
    assert.equal(future.future.simulationPolicyId, h.league.simulationPolicy.id);
    const match = h.league.calendar.matches[0];
    assert.equal((await h.officialV2.prepareMatch(match)).ok, true, 'el futuro no bloquea el compromiso derivado');
    const quote = h.betting.getMarket(match, '1x2').selections.find(item => item.key === 'home');
    const bet = await h.betting.placeBet({ profile: h.profile, matchId: match.id, market: '1x2', selection: 'home',
      stake: 100, idempotencyKey: 'single-00001', placedAt: h.now() });
    assert.equal(bet.ok, true, bet.code);
    assert.equal(bet.bet.oddsAtPlacement, quote.price);
    assert.equal(bet.bet.simulationId, commitmentId(match.simulation));
    assert.equal(h.engine._hasIncompatibleV2Bets(match), false);
    const loaded = new FootballStore(h.file), restored = loaded.getMatch(match.id), reloadedFuture = loaded.getFuture(future.future.id);
    assert.equal(reloadedFuture.simulationPolicyId, h.league.simulationPolicy.id);
    assert.equal(loaded.getBet(bet.bet.id).oddsAtPlacement, bet.bet.oddsAtPlacement);
    assert.deepEqual(restored.simulation, match.simulation);
    const v2 = createOfficialV2({ store: loaded, now: h.now });
    const engine = new FootballEngine(loaded, { officialV2: v2 });
    assert.equal(engine._hasIncompatibleV2Bets(restored), false);
    assert.equal(engine.startMatch(restored, restored.scheduledKickoffAt), true);
    loaded.close();
  } finally { h.close(); }
});

test('fallos durables conservan las mismas claves y no permiten una caída silenciosa a V1', async () => {
  const h = setup();
  try {
    const match = h.league.calendar.matches[0], save = h.store.saveStrict.bind(h.store);
    h.store.saveStrict = () => false;
    assert.equal((await h.officialV2.prepareMatch(match)).reason, 'persistencia_pendiente');
    const policyId = h.league.simulationPolicy.id;
    assert.throws(() => h.engine._ensureTimeline(match), /aún no preparado/);
    h.store.saveStrict = save;
    assert.equal((await h.officialV2.ensureSeason('2026-11')).ok, true);
    assert.equal(h.league.simulationPolicy.id, policyId);
    h.store.saveStrict = () => false;
    assert.equal((await h.officialV2.prepareMatch(match)).reason, 'persistencia_pendiente');
    const pending = match.simulation;
    assert.equal(h.betting.getMarket(match, '1x2'), null);
    assert.throws(() => h.engine._ensureTimeline(match), /no confirmado/);
    h.store.saveStrict = save;
    assert.equal((await h.officialV2.prepareMatch(match)).ok, true);
    assert.equal(match.simulation, pending);
    assert.ok(h.betting.getMarket(match, '1x2'));
  } finally { h.close(); }
});

test('una obligación V1 real solo preserva su propio encuentro; el resto selecciona V2', async () => {
  const h = setup();
  try {
    const [old, fresh] = h.league.calendar.matches;
    h.store.insertBet({ id: 'legacy-bet', idempotencyKey: 'legacy-01', profileId: 'legacy', matchId: old.id,
      seasonMonth: '2026-11', market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2,
      status: 'open', debited: true });
    assert.equal((await h.officialV2.prepareMatch(old)).legacy, true);
    assert.equal(old.simulation, undefined);
    assert.ok(h.betting.getMarket(old, '1x2'));
    assert.equal((await h.officialV2.prepareMatch(fresh)).ok, true);
    assert.ok(fresh.simulation);
    assert.equal(h.engine.startMatch(old, old.scheduledKickoffAt), true);
    assert.equal(h.engine.startMatch(fresh, fresh.scheduledKickoffAt), true);
  } finally { h.close(); }
});

test('scheduler espera persistencia V2 antes de arrancar y prepara el horizonte progresivo', async () => {
  const h = setup();
  try {
    const match = h.league.calendar.matches[0], kickoff = match.scheduledKickoffAt;
    const scheduler = new FootballScheduler(h.engine, { officialV2: h.officialV2 });
    assert.equal(scheduler.runKickoffSweep(kickoff).pending, true);
    await scheduler.kickoffPending;
    assert.ok(match.simulation);
    assert.equal(match.status, 'live');
    assert.ok(h.league.calendar.matches.some(item => item.status === 'scheduled' && !item.simulation));
  } finally { h.close(); }
});

test('apuesta simple, combinada, en vivo y cashout usan cuotas V2 y se liquidan al resultado real', async () => {
  const h = setup();
  try {
    const person = id => {
      const p = h.profiles.getOrCreate(id, id); p.chips = 1000;
      p.achievements = P.ACHIEVEMENTS.map(item => item.id);
      p.challenges = Object.fromEntries(P.CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
      P.recordOutcome(p, { game: 'dice', net: 0, eligible: false });
      p.rotatingChallenges.daily.completed = true; p.rotatingChallenges.weekly.completed = true;
      return p;
    };
    const combinedProfile = person('combo'), liveProfile = person('live'), cashProfile = person('cash');
    const matches = h.league.calendar.matches.slice(0, 2), first = matches[0];
    const single = await h.betting.placeBet({ profile: h.profile, matchId: first.id, market: '1x2',
      selection: 'home', stake: 100, placedAt: h.now(), idempotencyKey: 'official-single' });
    assert.ok(single.ok, single.code);
    const combo = await h.betting.placeParlay({ profile: combinedProfile, stake: 100, placedAt: h.now(),
      idempotencyKey: 'official-combo', legs: matches.map(match => ({ matchId: match.id, market: '1x2', selection: 'home' })) });
    assert.ok(combo.ok, combo.code);
    const cashBet = await h.betting.placeBet({ profile: cashProfile, matchId: first.id, market: '1x2',
      selection: 'away', stake: 100, placedAt: h.now(), idempotencyKey: 'official-cash-bet' });
    assert.ok(cashBet.ok, cashBet.code);
    const results = [];
    for (const match of matches) {
      const replay = h.engine._ensureTimeline(match), kick = match.scheduledKickoffAt;
      assert.equal(h.engine.startMatch(match, kick), true);
      if (match === first) {
        const getState = at => {
          const derived = h.engine.deriveMatchState(match, at), state = derived.state;
          return { minute: derived.minute, half: state.half, score: state.score, redCards: state.redCards,
            phase: state.phase, playStopped: state.playStopped };
        };
        let when = kick + 500;
        while (when < kick + 30000 && getState(when).playStopped) when += 500;
        h.setNow(when);
        const state = getState(when);
        assert.equal(state.playStopped, false);
        const quote = h.betting.getMarket(match, '1x2', state);
        assert.ok(quote && quote.selections.length === 3);
        const live = await h.betting.placeBet({ profile: liveProfile, matchId: match.id, market: '1x2',
          selection: 'draw', stake: 100, state, refreshState: () => getState(when), placedAt: when, idempotencyKey: 'official-live-bet' });
        assert.ok(live.ok, live.code);
        assert.equal(live.bet.simulationId, commitmentId(match.simulation));
        const cashed = await h.betting.cashout(cashProfile, cashBet.bet.id, state);
        assert.ok(cashed.ok, cashed.code);
        assert.equal(cashProfile.chips, 900 + cashed.cashout);
      }
      const ended = kick + replay.clock.matchEnd * 15000 + 1;
      h.setNow(ended); assert.equal(h.engine.advance(match, ended).ended, true);
      results.push(match.result);
    }
    const firstWin = results[0].home > results[0].away, bothWin = firstWin && results[1].home > results[1].away;
    assert.equal(h.store.getBet(single.bet.id).status, firstWin ? 'won' : 'lost');
    assert.equal(h.profile.chips, 900 + (firstWin ? single.bet.potentialPayout : 0));
    assert.equal(h.store.getParlay(combo.parlay.id).status, bothWin ? 'won' : 'lost');
    assert.equal(combinedProfile.chips, 900 + (bothWin ? combo.parlay.potentialPayout : 0));
    assert.equal(h.store.getBet(cashBet.bet.id).status, 'cashed');
    const liveBet = h.store.getBets({ profileId: liveProfile.id })[0];
    const draw = results[0].home === results[0].away;
    assert.equal(liveBet.status, draw ? 'won' : 'lost');
    assert.equal(liveProfile.chips, 900 + (draw ? liveBet.potentialPayout : 0));
  } finally { h.close(); }
});

test('futuros V2 siguen abiertos en juego con marcador y goleadores revelados, sin filtrar el replay', async () => {
  const { publicProjectionState } = require('../lib/football/v2/projection');
  const h = setup();
  try {
    assert.ok((await h.officialV2.prepareUpcoming()).ok);
    h.betting.futureMarket.getLiveState = (match, at) => publicProjectionState(h.engine, match, at);
    const before = h.betting.futureMarket.getMarket();
    assert.ok(before && before.markets.champion.length === 16);
    const kickoff = Math.min(...h.league.calendar.matches.map(match => match.scheduledKickoffAt));
    const matches = h.league.calendar.matches.filter(match => match.scheduledKickoffAt === kickoff);
    for (const match of matches) assert.equal(h.engine.startMatch(match, kickoff), true);
    h.setNow(kickoff + 15000);
    const live = h.betting.futureMarket.getMarket();
    assert.ok(live && live.markets.champion.length === 16);
    assert.notEqual(live.sourceId, before.sourceId);
    assert.ok(live.markets.golden_boot?.length > 16);
    const state = publicProjectionState(h.engine, matches[0], h.now());
    assert.equal(state.goals.filter(goal => goal.team === 'home').length, state.score.home);
    assert.equal(state.goals.filter(goal => goal.team === 'away').length, state.score.away);
    const serialized = JSON.stringify({ state, markets: live.markets });
    assert.equal(serialized.includes(h.league.simulationPolicy.privateSeed), false);
    assert.equal(serialized.includes(matches[0].simulation.privateSeed), false);
    assert.equal(serialized.includes('privateSeed'), false);
    const first = live.markets.champion[0];
    const accepted = await h.betting.placeFuture({ profile: h.profile, seasonMonth: '2026-11', market: 'champion',
      selection: first.selection, stake: 100, idempotencyKey: 'live-future-01', placedAt: h.now() });
    assert.ok(accepted.ok, accepted.code);
    assert.equal(accepted.future.odds, first.odds);
    h.setNow(kickoff + 30000);
    assert.notEqual(h.betting.futureMarket.getMarket().sourceId, live.sourceId);
    assert.equal(h.store.getFuture(accepted.future.id).odds, first.odds, 'una nueva proyección no altera el boleto');
  } finally { h.close(); }
});
