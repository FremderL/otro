'use strict';

const { CASINO_TIME_ZONE, cleanPassport, monthKey } = require('./profile-store-shared');
const {
  PASSPORT_GAMES,
  PASSPORT_GAME_IDS,
  PASSPORT_SLOTS,
  MAX_PASSPORT_ROUND_IDS,
  MAX_PASSPORT_POINTS,
  cosmeticFromId,
  rewardsForSeason,
  seasonDateRange,
  formatSeasonLabel
} = require('./passport-catalog');

const POINT_MILESTONES = [5, 15, 30, 50, 75];

function blankSeason(seasonKey) {
  return { key: seasonKey, points: 0, games: [], processedRoundIds: [] };
}

function ensurePassportShape(profile) {
  if (!profile || typeof profile !== 'object') return null;
  if (!profile.passport || typeof profile.passport !== 'object') profile.passport = cleanPassport({});
  else if (!profile.passport.currentSeason || typeof profile.passport.currentSeason !== 'object') {
    profile.passport = cleanPassport(profile.passport);
  }
  return profile.passport;
}

// Alinea la temporada del Pasaporte con el mes local del casino. El inventario
// y el equipamiento quedan intactos; solo se reemplazan los datos temporales.
function ensurePassportSeason(profile, date = new Date()) {
  const passport = ensurePassportShape(profile);
  if (!passport) return false;
  const seasonKey = monthKey(date);
  if (passport.currentSeason?.key === seasonKey) return false;
  passport.currentSeason = blankSeason(seasonKey);
  return true;
}

function validRoundId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[a-zA-Z0-9:_-]{1,160}$/.test(id) ? id : null;
}

function unlockForSeason(profile, season, seasonKey) {
  const inventory = profile.passport.unlockedCosmetics;
  const inventorySet = new Set(inventory);
  const granted = [];
  const allGamesComplete = PASSPORT_GAMES.every(game => season.games.includes(game.id));
  const currentRewards = rewardsForSeason(seasonKey);

  for (const reward of currentRewards) {
    const eligible = reward.threshold === null
      ? allGamesComplete
      : season.points >= reward.threshold;
    if (!eligible || inventorySet.has(reward.id)) continue;
    inventory.push(reward.id);
    inventorySet.add(reward.id);
    granted.push(cosmeticFromId(reward.id));
  }
  return granted.filter(Boolean);
}

// Se llama únicamente desde la liquidación autoritativa de una ronda. La ronda
// y el juego se verifican en el servidor; el importe y el resultado no forman
// parte del cálculo del Pasaporte.
function recordPassportRound(profile, { game, roundId, date = new Date() } = {}) {
  if (!profile || !PASSPORT_GAME_IDS.has(game)) return { changed: false, unlocked: [] };
  const stableRoundId = validRoundId(roundId);
  if (!stableRoundId) return { changed: false, unlocked: [] };

  const reset = ensurePassportSeason(profile, date);
  const passport = ensurePassportShape(profile);
  const season = passport.currentSeason;
  season.games = Array.isArray(season.games) ? season.games : [];
  season.processedRoundIds = Array.isArray(season.processedRoundIds) ? season.processedRoundIds : [];
  passport.unlockedCosmetics = Array.isArray(passport.unlockedCosmetics) ? passport.unlockedCosmetics : [];
  passport.equipped = passport.equipped && typeof passport.equipped === 'object'
    ? passport.equipped
    : { frame: null, title: null, badge: null };

  if (season.processedRoundIds.includes(stableRoundId)) {
    return { changed: reset, unlocked: [] };
  }

  season.processedRoundIds.push(stableRoundId);
  season.processedRoundIds = season.processedRoundIds.slice(-MAX_PASSPORT_ROUND_IDS);
  season.points = Math.min(MAX_PASSPORT_POINTS, Math.max(0, Math.floor(Number(season.points) || 0)) + 1);
  if (!season.games.includes(game)) season.games.push(game);

  return {
    changed: true,
    unlocked: unlockForSeason(profile, season, season.key)
  };
}

function publicCosmetic(itemId) {
  return cosmeticFromId(itemId);
}

