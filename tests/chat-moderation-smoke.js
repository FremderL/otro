'use strict';

// Cobertura dedicada de la moderación compartida: censura sin bloquear el
// resto del mensaje, repetidos por canal y separación entre lobby y mesa.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const port = 6900 + Math.floor(Math.random() * 250);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-chat-${process.pid}.json`);
const clients = [];
let server;

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
async function waitState(socket, predicate, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (socket.latest && predicate(socket.latest)) return socket.latest;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Tiempo agotado esperando el estado de la mesa.');
}
async function waitServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`El servidor terminó antes de iniciar.\n${server.log}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch (_) { /* sigue arrancando */ }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error(`El servidor no abrió el puerto.\n${server.log}`);
}
function waitFor(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Tiempo agotado esperando ${event}`));
    }, timeout);
    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', DATABASE_URL: '', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.log = '';
  server.stdout.on('data', chunk => { server.log += chunk; });
  server.stderr.on('data', chunk => { server.log += chunk; });
  await waitServer();

  const table = connectClient();
  const lobbyPeer = connectClient();
  await Promise.all([
    waitFor(table, 'connect'),
    waitFor(lobbyPeer, 'connect')
  ]);

  // La mesa sigue siendo privada y exige T&C como antes.
  const created = await emitAck(table, 'create_room', {
    name: 'Mesa', game: 'roulette', token: 'chat-table-token', tos: TOS_VERSION
  });
  assert.equal(created.ok, true, created.error);
  await waitState(table, state => state.code === created.code);

  const tableText = 'Hola mesa, mierda y fuck, pero el resto sigue visible';
  assert.equal((await emitAck(table, 'chat', { text: tableText })).ok, true, 'el mensaje moderado se acepta');
  const moderatedState = await waitState(table, state => state.messages.some(message => message.text.includes('resto sigue visible')));
  const moderated = moderatedState.messages.find(message => message.text.includes('resto sigue visible'));
  assert.ok(moderated && /\*+/.test(moderated.text), 'la grosería se censura con asteriscos');
  assert.ok(!/mierda|fuck/i.test(moderated.text), 'la palabra original no viaja al cliente');
  assert.equal((await emitAck(table, 'chat', { text: tableText })).ok, false, 'el mismo mensaje de mesa se frena durante 8 segundos');

  // Unirse al lobby exige apodo y T&C, y reutiliza el token de dispositivo al
  // volver a identificarse; no utiliza el roomCode ni el historial de la mesa.
  assert.equal((await emitAck(lobbyPeer, 'lobby_chat_join', { token: 'chat-lobby-token', tos: TOS_VERSION })).ok, false, 'el lobby exige apodo');
  assert.equal((await emitAck(lobbyPeer, 'lobby_chat_join', { token: 'chat-lobby-token', name: 'Lobby', tos: 'old-version' })).ok, false, 'el lobby exige T&C vigentes');
  assert.equal((await emitAck(lobbyPeer, 'lobby_chat_join', { token: 'chat-lobby-token', name: 'Lobby', tos: TOS_VERSION })).ok, true, 'el lobby acepta apodo y T&C');
  assert.equal((await emitAck(table, 'lobby_chat_join', { token: 'chat-table-token', name: 'Mesa', tos: TOS_VERSION })).ok, true, 'la misma identidad de dispositivo puede abrir el lobby aparte');

  const incoming = waitFor(lobbyPeer, 'lobby_chat_message', message => message.text.includes('resto lobby'));
  const lobbyText = 'Hola resto lobby, mierda y shit';
  assert.equal((await emitAck(table, 'lobby_chat', { text: lobbyText })).ok, true, 'el mensaje global se acepta');
  const lobbyMessage = await incoming;
  assert.ok(/\*+/.test(lobbyMessage.text), 'la censura también se aplica al lobby');
  assert.ok(!/mierda|shit/i.test(lobbyMessage.text), 'la grosería del lobby no se filtra');
  assert.ok(lobbyMessage.text.includes('resto lobby'), 'la moderación no bloquea el resto del mensaje');
  assert.equal((await emitAck(table, 'lobby_chat', { text: lobbyText })).ok, false, 'el repetido del lobby se frena de forma independiente');

  const roomAfterLobby = await waitState(table, state => state.messages.some(message => message.text.includes('resto sigue visible')));
  assert.equal(roomAfterLobby.messages.some(message => message.text.includes('resto lobby')), false, 'el chat global no entra en la mesa');
  assert.equal(lobbyMessage.text.includes('resto sigue visible'), false, 'el chat de mesa no entra al lobby');

  console.log('✅ chat-moderation-smoke: groserías censuradas, repetidos frenados y lobby aislado con apodo + T&C OK');
  cleanup(0);
}

main().catch(error => {
  console.error('❌ chat-moderation-smoke:', error.message);
  if (server?.log) console.error(server.log.slice(-900));
  cleanup(1);
});

function cleanup(code) {
  for (const socket of clients) { try { socket.disconnect(); } catch (_) { /* noop */ } }
  try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  if (server) { try { server.kill('SIGKILL'); } catch (_) { /* noop */ } }
  setTimeout(() => process.exit(code), 250);
}
