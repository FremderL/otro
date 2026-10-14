'use strict';

// Regresión: en el lobby, el perfil de cuenta debe mostrar datos actuales o
// avisar que no se pudieron confirmar. Antes, sin socket conectado, el modal
// mostraba la caché vieja sin ningún aviso y no se reintentaba al reconectar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { cleanProfile } = require('../lib/profile-store-shared');
const { publicProgress } = require('../lib/progression');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const SESSION_KEY = 'montecristo-account-session';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function accountProfile(roundsPlayed) {
  return publicProgress(cleanProfile({
    id: 'sync-account', username: 'sync_casino', name: 'Sincro', avatar: 'fox', chips: 1500,
    stats: { roundsPlayed, wins: 7, losses: 5 }, gamesPlayed: ['dice']
  }), true);
}

async function openLobbyProfile({ mode, connected }) {
  const fresh = accountProfile(12);
  const stale = accountProfile(5);
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'sync-device');
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(stale));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'sync-device';
  const online = { value: connected };
  window.fetch = async url => {
    const target = String(url);
    if (target.includes('/healthz')) {
      return { ok: true, json: async () => ({ accountSessionsEnabled: mode === 'cookie', passportEnabled: false, cardGachaEnabled: true, football: { enabled: false } }) };
    }
    if (target.includes('/api/auth/session') && mode === 'cookie') {
      return { ok: online.value, status: online.value ? 200 : 0, json: async () => ({ ok: true, profile: fresh, csrfToken: 'x' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const socket = {
    get connected() { return online.value; },
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      if (event === 'account_profile' && typeof ack === 'function') return ack({ ok: true, profile: fresh });
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {}, connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.connect?.();
  await wait(40);
  const rounds = () => {
    const text = document.getElementById('profile-stats').textContent.replace(/\s+/g, '');
    return Number(/RONDAS(\d+)/.exec(text)?.[1]);
  };
  const note = () => document.getElementById('profile-sync-note');
  document.getElementById('profile-card').click();
  await wait(60);
  return { window, rounds, note, online, handlers };
}

test('con socket conectado, abrir el perfil del lobby muestra los datos del servidor', async t => {
  const env = await openLobbyProfile({ mode: 'socket', connected: true });
  t.after(() => env.window.close());
  assert.equal(env.rounds(), 12);
  assert.ok(env.note().classList.contains('hidden'));
});

test('con sesión por cookie, el perfil se confirma con /api/auth/session', async t => {
  const env = await openLobbyProfile({ mode: 'cookie', connected: true });
  t.after(() => env.window.close());
  assert.equal(env.rounds(), 12);
  assert.ok(env.note().classList.contains('hidden'));
});

test('sin conexión, el perfil no se confirma: se avisa y al reconectar se actualiza', async t => {
  const env = await openLobbyProfile({ mode: 'socket', connected: false });
  t.after(() => env.window.close());
  assert.equal(env.rounds(), 5, 'muestra la caché guardada');
  assert.ok(!env.note().classList.contains('hidden'), 'el aviso de datos sin confirmar es visible');
  env.online.value = true;
  env.handlers.connect();
  await wait(60);
  assert.equal(env.rounds(), 12, 'al reconectar se pide el perfil actualizado');
  assert.ok(env.note().classList.contains('hidden'), 'el aviso desaparece tras confirmar');
});

// ---------------------------------------------------------------------------
// Sincronía de fichas: cada cambio de saldo (ack de cápsula, bono, ronda,
// profile_event) debe dejar al día el perfil del modal, el encabezado de la
// mesa y la caché de la cuenta, con el socket conectado.
// ---------------------------------------------------------------------------

function balanceProfile(chips, overrides = {}) {
  return publicProgress(cleanProfile({
    id: 'balance-account', username: 'balance_user', name: 'Saldo', avatar: 'fox', chips,
    stats: { roundsPlayed: 3, wins: 1, losses: 2 }, gamesPlayed: ['dice'], dailyBonusClaimed: false,
    dailyBonusAvailableAt: Date.now() - 1000, ...overrides
  }), true);
}

function tableRoom(viewerProfile) {
  const player = {
    id: viewerProfile.id, name: viewerProfile.name, avatar: viewerProfile.avatar, seat: 0, connected: true,
    hand: [], bet: 0, roundBet: 0, totalBet: 0, status: 'waiting', folded: false, allIn: false, acted: false,
    quickChoice: null, isBot: false, chips: viewerProfile.chips, stats: viewerProfile.stats,
    passport: { equipped: { frame: null, title: null, badge: null } },
    collection: { equipped: { avatar: null, frame: null, chips: null, felt: null, cards: null } }
  };
  return {
    code: 'SYNCA', name: 'Mesa de prueba', game: 'dice', phase: 'betting', hostId: player.id, viewerId: player.id,
    players: [player], spectators: [], viewerSpectator: null, viewerProfile, dealerHand: [], community: [],
    pot: 0, currentBet: 0, minRaise: 0, turnId: null, turnDeadline: null, turnDuration: 30, dealerIndex: 0,
    handNumber: 1, messages: [], results: [], quickResult: null, recentWinners: [], specialEvent: null,
    gameMeta: null, tournament: null, lobbyTournamentMatch: null, avatars: [], botOptions: { difficulties: [], styles: [], capacity: 6 }
  };
}

// Arranca el cliente con socket conectado y una sesión de cuenta. `responders`
// decide la respuesta de cada evento; `cookieMode` usa /api/auth/session por HTTP
// (con `sessionDelayMs` para simular una respuesta lenta).
async function bootBalanceClient({ profile, responders = {}, cookieMode = false, sessionDelayMs = 0 }) {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'balance-account');
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(profile));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'balance-account';
  window.fetch = async url => {
    const target = String(url);
    if (target.includes('/healthz')) {
      return { ok: true, json: async () => ({ accountSessionsEnabled: cookieMode, passportEnabled: false, cardGachaEnabled: true, football: { enabled: false } }) };
    }
    if (target.includes('/api/auth/session') && cookieMode) {
      await wait(sessionDelayMs);
      const current = JSON.parse(window.localStorage.getItem(SESSION_KEY));
      return { ok: true, status: 200, json: async () => ({ ok: true, profile: { ...current, chips: profile.chips }, csrfToken: 'x' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      const respond = responders[event];
      if (typeof ack !== 'function') return;
      if (respond) return ack(respond(payload));
      ack({ ok: true });
    },
    disconnect() {}, connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.connect?.();
  await wait(40);
  const doc = window.document;
  return {
    window, doc, handlers,
    modalChips: () => {
      const text = doc.getElementById('profile-stats').textContent.replace(/\s+/g, '');
      return Number(/FICHAS([\d.,]+)/.exec(text)?.[1]?.replace(/[.,]/g, ''));
    },
    headerChips: () => {
      const text = doc.getElementById('profile-card').textContent.replace(/\s+/g, ' ');
      return Number(/◆\s*([\d.,]+)\s*fichas/.exec(text)?.[1]?.replace(/[.,]/g, ''));
    },
    cachedChips: () => JSON.parse(window.localStorage.getItem(SESSION_KEY)).chips,
    openProfile: async () => {
      if (!doc.getElementById('profile-modal').classList.contains('open')) doc.getElementById('profile-card').click();
      await wait(60);
    },
    closeProfile: async () => { doc.querySelector('#profile-modal .modal-close')?.click(); await wait(20); }
  };
}

test('con socket conectado: la cápsula del lobby deja el saldo nuevo en el perfil y en la caché', async t => {
  // El servidor simulado conserva el saldo entre peticiones (como el real).
  let serverChips = 20000;
  const env = await bootBalanceClient({
    profile: balanceProfile(20000),
    responders: {
      account_profile: () => ({ ok: true, profile: balanceProfile(serverChips) }),
      card_gacha_pull: () => {
        serverChips = 15000;
        return { ok: true, card: { id: 'c1', name: 'Carta', rarity: 'comun', rank: 'A', suit: 'espadas', motif: 'x', symbol: '♠', count: 1, duplicate: false }, profile: balanceProfile(serverChips) };
      }
    }
  });
  t.after(() => env.window.close());
  await env.openProfile();
  assert.equal(env.modalChips(), 20000);
  env.doc.getElementById('album-open-capsule').click();
  await wait(60);
  assert.equal(env.modalChips(), 15000, 'el modal muestra el saldo que devolvió la cápsula');
  assert.equal(env.cachedChips(), 15000, 'la caché de la cuenta también se actualiza');
  await env.closeProfile();
  await env.openProfile();
  assert.equal(env.modalChips(), 15000, 'al volver a abrir el perfil sigue el saldo nuevo');
});

test('en una mesa: el bono diario deja el saldo nuevo en el perfil, el encabezado y la caché', async t => {
  const profile = balanceProfile(1000);
  const env = await bootBalanceClient({
    profile,
    responders: {
      daily_bonus_claim: () => ({ ok: true, claimed: true, reward: 100, profile: balanceProfile(1100, { dailyBonusClaimed: true }) })
    }
  });
  t.after(() => env.window.close());
  env.handlers.room_state(tableRoom(profile));
  await wait(30);
  assert.equal(env.headerChips(), 1000);
  await env.openProfile();
  env.doc.getElementById('daily-bonus-claim').click();
  await wait(60);
  assert.equal(env.modalChips(), 1100);
  assert.equal(env.headerChips(), 1100, 'el encabezado de la mesa coincide con el perfil');
  assert.equal(env.cachedChips(), 1100, 'la caché de la cuenta se actualiza dentro de la mesa');
});

test('en una mesa: una ronda (room_state con nuevo saldo) actualiza encabezado, perfil y caché', async t => {
  const env = await bootBalanceClient({ profile: balanceProfile(1500) });
  t.after(() => env.window.close());
  env.handlers.room_state(tableRoom(balanceProfile(1500)));
  await wait(20);
  env.handlers.room_state(tableRoom(balanceProfile(1480)));
  await wait(20);
  await env.openProfile();
  assert.equal(env.modalChips(), 1480);
  assert.equal(env.headerChips(), 1480);
  assert.equal(env.cachedChips(), 1480, 'la caché de la cuenta no se queda con el saldo de antes de la ronda');
});

test('un profile_event fuera de mesa (premio de torneo del lobby) actualiza la cuenta y el perfil', async t => {
  const env = await bootBalanceClient({ profile: balanceProfile(1500) });
  t.after(() => env.window.close());
  env.handlers.profile_event({ events: [], profile: balanceProfile(2500) });
  await wait(20);
  assert.equal(env.cachedChips(), 2500, 'la caché de la cuenta adopta el saldo del evento');
  await env.openProfile();
  assert.equal(env.modalChips(), 2500);
});

test('un refresco lento no pisa un saldo más nuevo que ya llegó por un ack', async t => {
  // Con sesiones por cookie el refresco viaja por HTTP y puede terminar después
  // de un ack por socket. La respuesta vieja no debe volver a mostrar el saldo anterior.
  const env = await bootBalanceClient({
    profile: balanceProfile(20000),
    cookieMode: true,
    sessionDelayMs: 120,
    responders: {
      card_gacha_pull: () => ({ ok: true, card: { id: 'c2', name: 'Carta', rarity: 'comun', rank: 'K', suit: 'copas', motif: 'x', symbol: '♥', count: 1, duplicate: false }, profile: balanceProfile(15000) })
    }
  });
  t.after(() => env.window.close());
  await env.openProfile();
  env.doc.getElementById('album-open-capsule').click();
  await wait(250);
  assert.equal(env.modalChips(), 15000);
  assert.equal(env.cachedChips(), 15000, 'el refresco tardío no reescribe la caché con 20.000');
});
