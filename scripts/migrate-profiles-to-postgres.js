#!/usr/bin/env node
'use strict';

// Fase 10.3: migración única de data/profiles.json (o cualquier archivo con el
// mismo formato) hacia Postgres. Pensado para usarse UNA vez al pasar de disco
// efímero a Neon: lee el archivo, lo vuelca a la base con la misma limpieza de
// datos que usa el ProfileStore (cleanProfile), y respeta lo que ya hubiera en
// la base si no está vacía.
//
// Uso:
//   DATABASE_URL="postgres://..." node scripts/migrate-profiles-to-postgres.js
//   DATABASE_URL="postgres://..." node scripts/migrate-profiles-to-postgres.js data/profiles.json
//   DATABASE_URL="postgres://..." node scripts/migrate-profiles-to-postgres.js --dry-run
//
// También disponible como `npm run migrate:profiles -- --dry-run`.

const fs = require('fs');
const path = require('path');
const { cleanProfile, monthKey } = require('../lib/profile-store-shared');
const { PgProfileStore } = require('../lib/profile-store-pg');

function parseArgs(argv) {
  const args = { dryRun: false, file: path.join(process.cwd(), 'data', 'profiles.json') };
  for (const raw of argv) {
    if (raw === '--dry-run' || raw === '-n') args.dryRun = true;
    else if (!raw.startsWith('-')) args.file = path.resolve(raw);
  }
  return args;
}

function loadJsonFile(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(data) ? data : Array.isArray(data.profiles) ? data.profiles : [];
  const seasons = !Array.isArray(data) && data.seasons && typeof data.seasons === 'object'
    ? {
        current: typeof data.seasons.current === 'string' ? data.seasons.current : monthKey(),
        history: Array.isArray(data.seasons.history) ? data.seasons.history.slice(-12) : []
      }
    : null;
  return { list, seasons };
}

function maskUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    return `postgres://${url.hostname}${url.pathname}`;
  } catch (_) {
    return '(URL no reconocida)';
  }
}

async function main() {
  const { dryRun, file } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('❌ Falta DATABASE_URL. Define la variable con la cadena de conexión de Neon antes de migrar.');
    console.error('   Ejemplo: DATABASE_URL="postgres://usuario:clave@host/db?sslmode=require" node scripts/migrate-profiles-to-postgres.js');
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error(`❌ No se encontró el archivo a migrar: ${file}`);
    process.exit(1);
  }

  console.log(`📂 Leyendo ${file}…`);
  const { list, seasons } = loadJsonFile(file);
  const profiles = list.map(cleanProfile).filter(profile => profile.id);
  console.log(`   ${profiles.length} perfil(es) encontrados en el archivo.`);

  console.log(`🔌 Conectando a Postgres (${maskUrl(databaseUrl)})…`);
  const store = new PgProfileStore(databaseUrl);
  await store.ready;
  const existingCount = store.profiles.size;
  console.log(`   La base ya tiene ${existingCount} perfil(es) cargados.`);

  let imported = 0;
  let updated = 0;
  for (const profile of profiles) {
    if (store.profiles.has(profile.id)) updated += 1; else imported += 1;
    store.profiles.set(profile.id, profile);
  }

  // Solo adoptamos las temporadas del archivo si la base todavía no tenía
  // historial propio (para no pisar un cierre de temporada que ya hubiera
  // ocurrido en Postgres). Si la base ya tenía historial, se conserva el de
  // la base y se avisa.
  let seasonsAdopted = false;
  if (seasons && store.seasons.history.length === 0) {
    store.seasons = seasons;
    seasonsAdopted = true;
  }

  console.log('');
  console.log('Resumen de la migración' + (dryRun ? ' (dry-run, no se escribió nada):' : ':'));
  console.log(`  · Perfiles nuevos a insertar: ${imported}`);
  console.log(`  · Perfiles existentes a actualizar: ${updated}`);
  console.log(`  · Total de perfiles tras la migración: ${store.profiles.size}`);
  console.log(`  · Temporada adoptada del archivo: ${seasonsAdopted ? 'sí' : 'no (la base ya tenía historial propio)'}`);

  if (dryRun) {
    console.log('\n✅ Dry-run terminado. Vuelve a correr sin --dry-run para escribir en Postgres.');
    await store.close();
    return;
  }

  console.log('\n💾 Guardando en Postgres…');
  await store.saveNow();
  await store.close();
  console.log('✅ Migración completa.');
}

main().catch(error => {
  console.error('❌ La migración falló:', error.message);
  process.exit(1);
});
