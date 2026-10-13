'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { csrfToken, COOKIE_NAME } = require('../lib/account-auth-http');
const { MemoryAuditStore } = require('../lib/audit-store');
const { createCommunityStore } = require('../lib/community-store');
const { installSeasonalThemeRoutes } = require('../lib/seasonal-theme-http');
const { DEFAULT_MONTHS } = require('../lib/seasonal-theme');

test('tema público es de solo lectura; escritura estacional requiere MFA, permiso, origen, CSRF e idempotencia', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seasonal-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pepper = Buffer.alloc(32, 77).toString('base64');
  const config = { enabled: true, appOrigin: '', sessionPepper: pepper };
  const admin = { id: 'admin-id', username: 'admin', name: 'Admin', role: 'admin', security: { mfaEnabled: true, sessionVersion: 1 } };
  const moderator = { id: 'mod-id', username: 'moderator', name: 'Moderator', role: 'moderator', security: { mfaEnabled: true, sessionVersion: 1 } };
  const profiles = { profiles: new Map([[admin.id, admin], [moderator.id, moderator]]) };
  const future = Date.now() + 60 * 60 * 1000;
  const sessions = new Map([
    ['admin-token', { id: 'admin-session', profileId: admin.id, sessionVersion: 1, role: 'admin', mfaVerifiedAt: Date.now(), idleExpiresAt: future, absoluteExpiresAt: future }],
    ['moderator-token', { id: 'moderator-session', profileId: moderator.id, sessionVersion: 1, role: 'moderator', mfaVerifiedAt: Date.now(), idleExpiresAt: future, absoluteExpiresAt: future }]
  ]);
  const sessionStore = {
    async findByToken(token) { return sessions.get(token) || null; },
    async touch() { return true; }
  };
  const communityStore = createCommunityStore(path.join(directory, 'community.json'), '');
  const auditStore = new MemoryAuditStore();
  const idempotencyEntries = [];
  const idempotencyStore = {
    async begin(input) { idempotencyEntries.push({ input }); return { state: 'new' }; },
    async complete(input) { idempotencyEntries.at(-1).completed = input; },
    encodeResponse(body) { return body; }
  };
  const emitted = [];
  const app = express();
  app.use(express.json());
  installSeasonalThemeRoutes(app, {
    config,
    getProfiles: () => profiles,
    getSessionStore: () => sessionStore,
    getCommunityStore: () => communityStore,
    getAuditStore: () => auditStore,
    getIdempotencyStore: () => idempotencyStore,
    onChanged: theme => emitted.push(theme)
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.appOrigin = `http://127.0.0.1:${server.address().port}`;
  const base = config.appOrigin;
  async function call(route, { token = null, method = 'GET', body, origin = base, csrf = true, idempotency = false } = {}) {
    const headers = {};
    if (token) headers.cookie = `${COOKIE_NAME}=${token}`;
    if (origin) headers.origin = origin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf && token) {
      const session = sessions.get(token);
      headers['x-csrf-token'] = csrfToken(session.id, pepper);
    }
    if (idempotency) headers['idempotency-key'] = crypto.randomUUID();
    const response = await fetch(`${base}${route}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }

  const publicDefault = await call('/api/seasonal-theme');
  assert.equal(publicDefault.status, 200);
  assert.equal(publicDefault.body.active, false);
  assert.equal((await call('/api/admin/v1/seasonal-theme')).status, 401);
  const moderatorDenied = await call('/api/admin/v1/seasonal-theme', { token: 'moderator-token' });
  assert.equal(moderatorDenied.status, 403);
  assert.equal(moderatorDenied.body.code, 'permission_denied');
  const staffView = await call('/api/admin/v1/seasonal-theme', { token: 'admin-token' });
  assert.equal(staffView.status, 200);
  assert.equal(staffView.body.presets.some(preset => preset.id === 'valentines'), true);
  assert.equal(staffView.body.months.length, 12);
  assert.equal(staffView.body.configuration.months.length, 12);
  assert.equal(staffView.body.configuration.rotation, 'monthly');

  const payload = {
    enabled: true,
    rotation: 'monthly',
    months: DEFAULT_MONTHS.map(item => ({ ...item, presetId: 'halloween', animation: 'embers', intensity: 'festive' })),
    startAt: null,
    endAt: null
  };
  const badOrigin = await call('/api/admin/v1/seasonal-theme', { token: 'admin-token', method: 'PUT', body: payload, origin: 'https://attacker.example', idempotency: true });
  assert.equal(badOrigin.status, 403);
  const missingCsrf = await call('/api/admin/v1/seasonal-theme', { token: 'admin-token', method: 'PUT', body: payload, csrf: false, idempotency: true });
  assert.equal(missingCsrf.status, 403);
  const saved = await call('/api/admin/v1/seasonal-theme', { token: 'admin-token', method: 'PUT', body: payload, idempotency: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.configuration.rotation, 'monthly');
  assert.equal(saved.body.configuration.months.length, 12);
  assert.equal(saved.body.configuration.months[9].presetId, 'halloween');
  assert.equal(saved.body.preview.active, true);
  assert.equal(saved.body.configuration.updatedBy, admin.id);
  assert.equal(auditStore.entries[0].action, 'seasonal_theme.updated');
  assert.equal(auditStore.entries[0].beforeData.seasonalThemeEnabled, false);
  assert.equal(auditStore.entries[0].afterData.seasonalThemeMonthCount, 12);
  assert.match(auditStore.entries[0].afterData.seasonalThemeCalendar, /:halloween:embers:festive:on/);
  assert.equal(idempotencyEntries.filter(entry => entry.completed).length, 1);
  assert.equal(emitted.length, 1);
  const publicUpdated = await call('/api/seasonal-theme');
  assert.equal(publicUpdated.body.theme.id, 'halloween');
  await communityStore.close();
});
