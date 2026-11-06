'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { generateReplay, generateOutcome, deriveReplay } = require('../lib/football/v2/adapter');
const { halfTimeScoreFromTimeline, firstScorerFromTimeline, cardsFromTimeline } = require('../lib/football/odds');
const { matchStats: fantasyMatchStats } = require('../lib/football/fantasy');
const { buildHighlights } = require('../lib/football/highlights');
const { secureRandom, newKey, derivedKey } = require('../lib/football/v2/secure-random');
const { createMatch, FIELD, STEP } = require('../lib/football/v2/simulator');
const { extractBallonDorMatchStats } = require('../lib/football/ballon-dor-stats');
const { FootballEngine } = require('../lib/football/engine');
const { createOfficialV2 } = require('../lib/football/v2/official');
const { clubRoster } = require('../lib/football/roster');
const { buildClubNews } = require('../lib/football/club-news');

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

test('generateOutcome obtiene marcador, eventos y estadísticas idénticos a generateReplay sin reservar frames', () => {
  const h = setup();
  try {
    const key = '07'.repeat(32);
    const replay = generateReplay(h.input, key);
    const outcome = generateOutcome(h.input, key);
    assert.equal(outcome.frames, undefined);
    assert.equal(outcome.inputHash, replay.inputHash);
    assert.deepEqual(outcome.score, replay.score);
    assert.equal(outcome.result, replay.result);
    assert.deepEqual(outcome.clock, replay.clock);
    assert.deepEqual(outcome.lineups, replay.lineups);
    assert.deepEqual(outcome.stats, replay.stats);
    assert.equal(outcome.timeline.length, replay.timeline.length);
    const stripCommentary = list => list.map(({ commentary: _commentary, ...rest }) => rest);
    assert.deepEqual(stripCommentary(outcome.timeline), stripCommentary(replay.timeline));
    assert.deepEqual(halfTimeScoreFromTimeline(outcome.timeline), halfTimeScoreFromTimeline(replay.timeline));
    assert.deepEqual(firstScorerFromTimeline(outcome.timeline), firstScorerFromTimeline(replay.timeline));
    assert.deepEqual(cardsFromTimeline(outcome.timeline), cardsFromTimeline(replay.timeline));
    assert.deepEqual(
      extractBallonDorMatchStats(h.match, outcome.timeline, outcome.lineups, { expectedScore: outcome.score }),
      extractBallonDorMatchStats(h.match, replay.timeline, replay.lineups, { expectedScore: replay.score })
    );
    assert.deepEqual(
      fantasyMatchStats(h.match, outcome.timeline, outcome.lineups),
      fantasyMatchStats(h.match, replay.timeline, replay.lineups)
    );
    assert.deepEqual(
      buildHighlights(h.match, outcome.timeline, outcome.lineups, { result: outcome.score }),
      buildHighlights(h.match, replay.timeline, replay.lineups, { result: replay.score })
    );
  } finally { h.close(); }
});

