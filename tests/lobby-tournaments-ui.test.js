'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const TOS_VERSION = '2026-09-28';

function event(id, { featured = false, capacity = 8 } = {}) {
  return {
    id, name: featured ? 'Final semanal MonteCristo' : `Relámpago · ${capacity}`,
    featured, capacity, startAt: Date.now() + 60 * 60 * 1000, status: 'registration',
    registeredCount: 0, seatsRemaining: capacity, isRegistered: false, myPlacement: null, myPrize: null,
    cancellationReason: null, participants: [],
    prizeSchedule: [{ place: 1, prize: featured ? 10000 : capacity === 8 ? 2400 : 5000 }],
    rounds: []
  };
}

test('el lobby muestra la final semanal y el bracket, y pide un nombre antes de inscribir a un invitado', async t => {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const handlers = {};
  const emitted = [];
  const eight = event('flash-eight');
  const featured = event('weekly-final', { featured: true, capacity: 16 });
  const initialSnapshot = {
    serverNow: Date.now(), timeZone: 'America/Mexico_City', registeredTournamentId: null,
    tournaments: [eight, featured]
  };
  const registeredSnapshot = {
    ...initialSnapshot,
    registeredTournamentId: eight.id,
    tournaments: [
      { ...eight, isRegistered: true, registeredCount: 1, seatsRemaining: 7, participants: [{ name: 'Jugadora', isYou: true }] },
      featured
    ]
  };

  window.localStorage.setItem('montecristo-tos', TOS_VERSION);
  window.localStorage.setItem('montecristo-device', 'tournament-ui-device');
  window.localStorage.removeItem('montecristo-name');
  window.sessionStorage.clear();
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'tournament-ui-device';
  window.fetch = async url => String(url).includes('/healthz')
    ? { ok: true, json: async () => ({ accountSessionsEnabled: false, passportEnabled: false, football: { enabled: false } }) }
    : { ok: false, status: 404, json: async () => ({}) };
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  const socket = {
    connected: true, io: { on() {} },
    on(name, handler) { handlers[name] = handler; },
    emit(name, payload, ack) {
      emitted.push({ name, payload });
      if (name === 'lobby_tournament_register') return ack({ ok: true, code: 'registered', snapshot: registeredSnapshot });
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {}, connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.lobby_tournaments_state(initialSnapshot);

  const document = window.document;
  assert.equal(document.querySelector('#lobby-weekly-final .tournament-card')?.dataset.tournamentCard, 'weekly-final');
  assert.match(document.getElementById('lobby-weekly-final').textContent, /Final semanal destacada/u);
  assert.ok(document.querySelector('#lobby-tournament-list [data-tournament-card="flash-eight"]'));
  document.querySelector('[data-tournament-bracket-toggle="flash-eight"]').click();
  assert.match(document.querySelector('[data-tournament-card="flash-eight"] .tournament-bracket').textContent, /El bracket se publicará/u);

  document.querySelector('[data-tournament-join="flash-eight"]').click();
  const dialog = document.getElementById('lobby-tournament-name-dialog');
  assert.equal(dialog.open, true);
  const nameInput = document.getElementById('lobby-tournament-name-input');
  nameInput.value = 'Jugadora';
  document.getElementById('lobby-tournament-name-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 25));
  const signup = emitted.find(item => item.name === 'lobby_tournament_register');
  assert.ok(signup);
  assert.equal(signup.payload.tournamentId, 'flash-eight');
  assert.equal(signup.payload.name, 'Jugadora');
  assert.equal(signup.payload.tos, TOS_VERSION);
  assert.equal(dialog.open, false);
  assert.match(document.querySelector('[data-tournament-card="flash-eight"]').textContent, /En la lista: Tú/u);
});
