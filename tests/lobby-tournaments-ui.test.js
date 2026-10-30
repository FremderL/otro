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
  const restartedEvent = { ...event('restart-cancelled'), status: 'cancelled', cancellationReason: 'server_restarted_before_start' };
  const initialSnapshot = {
    serverNow: Date.now(), timeZone: 'America/Mexico_City', registeredTournamentId: null,
    tournaments: [eight, featured, restartedEvent]
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
  assert.match(document.querySelector('[data-tournament-card="restart-cancelled"]').textContent,
    /El servidor se reinició antes del inicio; se canceló sin cobrar entrada/u);
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

test('la tabla de premios agrupa los puestos compartidos y el bracket lo indica', async t => {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const handlers = {};
  const completed = {
    ...event('flash-completed'),
    status: 'completed',
    registeredCount: 8,
    seatsRemaining: 0,
    isRegistered: true,
    myPlacement: 3,
    myPlacementLabel: '3.º puesto compartido',
    myPrize: 300,
    prizeSchedule: [
      { place: 1, prize: 2400 }, { place: 2, prize: 1000 },
      { place: 3, prize: 300 }, { place: 4, prize: 300 }
    ],
    participants: [
      { name: 'Campeona', isYou: false, state: '1.º puesto' },
      { name: 'Finalista', isYou: false, state: '2.º puesto' },
      { name: 'Jugadora', isYou: true, state: '3.º puesto compartido' },
      { name: 'Rival', isYou: false, state: '3.º puesto compartido' }
    ],
    rounds: [{
      index: 2, label: 'Final',
      matches: [{
        id: 'm3', number: 7, status: 'completed', forfeit: false,
        players: [
          { name: 'Campeona', winner: true, loser: false, placeLabel: '1.º puesto' },
          { name: 'Finalista', winner: false, loser: true, placeLabel: '2.º puesto' }
        ]
      }]
    }, {
      index: 1, label: 'Semifinales',
      matches: [{
        id: 'm2', number: 4, status: 'completed', forfeit: false,
        players: [
          { name: 'Campeona', winner: true, loser: false, placeLabel: null },
          { name: 'Jugadora', winner: false, loser: true, placeLabel: '3.º puesto compartido' }
        ]
      }]
    }]
  };
  const tournamentFinal = {
    ...event('weekly-completed', { featured: true, capacity: 16 }),
    status: 'completed',
    prizeSchedule: [1, 2, 3, 4, 5, 6, 7, 8].map(place => ({
      place,
      prize: { 1: 10000, 2: 5000, 3: 1600, 4: 1600, 5: 450, 6: 450, 7: 450, 8: 450 }[place]
    }))
  };
  const snapshot = {
    serverNow: Date.now(), timeZone: 'America/Mexico_City', registeredTournamentId: null,
    tournaments: [completed, tournamentFinal]
  };

  window.localStorage.setItem('montecristo-tos', TOS_VERSION);
  window.localStorage.setItem('montecristo-device', 'tournament-shared-ui-device');
  window.localStorage.removeItem('montecristo-name');
  window.sessionStorage.clear();
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'tournament-shared-ui-device';
  window.fetch = async url => String(url).includes('/healthz')
    ? { ok: true, json: async () => ({ accountSessionsEnabled: false, passportEnabled: false, football: { enabled: false } }) }
    : { ok: false, status: 404, json: async () => ({}) };
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  window.io = () => ({
    connected: true, io: { on() {} },
    on(name, handler) { handlers[name] = handler; },
    emit(name, payload, ack) { if (typeof ack === 'function') ack({ ok: true }); },
    disconnect() {}, connect() {}
  });
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.lobby_tournaments_state(snapshot);

  const document = window.document;
  const card = document.querySelector('[data-tournament-card="flash-completed"]');
  const rows = [...card.querySelectorAll('.tournament-prize-table tr')].map(row => row.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(rows.length, 3, 'la tabla colapsa 3.º y 4.º en una sola fila');
  assert.match(rows[2], /3\.º puesto compartido · semifinales/u);
  assert.match(rows[2], /300 c\/u/u);
  assert.ok(!rows.some(row => /4\.º puesto/u.test(row)), 'ya no se ofrece un 4.º puesto que el bracket nunca asigna');
  assert.match(card.textContent, /Puestos compartidos por ronda: 3\.º en semifinales y 5\.º en cuartos\./u);
  assert.match(card.textContent, /Terminaste en el 3\.º puesto compartido · premio ◆ 300\./u);

  const weeklyRows = [...document.querySelector('[data-tournament-card="weekly-completed"]').querySelectorAll('.tournament-prize-table tr')]
    .map(row => row.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(weeklyRows.length, 4, 'la final de 16 agrupa 3.º/4.º y 5.º a 8.º');
  assert.match(weeklyRows[2], /3\.º puesto compartido · semifinales/u);
  assert.match(weeklyRows[2], /1,600 c\/u/u);
  assert.match(weeklyRows[3], /5\.º puesto compartido · cuartos de final/u);
  assert.match(weeklyRows[3], /450 c\/u/u);
  assert.match(document.querySelector('[data-tournament-card="weekly-completed"]').textContent,
    /9\.º en octavos/u, 'la final de 16 también advierte el puesto compartido de octavos');

  document.querySelector('[data-tournament-bracket-toggle="flash-completed"]').click();
  const semifinal = document.querySelectorAll('[data-tournament-card="flash-completed"] .tournament-bracket-round')[1];
  assert.match(semifinal.textContent, /Jugadora3\.º puesto compartido/u,
    'el jugador eliminado en semifinales figura como 3.º compartido dentro del bracket');
  const final = document.querySelectorAll('[data-tournament-card="flash-completed"] .tournament-bracket-round')[0];
  assert.match(final.textContent, /Campeona1\.º puesto/u, 'la campeona muestra su puesto final en la final');
  assert.match(semifinal.textContent, /Campeona✓ Avanza/u, 'quien avanza conserva su marca de clasificación');
});
