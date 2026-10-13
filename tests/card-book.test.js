'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { blankCollection, cleanCollection, equipCosmetic, publicCollectionIdentity } = require('../lib/cosmetics');

function profile(counts = {}, collection = blankCollection()) {
  return { collection, cardAlbum: { counts }, stats: {}, gamesPlayed: [] };
}

test('una carta del álbum se puede equipar como dorso si el jugador la tiene', () => {
  const p = profile({ 'card-a-spades': 2 });
  const result = equipCosmetic(p, { slot: 'cards', itemId: 'album:card-a-spades' });
  assert.equal(result.ok, true);
  assert.equal(p.collection.equipped.cards, 'album:card-a-spades');
  assert.equal(result.item.art, '/assets/cards/card-a-spades.jpg');
});

test('no se puede equipar una carta que el jugador no tiene', () => {
  const p = profile({ 'card-a-spades': 1 });
  const result = equipCosmetic(p, { slot: 'cards', itemId: 'album:card-k-diamonds' });
  assert.equal(result.ok, false);
  assert.equal(p.collection.equipped.cards, null);
});

test('ids de álbum inventados o en otro espacio se rechazan', () => {
  const p = profile({ 'card-a-spades': 1 });
  assert.equal(equipCosmetic(p, { slot: 'cards', itemId: 'album:card-zz' }).ok, false);
  assert.equal(equipCosmetic(p, { slot: 'avatar', itemId: 'album:card-a-spades' }).ok, false);
});

test('la identidad pública publica el dorso con su ilustración solo si sigue siendo propiedad', () => {
  const p = profile({ 'card-q-hearts': 1 }, { unlocked: [], equipped: { ...blankCollection().equipped, cards: 'album:card-q-hearts' } });
  const back = publicCollectionIdentity(p).equipped.cards;
  assert.equal(back.style, 'album');
  assert.equal(back.art, '/assets/cards/card-q-hearts.jpg');
  const lost = profile({}, { unlocked: [], equipped: { ...blankCollection().equipped, cards: 'album:card-q-hearts' } });
  assert.equal(publicCollectionIdentity(lost).equipped.cards, null);
});

test('cleanCollection conserva solo ids de álbum válidos en el espacio de cartas', () => {
  const kept = cleanCollection({ equipped: { cards: 'album:card-10-clubs' } });
  assert.equal(kept.equipped.cards, 'album:card-10-clubs');
  const dropped = cleanCollection({ equipped: { cards: 'album:card-hack' } });
  assert.equal(dropped.equipped.cards, null);
});

test('quitar el dorso de álbum deja el espacio vacío', () => {
  const p = profile({ 'card-a-spades': 1 }, { unlocked: [], equipped: { ...blankCollection().equipped, cards: 'album:card-a-spades' } });
  const result = equipCosmetic(p, { slot: 'cards', itemId: null });
  assert.equal(result.ok, true);
  assert.equal(p.collection.equipped.cards, null);
});
