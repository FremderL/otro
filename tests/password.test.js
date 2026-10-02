'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../lib/password');

test('scrypt verifica la contraseña y usa una sal distinta', () => {
  const first = hashPassword('una contraseña segura');
  const second = hashPassword('una contraseña segura');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('una contraseña segura', first), true);
  assert.equal(verifyPassword('incorrecta', first), false);
});

test('hashes malformados no autentican ni lanzan excepciones', () => {
  for (const value of [null, '', 'sin-separador', ':', '00:zz', '00:00']) {
    assert.doesNotThrow(() => verifyPassword('clave', value));
    assert.equal(verifyPassword('clave', value), false);
  }
});
