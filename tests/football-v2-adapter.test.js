'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { generateReplay, deriveReplay } = require('../lib/football/v2/adapter');
const { secureRandom, newKey, derivedKey } = require('../lib/football/v2/secure-random');
const { createMatch, FIELD, STEP } = require('../lib/football/v2/simulator');
const { extractBallonDorMatchStats } = require('../lib/football/ballon-dor-stats');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otro-v2-adapter-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason('2026-11');
  const match = league.calendar.matches[0];
  const input = prepareMatchInputs({ league, match, seed: 0, asOf: match.scheduledKickoffAt - 1 });
  const close = () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { store, league, match, input, close };
}

test('el flujo privado es reproducible, de 256 bits y aislado por dominio', () => {
  const key = newKey();
  assert.match(key, /^[0-9a-f]{64}$/);
  const a = secureRandom(key, 'game'), b = secureRandom(key, 'game'), c = secureRandom(key, 'calibration');
  const x = Array.from({ length: 2000 }, a), y = Array.from({ length: 2000 }, b), z = Array.from({ length: 2000 }, c);
  assert.deepEqual(x, y);
  assert.notDeepEqual(x, z);
  assert.ok(x.every(n => n >= 0 && n < 1));
  assert.notEqual(derivedKey(key, 'sample:1'), derivedKey(key, 'sample:2'));
  assert.throws(() => secureRandom('123'), /256 bits/);
});

test('adaptador reproduce y recupera 90 minutos con las mismas entradas y clave', () => {
  const h = setup();
  try {
    const key = '91'.repeat(32);
    const replay = generateReplay(h.input, key);
    const restored = generateReplay(JSON.parse(JSON.stringify(h.input)), key);
    assert.equal(replay.inputHash, restored.inputHash);
    assert.deepEqual(replay.timeline, restored.timeline);
    assert.deepEqual(replay.frames, restored.frames);
    assert.deepEqual(replay.score, restored.score);
    assert.ok(replay.clock.matchEnd > 90 && replay.clock.matchEnd <= 98);
    assert.equal(replay.clock.matchEnd, 90 + replay.clock.s1 + replay.clock.s2);
    const pre = deriveReplay(replay, 0, { pre: true });
    assert.equal(pre.revealedIndex, -1);
    assert.deepEqual(pre.state.score, { home: 0, away: 0 });
    assert.equal(pre.state.players.filter(player => player.active).length, 22);
    const end = deriveReplay(replay, replay.clock.matchEnd);
    assert.deepEqual(end.state.score, replay.score);
    assert.equal(end.state.phase, 'ended');
    assert.equal(replay.timeline.at(-1).type, 'full_time');

    const direct = createMatch({ ...h.input, random: secureRandom(key, 'game') });
    direct.step(1000);
    const directState = direct.snapshot();
    const derived = deriveReplay(replay, 1000 * STEP / 60).state;
    for (let i = 0; i < 22; i++) {
      const player = derived.players.find(item => item.id === directState.players[i].id);
      assert.ok(player);
      assert.ok(Math.abs(player.x - directState.players[i].x / FIELD.length) < 1e-6);
      assert.ok(Math.abs(player.y - directState.players[i].y / FIELD.width) < 1e-6);
    }
    assert.ok(!JSON.stringify(derived).includes(key));
    assert.ok(!Object.hasOwn(derived, 'timeline'));
    assert.ok(!Object.hasOwn(derived, 'inputHash'));
    assert.ok(!Object.hasOwn(derived, 'scoreFinal'));
  } finally { h.close(); }
});

test('estado público y eventos solo revelan lo ocurrido y el marcador sigue a los goles', () => {
  const h = setup();
  try {
    const replay = generateReplay(h.input, '42'.repeat(32));
    for (let tick = 0; tick < replay.frameCount; tick += 7) {
      const derived = deriveReplay(replay, tick * STEP / 60);
      const relevant = replay.timeline.slice(0, derived.revealedIndex + 1);
      assert.deepEqual(derived.state.score, {
        home: relevant.filter(event => ['goal', 'penalty_scored'].includes(event.type) && event.team === 'home').length,
        away: relevant.filter(event => ['goal', 'penalty_scored'].includes(event.type) && event.team === 'away').length
      });
      assert.ok(relevant.every(event => event.tick <= tick));
      assert.ok(replay.timeline.slice(derived.revealedIndex + 1).every(event => event.tick > tick));
    }
    for (const event of replay.timeline.filter(item => item.type === 'goal' || item.type === 'penalty_scored')) {
      const before = deriveReplay(replay, (event.tick - 0.01) * STEP / 60);
      const at = deriveReplay(replay, (event.tick + 0.01) * STEP / 60);
      assert.ok(before.revealedIndex < event.i);
      assert.ok(at.revealedIndex >= event.i);
      assert.equal(at.state.score[event.team], before.state.score[event.team] + 1);
    }
  } finally { h.close(); }
});

test('timeline y once real permiten agregar Balón de Oro, fantasy y resumen al asentar', () => {
  const h = setup();
  try {
    const replay = generateReplay(h.input, '07'.repeat(32));
    const stats = extractBallonDorMatchStats(h.match, replay.timeline, replay.lineups, { expectedScore: replay.score });
    assert.equal(stats.ok, true, stats.reason);
    assert.deepEqual(stats.score, replay.score);
    assert.ok([...stats.players.values()].filter(p => p.appearances).length > 22, 'los suplentes cuentan en fantasy y Balón de Oro');
    const result = h.store.settleMatch(h.match.id, replay.score, {
      seasonMonth: h.match.seasonMonth, now: h.match.scheduledKickoffAt + 1350000,
      timeline: replay.timeline, lineups: replay.lineups
    });
    assert.equal(result.ok, true, result.detail || result.reason);
    assert.equal(h.match.status, 'settled');
    assert.deepEqual({ home: h.match.result.home, away: h.match.result.away }, replay.score);
    assert.ok(Array.isArray(h.match.fantasyStats));
    assert.ok(h.match.highlights);
    assert.equal(h.match.highlights.goals.length, replay.score.home + replay.score.away);
  } finally { h.close(); }
});
