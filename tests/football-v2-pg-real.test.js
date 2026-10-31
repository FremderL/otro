'use strict';

// PostgreSQL real opcional: ejecuta el recorrido V2 completo dentro de un
// esquema temporal; también comprueba exclusión entre procesos y servidores reales.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { PgFootballStore } = require('../lib/football-store-pg');
const { PgProfileStore } = require('../lib/profile-store-pg');
const { FootballEngine } = require('../lib/football/engine');
const { createBettingService } = require('../lib/football/betting');
const { prepareV2Match, attachV2Pricing } = require('../lib/football/v2/prepare');
const { VERSION } = require('../lib/football/v2/simulator');
const C = require('../lib/football/v2/calibration');
const P = require('../lib/progression');

const URL = process.env.FOOTBALL_TEST_DATABASE_URL;

test('PostgreSQL real: compromiso V2, apuesta, reinicio y pago idempotente', { skip: !URL, timeout: 30000 }, async t => {
  const schema = `v2_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  class ScopedPool extends Pool { constructor(options) { super({ ...options, options: `-c search_path=${schema}` }); } }
  let store, profiles;
  t.after(async () => {
    if (store) { await store.close(); await store.pool.end(); }
    if (profiles) await profiles.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const start = async () => {
    const pool = new ScopedPool({ connectionString: URL });
    store = new PgFootballStore(URL, { pool });
    profiles = new PgProfileStore(URL, { Pool: ScopedPool, deferSeasonCheck: true });
    await Promise.all([store.ready, profiles.ready]);
  };
  const stop = async () => {
    await store.close(); await store.pool.end(); store = null;
    await profiles.close(); profiles = null;
  };
  await start();
  const league = store.generateSeason('2026-11');
  const match = league.calendar.matches[0];
  const now = Math.min(...league.calendar.matches.map(item => item.scheduledKickoffAt)) - 60000;
  assert.equal(await store.saveStrict(), true);
  while (store._saving) await store._savingPromise;
  // Simula que COMMIT llegó a PostgreSQL pero se perdió su respuesta.
  const write = store._writeSnapshot.bind(store);
  let loseResponse = true;
  store._writeSnapshot = async () => {
    await write();
    if (loseResponse) { loseResponse = false; throw new Error('respuesta de COMMIT perdida'); }
  };
  const uncertain = await prepareV2Match({ store, match, asOf: now, keyFactory: () => '45'.repeat(32) });
  assert.equal(uncertain.reason, 'persistencia_pendiente');
  store._writeSnapshot = write;
  const prepared = await prepareV2Match({ store, match, asOf: now, keyFactory: () => '99'.repeat(32) });
  assert.equal(prepared.ok, true, prepared.reason);
  assert.equal(match.simulation.privateSeed, '45'.repeat(32), 'no cambiar el compromiso tras un COMMIT incierto');
  const sample = { version: C.VERSION, simulatorVersion: VERSION, inputHash: match.simulation.inputsHash, samples: 2048,
    counts: { '0-0': 400, '1-0': 500, '0-1': 360, '1-1': 420, '2-0': 150, '2-1': 130, '1-2': 88 }, liveByState: [] };
  const pricing = await attachV2Pricing({ store, match, asOf: now,
    training: { ...sample, keyCommitment: 'aa'.repeat(32) }, holdout: { ...sample, keyCommitment: 'bb'.repeat(32) } });
  assert.equal(pricing.ok, true, pricing.reason);
  const profile = profiles.getOrCreate('v2-real-player', 'Jugador');
  profile.chips = 1000;
  profile.achievements = P.ACHIEVEMENTS.map(item => item.id);
  profile.challenges = Object.fromEntries(P.CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
  P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false });
  profile.rotatingChallenges.daily.completed = true;
  profile.rotatingChallenges.weekly.completed = true;
  assert.equal(await profiles.persistProfile(profile), true);
  let betting = createBettingService({ store, profiles, now: () => now });
  const request = { profile, matchId: match.id, market: '1x2', selection: 'home', stake: 100,
    placedAt: now, idempotencyKey: 'v2-real-request-1' };
  const placed = await betting.placeBet(request);
  assert.equal(placed.ok, true, placed.code);
  const betId = placed.bet.id;
  const simulationId = placed.bet.simulationId;
  assert.equal(profile.chips, 900);
  await stop();
  await start();
  const loaded = store.getMatch(match.id, '2026-11');
  const reloadedProfile = profiles.getProfile(profile.id);
  assert.equal(loaded.simulation.privateSeed, '45'.repeat(32));
  assert.equal(loaded.simulation.pricing.version, 'v2-quotes-2');
  assert.equal(store.getBet(betId).simulationId, simulationId);
  assert.equal(reloadedProfile.chips, 900);
  betting = createBettingService({ store, profiles, now: () => now });
  assert.equal((await betting.placeBet({ ...request, profile: reloadedProfile })).replayed, true);
  assert.equal(reloadedProfile.chips, 900);
  const engine = new FootballEngine(store, { settleBets: (m, score) => betting.settleMatchBets(m, score) });
  const replay = engine._ensureTimeline(loaded);
  assert.equal(engine.startMatch(loaded, loaded.scheduledKickoffAt), true);
  assert.equal(engine.advance(loaded, loaded.scheduledKickoffAt + replay.clock.matchEnd * 15000 + 1).ended, true);
  await Promise.all([...betting.ticketPayouts.values()]);
  assert.equal(await store.saveStrict(), true);
  const won = replay.score.home > replay.score.away;
  const expected = 900 + (won ? placed.bet.potentialPayout : 0);
  assert.equal(reloadedProfile.chips, expected);
  assert.equal(store.getBet(betId).payoutApplied, true);
  await stop();
  await start();
  betting = createBettingService({ store, profiles });
  betting.reconcileEscrow();
  assert.equal(profiles.getProfile(profile.id).chips, expected);
  assert.equal(store.getBet(betId).payoutApplied, true);
});

// El backend de producción toma una concesión ANTES de cargar perfiles: una
// segunda instancia no puede servir una copia obsoleta del saldo.
test('PostgreSQL: una sola instancia escribe y la siguiente recupera el saldo correcto',
  { skip: !URL, timeout: 30000 }, async t => {
    const schema = `v2_writer_${randomUUID().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    class ScopedPool extends Pool { constructor(options) { super({ ...options, options: `-c search_path=${schema}` }); } }
    const profilesToClose = [], footballToClose = [];
    t.after(async () => {
      for (const store of footballToClose) {
        clearTimeout(store.saveTimer); clearTimeout(store._backgroundRetryTimer);
        await store.pool.end().catch(() => {});
      }
      for (const profiles of profilesToClose) {
        clearTimeout(profiles.saveTimer); clearTimeout(profiles._backgroundRetryTimer);
        await profiles.close();
      }
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const startProfiles = () => {
      const profiles = new PgProfileStore(URL, { Pool: ScopedPool, deferSeasonCheck: true, footballSingleWriter: true });
      profilesToClose.push(profiles);
      return profiles;
    };
    const first = startProfiles();
    await first.ready;
    const store = new PgFootballStore(URL, { pool: new ScopedPool({ connectionString: URL }), writerLease: first.footballWriter });
    footballToClose.push(store);
    await store.ready;
    const league = store.generateSeason('2026-11');
    const now = Math.min(...league.calendar.matches.map(match => match.scheduledKickoffAt)) - 60000;
    assert.equal(await store.saveStrict(), true);
    const profile = first.getOrCreate('v2-writer-player', 'Jugador');
    profile.chips = 1000;
    assert.equal(await first.persistProfile(profile), true);
    const duplicate = startProfiles();
    await assert.rejects(duplicate.ready, /otra instancia/);
    await duplicate.close();
    const betting = createBettingService({ store, profiles: first, now: () => now });
    const placed = await betting.placeBet({ profile, matchId: league.calendar.matches[0].id, market: '1x2',
      selection: 'home', stake: 500, idempotencyKey: 'writer-first' });
    assert.equal(placed.ok, true, placed.code);
    assert.equal(profile.chips, 500);
    assert.equal(await store.saveStrict(), true);
    clearTimeout(first.saveTimer);
    await first.saveNow();
    while (first._saving) await new Promise(resolve => setImmediate(resolve));
    // Después de soltar la concesión, el nuevo servidor recarga la base; la
    // instancia anterior ya no puede escribir ni fichas ni fotos de la liga.
    await first.footballWriter.close();
    const second = startProfiles();
    await second.ready;
    const reloaded = second.getProfile(profile.id);
    assert.equal(reloaded.chips, 500);
    profile.chips = 999;
    assert.equal(await first.persistProfile(profile), false);
    assert.equal(await store.saveStrict(), false);
    const secondStore = new PgFootballStore(URL, { pool: new ScopedPool({ connectionString: URL }), writerLease: second.footballWriter });
    footballToClose.push(secondStore);
    await secondStore.ready;
    const betting2 = createBettingService({ store: secondStore, profiles: second, now: () => now });
    const secondBet = await betting2.placeBet({ profile: reloaded, matchId: league.calendar.matches[1].id,
      market: '1x2', selection: 'away', stake: 250, idempotencyKey: 'writer-second' });
    assert.equal(secondBet.ok, true, secondBet.code);
    assert.equal(reloaded.chips, 250);
    assert.equal(await secondStore.saveStrict(), true);
    const db = new ScopedPool({ connectionString: URL });
    try {
      const bets = await db.query("SELECT count(*)::int AS count FROM football_bets WHERE status='open'");
      const row = await db.query("SELECT data->>'chips' AS chips FROM montecristo_profiles WHERE id=$1", [profile.id]);
      assert.equal(bets.rows[0].count, 2);
      assert.equal(Number(row.rows[0].chips), 250);
    } finally { await db.end(); }
  });

test('PostgreSQL: el nuevo escritor espera escrituras protegidas que ya estaban en curso',
  { skip: !URL, timeout: 30000 }, async t => {
    const { acquireFootballWriter } = require('../lib/football/pg-single-writer');
    const schema = `v2_fence_${randomUUID().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = { connectionString: URL, options: `-c search_path=${schema}` };
    const a = new Pool(options), b = new Pool(options);
    let first, second, transaction;
    t.after(async () => {
      if (transaction) { await transaction.query('ROLLBACK').catch(() => {}); transaction.release(); }
      await first?.close(); await second?.close();
      await a.end(); await b.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    });
    first = await acquireFootballWriter(a);
    transaction = await a.connect();
    await transaction.query('BEGIN');
    await first.assertTransaction(transaction);
    await first.close();
    let obtained = false;
    const pending = acquireFootballWriter(b).then(writer => { obtained = true; second = writer; return writer; });
    // El nuevo dueño ya puede tomar el advisory lock, pero su token no puede
    // sustituir al anterior hasta que termine la transacción protegida.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(obtained, false);
    await transaction.query('COMMIT'); transaction.release(); transaction = null;
    await pending;
    assert.equal(obtained, true);
    const check = await b.connect();
    try { await check.query('BEGIN'); await second.assertTransaction(check); await check.query('COMMIT'); }
    finally { check.release(); }
  });

test('PostgreSQL: la exclusión se comparte entre procesos Node independientes',
  { skip: !URL, timeout: 30000 }, async t => {
    const { acquireFootballWriter } = require('../lib/football/pg-single-writer');
    const { spawnSync } = require('node:child_process');
    const schema = `v2_process_${randomUUID().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: URL, options: `-c search_path=${schema}` });
    let writer;
    t.after(async () => { await writer?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    writer = await acquireFootballWriter(pool);
    const script = `
      const {Pool}=require('pg');
      const {acquireFootballWriter}=require('./lib/football/pg-single-writer');
      (async()=>{
        const pool=new Pool({connectionString:process.env.TEST_URL,options:'-c search_path='+process.env.TEST_SCHEMA});
        try { const writer=await acquireFootballWriter(pool); console.log('ACQUIRED'); await writer.close(); }
        catch(error) { if (/otra instancia/.test(error.message)) console.log('BLOCKED'); else {console.error(error); process.exitCode=1;} }
        finally { await pool.end(); }
      })();`;
    const run = () => spawnSync(process.execPath, ['-e', script], {
      cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TEST_URL: URL, TEST_SCHEMA: schema }
    });
    const blocked = run();
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /BLOCKED/);
    await writer.close(); writer = null;
    const acquired = run();
    assert.equal(acquired.status, 0, acquired.stderr);
    assert.match(acquired.stdout, /ACQUIRED/);
  });

test('PostgreSQL: dos servidores con Estadio activo no arrancan como escritores a la vez',
  { skip: !URL, timeout: 60000 }, async t => {
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const schema = `v2_server_${randomUUID().replace(/-/g, '')}`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otro-writer-server-'));
    const admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URLSearchParams({ options: `-c search_path=${schema}` });
    const dbUrl = `${URL}${URL.includes('?') ? '&' : '?'}${url}`;
    const children = [];
    function launch() {
      const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: dbUrl, FOOTBALL_ENABLED: 'on', PORT: '0', NODE_ENV: 'test',
          LOG_JSON: 'off', LOTERIA_ENABLED: 'off', FORTUNE_ENABLED: 'off', AUTO_BOTS: 'off',
          SHUTDOWN_GRACE_MS: '100', PROMOTION_MEDIA_DIR: directory,
          PROFILE_STORE_PATH: path.join(directory, 'profiles.json'),
          FOOTBALL_STORE_PATH: path.join(directory, 'football.json'),
          COMMUNITY_STORE_PATH: path.join(directory, 'community.json'),
          LOBBY_TOURNAMENT_STORE_PATH: path.join(directory, 'tournaments.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.text = '';
      child.stdout.on('data', chunk => { child.text += chunk.toString(); });
      child.stderr.on('data', chunk => { child.text += chunk.toString(); });
      children.push(child);
      return child;
    }
    function wait(child, predicate, timeout = 25000) {
      return new Promise((resolve, reject) => {
        let timer, limit;
        const finish = error => {
          clearInterval(timer); clearTimeout(limit); child.removeListener('exit', check);
          if (error) reject(error); else resolve();
        };
        const check = () => {
          if (predicate(child)) finish();
          else if (child.exitCode !== null || child.signalCode) finish(new Error(`El servidor terminó: ${child.text}`));
        };
        timer = setInterval(check, 25);
        limit = setTimeout(() => finish(new Error(`Tiempo agotado: ${child.text}`)), timeout);
        child.once('exit', check);
        check();
      });
    }
    async function stop(child) {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 4000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    }
    t.after(async () => {
      for (const child of children) await stop(child);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const first = launch();
    await wait(first, child => /MonteCristo lista/.test(child.text));
    const second = launch();
    await wait(second, child => child.exitCode !== null);
    assert.notEqual(second.exitCode, 0);
    assert.match(second.text, /otra instancia.*controla el Estadio/i);
    // Se pierde la conexión que mantiene el bloqueo, como ante un corte de red
    // o reinicio de PostgreSQL. El servidor anterior debe terminar y no seguir
    // usando la copia de perfiles que tenía en memoria.
    const locks = await admin.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objsubid=1
      AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
      AND objid::bigint = (hashtextextended($1, 0) & 4294967295) AND granted`,
    [`montecristo-football-writer:${schema}`]);
    assert.equal(locks.rowCount, 1);
    await admin.query('SELECT pg_terminate_backend($1)', [locks.rows[0].pid]);
    await wait(first, child => child.exitCode !== null);
    assert.equal(first.exitCode, 1, first.text);
    assert.match(first.text, /Se perdió la exclusión de escritura del Estadio/);
    const third = launch();
    await wait(third, child => /MonteCristo lista/.test(child.text));
    assert.equal(third.exitCode, null, third.text);
  });
