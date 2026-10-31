'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { seatIdentity, lobbyChatIdentity } = require('../lib/seat-identity');

test('con sesión de cuenta verificada, la persona se sienta con el perfil de su cuenta', () => {
  assert.equal(
    seatIdentity({ accountSessionsEnabled: true, accountProfileId: 'cuenta-A', token: 'dispositivo-B' }),
    'cuenta-A'
  );
});

test('sin sesión de cuenta, el asiento sigue siendo el perfil del dispositivo', () => {
  assert.equal(seatIdentity({ accountSessionsEnabled: true, accountProfileId: null, token: 'dispositivo-B' }), 'dispositivo-B');
  assert.equal(seatIdentity({ accountSessionsEnabled: false, accountProfileId: 'cuenta-A', token: 'dispositivo-B' }), 'dispositivo-B');
});

test('en modo sin sesiones seguras, un accountId enviado por el navegador no sienta a nadie', () => {
  // Sin prueba de identidad (cookie verificada), usar ese dato permitiría jugar
  // con las fichas de otra persona si conoce su id.
  const seat = seatIdentity({ accountSessionsEnabled: false, accountProfileId: undefined, token: 'dispositivo-B' });
  assert.equal(seat, 'dispositivo-B');
});

test('los ids se recortan a 80 caracteres y un token vacío da cadena vacía', () => {
  assert.equal(seatIdentity({ token: 'x'.repeat(120) }).length, 80);
  assert.equal(seatIdentity({}), '');
});

test('el chat usa la cuenta verificada por cookie y no el dispositivo', () => {
  assert.deepEqual(lobbyChatIdentity({ accountSessionsEnabled: true, accountProfileId: 'cuenta-A', token: 'dispositivo-B' }),
    { id: 'cuenta-A', authenticated: true });
  assert.deepEqual(lobbyChatIdentity({ accountSessionsEnabled: true, legacyChatProfileId: 'cuenta-A', token: 'dispositivo-B' }),
    { id: 'dispositivo-B', authenticated: false }, 'el login legado no sustituye una cookie');
});

test('el chat legado usa solo la cuenta autenticada en esta conexión', () => {
  assert.deepEqual(lobbyChatIdentity({ legacyChatProfileId: 'cuenta-A', token: 'dispositivo-B' }),
    { id: 'cuenta-A', authenticated: true });
  assert.deepEqual(lobbyChatIdentity({ accountProfileId: 'cuenta-A', token: 'dispositivo-B' }),
    { id: 'dispositivo-B', authenticated: false });
});
