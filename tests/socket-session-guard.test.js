'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('los handlers de cuenta seguros ignoran accountId enviado por el cliente', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /socket\.data\.accountProfileId/);
  assert.match(source, /adminConfig\.accountSessionsEnabled\s*\?\s*socket\.data\.accountProfileId/);
  assert.match(source, /if \(adminConfig\.accountSessionsEnabled\)[\s\S]*Actualiza la página para usar el inicio de sesión seguro/);
});

test('el cliente usa HTTP y reconecta Socket.IO para adoptar la cookie', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /secureAuthRequest\('\/api\/auth\/login'/);
  assert.match(source, /secureAuthRequest\('\/api\/auth\/session'/);
  assert.match(source, /secureAuthRequest\('\/api\/auth\/logout'/);
  assert.match(source, /socket\.disconnect\(\)\.connect\(\)/);
  assert.match(source, /secureAuthRequest\('\/api\/auth\/change-password'/);
  assert.match(source, /ui\.csrfToken/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(response\.token|csrfToken)/);
});
