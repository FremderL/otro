'use strict';

// Gachapón de cartas («Cápsula del álbum»): catálogo cerrado de 54 cartas
// (52 de la baraja + 2 Jokers), tasas por rareza y sorteo autoritativo.
//
// Principios:
//   - Cosmético y virtual: una cápsula cuesta fichas, pero nunca entrega
//     fichas, multiplicadores ni ventajas en las mesas.
//   - Las tasas se publican tal cual en la interfaz (ver `publicCardAlbum`).
//   - Las tasas son enteros en unidades de 0,01 %: 10.000 unidades = 100 %.
//     Así la suma es exacta y no hay errores de coma flotante.
//   - Cada rareza reparte su tasa uniformemente entre sus cartas.

const crypto = require('node:crypto');

const CARD_GACHA_COST = 5;
const RARITY_UNITS_TOTAL = 10000; // 1 unidad = 0,01 %
const MAX_COPIES = 999;

// Orden de mayor a menor prevalencia: el sorteo recorre este arreglo.
const RARITIES = Object.freeze([
  { id: 'comun', name: 'Común', units: 8739 },       // 87,39 %: 2–5 (16 cartas) + el 7,39 % sobrante
  { id: 'poco-comun', name: 'Poco común', units: 1000 }, // 10 %: 6–9 (16 cartas)
  { id: 'raro', name: 'Raro', units: 200 },          // 2 %: 10 y J (8 cartas)
  { id: 'epico', name: 'Épico', units: 50 },         // 0,5 %: Jokers (2 cartas)
  { id: 'legendario', name: 'Legendario', units: 10 }, // 0,1 %: Q y K (8 cartas)
  { id: 'mitico', name: 'Mítico', units: 1 }          // 0,01 %: As (4 cartas)
]);
const RARITY_BY_ID = new Map(RARITIES.map(rarity => [rarity.id, rarity]));

const SUITS = Object.freeze({
  spades: { key: 'spades', name: 'Picas', symbol: '♠' },
  hearts: { key: 'hearts', name: 'Corazones', symbol: '♥' },
  diamonds: { key: 'diamonds', name: 'Diamantes', symbol: '♦' },
  clubs: { key: 'clubs', name: 'Tréboles', symbol: '♣' }
});

// Un motivo visual por rango. Combinado con el palo (color) y la rareza
// (marco y brillo) da una combinación distinta para cada una de las 52 cartas.
const RANKS = Object.freeze([
  { rank: '2', slug: '2', name: 'Dos', rarity: 'comun', motif: 'orbit' },
  { rank: '3', slug: '3', name: 'Tres', rarity: 'comun', motif: 'waves' },
  { rank: '4', slug: '4', name: 'Cuatro', rarity: 'comun', motif: 'lattice' },
  { rank: '5', slug: '5', name: 'Cinco', rarity: 'comun', motif: 'stripes' },
  { rank: '6', slug: '6', name: 'Seis', rarity: 'poco-comun', motif: 'rings' },
  { rank: '7', slug: '7', name: 'Siete', rarity: 'poco-comun', motif: 'stars' },
  { rank: '8', slug: '8', name: 'Ocho', rarity: 'poco-comun', motif: 'chevrons' },
  { rank: '9', slug: '9', name: 'Nueve', rarity: 'poco-comun', motif: 'facets' },
  { rank: '10', slug: '10', name: 'Diez', rarity: 'raro', motif: 'sunburst' },
  { rank: 'J', slug: 'j', name: 'Jota', rarity: 'raro', motif: 'shield' },
  { rank: 'Q', slug: 'q', name: 'Reina', rarity: 'legendario', motif: 'crown' },
  { rank: 'K', slug: 'k', name: 'Rey', rarity: 'legendario', motif: 'crossed' },
  { rank: 'A', slug: 'a', name: 'As', rarity: 'mitico', motif: 'aurora' }
]);

const SUIT_ORDER = Object.freeze(['spades', 'hearts', 'diamonds', 'clubs']);

