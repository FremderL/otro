// TEMPORAL: reproduce el guard de FutureMarketService.getMarket sobre PG real
// e imprime el estado de cada condición.
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { PgFootballStore } = require('../lib/football-store-pg');
const { PgProfileStore } = require('../lib/profile-store-pg');
const { createOfficialV2 } = require('../lib/football/v2/official');
const { createBettingService } = require('../lib/football/betting');
const { verifyPolicy } = require('../lib/football/v2/season-policy');
const { lastCompletedJornada } = require('../lib/football/ballon-dor-market');
const out = line => console.log(`::error::${line}`);
(async () => {
  const URL = process.env.FOOTBALL_TEST_DATABASE_URL;
  const schema = `probe_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  class ScopedPool extends Pool { constructor(o) { super({ ...o, options: `-c search_path=${schema}` }); } }
  let store, profiles;
  try {
    store = new PgFootballStore(URL, { pool: new ScopedPool({ connectionString: URL }) });
    profiles = new PgProfileStore(URL, { Pool: ScopedPool, deferSeasonCheck: true });
    await Promise.all([store.ready, profiles.ready]);
    store.generateSeason('2026-10');
    const old = store.getMatches('2026-10')[0];
    store.settleMatch(old.id, { home: 4, away: 1 }, { seasonMonth: '2026-10', now: old.scheduledKickoffAt + 1800000 });
    store.closeSeason('2026-10');
    const league = store.generateSeason('2026-11');
    const now = Math.min(...league.calendar.matches.map(m => m.scheduledKickoffAt)) - 60000;
    await store.saveStrict();
    const v2 = createOfficialV2({ store, now: () => now });
    const ensured = await v2.ensureSeason('2026-11');
    out(`ensureSeason=${JSON.stringify(ensured)}`);
    const betting = createBettingService({ store, profiles, officialV2: v2, now: () => now });
    const fm = betting.futureMarket;
    const live = store.getLeague('2026-11');
    out(`league=${Boolean(live)} status=${live && live.status} current=${store.getCurrentSeasonMonth()} cached=${fm.cache.size}`);
    out(`policyOk=${verifyPolicy(live && live.simulationPolicy, '2026-11')} unconfirmed=${live && live.simulationPolicyUnconfirmed} v2Only=${store.v2Only}`);
    out(`lastJornada=${live ? lastCompletedJornada(live) : 'n/a'} liveState=${typeof fm.getLiveState}`);
    const matches = (live && live.calendar && live.calendar.matches) || [];
    const liveOnes = matches.filter(m => !m.desempate && m.status !== 'settled'
      && !(m.status === 'scheduled' && now < m.scheduledKickoffAt));
    out(`matches=${matches.length} vivos=${liveOnes.length} muestra=${liveOnes.slice(0, 3).map(m => `${m.id}:${m.status}:sim=${Boolean(m.simulation)}`).join(',')}`);
    out(`getMarket=${fm.getMarket('2026-11') ? 'ok' : 'NULL'}`);
  } catch (error) {
    out(`EXCEPCIÓN ${error && error.message}`);
  } finally {
    try { await store?.close(); await profiles?.close(); } catch (_) {}
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
})().catch(error => { out(`FALLO ${error.message}`); process.exit(1); });
