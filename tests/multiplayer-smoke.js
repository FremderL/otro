'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const { TOS_VERSION } = require('../lib/terms');

const port = 3200 + Math.floor(Math.random() * 500);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-smoke-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', RECONNECT_GRACE_MS: '400' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

const clients = [];
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
function waitFor(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`Tiempo agotado esperando ${event}`)); }, timeout);
    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer); socket.off(event, onEvent); resolve(payload);
    }
    socket.on(event, onEvent);
  });
}
async function waitState(socket, predicate, timeout = 5000) {
  if (socket.latest && predicate(socket.latest)) return socket.latest;
  return waitFor(socket, 'room_state', predicate, timeout);
}
async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`El servidor terminó antes de iniciar.\n${serverLog}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (_) { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`El servidor no abrió el puerto.\n${serverLog}`);
}
async function createRoom(socket, game, token, name = 'Anfitrión') {
  socket.latest = null;
  const response = await emitAck(socket, 'create_room', { name, roomName: `Prueba ${game}`, game, token, avatar: 'robot', tos: TOS_VERSION });
  assert.equal(response.ok, true, response.error);
  const state = await waitState(socket, room => room.code === response.code);
  assert.equal(state.game, game);
  assert.equal(state.viewerProfile.chips, 1100, 'saldo inicial + bono diario');
  return state;
}
async function joinRoom(socket, code, token, name = 'Invitada') {
  socket.latest = null;
  const response = await emitAck(socket, 'join_room', { name, code, token, avatar: 'panda' , tos: TOS_VERSION });
  assert.equal(response.ok, true, response.error);
  return waitState(socket, room => room.code === code && room.players.some(player => player.id === token));
}
function progressionRewards(before, after) {
  const beforeAchievements = new Set((before.allAchievements || []).filter(item => item.unlocked).map(item => item.id));
  const beforeChallenges = new Set((before.challenges || []).filter(item => item.completed).map(item => item.id));
  const achievementRewards = (after.allAchievements || []).filter(item => item.unlocked && !beforeAchievements.has(item.id)).reduce((sum, item) => sum + item.reward, 0);
  const challengeRewards = (after.challenges || []).filter(item => item.completed && !beforeChallenges.has(item.id)).reduce((sum, item) => sum + item.reward, 0);
  return achievementRewards + challengeRewards;
}
async function testRoulette() {
  const host = connectClient(), guest = connectClient();
  await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);
  const suffix = `${Date.now()}-${Math.random()}`;
  let room = await createRoom(host, 'roulette', `host-${suffix}`);
  await joinRoom(guest, room.code, `guest-${suffix}`);
  room = await waitState(host, state => state.players.length === 2);
  const hostProfileBefore = structuredClone(room.viewerProfile);
  const guestProfileBefore = structuredClone(guest.latest.viewerProfile);

  let response = await emitAck(guest, 'quick_resolve');
  assert.equal(response.ok, false, 'un invitado no debe resolver');
  // Fase 5: cobertura de extremo a extremo de docenas y columnas
  assert.equal((await emitAck(host, 'quick_bet', { amount: 10, choice: 'd2' })).ok, true);
  assert.equal((await emitAck(guest, 'quick_bet', { amount: 10, choice: 'c1' })).ok, true);
  response = await emitAck(host, 'quick_resolve');
  assert.equal(response.ok, true, response.error);
  const resolvedHost = await waitState(host, state => state.phase === 'results' && state.handNumber === 1, 7000);
  const resolvedGuest = await waitState(guest, state => state.phase === 'results' && state.handNumber === 1, 7000);
  assert.ok(Number.isInteger(resolvedHost.quickResult.value) && resolvedHost.quickResult.value >= 0 && resolvedHost.quickResult.value <= 36);
  assert.equal(resolvedHost.results.length, 2);
  const hostResult = resolvedHost.results.find(item => item.id === `host-${suffix}`);
  const guestResult = resolvedGuest.results.find(item => item.id === `guest-${suffix}`);
  const winning = resolvedHost.quickResult.value;
  // El neto se compara SIN el bono del evento especial aleatorio de la mesa (si lo hubo),
  // porque ese multiplicador sorpresa se suma al `amount` de quien gana.
  assert.equal(hostResult.amount - (hostResult.specialBonus || 0), winning >= 13 && winning <= 24 ? 20 : -10, 'la docena 13–24 paga x3');
  assert.equal(guestResult.amount - (guestResult.specialBonus || 0), winning >= 1 && winning % 3 === 1 ? 20 : -10, 'la columna 1 paga x3');
  assert.equal(resolvedHost.viewerProfile.chips, hostProfileBefore.chips + hostResult.amount + progressionRewards(hostProfileBefore, resolvedHost.viewerProfile), 'contabilidad autoritativa del anfitrión');
  assert.equal(resolvedGuest.viewerProfile.chips, guestProfileBefore.chips + guestResult.amount + progressionRewards(guestProfileBefore, resolvedGuest.viewerProfile), 'contabilidad autoritativa del invitado');

  const reactionPromise = waitFor(guest, 'reaction', event => event.emoji === '🔥');
  assert.equal((await emitAck(host, 'reaction', { emoji: '🔥' })).ok, true);
  assert.equal((await reactionPromise).name, 'Anfitrión');
  assert.equal((await emitAck(guest, 'quick_chat', { message: '¡Bien jugado!' })).ok, true);
  await waitState(host, state => state.messages.some(message => message.text === '¡Bien jugado!'));
  assert.equal((await emitAck(guest, 'profile_update', { name: 'Panda social', avatar: 'owl' })).ok, true);
  await waitState(host, state => state.players.some(player => player.name === 'Panda social' && player.avatar === 'owl'));

  assert.equal((await emitAck(host, 'quick_new')).ok, true);
  await waitState(guest, state => state.phase === 'betting' && state.handNumber === 1);
  const balanceBeforeRefund = guest.latest.viewerProfile.chips;
  assert.equal((await emitAck(guest, 'quick_bet', { amount: 20, choice: 'even' })).ok, true);
  assert.equal((await emitAck(guest, 'leave_room')).ok, true);
  const guestRejoined = await joinRoom(guest, room.code, `guest-${suffix}`, 'Panda social');
  assert.equal(guestRejoined.viewerProfile.chips, balanceBeforeRefund, 'la apuesta abierta se reembolsa al salir');
  host.disconnect(); guest.disconnect();
}
async function testQuickSolo(game, choice) {
  const socket = connectClient();
  await waitFor(socket, 'connect');
  const token = `${game}-${Date.now()}-${Math.random()}`;
  await createRoom(socket, game, token, game);
  assert.equal((await emitAck(socket, 'quick_bet', { amount: 10, choice })).ok, true);
  assert.equal((await emitAck(socket, 'quick_resolve')).ok, true);
  const state = await waitState(socket, room => room.phase === 'results', 7000);
  assert.ok(state.quickResult && state.results.length === 1, `${game} debe publicar resultado y liquidación`);
  assert.equal((await emitAck(socket, 'quick_new')).ok, true);
  await waitState(socket, room => room.phase === 'betting' && room.quickResult === null);
  socket.disconnect();
}
async function testPokerRegression() {
  const host = connectClient(), guest = connectClient();
  await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);
  const suffix = `${Date.now()}-${Math.random()}`;
  // Nombres explícitos: con la unicidad global de nombres del casino, dos
  // perfiles distintos no pueden llamarse igual (los otros tests de este
  // archivo ya usan «Anfitrión»/«Invitada» con otros tokens).
  const room = await createRoom(host, 'poker', `poker-host-${suffix}`, 'Anfitriona póker');
  await joinRoom(guest, room.code, `poker-guest-${suffix}`, 'Invitada póker');
  await waitState(host, state => state.players.length === 2);
  const response = await emitAck(host, 'poker_start');
  assert.equal(response.ok, true, response.error);
  const active = await waitState(host, state => state.phase === 'preflop');
  assert.equal(active.players.filter(player => player.hand.length === 2).length, 2);
  assert.ok(active.pot > 0 && active.turnId, 'póker conserva bote y turnos');
  host.disconnect(); guest.disconnect();
}
async function testBlackjackRegression() {
  const host = connectClient();
  await waitFor(host, 'connect');
  await createRoom(host, 'blackjack', `blackjack-${Date.now()}-${Math.random()}`, 'Anfitrión del 21');
  assert.equal((await emitAck(host, 'blackjack_bet', { amount: 10 })).ok, true);
  const response = await emitAck(host, 'blackjack_start');
  assert.equal(response.ok, true, response.error);
  const state = await waitState(host, room => room.phase === 'playing' || room.phase === 'results');
  assert.ok(state.players[0].hand.length >= 2 && state.dealerHand.length >= 2, 'blackjack conserva reparto');
  host.disconnect();
}

(async () => {
  try {
    await waitForServer();
    await testRoulette();
    await testQuickSolo('dice', 'n:6');
    await testQuickSolo('coinflip', 'heads');
    await testQuickSolo('slots', 'spin');
    await testPokerRegression();
    await testBlackjackRegression();
    console.log('✓ Smoke multicliente: ruleta, dados, cara o cruz, tragamonedas, perfil, social, reembolsos, póker y blackjack.');
  } catch (error) {
    console.error(error.stack || error);
    console.error(serverLog);
    process.exitCode = 1;
  } finally {
    clients.forEach(socket => socket.connected && socket.disconnect());
    server.kill('SIGTERM');
  }
})();
