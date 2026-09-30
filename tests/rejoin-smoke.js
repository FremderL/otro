'use strict';

// Regresión — Reingreso a una mesa con el mismo token (recarga de página o
// reconexión automática del socket). Hasta la corrección, join_room tenía un
// ReferenceError (referenciaba `featuredAchievements`, una variable que ese
// evento nunca recibe) que TUMBABA el proceso entero del servidor: todas las
// mesas en memoria desaparecían, los clientes quedaban huérfanos y cualquier
// edición de perfil desde la "mesa fantasma" respondía "Perfil no disponible."
// Ninguna otra suite reingresaba con un token ya sentado, por eso nadie lo vio.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const { TOS_VERSION } = require('../lib/terms');

const port = 4000 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-rejoin-${process.pid}.json`);
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, DATABASE_URL: '', BOT_SPEED_FACTOR: '0.05' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk; });
child.stderr.on('data', chunk => { serverLog += chunk; });
let childExit = null;
child.on('exit', (code, signal) => { childExit = { code, signal }; });
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
async function waitServerUp() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (childExit) throw new Error(`El servidor murió al arrancar: ${JSON.stringify(childExit)}\n${serverLog}`);
    if (serverLog.includes('http')) return;
    await delay(200);
  }
  throw new Error(`El servidor no arrancó a tiempo.\n${serverLog}`);
}

async function main() {
  await waitServerUp();

  // === 1) Ana crea una mesa ===
  const token = `rejoin-device-${Date.now()}`;
  const firstSocket = connectClient();
  await waitFor(firstSocket, 'connect');
  const created = await emitAck(firstSocket, 'create_room', { name: 'Ana', roomName: 'Mesa del reingreso', game: 'coinflip', token, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error || 'crear la mesa debe funcionar');
  const code = created.code;
  firstSocket.disconnect();
  await delay(200);

  // === 2) Ana recarga la página: NUEVO socket, MISMO token, misma mesa ===
  // Antes: este ack nunca llegaba y el proceso del servidor moría con
  // "ReferenceError: featuredAchievements is not defined".
  const backSocket = connectClient();
  await waitFor(backSocket, 'connect');
  const rejoin = await emitAck(backSocket, 'join_room', { name: 'Ana', code, token, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(rejoin.ok, true, rejoin.error || 'reingresar a la mesa con el mismo token debe responder ok');

  // El servidor debe seguir VIVO después del reingreso (antes ya estaría muerto).
  await delay(400);
  assert.equal(childExit, null, `el proceso del servidor no debe morir tras un reingreso: ${JSON.stringify(childExit)}\n${serverLog}`);
  assert.doesNotMatch(serverLog, /ReferenceError|HANDLER_ERROR/, 'no debe registrarse ningún error de handler');

  // === 3) Ana recupera su asiento y su perfil de mesa ===
  const state = await waitState(backSocket, current => current.viewerProfile?.name === 'Ana', 'room_state tras reingresar');
  assert.ok(state.players.some(player => player.id === token && player.connected), 'Ana vuelve a figurar sentada y conectada');
  assert.ok(state.messages.some(message => message.system && /volvió a la mesa/.test(message.text)), 'se anuncia el regreso a la mesa');

  // === 4) El motivo original del reporte: editar el perfil (nombre/avatar)
  // desde la mesa después de reconectar NO debe decir "Perfil no disponible." ===
  const rename = await emitAck(backSocket, 'profile_update', { name: 'Ana Reconectada', avatar: 'owl' });
  assert.equal(rename.ok, true, rename.error || 'editar el perfil tras reconectar debe funcionar');
  assert.equal(rename.profile.name, 'Ana Reconectada');
  await waitState(backSocket, current => current.viewerProfile?.name === 'Ana Reconectada', 'el nuevo nombre se refleja en room_state');

  // === 5) La vitrina de logros desde la mesa también responde (mismo handler) ===
  const showcase = await emitAck(backSocket, 'profile_update', { name: 'Ana Reconectada', avatar: 'owl', featuredAchievements: [] });
  assert.equal(showcase.ok, true, showcase.error || 'actualizar la vitrina tras reconectar no debe fallar');

  console.log('✔ rejoin-smoke: reingresar a la mesa conserva el asiento, el servidor sobrevive y el perfil se puede editar');
}

main().then(() => {
  for (const socket of clients) { try { socket.disconnect(); } catch { /* nada */ } }
  child.kill('SIGKILL');
  setTimeout(() => process.exit(0), 150);
}).catch(error => {
  console.error('✘ rejoin-smoke falló:', error.message);
  if (serverLog) console.error('--- log del servidor ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  for (const socket of clients) { try { socket.disconnect(); } catch { /* nada */ } }
  try { child.kill('SIGKILL'); } catch { /* nada */ }
  setTimeout(() => process.exit(1), 150);
});
