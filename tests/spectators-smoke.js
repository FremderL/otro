'use strict';

// Fase 8 — Smoke de espectadores: entrar a la tribuna, privacidad de la vista,
// chat con prefijo 👁, tomar asiento y limpieza al desconectarse.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const port = 4400 + Math.floor(Math.random() * 500);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-spectators-${process.pid}.json`);
const clients = [];
let server;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off', RECONNECT_GRACE_MS: '400' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.log = '';
  child.stdout.on('data', chunk => { child.log += chunk; });
  child.stderr.on('data', chunk => { child.log += chunk; });
  return child;
}
function connectClient() {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.latest = null;
  socket.on('room_state', state => { socket.latest = state; });
  clients.push(socket);
  return socket;
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 5000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}
function waitFor(emitter, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tiempo agotado esperando ${event}`)), timeout);
    emitter.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
}
async function waitState(socket, predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (socket.latest && predicate(socket.latest)) return socket.latest;
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error(`Tiempo agotado esperando estado: ${label}`);
}

(async () => {
  fs.rmSync(profilePath, { force: true });
  server = startServer();
  await new Promise(r => setTimeout(r, 900));

  // ---- Host crea una mesa de ruleta ----
  const host = connectClient();
  await waitFor(host, 'connect');
  const hostToken = `host-${Date.now()}`;
  const created = await emitAck(host, 'create_room', { name: 'Anfitriona', roomName: 'Mesa mirada', game: 'roulette', token: hostToken, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  const code = created.code;

  // ---- Sin T&C aceptados no hay tribuna ----
  const specToken = `spec-${Date.now()}`;
  const spectator = connectClient();
  await waitFor(spectator, 'connect');
  const rejected = await emitAck(spectator, 'spectate_room', { name: 'Mirona', code, token: specToken, avatar: 'fox' });
  assert.equal(rejected.ok, false, 'sin T&C debe rechazarse');

  // ---- El anfitrión (ya sentado) no puede espectear su propia mesa ----
  const selfSpectate = await emitAck(host, 'spectate_room', { name: 'Anfitriona', code, token: hostToken, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(selfSpectate.ok, false, 'un jugador sentado no entra a la tribuna');

  // ---- Espectadora entra a la tribuna ----
  const joined = await emitAck(spectator, 'spectate_room', { name: 'Mirona', code, token: specToken, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(joined.ok, true, joined.error);
  assert.equal(joined.code, code);
  const specState = await waitState(spectator, s => s.viewerSpectator?.id === specToken, 'room_state con viewerSpectator');
  assert.equal(specState.viewerSpectator.name, 'Mirona');
  assert.ok(!specState.players.some(p => p.id === specToken), 'la espectadora no ocupa asiento');
  await waitState(host, s => (s.spectators || []).length === 1, 'el host ve la tribuna');

  // ---- Privacidad: la apuesta del host se ve como 'locked' para la tribuna ----
  assert.equal((await emitAck(host, 'quick_bet', { amount: 50, choice: 'red' })).ok, true);
  const betting = await waitState(spectator, s => s.players.find(p => p.id === hostToken)?.bet > 0, 'apuesta visible en fichas');
  assert.equal(betting.players.find(p => p.id === hostToken).quickChoice, 'locked', 'la elección ajena queda oculta');

  // ---- Chat de espectadora con prefijo 👁 ----
  assert.equal((await emitAck(spectator, 'chat', { text: '¡Qué mesa!' })).ok, true);
  const chatted = await waitState(host, s => s.messages.some(m => m.text === '¡Qué mesa!'), 'mensaje de la tribuna');
  const message = chatted.messages.find(m => m.text === '¡Qué mesa!');
  assert.ok(message.name.startsWith('👁 '), `el nombre lleva prefijo 👁 (fue: ${message.name})`);

  // ---- Tomar asiento: join_room saca a la espectadora de la tribuna ----
  const seated = await emitAck(spectator, 'join_room', { name: 'Mirona', code, token: specToken, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(seated.ok, true, seated.error);
  const afterSeat = await waitState(host, s => s.players.some(p => p.id === specToken), 'la espectadora ya tiene asiento');
  assert.equal((afterSeat.spectators || []).length, 0, 'la tribuna queda vacía tras sentarse');
  const specSeated = await waitState(spectator, s => s.players.some(p => p.id === specToken) && !s.viewerSpectator, 'estado propio sin viewerSpectator');
  assert.ok(specSeated.players.find(p => p.id === specToken).name === 'Mirona');

  // ---- Un segundo espectador se desconecta y desaparece de la tribuna ----
  const ghostToken = `ghost-${Date.now()}`;
  const ghost = connectClient();
  await waitFor(ghost, 'connect');
  assert.equal((await emitAck(ghost, 'spectate_room', { name: 'Fantasma', code, token: ghostToken, avatar: 'cat', tos: TOS_VERSION })).ok, true);
  await waitState(host, s => (s.spectators || []).some(sp => sp.id === ghostToken), 'segundo espectador visible');
  ghost.disconnect();
  const cleaned = await waitState(host, s => !(s.spectators || []).some(sp => sp.id === ghostToken), 'la desconexión limpia la tribuna');
  assert.ok(cleaned.messages.some(m => m.system && m.text.includes('dejó de ver la mesa')), 'mensaje de salida de la tribuna');

  console.log('✅ spectators-smoke: tribuna, privacidad, chat 👁, tomar asiento y limpieza OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ spectators-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1500));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
