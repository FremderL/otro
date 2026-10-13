'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileCommunityStore, PgCommunityStore, emptyCommunityState } = require('../lib/community-store');

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('JSON de comunidad serializa transacciones, persiste y revierte errores', async t => {
  const directory = temporaryDirectory(t, 'community-file-');
  const filePath = path.join(directory, 'community.json');
  const store = new FileCommunityStore(filePath);
  await Promise.all(Array.from({ length: 18 }, (_, index) => store.transact(state => {
    state.friendRequests.push({ id: `request-${index}`, fromId: `from-${index}`, toId: `to-${index}`, createdAt: index + 1 });
  })));
  assert.equal(store.getState().friendRequests.length, 18);
  await assert.rejects(store.transact(state => {
    state.friendRequests.push({ id: 'broken' });
    throw new Error('simulated write failure');
  }), /simulated write failure/);
  assert.equal(store.getState().friendRequests.length, 18);

  const restored = new FileCommunityStore(filePath);
  assert.equal(restored.getState().friendRequests.length, 18);
  assert.equal(restored.getState().seasonalTheme.enabled, false);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

class FakePool {
  static database = { data: null, tail: Promise.resolve() };
  constructor() { this.database = FakePool.database; }
  on() {}
  async query(sql, values = []) {
    if (/^\s*CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO montecristo_community_state/i.test(sql)) {
      if (/DO NOTHING/i.test(sql) && this.database.data) return { rows: [] };
      this.database.data = JSON.parse(values[0]);
      return { rows: [] };
    }
    if (/SELECT data FROM montecristo_community_state/i.test(sql)) {
      return { rows: this.database.data ? [{ data: structuredClone(this.database.data) }] : [] };
    }
    throw new Error(`Consulta de prueba desconocida: ${sql}`);
  }
  async connect() {
    const pool = this;
    let unlock = null;
    let snapshot = null;
    return {
      async query(sql, values = []) {
        if (/^BEGIN$/i.test(sql.trim())) {
          let next;
          const previous = pool.database.tail;
          pool.database.tail = new Promise(resolve => { next = resolve; });
          await previous;
          unlock = next;
          snapshot = structuredClone(pool.database.data);
          return { rows: [] };
        }
        if (/SELECT data FROM montecristo_community_state/i.test(sql)) {
          return { rows: pool.database.data ? [{ data: structuredClone(pool.database.data) }] : [] };
        }
        if (/INSERT INTO montecristo_community_state/i.test(sql)) {
          pool.database.data = JSON.parse(values[0]);
          return { rows: [] };
        }
        if (/^COMMIT$/i.test(sql.trim())) { unlock?.(); unlock = null; return { rows: [] }; }
        if (/^ROLLBACK$/i.test(sql.trim())) { pool.database.data = snapshot; unlock?.(); unlock = null; return { rows: [] }; }
        throw new Error(`Consulta de transacción desconocida: ${sql}`);
      },
      release() { unlock?.(); unlock = null; }
    };
  }
  async end() {}
}

test('Postgres bloquea la fila de estado y conserva escrituras de instancias concurrentes', async () => {
  FakePool.database = { data: null, tail: Promise.resolve() };
  const first = new PgCommunityStore('postgres://fixture', { Pool: FakePool });
  const second = new PgCommunityStore('postgres://fixture', { Pool: FakePool });
  await Promise.all([first.ready, second.ready]);
  const add = (store, id) => store.transact(state => {
    state.friendRequests.push({ id, fromId: `from-${id}`, toId: `to-${id}`, createdAt: 1 });
  });
  await Promise.all([add(first, 'first'), add(second, 'second')]);
  await first.refresh();
  assert.deepEqual(first.getState().friendRequests.map(item => item.id).sort(), ['first', 'second']);
  assert.deepEqual(FakePool.database.data.friendRequests.map(item => item.id).sort(), ['first', 'second']);
  await Promise.all([first.close(), second.close()]);
});

test('estado de comunidad defectuoso recupera valores vacíos seguros', () => {
  assert.deepEqual(emptyCommunityState().clubs, []);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-invalid-'));
  const filePath = path.join(directory, 'community.json');
  fs.writeFileSync(filePath, JSON.stringify({ clubs: [{ id: '<x>', ownerId: 'bad' }], seasonalTheme: { enabled: true, presetId: 'evil' } }));
  const store = new FileCommunityStore(filePath);
  assert.deepEqual(store.getState().clubs, [{
    id: '<x>', name: '', description: '', emblem: '', color: '', visibility: 'public', ownerId: 'bad',
    createdAt: store.getState().clubs[0].createdAt, updatedAt: store.getState().clubs[0].updatedAt, members: [], requests: []
  }]);
  assert.equal(store.getState().seasonalTheme.enabled, false);
  fs.rmSync(directory, { recursive: true, force: true });
});
