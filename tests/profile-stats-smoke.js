'use strict';

// Fase 8.2 — Smoke de estadísticas ampliadas: % de victorias, historial por juego
// y evolución de saldo, con persistencia en disco tras un apagado limpio.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const port = 4200 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-stats-${process.pid}.json`);
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
async function waitState(socket, predicate, label, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (socket.latest && predicate(socket.latest)) return socket.latest;
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error(`Tiempo agotado esperando estado: ${label}`);
}
function waitExit(child, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no terminó tras SIGTERM.')), timeout);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
async function playRound(socket, choice) {
  assert.equal((await emitAck(socket, 'quick_bet', { amount: 50, choice })).ok, true, 'apuesta aceptada');
  assert.equal((await emitAck(socket, 'quick_resolve')).ok, true, 'resolución aceptada');
  return waitState(socket, s => s.phase === 'results', 'fase de resultados');
}

(async () => {
  fs.rmSync(profilePath, { force: true });
  server = startServer();
  await new Promise(r => setTimeout(r, 900));

  const token = `stats-${Date.now()}`;
  const socket = connectClient();
  await waitFor(socket, 'connect');
  const created = await emitAck(socket, 'create_room', { name: 'Estadista', roomName: 'Mesa de datos', game: 'coinflip', token, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);

  // ---- Primera ronda: el historial por juego y la gráfica empiezan a llenarse ----
  let state = await playRound(socket, 'heads');
  let profile = state.viewerProfile;
  assert.ok(profile, 'el creador recibe su perfil privado');
  assert.equal(typeof profile.stats.winRate, 'number', 'winRate presente');
  assert.ok(profile.stats.winRate === 0 || profile.stats.winRate === 100, `winRate coherente tras 1 ronda (fue ${profile.stats.winRate})`);
  assert.ok(profile.gameStats, 'gameStats presente en el perfil privado');
  assert.equal(profile.gameStats.coinflip.rounds, 1, 'una ronda registrada en cara o cruz');
  assert.equal(profile.gameStats.coinflip.wins, profile.stats.wins, 'victorias por juego coinciden con las globales');
  assert.ok(Array.isArray(profile.balanceHistory) && profile.balanceHistory.length >= 1, 'la evolución de saldo tiene puntos');
  const lastPoint = profile.balanceHistory[profile.balanceHistory.length - 1];
  assert.equal(lastPoint.chips, profile.chips, 'el último punto de la gráfica refleja el saldo actual');

  // ---- Segunda ronda: los contadores avanzan ----
  assert.equal((await emitAck(socket, 'quick_new')).ok, true, 'nueva ronda');
  await waitState(socket, s => s.phase === 'betting', 'fase de apuestas');
  const pointsBefore = profile.balanceHistory.length;
  state = await playRound(socket, 'tails');
  profile = state.viewerProfile;
  assert.equal(profile.gameStats.coinflip.rounds, 2, 'dos rondas registradas');
  assert.equal(profile.stats.winRate, Math.round(profile.stats.wins / profile.stats.roundsPlayed * 100), 'winRate = victorias/rondas');
  assert.ok(profile.balanceHistory.length > pointsBefore, 'la gráfica creció con la segunda ronda');
  const expectedNet = profile.gameStats.coinflip.net;
  assert.ok(Number.isInteger(expectedNet), 'balance neto por juego es un entero');

  // ---- Persistencia: SIGTERM guarda gameStats y balanceHistory en disco ----
  server.kill('SIGTERM');
  assert.equal(await waitExit(server), 0, 'apagado limpio');
  const savedData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const saved = Array.isArray(savedData) ? savedData : savedData.profiles; // formato con temporadas (fase 8.7)
  const stored = saved.find(item => item.id === token);
  assert.ok(stored, 'perfil persistido');
  assert.equal(stored.gameStats.coinflip.rounds, 2, 'gameStats sobrevive al reinicio');
  assert.ok(stored.balanceHistory.length >= 2, 'balanceHistory sobrevive al reinicio');

  console.log('✅ profile-stats-smoke: winRate, historial por juego, gráfica de saldo y persistencia OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ profile-stats-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1200));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
