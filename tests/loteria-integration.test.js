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

function startServer(port, tempDir, output) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      PROFILE_STORE_PATH: path.join(tempDir, 'profiles.json'),
      LOBBY_TOURNAMENT_STORE_PATH: path.join(tempDir, 'tournaments.json'),
      LOTERIA_STORE_PATH: path.join(tempDir, 'lotería.json'),
      LOTERIA_REGISTRATION_MS: '4000',
      LOTERIA_CALL_INTERVAL_MS: '120',
      LOTERIA_INTERMISSION_MS: '1500',
      ADMIN_FEATURE_ENABLED: 'off',
      FOOTBALL_ENABLED: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tiempo agotado esperando al servidor.\n${output.text}`)), 15000);
    const onOutput = chunk => {
      output.text += chunk.toString();
      if (output.text.includes('MonteCristo lista en')) {
        clearTimeout(timer);
        child.stdout.off('data', onOutput);
        child.stderr.off('data', onOutput);
        resolve();
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`El servidor terminó antes de iniciar (código ${code}).\n${output.text}`));
    });
  });
  // El rechazo por salida también llega cuando *nosotros* matamos el proceso ya
  // arrancado; para entonces la promesa ya resolvió y esto es inocuo.
  return { child, ready: ready.catch(error => { if (child.exitCode !== null && output.text.includes('MonteCristo lista en')) return; throw error; }) };
}

async function stopServer(child, signal = 'SIGKILL') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(signal);
  await exited;
}

function connectSocket(port, deviceToken) {
  const socket = io(`http://127.0.0.1:${port}`, {
    auth: { deviceToken },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('Tiempo agotado conectando.')); }, 6000);
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function snapshotOf(socket) {
  const response = await emitWithAck(socket, 'loteria_get', {});
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.snapshot;
}

async function waitRegistration(socket, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await snapshotOf(socket);
    if (snapshot.game?.status === 'registration') return snapshot;
    await sleep(200);
  }
  throw new Error('No abrió ninguna ventana de inscripción a tiempo.');
}

