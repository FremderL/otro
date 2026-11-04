'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSocketIdentityGuard } = require('../lib/socket-identity-guard');
const { MemorySessionStore } = require('../lib/account-sessions');

const pepper = Buffer.alloc(32, 7).toString('base64');

function harness({ link = null } = {}) {
  const profiles = new Map([
    ['account-1', { id: 'account-1', username: 'cuenta', role: 'user', security: { sessionVersion: 1 } }],
    ['guest-1', { id: 'guest-1', username: null }]
  ]);
  const sessions = new MemorySessionStore({ pepper });
  const deviceLinks = { get: async () => link, set: async (_t, profileId, mode) => ({ profileId, mode }) };
  const guard = createSocketIdentityGuard({ enabled: () => true, profiles: { getProfile: id => profiles.get(id) || null }, sessions, deviceLinks, now: () => 500000 });
  const socket = { handshake: { auth: { deviceToken: 'guest-1' } }, data: {}, emit: () => {} };
  return { guard, socket, sessions, profiles };
}

test('un dispositivo vinculado sin sesión no puede apostar ni reclamar bonos', async () => {
  const { guard, socket } = harness({ link: { profileId: 'account-1', mode: 'account' } });
  let ack = null;
  const allowed = await guard.guard(socket, 'football:bet', [{ stake: 100 }, r => { ack = r; }]);
  assert.equal(allowed, false);
  assert.equal(ack.code, 'account_session_required');
  assert.equal(await guard.guard(socket, 'daily_bonus_claim', [{}]), false);
  assert.equal(await guard.guard(socket, 'loteria_join', [{}]), false);
});

test('las lecturas públicas siguen disponibles con sesión caducada', async () => {
  const { guard, socket } = harness({ link: { profileId: 'account-1', mode: 'account' } });
  assert.equal(await guard.guard(socket, 'bet_ranking_get', [{}]), true);
  assert.equal(await guard.guard(socket, 'football:subscribe', [{ scope: 'lobby' }]), true);
});

test('un invitado real conserva acceso económico', async () => {
  const { guard, socket } = harness();
  assert.equal(await guard.guard(socket, 'football:bet', [{ stake: 100 }]), true);
});

test('una sesión válida permite acciones y se renueva con actividad', async () => {
  const { guard, socket, sessions } = harness();
  const issued = await sessions.issue({ profileId: 'account-1', now: 90000 });
  socket.data.accountSessionId = issued.session.id;
  socket.data.accountSessionToken = issued.token;
  socket.data.accountProfileId = 'account-1';
  assert.equal(await guard.guard(socket, 'football:bet', [{ stake: 100 }]), true);
  const record = await sessions.findByToken(issued.token);
  assert.ok(record.idleExpiresAt > issued.session.idleExpiresAt);
});

test('una sesión revocada en caliente bloquea la siguiente acción económica', async () => {
  const { guard, socket, sessions } = harness({ link: { profileId: 'account-1', mode: 'account' } });
  const issued = await sessions.issue({ profileId: 'account-1', now: 90000 });
  socket.data.accountSessionId = issued.session.id;
  socket.data.accountSessionToken = issued.token;
  socket.data.accountProfileId = 'account-1';
  await sessions.revoke(issued.session.id, 'logout');
  let ack = null;
  assert.equal(await guard.guard(socket, 'football:cashout', [{}, r => { ack = r; }]), false);
  assert.equal(ack.code, 'account_session_required');
  assert.equal(socket.data.accountProfileId, null);
});
