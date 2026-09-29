'use strict';

// Fase 9 — QA adversarial: un cliente malicioso o torpe no puede romper la mesa.
// · Entradas inválidas (montos NaN/negativos/infinitos, juegos inventados, códigos falsos).
// · Nombres y mensajes gigantes quedan recortados y sin < > (defensa doble contra XSS).
// · Acciones fuera de turno o de otro juego se rechazan con error amable.
// · El chat tiene límite de frecuencia: nadie puede inundar la sala.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const port = 6400 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-qa-${process.pid}.json`);
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
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error('Tiempo agotado esperando estado.');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.log = '';
  server.stdout.on('data', chunk => { server.log += chunk; });
  server.stderr.on('data', chunk => { server.log += chunk; });
  await sleep(900);

  const evil = connectClient();

  // 1) Crear sala: un juego inventado degrada al catálogo válido (nunca una mesa rota),
  //    sin términos no se entra, y el nombre-ataque queda saneado.
  const probe = connectClient();
  const weird = await emitAck(probe, 'create_room', { name: 'Curiosa', game: 'hackjack', token: 'qa-probe', tos: TOS_VERSION });
  assert.equal(weird.ok, true, 'El juego inventado no tumba la creación');
  const weirdState = await waitState(probe, s => Boolean(s.game));
  assert.equal(weirdState.game, 'poker', 'El juego desconocido cae al catálogo válido (póker)');
  assert.equal((await emitAck(probe, 'leave_room')).ok, true);
  assert.equal((await emitAck(evil, 'create_room', { name: 'Mal', game: 'roulette', token: 'qa-evil' })).ok, false, 'Sin T&C no se entra');
  const longName = '<script>alert(1)</script>'.repeat(20);
  const created = await emitAck(evil, 'create_room', { name: longName, roomName: `<b>${'x'.repeat(200)}</b>`, game: 'roulette', token: 'qa-evil', avatar: 'no-existe', tos: TOS_VERSION });
  assert.equal(created.ok, true, `create_room válido falló: ${created.error}`);
  const state = await waitState(evil, s => s.players.length === 1);
  const me = state.players[0];
  assert.ok(me.name.length <= 18 && !/[<>]/.test(me.name), `El nombre queda recortado y sin <> (llegó "${me.name}")`);
  assert.ok(state.name.length <= 28 && !/[<>]/.test(state.name), 'El nombre de la sala queda saneado');

  // 2) Unirse a salas que no existen.
  const ghost = connectClient();
  assert.equal((await emitAck(ghost, 'join_room', { name: 'Fantasma', code: 'ZZZZZ', token: 'qa-ghost', tos: TOS_VERSION })).ok, false, 'Código inexistente rechazado');
  assert.equal((await emitAck(ghost, 'join_room', { name: 'Fantasma', code: '../../etc', token: 'qa-ghost', tos: TOS_VERSION })).ok, false, 'Código malicioso rechazado');

  // 3) Apuestas imposibles: nunca cambian las fichas.
  const chipsBefore = me.chips;
  for (const amount of [NaN, 'abc', -50, 0, 5, Infinity, 1e18, chipsBefore + 1]) {
    const res = await emitAck(evil, 'quick_bet', { amount, choice: 'red' });
    assert.equal(res.ok, false, `Apuesta inválida aceptada: ${String(amount)}`);
  }
  assert.equal((await emitAck(evil, 'quick_bet', { amount: 50, choice: 'purple' })).ok, false, 'Elección inexistente rechazada');
  assert.equal(evil.latest.players[0].chips, chipsBefore, 'Las fichas no se movieron con apuestas inválidas');

  // 4) Acciones de otro juego y dobles apuestas.
  assert.equal((await emitAck(evil, 'blackjack_hit')).ok, false, 'No se puede pedir carta en la ruleta');
  assert.equal((await emitAck(evil, 'poker_action', { action: 'raise', amount: 999 })).ok, false, 'No hay póker en la ruleta');
  assert.equal((await emitAck(evil, 'quick_bet', { amount: 50.9, choice: 'red' })).ok, true, 'Apuesta válida con decimales se acepta (se redondea hacia abajo)');
  await waitState(evil, s => s.players[0].bet === 50);
  assert.equal(evil.latest.players[0].chips, chipsBefore - 50, 'Se descontaron exactamente 50 fichas');
  assert.equal((await emitAck(evil, 'quick_bet', { amount: 50, choice: 'red' })).ok, false, 'La doble apuesta se rechaza');

  // 5) Solo quien es anfitrión puede lanzar y reabrir rondas.
  const beto = connectClient();
  assert.equal((await emitAck(beto, 'join_room', { name: 'BetoQA', code: created.code, token: 'qa-beto', tos: TOS_VERSION })).ok, true);
  assert.equal((await emitAck(beto, 'quick_resolve')).ok, false, 'Un invitado no puede lanzar la ronda');

  // 6) Chat: mensajes gigantes recortados y límite de frecuencia activo.
  assert.equal((await emitAck(evil, 'chat', { text: `hola <img onerror=alert(1)> ${'A'.repeat(5000)}` })).ok, true);
  const chatState = await waitState(evil, s => s.messages.some(m => !m.system && m.text.startsWith('hola')));
  const msg = chatState.messages.find(m => !m.system && m.text.startsWith('hola'));
  assert.ok(msg.text.length <= 180 && !/[<>]/.test(msg.text), 'El mensaje queda recortado a 180 y sin <>');

  let rejected = 0;
  for (let i = 0; i < 12; i++) {
    const res = await emitAck(evil, 'chat', { text: `spam ${i}` });
    if (!res.ok) rejected += 1;
  }
  assert.ok(rejected >= 5, `El límite de frecuencia frenó la inundación (rechazados: ${rejected})`);
  assert.equal((await emitAck(evil, 'reaction', { emoji: '💩' })).ok, false, 'Reacción fuera del catálogo rechazada');
  assert.ok(evil.latest.messages.length <= 40, 'El historial del chat queda acotado a 40 mensajes');

  // 7) El avatar inventado terminó siendo uno válido del catálogo.
  assert.ok(typeof evil.latest.players[0].avatar === 'string' && evil.latest.players[0].avatar !== 'no-existe', 'Avatar inválido reemplazado por uno del catálogo');

  console.log('✅ qa-hardening-smoke: entradas inválidas, saneado de textos, permisos de anfitrión y antiflood de chat OK');
}

main()
  .then(() => cleanup(0))
  .catch(error => { console.error('❌ qa-hardening-smoke:', error.message); if (server?.log) console.error(server.log.slice(-600)); cleanup(1); });

function cleanup(code) {
  for (const socket of clients) { try { socket.disconnect(); } catch (_) { /* noop */ } }
  try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  if (server) { try { server.kill('SIGKILL'); } catch (_) { /* noop */ } }
  setTimeout(() => process.exit(code), 400);
}
