'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flagOn, loadPassportConfig } = require('../lib/passport-config');

test('PASSPORT_ENABLED queda apagado por defecto y solo acepta valores afirmativos', () => {
  assert.deepEqual(loadPassportConfig({}), { enabled: false });
  assert.deepEqual(loadPassportConfig({ PASSPORT_ENABLED: '' }), { enabled: false });
  assert.deepEqual(loadPassportConfig({ PASSPORT_ENABLED: 'off' }), { enabled: false });
  assert.deepEqual(loadPassportConfig({ PASSPORT_ENABLED: 'enabled' }), { enabled: false });

  for (const value of ['on', 'ON', ' true ', '1', 'Yes']) {
    assert.equal(flagOn(value), true, `${JSON.stringify(value)} debe activar el flag`);
    assert.deepEqual(loadPassportConfig({ PASSPORT_ENABLED: value }), { enabled: true });
  }
});
