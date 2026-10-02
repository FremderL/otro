'use strict';

const { MemoryAuditStore } = require('./audit-store');
const { PgAuditStore } = require('./audit-store-pg');

function createAuditStore(config, { databaseUrl = process.env.DATABASE_URL, pool } = {}) {
  if (!config?.enabled) return null;
  if (databaseUrl) return new PgAuditStore(databaseUrl, { pool });
  if (process.env.NODE_ENV === 'test') return new MemoryAuditStore();
  throw new Error('La auditoría administrativa requiere PostgreSQL');
}

module.exports = { createAuditStore };
