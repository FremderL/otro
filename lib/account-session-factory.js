'use strict';

const { MemorySessionStore } = require('./account-sessions');
const { PgSessionStore } = require('./account-session-store-pg');

function createAccountSessionStore(config, { databaseUrl = process.env.DATABASE_URL, pool } = {}) {
  if (!config?.accountSessionsEnabled) return null;
  if (databaseUrl) return new PgSessionStore(databaseUrl, { pepper: config.sessionPepper, pool });
  // Solo se permite para pruebas explícitas. La validación de configuración
  // impide que producción habilite sesiones sin DATABASE_URL.
  if (process.env.NODE_ENV === 'test') return new MemorySessionStore({ pepper: config.sessionPepper });
  throw new Error('Las sesiones de cuenta requieren PostgreSQL');
}

module.exports = { createAccountSessionStore };
