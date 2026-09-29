'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { io } = require('socket.io-client');

const port = 4000 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port),
    PROFILE_STORE_PATH: path.join(os.tmpdir(), `montecristo-fallback-${process.pid}.json`),
    BOT_SPEED_FACTOR: '0.02',
    BOT_ONLY_ROOM_TTL_MS: '250',
    BOT_FORCE_DECISION_ERROR: '1',
    AUTO_BOTS: 'off',
    RECONNECT_GRACE_MS: '250'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
let socket;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function emitAck(event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 4000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}
function waitState(predicate, timeout = 5000) {
  if (socket.latest && predicate(socket.latest)) return Promise.resolve(socket.latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('room_state', listener); reject(new Error('Tiempo agotado esperando room_state')); }, timeout);
    function listener(state) {
      if (!predicate(state)) return;
      clearTimeout(timer); socket.off('room_state', listener); resolve(state);
    }
    socket.on('room_state', listener);
  });
}
async function waitServer() {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó.\n${log}`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch (_) { /* iniciando */ }
    await delay(50);
  }
  throw new Error(`El servidor no inició.\n${log}`);
}

(async () => {
  try {
    await waitServer();
    socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.latest = null;
    socket.on('room_state', state => { socket.latest = state; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No conectó')), 4000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
    });
    let response = await emitAck('create_room', { name: 'Fallback', roomName: 'Prueba segura', game: 'roulette', token: `fallback-${Date.now()}`, avatar: 'robot' });
    assert.equal(response.ok, true, response.error);
    await waitState(state => state.code === response.code);

    const fallbackEvent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No se anunció el fallback')), 5000);
      function listener(event) {
        if (event.type !== 'bot_action' || !event.fallback) return;
        clearTimeout(timer); socket.off('game_event', listener); resolve(event);
      }
      socket.on('game_event', listener);
    });
    response = await emitAck('bot_add', { difficulty: 'expert', style: 'aggressive' });
    assert.equal(response.ok, true, response.error);
    const botId = response.botId;
    const event = await fallbackEvent;
    assert.equal(event.botId, botId);
    let state = await waitState(current => current.players.some(player => player.id === botId && player.bet > 0));
    let bot = state.players.find(player => player.id === botId);
    assert.ok(bot.bet >= 10 && bot.chips + bot.bet === 1000, 'el fallback también pasa por economía autoritativa');
    assert.ok(bot.bot.history.some(action => action.fallback), 'el historial marca la alternativa segura');
    assert.ok(bot.bot.stats.actions >= 1);
    assert.ok(log.includes('[BOT_FALLBACK]') && log.includes('Fallo de decisión simulado.'), 'el error quedó registrado con contexto');

    assert.equal((await emitAck('quick_resolve')).ok, true);
    state = await waitState(current => current.phase === 'results');
    assert.equal(state.results.length, 1, 'el error de IA no congeló ni evitó liquidar la ronda');
    assert.equal((await emitAck('quick_new')).ok, true);
    state = await waitState(current => current.phase === 'betting' && current.players.find(player => player.id === botId)?.bet > 0);
    bot = state.players.find(player => player.id === botId);
    assert.ok(bot.bot.history.filter(action => action.fallback).length >= 2, 'el bot continúa en rondas posteriores');

    socket.disconnect();
    const deadline = Date.now() + 4000;
    let health;
    do {
      await delay(50);
      health = await (await fetch(`${url}/health`)).json();
    } while (Date.now() < deadline && (health.rooms !== 0 || health.botTasks !== 0));
    assert.equal(health.rooms, 0);
    assert.equal(health.botTasks, 0, 'el cierre cancela tareas incluso después de fallos');
    console.log('✓ Fallback forzado: registro, alternativa válida, continuidad, economía y limpieza.');
  } catch (error) {
    console.error(error.stack || error);
    console.error(log);
    process.exitCode = 1;
  } finally {
    socket?.disconnect();
    child.kill('SIGTERM');
  }
})();
