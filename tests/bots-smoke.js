'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const { DIFFICULTIES, STYLES, createBot } = require('../lib/bots/catalog');
const { decide, fallbackDecision } = require('../lib/bots/decision-engine');

const port = 3700 + Math.floor(Math.random() * 250);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `mesa-amiga-bots-${process.pid}.json`);
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath,
    BOT_SPEED_FACTOR: '0.05', BOT_ONLY_ROOM_TTL_MS: '350'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk; });
child.stderr.on('data', chunk => { serverLog += chunk; });
const clients = [];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function connectClient() {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.latest = null;
  socket.on('room_state', state => { socket.latest = state; });
  clients.push(socket);
  return socket;
}
function waitFor(socket, event, predicate = () => true, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Tiempo agotado esperando ${event}`)); }, timeout);
    function listener(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer); socket.off(event, listener); resolve(payload);
    }
    socket.on(event, listener);
  });
}
function waitState(socket, predicate, timeout = 6000) {
  if (socket.latest && predicate(socket.latest)) return Promise.resolve(socket.latest);
  return waitFor(socket, 'room_state', predicate, timeout);
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 5000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}
async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor finalizado.\n${serverLog}`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch (_) { /* starting */ }
    await delay(60);
  }
  throw new Error(`El servidor no inició.\n${serverLog}`);
}
async function createRoom(socket, game, token) {
  const response = await emitAck(socket, 'create_room', { name: `Host ${game}`, roomName: `Bots ${game}`, game, token, avatar: 'robot' });
  assert.equal(response.ok, true, response.error);
  return waitState(socket, room => room.code === response.code);
}
async function waitUntil(predicate, timeout = 5000, interval = 30) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(interval);
  }
  throw new Error('Condición no alcanzada a tiempo.');
}
async function waitForRooms(expected) {
  return waitUntil(async () => {
    const state = await (await fetch(`${url}/health`)).json();
    return state.rooms === expected && (expected > 0 || state.botTasks === 0) ? state : null;
  }, 5000);
}

function testStrategyModules() {
  assert.deepEqual(Object.keys(DIFFICULTIES), ['easy', 'normal', 'hard', 'expert']);
  assert.equal(DIFFICULTIES.easy.minDelay, 2000); assert.equal(DIFFICULTIES.easy.maxDelay, 5000);
  assert.equal(DIFFICULTIES.normal.minDelay, 1500); assert.equal(DIFFICULTIES.normal.maxDelay, 4000);
  assert.equal(DIFFICULTIES.hard.minDelay, 1000); assert.equal(DIFFICULTIES.hard.maxDelay, 3000);
  assert.equal(DIFFICULTIES.expert.minDelay, 800); assert.equal(DIFFICULTIES.expert.maxDelay, 2500);
  assert.deepEqual(Object.keys(STYLES), ['conservative', 'aggressive', 'balanced', 'risky', 'unpredictable']);

  const dummyRoom = { code: 'TESTS', game: 'blackjack', players: [] };
  const bot = createBot(dummyRoom, { difficulty: 'expert', style: 'balanced' });
  dummyRoom.players.push(bot);
  bot.hand = ['10S', '6H']; bot.bet = 10; bot.chips = 990;
  const blackjackView = { game: 'blackjack', dealerHand: ['10D', 'XX'], players: [{ id: bot.id, hand: bot.hand, bet: 10, chips: 990 }] };
  assert.equal(decide(blackjackView, bot, 'blackjack-turn').action, 'hit', 'experto aplica estrategia legal con 16 contra 10');
  bot.chips = 5;
  assert.equal(fallbackDecision({ game: 'blackjack', players: [{ id: bot.id }] }, bot, 'blackjack-bet'), null, 'un bot sin fichas no inventa una apuesta');

  bot.chips = 1000;
  const quick = decide({ game: 'coinflip', players: [{ id: bot.id }] }, bot, 'quick-bet');
  assert.ok(['heads', 'tails'].includes(quick.choice) && quick.amount >= 10 && quick.amount <= 1000);
}

