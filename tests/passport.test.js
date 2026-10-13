'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../lib/progression');
const Passport = require('../lib/passport');
const Catalog = require('../lib/passport-catalog');
const { cleanProfile, monthKey } = require('../lib/profile-store-shared');
const { ProfileStore } = require('../lib/profile-store');
const { PgProfileStore } = require('../lib/profile-store-pg');

const OCTOBER = new Date('2026-10-15T12:00:00.000Z');

function newProfile(id = 'passport-test') {
  return cleanProfile({ id, name: 'Pasaporte QA', chips: 1000 });
}

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

test('el Pasaporte comparte exactamente los seis juegos de AVAILABLE_GAMES', () => {
  assert.deepEqual(P.AVAILABLE_GAMES, Catalog.PASSPORT_GAMES.map(game => game.id));
  assert.equal(Catalog.PASSPORT_GAME_IDS.has('football'), false);
});

test('una ronda elegible suma un punto y el mismo resultado no suma dos veces', () => {
  const profile = newProfile();
  P.recordOutcome(profile, { game: 'poker', net: 0, eligible: true, roundId: 'table-a:1' });
  assert.equal(profile.passport.currentSeason.points, 1);
  assert.deepEqual(profile.passport.currentSeason.games, ['poker']);

  P.recordOutcome(profile, { game: 'poker', net: -50, eligible: true, roundId: 'table-a:1' });
  assert.equal(profile.passport.currentSeason.points, 1, 'resultado repetido idempotente para el Pasaporte');
  assert.deepEqual(profile.passport.currentSeason.games, ['poker']);
});

test('victoria, derrota y empate valen un punto por igual; apuestas y fútbol no dan puntos', () => {
  const results = [100, -700, 0].map((net, index) => {
    const profile = newProfile(`outcome-${index}`);
    P.recordOutcome(profile, { game: 'dice', net, eligible: true, roundId: `dice-${index}` });
    return profile.passport.currentSeason.points;
  });
  assert.deepEqual(results, [1, 1, 1]);

  const profile = newProfile('ineligible');
  P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false, roundId: 'bot-round' });
  P.recordOutcome(profile, { game: 'football', net: 0, eligible: true, roundId: 'football-round' });
  P.recordOutcome(profile, { game: 'poker', net: 0, eligible: true });
  assert.equal(profile.passport.currentSeason.points, 0);
  assert.deepEqual(profile.passport.currentSeason.games, []);
});

test('los seis sellos son únicos por temporada y completarlos desbloquea la insignia Explorador', () => {
  const profile = newProfile('six-games');
  const unlocked = [];
  for (const [index, game] of P.AVAILABLE_GAMES.entries()) {
    const result = Passport.recordPassportRound(profile, { game, roundId: `six-games:${index}`, date: OCTOBER });
    unlocked.push(...result.unlocked.map(item => item.slug));
    Passport.recordPassportRound(profile, { game, roundId: `six-games:duplicate:${index}`, date: OCTOBER });
  }

  const view = Passport.publicPassport(profile, OCTOBER);
  assert.equal(view.season.completedGames, 6);
  assert.equal(view.season.allGamesComplete, true);
  assert.ok(view.season.games.every(game => game.completed));
  assert.equal(profile.passport.currentSeason.points, 12, 'son 12 rondas distintas, aunque solo seis sellos');
  assert.equal(profile.passport.currentSeason.games.length, 6, 'cada juego deja un único sello');
  assert.ok(unlocked.includes('explorer'));
  assert.ok(profile.passport.unlockedCosmetics.includes(Catalog.makeCosmeticId('2026-10', 'explorer')));
});

test('los hitos fijos se desbloquean automáticamente y no modifican fichas', () => {
  const profile = newProfile('milestones');
  for (let round = 1; round <= 75; round++) {
    Passport.recordPassportRound(profile, { game: 'poker', roundId: `milestone:${round}`, date: OCTOBER });
  }

  const expected = Catalog.rewardsForSeason('2026-10').filter(item => item.threshold !== null).map(item => item.id);
  assert.equal(profile.passport.currentSeason.points, 75);
  assert.deepEqual(expected.filter(id => profile.passport.unlockedCosmetics.includes(id)).length, 5);
  assert.ok(expected.every(id => profile.passport.unlockedCosmetics.includes(id)));
  assert.equal(profile.chips, 1000, 'el Pasaporte solo otorga cosméticos');
  assert.deepEqual(profile.passport.currentSeason.games, ['poker']);
});

