'use strict';

// Auditoría de nombres de personas — cubre las reglas del servidor:
//
//  1) Nombres ofensivos rechazados en TODOS los puntos donde una persona elige
//     cómo la verán los demás: crear mesa, entrar a mesa, tribuna, renombrar
//     el perfil, crear cuenta y apodo del chat del casino. La lista es la
//     misma que censura el chat, y también se revisa tras quitar separadores
//     ("gil_ipollas") para no dejar pasar obfuscaciones triviales. Un nombre
//     como "Computadora" (contiene "puta" como subcadena, sin límites de
//     palabra) NO se rechaza: la verificación es por palabras completas.
//  2) UNICIDAD GLOBAL: un nombre le pertenece a un solo perfil en todo el
//     casino, en cualquier mesa (findProfileByName del ProfileStore). Dentro
//     de una mesa se aplica además el chequeo local (jugadores, tribuna y
//     bots sentados ahí) con su propio mensaje. Mayúsculas y espacios extra
//     no distinguen. Renombrarse al PROPIO nombre sigue permitido, y borrar
//     el perfil libera su nombre (verificado directo contra el store).

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { io } = require('socket.io-client');
const { TOS_VERSION } = require('../lib/terms');
const { ProfileStore } = require('../lib/profile-store');

const port = 5600 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-name-guard-${process.pid}.json`);
const unitPath = path.join(os.tmpdir(), `montecristo-name-guard-unit-${process.pid}.json`);
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
function connectClient() {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.latest = null;
  socket.on('room_state', state => { socket.latest = state; });
  clients.push(socket);
  return socket;
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 6000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}
async function until(fn, description, timeout = 8000, step = 60) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = fn(); if (value) return value; } catch (_) { /* reintento */ }
    await new Promise(resolve => setTimeout(resolve, step));
  }
  throw new Error(`Tiempo agotado esperando: ${description}`);
}

// Registro global directamente contra el ProfileStore de archivo (la regla
// vive en la clase base, así que el backend de Postgres hereda lo mismo —
// ver tests/profile-store-pg-smoke.js).
async function testStoreRegistry() {
  const store = new ProfileStore(unitPath);
  store.getOrCreate('unit-a', 'Rosa  Salvatierra', 'fox');
  store.getOrCreate('unit-b', 'Mirta', 'owl');
  assert.equal(store.findProfileByName('rosa salvatierra')?.id, 'unit-a', 'findProfileByName compara normalizado (mayúsculas y espacios extra)');
  assert.equal(store.findProfileByName('  ROSA   salvatierra ')?.id, 'unit-a', 'los espacios de sobra no esquivan el registro');
  assert.equal(store.findProfileByName('Rosa Salvatierra', 'unit-a'), null, 'exceptId excluye al propio perfil (renombrarse a su nombre)');
  assert.equal(store.findProfileByName('mirta')?.id, 'unit-b', 'encuentra a la dueña exacta del nombre');
  assert.equal(store.findProfileByName('Mirtas'), null, 'un nombre parecido pero distinto está libre');
  // Borrar el perfil libera su nombre: el registro es el estado vivo, no un
  // índice aparte que quede huérfano.
  store.deleteProfile('unit-a');
  assert.equal(store.findProfileByName('rosa salvatierra'), null, 'borrar el perfil libera su nombre en el registro global');
  store.saveNow();
}

async function main() {
  await testStoreRegistry();
  server = startServer();
  await waitForServer();
  const suffix = `${Date.now()}`.slice(-6);

  // ---------- 1) Nombres ofensivos rechazados en todos los puntos de entrada ----------
  const host = connectClient();
  for (const [event, payload] of [
    ['create_room', { name: 'Pendejo', game: 'roulette', token: `profane-a-${suffix}` }],
    ['create_room', { name: 'Gil_ipollas', game: 'roulette', token: `profane-b-${suffix}` }], // separadores intercalados
    ['create_room', { name: 'La mierda', game: 'coinflip', token: `profane-c-${suffix}` }],   // con espacios de por medio
    ['account_signup', { token: `signup-${suffix}`, name: 'Cabrona', username: `bad${suffix}`, password: 'clave-mala' }]
  ]) {
    const response = await emitAck(host, event, { ...payload, tos: TOS_VERSION });
    assert.equal(response.ok, false, `${event} debe rechazar el nombre ofensivo "${payload.name}"`);
    assert.match(response.error, /ofensiv/i, `el error explica el motivo (${event}): ${response.error}`);
  }

  // Sin falsos positivos: subcadena sin límites de palabra no es grosería.
  const clean = await emitAck(host, 'create_room', { name: 'Computadora', roomName: 'Mesa limpia', game: 'roulette', token: `host-${suffix}`, tos: TOS_VERSION });
  assert.equal(clean.ok, true, `nombre inocente aceptado: ${clean.error}`);
  const code = clean.code;

  // ---------- 2) Sin nombres duplicados en una misma mesa ----------
  const guest = connectClient();

  // Mayúsculas/minúsculas no distinguen: "computadora" ya está sentado.
  const dupJoin = await emitAck(guest, 'join_room', { name: 'computadora', code, token: `guest-${suffix}`, tos: TOS_VERSION });
  assert.equal(dupJoin.ok, false, 'join_room rechaza el nombre de otra persona en la mesa');
  assert.match(dupJoin.error, /ya está en uso/i, `el error explica el duplicado: ${dupJoin.error}`);

  // Espacios extra tampoco: " Computadora " sigue siendo el mismo nombre.
  const dupJoinSpaces = await emitAck(guest, 'join_room', { name: ' Computadora ', code, token: `guest-${suffix}`, tos: TOS_VERSION });
  assert.equal(dupJoinSpaces.ok, false, 'join_room ignora espacios extra al comparar nombres');

  const okJoin = await emitAck(guest, 'join_room', { name: 'Distinta', code, token: `guest-${suffix}`, tos: TOS_VERSION });
  assert.equal(okJoin.ok, true, `un nombre libre sí entra a la mesa: ${okJoin.error}`);

  // Renombrar el perfil al nombre de otra persona sentada: rechazado.
  const dupRename = await emitAck(guest, 'profile_update', { name: 'COMPUTADORA', avatar: 'owl' });
  assert.equal(dupRename.ok, false, 'profile_update no permite robar el nombre de otra persona en la mesa');
  assert.match(dupRename.error, /ya está en uso/i, `el error explica el duplicado (rename): ${dupRename.error}`);

  // Renombrarse a su PROPIO nombre (o a uno libre) sigue funcionando.
  const selfRename = await emitAck(host, 'profile_update', { name: 'Computadora', avatar: 'fox' });
  assert.equal(selfRename.ok, true, `renombrarse a tu propio nombre sigue permitido: ${selfRename.error}`);

  // El apodo de la tribuna tampoco choca con jugadores ni con otros espectadores.
  const watcher = connectClient();
  const dupSpectate = await emitAck(watcher, 'spectate_room', { name: 'COMPUTADORA', code, token: `watch-${suffix}`, tos: TOS_VERSION });
  assert.equal(dupSpectate.ok, false, 'spectate_room rechaza el nombre de un jugador sentado');
  const okSpectate = await emitAck(watcher, 'spectate_room', { name: 'Tribuna', code, token: `watch-${suffix}`, tos: TOS_VERSION });
  assert.equal(okSpectate.ok, true, `un espectador con nombre libre sí entra: ${okSpectate.error}`);
  const watcher2 = connectClient();
  const dupSpectate2 = await emitAck(watcher2, 'spectate_room', { name: 'tribuna', code, token: `watch2-${suffix}`, tos: TOS_VERSION });
  assert.equal(dupSpectate2.ok, false, 'spectate_room rechaza el nombre de otro espectador conectado');

  // El nombre de un BOT sentado tampoco se puede tomar.
  const botAdd = await emitAck(host, 'bot_add', { difficulty: 'normal', style: 'balanced' });
  assert.equal(botAdd.ok, true, `bot_add funciona: ${botAdd.error}`);
  const botName = await until(() => (host.latest?.players || []).find(p => p.isBot)?.name, 'el bot aparece en la mesa');
  const late = connectClient();
  const dupBotName = await emitAck(late, 'join_room', { name: botName, code, token: `late-${suffix}`, tos: TOS_VERSION });
  assert.equal(dupBotName.ok, false, `join_room rechaza el nombre del bot sentado (${botName})`);

  // ---------- 3) Sin apodos duplicados en el chat del casino ----------
  const chatA = connectClient();
  const chatB = connectClient();
  assert.equal((await emitAck(chatA, 'lobby_chat_join', { token: `chatA-${suffix}`, name: 'Gemela', tos: TOS_VERSION })).ok, true, 'primer apodo entra al chat');
  const dupNick = await emitAck(chatB, 'lobby_chat_join', { token: `chatB-${suffix}`, name: 'GEMELA', tos: TOS_VERSION });
  assert.equal(dupNick.ok, false, 'el chat rechaza un apodo idéntico (mayúsculas aparte)');
  // La unicidad global del casino cubre el chat: el mensaje es el del registro global.
  assert.match(dupNick.error, /casino/i, `el error explica el duplicado (chat): ${dupNick.error}`);
  const okNick = await emitAck(chatB, 'lobby_chat_join', { token: `chatB-${suffix}`, name: 'Solfiera', tos: TOS_VERSION });
  assert.equal(okNick.ok, true, `un apodo libre sí entra al chat: ${okNick.error}`);
  // La MISMA persona (mismo dispositivo) puede re-entrar con su propio apodo.
  const selfNick = await emitAck(chatA, 'lobby_chat_join', { token: `chatA-${suffix}`, name: 'Gemela', tos: TOS_VERSION });
  assert.equal(selfNick.ok, true, `re-entrar con tu propio apodo está permitido: ${selfNick.error}`);
  // Y el chat sigue censurando apodos ofensivos.
  const badNick = await emitAck(chatB, 'lobby_chat_join', { token: `chatB-${suffix}`, name: 'Mierda', tos: TOS_VERSION });
  assert.equal(badNick.ok, false, 'el chat rechaza apodos ofensivos');
  assert.match(badNick.error, /ofensiv/i, `el error explica el motivo (chat): ${badNick.error}`);

  // ---------- 4) Unicidad GLOBAL: un nombre ↔ un perfil, en cualquier mesa ----------
  const glob1 = connectClient();
  const roomA = await emitAck(glob1, 'create_room', { name: 'Única en el casino', roomName: 'Mesa lejana', game: 'dice', token: `glob1-${suffix}`, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(roomA.ok, true, `crear la mesa lejana: ${roomA.error}`);

  const glob2 = connectClient();
  // Otro dispositivo, OTRA mesa, mismo nombre (mayúsculas aparte): rechazado.
  const dupGlobalCreate = await emitAck(glob2, 'create_room', { name: 'ÚNICA EN EL CASINO', roomName: 'Mesa propia', game: 'coinflip', token: `glob2-${suffix}`, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(dupGlobalCreate.ok, false, 'crear una mesa con el nombre de un perfil de OTRA mesa se rechaza (unicidad global)');
  assert.match(dupGlobalCreate.error, /casino/i, `el error explica la unicidad global: ${dupGlobalCreate.error}`);

  // Con un nombre libre, en otra mesa distinta: sí entra.
  const okGlobalCreate = await emitAck(glob2, 'create_room', { name: 'Diferente en el casino', roomName: 'Mesa propia', game: 'coinflip', token: `glob2-${suffix}`, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(okGlobalCreate.ok, true, `un nombre libre funciona en otra mesa: ${okGlobalCreate.error}`);

  // Renombrar el propio perfil al nombre globalmente tomado: rechazado.
  const dupGlobalRename = await emitAck(glob2, 'profile_update', { name: 'única en el casino', avatar: 'owl' });
  assert.equal(dupGlobalRename.ok, false, 'profile_update no permite tomar un nombre usado por un perfil de otra mesa');
  assert.match(dupGlobalRename.error, /casino/i, `el error explica la unicidad global (rename): ${dupGlobalRename.error}`);

  // La tribuna de una mesa donde NO está la dueña del nombre: rechazado igual.
  const glob3 = connectClient();
  const dupGlobalSpectate = await emitAck(glob3, 'spectate_room', { name: 'ÚNICA EN EL CASINO', code: okGlobalCreate.code, token: `glob3-${suffix}`, avatar: 'tiger', tos: TOS_VERSION });
  assert.equal(dupGlobalSpectate.ok, false, 'spectate_room tampoco admite un nombre globalmente tomado');

  // ---------- 5) La mesa sigue funcionando con nombres válidos ----------
  const fresh = await emitAck(late, 'join_room', { name: 'Recién llegada', code, token: `late-${suffix}`, tos: TOS_VERSION });
  assert.equal(fresh.ok, true, `la validación no estropea el flujo normal: ${fresh.error}`);

  console.log('✅ name-guard-smoke: nombres ofensivos rechazados en todos los puntos y unicidad global (mesa, tribuna, bots y casino entero) OK');
}

main()
  .catch(error => { console.error('❌ name-guard-smoke:', error.stack || error.message); process.exitCode = 1; })
  .finally(async () => {
    for (const client of clients) { try { client.disconnect(); } catch (_) { /* noop */ } }
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => { server.on('exit', resolve); setTimeout(resolve, 1500); });
    }
    try { require('node:fs').unlinkSync(profilePath); } catch (_) { /* noop */ }
    try { require('node:fs').unlinkSync(unitPath); } catch (_) { /* noop */ }
  });
