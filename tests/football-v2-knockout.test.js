'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSeasonClubs } = require('../lib/football/teams');
const { mulberry32 } = require('../lib/football/prng');
const { FootballStore } = require('../lib/football-store');
const { FootballEngine } = require('../lib/football/engine');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { knockout } = require('../lib/football/v2/versions');
const { createOfficialV2 } = require('../lib/football/v2/official');
const Policy = require('../lib/football/v2/season-policy');
const Q = require('../lib/football/v2/quotes');
const { makeCommitment, verifyCommitment, commitmentId } = require('../lib/football/v2/commitment');
const { generateReplay, deriveReplay } = require('../lib/football/v2/adapter');

function fixture() {
  const clubs = buildSeasonClubs(mulberry32(1));
  const match = { id: 'final', seasonMonth: '2026-11', homeId: clubs[0].id, awayId: clubs[1].id, desempate: true };
  const league = { seasonMonth: '2026-11', config: clubs, calendar: { matches: [] } };
  const input = prepareMatchInputs({ league, match, asOf: Date.UTC(2026, 10, 1), seed: 0 });
  input.version = knockout.VERSION; input.knockout = true;
  return { match, league, input };
}

test('desempate V2 puede resolverse en tiempo normal, prórroga o tanda con físicos causales', () => {
  const seen = { regular: 0, extra: 0, shootout: 0, home: 0, away: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    const game = knockout.createMatch({ seed, knockout: true });
    let before = game.snapshot();
    while (!before.ended) {
      const after = game.step();
      if (before.half >= 3 || after.half >= 3) {
        const events = game.eventsAfter(before.lastEventId);
        for (const side of ['home', 'away']) {
          assert.equal(after.score[side] - before.score[side], events.filter(e => e.type === 'goal' && e.team === side).length);
        }
        assert.ok(knockout.distance(before.ball, after.ball) <= knockout.MAX_BALL_SPEED * knockout.STEP + 1e-7);
        for (let i = 0; i < after.players.length; i++) {
          assert.ok(knockout.distance(before.players[i], after.players[i]) <= knockout.MAX_PLAYER_SPEED * knockout.STEP + 1e-7);
        }
      }
      assert.ok(after.time <= knockout.MAX_KNOCKOUT_END);
      before = after;
    }
    const events = game.eventsAfter(-1), result = before.result;
    assert.ok(['home', 'away'].includes(result.winner)); seen[result.winner]++;
    const kicks = events.filter(e => e.type === 'shootout_kick');
    if (kicks.length) {
      seen.shootout++;
      assert.equal(before.score.home, before.score.away, 'la tanda no suma goles al marcador');
      const marks = { home: 0, away: 0 }, taken = { home: 0, away: 0 };
      for (const kick of kicks) {
        assert.equal(kick.team, taken.home === taken.away ? 'home' : 'away');
        if (kick.scored) marks[kick.team]++;
        taken[kick.team]++;
        assert.deepEqual(kick.marks, marks);
      }
      if (taken.home > 5 || taken.away > 5) assert.equal(taken.home, taken.away, 'muerte súbita con ambos turnos');
      assert.notEqual(marks.home, marks.away);
      assert.equal(result.winner, marks.home > marks.away ? 'home' : 'away');
    } else if (before.clock.extraTimeStart != null) { seen.extra++; assert.notEqual(before.score.home, before.score.away); }
    else { seen.regular++; assert.notEqual(before.score.home, before.score.away); }
    assert.equal(events.at(-1).type, 'full_time');
  }
  assert.ok(Object.values(seen).every(value => value > 0), JSON.stringify(seen));
});

