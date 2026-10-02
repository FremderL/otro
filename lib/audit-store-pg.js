'use strict';

const { Pool } = require('pg');
const { createAuditEntry } = require('./audit-store');

class PgAuditStore {
  constructor(connectionString, { pool } = {}) {
    if (!connectionString && !pool) throw new Error('PgAuditStore requiere DATABASE_URL');
    this.ownsPool = !pool;
    this.pool = pool || new Pool({
      connectionString,
      ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 10000
    });
  }
  async append(input) {
    const entry = createAuditEntry(input);
    await this.pool.query(
      `INSERT INTO montecristo_audit_log
       (id, actor_profile_id, actor_role, action, target_type, target_id, request_id,
        ip_hash, before_data, after_data, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,to_timestamp($12 / 1000.0))`,
      [entry.id, entry.actorProfileId, entry.actorRole, entry.action, entry.targetType,
        entry.targetId, entry.requestId, entry.ipHash, JSON.stringify(entry.beforeData),
        JSON.stringify(entry.afterData), entry.reason, entry.createdAt]
    );
    return entry;
  }
  async close() { if (this.ownsPool) await this.pool.end(); }
}

module.exports = { PgAuditStore };