test('lotería compartida: inscripción, reembolso, caída del proceso y liquidación sin duplicar', { timeout: 90000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monte-loteria-'));
  const port = await reservePort();
  const output = { text: '' };
  const sockets = [];
  let server = startServer(port, tempDir, output);
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await stopServer(server.child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  await server.ready;

  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.loteriaEnabled, true);

  const suffix = Date.now().toString().slice(-6);
  let ana = await connectSocket(port, `lotería-ana-${suffix}`);
  let beto = await connectSocket(port, `lotería-beto-${suffix}`);
  sockets.push(ana, beto);

  await waitRegistration(ana);
  const joinAna = await emitWithAck(ana, 'loteria_join', {
    name: `Ana${suffix}`, avatar: 'fox', tos: TOS_VERSION, requestId: `ana-req-${suffix}-1`
  });
  assert.equal(joinAna.ok, true, JSON.stringify(joinAna));
  assert.equal(joinAna.profile.chips, 950);
  assert.equal(joinAna.snapshot.game.board.length, 16);
  const gameId = joinAna.snapshot.game.id;
  const anaBoard = joinAna.snapshot.game.board;

  const retryAna = await emitWithAck(ana, 'loteria_join', {
    name: `Ana${suffix}`, avatar: 'fox', tos: TOS_VERSION, requestId: `ana-req-${suffix}-1`
  });
  assert.equal(retryAna.ok, true, JSON.stringify(retryAna));
  assert.equal(retryAna.code, 'already_joined');
  assert.equal(retryAna.profile.chips, 950, 'el reintento idempotente no cobra dos veces');

  const joinBeto = await emitWithAck(beto, 'loteria_join', {
    name: `Beto${suffix}`, avatar: 'owl', tos: TOS_VERSION, requestId: `beto-req-${suffix}-1`
  });
  assert.equal(joinBeto.ok, true, JSON.stringify(joinBeto));
  assert.equal(joinBeto.snapshot.game.count, 2);
  assert.equal(joinBeto.snapshot.game.pot, 100);

  // Beto se arrepiente antes del cierre: reembolso exacto y puede volver con
  // una solicitud nueva (la anterior queda quemada a propósito).
  const leaveBeto = await emitWithAck(beto, 'loteria_leave', {});
  assert.equal(leaveBeto.ok, true, JSON.stringify(leaveBeto));
  assert.equal(leaveBeto.profile.chips, 1000);
  const reuseBeto = await emitWithAck(beto, 'loteria_join', {
    name: `Beto${suffix}`, avatar: 'owl', tos: TOS_VERSION, requestId: `beto-req-${suffix}-1`
  });
  assert.equal(reuseBeto.ok, false);
  assert.equal(reuseBeto.code, 'cancelled_request');
  const rejoinBeto = await emitWithAck(beto, 'loteria_join', {
    name: `Beto${suffix}`, avatar: 'owl', tos: TOS_VERSION, requestId: `beto-req-${suffix}-2`
  });
  assert.equal(rejoinBeto.ok, true, JSON.stringify(rejoinBeto));
  assert.equal(rejoinBeto.profile.chips, 950);
  assert.equal(rejoinBeto.snapshot.game.id, gameId);

  // Caída dura del proceso (sin apagado limpio) con dos cartones pagados.
  await stopServer(server.child, 'SIGKILL');
  for (const socket of sockets) socket.disconnect();
  sockets.length = 0;
  output.text = '';
  server = startServer(port, tempDir, output);
  await server.ready;

  ana = await connectSocket(port, `lotería-ana-${suffix}`);
  beto = await connectSocket(port, `lotería-beto-${suffix}`);
  sockets.push(ana, beto);
  const recovered = await snapshotOf(ana);
  assert.equal(recovered.game.id, gameId, 'la misma partida sobrevive a la caída');
  assert.deepEqual(recovered.game.board, anaBoard, 'Ana conserva su cartón');
  assert.equal(recovered.game.count, 2, 'nadie pierde su inscripción por el reinicio');

  // La partida avanza por reloj: puede liquidarse sola poco después.
  const finalStates = new Map();
  ana.on('loteria_state', snapshot => finalStates.set('ana', snapshot));
  beto.on('loteria_state', snapshot => finalStates.set('beto', snapshot));
  await snapshotOf(beto); // suscribe también a beto a las difusiones
  const deadline = Date.now() + 30000;
  let settled = null;
  while (Date.now() < deadline) {
    const candidate = finalStates.get('ana') || await snapshotOf(ana);
    if (candidate.game.id === gameId && (candidate.game.status === 'settled' || candidate.game.status === 'cancelled')) {
      settled = candidate;
      break;
    }
    await sleep(250);
  }
  assert.ok(settled, 'la partida debe terminar tras la recuperación');
  assert.equal(settled.game.status, 'settled', JSON.stringify(settled.game));

  const anaFinal = await snapshotOf(ana);
  const betoFinal = await snapshotOf(beto);
  const anaPayout = anaFinal.game.id === gameId ? anaFinal.game.result.myPayout : settled.game.result.myPayout;
  const betoPayout = betoFinal.game.id === gameId ? betoFinal.game.result.myPayout : null;
  assert.ok(anaPayout > 0 || betoPayout > 0, 'alguien ganó el bote');
  assert.equal((anaPayout || 0) + (betoPayout || 0) + settled.game.result.carry, settled.game.result.pot,
    'premios + sobrante = bote exacto');

  // En el archivo de perfiles, cada quien tiene UNA sola liquidación de la
  // partida y el neto correcto (premio − entrada), sin dobles pagos.
  const saved = JSON.parse(fs.readFileSync(path.join(tempDir, 'profiles.json'), 'utf8'));
  const byName = new Map(saved.profiles.map(profile => [profile.name, profile]));
  for (const [name, payout] of [[`Ana${suffix}`, anaPayout], [`Beto${suffix}`, betoPayout]]) {
    const profile = byName.get(name);
    assert.ok(profile, `perfil de ${name}`);
    const outcomes = profile.transactions.filter(tx => String(tx.operationId || '').startsWith('loteria:outcome:'));
    assert.equal(outcomes.length, 1, `${name}: una sola transacción de liquidación`);
    assert.equal(outcomes[0].amount, (payout || 0) - 50, `${name}: neto = premio − 50`);
    assert.equal(profile.gameStats.loteria.rounds, 1);
    assert.ok(profile.chips >= 950 + (payout || 0), `${name}: el premio llegó a su saldo`);
    if (!payout) assert.equal(profile.chips, 950, `${name}: quien pierde se queda en 950`);
  }

  // Y el ciclo sigue: tras el intermedio abre la siguiente partida.
  const next = await waitRegistration(ana);
  assert.notEqual(next.game.id, gameId);
  assert.equal(next.game.count, 0);
});
