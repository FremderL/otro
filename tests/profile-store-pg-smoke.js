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
  // Fase 11.4: DELETE de cuentas eliminadas (inactividad, panel de admin a futuro).
  if (/^DELETE FROM montecristo_profiles WHERE id = ANY/i.test(text)) {
    for (const id of params[0]) state.profiles.delete(id);
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

// Fase 11.3: variante "quisquillosa" del Postgres simulado, que falla las
// primeras `failTimes` operaciones (conexión o consulta) con un error de
// conexión típico de una base "despertando" (p. ej. Neon escalando desde
// cero), y a partir de ahí funciona normal. Sirve para probar los reintentos
// de _init()/load()/saveNow() sin tocar una base real. Con `failTimes:
// Infinity` simula una base que nunca responde (fallo permanente).
function createFlakyFakePgBackend(failTimes = 0) {
  const state = { profiles: new Map(), seasons: null };
  let remaining = failTimes;
  function maybeFail() {
    if (remaining > 0) {
      remaining -= 1;
      const error = new Error('Postgres simulado: fallo transitorio de conexión (base despertando)');
      error.code = 'ETIMEDOUT';
      throw error;
    }
  }
  class FakeClient {
    async query(sql, params) { maybeFail(); return runFakeQuery(state, sql, params); }
    release() {}
  }
  class FakePool {
    constructor(config) { this.config = config; }
    on() {}
    async query(sql, params) { maybeFail(); return runFakeQuery(state, sql, params); }
    async connect() { maybeFail(); return new FakeClient(); }
    async end() {}
  }
  return { Pool: FakePool, state, stopFailing: () => { remaining = 0; } };
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

// Fase 11.4: borrar un perfil (deleteProfile / pruneInactiveAccounts) debe
// borrar también su fila en Postgres, no solo la memoria -- si no, nunca se
// ahorra el espacio que se buscaba liberar.
async function testBorradoDeCuentaSePropagaAPostgres() {
  const backend = createFakePgBackend();
  const store = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
  await store.ready;

  const activo = store.getOrCreate('cuenta-activa', 'Activa', 'fox');
  const abandonado = store.getOrCreate('cuenta-abandonada', 'Fantasma', 'owl');
  await store.saveNow();
  assert.ok(backend.state.profiles.has('cuenta-abandonada'), 'la cuenta abandonada se guardó primero, como cualquier otra');

  // Simulamos ~4 meses sin actividad y corremos la poda, igual que el barrido
  // periódico de server.js.
  abandonado.updatedAt = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const removed = store.pruneInactiveAccounts(90 * 24 * 60 * 60 * 1000);
  assert.deepEqual(removed.map(e => e.id), ['cuenta-abandonada'], 'la poda identifica solo a la cuenta inactiva');
  assert.equal(store.profiles.has('cuenta-abandonada'), false, 'ya no está en memoria');

  await store.saveNow();
  assert.equal(backend.state.profiles.has('cuenta-abandonada'), false, 'la fila también se borró en Postgres, no solo en memoria');
  assert.ok(backend.state.profiles.has('cuenta-activa'), 'la cuenta activa no se ve afectada');
  assert.equal(store._pendingDeletes.size, 0, 'la eliminación pendiente se confirmó y ya no queda por reintentar');

  await store.close();
}

// Fase 11.3: un hipo transitorio al arrancar (p. ej. Neon despertando de
// escalar a cero justo cuando el propio servicio despierta en Render) no debe
// hacer que el store arranque vacío en silencio; debe reintentar y cargar los
// datos reales igual que si no hubiera pasado nada.
async function testReintentaCargaAlArrancarTrasFalloTransitorio() {
  const backend = createFlakyFakePgBackend(1); // falla solo la primera operación (crear tablas)
  const store = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
  // Sembramos un perfil "ya existente" directamente en el estado simulado,
  // como si otra instancia lo hubiera guardado antes de que este proceso
  // arrancara.
  backend.state.profiles.set('viejo-cliente', { data: { id: 'viejo-cliente', name: 'Cliente Viejo', chips: 777, avatar: 'fox' } });
  await store.ready;
  const recovered = store.profiles.get('viejo-cliente');
  assert.ok(recovered, 'el perfil existente se cargó pese al fallo transitorio inicial');
  assert.equal(recovered.chips, 777, 'los datos reales no se perdieron ni se reemplazaron por un perfil en blanco');
  await store.close();
}

// Fase 11.3 (regresión del bug crítico): si Postgres no responde en absoluto
// durante el arranque (ni tras los reintentos), el store NO debe quedar listo
// con la memoria vacía -- eso arriesgaría sobrescribir los datos reales de la
// base con perfiles en blanco en el siguiente guardado. Debe rechazar y dejar
// que server.js aborte el arranque (bootstrap().catch -> process.exit(1)).
async function testFalloPermanenteAlArrancarNoDejaStoreVacioListo() {
  const backend = createFlakyFakePgBackend(Infinity); // nunca responde con éxito
  await assert.rejects(
    async () => {
      const store = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
      await store.ready;
    },
    undefined,
    'con Postgres inalcanzable, ready debe rechazar en vez de quedar listo con el store vacío'
  );
}

// Fase 11.3: un guardado que falla por un hipo transitorio (p. ej. Neon
// despertando) se reintenta solo, sin perder el cambio ni requerir que otro
// evento dispare un nuevo guardado.
async function testGuardadoReintentaTrasFalloTransitorio() {
  const arranque = createFakePgBackend();
  const store = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: arranque.Pool });
  await store.ready;

  const profile = store.getOrCreate('jugador-reintento', 'Rita', 'owl');
  profile.chips = 3210;
  store.touch(profile);
  clearTimeout(store.saveTimer); // evita que el debounce normal (180ms) dispare un guardado paralelo al de esta prueba

  // El store ya arrancó; para aislar la prueba al camino de saveNow(),
  // reemplazamos su pool por uno que falla una sola vez (como un hipo
  // transitorio de red justo al momento de guardar).
  const backendConFallo = createFlakyFakePgBackend(1);
  store.pool = new backendConFallo.Pool();
  await store.saveNow();

  const guardado = backendConFallo.state.profiles.get('jugador-reintento');
  assert.ok(guardado, 'el perfil se guardó pese al fallo transitorio en el primer intento');
  assert.equal(guardado.data.chips, 3210, 'el saldo guardado es el correcto tras el reintento');
  await store.close();
}

