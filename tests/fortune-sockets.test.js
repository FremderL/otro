'use strict';

// Integración real de la Rueda de la Fortuna: se levanta server.js en un
// proceso aparte con su diario transaccional y se juega por Socket.IO.
// Comprueba que la Rueda ya está disponible sin la vista insegura, el cobro y
// el pago del sector, la devolución al salir antes del resultado y la
// recuperación tras una caída del proceso.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
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

function startServer(port, env) {
  const output = { text: '' };
  const child = fork(path.join(__dirname, '..', 'server.js'), [], {
    env: {
      ...process.env,
      PORT: String(port),
      FOOTBALL_ENABLED: 'off',
      ADMIN_FEATURE_ENABLED: 'off',
      AUTO_BOTS: 'off',
      LOG_JSON: 'off',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.on('data', chunk => { output.text += chunk.toString(); });
  child.stderr.on('data', chunk => { output.text += chunk.toString(); });
  return { child, output };
}

function waitForServer(child, output, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (output.text.includes('MonteCristo lista en')) return resolve();
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
    const onOutput = () => { if (output.text.includes('MonteCristo lista en')) finish(); };
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
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('Tiempo agotado conectando a la mesa.')); }, 8000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', error => { clearTimeout(timer); socket.disconnect(); reject(error); });
  });
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta del servidor para ${event}`)), 8000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}

// La mesa publica `room_state` en cada acción; el test guarda el último
// snapshot y espera a que cumpla la condición (no hay evento de consulta).
function trackRoom(socket) {
  const state = { latest: null };
  socket.on('room_state', room => { state.latest = room; });
  state.waitFor = (predicate, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (state.latest && predicate(state.latest)) {
        clearInterval(timer);
        resolve(state.latest);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Tiempo agotado esperando el estado de la mesa. Último: ${JSON.stringify(state.latest?.phase)}`));
      }
    }, 40);
  });
  return state;
}

// Espera a que el archivo de perfiles se estabilice (el guardado del casino es
// diferido ~180 ms) y devuelve el saldo ya persistido.
async function stableChips(filePath, profileId, timeoutMs = 5000) {
  const started = Date.now();
  let previous = null;
  let stableSince = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 120));
    const current = readProfiles(filePath).get(profileId)?.chips ?? null;
    if (current !== null && current === previous) {
      if (Date.now() - stableSince >= 240) return current;
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }
  return previous;
}

function readProfiles(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return new Map((data.profiles || []).map(profile => [profile.id, profile]));
}

async function stopServer(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000);
    entry.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { entry.child.kill('SIGTERM'); } catch (_) { clearTimeout(timer); resolve(); }
  });
}

function tempPaths(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fortune-sockets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    profiles: path.join(directory, 'profiles.json'),
    ledger: path.join(directory, 'fortune-ledger.json')
  };
}

test('la Rueda está disponible y liquida el sector elegido con pago total', { timeout: 60000 }, async t => {
  const paths = tempPaths(t);
  const port = await reservePort();
  const entry = startServer(port, {
    PROFILE_STORE_PATH: paths.profiles, FORTUNE_STATE_PATH: paths.ledger, NODE_ENV: 'production'
  });
  let socket;
  t.after(async () => { socket?.disconnect(); await stopServer(entry); });
  await waitForServer(entry.child, entry.output);

  // En producción, sin ninguna variable de vista previa insegura.
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json());
  assert.equal(health.fortuneEnabled, true);

  socket = await connectSocket(port, 'rueda-ana');
  const tracked = trackRoom(socket);
  const created = await emitAck(socket, 'create_room', { token: 'rueda-ana', name: 'Ana', game: 'fortune', avatar: 'fox', tos: TOS_VERSION });
  assert.equal(created.ok, true, JSON.stringify(created));

  const betting = await tracked.waitFor(room => room.game === 'fortune' && room.phase === 'betting');
  assert.equal(betting.viewerProfile.chips, 1000);

  const bet = await emitAck(socket, 'quick_bet', { amount: 100, choice: '5' });
  assert.equal(bet.ok, true, JSON.stringify(bet));
  const betPlaced = await tracked.waitFor(room => room.players.some(player => player.bet === 100));
  assert.equal(betPlaced.viewerProfile.chips, 900);

  const resolve = await emitAck(socket, 'quick_resolve', {});
  assert.equal(resolve.ok, true, JSON.stringify(resolve));
  const room = await tracked.waitFor(candidate => candidate.phase === 'results' && candidate.quickResult);
  const result = room.quickResult;
  assert.ok([1, 2, 5, 10, 20, 40].includes(result.value));
  const record = room.results.find(row => row.name === 'Ana');
  assert.ok(record, 'la apuesta aparece en los resultados');
  const expectedPayout = result.value === 5 ? 100 * 6 : 0;
  assert.equal(record.payout, expectedPayout);
  assert.equal(record.amount, expectedPayout - 100);
  assert.equal(room.specialEvent, null, 'la Rueda no tiene eventos especiales');

  // El diario y el perfil quedan consistentes: 1000 - 100 + premio.
  const profiles = readProfiles(paths.profiles);
  const ana = profiles.get('rueda-ana');
  assert.ok(ana);
  const prize = ana.transactions.find(item => item.reason === 'Rueda de la Fortuna: premio');
  if (expectedPayout > 0) assert.equal(prize.amount, expectedPayout);
  else assert.equal(prize, undefined);
  assert.equal(ana.gameStats.fortune.rounds, 1);
  assert.equal(ana.gameStats.fortune.net, expectedPayout - 100);

  const ledger = JSON.parse(fs.readFileSync(paths.ledger, 'utf8'));
  const rounds = Object.values(ledger.rounds);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].status, 'paid');
  assert.equal(rounds[0].result.value, result.value);
});

