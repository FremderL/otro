'use strict';

// Reasigna una cuenta (@usuario + contraseña + rol + MFA) a un perfil existente
// sin cuenta, por ejemplo el perfil del dispositivo donde la persona juega.
// No toca fichas, historial ni estadísticas. El perfil de origen queda sin
// usuario ni contraseña, y las sesiones de ambos perfiles se revocan.
//
// Uso:
//   npm run account:relink -- --list
//   npm run account:relink -- --username <usuario> --target <id-perfil>          (vista previa)
//   npm run account:relink -- --username <usuario> --target <id-perfil> --apply  (escribe)
//
// Requisitos para --apply: el servicio detenido, ADMIN_MAINTENANCE_MODE=true y
// escribir @usuario para confirmar. Sin --apply no se escribe nada.

const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { Pool } = require('pg');
const { normalizeUsername } = require('../lib/profile-store-shared');
const { planAccountRelink, applyAccountRelink } = require('../lib/account-relink');

function parseArgs(argv) {
  const options = { list: false, apply: false, username: '', target: '' };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--list') options.list = true;
    else if (value === '--apply') options.apply = true;
    else if (value === '--username') options.username = argv[++i] || '';
    else if (value === '--target') options.target = argv[++i] || '';
    else if (/password|contrase/i.test(value)) throw new Error('Nunca pases contraseñas a esta herramienta');
    else throw new Error(`Argumento desconocido: ${value}`);
  }
  return options;
}

function parseData(row) {
  return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
}

async function listCandidates(pool) {
  const result = await pool.query(
    `SELECT id, data, updated_at FROM montecristo_profiles
     WHERE COALESCE(data->>'username', '') = ''
     ORDER BY COALESCE((data->>'chips')::numeric, 0) DESC
     LIMIT 25`
  );
  console.log('Perfiles sin cuenta (los más ricos primero):');
  for (const row of result.rows) {
    const profile = parseData(row);
    console.log(`  ${row.id}  ${String(profile.name || '').padEnd(20)} fichas=${profile.chips}  actualizado=${new Date(row.updated_at).toISOString()}`);
  }
}

// Carga la cuenta y el destino. En --apply se bloquean las dos filas: nadie
// más puede modificarlas entre la vista previa y la escritura.
async function loadRows(client, { username, target }, { lock }) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const sourceRows = await client.query(
    `SELECT id, data FROM montecristo_profiles WHERE data->>'username' = $1${suffix}`,
    [username]
  );
  if (sourceRows.rows.length > 1) throw new Error(`Hay ${sourceRows.rows.length} perfiles con @${username}; revisa los datos antes de continuar`);
  const targetRows = await client.query(
    `SELECT id, data FROM montecristo_profiles WHERE id = $1${suffix}`,
    [target]
  );
  return { sourceRow: sourceRows.rows[0] || null, targetRow: targetRows.rows[0] || null };
}

function fakeStore(sourceRow, targetRow) {
  const profiles = new Map();
  if (sourceRow) profiles.set(sourceRow.id, parseData(sourceRow));
  if (targetRow) profiles.set(targetRow.id, parseData(targetRow));
  return {
    profiles,
    findByUsername: name => [...profiles.values()].find(profile => profile.username === name) || null
  };
}

function printPlan(plan) {
  const { source, target, username } = plan;
  console.log(`Plan: mover @${username} de ${source.id} (${source.name}, ${source.chips} fichas) a ${target.id} (${target.name}, ${target.chips} fichas).`);
  console.log('Las fichas de cada perfil NO cambian. Solo cambian usuario, contraseña, rol y MFA.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL es obligatorio');
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString,
    ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000
  });
  try {
    if (options.list) return await listCandidates(pool);
    if (!options.username || !options.target) throw new Error('Uso: --username <usuario> --target <id-perfil> [--apply]');
    const username = normalizeUsername(options.username);
    if (!username) throw new Error('Usuario inválido');

    if (!options.apply) {
      const { sourceRow, targetRow } = await loadRows(pool, { username, target: options.target }, { lock: false });
      const plan = planAccountRelink(fakeStore(sourceRow, targetRow), { username, targetId: options.target });
      if (!plan.ok) throw new Error(plan.error);
      printPlan(plan);
      console.log('Vista previa: no se escribió nada. Para aplicar, añade --apply.');
      return;
    }

    if (process.env.ADMIN_MAINTENANCE_MODE !== 'true') {
      throw new Error('Detén el servicio y define ADMIN_MAINTENANCE_MODE=true para evitar que una copia en memoria revierta el cambio');
    }
    const readlinePrompt = readline.createInterface({ input: stdin, output: stdout });
    const confirmation = await readlinePrompt.question(`Escribe @${username} para confirmar la reasignación: `);
    readlinePrompt.close();
    if (confirmation.trim() !== `@${username}`) throw new Error('Confirmación cancelada');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { sourceRow, targetRow } = await loadRows(client, { username, target: options.target }, { lock: true });
      const plan = planAccountRelink(fakeStore(sourceRow, targetRow), { username, targetId: options.target });
      if (!plan.ok) throw new Error(plan.error);
      const before = { source: plan._source.username, target: plan._target.username };
      const applied = applyAccountRelink(plan);
      if (!applied.ok) throw new Error(applied.error);
      const sourceData = JSON.stringify(plan._source);
      const targetData = JSON.stringify(plan._target);
      await client.query('UPDATE montecristo_profiles SET data = $2::jsonb, updated_at = now() WHERE id = $1', [plan._source.id, sourceData]);
      await client.query('UPDATE montecristo_profiles SET data = $2::jsonb, updated_at = now() WHERE id = $1', [plan._target.id, targetData]);
      await client.query(
        `UPDATE montecristo_account_sessions SET revoked_at = now(), revoke_reason = 'account_relinked'
         WHERE profile_id = ANY($1::text[]) AND revoked_at IS NULL`,
        [[plan._source.id, plan._target.id]]
      );
      await client.query(
        `INSERT INTO montecristo_audit_log
         (id, actor_profile_id, actor_role, action, target_type, target_id, request_id, before_data, after_data, reason)
         VALUES ($1, NULL, 'system', 'account.relinked.cli', 'profile', $2, $3, $4::jsonb, $5::jsonb, $6)`,
        [
          crypto.randomUUID(), plan._target.id, crypto.randomUUID(),
          JSON.stringify({ sourceUsername: before.source, targetUsername: before.target }),
          JSON.stringify({ sourceId: plan._source.id, targetId: plan._target.id, username }),
          'Reasignación de cuenta por CLI (perfil congelado)'
        ]
      );
      await client.query('COMMIT');
      printPlan(plan);
      console.log(`Listo: @${username} ahora pertenece a ${plan._target.id}. Sesiones revocadas.`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`No se reasignó la cuenta: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
