'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { generateReplay, deriveReplay } = require('../lib/football/v2/adapter');
const { makeCommitment, verifyCommitment } = require('../lib/football/v2/commitment');
const { secureRandom } = require('../lib/football/v2/secure-random');
const { legacy } = require('../lib/football/v2/versions');
const { extractBallonDorMatchStats } = require('../lib/football/ballon-dor-stats');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-rules-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason('2026-11');
  const match = league.calendar.matches[0];
  const input = prepareMatchInputs({ league, match, asOf: match.scheduledKickoffAt - 1, seed: 0 });
  return { store, league, match, input, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('el añadido se anuncia por mitad y se juega antes de cerrar; el relato se conserva en el replay', () => {
  const h = setup();
  try {
    const replay = generateReplay(h.input, '01'.repeat(32));
    const starts = replay.timeline.filter(e => e.type === 'stoppage_start');
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map(e => e.half), [1, 2]);
    assert.equal(starts[0].t, 45);
    assert.equal(starts[1].t, replay.clock.firstHalfEnd + 45);
    assert.equal(starts[0].addedMinutes, replay.clock.s1);
    assert.equal(starts[1].addedMinutes, replay.clock.s2);
    assert.ok(starts.every(e => e.commentary.some(line => /añade/.test(line.text))));
    assert.equal(replay.clock.matchEnd, 90 + replay.clock.s1 + replay.clock.s2);
    assert.equal(replay.timeline.at(-1).type, 'full_time');
    assert.equal(replay.timeline.at(-1).t, replay.clock.matchEnd);
    assert.equal(replay.timeline.find(e => e.type === 'halftime').clockLabel, `45+${replay.clock.s1}`);
    assert.equal(replay.timeline.at(-1).clockLabel, `90+${replay.clock.s2}`);
    assert.equal(deriveReplay(replay, 45.01).state.clockLabel, '45+1');
    assert.equal(deriveReplay(replay, replay.clock.firstHalfEnd + 45.01).state.clockLabel, '90+1');
    assert.notEqual(deriveReplay(replay, replay.clock.matchEnd - 0.01).state.phase, 'ended');
    assert.equal(deriveReplay(replay, replay.clock.matchEnd).state.phase, 'ended');
    assert.ok(replay.timeline.filter(e => e.type === 'goal' || e.type === 'penalty_scored')
      .every(e => e.commentary.some(line => line.voice === 'narrador') && e.commentary.some(line => line.voice === 'analista')));
  } finally { h.close(); }
});

test('cambios y tarjetas afectan a las fichas reales y a los minutos de las estadísticas', () => {
  const h = setup();
  try {
    const replay = generateReplay(h.input, '01'.repeat(32));
    const changes = replay.timeline.filter(e => e.type === 'substitution');
    const cards = replay.timeline.filter(e => ['yellow_card', 'second_yellow', 'red_card'].includes(e.type));
    assert.ok(changes.length >= 4);
    assert.ok(cards.length > 0);
    for (const event of changes) {
      const before = deriveReplay(replay, (event.tick - 0.01) * 0.5 / 60).state;
      const after = deriveReplay(replay, (event.tick + 0.01) * 0.5 / 60).state;
      assert.equal(before.players.find(p => p.id === event.playerOutId).active, true);
      assert.equal(before.players.find(p => p.id === event.playerInId).active, false);
      assert.equal(after.players.find(p => p.id === event.playerOutId).status, 'substituted');
      assert.equal(after.players.find(p => p.id === event.playerInId).active, true);
      assert.ok(event.commentary.some(line => line.text.includes(event.playerOutName) && line.text.includes(event.playerInName)));
    }
    for (const card of cards) {
      assert.ok(replay.timeline.some(e => e.type === 'foul' && e.sequenceId === card.sequenceId && e.playerId === card.playerId));
      assert.ok(card.commentary.some(line => line.voice === 'narrador'));
      if (card.type !== 'yellow_card') {
        const after = deriveReplay(replay, (card.tick + 0.01) * 0.5 / 60).state;
        assert.equal(after.players.find(p => p.id === card.playerId).status, 'sent_off');
      }
    }
    const stats = extractBallonDorMatchStats(h.match, replay.timeline, replay.lineups, { expectedScore: replay.score });
    assert.equal(stats.ok, true, stats.reason);
    for (const event of changes) {
      assert.ok(stats.players.get(event.playerInId).minutes > 0);
      assert.ok(stats.players.get(event.playerOutId).minutes < replay.clock.matchEnd);
    }
  } finally { h.close(); }
});

test('los compromisos de la versión experimental anterior se reproducen con su motor original', () => {
  const h = setup();
  try {
    const input = { ...h.input, version: legacy.VERSION };
    const key = '8a'.repeat(32);
    const commitment = makeCommitment(input, key, h.match.scheduledKickoffAt - 1);
    assert.equal(verifyCommitment(commitment, h.match), true);
    const replay = generateReplay(input, key);
    const original = legacy.createMatch({ ...input, random: secureRandom(key, 'game') });
    while (!original.snapshot().ended) original.step(10000);
    assert.equal(replay.version, legacy.VERSION);
    assert.equal(replay.clock.matchEnd, 90);
    assert.deepEqual(replay.score, original.snapshot().score);
    assert.equal(replay.timeline.filter(e => e.type === 'substitution').length, 0);
    const demo = legacy.createMatch({ seed: 20261102 });
    while (!demo.snapshot().ended) demo.step(10000);
    assert.deepEqual(demo.snapshot().score, { home: 2, away: 1 });
  } finally { h.close(); }
});
