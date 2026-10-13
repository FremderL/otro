'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, INITIAL_CHIPS } = require('../lib/profile-store');
const { emptyClubTreasury, MAX_CLUB_MOVEMENT } = require('../lib/profile-store-base');

test('tesorería y fichas personales se guardan juntas, registran movimientos idempotentes y reinician en temporada', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'club-treasury-'));
  const filePath = path.join(directory, 'profiles.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const beforeReset = Date.parse('2026-10-15T18:00:00Z');
  const nextSeason = new Date('2026-11-15T12:00:00Z');
  const store = new ProfileStore(filePath, { deferSeasonCheck: true });
  const alice = store.getOrCreate('treasury-alice', 'Alicia');
  const bob = store.getOrCreate('treasury-bob', 'Roberto');
  alice.username = 'alice';
  bob.username = 'roberto';
  alice.chips = 1000;
  bob.chips = 250;
  store.seasons.current = '2026-10';
  store.seasons.clubTreasury = emptyClubTreasury('2026-10');
  store._passportSeasonMonth = '2026-10';

  const deposited = store.applyClubTreasuryMovement({
    clubId: 'club-test', type: 'deposit', amount: 300, actorId: alice.id,
    operationId: 'deposit-idempotency-001', now: beforeReset,
    validate: () => ({ ok: true, club: { name: 'Mesa Esmeralda' } })
  });
  assert.equal(deposited.ok, true);
  assert.equal(deposited.balance, 300);
  assert.equal(alice.chips, 700);
  assert.equal(alice.transactions.at(-1).amount, -300);
  assert.equal(alice.stats.wins, 0, 'los movimientos no cuentan como resultado de juego');
  assert.equal(store.getClubTreasury('club-test').seasonKey, '2026-10');

  const duplicate = store.applyClubTreasuryMovement({
    clubId: 'club-test', type: 'deposit', amount: 300, actorId: alice.id,
    operationId: 'deposit-idempotency-001', now: beforeReset,
    validate: () => ({ ok: true, club: { name: 'Mesa Esmeralda' } })
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(alice.chips, 700);
  assert.equal(store.getClubTreasuryBalance('club-test'), 300);
  assert.equal(store.applyClubTreasuryMovement({
    clubId: 'club-test', type: 'deposit', amount: 301, actorId: alice.id,
    operationId: 'deposit-idempotency-001', now: beforeReset,
    validate: () => ({ ok: true, club: { name: 'Mesa Esmeralda' } })
  }).code, 'idempotency_conflict');

  const transfer = store.applyClubTreasuryMovement({
    clubId: 'club-test', type: 'transfer', amount: 125, actorId: alice.id, targetId: bob.id,
    operationId: 'transfer-idempotency-001', note: 'Premio de temporada', now: beforeReset,
    validate: () => ({ ok: true, club: { name: 'Mesa Esmeralda' } })
  });
  assert.equal(transfer.ok, true);
  assert.equal(transfer.balance, 175);
  assert.equal(bob.chips, 375);
  assert.equal(bob.transactions.at(-1).amount, 125);
  assert.equal(store.getClubTreasury('club-test').movements.at(-1).note, 'Premio de temporada');

  assert.equal(store.applyClubTreasuryMovement({
    clubId: 'club-test', type: 'deposit', amount: MAX_CLUB_MOVEMENT + 1, actorId: alice.id,
    operationId: 'deposit-limit-0001', now: beforeReset,
    validate: () => ({ ok: true, club: { name: 'Mesa Esmeralda' } })
  }).code, 'amount_invalid');
  assert.equal(store.applyClubTreasuryMovement({
    clubId: 'club-test', type: 'transfer', amount: 200, actorId: alice.id, targetId: bob.id,
    operationId: 'transfer-overdraw-01', now: beforeReset,
    validate: () => ({ ok: true, club: { name: 'Mesa Esmeralda' } })
  }).code, 'treasury_insufficient');
  assert.equal(store.applyClubTreasuryMovement({
    clubId: 'club-test', type: 'deposit', amount: 1, actorId: bob.id,
    operationId: 'deposit-denied-0001', now: beforeReset,
    validate: () => ({ ok: false, code: 'not_club_member', error: 'denied' })
  }).code, 'not_club_member');

  await store.flushClubTreasury();
  const restored = new ProfileStore(filePath, { deferSeasonCheck: true });
  assert.equal(restored.getProfile(alice.id).chips, 700);
  assert.equal(restored.getProfile(bob.id).chips, 375);
  assert.equal(restored.getClubTreasuryBalance('club-test'), 175);
  assert.equal(restored.getClubTreasury('club-test').movements.length, 2);

  const closed = restored.ensureSeason(nextSeason);
  assert.equal(closed.type, 'closed');
  assert.equal(restored.seasons.current, '2026-11');
  assert.equal(restored.getProfile(alice.id).chips, INITIAL_CHIPS);
  assert.equal(restored.getProfile(bob.id).chips, INITIAL_CHIPS);
  assert.equal(restored.getClubTreasuryBalance('club-test'), 0);
  assert.equal(restored.getClubTreasury('club-test').seasonKey, '2026-11');
  assert.equal(restored.seasons.clubTreasury.history.at(-1).seasonKey, '2026-10');
  assert.deepEqual(restored.seasons.clubTreasury.history.at(-1).top, [{ clubId: 'club-test', balance: 175 }]);
  await restored.flushClubTreasury();
  clearTimeout(store.saveTimer);
  clearTimeout(restored.saveTimer);
});
