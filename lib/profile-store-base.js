'use strict';

const crypto = require('node:crypto');

// Fase 10.1: lógica común a cualquier backend de ProfileStore (archivo JSON o
// Postgres). Las subclases solo implementan `load()` (poblar `this.profiles` y
// `this.seasons` al arrancar) y `saveNow()` (escribir el estado actual en su
// backend). Todo lo demás — temporadas, ranking, alta/edición de perfiles,
// bono diario vía `dailyBonusDate`, etc. — se comporta idéntico sin importar
// dónde se persista, que es justo lo que pide la Fase 10: misma interfaz.

const { INITIAL_CHIPS, cleanProfile, monthKey, CASINO_TIME_ZONE, HISTORY_LIMITS, normalizeUsername, normalizeDisplayName } = require('./profile-store-shared');
const { AVATAR_IDS } = require('./profile-store-shared');
const { ensurePassportSeason } = require('./passport');
const { hashPassword, verifyPassword } = require('./password');
const { moderationMessage, effectiveModeration } = require('./moderation');

// Fase 11.2: protección simple contra fuerza bruta en el login. Tras
// MAX_LOGIN_FAILURES intentos fallidos seguidos contra el mismo usuario, se
// bloquea ese usuario por LOGIN_LOCK_MS (persistido en el propio perfil, así
// que sobrevive a reinicios del servidor). No hay protección para usuarios
// que no existen (limitación aceptada: no hay nada que bloquear ahí).
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const MAX_CLUB_MOVEMENT = 100000;
const CLUB_MOVEMENT_HISTORY_LIMIT = 30;
const CLUB_SEASON_HISTORY_LIMIT = 12;

function emptyClubTreasury(seasonKey, history = []) {
  return { seasonKey: String(seasonKey || monthKey()), accounts: {}, history: history.slice(-CLUB_SEASON_HISTORY_LIMIT) };
}

function cleanClubTreasury(value, seasonKey) {
  const safeHistory = Array.isArray(value?.history) ? value.history.slice(-CLUB_SEASON_HISTORY_LIMIT).map(item => ({
    seasonKey: /^\d{4}-\d{2}$/.test(String(item?.seasonKey || '')) ? String(item.seasonKey) : '',
    closedAt: Math.max(0, Number(item?.closedAt) || 0),
    top: Array.isArray(item?.top) ? item.top.slice(0, 10).filter(entry => entry && typeof entry.clubId === 'string').map(entry => ({
      clubId: entry.clubId.slice(0, 80),
      balance: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(entry.balance) || 0)))
    })) : []
  })).filter(item => item.seasonKey) : [];
  const wantedSeason = String(seasonKey || monthKey());
  if (!value || value.seasonKey !== wantedSeason || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) {
    return emptyClubTreasury(wantedSeason, safeHistory);
  }
  const accounts = {};
  for (const [clubId, raw] of Object.entries(value.accounts).slice(0, 10000)) {
    if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(clubId) || !raw || typeof raw !== 'object') continue;
    const movements = Array.isArray(raw.movements) ? raw.movements.slice(-CLUB_MOVEMENT_HISTORY_LIMIT).filter(item =>
      item && ['deposit', 'transfer'].includes(item.type) && Number(item.amount) > 0 && item.actorId
    ).map(item => ({
      id: String(item.id || '').slice(0, 80),
      operationId: String(item.operationId || '').slice(0, 100),
      type: item.type,
      amount: Math.min(MAX_CLUB_MOVEMENT, Math.max(1, Math.floor(Number(item.amount) || 0))),
      actorId: String(item.actorId).slice(0, 80),
      targetId: item.targetId ? String(item.targetId).slice(0, 80) : null,
      note: typeof item.note === 'string' ? item.note.replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, 80) : '',
      time: Math.max(0, Number(item.time) || 0),
      seasonKey: wantedSeason,
      balanceAfter: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(item.balanceAfter) || 0)))
    })) : [];
    accounts[clubId] = {
      balance: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(raw.balance) || 0))),
      movements
    };
  }
  return { seasonKey: wantedSeason, accounts, history: safeHistory };
}

function closeClubTreasurySeason(value, fromSeason, toSeason, closedAt) {
  const current = cleanClubTreasury(value, fromSeason);
  const top = Object.entries(current.accounts)
    .map(([clubId, account]) => ({ clubId, balance: account.balance }))
    .filter(item => item.balance > 0)
    .sort((a, b) => b.balance - a.balance || a.clubId.localeCompare(b.clubId))
    .slice(0, 10);
  const history = [...current.history, { seasonKey: String(fromSeason), closedAt: Number(closedAt) || Date.now(), top }]
    .slice(-CLUB_SEASON_HISTORY_LIMIT);
  return emptyClubTreasury(toSeason, history);
}

