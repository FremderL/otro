'use strict';

// Fase 11.2 — Login opcional (usuario + contraseña) para portabilidad de perfil.
//
// El modo sin cuenta (token de dispositivo en localStorage) sigue existiendo
// sin cambios; este test cubre la capa adicional: vincular usuario+contraseña
// al perfil actual y recuperar ese mismo perfil (fichas, logros, historial)
// desde "otra computadora" (en la prueba, desde un socket nuevo sin el token
// original).
//
// Partes:
// 1. Unidad — lib/password.js: hash/verificación con scrypt, formato inválido.
// 2. Unidad — normalizeUsername: formatos válidos e inválidos.
// 3. Unidad — BaseProfileStore.registerAccount/authenticate: alta, duplicados,
//    contraseña corta, credenciales incorrectas (mensaje genérico) y bloqueo
//    temporal tras varios intentos fallidos seguidos.
// 4. E2E — servidor real (backend de archivo): crea perfil vía create_room,
//    vincula cuenta, y la recupera completa desde un socket nuevo con
//    account_login (sin el token original). Confirma también que el hash de
//    contraseña nunca viaja al cliente.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');
const { hashPassword, verifyPassword } = require('../lib/password');
const { normalizeUsername, cleanProfile } = require('../lib/profile-store-shared');
const { BaseProfileStore } = require('../lib/profile-store-base');

function testPasswordHashing() {
  const stored = hashPassword('correcto-123');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]+$/, 'formato sal:hash en hexadecimal');
  assert.equal(verifyPassword('correcto-123', stored), true, 'la contraseña correcta verifica');
  assert.equal(verifyPassword('incorrecto', stored), false, 'una contraseña distinta no verifica');
  assert.equal(verifyPassword('correcto-123', 'no-tiene-formato-valido'), false, 'un formato corrupto no verifica (sin lanzar)');
  assert.equal(verifyPassword('correcto-123', null), false, 'un valor nulo no verifica (sin lanzar)');
  // Dos hashes de la misma contraseña deben diferir (sal aleatoria).
  assert.notEqual(hashPassword('correcto-123'), stored, 'la sal es aleatoria por contraseña');
}

function testNormalizeUsername() {
  assert.equal(normalizeUsername('  Ana_99  '), 'ana_99', 'normaliza a minúsculas y recorta espacios');
  assert.equal(normalizeUsername('ab'), null, 'menos de 3 caracteres se rechaza');
  assert.equal(normalizeUsername('a'.repeat(21)), null, 'más de 20 caracteres se rechaza');
  assert.equal(normalizeUsername('usuario con espacios'), null, 'espacios internos se rechazan');
  assert.equal(normalizeUsername('usuario!'), null, 'símbolos fuera de [a-z0-9_] se rechazan');
  assert.equal(normalizeUsername(''), null, 'vacío se rechaza');
}

function testRegisterAndAuthenticate() {
  class MemStore extends BaseProfileStore {
    load() {}
    saveNow() {}
  }
  const store = new MemStore();
  const ana = cleanProfile({ id: 'ana-device', name: 'Ana', chips: 1500 });
  const beto = cleanProfile({ id: 'beto-device', name: 'Beto', chips: 900 });
  store.profiles.set(ana.id, ana);
  store.profiles.set(beto.id, beto);

  // --- Alta ---
  let result = store.registerAccount(ana, 'Ana_99', 'clave-segura');
  assert.equal(result.ok, true, 'alta de cuenta válida');
  assert.equal(ana.username, 'ana_99', 'el usuario queda normalizado');
  assert.ok(ana.passwordHash, 'se guarda un hash, no la contraseña');
  assert.notEqual(ana.passwordHash, 'clave-segura', 'el hash no es la contraseña en texto plano');

  assert.equal(store.registerAccount(beto, 'us', 'clave-segura').ok, false, 'usuario demasiado corto se rechaza');
  assert.equal(store.registerAccount(beto, 'beto1', 'corta').ok, false, 'contraseña de menos de 6 caracteres se rechaza');
  const dup = store.registerAccount(beto, 'ANA_99', 'otra-clave-99');
  assert.equal(dup.ok, false, 'un usuario ya tomado (sin importar mayúsculas) se rechaza');
  assert.equal(beto.username, null, 'el intento fallido no deja el perfil de Beto a medias');

  // --- Autenticación ---
  const login = store.authenticate('Ana_99', 'clave-segura');
  assert.equal(login.ok, true, 'login con las credenciales correctas');
  assert.equal(login.profile.id, ana.id, 'devuelve el mismo perfil vinculado');

  const wrongPassword = store.authenticate('ana_99', 'clave-incorrecta');
  assert.equal(wrongPassword.ok, false, 'contraseña incorrecta rechazada');
  const unknownUser = store.authenticate('nadie-existe', 'lo-que-sea');
  assert.equal(unknownUser.ok, false, 'usuario inexistente rechazado');
  assert.equal(wrongPassword.error, unknownUser.error, 'mismo mensaje genérico: no se filtra cuál de los dos falló');

  // --- Bloqueo temporal tras intentos fallidos seguidos ---
  for (let i = 0; i < 4; i++) store.authenticate('ana_99', 'clave-incorrecta');
  const fifthFailure = store.authenticate('ana_99', 'clave-incorrecta'); // 5º intento fallido: dispara el bloqueo
  assert.equal(fifthFailure.ok, false);
  const lockedAttempt = store.authenticate('ana_99', 'clave-segura'); // contraseña correcta, pero ya bloqueada
  assert.equal(lockedAttempt.ok, false, 'bloqueado incluso con la contraseña correcta');
  assert.match(lockedAttempt.error, /Demasiados intentos/, 'mensaje explica el bloqueo temporal');
  // Simulamos que el tiempo de bloqueo ya pasó (evita esperar 60s reales en la prueba):
  ana.flags.loginLockedUntil = Date.now() - 1;
  const afterExpiry = store.authenticate('ana_99', 'clave-segura');
  assert.equal(afterExpiry.ok, true, 'pasado el bloqueo, la contraseña correcta vuelve a funcionar');
}

