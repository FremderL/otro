'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { TOS_VERSION } = require('../lib/terms');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó con código ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return response.json();
    } catch (_) { /* todavía arrancando */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('El servidor no respondió a tiempo');
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Sin ack para ${event}`)), 3000);
    socket.emit(event, payload, response => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

test('servidor conserva los flujos básicos de salud, invitado y cuenta', { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'montecristo-server-'));
  const port = await reservePort();
  const profileFile = path.join(directory, 'profiles.json');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      PROFILE_STORE_PATH: profileFile,
      ADMIN_FEATURE_ENABLED: 'false',
      AUTO_BOTS: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve)).catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(origin, child);
  assert.equal(health.status, 'ok');
  assert.equal(health.tosVersion, TOS_VERSION);

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /MonteCristo/i);

  const socket = io(origin, { transports: ['websocket'], forceNew: true });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  const room = await emitAck(socket, 'create_room', {
    name: 'Prueba', roomName: 'Mesa base', game: 'poker', token: 'device-smoke', tos: TOS_VERSION
  });
  assert.equal(room.ok, true, JSON.stringify(room));
  assert.match(room.code, /^[A-Z0-9]{5}$/);

  const signup = await emitAck(socket, 'account_signup', {
    token: 'device-smoke', name: 'Prueba', username: 'prueba_smoke', password: 'segura-123', tos: TOS_VERSION
  });
  assert.equal(signup.ok, true, JSON.stringify(signup));
  assert.equal(signup.profile.username, 'prueba_smoke');
  assert.equal(Object.hasOwn(signup.profile, 'passwordHash'), false);

  const failed = await emitAck(socket, 'account_login', { username: 'prueba_smoke', password: 'incorrecta' });
  assert.equal(failed.ok, false);
  const login = await emitAck(socket, 'account_login', { username: 'prueba_smoke', password: 'segura-123' });
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.equal(login.token, 'device-smoke'); // Caracteriza el modelo inseguro que sustituirá la Fase 1.

  assert.equal(child.exitCode, null, output);
});
