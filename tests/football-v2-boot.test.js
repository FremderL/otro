'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { FootballStore } = require('../lib/football-store');
const { generateCalendar } = require('../lib/football/fixtures');
const { buildSeasonClubs } = require('../lib/football/teams');
const { mulberry32 } = require('../lib/football/prng');
const { verifyPolicy } = require('../lib/football/v2/season-policy');
const { verifyCommitment } = require('../lib/football/v2/commitment');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function startServer(dir, at) {
  const port = await freePort(), clock = path.join(dir, 'clock.cjs');
  fs.writeFileSync(clock, `const RealDate = Date; const fixed = ${at};\n` +
    'global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };\n');
  const env = { ...process.env, DATABASE_URL: '', NODE_OPTIONS: `--require=${clock}`,
    PORT: String(port), CASINO_TIME_ZONE: 'America/Mexico_City', FOOTBALL_ENABLED: 'on',
    PROFILE_STORE_PATH: path.join(dir, 'profiles.json'), FOOTBALL_STORE_PATH: path.join(dir, 'football.json'),
    COMMUNITY_STORE_PATH: path.join(dir, 'community.json'), LOBBY_TOURNAMENT_STORE_PATH: path.join(dir, 'tournaments.json'),
    PROMOTION_MEDIA_DIR: path.join(dir, 'promotions'), LOTERIA_ENABLED: 'off', FORTUNE_ENABLED: 'off' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: dir, env });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`arranque agotado: ${output}`)); }, 30000);
    const done = fn => value => { clearTimeout(timer); fn(value); };
    child.stdout.on('data', chunk => { if (String(chunk).includes('MonteCristo lista en')) done(resolve)(); });
    child.once('error', done(reject));
    child.once('exit', done(code => reject(new Error(`servidor salió ${code}: ${output}`))));
  });
  return { child, port };
}
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('servidor real pasa de octubre a V2 automático antes de publicar y conserva claves tras reiniciar', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-boot-'));
  let child;
  t.after(async () => { if (child) await stopServer(child); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'football.json'), store = new FootballStore(file);
  const october = store.generateSeason('2026-10'), past = october.calendar.matches[0];
  assert.ok(store.settleMatch(past.id, { home: 2, away: 1 }, { now: Date.UTC(2026, 9, 30) }).ok);
  store.close();
  const cal = generateCalendar('2026-11', buildSeasonClubs(mulberry32(1)));
  const at = Math.min(...cal.matches.map(match => match.scheduledKickoffAt)) - 60000;
  let server = await startServer(dir, at); child = server.child;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const league = data.leagues.find(item => item.seasonMonth === '2026-11');
  assert.ok(verifyPolicy(league.simulationPolicy, '2026-11'));
  const match = league.calendar.matches.find(item => item.scheduledKickoffAt === at + 60000);
  assert.ok(verifyCommitment(match.simulation, match), 'el compromiso está durable antes de escuchar');
  assert.equal(match.simulation.inputs.source.previousSeason, '2026-10');
  assert.ok(match.simulation.inputs.context.previousSample > 0);
  assert.equal(match.simulation.pricing.version, 'v2-estimated-2');
  const response = await fetch(`http://127.0.0.1:${server.port}/api/estadio/matches/${match.id}`);
  assert.equal(response.status, 200);
  const publicData = await response.json();
  assert.equal(publicData.matchState.match.engine, 'v2');
  assert.ok(publicData.matchState.markets['1x2']);
  assert.doesNotMatch(JSON.stringify(publicData), /privateSeed|rootSeed|matchEnd|simulationPolicy/);
  await stopServer(child); child = null;
  server = await startServer(dir, at); child = server.child;
  const again = JSON.parse(fs.readFileSync(file, 'utf8')).leagues.find(item => item.seasonMonth === '2026-11');
  assert.deepEqual(again.simulationPolicy, league.simulationPolicy);
  assert.deepEqual(again.calendar.matches.find(item => item.id === match.id).simulation, match.simulation);
});

