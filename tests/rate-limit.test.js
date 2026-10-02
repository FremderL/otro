'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FixedWindowRateLimiter } = require('../lib/rate-limit');

test('limita por clave y permite de nuevo al terminar la ventana', () => {
  let now = 1000;
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.consume('a').allowed, false);
  assert.equal(limiter.consume('b').allowed, true);
  now = 2000;
  assert.equal(limiter.consume('a').allowed, true);
});

test('acota el número de claves retenidas', () => {
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2 });
  limiter.consume('a'); limiter.consume('b'); limiter.consume('c');
  assert.equal(limiter.entries.size, 2);
  assert.equal(limiter.entries.has('a'), false);
});
