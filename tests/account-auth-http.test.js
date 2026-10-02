'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../lib/profile-store');
const { MemorySessionStore } = require('../lib/account-sessions');
const { installAccountAuthRoutes } = require('../lib/account-auth-http');
const { createTotp } = require('../lib/mfa');
const { MemoryAuditStore } = require('../lib/audit-store');

const pepper = Buffer.alloc(32, 5).toString('base64');

async function fixture(t, { role = 'user' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'montecristo-auth-'));
  const profiles = new ProfileStore(path.join(directory, 'profiles.json'));
  const profile = profiles.getOrCreate('profile-1', 'Alicia');
  profiles.registerAccount(profile, 'alicia', 'segura-123');
  profile.role = role;
  const sessions = new MemorySessionStore({ pepper });
  const audit = new MemoryAuditStore();
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  const origin = await new Promise((resolve, reject) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.once('error', reject);
  });
  // Las opciones se inyectan directamente para probar HTTP local. La carga de
  // configuración de producción exige HTTPS y se prueba por separado.
  installAccountAuthRoutes(app, {
    config: { enabled: true, accountSessionsEnabled: true, appOrigin: origin, sessionPepper: pepper, mfaEncryptionKey: pepper },
    getProfiles: () => profiles,
    getSessionStore: () => sessions,
    getAuditStore: () => audit
  });
  t.after(() => {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { origin, sessions, profiles, profile, audit };
}

test('login de personal exitoso y fallido queda auditado sin contraseña',async t=>{const f=await fixture(t,{role:'admin'});let response=await fetch(`${f.origin}/api/auth/login`,{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:JSON.stringify({username:'alicia',password:'incorrecta'})});assert.equal(response.status,401);response=await fetch(`${f.origin}/api/auth/login`,{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:JSON.stringify({username:'alicia',password:'segura-123'})});assert.equal(response.status,200);assert.deepEqual(f.audit.entries.map(e=>e.action),['admin.login_failed','admin.login_succeeded']);assert.equal(JSON.stringify(f.audit.entries).includes('segura-123'),false);});

test('login emite cookie HttpOnly y la sesión autentica sin exponer token en JSON', async t => {
  const { origin } = await fixture(t);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alicia', password: 'segura-123' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^mc_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  const body = await login.json();
  assert.equal(body.ok, true);
  assert.equal(JSON.stringify(body).includes('mc_session'), false);
  assert.equal(JSON.stringify(body).includes('passwordHash'), false);

  const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).profile.username, 'alicia');
});

test('un cambio de sessionVersion invalida inmediatamente la cookie', async t => {
  const { origin, profile } = await fixture(t);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alicia', password: 'segura-123' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  profile.security.sessionVersion += 1;
  const stale = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
  assert.equal(stale.status, 401);
});

test('cambiar contraseña rota la cookie e invalida contraseña y sesiones anteriores', async t => {
  const { origin, profile } = await fixture(t);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alicia', password: 'segura-123' })
  });
  const oldCookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  const changed = await fetch(`${origin}/api/auth/change-password`, {
    method: 'POST', headers: { origin, cookie: oldCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ currentPassword: 'segura-123', newPassword: 'mucho-mas-segura-456' })
  });
  assert.equal(changed.status, 200);
  const newCookie = changed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(newCookie, oldCookie);
  assert.equal(profile.security.sessionVersion, 2);
  assert.ok(profile.security.passwordChangedAt);
  assert.equal((await fetch(`${origin}/api/auth/session`, { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await fetch(`${origin}/api/auth/session`, { headers: { cookie: newCookie } })).status, 200);

  const oldPassword = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alicia', password: 'segura-123' })
  });
  assert.equal(oldPassword.status, 401);
});

test('personal debe enrolar y verificar MFA antes de elevar su sesión', async t => {
  const { origin, profile } = await fixture(t, { role: 'admin' });
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alicia', password: 'segura-123' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const loginBody = await login.json();
  assert.equal(loginBody.auth.mfaRequired, true);
  assert.equal(loginBody.auth.mfaEnrollmentRequired, true);

  const start = await fetch(`${origin}/api/auth/mfa/enroll/start`, {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrfToken },
    body: JSON.stringify({ currentPassword: 'segura-123' })
  });
  assert.equal(start.status, 200);
  const setup = await start.json();
  const token = createTotp({ username: '@alicia', secret: setup.manualKey }).generate();
  const confirm = await fetch(`${origin}/api/auth/mfa/enroll/confirm`, {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrfToken },
    body: JSON.stringify({ token })
  });
  assert.equal(confirm.status, 200);
  const confirmed = await confirm.json();
  assert.equal(confirmed.recoveryCodes.length, 10);
  assert.equal(profile.security.mfaEnabled, true);
  assert.equal(profile.security.recoveryCodeHashes.length, 10);
  assert.equal(JSON.stringify(profile.security).includes(confirmed.recoveryCodes[0]), false);

  const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
  assert.equal((await session.json()).auth.mfaVerified, true);
});

test('limita intentos de login por IP y devuelve Retry-After', async t => {
  const { origin } = await fixture(t);
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: `inexistente_${attempt}`, password: 'incorrecta' })
    });
  }
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
});

test('rechaza origen externo y logout revoca la sesión', async t => {
  const { origin } = await fixture(t);
  const foreign = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alicia', password: 'segura-123' })
  });
  assert.equal(foreign.status, 403);

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alicia', password: 'segura-123' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  const withoutCsrf = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { origin, cookie } });
  assert.equal(withoutCsrf.status, 403);
  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrfToken }
  });
  assert.equal(logout.status, 200);
  const stale = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
  assert.equal(stale.status, 401);
});
