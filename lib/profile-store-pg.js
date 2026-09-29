'use strict';

// Fase 10.1: ProfileStore respaldado en Postgres (pensado para el free tier de
// Neon: sin tarjeta, sin disco). Misma interfaz pública que el ProfileStore de
// archivo (lib/profile-store.js): getOrCreate, update, top, touch, seasons,
// ensureSeason, saveNow, filePath. La diferencia es solo de E/S: en vez de leer
// y escribir data/profiles.json, lee y escribe dos tablas en Postgres.
//
// Estrategia deliberadamente simple (igual que el archivo JSON): todo el
// estado vive en memoria (`this.profiles`, `this.seasons`) y `saveNow()`
// vuelca una foto completa a la base, con la misma cadencia (180 ms tras el
// último cambio). Para la escala de un casino social esto es más que
// suficiente y evita reescribir media docena de llamadas en server.js.

const { Pool: RealPool } = require('pg');
const { BaseProfileStore } = require('./profile-store-base');
const { cleanProfile, monthKey } = require('./profile-store-shared');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS montecristo_profiles (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS montecristo_seasons (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

function resolveSsl(connectionString) {
  // Neon (y la mayoría de los Postgres gestionados gratuitos) exigen TLS.
  // `sslmode=disable` explícito en la URL desactiva TLS (útil para Postgres
  // locales de prueba); en cualquier otro caso se exige TLS sin validar la
  // cadena de certificados (igual que recomienda la documentación de Neon
  // para node-postgres).
  if (/sslmode=disable/i.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

function describeConnection(connectionString) {
  try {
    const url = new URL(connectionString);
    const db = url.pathname.replace(/^\//, '') || 'postgres';
    return `postgres://${url.hostname}/${db}`;
  } catch (_) {
    return 'postgres://(url no reconocida)';
  }
}

// Fase 11.3: robustez ante bases "dormidas" (Neon escala a cero tras
// inactividad, igual que puede dormir el propio servicio en Render free).
// Reintenta una operación con una pequeña espera creciente entre intentos,
// en vez de darla por perdida al primer error de conexión.
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function withRetries(fn, { attempts = 3, delaysMs = [1000, 2500], label = 'operación' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delay = delaysMs[attempt - 1] ?? delaysMs[delaysMs.length - 1];
      console.warn(`Postgres: ${label} falló (intento ${attempt}/${attempts}), reintentando en ${delay}ms:`, error.message);
      await wait(delay);
    }
  }
  throw lastError;
}

class PgProfileStore extends BaseProfileStore {
  // `options.Pool` es una costura de prueba: permite inyectar un Postgres
  // simulado en tests/profile-store-pg-smoke.js sin tocar una base real. En
  // producción siempre es el `Pool` real de la librería `pg`.
  constructor(connectionString, options = {}) {
    super();
    if (!connectionString) throw new Error('PgProfileStore requiere una cadena de conexión (DATABASE_URL)');
    this.backend = 'postgres'; // Fase 11.1: usado por server.js para elevar los techos de historial.
    const { Pool: PoolImpl = RealPool, ...poolOptions } = options;
    this.connectionString = connectionString;
    // Mismo nombre de campo que ProfileStore (archivo) para que server.js y los
    // logs de arranque no necesiten distinguir el backend.
    this.filePath = describeConnection(connectionString);
    // Fase 11.3: sin `connectionTimeoutMillis`, node-postgres espera
    // indefinidamente a que abra la conexión. Un techo generoso (10s) tolera
    // que Neon esté "despertando" de escalar a cero sin colgar el proceso si
    // la base de verdad no responde nunca.
    this.pool = new PoolImpl({ connectionString, ssl: resolveSsl(connectionString), max: 5, connectionTimeoutMillis: 10000, ...poolOptions });
    this.pool.on('error', error => console.warn('Postgres (pool) error inesperado:', error.message));
    this._saving = false;
    this._savePending = false;
    this._backgroundRetryTimer = null;
    // Promesa de arranque: el factory (lib/profile-store-factory.js) espera a
    // que resuelva antes de dejar que el servidor acepte conexiones, así que
    // getOrCreate/update/top nunca se llaman antes de tener los datos cargados.
    this.ready = this._init();
  }

  async _init() {
    // Fase 11.3: si Postgres tarda en responder al arrancar (p. ej. Neon
    // despertando de escalar a cero tras la inactividad que también hizo
    // dormir a este mismo servicio), reintentamos un par de veces en vez de
    // arrancar con la memoria vacía. Si aun así falla, dejamos que el error
    // suba (ver profile-store-factory.js -> server.js bootstrap()): es
    // preferible que el proceso falle al arrancar y Render lo reintente a
    // que sirva tráfico con los perfiles "en blanco" y termine sobrescribiendo
    // datos reales la próxima vez que alguien se conecte.
    await withRetries(() => this.pool.query(SCHEMA_SQL), { label: 'crear tablas' });
    await withRetries(() => this._loadOnce(), { label: 'cargar perfiles' });
    this.ensureSeason();
  }

  async _loadOnce() {
    const [profilesResult, seasonsResult] = await Promise.all([
      this.pool.query('SELECT data FROM montecristo_profiles'),
      this.pool.query('SELECT data FROM montecristo_seasons WHERE id = 1')
    ]);
    for (const row of profilesResult.rows) {
      const profile = cleanProfile(row.data);
      if (profile.id) this.profiles.set(profile.id, profile);
    }
    const seasonData = seasonsResult.rows[0]?.data;
    if (seasonData && typeof seasonData === 'object') {
      this.seasons = {
        current: typeof seasonData.current === 'string' ? seasonData.current : monthKey(),
        history: Array.isArray(seasonData.history) ? seasonData.history.slice(-12) : []
      };
    }
  }

  // Mantenido por compatibilidad con la interfaz de BaseProfileStore (y por si
  // algo externo quisiera recargar manualmente); ya no traga errores en
  // silencio, a diferencia de versiones anteriores.
  async load() {
    return this._loadOnce();
  }

  async saveNow() {
    // Evita escrituras superpuestas si un guardado tarda más que el siguiente
    // debounce (180 ms); en vez de eso encola una repetición al terminar.
    if (this._saving) {
      this._savePending = true;
      return;
    }
    this._saving = true;
    clearTimeout(this._backgroundRetryTimer);
    try {
      // Fase 11.3: un par de reintentos rápidos absorben un hipo transitorio
      // (por ejemplo, Neon despertando) sin perder el cambio ni alargar
      // demasiado un apagado limpio (server.js espera este saveNow() con un
      // margen pensado para este mismo número de intentos).
      await withRetries(() => this._writeSnapshot(), { attempts: 3, delaysMs: [700, 2000], label: 'guardar perfiles' });
    } catch (error) {
      console.warn('No se pudieron guardar los perfiles en Postgres tras varios intentos; se reintentará en segundo plano:', error.message);
      // Fase 11.3: no se pierde el cambio para siempre. Mientras el proceso
      // siga vivo, se sigue intentando cada 10s hasta que Postgres responda
      // (por ejemplo, en cuanto Neon termine de despertar).
      this._backgroundRetryTimer = setTimeout(() => { this.saveNow(); }, 10000);
      this._backgroundRetryTimer.unref?.();
    } finally {
      this._saving = false;
      if (this._savePending) {
        this._savePending = false;
        this.saveNow();
      }
    }
  }

  async _writeSnapshot() {
    const entries = [...this.profiles.values()];
    // Fase 11.4: perfiles borrados (cuentas inactivas, panel de administración
    // a futuro, etc.) deben desaparecer también de Postgres; si solo se
    // quitaran de la memoria, sus filas quedarían para siempre en la base.
    const deletions = [...this._pendingDeletes];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (entries.length) {
        const ids = entries.map(profile => profile.id);
        const datas = entries.map(profile => JSON.stringify(profile));
        await client.query(
          `INSERT INTO montecristo_profiles (id, data, updated_at)
           SELECT id, data, now() FROM unnest($1::text[], $2::jsonb[]) AS t(id, data)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [ids, datas]
        );
      }
      if (deletions.length) {
        await client.query('DELETE FROM montecristo_profiles WHERE id = ANY($1::text[])', [deletions]);
      }
      await client.query(
        `INSERT INTO montecristo_seasons (id, data, updated_at) VALUES (1, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(this.seasons)]
      );
      await client.query('COMMIT');
      // Solo se limpian las que quedaron confirmadas en este guardado exitoso;
      // si mientras tanto se marcó alguna más para borrar, sigue pendiente.
      for (const id of deletions) this._pendingDeletes.delete(id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Fase 10.4: usado por el smoke test y por un apagado ordenado si algún día
  // se necesita cerrar el pool explícitamente (SIGTERM ya usa saveNow()).
  async close() {
    clearTimeout(this.saveTimer);
    clearTimeout(this._backgroundRetryTimer);
    await this.pool.end().catch(() => {});
  }
}

module.exports = { PgProfileStore, SCHEMA_SQL };

