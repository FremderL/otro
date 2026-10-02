'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MemorySessionStore, hashSessionToken, sessionState,
  USER_IDLE_MS, STAFF_IDLE_MS, TOUCH_INTERVAL_MS
} = require('../lib/account-sessions');

const pepper = Buffer.alloc(32, 9).toString('base64');

test('emite un token opaco y conserva únicamente su hash', async () => {
  const store = new MemorySessionStore({ pepper });
  const issued = await store.issue({ profileId: 'profile-1', sessionVersion: 2, now: 1000 });
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(issued.session.tokenHash, issued.token);
  assert.equal(issued.session.tokenHash, hashSessionToken(issued.token, pepper));
  assert.equal((await store.findByToken(issued.token)).profileId, 'profile-1');
  assert.equal(await store.findByToken('token-inventado'), null);
});

test('aplica expiración distinta al personal y valida la versión', async () => {
  const store = new MemorySessionStore({ pepper });
  const user = await store.issue({ profileId: 'user', role: 'user', now: 1000 });
  const admin = await store.issue({ profileId: 'admin', role: 'admin', now: 1000 });
  assert.equal(user.session.idleExpiresAt, 1000 + USER_IDLE_MS);
  assert.equal(admin.session.idleExpiresAt, 1000 + STAFF_IDLE_MS);
  assert.equal(sessionState(user.session, { now: 2000, sessionVersion: 1 }).valid, true);
  assert.equal(sessionState(user.session, { now: 2000, sessionVersion: 2 }).reason, 'version_mismatch');
  assert.equal(sessionState(admin.session, { now: 1000 + STAFF_IDLE_MS }).reason, 'idle_expired');
});

test('marca MFA únicamente sobre una sesión activa', async () => {
  const store = new MemorySessionStore({ pepper });
  const issued = await store.issue({ profileId: 'staff', role: 'admin' });
  assert.equal((await store.findByToken(issued.token)).mfaVerifiedAt, null);
  assert.equal(await store.markMfaVerified(issued.session.id, 5000), true);
  assert.equal((await store.findByToken(issued.token)).mfaVerifiedAt, 5000);
});

test('revoca una sesión o todas las sesiones de un perfil', async () => {
  const store = new MemorySessionStore({ pepper });
  const first = await store.issue({ profileId: 'profile-1' });
  const second = await store.issue({ profileId: 'profile-1' });
  const other = await store.issue({ profileId: 'profile-2' });
  assert.equal(await store.revoke(first.session.id, 'logout', 2000), true);
  assert.equal(sessionState(await store.findByToken(first.token), { now: 2001 }).reason, 'revoked');
  assert.equal(await store.revokeProfile('profile-1', 'password_changed', { now: 3000 }), 1);
  assert.equal(sessionState(await store.findByToken(second.token), { now: 3001 }).reason, 'revoked');
  assert.equal(sessionState(await store.findByToken(other.token), { now: 3001 }).valid, true);
});

test('touch limita escrituras y nunca extiende más allá del vencimiento absoluto', async () => {
  const store = new MemorySessionStore({ pepper });
  const issued = await store.issue({ profileId: 'profile-1', now: 1000 });
  assert.equal(await store.touch(issued.session.id, { now: 1000 + TOUCH_INTERVAL_MS - 1 }), false);
  assert.equal(await store.touch(issued.session.id, { now: 1000 + TOUCH_INTERVAL_MS }), true);
  const touched = await store.findByToken(issued.token);
  assert.ok(touched.idleExpiresAt <= touched.absoluteExpiresAt);
});
