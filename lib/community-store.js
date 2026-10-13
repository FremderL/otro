'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool: RealPool } = require('pg');
const { DEFAULT_SEASONAL_THEME, cleanStoredSeasonalTheme } = require('./seasonal-theme');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS montecristo_community_state (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

function emptyCommunityState() {
  return { version: 1, friendships: [], friendRequests: [], clubs: [], seasonalTheme: { ...DEFAULT_SEASONAL_THEME } };
}

function text(value, max = 160) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function cleanMember(value) {
  if (!value || typeof value !== 'object' || !value.profileId) return null;
  const role = value.role === 'owner' ? 'owner' : 'member';
  return {
    profileId: text(String(value.profileId), 80),
    role,
    joinedAt: Number(value.joinedAt) || Date.now()
  };
}

function cleanClub(value) {
  if (!value || typeof value !== 'object' || !value.id || !value.ownerId) return null;
  const members = Array.isArray(value.members)
    ? value.members.slice(0, 30).map(cleanMember).filter(Boolean)
    : [];
  const requests = Array.isArray(value.requests)
    ? value.requests.slice(-500).filter(item => item && item.id && item.profileId).map(item => ({
      id: text(String(item.id), 80), profileId: text(String(item.profileId), 80), createdAt: Number(item.createdAt) || Date.now()
    }))
    : [];
  return {
    id: text(String(value.id), 80),
    name: text(value.name, 24),
    description: text(value.description, 160),
    emblem: text(value.emblem, 8),
    color: text(value.color, 7),
    visibility: value.visibility === 'private' ? 'private' : 'public',
    ownerId: text(String(value.ownerId), 80),
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
    members,
    requests
  };
}

function cleanCommunityState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCommunityState();
  const friendships = Array.isArray(value.friendships)
    ? value.friendships.slice(-100000).filter(item => item && item.id && item.profileA && item.profileB).map(item => ({
      id: text(String(item.id), 80),
      profileA: text(String(item.profileA), 80),
      profileB: text(String(item.profileB), 80),
      createdAt: Number(item.createdAt) || Date.now()
    }))
    : [];
  const friendRequests = Array.isArray(value.friendRequests)
    ? value.friendRequests.slice(-100000).filter(item => item && item.id && item.fromId && item.toId).map(item => ({
      id: text(String(item.id), 80),
      fromId: text(String(item.fromId), 80),
      toId: text(String(item.toId), 80),
      createdAt: Number(item.createdAt) || Date.now()
    }))
    : [];
  const clubs = Array.isArray(value.clubs)
    ? value.clubs.slice(-10000).map(cleanClub).filter(Boolean)
    : [];
  return {
    version: 1,
    friendships,
    friendRequests,
    clubs,
    seasonalTheme: cleanStoredSeasonalTheme(value.seasonalTheme)
  };
}

class FileCommunityStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'community.json')) {
    this.backend = 'file';
    this.filePath = filePath;
    this.state = emptyCommunityState();
    this._writeTail = Promise.resolve();
    this.load();
  }

  load() {
    try {
      this.state = cleanCommunityState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudo cargar el estado de comunidad:', error.message);
    }
  }

  getState() { return this.state; }

  async refresh() { return this.state; }

  transact(mutator) {
    const run = this._writeTail.then(async () => {
      const before = structuredClone(this.state);
      try {
        const result = mutator(this.state);
        if (JSON.stringify(before) !== JSON.stringify(this.state)) await this.saveNow();
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
    this._writeTail = run.catch(() => {});
    return run;
  }

  async saveNow() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cleanCommunityState(this.state), null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  async close() {}
}

class PgCommunityStore {
  constructor(connectionString, { Pool = RealPool } = {}) {
    if (!connectionString) throw new Error('PgCommunityStore requiere DATABASE_URL');
    this.backend = 'postgres';
    this.filePath = 'postgres://community-state';
    this.pool = new Pool({
      connectionString,
      ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 10000
    });
    this.pool.on('error', error => console.warn('Postgres (community store) error:', error.message));
    this.state = emptyCommunityState();
    this._writeTail = Promise.resolve();
    this.ready = this.init();
  }

  async init() {
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(
      'INSERT INTO montecristo_community_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(emptyCommunityState())]
    );
    const result = await this.pool.query('SELECT data FROM montecristo_community_state WHERE id = 1');
    if (result.rows[0]?.data) this.state = cleanCommunityState(result.rows[0].data);
  }

  getState() { return this.state; }

  async refresh() {
    await this.ready;
    await this._writeTail;
    const result = await this.pool.query('SELECT data FROM montecristo_community_state WHERE id = 1');
    if (result.rows[0]?.data) this.state = cleanCommunityState(result.rows[0].data);
    return this.state;
  }

  transact(mutator) {
    const run = this._writeTail.then(async () => {
      await this.ready;
      const client = await this.pool.connect();
      let before = structuredClone(this.state);
      try {
        await client.query('BEGIN');
        const current = await client.query('SELECT data FROM montecristo_community_state WHERE id = 1 FOR UPDATE');
        if (current.rows[0]?.data) this.state = cleanCommunityState(current.rows[0].data);
        before = structuredClone(this.state);
        const result = mutator(this.state);
        if (JSON.stringify(before) !== JSON.stringify(this.state)) {
          await client.query(
            `INSERT INTO montecristo_community_state (id, data, updated_at)
             VALUES (1, $1::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [JSON.stringify(cleanCommunityState(this.state))]
          );
        }
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* rollback best-effort */ }
        this.state = before;
        throw error;
      } finally {
        client.release();
      }
    });
    this._writeTail = run.catch(() => {});
    return run;
  }

  async saveNow() {
    await this.pool.query(
      `INSERT INTO montecristo_community_state (id, data, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(cleanCommunityState(this.state))]
    );
  }

  async close() { await this.pool.end(); }
}

function createCommunityStore(filePath = process.env.COMMUNITY_STORE_PATH, databaseUrl = process.env.DATABASE_URL, options = {}) {
  if (databaseUrl) return new PgCommunityStore(databaseUrl, options);
  return new FileCommunityStore(filePath || path.join(process.cwd(), 'data', 'community.json'));
}

module.exports = {
  FileCommunityStore,
  PgCommunityStore,
  createCommunityStore,
  emptyCommunityState,
  cleanCommunityState
};
