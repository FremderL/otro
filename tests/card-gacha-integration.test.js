'use strict';

// Gachapón de cartas por socket, con server.js real: la respuesta de
// card_gacha_pull trae `duplicate`, `refundChips` y el saldo/historial del
// perfil, y el abono por repetida queda en el perfil guardado.

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
const { CARD_GACHA_COST, CARD_DUPLICATE_CHIPS, CARD_CATALOG } = require('../lib/card-gacha');

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

// Arranca un servidor real con un perfil sembrado (fichas y álbum a medida).
// El bono diario se marca como ya cobrado hoy para que no sume fichas al entrar.
async function bootServer(t, { chips, cardAlbum }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-card-gacha-'));
  const profilePath = path.join(tempDir, 'profiles.json');
  const token = `gacha-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seededStore = new ProfileStore(profilePath, { deferSeasonCheck: true });
  const seeded = seededStore.getOrCreate(token, 'Coleccionista', 'fox');
  seeded.chips = chips;
  seeded.cardAlbum = { counts: { ...(cardAlbum || {}) } };
  seeded.dailyBonusDate = new Date().toISOString().slice(0, 10);
  seededStore.touch(seeded);
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
      CARD_GACHA_ENABLED: 'on',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let socket = null;
  t.after(async () => {
    socket?.disconnect();
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  await waitForServer(child, output);
  socket = await connectSocket(port, token);
  // Crear una mesa deja al perfil sentado: así la cápsula usa su perfil de mesa.
  const created = await emitWithAck(socket, 'create_room', {
    token, name: 'Coleccionista', roomName: 'Prueba gachapón', game: 'poker', avatar: 'fox', tos: TOS_VERSION
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { socket, token };
}

function fullAlbum() {
  return Object.fromEntries(CARD_CATALOG.map(card => [card.id, 1]));
}

test('primera copia: no abona, cobra 5.000 y el historial lo registra', { timeout: 50000 }, async t => {
  const { socket } = await bootServer(t, { chips: 20000, cardAlbum: {} });
  const pull = await emitWithAck(socket, 'card_gacha_pull', {});
  assert.equal(pull.ok, true, JSON.stringify(pull));
  assert.equal(pull.duplicate, false);
  assert.equal(pull.refundChips, 0);
  assert.equal(pull.profile.chips, 20000 - CARD_GACHA_COST);
  assert.equal(pull.profile.transactions[0].amount, -CARD_GACHA_COST);
  assert.equal(pull.profile.transactions[0].reason, 'Cápsula de cartas');
  assert.equal(pull.profile.transactions.length, 1, 'la primera copia no registra abono');
});

test('repetida: abona 100 fichas, cobro y abono son movimientos separados y el saldo cuadra', { timeout: 50000 }, async t => {
  const start = 20000;
  const { socket } = await bootServer(t, { chips: start, cardAlbum: fullAlbum() });
  // Con el álbum completo, cada cápsula es repetida (no depende del azar).
  const first = await emitWithAck(socket, 'card_gacha_pull', {});
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.duplicate, true);
  assert.equal(first.refundChips, CARD_DUPLICATE_CHIPS);
  assert.equal(first.profile.chips, start - CARD_GACHA_COST + CARD_DUPLICATE_CHIPS);

  const second = await emitWithAck(socket, 'card_gacha_pull', {});
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.refundChips, CARD_DUPLICATE_CHIPS);
  assert.equal(second.profile.chips, start - 2 * CARD_GACHA_COST + 2 * CARD_DUPLICATE_CHIPS);

  // Historial: dos cobros y dos abonos, cada uno como movimiento propio.
  const reasons = second.profile.transactions.map(entry => `${entry.reason}:${entry.amount}`);
  assert.equal(reasons.filter(reason => reason.startsWith('Cápsula de cartas:')).length, 2);
  assert.equal(reasons.filter(reason => reason.startsWith('Carta repetida: ')).length, 2);
  assert.ok(reasons.includes(`Cápsula de cartas:${-CARD_GACHA_COST}`));
  assert.ok(reasons.includes(`Carta repetida: ${second.card.name}:${CARD_DUPLICATE_CHIPS}`));
});

test('sin fichas suficientes no hay cobro ni abono', { timeout: 50000 }, async t => {
  const { socket } = await bootServer(t, { chips: CARD_GACHA_COST - 1, cardAlbum: fullAlbum() });
  const denied = await emitWithAck(socket, 'card_gacha_pull', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.refundChips, undefined);
  assert.equal(denied.error, `Necesitas ${CARD_GACHA_COST} fichas para abrir una cápsula.`);
});
