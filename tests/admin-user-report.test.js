'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { JSDOM } = require('jsdom');
const { installAdminRoutes } = require('../lib/admin-auth-http');
const { installReportRoutes } = require('../lib/report-http');
const { MemoryAuditStore } = require('../lib/audit-store');
const { MemoryModerationStore } = require('../lib/moderation-store');
const { MemoryReportStore } = require('../lib/report-store');
const { PgProfileStore } = require('../lib/profile-store-pg');
const { COOKIE_NAME, csrfToken } = require('../lib/account-auth-http');

const PEPPER = crypto.randomBytes(32).toString('base64');
const ORIGIN = 'http://localhost';
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const ADMIN_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');

function makeProfile(id, role, { username = id, mfaEnabled = role !== 'user', status = 'active' } = {}) {
  return {
    id, username, name: id, role,
    security: { sessionVersion: 1, mfaEnabled },
    moderation: { status, until: status === 'suspended' ? Date.now() + 60_000 : null },
    updatedAt: Date.now()
  };
}

function createHarness({ targetStatus = 'active', targetMfaEnabled = false, findEvidence = () => null } = {}) {
  const profiles = new Map([
    ['admin-1', makeProfile('admin-1', 'admin')],
    ['mod-1', makeProfile('mod-1', 'moderator')],
    ['user-1', makeProfile('user-1', 'user')],
    ['guest-1', makeProfile('guest-1', 'user', { username: null })],
    ['target-1', makeProfile('target-1', 'user', { status: targetStatus, mfaEnabled: targetMfaEnabled })]
  ]);
  const tokens = new Map();
  const sessions = new Map();
  for (const profileId of ['admin-1', 'mod-1', 'user-1']) {
    const id = `session-${profileId}`;
    const token = `token-${profileId}`;
    const session = {
      id, profileId, sessionVersion: 1, mfaVerifiedAt: Date.now(),
      absoluteExpiresAt: Date.now() + 60 * 60 * 1000,
      idleExpiresAt: Date.now() + 60 * 60 * 1000
    };
    tokens.set(token, session);
    sessions.set(id, session);
  }

  const revocations = [];
  const sessionStore = {
    async findByToken(token) { return tokens.get(token) || null; },
    async touch() { return true; },
    async revokeProfile(profileId, reason) {
      revocations.push({ profileId, reason });
      for (const session of sessions.values()) {
        if (session.profileId === profileId) session.revokedAt = Date.now();
      }
      return 1;
    }
  };
  const profileStore = {
    profiles,
    touch(profile) { profile.updatedAt = Date.now(); },
    async findByUsername(username) {
      const normalized = String(username || '').trim().replace(/^@/, '').toLowerCase();
      return [...profiles.values()].find(profile => profile.username?.toLowerCase() === normalized) || null;
    }
  };
  const auditStore = new MemoryAuditStore();
  const moderationStore = new MemoryModerationStore();
  const reportStore = new MemoryReportStore();
  const idempotencyEntries = new Map();
  const idempotencyStore = {
    async begin(input) {
      idempotencyEntries.set(`${input.actorId}:${input.key}`, { ...input, state: 'processing' });
      return { state: 'new' };
    },
    async complete(input) {
      idempotencyEntries.set(`${input.actorId}:${input.key}`, { ...input, state: 'completed' });
      return true;
    },
    encodeResponse(body) { return body; }
  };
  const roleChanges = [];
  const moderationChanges = [];
  const evidenceLookups = [];
  const config = {
    enabled: true,
    appOrigin: ORIGIN,
    sessionPepper: PEPPER,
    auditIpPepper: PEPPER,
    reportGuestEnabled: true
  };
  const app = express();
  installAdminRoutes(app, {
    config,
    getProfiles: () => profileStore,
    getSessionStore: () => sessionStore,
    getAuditStore: () => auditStore,
    getModerationStore: () => moderationStore,
    getReportStore: () => reportStore,
    getIdempotencyStore: () => idempotencyStore,
    onModerated: async (target, state) => moderationChanges.push({ id: target.id, state }),
    onRoleChanged: async (target, state) => roleChanges.push({ id: target.id, state })
  });
  installReportRoutes(app, {
    config,
    getProfiles: () => profileStore,
    getSessionStore: () => sessionStore,
    getReportStore: () => reportStore,
    findEvidence: async messageId => {
      evidenceLookups.push(messageId);
      return findEvidence(messageId);
    }
  });
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

  return {
    app, config, profiles, sessionStore, revocations, profileStore, auditStore,
    moderationStore, reportStore, roleChanges, moderationChanges, evidenceLookups,
    tokens
  };
}

