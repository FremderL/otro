'use strict';

// Fase 10.1: lógica común a cualquier backend de ProfileStore (archivo JSON o
// Postgres). Las subclases solo implementan `load()` (poblar `this.profiles` y
// `this.seasons` al arrancar) y `saveNow()` (escribir el estado actual en su
// backend). Todo lo demás — temporadas, ranking, alta/edición de perfiles,
// bono diario vía `dailyBonusDate`, etc. — se comporta idéntico sin importar
// dónde se persista, que es justo lo que pide la Fase 10: misma interfaz.

const { INITIAL_CHIPS, cleanProfile, monthKey, CASINO_TIME_ZONE, HISTORY_LIMITS, normalizeUsername, normalizeDisplayName } = require('./profile-store-shared');
const { AVATAR_IDS } = require('./profile-store-shared');
const { hashPassword, verifyPassword } = require('./password');

// Fase 11.2: protección simple contra fuerza bruta en el login. Tras
// MAX_LOGIN_FAILURES intentos fallidos seguidos contra el mismo usuario, se
// bloquea ese usuario por LOGIN_LOCK_MS (persistido en el propio perfil, así
// que sobrevive a reinicios del servidor). No hay protección para usuarios
// que no existen (limitación aceptada: no hay nada que bloquear ahí).
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 60 * 1000;

class BaseProfileStore {
  constructor() {
    this.profiles = new Map();
    this.saveTimer = null;
    this.saveDelayMs = 180;
    this.seasons = { current: monthKey(), history: [] };
    // Fase 11.4: ids borrados que el backend de Postgres todavía no confirmó
    // en la base (deleteProfile los agrega; PgProfileStore._writeSnapshot los
    // limpia solo después de un DELETE exitoso). El backend de archivo no lo
    // necesita: como reescribe el archivo completo en cada guardado, un perfil
    // fuera de `this.profiles` ya desaparece solo.
    this._pendingDeletes = new Set();
  }

