'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../lib/profile-store');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'montecristo-profile-'));
  const file = path.join(directory, 'profiles.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { store: new ProfileStore(file), file };
}

test('crea, registra, autentica y persiste una cuenta sin exponer la clave', t => {
  const { store, file } = fixture(t);
  const profile = store.getOrCreate('device-1', 'Alicia', 'fox');
  const result = store.registerAccount(profile, 'Alicia_1', 'secreto-123');
  assert.equal(result.ok, true);
  assert.equal(store.authenticate('alicia_1', 'secreto-123').ok, true);
  assert.equal(store.authenticate('alicia_1', 'incorrecta').ok, false);
  store.saveNow();

  const persisted = fs.readFileSync(file, 'utf8');
  assert.equal(persisted.includes('secreto-123'), false);
  const reloaded = new ProfileStore(file);
  assert.equal(reloaded.authenticate('ALICIA_1', 'secreto-123').ok, true);
});

test('normaliza roles y seguridad con defaults que no elevan privilegios', t => {
  const { store } = fixture(t);
  const normal = store.getOrCreate('normal', 'Normal');
  assert.equal(normal.role, 'user');
  assert.equal(normal.security.sessionVersion, 1);
  const unsafe = store.getOrCreate('unsafe', 'Unsafe');
  unsafe.role = 'superadmin';
  store.saveNow();
  const reloaded = new ProfileStore(store.filePath);
  assert.equal(reloaded.profiles.get('unsafe').role, 'user');
});

test('impide usuarios duplicados y contraseñas demasiado cortas', t => {
  const { store } = fixture(t);
  const one = store.getOrCreate('one', 'Uno', 'fox');
  const two = store.getOrCreate('two', 'Dos', 'fox');
  assert.equal(store.registerAccount(one, 'usuario', '12345').ok, false);
  assert.equal(store.registerAccount(one, 'usuario', '123456').ok, true);
  assert.equal(store.registerAccount(two, 'USUARIO', 'abcdef').ok, false);
});

test('rechaza login de cuentas suspendidas o baneadas después de validar contraseña', t => {
  const { store } = fixture(t);
  const profile = store.getOrCreate('blocked', 'Bloqueado');
  store.registerAccount(profile, 'bloqueado', 'correcta-123');
  profile.moderation = { status: 'banned', reason: 'Abuso confirmado', until: null };
  assert.equal(store.authenticate('bloqueado', 'incorrecta').error, 'Usuario o contraseña incorrectos.');
  assert.equal(store.authenticate('bloqueado', 'correcta-123').code, 'account_banned');
  profile.moderation = { status: 'suspended', reason: 'Temporal', until: Date.now() - 1 };
  assert.equal(store.authenticate('bloqueado', 'correcta-123').ok, true);
});

test('bloquea temporalmente tras cinco intentos fallidos', t => {
  const { store } = fixture(t);
  const profile = store.getOrCreate('one', 'Uno', 'fox');
  store.registerAccount(profile, 'usuario', 'correcta');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(store.authenticate('usuario', 'mala').ok, false);
  }
  const result = store.authenticate('usuario', 'correcta');
  assert.equal(result.ok, false);
  assert.match(result.error, /Demasiados intentos/);
});
