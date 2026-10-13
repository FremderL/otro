'use strict';

// Catálogo cerrado del Pasaporte. Los identificadores nunca se construyen a
// partir de datos libres del cliente: cada objeto pertenece a un mes y a uno
// de estos seis premios cosméticos fijos.
const PASSPORT_GAMES = [
  { id: 'poker', name: 'Póker', icon: '♠' },
  { id: 'blackjack', name: 'Blackjack', icon: '◆' },
  { id: 'roulette', name: 'Ruleta', icon: '◉' },
  { id: 'dice', name: 'Dados', icon: '⚄' },
  { id: 'coinflip', name: 'Cara o Cruz', icon: '◐' },
  { id: 'slots', name: 'Tragamonedas', icon: '🎰' }
];
const PASSPORT_GAME_IDS = new Set(PASSPORT_GAMES.map(game => game.id));
const PASSPORT_SLOTS = ['frame', 'title', 'badge'];
const MAX_PASSPORT_ROUND_IDS = 128;
const MAX_PASSPORT_POINTS = 1_000_000_000;

const REWARDS = [
  {
    slug: 'season-badge', threshold: 5, slot: 'badge', icon: '✦', style: 'badge-season',
    name: 'Insignia de temporada', description: 'Un distintivo para celebrar tu recorrido de este mes.'
  },
  {
    slug: 'frame-15', threshold: 15, slot: 'frame', icon: '▣', style: 'frame-15',
    name: 'Marco de perfil', description: 'Un marco verde esmeralda para tu avatar.'
  },
  {
    slug: 'title-30', threshold: 30, slot: 'title', icon: '✧', style: 'title-30',
    name: 'Explorador MonteCristo', description: 'Un título decorativo que aparece junto a tu nombre.'
  },
  {
    slug: 'frame-50', threshold: 50, slot: 'frame', icon: '◇', style: 'frame-50',
    name: 'Marco de la suerte', description: 'Una segunda variante de marco, en dorado.'
  },
  {
    slug: 'emblem-75', threshold: 75, slot: 'badge', icon: '🏅', style: 'badge-emblem',
    name: 'Emblema destacado', description: 'El distintivo especial por alcanzar los 75 puntos.'
  },
  {
    slug: 'explorer', threshold: null, slot: 'badge', icon: '🧭', style: 'badge-explorer',
    name: 'Insignia Explorador', description: 'Completa los seis sellos durante la temporada.'
  }
];
const REWARD_BY_SLUG = new Map(REWARDS.map(reward => [reward.slug, reward]));
const SEASON_KEY_RE = /^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/;
const COSMETIC_ID_RE = /^passport:([1-9]\d{3}-(?:0[1-9]|1[0-2])):([a-z0-9-]+)$/;

function isSeasonKey(value) {
  return typeof value === 'string' && SEASON_KEY_RE.test(value);
}

function makeCosmeticId(seasonKey, slug) {
  if (!isSeasonKey(seasonKey) || !REWARD_BY_SLUG.has(slug)) return null;
  return `passport:${seasonKey}:${slug}`;
}

function seasonParts(seasonKey) {
  if (!isSeasonKey(seasonKey)) return null;
  const [year, month] = seasonKey.split('-').map(Number);
  return { year, month };
}

function monthName(month, year) {
  return new Intl.DateTimeFormat('es-MX', { month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatSeasonLabel(seasonKey) {
  const parts = seasonParts(seasonKey);
  if (!parts) return 'Temporada actual';
  const label = new Intl.DateTimeFormat('es-MX', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, 1)));
  return label.replace(/^./u, character => character.toLocaleUpperCase('es-MX'));
}

function seasonDateRange(seasonKey) {
  const parts = seasonParts(seasonKey);
  if (!parts) return { startDate: '', endDate: '' };
  const name = monthName(parts.month, parts.year);
  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  return {
    startDate: `1 de ${name} de ${parts.year}`,
    endDate: `${lastDay} de ${name} de ${parts.year}`
  };
}

function cosmeticFromId(id) {
  if (typeof id !== 'string') return null;
  const match = COSMETIC_ID_RE.exec(id);
  if (!match) return null;
  const reward = REWARD_BY_SLUG.get(match[2]);
  if (!reward) return null;
  return {
    id,
    slug: reward.slug,
    seasonKey: match[1],
    seasonLabel: formatSeasonLabel(match[1]),
    slot: reward.slot,
    icon: reward.icon,
    style: reward.style,
    name: reward.name,
    description: reward.description,
    threshold: reward.threshold
  };
}

function rewardsForSeason(seasonKey) {
  if (!isSeasonKey(seasonKey)) return [];
  return REWARDS.map(reward => ({
    ...reward,
    id: makeCosmeticId(seasonKey, reward.slug),
    seasonKey,
    seasonLabel: formatSeasonLabel(seasonKey),
    requirement: reward.threshold === null ? '6 sellos' : `${reward.threshold} puntos`
  }));
}

module.exports = {
  PASSPORT_GAMES,
  PASSPORT_GAME_IDS,
  PASSPORT_SLOTS,
  MAX_PASSPORT_ROUND_IDS,
  MAX_PASSPORT_POINTS,
  REWARDS,
  isSeasonKey,
  makeCosmeticId,
  cosmeticFromId,
  rewardsForSeason,
  formatSeasonLabel,
  seasonDateRange
};