  _rankedProfiles() {
    // El mismo orden determinista alimenta el ranking visible y el cierre. Así,
    // incluso si dos perfiles empatan en fichas y victorias, la persona que se
    // ve en #1 es exactamente quien recibe la medalla.
    return [...this.profiles.values()].sort((a, b) =>
      b.chips - a.chips || b.stats.wins - a.stats.wins ||
      a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id))
    );
  }

  _repairPrematureSeason(correctMonth, detectedAt) {
    const futureMonth = this.seasons.current;
    const latest = this.seasons.history[this.seasons.history.length - 1];
    let awardReverted = false;
    let revertedWinner = null;

    // Compatibilidad con el cierre erróneo anterior: a las 00:00 UTC se archivó
    // septiembre aunque en México todavía era 30 de septiembre. Si ese es el
    // último registro, se elimina y se revierte únicamente el premio que ese
    // cierre prematuro entregó. Los nombres son globalmente únicos; los cierres
    // nuevos guardan además el id interno para que la reparación sea inequívoca.
    if (latest?.month === correctMonth) {
      const first = latest.podium?.[0];
      const winnerId = latest.winnerId || first?.profileId;
      const winner = winnerId
        ? this.profiles.get(winnerId)
        : [...this.profiles.values()].find(profile => normalizeDisplayName(profile.name) === normalizeDisplayName(first?.name));
      if (winner) {
        winner.medals = Math.max(0, (winner.medals || 0) - 1);
        if (latest.bannerAwarded) winner.championBanner = false;
        winner.updatedAt = detectedAt.getTime();
        awardReverted = true;
        revertedWinner = winner.name;
      }
      this.seasons.history = this.seasons.history.slice(0, -1);
    }

    // No se vuelven a reiniciar las fichas: se conserva el ranking que las
    // personas ya ven y con el que se llegará al verdadero cierre local. Sí se
    // retira del historial la transacción administrativa del reinicio adelantado.
    const resetReason = `Nueva temporada ${futureMonth}: saldo reiniciado a ${INITIAL_CHIPS}`;
    for (const profile of this.profiles.values()) {
      profile.transactions = (profile.transactions || []).filter(transaction => transaction.reason !== resetReason);
      profile.updatedAt = detectedAt.getTime();
    }
    this.seasons.current = correctMonth;
    const repair = {
      type: 'repair', fromMonth: futureMonth, toMonth: correctMonth,
      timeZone: CASINO_TIME_ZONE, awardReverted, revertedWinner
    };
    this.lastSeasonRepair = repair;
    this.scheduleSave();
    return repair;
  }

  // Fase 8.7/11.4: si cambió el mes LOCAL del casino, archiva una instantánea
  // del ranking, premia a quien aparece en 1er lugar y reinicia los saldos.
  ensureSeason(date = new Date()) {
    const now = monthKey(date);
    if (this.seasons.current === now) return null;
    // Nunca se cierra una temporada "hacia atrás". Este caso identifica y
    // corrige automáticamente datos afectados por el antiguo calendario UTC.
    if (this.seasons.current > now) return this._repairPrematureSeason(now, date);

    const ranked = this._rankedProfiles();
    const winner = ranked[0] || null;
    let bannerAwarded = false;
    if (winner) {
      // Fase 11.4: la medalla de oro se puede coleccionar (una más por cada
      // temporada ganada); el banner dorado es un logro único de por vida.
      winner.medals = (winner.medals || 0) + 1;
      if (!winner.championBanner) {
        winner.championBanner = true;
        bannerAwarded = true;
      }
    }
    const podium = ranked.slice(0, 3).map(profile => ({
      profileId: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips,
      medals: profile.medals || 0, championBanner: Boolean(profile.championBanner)
    }));
    const closed = {
      type: 'closed', month: this.seasons.current, podium, players: this.profiles.size,
      winnerId: winner?.id || null, bannerAwarded, closedAt: date.getTime(), timeZone: CASINO_TIME_ZONE
    };
    this.seasons.history = [...this.seasons.history, closed].slice(-12);
    this.seasons.current = now;
    for (const profile of this.profiles.values()) {
      profile.chips = INITIAL_CHIPS;
      profile.transactions.push({ amount: 0, reason: `Nueva temporada ${now}: saldo reiniciado a ${INITIAL_CHIPS}`, time: date.getTime() });
      profile.transactions = profile.transactions.slice(-HISTORY_LIMITS.transactions);
      // Fase 11.4: se descartan los puntos de temporadas anteriores para
      // ahorrar espacio (sobre todo en Postgres, donde el techo por perfil es
      // alto); cada temporada nueva empieza su propia gráfica desde cero.
      profile.balanceHistory = [{ t: date.getTime(), chips: profile.chips }];
      profile.updatedAt = date.getTime();
    }
    this.scheduleSave();
    return closed;
  }

  // Fase 8.6/11.4: ranking mensual — los perfiles con más puntos de la
  // temporada en curso, con sus insignias de campeón (si las tiene).
  top(limit = 10) {
    return this._rankedProfiles()
      .slice(0, limit)
      .map(profile => ({
        name: profile.name, avatar: profile.avatar, chips: profile.chips, wins: profile.stats.wins,
        medals: profile.medals || 0, championBanner: Boolean(profile.championBanner)
      }));
  }

  // Fase 11.4: borra un perfil por completo (usado por pruneInactiveAccounts
  // y disponible para un futuro panel de administración). Devuelve true si
  // existía. El id queda marcado como pendiente de borrar en el backend
  // persistente hasta que un saveNow() lo confirme.
  deleteProfile(id) {
    id = String(id || '').slice(0, 80);
    const existed = this.profiles.delete(id);
    if (existed) {
      this._pendingDeletes.add(id);
      this.scheduleSave();
    }
    return existed;
  }

  // Fase 11.4: elimina cuentas sin ninguna actividad (`updatedAt`) desde hace
  // más de `maxAgeMs` (por defecto, ver INACTIVITY_LIMIT_MS en
  // profile-store-shared.js: ~3 meses). Pensado para correr periódicamente
  // (ver seasonSweep en server.js), no en cada acceso. Devuelve la lista de
  // perfiles eliminados (id y nombre) para poder registrarlo en los logs.
  pruneInactiveAccounts(maxAgeMs) {
    const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
    const removed = [];
    for (const profile of this.profiles.values()) {
      if ((Number(profile.updatedAt) || 0) < cutoff) removed.push({ id: profile.id, name: profile.name });
    }
    for (const entry of removed) this.deleteProfile(entry.id);
    return removed;
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
    if (Array.isArray(changes.featuredAchievements)) {
      profile.featuredAchievements = [...new Set(changes.featuredAchievements.map(String))]
        .filter(id => profile.achievements.includes(id)).slice(0, 3);
    }
    this.touch(profile);
    return profile;
  }

  touch(profile) {
    profile.updatedAt = Date.now();
    this.scheduleSave();
  }

  // Unicidad global de nombres: un nombre le pertenece a UN perfil en todo el
  // casino (mesas distintas incluidas). Devuelve el perfil que ya usa ese
  // nombre — comparación normalizada, ver normalizeDisplayName en
  // profile-store-shared.js — o null si está libre. `exceptId` excluye un
  // perfil concreto: quien se renombra a su PROPIO nombre nunca choca
  // consigo misma. No hay un índice aparte que mantener: el registro es el
  // estado vivo de perfiles, así que un nombre se libera solo cuando su
  // perfil se borra (deleteProfile / pruneInactiveAccounts). Los bots no
  // están en el store: sus nombres solo se reservan dentro de su mesa.
  findProfileByName(name, exceptId = null) {
    const target = normalizeDisplayName(name);
    if (!target) return null;
    for (const profile of this.profiles.values()) {
      if (profile.id !== exceptId && normalizeDisplayName(profile.name) === target) return profile;
    }
    return null;
  }

  // Fase 11.2: login opcional. Busca por usuario normalizado con un barrido
  // simple sobre los perfiles en memoria — no hace falta un índice aparte
  // para el número de jugadores de un casino social entre amigos; si esto
  // creciera mucho se puede revisar más adelante.
  findByUsername(username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;
    for (const profile of this.profiles.values()) {
      if (profile.username === normalized) return profile;
    }
    return null;
  }

  // Vincula usuario+contraseña al perfil ya existente (mismo dispositivo,
  // mismas fichas/logros/historial) para poder recuperarlo desde otra
  // computadora con authenticate(). No crea un perfil nuevo.
  registerAccount(profile, username, password) {
    const normalized = normalizeUsername(username);
    if (!normalized) return { ok: false, error: 'Elige un usuario de 3 a 20 letras, números o guion bajo.' };
    if (typeof password !== 'string' || password.length < 6) {
      return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' };
    }
    const existing = this.findByUsername(normalized);
    if (existing && existing.id !== profile.id) return { ok: false, error: 'Ese usuario ya está en uso.' };
    profile.username = normalized;
    profile.passwordHash = hashPassword(password.slice(0, 72));
    this.touch(profile);
    return { ok: true, profile };
  }

  // Verifica usuario+contraseña y, si son correctos, devuelve el perfil
  // vinculado (para que el cliente adopte su id como token de dispositivo).
  authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const genericError = { ok: false, error: 'Usuario o contraseña incorrectos.' };
    if (!normalized || typeof password !== 'string') return genericError;
    const profile = this.findByUsername(normalized);
    if (!profile || !profile.passwordHash) return genericError;
    const now = Date.now();
    profile.flags = profile.flags || {};
    const lockedUntil = Number(profile.flags.loginLockedUntil) || 0;
    if (lockedUntil > now) {
      const waitSeconds = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
      return { ok: false, error: `Demasiados intentos. Espera ${waitSeconds}s e inténtalo de nuevo.` };
    }
    if (!verifyPassword(password, profile.passwordHash)) {
      profile.flags.loginFailures = (Number(profile.flags.loginFailures) || 0) + 1;
      if (profile.flags.loginFailures >= MAX_LOGIN_FAILURES) {
        profile.flags.loginLockedUntil = now + LOGIN_LOCK_MS;
        profile.flags.loginFailures = 0;
      }
      this.touch(profile);
      return genericError;
    }
    profile.flags.loginFailures = 0;
    delete profile.flags.loginLockedUntil;
    this.touch(profile);
    return { ok: true, profile };
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
