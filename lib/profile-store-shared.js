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

// Fase 11.1: cuántos puntos de la gráfica de saldo y cuántas transacciones se
// conservan por perfil. Son valores por defecto pensados para el archivo JSON
// (donde cada punto de más pesa en el tamaño del archivo reescrito en cada
// guardado); server.js los eleva a un techo generoso al arrancar si el backend
// activo es Postgres (ver bootstrap() en server.js), donde ese costo no aplica
// igual. Es un objeto mutable a propósito: cleanProfile, ensureSeason y
// lib/progression.js lo leen por referencia, así que un solo ajuste en el
// arranque cambia el comportamiento en todas partes sin tocar cada llamada.
const HISTORY_LIMITS = { transactions: 20, balance: 60 };

// Fase 11.4: cuentas sin ninguna actividad (`updatedAt` sin tocar) por más de
// este tiempo se eliminan por completo para no acumular espacio con cuentas
// abandonadas. ~3 meses aproximados como 90 días (no meses de calendario, para
// no complicar el cálculo con la duración variable de cada mes).
const INACTIVITY_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;


// Fase 11.2: usuario de 3 a 20 caracteres (letras, números y guion bajo),
// siempre normalizado a minúsculas para que la búsqueda y la unicidad no
// dependan de cómo lo haya escrito cada quien.
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
function normalizeUsername(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return USERNAME_RE.test(value) ? value : null;
}

// Unicidad global de nombres de perfil: cómo se comparan dos nombres para
// decidir si son «el mismo». Sin espacios de sobra, en minúsculas y con los
// espacios internos colapsados: «ANA  de las Cuevas» ≡ «ana de las cuevas».
// La usan el registro global del casino (findProfileByName) y la comparación
// de nombres dentro de una mesa, para que ambas reglas coincidan siempre.
function normalizeDisplayName(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanRotatingPeriod(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    key: String(raw.key || '').slice(0, 20),
    rounds: Math.max(0, Math.floor(Number(raw.rounds) || 0)),
    wins: Math.max(0, Math.floor(Number(raw.wins) || 0)),
    wagered: Math.max(0, Math.floor(Number(raw.wagered) || 0)),
    games: Array.isArray(raw.games) ? [...new Set(raw.games.map(String))].slice(0, 10) : [],
    currentStreak: Math.max(0, Math.floor(Number(raw.currentStreak) || 0)),
    bestStreak: Math.max(0, Math.floor(Number(raw.bestStreak) || 0)),
    completed: Boolean(raw.completed),
    completedAt: Number(raw.completedAt) || null
  };
}

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
      bestStreak: Math.max(0, Math.floor(Number(raw.stats?.bestStreak) || 0)),
      // Las nuevas rachas elegibles excluyen bots y rondas sin apuesta válida;
      // se conserva el fallback histórico de bestStreak en progression.js.
      eligibleCurrentStreak: Math.max(0, Math.floor(Number(raw.stats?.eligibleCurrentStreak) || 0)),
      eligibleBestStreak: Math.max(0, Math.floor(Number(raw.stats?.eligibleBestStreak) || 0)),
      eligibleTracking: Boolean(raw.stats && Object.prototype.hasOwnProperty.call(raw.stats, 'eligibleBestStreak'))
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
          .slice(-HISTORY_LIMITS.balance)
      : [],
    achievements: Array.isArray(raw.achievements) ? [...new Set(raw.achievements.map(String))].slice(0, 100) : [],
    // Fase 11.4: premios de fin de temporada para quien terminó en 1er lugar.
    // `championBanner` es un logro único de por vida (una vez otorgado, ganar
    // otra temporada no da un segundo banner). `medals` sí se acumula: una
    // medalla de oro más por cada temporada en la que fue el/la líder.
    championBanner: Boolean(raw.championBanner),
    medals: Math.max(0, Math.floor(Number(raw.medals) || 0)),
    challenges: raw.challenges && typeof raw.challenges === 'object' ? raw.challenges : {},
    rotatingChallenges: raw.rotatingChallenges && typeof raw.rotatingChallenges === 'object' ? {
      daily: cleanRotatingPeriod(raw.rotatingChallenges.daily),
      weekly: cleanRotatingPeriod(raw.rotatingChallenges.weekly)
    } : { daily: null, weekly: null },
    featuredAchievements: Array.isArray(raw.featuredAchievements) ? [...new Set(raw.featuredAchievements.map(String))].slice(0, 3) : [],
    dailyBonusDate: typeof raw.dailyBonusDate === 'string' ? raw.dailyBonusDate : null,
    transactions: Array.isArray(raw.transactions) ? raw.transactions.slice(-HISTORY_LIMITS.transactions) : [],
    flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {},
    // Fase 11.2: login opcional (usuario + contraseña) para recuperar el
    // mismo perfil desde otra computadora. `passwordHash` nunca se envía al
    // cliente (ver publicProgress en lib/progression.js, que arma su
    // respuesta con una lista explícita de campos y no incluye este).
    username: normalizeUsername(raw.username) || null,
    passwordHash: typeof raw.passwordHash === 'string' ? raw.passwordHash : null,
    // Fase administrativa 1: todo valor desconocido degrada a usuario. Nunca
    // se confía en un rol procedente del navegador.
    role: ['user', 'moderator', 'admin'].includes(raw.role) ? raw.role : 'user',
    moderation: {
      status: ['active', 'suspended', 'banned'].includes(raw.moderation?.status) ? raw.moderation.status : 'active',
      reason: typeof raw.moderation?.reason === 'string' ? raw.moderation.reason.slice(0, 500) : null,
      until: Number(raw.moderation?.until) || null,
      actionId: typeof raw.moderation?.actionId === 'string' ? raw.moderation.actionId : null,
      updatedAt: Number(raw.moderation?.updatedAt) || null
    },
    security: {
      sessionVersion: Math.max(1, Math.floor(Number(raw.security?.sessionVersion) || 1)),
      mustChangePassword: Boolean(raw.security?.mustChangePassword),
      passwordChangedAt: Number(raw.security?.passwordChangedAt) || null,
      mfaEnabled: Boolean(raw.security?.mfaEnabled),
      mfaSecretEncrypted: typeof raw.security?.mfaSecretEncrypted === 'string' ? raw.security.mfaSecretEncrypted : null,
      mfaPendingSecretEncrypted: typeof raw.security?.mfaPendingSecretEncrypted === 'string' ? raw.security.mfaPendingSecretEncrypted : null,
      recoveryCodeHashes: Array.isArray(raw.security?.recoveryCodeHashes)
        ? raw.security.recoveryCodeHashes.filter(value => /^[a-f0-9]{64}$/.test(value)).slice(0, 10)
        : [],
      mfaEnrolledAt: Number(raw.security?.mfaEnrolledAt) || null
    },
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

