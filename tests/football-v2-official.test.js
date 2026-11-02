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
const { createOfficialV2, HORIZON_MS } = require('../lib/football/v2/official');
const { makeCommitment, verifyCommitment, commitmentId } = require('../lib/football/v2/commitment');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
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
    assert.ok(Math.abs(firstPrice.overround - 1.06) < 0.002);
    assert.ok(Math.abs(firstPrice.margin - (firstPrice.overround - 1)) < 1e-8);
    assert.ok(Math.abs(firstPrice.hold - firstPrice.margin / firstPrice.overround) < 1e-5);
    assert.ok(Math.abs(firstPrice.selections.reduce((sum, item) => sum + item.prob, 0) - 1) < 1e-5);
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

test('migra política y futuros legados a v4 sin alterar cuotas ni compromisos por partido previos', async () => {
  const h = setup();
  try {
    assert.equal((await h.officialV2.ensureSeason('2026-11')).ok, true);
    const oldPolicy = { ...h.league.simulationPolicy, simulatorVersion: 'v2-causal-3', pricingVersion: 'v2-estimated-1' };
    oldPolicy.id = Policy.policyId(oldPolicy);
    h.league.simulationPolicy = oldPolicy;
    const previousMatch = h.league.calendar.matches[0];
    const oldInputs = prepareMatchInputs({ league: h.league, previousLeague: h.previous, match: previousMatch,
      asOf: h.now(), seed: 0 });
    oldInputs.version = 'v2-causal-3';
    previousMatch.simulation = makeCommitment(oldInputs, '66'.repeat(32), h.now(), Q.createEstimatedModel(oldInputs));
    assert.ok(verifyCommitment(previousMatch.simulation, previousMatch));
    assert.equal(previousMatch.simulation.version, 'v2-causal-3');
    assert.equal(previousMatch.simulation.pricing.version, Q.ESTIMATED_LEGACY_VERSION);
    const oldCommitment = JSON.parse(JSON.stringify(previousMatch.simulation));
    const inserted = h.store.insertFuture({ id: 'migration-future-1', profileId: h.profile.id,
      seasonMonth: '2026-11', market: 'champion', selection: 'club1', odds: 3.4, stake: 100,
      potentialPayout: 340, status: 'open', debited: true, simulationPolicyId: oldPolicy.id,
      simulationCommitments: [{ matchId: previousMatch.id, id: commitmentId(previousMatch.simulation) }],
      placedAt: h.now() });
    assert.equal(inserted.ok, true);
    const future = inserted.future;
    const oldFutureOdds = future.odds;
    const oldFutureCommitments = JSON.parse(JSON.stringify(future.simulationCommitments));

    assert.equal((await h.officialV2.ensureSeason('2026-11')).ok, true);
    assert.equal(h.league.simulationPolicy.simulatorVersion, 'v2-causal-4');
    assert.equal(h.league.simulationPolicy.pricingVersion, Q.ESTIMATED_VERSION);
    assert.equal(future.simulationPolicyId, h.league.simulationPolicy.id);
    assert.equal(future.odds, oldFutureOdds);
    assert.deepEqual(future.simulationCommitments, oldFutureCommitments);
    assert.deepEqual(previousMatch.simulation, oldCommitment);

    const nextMatch = h.league.calendar.matches.find(match => match.id !== previousMatch.id && match.status === 'scheduled');
    assert.equal((await h.officialV2.prepareMatch(nextMatch)).ok, true);
    assert.equal(nextMatch.simulation.version, 'v2-causal-4');
    assert.equal(nextMatch.simulation.pricing.version, Q.ESTIMATED_VERSION);
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

test('con la concesión de escritura en espera, el arranque pospone V2 sin migrar a medias', async () => {
  const h = setup();
  try {
    const events = [];
    const v2 = createOfficialV2({ store: h.store, now: h.now, log: (event, data) => events.push({ event, ...data }) });
    assert.equal((await v2.ensureSeason('2026-11')).ok, true);
    const oldPolicy = { ...h.league.simulationPolicy, simulatorVersion: 'v2-causal-3', pricingVersion: 'v2-estimated-1' };
    oldPolicy.id = Policy.policyId(oldPolicy);
    h.league.simulationPolicy = oldPolicy;
    assert.ok(await h.store.saveStrict());

    // Solape de un deploy rolling: el handle pendiente hace fallar todo guardado
    // estricto (en Postgres, saveStrict devuelve false vía FOOTBALL_WRITER_PENDING).
    const lease = { pending: true };
    h.store.writerLease = lease;
    const realSaveStrict = h.store.saveStrict.bind(h.store);
    h.store.saveStrict = () => false;

    const deferred = await v2.prepareUpcoming();
    assert.equal(deferred.ok, true, 'el arranque no puede morir por persistencia mientras solo lee');
    assert.equal(deferred.deferred, true);
    assert.equal(h.league.simulationPolicy.id, oldPolicy.id, 'sin escrituras no se migra la política a medias');
    assert.equal(h.league.simulationPolicyUnconfirmed, undefined);
    assert.equal(h.league.calendar.matches.some(match => match.simulation), false);
    assert.equal((await v2.prepareUpcoming()).deferred, true, 'los barridos pueden volver a preguntar');
    assert.equal(events.filter(item => item.event === 'football_v2_preparation_deferred').length, 1,
      'un solo aviso de posposición, no uno por barrido');

    // El contrato de dinero sigue fallando en cerrado mientras espera.
    assert.equal((await v2.ensureSeason('2026-11')).reason, 'persistencia_pendiente');
    const match = h.league.calendar.matches[0];
    assert.equal((await v2.prepareMatch(match)).reason, 'persistencia_pendiente');
    assert.equal(match.simulation, undefined, 'no se arranca un encuentro sin compromiso durable');

    // Al adquirir la concesión, el siguiente barrido migra y prepara con las
    // escrituras ya habilitadas (igual que hace el kickoff sweep tras el gancho).
    lease.pending = false;
    h.store.saveStrict = realSaveStrict;
    const ready = await v2.prepareUpcoming();
    assert.equal(ready.ok, true);
    assert.equal(ready.deferred, undefined);
    assert.equal(h.league.simulationPolicyUnconfirmed, undefined);
    assert.equal(h.league.simulationPolicy.simulatorVersion, 'v2-causal-4');
    assert.equal(h.league.simulationPolicy.pricingVersion, Q.ESTIMATED_VERSION);
    assert.ok(Policy.verifyPolicy(h.league.simulationPolicy, '2026-11'));
    const upcoming = h.league.calendar.matches
      .filter(item => item.status === 'scheduled' && item.scheduledKickoffAt <= h.now() + HORIZON_MS);
    assert.ok(upcoming.length > 0);
    assert.ok(upcoming.every(item => item.simulation && verifyCommitment(item.simulation, item)));
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

test('scheduler prioriza partidos vencidos y aísla una falla del horizonte sin saltar persistencia', async () => {
  const calls = [], logs = [];
  const matches = [
    { id: 'bloqueado', status: 'scheduled', scheduledKickoffAt: 10 },
    { id: 'listo', status: 'scheduled', scheduledKickoffAt: 10 },
    { id: 'futuro', status: 'scheduled', scheduledKickoffAt: 20 }
  ];
  const engine = {
    opts: { pregenerateMs: 10 }, operationalMatches: () => matches,
    startMatch(match) { calls.push('start:' + match.id); match.status = 'live'; },
    pregenerateUpcoming() { calls.push('pregenerate'); }
  };
  const officialV2 = {
    async prepareMatch(match) { calls.push('prepare:' + match.id); return match.id === 'bloqueado' ? { ok: false, reason: 'persistencia_pendiente' } : { ok: true }; },
    async prepareUpcoming() { calls.push('upcoming'); throw new Error('horizonte indisponible'); }
  };
  const scheduler = new FootballScheduler(engine, { officialV2, logEvent: (event, data) => logs.push({ event, data }) });
  scheduler.runKickoffSweep(10);
  await scheduler.kickoffPending;
  assert.deepEqual(calls, ['prepare:bloqueado', 'prepare:listo', 'start:listo', 'upcoming', 'pregenerate']);
  assert.equal(matches[0].status, 'scheduled', 'sin persistencia confirmada no se arranca');
  assert.equal(matches[1].status, 'live');
  assert.ok(logs.some(log => log.event === 'football_v2_kickoff_not_ready' && log.data.reason === 'persistencia_pendiente'));
  assert.ok(logs.some(log => log.event === 'football_v2_kickoff_error'));
});

test('scheduler reintenta el kickoff tras recuperar la persistencia V2', async () => {
  const h = setup();
  try {
    const match = h.league.calendar.matches[0], kickoff = match.scheduledKickoffAt;
    const save = h.store.saveStrict.bind(h.store);
    const scheduler = new FootballScheduler(h.engine, { officialV2: h.officialV2 });
    h.store.saveStrict = () => false;
    scheduler.runKickoffSweep(kickoff);
    await scheduler.kickoffPending;
    assert.equal(match.status, 'scheduled', 'no arranca sin confirmación durable');
    h.store.saveStrict = save;
    scheduler.runKickoffSweep(kickoff + 5000);
    await scheduler.kickoffPending;
    assert.equal(match.status, 'live');
    assert.ok(verifyCommitment(match.simulation, match));
    assert.equal(match.simulationUnconfirmed, undefined);
  } finally { h.close(); }
});
