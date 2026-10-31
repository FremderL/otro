'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { FootballStore } = require('../lib/football-store');
const { prepareV2Match } = require('../lib/football/v2/prepare');
const { preparePricedV2Match } = require('../lib/football/v2/prepare-priced');
const { verifyCommitment } = require('../lib/football/v2/commitment');
const C = require('../lib/football/v2/calibration');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-priced-'));
  const file = path.join(dir, 'football.json');
  const store = new FootballStore(file), league = store.generateSeason('2026-11');
  const match = league.calendar.matches[0];
  let now = match.scheduledKickoffAt - 60000;
  let keys = 0;
  return { store, league, match, file, clock: () => now, advance: delta => { now += delta; },
    keyFactory: () => (++keys).toString(16).padStart(2, '0').repeat(32),
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Histogramas sintéticos: comprueban atomicidad e integridad, no calibración económica.
function calibration(input, key, samples) {
  return Promise.resolve({ version: C.VERSION, simulatorVersion: input.version, inputHash: C.hashInputs(input), samples,
    keyCommitment: crypto.createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex'),
    counts: { '0-0': 400, '1-0': 500, '0-1': 360, '1-1': 420, '2-0': 150, '2-1': 130, '1-2': 88 }, liveByState: [] });
}

function options(h, extra = {}) {
  return { store: h.store, match: h.match, clock: h.clock, keyFactory: h.keyFactory, calibrate: calibration, ...extra };
}

test('preparación con cuotas confirma todo junto y conserva el snapshot capturado antes de otros resultados', async () => {
  const h = setup();
  try {
    let release, announced;
    const gate = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { announced = resolve; });
    let received;
    const calibrate = async (input, key, samples) => {
      received ||= JSON.parse(JSON.stringify(input)); announced(); await gate;
      return calibration(input, key, samples);
    };
    let writes = 0;
    const save = h.store.saveStrict.bind(h.store);
    h.store.saveStrict = async () => {
      writes++;
      assert.ok(h.match.simulation?.pricing, 'nunca se confirma el compromiso sin cuotas');
      return save();
    };
    const first = preparePricedV2Match(options(h, { calibrate }));
    const second = preparePricedV2Match(options(h, { calibrate }));
    await begun;
    assert.equal(h.match.simulation, undefined, 'la calibración no bloquea ni cambia el partido');
    const another = h.league.calendar.matches.find(item => item.id !== h.match.id
      && (item.homeId === h.match.homeId || item.awayId === h.match.homeId));
    h.advance(1000);
    assert.equal(h.store.settleMatch(another.id, { home: 3, away: 0 }, { seasonMonth: '2026-11', now: h.clock() }).ok, true);
    release(); h.advance(1000);
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal(writes, 1);
    assert.deepEqual(h.match.simulation.inputs, received);
    assert.ok(verifyCommitment(h.match.simulation, h.match));
    const loaded = new FootballStore(h.file).getMatch(h.match.id, '2026-11');
    assert.deepEqual(loaded.simulation, h.match.simulation);
    assert.ok(loaded.simulation.pricing);
  } finally { h.close(); }
});

test('una apuesta o un futuro aceptado durante el cálculo impide seleccionar otro motor', async () => {
  for (const kind of ['bet', 'future']) {
    const h = setup();
    try {
      let release, announced;
      const gate = new Promise(resolve => { release = resolve; });
      const begun = new Promise(resolve => { announced = resolve; });
      const calibrate = async (...args) => { announced(); await gate; return calibration(...args); };
      const pending = preparePricedV2Match(options(h, { calibrate }));
      await begun;
      if (kind === 'bet') h.store.insertBet({ id: 'b1', idempotencyKey: 'x', profileId: 'p', matchId: h.match.id,
        market: '1x2', selection: 'home', stake: 10, oddsAtPlacement: 2, status: 'open', debited: true });
      else h.store.insertFuture({ id: 'f1', profileId: 'p', seasonMonth: h.match.seasonMonth,
        market: 'champion', selection: h.match.homeId, odds: 2, stake: 10, status: 'open', debited: true });
      release();
      assert.equal((await pending).reason, 'compromisos_anteriores', kind);
      assert.equal(h.match.simulation, undefined);
    } finally { h.close(); }
  }
});

