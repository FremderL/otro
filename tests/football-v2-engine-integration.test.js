'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { FootballEngine } = require('../lib/football/engine');
const { createBettingService } = require('../lib/football/betting');
const { registerFootballSockets } = require('../lib/football/sockets');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { makeCommitment } = require('../lib/football/v2/commitment');
const { VERSION } = require('../lib/football/v2/simulator');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otro-v2-engine-'));
  const file = path.join(dir, 'football.json');
  const store = new FootballStore(file);
  const league = store.generateSeason('2026-11');
  const match = league.calendar.matches[0];
  const key = 'bc'.repeat(32);
  const inputs = prepareMatchInputs({ league, match, asOf: match.scheduledKickoffAt - 60000, seed: 0 });
  match.simulation = makeCommitment(inputs, key, match.scheduledKickoffAt - 60000);
  store.saveNow();
  function close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  return { dir, file, store, league, match, key, inputs, close };
}

test('V2 experimental persiste su compromiso, se recupera y asienta a los 90 minutos en 4×', () => {
  const h = setup();
  try {
    const loaded = new FootballStore(h.file);
    const match = loaded.getMatch(h.match.id, '2026-11');
    assert.equal(match.simulation.version, VERSION);
    assert.deepEqual(match.simulation.inputs, h.inputs);
    const engine = new FootballEngine(loaded);
    const kick = match.scheduledKickoffAt;
    const replay = engine._ensureTimeline(match);
    const expected = replay.score;
    assert.equal(engine.deriveMatchState(match, kick - 1).revealedIndex, -1);
    assert.equal(engine.startMatch(match, kick), true);
    assert.equal(engine.deriveMatchState(match, kick + 15000).minute, 1);
    assert.equal(engine.forceFinish(match, kick + 15000).reason, 'v2_aun_no_termina');
    assert.equal(match.status, 'live');
    const before = engine.deriveMatchState(match, kick + 37.5 * 15000);
    loaded.getLeague('2026-11').config.find(c => c.id === match.homeId).ratings.att = 0.71;
    engine.invalidate(match.id);
    const after = engine.deriveMatchState(match, kick + 37.5 * 15000);
    assert.deepEqual(after.state, before.state, 'el contexto posterior no cambia el partido congelado');
    loaded.saveNow();
    const restartedStore = new FootballStore(h.file);
    const restartedMatch = restartedStore.getMatch(match.id, '2026-11');
    const restarted = new FootballEngine(restartedStore);
    assert.deepEqual(restarted.deriveMatchState(restartedMatch, kick + 37.5 * 15000).state, before.state);
    const at90 = restarted.advance(restartedMatch, kick + 1350000);
    assert.equal(at90.ended, false, 'el añadido se juega antes de liquidar');
    const result = restarted.advance(restartedMatch, kick + replay.clock.matchEnd * 15000);
    assert.equal(result.ended, true);
    assert.equal(restartedMatch.status, 'settled');
    assert.deepEqual({ home: restartedMatch.result.home, away: restartedMatch.result.away }, expected);
    assert.ok(restartedMatch.highlights);
    assert.ok(restartedMatch.fantasyStats);
    assert.equal(restarted.runtime.get(match.id).result, null, 'libera los cuadros al cerrar');
    restartedStore.close(); loaded.close();
  } finally { h.close(); }
});

test('HTTP/socket: la instantánea V2 solo contiene el prefijo revelado y nunca la clave o el futuro', () => {
  const h = setup();
  let sockets;
  try {
    const engine = new FootballEngine(h.store);
    const kick = h.match.scheduledKickoffAt;
    engine.startMatch(h.match, kick);
    const betting = createBettingService({ store: h.store, profiles: {} });
    const io = { on() {}, to() { return { emit() {} }; } };
    sockets = registerFootballSockets(io, { betting, engine, store: h.store, profiles: {}, now: () => kick + 5 * 15000 });
    const payload = sockets.buildMatchState(h.match.id, null);
    assert.equal(payload.match.engine, 'v2');
    assert.equal(payload.match.secondsPerMinute, 15);
    assert.equal(payload.state.players.filter(player => player.active).length, 22);
    assert.deepEqual(payload.markets, {}, 'nunca usar cuotas V1 para V2 experimental');
    const json = JSON.stringify(payload);
    for (const secret of [h.key, h.match.simulation.inputsHash, 'privateSeed', 'timeline', 'inputsHash', 'inputs']) {
      assert.equal(json.includes(secret), false, `no filtrar ${secret}`);
    }
    assert.deepEqual(payload.state.score, engine.deriveMatchState(h.match, kick + 5 * 15000).state.score);
  } finally { sockets?.stop(); h.close(); }
});

test('un compromiso roto no cae silenciosamente en V1 ni fabrica estadísticas V1', () => {
  const h = setup();
  try {
    const raw = JSON.parse(fs.readFileSync(h.file, 'utf8'));
    const league = raw.leagues.find(item => item.seasonMonth === '2026-11');
    const persisted = league.calendar.matches.find(item => item.id === h.match.id);
    persisted.simulation.privateSeed = 'broken';
    fs.writeFileSync(h.file, JSON.stringify(raw));
    const store = new FootballStore(h.file);
    const match = store.getMatch(h.match.id, '2026-11');
    assert.equal(match.simulation.invalid, true);
    const engine = new FootballEngine(store);
    assert.throws(() => engine.deriveMatchState(match, match.scheduledKickoffAt), /compromiso V2 inválido/);
    const settled = store.settleMatch(match.id, { home: 1, away: 0 }, { seasonMonth: '2026-11' });
    assert.equal(settled.reason, 'v2_timeline_ausente');
    assert.equal(match.status, 'scheduled');
    store.close();
  } finally { h.close(); }
});

test('las cuotas V1 y boletos ya abiertos no se trasladan a un partido experimental V2', async () => {
  const h = setup();
  try {
    const betting = createBettingService({ store: h.store, profiles: { getProfile() { return null; } } });
    const legacy = h.league.calendar.matches.find(m => m.id !== h.match.id);
    assert.ok(betting.getMarket(legacy, '1x2'));
    assert.equal(betting.getMarket(h.match, '1x2'), null);
    const attempt = await betting.placeBet({ profile: { id: 'test', chips: 1000 }, matchId: h.match.id,
      market: '1x2', selection: 'home', stake: 100 });
    assert.equal(attempt.code, 'market_unavailable');
    h.store.insertBet({ id: 'prior', profileId: 'test', matchId: h.match.id, market: '1x2', selection: 'home',
      stake: 100, oddsAtPlacement: 2, status: 'open', debited: true });
    const engine = new FootballEngine(h.store);
    assert.throws(() => engine.startMatch(h.match, h.match.scheduledKickoffAt), /boletos abiertos/);
    assert.equal(h.match.status, 'scheduled');
    assert.equal(h.store.getBet('prior').status, 'open');
  } finally { h.close(); }
});
