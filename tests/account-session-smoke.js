'use strict';

// Auditoría de cuenta/login/perfil — cobertura de servidor (protocolo de
// sockets, sin UI). Complementa account-login-smoke.js (que ya cubre el hash
// de contraseñas, el bloqueo por fuerza bruta y la recuperación básica del
// perfil por login) con los puntos nuevos de esta auditoría:
//
//  1. account_login/account_signup devuelven username + perfil público
//     completo (fichas, stats, logros) y NUNCA passwordHash.
//  2. profile_update funciona sin estar sentado en una mesa cuando se manda
//     `accountId` (edición desde el lobby) y persiste de verdad en el
//     servidor (se confirma con un login posterior desde otro socket).
//  3. profile_update guarda featuredAchievements (antes se ignoraba en el
//     propio backend aunque el payload lo mandara: bug corregido).
//  4. Sin mesa y sin accountId válido, profile_update falla con "Perfil no
//     disponible." (no se inventa una mesa ni se edita cualquier perfil).
//  5. account_profile expone el perfil público de una cuenta vinculada (para
//     refrescar una sesión cacheada incompleta/obsoleta) pero nunca el de un
//     perfil anónimo sin cuenta (evita fugas de perfiles ajenos adivinando
//     su id de dispositivo), y nunca incluye passwordHash.
//  6. Editar desde una mesa sigue persistiendo en el servidor.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const port = 4900 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-account-session-${process.pid}.json`);
const clients = [];
let server;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', DATABASE_URL: '', LOG_JSON: 'off' },
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
function assertNoPasswordHash(payload, label) {
  const json = JSON.stringify(payload);
  assert.equal(json.includes('passwordHash'), false, `${label}: no debe incluir passwordHash`);
  assert.equal(json.includes('"password"'), false, `${label}: no debe incluir password en texto plano`);
}

