'use strict';

// Ficha de una persona de la misma mesa: la interfaz debe ofrecer ver el
// perfil de quien juega contigo y, entre cuentas, mandar o aceptar la
// solicitud de amistad sin salir de la partida.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const TOS = '2026-09-28';

const account = { id: 'alice-id', username: 'alice', name: 'Alicia', avatar: 'fox', chips: 1000 };

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function profileCard(overrides = {}) {
  return {
    id: 'bob-id',
    name: 'Roberto',
    avatar: 'owl',
    account: true,
    username: 'bob',
    isBot: false,
    bot: null,
    seat: { index: 1, isHost: false, isSpectator: false },
    chips: 1800,
    stats: { roundsPlayed: 24, wins: 9, losses: 15, winRate: 38, biggestWin: 620, bestStreak: 5, differentGames: 3 },
    achievementCount: 3,
    achievementTotal: 18,
    achievements: [
      { id: 'first_win', icon: '🏆', name: 'Primera victoria', description: 'Gana tu primera ronda.' },
      { id: 'hot_streak', icon: '🔥', name: 'En racha', description: 'Consigue 3 victorias seguidas.' }
    ],
    passport: { equipped: {} },
    collection: { equipped: {} },
    fanPin: null,
    medals: 0,
    championBanner: false,
    relationship: 'none',
    requestId: null,
    mutualFriends: 0,
    ...overrides
  };
}

function roomFixture() {
  return {
    code: 'MY123', name: 'Mesa de Alicia', game: 'poker', phase: 'waiting', hostId: 'alice-id', viewerId: 'alice-id',
    players: [
      {
        id: 'alice-id', seat: 0, name: 'Alicia', avatar: 'fox', chips: 1000, hand: [], bet: 0, roundBet: 0, totalBet: 0,
        status: 'waiting', folded: false, allIn: false, connected: true, isBot: false, isHost: true,
        collection: { equipped: {} }, passport: { equipped: {} }, stats: {}
      },
      {
        id: 'bob-id', seat: 1, name: 'Roberto', avatar: 'owl', chips: 1800, hand: [], bet: 0, roundBet: 0, totalBet: 0,
        status: 'waiting', folded: false, allIn: false, connected: true, isBot: false,
        collection: { equipped: {} }, passport: { equipped: {} }, stats: {}
      },
      {
        id: 'bot:1', seat: 2, name: 'Bot Nova', avatar: 'robot', chips: 500, hand: [], bet: 0, roundBet: 0, totalBet: 0,
        status: 'waiting', folded: false, allIn: false, connected: true, isBot: true,
        bot: { difficultyLabel: 'Experto', styleLabel: 'Equilibrado', thinking: false },
        collection: { equipped: {} }, passport: { equipped: {} }, stats: {}
      }
    ],
    spectators: [{ id: 'carla-id', name: 'Carla', avatar: 'panda', collection: { equipped: {} } }],
    messages: [], results: [], recentWinners: [], dealerHand: [], community: [], pot: 0,
    currentBet: 0, minRaise: 20, turnId: null, turnDeadline: null, turnDuration: 30000, dealerIndex: -1,
    handNumber: 0, quickResult: null, specialEvent: null, lobbyTournamentMatch: null, tournament: null,
    viewerProfile: { ...account, stats: {}, passport: null, collection: { equipped: {} }, fanPin: null }
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// El servidor guarda la solicitud antes de responder: la siguiente lectura de
// la ficha ya devuelve la relación «outgoing» (o «friend» si fue cruzada).
function tableFriendRequestReply(cards, payload) {
  if (cards[payload?.playerId]) cards[payload.playerId] = { ...cards[payload.playerId], relationship: 'outgoing', requestId: 'request-1' };
  return { ok: true, code: 'request_sent', relationship: 'outgoing', mutual: false, target: { id: 'bob-id', name: 'Roberto' } };
}

async function createPage(t, { cards = {}, presenceMap, signedIn = true } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.localStorage.setItem('montecristo-tos', TOS);
  window.localStorage.setItem('montecristo-device', 'alice-device');
  window.localStorage.setItem('montecristo-name', 'Alicia');
  if (signedIn) window.localStorage.setItem('montecristo-account-session', JSON.stringify(account));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const route = new URL(String(url), 'http://localhost:3000');
    calls.push({ path: route.pathname, method: options.method || 'GET', body: options.body });
    if (route.pathname === '/healthz') return response({ accountSessionsEnabled: true, passportEnabled: false, football: { enabled: false } });
    if (route.pathname === '/api/seasonal-theme') return response({ active: false });
    if (route.pathname === '/api/auth/session') return response({ ok: true, csrfToken: 'csrf-table', profile: signedIn ? account : null });
    if (route.pathname === '/api/social/v1/me') return response({
      ok: true, profile: { ...account }, seasonKey: '2026-10', friends: [], incomingRequests: [], outgoingRequests: [], clubs: []
    });
    if (route.pathname === '/api/social/v1/clubs') return response({ ok: true, clubs: [] });
    if (route.pathname === '/api/social/v1/clubs/ranking') return response({ ok: true, seasonKey: '2026-10', ranking: [] });
    if (route.pathname.startsWith('/api/social/v1/friends/requests/') && route.pathname.endsWith('/accept') && options.method === 'POST') {
      return response({ ok: true, code: 'friend_added', message: 'Solicitud aceptada.' });
    }
    if (route.pathname.startsWith('/api/social/v1/friends/requests/') && options.method === 'DELETE') {
      return response({ ok: true, code: 'request_removed', message: 'Solicitud retirada.' });
    }
    return response({ ok: false, error: `Ruta inesperada: ${route.pathname}` }, 404);
  };
  const handlers = {};
  const emitted = [];
  const presence = presenceMap || {};
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      const replies = {
        friend_presence_get: { ok: true, presence },
        friend_invites_get: { ok: true, invites: [] },
        table_profile_get: cards[payload?.playerId]
          ? { ok: true, profile: profileCard(cards[payload.playerId]) }
          : { ok: false, error: 'Esa persona ya no está en la mesa.' },
        table_friend_request: tableFriendRequestReply(cards, payload)
      };
      if (typeof ack === 'function') ack(replies[event] || { ok: true });
    },
    disconnect() {},
    connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  await sleep(25);
  return { window, handlers, emitted, calls, document: window.document };
}

