'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const {
  CARD_GACHA_COST, CARD_DUPLICATE_CHIPS, MAX_COPIES, RARITY_UNITS_TOTAL, RARITIES, CARD_CATALOG, CARD_BY_ID,
  rollRarity, rollCard, publicRates, cleanCardAlbum, publicCardAlbum
} = require('../lib/card-gacha');
const { cleanProfile } = require('../lib/profile-store-shared');
const { openCardCapsule, publicProgress } = require('../lib/progression');

function profile(overrides = {}) {
  return cleanProfile({
    id: 'gacha-player', name: 'Gacha', avatar: 'fox', chips: 100,
    stats: { roundsPlayed: 0, wins: 0, losses: 0 }, gameStats: {}, gamesPlayed: [],
    ...overrides
  });
}

// Generador determinista: devuelve siempre el mismo valor (acotado a n).
const fixed = value => n => Math.min(value, n - 1);

test('el catálogo tiene 54 cartas únicas: 52 de la baraja y 2 Jokers', () => {
  assert.equal(CARD_CATALOG.length, 54);
  assert.equal(new Set(CARD_CATALOG.map(card => card.id)).size, 54);
  assert.equal(CARD_CATALOG.filter(card => card.suit === 'joker').length, 2);
  const standard = CARD_CATALOG.filter(card => card.suit !== 'joker');
  assert.equal(new Set(standard.map(card => `${card.suit}-${card.rank}`)).size, 52);
});

test('cada carta tiene una combinación visual distinta (palo + motivo) y todas tienen rareza', () => {
  const looks = CARD_CATALOG.map(card => `${card.suit}|${card.motif}`);
  assert.equal(new Set(looks).size, CARD_CATALOG.length, 'no hay dos cartas con el mismo estilo');
  assert.ok(CARD_CATALOG.every(card => RARITIES.some(rarity => rarity.id === card.rarity)));
});

test('las rarezas se asignan exactamente como se acordó', () => {
  const rarityOf = rank => CARD_CATALOG.find(card => card.rank === rank && card.suit === 'spades').rarity;
  for (const rank of ['2', '3', '4', '5']) assert.equal(rarityOf(rank), 'comun');
  for (const rank of ['6', '7', '8', '9']) assert.equal(rarityOf(rank), 'poco-comun');
  for (const rank of ['10', 'J']) assert.equal(rarityOf(rank), 'raro');
  for (const rank of ['Q', 'K']) assert.equal(rarityOf(rank), 'legendario');
  assert.equal(rarityOf('A'), 'mitico');
  assert.ok(CARD_CATALOG.filter(card => card.suit === 'joker').every(card => card.rarity === 'epico'));
});

test('las tasas suman exactamente 100 % y cada rareza coincide con sus cartas', () => {
  assert.equal(RARITY_UNITS_TOTAL, 10000);
  assert.equal(RARITIES.reduce((sum, rarity) => sum + rarity.units, 0), RARITY_UNITS_TOTAL);
  const rates = publicRates();
  assert.equal(rates.reduce((sum, rate) => sum + rate.percent, 0).toFixed(2), '100.00');
  const byId = Object.fromEntries(rates.map(rate => [rate.id, rate]));
  assert.equal(byId.comun.percent, 87.39);
  assert.equal(byId['poco-comun'].percent, 10);
  assert.equal(byId.raro.percent, 2);
  assert.equal(byId.epico.percent, 0.5);
  assert.equal(byId.legendario.percent, 0.1);
  assert.equal(byId.mitico.percent, 0.01);
  for (const rate of rates) {
    const count = CARD_CATALOG.filter(card => card.rarity === rate.id).length;
    assert.equal(rate.cards, count);
    assert.ok(Math.abs(rate.perCardPercent * count - rate.percent) < 1e-9);
  }
});

test('el sorteo reparte exactamente las unidades de cada rareza (enumeración completa)', () => {
  const counts = Object.fromEntries(RARITIES.map(rarity => [rarity.id, 0]));
  for (let roll = 0; roll < RARITY_UNITS_TOTAL; roll++) {
    counts[rollRarity(() => roll).id]++;
  }
  for (const rarity of RARITIES) assert.equal(counts[rarity.id], rarity.units, rarity.id);
});

test('rollCard elige una carta de la rareza sorteada, con los extremos esperados', () => {
  assert.equal(rollRarity(fixed(0)).id, 'comun');
  assert.equal(rollRarity(fixed(RARITY_UNITS_TOTAL - 1)).id, 'mitico');
  assert.equal(rollCard(fixed(RARITY_UNITS_TOTAL - 1)).rank, 'A');
  const common = rollCard(fixed(0));
  assert.equal(common.rarity, 'comun');
  // Los límites del sorteo: 9998 cae en Legendario y 9999 (último) en Mítico.
  assert.equal(rollCard(fixed(RARITY_UNITS_TOTAL - 2)).rarity, 'legendario');
  for (let roll = 0; roll < RARITY_UNITS_TOTAL; roll += 97) {
    const card = rollCard(n => (n === RARITY_UNITS_TOTAL ? roll : 0));
    assert.equal(card.rarity, rollRarity(() => roll).id);
  }
});