async function testQuickBots() {
  const host = connectClient(), guest = connectClient();
  await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);
  const room = await createRoom(host, 'roulette', `quick-host-${Date.now()}`);
  const guestToken = `guest-${Date.now()}`;
  let response = await emitAck(guest, 'join_room', { name: 'Invitada', code: room.code, token: guestToken, avatar: 'panda' });
  assert.equal(response.ok, true, response.error);
  await waitState(host, state => state.players.length === 2);
  response = await emitAck(guest, 'bot_add', { difficulty: 'expert', style: 'aggressive' });
  assert.equal(response.ok, false, 'un invitado no puede configurar bots');

  response = await emitAck(host, 'bot_add', { difficulty: 'easy', style: 'conservative' });
  assert.equal(response.ok, true, response.error);
  const removable = await waitState(host, state => state.players.some(player => player.id === response.botId && player.bot?.thinking));
  const added = removable.players.find(player => player.id === response.botId);
  assert.equal(added.isBot, true); assert.equal(added.bot.difficulty, 'easy'); assert.equal(added.bot.style, 'conservative');
  response = await emitAck(host, 'bot_remove', { botId: added.id });
  assert.equal(response.ok, true, response.error);
  await waitState(host, state => !state.players.some(player => player.id === added.id));
  await delay(350);
  assert.equal(host.latest.players.some(player => player.id === added.id), false, 'una tarea cancelada no revive al bot');

  for (const [difficulty, style] of [['easy', 'conservative'], ['normal', 'balanced'], ['hard', 'aggressive'], ['expert', 'unpredictable']]) {
    response = await emitAck(host, 'bot_add', { difficulty, style });
    assert.equal(response.ok, true, response.error);
  }
  let state = await waitState(host, current => current.players.length === 6);
  assert.equal(state.players.filter(player => player.isBot).length, 4);
  assert.deepEqual(new Set(state.players.filter(player => player.isBot).map(player => player.bot.difficulty)), new Set(['easy', 'normal', 'hard', 'expert']));
  assert.equal((await emitAck(host, 'bot_add', { difficulty: 'normal', style: 'balanced' })).ok, false, 'se respeta la capacidad');
  state = await waitState(host, current => current.players.filter(player => player.isBot).every(player => player.bet > 0), 5000);
  assert.ok(state.players.filter(player => player.isBot).every(player => player.quickChoice === 'locked'), 'las elecciones de bots siguen ocultas antes del resultado');
  assert.equal((await emitAck(host, 'quick_resolve')).ok, true);
  state = await waitState(host, current => current.phase === 'results', 5000);
  assert.equal(state.results.length, 4, 'todos los bots apostaron y fueron liquidados');
  assert.ok(state.players.filter(player => player.isBot).every(player => player.bot.stats.roundsPlayed === 1));
  assert.equal((await emitAck(host, 'quick_new')).ok, true);
  state = await waitState(host, current => current.phase === 'betting' && current.players.filter(player => player.isBot).every(player => player.bet > 0), 5000);
  assert.equal(state.handNumber, 1, 'los bots participan en la ronda consecutiva');

  // El abandono migra el anfitrión, y cambiar de juego se hace saliendo y
  // creando una sala nueva: no se arrastran estado ni tareas del juego anterior.
  assert.equal((await emitAck(host, 'leave_room')).ok, true);
  state = await waitState(guest, current => current.hostId === guestToken && current.phase === 'betting');
  assert.equal((await emitAck(guest, 'quick_resolve')).ok, true, 'el nuevo anfitrión conserva el control');
  await waitState(guest, current => current.phase === 'results', 5000);
  const switched = await createRoom(host, 'dice', `Cambio a dados ${Date.now()}`);
  assert.equal(switched.game, 'dice');
  assert.equal((await emitAck(host, 'bot_add', { difficulty: 'normal', style: 'balanced' })).ok, true);
  await waitState(host, current => current.players.some(player => player.isBot));
  assert.equal((await emitAck(host, 'leave_room')).ok, true);
  guest.disconnect();
  await waitForRooms(0);
}

async function testBlackjackBots() {
  const host = connectClient(); await waitFor(host, 'connect');
  await createRoom(host, 'blackjack', `blackjack-host-${Date.now()}`);
  let response = await emitAck(host, 'bot_fill', { difficulty: 'hard', style: 'balanced' });
  assert.equal(response.ok, true, response.error); assert.equal(response.botIds.length, 5);
  let state = await waitState(host, current => current.players.filter(player => player.isBot).every(player => player.bet > 0), 5000);
  assert.equal(state.players.length, 6);
  assert.equal((await emitAck(host, 'blackjack_start')).ok, true);
  state = await waitState(host, current => current.phase === 'results', 5000);
  assert.equal(state.results.length, 5);
  assert.ok(state.players.filter(player => player.isBot).every(player => player.bot.stats.actions >= 1));
  assert.equal(serverLog.includes('[BOT_FALLBACK]'), false, 'las decisiones normales no necesitaron fallback');
  host.disconnect(); await waitForRooms(0);
}

async function testPokerBotsAndCleanup() {
  const host = connectClient(); await waitFor(host, 'connect');
  const token = `poker-host-${Date.now()}`;
  await createRoom(host, 'poker', token);
  const response = await emitAck(host, 'bot_fill', { difficulty: 'expert', style: 'risky' });
  assert.equal(response.ok, true, response.error); assert.equal(response.botIds.length, 5);
  assert.equal((await emitAck(host, 'poker_start')).ok, true);
  let state = await waitState(host, current => current.phase === 'preflop');
  for (const bot of state.players.filter(player => player.isBot)) assert.ok(bot.hand.every(card => card === 'XX'), 'el humano no recibe cartas ocultas del bot');

  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    state = host.latest;
    if (state.phase === 'showdown') break;
    if (state.turnId === token) {
      const me = state.players.find(player => player.id === token);
      const toCall = Math.max(0, state.currentBet - me.roundBet);
      const action = toCall ? 'fold' : 'check';
      const actionResponse = await emitAck(host, 'poker_action', { action });
      assert.equal(actionResponse.ok, true, actionResponse.error);
    }
    await delay(25);
  }
  assert.equal(host.latest.phase, 'showdown', 'una mesa con cinco bots progresa sin congelarse');
  assert.ok(host.latest.players.filter(player => player.isBot).some(player => player.bot.stats.roundsPlayed >= 1));
  host.disconnect();
  const health = await waitForRooms(0);
  assert.equal(health.botTasks, 0, 'el cierre de la sala cancela todas las tareas de bots');
}

(async () => {
  try {
    testStrategyModules();
    await waitForServer();
    await testQuickBots();
    await testBlackjackBots();
    await testPokerBotsAndCleanup();
    console.log('✓ Bots: permisos, capacidad, dificultades, estilos, decisiones, fallback, rondas, ocultación y limpieza.');
  } catch (error) {
    console.error(error.stack || error);
    console.error(serverLog);
    process.exitCode = 1;
  } finally {
    clients.forEach(socket => socket.connected && socket.disconnect());
    child.kill('SIGTERM');
  }
})();
