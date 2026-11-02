'use strict';

// Pestaña Preferencias del perfil (interfaz): los interruptores deben reflejar
// lo que el servidor tiene guardado, enviar SOLO la clave que cambió y volver
// atrás si el guardado falla (nunca mostrar un estado que el servidor no aceptó).
// También se comprueba que la casilla del formulario de creación de mesa es la
// misma preferencia, porque es la vía de quien juega sin cuenta.

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

function profileWith(preferences) {
  return publicProgress(cleanProfile({
    id: 'pref-account', username: 'pref_casino', name: 'Preferente', avatar: 'fox', chips: 1500,
    stats: { roundsPlayed: 4, wins: 2, losses: 2 }, gamesPlayed: ['dice'], preferences
  }), true);
}

async function openProfile({ initial, denySave = false } = {}) {
  const fresh = profileWith(initial);
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'pref-device');
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'pref-device';
  window.fetch = async url => {
    const target = String(url);
    if (target.includes('/healthz')) {
      return { ok: true, json: async () => ({ accountSessionsEnabled: true, passportEnabled: false, cardGachaEnabled: false, football: { enabled: false } }) };
    }
    if (target.includes('/api/auth/session')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, profile: fresh, csrfToken: 'x' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers = {};
  const sent = [];
  let current = fresh;
  const socket = {
    get connected() { return true; },
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      sent.push({ event, payload });
      if (event === 'preferences_update' && typeof ack === 'function') {
        if (denySave) return ack({ ok: false, error: 'No se pudo guardar la preferencia.' });
        current = { ...current, preferences: { ...current.preferences, ...payload.preferences } };
        return ack({ ok: true, preferences: current.preferences, profile: current });
      }
      if (event === 'account_profile' && typeof ack === 'function') return ack({ ok: true, profile: current });
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {}, connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.connect?.();
  await wait(40);
  document.getElementById('profile-card').click();
  await wait(60);
  const toggle = id => document.getElementById(id);
  return { window, document, sent, toggle };
}

test('la pestaña Preferencias pinta los interruptores del perfil', async t => {
  const env = await openProfile({ initial: { autoBots: false, botsStay: true, tableInvites: false } });
  t.after(() => env.window.close());
  const section = env.document.getElementById('profile-section-preferences');
  assert.ok(section, 'la sección Preferencias existe en el perfil');
  assert.ok(env.document.getElementById('profile-tab-preferences'), 'hay un acceso directo a Preferencias');
  assert.equal(env.toggle('preference-auto-bots').checked, false);
  assert.equal(env.toggle('preference-bots-stay').checked, true);
  assert.equal(env.toggle('preference-table-invites').checked, false);
  // La casilla del formulario de creación usa la misma preferencia.
  assert.equal(env.toggle('setup-auto-bots').checked, false);
  // Las filas quedan marcadas visualmente cuando están activadas.
  const row = env.document.querySelector('[data-preference-row="botsStay"]');
  assert.ok(row.classList.contains('is-on'));
});

test('cambiar un interruptor guarda solo esa preferencia en el servidor', async t => {
  const env = await openProfile({ initial: { autoBots: true, botsStay: false, tableInvites: true } });
  t.after(() => env.window.close());
  const input = env.toggle('preference-auto-bots');
  assert.equal(input.checked, true);
  input.checked = false;
  input.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await wait(40);
  const saved = env.sent.filter(item => item.event === 'preferences_update');
  assert.equal(saved.length, 1, 'un solo guardado por cambio');
  // El payload nace en el realm de jsdom: se compara su forma serializada.
  assert.equal(JSON.stringify(saved[0].payload.preferences), JSON.stringify({ autoBots: false }), 'solo la clave que cambió');
  // Fuera de una mesa el servidor necesita la cuenta dueña del cambio (igual que
  // al guardar nombre/avatar); nunca se envía en su lugar un id de otra persona.
  assert.equal(saved[0].payload.accountId, 'pref-account');
  assert.equal(env.toggle('preference-auto-bots').checked, false, 'el interruptor conserva el cambio confirmado');
  assert.equal(env.toggle('setup-auto-bots').checked, false, 'la casilla de creación se sincroniza');
  const status = env.document.getElementById('preferences-status');
  assert.ok(!status.classList.contains('hidden'), 'se confirma el guardado');
  assert.match(status.textContent, /guardada/i);
});

test('si el servidor rechaza el cambio, el interruptor vuelve a su estado real', async t => {
  const env = await openProfile({ initial: { autoBots: false }, denySave: true });
  t.after(() => env.window.close());
  const input = env.toggle('preference-auto-bots');
  assert.equal(input.checked, false);
  input.checked = true;
  input.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await wait(40);
  assert.equal(env.toggle('preference-auto-bots').checked, false, 'no se muestra un estado que el servidor no aceptó');
  const status = env.document.getElementById('preferences-status');
  assert.ok(status.classList.contains('is-error'));
  assert.match(status.textContent, /No se pudo guardar/);
});

test('la casilla de crear mesa escribe la preferencia antes de crear la sala', async t => {
  const env = await openProfile({ initial: { autoBots: true } });
  t.after(() => env.window.close());
  const box = env.toggle('setup-auto-bots');
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await wait(20);
  // Se recuerda en el dispositivo aunque todavía no se haya creado ninguna mesa.
  const cached = JSON.parse(env.window.localStorage.getItem('montecristo-preferences') || '{}');
  assert.equal(cached.autoBots, false);
});
