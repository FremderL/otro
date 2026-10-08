'use strict';

// Fase 10.2: selección de backend de perfiles por variable de entorno.
// - Si existe DATABASE_URL → Postgres (lib/profile-store-pg.js), pensado para
//   el free tier de Neon (sin tarjeta, sin disco).
// - Si no existe → el ProfileStore de archivo JSON de siempre
//   (lib/profile-store.js), exactamente como hasta la Fase 9. Nada cambia en
//   local ni en los tests existentes: ninguno define DATABASE_URL.
//
// Ambos backends exponen la misma interfaz pública (getOrCreate, update, top,
// touch, seasons, ensureSeason, saveNow, filePath), así que server.js no
// necesita saber cuál está activo.

async function createProfileStore(filePath, databaseUrl = process.env.DATABASE_URL, poolOptions = {}) {
  if (databaseUrl) {
    const { PgProfileStore } = require('./profile-store-pg');
    const store = new PgProfileStore(databaseUrl, poolOptions);
    await store.ready;
    return store;
  }
  const { ProfileStore } = require('./profile-store');
  // Fase F (A12): poolOptions también lleva deferSeasonCheck al backend de archivo
  // (el ProfileStore de disco solo lee options.deferSeasonCheck; el resto se ignora).
  return new ProfileStore(filePath, poolOptions);
}

module.exports = { createProfileStore };
