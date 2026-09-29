'use strict';

// Fase 10.1: piezas compartidas entre el ProfileStore de archivo (JSON) y el de
// Postgres, para que ambos limpien y normalicen los perfiles exactamente igual
// sin importar dónde se guarden.

const INITIAL_CHIPS = 1000;
const AVATARS = [
  { id: 'fox', emoji: '🦊', label: 'Zorro' },
  { id: 'tiger', emoji: '🐯', label: 'Tigre' },
  { id: 'panda', emoji: '🐼', label: 'Panda' },
  { id: 'owl', emoji: '🦉', label: 'Búho' },
  { id: 'alien', emoji: '👽', label: 'Alien' },
  { id: 'robot', emoji: '🤖', label: 'Robot' },
  { id: 'crown', emoji: '👑', label: 'Corona' },
  { id: 'diamond', emoji: '💎', label: 'Diamante' }
];
const AVATAR_IDS = new Set(AVATARS.map(item => item.id));

function cleanProfile(raw = {}) {
  return {
    id: String(raw.id || '').slice(0, 80),
    name: String(raw.name || 'Jugador').replace(/[<>]/g, '').trim().slice(0, 18) || 'Jugador',
    avatar: AVATAR_IDS.has(raw.avatar) ? raw.avatar : 'fox',
    chips: Math.max(0, Math.floor(Number.isFinite(Number(raw.chips)) ? Number(raw.chips) : INITIAL_CHIPS)),
    stats: {
      roundsPlayed: Math.max(0, Math.floor(Number(raw.stats?.roundsPlayed) || 0)),
      wins: Math.max(0, Math.floor(Number(raw.stats?.wins) || 0)),
      losses: Math.max(0, Math.floor(Number(raw.stats?.losses) || 0)),
      biggestWin: Math.max(0, Math.floor(Number(raw.stats?.biggestWin) || 0)),
      totalWagered: Math.max(0, Math.floor(Number(raw.stats?.totalWagered) || 0)),
      currentStreak: Math.floor(Number(raw.stats?.currentStreak) || 0),
      bestStreak: Math.max(0, Math.floor(Number(raw.stats?.bestStreak) || 0))
    },
    gamesPlayed: Array.isArray(raw.gamesPlayed) ? [...new Set(raw.gamesPlayed.map(String))].slice(0, 20) : [],
    // Fase 8.2: historial por juego y evolución de saldo.
    gameStats: (() => {
      const source = raw.gameStats && typeof raw.gameStats === 'object' ? raw.gameStats : {};
      const clean = {};
      for (const key of Object.keys(source).slice(0, 10)) {
        const entry = source[key] || {};
        clean[String(key).slice(0, 20)] = {
          rounds: Math.max(0, Math.floor(Number(entry.rounds) || 0)),
          wins: Math.max(0, Math.floor(Number(entry.wins) || 0)),
          net: Math.floor(Number(entry.net) || 0)
        };
      }
      return clean;
    })(),
    balanceHistory: Array.isArray(raw.balanceHistory)
      ? raw.balanceHistory
          .filter(point => point && Number.isFinite(Number(point.chips)))
          .map(point => ({ t: Number(point.t) || Date.now(), chips: Math.max(0, Math.floor(Number(point.chips))) }))
          .slice(-60)
      : [],
    achievements: Array.isArray(raw.achievements) ? [...new Set(raw.achievements.map(String))].slice(0, 100) : [],
    challenges: raw.challenges && typeof raw.challenges === 'object' ? raw.challenges : {},
    dailyBonusDate: typeof raw.dailyBonusDate === 'string' ? raw.dailyBonusDate : null,
    transactions: Array.isArray(raw.transactions) ? raw.transactions.slice(-20) : [],
    flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {},
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

// Fase 8.7: clave de temporada mensual (los puntos se reinician cada mes).
function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function avatarInfo(id) {
  return AVATARS.find(item => item.id === id) || AVATARS[0];
}

module.exports = { INITIAL_CHIPS, AVATARS, AVATAR_IDS, avatarInfo, cleanProfile, monthKey };
