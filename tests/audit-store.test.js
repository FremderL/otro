'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryAuditStore, createAuditEntry } = require('../lib/audit-store');
const { PgAuditStore } = require('../lib/audit-store-pg');

test('auditoría usa lista permitida y elimina secretos', () => {
  const entry = createAuditEntry({ actorRole:'admin', action:'mfa.reset', targetType:'profile', targetId:'p', reason:'Motivo suficientemente largo', beforeData:{role:'admin',mfaEnabled:true,passwordHash:'secret',token:'secret'} });
  assert.deepEqual(entry.beforeData, {role:'admin',mfaEnabled:true});
  assert.equal(JSON.stringify(entry).includes('secret'), false);
});

test('store en memoria conserva entradas append-only', async () => {
  const store = new MemoryAuditStore();
  await store.append({actorRole:'system',action:'test',targetType:'profile'});
  assert.equal(store.entries.length, 1);
});

test('store Postgres parametriza JSON minimizado', async () => {
  const calls=[]; const pool={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:1};}};
  const store = new PgAuditStore(null,{pool});
  await store.append({actorProfileId:'a',actorRole:'admin',action:'role.changed',targetType:'profile',targetId:'p',reason:'Cambio autorizado manualmente',afterData:{role:'moderator',passwordHash:'never'}});
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/INSERT INTO montecristo_audit_log/);
  assert.equal(JSON.stringify(calls[0].params).includes('never'),false);
});
