'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeasonClubs } = require('../lib/football/teams');
const { mulberry32 } = require('../lib/football/prng');
const { prepareMatchInputs, previousMonth } = require('../lib/football/v2/inputs');
const { createMatch, END } = require('../lib/football/v2/simulator');

function leagues() {
  const clubs = buildSeasonClubs(mulberry32(123));
  const prevClubs = buildSeasonClubs(mulberry32(456));
  const [home, away] = clubs;
  const now = Date.UTC(2026, 10, 1, 18);
  const match = { id: 'example', seasonMonth: '2026-11', homeId: home.id, awayId: away.id, status: 'scheduled' };
  const current = { seasonMonth: '2026-11', config: clubs, calendar: { matches: [match] } };
  const prev = { seasonMonth: '2026-10', config: prevClubs, calendar: { matches: [] } };
  for (let i = 0; i < 10; i++) prev.calendar.matches.push({
    homeId: home.id, awayId: away.id, status: 'settled', settledAt: now - (i + 1) * 1000,
    result: { home: 2, away: 1 }
  });
  return { home, away, match, current, prev, now };
}

function end(simulation) {
  while (!simulation.snapshot().ended) simulation.step(10000);
  return simulation.snapshot();
}

test('la entrada usa once y ratings persistidos e incorpora octubre solo si hay resultados asentados', () => {
  const { home, away, match, current, prev, now } = leagues();
  prev.config.find(club => club.id === home.id).ratings.att = 1.35;
  home.ratings.att = 0.8;
  const input = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 123 });
  assert.equal(input.source.currentSeason, '2026-11');
  assert.equal(input.source.previousSeason, '2026-10');
  assert.equal(input.source.home.previousMatches, 10);
  assert.ok(input.source.home.previousWeight > 0);
  assert.ok(input.home.ratings.att > home.ratings.att && input.home.ratings.att < 1.35);
  assert.equal(input.home.ratings.gk, home.ratings.gk, 'se usa el portero de la plantilla nueva');
  assert.equal(input.home.lineup.players.length, 18);
  assert.equal(input.home.lineup.players.filter(player => player.initialStatus === 'active').length, 11);
  const original = JSON.parse(JSON.stringify(input));
  home.ratings.att = 1.2;
  home.squad[0].name = 'Cambio posterior';
  assert.deepEqual(input, original, 'la entrada congelada no comparte objetos mutables del store');
  const simulation = createMatch(input);
  const snapshot = simulation.snapshot();
  const homeIds = new Set(input.home.lineup.players.filter(p => p.initialStatus === 'active').map(p => p.id));
  const awayIds = new Set(input.away.lineup.players.filter(p => p.initialStatus === 'active').map(p => p.id));
  assert.ok(snapshot.players.filter(p => p.side === 'home').every(p => homeIds.has(p.id)));
  assert.ok(snapshot.players.filter(p => p.side === 'away').every(p => awayIds.has(p.id)));
  assert.deepEqual(end(simulation), end(createMatch(original)), 'la misma entrada reproduce los 90 minutos');
  assert.ok(end(createMatch(input)).time > END, 'incluye tiempo añadido');
  assert.ok(away.squad.some(p => awayIds.has(p.id)));
});

test('sin historial no se inventan resultados, y el peso de octubre cae durante noviembre', () => {
  const { home, match, current, prev, now } = leagues();
  const absent = prepareMatchInputs({ league: current, match, asOf: now, seed: 9 });
  assert.equal(absent.source.previousSeason, null);
  assert.equal(absent.source.home.previousMatches, 0);
  assert.equal(absent.home.ratings.att, home.ratings.att);
  const initial = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 9 });
  current.calendar.matches.push({ ...match, id: 'completed', status: 'settled', settledAt: now - 1, result: { home: 0, away: 0 } });
  const later = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 9 });
  assert.equal(later.source.home.currentMatches, 1);
  assert.ok(later.source.home.previousWeight < initial.source.home.previousWeight);
  prev.seasonMonth = '2026-09';
  const nonAdjacent = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 9 });
  assert.equal(nonAdjacent.source.previousSeason, null);
  assert.equal(previousMonth('2027-01'), '2026-12');
});

