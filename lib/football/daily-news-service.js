'use strict';

// Servicio editorial perezoso: como mucho una edición por día de casino. El
// scheduler lo prepara sin usuarios; una consulta también puede hacerlo. Nunca
// encola emisiones atrasadas ni depende de que un timer se disparara a medianoche.
const { buildDailyEdition, dayKey, previousDay } = require('./daily-news');
const { CASINO_TIME_ZONE } = require('../football-store-shared');
const { ranking } = require('./fan-club');

const EDITION_LIMIT = 45;
const RESERVATION_MS = 30000;
const FLAG = 'montecristoNewsDaily';

function emptyState() { return { version: 1, editions: {}, operational: {} }; }
function publicState(state) {
  return { editionCount: Object.keys(state?.editions || {}).length,
    lastReadyDay: state?.operational?.lastReadyDay || null,
    lastReadyAt: state?.operational?.lastReadyAt || null };
}
function previousMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

function createDailyNewsService({ store, profiles = null, now = () => Date.now(),
  readiness = () => ({ ready: true }), enabled = true, log = () => {}, timeZone = CASINO_TIME_ZONE } = {}) {
  if (!store) throw new Error('daily news requiere store');
  if (!store.dailyNews) store.dailyNews = emptyState();
  let queue = Promise.resolve();
  let failures = 0;
  function serialize(work) {
    const task = queue.catch(() => {}).then(work);
    queue = task.catch(() => {});
    return task;
  }
  async function commit(next) {
    const before = store.dailyNews;
    store.dailyNews = next;
    let saved = false;
    try { saved = await store.saveStrict(); } catch (_) { saved = false; }
    if (!saved) {
      if (store.dailyNews === next) store.dailyNews = before;
      return false;
    }
    return true;
  }
  function prepare(at = now()) {
    if (!enabled) return Promise.resolve({ ok: true, status: 'disabled', edition: null });
    if (!Number.isSafeInteger(at)) return Promise.resolve({ ok: false, status: 'unavailable', edition: null });
    return serialize(async () => {
      const day = dayKey(at, timeZone);
      const state = store.dailyNews || emptyState();
      const existing = state.editions[day];
      if (existing) return { ok: true, status: 'ready', edition: existing, replayed: true };
      let gate;
      try { gate = readiness(at); } catch (_) { gate = { ready: false, reason: 'readiness_error' }; }
      if (!gate?.ready || (store.writerLease && !store.writerLease.active)) {
        return { ok: true, status: 'preparing', edition: null, reason: gate?.reason || 'writer_pending', retryAfterMs: 15000 };
      }
      const league = store.getLeague();
      const previousLeague = league ? store.getLeague(previousMonth(league.seasonMonth)) : null;
      let edition;
      try {
        const previousDayEdition = state.editions[previousDay(day)] || null;
        edition = buildDailyEdition({ league, previousLeague, leagues: [...store.leagues.values()], at,
          fanRanking: profiles?.profiles ? ranking(profiles.profiles, store.leagues, at, undefined, { includeMilestones: true }) : [],
          previousEdition: previousDayEdition, operational: state.operational, timeZone });
      } catch (error) {
        failures++;
        log('football_daily_news_build_error', { message: String(error?.message || error) });
        return { ok: false, status: 'unavailable', edition: null, retryAfterMs: 15000 };
      }
      if (!edition) return { ok: true, status: 'preparing', edition: null, reason: 'season_not_ready', retryAfterMs: 15000 };
      const keys = [...Object.keys(state.editions), day].sort().slice(-EDITION_LIMIT);
      const next = { version: 1,
        editions: Object.fromEntries(keys.map(key => [key, key === day ? edition : state.editions[key]])),
        operational: { lastReadyDay: day, lastReadyAt: at } };
      if (!await commit(next)) {
        failures++;
        log('football_daily_news_persist_error', { day });
        return { ok: false, status: 'unavailable', edition: null, retryAfterMs: 15000 };
      }
      log('football_daily_news_prepared', { day, mode: edition.mode, items: edition.items.length,
        recoveredMatches: edition.coverage.recoveredMatches, scriptCharacters: edition.scriptCharacters });
      return { ok: true, status: 'ready', edition, replayed: false };
    });
  }
  function snapshot(profile, at = now()) {
    const day = dayKey(at, timeZone);
    const flag = profile?.flags?.[FLAG] || {};
    const reservation = flag.reservation;
    const reserved = reservation?.day === day && reservation.expiresAt > at;
    return { day, lastPresentedDay: flag.lastPresentedDay || null,
      shouldOpen: flag.lastPresentedDay !== day && !reserved, reserved };
  }
  // Reserva durable antes de entregar el derecho de apertura. Dos pestañas del
  // mismo perfil compiten en la cola del socket; no se acepta profileId externo.
  async function reserve(profile, editionId, socketId, persistProfile, at = now()) {
    if (!enabled || !profile || !socketId || !editionId) return { ok: false, code: 'invalid' };
    const prepared = await prepare(at);
    if (prepared.status !== 'ready') return prepared;
    if (prepared.edition.id !== editionId) return { ok: false, code: 'edition_changed', edition: prepared.edition };
    const day = prepared.edition.day;
    const flag = profile.flags?.[FLAG] || {};
    if (flag.lastPresentedDay === day) return { ok: true, granted: false, reason: 'already_presented', edition: prepared.edition };
    const active = flag.reservation && flag.reservation.day === day && flag.reservation.expiresAt > at;
    if (active && flag.reservation.socketId !== socketId) return { ok: true, granted: false, reason: 'reserved', edition: prepared.edition };
    if (active && flag.reservation.socketId === socketId) return { ok: true, granted: true, edition: prepared.edition };
    const before = profile.flags?.[FLAG];
    profile.flags = profile.flags && typeof profile.flags === 'object' ? profile.flags : {};
    profile.flags[FLAG] = { ...flag, reservation: { day, editionId, socketId, expiresAt: at + RESERVATION_MS } };
    let saved = false;
    try { saved = await persistProfile(profile); } catch (_) { saved = false; }
    if (!saved) {
      if (before === undefined) delete profile.flags[FLAG]; else profile.flags[FLAG] = before;
      return { ok: false, code: 'save_pending', retryAfterMs: 15000 };
    }
    return { ok: true, granted: true, edition: prepared.edition };
  }
  // Se confirma al montar la pantalla, no al precargar datos ni al terminar el
  // audio. Saltar la intro cuenta como presentada; una reserva abandonada expira.
  async function acknowledge(profile, editionId, socketId, persistProfile, at = now()) {
    const day = dayKey(at, timeZone);
    const edition = store.dailyNews?.editions?.[day];
    if (!enabled || !edition || edition.id !== editionId) return { ok: false, code: 'edition_changed' };
    const flag = profile.flags?.[FLAG] || {};
    if (flag.lastPresentedDay === day) return { ok: true, acknowledged: true };
    if (flag.reservation?.socketId !== socketId || flag.reservation.day !== day || flag.reservation.editionId !== editionId) {
      return { ok: false, code: 'reservation_required' };
    }
    const before = profile.flags?.[FLAG];
    profile.flags = profile.flags && typeof profile.flags === 'object' ? profile.flags : {};
    profile.flags[FLAG] = { lastPresentedDay: day, lastPresentedAt: at, editionId, reservation: null };
    let saved = false;
    try { saved = await persistProfile(profile); } catch (_) { saved = false; }
    if (!saved) {
      profile.flags[FLAG] = before;
      return { ok: false, code: 'save_pending' };
    }
    return { ok: true, acknowledged: true };
  }
  return { prepare, snapshot, reserve, acknowledge, healthSnapshot: () => ({ enabled, failures, ...publicState(store.dailyNews) }) };
}

module.exports = { createDailyNewsService, emptyState, EDITION_LIMIT, RESERVATION_MS, FLAG };
