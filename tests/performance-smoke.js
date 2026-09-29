'use strict';

// Fase 9.3 — Presupuesto de rendimiento:
// · La primera carga de escritorio debe caber en < 300 KB comprimidos (objetivo < 2 s
//   incluso en conexiones de 3 Mbps) y el servidor debe responder gzip para HTML/CSS/JS.
// · Las imágenes del lobby viajan con caché larga (solo cuestan la primera visita).
// · Los payloads de Socket.IO por ronda (lobby_state y room_state) quedan auditados
//   con un techo explícito para detectar regresiones al agregar campos.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { io } = require('socket.io-client');
const { TOS_VERSION } = require('../lib/terms');

const port = 5900 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-perf-${process.pid}.json`);
const clients = [];
let server;

// Presupuestos (bytes). Si un cambio legítimo los rebasa, subirlos a conciencia aquí.
const BUDGETS = {
  htmlGzip: 15_000,
  cssGzip: 30_000,
  jsGzip: 40_000,
  firstLoadGzip: 300_000, // html + css + app.js + cliente socket.io
  lobbyState: 30_000,
  roomState: 30_000,
  healthzMs: 250
};

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.log = '';
  child.stdout.on('data', chunk => { child.log += chunk; });
  child.stderr.on('data', chunk => { child.log += chunk; });
  return child;
}

function fetchRaw(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.get(`${url}${pathname}`, { headers: { 'accept-encoding': 'gzip', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'] || 'identity';
        const decoded = encoding === 'gzip' ? zlib.gunzipSync(body) : body;
        resolve({ status: res.statusCode, headers: res.headers, bytes: body.length, decodedBytes: decoded.length, encoding, ms: Date.now() - started, text: decoded.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error(`Timeout pidiendo ${pathname}`)); });
  });
}

function connectClient() {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.latest = null;
  socket.lobby = null;
  socket.maxRoomBytes = 0;
  socket.on('room_state', state => {
    socket.latest = state;
    socket.maxRoomBytes = Math.max(socket.maxRoomBytes, Buffer.byteLength(JSON.stringify(state)));
  });
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
async function waitState(socket, predicate, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (socket.latest && predicate(socket.latest)) return socket.latest;
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error('Tiempo agotado esperando estado de la sala.');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;

async function main() {
  server = startServer();
  await sleep(900);

  // 1) Primera carga comprimida dentro del presupuesto.
  const html = await fetchRaw('/');
  const css = await fetchRaw('/styles.css');
  const js = await fetchRaw('/app.js');
  const sioClient = await fetchRaw('/socket.io/socket.io.js');
  for (const [name, res] of [['/', html], ['/styles.css', css], ['/app.js', js]]) {
    assert.equal(res.status, 200, `${name} responde 200`);
    assert.equal(res.encoding, 'gzip', `${name} debe viajar con gzip (llegó ${res.encoding})`);
  }
  assert.ok(html.bytes < BUDGETS.htmlGzip, `HTML gzip ${kb(html.bytes)} < ${kb(BUDGETS.htmlGzip)}`);
  assert.ok(css.bytes < BUDGETS.cssGzip, `CSS gzip ${kb(css.bytes)} < ${kb(BUDGETS.cssGzip)}`);
  assert.ok(js.bytes < BUDGETS.jsGzip, `app.js gzip ${kb(js.bytes)} < ${kb(BUDGETS.jsGzip)}`);
  const firstLoad = html.bytes + css.bytes + js.bytes + sioClient.bytes;
  assert.ok(firstLoad < BUDGETS.firstLoadGzip, `Primera carga ${kb(firstLoad)} < ${kb(BUDGETS.firstLoadGzip)}`);

  // 2) Imágenes del lobby con caché larga (una semana) y HTML sin caché agresiva.
  const hero = await fetchRaw('/assets/casino-hero.jpg');
  assert.equal(hero.status, 200, 'La imagen del héroe existe');
  assert.match(hero.headers['cache-control'] || '', /max-age=604800/, 'Las imágenes llevan max-age de 7 días');
  assert.doesNotMatch(html.headers['cache-control'] || '', /max-age=604800/, 'El HTML no hereda la caché larga');

  // 3) /healthz responde rápido (presupuesto local generoso para CI).
  const health = await fetchRaw('/healthz');
  assert.equal(health.status, 200, '/healthz responde 200');
  assert.ok(health.ms < BUDGETS.healthzMs, `/healthz en ${health.ms} ms < ${BUDGETS.healthzMs} ms`);

  // 4) Payload de lobby_state auditado.
  const ana = connectClient();
  const anaJoin = await emitAck(ana, 'create_room', { name: 'PerfAna', roomName: 'Mesa Perf', game: 'roulette', token: 'perf-ana', avatar: 'fox', tos: TOS_VERSION });
  assert.ok(anaJoin?.ok, `create_room falló: ${anaJoin?.error}`);
  const started = Date.now();
  while (!ana.lobby && Date.now() - started < 4000) await sleep(50);
  assert.ok(ana.lobby, 'Llegó lobby_state');
  const lobbyBytes = Buffer.byteLength(JSON.stringify(ana.lobby));
  assert.ok(lobbyBytes < BUDGETS.lobbyState, `lobby_state ${kb(lobbyBytes)} < ${kb(BUDGETS.lobbyState)}`);

  // 5) Payload de room_state auditado durante una ronda completa de ruleta.
  const beto = connectClient();
  const betoJoin = await emitAck(beto, 'join_room', { code: anaJoin.code, name: 'PerfBeto', token: 'perf-beto', avatar: 'owl', tos: TOS_VERSION });
  assert.ok(betoJoin?.ok, `join_room falló: ${betoJoin?.error}`);
  await waitState(ana, s => s.players.filter(p => !p.isBot).length === 2);
  assert.ok((await emitAck(ana, 'quick_bet', { amount: 50, choice: 'red' }))?.ok, 'Apuesta de Ana aceptada');
  assert.ok((await emitAck(beto, 'quick_bet', { amount: 50, choice: 'black' }))?.ok, 'Apuesta de Beto aceptada');
  assert.ok((await emitAck(ana, 'quick_resolve'))?.ok, 'Giro aceptado');
  await waitState(ana, s => s.phase === 'results', 8000);
  const maxRoom = Math.max(ana.maxRoomBytes, beto.maxRoomBytes);
  assert.ok(maxRoom > 1000, 'room_state medido de verdad');
  assert.ok(maxRoom < BUDGETS.roomState, `room_state máximo ${kb(maxRoom)} < ${kb(BUDGETS.roomState)}`);

  console.log(`✅ performance-smoke: primera carga ${kb(firstLoad)} gzip, lobby ${kb(lobbyBytes)}, room máx ${kb(maxRoom)}, /healthz ${health.ms} ms, caché de imágenes OK`);
}

main()
  .then(() => cleanup(0))
  .catch(error => { console.error('❌ performance-smoke:', error.message); if (server?.log) console.error(server.log.slice(-800)); cleanup(1); });

function cleanup(code) {
  for (const socket of clients) { try { socket.disconnect(); } catch (_) { /* noop */ } }
  try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  if (server) { try { server.kill('SIGKILL'); } catch (_) { /* noop */ } }
  setTimeout(() => process.exit(code), 400);
}