function buildCatalog() {
  const cards = [];
  for (const suitKey of SUIT_ORDER) {
    const suit = SUITS[suitKey];
    for (const rank of RANKS) {
      cards.push({
        id: `card-${rank.slug}-${suit.key}`,
        rank: rank.rank,
        name: `${rank.name} de ${suit.name.toLowerCase()}`,
        suit: suit.key,
        suitName: suit.name,
        symbol: suit.symbol,
        rarity: rank.rarity,
        motif: rank.motif
      });
    }
  }
  // Jokers: no pertenecen a un palo; cada uno tiene su propio motivo.
  cards.push(
    { id: 'card-joker-fuego', rank: 'JOKER', name: 'Joker Fuego', suit: 'joker', suitName: 'Joker', symbol: '★', rarity: 'epico', motif: 'joker-fuego' },
    { id: 'card-joker-abismo', rank: 'JOKER', name: 'Joker Abismo', suit: 'joker', suitName: 'Joker', symbol: '★', rarity: 'epico', motif: 'joker-abismo' }
  );
  return Object.freeze(cards.map(card => Object.freeze(card)));
}

const CARD_CATALOG = buildCatalog();
const CARD_BY_ID = new Map(CARD_CATALOG.map(card => [card.id, card]));
const CARDS_BY_RARITY = new Map(RARITIES.map(rarity => [
  rarity.id,
  CARD_CATALOG.filter(card => card.rarity === rarity.id)
]));

// Tasa por rareza y por carta, para mostrar en la interfaz.
function publicRates() {
  return RARITIES.map(rarity => {
    const cards = CARDS_BY_RARITY.get(rarity.id) || [];
    return {
      id: rarity.id,
      name: rarity.name,
      percent: rarity.units / 100,
      cards: cards.length,
      perCardPercent: rarity.units / cards.length / 100
    };
  });
}

// `random(n)` devuelve un entero uniforme en [0, n). Por defecto usa el CSPRNG
// del sistema; los tests inyectan un generador determinista.
function rollRarity(random = crypto.randomInt) {
  const roll = random(RARITY_UNITS_TOTAL);
  let accumulated = 0;
  for (const rarity of RARITIES) {
    accumulated += rarity.units;
    if (roll < accumulated) return rarity;
  }
  return RARITIES[RARITIES.length - 1];
}

function rollCard(random = crypto.randomInt) {
  const rarity = rollRarity(random);
  const pool = CARDS_BY_RARITY.get(rarity.id);
  return pool[random(pool.length)];
}

// Solo se guardan ids del catálogo con copias positivas. Cualquier otro valor
// (ids inventados, cantidades negativas o no numéricas) se descarta.
function cleanCardAlbum(raw) {
  const source = raw && typeof raw === 'object' && raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)
    ? raw.counts
    : {};
  const counts = {};
  for (const id of Object.keys(source)) {
    if (!CARD_BY_ID.has(id)) continue;
    const copies = Math.floor(Number(source[id]));
    if (copies > 0) counts[id] = Math.min(MAX_COPIES, copies);
  }
  return { counts };
}

function publicCard(card, count = 0) {
  const rarity = RARITY_BY_ID.get(card.rarity);
  return {
    id: card.id,
    rank: card.rank,
    name: card.name,
    suit: card.suit,
    suitName: card.suitName,
    symbol: card.symbol,
    rarity: card.rarity,
    rarityName: rarity?.name || card.rarity,
    motif: card.motif,
    count
  };
}

// Álbum del dueño del perfil. Incluye el catálogo completo (es público en el
// código) y el número de copias de cada carta; las cartas sin copias las
// oculta la interfaz.
function publicCardAlbum(profile) {
  const counts = profile?.cardAlbum?.counts || {};
  const cards = CARD_CATALOG.map(card => publicCard(card, counts[card.id] || 0));
  return {
    cost: CARD_GACHA_COST,
    rates: publicRates(),
    cards,
    ownedCount: cards.filter(card => card.count > 0).length,
    total: cards.length,
    duplicates: cards.reduce((sum, card) => sum + Math.max(0, card.count - 1), 0)
  };
}

module.exports = {
  CARD_GACHA_COST,
  MAX_COPIES,
  RARITY_UNITS_TOTAL,
  RARITIES,
  SUITS,
  RANKS,
  CARD_CATALOG,
  CARD_BY_ID,
  rollRarity,
  rollCard,
  publicRates,
  cleanCardAlbum,
  publicCard,
  publicCardAlbum
};
