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

const INITIAL_CHIPS = 1000;
const INITIAL_TIME = Date.parse('2026-10-12T17:00:00Z');

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
      reject(new Error(`Tiempo agotado conectando al inscrito ${deviceToken}.`));
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

function waitFor(predicate, message, timeoutMs = 15000) {
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

function forcedRoyalBoardDeck() {
  const suits = ['S', 'H', 'D', 'C'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const allCards = suits.flatMap(suit => ranks.map(rank => `${rank}${suit}`));
  const dealOrder = ['2C', '3C', '4C', '5C', '10S', 'JS', 'QS', 'KS', 'AS'];
  return [...dealOrder, ...allCards.filter(card => !dealOrder.includes(card))];
}

async function startTournamentHarness(t, capacity, { pokerDeck, reconnectGraceMs = 90_000 } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-tournament-${capacity}-`));
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
  const tournamentStorePath = path.join(tempDir, 'lobby-tournaments.json');
  const port = await reservePort();
  const output = { text: '' };
  const child = fork(path.resolve(__dirname, '..', 'server.js'), [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port), DATABASE_URL: '', PROFILE_STORE_PATH: profilePath,
      LOBBY_TOURNAMENT_STORE_PATH: tournamentStorePath,
      ADMIN_FEATURE_ENABLED: 'off', FOOTBALL_ENABLED: 'off', PASSPORT_ENABLED: 'off',
      AUTO_BOTS: 'off', LOG_JSON: 'off', TEST_CLOCK_INITIAL: String(INITIAL_TIME),
      RECONNECT_GRACE_MS: String(reconnectGraceMs),
      ...(pokerDeck ? { TEST_POKER_DECK: JSON.stringify(pokerDeck) } : {})
    },
    execArgv: ['--require', clockPreload],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const harness = {
    capacity, child, output, port, profilePath, tournamentStorePath, clockPreload, tempDir, reconnectGraceMs, pokerDeck,
    tokens: Array.from({ length: capacity }, (_, index) => `flash-${capacity}-${index + 1}`),
    names: new Map(), currentSockets: new Map(), allSockets: [],
    roomStates: new Map(), tournamentSnapshots: new Map(), prizeEvents: new Map(),
    tournament: null, stopped: false
  };

  t.after(async () => {
    harness.allSockets.forEach(socket => socket.disconnect());
    if (!harness.stopped) await stopServer(harness.child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child, output);
  for (let index = 0; index < capacity; index++) {
    const token = harness.tokens[index];
    const name = `Relámpago ${capacity}-${index + 1}`;
    harness.names.set(token, name);
    harness.prizeEvents.set(token, []);
    const socket = await connectSocket(port, token);
    attachSocket(harness, token, socket);
  }

  const calendar = await emitWithAck(harness.currentSockets.get(harness.tokens[0]), 'lobby_tournaments_get', {});
  assert.equal(calendar.ok, true, JSON.stringify(calendar));
  const tournament = calendar.snapshot.tournaments.find(event => !event.featured
    && event.capacity === capacity && event.status === 'registration');
  assert.ok(tournament, `hay un torneo regular de ${capacity} plazas en el calendario`);
  harness.tournament = tournament;

  for (const token of harness.tokens) {
    const response = await emitWithAck(harness.currentSockets.get(token), 'lobby_tournament_register', {
      tournamentId: tournament.id, name: harness.names.get(token), avatar: 'fox', tos: TOS_VERSION
    });
    assert.equal(response.ok, true, JSON.stringify(response));
  }

  child.send({ type: 'set-test-clock', now: tournament.startAt });
  await waitFor(() => roundMatches(harness, 0), `No se iniciaron las mesas del torneo de ${capacity}.`);
  return harness;
}

async function restartTournamentHarness(harness, { alreadyStopped = false } = {}) {
  if (!alreadyStopped) await stopServer(harness.child);
  harness.allSockets.forEach(socket => socket.disconnect());
  harness.currentSockets.clear();
  harness.roomStates.clear();
  harness.tournamentSnapshots.clear();

  const output = { text: '' };
  const child = fork(path.resolve(__dirname, '..', 'server.js'), [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(harness.port), DATABASE_URL: '', PROFILE_STORE_PATH: harness.profilePath,
      LOBBY_TOURNAMENT_STORE_PATH: harness.tournamentStorePath,
      ADMIN_FEATURE_ENABLED: 'off', FOOTBALL_ENABLED: 'off', PASSPORT_ENABLED: 'off',
      AUTO_BOTS: 'off', LOG_JSON: 'off', TEST_CLOCK_INITIAL: String(INITIAL_TIME),
      RECONNECT_GRACE_MS: String(harness.reconnectGraceMs),
      ...(harness.pokerDeck ? { TEST_POKER_DECK: JSON.stringify(harness.pokerDeck) } : { TEST_POKER_DECK: '' })
    },
    execArgv: ['--require', harness.clockPreload],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  harness.child = child;
  harness.output = output;
  await waitForServer(child, output);
  for (const token of harness.tokens) {
    const socket = await connectSocket(harness.port, token);
    attachSocket(harness, token, socket);
  }
}

function attachSocket(harness, token, socket) {
  harness.currentSockets.set(token, socket);
  harness.allSockets.push(socket);
  socket.on('room_state', room => harness.roomStates.set(token, room));
  socket.on('lobby_tournaments_state', snapshot => harness.tournamentSnapshots.set(token, snapshot));
  socket.on('profile_event', event => harness.prizeEvents.get(token).push(event));
}

function roundMatches(harness, roundIndex) {
  const needed = harness.capacity >> (roundIndex + 1);
  const matches = new Map();
  for (const token of harness.tokens) {
    const room = harness.roomStates.get(token);
    const match = room?.lobbyTournamentMatch;
    if (match?.tournamentId === harness.tournament.id
        && match.roundIndex === roundIndex && match.status === 'playing') {
      matches.set(match.matchId, room);
    }
  }
  return matches.size === needed ? [...matches.values()] : null;
}

async function reconnectInMatch(harness, room, profileId) {
  const oldSocket = harness.currentSockets.get(profileId);
  const peerId = room.players.find(player => player.id !== profileId)?.id;
  assert.ok(peerId, 'la partida tiene un oponente para observar la desconexión');
  oldSocket.disconnect();
  await waitFor(() => harness.roomStates.get(peerId)?.players.find(player => player.id === profileId)?.connected === false,
    'la desconexión temporal no se reflejó en el estado de la mesa.');

  const socket = await connectSocket(harness.port, profileId);
  attachSocket(harness, profileId, socket);
  const result = await emitWithAck(socket, 'join_room', {
    name: harness.names.get(profileId), code: room.code, token: profileId, avatar: 'fox', tos: TOS_VERSION
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const restored = await waitFor(() => {
    const latest = harness.roomStates.get(profileId);
    const match = latest?.lobbyTournamentMatch;
    return match?.matchId === room.lobbyTournamentMatch.matchId && match.status === 'playing'
      && latest.players.some(player => player.id === profileId && player.connected) ? latest : null;
  }, 'el inscrito no recuperó su asiento antes del límite de reconexión.');
  assert.equal(restored.players.filter(player => player.id === profileId).length, 1,
    'reconectarse restaura el mismo asiento en vez de duplicarlo');
  return restored;
}

async function resolveMatchByForfeit(harness, room) {
  const matchId = room.lobbyTournamentMatch.matchId;
  const winnerId = room.players[0].id;
  const loserId = room.players[1].id;
  const loser = harness.currentSockets.get(loserId);
  const leave = await emitWithAck(loser, 'leave_room', {});
  assert.equal(leave.ok, true, JSON.stringify(leave));

  const completed = await waitFor(() => {
    const latest = harness.roomStates.get(winnerId);
    const match = latest?.lobbyTournamentMatch;
    return match?.matchId === matchId && match.status === 'completed' ? latest : null;
  }, `el encuentro ${matchId} no terminó por abandono.`);
  assert.equal(completed.lobbyTournamentMatch.forfeit, true);
  assert.equal(completed.lobbyTournamentMatch.winnerName, harness.names.get(winnerId));

  const winnerLeave = await emitWithAck(harness.currentSockets.get(winnerId), 'leave_room', {});
  assert.equal(winnerLeave.ok, true, JSON.stringify(winnerLeave));
  return { winnerId, loserId };
}

function prizeFor(event, place) {
  return event.prizeSchedule.find(item => item.place === place)?.prize || 0;
}

// Quienes caen en la misma ronda comparten puesto (3.º, 5.º, 9.º); el recibo
// del saldo lo dice explícitamente y el premio sigue siendo individual.
function placeLabelFor(place) {
  return [3, 5, 9].includes(place) ? `${place}.º puesto compartido` : `${place}.º puesto`;
}

function receiptReasonFor(tournamentName, place) {
  return `Premio virtual · ${tournamentName} · ${placeLabelFor(place)}`;
}

async function completeFullBracket(harness, { reconnectFirst = false } = {}) {
  const expectedPlacements = new Map();
  const rounds = Math.log2(harness.capacity);
  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    const matches = await waitFor(() => roundMatches(harness, roundIndex),
      `No se publicaron todas las mesas de la ronda ${roundIndex + 1}.`);
    for (const room of matches) {
      if (reconnectFirst && roundIndex === 0 && !harness.didReconnect) {
        const reconnectingId = room.players[0].id;
        const restored = await reconnectInMatch(harness, room, reconnectingId);
        await new Promise(resolve => setTimeout(resolve, harness.reconnectGraceMs + 100));
        const afterGrace = harness.roomStates.get(reconnectingId);
        assert.equal(afterGrace?.lobbyTournamentMatch?.matchId, restored.lobbyTournamentMatch.matchId);
        assert.equal(afterGrace.lobbyTournamentMatch.status, 'playing',
          'reconectarse cancela el temporizador: no hay forfeiture al vencer la gracia');
        assert.ok(afterGrace.players.every(player => player.connected), 'ambos asientos siguen conectados tras la gracia');
        harness.didReconnect = true;
      }
      const winnerId = room.players[0].id;
      const loserId = room.players[1].id;
      expectedPlacements.set(loserId, (harness.capacity >> (roundIndex + 1)) + 1);
      await resolveMatchByForfeit(harness, room);
      if (roundIndex === rounds - 1) expectedPlacements.set(winnerId, 1);
    }
  }
  assert.equal(expectedPlacements.size, harness.capacity);
  return expectedPlacements;
}

async function verifyCompletedBracket(harness, expectedPlacements) {
  for (const token of harness.tokens) {
    await emitWithAck(harness.currentSockets.get(token), 'lobby_tournaments_get', {});
  }
  const finalSnapshots = await waitFor(() => {
    const byToken = new Map();
    for (const token of harness.tokens) {
      const snapshot = harness.tournamentSnapshots.get(token);
      const event = snapshot?.tournaments.find(item => item.id === harness.tournament.id);
      if (event?.status === 'completed') byToken.set(token, event);
    }
    return byToken.size === harness.capacity ? byToken : null;
  }, 'no todos los inscritos recibieron el bracket final.');

  const representative = finalSnapshots.get(harness.tokens[0]);
  assert.equal(representative.rounds.length, Math.log2(harness.capacity));
  assert.ok(representative.rounds.every(round => round.matches.every(match => match.status === 'completed')),
    'todos los encuentros del bracket figuran completados');
  assert.equal(representative.rounds.flatMap(round => round.matches).length, harness.capacity - 1,
    'un bracket binario completo resuelve N-1 encuentros');

  for (const token of harness.tokens) {
    const event = finalSnapshots.get(token);
    const expectedPlace = expectedPlacements.get(token);
    const expectedPrize = prizeFor(event, expectedPlace);
    assert.equal(event.myPlacement, expectedPlace, `${token}: puesto final`);
    assert.equal(event.myPrize, expectedPrize, `${token}: premio individual`);

    const tournamentRewards = harness.prizeEvents.get(token).flatMap(event => event.events || []).filter(item =>
      item.type === 'lobby_tournament_prize' && item.id === harness.tournament.id);
    assert.equal(tournamentRewards.length, expectedPrize > 0 ? 1 : 0,
      `${token}: se emite exactamente una recompensa si el puesto tiene premio`);
    if (expectedPrize > 0) {
      assert.equal(tournamentRewards[0].reward, expectedPrize);
      assert.equal(tournamentRewards[0].place, expectedPlace);
      assert.equal(tournamentRewards[0].placeLabel, placeLabelFor(expectedPlace),
        `${token}: el aviso de premio indica si el puesto es compartido`);
      assert.equal(event.myPlacementLabel, placeLabelFor(expectedPlace), `${token}: etiqueta del puesto final`);
    }

    const retry = await emitWithAck(harness.currentSockets.get(token), 'lobby_tournament_register', {
      tournamentId: harness.tournament.id, name: harness.names.get(token), avatar: 'fox', tos: TOS_VERSION
    });
    assert.equal(retry.ok, false, 'un torneo terminado no admite reinscripción ni vuelve a pagar');
    assert.equal(retry.code, 'registration_closed');
  }

  return new Map([...expectedPlacements].map(([token, place]) => [token, prizeFor(representative, place)]));
}

async function stopAndReadProfiles(harness) {
  harness.allSockets.forEach(socket => socket.disconnect());
  await stopServer(harness.child);
  harness.stopped = true;
  const store = new ProfileStore(harness.profilePath, { deferSeasonCheck: true });
  return new Map(harness.tokens.map(token => [token, store.getProfile(token)]));
}

test('bracket de 8 completa las 7 partidas, reconecta un asiento y entrega premios una sola vez', { timeout: 90000 }, async t => {
  const harness = await startTournamentHarness(t, 8, { reconnectGraceMs: 350 });
  const placements = await completeFullBracket(harness, { reconnectFirst: true });
  const prizes = await verifyCompletedBracket(harness, placements);
  const profiles = await stopAndReadProfiles(harness);

  for (const token of harness.tokens) {
    const expectedPrize = prizes.get(token);
    const profile = profiles.get(token);
    assert.ok(profile.chips >= INITIAL_CHIPS + expectedPrize,
      `${token}: el premio no reduce el saldo virtual (${profile.chips} >= ${INITIAL_CHIPS + expectedPrize})`);
    const receipts = profile.transactions.filter(transaction =>
      transaction.reason === receiptReasonFor(harness.tournament.name, placements.get(token)));
    assert.equal(receipts.length, expectedPrize > 0 ? 1 : 0, `${token}: el premio se persiste una sola vez`);
    if (expectedPrize > 0) assert.equal(receipts[0].amount, expectedPrize);
  }
});

test('un reinicio conserva inscripciones y crea de nuevo las mesas pendientes del bracket', { timeout: 60000 }, async t => {
  const harness = await startTournamentHarness(t, 8);
  const before = await waitFor(() => roundMatches(harness, 0), 'No inició la primera ronda.');
  const beforeIds = before.map(room => room.lobbyTournamentMatch.matchId).sort();
  await restartTournamentHarness(harness);

  const after = await waitFor(() => roundMatches(harness, 0), 'El bracket no reanudó sus mesas después del reinicio.');
  const afterIds = after.map(room => room.lobbyTournamentMatch.matchId).sort();
  assert.deepEqual(afterIds, beforeIds, 'se conservan las partidas y el sembrado de la ronda');
  for (const room of after) {
    assert.equal(room.players.length, 2);
    assert.ok(room.players.every(player => player.connected));
    assert.ok(room.players.every(player => player.chips + player.totalBet === INITIAL_CHIPS),
      'un encuentro interrumpido reinicia solo su stack virtual, sin tocar el saldo personal');
  }
  const response = await emitWithAck(harness.currentSockets.get(harness.tokens[0]), 'lobby_tournaments_get', {});
  const event = response.snapshot.tournaments.find(item => item.id === harness.tournament.id);
  assert.equal(event.status, 'in_progress');
  assert.equal(event.registeredCount, 8);
});

test('bracket de 16 completa las 15 partidas y asigna los ocho premios según el puesto', { timeout: 90000 }, async t => {
  const harness = await startTournamentHarness(t, 16);
  const placements = await completeFullBracket(harness);
  const prizes = await verifyCompletedBracket(harness, placements);
  const profiles = await stopAndReadProfiles(harness);

  for (const token of harness.tokens) {
    const expectedPrize = prizes.get(token);
    const profile = profiles.get(token);
    assert.ok(profile.chips >= INITIAL_CHIPS + expectedPrize,
      `${token}: el premio no reduce el saldo virtual (${profile.chips} >= ${INITIAL_CHIPS + expectedPrize})`);
    const receipts = profile.transactions.filter(transaction =>
      transaction.reason === receiptReasonFor(harness.tournament.name, placements.get(token)));
    assert.equal(receipts.length, expectedPrize > 0 ? 1 : 0, `${token}: el premio se persiste una sola vez`);
    if (expectedPrize > 0) assert.equal(receipts[0].amount, expectedPrize);
  }
});

test('el reinicio reintenta un payout pendiente sin duplicarlo si el perfil ya guardó su clave', { timeout: 90000 }, async t => {
  const harness = await startTournamentHarness(t, 8);
  const placements = await completeFullBracket(harness);
  const prizes = await verifyCompletedBracket(harness, placements);
  const championId = [...placements].find(([, place]) => place === 1)[0];
  const reason = receiptReasonFor(harness.tournament.name, 1);

  await stopServer(harness.child);
  const before = new ProfileStore(harness.profilePath, { deferSeasonCheck: true }).getProfile(championId);
  assert.ok(before.lobbyTournamentPayouts.includes(harness.tournament.id));
  assert.equal(before.transactions.filter(transaction => transaction.reason === reason).length, 1);

  const savedState = JSON.parse(fs.readFileSync(harness.tournamentStorePath, 'utf8'));
  const savedEvent = savedState.events.find(event => event.id === harness.tournament.id);
  assert.equal(savedEvent.status, 'completed');
  savedEvent.payoutsAwarded = false; // simula el corte entre guardar perfiles y confirmar el recibo global
  fs.writeFileSync(harness.tournamentStorePath, JSON.stringify(savedState, null, 2));
  await restartTournamentHarness(harness, { alreadyStopped: true });

  const restartedSnapshot = await emitWithAck(harness.currentSockets.get(championId), 'lobby_tournaments_get', {});
  const restartedEvent = restartedSnapshot.snapshot.tournaments.find(event => event.id === harness.tournament.id);
  assert.equal(restartedEvent.status, 'completed');
  assert.equal(restartedEvent.myPrize, prizes.get(championId));
  const after = new ProfileStore(harness.profilePath, { deferSeasonCheck: true }).getProfile(championId);
  assert.equal(after.chips, before.chips, 'la reanudación no vuelve a acreditar las fichas');
  assert.equal(after.transactions.filter(transaction => transaction.reason === reason).length, 1);
  assert.ok(after.lobbyTournamentPayouts.includes(harness.tournament.id));
  const durable = JSON.parse(fs.readFileSync(harness.tournamentStorePath, 'utf8'));
  assert.equal(durable.events.find(event => event.id === harness.tournament.id).payoutsAwarded, true);
  assert.equal(harness.prizeEvents.get(championId).flatMap(event => event.events || [])
    .filter(event => event.type === 'lobby_tournament_prize' && event.id === harness.tournament.id).length, 1,
  'la recuperación tampoco repite el aviso de premio');
});

test('si vence la gracia sin reconectar, el temporizador resuelve el encuentro por incomparecencia', { timeout: 60000 }, async t => {
  const harness = await startTournamentHarness(t, 8, { reconnectGraceMs: 350 });
  const room = (await waitFor(() => roundMatches(harness, 0), 'No inició la primera ronda.'))[0];
  const matchId = room.lobbyTournamentMatch.matchId;
  const disconnectedId = room.players[0].id;
  const winnerId = room.players[1].id;

  harness.currentSockets.get(disconnectedId).disconnect();
  await waitFor(() => harness.roomStates.get(winnerId)?.players.find(player => player.id === disconnectedId)?.connected === false,
    'el rival no figura desconectado durante el periodo de gracia.');
  const settled = await waitFor(() => {
    const latest = harness.roomStates.get(winnerId);
    return latest?.lobbyTournamentMatch?.matchId === matchId
      && latest.lobbyTournamentMatch.status === 'completed' ? latest : null;
  }, 'el temporizador no resolvió el encuentro al terminar la gracia.');
  assert.equal(settled.lobbyTournamentMatch.forfeit, true);
  assert.equal(settled.lobbyTournamentMatch.winnerName, harness.names.get(winnerId));
  assert.equal(settled.players.find(player => player.id === disconnectedId)?.connected, false);

  const response = await emitWithAck(harness.currentSockets.get(winnerId), 'lobby_tournaments_get', {});
  const event = response.snapshot.tournaments.find(item => item.id === harness.tournament.id);
  assert.equal(event.rounds[0].matches.find(match => match.id === matchId)?.status, 'completed');
  assert.equal(event.rounds[0].matches.find(match => match.id === matchId)?.forfeit, true);
  assert.equal(harness.prizeEvents.get(winnerId).flatMap(item => item.events || [])
    .filter(item => item.type === 'lobby_tournament_prize').length, 0,
  'un encuentro de primera ronda no adelanta el pago final del torneo');
});

test('un empate de escalera real en el showdown reparte el pozo y no decide el bracket', { timeout: 60000 }, async t => {
  const harness = await startTournamentHarness(t, 8, { pokerDeck: forcedRoyalBoardDeck() });
  const room = (await waitFor(() => roundMatches(harness, 0), 'No inició la primera ronda.'))[0];
  const matchId = room.lobbyTournamentMatch.matchId;
  const participantIds = room.players.map(player => player.id);

  for (let actionIndex = 0; actionIndex < 3; actionIndex++) {
    const state = await waitFor(() => {
      const latest = harness.roomStates.get(participantIds[0]);
      return latest?.lobbyTournamentMatch?.matchId === matchId && latest.turnId ? latest : null;
    }, 'No llegó el turno previo al showdown.');
    const actorId = state.turnId;
    const actor = harness.currentSockets.get(actorId);
    const player = state.players.find(item => item.id === actorId);
    const action = player.roundBet < state.currentBet ? 'call' : 'allin';
    const response = await emitWithAck(actor, 'poker_action', { action });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (actionIndex < 2) {
      await waitFor(() => {
        const latest = harness.roomStates.get(participantIds[0]);
        return latest?.lobbyTournamentMatch?.matchId === matchId
          && (latest.phase === 'showdown' || (latest.turnId && latest.turnId !== actorId));
      }, 'la acción no pasó el turno al siguiente jugador.');
    }
  }

  const showdown = await waitFor(() => {
    const latest = harness.roomStates.get(participantIds[0]);
    return latest?.lobbyTournamentMatch?.matchId === matchId && latest.phase === 'showdown' ? latest : null;
  }, 'el mazo controlado no llegó al showdown.');
  assert.equal(showdown.community.join(','), '10S,JS,QS,KS,AS', 'la mesa forma una escalera real compartida');
  assert.equal(showdown.lobbyTournamentMatch.status, 'playing', 'un empate no declara ganador del encuentro');
  assert.equal(showdown.lobbyTournamentMatch.handsAtLevel, 1);
  assert.equal(showdown.results.length, 2, 'ambos jugadores reciben resultado de ganador del pozo dividido');
  assert.ok(showdown.results.every(result => result.amount === 1000));
  assert.ok(showdown.players.filter(player => participantIds.includes(player.id)).every(player => player.chips === INITIAL_CHIPS),
    'el pozo empatado devuelve las fichas a los dos stacks del torneo');

  const snapshot = await emitWithAck(harness.currentSockets.get(participantIds[0]), 'lobby_tournaments_get', {});
  const event = snapshot.snapshot.tournaments.find(item => item.id === harness.tournament.id);
  assert.equal(event.status, 'in_progress');
  assert.ok(event.rounds[0].matches.find(match => match.id === matchId)?.status === 'playing');
  assert.equal(harness.prizeEvents.get(participantIds[0]).filter(item => item.type === 'lobby_tournament_prize').length, 0,
    'el empate no paga ni adelanta premios');

  const forfeit = await emitWithAck(harness.currentSockets.get(participantIds[1]), 'leave_room', {});
  assert.equal(forfeit.ok, true, JSON.stringify(forfeit));
  const settled = await waitFor(() => {
    const latest = harness.roomStates.get(participantIds[0]);
    return latest?.lobbyTournamentMatch?.matchId === matchId
      && latest.lobbyTournamentMatch.status === 'completed' ? latest : null;
  }, 'el encuentro empatado no pudo continuar y resolverse después.');
  assert.equal(settled.lobbyTournamentMatch.forfeit, true);
  assert.equal(settled.lobbyTournamentMatch.winnerName, harness.names.get(participantIds[0]));
});
