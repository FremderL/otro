'use strict';

// Integración real: se levanta server.js en un proceso aparte (con archivos de
// estado temporales y una inscripción corta) y tres dispositivos juegan una
// ronda completa de Lotería por Socket.IO. Comprueba cobro, reembolso, canto,
// bote, privacidad del cartón y pagos exactos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { io } = require('socket.io-client');
const { TOS_VERSION } = require('../lib/terms');

const ENTRY = 50;
const REGISTRATION_MS = 12000;
const CALL_INTERVAL_MS = 30;

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

function waitForServer(child, output, timeoutMs = 20000) {
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
      reject(new Error('Tiempo agotado conectando a la Lotería.'));
    }, 8000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', error => { clearTimeout(timer); socket.disconnect(); reject(error); });
  });
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta del servidor para ${event}`)), 8000);
    socket.emit(event, payload, response => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForState(socket, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('loteria_state', onState);
      reject(new Error('Tiempo agotado esperando el estado de la Lotería.'));
    }, timeoutMs);
    const onState = snapshot => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      socket.off('loteria_state', onState);
      resolve(snapshot);
    };
    socket.on('loteria_state', onState);
  });
}

function readProfiles(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return new Map((data.profiles || []).map(profile => [profile.id, profile]));
}

test('sala real: cobro, reembolso antes del cierre, canto automático y reparto exacto', { timeout: 90000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loteria-sockets-'));
  const profilePath = path.join(directory, 'profiles.json');
  const loteriaPath = path.join(directory, 'loteria.json');
  const port = await reservePort();
  const output = { text: '' };
  const child = fork(path.join(__dirname, '..', 'server.js'), [], {
    env: {
      ...process.env,
      PORT: String(port),
      PROFILE_STORE_PATH: profilePath,
      LOTERIA_STATE_PATH: loteriaPath,
      LOTERIA_REGISTRATION_MS: String(REGISTRATION_MS),
      LOTERIA_CALL_INTERVAL_MS: String(CALL_INTERVAL_MS),
      LOTERIA_BREAK_MS: '1500',
      FOOTBALL_ENABLED: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    child.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForServer(child, output);

  try {
  const alice = await connectSocket(port, 'alice-device');
  const bob = await connectSocket(port, 'bob-device');
  const carol = await connectSocket(port, 'carol-device');
  sockets.push(alice, bob, carol);

  const aliceSub = await emitAck(alice, 'loteria_subscribe');
  assert.equal(aliceSub.ok, true);
  assert.equal(aliceSub.cards.length, 54);
  assert.equal(aliceSub.cards[0].number, 1);
  assert.equal(aliceSub.state.entryCost, ENTRY);

  const publicStates = [];
  alice.on('loteria_state', snapshot => publicStates.push(snapshot));

  // Carol entra y sale antes del cierre: se le devuelve la entrada.
  const carolJoin = await emitAck(carol, 'loteria_join', { name: 'Carol', avatar: 'owl', tos: TOS_VERSION });
  assert.equal(carolJoin.ok, true);
  assert.equal(carolJoin.you.chips, 1000 - ENTRY);
  assert.equal(carolJoin.you.board.length, 16);
  const carolLeave = await emitAck(carol, 'loteria_leave');
  assert.equal(carolLeave.ok, true);
  assert.equal(carolLeave.refunded, true);
  assert.equal(carolLeave.you.chips, 1000);
  assert.equal(carolLeave.state.game.count, 0);

  const aliceJoin = await emitAck(alice, 'loteria_join', { name: 'Ana', avatar: 'fox', tos: TOS_VERSION });
  assert.equal(aliceJoin.ok, true);
  const bobJoin = await emitAck(bob, 'loteria_join', { name: 'Beto', avatar: 'panda', tos: TOS_VERSION });
  assert.equal(bobJoin.ok, true);
  assert.equal(aliceJoin.you.chips, 1000 - ENTRY);
  assert.notDeepEqual(aliceJoin.you.board, bobJoin.you.board);

  // El servidor cierra la inscripción y canta cartas solo.
  const settled = await waitForState(alice, snapshot => snapshot.game && (snapshot.game.status === 'settled' || snapshot.game.status === 'cancelled'), 45000);
  assert.equal(settled.game.status, 'settled', `la ronda debía resolverse con dos cartones. Servidor:\n${output.text}`);
  assert.equal(settled.game.count, 2);
  assert.equal(settled.game.result.pot, ENTRY * 2);
  assert.ok(settled.game.called.length >= 16 && settled.game.called.length <= 54);
  assert.equal(new Set(settled.game.called).size, settled.game.called.length, 'no se repiten cartas');
  const winners = settled.game.result.winners;
  assert.ok(winners.length >= 1);
  const paid = winners.reduce((sum, winner) => sum + winner.amount, 0);
  assert.equal(paid + settled.game.result.carry, ENTRY * 2);
  assert.equal(settled.game.board, null, 'el estado difundido no lleva el cartón de nadie');

  // Todo estado público mantiene la privacidad de los cartones.
  for (const snapshot of publicStates) {
    assert.ok(!JSON.stringify(snapshot).includes('profileId'));
    if (snapshot.game && snapshot.game.status !== 'settled') assert.equal(snapshot.game.board, null);
  }

  const profiles = readProfiles(profilePath);
  const aliceProfile = profiles.get('alice-device');
  const bobProfile = profiles.get('bob-device');
  assert.ok(aliceProfile && bobProfile);
  // Cada premio se acredita exactamente una vez y por el importe repartido.
  const prizesByName = new Map(winners.map(winner => [winner.name, winner.amount]));
  const alicePrize = aliceProfile.transactions.find(item => item.reason === 'Lotería mexicana: premio');
  const bobPrize = bobProfile.transactions.find(item => item.reason === 'Lotería mexicana: premio');
  assert.equal(alicePrize ? alicePrize.amount : 0, prizesByName.get('Ana') || 0);
  assert.equal(bobPrize ? bobPrize.amount : 0, prizesByName.get('Beto') || 0);
  assert.equal(
    aliceProfile.transactions.filter(item => item.reason === 'Lotería mexicana: premio').length,
    prizesByName.has('Ana') ? 1 : 0
  );
  // El saldo solo puede crecer por los premios y por los logros normales del
  // casino, nunca por un segundo pago de la ronda.
  assert.ok(aliceProfile.chips >= 1000 - ENTRY + (prizesByName.get('Ana') || 0));
  assert.ok(bobProfile.chips >= 1000 - ENTRY + (prizesByName.get('Beto') || 0));
  // Los dos perfiles registran la ronda en sus estadísticas, con o sin premio.
  assert.equal(aliceProfile.gameStats.loteria.rounds, 1);
  assert.equal(bobProfile.gameStats.loteria.rounds, 1);
  assert.equal(aliceProfile.gameStats.loteria.net + bobProfile.gameStats.loteria.net, -ENTRY * 2 + paid);

  // La sala abre la siguiente ronda tras el descanso y conserva el acumulado.
  const nextRound = await waitForState(alice, snapshot => snapshot.game && snapshot.game.status === 'registration', 12000);
  assert.equal(nextRound.game.carry, settled.game.result.carry);
  assert.equal(nextRound.game.count, 0);
  assert.notEqual(nextRound.game.id, settled.game.id);
  } catch (error) {
    console.error('SALIDA DEL SERVIDOR:\n' + output.text);
    throw error;
  }
});