async function requestOnce(harness, {
  actor = 'admin-1', method = 'POST', path, body = {}, headers = {}
}) {
  const server = http.createServer(harness.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = [...harness.tokens.entries()].find(([, value]) => value.profileId === actor)?.[1];
  const requestHeaders = { origin: ORIGIN, ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (session) {
    requestHeaders.cookie = `${COOKIE_NAME}=${[...harness.tokens.entries()].find(([, value]) => value === session)[0]}`;
    requestHeaders['x-csrf-token'] = csrfToken(session.id, PEPPER);
  }
  if (method === 'POST' && path.startsWith('/api/admin/')) {
    requestHeaders['idempotency-key'] = crypto.randomUUID();
  }
  let response;
  let json;
  try {
    response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: requestHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    json = await response.json().catch(() => null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  return { status: response.status, json };
}

test('admin promueve a moderador con auditoría, versión de seguridad y revocación de sesiones', async () => {
  const harness = createHarness({ targetMfaEnabled: false });
  const result = await requestOnce(harness, {
    path: '/api/admin/v1/users/target-1/role',
    body: { role: 'moderator', reason: 'Se asigna la cobertura de moderación.' }
  });

  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.target.role, 'moderator');
  assert.equal(result.json.target.mfaRequired, true);
  assert.equal(harness.profiles.get('target-1').security.sessionVersion, 2);
  assert.equal(harness.auditStore.entries[0].action, 'user.role_changed');
  assert.equal(harness.auditStore.entries[0].beforeData.role, 'user');
  assert.equal(harness.auditStore.entries[0].afterData.role, 'moderator');
  assert.deepEqual(harness.revocations, [{ profileId: 'target-1', reason: 'role_changed' }]);
  assert.deepEqual(harness.roleChanges, [{ id: 'target-1', state: { previousRole: 'user', role: 'moderator', mfaRequired: true } }]);

  const demoted = await requestOnce(harness, {
    path: '/api/admin/v1/users/target-1/role',
    body: { role: 'user', reason: 'Se retiran los permisos temporales.' }
  });
  assert.equal(demoted.status, 200, JSON.stringify(demoted.json));
  assert.equal(demoted.json.target.role, 'user');
  assert.equal(harness.profiles.get('target-1').security.sessionVersion, 3);
  assert.equal(harness.auditStore.entries[1].beforeData.role, 'moderator');
  assert.equal(harness.auditStore.entries[1].afterData.role, 'user');
  assert.equal(harness.revocations[1].reason, 'role_changed');
});

test('ROLE_MANAGE sigue siendo exclusivo de admin', async () => {
  const harness = createHarness();
  const result = await requestOnce(harness, {
    actor: 'mod-1',
    path: '/api/admin/v1/users/target-1/role',
    body: { role: 'moderator', reason: 'Se asigna la cobertura de moderación.' }
  });

  assert.equal(result.status, 403);
  assert.equal(result.json.code, 'permission_denied');
  assert.equal(harness.profiles.get('target-1').role, 'user');
  assert.equal(harness.auditStore.entries.length, 0);
});

test('el cambio de rol no acepta conceder admin ni omitir el motivo', async () => {
  const harness = createHarness();
  const invalidRole = await requestOnce(harness, {
    path: '/api/admin/v1/users/target-1/role',
    body: { role: 'admin', reason: 'Cambio de permisos solicitado.' }
  });
  assert.equal(invalidRole.status, 400);
  assert.equal(invalidRole.json.code, 'invalid_role');
  assert.equal(harness.profiles.get('target-1').role, 'user');

  const missingReason = await requestOnce(harness, {
    path: '/api/admin/v1/users/target-1/role',
    body: { role: 'moderator', reason: 'corto' }
  });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.json.code, 'reason_invalid');
  assert.equal(harness.profiles.get('target-1').role, 'user');
});

test('admin desbanea desde la ruta existente y registra la acción', async () => {
  const harness = createHarness({ targetStatus: 'banned' });
  const result = await requestOnce(harness, {
    path: '/api/admin/v1/users/target-1/unban',
    body: { reason: 'La revisión terminó; se retira el bloqueo.' }
  });

  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.target.status, 'active');
  assert.equal(harness.profiles.get('target-1').security.sessionVersion, 2);
  assert.equal(harness.moderationStore.actions[0].type, 'unban');
  assert.equal(harness.auditStore.entries[0].action, 'moderation.unban');
  assert.deepEqual(harness.revocations, [{ profileId: 'target-1', reason: 'moderation_unban' }]);
  assert.equal(harness.moderationChanges.length, 1);
});

test('el moderador no puede desbanear aunque tenga acceso al panel', async () => {
  const harness = createHarness({ targetStatus: 'banned' });
  const result = await requestOnce(harness, {
    actor: 'mod-1',
    path: '/api/admin/v1/users/target-1/unban',
    body: { reason: 'La revisión terminó; se retira el bloqueo.' }
  });

  assert.equal(result.status, 403);
  assert.equal(result.json.code, 'permission_denied');
  assert.equal(harness.profiles.get('target-1').moderation.status, 'banned');
});

test('una suspensión no puede reemplazar silenciosamente un bloqueo permanente', async () => {
  const harness = createHarness({ targetStatus: 'banned' });
  const result = await requestOnce(harness, {
    actor: 'mod-1',
    path: '/api/admin/v1/users/target-1/suspend',
    body: { duration: '1h', reason: 'Se solicita una sanción temporal.' }
  });

  assert.equal(result.status, 400);
  assert.equal(result.json.code, 'target_banned');
  assert.equal(harness.profiles.get('target-1').moderation.status, 'banned');
});

test('reportar mensaje resuelve al autor por playerId del servidor aunque no tenga username', async () => {
  const harness = createHarness({
    findEvidence: messageId => messageId === 'quick-message-1'
      ? { messageId, authorProfileId: 'guest-1', text: '¡Bien jugado!', time: Date.now() }
      : null
  });
  const result = await requestOnce(harness, {
    actor: 'user-1',
    path: '/api/reports',
    body: {
      messageId: 'quick-message-1',
      reportedUsername: 'admin-1', // no se usa para resolver la autoría
      category: 'spam',
      description: 'Este mensaje rápido incumple las reglas del chat.'
    }
  });

  assert.equal(result.status, 201, JSON.stringify(result.json));
  const report = await harness.reportStore.get(result.json.reportId);
  assert.equal(report.reportedProfileId, 'guest-1');
  assert.equal(report.reporterProfileId, 'user-1');
  const evidence = await harness.reportStore.evidenceFor(report.id);
  assert.equal(evidence[0].type, 'chat_message');
  assert.equal(evidence[0].snapshot.authorProfileId, 'guest-1');
  assert.equal(evidence[0].snapshot.text, '¡Bien jugado!');
  assert.deepEqual(harness.evidenceLookups, ['quick-message-1']);
});

test('un invitado puede reportar un mensaje visible de un perfil sin username', async () => {
  const harness = createHarness({
    findEvidence: messageId => messageId === 'lobby-message-1'
      ? { messageId, authorProfileId: 'guest-1', text: 'Mensaje visible del lobby.', time: Date.now() }
      : null
  });
  const result = await requestOnce(harness, {
    actor: null,
    path: '/api/reports',
    headers: { 'x-device-token': crypto.randomUUID() },
    body: {
      messageId: 'lobby-message-1',
      category: 'harassment',
      description: 'Quiero reportar este mensaje del chat del lobby.'
    }
  });

  assert.equal(result.status, 201, JSON.stringify(result.json));
  const report = await harness.reportStore.get(result.json.reportId);
  assert.equal(report.reportedProfileId, 'guest-1');
  assert.equal(report.reporterProfileId, null);
  assert.ok(report.reporterDeviceHash);
});

test('no se crea un reporte si el mensaje no existe en la evidencia del servidor', async () => {
  const harness = createHarness({ findEvidence: () => null });
  const result = await requestOnce(harness, {
    actor: 'user-1',
    path: '/api/reports',
    body: {
      messageId: 'invented-message-id',
      category: 'spam',
      description: 'Este mensaje no se encuentra en el historial.'
    }
  });

  assert.equal(result.status, 400);
  assert.equal(harness.reportStore.reports.size, 0);
});

test('PgProfileStore confirma rol, auditoría, revocación e idempotencia en una sola transacción', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE montecristo_profiles')) return { rowCount: 1 };
      if (sql.includes('UPDATE montecristo_admin_idempotency')) return { rowCount: 1 };
      return { rowCount: 1 };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  const store = Object.create(PgProfileStore.prototype);
  store.pool = { async connect() { return client; } };
  store._dirtyProfiles = new Set(['target-1']);
  const target = makeProfile('target-1', 'moderator', { mfaEnabled: false });
  target.updatedAt = 12345;
  const idempotency = {
    actorId: 'admin-1', key: crypto.randomUUID(),
    encodeResponse: body => body
  };

  const result = await store.applyRoleChangeAtomic({
    profile: target,
    audit: {
      actorProfileId: 'admin-1', actorRole: 'admin', action: 'user.role_changed',
      targetType: 'profile', targetId: 'target-1',
      beforeData: { role: 'user', sessionVersion: 1 },
      afterData: { role: 'moderator', mfaEnabled: false, sessionVersion: 2 },
      reason: 'Se asigna la cobertura de moderación.'
    },
    idempotency,
    revokeReason: 'role_changed'
  });

  const statements = calls.map(call => call.sql.trim().split(/\s+/)[0].toUpperCase());
  assert.deepEqual(statements.slice(0, 5), ['BEGIN', 'UPDATE', 'UPDATE', 'INSERT', 'UPDATE']);
  assert.equal(statements[5], 'COMMIT');
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), false);
  assert.equal(calls[2].params[1], 'role_changed');
  assert.equal(JSON.parse(calls[4].params[2]).target.role, 'moderator');
  assert.equal(result.responseBody.target.mfaRequired, true);
  assert.equal(store._dirtyProfiles.has('target-1'), false);
});

