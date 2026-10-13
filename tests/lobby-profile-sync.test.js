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