// --- E2E con servidor real (backend de archivo) -----------------------------

const port = 4800 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-account-${process.pid}.json`);
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
  testPasswordHashing();
  testNormalizeUsername();
  testRegisterAndAuthenticate();

  fs.rmSync(profilePath, { force: true });
  server = startServer();
  await waitForServer();

  const originalToken = `orig-${Date.now()}`;
  const socketA = connectClient();
  await waitFor(socketA, 'connect');
  const created = await emitAck(socketA, 'create_room', { name: 'Original', roomName: 'Mesa de la cuenta', game: 'coinflip', token: originalToken, avatar: 'panda', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  await waitState(socketA, s => s.code === created.code, 'sala creada');
  // Le damos algo de historial propio antes de vincular la cuenta, para
  // confirmar que login recupera el perfil completo, no uno recién creado.
  assert.equal((await emitAck(socketA, 'quick_bet', { amount: 40, choice: 'heads' })).ok, true);
  assert.equal((await emitAck(socketA, 'quick_resolve')).ok, true);
  await waitState(socketA, s => s.phase === 'results', 'fase de resultados');

  // --- Signup: username repetido en mayúsculas para probar normalización ---
  const username = `jugador${Date.now()}`;
  const signup = await emitAck(socketA, 'account_signup', { token: originalToken, username: username.toUpperCase(), password: 'clave-larga-99', tos: TOS_VERSION });
  assert.equal(signup.ok, true, signup.error);
  assert.equal(signup.profile.username, username.toLowerCase(), 'el usuario se guarda normalizado');
  assert.equal(signup.profile.passwordHash, undefined, 'el hash de contraseña nunca viaja al cliente');
  assert.equal(JSON.stringify(signup).includes('passwordHash'), false, 'ni siquiera aparece la clave passwordHash en la respuesta');

  // Re-registrar con el MISMO token es idempotente (es el mismo perfil):
  const reSignup = await emitAck(socketA, 'account_signup', { token: originalToken, username, password: 'otra-clave-99', tos: TOS_VERSION });
  assert.equal(reSignup.ok, true, 'el propio dueño puede re-registrar su mismo usuario (no es un duplicado real)');

  // --- Un perfil DISTINTO intentando tomar el mismo usuario: sí debe rechazarse ---
  const socketB = connectClient();
  await waitFor(socketB, 'connect');
  const otherToken = `otro-${Date.now()}`;
  const dupSignup = await emitAck(socketB, 'account_signup', { token: otherToken, name: 'Otra Persona', username, password: 'una-clave-distinta', tos: TOS_VERSION });
  assert.equal(dupSignup.ok, false, 'un perfil distinto no puede tomar un usuario ya en uso');

  // --- "Se cambia de computadora": socket nuevo, SIN el token original ---

  const wrongLogin = await emitAck(socketB, 'account_login', { username, password: 'contraseña-equivocada' });
  assert.equal(wrongLogin.ok, false, 'contraseña equivocada rechazada desde el dispositivo nuevo');

  const login = await emitAck(socketB, 'account_login', { username, password: 'otra-clave-99' });
  assert.equal(login.ok, true, login.error);
  assert.equal(login.token, originalToken, 'el login devuelve el MISMO token/id de perfil original');
  assert.equal(login.profile.name, 'Original', 'se recupera el nombre del perfil original');
  assert.equal(login.profile.chips, signup.profile.chips, 'se recuperan las mismas fichas (incluye la ronda ya jugada)');
  assert.ok(login.profile.transactions.length >= 1, 'se recupera el historial de transacciones ya existente');
  assert.equal(login.profile.passwordHash, undefined, 'tampoco se filtra el hash al iniciar sesión');

  // --- Apagado limpio ---
  server.kill('SIGTERM');
  assert.equal(await waitExit(server), 0, 'apagado limpio');

  console.log('✅ account-login-smoke: hash de contraseñas, alta, bloqueo por fuerza bruta y recuperación de perfil por login OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ account-login-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1200));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