test('salir antes del resultado devuelve la apuesta y no paga nada', { timeout: 60000 }, async t => {
  const paths = tempPaths(t);
  const port = await reservePort();
  const entry = startServer(port, { PROFILE_STORE_PATH: paths.profiles, FORTUNE_STATE_PATH: paths.ledger });
  const sockets = [];
  t.after(async () => { for (const item of sockets) item.disconnect(); await stopServer(entry); });
  await waitForServer(entry.child, entry.output);

  const host = await connectSocket(port, 'rueda-host');
  sockets.push(host);
  const created = await emitAck(host, 'create_room', { token: 'rueda-host', name: 'Host', game: 'fortune', tos: TOS_VERSION });
  assert.equal(created.ok, true);
  const code = created.code;
  await new Promise(resolve => setTimeout(resolve, 200));

  const guest = await connectSocket(port, 'rueda-guest');
  sockets.push(guest);
  const joined = await emitAck(guest, 'join_room', { token: 'rueda-guest', name: 'Invitada', code, tos: TOS_VERSION });
  assert.equal(joined.ok, true, JSON.stringify(joined));

  const bet = await emitAck(guest, 'quick_bet', { amount: 250, choice: '10' });
  assert.equal(bet.ok, true, JSON.stringify(bet));
  await new Promise(resolve => setTimeout(resolve, 250));
  // El saldo puede subir por logros/retos del casino; lo que importa es que la
  // devolución compense exactamente las 250 fichas apostadas. El débito no crea
  // transacción propia (igual que en las demás mesas), la devolución sí.
  const chipsAfterBet = await stableChips(paths.profiles, 'rueda-guest');
  assert.ok(Number.isInteger(chipsAfterBet) && chipsAfterBet <= 1000);

  // Se retira antes del resultado: se le devuelve la apuesta.
  const left = await emitAck(guest, 'leave_room', {});
  assert.equal(left.ok, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  const guestProfile = readProfiles(paths.profiles).get('rueda-guest');
  assert.equal(guestProfile.chips, chipsAfterBet + 250);
  const refunds = guestProfile.transactions.filter(item => item.reason === 'Rueda de la Fortuna: devolución');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount, 250);

  // La mesa sigue viva para el anfitrión; sin apuestas no hay nada que lanzar.
  const resolved = await emitAck(host, 'quick_resolve', {});
  assert.equal(resolved.ok, false, 'nadie más apostó: no hay ronda que lanzar');
  const state = readProfiles(paths.profiles).get('rueda-host');
  assert.equal(state.transactions.filter(item => item.reason === 'Rueda de la Fortuna: premio').length, 0);
});

test('tras una caída del proceso, la apuesta sin resultado se devuelve al arrancar', { timeout: 90000 }, async t => {
  const paths = tempPaths(t);
  const port = await reservePort();
  let entry = startServer(port, { PROFILE_STORE_PATH: paths.profiles, FORTUNE_STATE_PATH: paths.ledger });
  let socket;
  t.after(async () => { socket?.disconnect(); await stopServer(entry); });
  await waitForServer(entry.child, entry.output);

  socket = await connectSocket(port, 'rueda-crash');
  const created = await emitAck(socket, 'create_room', { token: 'rueda-crash', name: 'Ana', game: 'fortune', tos: TOS_VERSION });
  assert.equal(created.ok, true);
  const bet = await emitAck(socket, 'quick_bet', { amount: 300, choice: '20' });
  assert.equal(bet.ok, true, JSON.stringify(bet));
  await new Promise(resolve => setTimeout(resolve, 300));
  const chipsAfterBet = await stableChips(paths.profiles, 'rueda-crash');
  assert.equal(JSON.parse(fs.readFileSync(paths.ledger, 'utf8')).rounds[Object.keys(JSON.parse(fs.readFileSync(paths.ledger, 'utf8')).rounds)[0]].status, 'open');

  // Caída sin liquidar: la mesa vive en memoria y desaparece.
  socket.disconnect();
  socket = null;
  await stopServer(entry);
  entry.child.kill('SIGKILL');

  const restarted = startServer(port, { PROFILE_STORE_PATH: paths.profiles, FORTUNE_STATE_PATH: paths.ledger });
  entry = restarted;
  await waitForServer(restarted.child, restarted.output);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json());
  assert.equal(health.fortuneEnabled, true);

  const profile = readProfiles(paths.profiles).get('rueda-crash');
  assert.equal(profile.chips, chipsAfterBet + 300, 'la apuesta sin resultado se devuelve al reiniciar');
  const refunds = profile.transactions.filter(item => item.reason === 'Rueda de la Fortuna: devolución');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount, 300);
  const ledger = JSON.parse(fs.readFileSync(paths.ledger, 'utf8'));
  assert.equal(Object.values(ledger.rounds)[0].status, 'refunded');
  assert.match(restarted.output.text, /MonteCristo lista en/, 'el casino vuelve a abrir con la Rueda activa');
});

test('con FORTUNE_ENABLED=off la Rueda se mantiene pausada', { timeout: 40000 }, async t => {
  const paths = tempPaths(t);
  const port = await reservePort();
  const entry = startServer(port, {
    PROFILE_STORE_PATH: paths.profiles, FORTUNE_STATE_PATH: paths.ledger, FORTUNE_ENABLED: 'off'
  });
  let socket;
  t.after(async () => { socket?.disconnect(); await stopServer(entry); });
  await waitForServer(entry.child, entry.output);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json());
  assert.equal(health.fortuneEnabled, false);
  socket = await connectSocket(port, 'rueda-off');
  const attempt = await emitAck(socket, 'create_room', { token: 'rueda-off', name: 'Ana', game: 'fortune', tos: TOS_VERSION });
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /no está disponible/i);
});
