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

// Fase 8.7: clave de temporada mensual (los puntos se reinician cada mes).
function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

class ProfileStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'profiles.json')) {
    this.filePath = filePath;
    this.profiles = new Map();
    this.saveTimer = null;
    this.seasons = { current: monthKey(), history: [] };
    this.load();
    this.ensureSeason();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      // Formato nuevo { seasons, profiles } o legado (arreglo simple de perfiles).
      const list = Array.isArray(data) ? data : Array.isArray(data.profiles) ? data.profiles : [];
      if (!Array.isArray(data) && data.seasons && typeof data.seasons === 'object') {
        this.seasons = {
          current: typeof data.seasons.current === 'string' ? data.seasons.current : monthKey(),
          history: Array.isArray(data.seasons.history) ? data.seasons.history.slice(-12) : []
        };
      }
      for (const raw of list) {
        const profile = cleanProfile(raw);
        if (profile.id) this.profiles.set(profile.id, profile);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudieron cargar los perfiles:', error.message);
    }
  }

  // Fase 8.7: si cambió el mes, archiva el podio y reinicia todos los saldos a 1000.
  // El bono diario de 100 fichas no cambia.
  ensureSeason() {
    const now = monthKey();
    if (this.seasons.current === now) return null;
    const podium = [...this.profiles.values()]
      .sort((a, b) => b.chips - a.chips)
      .slice(0, 3)
      .map(profile => ({ name: profile.name, avatar: profile.avatar, chips: profile.chips }));
    const closed = { month: this.seasons.current, podium, players: this.profiles.size };
    this.seasons.history = [...this.seasons.history, closed].slice(-12);
    this.seasons.current = now;
    for (const profile of this.profiles.values()) {
      profile.chips = INITIAL_CHIPS;
      profile.transactions.push({ amount: 0, reason: `Nueva temporada ${now}: saldo reiniciado a ${INITIAL_CHIPS}`, time: Date.now() });
      profile.transactions = profile.transactions.slice(-20);
      profile.balanceHistory = [...(profile.balanceHistory || []), { t: Date.now(), chips: profile.chips }].slice(-60);
      profile.updatedAt = Date.now();
    }
    this.scheduleSave();
    return closed;
  }

  // Fase 8.6: ranking mensual — los perfiles con más puntos de la temporada en curso.
  top(limit = 10) {
    return [...this.profiles.values()]
      .sort((a, b) => b.chips - a.chips || b.stats.wins - a.stats.wins)
      .slice(0, limit)
      .map(profile => ({ name: profile.name, avatar: profile.avatar, chips: profile.chips, wins: profile.stats.wins }));
  }

  getOrCreate(id, name, avatar) {
    this.ensureSeason(); // Fase 8.7: verifica el cambio de mes en cada acceso.
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
      // Fase 8.6/8.7: el archivo guarda también las temporadas mensuales.
      fs.writeFileSync(temporary, JSON.stringify({ seasons: this.seasons, profiles: [...this.profiles.values()] }, null, 2));
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
