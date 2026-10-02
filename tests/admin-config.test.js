'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdminConfig, secretBytes } = require('../lib/admin-config');

const secret = Buffer.alloc(32, 7).toString('base64');

test('la administración queda apagada por defecto', () => {
  const config = loadAdminConfig({});
  assert.equal(config.enabled, false);
});

test('activar administración sin requisitos falla cerrado', () => {
  assert.throws(() => loadAdminConfig({ ADMIN_FEATURE_ENABLED: 'true' }), /DATABASE_URL es obligatorio/);
});

test('acepta únicamente una configuración de producción completa', () => {
  const config = loadAdminConfig({
    ADMIN_FEATURE_ENABLED: 'true',
    DATABASE_URL: 'postgres://db.example/montecristo',
    APP_ORIGIN: 'https://casino.example',
    TRUST_PROXY_HOPS: '1',
    SESSION_PEPPER: secret,
    MFA_ENCRYPTION_KEY: secret,
    AUDIT_IP_PEPPER: secret
  });
  assert.equal(config.enabled, true);
  assert.equal(config.appOrigin, 'https://casino.example');
  assert.equal(config.trustProxyHops, 1);
});

test('rechaza secretos cortos o que no sean Base64 canónico', () => {
  assert.equal(secretBytes('no-es-base64!'), 0);
  assert.throws(() => loadAdminConfig({
    ADMIN_FEATURE_ENABLED: 'on', DATABASE_URL: 'postgres://db/test', APP_ORIGIN: 'https://casino.example',
    SESSION_PEPPER: 'corto', MFA_ENCRYPTION_KEY: secret, AUDIT_IP_PEPPER: secret
  }), /SESSION_PEPPER/);
});
