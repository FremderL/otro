'use strict';

// Pruebas de la concesión de escritor único de Postgres con un pool simulado:
// adquisición inmediata, fallo instantáneo cuando el lock está ocupado
// (waitMs = 0, comportamiento histórico), modo "en espera" con reintento en
// segundo plano para deploys rolling de Render (FOOTBALL_WRITER_WAIT_MS), y el
// vallado de escrituras con withWriterFence.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  acquireFootballWriter,
  acquireFootballWriterWithWait,
  withWriterFence,
  FOOTBALL_WRITER_BUSY,
  FOOTBALL_WRITER_PENDING
} = require('../lib/football/pg-single-writer');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Pool simulado: `busyAttempts` indica cuántos pg_try_advisory_xact_lock
// devuelven false antes de conceder el lock.
function makeMockPool({ busyAttempts = 0 } = {}) {
  const state = { lockAttempts: 0, busyAttempts, fenceToken: null, queries: [] };
  const run = (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push(s);
    if (/pg_try_advisory_xact_lock/.test(s)) {
      state.lockAttempts += 1;
      return { rows: [{ acquired: state.lockAttempts > state.busyAttempts }] };
    }
    if (/^SELECT token FROM football_writer_fence/.test(s)) {
      return { rows: [{ token: state.fenceToken }] };
    }
    if (/^INSERT INTO football_writer_fence/.test(s)) {
      state.fenceToken = params[0];
      return { rows: [] };
    }
    return { rows: [] };
  };
  return {
    state,
    on() {},
    query: async (sql, params) => run(sql, params),
    connect: async () => ({ on() {}, query: async (sql, params) => run(sql, params), release() {} }),
    end: async () => {}
  };
}

test('adquiere la concesión de inmediato cuando el lock está libre', async () => {
  const pool = makeMockPool();
  const lease = await acquireFootballWriter(pool);
  assert.equal(lease.active, true);
  assert.ok(lease.token);
  const client = await pool.connect();
  await lease.assertTransaction(client); // el token del fence coincide
  await lease.close();
  assert.equal(lease.active, false);
});

test('sin espera falla al instante con FOOTBALL_WRITER_BUSY si otra instancia tiene el lock', async () => {
  const pool = makeMockPool({ busyAttempts: 99 });
  await assert.rejects(
    acquireFootballWriter(pool),
    error => error.code === FOOTBALL_WRITER_BUSY && /otra instancia/.test(error.message)
  );
  await assert.rejects(
    acquireFootballWriterWithWait(pool, { waitMs: 0 }),
    error => error.code === FOOTBALL_WRITER_BUSY
  );
});

test('modo espera: las escrituras se rechazan hasta adquirir y luego se delega en la concesión real', async () => {
  const pool = makeMockPool({ busyAttempts: 2 });
  let acquiredCalls = 0;
  const handle = await acquireFootballWriterWithWait(pool, {
    waitMs: 5000,
    retryMs: 5,
    onAcquired: async () => { acquiredCalls += 1; }
  });
  assert.equal(handle.pending, true);
  assert.equal(handle.active, false);
  const client = await pool.connect();
  await assert.rejects(handle.assertTransaction(client), error => error.code === FOOTBALL_WRITER_PENDING);
  const deadline = Date.now() + 3000;
  while (handle.pending && Date.now() < deadline) await sleep(5);
  assert.equal(handle.pending, false);
  assert.equal(handle.active, true);
  assert.equal(acquiredCalls, 1);
  await handle.assertTransaction(client); // ahora sí consulta el fence
  await handle.close();
  assert.equal(handle.active, false);
});

test('modo espera: si waitMs se agota sin conseguir la concesión, dispara onLost (fail-closed)', async () => {
  const pool = makeMockPool({ busyAttempts: 9999 });
  let lostError = null;
  const handle = await acquireFootballWriterWithWait(pool, {
    waitMs: 60,
    retryMs: 5,
    onLost: error => { lostError = error; }
  });
  const deadline = Date.now() + 3000;
  while (!lostError && Date.now() < deadline) await sleep(5);
  assert.ok(lostError);
  assert.equal(lostError.code, FOOTBALL_WRITER_BUSY);
  assert.equal(handle.active, false);
  await handle.close();
});

test('withWriterFence no ejecuta el trabajo con un handle pendiente y sí con la concesión adquirida', async () => {
  const busyPool = makeMockPool({ busyAttempts: 9999 });
  const pending = await acquireFootballWriterWithWait(busyPool, { waitMs: 10000, retryMs: 5 });
  let ran = 0;
  await assert.rejects(
    withWriterFence(busyPool, pending, async () => { ran += 1; }),
    error => error.code === FOOTBALL_WRITER_PENDING
  );
  assert.equal(ran, 0);
  await pending.close();

  const freePool = makeMockPool();
  const lease = await acquireFootballWriter(freePool);
  let ran2 = 0;
  await withWriterFence(freePool, lease, async client => { ran2 += 1; return client.query('SELECT 1'); });
  assert.equal(ran2, 1);
  await lease.close();
});