test('desde la mesa se abre la ficha de quien juega contigo y se manda la solicitud', async t => {
  const { window, handlers, emitted, document } = await createPage(t, { cards: { 'bob-id': {} } });
  handlers.room_state(roomFixture());
  await sleep(160);

  // La fila de la clasificación y su botón ♧ abren la ficha de esa persona.
  const row = document.querySelector('.player-row[data-table-profile="bob-id"]');
  assert.ok(row, 'cada persona real de la mesa tiene su ficha a la mano');
  assert.ok(row.querySelector('.player-card-hint'), 'el atajo de teclado existe como botón');
  assert.equal(document.querySelector('.player-row[data-table-profile="alice-id"]'), null, 'tu propia fila no abre ficha');
  row.click();
  await sleep(60);
  const modal = document.getElementById('table-profile-modal');
  assert.equal(modal.classList.contains('open'), true);
  assert.equal(modal.getAttribute('aria-hidden'), 'false');
  const get = emitted.find(item => item.event === 'table_profile_get');
  assert.ok(get, 'la ficha se pide al servidor, que arma el perfil público del asiento');
  assert.equal(get.payload.playerId, 'bob-id');

  assert.equal(document.getElementById('table-profile-name').textContent, 'Roberto');
  assert.match(document.getElementById('table-profile-handle').textContent, /@bob/);
  const stats = document.getElementById('table-profile-stats');
  assert.match(stats.textContent, /RONDAS/);
  assert.match(stats.textContent, /38%/, 'el % de victorias que ya calcula el servidor');
  assert.match(document.getElementById('table-profile-seat').textContent, /asiento 2/);
  assert.match(document.getElementById('table-profile-seat').textContent, /1,800 fichas/);
  assert.match(document.getElementById('table-profile-achievements').textContent, /Primera victoria/);

  const request = document.querySelector('[data-table-friend-request="bob-id"]');
  assert.ok(request, 'hay un botón para mandar la solicitud desde la mesa');
  request.click();
  await sleep(120);
  const sent = emitted.find(item => item.event === 'table_friend_request');
  assert.ok(sent, 'la solicitud sale por el socket de la mesa');
  assert.equal(sent.payload.playerId, 'bob-id');
  assert.match(document.getElementById('table-profile-status').textContent, /Solicitud enviada/);
  assert.match(document.getElementById('table-profile-social').textContent, /Solicitud enviada/, 'la ficha refleja el estado nuevo');
  assert.ok(document.querySelector('.toast-stack .toast'), 'se confirma con un aviso');
  assert.ok(window.document.body.classList.contains('modal-open'));
});

