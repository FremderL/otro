'use strict';

const { CARD_BY_ID, publicCard } = require('./card-gacha');

// Dorso de cartas tomado del álbum del gachapón: `album:<id de carta>`.
const ALBUM_BACK_PREFIX = 'album:';

const GAME_IDS = Object.freeze(['poker', 'blackjack', 'roulette', 'dice', 'coinflip', 'slots']);
const GAME_NAMES = Object.freeze({
  poker: 'Texas Hold’em', blackjack: 'Blackjack', roulette: 'Ruleta',
  dice: 'Dados', coinflip: 'Cara o Cruz', slots: 'Tragamonedas'
});

const COSMETIC_ITEMS = Object.freeze([
  {
    id: 'avatar-phoenix', slot: 'avatar', category: 'avatar', name: 'Fénix de obsidiana',
    description: 'Un guardián encendido para tu identidad.', icon: '✦', art: '/assets/cosmetics/avatars/phoenix.svg',
    style: 'phoenix', animation: 'float', goal: { kind: 'rounds_total', target: 10, description: 'Completa 10 rondas válidas en cualquier juego.' }
  },
  {
    id: 'avatar-axolotl', slot: 'avatar', category: 'avatar', name: 'Axolote lunar',
    description: 'Un compañero sereno que nada entre estrellas.', icon: '☾', art: '/assets/cosmetics/avatars/axolotl.svg',
    style: 'axolotl', animation: 'float', goal: { kind: 'game_wins', game: 'blackjack', target: 5, description: 'Gana 5 rondas de Blackjack.' }
  },
  {
    id: 'avatar-nebula', slot: 'avatar', category: 'avatar', name: 'Nébula',
    description: 'Polvo estelar en movimiento.', icon: '✧', art: '/assets/cosmetics/avatars/nebula.svg',
    style: 'nebula', animation: 'orbit', goal: { kind: 'wins_total', target: 25, description: 'Gana 25 rondas en cualquier juego.' }
  },
  {
    id: 'frame-obsidian', slot: 'frame', category: 'frame', name: 'Borde de obsidiana',
    description: 'Un marco mineral con destellos verdes.', icon: '⬡', style: 'obsidian',
    goal: { kind: 'game_rounds', game: 'poker', target: 10, description: 'Completa 10 rondas válidas de Texas Hold’em.' }
  },
  {
    id: 'frame-starlight', slot: 'frame', category: 'frame', name: 'Halo estelar',
    description: 'Una línea de luz dorada para tu perfil.', icon: '✦', style: 'starlight',
    goal: { kind: 'wins_total', target: 15, description: 'Gana 15 rondas en cualquier juego.' }
  },
  {
    id: 'chips-ember', slot: 'chips', category: 'chips', name: 'Fichas brasa',
    description: 'Fichas con acentos de cobre y fuego.', icon: '◉', style: 'ember',
    goal: { kind: 'game_rounds', game: 'slots', target: 10, description: 'Completa 10 rondas válidas de Tragamonedas.' }
  },
  {
    id: 'chips-tide', slot: 'chips', category: 'chips', name: 'Fichas marea',
    description: 'Un acabado frío inspirado en el océano.', icon: '◉', style: 'tide',
    goal: { kind: 'game_wins', game: 'dice', target: 10, description: 'Gana 10 rondas de Dados.' }
  },
  {
    id: 'felt-aurora', slot: 'felt', category: 'felt', name: 'Tapete aurora',
    description: 'Ondas turquesa y violeta recorren la mesa.', icon: '⌁', style: 'aurora',
    goal: { kind: 'games_variety', target: GAME_IDS.length, description: 'Completa una ronda válida en cada uno de los 6 juegos de mesa.' }
  },
  {
    id: 'felt-emerald', slot: 'felt', category: 'felt', name: 'Paño esmeralda',
    description: 'Un paño profundo con líneas de jade.', icon: '⌁', style: 'emerald',
    goal: { kind: 'game_rounds', game: 'poker', target: 25, description: 'Completa 25 rondas válidas de Texas Hold’em.' }
  },
  {
    id: 'cards-royal', slot: 'cards', category: 'cards', name: 'Dorso real',
    description: 'Un patrón geométrico de oro y tinta.', icon: '▤', style: 'royal',
    goal: { kind: 'game_wins', game: 'poker', target: 5, description: 'Gana 5 rondas de Texas Hold’em.' }
  },
  {
    id: 'cards-cosmos', slot: 'cards', category: 'cards', name: 'Dorso cosmos',
    description: 'Constelaciones grabadas sobre azul noche.', icon: '▤', style: 'cosmos',
    goal: { kind: 'rounds_total', target: 50, description: 'Completa 50 rondas válidas en cualquier juego.' }
  }
]);

