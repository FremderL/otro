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
const { createOfficialV2 } = require('../lib/football/v2/official');
const { createBettingService } = require('../lib/football/betting');
const { verifyCommitment } = require('../lib/football/v2/commitment');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-only-'));
  const file = path.join(dir, 'football.json'), profileFile = path.join(dir, 'profiles.json');
  const store = new FootballStore(file), profiles = new ProfileStore(profileFile);
  const league = store.generateSeason('2026-11');
  store.v2Only = true;
  const match = league.calendar.matches.find(m => m.homeId === 'norvela_sporting' && m.awayId === 'dynamo_kelvar');
  const now = match.scheduledKickoffAt + 86400000;
  for (const other of league.calendar.matches) if (other !== match) other.scheduledKickoffAt = now + 10 * 86400000;
  let betting;
  const official = createOfficialV2({ store, now: () => now, onlyV2: true,
    retireLegacy: month => betting.retireLegacySeason(month) });
  betting = createBettingService({ store, profiles, officialV2: official, now: () => now });
  const engine = new FootballEngine(store, { officialV2: official });
  t.after(() => { store.close(); profiles.saveNow(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, profiles, league, match, now, official, betting, engine, file, profileFile };
}
function addLegacy(h, profile) {
  const m = h.match, other = h.league.calendar.matches.find(item => item !== m);
  assert.ok(h.store.insertBet({ id: 'old-bet', profileId: profile.id, matchId: m.id, seasonMonth: '2026-11',
    market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true }).ok);
  assert.ok(h.store.insertParlay({ id: 'old-parlay', profileId: profile.id, seasonMonth: '2026-11', stake: 100,
    status: 'open', debited: true, legs: [m, other].map(item => ({ matchId: item.id, market: '1x2', selection: 'home', oddsAtPlacement: 2, status: 'open' })) }).ok);
  for (const [id, market] of [['old-future', 'champion'], ['old-bdo', 'balon_de_oro']]) {
    assert.ok(h.store.insertFuture({ id, idempotencyKey: id, profileId: profile.id, seasonMonth: '2026-11', market,
      selection: 'test', stake: 100, odds: 2, status: 'open', debited: true }).ok);
  }
}

test('retiro V1 reembolsa simples, combinadas y futuros una sola vez y recupera el partido con V2', async t => {
  const h = setup(t), profile = h.profiles.getOrCreate('retire-user', 'User');
  profile.chips = 600; h.profiles.saveNow();
  addLegacy(h, profile);
  const outcome = await h.betting.retireLegacySeason('2026-11');
  assert.equal(outcome.ok, true);
  assert.equal(profile.chips, 1000);
  for (const item of [h.store.getBet('old-bet'), h.store.getParlay('old-parlay'), h.store.getFuture('old-future'), h.store.getFuture('old-bdo')]) {
    assert.equal(item.status, 'void'); assert.equal(item.payout, 100); assert.equal(item.payoutApplied, true);
  }
  assert.equal((await h.betting.retireLegacySeason('2026-11')).ok, true);
  assert.equal(profile.chips, 1000);
  const scheduler = new FootballScheduler(h.engine, { officialV2: h.official });
  await scheduler.runSeasonSweep(h.now);
  assert.equal(h.match.status, 'settled');
  assert.ok(verifyCommitment(h.match.simulation, h.match));
  assert.ok(Array.isArray(h.match.fantasyStats));
  assert.deepEqual(h.store.getStandings('2026-11').filter(row => [h.match.homeId, h.match.awayId].includes(row.teamId)).map(row => row.played), [1, 1]);
  const reopened = new FootballStore(h.file), reopenedProfiles = new ProfileStore(h.profileFile);
  try {
    const again = createBettingService({ store: reopened, profiles: reopenedProfiles, now: () => h.now });
    assert.equal((await again.retireLegacySeason('2026-11')).ok, true);
    assert.equal(reopenedProfiles.getProfile(profile.id).chips, 1000);
    assert.deepEqual(reopened.getMatch(h.match.id).result, h.match.result);
  } finally { reopened.close(); reopenedProfiles.saveNow(); }
});

test('un reembolso fallido bloquea V2 y se reintenta sin pagar dos veces', async t => {
  const h = setup(t), profile = h.profiles.getOrCreate('retry-user', 'User');
  profile.chips = 900; h.profiles.saveNow();
  assert.ok(h.store.insertBet({ id: 'retry-bet', profileId: profile.id, matchId: h.match.id,
    seasonMonth: '2026-11', market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true }).ok);
  const persist = h.profiles.persistProfile.bind(h.profiles);
  h.profiles.persistProfile = () => false;
  assert.equal((await h.official.prepareMatch(h.match, h.now)).reason, 'retiro_v1_pendiente');
  assert.equal(h.match.simulation, undefined);
  assert.equal(h.store.getBet('retry-bet').payoutApplied, false);
  h.profiles.persistProfile = persist;
  assert.equal((await h.official.prepareMatch(h.match, h.now)).ok, true);
  assert.equal(profile.chips, 1000);
  assert.equal(h.store.getBet('retry-bet').payoutApplied, true);
});

test('modo oficial V2 no ejecuta V1 ni para partido viejo ni para uno sin compromiso', t => {
  const h = setup(t);
  assert.throws(() => h.engine._ensureTimeline(h.match), /V1 deshabilitado/);
  assert.throws(() => h.engine.startMatch(h.match, h.now), /V1 deshabilitado/);
  assert.equal(h.betting.getMatchContext({ ...h.match, seasonMonth: '2026-10' }), null);
});

test('al reanudar a las 15:01 recupera ambos cruces de West Hamón, conserva el compromiso y no duplica PJ', async t => {
  const h = setup(t);
  const first = h.match;
  const second = h.league.calendar.matches.find(m => m.id === 'm_2026-11_j2_b1_1');
  const at = Date.UTC(2026, 10, 2, 21, 1); // 15:01 Ciudad de México
  first.scheduledKickoffAt = Date.UTC(2026, 10, 2, 0);
  second.scheduledKickoffAt = Date.UTC(2026, 10, 2, 19);
  for (const match of h.league.calendar.matches) if (match !== first && match !== second) match.scheduledKickoffAt = at + 10 * 86400000;
  assert.equal((await h.official.prepareMatch(first, first.scheduledKickoffAt - 60000)).ok, true);
  const committed = JSON.stringify(first.simulation);
  await h.engine.reconcileBoot(at);
  assert.equal(first.status, 'settled'); assert.equal(second.status, 'settled');
  assert.equal(JSON.stringify(first.simulation), committed);
  assert.ok(verifyCommitment(second.simulation, second));
  assert.ok(first.fantasyStats.length >= 22 && second.fantasyStats.length >= 22);
  assert.ok(first.highlights && second.highlights);
  const played = id => h.store.getStandings('2026-11').find(row => row.teamId === id).played;
  assert.equal(played('norvela_sporting'), 2);
  assert.equal(played('dynamo_kelvar'), 1);
  assert.equal(played('cs_verdania'), 1);
  const scores = [first.result, second.result].map(item => JSON.stringify(item));
  await h.engine.repairOverdueMatches(at + 60000);
  assert.equal(played('norvela_sporting'), 2);
  assert.deepEqual([first.result, second.result].map(item => JSON.stringify(item)), scores);
});

test('un partido V1 en vivo sin acta vuelve a programado tras reembolsar y no se reproduce con V1', async t => {
  const h = setup(t), profile = h.profiles.getOrCreate('live-user', 'User');
  profile.chips = 900; h.profiles.saveNow();
  assert.ok(h.store.insertBet({ id: 'live-old', profileId: profile.id, matchId: h.match.id, seasonMonth: '2026-11',
    market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true }).ok);
  h.match.status = 'live'; h.match.actualKickoffAt = h.match.scheduledKickoffAt;
  const scheduler = new FootballScheduler(h.engine, { officialV2: h.official });
  for (let i = 0; i < 4; i++) scheduler.runSchedulerSweep(h.now + i * 500);
  assert.equal(h.match.status, 'live');
  await scheduler.runSeasonSweep(h.now + 60000);
  assert.equal(profile.chips, 1000);
  assert.equal(h.match.status, 'settled');
  assert.ok(verifyCommitment(h.match.simulation, h.match));
});

test('un reembolso V1 atascado de otro partido no detiene un compromiso V2 confirmado', async t => {
  const h = setup(t);
  assert.equal((await h.official.prepareMatch(h.match, h.now)).ok, true);
  const stuck = createOfficialV2({ store: h.store, onlyV2: true, now: () => h.now,
    retireLegacy: () => new Promise(() => {}) });
  assert.equal((await stuck.prepareMatch(h.match, h.now)).ok, true);
  assert.equal(h.engine.startMatch(h.match, h.now), true);
});

test('un compromiso V2 no arranca si su reembolso V1 sigue sin confirmar', async t => {
  const h = setup(t), profile = h.profiles.getOrCreate('pending-user', 'User');
  assert.equal((await h.official.prepareMatch(h.match, h.now)).ok, true);
  assert.ok(h.store.insertBet({ id: 'pending-old', profileId: profile.id, matchId: h.match.id, seasonMonth: '2026-11',
    market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true }).ok);
  h.profiles.persistProfile = () => false;
  assert.equal((await h.official.prepareMatch(h.match, h.now)).reason, 'retiro_v1_pendiente');
  assert.equal(h.store.getBet('pending-old').payoutApplied, false);
  assert.equal(h.betting.getMatchContext(h.match), null);
  assert.throws(() => h.engine.startMatch(h.match, h.now), /compromiso V2/);
  assert.equal((await h.official.prepareMatch(h.match, h.now)).reason, 'retiro_v1_pendiente');
});

test('tras caída entre anulación y perfil, el reembolso V1 se recupera exactamente una vez', async t => {
  const h = setup(t), profile = h.profiles.getOrCreate('restart-user', 'User');
  profile.chips = 900; h.profiles.saveNow();
  assert.ok(h.store.insertBet({ id: 'restart-bet', profileId: profile.id, matchId: h.match.id, seasonMonth: '2026-11',
    market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true }).ok);
  h.profiles.persistProfile = () => false;
  assert.equal((await h.betting.retireLegacySeason('2026-11')).ok, false);
  assert.equal(h.store.getBet('restart-bet').status, 'void');
  const reopened = new FootballStore(h.file), reopenedProfiles = new ProfileStore(h.profileFile);
  try {
    assert.equal(reopenedProfiles.getProfile(profile.id).chips, 900);
    const betting = createBettingService({ store: reopened, profiles: reopenedProfiles, now: () => h.now });
    assert.equal((await betting.retireLegacySeason('2026-11')).ok, true);
    assert.equal((await betting.retireLegacySeason('2026-11')).ok, true);
    assert.equal(reopenedProfiles.getProfile(profile.id).chips, 1000);
    assert.equal(reopened.getBet('restart-bet').payoutApplied, true);
  } finally { reopened.close(); reopenedProfiles.saveNow(); }
});

test('una colocación durable V1 pendiente sin débito en el perfil no recibe fichas inventadas', async t => {
  const h = setup(t), profile = h.profiles.getOrCreate('pending-debit-user', 'User');
  profile.chips = 1000; h.profiles.saveNow();
  assert.ok(h.store.insertBet({ id: 'pending-no-debit', profileId: profile.id, matchId: h.match.id,
    seasonMonth: '2026-11', market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2,
    status: 'pending', debited: true, escrowProtocol: 'durable-1' }).ok);
  assert.equal((await h.betting.retireLegacySeason('2026-11')).ok, true);
  assert.equal(profile.chips, 1000);
  assert.equal(h.store.getBet('pending-no-debit').payout, 0);
  assert.equal(h.store.getBet('pending-no-debit').payoutApplied, true);
});