test('una solicitud recibida se acepta desde la ficha de la mesa', async t => {
  const { handlers, calls, document } = await createPage(t, {
    cards: { 'bob-id': { relationship: 'incoming', requestId: 'request-77' } }
  });
  handlers.room_state(roomFixture());
  await sleep(160);
  document.querySelector('[data-table-profile="bob-id"]').click();
  await sleep(80);
  const accept = document.querySelector('[data-table-friend-accept="request-77"]');
  assert.ok(accept, 'la ficha ofrece aceptar la solicitud pendiente');
  assert.equal(document.querySelector('[data-table-friend-request]'), null, 'no se ofrece enviar otra a quien ya te escribió');
  accept.click();
  await sleep(140);
  const call = calls.find(item => item.path === '/api/social/v1/friends/requests/request-77/accept' && item.method === 'POST');
  assert.ok(call, 'aceptar usa la misma API de comunidad que la bandeja');
  assert.match(document.getElementById('table-profile-status').textContent, /ya son amistades/);
});

test('un bot o una persona sin cuenta se explica en la ficha, sin botón de amistad', async t => {
  const { handlers, emitted, document } = await createPage(t, {
    cards: {
      'bot:1': { id: 'bot:1', name: 'Bot Nova', username: null, account: false, isBot: true, bot: { difficultyLabel: 'Experto', styleLabel: 'Equilibrado' }, achievements: [], achievementCount: 0, relationship: 'bot' },
      'carla-id': { id: 'carla-id', name: 'Carla', username: null, account: false, seat: { index: null, isSpectator: true }, relationship: 'guest' }
    }
  });
  handlers.room_state(roomFixture());
  await sleep(160);

  document.querySelector('.player-row[data-table-profile="bot:1"]').click();
  await sleep(70);
  assert.equal(document.getElementById('table-profile-name').textContent, 'Bot Nova');
  assert.match(document.getElementById('table-profile-badges').textContent, /BOT/);
  assert.equal(document.querySelector('[data-table-friend-request]'), null, 'a un bot no se le manda amistad');
  assert.equal(document.getElementById('table-profile-achievements-section').classList.contains('hidden'), true);

  // La tribuna también tiene fichas: ver quién mira la mesa no pide asiento.
  document.querySelector('.modal-close[data-close-table-profile]').click();
  const spectator = document.querySelector('.spectator-name[data-table-profile="carla-id"]');
  assert.ok(spectator, 'la tribuna lista nombres pulsables');
  spectator.click();
  await sleep(70);
  assert.equal(document.getElementById('table-profile-name').textContent, 'Carla');
  assert.match(document.getElementById('table-profile-seat').textContent, /tribuna/i);
  assert.match(document.getElementById('table-profile-badges').textContent, /Tribuna/);
  assert.equal(document.querySelector('[data-table-friend-request]'), null, 'sin cuenta no hay amistad posible');
  assert.match(document.getElementById('table-profile-social').textContent, /Juega sin cuenta/);
  assert.equal(emitted.filter(item => item.event === 'table_friend_request').length, 0);
});

test('las fichas del asiento y la tribuna de la mesa también abren el perfil', async t => {
  const { handlers, emitted, document } = await createPage(t, { cards: { 'bob-id': {} } });
  handlers.room_state(roomFixture());
  await sleep(160);
  const seat = document.querySelector('.table-seat .seat-head[data-table-profile="bob-id"]');
  assert.ok(seat, 'el asiento del jugador es la puerta a su ficha');
  assert.equal(seat.tagName, 'BUTTON');
  seat.click();
  await sleep(70);
  assert.ok(emitted.find(item => item.event === 'table_profile_get' && item.payload.playerId === 'bob-id'));
  assert.equal(document.getElementById('table-profile-modal').classList.contains('open'), true);
  // Tu propio asiento no abre una ficha de ti mismo.
  assert.equal(document.querySelector('.seat-head[data-table-profile="alice-id"]'), null);
});

