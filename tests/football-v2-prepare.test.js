'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { FootballEngine } = require('../lib/football/engine');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { prepareV2Match } = require('../lib/football/v2/prepare');
const { verifyCommitment } = require('../lib/football/v2/commitment');
const { VERSION } = require('../lib/football/v2/simulator');

function setup(month = '2026-11') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-prepare-'));
  const file = path.join(dir, 'football.json');
  const store = new FootballStore(file);
  const league = store.generateSeason(month);
  const match = league.calendar.matches[0];
  const asOf = match.scheduledKickoffAt - 60000;
  return { store, file, league, match, asOf, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('el compromiso privado se confirma en disco, se recupera y no reutiliza una precarga V1', async () => {
  const h = setup();
  try {
    const engine = new FootballEngine(h.store);
    const previous = engine._ensureTimeline(h.match);
    assert.notEqual(previous.version, VERSION);
    const prepared = await prepareV2Match({ store: h.store, match: h.match, asOf: h.asOf, keyFactory: () => 'ab'.repeat(32) });
    assert.deepEqual(prepared, { ok: true, existing: false });
    assert.ok(verifyCommitment(h.match.simulation, h.match));
    assert.equal(h.match.simulation.privateSeed, 'ab'.repeat(32));
    assert.equal(engine._ensureTimeline(h.match).version, VERSION);
    const loaded = new FootballStore(h.file);
    const saved = loaded.getMatch(h.match.id, h.match.seasonMonth);
    assert.deepEqual(saved.simulation, h.match.simulation);
    assert.equal(saved.simulationUnconfirmed, undefined);
    const existing = await prepareV2Match({ store: loaded, match: saved, asOf: h.asOf, keyFactory: () => { throw new Error('no reemplazar'); } });
    assert.deepEqual(existing, { ok: true, existing: true });
  } finally { h.close(); }
});

test('no cambia un partido anterior, iniciado, con apuestas, combinadas o futuros aceptados', async () => {
  const cases = ['bet', 'parlay', 'future'];
  for (const kind of cases) {
    const h = setup();
    try {
      if (kind === 'bet') h.store.insertBet({ id: 'b1', idempotencyKey: 'x', profileId: 'p', matchId: h.match.id,
        market: '1x2', selection: 'home', stake: 10, oddsAtPlacement: 2, status: 'open', debited: true });
      if (kind === 'parlay') h.store.insertParlay({ id: 'p1', profileId: 'p', seasonMonth: h.match.seasonMonth,
        legs: [{ matchId: h.match.id, market: '1x2', selection: 'home', oddsAtPlacement: 2, status: 'open' }],
        combinedOdds: 2, stake: 10, status: 'open', debited: true });
      if (kind === 'future') h.store.insertFuture({ id: 'f1', profileId: 'p', seasonMonth: h.match.seasonMonth,
        market: 'champion', selection: h.match.homeId, odds: 2, stake: 10, status: 'open', debited: true });
      const result = await prepareV2Match({ store: h.store, match: h.match, asOf: h.asOf });
      assert.equal(result.reason, 'compromisos_anteriores', kind);
      assert.equal(h.match.simulation, undefined);
    } finally { h.close(); }
  }
  const old = setup('2026-10');
  try { assert.equal((await prepareV2Match({ store: old.store, match: old.match, asOf: old.asOf })).reason, 'temporada_anterior'); }
  finally { old.close(); }
  const started = setup();
  try {
    started.match.status = 'live';
    assert.equal((await prepareV2Match({ store: started.store, match: started.match, asOf: started.asOf })).reason, 'partido_no_preparable');
  } finally { started.close(); }
});

test('un fallo de persistencia impide arrancar y reintenta la misma clave, sin cambiar de motor', async () => {
  const h = setup();
  try {
    const save = h.store.saveStrict.bind(h.store);
    h.store.saveStrict = () => false;
    const result = await prepareV2Match({ store: h.store, match: h.match, asOf: h.asOf, keyFactory: () => '33'.repeat(32) });
    assert.equal(result.reason, 'persistencia_pendiente');
    assert.equal(h.match.simulation.privateSeed, '33'.repeat(32));
    const engine = new FootballEngine(h.store);
    assert.throws(() => engine._ensureTimeline(h.match), /no confirmado/);
    h.store.saveStrict = save;
    const retry = await prepareV2Match({ store: h.store, match: h.match, asOf: h.asOf, keyFactory: () => { throw new Error('clave nueva'); } });
    assert.equal(retry.ok, true);
    assert.equal(h.match.simulation.privateSeed, '33'.repeat(32));
    assert.equal(engine._ensureTimeline(h.match).version, VERSION);
    assert.equal(new FootballStore(h.file).getMatch(h.match.id, h.match.seasonMonth).simulation.privateSeed, '33'.repeat(32));
  } finally { h.close(); }
});

test('dos preparaciones concurrentes comparten una clave y un único guardado', async () => {
  const h = setup();
  try {
    let unblock, keys = 0, saves = 0;
    const gate = new Promise(resolve => { unblock = resolve; });
    const save = h.store.saveStrict.bind(h.store);
    h.store.saveStrict = async () => { saves++; await gate; return save(); };
    const options = { store: h.store, match: h.match, asOf: h.asOf, keyFactory: () => { keys++; return '66'.repeat(32); } };
    const first = prepareV2Match(options), second = prepareV2Match(options);
    unblock();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal(keys, 1);
    assert.equal(saves, 1);
  } finally { h.close(); }
});

test('una apuesta V1 que estaba esperando idempotencia no se acepta tras preparar V2', async () => {
  const h = setup();
  const profiles = new ProfileStore(path.join(path.dirname(h.file), 'profiles.json'));
  try {
    const profile = profiles.getOrCreate('p', 'Jugador', null);
    profile.chips = 1000;
    let unblock, started;
    const begun = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const idempotency = { async begin() { started(); await gate; return { state: 'started' }; }, async complete() {} };
    const betting = createBettingService({ store: h.store, profiles, idempotency });
    const bet = betting.placeBet({ profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: h.asOf });
    await begun;
    assert.equal((await prepareV2Match({ store: h.store, match: h.match, asOf: h.asOf })).ok, true);
    unblock();
    assert.equal((await bet).code, 'mercado_cambio');
    assert.equal(profile.chips, 1000);
    assert.equal(h.store.getBets({ matchId: h.match.id }).length, 0);
  } finally { h.close(); }
});