test('V2 atribuye asistencias causales a goles en jugada y alimenta Balón de Oro, Fantasy, resumen, plantilla y MonteCristo News', () => {
  const h = setup();
  try {
    let assistedFound = null;
    for (let i = 0; i < 16 && !assistedFound; i++) {
      const m = h.league.calendar.matches[i];
      const input = prepareMatchInputs({ league: h.league, match: m, seed: 0, asOf: m.scheduledKickoffAt - 1 });
      const key = String(i + 1).padStart(64, 'b');
      const replay = generateReplay(input, key);
      const outcome = generateOutcome(input, key);
      for (const pen of replay.timeline.filter(e => e.type === 'penalty_scored')) {
        assert.equal(pen.assistId, undefined, 'los penales nunca registran asistencia');
      }
      const goalWithAssist = replay.timeline.find(e => e.type === 'goal' && e.assistId);
      if (goalWithAssist) {
        assistedFound = { match: m, input, key, replay, outcome, goalWithAssist };
      }
    }
    assert.ok(assistedFound, 'la simulación causal V2 produce goles con pase previo asistido');
    const { match, replay, outcome, goalWithAssist } = assistedFound;
    assert.ok(goalWithAssist.assistName, 'el evento de gol incluye el nombre del asistente');
    assert.notEqual(goalWithAssist.assistId, goalWithAssist.playerId, 'el asistente nunca es el propio goleador');

    const outcomeGoal = outcome.timeline.find(e => e.i === goalWithAssist.i);
    assert.equal(outcomeGoal.assistId, goalWithAssist.assistId);
    assert.equal(outcomeGoal.assistName, goalWithAssist.assistName);

    const settled = h.store.settleMatch(match.id, replay.score, {
      seasonMonth: match.seasonMonth,
      now: match.scheduledKickoffAt + 1350000,
      timeline: replay.timeline,
      lineups: replay.lineups
    });
    assert.equal(settled.ok, true, settled.detail || settled.reason);
    const fantasyRow = match.fantasyStats.find(r => r.id === goalWithAssist.assistId);
    assert.ok(fantasyRow && fantasyRow.assists >= 1, 'fantasyStats registra la asistencia del jugador');
    assert.ok(match.highlights.goals.some(g => g.assist === goalWithAssist.assistName), 'highlights registra el asistente');

    const assisterSide = replay.lineups.home.players.some(p => p.id === goalWithAssist.assistId) ? match.homeId : match.awayId;
    const roster = clubRoster(h.league, assisterSide);
    const rosterPlayer = roster.players.find(p => p.id === goalWithAssist.assistId);
    assert.ok(rosterPlayer && rosterPlayer.stats.assists >= 1, 'la plantilla del club refleja las asistencias');

    // Si un candidato ST del Balón de Oro asiste o marca, MonteCristo News expone sus asistencias verificadas.
    const sortedMatches = h.league.calendar.matches
      .filter(m => !m.desempate && m.jornada <= 3)
      .slice()
      .sort((a, b) => a.scheduledKickoffAt - b.scheduledKickoffAt);
    let cursorAt = match.settledAt || match.scheduledKickoffAt + 1350000;
    for (let i = 0; i < sortedMatches.length; i++) {
      const m = sortedMatches[i];
      if (m.status === 'settled') continue;
      cursorAt = Math.max(cursorAt + 1000, m.scheduledKickoffAt);
      const input = prepareMatchInputs({ league: h.league, match: m, seed: 0, asOf: cursorAt });
      const out = generateOutcome(input, String(i + 20).padStart(64, 'c'));
      cursorAt += 1350000;
      h.store.settleMatch(m.id, out.score, {
        seasonMonth: m.seasonMonth,
        now: cursorAt,
        timeline: out.timeline,
        lineups: out.lineups
      });
    }
    const candidateWithAssist = h.league.ballonDor.candidates.find(c => c.stats.assists > 0);
    assert.ok(candidateWithAssist, 'al menos un delantero candidato acumula asistencias en el ciclo V2');
    assert.equal(candidateWithAssist.points.assists, candidateWithAssist.stats.assists * 3);
    const news = buildClubNews(h.league, null, Infinity);
    const bdoNews = news.find(item => item.type === 'ballon_dor_spotlight');
    if (bdoNews) assert.match(bdoNews.subtitle, /asistencias verificadas/);
  } finally { h.close(); }
});

test('reconcileBoot reconstruye asistencias V2 en partidos ya asentados de la temporada activa y repara Balón de Oro', async () => {
  const h = setup();
  try {
    const officialV2 = createOfficialV2({ store: h.store, log: () => {} });
    const engine = new FootballEngine(h.store, { officialV2, logEvent: () => {} });
    const j1 = h.league.calendar.matches.filter(m => m.jornada === 1);
    const prepAt = j1[0].scheduledKickoffAt - 60000;
    const prep = await officialV2.prepareMatches('2026-11', j1, prepAt);
    assert.equal(prep.ok, true, prep.reason);
    await h.store.transitionBallonDor('2026-11', 'active', { at: prepAt });

    let settleNow = prepAt;
    for (const m of j1) {
      settleNow = Math.max(settleNow + 1000, m.scheduledKickoffAt + 7200000);
      const out = engine.settleOverdueMatch(m, settleNow);
      assert.equal(out.ok, true, out.reason);
    }
    const totalAssistsExpected = h.league.calendar.matches
      .filter(m => m.jornada === 1)
      .reduce((sum, m) => sum + (m.fantasyStats || []).reduce((acc, r) => acc + (r.assists || 0), 0), 0);
    assert.ok(totalAssistsExpected > 0, 'la jornada 1 V2 generó asistencias reales');

    // Simula el estado previo al fix: partidos V2 ya asentados con assists=0 en archivo y acumulado BDO.
    for (const m of j1) {
      m.fantasyStats = m.fantasyStats.map(row => ({ ...row, assists: 0 }));
      if (m.highlights && Array.isArray(m.highlights.goals)) {
        m.highlights = { ...m.highlights, goals: m.highlights.goals.map(({ assist: _a, ...g }) => g) };
      }
    }
    await h.store.repairBallonDor('2026-11', { apply: true, at: settleNow + 10 });
    assert.ok(h.league.ballonDor.candidates.every(c => c.stats.assists === 0));

    await engine.reconcileBoot(settleNow + 20);
    const totalAssistsRestored = h.league.calendar.matches
      .filter(m => m.jornada === 1)
      .reduce((sum, m) => sum + (m.fantasyStats || []).reduce((acc, r) => acc + (r.assists || 0), 0), 0);
    assert.equal(totalAssistsRestored, totalAssistsExpected, 'reconcileBoot restaura las asistencias exactas del compromiso V2');
    const audit = h.store.auditBallonDor('2026-11');
    assert.equal(audit.mismatched, 0, 'el acumulado del Balón de Oro queda cuadrado tras el backfill');
  } finally { h.close(); }
});

