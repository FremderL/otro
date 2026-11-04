'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../lib/profile-store');
const { FootballStore } = require('../lib/football-store');
const { FileDeviceLinkStore } = require('../lib/device-links');
const { GuestImportService, mergeProfiles } = require('../lib/guest-import');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-import-'));
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const footballStore = new FootballStore(path.join(dir, 'football.json'));
  const deviceLinks = new FileDeviceLinkStore(path.join(dir, 'links.json'));
  const account = profiles.getOrCreate('account-1', 'Cuenta');
  profiles.registerAccount(account, 'cuenta_uno', 'password-segura-123');
  account.chips = 1000;
  const guest = profiles.getOrCreate('guest-token-1', 'Invitado');
  guest.chips = 750;
  guest.achievements = ['first_win'];
  const service = new GuestImportService({ profiles, footballStore, deviceLinks, now: () => 5000 });
  return { dir, profiles, footballStore, deviceLinks, account, guest, service };
}

test('la vista previa exige confirmación y la importación es idempotente', async () => {
  const ctx = setup();
  const preview = ctx.service.inspect(ctx.account.id, ctx.guest.id);
  assert.equal(preview.available, true);
  assert.equal(preview.resultingChips, 1750);
  const denied = await ctx.service.import({ accountId: ctx.account.id, guestToken: ctx.guest.id, operationId: 'op-1234567890abcdef', version: 'stale' });
  assert.equal(denied.code, 'preview_stale');
  const result = await ctx.service.import({ accountId: ctx.account.id, guestToken: ctx.guest.id, operationId: 'op-1234567890abcdef', version: preview.version });
  assert.equal(result.ok, true);
  assert.equal(ctx.account.chips, 1750);
  assert.equal(ctx.guest.chips, 0);
  assert.equal(ctx.guest.mergedInto, ctx.account.id);
  const replay = await ctx.service.import({ accountId: ctx.account.id, guestToken: ctx.guest.id, operationId: 'op-1234567890abcdef', version: preview.version });
  assert.equal(replay.replayed, true);
  assert.equal(ctx.account.chips, 1750);
  ctx.footballStore.close();
});

test('los boletos abiertos cambian de dueño conservando id y estado', async () => {
  const ctx = setup();
  ctx.footballStore.bets.set('bet-1', { id: 'bet-1', profileId: ctx.guest.id, status: 'open', stake: 100, market: '1x2', selection: 'home', matchId: 'm1' });
  const preview = ctx.service.inspect(ctx.account.id, ctx.guest.id);
  assert.equal(preview.guest.bets, 1);
  await ctx.service.import({ accountId: ctx.account.id, guestToken: ctx.guest.id, operationId: 'op-1234567890abcdef', version: preview.version });
  assert.equal(ctx.footballStore.bets.get('bet-1').profileId, ctx.account.id);
  assert.equal(ctx.footballStore.bets.get('bet-1').status, 'open');
  ctx.footballStore.close();
});

test('un conflicto de mercado bloquea la importación sin tocar saldos', async () => {
  const ctx = setup();
  ctx.footballStore.bets.set('bet-1', { id: 'bet-1', profileId: ctx.guest.id, status: 'open', market: '1x2', selection: 'home', matchId: 'm1' });
  ctx.footballStore.bets.set('bet-2', { id: 'bet-2', profileId: ctx.account.id, status: 'open', market: '1x2', selection: 'home', matchId: 'm1' });
  const preview = ctx.service.inspect(ctx.account.id, ctx.guest.id);
  assert.equal(preview.available, false);
  assert.ok(preview.blockers.includes('duplicate_bets'));
  const result = await ctx.service.import({ accountId: ctx.account.id, guestToken: ctx.guest.id, operationId: 'op-1234567890abcdef', version: preview.version });
  assert.equal(result.ok, false);
  assert.equal(ctx.account.chips, 1000);
  assert.equal(ctx.guest.chips, 750);
  ctx.footballStore.close();
});

test('el diario de archivo recupera una importación interrumpida tras transferir boletos', async () => {
  const ctx = setup();
  ctx.footballStore.bets.set('bet-1', { id: 'bet-1', profileId: ctx.guest.id, status: 'open', stake: 100 });
  const merged = mergeProfiles(ctx.account, ctx.guest, { operationId: 'op-1234567890abcdef', now: 5000 });
  ctx.profiles.importJournal = { account: merged.account, source: merged.source, operationId: 'op-1234567890abcdef' };
  assert.equal(ctx.profiles.saveNow(), true);
  await ctx.footballStore.reassignProfile(ctx.guest.id, ctx.account.id);
  // Crash simulado: el saldo aún no se fusionó en perfiles.
  const reopened = new ProfileStore(path.join(ctx.dir, 'profiles.json'));
  assert.ok(reopened.importJournal);
  const service = new GuestImportService({ profiles: reopened, footballStore: ctx.footballStore, deviceLinks: ctx.deviceLinks });
  await service.recover();
  assert.equal(reopened.getProfile(ctx.account.id).chips, 1750);
  assert.equal(reopened.getProfile(ctx.guest.id).chips, 0);
  assert.equal(reopened.importJournal, null);
  ctx.footballStore.close();
});

test('las operaciones pendientes bloquean la importación', () => {
  const ctx = setup();
  ctx.guest.footballPendingStakes = ['football:bet:stake:abc'];
  const preview = ctx.service.inspect(ctx.account.id, ctx.guest.id);
  assert.equal(preview.available, false);
  assert.ok(preview.blockers.includes('pending_settlement'));
  ctx.footballStore.close();
});
