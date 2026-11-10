'use strict';

// Interfaz de la Lotería: se evalúa el cliente real en jsdom contra un socket
// simulado. Comprueba cartón, cantadas, botones, cambio de cartón, identidad y
// pantalla de resultado, y que la página no tenga scripts ni manejadores
// inline (CSP).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { CARDS } = require('../lib/loteria/cards');
const { TOS_VERSION } = require('../lib/terms');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'loteria.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'loteria.js'), 'utf8');
const STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'loteria.css'), 'utf8');
// Cartón que entrega el socket simulado al pedir un cambio: 16 cartas que no
// coinciden con ninguna del cartón inicial (1 a 16).
const NEW_BOARD = [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const cardName = number => CARDS.find(card => card.number === number).name;

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

// `changeBoardReply(ack)` permite decidir qué responde el servidor simulado al
// cambio de cartón (un rechazo, o nada todavía); sin él, entrega NEW_BOARD.
function createClient({ storedName = 'Ana', changeBoardReply = null } = {}) {
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
      if (name === 'loteria_change_board') {
        if (changeBoardReply) return changeBoardReply(ack);
        return ack({
          ok: true,
          board: NEW_BOARD,
          state: snapshot({ board: NEW_BOARD, joined: true, count: 1, pot: 50 }),
          you: { name: 'Ana', avatar: 'fox', chips: 950, joined: true, board: NEW_BOARD }
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

test('el botón para cambiar de cartón solo aparece con cartón propio y con la inscripción abierta', async t => {
  const client = createClient();
  t.after(() => client.dom.window.close());
  const document = client.window.document;
  const button = document.getElementById('loteria-change-board');

  assert.ok(button, 'la página trae el botón');
  assert.equal(button.type, 'button');
  assert.equal(button.hidden, true, 'sin cartón no hay nada que cambiar');

  document.getElementById('loteria-join').click();
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /Cambiar cartón/u);
  assert.equal(document.getElementById('loteria-board').classList.contains('is-swapping'), false, 'recibir el primer cartón no es un cambio');

  // Sin conexión sigue a la vista, pero no se puede usar.
  client.handlers.disconnect();
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  client.handlers.loteria_you({ name: 'Ana', avatar: 'fox', chips: 950, joined: true, board: client.board });

  // En cuanto empieza el canto el cartón queda fijo y el botón desaparece.
  client.handlers.loteria_state(snapshot({ status: 'calling', board: client.board, called: [1], joined: true }));
  assert.equal(button.hidden, true);
  client.handlers.loteria_state(snapshot({
    status: 'settled', board: client.board, called: client.board, joined: true,
    result: { pot: 100, winnerCount: 1, payoutPerWinner: 100, carry: 0, won: true, myPayout: 100, winners: [{ name: 'Ana', amount: 100 }] }
  }));
  assert.equal(button.hidden, true);

  // Ronda nueva sin haber entrado: tampoco aparece.
  client.handlers.loteria_state(snapshot({ count: 0, pot: 0 }));
  client.handlers.loteria_you({ name: 'Ana', avatar: 'fox', chips: 1050, joined: false, board: null });
  assert.equal(button.hidden, true);
  assert.equal(client.emitted.some(item => item.name === 'loteria_change_board'), false);
});

test('cambiar de cartón pide otro al servidor, lo dibuja y borra las marcas del anterior', async t => {
  const client = createClient();
  t.after(() => client.dom.window.close());
  const document = client.window.document;
  const board = document.getElementById('loteria-board');
  const button = document.getElementById('loteria-change-board');

  document.getElementById('loteria-join').click();
  // La persona marca a mano dos cartas de su primer cartón.
  board.querySelector('[data-card-number="1"]').click();
  board.querySelector('[data-card-number="2"]').click();
  assert.equal(board.querySelectorAll('.loteria-cell.is-marked').length, 2);
  assert.equal(document.getElementById('loteria-board-progress').textContent, '2/16');

  button.click();
  const requests = client.emitted.filter(item => item.name === 'loteria_change_board');
  assert.equal(requests.length, 1);
  // El objeto nace dentro de la ventana de jsdom, así que se compara su
  // contenido y no su prototipo.
  assert.equal(JSON.stringify(requests[0].payload), '{}', 'el navegador no propone cartas: el cartón lo sortea el servidor');

  const numbers = [...board.querySelectorAll('.loteria-cell')].map(cell => Number(cell.getAttribute('data-card-number')));
  assert.deepEqual(numbers, NEW_BOARD);
  assert.match(board.textContent, new RegExp(cardName(17), 'u'));
  assert.doesNotMatch(board.textContent, /El Gallo/u);
  assert.equal(board.querySelectorAll('.loteria-cell.is-marked').length, 0, 'las marcas del cartón viejo no pasan al nuevo');
  assert.equal(document.getElementById('loteria-board-progress').textContent, '0/16');
  assert.equal(board.classList.contains('is-swapping'), true, 'el relevo se anima');

  // Es gratis y la persona sigue dentro, con el botón listo para otro cambio.
  assert.match(document.getElementById('loteria-balance').textContent, /950 fichas/u);
  assert.equal(document.getElementById('loteria-leave').hidden, false);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /Cambiar cartón/u);
  const toast = document.getElementById('loteria-toast');
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /Cartón cambiado/u);

  // Las marcas nuevas ya pertenecen al cartón nuevo.
  board.querySelector('[data-card-number="17"]').click();
  assert.equal(board.querySelectorAll('.loteria-cell.is-marked').length, 1);
});

test('si el servidor rechaza el cambio, el cartón y sus marcas se quedan como estaban', async t => {
  const client = createClient({
    changeBoardReply: ack => ack({ ok: false, code: 'already_started', error: 'La inscripción ya cerró: tu cartón queda fijo para esta ronda.' })
  });
  t.after(() => client.dom.window.close());
  const document = client.window.document;
  const board = document.getElementById('loteria-board');
  const button = document.getElementById('loteria-change-board');

  document.getElementById('loteria-join').click();
  board.querySelector('[data-card-number="3"]').click();
  button.click();

  assert.equal(client.emitted.filter(item => item.name === 'loteria_change_board').length, 1);
  assert.match(board.textContent, /El Gallo/u);
  assert.equal(board.querySelectorAll('.loteria-cell.is-marked').length, 1);
  assert.equal(board.classList.contains('is-swapping'), false);
  const toast = document.getElementById('loteria-toast');
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /inscripción ya cerró/u);
  assert.equal(button.disabled, false, 'el botón vuelve a quedar disponible');
  assert.match(button.textContent, /Cambiar cartón/u);
});

test('un cambio en curso bloquea los botones, y un corte de conexión no los deja bloqueados para siempre', async t => {
  const pending = [];
  const client = createClient({ changeBoardReply: ack => { pending.push(ack); } });
  t.after(() => client.dom.window.close());
  const document = client.window.document;
  const button = document.getElementById('loteria-change-board');
  const leave = document.getElementById('loteria-leave');

  document.getElementById('loteria-join').click();
  button.click();
  assert.equal(pending.length, 1);
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /Cambiando/u);
  assert.equal(leave.disabled, true, 'no se puede salir a mitad de un cambio');
  // Insistir mientras el servidor no responde no envía más peticiones.
  button.click();
  leave.click();
  assert.equal(client.emitted.filter(item => item.name === 'loteria_change_board').length, 1);
  assert.equal(client.emitted.some(item => item.name === 'loteria_leave'), false);

  // La conexión se corta y la respuesta ya no llegará nunca.
  client.handlers.disconnect();
  assert.match(button.textContent, /Cambiar cartón/u);
  client.handlers.connect();
  client.handlers.loteria_you({ name: 'Ana', avatar: 'fox', chips: 950, joined: true, board: client.board });
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false, 'tras reconectar el botón vuelve a servir');
  assert.equal(leave.disabled, false);
  button.click();
  assert.equal(pending.length, 2);
});

