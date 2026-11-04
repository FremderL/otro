'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { FootballScheduler } = require('../lib/football/scheduler');
const { buildDailyEdition, dayKey, previousDay } = require('../lib/football/daily-news');
const { cleanDailyNewsState } = require('../lib/football/daily-news-state');
const { createDailyNewsService, RESERVATION_MS } = require('../lib/football/daily-news-service');
const { ProfileStore } = require('../lib/profile-store');

const OCT = '2026-10';
const NOW = Date.UTC(2026, 9, 15, 18); // 15 oct, 12:00 en America/Mexico_City
function temp(t, name = 'daily-news-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function setup(t) {
  const dir = temp(t);
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason(OCT);
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const profile = profiles.getOrCreate('daily-test-account', 'Aficionado');
  return { dir, store, league, profiles, profile };
}
function settle(league, index, at, score = { home: 2, away: 1 }) {
  const match = league.calendar.matches[index];
  match.scheduledKickoffAt = at - 20 * 60000;
  match.settledAt = at;
  match.status = 'settled';
  match.result = { ...score };
  return match;
}
function editionFor(store, at = NOW, operational = {}) {
  return buildDailyEdition({ league: store.getLeague(), leagues: [...store.leagues.values()], at, operational });
}
function serviceFor(ctx, options = {}) {
  return createDailyNewsService({ store: ctx.store, profiles: ctx.profiles, now: () => NOW,
    readiness: () => ({ ready: true }), ...options });
}

test('la edición diaria usa el día local, solo resultados asentados y fechas de juego distintas de recuperación', t => {
  const { store, league } = setup(t);
  const yesterday = Date.UTC(2026, 9, 14, 22);
  const first = settle(league, 0, yesterday);
  const second = settle(league, 1, yesterday + 60000, { home: 0, away: 0 });
  settle(league, 2, NOW + 60000); // todavía no puede aparecer
  const operational = { lastReadyDay: '2026-10-14', lastReadyAt: Date.UTC(2026, 9, 14, 6) };
  const a = editionFor(store, NOW, operational);
  const b = editionFor(store, NOW, operational);
  assert.deepEqual(a, b, 'mismos insumos producen la misma edición');
  assert.equal(a.id, 'daily:2026-10-15');
  assert.equal(dayKey(NOW), '2026-10-15');
  assert.equal(previousDay('2026-03-01'), '2026-02-28');
  assert.equal(a.mode, 'daily');
  assert.equal(a.coverage.availableResults, 2);
  assert.equal(a.coverage.selectedResults, 2);
  assert.ok(a.items.some(item => item.matchId === first.id));
  assert.ok(a.items.some(item => item.matchId === second.id));
  assert.ok(a.items.some(item => item.type === 'daily_table'));
  assert.ok(a.items.some(item => item.type === 'daily_agenda'));
  assert.ok(a.items.length <= 7 && a.script.length <= 9);
  assert.ok(a.scriptCharacters <= 1900);
  const result = a.items.find(item => item.matchId === first.id);
  assert.match(result.subtitle, /Jornada /);
  assert.equal(a.items.some(item => item.matchId === league.calendar.matches[2].id), false);
  assert.deepEqual(cleanDailyNewsState({ editions: { [a.day]: a }, operational }).editions[a.day], a);
});

test('día 15 integra el mercado anunciado real y explica la vigencia de los fichajes', t => {
  const { store } = setup(t);
  const edition = editionFor(store);
  assert.ok(edition.items.some(item => item.type === 'transfer_roundup'));
  assert.ok(edition.script.some(line => /fichajes anunciados/.test(line.text)));
  assert.match(edition.items.find(item => item.type === 'daily_agenda').headline, /15/);
});

test('larga interrupción: una sola edición de regreso con resultados recuperados, sin cola de días ni meses inventados', t => {
  const { store, league } = setup(t);
  const scheduled = Date.UTC(2026, 9, 2, 22);
  const recovered = settle(league, 0, NOW - 60000);
  recovered.scheduledKickoffAt = scheduled;
  const operational = { lastReadyDay: '2026-10-02', lastReadyAt: scheduled - 60000 };
  const edition = editionFor(store, NOW, operational);
  assert.equal(edition.mode, 'return');
  assert.equal(edition.coverage.gapDays, 13);
  assert.equal(edition.coverage.recoveredMatches, 1);
  assert.match(edition.headline, /Volvemos/);
  const item = edition.items.find(row => row.matchId === recovered.id);
  assert.match(item.subtitle, /Jornada /);
  assert.match(edition.script.map(line => line.text).join(' '), /resultados pendientes/);
  assert.equal(Object.keys(store.dailyNews.editions).length, 0, 'el constructor no crea una cola por sí solo');
  assert.deepEqual(store.getSeasonMonths(), [OCT]);
});

