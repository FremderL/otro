'use strict';

const { Pool } = require('pg');
const { createSessionRecord, hashSessionToken, sessionPolicy } = require('./account-sessions');

class PgSessionStore {
  constructor(connectionString, { pepper, pool } = {}) {
    if (!connectionString && !pool) throw new Error('PgSessionStore requiere DATABASE_URL');
    if (!pepper) throw new Error('PgSessionStore requiere SESSION_PEPPER');
    this.pepper = pepper;
    this.ownsPool = !pool;
    this.pool = pool || new Pool({
      connectionString,
      ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10000
    });
  }

  async issue(input) {
    const { token, record } = createSessionRecord(input, this.pepper);
    await this.pool.query(
      `INSERT INTO montecristo_account_sessions
       (id, profile_id, token_hash, session_version, role, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, ip_hash, user_agent_hash)
       VALUES ($1, $2, decode($3, 'hex'), $4, $5, to_timestamp($6 / 1000.0),
        to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0), $10, $11)`,
      [record.id, record.profileId, record.tokenHash, record.sessionVersion, record.role,
        record.createdAt, record.lastSeenAt, record.idleExpiresAt, record.absoluteExpiresAt,
        record.ipHash, record.userAgentHash]
    );
    return { token, session: record };
  }

  async findByToken(token) {
    const hash = hashSessionToken(token, this.pepper);
    if (!hash) return null;
    const result = await this.pool.query(
      `SELECT id, profile_id, encode(token_hash, 'hex') AS token_hash, session_version, role,
              extract(epoch FROM created_at) * 1000 AS created_at,
              extract(epoch FROM last_seen_at) * 1000 AS last_seen_at,
              extract(epoch FROM idle_expires_at) * 1000 AS idle_expires_at,
              extract(epoch FROM absolute_expires_at) * 1000 AS absolute_expires_at,
              extract(epoch FROM revoked_at) * 1000 AS revoked_at, revoke_reason,
              extract(epoch FROM mfa_verified_at) * 1000 AS mfa_verified_at, ip_hash, user_agent_hash
       FROM montecristo_account_sessions WHERE token_hash = decode($1, 'hex') LIMIT 1`,
      [hash]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async touch(id, { now = Date.now(), role = 'user' } = {}) {
    const idleExpiresAt = now + sessionPolicy(role).idleMs;
    const result = await this.pool.query(
      `UPDATE montecristo_account_sessions
       SET last_seen_at = to_timestamp($2 / 1000.0),
           idle_expires_at = LEAST(to_timestamp($3 / 1000.0), absolute_expires_at)
       WHERE id = $1 AND revoked_at IS NULL AND last_seen_at <= to_timestamp(($2 - 300000) / 1000.0)`,
      [id, now, idleExpiresAt]
    );
    return result.rowCount > 0;
  }

  async markMfaVerified(id, now = Date.now()) {
    const result = await this.pool.query(
      `UPDATE montecristo_account_sessions SET mfa_verified_at = to_timestamp($2 / 1000.0)
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, now]
    );
    return result.rowCount > 0;
  }

  async revoke(id, reason = 'logout', now = Date.now()) {
    const result = await this.pool.query(
      `UPDATE montecristo_account_sessions SET revoked_at = to_timestamp($3 / 1000.0), revoke_reason = $2
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, String(reason).slice(0, 120), now]
    );
    return result.rowCount > 0;
  }

  async revokeProfile(profileId, reason = 'logout_all', { exceptId = null, now = Date.now() } = {}) {
    const result = await this.pool.query(
      `UPDATE montecristo_account_sessions SET revoked_at = to_timestamp($4 / 1000.0), revoke_reason = $2
       WHERE profile_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [String(profileId), String(reason).slice(0, 120), exceptId, now]
    );
    return result.rowCount;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

function mapRow(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    tokenHash: row.token_hash,
    sessionVersion: Number(row.session_version),
    role: row.role,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    idleExpiresAt: Number(row.idle_expires_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    revokeReason: row.revoke_reason,
    mfaVerifiedAt: row.mfa_verified_at == null ? null : Number(row.mfa_verified_at),
    ipHash: row.ip_hash,
    userAgentHash: row.user_agent_hash
  };
}

module.exports = { PgSessionStore, mapRow };
