'use strict';

// Fase 10.4: smoke test del backend de Postgres para perfiles.
//
// Corre SIEMPRE dentro de `npm test`, sin necesidad de una base de datos real:
// usa un Postgres simulado en memoria (mismo contrato de `pg`: Pool/Client con
// `.query()`, `.connect()`, `.release()`) inyectado en PgProfileStore, así se
// ejercita el código de producción real (SQL incluido) sin red.
//
// Si además defines DATABASE_URL_TEST (una base Postgres/Neon desechable para
// pruebas), también corre una ronda de verdad contra esa base y limpia sus
// propias filas al terminar. Sin esa variable, esa parte se omite con un
// aviso — las 16 suites históricas (y esta) siguen en verde sin ninguna base.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { PgProfileStore } = require('../lib/profile-store-pg');
const { createProfileStore } = require('../lib/profile-store-factory');
const { ProfileStore } = require('../lib/profile-store');

// --- Postgres simulado -----------------------------------------------------
// Reproduce solo las cinco formas de consulta que usa lib/profile-store-pg.js
// (ver SCHEMA_SQL y saveNow/load ahí). Cualquier otra consulta lanza un error
// claro para detectar de inmediato si el store empieza a usar SQL nuevo.
function runFakeQuery(state, sql, params = []) {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (/^CREATE TABLE/i.test(text)) return { rows: [] };
  if (/^BEGIN$/i.test(text)) return { rows: [] };
  if (/^COMMIT$/i.test(text)) return { rows: [] };
  if (/^ROLLBACK$/i.test(text)) return { rows: [] };
  if (/^SELECT data FROM montecristo_profiles$/i.test(text)) {
    return { rows: [...state.profiles.values()].map(row => ({ data: row.data })) };
  }
  if (/^SELECT data FROM montecristo_seasons WHERE id = 1$/i.test(text)) {
    return { rows: state.seasons ? [{ data: state.seasons.data }] : [] };
  }
  if (/^INSERT INTO montecristo_profiles/i.test(text)) {
    const [ids, datas] = params;
    ids.forEach((id, index) => state.profiles.set(id, { data: JSON.parse(datas[index]) }));
    return { rows: [] };
  }
  if (/^INSERT INTO montecristo_seasons/i.test(text)) {
    state.seasons = { data: JSON.parse(params[0]) };
    return { rows: [] };
  }
  throw new Error(`Postgres simulado: consulta no reconocida -> ${text}`);
}

