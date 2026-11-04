'use strict';

// Fusión explícita invitado → cuenta. No vuelve a entregar recompensas de logros:
// une inventarios y contadores. Los boletos conservan su id/operationId y cambian
// de dueño; nunca se cancelan para recrearlos ni se suma dos veces un pago.
const crypto = require('node:crypto');
const { cleanProfile, HISTORY_LIMITS } = require('./profile-store-shared');
const { POINT_MILESTONES } = require('./passport');
const { MAX_COPIES } = require('./card-gacha');
const MAX_PASSPORT_POINTS = Math.max(...POINT_MILESTONES);

const sum = (a, b) => Math.max(0, Math.floor(Number(a) || 0) + Math.floor(Number(b) || 0));
const union = (a, b, limit = 1000) => [...new Set([...(a || []), ...(b || [])])].slice(-limit);
const clone = value => JSON.parse(JSON.stringify(value));

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function footballLiabilities(store, profileId) {
  if (!store) return { bets: [], parlays: [], futures: [], quiniela: [] };
  const own = item => item.profileId === profileId;
  const quiniela = [];
  for (const league of store.leagues?.values?.() || []) {
    for (const [jornada, round] of Object.entries(league.quiniela?.rounds || {})) {
      const ticket = round.tickets?.[profileId];
      if (ticket) quiniela.push({ season: league.seasonMonth, jornada: Number(jornada), ticket: clone(ticket) });
    }
  }
  return {
    bets: [...(store.bets?.values?.() || [])].filter(own).map(clone),
    parlays: [...(store.parlays?.values?.() || [])].filter(own).map(clone),
    futures: [...(store.futures?.values?.() || [])].filter(own).map(clone),
    quiniela
  };
}

function mergeProfiles(accountValue, guestValue, { operationId, now = Date.now() }) {
  const account = cleanProfile(clone(accountValue));
  const guest = cleanProfile(clone(guestValue));
  if (!account.username || guest.username || account.id === guest.id) throw new Error('Perfiles no combinables');
  const additive = ['roundsPlayed', 'wins', 'losses', 'totalWagered'];
  for (const key of additive) account.stats[key] = sum(account.stats[key], guest.stats[key]);
  for (const key of ['biggestWin', 'bestStreak', 'eligibleBestStreak']) account.stats[key] = Math.max(account.stats[key] || 0, guest.stats[key] || 0);
  account.chips = sum(account.chips, guest.chips);
  account.medals = sum(account.medals, guest.medals);
  account.championBanner ||= guest.championBanner;
  account.gamesPlayed = union(account.gamesPlayed, guest.gamesPlayed, 20);
  account.achievements = union(account.achievements, guest.achievements, 100);
  account.featuredAchievements = union(account.featuredAchievements, guest.featuredAchievements, 3);
  account.lobbyTournamentPayouts = union(account.lobbyTournamentPayouts, guest.lobbyTournamentPayouts, 256);
  account.appliedChipOperations = union(account.appliedChipOperations, guest.appliedChipOperations, 1000);
  account.footballPendingPayments = union(account.footballPendingPayments, guest.footballPendingPayments);
  account.footballPendingStakes = union(account.footballPendingStakes, guest.footballPendingStakes);
  for (const [game, row] of Object.entries(guest.gameStats || {})) {
    const target = account.gameStats[game] || { rounds: 0, wins: 0, net: 0 };
    account.gameStats[game] = { rounds: sum(target.rounds, row.rounds), wins: sum(target.wins, row.wins), net: (Number(target.net) || 0) + (Number(row.net) || 0) };
  }
  for (const id of Object.keys(guest.challenges || {})) if (guest.challenges[id]) account.challenges[id] = true;
  // Retos periódicos y racha vigente conservan la cuenta: fusionarlos podría
  // fabricar una racha o reclamar dos veces el mismo periodo.
  const ap = account.passport, gp = guest.passport;
  ap.unlockedCosmetics = union(ap.unlockedCosmetics, gp.unlockedCosmetics, 100);
  if (ap.currentSeason.key === gp.currentSeason.key) {
    ap.currentSeason.points = Math.min(MAX_PASSPORT_POINTS, sum(ap.currentSeason.points, gp.currentSeason.points));
    ap.currentSeason.games = union(ap.currentSeason.games, gp.currentSeason.games, 20);
    ap.currentSeason.processedRoundIds = union(ap.currentSeason.processedRoundIds, gp.currentSeason.processedRoundIds, 2000);
  }
  for (const slot of Object.keys(ap.equipped)) if (!ap.equipped[slot] && ap.unlockedCosmetics.includes(gp.equipped[slot])) ap.equipped[slot] = gp.equipped[slot];
  account.collection.unlocked = union(account.collection.unlocked, guest.collection.unlocked, 100);
  for (const slot of Object.keys(account.collection.equipped)) if (!account.collection.equipped[slot]) account.collection.equipped[slot] = guest.collection.equipped[slot] || null;
  account.cardAlbum.counts = { ...(account.cardAlbum.counts || {}) };
  for (const [id, count] of Object.entries(guest.cardAlbum.counts || {})) account.cardAlbum.counts[id] = Math.min(MAX_COPIES, sum(account.cardAlbum.counts[id], count));
  account.dailyBonusDate = [account.dailyBonusDate, guest.dailyBonusDate].filter(Boolean).sort().at(-1) || null;
  account.transactions = [...(account.transactions || []), ...(guest.transactions || []),
    { type: 'import', amount: guestValue.chips, reason: 'Progreso de invitado importado', time: now, operationId }].slice(-HISTORY_LIMITS.transactions);
  account.balanceHistory = [...(account.balanceHistory || []), { t: now, chips: account.chips }].slice(-HISTORY_LIMITS.balance);
  const promotions = new Map((account.promotions || []).map(item => [item.id, item]));
  for (const item of guest.promotions || []) if (!promotions.has(item.id)) promotions.set(item.id, item);
  account.promotions = [...promotions.values()];
  if (!account.footballFanClub && guest.footballFanClub) account.footballFanClub = guest.footballFanClub;
  if (!account.footballFantasy && guest.footballFantasy) account.footballFantasy = guest.footballFantasy;
  if ((guest.flags?.tosVersion || '') > (account.flags?.tosVersion || '')) {
    account.flags.tosVersion = guest.flags.tosVersion;
    account.flags.tosAcceptedAt = guest.flags.tosAcceptedAt;
  }
  account.guestImports = union(account.guestImports, [guest.id], 100);
  account.updatedAt = now;
  const source = cleanProfile(clone(guestValue));
  source.chips = 0;
  source.mergedInto = account.id;
  source.mergedAt = now;
  source.mergeOperationId = operationId;
  source.updatedAt = now;
  return { account, source };
}