test('la barra lateral avisa que las fichas sirven para pedir amistad', async t => {
  const { handlers, window, document } = await createPage(t);
  handlers.room_state(roomFixture());
  await sleep(160);
  const note = document.getElementById('room-social-note');
  assert.equal(note.classList.contains('hidden'), false);
  assert.match(document.getElementById('room-social-note-copy').textContent, /perfil|solicitud/i);
  assert.equal(note.dataset.account, 'yes');

  // Al salir de la mesa la ficha abierta se cierra y el aviso desaparece.
  const { handlers: handlers2, document: doc2 } = await createPage(t);
  handlers2.room_state(roomFixture());
  await sleep(160);
  doc2.querySelector('[data-table-profile="bob-id"]').click();
  await sleep(60);
  assert.equal(doc2.getElementById('table-profile-modal').classList.contains('open'), true);
  doc2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(30);
  assert.equal(doc2.getElementById('table-profile-modal').classList.contains('open'), false);
});

test('el marcado y los estilos publican la ficha accesible', () => {
  const dom = new JSDOM(HTML);
  const document = dom.window.document;
  const modal = document.getElementById('table-profile-modal');
  assert.ok(modal, 'existe la ventana de ficha');
  assert.equal(modal.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
  assert.ok(document.getElementById('table-profile-loading'), 'hay un estado de carga explícito');
  assert.ok(document.getElementById('table-profile-achievements'), 'los logros tienen su contenedor');
  assert.ok(document.getElementById('table-profile-social'), 'la amistad tiene su contenedor');
  assert.match(CLIENT, /table_profile_get/);
  assert.match(CLIENT, /table_friend_request/);
  assert.match(CLIENT, /data-table-profile/);
  assert.match(CSS, /\.table-profile-card \{/);
  assert.match(CSS, /\.seat-head\.is-viewable/);
  dom.window.close();
});

test('sin cuenta iniciada la ficha se arma en local y no afirma nada que no sepa', async t => {
  const { handlers, emitted, document } = await createPage(t, { signedIn: false });
  handlers.room_state(roomFixture());
  await sleep(160);
  document.querySelector('.player-row[data-table-profile="bob-id"]').click();
  await sleep(80);
  // Sin sesión de cuenta no hay petición al servidor: el asiento ya trae lo
  // público en room_state y la ficha se abre igual.
  assert.equal(emitted.filter(item => item.event === 'table_profile_get').length, 0);
  assert.equal(document.getElementById('table-profile-modal').classList.contains('open'), true);
  assert.equal(document.getElementById('table-profile-name').textContent, 'Roberto');
  // Ni «Cuenta» ni «Invitado»: sin sesión el cliente no puede saberlo.
  assert.doesNotMatch(document.getElementById('table-profile-badges').textContent, /Invitado/);
  assert.doesNotMatch(document.getElementById('table-profile-handle').textContent, /no vinculada/);
  assert.match(document.getElementById('table-profile-seat').textContent, /asiento 2/);
  // Se ofrece iniciar sesión en vez de un botón que el servidor rechazaría.
  assert.equal(document.querySelector('[data-table-friend-request]'), null);
  assert.ok(document.querySelector('[data-table-profile-login]'), 'la ficha invita a iniciar sesión');
  assert.match(document.getElementById('table-profile-social').textContent, /Inicia sesión/);
});

test('el foco entra a la ficha al abrirla y vuelve a quien la abrió al cerrarla', async t => {
  const { handlers, document } = await createPage(t, { cards: { 'bob-id': {} } });
  handlers.room_state(roomFixture());
  await sleep(160);
  const seat = document.querySelector('.table-seat .seat-head[data-table-profile="bob-id"]');
  seat.focus();
  assert.equal(document.activeElement, seat, 'el asiento se puede enfocar con el teclado');
  seat.click();
  await sleep(70);
  assert.equal(
    document.activeElement,
    document.querySelector('#table-profile-modal .modal-close'),
    'al abrirse, el foco va al control de cierre de la ventana'
  );
  document.querySelector('#table-profile-modal .modal-close').click();
  await sleep(40);
  assert.equal(document.activeElement, seat, 'al cerrar, el foco regresa al asiento de origen');
});
