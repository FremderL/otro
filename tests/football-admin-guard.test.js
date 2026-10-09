'use strict';

// Fase E4b — Guardia de administración de las palancas del Estadio (/admin/estadio/*).
//
// Valida la cadena completa que server.js inyecta (makeAdminGuard().fullGuard):
// sesión staff válida → permiso football:manage (solo admin) → MFA reciente →
// escritura de confianza (origen + CSRF), más el fail-closed del gate de http.js
// cuando ADMIN_FEATURE_ENABLED está apagado. Se usa un app Express mínimo con
// stores simulados: en local no se puede encender admin completo (loadAdminConfig
// exige DATABASE_URL, HTTPS, MFA_ENCRYPTION_KEY y AUDIT_IP_PEPPER), así que esta es
// la vía para probar la guardia de punta a punta.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { installFootballAdminRoutes } = require('../lib/football/http');
const { makeAdminGuard } = require('../lib/admin-auth-http');
const { csrfToken, COOKIE_NAME } = require('../lib/account-auth-http');
const { PERMISSIONS } = require('../lib/permissions');

const PEPPER = crypto.randomBytes(32).toString('base64');
const ORIGIN = 'http://localhost';
const NOW = Date.now();

function makeProfile(id, role) {
  return { id, username: 'u-' + id, role, security: { mfaEnabled: true, sessionVersion: 1 } };
}
function makeSession(profileId, { mfaVerifiedAt = NOW, id = 'sess-' + profileId } = {}) {
  return {
    id, profileId, mfaVerifiedAt, sessionVersion: 1,
    absoluteExpiresAt: NOW + 3600_000, idleExpiresAt: NOW + 3600_000
  };
}

// Construye un app con la guardia y las palancas, hace UNA petición y lo apaga.
async function runOnce({
  adminEnabled = true,
  role = null,            // null => sin cookie (anónimo)
  mfaVerifiedAt = NOW,
  sendCsrf = true,
  origin = ORIGIN,
  path = '/admin/estadio/matches/m1/suspend',
  body = { untilMs: NOW + 60_000 }
} = {}) {
  const profiles = new Map([
    ['admin1', makeProfile('admin1', 'admin')],
    ['mod1', makeProfile('mod1', 'moderator')],
    ['user1', makeProfile('user1', 'user')]
  ]);
  const session = role ? makeSession(role === 'admin' ? 'admin1' : role === 'moderator' ? 'mod1' : 'user1', { mfaVerifiedAt }) : null;
  const TOKEN = 'tok-' + (role || 'anon');
  const config = { enabled: adminEnabled, appOrigin: ORIGIN, sessionPepper: PEPPER };

  const spies = { suspend: 0, closeMarket: 0, forceFinish: 0, quarantine: 0 };
  const deps = {
    adminConfig: config,
    guard: makeAdminGuard({
      config,
      getProfiles: () => ({ profiles }),
      getSessionStore: () => ({
        findByToken: async (t) => (t === TOKEN ? session : null),
        touch: async () => {}
      })
    }).fullGuard(PERMISSIONS.FOOTBALL_MANAGE),
    store: { getMatch: (id) => (id === 'm1' ? { id: 'm1', status: 'live' } : null) },
    betting: { suspend: () => { spies.suspend++; }, closeMarket: () => { spies.closeMarket++; } },
    engine: { forceFinish: () => { spies.forceFinish++; }, quarantine: () => { spies.quarantine++; } },
    audit: () => {}, log: () => {}, now: () => NOW
  };

  const app = express();
  app.use('/admin/estadio', express.json({ limit: '16kb', strict: true }));
  installFootballAdminRoutes(app, deps);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (role) headers.cookie = `${COOKIE_NAME}=${TOKEN}`;
  if (sendCsrf && session) headers['x-csrf-token'] = csrfToken(session.id, PEPPER);

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  await new Promise(resolve => server.close(resolve));
  return { status: res.status, json, spies };
}

test('ADMIN_FEATURE_ENABLED apagado: 404 fail-closed (sin revelar existencia)', async () => {
  const r = await runOnce({ adminEnabled: false, role: 'admin' });
  assert.equal(r.status, 404);
  assert.equal(r.spies.suspend, 0, 'la palanca no se ejecutó');
});