const ITEM_BY_ID = new Map(COSMETIC_ITEMS.map(item => [item.id, item]));
const ITEM_SLOTS = Object.freeze(['avatar', 'frame', 'chips', 'felt', 'cards']);

function blankCollection() {
  return { unlocked: [], equipped: { avatar: null, frame: null, chips: null, felt: null, cards: null } };
}

function cleanCollection(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unlocked = Array.isArray(source.unlocked)
    ? [...new Set(source.unlocked.filter(id => ITEM_BY_ID.has(id)))].slice(0, COSMETIC_ITEMS.length)
    : [];
  const equippedSource = source.equipped && typeof source.equipped === 'object' && !Array.isArray(source.equipped)
    ? source.equipped
    : {};
  const equipped = {};
  for (const slot of ITEM_SLOTS) {
    if (slot === 'cards' && albumBackCardId(equippedSource.cards)) {
      equipped.cards = equippedSource.cards;
      continue;
    }
    const item = ITEM_BY_ID.get(equippedSource[slot]);
    equipped[slot] = item?.slot === slot && unlocked.includes(item.id) ? item.id : null;
  }
  return { unlocked, equipped };
}

function albumBackCardId(value) {
  if (typeof value !== 'string' || !value.startsWith(ALBUM_BACK_PREFIX)) return null;
  const id = value.slice(ALBUM_BACK_PREFIX.length);
  return CARD_BY_ID.has(id) ? id : null;
}

function ownsAlbumCard(profile, cardId) {
  return Number(profile?.cardAlbum?.counts?.[cardId]) > 0;
}

// Dorso de álbum equipado: se publica con su ilustración para que la mesa la muestre.
function publicAlbumBack(profile, cardId) {
  if (!cardId || !ownsAlbumCard(profile, cardId)) return null;
  const card = CARD_BY_ID.get(cardId);
  const view = publicCard(card, profile.cardAlbum.counts[cardId]);
  if (!view.art) return null;
  return {
    id: `${ALBUM_BACK_PREFIX}${cardId}`, slot: 'cards', category: 'cards',
    name: `Dorso · ${view.name}`, description: `Carta ${view.name} del álbum.`,
    icon: '▤', art: view.art, style: 'album', animation: null, equipped: true
  };
}

function metricFor(profile, goal) {
  const stats = profile?.stats || {};
  const game = goal.game ? profile?.gameStats?.[goal.game] || {} : {};
  if (goal.kind === 'rounds_total') return Math.max(0, Number(stats.roundsPlayed) || 0);
  if (goal.kind === 'wins_total') return Math.max(0, Number(stats.wins) || 0);
  if (goal.kind === 'game_rounds') return Math.max(0, Number(game.rounds) || 0);
  if (goal.kind === 'game_wins') return Math.max(0, Number(game.wins) || 0);
  if (goal.kind === 'games_variety') {
    const played = new Set(Array.isArray(profile?.gamesPlayed) ? profile.gamesPlayed : []);
    return GAME_IDS.filter(id => played.has(id)).length;
  }
  return 0;
}

function isUnlocked(profile, itemOrId) {
  const item = typeof itemOrId === 'string' ? ITEM_BY_ID.get(itemOrId) : itemOrId;
  if (!item) return false;
  return Boolean(profile?.collection?.unlocked?.includes(item.id)) || metricFor(profile, item.goal) >= item.goal.target;
}

