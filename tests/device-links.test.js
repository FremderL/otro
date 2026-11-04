'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileDeviceLinkStore, deviceHash, deviceIdentity } = require('../lib/device-links');
const { seatIdentity } = require('../lib/seat-identity');

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-links-')), 'links.json'); }

test('el vínculo persiste entre reinicios y no guarda el token en claro', async () => {
  const file = tmp();
  const store = new FileDeviceLinkStore(file);
  await store.set('device-token-123', 'account-1', 'account', 1000);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('device-token-123'));
  assert.ok(raw.includes(deviceHash('device-token-123')));
  const reopened = new FileDeviceLinkStore(file);
  assert.deepEqual(await reopened.get('device-token-123'), { profileId: 'account-1', mode: 'account', linkedAt: 1000, updatedAt: 1000 });
});

test('un dispositivo vinculado sin sesión exige login; el modo invitado requiere elección explícita', async () => {
  const store = new FileDeviceLinkStore(tmp());
  await store.set('device-token-123', 'account-1', 'account');
  const link = await store.get('device-token-123');
  assert.equal(deviceIdentity({ link, token: 'device-token-123' }).mode, 'login_required');
  assert.equal(seatIdentity({ accountSessionsEnabled: true, token: 'device-token-123', deviceLink: link }), null);
  await store.set('device-token-123', 'account-1', 'guest');
  const guestLink = await store.get('device-token-123');
  assert.equal(deviceIdentity({ link: guestLink, token: 'device-token-123' }).mode, 'guest');
  assert.equal(seatIdentity({ accountSessionsEnabled: true, token: 'device-token-123', deviceLink: guestLink }), 'device-token-123');
});

test('la sesión verificada siempre prevalece sobre el token de dispositivo', () => {
  const link = { profileId: 'account-1', mode: 'account' };
  assert.equal(seatIdentity({ accountSessionsEnabled: true, accountProfileId: 'account-1', token: 'device-token-123', deviceLink: link }), 'account-1');
  assert.equal(deviceIdentity({ link, accountProfileId: 'account-1', token: 'device-token-123' }).mode, 'account');
});

test('reassign mueve los vínculos del perfil invitado a la cuenta', async () => {
  const store = new FileDeviceLinkStore(tmp());
  await store.set('device-token-123', 'guest-1', 'account');
  await store.reassign('guest-1', 'account-1', 2000);
  assert.equal((await store.get('device-token-123')).profileId, 'account-1');
});
