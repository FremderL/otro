'use strict';

// Fase A — Selección de backend del store de fútbol (§13.1).
//
// Espejo exacto de lib/profile-store-factory.js para que server.js no necesite
// saber qué backend está activo:
//   · Sin DATABASE_URL → football-store.js, archivo JSON en FOOTBALL_STORE_PATH
//     (por defecto data/football.json; en Render /var/data/football.json, junto
//     a profiles.json).
//   · Con DATABASE_URL → football-store-pg.js (Neon/Postgres).
//
// Backend Postgres del Estadio: ENTREGADO en la Fase F (lib/football-store-pg.js,
// §13.3). Con DATABASE_URL, createFootballStore devuelve un PgFootballStore y espera
// su `ready` (que crea el esquema inline, rehidrata y asegura la temporada) antes de
// devolverlo. Si por cualquier motivo el módulo no pudiera cargarse, la fábrica falla
// de forma explícita y fail-closed en vez de devolver un store a medias — la misma
// disciplina que el hallazgo 5 de §12.7 exige para todo lo que pueda dejar el proceso
// en un estado inconsistente.

const DEFAULT_STORE_PATH = process.env.FOOTBALL_STORE_PATH || require('path').join(process.cwd(), 'data', 'football.json');

async function createFootballStore(filePath = DEFAULT_STORE_PATH, databaseUrl = process.env.DATABASE_URL, poolOptions = {}) {
  if (databaseUrl) {
    let PgFootballStore;
    try {
      ({ PgFootballStore } = require('./football-store-pg'));
    } catch (error) {
      if (error && error.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'DATABASE_URL está definida pero el backend Postgres del Estadio ' +
          '(lib/football-store-pg.js) se entrega en la Fase F (§21). Hasta entonces ' +
          'despliega las fases A–E con FOOTBALL_ENABLED=off y sin DATABASE_URL de fútbol, ' +
          'o usa el backend de archivo.'
        );
      }
      throw error;
    }
    const store = new PgFootballStore(databaseUrl, poolOptions);
    await store.ready;
    return store;
  }
  const { FootballStore } = require('./football-store');
  return new FootballStore(filePath);
}

module.exports = { createFootballStore, DEFAULT_STORE_PATH };
