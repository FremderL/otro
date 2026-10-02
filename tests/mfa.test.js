'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encryptSecret, decryptSecret, createTotp, verifyTotp, beginEnrollment,
  generateRecoveryCodes, consumeRecoveryCode, hashRecoveryCode
} = require('../lib/mfa');

const key = Buffer.alloc(32, 6).toString('base64');
const pepper = Buffer.alloc(32, 8).toString('base64');

test('AES-256-GCM cifra y autentica el secreto MFA', () => {
  const encrypted = encryptSecret('JBSWY3DPEHPK3PXP', key);
  assert.notEqual(encrypted.includes('JBSWY3DPEHPK3PXP'), true);
  assert.equal(decryptSecret(encrypted, key), 'JBSWY3DPEHPK3PXP');
  const parts = encrypted.split(':');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString('base64url');
  assert.throws(() => decryptSecret(parts.join(':'), key));
});

test('TOTP acepta la ventana actual y rechaza códigos inválidos', () => {
  const timestamp = 1760000000000;
  const totp = createTotp({ username: '@alicia' });
  const token = totp.generate({ timestamp });
  assert.equal(verifyTotp(totp.secret.base32, token, timestamp), true);
  assert.equal(verifyTotp(totp.secret.base32, '00000', timestamp), false);
});

test('enrolamiento produce URI, QR y clave manual sin guardar texto plano', async () => {
  const result = await beginEnrollment('alicia', key);
  assert.match(result.uri, /^otpauth:\/\/totp\//);
  assert.match(result.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(decryptSecret(result.encryptedSecret, key), result.manualKey);
  assert.equal(result.encryptedSecret.includes(result.manualKey), false);
});

test('códigos de recuperación son diez, hasheados y de un solo uso', () => {
  const generated = generateRecoveryCodes(10, pepper);
  assert.equal(generated.codes.length, 10);
  assert.equal(generated.hashes.length, 10);
  assert.equal(generated.hashes.includes(generated.codes[0]), false);
  assert.equal(generated.hashes[0], hashRecoveryCode(generated.codes[0].toLowerCase(), pepper));
  const consumed = consumeRecoveryCode(generated.hashes, generated.codes[0], pepper);
  assert.equal(consumed.valid, true);
  assert.equal(consumed.hashes.length, 9);
  assert.equal(consumeRecoveryCode(consumed.hashes, generated.codes[0], pepper).valid, false);
});