test('servicio serializa preparación, persiste una edición inmutable y sobrevive a reinicio', async t => {
  const ctx = setup(t);
  settle(ctx.league, 0, Date.UTC(2026, 9, 14, 22));
  const service = serviceFor(ctx);
  const [a, b] = await Promise.all([service.prepare(NOW), service.prepare(NOW)]);
  assert.equal(a.status, 'ready'); assert.equal(a.edition.id, b.edition.id);
  assert.deepEqual(a.edition, b.edition);
  const saved = JSON.parse(fs.readFileSync(ctx.store.filePath, 'utf8'));
  assert.equal(saved.dailyNews.editions['2026-10-15'].id, a.edition.id);
  assert.equal(saved.dailyNews.operational.lastReadyAt, NOW);
  await service.prepare(NOW + 3600000);
  assert.equal(Object.keys(ctx.store.dailyNews.editions).length, 1);
  const reloaded = new FootballStore(ctx.store.filePath);
  assert.deepEqual(reloaded.dailyNews, ctx.store.dailyNews);
  await serviceFor({ ...ctx, store: reloaded }).prepare(NOW + 7200000);
  assert.equal(Object.keys(reloaded.dailyNews.editions).length, 1);
});

test('readiness bloquea noticias antes de liquidar; fallo de disco no publica ni avanza la recuperación', async t => {
  const ctx = setup(t);
  let ready = false;
  const service = serviceFor(ctx, { readiness: () => ({ ready, reason: 'results_pending' }) });
  assert.equal((await service.prepare(NOW)).status, 'preparing');
  assert.deepEqual(ctx.store.dailyNews.editions, {});
  ready = true;
  const original = ctx.store.saveStrict.bind(ctx.store);
  ctx.store.saveStrict = () => { throw new Error('disk full'); };
  const failed = await service.prepare(NOW);
  assert.equal(failed.status, 'unavailable');
  assert.deepEqual(ctx.store.dailyNews.editions, {});
  assert.equal(ctx.store.dailyNews.operational.lastReadyAt, undefined);
  assert.equal(service.healthSnapshot().failures, 1);
  ctx.store.saveStrict = original;
  assert.equal((await service.prepare(NOW)).status, 'ready');
  assert.equal(Object.keys(ctx.store.dailyNews.editions).length, 1);
});

test('reserva por identidad y día: dos pestañas no presentan a la vez; acknowledge persiste y no se repite', async t => {
  const ctx = setup(t); const service = serviceFor(ctx);
  const { edition } = await service.prepare(NOW);
  const otherProfile = ctx.profiles.getOrCreate('other-account', 'Otra persona');
  const a = await service.reserve(ctx.profile, edition.id, 'socket-a', ctx.profiles.persistProfile.bind(ctx.profiles), NOW);
  const b = await service.reserve(ctx.profile, edition.id, 'socket-b', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 1);
  const other = await service.reserve(otherProfile, edition.id, 'socket-c', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 1);
  assert.equal(a.granted, true); assert.equal(b.granted, false); assert.equal(b.reason, 'reserved');
  assert.equal(other.granted, true, 'la edición es compartida; la presentación es por perfil');
  assert.equal((await service.acknowledge(ctx.profile, edition.id, 'socket-b', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 2)).ok, false);
  assert.equal((await service.acknowledge(ctx.profile, edition.id, 'socket-a', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 2)).ok, true);
  assert.equal(ctx.profile.flags.montecristoNewsDaily.lastPresentedDay, '2026-10-15');
  assert.equal(ctx.profile.flags.montecristoNewsDaily.reservation, null);
  assert.equal((await service.reserve(ctx.profile, edition.id, 'socket-a', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 3)).granted, false);
  assert.equal((await service.snapshot(ctx.profile, NOW)).shouldOpen, false);
  const reloaded = new ProfileStore(path.join(ctx.dir, 'profiles.json'));
  assert.equal(reloaded.getOrCreate(ctx.profile.id).flags.montecristoNewsDaily.lastPresentedDay, '2026-10-15');
  assert.equal((await service.acknowledge(otherProfile, edition.id, 'socket-c', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 3)).ok, true);
  const expiryProfile = ctx.profiles.getOrCreate('expiry-account', 'Expira');
  const expired = await service.reserve(expiryProfile, edition.id, 'socket-d', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 4);
  assert.equal(expired.granted, true);
  assert.equal((await service.reserve(expiryProfile, edition.id, 'socket-e', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + RESERVATION_MS + 5)).granted, true);
  assert.equal((await service.reserve(otherProfile, 'daily:2026-10-14', 'socket-e', ctx.profiles.persistProfile.bind(ctx.profiles), NOW + 6)).ok, false);
});

