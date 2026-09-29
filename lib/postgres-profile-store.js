'use strict';

const { Pool } = require('pg');
const { INITIAL_CHIPS, AVATARS, AVATAR_IDS, cleanProfile } = require('./profile-store');

// Adaptador deliberadamente pequeño: conserva una copia en memoria para que la
// interfaz existente siga siendo síncrona y persiste los cambios en segundo plano.
class PostgresProfileStore {
  constructor(databaseUrl = process.env.DATABASE_URL) {
    this.profiles = new Map();
    this.saveTimer = null;
    this.pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } });
    this.ready = this.load();
  }

  async load() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS montecristo_profiles (
      id TEXT PRIMARY KEY,
      profile JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const { rows } = await this.pool.query('SELECT profile FROM montecristo_profiles');
    for (const row of rows) {
      const profile = cleanProfile(row.profile);
      if (profile.id) this.profiles.set(profile.id, profile);
    }
  }

  getOrCreate(id, name, avatar) {
    id = String(id || '').slice(0, 80);
    let profile = this.profiles.get(id);
    if (!profile) {
      profile = cleanProfile({ id, name, avatar, chips: INITIAL_CHIPS });
      this.profiles.set(id, profile);
    } else {
      if (name) profile.name = String(name).replace(/[<>]/g, '').trim().slice(0, 18) || profile.name;
      if (AVATAR_IDS.has(avatar)) profile.avatar = avatar;
    }
    this.touch(profile);
    return profile;
  }

  update(profile, changes = {}) {
    if (changes.name) profile.name = String(changes.name).replace(/[<>]/g, '').trim().slice(0, 18) || profile.name;
    if (AVATAR_IDS.has(changes.avatar)) profile.avatar = changes.avatar;
    this.touch(profile);
    return profile;
  }

  touch(profile) {
    profile.updatedAt = Date.now();
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 180);
    this.saveTimer.unref?.();
  }

  async saveNow() {
    for (const profile of this.profiles.values()) {
      await this.pool.query(`INSERT INTO montecristo_profiles (id, profile, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()`,
      [profile.id, JSON.stringify(profile)]);
    }
  }

  top(limit = 10) {
    return [...this.profiles.values()].sort((a, b) => b.chips - a.chips).slice(0, limit);
  }

  temporadas(limit = 10) {
    return this.top(limit);
  }

  reinicioMensual() {
    for (const profile of this.profiles.values()) {
      profile.stats.currentStreak = 0;
      this.touch(profile);
    }
    return this.profiles.size;
  }

  async close() {
    await this.saveNow();
    await this.pool.end();
  }
}

module.exports = { PostgresProfileStore };
