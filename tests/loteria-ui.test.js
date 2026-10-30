'use strict';

// Interfaz de la Lotería: se evalúa el cliente real en jsdom contra un socket
// simulado. Comprueba cartón, cantadas, botones, identidad y pantalla de
// resultado, y que la página no tenga scripts ni manejadores inline (CSP).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { CARDS } = require('../lib/loteria/cards');
const { TOS_VERSION } = require('../lib/terms');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'loteria.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'loteria.js'), 'utf8');

function snapshot({ status = 'registration', board = null, called = [], joined = false, count = 2, pot = 100, result = null } = {}) {
  return {
    enabled: true,
    serverNow: Date.now(),
    entryCost: 50,
    minPlayers: 2,
    maxPlayers: 100,
    boardSize: 16,
    cardCount: 54,
    registrationMs: 60000,
    callIntervalMs: 2000,
    nextOpensAt: status === 'settled' ? Date.now() + 8000 : null,
    game: {
      id: 'ronda-1',
      status,
      openedAt: Date.now() - 5000,
      closesAt: Date.now() + 55000,
      count,
      pot,
      carry: 0,
      called,
      board,
      joined,
      players: [{ name: 'Ana', avatar: 'fox' }, { name: 'Beto', avatar: 'panda' }],
      result
    }
  };
}

function createClient({ storedName = 'Ana' } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/loteria', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const handlers = {};
  const emitted = [];
  const board = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  let joined = false;
  const socket = {
    connected: true,
    on(name, handler) { handlers[name] = handler; },
    emit(name, payload, ack) {
      emitted.push({ name, payload });
      if (name === 'loteria_subscribe') {
        return ack({
          ok: true,
          cards: CARDS,
          tosVersion: TOS_VERSION,
          state: snapshot({ count: 0, pot: 0 }),
          you: null
        });
      }
      if (name === 'loteria_join') {
        joined = true;
        return ack({
          ok: true,
          board,
          state: snapshot({ board, joined: true, count: 1, pot: 50 }),
          you: { name: payload.name, avatar: payload.avatar, chips: 950, joined: true, board }
        });
      }
      if (name === 'loteria_leave') {
        joined = false;
        return ack({
          ok: true,
          refunded: true,
          state: snapshot({ count: 0, pot: 0 }),
          you: { name: 'Ana', avatar: 'fox', chips: 1000, joined: false, board: null }
        });
      }
      if (typeof ack === 'function') ack({ ok: true });
      return undefined;
    },
    disconnect() {}
  };
  window.localStorage.setItem('montecristo-device', 'ui-device');
  window.localStorage.setItem('montecristo-tos', TOS_VERSION);
  window.localStorage.setItem('montecristo-avatar', 'fox');
  if (storedName) window.localStorage.setItem('montecristo-name', storedName);
  else window.localStorage.removeItem('montecristo-name');
  window.io = () => socket;
  window.eval(CLIENT);
  // El cliente arranca en connect(): se simula la conexión y la suscripción.
  handlers.connect();
  return { dom, window, handlers, emitted, board, isJoined: () => joined };
}

test('el cartón, el saldo y los botones reflejan el estado del servidor', async t => {
  const client = createClient();
  t.after(() => client.dom.window.close());
  const document = client.window.document;

  const cells = document.querySelectorAll('#loteria-board .loteria-cell');
  assert.equal(cells.length, 16);
  assert.equal(document.getElementById('loteria-balance').textContent, '◆ — fichas');
  assert.match(document.getElementById('loteria-phase').textContent, /Inscripción abierta/u);
  assert.match(document.getElementById('loteria-join').textContent, /Entrar por 50 fichas/u);

  document.getElementById('loteria-join').click();
  const join = client.emitted.find(item => item.name === 'loteria_join');
  assert.ok(join, 'se emitió la inscripción');
  assert.equal(join.payload.name, 'Ana');
  assert.equal(join.payload.tos, TOS_VERSION);
  assert.equal(join.payload.avatar, 'fox');
  assert.equal(client.isJoined(), true);

  // Tras el ack, la interfaz muestra el cartón privado y el saldo.
  assert.match(document.getElementById('loteria-balance').textContent, /950 fichas/u);
  assert.equal(document.querySelectorAll('#loteria-board .loteria-cell').length, 16);
  assert.match(document.getElementById('loteria-board').textContent, /El Gallo/u);
  assert.equal(document.getElementById('loteria-leave').hidden, false);

  // El canto marca el cartón automáticamente.
  client.handlers.loteria_state(snapshot({ status: 'calling', board: client.board, called: [1, 2, 3], joined: true, count: 1, pot: 50 }));
  assert.equal(document.querySelectorAll('#loteria-board .loteria-cell.is-called').length, 3);
  assert.match(document.getElementById('loteria-phase').textContent, /Cantando cartas/u);
  assert.match(document.getElementById('loteria-called').textContent, /El Gallo/u);
  // Durante el canto el botón de entrada queda visible pero deshabilitado: la
  // persona ya está dentro y su cartón sigue jugando.
  assert.equal(document.getElementById('loteria-join').hidden, false);
  assert.equal(document.getElementById('loteria-join').disabled, true);
  assert.match(document.getElementById('loteria-join').textContent, /Tu cartón sigue en juego/u);
  assert.equal(document.getElementById('loteria-leave').hidden, true);

  // Salir antes del cierre devuelve la entrada.
  document.getElementById('loteria-leave').click();
  const leave = client.emitted.find(item => item.name === 'loteria_leave');
  assert.ok(leave);
  assert.match(document.getElementById('loteria-balance').textContent, /1,000 fichas/u);
  assert.equal(document.getElementById('loteria-leave').hidden, true);
});

