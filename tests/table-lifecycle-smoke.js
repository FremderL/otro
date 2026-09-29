'use strict';

// Fase 2 — Ciclo de vida de mesas: autollenado con bots expertos, bots que ceden
// y desocupan asientos, purga de jugadores fantasma, migración de autoridad por
// inactividad y eliminación de mesas sin personas reales.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');

const port = 4000 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-lifecycle-${process.pid}.json`);
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port),
    PROFILE_STORE_PATH: profilePath,
    BOT_SPEED_FACTOR: '0.05',
    HOST_INACTIVITY_MS: '700',
    HOST_INACTIVITY_SWEEP_MS: '100',
    RECONNECT_GRACE_MS: '300'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk; });
child.stderr.on('data', chunk => { serverLog += chunk; });
const clients = [];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function connectClient() {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.latest = null;
  socket.on('room_state', state => { socket.latest = state; });
  clients.push(socket);
  return socket;
}
function waitFor(socket, event, predicate = () => true, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Tiempo agotado esperando ${event}`)); }, timeout);
    function listener(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer); socket.off(event, listener); resolve(payload);
    }
    socket.on(event, listener);
  });
}
function waitState(socket, predicate, timeout = 7000) {
  if (socket.latest && predicate(socket.latest)) return Promise.resolve(socket.latest);
  return waitFor(socket, 'room_state', predicate, timeout);
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 5000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}
async function health() {
  const response = await fetch(`${url}/health`);
  return response.json();
}
async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor finalizado.\n${serverLog}`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch (_) { /* arrancando */ }
    await delay(60);
  }
  throw new Error('El servidor no arrancó a tiempo.');
}
async function waitForRoomCount(expected, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { rooms } = await health();
    if (rooms === expected) return;
    await delay(80);
  }
  throw new Error(`Las salas no llegaron a ${expected} a tiempo.`);
}
async function createRoom(socket, game, token, name = 'Persona') {
  const response = await emitAck(socket, 'create_room', { name, roomName: `${game}-${Date.now()}`, game, token, avatar: 'fox' });
  assert.equal(response.ok, true, response.error);
  return waitState(socket, state => state.code === response.code);
}

const bots = state => state.players.filter(player => player.isBot);
const humans = state => state.players.filter(player => !player.isBot);

async function testAutoFillAndRoundLifecycle() {
  const hostToken = `life-host-${Date.now()}`;
  const host = connectClient(); await waitFor(host, 'connect');

  // 1) Al crear la mesa, los asientos libres se completan con bots expertos.
  let state = await createRoom(host, 'dice', hostToken, 'Anfitriona');
  state = await waitState(host, current => current.players.length === 6);
  assert.equal(bots(state).length, 5, 'cinco asientos llenados con bots');
  assert.ok(bots(state).every(player => player.bot?.difficulty === 'expert'), 'todos los bots son nivel experto');

  // 2) Los bots apuestan solos; el anfitrión resuelve; al terminar la ronda los bots desocupan.
  assert.equal((await emitAck(host, 'quick_bet', { amount: 20, choice: 'high' })).ok, true);
  await waitState(host, current => bots(current).every(player => player.bet > 0));
  assert.equal((await emitAck(host, 'quick_resolve')).ok, true);
  state = await waitState(host, current => current.phase === 'results');
  state = await waitState(host, current => bots(current).length === 0);
  assert.equal(humans(state).length, 1, 'solo queda la persona real tras los resultados');

  // 3) Al abrir la siguiente ronda, la mesa se vuelve a completar con bots expertos.
  assert.equal((await emitAck(host, 'quick_new')).ok, true);
  state = await waitState(host, current => current.phase === 'betting' && current.players.length === 6);
  assert.ok(bots(state).every(player => player.bot?.difficulty === 'expert'));

  // 4) Con la mesa llena de bots, una persona real recibe asiento: un bot lo cede.
  const guestToken = `life-guest-${Date.now()}`;
  const guest = connectClient(); await waitFor(guest, 'connect');
  const joined = await emitAck(guest, 'join_room', { name: 'Invitado', code: state.code, token: guestToken, avatar: 'owl' });
  assert.equal(joined.ok, true, 'el bot cede su asiento a la persona real');
  state = await waitState(guest, current => current.players.some(player => player.id === guestToken));
  assert.equal(state.players.length, 6);
  assert.equal(bots(state).length, 4, 'un bot cedió el asiento');

  // 5) Jugador fantasma: el invitado se desconecta bruscamente; al iniciar la partida se valida su estatus.
  guest.disconnect();
  await delay(150);
  assert.equal((await emitAck(host, 'quick_bet', { amount: 20, choice: 'low' })).ok, true);
  await waitState(host, current => bots(current).every(player => player.bet > 0));
  assert.equal((await emitAck(host, 'quick_resolve')).ok, true);
  state = await waitState(host, current => current.phase === 'results');
  assert.equal(state.players.some(player => player.id === guestToken), false, 'el jugador que salió no sigue apareciendo en la mesa');

  // 6) La última persona real se va: la mesa se elimina aunque queden bots pendientes.
  assert.equal((await emitAck(host, 'leave_room')).ok, true);
  await waitForRoomCount(0);
  host.disconnect();
}

async function testHostInactivityMigration() {
  const hostToken = `idle-host-${Date.now()}`;
  const guestToken = `idle-guest-${Date.now()}`;
  const host = connectClient(); await waitFor(host, 'connect');
  const state = await createRoom(host, 'coinflip', hostToken, 'Distraído');
  const guest = connectClient(); await waitFor(guest, 'connect');
  assert.equal((await emitAck(guest, 'join_room', { name: 'Activa', code: state.code, token: guestToken, avatar: 'owl' })).ok, true);

  // El anfitrión queda inactivo; la persona activa hereda la autoridad (nunca un bot).
  const deadline = Date.now() + 6000;
  let migrated = null;
  while (Date.now() < deadline) {
    await delay(200);
    await emitAck(guest, 'chat', { text: 'sigo aquí' });
    if (guest.latest?.hostId === guestToken) { migrated = guest.latest; break; }
  }
  assert.ok(migrated, 'la autoridad migró a la persona activa por inactividad del anfitrión');
  assert.equal(migrated.hostId, guestToken);

  await emitAck(guest, 'leave_room');
  await emitAck(host, 'leave_room');
  host.disconnect(); guest.disconnect();
  await waitForRoomCount(0);
}

async function testPokerAutoFillAndAbandonedRoom() {
  const hostToken = `poker-host-${Date.now()}`;
  const host = connectClient(); await waitFor(host, 'connect');
  let state = await createRoom(host, 'poker', hostToken, 'Tiburona');
  state = await waitState(host, current => current.players.length === 6);
  assert.ok(bots(state).every(player => player.bot?.difficulty === 'expert'));
  assert.equal((await emitAck(host, 'poker_start')).ok, true);
  await waitState(host, current => current.phase === 'preflop');

  // La única persona real abandona a mitad de mano: tras la gracia, la mesa desaparece.
  host.disconnect();
  await waitForRoomCount(0);
}

(async () => {
  try {
    await waitForServer();
    await testAutoFillAndRoundLifecycle();
    await testHostInactivityMigration();
    await testPokerAutoFillAndAbandonedRoom();
    console.log('✓ Ciclo de vida: autollenado experto, bots que ceden y desocupan, purga de fantasmas, migración por inactividad y limpieza de mesas.');
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    console.error(serverLog);
    process.exitCode = 1;
  } finally {
    for (const socket of clients) { try { socket.disconnect(); } catch (_) { /* cerrado */ } }
    child.kill('SIGTERM');
  }
})();