function createFakePgBackend() {
  const state = { profiles: new Map(), seasons: null };
  class FakeClient {
    async query(sql, params) { return runFakeQuery(state, sql, params); }
    release() {}
  }
  class FakePool {
    constructor(config) { this.config = config; }
    on() {}
    async query(sql, params) { return runFakeQuery(state, sql, params); }
    async connect() { return new FakeClient(); }
    async end() {}
  }
  return { Pool: FakePool, state };
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tiempo agotado (${label})`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function testCicloDeVidaCompleto() {
  const backend = createFakePgBackend();
  const store = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
  await store.ready;

  // Alta y edición, igual que el store de archivo.
  const profile = store.getOrCreate('jugador-1', 'Ana', 'panda');
  assert.equal(profile.chips, 1000, 'saldo inicial 1000');
  store.update(profile, { name: 'Ana María', avatar: 'owl' });
  assert.equal(profile.name, 'Ana María');
  assert.equal(profile.avatar, 'owl');

  profile.chips = 1450;
  store.touch(profile);

  // Ranking: agregamos un segundo jugador con más fichas.
  const rival = store.getOrCreate('jugador-2', 'Beto', 'fox');
  rival.chips = 5000;
  store.touch(rival);

  await store.saveNow();
  assert.ok(backend.state.profiles.has('jugador-1'), 'el perfil se escribió en la base simulada');
  assert.equal(backend.state.profiles.get('jugador-1').data.chips, 1450);

  const ranking = store.top(10);
  assert.equal(ranking[0].name, 'Beto', 'el ranking ordena por fichas');
  assert.equal(ranking[1].name, 'Ana María');

  // "Reinicio del servidor": una segunda instancia del store, contra la misma
  // base simulada, debe recuperar exactamente lo guardado (persistencia real).
  const store2 = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
  await store2.ready;
  const recovered = store2.profiles.get('jugador-1');
  assert.ok(recovered, 'el perfil sobrevive a un reinicio simulado');
  assert.equal(recovered.chips, 1450);
  assert.equal(recovered.name, 'Ana María');

  // Bono diario / reinicio mensual: forzamos que la temporada quede "vieja" y
  // verificamos el mismo comportamiento que el store de archivo (Fase 8.7).
  store2.seasons.current = '2000-01';
  const closed = store2.ensureSeason();
  assert.ok(closed, 'ensureSeason cierra la temporada vieja');
  assert.equal(closed.month, '2000-01');
  assert.equal(recovered.chips, 1000, 'el saldo se reinicia a 1000 en la nueva temporada');
  await store2.saveNow();

  const store3 = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
  await store3.ready;
  assert.equal(store3.seasons.history.length, 1, 'la temporada cerrada quedó archivada en la base');
  assert.equal(store3.profiles.get('jugador-1').chips, 1000);

  await store.close();
  await store2.close();
  await store3.close();
}

async function testMigracionDeFormatoLegado() {
  // El store de Postgres debe aceptar perfiles "crudos" con el mismo formato
  // legado que ya soporta el de archivo (cleanProfile se comparte entre ambos).
  const backend = createFakePgBackend();
  backend.state.profiles.set('viejo-1', { data: { id: 'viejo-1', name: 'Legado', chips: '250.9', avatar: 'no-existe' } });
  const store = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
  await store.ready;
  const profile = store.profiles.get('viejo-1');
  assert.ok(profile, 'perfil legado cargado');
  assert.equal(profile.chips, 250, 'chips se normalizan a entero');
  assert.equal(profile.avatar, 'fox', 'avatar inválido cae al default');
  await store.close();
}

async function testFactorySinDatabaseUrl() {
  // Sin DATABASE_URL, la fábrica debe seguir devolviendo el store de archivo
  // de siempre: ningún cambio de comportamiento local ni en los tests actuales.
  const tmpFile = path.join(os.tmpdir(), `montecristo-factory-json-${process.pid}-${Date.now()}.json`);
  const store = await createProfileStore(tmpFile, undefined);
  assert.ok(store instanceof ProfileStore, 'sin DATABASE_URL se usa el ProfileStore de archivo');
  assert.equal(store.filePath, tmpFile);
}

async function testFactoryConDatabaseUrlEligePostgres() {
  // Con DATABASE_URL definida, la fábrica debe intentar Postgres de verdad
  // (no caer en silencio al archivo JSON). Usamos un host inexistente con
  // timeout corto: si el intento de conexión falla rápido, confirma que tomó
  // la rama de Postgres en vez de ignorar la variable.
  const start = Date.now();
  await assert.rejects(
    () => createProfileStore('/tmp/no-debe-usarse.json', 'postgres://usuario:clave@host-inexistente.invalid:5432/db', {
      connectionTimeoutMillis: 800
    }),
    undefined,
    'DATABASE_URL con host inválido debe rechazar, no usar el archivo JSON en silencio'
  );
  assert.ok(Date.now() - start < 8000, 'el intento de conexión falló sin colgar la prueba');
}

async function testContraPostgresReal() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    console.log('↷ Sin DATABASE_URL_TEST: se omite la prueba contra un Postgres real (Neon u otro). Todo lo demás corrió con el Postgres simulado.');
    return;
  }
  const testId = `smoke-test-${Date.now()}`;
  const store = new PgProfileStore(url);
  await store.ready;
  try {
    const profile = store.getOrCreate(testId, 'SmokeTest', 'robot');
    profile.chips = 4242;
    store.touch(profile);
    await store.saveNow();

    const store2 = new PgProfileStore(url);
    await store2.ready;
    try {
      const recovered = store2.profiles.get(testId);
      assert.ok(recovered, 'el perfil de prueba se leyó de vuelta desde Postgres real');
      assert.equal(recovered.chips, 4242);
    } finally {
      await store2.pool.query('DELETE FROM montecristo_profiles WHERE id = $1', [testId]).catch(() => {});
      await store2.close();
    }
  } finally {
    await store.pool.query('DELETE FROM montecristo_profiles WHERE id = $1', [testId]).catch(() => {});
    await store.close();
  }
}

async function main() {
  await withTimeout(testCicloDeVidaCompleto(), 5000, 'ciclo de vida con Postgres simulado');
  await withTimeout(testMigracionDeFormatoLegado(), 5000, 'migración de formato legado');
  await withTimeout(testFactorySinDatabaseUrl(), 5000, 'fábrica sin DATABASE_URL');
  await withTimeout(testFactoryConDatabaseUrlEligePostgres(), 8000, 'fábrica con DATABASE_URL inválida');
  await withTimeout(testContraPostgresReal(), 15000, 'ronda opcional contra Postgres real');
  console.log('✅ profile-store-pg-smoke: alta/edición, ranking, persistencia entre reinicios, temporada, formato legado y selección por DATABASE_URL OK');
}

main().catch(error => {
  console.error('❌ profile-store-pg-smoke falló:', error);
  process.exit(1);
});
