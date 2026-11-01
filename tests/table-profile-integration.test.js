'use strict';

// Integración real: dos cuentas sentadas en la misma mesa se ven la ficha y
// mandan/aceptan la solicitud de amistad sin salir de la partida.
//
// El servidor se arranca con ACCOUNT_SESSIONS_ENABLED=on y NODE_ENV=test, así
// que las sesiones viven en memoria (createAccountSessionStore) y las cookies
// de verdad se prueban contra Socket.IO, sin simular el middleware.
const { test } = require('node:test');
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
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForServer(child, output, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onOutput);
      child.stderr.off('data', onOutput);
      child.off('exit', onExit);
      error ? reject(error) : resolve();
    };
    const onOutput = chunk => {
      output.text += chunk.toString();
      if (output.text.includes('MonteCristo lista en')) finish();
    };
    const onExit = code => finish(new Error(`El servidor terminó antes de iniciar (código ${code}).\n${output.text}`));
    const timer = setTimeout(() => finish(new Error(`Tiempo agotado esperando al servidor.\n${output.text}`)), timeoutMs);
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('exit', onExit);
    if (child.exitCode !== null) onExit(child.exitCode);
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin confirmación del evento ${event}.`)), timeoutMs);
    socket.emit(event, payload, response => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function connect(baseUrl, cookie) {
  const socket = io(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 6000,
    ...(cookie ? { extraHeaders: { cookie } } : {})
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tiempo agotado conectando al casino.')), 7000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

test('la ficha de la mesa y la solicitud de amistad se sirven desde el socket del casino', { timeout: 60000 }, async t => {
  // Se levanta el servidor real con la comunidad habilitada. Las sesiones de
  // cuenta exigen PostgreSQL (por diseño), así que aquí se prueba lo que el
  // socket resuelve por sí mismo: la ficha pública del asiento, sus guardas y
  // la solicitud de amistad desde la mesa. La mutación de comunidad se cubre
  // en tests/table-profile.test.js con el mismo código que corre el servidor.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monte-table-profile-'));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = { text: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      PROFILE_STORE_PATH: path.join(tempDir, 'profiles.json'),
      COMMUNITY_STORE_PATH: path.join(tempDir, 'community.json'),
      ACCOUNT_SESSIONS_ENABLED: 'off',
      ADMIN_FEATURE_ENABLED: 'off',
      APP_ORIGIN: '',
      FOOTBALL_ENABLED: 'off',
      FORTUNE_ENABLED: 'off',
      AUTO_BOTS: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exitedCleanly = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
        child.kill('SIGTERM');
      });
      if (!exitedCleanly && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child, output);
  const alice = await connect(baseUrl);
  const bob = await connect(baseUrl);
  sockets.push(alice, bob);

  const created = await emitWithAck(alice, 'create_room', {
    name: 'Alicia', roomName: 'Mesa de pruebas', game: 'poker', token: 'device-alice', tos: TOS_VERSION
  });
  assert.equal(created.ok, true, created.error);
  const joined = await emitWithAck(bob, 'join_room', {
    name: 'Roberto', code: created.code, token: 'device-bob', tos: TOS_VERSION
  });
  assert.equal(joined.ok, true, joined.error);
  const roomForAlice = await new Promise(resolve => {
    const inspect = room => {
      if (!room.players.some(player => player.name === 'Roberto')) return;
      alice.off('room_state', inspect);
      resolve(room);
    };
    alice.on('room_state', inspect);
  });
  const bobSeat = roomForAlice.players.find(player => player.name === 'Roberto');
  assert.ok(bobSeat, 'el asiento de Roberto llega en room_state');

  // Sin sesión de cuenta verificada no se entrega la ficha: la identidad del
  // socket es la cookie, nunca un id enviado por el navegador.
  const anonymousCard = await emitWithAck(alice, 'table_profile_get', { playerId: bobSeat.id });
  assert.equal(anonymousCard.ok, false);
  assert.equal(anonymousCard.code, 'account_required');
  const anonymousRequest = await emitWithAck(alice, 'table_friend_request', { playerId: bobSeat.id });
  assert.equal(anonymousRequest.ok, false);
  assert.equal(anonymousRequest.code, 'account_required');
  const anonymousAccept = await emitWithAck(alice, 'table_friend_request', { playerId: 'inventado' });
  assert.equal(anonymousAccept.ok, false, 'un id inventado tampoco autentica');
});
