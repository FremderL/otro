'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanProfile } = require('../lib/profile-store-shared');
const {
  COSMETIC_ITEMS, ITEM_SLOTS, cleanCollection, evaluateCosmetics,
  publicCollection, publicCollectionIdentity, equipCosmetic
} = require('../lib/cosmetics');
const { recordOutcome } = require('../lib/progression');

function profile(overrides = {}) {
  return cleanProfile({
    id: 'cosmetic-player', name: 'Cosmetic', avatar: 'fox', chips: 1000,
    stats: { roundsPlayed: 0, wins: 0, losses: 0 }, gameStats: {}, gamesPlayed: [],
    ...overrides
  });
}

test('el catálogo contiene metas fijas para avatares animados y los cinco espacios cosméticos', () => {
  assert.ok(COSMETIC_ITEMS.length >= 10);
  assert.deepEqual(new Set(COSMETIC_ITEMS.map(item => item.slot)), new Set(ITEM_SLOTS));
  assert.ok(COSMETIC_ITEMS.filter(item => item.slot === 'avatar').every(item => item.art && item.animation));
  assert.ok(COSMETIC_ITEMS.every(item => item.goal?.target > 0 && item.goal?.description));
  assert.ok(COSMETIC_ITEMS.every(item => !Object.hasOwn(item, 'random') && !Object.hasOwn(item, 'price')));
});

test('una meta se desbloquea determinísticamente al alcanzar el objetivo y no entrega fichas', () => {
  const player = profile();
  player.stats.roundsPlayed = 10;
  const balance = player.chips;
  const unlocked = evaluateCosmetics(player);
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].id, 'avatar-phoenix');
  assert.deepEqual(evaluateCosmetics(player), []);
  assert.equal(publicCollection(player).items.find(item => item.id === 'avatar-phoenix').unlocked, true);
  assert.equal(player.chips, balance, 'desbloquear no entrega fichas');
});

test('metas por juego y variedad no cuentan fútbol ni progreso no elegible', () => {
  const player = profile();
  for (let index = 0; index < 5; index++) recordOutcome(player, { game: 'blackjack', net: 1, eligible: false, passportEligible: false, roundId: `bot-${index}` });
  assert.equal(player.collection.unlocked.includes('avatar-axolotl'), false, 'rondas no elegibles no desbloquean');
  for (let index = 0; index < 5; index++) recordOutcome(player, { game: 'blackjack', net: 1, eligible: true, passportEligible: false, roundId: `bj-${index}` });
  assert.equal(player.collection.unlocked.includes('avatar-axolotl'), true);
  player.gamesPlayed = ['poker', 'blackjack', 'roulette', 'dice', 'coinflip', 'football'];
  const explorer = COSMETIC_ITEMS.find(item => item.id === 'felt-aurora');
  const items = publicCollection(player).items;
  assert.equal(items.find(item => item.id === explorer.id).unlocked, false, 'Estadio/fútbol no sustituye a un juego de mesa');
  player.gamesPlayed.push('slots');
  assert.equal(publicCollection(player).items.find(item => item.id === explorer.id).unlocked, true);
});

test('el servidor solo permite equipar una pieza ya ganada en su espacio', () => {
  const player = profile();
  assert.equal(equipCosmetic(player, { slot: 'avatar', itemId: 'avatar-phoenix' }).ok, false);
  player.stats.roundsPlayed = 10;
  const equipped = equipCosmetic(player, { slot: 'avatar', itemId: 'avatar-phoenix' });
  assert.equal(equipped.ok, true);
  assert.equal(publicCollectionIdentity(player).equipped.avatar.id, 'avatar-phoenix');
  assert.equal(equipCosmetic(player, { slot: 'frame', itemId: 'avatar-phoenix' }).ok, false);
  assert.equal(equipCosmetic(player, { slot: 'avatar', itemId: null }).ok, true);
  assert.equal(publicCollectionIdentity(player).equipped.avatar, null);
});

test('el limpiador descarta ids desconocidos y equipamientos ajenos al catálogo', () => {
  const cleaned = cleanCollection({
    unlocked: ['avatar-phoenix', 'modded-item', 'avatar-phoenix'],
    equipped: { avatar: 'modded-item', frame: 'avatar-phoenix', chips: 'chips-ember' }
  });
  assert.deepEqual(cleaned.unlocked, ['avatar-phoenix']);
  assert.deepEqual(cleaned.equipped, { avatar: null, frame: null, chips: null, felt: null, cards: null });
});