test('cleanCardAlbum descarta ids inventados, cantidades inválidas y limita las copias', () => {
  const album = cleanCardAlbum({
    counts: { 'card-a-hearts': 3, 'card-hack': 9, 'card-2-spades': -4, 'card-10-clubs': 'x', 'card-joker-fuego': 1e9 }
  });
  assert.deepEqual(album, { counts: { 'card-a-hearts': 3, 'card-joker-fuego': MAX_COPIES } });
  assert.deepEqual(cleanCardAlbum(null), { counts: {} });
  assert.deepEqual(cleanCardAlbum({ counts: [1, 2] }), { counts: {} });
});

test('una cápsula cobra 5.000 fichas, suma una copia y registra el movimiento', () => {
  const player = profile({ chips: 20000 });
  const result = openCardCapsule(player, { random: fixed(RARITY_UNITS_TOTAL - 1) });
  assert.equal(result.ok, true);
  assert.ok(CARD_BY_ID.has(result.card.id));
  assert.equal(result.card.rarity, 'mitico');
  assert.equal(result.card.count, 1);
  assert.equal(result.duplicate, false);
  assert.equal(result.chips, 20000 - CARD_GACHA_COST);
  assert.equal(player.cardAlbum.counts[result.card.id], 1);
  assert.equal(player.transactions.at(-1).amount, -CARD_GACHA_COST);
});

test('una carta repetida suma copias, se marca como duplicada y abona 100 fichas', () => {
  const player = profile({ chips: 20000 });
  const first = openCardCapsule(player, { random: fixed(0) });
  const second = openCardCapsule(player, { random: fixed(0) });
  assert.equal(first.card.id, second.card.id);
  assert.equal(second.duplicate, true);
  assert.equal(second.card.count, 2);
  assert.equal(player.chips, 20000 - 2 * CARD_GACHA_COST + CARD_DUPLICATE_CHIPS);
});

test('la primera copia de una carta no abona fichas; la repetida sí, por CARD_DUPLICATE_CHIPS', () => {
  assert.equal(CARD_DUPLICATE_CHIPS, 100);
  const player = profile({ chips: 20000 });
  const first = openCardCapsule(player, { random: fixed(0) });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.refundChips, 0);
  assert.equal(first.chips, 20000 - CARD_GACHA_COST, 'la primera copia solo cobra');
  assert.equal(player.cardAlbum.counts[first.card.id], 1);

  const second = openCardCapsule(player, { random: fixed(0) });
  assert.equal(second.duplicate, true);
  assert.equal(second.refundChips, CARD_DUPLICATE_CHIPS);
  assert.equal(second.card.count, 2);
  assert.equal(second.chips, 20000 - 2 * CARD_GACHA_COST + CARD_DUPLICATE_CHIPS);
  assert.equal(player.chips, second.chips, 'el saldo devuelto es el del perfil');
});

test('cobro y abono quedan en el historial como movimientos separados y en orden', () => {
  const player = profile({ chips: 20000 });
  openCardCapsule(player, { random: fixed(0) });
  const beforeDuplicate = player.transactions.length;
  const result = openCardCapsule(player, { random: fixed(0) });
  const added = player.transactions.slice(beforeDuplicate);
  assert.equal(added.length, 2, 'una cápsula repetida registra exactamente dos movimientos');
  assert.equal(added[0].reason, 'Cápsula de cartas');
  assert.equal(added[0].amount, -CARD_GACHA_COST);
  assert.equal(added[1].reason, `Carta repetida: ${result.card.name}`);
  assert.equal(added[1].amount, CARD_DUPLICATE_CHIPS);
  assert.equal(player.transactions.filter(entry => entry.reason === 'Cápsula de cartas').length, 2);
});

test('una copia repetida con la carta ya en MAX_COPIES también abona 100 y no supera el límite', () => {
  const player = profile({ chips: 20000, cardAlbum: { counts: { [CARD_CATALOG[0].id]: MAX_COPIES } } });
  const result = openCardCapsule(player, { random: fixed(0) });
  assert.equal(result.card.id, CARD_CATALOG[0].id);
  assert.equal(result.duplicate, true);
  assert.equal(result.refundChips, CARD_DUPLICATE_CHIPS);
  assert.equal(result.card.count, MAX_COPIES);
  assert.equal(player.cardAlbum.counts[CARD_CATALOG[0].id], MAX_COPIES);
  assert.equal(player.chips, 20000 - CARD_GACHA_COST + CARD_DUPLICATE_CHIPS);
});