test('reinicio real reprograma el encuentro vencido sin iniciarlo ni cambiar su compromiso', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-reschedule-boot-'));
  let child;
  t.after(async () => { if (child) await stopServer(child); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'football.json'), store = new FootballStore(file);
  const league = store.generateSeason('2026-11');
  const match = league.calendar.matches.reduce((first, item) => item.scheduledKickoffAt < first.scheduledKickoffAt ? item : first);
  const kickoff = match.scheduledKickoffAt, at = kickoff + 22 * 60000;
  const { createOfficialV2 } = require('../lib/football/v2/official');
  const official = createOfficialV2({ store, now: () => kickoff - 60000 });
  assert.ok((await official.prepareMatch(match)).ok);
  const commitment = JSON.stringify(match.simulation), matchId = match.id;
  store.close();
  const server = await startServer(dir, at); child = server.child;
  await new Promise(resolve => setTimeout(resolve, 5500)); // el barrido de producción corre cada 5 s
  const response = await fetch(`http://127.0.0.1:${server.port}/api/estadio/matches/${matchId}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.matchState.match.status, 'scheduled');
  assert.equal(data.matchState.match.scheduledKickoffAt, at + 30 * 60000);
  assert.equal(data.matchState.match.autoRescheduled, true);
  assert.deepEqual(data.matchState.markets, {});
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')).leagues.find(item => item.seasonMonth === '2026-11');
  const saved = disk.calendar.matches.find(item => item.id === matchId);
  assert.equal(saved.status, 'scheduled');
  assert.equal(JSON.stringify(saved.simulation), commitment);
  assert.equal(saved.autoRescheduledAt, at);
});

test('despertar tras suspensión prolongada liquida > 30 min con estadísticas completas y reprograma <= 30 min', { timeout: 90000 }, async t => {
  const { ProfileStore } = require('../lib/profile-store');
  const { createBettingService } = require('../lib/football/betting');
  const { createOfficialV2 } = require('../lib/football/v2/official');
  const P = require('../lib/progression');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-suspend-boot-'));
  let child;
  t.after(async () => { if (child) await stopServer(child); fs.rmSync(dir, { recursive: true, force: true }); });

  const file = path.join(dir, 'football.json');
  const profileFile = path.join(dir, 'profiles.json');
  const store = new FootballStore(file);
  const profiles = new ProfileStore(profileFile);
  const league = store.generateSeason('2026-11');
  const sorted = league.calendar.matches.slice().sort((a, b) => a.scheduledKickoffAt - b.scheduledKickoffAt);

  // Dejamos tres partidos antes del despertar y el resto en el futuro para probar
  // en un proceso real los tres escenarios sin esperar 240 encuentros.
  const firstKickoff = sorted[0].scheduledKickoffAt;
  const committedOverdue = sorted[0];   // comprometido antes de dormir, > 30 min vencido al despertar
  const unpreparedOverdue = sorted[1];  // fuera del horizonte al dormir (sin compromiso previo), > 30 min vencido
  const recentOverdue = sorted[2];      // a 15 min al despertar (<= 30 min -> se reprograma)

  const wakeAt = firstKickoff + 30 * 3600000; // 30 horas después del primer partido
  committedOverdue.scheduledKickoffAt = firstKickoff;
  unpreparedOverdue.scheduledKickoffAt = firstKickoff + 26 * 3600000; // +26 h: a 4 h de atraso al despertar
  recentOverdue.scheduledKickoffAt = wakeAt - 15 * 60000;             // -15 min al despertar (<= 30 min)
  for (let i = 3; i < sorted.length; i++) {
    sorted[i].scheduledKickoffAt = wakeAt + (2 + Math.floor(i / 8)) * 86400000 + (i % 8) * 3600000;
  }

  const sleepAt = firstKickoff - 60000;
  const official = createOfficialV2({ store, now: () => sleepAt });
  assert.ok((await official.prepareMatch(committedOverdue, sleepAt)).ok);
  assert.equal(unpreparedOverdue.simulation, undefined, 'aún no estaba preparado antes de suspenderse el servicio');

  const profile = profiles.getOrCreate('suspended-bettor', 'Apostador');
  profile.chips = 1000;
  profile.achievements = P.ACHIEVEMENTS.map(item => item.id);
  profile.challenges = Object.fromEntries(P.CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
  P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false });
  profile.rotatingChallenges.daily.completed = true;
  profile.rotatingChallenges.weekly.completed = true;

  const betting = createBettingService({ store, profiles, officialV2: official, now: () => sleepAt });
  const betPlaced = await betting.placeBet({
    profile, matchId: committedOverdue.id, market: '1x2', selection: 'home',
    stake: 100, placedAt: sleepAt, idempotencyKey: 'suspend-bet-1'
  });
  assert.ok(betPlaced.ok, betPlaced.code);
  const recentBet = await betting.placeBet({
    profile, matchId: recentOverdue.id, market: '1x2', selection: 'away',
    stake: 100, placedAt: sleepAt, idempotencyKey: 'suspend-bet-2'
  });
  assert.ok(recentBet.ok, recentBet.code);

  const originalCommitment = JSON.stringify(committedOverdue.simulation);
  profiles.saveNow();
  store.saveNow();
  store.close();

  const server = await startServer(dir, wakeAt);
  child = server.child;

  // 1) Los dos partidos con > 30 min de retraso quedan liquidados antes de aceptar tráfico.
  for (const target of [committedOverdue, unpreparedOverdue]) {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/estadio/matches/${target.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const ms = body.matchState;
    assert.equal(ms.match.status, 'settled');
    assert.equal(ms.match.autoRescheduled, false);
    assert.ok(ms.match.result && ['home', 'away', 'draw'].includes(ms.match.result.winner));
    assert.equal(ms.state.phase, 'ended');
    assert.deepEqual(ms.state.score, { home: ms.match.result.home, away: ms.match.result.away });
    assert.ok(ms.state.stats && Number.isInteger(ms.state.stats.fouls.home) && Number.isInteger(ms.state.stats.fouls.away));
    assert.ok(Number.isInteger(ms.state.stats.shots.home) && Number.isInteger(ms.state.stats.corners.home));
    assert.ok(ms.match.highlights && Array.isArray(ms.match.highlights.goals));
    assert.equal(ms.match.highlights.goals.length, ms.match.result.home + ms.match.result.away);
  }

  // 2) El partido dentro de los primeros 30 min se reprograma +30 min y conserva su apuesta abierta.
  const recentRes = await fetch(`http://127.0.0.1:${server.port}/api/estadio/matches/${recentOverdue.id}`);
  assert.equal(recentRes.status, 200);
  const recentBody = await recentRes.json();
  assert.equal(recentBody.matchState.match.status, 'scheduled');
  assert.equal(recentBody.matchState.match.autoRescheduled, true);
  assert.equal(recentBody.matchState.match.scheduledKickoffAt, wakeAt + 30 * 60000);

  // 3) Verifica persistencia en disco: compromiso intacto, fantasyStats, Balón de Oro y liquidación del boleto.
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const savedLeague = disk.leagues.find(item => item.seasonMonth === '2026-11');
  const savedCommitted = savedLeague.calendar.matches.find(item => item.id === committedOverdue.id);
  const savedUnprepared = savedLeague.calendar.matches.find(item => item.id === unpreparedOverdue.id);
  const savedRecent = savedLeague.calendar.matches.find(item => item.id === recentOverdue.id);
  assert.equal(JSON.stringify(savedCommitted.simulation), originalCommitment);
  assert.ok(verifyCommitment(savedUnprepared.simulation, savedUnprepared));
  assert.ok(Array.isArray(savedCommitted.fantasyStats) && savedCommitted.fantasyStats.length >= 22);
  assert.ok(Array.isArray(savedUnprepared.fantasyStats) && savedUnprepared.fantasyStats.length >= 22);
  assert.equal(savedRecent.status, 'scheduled');

  const savedBet1 = disk.bets.find(item => item.id === betPlaced.bet.id);
  const savedBet2 = disk.bets.find(item => item.id === recentBet.bet.id);
  assert.ok(['won', 'lost'].includes(savedBet1.status));
  assert.equal(savedBet1.payoutApplied, true);
  assert.equal(savedBet2.status, 'open');

  const savedProfiles = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const reloadedUser = (savedProfiles.profiles || []).find(item => item.id === profile.id);
  const expectedChips = 800 + (savedBet1.status === 'won' ? betPlaced.bet.potentialPayout : 0);
  assert.equal(reloadedUser.chips, expectedChips);
});