test('el equipamiento valida catálogo, desbloqueo y espacio y se puede quitar', () => {
  const profile = newProfile('equipment');
  for (let round = 1; round <= 15; round++) {
    Passport.recordPassportRound(profile, { game: 'blackjack', roundId: `equipment:${round}`, date: OCTOBER });
  }
  const frameId = Catalog.makeCosmeticId('2026-10', 'frame-15');
  const equipped = Passport.equipPassportCosmetic(profile, { slot: 'frame', itemId: frameId });
  assert.equal(equipped.ok, true);
  assert.equal(profile.passport.equipped.frame, frameId);
  assert.equal(Passport.publicPassportIdentity(profile).equipped.frame.id, frameId);

  assert.equal(Passport.equipPassportCosmetic(profile, { slot: 'badge', itemId: frameId }).ok, false, 'no admite equipar un marco como insignia');
  assert.equal(Passport.equipPassportCosmetic(profile, { slot: 'frame', itemId: 'passport:2026-10:inventado' }).ok, false, 'rechaza ids fuera del catálogo');
  const lockedFrame = Catalog.makeCosmeticId('2026-11', 'frame-15');
  assert.equal(Passport.equipPassportCosmetic(profile, { slot: 'frame', itemId: lockedFrame }).ok, false, 'no basta con que el id exista: debe estar desbloqueado');

  assert.equal(Passport.equipPassportCosmetic(profile, { slot: 'frame', itemId: null }).changed, true);
  assert.equal(profile.passport.equipped.frame, null);
});

test('el cambio de mes usa CASINO_TIME_ZONE, reinicia puntos/sellos y conserva la colección equipada', () => {
  const profile = newProfile('month-change');
  const octoberBeforeMidnight = new Date('2026-11-01T05:59:59.000Z');
  const novemberAtMidnight = new Date('2026-11-01T06:00:00.000Z');
  assert.equal(monthKey(octoberBeforeMidnight), '2026-10');
  assert.equal(monthKey(novemberAtMidnight), '2026-11');

  for (let round = 1; round <= 15; round++) {
    Passport.recordPassportRound(profile, { game: 'roulette', roundId: `month:${round}`, date: octoberBeforeMidnight });
  }
  const frameId = Catalog.makeCosmeticId('2026-10', 'frame-15');
  Passport.equipPassportCosmetic(profile, { slot: 'frame', itemId: frameId });

  assert.equal(Passport.ensurePassportSeason(profile, octoberBeforeMidnight), false);
  assert.equal(Passport.ensurePassportSeason(profile, novemberAtMidnight), true);
  assert.equal(profile.passport.currentSeason.key, '2026-11');
  assert.equal(profile.passport.currentSeason.points, 0);
  assert.deepEqual(profile.passport.currentSeason.games, []);
  assert.deepEqual(profile.passport.currentSeason.processedRoundIds, []);
  assert.ok(profile.passport.unlockedCosmetics.includes(frameId));
  assert.equal(profile.passport.equipped.frame, frameId);
});

test('BaseProfileStore renueva Pasaporte al inicio del mes local sin borrar cosméticos', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-passport-season-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
  t.after(() => clearTimeout(store.saveTimer));
  const profile = store.getOrCreate('season-boundary', 'Temporada');
  const badgeId = Catalog.makeCosmeticId('2026-10', 'season-badge');
  profile.passport.currentSeason = { key: '2026-10', points: 15, games: ['poker'], processedRoundIds: ['table:1'] };
  profile.passport.unlockedCosmetics = [badgeId];
  profile.passport.equipped.badge = badgeId;
  store.seasons.current = '2026-10';
  store._passportSeasonMonth = '2026-10';

  const beforeLocalMidnight = new Date('2026-11-01T05:59:59.000Z');
  const atLocalMidnight = new Date('2026-11-01T06:00:00.000Z');
  store.ensureSeason(beforeLocalMidnight);
  assert.equal(profile.passport.currentSeason.key, '2026-10');
  store.ensureSeason(atLocalMidnight);
  assert.equal(profile.passport.currentSeason.key, '2026-11');
  assert.equal(profile.passport.currentSeason.points, 0);
  assert.deepEqual(profile.passport.currentSeason.games, []);
  assert.deepEqual(profile.passport.currentSeason.processedRoundIds, []);
  assert.ok(profile.passport.unlockedCosmetics.includes(badgeId));
  assert.equal(profile.passport.equipped.badge, badgeId);
});

