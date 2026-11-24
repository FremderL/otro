'use strict';

// Ejecuta las pruebas que necesitan un PostgreSQL REAL.
//
// Antes `npm run test:postgres` apuntaba a tests/postgres-real.test.js, un
// archivo que no existe: el script fallaba siempre y nadie podía verificar el
// backend de Postgres sin adivinar el comando. Ahora:
//   DATABASE_URL=postgres://... npm run test:postgres
// (o FOOTBALL_TEST_DATABASE_URL, que es lo que leen los tests).
//
// Los tests crean un esquema temporal y lo borran al terminar, así que la base
// puede ser la de desarrollo. No lo ejecutes contra producción.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const url = process.env.FOOTBALL_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error([
    'test:postgres necesita una base PostgreSQL real.',
    '',
    '  DATABASE_URL=postgres://usuario:clave@host:5432/base npm run test:postgres',
    '',
    'Los tests usan esquemas temporales (se crean y se borran), pero apuntan',
    'siempre a una base de desarrollo, nunca a producción.'
  ].join('\n'));
  process.exit(1);
}

const tests = [
  'tests/football-v2-pg-real.test.js',
  'tests/football-store-pg.test.js',
  'tests/club-treasury-pg.test.js'
].map(file => path.join(__dirname, '..', file));

const result = spawnSync(process.execPath, ['--test', ...tests], {
  stdio: 'inherit',
  env: { ...process.env, FOOTBALL_TEST_DATABASE_URL: url }
});
process.exit(Number.isInteger(result.status) ? result.status : 1);
