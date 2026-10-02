'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { Pool } = require('pg');
const { normalizeUsername } = require('../lib/profile-store-shared');
const { normalizeRole } = require('../lib/permissions');

function safeSnapshot(profile) {
  return {
    role: normalizeRole(profile.role),
    sessionVersion: Math.max(1, Number(profile.security?.sessionVersion) || 1),
    mfaEnabled: Boolean(profile.security?.mfaEnabled)
  };
}

async function changeRole(client, { username, role, reason = 'bootstrap administrativo', requestId = crypto.randomUUID() }) {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error('Usuario inválido');
  if (!['user', 'moderator', 'admin'].includes(role)) throw new Error('Rol inválido');
  if (String(reason).trim().length < 10 || String(reason).length > 500) throw new Error('El motivo debe tener entre 10 y 500 caracteres');

  await client.query('BEGIN');
  try {
    const result = await client.query(
      `SELECT id, data FROM montecristo_profiles
       WHERE data->>'username' = $1 FOR UPDATE`,
      [normalized]
    );
    if (!result.rows[0]) throw new Error(`No existe la cuenta @${normalized}`);
    const row = result.rows[0];
    const profile = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const before = safeSnapshot(profile);
    if (before.role === role) throw new Error(`La cuenta @${normalized} ya tiene rol ${role}`);

    if (before.role === 'admin' && role !== 'admin') {
      const admins = await client.query(
        `SELECT count(*)::int AS count FROM montecristo_profiles
         WHERE COALESCE(data->>'role', 'user') = 'admin'`
      );
      if (Number(admins.rows[0]?.count) <= 1) throw new Error('No se puede degradar al último administrador');
    }

    profile.role = role;
    profile.security = profile.security && typeof profile.security === 'object' ? profile.security : {};
    profile.security.sessionVersion = before.sessionVersion + 1;
    // Personal nuevo debe enrolar MFA antes de ejercer permisos. Una promoción
    // nunca hereda una bandera MFA inventada o de otro rol.
    if (role === 'moderator' || role === 'admin') profile.security.mfaEnabled = false;
    const after = safeSnapshot(profile);

    await client.query(
      `UPDATE montecristo_profiles SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
      [row.id, JSON.stringify(profile)]
    );
    await client.query(
      `UPDATE montecristo_account_sessions
       SET revoked_at = now(), revoke_reason = 'role_changed'
       WHERE profile_id = $1 AND revoked_at IS NULL`,
      [row.id]
    );
    await client.query(
      `INSERT INTO montecristo_audit_log
       (id, actor_profile_id, actor_role, action, target_type, target_id, request_id, before_data, after_data, reason)
       VALUES ($1, NULL, 'system', 'role.changed.cli', 'profile', $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [crypto.randomUUID(), row.id, requestId, JSON.stringify(before), JSON.stringify(after), String(reason).trim()]
    );
    await client.query('COMMIT');
    return { profileId: row.id, username: normalized, before, after, requestId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(value => /password|contrase/i.test(value))) throw new Error('Nunca pases contraseñas a esta herramienta');
  const [command, username, requestedRole] = args;
  const role = command === 'promote' ? (requestedRole || 'admin') : command === 'demote' ? 'user' : null;
  if (!role || !username) {
    throw new Error('Uso: npm run admin:role -- promote <usuario> [moderator|admin] | demote <usuario>');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL es obligatorio');
  if (process.env.ADMIN_MAINTENANCE_MODE !== 'true') {
    throw new Error('Detén el servicio y define ADMIN_MAINTENANCE_MODE=true para evitar que un snapshot activo revierta el rol');
  }
  const normalized = normalizeUsername(username);
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  const confirmation = await prompt.question(`Escribe @${normalized} para confirmar el cambio a ${role}: `);
  prompt.close();
  if (confirmation.trim() !== `@${normalized}`) throw new Error('Confirmación cancelada');

  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString,
    ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000
  });
  const client = await pool.connect();
  try {
    const result = await changeRole(client, { username: normalized, role, reason: `Cambio por CLI: ${command}` });
    console.log(`Rol actualizado: @${result.username} ${result.before.role} -> ${result.after.role}; sesiones revocadas.`);
    if (role !== 'user') console.log('La cuenta deberá enrolar MFA antes de acceder a administración.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`No se cambió el rol: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { changeRole, safeSnapshot };
