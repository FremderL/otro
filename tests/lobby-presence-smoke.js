'use strict';

// Regresión del contador "Jugadores en línea": debe representar toda la
// presencia del casino (incluido el lobby), actualizarse al conectar/desconectar
// y no duplicar a una persona que abre dos pestañas con el mismo dispositivo.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { io } = require('socket.io-client');

const port = 5500 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-presence-${process.pid}.json`);
const sockets = [];
let server;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`El servidor terminó antes de iniciar.\n${server.log}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (_) { /* todavía iniciando */ }
    await sleep(60);
  }
  throw new Error(`El servidor no abrió el puerto.\n${server.log}`);
}

function connect(deviceToken) {
  const socket = io(url, {
    auth: { deviceToken },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  });
  socket.presence = null;
  socket.on('lobby_state', state => { socket.presence = state?.playersOnline; });
  sockets.push(socket);
  return socket;
}

async function until(fn, description, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = fn();
    if (value) return value;
    await sleep(30);
  }
  throw new Error(`Tiempo agotado esperando: ${description}`);
}

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', DATABASE_URL: '', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.log = '';
  server.stdout.on('data', chunk => { server.log += chunk; });
  server.stderr.on('data', chunk => { server.log += chunk; });
  await waitForServer();

  const first = connect('presence-device-a');
  await until(() => first.connected && first.presence === 1, 'el primer visitante del lobby cuenta como 1');

  const second = connect('presence-device-b');
  await until(() => second.connected && first.presence === 2 && second.presence === 2,
    'los dos visitantes ven el contador subir a 2');

  const duplicateTab = connect('presence-device-a');
  await until(() => duplicateTab.connected && duplicateTab.presence === 2 && first.presence === 2,
    'dos pestañas del mismo dispositivo siguen contando como una persona');
  await sleep(150);
  assert.equal(second.presence, 2, 'el contador permanece deduplicado en todos los clientes');

  second.disconnect();
  await until(() => first.presence === 1 && duplicateTab.presence === 1,
    'al desconectarse el segundo dispositivo el contador baja en vivo');

  console.log('✅ lobby-presence-smoke: presencia del lobby en vivo, desconexión y deduplicación por dispositivo OK');
}

main()
  .catch(error => { console.error('❌ lobby-presence-smoke:', error.stack || error.message); process.exitCode = 1; })
  .finally(async () => {
    sockets.forEach(socket => { try { socket.disconnect(); } catch (_) { /* noop */ } });
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => { server.on('exit', resolve); setTimeout(resolve, 1200); });
    }
    try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  });
