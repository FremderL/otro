'use strict';

// Fase 11.1 — Historial y estadísticas sin límite artificial.
//
// Parte unitaria (sin servidor): HISTORY_LIMITS es un objeto compartido por
// referencia entre cleanProfile (lib/profile-store-shared.js), ensureSeason
// (lib/profile-store-base.js) y credit/recordOutcome (lib/progression.js).
// Verifica que, tal como hace server.js cuando el backend activo es Postgres,
// elevar ese techo en un solo lugar cambia el recorte en los tres sitios sin
// tocar cada llamada.
//
// Parte E2E (servidor real, backend de archivo — el de siempre sin
// DATABASE_URL): confirma que el comportamiento histórico (20 transacciones,
// 60 puntos de saldo) no cambió, que el nuevo endpoint de descarga
// `/api/perfil/:token/historial` expone ese historial completo (y 404 para
// tokens desconocidos), y que el log de arranque reporta el backend y los
// techos activos para poder auditarlo en producción.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');
const { HISTORY_LIMITS, cleanProfile } = require('../lib/profile-store-shared');
const { BaseProfileStore } = require('../lib/profile-store-base');
const { credit } = require('../lib/progression');

function testLimiteCompartidoEnMemoria() {
  const original = { ...HISTORY_LIMITS };
  try {
    // --- Comportamiento por defecto (archivo JSON): 20 transacciones, 60 puntos ---
    const profile = cleanProfile({ id: 'x' });
    for (let i = 0; i < 90; i++) credit(profile, 10, `mov-${i}`);
    assert.equal(profile.transactions.length, 20, 'techo por defecto: 20 transacciones');
    assert.equal(profile.balanceHistory.length, 60, 'techo por defecto: 60 puntos de saldo');

    // --- Igual que hace server.js si detecta backend Postgres (bootstrap()) ---
    HISTORY_LIMITS.transactions = 500;
    HISTORY_LIMITS.balance = 2000;
    const bigProfile = cleanProfile({ id: 'y' });
    for (let i = 0; i < 120; i++) credit(bigProfile, 5, `mov-${i}`);
    assert.equal(bigProfile.transactions.length, 120, 'con el techo elevado no se recorta antes de tiempo (transacciones)');
    assert.equal(bigProfile.balanceHistory.length, 120, 'con el techo elevado no se recorta antes de tiempo (balance)');

    // cleanProfile también respeta el techo activo al normalizar datos crudos
    // (por ejemplo, al cargar un perfil ya existente desde el archivo o Postgres).
    const rawWithManyPoints = { id: 'z', balanceHistory: Array.from({ length: 300 }, (_, i) => ({ t: i, chips: i })) };
    const loaded = cleanProfile(rawWithManyPoints);
    assert.equal(loaded.balanceHistory.length, 300, 'cleanProfile conserva hasta el techo elevado');
  } finally {
    Object.assign(HISTORY_LIMITS, original);
  }
}

function testEnsureSeasonRespetaTecho() {
  const original = { ...HISTORY_LIMITS };
  try {
    HISTORY_LIMITS.transactions = 3;
    HISTORY_LIMITS.balance = 3;
    class MemStore extends BaseProfileStore {
      load() {}
      saveNow() {}
    }
    const store = new MemStore();
    const profile = cleanProfile({
      id: 'season-test',
      transactions: [{ amount: 1, reason: 'a', time: 1 }, { amount: 1, reason: 'b', time: 2 }],
      balanceHistory: [{ t: 1, chips: 1 }, { t: 2, chips: 2 }]
    });
    store.profiles.set(profile.id, profile);
    store.seasons.current = '2000-01'; // fuerza a que ensureSeason la vea "vieja"
    const closed = store.ensureSeason();
    assert.ok(closed, 'ensureSeason cierra la temporada vieja');
    assert.ok(profile.transactions.length <= 3, 'ensureSeason respeta el techo de transacciones');
    // Fase 11.4: los puntos de la gráfica de saldo de la temporada que cierra
    // se descartan por completo (no solo se recortan al techo) para ahorrar
    // espacio; la nueva temporada arranca su propia gráfica desde cero.
    assert.equal(profile.balanceHistory.length, 1, 'ensureSeason borra los puntos de la temporada anterior y arranca uno nuevo');
    assert.equal(profile.balanceHistory[0].chips, 1000, 'el único punto que queda es el saldo recién reiniciado');
  } finally {
    Object.assign(HISTORY_LIMITS, original);
  }
}

// --- E2E con servidor real (backend de archivo) ---------------------------

const port = 4400 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-history-${process.pid}.json`);
const clients = [];
let server;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', DATABASE_URL: '' },
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
async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`El servidor terminó antes de iniciar.\n${server.log}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (_) { /* aún iniciando */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`El servidor no abrió el puerto.\n${server.log}`);
}
function waitExit(child, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no terminó tras SIGTERM.')), timeout);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

(async () => {
  testLimiteCompartidoEnMemoria();
  testEnsureSeasonRespetaTecho();

  fs.rmSync(profilePath, { force: true });
  server = startServer();
  await waitForServer();

  const token = `hist-${Date.now()}`;
  const socket = connectClient();
  await waitFor(socket, 'connect');
  const created = await emitAck(socket, 'create_room', { name: 'Historiadora', roomName: 'Mesa histórica', game: 'coinflip', token, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  await waitState(socket, s => s.code === created.code, 'sala creada');

  assert.equal((await emitAck(socket, 'quick_bet', { amount: 50, choice: 'heads' })).ok, true, 'apuesta aceptada');
  assert.equal((await emitAck(socket, 'quick_resolve')).ok, true, 'resolución aceptada');
  await waitState(socket, s => s.phase === 'results', 'fase de resultados');

  // --- Endpoint de descarga: perfil conocido ---
  const res = await fetch(`${url}/api/perfil/${token}/historial`);
  assert.equal(res.status, 200, 'el endpoint responde 200 para un perfil existente');
  assert.match(res.headers.get('content-disposition') || '', /attachment/, 'se ofrece como descarga');
  const payload = await res.json();
  assert.equal(payload.perfil.id, token, 'el historial corresponde al perfil correcto');
  assert.ok(Array.isArray(payload.evolucionDeSaldo) && payload.evolucionDeSaldo.length >= 1, 'incluye la evolución de saldo');
  assert.ok(Array.isArray(payload.transacciones) && payload.transacciones.length >= 1, 'incluye las transacciones');
  assert.ok(payload.estadisticas, 'incluye las estadísticas');

  // --- Endpoint de descarga: perfil inexistente ---
  const missing = await fetch(`${url}/api/perfil/no-existe-${Date.now()}/historial`);
  assert.equal(missing.status, 404, 'un token desconocido responde 404, no expone nada');

  // --- Apagado limpio y verificación del log de arranque (backend + techos) ---
  server.kill('SIGTERM');
  assert.equal(await waitExit(server), 0, 'apagado limpio');
  assert.match(server.log, /"profileBackend":"file"/, 'el log reporta el backend de archivo (sin DATABASE_URL)');
  assert.match(server.log, /"historyLimits":\{"transactions":20,"balance":60\}/, 'el log reporta los techos por defecto (20/60)');

  console.log('✅ profile-history-smoke: techo compartido, ensureSeason, endpoint de descarga (200/404) y log de arranque OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ profile-history-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1200));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
