'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { changeRole, safeSnapshot } = require('../scripts/admin-role');

class RoleClient {
  constructor(profile, adminCount = 2) { this.profile = profile; this.adminCount = adminCount; this.calls = []; }
  async query(sql, params = []) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql: compact, params });
    if (compact.startsWith('SELECT id, data')) return { rows: this.profile ? [{ id: this.profile.id, data: structuredClone(this.profile) }] : [] };
    if (compact.startsWith('SELECT count')) return { rows: [{ count: this.adminCount }] };
    return { rows: [], rowCount: 1 };
  }
}

function profile(role = 'user') {
  return { id: 'profile-1', username: 'alicia', role, passwordHash: 'no-debe-auditarse', security: { sessionVersion: 3, mfaEnabled: role === 'admin' } };
}

test('promoción incrementa versión, exige MFA nuevo, revoca y audita datos mínimos', async () => {
  const client = new RoleClient(profile('user'));
  const result = await changeRole(client, { username: 'ALICIA', role: 'admin', reason: 'Creación inicial segura' });
  assert.deepEqual(result.before, { role: 'user', sessionVersion: 3, mfaEnabled: false });
  assert.deepEqual(result.after, { role: 'admin', sessionVersion: 4, mfaEnabled: false });
  assert.ok(client.calls.some(call => call.sql.startsWith('UPDATE montecristo_account_sessions')));
  const audit = client.calls.find(call => call.sql.startsWith('INSERT INTO montecristo_audit_log'));
  assert.ok(audit);
  assert.equal(JSON.stringify(audit.params).includes('passwordHash'), false);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('impide degradar al último administrador y revierte transacción', async () => {
  const client = new RoleClient(profile('admin'), 1);
  await assert.rejects(
    changeRole(client, { username: 'alicia', role: 'user', reason: 'Prueba de protección' }),
    /último administrador/
  );
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(client.calls.some(call => call.sql.startsWith('UPDATE montecristo_profiles')), false);
});

test('safeSnapshot nunca incluye secretos', () => {
  assert.deepEqual(safeSnapshot(profile('admin')), { role: 'admin', sessionVersion: 3, mfaEnabled: true });
});
