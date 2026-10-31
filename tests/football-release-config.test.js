'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadFootballConfig } = require('../lib/football-config');

test('el Estadio queda apagado si FOOTBALL_ENABLED no se define o es off', () => {
  assert.equal(loadFootballConfig({}).enabled, false);
  assert.equal(loadFootballConfig({ FOOTBALL_ENABLED: 'off' }).enabled, false);
  assert.equal(loadFootballConfig({ FOOTBALL_ENABLED: 'true' }).enabled, true);
});

test('Render habilita el Estadio oficial y conserva el store sobre el disco persistente', () => {
  const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  assert.match(blueprint, /key:\s*FOOTBALL_ENABLED\s*\n\s*value:\s*"on"/);
  assert.match(blueprint, /key:\s*FOOTBALL_STORE_PATH\s*\n\s*value:\s*\/var\/data\/football\.json/);
  assert.match(blueprint, /mountPath:\s*\/var\/data/);
});
