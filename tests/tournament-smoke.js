'use strict';

// Fase 8.1 — Smoke de torneos sit & go: entrada y bote, stack independiente del
// perfil, ciegas crecientes por nivel, eliminación y premio al campeón con el
// saldo real restaurado al final.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');

const port = 4600 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-tournament-${process.pid}.json`);
const clients = [];
let server;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.log = '';
  child.stdout.on('data', chunk => { child.log += chunk; });
  child.stderr.on('data', chunk => { child.log += chunk; });
  return child;
}
function connectClient() {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.latest = null;
  socket.on('room_state', state => { socket.latest = state; });
  clients.push(socket);
  return socket;
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 5000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}
function waitFor(emitter, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tiempo agotado esperando ${event}`)), timeout);
    emitter.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
}
async function waitState(socket, predicate, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (socket.latest && predicate(socket.latest)) return socket.latest;
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error(`Tiempo agotado esperando estado: ${label}`);
}
const ACTIVE = ['preflop', 'flop', 'turn', 'river'];

// Juega la mano actual hasta el showdown siguiendo el turno autoritativo.
async function playHand(sockets, tokens, mode = 'calm') {
  const bySocket = new Map(tokens.map((token, index) => [token, sockets[index]]));
  for (let step = 0; step < 60; step++) {
    const state = sockets[0].latest;
    if (!state || !ACTIVE.includes(state.phase)) return state;
    const turnId = state.turnId;
    if (!turnId) { await new Promise(r => setTimeout(r, 80)); continue; }
    const actorSocket = bySocket.get(turnId);
    if (!actorSocket) { await new Promise(r => setTimeout(r, 80)); continue; }
    const me = state.players.find(p => p.id === turnId);
    const toCall = Math.max(0, state.currentBet - (me?.roundBet || 0));
    const action = mode === 'allin' ? 'allin' : toCall > 0 ? 'call' : 'check';
    const response = await emitAck(actorSocket, 'poker_action', { action });
    if (!response.ok && response.code !== 'stale') throw new Error(`Acción rechazada (${action}): ${response.error}`);
    await waitState(sockets[0], s => s.turnId !== turnId || !ACTIVE.includes(s.phase), 'avance de turno', 4000).catch(() => null);
  }
  throw new Error('La mano no terminó en 60 pasos.');
}