test('la pantalla de resultado anuncia al ganador y conserva el acumulado', async t => {
  const client = createClient();
  t.after(() => client.dom.window.close());
  const document = client.window.document;

  client.handlers.loteria_state(snapshot({
    status: 'settled',
    board: client.board,
    called: client.board,
    joined: true,
    count: 2,
    pot: 100,
    result: {
      pot: 100, winnerCount: 1, payoutPerWinner: 100, carry: 0,
      won: true, myPayout: 100, winners: [{ name: 'Ana', amount: 100 }]
    }
  }));
  const panel = document.getElementById('loteria-result');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /Completaste tu cartón/u);
  assert.match(panel.textContent, /Ganaste 100 fichas/u);
  assert.match(panel.textContent, /Ana/u);
  assert.ok(document.querySelectorAll('#loteria-board .loteria-cell.is-win').length === 16);

  client.handlers.loteria_state(snapshot({
    status: 'cancelled', count: 1, pot: 50,
    result: { cancelled: true, refunded: true, carry: 7 }
  }));
  assert.match(panel.textContent, /Ronda cancelada/u);
  assert.match(panel.textContent, /7/u);

  client.handlers.loteria_state(snapshot({ status: 'registration', count: 0, pot: 0 }));
  assert.equal(panel.hidden, true);
});

test('sin apodo guardado se pide identidad y términos antes de inscribirse', async t => {
  const client = createClient({ storedName: '' });
  t.after(() => client.dom.window.close());
  const document = client.window.document;
  const form = document.getElementById('loteria-identity');

  document.getElementById('loteria-join').click();
  assert.equal(form.hidden, false);
  assert.equal(client.emitted.some(item => item.name === 'loteria_join'), false);

  document.getElementById('loteria-name').value = 'Jugadora';
  document.getElementById('loteria-avatar').value = 'owl';
  // Este dispositivo todavía no había aceptado la versión vigente: el envío
  // sin la casilla marcada no puede inscribir a nadie.
  document.getElementById('loteria-tos').checked = false;
  form.dispatchEvent(new client.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(client.emitted.some(item => item.name === 'loteria_join'), false, 'sin aceptar términos no se inscribe');

  document.getElementById('loteria-tos').checked = true;
  form.dispatchEvent(new client.window.Event('submit', { bubbles: true, cancelable: true }));
  const join = client.emitted.find(item => item.name === 'loteria_join');
  assert.ok(join);
  assert.equal(join.payload.name, 'Jugadora');
  assert.equal(join.payload.avatar, 'owl');
  assert.equal(client.window.localStorage.getItem('montecristo-name'), 'Jugadora');
  assert.equal(form.hidden, true);
});

test('la página de la Lotería no usa scripts inline ni manejadores on*', () => {
  const inlineScripts = [...HTML.matchAll(/<script\b([^>]*)>/gi)].filter(match => !/\bsrc\s*=/.test(match[1]));
  assert.equal(inlineScripts.length, 0, 'sin <script> sin src');
  assert.equal((HTML.match(/\son[a-z]+\s*=/gi) || []).length, 0, 'sin manejadores on*=');
  assert.equal((HTML.match(/javascript:/gi) || []).length, 0, 'sin URLs javascript:');
  // El cliente pinta con textContent/DOM: ningún innerHTML se arma con datos
  // que lleguen del servidor.
  assert.ok(!/innerHTML\s*=\s*[a-zA-Z_$]/u.test(CLIENT), 'sin innerHTML con variables');
  assert.ok(!/insertAdjacentHTML/u.test(CLIENT));
});
