'use strict';

// Regresión del showdown de póker (bug reportado por un jugador real):
// con una apuesta sin igualar (all-in por menos fichas), el excedente formaba un
// "bote lateral" de un solo elegible y el sistema devolvía ese dinero marcando a su
// dueño como GANADOR: una carta alta podía "ganar" junto a un par de reyes.
// Ahora el excedente se devuelve en silencio y en los resultados solo aparecen
// quienes de verdad ganan un bote disputado, según el evaluador de manos.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TOS_VERSION } = require('../lib/terms');
const { bestPokerScore, compareScores } = require('../lib/poker-evaluator');

const port = 6650 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-showdown-${process.pid}.json`);
const clients = [];
let server;

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
async function waitState(socket, predicate, description, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (socket.latest && predicate(socket.latest)) return socket.latest;
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error(`Tiempo agotado esperando: ${description}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sumRewards = profile => (profile?.transactions || [])
  .filter(t => /^(Logro|Reto):/.test(t.reason))
  .reduce((sum, t) => sum + t.amount, 0);

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.log = '';
  server.stdout.on('data', chunk => { server.log += chunk; });
  server.stderr.on('data', chunk => { server.log += chunk; });
  await sleep(900);

  const ana = connectClient();
  const beto = connectClient();
  const anaId = 'sd-ana';
  const betoId = 'sd-beto';
  const created = await emitAck(ana, 'create_room', { name: 'AnaShow', roomName: 'Mesa Showdown', game: 'poker', token: anaId, avatar: 'fox', tos: TOS_VERSION });
  assert.equal(created.ok, true, created.error);
  assert.equal((await emitAck(beto, 'join_room', { name: 'BetoShow', code: created.code, token: betoId, avatar: 'owl', tos: TOS_VERSION })).ok, true);
  await waitState(ana, s => s.players.filter(p => !p.isBot).length === 2, 'dos personas sentadas');
  const clientOf = id => (id === anaId ? ana : beto);

  // ---- Mano 1: la primera en actuar se retira → los stacks quedan desparejos (±10). ----
  assert.equal((await emitAck(ana, 'poker_start')).ok, true, 'arranca la mano 1');
  let state = await waitState(ana, s => s.phase === 'preflop' && s.turnId, 'preflop de la mano 1');
  assert.equal((await emitAck(clientOf(state.turnId), 'poker_action', { action: 'fold' })).ok, true, 'fold de apertura');
  state = await waitState(ana, s => s.phase === 'showdown', 'fin de la mano 1');

  const stackBefore = new Map(state.players.map(p => [p.id, p.chips]));
  const rewardsBefore = new Map([[anaId, sumRewards(ana.latest?.viewerProfile)], [betoId, sumRewards(beto.latest?.viewerProfile)]]);
  const bigId = stackBefore.get(anaId) > stackBefore.get(betoId) ? anaId : betoId;
  const expectedRefund = Math.abs(stackBefore.get(anaId) - stackBefore.get(betoId));
  assert.ok(expectedRefund > 0, 'los stacks quedaron desparejos para forzar una apuesta sin igualar');

  // ---- Mano 2: all-in contra all-in con stacks distintos → hay excedente sin igualar. ----
  const handBefore = state.handNumber;
  assert.equal((await emitAck(ana, 'poker_start')).ok, true, 'arranca la mano 2');
  state = await waitState(ana, s => s.handNumber > handBefore && s.phase === 'preflop' && s.turnId, 'preflop de la mano 2');
  const first = state.turnId;
  const second = first === anaId ? betoId : anaId;
  assert.equal((await emitAck(clientOf(first), 'poker_action', { action: 'allin' })).ok, true, 'primer all-in');
  state = await waitState(ana, s => s.phase === 'showdown' || s.turnId === second, 'turno del segundo all-in');
  if (state.phase !== 'showdown') assert.equal((await emitAck(clientOf(second), 'poker_action', { action: 'allin' })).ok, true, 'segundo all-in');
  state = await waitState(ana, s => s.phase === 'showdown' && s.results?.length, 'showdown de la mano 2');

  // ---- El único que puede figurar como ganador es quien tiene la mejor mano. ----
  const live = state.players.filter(p => !p.folded && Array.isArray(p.hand) && p.hand.length === 2 && p.hand[0] !== 'XX');
  assert.equal(live.length, 2, 'las dos manos quedan boca arriba en el showdown');
  assert.equal(state.community.length, 5, 'las cinco cartas comunitarias están en la mesa');
  const scores = new Map(live.map(p => [p.id, bestPokerScore([...p.hand, ...state.community])]));
  let best = null;
  for (const score of scores.values()) if (!best || compareScores(score, best) > 0) best = score;
  const expectedWinners = live.filter(p => compareScores(scores.get(p.id), best) === 0).map(p => p.id).sort();
  const actualWinners = state.results.map(result => result.id).sort();
  assert.deepEqual(actualWinners, expectedWinners, `ganó quien no debía: resultados ${JSON.stringify(state.results.map(r => `${r.name}:${r.label}`))}`);

  // ---- La devolución de la apuesta sin igualar se anuncia y no infla a nadie. ----
  assert.ok(state.messages.some(m => m.system && /sin igualar/.test(m.text)), 'el sistema anuncia la devolución del excedente');

  if (expectedWinners.length === 1) {
    const winnerId = expectedWinners[0];
    const loserId = winnerId === anaId ? betoId : anaId;
    const loserState = state.players.find(p => p.id === loserId);
    const loserRewards = sumRewards(clientOf(loserId).latest?.viewerProfile) - rewardsBefore.get(loserId);
    const loserExpected = (loserId === bigId ? expectedRefund : 0) + loserRewards;
    assert.equal(loserState.chips, loserExpected, `quien pierde queda solo con su excedente devuelto (esperado ${loserExpected}, tiene ${loserState.chips})`);
    const winnerState = state.players.find(p => p.id === winnerId);
    const contested = 2 * Math.min(stackBefore.get(anaId), stackBefore.get(betoId));
    assert.ok(winnerState.chips >= contested, `el bote disputado completo (${contested}) es para la mejor mano`);
    assert.equal(state.results.length, 1, 'solo hay una entrada de resultado');
  } else {
    // Empate legítimo del tablero: ambos reparten y nadie recibe de más.
    assert.equal(state.results.length, 2, 'empate: ambos aparecen en resultados');
  }

  console.log(`✅ poker-showdown-smoke: bote disputado para la mejor mano, excedente devuelto sin figurar como ganador (refund ${expectedRefund}) OK`);
}

main()
  .then(() => cleanup(0))
  .catch(error => { console.error('❌ poker-showdown-smoke:', error.message); if (server?.log) console.error(server.log.slice(-600)); cleanup(1); });

function cleanup(code) {
  for (const socket of clients) { try { socket.disconnect(); } catch (_) { /* noop */ } }
  try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  if (server) { try { server.kill('SIGKILL'); } catch (_) { /* noop */ } }
  setTimeout(() => process.exit(code), 400);
}