test('el kickoff, otra preparación y la calibración inválida impiden un cambio tardío', async () => {
  for (const kind of ['kickoff', 'other', 'invalid']) {
    const h = setup();
    try {
      let release, announced;
      const gate = new Promise(resolve => { release = resolve; });
      const begun = new Promise(resolve => { announced = resolve; });
      const calibrate = async (input, key, samples) => {
        announced(); await gate;
        const result = await calibration(input, key, samples);
        return kind === 'invalid' ? { ...result, inputHash: 'incorrecto' } : result;
      };
      const pending = preparePricedV2Match(options(h, { calibrate }));
      await begun;
      if (kind === 'kickoff') h.advance(60000);
      if (kind === 'other') assert.equal((await prepareV2Match({ store: h.store, match: h.match, asOf: h.clock() })).ok, true);
      release();
      const result = await pending;
      assert.equal(result.reason, kind === 'kickoff' ? 'partido_no_preparable' : kind === 'other' ? 'compromiso_existente' : 'calibracion_invalida');
      if (kind !== 'other') assert.equal(h.match.simulation, undefined);
    } finally { h.close(); }
  }
});

test('persistencia incierta mantiene la misma clave y los precios para reintentar', async () => {
  const h = setup();
  try {
    const save = h.store.saveStrict.bind(h.store);
    h.store.saveStrict = () => false;
    const result = await preparePricedV2Match(options(h));
    assert.equal(result.reason, 'persistencia_pendiente');
    assert.ok(h.match.simulation.pricing);
    assert.equal(h.match.simulation.privateSeed, '01'.repeat(32));
    assert.equal(h.match.simulationUnconfirmed, true);
    h.store.saveStrict = save;
    const retry = await prepareV2Match({ store: h.store, match: h.match, asOf: h.clock(), keyFactory: () => { throw new Error('no reemplazar'); } });
    assert.equal(retry.ok, true);
    assert.equal(h.match.simulation.privateSeed, '01'.repeat(32));
    assert.ok(new FootballStore(h.file).getMatch(h.match.id, '2026-11').simulation.pricing);
  } finally { h.close(); }
});

test('cancelar mientras espera admisión no confirma el candidato ni toca las apuestas', async () => {
  const { withSeasonAdmission } = require('../lib/football/season-admission');
  const h = setup();
  try {
    let release, locked;
    const gate = new Promise(resolve => { release = resolve; });
    const acquired = new Promise(resolve => { locked = resolve; });
    const blocker = withSeasonAdmission(h.store, h.match.seasonMonth, async () => { locked(); await gate; });
    await acquired;
    const controller = new AbortController();
    const operation = preparePricedV2Match(options(h, { signal: controller.signal }));
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); release(); await blocker;
    assert.equal((await operation).reason, 'calibracion_cancelada');
    assert.equal(h.match.simulation, undefined);
    assert.equal(h.store.getBets().length, 0);
  } finally { h.close(); }
});

test('una apuesta que calculó cuota V1 no puede avanzar cuando se confirma el compromiso con precios', async () => {
  const { ProfileStore } = require('../lib/profile-store');
  const { createBettingService } = require('../lib/football/betting');
  const h = setup();
  const profiles = new ProfileStore(path.join(path.dirname(h.file), 'profiles.json'));
  try {
    const profile = profiles.getOrCreate('p', 'Jugador', null); profile.chips = 1000;
    let unblock, started;
    const begun = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const idempotency = { async begin() { started(); await gate; return { state: 'started' }; }, async complete() {} };
    const betting = createBettingService({ store: h.store, profiles, idempotency, now: h.clock });
    const bet = betting.placeBet({ profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: h.clock() });
    await begun;
    assert.equal((await preparePricedV2Match(options(h))).ok, true);
    unblock();
    assert.equal((await bet).code, 'mercado_cambio');
    assert.equal(profile.chips, 1000);
    assert.equal(h.store.getBets({ matchId: h.match.id }).length, 0);
  } finally { h.close(); }
});