// Fase 11.3: si un guardado falla más allá de los reintentos rápidos (Postgres
// realmente caído por unos segundos más), el cambio no se pierde para
// siempre: se programa un reintento en segundo plano que eventualmente lo
// completa en cuanto la base vuelve a responder.
async function testGuardadoConFalloPersistenteProgramaReintentoEnSegundoPlano() {
  const backend = createFlakyFakePgBackend(0);
  const store = new PgProfileStore('postgres://usuario:clave@fake-host/db', { Pool: backend.Pool });
  await store.ready;

  const profile = store.getOrCreate('jugador-persistente', 'Léo', 'panda');
  profile.chips = 5555;
  store.touch(profile);
  clearTimeout(store.saveTimer); // evita que el debounce normal (180ms) dispare un guardado paralelo al de esta prueba

  // Postgres "sigue caído" indefinidamente durante este guardado.
  const backendCaido = createFlakyFakePgBackend(Infinity);
  store.pool = new backendCaido.Pool();
  await store.saveNow(); // no debe lanzar: los fallos ultimos se registran, no se propagan

  assert.ok(!backendCaido.state.profiles.get('jugador-persistente'), 'el guardado aún no se completó mientras la base seguía caída');
  assert.ok(store._backgroundRetryTimer, 'se programó un reintento en segundo plano en vez de perder el cambio');

  // La base "despierta": simulamos que el siguiente reintento (el que
  // dispararía el temporizador de fondo) ya puede tener éxito.
  backendCaido.stopFailing();
  clearTimeout(store._backgroundRetryTimer);
  await store.saveNow();

  const guardado = backendCaido.state.profiles.get('jugador-persistente');
  assert.ok(guardado, 'el guardado se completó en cuanto la base volvió a responder');
  assert.equal(guardado.data.chips, 5555);
  await store.close();
}

async function main() {
  await withTimeout(testCicloDeVidaCompleto(), 5000, 'ciclo de vida con Postgres simulado');
  await withTimeout(testMigracionDeFormatoLegado(), 5000, 'migración de formato legado');
  await withTimeout(testFactorySinDatabaseUrl(), 5000, 'fábrica sin DATABASE_URL');
  await withTimeout(testFactoryConDatabaseUrlEligePostgres(), 8000, 'fábrica con DATABASE_URL inválida');
  await withTimeout(testBorradoDeCuentaSePropagaAPostgres(), 5000, 'borrado de cuenta inactiva se propaga a Postgres');
  await withTimeout(testReintentaCargaAlArrancarTrasFalloTransitorio(), 8000, 'reintento de carga al arrancar tras fallo transitorio');
  await withTimeout(testFalloPermanenteAlArrancarNoDejaStoreVacioListo(), 8000, 'fallo permanente al arrancar no deja store vacío listo');
  await withTimeout(testGuardadoReintentaTrasFalloTransitorio(), 8000, 'guardado reintenta tras fallo transitorio');
  await withTimeout(testGuardadoConFalloPersistenteProgramaReintentoEnSegundoPlano(), 8000, 'guardado con fallo persistente programa reintento en segundo plano');
  await withTimeout(testContraPostgresReal(), 15000, 'ronda opcional contra Postgres real');
  console.log('✅ profile-store-pg-smoke: alta/edición, ranking, persistencia entre reinicios, temporada, formato legado y selección por DATABASE_URL OK');
}

main().catch(error => {
  console.error('❌ profile-store-pg-smoke falló:', error);
  process.exit(1);
});