test('el saldo tras varias cápsulas: −5.000 por cada una y +100 por cada repetida', () => {
  const start = 50000;
  const player = profile({ chips: start });
  const pulls = 5;
  for (let i = 0; i < pulls; i++) openCardCapsule(player, { random: fixed(0) });
  // 1 primera copia + 4 repetidas: costo neto 5 × 5.000 − 4 × 100 = 24.600.
  assert.equal(player.chips, start - pulls * CARD_GACHA_COST + (pulls - 1) * CARD_DUPLICATE_CHIPS);
  assert.equal(player.chips, start - 24600);
  const sum = player.transactions.reduce((total, entry) => total + entry.amount, 0);
  assert.equal(sum, player.chips - start, 'el historial cuadra con el saldo');
});

test('una cápsula con saldo insuficiente no abona nada aunque la carta fuera repetida', () => {
  const player = profile({ chips: CARD_GACHA_COST - 1, cardAlbum: { counts: { [CARD_CATALOG[0].id]: 1 } } });
  const before = JSON.stringify(player.cardAlbum);
  const denied = openCardCapsule(player, { random: fixed(0) });
  assert.equal(denied.ok, false);
  assert.equal(denied.refundChips, undefined);
  assert.equal(player.chips, CARD_GACHA_COST - 1);
  assert.equal(JSON.stringify(player.cardAlbum), before);
  assert.equal(player.transactions.length, 0);
});

test('sin fichas suficientes o con el gachapón apagado no se cobra ni se sortea nada', () => {
  const broke = profile({ chips: CARD_GACHA_COST - 1 });
  const before = JSON.stringify(broke.cardAlbum);
  const denied = openCardCapsule(broke, { random: fixed(0) });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'insufficient_chips');
  assert.equal(broke.chips, CARD_GACHA_COST - 1);
  assert.equal(JSON.stringify(broke.cardAlbum), before);

  const off = profile({ chips: 50 });
  const disabled = openCardCapsule(off, { random: fixed(0), enabled: false });
  assert.equal(disabled.code, 'disabled');
  assert.equal(off.chips, 50);
  assert.deepEqual(off.cardAlbum.counts, {});
});

test('el álbum sobrevive al guardado (cleanProfile) y solo el dueño recibe el detalle', () => {
  const player = profile({ chips: 20000, cardAlbum: { counts: { 'card-k-hearts': 2, 'card-zz': 4 } } });
  assert.deepEqual(player.cardAlbum, { counts: { 'card-k-hearts': 2 } });
  const owner = publicProgress(player, true);
  assert.equal(owner.cardAlbum.ownedCount, 1);
  assert.equal(owner.cardAlbum.total, 54);
  assert.equal(owner.cardAlbum.duplicates, 1);
  assert.equal(owner.cardAlbum.cards.find(card => card.id === 'card-k-hearts').count, 2);
  assert.equal(owner.cardAlbum.cost, CARD_GACHA_COST);
  assert.equal(owner.cardAlbum.rates.length, RARITIES.length);
  const publicView = publicProgress(player, false);
  assert.equal(publicView.cardAlbum, undefined);
});

test('cada carta indica su ilustración: las 54 tienen archivo y apuntan a su ruta', () => {
  const album = publicCardAlbum({});
  const spadesJ = album.cards.find(card => card.id === 'card-j-spades');
  assert.equal(spadesJ.art, '/assets/cards/card-j-spades.jpg');
  for (const card of album.cards) {
    assert.equal(card.art, `/assets/cards/${card.id}.jpg`, `falta la ilustración de ${card.id}`);
  }
});

test('publicCardAlbum funciona para perfiles nuevos sin álbum', () => {
  const album = publicCardAlbum({});
  assert.equal(album.ownedCount, 0);
  assert.equal(album.cards.length, CARD_BY_ID.size);
});

test('la interfaz tiene la pestaña, la sección del álbum y el enlace a su hoja de estilos', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'card-album.css'), 'utf8');
  const dom = new JSDOM(html);
  const { document } = dom.window;
  assert.ok(document.getElementById('profile-tab-album'));
  assert.ok(document.getElementById('profile-section-album'));
  assert.equal(document.querySelector('[data-profile-section="album"]'), null);
  assert.ok(document.getElementById('album-open-capsule'));
  assert.ok(document.querySelector('link[href="/card-album.css"]'));
  assert.ok(app.includes("'card_gacha_pull'"));
  assert.ok(RARITIES.every(rarity => css.includes(`.rarity-${rarity.id}`)), 'cada rareza tiene estilo');
  dom.window.close();
});

test('la sesión de cuenta del lobby conserva el álbum (cardAlbum en la caché)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const block = app.slice(app.indexOf('const ACCOUNT_SESSION_FIELDS = ['), app.indexOf('];', app.indexOf('const ACCOUNT_SESSION_FIELDS = [')));
  assert.ok(block.includes("'cardAlbum'"));
});

test('la cápsula no altera fichas en mesa ni estadísticas de juego', () => {
  const player = profile({ chips: 20000, stats: { roundsPlayed: 4, wins: 2 } });
  openCardCapsule(player, { random: fixed(0) });
  assert.equal(player.stats.roundsPlayed, 4);
  assert.equal(player.stats.wins, 2);
  assert.equal(player.chips, 20000 - CARD_GACHA_COST);
  assert.ok(!player.achievements.length);
});
