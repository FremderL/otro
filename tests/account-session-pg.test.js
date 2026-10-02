'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PgSessionStore, mapRow } = require('../lib/account-session-store-pg');
const { hashSessionToken } = require('../lib/account-sessions');

const pepper = Buffer.alloc(32, 4).toString('base64');

class FakePool {
  constructor() { this.calls = []; this.responses = []; this.ended = false; }
  queue(response) { this.responses.push(response); }
  async query(sql, params) {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return this.responses.shift() || { rows: [], rowCount: 0 };
  }
  async end() { this.ended = true; }
}

test('Postgres inserta solo el hash y metadatos de sesión', async () => {
  const pool = new FakePool();
  pool.queue({ rows: [], rowCount: 1 });
  const store = new PgSessionStore(null, { pepper, pool });
  const issued = await store.issue({ profileId: 'profile-1', sessionVersion: 3, role: 'admin', now: 1000 });
  const call = pool.calls[0];
  assert.match(call.sql, /^INSERT INTO montecristo_account_sessions/);
  assert.equal(call.params[1], 'profile-1');
  assert.equal(call.params[2], hashSessionToken(issued.token, pepper));
  assert.equal(call.params.includes(issued.token), false);
  assert.equal(call.params[3], 3);
  assert.equal(call.params[4], 'admin');
});

test('Postgres consulta por hash y mapea timestamps', async () => {
  const pool = new FakePool();
  pool.queue({ rows: [{
    id: '00000000-0000-4000-8000-000000000001', profile_id: 'p1', token_hash: 'abcd',
    session_version: '2', role: 'user', created_at: '1000', last_seen_at: '2000',
    idle_expires_at: '3000', absolute_expires_at: '4000', revoked_at: null,
    revoke_reason: null, ip_hash: null, user_agent_hash: null
  }] });
  const store = new PgSessionStore(null, { pepper, pool });
  const session = await store.findByToken('token-secreto');
  assert.equal(pool.calls[0].params[0], hashSessionToken('token-secreto', pepper));
  assert.equal(session.profileId, 'p1');
  assert.equal(session.sessionVersion, 2);
  assert.equal(session.absoluteExpiresAt, 4000);
  assert.equal(session.revokedAt, null);
});

test('touch y revocaciones son parametrizadas y reportan filas afectadas', async () => {
  const pool = new FakePool();
  pool.queue({ rowCount: 1 }); pool.queue({ rowCount: 1 }); pool.queue({ rowCount: 2 });
  const store = new PgSessionStore(null, { pepper, pool });
  assert.equal(await store.touch('session-id', { now: 500000, role: 'user' }), true);
  assert.equal(await store.revoke('session-id', 'logout', 600000), true);
  assert.equal(await store.revokeProfile('profile-id', 'logout_all', { now: 700000 }), 2);
  assert.deepEqual(pool.calls[0].params, ['session-id', 500000n, 605300000n]);
  assert.deepEqual(pool.calls[1].params, ['session-id', 'logout', 600000]);
  assert.deepEqual(pool.calls[2].params, ['profile-id', 'logout_all', null, 700000]);
});

test('mapRow conserva una revocación existente', () => {
  const mapped = mapRow({
    id: 'id', profile_id: 'p', token_hash: 'h', session_version: 1, role: 'user',
    created_at: 1, last_seen_at: 2, idle_expires_at: 3, absolute_expires_at: 4,
    revoked_at: 5, revoke_reason: 'password_changed', ip_hash: 'i', user_agent_hash: 'u'
  });
  assert.equal(mapped.revokedAt, 5);
  assert.equal(mapped.revokeReason, 'password_changed');
});
