'use strict';

// Pruebas de las defensas añadidas en la revisión de seguridad:
//   · CORS/orígenes del handshake de Socket.IO (antes `origin: true`)
//   · verificación TLS de Postgres (antes `rejectUnauthorized: false`)
//   · límite de perfiles nuevos (antes ilimitado)
//   · límites de intentos que no se pueden vaciar con claves nuevas
//   · política de contraseñas unificada y login asíncrono
//   · anti-replay de TOTP
//   · escritura atómica con fsync

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { originAllowed, resolveAllowedOrigins, isLoopbackOrigin } = require('../lib/socket-origin');
const { resolvePgSsl } = require('../lib/pg-ssl');
const { FixedWindowRateLimiter } = require('../lib/rate-limit');
const { hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync, validatePassword } = require('../lib/password');
const { verifyTotpStep, createTotp } = require('../lib/mfa');
const { atomicWriteFileSync } = require('../lib/atomic-file');
const { ProfileStore } = require('../lib/profile-store');

// ───────────────────────────── Socket.IO origin ─────────────────────────────

test('CORS del socket: un origen ajeno se rechaza en producción', () => {
  const env = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://a.example' };
  const config = { appOrigin: 'https://casino.example' };
  const allowed = resolveAllowedOrigins(env, config);
  assert.equal(originAllowed('https://casino.example', allowed, env), true);
  assert.equal(originAllowed('https://a.example', allowed, env), true);
  assert.equal(originAllowed('https://evil.example', allowed, env), false);
  // Nada de reflejar el origen ajeno con credenciales (el bug original).
  assert.equal(originAllowed('http://localhost:3000', allowed, env), false);
});

test('CORS del socket: clientes sin Origin (tests, CLI) siguen pasando', () => {
  const env = { NODE_ENV: 'production' };
  assert.equal(originAllowed(undefined, new Set(), env), true);
  assert.equal(originAllowed('', new Set(), env), true);
});

test('CORS del socket: en desarrollo se tolera localhost, no un sitio externo', () => {
  const env = { NODE_ENV: 'development' };
  const allowed = resolveAllowedOrigins(env, { appOrigin: 'https://casino.example' });
  assert.equal(isLoopbackOrigin('http://127.0.0.1:5173'), true);
  assert.equal(originAllowed('http://127.0.0.1:5173', allowed, env), true);
  assert.equal(originAllowed('https://evil.example', allowed, env), false);
});

// ──────────────────────────────── Postgres TLS ───────────────────────────────

test('Postgres TLS: se verifica el certificado salvo opt-out explícito', () => {
  assert.deepEqual(resolvePgSsl('postgres://h/db?sslmode=require', {}), { rejectUnauthorized: true });
  assert.deepEqual(resolvePgSsl('postgres://h/db', {}), { rejectUnauthorized: true });
  assert.equal(resolvePgSsl('postgres://h/db?sslmode=disable', {}), false);
  const previous = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(resolvePgSsl('postgres://h/db', { PGSSL_REJECT_UNAUTHORIZED: 'false' }), { rejectUnauthorized: false });
  } finally {
    console.warn = previous;
  }
});

// ─────────────────────────────── Límite de intentos ──────────────────────────

test('el limitador no expulsa contadores legítimos al llenarse de claves nuevas', () => {
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 60000, maxKeys: 3, now: () => 1000 });
  limiter.consume('victima');
  assert.equal(limiter.consume('victima').allowed, true);
  limiter.consume('ruido-1');
  limiter.consume('ruido-2');
  // Tercera clave nueva con el mapa lleno: se rechaza sin tocar 'victima'.
  assert.equal(limiter.consume('ruido-3').allowed, false);
  assert.equal(limiter.consume('victima').allowed, false, 'el contador de la víctima sigue vivo');
});

// ──────────────────────────────── Contraseñas ───────────────────────────────

test('política de contraseñas: 10-128 caracteres y sin recortes', () => {
  assert.equal(validatePassword('123456789').ok, false);
  assert.equal(validatePassword('1234567890').ok, true);
  assert.equal(validatePassword('x'.repeat(128)).ok, true);
  assert.equal(validatePassword('x'.repeat(129)).ok, false);
  // Una contraseña de 80 caracteres se hashea completa: antes el alta recortaba
  // a 72 y el cambio no, creando credenciales divergentes.
  const long = 'a'.repeat(80);
  const stored = hashPassword(long);
  assert.equal(verifyPassword(long, stored), true);
  assert.equal(verifyPassword('a'.repeat(72), stored), false);
});

test('hash asíncrono produce hashes verificables e interoperables', async () => {
  const stored = await hashPasswordAsync('Clave-segura-1');
  assert.equal(await verifyPasswordAsync('Clave-segura-1', stored), true);
  assert.equal(await verifyPasswordAsync('otra-clave', stored), false);
  assert.equal(verifyPassword('Clave-segura-1', stored), true, 'la variante síncrona lee el mismo formato');
});