(async () => {
  fs.rmSync(profilePath, { force: true });
  server = startServer();
  await new Promise(r => setTimeout(r, 900));

  const hostToken = `t-host-${Date.now()}`;
  const guestToken = `t-guest-${Date.now()}`;
  const host = connectClient();
  const guest = connectClient();
  await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);

  const created = await emitAck(host, 'create_room', { name: 'Campeona', roomName: 'Arena', game: 'poker', token: hostToken, avatar: 'owl', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  const code = created.code;
  assert.equal((await emitAck(guest, 'join_room', { name: 'Retador', code, token: guestToken, avatar: 'fox', tos: TOS_VERSION })).ok, true);
  await waitState(host, s => s.players.length === 2, 'dos jugadores sentados');

  // ---- Solo el anfitrión inicia el torneo ----
  assert.equal((await emitAck(guest, 'tournament_start')).ok, false, 'el invitado no puede iniciar el torneo');
  const started = await emitAck(host, 'tournament_start');
  assert.equal(started.ok, true, started.error);

  // ---- Entrada cobrada, stack independiente y bote correcto ----
  let state = await waitState(host, s => s.tournament?.active && s.phase === 'preflop', 'torneo activo con mano en curso');
  assert.equal(state.tournament.prize, 400, 'bote = entrada × participantes');
  assert.equal(state.tournament.level, 1);
  assert.equal(state.tournament.blinds.small, 10);
  assert.equal(state.viewerProfile.chips, 900, 'la entrada salió del saldo real (1000 + bono diario 100 − 200)');
  const meHost = state.players.find(p => p.id === hostToken);
  assert.ok(meHost.chips + meHost.roundBet === 1000, `stack de torneo 1000 (fichas ${meHost.chips} + ciega ${meHost.roundBet})`);

  // ---- Sin recompras: el evento 'rebuy' ya no existe en el servidor ----
  const rebuyAttempt = await Promise.race([
    new Promise(resolve => host.emit('rebuy', {}, resolve)),
    new Promise(resolve => setTimeout(() => resolve('sin-respuesta'), 1500))
  ]);
  assert.equal(rebuyAttempt, 'sin-respuesta', 'el servidor ignora por completo la recarga de fichas');

  // ---- Tres manos tranquilas → sube el nivel de ciegas ----
  await playHand([host, guest], [hostToken, guestToken], 'calm');
  state = await waitState(host, s => s.phase === 'showdown', 'showdown de la mano 1');
  for (let hand = 2; hand <= 3 && state.tournament.active; hand++) {
    assert.equal((await emitAck(host, 'poker_start')).ok, true, `mano ${hand} iniciada`);
    await waitState(host, s => ACTIVE.includes(s.phase), `mano ${hand} en curso`);
    await playHand([host, guest], [hostToken, guestToken], 'calm');
    state = await waitState(host, s => s.phase === 'showdown', `showdown de la mano ${hand}`);
  }
  if (state.tournament.active) {
    assert.equal(state.tournament.level, 2, 'tras 3 manos el torneo está en nivel 2');
    assert.equal(state.tournament.blinds.big, 40, 'ciegas dobladas (20/40)');
  }

  // ---- All-ins hasta que haya campeón ----
  for (let round = 0; round < 20 && state.tournament.active; round++) {
    const handBefore = host.latest.handNumber;
    const startResult = await emitAck(host, 'poker_start');
    if (!startResult.ok) throw new Error(`poker_start durante torneo: ${startResult.error}`);
    await waitState(host, s => s.handNumber > handBefore, 'mano all-in en curso');
    await playHand([host, guest], [hostToken, guestToken], 'allin');
    state = await waitState(host, s => s.handNumber > handBefore && s.phase === 'showdown', 'showdown all-in');
  }
  assert.equal(state.tournament.active, false, `el torneo terminó (quedan ${state.tournament.remaining}, eliminados ${JSON.stringify(state.tournament.eliminated)})`);
  assert.ok(state.tournament.winnerName, 'hay campeón registrado');

  // ---- Economía final: el campeón cobra el bote y los saldos reales vuelven ----
  // (logros y retos pueden sumar fichas extra al perfil, así que validamos por transacción)
  const hostFinal = await waitState(host, s => !s.tournament.active, 'estado final host');
  const guestFinal = await waitState(guest, s => !s.tournament.active, 'estado final guest');
  const winnerName = hostFinal.tournament.winnerName;
  const winnerIsHost = hostFinal.players.find(p => p.id === hostToken)?.name === winnerName;
  const winnerState = winnerIsHost ? hostFinal : guestFinal;
  const loserState = winnerIsHost ? guestFinal : hostFinal;
  const prizeTx = (winnerState.viewerProfile.transactions || []).find(tx => tx.reason === 'Premio del torneo sit & go');
  assert.ok(prizeTx && prizeTx.amount === 400, 'el campeón tiene la transacción del premio (+400)');
  assert.ok(!(loserState.viewerProfile.transactions || []).some(tx => tx.reason === 'Premio del torneo sit & go'), 'el subcampeón no cobra premio');
  // Reenganche fichas ⇄ perfil para ambos: lo que se ve en mesa es el saldo real.
  assert.equal(hostFinal.players.find(p => p.id === hostToken).chips, hostFinal.viewerProfile.chips, 'fichas del host = saldo real');
  assert.equal(guestFinal.players.find(p => p.id === guestToken).chips, guestFinal.viewerProfile.chips, 'fichas del invitado = saldo real');
  assert.ok(winnerState.viewerProfile.chips >= 1300, 'el campeón recuperó su saldo más el bote');
  assert.ok(loserState.viewerProfile.chips >= 900 - 0, 'el subcampeón conserva su saldo real menos la entrada');
  const eliminatedEntry = hostFinal.tournament.eliminated.find(e => e.place === 2);
  assert.ok(eliminatedEntry, 'el subcampeón quedó registrado en 2.º lugar');

  // ---- Después del torneo la mesa vuelve a ciegas normales ----
  assert.equal((await emitAck(host, 'poker_start')).ok, true, 'mano normal tras el torneo');
  state = await waitState(host, s => s.phase === 'preflop', 'mano normal en curso');
  assert.ok(state.messages.some(m => m.text.includes('ciegas 10/20')), 'las ciegas regresan a 10/20');

  console.log('✅ tournament-smoke: entrada, stack, niveles de ciegas, eliminación, premio y restauración OK');
  process.exit(0);
})().catch(error => {
  console.error('❌ tournament-smoke falló:', error.message);
  if (server?.log) console.error(server.log.slice(-1500));
  process.exit(1);
}).finally(() => {
  clients.forEach(socket => socket.disconnect());
  server?.kill('SIGKILL');
  fs.rmSync(profilePath, { force: true });
});