async function openAdminUserDetail(role) {
  const dom = new JSDOM(ADMIN_HTML, {
    url: 'http://localhost/admin',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  const staff = { id: `${role}-1`, username: role, name: role, role };
  const user = { id: 'target-1', username: 'target', name: 'Target', role: 'user', status: 'banned', until: null };
  window.fetch = async url => {
    const requestPath = String(url);
    let payload;
    if (requestPath === '/api/auth/session') {
      payload = { ok: true, csrfToken: 'csrf', auth: { staff: true, mfaEnrollmentRequired: false, mfaVerified: true } };
    } else if (requestPath === '/api/admin/v1/me') {
      payload = { ok: true, staff };
    } else if (requestPath === '/api/admin/v1/reports?status=open') {
      payload = { ok: true, reports: [] };
    } else if (requestPath.startsWith('/api/admin/v1/users?')) {
      payload = { ok: true, users: [user] };
    } else if (requestPath === '/api/admin/v1/users/target-1') {
      payload = { ok: true, user, actions: [] };
    } else {
      payload = { ok: false, error: 'Ruta no simulada.' };
    }
    return { ok: payload.ok, status: payload.ok ? 200 : 404, json: async () => payload };
  };
  window.eval(ADMIN_JS);
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  };
  await flush();
  window.document.getElementById('user-search').value = 'ta';
  window.document.getElementById('user-search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  window.document.querySelector('[data-user="target-1"]').click();
  await flush();
  return dom;
}

test('panel admin muestra desbaneo directo y gestión de rol para una cuenta bloqueada', async t => {
  const dom = await openAdminUserDetail('admin');
  t.after(() => dom.window.close());
  const { document } = dom.window;

  assert.equal(document.getElementById('unban-panel').classList.contains('hidden'), false);
  assert.equal(document.getElementById('role-form').classList.contains('hidden'), false);
  assert.equal(document.getElementById('role-submit').textContent, 'Promover a moderador');
  assert.equal(document.querySelector('#moderation-action option[value="unban"]'), null, 'el desbaneo directo reutiliza la ruta existente');
});

test('panel moderador no muestra desbaneo ni promoción y oculta banear', async t => {
  const dom = await openAdminUserDetail('moderator');
  t.after(() => dom.window.close());
  const { document } = dom.window;

  assert.equal(document.getElementById('unban-panel').classList.contains('hidden'), true);
  assert.equal(document.getElementById('role-form').classList.contains('hidden'), true);
  assert.equal(document.querySelector('#moderation-action option[value="ban"]').hidden, true);
});