class GuestImportService {
  constructor({ profiles, footballStore = null, deviceLinks, blockers = () => [], now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { profiles, footballStore, deviceLinks, blockers, now, log });
    this.locks = new Set();
  }
  inspect(accountId, guestToken) {
    const account = this.profiles.getProfile(accountId);
    const guest = this.profiles.getProfile(String(guestToken || '').slice(0, 80));
    if (!account?.username) return { ok: false, code: 'account_session_required', error: 'Inicia sesión con tu cuenta.' };
    if (!guest || guest.id === account.id) return { ok: true, available: false, reason: 'nothing_to_import' };
    if (guest.mergedInto) return { ok: true, available: false, reason: 'already_imported', mergedInto: guest.mergedInto };
    const blockers = [...this.blockers(guest.id, account.id)];
    if (guest.username) blockers.push('guest_has_account');
    if (guest.footballPendingPayments?.length || guest.footballPendingStakes?.length) blockers.push('pending_settlement');
    const source = footballLiabilities(this.footballStore, guest.id);
    const target = footballLiabilities(this.footballStore, account.id);
    for (const kind of ['bets', 'parlays', 'futures']) {
      const keys = new Set(target[kind].filter(item => ['pending', 'open'].includes(item.status)).map(item => `${item.matchId || item.seasonMonth}:${item.market}:${item.selection || ''}`));
      if (source[kind].some(item => ['pending', 'open'].includes(item.status) && keys.has(`${item.matchId || item.seasonMonth}:${item.market}:${item.selection || ''}`))) blockers.push(`duplicate_${kind}`);
    }
    const targetRounds = new Set(target.quiniela.map(item => `${item.season}:${item.jornada}`));
    if (source.quiniela.some(item => targetRounds.has(`${item.season}:${item.jornada}`))) blockers.push('duplicate_quiniela');
    if (source.quiniela.some(item => item.ticket.status === 'pending_debit')) blockers.push('pending_settlement');
    if (account.footballFanClub && guest.footballFanClub) blockers.push('fan_club_conflict');
    if (account.footballFantasy && guest.footballFantasy) blockers.push('fantasy_conflict');
    const version = fingerprint({ account, guest, source, blockers });
    return { ok: true, available: blockers.length === 0, version, blockers: [...new Set(blockers)],
      guest: { name: guest.name, chips: guest.chips, achievements: guest.achievements.length,
        bets: source.bets.length, parlays: source.parlays.length, futures: source.futures.length, quiniela: source.quiniela.length },
      account: { name: account.name, chips: account.chips }, resultingChips: sum(account.chips, guest.chips) };
  }
  async import({ accountId, guestToken, operationId, version }) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(String(operationId || ''))) return { ok: false, code: 'operation_required', error: 'Identificador de operación inválido.' };
    const account = this.profiles.getProfile(accountId);
    if (account?.guestImports?.includes(String(guestToken || '').slice(0, 80))) return { ok: true, replayed: true, profile: account };
    const preview = this.inspect(accountId, guestToken);
    if (!preview.ok || !preview.available) return { ok: false, code: preview.code || 'import_blocked', error: 'El progreso cambió o tiene operaciones pendientes. Revisa la vista previa.', preview };
    if (version !== preview.version) return { ok: false, code: 'preview_stale', error: 'El progreso cambió. Confirma la nueva vista previa.', preview };
    const guest = this.profiles.getProfile(guestToken);
    const keys = [accountId, guest.id];
    if (keys.some(key => this.locks.has(key))) return { ok: false, code: 'import_in_progress', error: 'Ya hay una importación en curso.' };
    keys.forEach(key => this.locks.add(key));
    try {
      const merged = mergeProfiles(account, guest, { operationId, now: this.now() });
      const result = await this.profiles.applyGuestImport({ account: merged.account, source: merged.source, operationId,
        footballStore: this.footballStore, deviceLinks: this.deviceLinks });
      if (!result) throw new Error('No se pudo confirmar la importación');
      this.log('guest_progress_imported', { operationId, targetProfileId: accountId, sourceProfileId: guest.id, chips: guest.chips });
      return { ok: true, replayed: false, profile: merged.account };
    } finally { keys.forEach(key => this.locks.delete(key)); }
  }
  async recover() { return this.profiles.recoverGuestImport?.({ footballStore: this.footballStore, deviceLinks: this.deviceLinks }); }
}

module.exports = { GuestImportService, mergeProfiles, footballLiabilities, fingerprint };
