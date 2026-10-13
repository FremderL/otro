'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { makeCosmeticId } = require('../lib/passport-catalog');
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

function connectSocket(port, deviceToken) {
  const socket = io(`http://127.0.0.1:${port}`, {
    auth: { deviceToken }, transports: ['websocket'], reconnection: false, timeout: 6000
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Tiempo agotado conectando al casino.'));
    }, 7000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', error => { clearTimeout(timer); socket.disconnect(); reject(error); });
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin confirmación del evento ${event}.`)), 5000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}

function waitForRoomProfile(socket, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('room_state', onRoom);
      error ? reject(error) : resolve(value);
    };
    const onRoom = room => {
      const profile = room.viewerProfile;
      if (profile && predicate(profile, room)) finish(null, { profile, room });
    };
    const timer = setTimeout(() => finish(new Error('No llegó el estado de perfil esperado.')), timeoutMs);
    socket.on('room_state', onRoom);
  });
}

test('el Pasaporte se acredita en liquidaciones válidas y el cliente no puede inventar progreso ni premios', { timeout: 50000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-passport-integration-'));
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
      PASSPORT_ENABLED: 'on',
      AUTO_BOTS: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let socket = null;
  t.after(async () => {
    socket?.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exitedCleanly = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 3000);
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
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json());
  assert.equal(health.passportEnabled, true, '/healthz refleja el flag activado');
  for (const asset of ['/', '/app.js', '/styles.css']) {
    const response = await fetch(`http://127.0.0.1:${port}${asset}`);
    assert.equal(response.headers.get('cache-control'), 'no-cache, must-revalidate', `${asset} se revalida para no mostrar una UI cacheada`);
  }
  const token = `passport-${Date.now()}`;
  socket = await connectSocket(port, token);
  const initialProfile = waitForRoomProfile(socket, profile => profile.id === token);
  const created = await emitWithAck(socket, 'create_room', {
    token,
    name: `Pasaporte${Date.now().toString().slice(-6)}`,
    roomName: 'Mesa de validación',
    game: 'coinflip',
    avatar: 'fox',
    tos: TOS_VERSION
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const initial = (await initialProfile).profile;
  assert.equal(initial.passport.season.points, 0);

  const currentSeason = initial.passport.season.key;
  const badgeId = makeCosmeticId(currentSeason, 'season-badge');
  const forgedProfile = await emitWithAck(socket, 'profile_update', {
    name: initial.name,
    avatar: initial.avatar,
    passport: {
      currentSeason: { key: currentSeason, points: 999999, games: ['poker', 'blackjack', 'roulette', 'dice', 'coinflip', 'slots'] },
      unlockedCosmetics: [badgeId],
      equipped: { badge: badgeId }
    }
  });
  assert.equal(forgedProfile.ok, true);
  assert.equal(forgedProfile.profile.passport.season.points, 0, 'profile_update no acepta campos de progreso del Pasaporte');
  assert.equal(forgedProfile.profile.passport.inventory.length, 0);

  const lockedEquip = await emitWithAck(socket, 'passport_equip', { slot: 'badge', itemId: badgeId });
  assert.equal(lockedEquip.ok, false, 'el cliente no puede equipar un premio todavía bloqueado');
  socket.emit('passport_progress', { points: 999999, games: ['poker', 'blackjack', 'roulette', 'dice', 'coinflip', 'slots'] });
  const afterUnknownEvent = await emitWithAck(socket, 'profile_update', { name: initial.name, avatar: initial.avatar });
  assert.equal(afterUnknownEvent.profile.passport.season.points, 0, 'no hay evento socket para conceder progreso');

  for (let round = 1; round <= 5; round++) {
    if (round > 1) {
      const opened = await emitWithAck(socket, 'quick_new', {});
      assert.equal(opened.ok, true, JSON.stringify(opened));
    }
    const bet = await emitWithAck(socket, 'quick_bet', { amount: 10, choice: 'heads' });
    assert.equal(bet.ok, true, JSON.stringify(bet));
    const updatedProfile = waitForRoomProfile(socket, profile => profile.passport.season.points >= round);
    const resolved = await emitWithAck(socket, 'quick_resolve', {});
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const state = await updatedProfile;
    assert.equal(state.profile.passport.season.points, round, `la liquidación ${round} suma solo un punto`);
  }

  const refreshed = await emitWithAck(socket, 'profile_update', { name: initial.name, avatar: initial.avatar });
  assert.equal(refreshed.profile.passport.season.points, 5);
  assert.ok(refreshed.profile.passport.inventory.some(item => item.id === badgeId), 'el hito de 5 puntos se desbloquea automáticamente');

  const identityUpdate = waitForRoomProfile(socket, profile => profile.passport.equipped.badge?.id === badgeId);
  const equip = await emitWithAck(socket, 'passport_equip', { slot: 'badge', itemId: badgeId });
  assert.equal(equip.ok, true, JSON.stringify(equip));
  assert.equal(equip.profile.passport.equipped.badge.id, badgeId);
  const roomIdentity = await identityUpdate;
  assert.equal(roomIdentity.room.players.find(player => player.id === token).passport.equipped.badge.id, badgeId,
    'la insignia equipada se publica en la identidad de la sala');
});

test('con PASSPORT_ENABLED ausente se pausa el progreso, se rechaza el equipamiento y no se publica cosmética', { timeout: 40000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-passport-disabled-'));
  const port = await reservePort();
  const output = { text: '' };
  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: '',
    PROFILE_STORE_PATH: path.join(tempDir, 'profiles.json'),
    ADMIN_FEATURE_ENABLED: 'off',
    FOOTBALL_ENABLED: 'off',
    AUTO_BOTS: 'off',
    LOG_JSON: 'off'
  };
  delete env.PASSPORT_ENABLED;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let socket = null;
  t.after(async () => {
    socket?.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exitedCleanly = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 3000);
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
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json());
  assert.equal(health.passportEnabled, false, 'un flag ausente se reporta apagado');
  const token = `passport-disabled-${Date.now()}`;
  socket = await connectSocket(port, token);
  const initialProfile = waitForRoomProfile(socket, profile => profile.id === token);
  const created = await emitWithAck(socket, 'create_room', {
    token,
    name: `SinPasaporte${Date.now().toString().slice(-5)}`,
    roomName: 'Mesa con Pasaporte pausado',
    game: 'coinflip',
    avatar: 'fox',
    tos: TOS_VERSION
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const initial = (await initialProfile).profile;
  assert.equal(initial.passport.season.points, 0);

  const equip = await emitWithAck(socket, 'passport_equip', {
    slot: 'badge', itemId: makeCosmeticId(initial.passport.season.key, 'season-badge')
  });
  assert.equal(equip.ok, false);
  assert.match(equip.error, /no está activo/i);

  const bet = await emitWithAck(socket, 'quick_bet', { amount: 10, choice: 'heads' });
  assert.equal(bet.ok, true, JSON.stringify(bet));
  const settledProfile = waitForRoomProfile(socket, profile => profile.stats.roundsPlayed >= 1);
  const resolved = await emitWithAck(socket, 'quick_resolve', {});
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const settled = await settledProfile;
  assert.equal(settled.profile.passport.season.points, 0, 'la ronda se liquida pero no da puntos durante la pausa');
  assert.equal(settled.room.players.find(player => player.id === token).passport.equipped.badge, null,
    'la identidad pública no expone cosméticos con el flag apagado');

  const refreshed = await emitWithAck(socket, 'profile_update', { name: initial.name, avatar: initial.avatar });
  assert.equal(refreshed.profile.passport.season.points, 0);
  assert.equal(refreshed.profile.passport.inventory.length, 0);
});
