'use strict';

// Invitaciones de amistad a mesas privadas: la interfaz debe mostrar la
// presencia de las amistades, invitar con un clic desde la mesa y aceptar la
// invitación desde la bandeja sin escribir códigos.
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
const bob = { id: 'bob-id', username: 'bob', name: 'Roberto', avatar: 'owl' };
const BOB_ROOM = { code: 'ABC12', name: 'Mesa de Roberto', game: 'poker', players: 3, capacity: 6 };

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function roomFixture() {
  return {
    code: 'MY123', name: 'Mesa de Alicia', game: 'poker', phase: 'waiting', hostId: 'alice-id', viewerId: 'alice-id',
    players: [{
      id: 'alice-id', seat: 0, name: 'Alicia', avatar: 'fox', chips: 1000, hand: [], bet: 0, roundBet: 0, totalBet: 0,
      status: 'waiting', folded: false, allIn: false, connected: true, isBot: false, isHost: true,
      collection: { equipped: {} }, passport: { equipped: {} }, stats: {}
    }],
    spectators: [], messages: [], results: [], recentWinners: [], dealerHand: [], community: [], pot: 0,
    currentBet: 0, minRaise: 20, turnId: null, turnDeadline: null, turnDuration: 30000, dealerIndex: -1,
    handNumber: 0, quickResult: null, specialEvent: null, lobbyTournamentMatch: null, tournament: null,
    viewerProfile: { ...account, stats: {}, passport: null, collection: { equipped: {} }, fanPin: null }
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function createPage(t, { presenceMap } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.localStorage.setItem('montecristo-tos', TOS);
  window.localStorage.setItem('montecristo-device', 'alice-device');
  window.localStorage.setItem('montecristo-name', 'Alicia');
  window.localStorage.setItem('montecristo-account-session', JSON.stringify(account));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const route = new URL(String(url), 'http://localhost:3000');
    calls.push({ path: route.pathname, method: options.method || 'GET' });
    if (route.pathname === '/healthz') return response({ accountSessionsEnabled: true, passportEnabled: false, football: { enabled: false } });
    if (route.pathname === '/api/seasonal-theme') return response({ active: false });
    if (route.pathname === '/api/auth/session') return response({ ok: true, csrfToken: 'csrf-invites', profile: account });
    if (route.pathname === '/api/social/v1/me') return response({
      ok: true, profile: { ...account }, seasonKey: '2026-10', friends: [bob],
      incomingRequests: [], outgoingRequests: [], clubs: []
    });
    if (route.pathname === '/api/social/v1/clubs') return response({ ok: true, clubs: [] });
    if (route.pathname === '/api/social/v1/clubs/ranking') return response({ ok: true, seasonKey: '2026-10', ranking: [] });
    return response({ ok: false, error: `Ruta inesperada: ${route.pathname}` }, 404);
  };
  const handlers = {};
  const emitted = [];
  const presence = presenceMap || {
    'bob-id': { online: true, status: 'playing', room: BOB_ROOM }
  };
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      const invites = {
        ok: true,
        invites: [{
          id: 'invite-incoming', from: { id: 'bob-id', name: 'Roberto', avatar: 'owl' },
          toId: 'alice-id', room: BOB_ROOM, createdAt: Date.now(), expiresAt: Date.now() + 600000
        }]
      };
      const replies = {
        friend_presence_get: { ok: true, presence },
        friend_invites_get: event === 'friend_invites_get' ? { ok: true, invites: [] } : invites,
        friend_invite_send: { ok: true, code: 'invite_sent', online: true, invite: { id: 'invite-1', room: { ...BOB_ROOM, code: 'MY123' } } },
        friend_invite_accept: { ok: true, code: 'ABC12', room: BOB_ROOM },
        friend_invite_dismiss: { ok: true },
        create_room: { ok: true, code: 'NEW42', game: 'poker' },
        join_room: { ok: true, code: 'ABC12', game: 'poker' }
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

test('la lista de amistades muestra dónde juega cada quien y deja unirse con un clic', async t => {
  const { window, emitted, document } = await createPage(t);
  document.getElementById('community-open-btn').click();
  await sleep(50);
  const list = document.getElementById('community-friends-list');
  assert.match(list.textContent, /Roberto/);
  assert.match(list.textContent, /Jugando texas hold’em · 3\/6/, 'la presencia indica la mesa y el cupo');
  const join = list.querySelector('[data-social-action="join-friend-room"]');
  assert.ok(join, 'hay un botón para entrar a su mesa');
  assert.equal(join.dataset.roomCode, 'ABC12');
  join.click();
  await sleep(50);
  const call = emitted.find(item => item.event === 'join_room');
  assert.ok(call, 'entrar a la mesa de una amistad no pide escribir el código');
  assert.equal(call.payload.code, 'ABC12');
  assert.equal(window.document.getElementById('community-modal').classList.contains('open'), false);
});

test('desde la mesa, invitar a una amistad es un clic y el enlace sigue disponible', async t => {
  const { handlers, emitted, document } = await createPage(t);
  handlers.room_state(roomFixture());
  await sleep(40);
  const inviteButton = document.getElementById('invite-friends');
  assert.ok(inviteButton, 'la cabecera de la mesa conserva el botón de invitar');
  assert.ok(document.querySelector('[data-invite-open-friends]'), 'mientras la mesa espera, invitar también está a la mano en el panel de acciones');
  inviteButton.click();
  await sleep(50);
  const modal = document.getElementById('invite-modal');
  assert.equal(modal.classList.contains('open'), true);
  assert.equal(modal.getAttribute('aria-hidden'), 'false');
  await sleep(30);
  assert.equal(document.getElementById('invite-room-code').textContent, 'MY123');
  assert.equal(document.getElementById('invite-link').value, 'http://localhost:3000/room/MY123');
  const list = document.getElementById('invite-friends-list');
  assert.match(list.textContent, /Roberto/);
  assert.match(list.textContent, /Jugando texas hold’em/, 'también aquí se ve dónde está la amistad');
  const invite = list.querySelector('[data-invite-friend="bob-id"]');
  assert.ok(invite, 'hay una acción directa para invitar');
  invite.click();
  await sleep(50);
  const sent = emitted.find(item => item.event === 'friend_invite_send');
  assert.ok(sent, 'la invitación se envía por socket');
  assert.equal(sent.payload.profileId, 'bob-id');
  assert.equal(sent.payload.code, 'MY123');
  assert.match(document.getElementById('invite-status').textContent, /puede entrar con un clic/);
  assert.match(document.getElementById('invite-friends-list').textContent, /Invitación enviada/);
  assert.ok(document.querySelector('.toast-stack .toast'), 'se confirma con un aviso');
});

test('una invitación recibida se acepta desde cualquier vista y entra a la sala', async t => {
  const { handlers, emitted, document } = await createPage(t);
  handlers.friend_invite_received({
    invite: {
      id: 'invite-incoming', from: { id: 'bob-id', name: 'Roberto', avatar: 'owl' },
      toId: 'alice-id', room: BOB_ROOM, createdAt: Date.now(), expiresAt: Date.now() + 600000
    }
  });
  await sleep(20);
  const inbox = document.getElementById('invite-inbox');
  assert.equal(inbox.classList.contains('hidden'), false);
  assert.match(inbox.textContent, /Roberto te invita/);
  assert.match(inbox.textContent, /Mesa de Roberto/);
  document.querySelector('[data-invite-accept]').click();
  await sleep(80);
  assert.ok(emitted.some(item => item.event === 'friend_invite_accept' && item.payload.inviteId === 'invite-incoming'));
  const join = emitted.find(item => item.event === 'join_room');
  assert.ok(join, 'aceptar entra directo a la mesa');
  assert.equal(join.payload.code, 'ABC12');
});

test('dentro de la sala, la barra lateral lista amistades e invita con un clic', async t => {
  const { handlers, emitted, document } = await createPage(t);
  handlers.room_state(roomFixture());
  await sleep(160);
  const section = document.getElementById('room-friends-section');
  assert.equal(section.classList.contains('hidden'), false, 'la mesa muestra su sección de amigos');
  const strip = document.getElementById('room-friends-strip');
  assert.match(strip.textContent, /Roberto/);
  assert.match(strip.textContent, /Jugando texas hold’em/, 'la presencia se ve sin abrir ningún panel');
  const invite = strip.querySelector('[data-room-invite="bob-id"]');
  assert.ok(invite, 'cada amistad tiene su botón de invitar dentro de la sala');
  invite.click();
  await sleep(60);
  const sent = emitted.filter(item => item.event === 'friend_invite_send').at(-1);
  assert.ok(sent, 'invitar desde la barra lateral usa el mismo envío seguro');
  assert.equal(sent.payload.profileId, 'bob-id');
  assert.equal(sent.payload.code, 'MY123');
  assert.match(document.getElementById('room-friends-strip').textContent, /Enviada/);
});

test('desde el lobby, «Jugar» crea la mesa y envía la invitación sola', async t => {
  const { window, emitted, document } = await createPage(t, {
    presenceMap: { 'bob-id': { online: true, status: 'lobby', room: null } }
  });
  document.getElementById('community-open-btn').click();
  await sleep(50);
  const play = document.querySelector('[data-social-action="play-with-friend"][data-profile-id="bob-id"]');
  assert.ok(play, 'una amistad en línea ofrece jugar sin tener que crear la mesa antes');
  play.click();
  await sleep(30);
  const modal = document.getElementById('join-modal');
  assert.equal(modal.classList.contains('open'), true);
  assert.match(document.getElementById('modal-subtitle').textContent, /Roberto recibirá la invitación/);
  assert.equal(document.getElementById('community-modal').classList.contains('open'), false);

  document.getElementById('join-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(450);
  const create = emitted.find(item => item.event === 'create_room');
  assert.ok(create, 'se crea la mesa con el juego elegido');
  const sent = emitted.find(item => item.event === 'friend_invite_send');
  assert.ok(sent, 'la invitación sale automáticamente al crear la mesa');
  assert.equal(sent.payload.profileId, 'bob-id');
  assert.equal(sent.payload.code, 'NEW42', 'se invita al código de la mesa recién creada');
});

test('el marcado y los estilos publican el panel de invitación accesible', () => {
  const dom = new JSDOM(HTML);
  const document = dom.window.document;
  const modal = document.getElementById('invite-modal');
  assert.ok(modal, 'existe el modal de invitación');
  assert.equal(modal.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
  assert.ok(document.getElementById('invite-friends'), 'botón de invitar en la mesa');
  assert.ok(document.getElementById('invite-inbox'), 'bandeja de invitaciones recibidas');
  assert.ok(document.getElementById('invite-friends-list'));
  assert.match(CLIENT, /friend_invite_received/);
  assert.match(CLIENT, /friend_invite_send/);
  assert.match(CLIENT, /friend_invite_accept/);
  assert.match(CSS, /\.invite-card \{/);
  assert.match(CSS, /\.community-presence\.is-online/);
  dom.window.close();
});
