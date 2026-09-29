'use strict';

// Fase 8.4 — Smoke de seguro y split en blackjack, con mazos deterministas
// (TEST_BLACKJACK_DECK): seguro que paga 2:1 contra blackjack de la casa,
// split con dos manos independientes, dobles por mano y validaciones.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const profilePath = path.join(os.tmpdir(), `montecristo-bjvar-${process.pid}.json`);
const clients = [];
let server;

const FILLER = Array.from({ length: 22 }, () => '2♣');
// Mazo A: la casa tiene blackjack natural (A + K) y el jugador recibe un par de ochos.
const DECK_NATURAL = ['A♠', 'K♠', '8♥', '8♦', '3♣', '4♣', 'K♦', '5♦', ...FILLER];
// Mazo B: la casa muestra 9 y se pasa; el jugador divide dos dieces y gana ambas manos.
const DECK_SPLIT_WIN = ['9♣', '7♠', '10♥', '10♦', '9♥', '8♣', '6♦', ...FILLER];

function startServer(port, deck) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath,
      AUTO_BOTS: 'off', LOG_JSON: 'off', TEST_BLACKJACK_DECK: JSON.stringify(deck)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.log = '';
  child.stdout.on('data', chunk => { child.log += chunk; });
  child.stderr.on('data', chunk => { child.log += chunk; });
  return child;
}
function connectClient(port) {
  const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
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
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Tiempo agotado esperando estado: ${label}`);
}
function me(state, token) { return state.players.find(p => p.id === token); }

(async () => {
  fs.rmSync(profilePath, { force: true });

  // ================= Servidor A: la casa tiene blackjack natural =================
  const portA = 5100 + Math.floor(Math.random() * 200);
  server = startServer(portA, DECK_NATURAL);
  await new Promise(r => setTimeout(r, 900));
  const token = `bj-${Date.now()}`;
  const socket = connectClient(portA);
  await waitFor(socket, 'connect');
  const created = await emitAck(socket, 'create_room', { name: 'Divisora', roomName: 'Mesa 21', game: 'blackjack', token, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);

  // ---- Ronda 1: seguro + split contra blackjack de la casa ----
  assert.equal((await emitAck(socket, 'blackjack_bet', { amount: 50 })).ok, true);
  assert.equal((await emitAck(socket, 'blackjack_start')).ok, true);
  let state = await waitState(socket, s => s.phase === 'playing', 'ronda 1 en curso');
  assert.equal(state.dealerHand[0], 'A♠', 'la casa muestra un as');
  assert.equal(state.dealerHand[1], 'XX', 'la carta oculta viaja boca abajo');
  assert.ok(state.messages.some(m => m.text.includes('seguro')), 'se anuncia la ventana de seguro');
  assert.equal((await emitAck(socket, 'blackjack_insurance')).ok, true, 'seguro aceptado');
  assert.equal((await emitAck(socket, 'blackjack_insurance')).ok, false, 'no se puede asegurar dos veces');
  state = await waitState(socket, s => me(s, token)?.insurance === 25, 'seguro registrado (25)');
  const splitAck = await emitAck(socket, 'blackjack_split');
  assert.equal(splitAck.ok, true, `split aceptado: ${splitAck.error || ''}`);
  state = await waitState(socket, s => me(s, token)?.split, 'split visible');
  const seat = me(state, token);
  assert.equal(seat.hand.length, 2, 'mano principal con 2 cartas');
  assert.equal(seat.split.hand.length, 2, 'mano dividida con 2 cartas');
  assert.equal(seat.split.active, 'main', 'se juega primero la mano principal');
  assert.equal((await emitAck(socket, 'blackjack_split')).ok, false, 'solo un split por ronda');
  assert.equal((await emitAck(socket, 'blackjack_stand')).ok, true, 'plantarse en la mano 1');
  state = await waitState(socket, s => me(s, token)?.split?.active === 'split', 'turno de la mano 2');
  assert.equal((await emitAck(socket, 'blackjack_stand')).ok, true, 'plantarse en la mano 2');
  state = await waitState(socket, s => s.phase === 'results', 'resultados ronda 1');
  assert.ok(state.messages.some(m => m.text.includes('blackjack natural')), 'la casa revela blackjack natural');
  let result = state.results.find(r => r.id === token);
  assert.equal(result.amount, -50, 'pierde 100 en manos pero el seguro paga 2:1 (neto −50)');
  assert.equal(state.viewerProfile.chips, 1050, 'saldo 1100 − 50 tras la ronda 1');

  // ---- Ronda 2: sin seguro ni split después de pedir carta ----
  assert.equal((await emitAck(socket, 'blackjack_new')).ok, true);
  await waitState(socket, s => s.phase === 'betting', 'apuestas ronda 2');
  assert.equal((await emitAck(socket, 'blackjack_bet', { amount: 50 })).ok, true);
  assert.equal((await emitAck(socket, 'blackjack_start')).ok, true);
  await waitState(socket, s => s.phase === 'playing' && s.handNumber === 2, 'ronda 2 en curso');
  assert.equal((await emitAck(socket, 'blackjack_hit')).ok, true, 'pide carta (16 + 3 = 19)');
  state = await waitState(socket, s => me(s, token)?.hand.length === 3, 'tercera carta visible');
  assert.equal((await emitAck(socket, 'blackjack_insurance')).ok, false, 'sin seguro después de la primera jugada');
  assert.equal((await emitAck(socket, 'blackjack_split')).ok, false, 'sin split con tres cartas');
  assert.equal((await emitAck(socket, 'blackjack_stand')).ok, true);
  state = await waitState(socket, s => s.phase === 'results' && s.handNumber === 2, 'resultados ronda 2');
  assert.equal(state.viewerProfile.chips, 1000, 'saldo 1050 − 50 (sin seguro, la casa gana)');

  // ---- Ronda 3: doblar en cada mano del split ----
  assert.equal((await emitAck(socket, 'blackjack_new')).ok, true);
  await waitState(socket, s => s.phase === 'betting', 'apuestas ronda 3');
  assert.equal((await emitAck(socket, 'blackjack_bet', { amount: 50 })).ok, true);
  assert.equal((await emitAck(socket, 'blackjack_start')).ok, true);
  await waitState(socket, s => s.phase === 'playing' && s.handNumber === 3, 'ronda 3 en curso');
  assert.equal((await emitAck(socket, 'blackjack_split')).ok, true, 'split ronda 3');
  assert.equal((await emitAck(socket, 'blackjack_double')).ok, true, 'doblar mano 1 (11 → 21)');
  state = await waitState(socket, s => me(s, token)?.split?.active === 'split', 'pasa a la mano 2');
  assert.equal(me(state, token).split.mainStatus, 'stand', 'mano 1 cerrada tras doblar');
  assert.equal((await emitAck(socket, 'blackjack_double')).ok, true, 'doblar mano 2 (12 → 17)');
  state = await waitState(socket, s => s.phase === 'results' && s.handNumber === 3, 'resultados ronda 3');
  result = state.results.find(r => r.id === token);
  // Mano 1 doblada llega a 21 y empata con la casa; la mano 2 doblada pierde (−100).
  assert.equal(result.amount, -100, 'empate en la mano doblada a 21 y pérdida en la otra (−100)');
  assert.equal(result.label, 'Empate / Pierde', 'etiqueta por mano del split');
  // 900 + retos completados en esta ronda (3 rondas jugadas +75, 250 apostadas +75).
  assert.equal(state.viewerProfile.chips, 1050, 'saldo 1000 − 100 + 150 de retos');
  socket.disconnect();
  server.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 300));

  // ================= Servidor B: split ganador y seguro rechazado sin as =================
  const portB = 5350 + Math.floor(Math.random() * 200);
  server = startServer(portB, DECK_SPLIT_WIN);
  await new Promise(r => setTimeout(r, 900));
  const token2 = `bj2-${Date.now()}`;
  const socket2 = connectClient(portB);
  await waitFor(socket2, 'connect');
  assert.equal((await emitAck(socket2, 'create_room', { name: 'Doblona', roomName: 'Mesa 21B', game: 'blackjack', token: token2, avatar: 'fox', tos: TOS_VERSION })).ok, true);
  assert.equal((await emitAck(socket2, 'blackjack_bet', { amount: 50 })).ok, true);
  assert.equal((await emitAck(socket2, 'blackjack_start')).ok, true);
  let state2 = await waitState(socket2, s => s.phase === 'playing', 'ronda B en curso');
  assert.equal(state2.dealerHand[0], '9♣', 'la casa muestra un 9');
  assert.equal((await emitAck(socket2, 'blackjack_insurance')).ok, false, 'sin seguro cuando la casa no muestra as');
  assert.equal((await emitAck(socket2, 'blackjack_split')).ok, true, 'split de dos dieces');
  assert.equal((await emitAck(socket2, 'blackjack_stand')).ok, true, 'mano 1 se planta con 19');
  await waitState(socket2, s => me(s, token2)?.split?.active === 'split', 'turno mano 2');
  assert.equal((await emitAck(socket2, 'blackjack_stand')).ok, true, 'mano 2 se planta con 18');
  state2 = await waitState(socket2, s => s.phase === 'results', 'resultados ronda B');
  const result2 = state2.results.find(r => r.id === token2);
  const bonus = result2.specialBonus || 0;
  assert.equal(result2.amount - bonus, 100, 'la casa se pasa: ambas manos ganan (+100 antes de bonos)');
  assert.equal(result2.label, 'Gana ×2', 'etiqueta combinada de las dos manos');
  // 1200 + bono especial (si lo hubo) + recompensas de logros/retos disparadas por la victoria.
  const rewards = (state2.viewerProfile.transactions || [])
    .filter(tx => /^(Logro|Reto):/.test(tx.reason))
    .reduce((sum, tx) => sum + tx.amount, 0);
  assert.ok(rewards >= 100, 'la primera victoria dispara logro y reto (≥ +100)');
  assert.equal(state2.viewerProfile.chips, 1200 + bonus + rewards, 'saldo 1100 + 100 + bonos y recompensas');

  console.log('✅ blackjack-variants-smoke: seguro 2:1, split, dobles por mano, validaciones y pagos OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ blackjack-variants-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1500));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