function recordClubChipTransaction(profile, amount, reason, time) {
  profile.transactions = Array.isArray(profile.transactions) ? profile.transactions : [];
  profile.transactions.push({ amount, reason: String(reason).slice(0, 120), time });
  profile.transactions = profile.transactions.slice(-HISTORY_LIMITS.transactions);
  profile.balanceHistory = Array.isArray(profile.balanceHistory) ? profile.balanceHistory : [];
  profile.balanceHistory.push({ t: time, chips: profile.chips });
  profile.balanceHistory = profile.balanceHistory.slice(-HISTORY_LIMITS.balance);
}

class BaseProfileStore {
  constructor() {
    this.profiles = new Map();
    this.saveTimer = null;
    this.saveDelayMs = 180;
    this.seasons = { current: monthKey(), history: [] };
    this.seasons.clubTreasury = emptyClubTreasury(this.seasons.current);
    this._passportSeasonMonth = null;
    // Fase 11.4: ids borrados que el backend de Postgres todavía no confirmó
    // en la base (deleteProfile los agrega; PgProfileStore._writeSnapshot los
    // limpia solo después de un DELETE exitoso). El backend de archivo no lo
    // necesita: como reescribe el archivo completo en cada guardado, un perfil
    // fuera de `this.profiles` ya desaparece solo.
    this._pendingDeletes = new Set();
  }

  getClubTreasury(clubId) {
    const seasonKey = String(this.seasons.current || monthKey());
    this.seasons.clubTreasury = cleanClubTreasury(this.seasons.clubTreasury, seasonKey);
    const account = this.seasons.clubTreasury.accounts[String(clubId || '')] || { balance: 0, movements: [] };
    return {
      seasonKey,
      balance: account.balance,
      movements: account.movements.map(item => ({ ...item }))
    };
  }

  getClubTreasuryBalance(clubId) { return this.getClubTreasury(clubId).balance; }

  applyClubTreasuryMovement({
    clubId, type, amount, actorId, targetId = null, operationId, note = '', now = Date.now(), validate
  } = {}) {
    const time = Number(now) > 0 ? Number(now) : Date.now();
    this.ensureSeason(new Date(time));
    const numericAmount = Number(amount);
    if (!Number.isSafeInteger(numericAmount) || numericAmount < 1 || numericAmount > MAX_CLUB_MOVEMENT) {
      return { ok: false, code: 'amount_invalid', error: `El movimiento debe ser de 1 a ${MAX_CLUB_MOVEMENT.toLocaleString('es-MX')} fichas.` };
    }
    if (!['deposit', 'transfer'].includes(type)) return { ok: false, code: 'movement_invalid', error: 'El tipo de movimiento no está disponible.' };
    const safeClubId = String(clubId || '').slice(0, 80);
    const safeActorId = String(actorId || '').slice(0, 80);
    const safeTargetId = targetId == null ? null : String(targetId).slice(0, 80);
    const safeOperationId = String(operationId || '');
    if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(safeOperationId)) {
      return { ok: false, code: 'idempotency_required', error: 'Actualiza la página e inténtalo de nuevo.' };
    }
    if (!safeClubId || !safeActorId || (type === 'transfer' && !safeTargetId)) {
      return { ok: false, code: 'movement_invalid', error: 'Faltan datos para completar el movimiento.' };
    }
    const authorization = typeof validate === 'function' ? validate() : { ok: false, code: 'permission_denied', error: 'No se pudo validar el acceso al club.' };
    if (!authorization?.ok) return authorization || { ok: false, code: 'permission_denied', error: 'No se pudo validar el acceso al club.' };

    const actor = this.getProfile(safeActorId);
    if (!actor?.username) return { ok: false, code: 'account_required', error: 'La cuenta no está disponible.' };
    const recipient = type === 'transfer' ? this.getProfile(safeTargetId) : null;
    if (type === 'transfer' && !recipient?.username) return { ok: false, code: 'recipient_unavailable', error: 'La cuenta destinataria no está disponible.' };

