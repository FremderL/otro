'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
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
      reject(new Error('Tiempo agotado conectando al torneo.'));
    }, 7000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', error => { clearTimeout(timer); socket.disconnect(); reject(error); });
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin confirmación del evento ${event}.`)), 6000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}

function waitFor(predicate, message, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      let result;
      try { result = predicate(); } catch (error) { reject(error); return; }
      if (result) { resolve(result); return; }
      if (Date.now() >= deadline) { reject(new Error(message)); return; }
      setTimeout(check, 20);
    };
    check();
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exitedCleanly = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 3500);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
    child.kill('SIGTERM');
  });
  if (!exitedCleanly && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

test('el bracket crea mesas reales 1v1 con stack separado, bloquea Sit & Go/bots y resuelve un all-in', { timeout: 60000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bracket-integration-'));
  const clockPreload = path.join(tempDir, 'test-clock.cjs');
  fs.writeFileSync(clockPreload, `
    'use strict';
    let now = Number(process.env.TEST_CLOCK_INITIAL);
    Date.now = () => now;
    process.on('message', message => {
      if (message?.type === 'set-test-clock' && Number.isFinite(Number(message.now))) now = Number(message.now);
    });
  `);
  const profilePath = path.join(tempDir, 'profiles.json');
  const port = await reservePort();
  const initialTime = Date.parse('2026-10-12T17:00:00Z');
  const output = { text: '' };
  const child = fork(path.resolve(__dirname, '..', 'server.js'), [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port), DATABASE_URL: '', PROFILE_STORE_PATH: profilePath,
      ADMIN_FEATURE_ENABLED: 'off', FOOTBALL_ENABLED: 'off', PASSPORT_ENABLED: 'off',
      AUTO_BOTS: 'off', LOG_JSON: 'off', TEST_CLOCK_INITIAL: String(initialTime)
    },
    execArgv: ['--require', clockPreload],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const sockets = [];
  const roomStates = new Map();
  let stopped = false;
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    if (!stopped) await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child, output);
  for (let index = 0; index < 8; index++) {
    const socket = await connectSocket(port, `bracket-${index + 1}`);
    socket.on('room_state', room => roomStates.set(socket.id, room));
    sockets.push(socket);
  }
  const calendar = await emitWithAck(sockets[0], 'lobby_tournaments_get', {});
  assert.equal(calendar.ok, true, JSON.stringify(calendar));
  const tournament = calendar.snapshot.tournaments.find(event => !event.featured && event.capacity === 8 && event.status === 'registration');
  assert.ok(tournament, 'hay un torneo de 8 plazas en el calendario');
  for (let index = 0; index < sockets.length; index++) {
    const response = await emitWithAck(sockets[index], 'lobby_tournament_register', {
      tournamentId: tournament.id, name: `Bracket ${index + 1}`, avatar: 'fox', tos: TOS_VERSION
    });
    assert.equal(response.ok, true, JSON.stringify(response));
  }

  child.send({ type: 'set-test-clock', now: tournament.startAt });
  const matches = await waitFor(() => {
    const live = [...roomStates.values()].filter(room => room.lobbyTournamentMatch?.tournamentId === tournament.id
      && room.lobbyTournamentMatch.status === 'playing');
    return live.length === 8 ? live : null;
  }, 'El servidor no creó las cuatro mesas del bracket.');
  const uniqueMatches = new Map(matches.map(room => [room.lobbyTournamentMatch.matchId, room]));
  assert.equal(uniqueMatches.size, 4);
  for (const room of uniqueMatches.values()) {
    assert.equal(room.game, 'poker');
    assert.equal(room.players.length, 2);
    assert.equal(room.tournament, null, 'un bracket no activa el Sit & Go de mesa');
    assert.ok(room.players.every(player => !player.isBot), 'los encuentros no admiten bots');
    assert.ok(room.players.every(player => player.chips + player.totalBet === 1000), 'cada asiento recibe 1.000 fichas de torneo');
    assert.equal(room.viewerProfile.chips, 1000, 'el saldo personal permanece intacto');
  }

  const firstMatch = [...uniqueMatches.values()].find(room => room.players.some(player => player.isHost));
  const participantProfileIds = firstMatch.players.map(player => player.id);
  const hostId = firstMatch.players.find(player => player.isHost).id;
  const hostSocket = sockets.find(socket => roomStates.get(socket.id)?.viewerId === hostId);
  assert.ok(hostSocket);
  const sitAndGoAttempt = await emitWithAck(hostSocket, 'tournament_start', {});
  assert.equal(sitAndGoAttempt.ok, false);
  assert.match(sitAndGoAttempt.error, /bracket del lobby/u);
  const botAttempt = await emitWithAck(hostSocket, 'bot_add', { difficulty: 'normal', style: 'balanced' });
  assert.equal(botAttempt.ok, false);
  assert.match(botAttempt.error, /no admiten bots/u);

  const matchId = firstMatch.lobbyTournamentMatch.matchId;
  let finishedRoom = null;
  let lastHandNumber = 0;
  for (let hand = 0; hand < 5; hand++) {
    let state = await waitFor(() => {
      const latest = roomStates.get(hostSocket.id);
      return latest?.lobbyTournamentMatch?.matchId === matchId ? latest : null;
    }, 'No se recibió el estado de la mesa del bracket.');
    if (state.lobbyTournamentMatch.status === 'completed') { finishedRoom = state; break; }
    if (state.phase === 'showdown') {
      lastHandNumber = state.handNumber;
      const nextHand = await emitWithAck(hostSocket, 'poker_start', {});
      assert.equal(nextHand.ok, true, JSON.stringify(nextHand));
      state = await waitFor(() => {
        const latest = roomStates.get(hostSocket.id);
        return latest?.lobbyTournamentMatch?.matchId === matchId && latest.handNumber > lastHandNumber ? latest : null;
      }, 'El siguiente all-in no pudo iniciar.');
    }
    for (let actionIndex = 0; actionIndex < 2; actionIndex++) {
      const roomForTurn = await waitFor(() => {
        const latest = roomStates.get(hostSocket.id);
        return latest?.lobbyTournamentMatch?.matchId === matchId && (latest.turnId || latest.phase === 'showdown') ? latest : null;
      }, 'No llegó el turno de póker.');
      if (roomForTurn.phase === 'showdown' || roomForTurn.lobbyTournamentMatch.status === 'completed') {
        state = roomForTurn;
        break;
      }
      const actingId = roomForTurn.turnId;
      const actor = sockets.find(socket => roomStates.get(socket.id)?.viewerId === actingId);
      assert.ok(actor, 'el turno pertenece a uno de los inscritos');
      const player = roomForTurn.players.find(item => item.id === actingId);
      const action = player.roundBet < roomForTurn.currentBet ? 'call' : 'allin';
      const response = await emitWithAck(actor, 'poker_action', { action });
      assert.equal(response.ok, true, JSON.stringify(response));
      state = await waitFor(() => {
        const latest = roomStates.get(hostSocket.id);
        return latest?.lobbyTournamentMatch?.matchId === matchId
          && (latest.lobbyTournamentMatch.status === 'completed' || latest.phase === 'showdown' || latest.turnId !== actingId) ? latest : null;
      }, 'La acción all-in no avanzó el turno.');
      if (state.phase === 'showdown' || state.lobbyTournamentMatch.status === 'completed') break;
    }
    if (state.lobbyTournamentMatch.status === 'completed') { finishedRoom = state; break; }
  }
  assert.ok(finishedRoom, 'el encuentro se completó en un máximo de cuatro manos all-in');
  assert.ok(finishedRoom.lobbyTournamentMatch.winnerName);
  assert.equal(finishedRoom.lobbyTournamentMatch.forfeit, false);
  const finalStates = new Map();
  for (const profileId of participantProfileIds) {
    const participantSocket = sockets.find(socket => roomStates.get(socket.id)?.viewerId === profileId);
    assert.ok(participantSocket);
    finalStates.set(profileId, await waitFor(() => {
      const latest = roomStates.get(participantSocket.id);
      return latest?.lobbyTournamentMatch?.matchId === matchId && latest.lobbyTournamentMatch.status === 'completed' ? latest : null;
    }, 'Uno de los participantes no recibió el estado final.'));
  }
  const finalProfiles = new Map();
  for (const player of finishedRoom.players) {
    const viewerProfile = finalStates.get(player.id).viewerProfile;
    assert.equal(player.chips, viewerProfile.chips, 'al terminar, la sala vuelve a mostrar el saldo personal persistido');
    assert.ok(!viewerProfile.transactions.some(transaction => transaction.reason.startsWith('Premio virtual ·')),
      'una partida intermedia no paga los premios del torneo completo');
    finalProfiles.set(player.id, viewerProfile);
  }

  sockets.forEach(socket => socket.disconnect());
  sockets.length = 0;
  await stopServer(child);
  stopped = true;
  const persisted = new ProfileStore(profilePath, { deferSeasonCheck: true });
  for (const profileId of participantProfileIds) {
    const profile = persisted.getProfile(profileId);
    assert.equal(profile.chips, finalProfiles.get(profileId).chips, 'los premios normales del juego y el saldo quedaron persistidos');
    assert.ok(profile.stats.roundsPlayed >= 1, 'la mano real registra progreso válido del participante');
  }
});
