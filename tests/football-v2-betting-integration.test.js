'use strict';

// Ensayo funcional con histogramas sintéticos; NO certifica los precios ni
// activa el motor oficial. Comprueba el recorrido del boleto hasta su pago.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { FootballEngine } = require('../lib/football/engine');
const { createBettingService } = require('../lib/football/betting');
const { prepareV2Match, attachV2Pricing } = require('../lib/football/v2/prepare');
const { commitmentId } = require('../lib/football/v2/commitment');
const C = require('../lib/football/v2/calibration');
const { VERSION } = require('../lib/football/v2/simulator');
const P = require('../lib/progression');

function samples(match) {
  const base = { version: C.VERSION, simulatorVersion: VERSION, inputHash: match.simulation.inputsHash, samples: 2048,
    counts: { '0-0': 400, '1-0': 500, '0-1': 360, '1-1': 420, '2-0': 150, '2-1': 130, '1-2': 88 },
    liveByState: [{ '0-0|1|0-0': { home: 90, draw: 60, away: 50 } }] };
  return { training: { ...base, keyCommitment: 'aa'.repeat(32) },
    holdout: { ...base, keyCommitment: 'bb'.repeat(32) } };
}
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bets-'));
  const file = path.join(dir, 'football.json');
  const store = new FootballStore(file);
  const league = store.generateSeason('2026-11');
  const matches = league.calendar.matches.slice(0, 2);
  const now = Math.min(...league.calendar.matches.map(match => match.scheduledKickoffAt)) - 120000;
  const profileFile = path.join(dir, 'profiles.json');
  const profiles = new ProfileStore(profileFile);
  const people = ['uno', 'dos', 'tres'].map(id => {
    const profile = profiles.getOrCreate(id, id, null);
    profile.chips = 1000;
    profile.achievements = P.ACHIEVEMENTS.map(item => item.id);
    profile.challenges = Object.fromEntries(P.CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
    P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false });
    profile.rotatingChallenges.daily.completed = true;
    profile.rotatingChallenges.weekly.completed = true;
    return profile;
  });
  profiles.saveNow();
  const betting = createBettingService({ store, profiles, now: () => now });
  const engine = new FootballEngine(store, { settleBets: (match, score) => betting.settleMatchBets(match, score) });
  return { dir, file, profileFile, store, league, matches, now, profiles, people, betting, engine,
    close() { store.close(); profiles.saveNow(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function prepare(h, match, index) {
  assert.equal((await prepareV2Match({ store: h.store, match, asOf: h.now, keyFactory: () => String(index).repeat(64) })).ok, true);
  assert.equal((await attachV2Pricing({ store: h.store, match, asOf: h.now, ...samples(match) })).ok, true);
}

test('cuotas V2 ligadas al compromiso pagan simples y combinadas contra su propio replay', async () => {
  const h = setup();
  try {
    for (let i = 0; i < h.matches.length; i++) await prepare(h, h.matches[i], i + 1);
    const [first] = h.matches;
    const price = h.betting.getMarket(first, '1x2').selections.find(item => item.key === 'home').price;
    const simple = await h.betting.placeBet({ profile: h.people[0], matchId: first.id, market: '1x2', selection: 'home', stake: 100, placedAt: h.now });
    assert.equal(simple.ok, true, simple.code);
    assert.equal(simple.bet.oddsAtPlacement, price);
    assert.equal(simple.bet.simulationId, commitmentId(first.simulation));
    const parlay = await h.betting.placeParlay({ profile: h.people[1], stake: 100, placedAt: h.now,
      legs: h.matches.map(match => ({ matchId: match.id, market: '1x2', selection: 'home' })) });
    assert.equal(parlay.ok, true, parlay.code);
    assert.deepEqual(parlay.parlay.legs.map(leg => leg.simulationId), h.matches.map(match => commitmentId(match.simulation)));
    const other = await h.betting.placeBet({ profile: h.people[2], matchId: first.id, market: '1x2', selection: 'away', stake: 100, placedAt: h.now });
    assert.equal(other.ok, true, other.code);

    // La calibración y las referencias de los boletos sobreviven al reinicio.
    const loaded = new FootballStore(h.file);
    assert.equal(loaded.getBet(simple.bet.id).simulationId, simple.bet.simulationId);
    assert.ok(loaded.getMatch(first.id, '2026-11').simulation.pricing);
    assert.equal(loaded.getParlay(parlay.parlay.id).legs[1].simulationId, parlay.parlay.legs[1].simulationId);
    loaded.close();

    const results = [];
    for (const match of h.matches) {
      const replay = h.engine._ensureTimeline(match);
      const kick = match.scheduledKickoffAt;
      assert.equal(h.engine.startMatch(match, kick), true, 'los boletos compatibles no bloquean V2');
      if (match === first) {
        let observed;
        for (let delay = 1; delay < 14000; delay += 100) {
          const derived = h.engine.deriveMatchState(match, kick + delay);
          const state = derived.state;
          if (!state.playStopped && state.score.home === 0 && state.score.away === 0) {
            observed = { minute: derived.minute, half: state.half, score: state.score, redCards: state.redCards,
              phase: state.phase, playStopped: state.playStopped };
            break;
          }
        }
        assert.ok(observed, 'hay estado live público cubierto por la muestra de prueba');
        const live = h.betting.getMarket(match, '1x2', observed);
        assert.ok(live);
        assert.equal(h.betting.getMarket(match, '1x2', {}), null, 'no se usa la cuota prepartido durante el juego');
        const cashed = await h.betting.cashout(h.people[2], other.bet.id, observed);
        assert.equal(cashed.ok, true, cashed.code);
        assert.equal(h.people[2].chips, 900 + cashed.cashout);
      }
      const atEnd = kick + replay.clock.matchEnd * 15000 + h.engine.opts.halftimeMs + 1;
      assert.equal(h.engine.advance(match, atEnd).ended, true);
      assert.equal(match.status, 'settled');
      results.push(match.result);
    }
    const firstWon = results[0].home > results[0].away;
    assert.equal(h.store.getBet(simple.bet.id).status, firstWon ? 'won' : 'lost');
    assert.equal(h.people[0].chips, 900 + (firstWon ? simple.bet.potentialPayout : 0));
    const bothWon = firstWon && results[1].home > results[1].away;
    assert.equal(h.store.getParlay(parlay.parlay.id).status, bothWon ? 'won' : 'lost');
    assert.equal(h.people[1].chips, 900 + (bothWon ? parlay.parlay.potentialPayout : 0));
    assert.equal(h.store.getBet(other.bet.id).status, 'cashed');
  } finally { h.close(); }
});

test('la calibración V2 se confirma una vez, sin sustituirla tras fallar el guardado', async () => {
  const h = setup();
  try {
    const match = h.matches[0];
    assert.equal((await prepareV2Match({ store: h.store, match, asOf: h.now, keyFactory: () => '44'.repeat(32) })).ok, true);
    const good = samples(match);
    const save = h.store.saveStrict.bind(h.store);
    h.store.saveStrict = () => false;
    assert.equal((await attachV2Pricing({ store: h.store, match, asOf: h.now, ...good })).reason, 'persistencia_pendiente');
    assert.equal(h.betting.getMarket(match, '1x2'), null);
    const pricing = match.simulation.pricing;
    h.store.saveStrict = save;
    assert.equal((await attachV2Pricing({ store: h.store, match, asOf: h.now, training: {}, holdout: {} })).ok, true);
    assert.equal(match.simulation.pricing, pricing);
    assert.ok(h.betting.getMarket(match, '1x2'));
    assert.equal((await attachV2Pricing({ store: h.store, match, asOf: h.now, training: {}, holdout: {} })).existing, true);
    assert.equal(match.simulation.pricing, pricing);
  } finally { h.close(); }
});
