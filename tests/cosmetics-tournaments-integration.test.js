'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { ProfileStore } = require('../lib/profile-store');
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

function waitForProfile(socket, predicate, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room_state', onRoom);
      reject(new Error('No llegó el perfil esperado en el estado de sala.'));
    }, timeoutMs);
    const onRoom = room => {
      if (!room.viewerProfile || !predicate(room.viewerProfile, room)) return;
      clearTimeout(timer);
      socket.off('room_state', onRoom);
      resolve({ profile: room.viewerProfile, room });
    };
    socket.on('room_state', onRoom);
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
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

test('cosméticos y torneos relámpago funcionan por socket, sin falsificar desbloqueos ni pagar entradas', { timeout: 50000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cosmetic-tournament-'));
  const profilePath = path.join(tempDir, 'profiles.json');
  const token = `feature-${Date.now()}`;
  const seededStore = new ProfileStore(profilePath, { deferSeasonCheck: true });
  const seededProfile = seededStore.getOrCreate(token, 'Coleccionista', 'fox');
  seededProfile.stats.roundsPlayed = 10;
  seededProfile.collection.unlocked.push('avatar-phoenix');
  seededStore.touch(seededProfile);
  seededStore.saveNow();

  const port = await reservePort();
  const output = { text: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      PROFILE_STORE_PATH: profilePath,
      ADMIN_FEATURE_ENABLED: 'off',
      FOOTBALL_ENABLED: 'off',
      PASSPORT_ENABLED: 'off',
      AUTO_BOTS: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let socket = null;
  let stopped = false;
  t.after(async () => {
    socket?.disconnect();
    if (!stopped) await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child, output);
  socket = await connectSocket(port, token);
  const matchingRoom = waitForProfile(socket, profile => profile.id === token);
  const created = await emitWithAck(socket, 'create_room', {
    token, name: 'Coleccionista', roomName: 'Prueba cosméticos', game: 'poker', avatar: 'fox', tos: TOS_VERSION
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const { profile: initialProfile } = await matchingRoom;
  assert.equal(initialProfile.collection.items.find(item => item.id === 'avatar-phoenix')?.unlocked, true);
  assert.equal(initialProfile.collection.equipped.avatar, null);

  const equipped = await emitWithAck(socket, 'cosmetic_equip', { slot: 'avatar', itemId: 'avatar-phoenix' });
  assert.equal(equipped.ok, true, JSON.stringify(equipped));
  assert.equal(equipped.profile.collection.equipped.avatar.id, 'avatar-phoenix');
  const locked = await emitWithAck(socket, 'cosmetic_equip', { slot: 'frame', itemId: 'frame-obsidian' });
  assert.equal(locked.ok, false, 'el servidor rechaza un objeto todavía bloqueado');
  const wrongSlot = await emitWithAck(socket, 'cosmetic_equip', { slot: 'frame', itemId: 'avatar-phoenix' });
  assert.equal(wrongSlot.ok, false, 'el servidor valida el espacio del catálogo');
  const forgedUnlock = await emitWithAck(socket, 'cosmetic_equip', {
    slot: 'cards', itemId: 'cards-cosmos', unlocked: ['cards-cosmos'], progress: { roundsPlayed: 999999 }
  });
  assert.equal(forgedUnlock.ok, false, 'el cliente no puede enviar progreso para desbloquear objetos');

  assert.equal((await emitWithAck(socket, 'leave_room', {})).ok, true);
  const calendarResponse = await emitWithAck(socket, 'lobby_tournaments_get', {});
  assert.equal(calendarResponse.ok, true, JSON.stringify(calendarResponse));
  const events = calendarResponse.snapshot.tournaments;
  assert.ok(events.some(event => !event.featured && event.capacity === 8), 'el calendario publica relámpagos de 8');
  assert.ok(events.some(event => !event.featured && event.capacity === 16), 'el calendario publica relámpagos de 16');
  assert.ok(events.some(event => event.featured && event.capacity === 16), 'el calendario publica la final semanal destacada');

  const event = events.find(item => !item.featured && item.status === 'registration');
  assert.ok(event, 'hay una inscripción futura disponible');
  const registered = await emitWithAck(socket, 'lobby_tournament_register', {
    tournamentId: event.id, name: 'Coleccionista', tos: TOS_VERSION
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  assert.equal(registered.code, 'registered');
  const duplicate = await emitWithAck(socket, 'lobby_tournament_register', {
    tournamentId: event.id, name: 'Coleccionista', tos: TOS_VERSION
  });
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.code, 'already_registered');
  const otherEvent = events.find(item => !item.featured && item.id !== event.id && item.status === 'registration');
  const secondRegistration = await emitWithAck(socket, 'lobby_tournament_register', {
    tournamentId: otherEvent.id, name: 'Coleccionista', tos: TOS_VERSION
  });
  assert.equal(secondRegistration.ok, false, 'un perfil no puede duplicar inscripción en dos torneos');
  assert.match(secondRegistration.error, /Ya estás inscrito/u);
  const withdrawn = await emitWithAck(socket, 'lobby_tournament_withdraw', { tournamentId: event.id });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.equal(withdrawn.code, 'withdrawn');

  socket.disconnect();
  socket = null;
  await stopServer(child);
  stopped = true;
  const persisted = new ProfileStore(profilePath, { deferSeasonCheck: true }).getProfile(token);
  assert.ok(persisted, 'el perfil sobrevive al reinicio del servidor');
  assert.deepEqual(persisted.collection.unlocked, ['avatar-phoenix']);
  assert.equal(persisted.collection.equipped.avatar, 'avatar-phoenix');
  assert.equal(persisted.chips, 1000, 'equipar y registrarse no modifica el saldo virtual');
  assert.deepEqual(persisted.passport, seededProfile.passport, 'el inventario queda separado del Pasaporte');
});