(async () => {
  fs.rmSync(profilePath, { force: true });
  server = startServer();
  await waitForServer();

  // --- Prepara una cuenta desde una mesa (como en la vida real: primero se
  // juega anónimamente y luego se vincula usuario+contraseña) ---
  const deviceToken = `dev-${Date.now()}`;
  const owner = connectClient();
  await waitFor(owner, 'connect');
  const created = await emitAck(owner, 'create_room', { name: 'Ana', roomName: 'Mesa de auditoría', game: 'coinflip', token: deviceToken, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  await waitState(owner, s => s.code === created.code, 'sala creada');

  const username = `aud${Date.now()}`.slice(0, 20);
  const password = 'clave-super-segura-1';
  const signup = await emitAck(owner, 'account_signup', { token: deviceToken, username, password, tos: TOS_VERSION });
  assert.equal(signup.ok, true, signup.error);
  assert.equal(signup.profile.username, username, 'el signup devuelve el username vinculado');
  assert.ok(signup.profile.stats, 'el signup devuelve estadísticas públicas');
  assertNoPasswordHash(signup, 'account_signup');

  // === 1) account_login devuelve username + perfil público completo, sin passwordHash ===
  const loginSocket = connectClient();
  await waitFor(loginSocket, 'connect');
  const badLogin = await emitAck(loginSocket, 'account_login', { username, password: 'contraseña-mala' });
  assert.equal(badLogin.ok, false, 'login con contraseña incorrecta se rechaza');
  assertNoPasswordHash(badLogin, 'account_login fallido');

  const login = await emitAck(loginSocket, 'account_login', { username, password });
  assert.equal(login.ok, true, login.error);
  assert.equal(login.profile.username, username, 'login devuelve el username');
  assert.ok(login.profile.stats, 'login devuelve estadísticas públicas (para el modal de perfil)');
  assert.ok(Array.isArray(login.profile.achievements), 'login devuelve la lista de logros desbloqueados');
  assertNoPasswordHash(login, 'account_login');
  const accountId = login.profile.id;

  // === 2) profile_update SIN mesa, con accountId: persiste de verdad ===
  const lobbySocket = connectClient();
  await waitFor(lobbySocket, 'connect');
  const lobbyEdit = await emitAck(lobbySocket, 'profile_update', {
    name: 'Ana editada lobby', avatar: 'owl', accountId
  });
  assert.equal(lobbyEdit.ok, true, lobbyEdit.error || 'la edición desde el lobby (sin mesa) debe funcionar');
  assert.equal(lobbyEdit.profile.name, 'Ana editada lobby');
  assertNoPasswordHash(lobbyEdit, 'profile_update desde el lobby');

  // Confirma la persistencia real en el servidor con un socket totalmente
  // nuevo (nada de estado compartido salvo usuario+contraseña).
  const verifySocket = connectClient();
  await waitFor(verifySocket, 'connect');
  const reLogin = await emitAck(verifySocket, 'account_login', { username, password });
  assert.equal(reLogin.ok, true, reLogin.error);
  assert.equal(reLogin.profile.name, 'Ana editada lobby', 'el nombre editado desde el lobby persistió en el servidor');
  assert.equal(reLogin.profile.avatar, 'owl', 'el avatar editado desde el lobby persistió en el servidor');

  // === 3) featuredAchievements se guarda (antes se ignoraba silenciosamente) ===
  // Desbloqueamos "Primera victoria" jugando rondas de coinflip hasta ganar
  // una (50/50 por ronda; unos pocos intentos bastan para no depender del azar).
  let unlocked = null;
  for (let attempt = 0; attempt < 25 && !unlocked; attempt++) {
    assert.equal((await emitAck(owner, 'quick_bet', { amount: 10, choice: 'heads' })).ok, true);
    assert.equal((await emitAck(owner, 'quick_resolve')).ok, true);
    await waitState(owner, s => s.phase === 'results', 'ronda resuelta para desbloquear logros');
    const afterRound = await emitAck(verifySocket, 'account_login', { username, password });
    unlocked = (afterRound.profile.allAchievements || []).find(item => item.unlocked) || null;
  }
  assert.ok(unlocked, 'se desbloqueó al menos un logro tras varios intentos (Primera victoria en coinflip)');
  const featuredUpdate = await emitAck(lobbySocket, 'profile_update', {
    name: 'Ana editada lobby', avatar: 'owl', featuredAchievements: [unlocked.id], accountId
  });
  assert.equal(featuredUpdate.ok, true, featuredUpdate.error);
  assert.deepEqual(featuredUpdate.profile.featuredAchievements, [unlocked.id], 'la vitrina de logros se guarda en la respuesta');
  const reCheck = await emitAck(verifySocket, 'account_login', { username, password });
  assert.deepEqual(reCheck.profile.featuredAchievements, [unlocked.id], 'la vitrina de logros persiste en el servidor tras re-loguear');

  // === 4) Sin mesa y sin accountId válido: "Perfil no disponible." ===
  const strangerSocket = connectClient();
  await waitFor(strangerSocket, 'connect');
  const noContext = await emitAck(strangerSocket, 'profile_update', { name: 'Nadie' });
  assert.equal(noContext.ok, false, 'sin mesa y sin accountId no hay perfil que editar');
  assert.match(noContext.error, /Perfil no disponible/);

  const fakeAccountId = await emitAck(strangerSocket, 'profile_update', { name: 'Nadie', accountId: 'id-inventado-que-no-existe' });
  assert.equal(fakeAccountId.ok, false, 'un accountId inventado no permite editar nada');

  // Un dispositivo anónimo (sin cuenta vinculada) tampoco se puede "editar por
  // accountId" usando su propio id de dispositivo como si fuera una cuenta.
  const anonToken = `anon-${Date.now()}`;
  const anonSocket = connectClient();
  await waitFor(anonSocket, 'connect');
  await emitAck(anonSocket, 'create_room', { name: 'Anónimo', roomName: 'Mesa anónima', game: 'coinflip', token: anonToken, avatar: 'fox', tos: TOS_VERSION });
  const anonEditAttempt = await emitAck(strangerSocket, 'profile_update', { name: 'Suplantado', accountId: anonToken });
  assert.equal(anonEditAttempt.ok, false, 'un perfil anónimo (sin username) no se puede editar vía accountId desde otro socket');

  // === 5) account_profile: refresca una cuenta vinculada, pero no expone perfiles anónimos ===
  const refreshed = await emitAck(verifySocket, 'account_profile', { accountId });
  assert.equal(refreshed.ok, true, refreshed.error);
  assert.equal(refreshed.profile.username, username);
  assertNoPasswordHash(refreshed, 'account_profile');

  const anonLeak = await emitAck(verifySocket, 'account_profile', { accountId: anonToken });
  assert.equal(anonLeak.ok, false, 'account_profile no expone perfiles anónimos sin cuenta vinculada');

  const unknownId = await emitAck(verifySocket, 'account_profile', { accountId: 'no-existe-para-nada' });
  assert.equal(unknownId.ok, false, 'account_profile responde error ante un id inexistente');

  // === 6) Editar DESDE una mesa también sigue persistiendo (camino original) ===
  const tableEdit = await emitAck(owner, 'profile_update', { name: 'Ana de la mesa', avatar: 'panda' });
  assert.equal(tableEdit.ok, true, tableEdit.error);
  await waitState(owner, s => s.viewerProfile?.name === 'Ana de la mesa', 'el nombre editado desde la mesa se refleja en room_state');
  const reLoginAfterTableEdit = await emitAck(verifySocket, 'account_login', { username, password });
  assert.equal(reLoginAfterTableEdit.profile.name, 'Ana de la mesa', 'la edición hecha DESDE la mesa también persistió en el perfil de la cuenta (es el mismo perfil)');

  server.kill('SIGTERM');
  assert.equal(await waitExit(server), 0, 'apagado limpio');

  console.log('✅ account-session-smoke: login/perfil público sin passwordHash, edición desde el lobby y desde la mesa, vitrina de logros y account_profile seguro OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ account-session-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1500));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
