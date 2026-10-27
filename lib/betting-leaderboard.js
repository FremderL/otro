'use strict';

// Ranking transversal de apuestas. El casino ya conserva su volumen histórico
// por perfil; el Estadio conserva cada apuesta, combinada y futuro en su store.
// Se combinan aquí para ofrecer una sola clasificación sin exponer ids internos.

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ACCEPTED_STATUSES = new Set(['open', 'won', 'lost', 'cashed']);
const METRICS = Object.freeze({
  total: 'totalWagered',
  casino: 'casinoWagered',
  stadium: 'stadiumWagered'
});

function nonNegativeInt(value) {
  const amount = Math.floor(Number(value));
  return Number.isFinite(amount) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, amount)) : 0;
}

function safeAdd(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, nonNegativeInt(left) + nonNegativeInt(right));
}

function signedInt(value) {
  const amount = Math.trunc(Number(value));
  return Number.isFinite(amount)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(-Number.MAX_SAFE_INTEGER, amount))
    : 0;
}

function safeSignedAdd(left, right) {
  return signedInt(signedInt(left) + signedInt(right));
}

function readRecords(store, method) {
  if (!store || typeof store[method] !== 'function') return [];
  try {
    const records = store[method]();
    return Array.isArray(records) ? records : [];
  } catch (_) {
    return [];
  }
}

function isPlacedWager(wager) {
  if (!wager || typeof wager !== 'object' || nonNegativeInt(wager.stake) <= 0) return false;
  // `pending` rows are WAL intents, not confirmed bets. A rejected placement can
  // also become `void` before the debit; only an actually debited void counts.
  if (wager.status === 'pending') return false;
  if (wager.status === 'void') return wager.debited === true;
  return ACCEPTED_STATUSES.has(wager.status);
}

function profileMapOf(profiles) {
  if (profiles instanceof Map) return profiles;
  if (profiles?.profiles instanceof Map) return profiles.profiles;
  return new Map();
}

function compareBy(metric) {
  return (a, b) => b[metric] - a[metric]
    || b.totalWagered - a.totalWagered
    || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
    || String(a.name).localeCompare(String(b.name), 'es-MX');
}

function publicEntry(row, place) {
  return {
    place,
    name: row.name,
    avatar: row.avatar,
    totalWagered: row.totalWagered,
    casinoWagered: row.casinoWagered,
    stadiumWagered: row.stadiumWagered
  };
}

/**
 * Builds the public top lists plus a private, per-request summary for the viewer.
 * A leaderboard row contains display identity and virtual-chip totals only; the
 * internal profile/device id is deliberately never part of the returned payload.
 */
function createBettingLeaderboard({ profiles, footballStore = null, limit = DEFAULT_LIMIT, now = Date.now() } = {}) {
  const max = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)) || DEFAULT_LIMIT));
  const allProfiles = profileMapOf(profiles);
  const rowsById = new Map();

  for (const profile of allProfiles.values()) {
    if (!profile || !profile.id || profile.flags?.bot || profile.isBot) continue;
    const casinoWagered = nonNegativeInt(profile.stats?.totalWagered);
    rowsById.set(String(profile.id), {
      id: String(profile.id),
      name: String(profile.name || 'Jugador').slice(0, 18),
      avatar: String(profile.avatar || 'fox'),
      casinoWagered,
      stadiumWagered: 0,
      stadiumBets: 0,
      stadiumWins: 0,
      stadiumLosses: 0,
      stadiumSettledBets: 0,
      stadiumNet: 0,
      totalWagered: casinoWagered,
      createdAt: Number(profile.createdAt) || 0
    });
  }

  const addStadiumWager = wager => {
    if (!isPlacedWager(wager)) return;
    const row = rowsById.get(String(wager.profileId || ''));
    if (!row) return; // deleted / unknown profiles are intentionally not revived
    const stake = nonNegativeInt(wager.stake);
    row.stadiumWagered = safeAdd(row.stadiumWagered, stake);
    row.totalWagered = safeAdd(row.totalWagered, stake);
    row.stadiumBets = safeAdd(row.stadiumBets, 1);

    // El resumen personal separa rendimiento de volumen. Los void aceptados
    // devuelven el stake y las cashouts afectan el neto, pero ninguno mide una
    // predicción acertada; por eso el porcentaje usa solo won / (won + lost).
    if (['won', 'lost', 'void', 'cashed'].includes(wager.status)) {
      const returned = wager.status === 'void' && wager.payout == null
        ? stake
        : nonNegativeInt(wager.payout);
      row.stadiumSettledBets = safeAdd(row.stadiumSettledBets, 1);
      row.stadiumNet = safeSignedAdd(row.stadiumNet, returned - stake);
      if (wager.status === 'won') row.stadiumWins = safeAdd(row.stadiumWins, 1);
      if (wager.status === 'lost') row.stadiumLosses = safeAdd(row.stadiumLosses, 1);
    }
  };

  for (const wager of readRecords(footballStore, 'getBets')) addStadiumWager(wager);
  for (const wager of readRecords(footballStore, 'getParlays')) addStadiumWager(wager);
  for (const wager of readRecords(footballStore, 'getFutures')) addStadiumWager(wager);

  const participants = [...rowsById.values()].filter(row => row.totalWagered > 0);
  const ranked = {};
  const ranksByProfile = new Map();

  for (const [source, metric] of Object.entries(METRICS)) {
    const entries = participants
      .filter(row => row[metric] > 0)
      .sort(compareBy(metric));
    for (let index = 0; index < entries.length; index++) {
      const row = entries[index];
      const rank = index + 1;
      const ranks = ranksByProfile.get(row.id) || {};
      ranks[source] = rank;
      ranksByProfile.set(row.id, ranks);
    }
    ranked[source] = entries.slice(0, max).map((row, index) => publicEntry(row, index + 1));
  }

  const snapshot = {
    updatedAt: nonNegativeInt(now),
    participants: participants.length,
    participantsBySource: {
      total: participants.length,
      casino: participants.filter(row => row.casinoWagered > 0).length,
      stadium: participants.filter(row => row.stadiumWagered > 0).length
    },
    totalWagered: participants.reduce((sum, row) => safeAdd(sum, row.totalWagered), 0),
    ranking: ranked
  };
  function personal(profileId) {
    const viewer = profileId == null ? null : rowsById.get(String(profileId));
    if (!viewer) return null;
    const stadiumDecisions = viewer.stadiumWins + viewer.stadiumLosses;
    return {
      name: viewer.name,
      avatar: viewer.avatar,
      totalWagered: viewer.totalWagered,
      casinoWagered: viewer.casinoWagered,
      stadiumWagered: viewer.stadiumWagered,
      stadiumBets: viewer.stadiumBets,
      stadiumWins: viewer.stadiumWins,
      stadiumLosses: viewer.stadiumLosses,
      stadiumDecisions,
      stadiumSettledBets: viewer.stadiumSettledBets,
      stadiumHitRate: stadiumDecisions ? Math.round(viewer.stadiumWins / stadiumDecisions * 100) : null,
      stadiumNet: viewer.stadiumNet,
      totalRank: ranksByProfile.get(viewer.id)?.total || null,
      casinoRank: ranksByProfile.get(viewer.id)?.casino || null,
      stadiumRank: ranksByProfile.get(viewer.id)?.stadium || null
    };
  }
  return { snapshot, personal };
}

function buildBettingLeaderboard(options = {}) {
  const leaderboard = createBettingLeaderboard(options);
  return { ...leaderboard.snapshot, me: leaderboard.personal(options.profileId) };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildBettingLeaderboard,
  createBettingLeaderboard,
  isPlacedWager
};