test('no usa ratings que ya incorporan partidos posteriores y rechaza onces incompletos', () => {
  const { match, current, prev, now } = leagues();
  prev.calendar.matches[0].settledAt = now + 1;
  assert.throws(() => prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 1 }), /posteriores/);
  prev.calendar.matches[0].settledAt = now - 1;
  const input = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 1 });
  input.home.lineup.players.find(p => p.initialStatus === 'active').initialStatus = 'bench';
  assert.throws(() => createMatch(input), /once titular inválido/);
});

test('los ratings del equipo influyen en una simulación con los mismos jugadores y semilla', () => {
  const { match, current, prev, now } = leagues();
  const input = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 12 });
  const alternative = JSON.parse(JSON.stringify(input));
  input.home.ratings.att = 0.7; input.home.ratings.def = 1.35;
  alternative.home.ratings.att = 1.35; alternative.home.ratings.def = 0.7;
  const before = createMatch(input);
  const after = createMatch(alternative);
  assert.deepEqual(before.snapshot().players, after.snapshot().players);
  assert.notDeepEqual(before.step(1000), after.step(1000));
});

test('congela la media de goles de la liga actual y da menos peso a la temporada previa con más partidos', () => {
  const { match, current, prev, now } = leagues();
  for (const game of prev.calendar.matches) game.result = { home: 2, away: 2 };
  const first = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 1 });
  assert.equal(first.context.previousSample, 10);
  assert.ok(first.context.previousWeight > 0);
  assert.ok(first.context.leagueAvg > 1.35 && first.context.leagueAvg < 1.85);
  current.calendar.matches.push({ ...match, id: 'final', status: 'settled', settledAt: now - 1, result: { home: 2, away: 1 } });
  const next = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 1 });
  assert.ok(next.context.previousWeight < first.context.previousWeight);
  const snapshot = first.context.leagueAvg;
  prev.calendar.matches[0].result.home = 10;
  assert.equal(first.context.leagueAvg, snapshot, 'una preparación confirmada no cambia con la liga mutable');
  prev.calendar.matches[0].result.home = -1;
  assert.throws(() => prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 1 }), /resultado histórico inválido/);
});

test('Elo y media de goles influyen en las jugadas sin fijar el marcador', () => {
  const { match, current, prev, now } = leagues();
  const original = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 12 });
  const base = JSON.parse(JSON.stringify(original));
  base.home.ratings.elo = 1500; base.away.ratings.elo = 1500; base.context.leagueAvg = 1.35;
  const stronger = JSON.parse(JSON.stringify(base));
  stronger.home.ratings.elo = 1700; stronger.away.ratings.elo = 1300;
  const scoring = JSON.parse(JSON.stringify(base));
  scoring.context.leagueAvg = 1.85;
  const baseSim = createMatch(base), eloSim = createMatch(stronger), avgSim = createMatch(scoring);
  assert.deepEqual(baseSim.snapshot().score, { home: 0, away: 0 });
  assert.deepEqual(eloSim.snapshot().score, { home: 0, away: 0 });
  assert.notDeepEqual(eloSim.step(10000), baseSim.step(10000));
  const sameBase = createMatch(base);
  assert.notDeepEqual(avgSim.step(10000), sameBase.step(10000));
});


test('el promedio reciente ordena por kickoff reprogramado antes de elegir la ventana de 60', () => {
  const { match, current, now } = leagues();
  const records = Array.from({ length: 61 }, (_, i) => ({ ...match, id: `played-${i}`, status: 'settled',
    scheduledKickoffAt: now - (61 - i) * 1000, settledAt: now - (61 - i) * 1000 + 500,
    result: i === 60 ? { home: 7, away: 7 } : { home: 1, away: 1 } }));
  // La jornada reprogramada es la más reciente aunque siga al principio del array.
  current.calendar.matches = [match, records[60], ...records.slice(0, 60)];
  const input = prepareMatchInputs({ league: current, match, asOf: now, seed: 0 });
  assert.equal(input.context.sample, 60);
  assert.equal(input.context.leagueAvg, 1.1);
});

test('la muestra histórica informada respeta la ventana de 60 partidos', () => {
  const { match, current, prev, now } = leagues();
  for (let i = 0; i < 61; i++) prev.calendar.matches.push({ ...prev.calendar.matches[0], settledAt: now - (20 + i) * 1000 });
  const input = prepareMatchInputs({ league: current, previousLeague: prev, match, asOf: now, seed: 0 });
  assert.equal(input.context.previousSample, 60);
  assert.equal(input.context.sample, 0);
});