// --- Cableado real de PgProfileStore (deploy rolling de Render) ---
// Dos stores sobre la MISMA base simulada: el primero sostiene la concesión; el
// segundo arranca con footballWriterWaitMs y NO debe fallar al arrancar (Render
// lo declararía muerto y mataría el deploy), sino servir en espera y adquirir la
// concesión en segundo plano en cuanto la vieja la suelte.
function makeSharedDb() {
  const db = { holder: null, rows: { profiles: [], seasons: [] }, queries: [] };
  const resultFor = sql => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/pg_try_advisory_xact_lock/.test(s)) return { rows: [{ acquired: db.holder === null }] };
    if (/^SELECT token FROM football_writer_fence/.test(s)) {
      if (!db.holder) throw new Error('concesión de fútbol perdida');
      return { rows: [{ token: db.holder }] };
    }
    if (/SELECT data FROM montecristo_profiles/.test(s)) return { rows: db.rows.profiles };
    if (/SELECT data FROM montecristo_seasons/.test(s)) return { rows: db.rows.seasons };
    return { rows: [] };
  };
  const query = async (sql, params) => {
    db.queries.push(String(sql));
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO football_writer_fence/.test(s)) db.holder = params[0];
    // UPSERT de perfil: en producción devuelve RETURNING id (rowCount 1).
    if (/INSERT INTO montecristo_profiles/.test(s)) return { rows: [{ id: params[0] }], rowCount: 1 };
    if (/^ROLLBACK/.test(s)) db.holder = null;
    return resultFor(sql);
  };
  // Cada conexión de la concesión libera el lock al hacer ROLLBACK/liberar.
  const connect = async () => ({ on() {}, query, release() {} });
  return {
    db,
    Pool: class MockPool {
      constructor() { this.connectionString = 'postgres://mock-host/mockdb'; }
      on() {}
      query(sql, params) { return query(sql, params); }
      connect() { return connect(); }
      end() { return Promise.resolve(); }
    }
  };
}

test('PgProfileStore: el segundo proceso arranca en espera y adquiere la concesión sin morir (deploy rolling)', async () => {
  const { PgProfileStore } = require('../lib/profile-store-pg');
  const shared = makeSharedDb();
  const options = { Pool: shared.Pool, deferSeasonCheck: true, footballSingleWriter: true };

  const first = new PgProfileStore('postgres://mock-host/mockdb', options);
  await first.ready;
  assert.equal(first.footballWriter.active, true);

  const second = new PgProfileStore('postgres://mock-host/mockdb', {
    ...options, footballWriterWaitMs: 5000, onFootballWriterLost: () => { throw new Error('no debería perderse'); }
  });
  // Lo importante: ready RESUELVE aunque el lock esté ocupado (antes lanzaba).
  await second.ready;
  assert.equal(second.footballWriter.pending, true);
  assert.equal(second.footballWriter.active, false);
  // En espera no se puede escribir (fail-soft: la ruta de dinero devuelve false),
  // pero sí atender lecturas.
  const standby = second.getOrCreate('jugador', 'Jugador');
  assert.equal(await second.persistProfile(standby), false);

  // La instancia saliente suelta la concesión: la nueva la toma y recarga.
  let acquired = 0;
  second.onFootballWriterAcquired = async () => { acquired += 1; };
  await first.footballWriter.close();
  const deadline = Date.now() + 3000;
  while (!second.footballWriter.active && Date.now() < deadline) await sleep(5);
  assert.equal(second.footballWriter.active, true);
  assert.equal(second.footballWriter.pending, false);
  assert.equal(acquired, 1, 'recarga antes de habilitar escrituras');
  // Ya con la concesión, las escrituras de dinero vuelven a confirmarse.
  const fresh = second.getOrCreate('jugador-nuevo', 'Jugador Nuevo');
  assert.equal(await second.persistProfile(fresh), true);

  await first.close();
  await second.close();
});

test('PgProfileStore: sin margen de espera sigue fallando al instante (comportamiento histórico)', async () => {
  const { PgProfileStore } = require('../lib/profile-store-pg');
  const shared = makeSharedDb();
  const options = { Pool: shared.Pool, deferSeasonCheck: true, footballSingleWriter: true };
  const first = new PgProfileStore('postgres://mock-host/mockdb', options);
  await first.ready;
  const second = new PgProfileStore('postgres://mock-host/mockdb', { ...options, footballWriterWaitMs: 0 });
  await assert.rejects(second.ready, /otra instancia ya controla el Estadio/);
  await first.close();
});
