'use strict';

// Vínculo durable dispositivo → cuenta. El token de dispositivo es una credencial
// portadora: solo guardamos su SHA-256. No concede acceso a la cuenta; únicamente
// impide que un dispositivo ya vinculado vuelva a apostar como invitado al caducar
// la cookie. `guest` es una elección explícita y autenticada, nunca un fallback.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const SCHEMA = `CREATE TABLE IF NOT EXISTS montecristo_device_links (
  device_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'account' CHECK(mode IN ('account','guest')),
  linked_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS montecristo_device_links_profile ON montecristo_device_links(profile_id);`;

function cleanToken(value) {
  const token = String(value || '').trim();
  return token.length >= 8 && token.length <= 80 ? token : null;
}
function deviceHash(value) {
  const token = cleanToken(value);
  return token ? crypto.createHash('sha256').update(`montecristo-device:${token}`).digest('hex') : null;
}
function cleanLink(raw) {
  if (!raw || typeof raw.profileId !== 'string' || !raw.profileId || raw.profileId.length > 80) return null;
  return { profileId: raw.profileId, mode: raw.mode === 'guest' ? 'guest' : 'account',
    linkedAt: Number(raw.linkedAt) || 0, updatedAt: Number(raw.updatedAt) || 0 };
}

class FileDeviceLinkStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.backend = 'file';
    this.links = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [hash, raw] of Object.entries(data.links || {})) {
        const link = cleanLink(raw);
        if (/^[a-f0-9]{64}$/.test(hash) && link) this.links.set(hash, link);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`No se pudo cargar el vínculo de dispositivos: ${error.message}`);
    }
  }
  async get(token) { const hash = deviceHash(token); return hash ? { ...(this.links.get(hash) || {}) } : null; }
  async set(token, profileId, mode = 'account', now = Date.now()) {
    const hash = deviceHash(token);
    if (!hash || !profileId || !['account', 'guest'].includes(mode)) throw new Error('Vínculo de dispositivo inválido');
    const previous = this.links.get(hash);
    const next = { profileId: String(profileId).slice(0, 80), mode,
      linkedAt: previous?.profileId === profileId ? previous.linkedAt : now, updatedAt: now };
    this.links.set(hash, next);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, links: Object.fromEntries(this.links) }));
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      if (previous) this.links.set(hash, previous); else this.links.delete(hash);
      throw error;
    }
    return { ...next };
  }
  async reassign(sourceId, targetId, now = Date.now()) {
    for (const link of this.links.values()) if (link.profileId === sourceId) { link.profileId = targetId; link.mode = 'account'; link.updatedAt = now; }
  }
  async close() {}
}

class PgDeviceLinkStore {
  constructor(connectionString) {
    this.backend = 'postgres';
    this.pool = new Pool({ connectionString, ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10000 });
    this.ready = this.pool.query(SCHEMA);
  }
  async get(token) {
    await this.ready;
    const hash = deviceHash(token);
    if (!hash) return null;
    const result = await this.pool.query('SELECT profile_id, mode, linked_at, updated_at FROM montecristo_device_links WHERE device_hash=$1', [hash]);
    const row = result.rows[0];
    return row ? cleanLink({ profileId: row.profile_id, mode: row.mode, linkedAt: Number(row.linked_at), updatedAt: Number(row.updated_at) }) : null;
  }
  async set(token, profileId, mode = 'account', now = Date.now()) {
    await this.ready;
    const hash = deviceHash(token);
    if (!hash || !profileId || !['account', 'guest'].includes(mode)) throw new Error('Vínculo de dispositivo inválido');
    const result = await this.pool.query(`INSERT INTO montecristo_device_links(device_hash,profile_id,mode,linked_at,updated_at)
      VALUES($1,$2,$3,$4,$4) ON CONFLICT(device_hash) DO UPDATE SET profile_id=EXCLUDED.profile_id,mode=EXCLUDED.mode,
      linked_at=CASE WHEN montecristo_device_links.profile_id=EXCLUDED.profile_id THEN montecristo_device_links.linked_at ELSE EXCLUDED.linked_at END,
      updated_at=EXCLUDED.updated_at RETURNING profile_id,mode,linked_at,updated_at`, [hash, String(profileId).slice(0, 80), mode, now]);
    const row = result.rows[0];
    return cleanLink({ profileId: row.profile_id, mode: row.mode, linkedAt: Number(row.linked_at), updatedAt: Number(row.updated_at) });
  }
  async reassign(sourceId, targetId, now = Date.now(), client = this.pool) {
    await client.query(`UPDATE montecristo_device_links SET profile_id=$2,mode='account',updated_at=$3 WHERE profile_id=$1`, [sourceId, targetId, now]);
  }
  async close() { await this.pool.end(); }
}

function createDeviceLinkStore({ filePath, databaseUrl }) {
  return databaseUrl ? new PgDeviceLinkStore(databaseUrl) : new FileDeviceLinkStore(filePath);
}

// Política compartida por Casino, Estadio, HTTP y herramientas de recuperación.
function deviceIdentity({ link, accountProfileId, token, accountSessionsEnabled = true }) {
  if (!accountSessionsEnabled) return { mode: 'guest', profileId: String(token || '').slice(0, 80) || null };
  if (accountProfileId) return { mode: 'account', profileId: String(accountProfileId) };
  if (link?.profileId && link.mode !== 'guest') return { mode: 'login_required', profileId: null, linkedProfileId: link.profileId };
  return { mode: 'guest', profileId: String(token || '').slice(0, 80) || null };
}

module.exports = { SCHEMA, deviceHash, cleanToken, deviceIdentity, FileDeviceLinkStore, PgDeviceLinkStore, createDeviceLinkStore };
