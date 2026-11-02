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
