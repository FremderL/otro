'use strict';

// Fases 8.6 y 8.7 — Smoke del ranking mensual y del reinicio de temporada:
// el lobby publica el top de puntos del mes, el archivo legado (arreglo) se
// migra al formato con temporadas y, al cambiar el mes, todos los perfiles
// vuelven a 1000 fichas con el podio anterior archivado.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const port = 5600 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-season-${process.pid}.json`);
const clients = [];
let server;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off' },
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
  socket.lobby = null;
  socket.on('room_state', state => { socket.latest = state; });
  socket.on('lobby_state', payload => { socket.lobby = payload; });
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
async function waitLobby(socket, timeout = 4000) {
  const started = Date.now();
  while (!socket.lobby && Date.now() - started < timeout) await new Promise(r => setTimeout(r, 50));
  if (!socket.lobby) throw new Error('No llegó lobby_state.');
  return socket.lobby;
}
function waitExit(child, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no terminó tras SIGTERM.')), timeout);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
const currentMonth = new Date().toISOString().slice(0, 7);

(async () => {
  // ---- Archivo legado: un arreglo simple de perfiles se sigue cargando ----
  fs.writeFileSync(profilePath, JSON.stringify([{ id: 'legacy-user', name: 'Veterana', avatar: 'crown', chips: 4321 }]));

  server = startServer();
  await new Promise(r => setTimeout(r, 900));
  const token = `season-${Date.now()}`;
  const socket = connectClient();
  await waitFor(socket, 'connect');

  // ---- Fase 8.6: el lobby publica el ranking mensual ----
  const lobby = await waitLobby(socket);
  assert.equal(lobby.season.month, currentMonth, 'temporada actual = mes en curso');
  const legacyEntry = lobby.season.ranking.find(entry => entry.name === 'Veterana');
  assert.ok(legacyEntry && legacyEntry.chips === 4321, 'el archivo legado se migró y aparece en el ranking');

  const created = await emitAck(socket, 'create_room', { name: 'Temporadista', roomName: 'Mesa mensual', game: 'coinflip', token, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  assert.equal((await emitAck(socket, 'quick_bet', { amount: 50, choice: 'heads' })).ok, true);
  socket.disconnect();
  server.kill('SIGTERM');
  assert.equal(await waitExit(server), 0);

  // ---- El archivo guardado ya usa el formato con temporadas ----
  const saved = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.equal(saved.seasons.current, currentMonth, 'el archivo guarda la temporada vigente');
  assert.ok(saved.profiles.some(profile => profile.id === token), 'el perfil nuevo quedó persistido');
  const chipsBefore = saved.profiles.find(profile => profile.id === 'legacy-user').chips;
  assert.equal(chipsBefore, 4321, 'el perfil legado conserva sus fichas');

  // ---- Fase 8.7: simular cambio de mes y reiniciar la temporada ----
  saved.seasons.current = '2020-01';
  fs.writeFileSync(profilePath, JSON.stringify(saved));
  server = startServer();
  await new Promise(r => setTimeout(r, 900));
  const socket2 = connectClient();
  await waitFor(socket2, 'connect');
  const lobby2 = await waitLobby(socket2);
  assert.equal(lobby2.season.month, currentMonth, 'la nueva temporada es el mes en curso');
  assert.ok(lobby2.season.ranking.every(entry => entry.chips === 1000), 'todos los perfiles vuelven a 1000 puntos');
  assert.equal(lobby2.season.previous.month, '2020-01', 'la temporada cerrada quedó archivada');
  assert.equal(lobby2.season.previous.podium[0].name, 'Veterana', 'el podio anterior registra a la líder');
  assert.equal(lobby2.season.previous.podium[0].chips, 4321, 'con sus puntos de cierre');

  // ---- El bono diario de 100 se mantiene: perfil nuevo entra con 1000 + 100 ----
  const token2 = `fresh-${Date.now()}`;
  const created2 = await emitAck(socket2, 'create_room', { name: 'Novata', roomName: 'Mesa nueva', game: 'coinflip', token: token2, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(created2.ok, true, created2.error);
  const started = Date.now();
  while ((!socket2.latest || !socket2.latest.viewerProfile) && Date.now() - started < 4000) await new Promise(r => setTimeout(r, 50));
  assert.equal(socket2.latest.viewerProfile.chips, 1100, 'perfil nuevo: 1000 de temporada + bono diario de 100');
  assert.ok(socket2.latest.viewerProfile.transactions.some(tx => tx.reason.includes('Bono diario')), 'el bono diario sigue activo');

  console.log('✅ season-smoke: ranking mensual, migración de formato, reinicio a 1000 y bono diario OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ season-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1500));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