test('replay de tanda solo revela penales jugados, mantiene cuotas durante prórroga y recupera ganador', () => {
  const { input, match } = fixture(), key = '05'.repeat(32), model = Q.createEstimatedModel(input);
  const record = makeCommitment(input, key, input.asOf, model);
  assert.ok(verifyCommitment(record, match));
  assert.equal(verifyCommitment(record, { ...match, desempate: false }), false);
  const replay = generateReplay(input, key), replay2 = generateReplay(input, key);
  assert.deepEqual(replay.result, replay2.result);
  assert.ok(replay.clock.extraTimeStart && replay.clock.shootoutStart);
  assert.equal(replay.score.home, replay.score.away);
  const normal = deriveReplay(replay, replay.clock.extraTimeStart - 1).state;
  assert.equal(normal.half, 2); assert.equal(normal.shootout, undefined);
  const extra = deriveReplay(replay, replay.clock.extraTimeStart + 4).state;
  assert.equal(extra.half, 3); assert.ok(['extra_time', 'set_piece'].includes(extra.phase));
  const live = Q.liveMarket(model, '1x2', { ...extra, playStopped: false });
  assert.ok(live && live.selections.length === 3);
  const kicks = replay.timeline.filter(e => e.type === 'shootout_kick');
  assert.ok(kicks.length >= 6);
  const before = deriveReplay(replay, kicks[0].t - knockout.STEP / 60).state;
  assert.deepEqual(before.shootout, { home: 0, away: 0 });
  const after = deriveReplay(replay, kicks[0].t).state;
  assert.deepEqual(after.shootout, { home: kicks[0].team === 'home' && kicks[0].scored ? 1 : 0,
    away: kicks[0].team === 'away' && kicks[0].scored ? 1 : 0 });
  const ended = deriveReplay(replay, replay.clock.matchEnd).state;
  assert.equal(ended.phase, 'ended');
  assert.equal(replay.result.winner, ended.shootout.home > ended.shootout.away ? 'home' : 'away');
});

test('futuro de campeón admitido antes del desempate permite preparar y asentar su ganador V2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-title-'));
  const file = path.join(dir, 'football.json'), store = new FootballStore(file);
  try {
    const league = store.generateSeason('2026-11'), at = Date.UTC(2026, 10, 30, 17);
    league.simulationPolicy = Policy.createPolicy('2026-11', at - 1000, '44'.repeat(32));
    const future = { id: 'champion', idempotencyKey: 'champion-v2', profileId: 'p', seasonMonth: '2026-11',
      market: 'champion', selection: league.config[0].id, stake: 100, odds: 5, status: 'open', debited: true,
      simulationPolicyId: league.simulationPolicy.id, simulationCommitments: [] };
    assert.ok(store.insertFuture(future).ok);
    for (const match of league.calendar.matches) {
      match.status = 'settled'; match.result = { home: 0, away: 0 }; match.settledAt = at - 5000;
    }
    league.ballonDor.status = 'locked';
    const created = await store.createBallonDorTiebreak('2026-11', { homeId: league.config[0].id,
      awayId: league.config[1].id, kickoffAt: at + 60000 });
    assert.ok(created.ok, created.reason);
    const match = created.match, v2 = createOfficialV2({ store, now: () => at });
    assert.equal((await v2.prepareMatch(match)).ok, true);
    assert.equal(match.simulation.version, knockout.VERSION);
    assert.equal(match.simulation.privateSeed, Policy.matchKey(league.simulationPolicy, match));
    assert.ok(verifyCommitment(match.simulation, match));
    const engine = new FootballEngine(store, { officialV2: v2 });
    assert.equal(engine._hasIncompatibleV2Bets(match), false);
    const replay = engine._ensureTimeline(match);
    assert.equal(engine.startMatch(match, match.scheduledKickoffAt), true);
    assert.equal(engine.advance(match, match.scheduledKickoffAt + replay.clock.matchEnd * 15000 + 1).ended, true);
    assert.equal(match.status, 'settled');
    assert.equal(match.result.winner, replay.result.winner);
    assert.equal(store.getFuture(future.id).odds, 5);
    const loaded = new FootballStore(file), restored = loaded.getMatch(match.id);
    assert.equal(commitmentId(restored.simulation), commitmentId(match.simulation));
    assert.equal(restored.result.winner, replay.result.winner);
    assert.deepEqual(new FootballEngine(loaded)._ensureTimeline(restored).result, replay.result);
    loaded.close();
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('una tanda inusualmente larga no fuerza el resultado y aísla los eventos entregados', () => {
  const game = knockout.createMatch({ seed: 1, knockout: true, random: () => .99 });
  let state = game.snapshot(), kicks = [];
  while (!state.ended && kicks.length < 90 && state.time < knockout.MAX_KNOCKOUT_END) {
    state = game.step(100);
    kicks = game.eventsAfter(-1).filter(event => event.type === 'shootout_kick');
  }
  assert.ok(kicks.length >= 90, 'más de 32 rondas de muerte súbita');
  assert.equal(state.ended, false);
  assert.ok(kicks.every(event => !event.scored), 'ningún gol se impone artificialmente');
  kicks[0].marks.home = 999;
  assert.equal(game.eventsAfter(-1).find(event => event.type === 'shootout_kick').marks.home, 0);
});
