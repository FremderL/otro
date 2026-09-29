'use strict';

// Fase 10.1: lógica común a cualquier backend de ProfileStore (archivo JSON o
// Postgres). Las subclases solo implementan `load()` (poblar `this.profiles` y
// `this.seasons` al arrancar) y `saveNow()` (escribir el estado actual en su
// backend). Todo lo demás — temporadas, ranking, alta/edición de perfiles,
// bono diario vía `dailyBonusDate`, etc. — se comporta idéntico sin importar
// dónde se persista, que es justo lo que pide la Fase 10: misma interfaz.

const { INITIAL_CHIPS, cleanProfile, monthKey, HISTORY_LIMITS } = require('./profile-store-shared');
const { AVATAR_IDS } = require('./profile-store-shared');

class BaseProfileStore {
  constructor() {
    this.profiles = new Map();
    this.saveTimer = null;
    this.saveDelayMs = 180;
    this.seasons = { current: monthKey(), history: [] };
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
      profile.transactions = profile.transactions.slice(-HISTORY_LIMITS.transactions);
      profile.balanceHistory = [...(profile.balanceHistory || []), { t: Date.now(), chips: profile.chips }].slice(-HISTORY_LIMITS.balance);
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
    this.saveTimer = setTimeout(() => { this.saveNow(); }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  // Las subclases deben implementar load() y saveNow().
  load() {
    throw new Error('load() debe implementarse en la subclase de ProfileStore');
  }

  saveNow() {
    throw new Error('saveNow() debe implementarse en la subclase de ProfileStore');
  }
}

module.exports = { BaseProfileStore };