function publicPassportIdentity(profile) {
  const source = profile?.passport?.equipped || {};
  const equipped = {};
  for (const slot of PASSPORT_SLOTS) {
    const item = publicCosmetic(source[slot]);
    if (item?.slot === slot) equipped[slot] = item;
    else equipped[slot] = null;
  }
  return { equipped };
}

function visibleCurrentSeason(profile, seasonKey) {
  const current = profile?.passport?.currentSeason;
  if (!current || current.key !== seasonKey) return blankSeason(seasonKey);
  return current;
}

function publicPassport(profile, date = new Date()) {
  const seasonKey = monthKey(date);
  const current = visibleCurrentSeason(profile, seasonKey);
  const points = Math.min(MAX_PASSPORT_POINTS, Math.max(0, Math.floor(Number(current.points) || 0)));
  const currentGames = new Set(Array.isArray(current.games) ? current.games : []);
  const unlocked = Array.isArray(profile?.passport?.unlockedCosmetics)
    ? profile.passport.unlockedCosmetics.filter(id => cosmeticFromId(id))
    : [];
  const unlockedSet = new Set(unlocked);
  const identity = publicPassportIdentity(profile);
  const rewards = rewardsForSeason(seasonKey).map(reward => ({
    ...reward,
    unlocked: unlockedSet.has(reward.id),
    equipped: identity.equipped[reward.slot]?.id === reward.id
  }));
  const milestones = rewards.filter(reward => reward.threshold !== null);
  const nextMilestone = milestones.find(reward => points < reward.threshold) || null;
  const dates = seasonDateRange(seasonKey);
  const inventory = unlocked
    .map(publicCosmetic)
    .filter(Boolean)
    .sort((a, b) => b.seasonKey.localeCompare(a.seasonKey) || a.id.localeCompare(b.id))
    .map(item => ({ ...item, equipped: identity.equipped[item.slot]?.id === item.id }));
  const completedGames = PASSPORT_GAMES.filter(game => currentGames.has(game.id)).length;

  return {
    season: {
      key: seasonKey,
      label: formatSeasonLabel(seasonKey),
      startDate: dates.startDate,
      endDate: dates.endDate,
      timeZone: CASINO_TIME_ZONE,
      points,
      pointCap: POINT_MILESTONES[POINT_MILESTONES.length - 1],
      progressPercent: Math.min(100, Math.round(points / POINT_MILESTONES[POINT_MILESTONES.length - 1] * 100)),
      nextMilestone: nextMilestone ? {
        threshold: nextMilestone.threshold,
        rewardName: nextMilestone.name,
        remaining: Math.max(0, nextMilestone.threshold - points)
      } : null,
      games: PASSPORT_GAMES.map(game => ({ ...game, completed: currentGames.has(game.id) })),
      completedGames,
      allGamesComplete: completedGames === PASSPORT_GAMES.length,
      rewards
    },
    equipped: identity.equipped,
    inventory
  };
}

function equipPassportCosmetic(profile, { itemId, slot } = {}) {
  if (!profile || !PASSPORT_SLOTS.includes(slot)) return { ok: false, error: 'Espacio de cosmético no válido.' };
  const passport = ensurePassportShape(profile);
  passport.unlockedCosmetics = Array.isArray(passport.unlockedCosmetics) ? passport.unlockedCosmetics : [];
  passport.equipped = passport.equipped && typeof passport.equipped === 'object'
    ? passport.equipped
    : { frame: null, title: null, badge: null };

  if (itemId === null || itemId === '') {
    const changed = passport.equipped[slot] !== null;
    passport.equipped[slot] = null;
    return { ok: true, changed, slot, item: null };
  }
  if (typeof itemId !== 'string') return { ok: false, error: 'Elige un cosmético válido.' };

  const item = cosmeticFromId(itemId);
  if (!item || item.slot !== slot) return { ok: false, error: 'Ese cosmético no pertenece a este espacio.' };
  if (!passport.unlockedCosmetics.includes(item.id)) return { ok: false, error: 'Ese cosmético todavía no está desbloqueado.' };
  const changed = passport.equipped[slot] !== item.id;
  passport.equipped[slot] = item.id;
  return { ok: true, changed, slot, item };
}

module.exports = {
  POINT_MILESTONES,
  blankSeason,
  ensurePassportSeason,
  recordPassportRound,
  publicPassport,
  publicPassportIdentity,
  equipPassportCosmetic,
  validRoundId
};