// El casino opera con calendario de Ciudad de México. Render y Neon usan UTC,
// pero una temporada visible para jugadores de México no debe terminar seis
// horas antes, el 30 por la tarde. La zona se puede cambiar en despliegues
// futuros sin depender de la zona horaria del proceso.
const CASINO_TIME_ZONE = process.env.CASINO_TIME_ZONE || 'America/Mexico_City';
function calendarParts(date = new Date(), timeZone = CASINO_TIME_ZONE) {
  const value = date instanceof Date ? date : new Date(date);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(value);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  } catch (_) {
    // Una variable de entorno inválida nunca debe impedir que el casino
    // arranque. UTC queda solo como último fallback explícito.
    return {
      year: String(value.getUTCFullYear()),
      month: String(value.getUTCMonth() + 1).padStart(2, '0'),
      day: String(value.getUTCDate()).padStart(2, '0')
    };
  }
}
// Fase 8.7: clave de temporada mensual en el calendario operativo del casino.
function monthKey(date = new Date(), timeZone = CASINO_TIME_ZONE) {
  const { year, month } = calendarParts(date, timeZone);
  return `${year}-${month}`;
}

function avatarInfo(id) {
  return AVATARS.find(item => item.id === id) || AVATARS[0];
}

module.exports = { INITIAL_CHIPS, AVATARS, AVATAR_IDS, avatarInfo, cleanProfile, monthKey, calendarParts, CASINO_TIME_ZONE, HISTORY_LIMITS, INACTIVITY_LIMIT_MS, normalizeUsername, normalizeDisplayName };
