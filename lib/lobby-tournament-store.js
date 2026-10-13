'use strict';

// Estado durable del calendario y brackets del lobby. En desarrollo usa JSON
// atómico; con DATABASE_URL comparte Postgres con el resto de los perfiles.
const fs = require('node:fs');
const path = require('node:path');
const { Pool: RealPool } = require('pg');

const MAX_EVENTS = 256;
const DEFAULT_STORE_PATH = process.env.LOBBY_TOURNAMENT_STORE_PATH
  || path.join(process.cwd(), 'data', 'lobby-tournaments.json');
const EMPTY_STATE = Object.freeze({ version: 1, timeZone: null, events: [] });
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS montecristo_lobby_tournament_state (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

function cleanLobbyTournamentState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const events = Array.isArray(value.events)
    ? value.events.slice(-MAX_EVENTS).filter(event => event && typeof event === 'object' && !Array.isArray(event)
      && typeof event.id === 'string' && event.id.length <= 120)
      .map(event => JSON.parse(JSON.stringify(event)))
    : [];
  return {
    version: 1,
    timeZone: typeof value.timeZone === 'string' ? value.timeZone.slice(0, 80) : null,
    events
  };
}

class FileLobbyTournamentStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.backend = 'file';
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this._writeTail = Promise.resolve();
    this.ready = Promise.resolve();
    this.load();
  }

  load() {
    try {
      this.state = cleanLobbyTournamentState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudo cargar el estado de torneos del lobby:', error.message);
    }
    return this.state;
  }

  getState() { return this.state; }

  save(snapshot = this.state) {
    const state = cleanLobbyTournamentState(snapshot);
    this.state = state;
    const run = this._writeTail.then(() => this._write(state));
    this._writeTail = run.catch(() => {});
    return run;
  }

  async saveNow(snapshot = this.state) {
    await this._writeTail;
    const state = cleanLobbyTournamentState(snapshot);
    this.state = state;
    await this._write(state);
  }

  async _write(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  async close() { await this.saveNow(); }
}

class PgLobbyTournamentStore {
  constructor(connectionString, { Pool = RealPool } = {}) {
    if (!connectionString) throw new Error('PgLobbyTournamentStore requiere DATABASE_URL');
    this.backend = 'postgres';
    this.filePath = 'postgres://lobby-tournaments';
    this.pool = new Pool({
      connectionString,
      ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: 10000
    });
    this.pool.on('error', error => console.warn('Postgres (lobby tournaments) error:', error.message));
    this.state = structuredClone(EMPTY_STATE);
    this._writeTail = Promise.resolve();
    this.ready = this.init();
  }

  async init() {
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(
      'INSERT INTO montecristo_lobby_tournament_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(EMPTY_STATE)]
    );
    const result = await this.pool.query('SELECT data FROM montecristo_lobby_tournament_state WHERE id = 1');
    if (result.rows[0]?.data) this.state = cleanLobbyTournamentState(result.rows[0].data);
    return this.state;
  }

  getState() { return this.state; }

  save(snapshot = this.state) {
    const state = cleanLobbyTournamentState(snapshot);
    this.state = state;
    const run = this._writeTail.then(async () => {
      await this.ready;
      await this._write(state);
    });
    this._writeTail = run.catch(() => {});
    return run;
  }

  async saveNow(snapshot = this.state) {
    await this.ready;
    await this._writeTail;
    const state = cleanLobbyTournamentState(snapshot);
    this.state = state;
    await this._write(state);
  }

  async _write(state) {
    await this.pool.query(
      `INSERT INTO montecristo_lobby_tournament_state (id, data, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(state)]
    );
  }

  async close() {
    await this.saveNow();
    await this.pool.end();
  }
}

async function createLobbyTournamentStore(filePath = DEFAULT_STORE_PATH, databaseUrl = process.env.DATABASE_URL, options = {}) {
  if (databaseUrl) {
    const store = new PgLobbyTournamentStore(databaseUrl, options);
    await store.ready;
    return store;
  }
  return new FileLobbyTournamentStore(filePath || DEFAULT_STORE_PATH);
}

module.exports = {
  DEFAULT_STORE_PATH,
  EMPTY_STATE,
  cleanLobbyTournamentState,
  FileLobbyTournamentStore,
  PgLobbyTournamentStore,
  createLobbyTournamentStore
};
