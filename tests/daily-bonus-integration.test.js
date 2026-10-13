'use strict';

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

function waitForServer(child, output, timeoutMs = 12000) {
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

function connectSocket(port, deviceToken) {
  const socket = io(`http://127.0.0.1:${port}`, {
    auth: { deviceToken },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Tiempo agotado conectando al casino.'));
    }, 6000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', error => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin confirmación del evento ${event}.`)), 4000);
    socket.emit(event, payload, response => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForRoomProfile(socket, profileId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room_state', onRoom);
      reject(new Error('No llegó el perfil de la sala.'));
    }, 4000);
    const onRoom = room => {
      if (room.viewerProfile?.id !== profileId) return;
      clearTimeout(timer);
      socket.off('room_state', onRoom);
      resolve(room.viewerProfile);
    };
    socket.on('room_state', onRoom);
  });
}

test('el bono diario ya no se acredita al entrar y el botón lo reclama una sola vez por día', { timeout: 30000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monte-daily-bonus-'));
  const port = await reservePort();
  const output = { text: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      PROFILE_STORE_PATH: path.join(tempDir, 'profiles.json'),
      ADMIN_FEATURE_ENABLED: 'off',
      FOOTBALL_ENABLED: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let socket = null;
  t.after(async () => {
    socket?.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exitedCleanly = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 2500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
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
  const token = `daily-bonus-${Date.now()}`;
  socket = await connectSocket(port, token);
  const initialProfile = waitForRoomProfile(socket, token);
  const created = await emitWithAck(socket, 'create_room', {
    token,
    name: `Bono${Date.now().toString().slice(-6)}`,
    roomName: 'Mesa de prueba',
    game: 'poker',
    avatar: 'fox',
    tos: TOS_VERSION
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const roomProfile = await initialProfile;
  assert.equal(roomProfile.chips, 1000, 'entrar a la sala no acredita el bono automáticamente');
  assert.equal(roomProfile.dailyBonusClaimed, false, 'el perfil todavía puede reclamar el bono');

  const firstClaim = await emitWithAck(socket, 'daily_bonus_claim', {});
  assert.equal(firstClaim.ok, true, JSON.stringify(firstClaim));
  assert.equal(firstClaim.claimed, true);
  assert.equal(firstClaim.reward, 100);
  assert.equal(firstClaim.profile.chips, 1100);
  assert.equal(firstClaim.profile.dailyBonusClaimed, true);

  const repeatedClaim = await emitWithAck(socket, 'daily_bonus_claim', {});
  assert.equal(repeatedClaim.ok, true, JSON.stringify(repeatedClaim));
  assert.equal(repeatedClaim.claimed, false, 'reintentar el evento no duplica el premio');
  assert.equal(repeatedClaim.profile.chips, 1100);
});
