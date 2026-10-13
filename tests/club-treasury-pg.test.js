'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PgProfileStore } = require('../lib/profile-store-pg');
const { emptyClubTreasury } = require('../lib/profile-store-base');

function makeMockPgPoolClass(seed = {}) {
  return class MockPgPool {
    constructor() {
      this.profileRows = (seed.profiles || []).map(data => ({ data }));
      this.season = seed.season || null;
      this.ended = false;
    }
    on() {}
    async query(sql) {
      if (/SELECT data FROM montecristo_profiles/i.test(sql)) return { rows: this.profileRows };
      if (/SELECT data FROM montecristo_seasons/i.test(sql)) return { rows: this.season ? [{ data: this.season }] : [] };
      return { rows: [] };
    }
    async connect() {
      const pool = this;
      return {
        async query(sql, params = []) {
          if (/INSERT INTO montecristo_profiles/i.test(sql)) {
            const [ids, values] = params;
            pool.profileRows = pool.profileRows.filter(row => !ids.includes(row.data.id));
            pool.profileRows.push(...ids.map((id, index) => ({ id, data: JSON.parse(values[index]) })));
          } else if (/INSERT INTO montecristo_seasons/i.test(sql)) {
            pool.season = JSON.parse(params[0]);
          }
          return { rows: [], rowCount: 1 };
        },
        release() {}
      };
    }
    async end() { this.ended = true; }
  };
}

test('PostgreSQL snapshot conserva tesorerías, movimientos e historial de temporada', async t => {
  const PoolOne = makeMockPgPoolClass();
  const store = new PgProfileStore('postgres://mock-host/montecristo', { Pool: PoolOne, deferSeasonCheck: true });
  await store.ready;
  t.after(() => store.close());
  const profile = store.getOrCreate('pg-club-owner', 'Alicia');
  profile.username = 'alice';
  profile.chips = 1000;
  store.seasons.current = '2026-10';
  store.seasons.clubTreasury = emptyClubTreasury('2026-10', [{ seasonKey: '2026-09', closedAt: 1, top: [{ clubId: 'old-club', balance: 50 }] }]);
  const result = store.applyClubTreasuryMovement({
    clubId: 'club-pg', type: 'deposit', amount: 240, actorId: profile.id,
    operationId: 'pg-deposit-idempotency-01', now: Date.parse('2026-10-15T12:00:00Z'),
    validate: () => ({ ok: true, club: { name: 'Mesa Postgres' } })
  });
  assert.equal(result.ok, true);
  await store.flushClubTreasury();
  assert.equal(store.pool.season.clubTreasury.accounts['club-pg'].balance, 240);
  assert.equal(store.pool.profileRows.find(row => row.data.id === profile.id).data.chips, 760);

  const PoolTwo = makeMockPgPoolClass({ profiles: store.pool.profileRows.map(row => row.data), season: store.pool.season });
  const restored = new PgProfileStore('postgres://mock-host/montecristo', { Pool: PoolTwo, deferSeasonCheck: true });
  await restored.ready;
  t.after(() => restored.close());
  assert.equal(restored.getClubTreasuryBalance('club-pg'), 240);
  assert.equal(restored.getProfile(profile.id).chips, 760);
  assert.equal(restored.getClubTreasury('club-pg').movements[0].operationId, 'pg-deposit-idempotency-01');
  assert.deepEqual(restored.seasons.clubTreasury.history[0].top, [{ clubId: 'old-club', balance: 50 }]);
});