    const seasonKey = String(this.seasons.current || monthKey());
    this.seasons.clubTreasury = cleanClubTreasury(this.seasons.clubTreasury, seasonKey);
    const accounts = this.seasons.clubTreasury.accounts;
    const account = accounts[safeClubId] || (accounts[safeClubId] = { balance: 0, movements: [] });
    const previousMovement = account.movements.find(item => item.operationId === safeOperationId);
    if (previousMovement) {
      const sameOperation = previousMovement.type === type && previousMovement.amount === numericAmount
        && previousMovement.actorId === safeActorId && previousMovement.targetId === safeTargetId;
      if (!sameOperation) return { ok: false, code: 'idempotency_conflict', error: 'La operación ya se procesó con otros datos.' };
      return {
        ok: true, code: 'duplicate_operation', duplicate: true,
        balance: account.balance, actorChips: actor.chips, targetChips: recipient?.chips ?? null,
        seasonKey, movement: { ...previousMovement }
      };
    }

    if (type === 'deposit') {
      if (actor.chips < numericAmount) return { ok: false, code: 'balance_insufficient', error: 'No tienes suficientes fichas para esa aportación.' };
      if (account.balance > Number.MAX_SAFE_INTEGER - numericAmount) return { ok: false, code: 'treasury_limit', error: 'La tesorería llegó al límite permitido.' };
      actor.chips -= numericAmount;
      recordClubChipTransaction(actor, -numericAmount, `Aportación al club: ${String(authorization.club?.name || 'club').slice(0, 24)}`, time);
      this.touch(actor);
      account.balance += numericAmount;
    } else {
      if (account.balance < numericAmount) return { ok: false, code: 'treasury_insufficient', error: 'La tesorería no tiene suficientes fichas para ese movimiento.' };
      if (recipient.chips > Number.MAX_SAFE_INTEGER - numericAmount) return { ok: false, code: 'recipient_balance_limit', error: 'El saldo de la persona destinataria llegó al límite permitido.' };
      recipient.chips += numericAmount;
      recordClubChipTransaction(recipient, numericAmount, `Movimiento recibido del club: ${String(authorization.club?.name || 'club').slice(0, 24)}`, time);
      this.touch(recipient);
      account.balance -= numericAmount;
    }

