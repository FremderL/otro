'use strict';

// Fase 7 — Smoke operativo: /healthz, apagado limpio con SIGTERM, logs estructurados
// y persistencia de perfiles entre "deploys" (dos arranques con el mismo PROFILE_STORE_PATH).

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TOS_VERSION } = require('../lib/terms');

const port = 3800 + Math.floor(Math.random() * 500);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-ops-${process.pid}.json`);
const clients = [];

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', RECONNECT_GRACE_MS: '400' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.log = '';
  child.stdout.on('data', chunk => { child.log += chunk; });
  child.stderr.on('data', chunk => { child.log += chunk; });
  return child;
}
function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}${pathname}`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, json: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('timeout')));
  });
}
async function waitForHealth(timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { return await fetchJson('/healthz'); } catch (_) { await new Promise(r => setTimeout(r, 150)); }
  }
  throw new Error('El servidor no respondió /healthz a tiempo.');
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
async function waitLatest(socket, timeout = 4000) {
  const started = Date.now();
  while (!socket.latest && Date.now() - started < timeout) await new Promise(r => setTimeout(r, 50));
  if (!socket.latest) throw new Error('No llegó room_state.');
  return socket.latest;
}
function waitExit(child, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no terminó tras SIGTERM.')), timeout);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

(async () => {
  fs.rmSync(profilePath, { force: true });
  const token = `ops-${Date.now()}`;

  // ---- Primera "instancia" (deploy 1) ----
  let server = startServer();
  const health = await waitForHealth();
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok', '/healthz responde status ok');
  assert.ok(Number.isInteger(health.json.uptimeSeconds) && health.json.uptimeSeconds >= 0, 'uptime presente');
  assert.equal(health.json.rooms, 0, 'sin salas al arrancar');
  assert.equal(health.json.tosVersion, TOS_VERSION, 'expone la versión de T&C vigente');

  const socket = connectClient();
  await waitFor(socket, 'connect');
  const created = await emitAck(socket, 'create_room', { name: 'Operadora', roomName: 'Sala de ops', game: 'coinflip', token, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  assert.equal((await emitAck(socket, 'quick_bet', { amount: 50, choice: 'heads' })).ok, true);
  const chipsBefore = (await waitLatest(socket)).viewerProfile.chips;
  assert.ok((await fetchJson('/healthz')).json.rooms >= 1, 'healthz refleja la sala activa');

  // Apagado limpio: aviso a la mesa, guardado de perfiles y salida ordenada.
  const noticePromise = waitFor(socket, 'room_state', 3000);
  const disconnectPromise = waitFor(socket, 'disconnect', 4000);
  server.kill('SIGTERM');
  const noticed = await noticePromise;
  assert.ok(noticed.messages.some(message => message.text.includes('se está actualizando')), 'las mesas reciben el aviso de reinicio');
  const exitCode = await waitExit(server);
  assert.equal(exitCode, 0, 'SIGTERM produce una salida ordenada (código 0)');
  await disconnectPromise;
  assert.ok(server.log.includes('"event":"shutdown_start"') && server.log.includes('"event":"server_listening"'), 'logs estructurados JSON presentes');
  assert.ok(fs.existsSync(profilePath), 'el archivo de perfiles quedó escrito en disco');
  const savedData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const saved = Array.isArray(savedData) ? savedData : savedData.profiles; // formato con temporadas (fase 8.7)
  assert.ok(saved.some(profile => profile.id === token), 'el perfil del jugador está persistido');

  // ---- Segunda "instancia" (deploy 2, mismo disco) ----
  server = startServer();
  await waitForHealth();
  const socket2 = connectClient();
  await waitFor(socket2, 'connect');
  const recreated = await emitAck(socket2, 'create_room', { name: 'Operadora', roomName: 'Sala de ops 2', game: 'coinflip', token, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(recreated.ok, true, recreated.error);
  const chipsAfter = (await waitLatest(socket2)).viewerProfile.chips;
  // La apuesta abierta se reembolsa al morir la instancia sin resolverse, así que el saldo
  // persistido puede diferir en esa apuesta; lo importante es conservar el perfil y su magnitud.
  assert.ok(Math.abs(chipsAfter - chipsBefore) <= 50, `los perfiles sobreviven al redeploy (antes ${chipsBefore}, después ${chipsAfter})`);
  assert.equal(socket2.latest.viewerProfile.avatar, 'owl', 'avatar persistido');

  server.kill('SIGTERM');
  await waitExit(server);
  clients.forEach(client => client.close());
  fs.rmSync(profilePath, { force: true });
  console.log('✓ Ops: /healthz, SIGTERM limpio con aviso a mesas, logs JSON y perfiles que sobreviven redeploys.');
  process.exit(0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
