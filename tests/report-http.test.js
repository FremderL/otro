'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const {deviceHash}=require('../lib/report-http');
const pepper=crypto.randomBytes(32).toString('base64');
test('hash de invitado es estable, irreversible y separado por dominio',()=>{const token='123e4567-e89b-42d3-a456-426614174000';const hash=deviceHash(token,pepper);assert.match(hash,/^[0-9a-f]{64}$/);assert.equal(hash,deviceHash(token,pepper));assert.notEqual(hash,token);assert.notEqual(hash,crypto.createHmac('sha256',Buffer.from(pepper,'base64')).update(token).digest('hex'));});
test('rechaza identificadores de dispositivo arbitrarios',()=>{assert.equal(deviceHash('token-controlado-por-atacante',pepper),null);assert.equal(deviceHash('',pepper),null);});
