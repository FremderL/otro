const fs = require('fs');
const path = require('path');

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

class ProfileStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'profiles.json')) {
    this.filePath = filePath;
    this.profiles = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(list)) for (const raw of list) {
        const profile = cleanProfile(raw);
        if (profile.id) this.profiles.set(profile.id, profile);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudieron cargar los perfiles:', error.message);
    }
  }

  getOrCreate(id, name, avatar) {
    id = String(id || '').slice(0, 80);
    let profile = this.profiles.get(id);
    if (!profile) {
      profile = cleanProfile({ id, name, avatar, chips: INITIAL_CHIPS });
      this.profiles.set(id, profile);
    } else {
      if (name) profile.name = String(name).replace(/[<>]/g, '').trim().slice(0, 18) || profile.name;
      if (AVATAR_IDS.has(avatar)) profile.avatar = avatar;
    }
    this.touch(profile);
    return profile;
  }

  update(profile, changes = {}) {
    if (changes.name) profile.name = String(changes.name).replace(/[<>]/g, '').trim().slice(0, 18) || profile.name;
    if (AVATAR_IDS.has(changes.avatar)) profile.avatar = changes.avatar;
    this.touch(profile);
    return profile;
  }

  touch(profile) {
    profile.updatedAt = Date.now();
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 180);
    this.saveTimer.unref?.();
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify([...this.profiles.values()], null, 2));
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.warn('No se pudieron guardar los perfiles:', error.message);
    }
  }
}

function avatarInfo(id) {
  return AVATARS.find(item => item.id === id) || AVATARS[0];
}

module.exports = { ProfileStore, INITIAL_CHIPS, AVATARS, avatarInfo, AVATAR_IDS };
