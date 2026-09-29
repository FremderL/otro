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
    achievements: Array.isArray(raw.achievements) ? [...new Set(raw.achievements.map(String))].slice(0, 100) : [],
    challenges: raw.challenges && typeof raw.challenges === 'object' ? raw.challenges : {},
    dailyBonusDate: typeof raw.dailyBonusDate === 'string' ? raw.dailyBonusDate : null,
    transactions: Array.isArray(raw.transactions) ? raw.transactions.slice(-20) : [],
    flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {},
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

class JsonProfileStore {
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

  // Métodos comunes para las clasificaciones y las tareas de mantenimiento.
  top(limit = 10) {
    return [...this.profiles.values()].sort((a, b) => b.chips - a.chips).slice(0, limit);
  }

  temporadas(limit = 10) {
    return this.top(limit);
  }

  reinicioMensual() {
    for (const profile of this.profiles.values()) {
      profile.stats.currentStreak = 0;
      this.touch(profile);
    }
    return this.profiles.size;
  }
}

function avatarInfo(id) {
  return AVATARS.find(item => item.id === id) || AVATARS[0];
}

class ProfileStore extends JsonProfileStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'profiles.json')) {
    if (process.env.DATABASE_URL) {
      // Se mantiene el mismo constructor y los mismos métodos para server.js.
      const { PostgresProfileStore } = require('./postgres-profile-store');
      return new PostgresProfileStore(process.env.DATABASE_URL);
    }
    super(filePath);
    this.ready = Promise.resolve();
  }
}

module.exports = { ProfileStore, JsonProfileStore, INITIAL_CHIPS, AVATARS, avatarInfo, AVATAR_IDS, cleanProfile };