test('cleanProfile limita el historial idempotente y normaliza slots/inventario de forma cerrada', () => {
  const frameId = Catalog.makeCosmeticId('2026-10', 'frame-15');
  const badgeId = Catalog.makeCosmeticId('2026-10', 'season-badge');
  const profile = cleanProfile({
    id: 'normalize-passport',
    passport: {
      currentSeason: {
        key: '2026-10', points: '22.9',
        games: ['poker', 'poker', 'football', 'slots'],
        processedRoundIds: Array.from({ length: 160 }, (_, index) => `room:${index}`)
      },
      unlockedCosmetics: [frameId, frameId, badgeId, 'passport:2026-10:bad-item'],
      equipped: { frame: badgeId, title: frameId, badge: badgeId }
    }
  });

  assert.equal(profile.passport.currentSeason.points, 22);
  assert.deepEqual(profile.passport.currentSeason.games, ['poker', 'slots']);
  assert.equal(profile.passport.currentSeason.processedRoundIds.length, Catalog.MAX_PASSPORT_ROUND_IDS);
  assert.equal(profile.passport.unlockedCosmetics.length, 2);
  assert.equal(profile.passport.equipped.frame, null, 'el slot no coincide con la insignia');
  assert.equal(profile.passport.equipped.title, null, 'el título no puede ser un marco');
  assert.equal(profile.passport.equipped.badge, badgeId);
  assert.deepEqual(cleanProfile(JSON.parse(JSON.stringify(profile))).passport, profile.passport);

  const invalidMonth = cleanProfile({
    passport: { currentSeason: { key: 'no-es-mes', points: 999, games: ['poker'] } }
  });
  assert.equal(invalidMonth.passport.currentSeason.points, 0);
  assert.deepEqual(invalidMonth.passport.currentSeason.games, []);
});

test('archivo JSON y ProfileStore Postgres simulado preservan la misma forma de Pasaporte', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-passport-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seasonKey = monthKey();
  const cosmeticId = Catalog.makeCosmeticId(seasonKey, 'season-badge');

  const filePath = path.join(dir, 'profiles.json');
  const fileStore = new ProfileStore(filePath);
  const fileProfile = fileStore.getOrCreate('file-passport', 'Archivo');
  fileProfile.passport.unlockedCosmetics.push(cosmeticId);
  fileProfile.passport.equipped.badge = cosmeticId;
  fileProfile.passport.currentSeason.points = 5;
  fileProfile.passport.currentSeason.games = ['poker'];
  fileProfile.passport.currentSeason.processedRoundIds = ['room-persist:1'];
  fileStore.touch(fileProfile);
  fileStore.saveNow();
  clearTimeout(fileStore.saveTimer);
  const fileReload = new ProfileStore(filePath);
  t.after(() => clearTimeout(fileReload.saveTimer));
  assert.deepEqual(fileReload.getProfile('file-passport').passport, fileProfile.passport);

  const PoolOne = makeMockPgPoolClass();
  const pgStore = new PgProfileStore('postgres://mock-host/montecristo', { Pool: PoolOne });
  await pgStore.ready;
  t.after(() => pgStore.close());
  const pgProfile = pgStore.getOrCreate('pg-passport', 'Postgres');
  pgProfile.passport.unlockedCosmetics.push(cosmeticId);
  pgProfile.passport.equipped.badge = cosmeticId;
  pgProfile.passport.currentSeason.points = 5;
  pgProfile.passport.currentSeason.games = ['poker'];
  pgProfile.passport.currentSeason.processedRoundIds = ['room-persist:1'];
  pgStore.touch(pgProfile);
  await pgStore.saveNow();
  const saved = pgStore.pool.profileRows.find(row => row.data.id === 'pg-passport').data;
  const PoolTwo = makeMockPgPoolClass({ profiles: [saved], season: pgStore.pool.season });
  const pgReloadStore = new PgProfileStore('postgres://mock-host/montecristo', { Pool: PoolTwo });
  await pgReloadStore.ready;
  t.after(() => pgReloadStore.close());
  assert.deepEqual(pgReloadStore.getProfile('pg-passport').passport, fileReload.getProfile('file-passport').passport,
    'JSON y Postgres comparten el limpiador y la misma forma de datos');
});