test('el alta exige la misma política que el cambio de contraseña', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-policy-'));
  try {
    const store = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
    const profile = store.getOrCreate('p1', 'Persona', 'fox');
    assert.equal(store.registerAccount(profile, 'corta', '123456').ok, false);
    assert.equal(store.registerAccount(profile, 'larga', '1234567890').ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el login asíncrono mantiene el bloqueo por intentos fallidos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-async-login-'));
  try {
    const store = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
    const profile = store.getOrCreate('p1', 'Persona', 'fox');
    store.registerAccount(profile, 'persona', 'Clave-segura-1');
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await store.authenticateAsync('persona', 'mala')).ok, false);
    }
    const locked = await store.authenticateAsync('persona', 'Clave-segura-1');
    assert.equal(locked.ok, false);
    assert.match(locked.error, /Demasiados intentos/);
    // Un usuario inexistente responde igual que uno real (sin enumeración por
    // tiempo ni por mensaje).
    const unknown = await store.authenticateAsync('nadie', 'Clave-segura-1');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Usuario o contraseña incorrectos/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findByUsername no se queda con una entrada obsoleta del índice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-index-'));
  try {
    const store = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
    const profile = store.getOrCreate('p1', 'Persona', 'fox');
    store.registerAccount(profile, 'persona', 'Clave-segura-1');
    assert.equal(store.findByUsername('persona')?.id, 'p1');
    // Reasignación fuera de banda (lib/account-relink.js) sin avisar al store.
    profile.username = 'renombrada';
    assert.equal(store.findByUsername('persona'), null);
    assert.equal(store.findByUsername('renombrada')?.id, 'p1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────── TOTP anti-replay ────────────────────────────

test('verifyTotpStep devuelve el paso usado y rechaza códigos inválidos', () => {
  const totp = createTotp({ username: 'cuenta' });
  const now = Date.now();
  const code = totp.generate({ timestamp: now });
  const step = verifyTotpStep(totp.secret.base32, code, now);
  assert.equal(step, Math.floor(now / 30000));
  assert.equal(verifyTotpStep(totp.secret.base32, '000000', now), null);
  // El mismo código, en el paso siguiente, reporta un paso MENOR o igual al ya
  // usado: el handler lo trata como replay.
  const later = verifyTotpStep(totp.secret.base32, code, now + 30000);
  assert.ok(later === null || later <= step, 'un código ya usado no adelanta el paso');
});

// ───────────────────────────── Tope de perfiles nuevos ───────────────────────

test('el alta de perfiles desconocidos respeta MAX_PROFILES', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cap-'));
  const previous = process.env.MAX_PROFILES;
  process.env.MAX_PROFILES = '2';
  try {
    const store = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
    store.getOrCreate('uno', 'Uno', 'fox');
    store.getOrCreate('dos', 'Dos', 'fox');
    assert.equal(store.profileCreationIssue('tres').code, 'profile_capacity');
    assert.throws(() => store.getOrCreate('tres', 'Tres', 'fox'), /límite de perfiles/);
    // Los perfiles que ya existen nunca se bloquean.
    assert.equal(store.profileCreationIssue('uno'), null);
    assert.equal(store.getOrCreate('uno').id, 'uno');
  } finally {
    if (previous === undefined) delete process.env.MAX_PROFILES;
    else process.env.MAX_PROFILES = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MAX_PROFILES=0 desactiva el tope', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cap0-'));
  const previous = process.env.MAX_PROFILES;
  process.env.MAX_PROFILES = '0';
  try {
    const store = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
    for (let i = 0; i < 25; i += 1) store.getOrCreate(`p-${i}`, `P${i}`, 'fox');
    assert.equal(store.profileCreationIssue('otro'), null);
  } finally {
    if (previous === undefined) delete process.env.MAX_PROFILES;
    else process.env.MAX_PROFILES = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────── Escritura atómica ───────────────────────────

test('atomicWriteFileSync deja el archivo completo y sin temporales', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-'));
  try {
    const file = path.join(dir, 'nested', 'data.json');
    atomicWriteFileSync(file, JSON.stringify({ ok: true }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['data.json'], 'no queda el .tmp');
    // Sobrescribir tampoco deja restos.
    atomicWriteFileSync(file, JSON.stringify({ ok: 'nuevo' }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ok, 'nuevo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el store de archivo persiste a través de la escritura atómica', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-atomic-'));
  try {
    const file = path.join(dir, 'profiles.json');
    const store = new ProfileStore(file, { deferSeasonCheck: true });
    const profile = store.getOrCreate('persistente', 'Persistente', 'fox');
    store.touch(profile);
    assert.equal(store.saveNow(), true);
    const reloaded = new ProfileStore(file, { deferSeasonCheck: true });
    reloaded.load();
    assert.equal(reloaded.getProfile('persistente')?.name, 'Persistente');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