test('fallo al guardar marca de presentación revierte la reserva y permite reintento sin duplicar fichas ni resultados', async t => {
  const ctx = setup(t); const service = serviceFor(ctx);
  const { edition } = await service.prepare(NOW);
  const before = ctx.profile.chips;
  const persist = ctx.profiles.persistProfile.bind(ctx.profiles);
  ctx.profiles.persistProfile = async () => false;
  const denied = await service.reserve(ctx.profile, edition.id, 'socket-a', ctx.profiles.persistProfile.bind(ctx.profiles), NOW);
  assert.equal(denied.ok, false); assert.equal(denied.code, 'save_pending');
  assert.equal(ctx.profile.flags.montecristoNewsDaily, undefined);
  ctx.profiles.persistProfile = persist;
  assert.equal((await service.reserve(ctx.profile, edition.id, 'socket-a', ctx.profiles.persistProfile.bind(ctx.profiles), NOW)).granted, true);
  ctx.profiles.persistProfile = async () => false;
  assert.equal((await service.acknowledge(ctx.profile, edition.id, 'socket-a', ctx.profiles.persistProfile.bind(ctx.profiles), NOW)).code, 'save_pending');
  assert.equal(ctx.profile.flags.montecristoNewsDaily.lastPresentedDay, undefined);
  assert.equal(ctx.profile.chips, before);
});

test('scheduler vuelve tras diez días: liquida, genera solo el mes actual y prepara una edición, no diez', async t => {
  const ctx = setup(t);
  const wake = Date.UTC(2026, 9, 25, 18);
  for (const match of ctx.league.calendar.matches) {
    if (match.scheduledKickoffAt < wake - 3600000) {
      match.status = 'settled'; match.result = { home: 1, away: 0 }; match.settledAt = match.scheduledKickoffAt + 20 * 60000;
    }
  }
  const overdue = ctx.league.calendar.matches.find(match => match.status !== 'settled' && match.scheduledKickoffAt < wake - 3600000)
    || ctx.league.calendar.matches[0];
  overdue.status = 'scheduled'; overdue.result = null; overdue.settledAt = null;
  ctx.store.dailyNews.operational = { lastReadyDay: '2026-10-15', lastReadyAt: Date.UTC(2026, 9, 15, 18) };
  const engine = {
    store: ctx.store,
    reconcile: () => {}, repairOverdueMatches: () => {
      overdue.status = 'settled'; overdue.result = { home: 2, away: 1 }; overdue.settledAt = wake - 60000;
      return { errores: 0 };
    },
    ensureTodayScheduled: () => {},
    editorialReadiness: () => ({ ready: overdue.status === 'settled' })
  };
  const service = serviceFor(ctx, { now: () => wake, readiness: engine.editorialReadiness });
  const scheduler = new FootballScheduler(engine, { dailyNewsService: service });
  await scheduler.runSeasonSweep(wake);
  assert.equal(Object.keys(ctx.store.dailyNews.editions).length, 1);
  const edition = ctx.store.dailyNews.editions['2026-10-25'];
  assert.equal(edition.mode, 'return');
  assert.equal(edition.coverage.gapDays, 10);
  assert.ok(edition.coverage.recoveredMatches >= 1);
  await scheduler.runSeasonSweep(wake + 60000);
  assert.equal(Object.keys(ctx.store.dailyNews.editions).length, 1);
});

test('el sanitizador acota archivos y rechaza datos privados o ediciones con guion inválido', t => {
  const { store, league } = setup(t);
    settle(league, 0, NOW - 60000);
    const edition = editionFor(store);
    assert.equal(cleanDailyNewsState({ editions: { [edition.day]: { ...edition, script: [{ text: 'x'.repeat(1201) }] } } }).editions[edition.day], undefined);
    assert.equal(cleanDailyNewsState({ editions: { [edition.day]: { ...edition, privateSeed: 'secret' } } }).editions[edition.day], undefined);
    const many = {};
    for (let i = 1; i <= 60; i++) {
      const day = new Date(Date.UTC(2026, 6, i, 12)).toISOString().slice(0, 10);
      many[day] = { ...edition, day, id: `daily:${day}` };
    }
    const clean = cleanDailyNewsState({ editions: many });
    assert.equal(Object.keys(clean.editions).length, 45);
    assert.equal(clean.editions['2026-07-01'], undefined);
});
