'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { TOS_VERSION } = require('../lib/terms');
const { cleanProfile } = require('../lib/profile-store-shared');
const { publicProgress } = require('../lib/progression');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');

test('catálogo clásico de 54 figuras, únicas y en orden tradicional', () => {
  const block = CLIENT.match(/const LOTERIA_CARDS = \[([\s\S]*?)\];/);
  assert.ok(block, 'debe existir el catálogo LOTERIA_CARDS');
  const names = [...block[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map(match => match[1]);
  assert.equal(names.length, 54);
  assert.equal(new Set(names).size, 54);
  assert.equal(names[0], 'El Gallo');
  assert.equal(names[5], 'La Sirena');
  assert.equal(names[15], 'La Bandera');
  assert.equal(names[45], 'El Sol');
  assert.equal(names[53], 'La Rana');
});

test('la tarjeta y la sección nacen cerradas hasta que el servidor confirma la lotería', () => {
  const dom = new JSDOM(HTML);
  const { document } = dom.window;
  const section = document.getElementById('loteria');
  assert.ok(section, 'existe la sección de lotería en el lobby');
  assert.ok(section.classList.contains('hidden'), 'fail-closed: oculta sin confirmación del servidor');
  const openButton = document.querySelector('[data-loteria-open]');
  assert.ok(openButton);
  assert.equal(openButton.disabled, true);
  assert.ok(document.getElementById('loteria-join'));
  assert.ok(document.getElementById('loteria-leave'));
  assert.ok(document.getElementById('loteria-board'));
  assert.equal(document.getElementById('loteria-live').getAttribute('aria-live'), 'polite');
  assert.ok(!HTML.includes('EN DESARROLLO'), 'la tarjeta ya no anuncia un juego en desarrollo');
  assert.match(CSS, /\.loteria-board\s*\{[^}]*grid-template-columns:repeat\(4,1fr\)/);
  assert.match(CSS, /\.loteria-cell\.marked/);
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)[\s\S]*?\.loteria-cell/);
  dom.window.close();
});

function gameSnapshot(overrides = {}) {
  const now = Date.now();
  return {
    serverNow: now,
    nextGameAt: null,
    game: {
      id: 'partida-ui-1', status: 'registration', openedAt: now - 5_000, closesAt: now + 55_000,
      count: 1, pot: 50, called: [], board: null, joined: false,
      entryCost: 50, minPlayers: 2, maxPlayers: 100, callIntervalMs: 2_000, result: null,
      ...overrides
    }
  };
}

test('flujo completo en el lobby: comprar cartón, marcado automático y cierre con premio', async t => {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  const handlers = {};
  const emitted = [];
  const board = Array.from({ length: 16 }, (_, index) => index + 1);
  const profile = cleanProfile({ id: 'loteria-ui-device', name: 'Lotería UI', chips: 1000 });
  window.localStorage.setItem('montecristo-tos', TOS_VERSION);
  window.localStorage.setItem('montecristo-device', 'loteria-ui-device');
  window.localStorage.setItem('montecristo-name', 'Lotería UI');
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'loteria-ui-request-0001';
  window.fetch = async url => String(url).includes('/healthz')
    ? { ok: true, json: async () => ({ accountSessionsEnabled: false, loteriaEnabled: true, football: { enabled: false } }) }
    : { ok: false, status: 404, json: async () => ({}) };
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      if (typeof ack !== 'function') return;
      if (event === 'loteria_get') return ack({ ok: true, snapshot: gameSnapshot() });
      if (event === 'loteria_join') {
        profile.chips = 950;
        return ack({
          ok: true, code: 'joined',
          snapshot: gameSnapshot({ board, joined: true, count: 2, pot: 100 }),
          profile: publicProgress(profile, true)
        });
      }
      return ack({ ok: true });
    },
    disconnect() {},
    connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.connect?.();
  await new Promise(resolve => setTimeout(resolve, 40));

  const section = document.getElementById('loteria');
  assert.equal(section.classList.contains('hidden'), false, 'la sección aparece con loteriaEnabled');
  assert.equal(document.querySelector('[data-loteria-open]').disabled, false);
  assert.ok(emitted.some(item => item.event === 'loteria_get'), 'se pide el estado al conectar');
  assert.match(document.getElementById('loteria-status').textContent, /Inscripción abierta/);

  document.getElementById('loteria-join').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  const join = emitted.find(item => item.event === 'loteria_join');
  assert.ok(join, 'comprar emite loteria_join');
  assert.equal(join.payload.requestId, 'loteria-ui-request-0001');
  assert.equal(join.payload.tos, TOS_VERSION);
  assert.equal(join.payload.name, 'Lotería UI');
  const cells = document.querySelectorAll('#loteria-board .loteria-cell');
  assert.equal(cells.length, 16);
  assert.match(cells[0].textContent, /El Gallo/);
  assert.equal(document.getElementById('loteria-join').classList.contains('hidden'), true, 'con cartón ya no se ofrece comprar otro');
  assert.equal(document.getElementById('loteria-leave').classList.contains('hidden'), false, 'se puede salir antes del cierre');

  // Empieza el canto: salen El Gallo (1), El Diablito (2) y la Luna (23, que
  // no está en un cartón 1..16 → solo dos marcas).
  handlers.loteria_state(gameSnapshot({
    board, joined: true, count: 2, pot: 100, status: 'calling',
    closesAt: Date.now() - 6_000, called: [1, 2, 23]
  }));
  assert.equal(document.querySelectorAll('#loteria-board .loteria-cell.marked').length, 2);
  assert.match(document.getElementById('loteria-current').textContent, /La Luna/);
  assert.match(document.getElementById('loteria-live').textContent, /La Luna/, 'el lector de pantalla canta la carta');
  assert.equal(document.getElementById('loteria-leave').classList.contains('hidden'), true, 'tras el cierre ya no se puede salir');

  // Cartón completo y premio.
  handlers.loteria_state(gameSnapshot({
    board, joined: true, count: 2, pot: 100, status: 'settled',
    closesAt: Date.now() - 40_000, called: [...board, 23],
    result: { pot: 100, winnerCount: 1, payoutPerWinner: 100, carry: 0, won: true, myPayout: 100 }
  }));
  assert.equal(document.querySelectorAll('#loteria-board .loteria-cell.marked').length, 16);
  assert.match(document.getElementById('loteria-status').textContent, /¡Lotería!/);
  assert.match(document.getElementById('loteria-message').textContent, /te tocaron ◆100/);
  assert.match(document.getElementById('loteria-live').textContent, /ganaste 100 fichas/);
});
