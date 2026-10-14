'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../lib/profile-store');
const { planAccountRelink, applyAccountRelink } = require('../lib/account-relink');

// Caso real: la cuenta @admin quedó en un perfil congelado, mientras el perfil
// del dispositivo acumuló las fichas de las partidas.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-test-'));
  const store = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
  const account = store.getOrCreate('cuenta-congelada', 'Cuenta', 'fox');
  store.registerAccount(account, 'admin', 'Clave-segura-1');
  account.role = 'admin';
  account.chips = 1600;
  account.security = { ...account.security, mfaEnabled: true, mfaSecretEncrypted: 'secreto-cifrado', recoveryCodeHashes: ['a'.repeat(64)], sessionVersion: 3 };
  account.transactions = [{ amount: 100, reason: 'Bono diario', time: 1 }];
  const device = store.getOrCreate('dispositivo-vivo', 'Dispositivo', 'fox');
  device.chips = 6600;
  device.transactions = [{ amount: 5000, reason: 'Ganancia en dice', time: 2 }];
  store.touch(account);
  store.touch(device);
  return { dir, store, account, device };
}

test('la vista previa no modifica nada y resume el plan', () => {
  const { dir, store, account, device } = setup();
  try {
    const plan = planAccountRelink(store, { username: 'admin', targetId: device.id });
    assert.equal(plan.ok, true, plan.error);
    assert.equal(plan.source.id, account.id);
    assert.equal(plan.target.id, device.id);
    assert.equal(account.username, 'admin', 'el origen conserva su usuario');
    assert.equal(device.username, null, 'el destino sigue sin cuenta');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('aplicar mueve usuario, contraseña, rol y MFA, y no toca fichas ni historial', () => {
  const { dir, store, account, device } = setup();
  try {
    const originalHash = account.passwordHash;
    const plan = planAccountRelink(store, { username: 'admin', targetId: device.id });
    const applied = applyAccountRelink(plan);
    assert.equal(applied.ok, true);

    assert.equal(device.username, 'admin');
    assert.equal(device.role, 'admin');
    assert.equal(device.passwordHash, originalHash, 'el hash de la contraseña llega intacto');
    assert.equal(device.security.mfaEnabled, true, 'el autenticador sigue activo');
    assert.equal(device.security.mfaSecretEncrypted, 'secreto-cifrado');
    assert.equal(device.security.sessionVersion, 4, 'versión de sesión nueva en el destino');

    assert.equal(account.username, null, 'el origen ya no tiene usuario');
    assert.equal(account.passwordHash, null);
    assert.equal(account.role, 'user');
    assert.equal(account.security.mfaEnabled, false);
    assert.equal(account.security.sessionVersion, 4, 'las cookies del origen dejan de valer');

    assert.equal(account.chips, 1600, 'fichas del origen intactas');
    assert.equal(device.chips, 6600, 'fichas del destino intactas');
    assert.equal(device.transactions.length, 1);
    assert.equal(account.transactions.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tras aplicar, la contraseña entra al perfil destino y ya no al origen', () => {
  const { dir, store, device } = setup();
  try {
    applyAccountRelink(planAccountRelink(store, { username: 'admin', targetId: device.id }));
    assert.equal(store.findByUsername('admin').id, device.id);
    const ok = store.authenticate('admin', 'Clave-segura-1');
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.profile.id, device.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('se rechaza una reasignación inválida y no deja cambios a medias', () => {
  const { dir, store, account, device } = setup();
  try {
    assert.equal(planAccountRelink(store, { username: 'nadie', targetId: device.id }).ok, false, 'cuenta inexistente');
    assert.equal(planAccountRelink(store, { username: 'admin', targetId: 'no-existe' }).ok, false, 'destino inexistente');
    assert.equal(planAccountRelink(store, { username: 'admin', targetId: account.id }).ok, false, 'mismo perfil');
    store.registerAccount(device, 'otra_cuenta', 'Clave-segura-2');
    const blocked = planAccountRelink(store, { username: 'admin', targetId: device.id });
    assert.equal(blocked.ok, false, 'el destino ya tiene cuenta');
    assert.equal(account.username, 'admin');
    assert.equal(device.username, 'otra_cuenta');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('el script no acepta contraseñas en la línea de comandos y lee sus opciones', () => {
  const { parseArgs } = require('../scripts/relink-account');
  assert.throws(() => parseArgs(['--username', 'admin', '--password', 'secreta']), /Nunca pases contraseñas/);
  const options = parseArgs(['--username', 'admin', '--target', 'abc', '--apply']);
  assert.deepEqual(options, { list: false, apply: true, username: 'admin', target: 'abc' });
  assert.equal(parseArgs(['--list']).list, true);
});