test('sin sesión: 401 session_required', async () => {
  const r = await runOnce({ role: null });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'session_required');
});

test('rol user (no staff): 403 staff_required', async () => {
  const r = await runOnce({ role: 'user' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'staff_required');
});

test('moderator sin football:manage: 403 permission_denied', async () => {
  const r = await runOnce({ role: 'moderator' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'permission_denied');
  assert.equal(r.spies.suspend, 0, 'el moderador no toca el motor');
});

test('admin con MFA vencido: 403 recent_auth_required', async () => {
  const r = await runOnce({ role: 'admin', mfaVerifiedAt: NOW - 11 * 60_000 });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'recent_auth_required');
});

test('admin con CSRF incorrecto: 403 csrf_denied', async () => {
  const r = await runOnce({ role: 'admin', sendCsrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'csrf_denied');
});

test('admin con origen distinto: 403 origin_denied', async () => {
  const r = await runOnce({ role: 'admin', origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'origin_denied');
});

test('admin válido (sesión+permiso+MFA reciente+CSRF+origen): 200 y la palanca corre', async () => {
  const r = await runOnce({ role: 'admin' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.ok(r.spies.suspend >= 1, 'suspend ejecutado');
});

// --- Regresión del refactor (E4b): installAdminRoutes ahora consume makeAdminGuard.
// El panel del casino debe comportarse exactamente igual que antes del cambio. ---
const { installAdminRoutes } = require('../lib/admin-auth-http');

async function runCasino({ adminEnabled = true, role = 'admin' } = {}) {
  const profiles = new Map([['admin1', makeProfile('admin1', 'admin')]]);
  const session = makeSession('admin1');
  const TOKEN = 'tok-casino';
  const config = { enabled: adminEnabled, appOrigin: ORIGIN, sessionPepper: PEPPER };
  const app = express();
  app.use('/api/admin', express.json({ limit: '16kb', strict: true }));
  installAdminRoutes(app, {
    config,
    getProfiles: () => ({ profiles }),
    getSessionStore: () => ({ findByToken: async (t) => (t === TOKEN ? session : null), touch: async () => {} })
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const get = async (p, withCookie) => {
    const headers = {};
    if (withCookie) headers.cookie = `${COOKIE_NAME}=${TOKEN}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    await res.json().catch(() => null);
    return res.status;
  };
  const out = {
    adminPageOff: null, adminPageOn: null, meNoSession: null, meWithSession: null
  };
  if (!adminEnabled) out.adminPageOff = await get('/admin', false);
  else {
    out.adminPageOn = await get('/admin', false);
    out.meNoSession = await get('/api/admin/v1/me', false);
    out.meWithSession = await get('/api/admin/v1/me', true);
  }
  await new Promise(resolve => server.close(resolve));
  return out;
}

test('refactor: /admin del casino sigue 404 con admin apagado', async () => {
  const r = await runCasino({ adminEnabled: false });
  assert.equal(r.adminPageOff, 404);
});

test('refactor: /api/admin/v1/me exige sesión y responde con sesión válida', async () => {
  const r = await runCasino({ adminEnabled: true });
  assert.equal(r.adminPageOn, 200, 'la página del panel se sirve');
  assert.equal(r.meNoSession, 401, 'resolveAdmin (de la fábrica) rechaza sin sesión');
  assert.equal(r.meWithSession, 200, 'resolveAdmin (de la fábrica) acepta sesión admin');
});

test('el cuerpo JSON llega parseado a la palanca (parser montado)', async () => {
  // untilMs viaja en el body; si el parser no estuviera montado, http.js usaría su
  // valor por defecto (now+15min) en vez del enviado. Lo comprobamos con el eco.
  const until = NOW + 123_000;
  const r = await runOnce({ role: 'admin', body: { untilMs: until, market: '1x2' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.untilMs, until, 'el untilMs del body llegó al handler');
  assert.equal(r.json.suspended, 1, 'solo el mercado pedido (body.market respetado)');
});
