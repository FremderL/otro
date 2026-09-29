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
    this.pool = new PoolImpl({ connectionString, ssl: resolveSsl(connectionString), max: 5, ...poolOptions });
    this.pool.on('error', error => console.warn('Postgres (pool) error inesperado:', error.message));
    this._saving = false;
    this._savePending = false;
    // Promesa de arranque: el factory (lib/profile-store-factory.js) espera a
    // que resuelva antes de dejar que el servidor acepte conexiones, así que
    // getOrCreate/update/top nunca se llaman antes de tener los datos cargados.
    this.ready = this._init();
  }

  async _init() {
    await this.pool.query(SCHEMA_SQL);
    await this.load();
    this.ensureSeason();
  }

  async load() {
    try {
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
    } catch (error) {
      console.warn('No se pudieron cargar los perfiles desde Postgres:', error.message);
    }
  }

  async saveNow() {
    // Evita escrituras superpuestas si un guardado tarda más que el siguiente
    // debounce (180 ms); en vez de eso encola una repetición al terminar.
    if (this._saving) {
      this._savePending = true;
      return;
    }
    this._saving = true;
    try {
      const entries = [...this.profiles.values()];
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
        await client.query(
          `INSERT INTO montecristo_seasons (id, data, updated_at) VALUES (1, $1::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [JSON.stringify(this.seasons)]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.warn('No se pudieron guardar los perfiles en Postgres:', error.message);
    } finally {
      this._saving = false;
      if (this._savePending) {
        this._savePending = false;
        this.saveNow();
      }
    }
  }

  // Fase 10.4: usado por el smoke test y por un apagado ordenado si algún día
  // se necesita cerrar el pool explícitamente (SIGTERM ya usa saveNow()).
  async close() {
    clearTimeout(this.saveTimer);
    await this.pool.end().catch(() => {});
  }
}

module.exports = { PgProfileStore, SCHEMA_SQL };