    const safeNote = String(note || '').replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const movement = {
      id: crypto.randomUUID(), operationId: safeOperationId, type, amount: numericAmount,
      actorId: safeActorId, targetId: safeTargetId, note: safeNote, time, seasonKey,
      balanceAfter: account.balance
    };
    account.movements = [...account.movements, movement].slice(-CLUB_MOVEMENT_HISTORY_LIMIT);
    return {
      ok: true, code: type === 'deposit' ? 'deposit_complete' : 'transfer_complete',
      balance: account.balance, actorChips: actor.chips, targetChips: recipient?.chips ?? null,
      seasonKey, movement: { ...movement }
    };
  }

  async flushClubTreasury() {
    clearTimeout(this.saveTimer);
    return this.saveNow();
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
    const retainedTreasury = this.seasons.clubTreasury || emptyClubTreasury(futureMonth);
    this.seasons.clubTreasury = cleanClubTreasury({ ...retainedTreasury, seasonKey: correctMonth }, correctMonth);
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
    // El Pasaporte sigue su propio mes calendario aunque el reinicio de fichas
    // del casino se aplace por un ciclo ajeno. Solo se reinicia la parte
    // temporal; inventory/equipped sobreviven y se guardan en ambos backends.
    // El barrido se hace al arrancar y una vez al cambiar de mes, no en cada
    // alta de socket/perfil.
    if (this._passportSeasonMonth !== now) {
      for (const profile of this.profiles.values()) {
        if (ensurePassportSeason(profile, date)) {
          const lastActivityAt = profile.updatedAt;
          this.touch(profile);
          // Un reinicio pasivo de temporada no debe parecer actividad humana
          // ni impedir la política existente de depuración de cuentas inactivas.
          profile.updatedAt = lastActivityAt;
        }
      }
      this._passportSeasonMonth = now;
    }
    this.seasons.clubTreasury = cleanClubTreasury(this.seasons.clubTreasury, this.seasons.current);
    if (this.seasons.current === now) {
      this.seasons.clubTreasury = cleanClubTreasury(this.seasons.clubTreasury, now);
      return null;
    }
    // Nunca se cierra una temporada "hacia atrás". Este caso identifica y
    // corrige automáticamente datos afectados por el antiguo calendario UTC.
    if (this.seasons.current > now) return this._repairPrematureSeason(now, date);

    // Fase F (A12): antes de cerrar la temporada del casino y reiniciar TODOS los
    // saldos, se consulta un gancho opcional `onBeforeSeasonReset`. Sirve para no
    // pisar una temporada de fútbol que aún tenga apuestas abiertas: si el gancho
    // devuelve {type:'deferred'}, se aplaza el reset. Hay un tope de aplazamientos
    // (SEASON_RESET_MAX_DEFERRALS) para que el casino nunca quede atascado para
    // siempre en una temporada vieja si el gancho se quedara enganchado.
    if (typeof this.onBeforeSeasonReset === 'function') {
      const gate = this.onBeforeSeasonReset({ fromMonth: this.seasons.current, toMonth: now, date });
      if (gate && gate.type === 'deferred') {
        this._seasonDeferrals = (this._seasonDeferrals || 0) + 1;
        const max = Number(process.env.SEASON_RESET_MAX_DEFERRALS || 12);
        if (this._seasonDeferrals < max) {
          this.scheduleSave();
          return {
            type: 'deferred', month: this.seasons.current, toMonth: now,
            deferrals: this._seasonDeferrals, maxDeferrals: max,
            reason: gate.reason || 'apuestas_de_futbol_abiertas', at: date.getTime()
          };
        }
        console.warn(
          `Temporada del casino: se agotaron ${max} aplazamientos (${gate.reason || 'gate'}); ` +
          `se fuerza el cierre ${this.seasons.current} → ${now}.`
        );
      }
    }

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
    this.seasons.clubTreasury = closeClubTreasurySeason(this.seasons.clubTreasury, this.seasons.current, now, date.getTime());
    this.seasons.current = now;
    this._seasonDeferrals = 0; // el cierre ocurrió: se reinicia el contador de aplazamientos
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
    // Los premios BDO marcados para recovery al cambio de mes se aplican DESPUÉS
    // del reset para que el nuevo saldo no los borre. El hook nunca puede detener
    // el casino si una liquidación falla.
    if (typeof this.onAfterSeasonReset === 'function') {
      try { this.onAfterSeasonReset({ fromMonth: closed.month, toMonth: now, date, closed }); }
      catch (error) { console.warn('Hook posterior al reset de temporada falló:', error.message); }
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

  // Fase D — acceso de solo lectura por id, SIN crear el perfil si no existe.
  // `getOrCreate` fabrica un perfil nuevo (y dispara ensureSeason); liquidar una
  // apuesta o reembolsar un escrow necesita el perfil que YA existe, nunca crear
  // uno (§12.7, hallazgo 10: los handlers de dinero no resuelven identidad).
  getProfile(id) {
    return this.profiles.get(String(id == null ? '' : id)) || null;
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

  resetPassword(profile, newPassword) {
    if (!profile?.passwordHash) return { ok: false, error: 'Cuenta no disponible.' };
    if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) return { ok: false, error: 'La nueva contraseña debe tener entre 10 y 128 caracteres.' };
    if (verifyPassword(newPassword, profile.passwordHash)) return { ok: false, error: 'La nueva contraseña debe ser diferente de la anterior.' };
    profile.passwordHash = hashPassword(newPassword);
    profile.security = profile.security || {};
    profile.security.sessionVersion = Math.max(1, Number(profile.security.sessionVersion) || 1) + 1;
    profile.security.passwordChangedAt = Date.now(); profile.security.mustChangePassword = false;
    profile.flags = profile.flags || {}; profile.flags.loginFailures = 0; delete profile.flags.loginLockedUntil;
    this.touch(profile); return { ok: true, profile };
  }

  changePassword(profile, currentPassword, newPassword) {
    if (!profile?.passwordHash || !verifyPassword(currentPassword, profile.passwordHash)) {
      return { ok: false, error: 'La contraseña actual es incorrecta.' };
    }
    if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) {
      return { ok: false, error: 'La nueva contraseña debe tener entre 10 y 128 caracteres.' };
    }
    if (verifyPassword(newPassword, profile.passwordHash)) {
      return { ok: false, error: 'La nueva contraseña debe ser diferente de la actual.' };
    }
    profile.passwordHash = hashPassword(newPassword);
    profile.security = profile.security || {};
    profile.security.sessionVersion = Math.max(1, Number(profile.security.sessionVersion) || 1) + 1;
    profile.security.passwordChangedAt = Date.now();
    profile.security.mustChangePassword = false;
    profile.flags = profile.flags || {};
    profile.flags.loginFailures = 0;
    delete profile.flags.loginLockedUntil;
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
    const effective = effectiveModeration(profile, now);
    if (effective.expired) profile.moderation = { status: 'active', reason: 'Suspensión cumplida', until: null, actionId: profile.moderation?.actionId || null, updatedAt: now };
    const blocked = moderationMessage(profile, now);
    this.touch(profile);
    if (blocked) return { ok: false, ...blocked };
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

module.exports = {
  BaseProfileStore,
  MAX_CLUB_MOVEMENT,
  emptyClubTreasury,
  cleanClubTreasury,
  closeClubTreasurySeason
};
