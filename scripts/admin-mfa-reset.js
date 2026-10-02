'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { Pool } = require('pg');
const { normalizeUsername } = require('../lib/profile-store-shared');

async function resetMfa(client, { username, reason = 'Recuperación MFA de emergencia', requestId = crypto.randomUUID() }) {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error('Usuario inválido');
  if (String(reason).trim().length < 10) throw new Error('Motivo inválido');
  await client.query('BEGIN');
  try {
    const result = await client.query("SELECT id, data FROM montecristo_profiles WHERE data->>'username' = $1 FOR UPDATE", [normalized]);
    if (!result.rows[0]) throw new Error(`No existe la cuenta @${normalized}`);
    const row = result.rows[0];
    const profile = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (!['moderator', 'admin'].includes(profile.role)) throw new Error('La cuenta no pertenece al personal');
    profile.security = profile.security || {};
    const before = { role: profile.role, mfaEnabled: Boolean(profile.security.mfaEnabled), sessionVersion: Math.max(1, Number(profile.security.sessionVersion) || 1) };
    profile.security.mfaEnabled = false;
    profile.security.mfaSecretEncrypted = null;
    profile.security.mfaPendingSecretEncrypted = null;
    profile.security.recoveryCodeHashes = [];
    profile.security.mfaEnrolledAt = null;
    profile.security.sessionVersion = before.sessionVersion + 1;
    const after = { role: profile.role, mfaEnabled: false, sessionVersion: profile.security.sessionVersion };
    await client.query('UPDATE montecristo_profiles SET data = $2::jsonb, updated_at = now() WHERE id = $1', [row.id, JSON.stringify(profile)]);
    await client.query("UPDATE montecristo_account_sessions SET revoked_at = now(), revoke_reason = 'mfa_reset' WHERE profile_id = $1 AND revoked_at IS NULL", [row.id]);
    await client.query(
      `INSERT INTO montecristo_audit_log
       (id, actor_profile_id, actor_role, action, target_type, target_id, request_id, before_data, after_data, reason)
       VALUES ($1,NULL,'system','mfa.reset.cli','profile',$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [crypto.randomUUID(), row.id, requestId, JSON.stringify(before), JSON.stringify(after), String(reason).trim()]
    );
    await client.query('COMMIT');
    return { username: normalized, requestId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const username = process.argv[2];
  if (!username) throw new Error('Uso: npm run admin:mfa-reset -- <usuario>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL es obligatorio');
  if (process.env.ADMIN_MAINTENANCE_MODE !== 'true') throw new Error('Detén el servicio y define ADMIN_MAINTENANCE_MODE=true');
  const normalized = normalizeUsername(username);
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  const confirmation = await prompt.question(`Escribe RESET @${normalized} para borrar MFA y revocar sesiones: `);
  prompt.close();
  if (confirmation.trim() !== `RESET @${normalized}`) throw new Error('Confirmación cancelada');
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString, ssl:/sslmode=disable/i.test(connectionString)?false:{rejectUnauthorized:false}, max:1 });
  const client = await pool.connect();
  try { const result = await resetMfa(client, { username:normalized }); console.log(`MFA restablecido para @${result.username}.`); }
  finally { client.release(); await pool.end(); }
}

if (require.main === module) main().catch(error => { console.error(`No se restableció MFA: ${error.message}`); process.exitCode=1; });
module.exports = { resetMfa };