function evaluateCosmetics(profile) {
  if (!profile || typeof profile !== 'object') return [];
  profile.collection = cleanCollection(profile.collection);
  const granted = [];
  for (const item of COSMETIC_ITEMS) {
    if (!profile.collection.unlocked.includes(item.id) && metricFor(profile, item.goal) >= item.goal.target) {
      profile.collection.unlocked.push(item.id);
      granted.push(item);
    }
  }
  return granted.map(item => ({
    type: 'cosmetic_unlock', id: item.id, name: item.name, icon: item.icon,
    slot: item.slot, description: item.description, goal: item.goal.description
  }));
}

function publicCosmetic(item, profile, { equipped = false } = {}) {
  const value = Math.min(item.goal.target, metricFor(profile, item.goal));
  return {
    id: item.id,
    slot: item.slot,
    category: item.category,
    name: item.name,
    description: item.description,
    icon: item.icon,
    art: item.art || null,
    style: item.style,
    animation: item.animation || null,
    goal: { ...item.goal, value, percent: Math.min(100, Math.round(value / item.goal.target * 100)) },
    unlocked: isUnlocked(profile, item),
    equipped
  };
}

function publicCollectionIdentity(profile) {
  const collection = profile?.collection || blankCollection();
  const equipped = {};
  for (const slot of ITEM_SLOTS) {
    if (slot === 'cards' && albumBackCardId(collection.equipped?.cards)) {
      equipped.cards = publicAlbumBack(profile, albumBackCardId(collection.equipped.cards));
      continue;
    }
    const item = ITEM_BY_ID.get(collection.equipped?.[slot]);
    equipped[slot] = item && isUnlocked(profile, item) ? publicCosmetic(item, profile, { equipped: true }) : null;
  }
  return { equipped };
}

function publicCollection(profile) {
  const identity = publicCollectionIdentity(profile);
  const items = COSMETIC_ITEMS.map(item => publicCosmetic(item, profile, {
    equipped: identity.equipped[item.slot]?.id === item.id
  }));
  return {
    items,
    unlockedCount: items.filter(item => item.unlocked).length,
    total: items.length,
    equipped: identity.equipped
  };
}

function equipCosmetic(profile, { itemId, slot } = {}) {
  if (!profile || !ITEM_SLOTS.includes(slot)) return { ok: false, error: 'Espacio de cosmético no válido.' };
  profile.collection = cleanCollection(profile.collection);
  if (itemId === null || itemId === '') {
    const changed = profile.collection.equipped[slot] !== null;
    profile.collection.equipped[slot] = null;
    return { ok: true, changed, slot, item: null };
  }
  if (typeof itemId !== 'string') return { ok: false, error: 'Elige un cosmético válido.' };
  if (itemId.startsWith(ALBUM_BACK_PREFIX)) {
    if (slot !== 'cards') return { ok: false, error: 'Ese cosmético no pertenece a este espacio.' };
    const cardId = albumBackCardId(itemId);
    if (!cardId) return { ok: false, error: 'Esa carta no existe en el álbum.' };
    if (!ownsAlbumCard(profile, cardId)) return { ok: false, error: 'Todavía no tienes esa carta.' };
    const back = publicAlbumBack(profile, cardId);
    if (!back) return { ok: false, error: 'Esa carta no tiene ilustración disponible.' };
    const changed = profile.collection.equipped[slot] !== itemId;
    profile.collection.equipped[slot] = itemId;
    return { ok: true, changed, slot, item: back };
  }
  const item = ITEM_BY_ID.get(itemId);
  if (!item || item.slot !== slot) return { ok: false, error: 'Ese cosmético no pertenece a este espacio.' };
  if (!isUnlocked(profile, item)) return { ok: false, error: 'Ese cosmético todavía no está desbloqueado.' };
  if (!profile.collection.unlocked.includes(item.id)) profile.collection.unlocked.push(item.id);
  const changed = profile.collection.equipped[slot] !== item.id;
  profile.collection.equipped[slot] = item.id;
  return { ok: true, changed, slot, item: publicCosmetic(item, profile, { equipped: true }) };
}

module.exports = {
  GAME_IDS,
  GAME_NAMES,
  COSMETIC_ITEMS,
  ITEM_SLOTS,
  blankCollection,
  cleanCollection,
  metricFor,
  isUnlocked,
  evaluateCosmetics,
  publicCollection,
  publicCollectionIdentity,
  equipCosmetic,
  ALBUM_BACK_PREFIX
};