test('si el cartón se cambia desde otra pestaña, esta también lo dibuja', async t => {
  const client = createClient();
  t.after(() => client.dom.window.close());
  const document = client.window.document;
  const board = document.getElementById('loteria-board');

  document.getElementById('loteria-join').click();
  board.querySelector('[data-card-number="1"]').click();
  // El estado público que recibe toda la sala no trae cartones: no debe
  // confundirse con un cambio ni borrar las marcas.
  client.handlers.loteria_state(snapshot({ count: 2, pot: 100 }));
  assert.equal(board.querySelectorAll('.loteria-cell.is-marked').length, 1);
  assert.equal(board.classList.contains('is-swapping'), false);

  client.handlers.loteria_you({ name: 'Ana', avatar: 'fox', chips: 950, joined: true, board: NEW_BOARD });
  const numbers = [...board.querySelectorAll('.loteria-cell')].map(cell => Number(cell.getAttribute('data-card-number')));
  assert.deepEqual(numbers, NEW_BOARD);
  assert.equal(board.querySelectorAll('.loteria-cell.is-marked').length, 0);
  assert.equal(board.classList.contains('is-swapping'), true);
  assert.equal(client.emitted.some(item => item.name === 'loteria_change_board'), false);
});

test('los botones que la sala oculta desaparecen de verdad', () => {
  // styles.css declara `.btn { display: inline-flex }`, y esa regla le gana al
  // atributo `hidden`: un botón "oculto" seguía a la vista. jsdom no reproduce
  // esa cascada, así que aquí se vigila que la regla que lo corrige siga en la
  // hoja de la sala y que la página conserve la clase a la que se engancha.
  assert.match(HTML, /<body class="loteria-body">/u);
  assert.match(STYLES, /\.loteria-body \.btn\[hidden\]\s*\{\s*display:\s*none;?\s*\}/u);
  const hiddenButtons = [...HTML.matchAll(/<button\b[^>]*\bclass="[^"]*\bbtn\b[^"]*"[^>]*\bhidden\b[^>]*>/gu)].map(match => match[0]);
  assert.ok(hiddenButtons.some(tag => tag.includes('id="loteria-change-board"')), 'el botón de cambio empieza oculto');
  assert.ok(hiddenButtons.some(tag => tag.includes('id="loteria-leave"')), 'el botón de salida empieza oculto');
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
