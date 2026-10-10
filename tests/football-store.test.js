'use strict';

// Fase A — Pruebas del store de archivo (§13): generación de temporada, tabla de
// posiciones que se actualiza al asentar, idempotencia y persistencia JSON de ida
// y vuelta. Es la aceptación completa de la Fase A.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { monthKey } = require('../lib/profile-store-shared');

let tmpDir;
test.before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-store-')); });
test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const newStore = (name) => new FootballStore(path.join(tmpDir, `${name}.json`));

test('generateSeason construye una temporada completa y la persiste', () => {
  const store = newStore('gen');
  const league = store.generateSeason('2026-10');
  assert.strictEqual(league.seasonMonth, '2026-10');
  assert.strictEqual(league.status, 'active');
  assert.strictEqual(league.config.length, 16, '16 clubes');
  assert.strictEqual(league.calendar.matches.length, 240, '240 partidos');
  assert.strictEqual(league.calendar.jornadas.length, 30, '30 jornadas');
  assert.strictEqual(league.standings.length, 16, 'tabla con 16 filas');
  assert.ok(league.standings.every(r => r.played === 0 && r.points === 0), 'tabla inicial en cero');
  assert.ok(Number.isInteger(league.seed) && league.seed >= 0, 'seed de temporada');
  assert.ok(fs.existsSync(store.filePath), 'el archivo se escribió');
  store.close();
});

test('generateSeason es determinista e idempotente por mes', () => {
  const a = newStore('det-a').generateSeason('2026-10');
  const b = newStore('det-b').generateSeason('2026-10');
  assert.strictEqual(a.seed, b.seed, 'mismo mes → mismo seed');
  assert.deepStrictEqual(a.calendar.matches.map(m => m.id), b.calendar.matches.map(m => m.id));
  // Llamar de nuevo devuelve la misma liga, no regenera.
  const store = newStore('det-c');
  const first = store.generateSeason('2026-10');
  const again = store.generateSeason('2026-10');
  assert.strictEqual(first, again, 'misma instancia si ya existe');
  store.close();
});

test('asentar un resultado actualiza la tabla, los ratings y la forma', () => {
  const store = newStore('settle');
  const league = store.generateSeason('2026-10');
  const j1 = league.calendar.jornadas[0];
  const first = j1.matches[0];
  const homeBefore = league.config.find(c => c.id === first.homeId).ratings.elo;

  const res = store.settleMatch(first.id, { home: 3, away: 0 });
  assert.ok(res.ok);
  assert.strictEqual(first.status, 'settled');
  assert.deepStrictEqual(first.result, { home: 3, away: 0, winner: 'home' });

  const st = store.getStandings('2026-10');
  const homeRow = st.find(r => r.teamId === first.homeId);
  const awayRow = st.find(r => r.teamId === first.awayId);
  assert.strictEqual(homeRow.played, 1);
  assert.strictEqual(homeRow.points, 3);
  assert.strictEqual(homeRow.goalsFor, 3);
  assert.strictEqual(homeRow.goalDiff, 3);
  assert.deepStrictEqual(homeRow.form, ['W']);
  assert.strictEqual(awayRow.points, 0);
  assert.deepStrictEqual(awayRow.form, ['L']);

  const homeClub = league.config.find(c => c.id === first.homeId);
  assert.ok(homeClub.ratings.elo !== homeBefore, 'el elo del ganador cambió');
  assert.deepStrictEqual(homeClub.form, ['W'], 'la forma del club refleja la tabla');
  store.close();
});

test('asentar es idempotente: re-procesar no duplica ni altera la tabla', () => {
  const store = newStore('idem');
  const league = store.generateSeason('2026-10');
  const match = league.calendar.jornadas[0].matches[0];
  store.settleMatch(match.id, { home: 2, away: 1 });
  const pointsAfterFirst = store.getStandings('2026-10').find(r => r.teamId === match.homeId).points;

  const again = store.settleMatch(match.id, { home: 2, away: 1 });
  assert.ok(again.ok && again.alreadySettled, 'segunda llamada marcada alreadySettled');
  const pointsAfterSecond = store.getStandings('2026-10').find(r => r.teamId === match.homeId).points;
  assert.strictEqual(pointsAfterFirst, pointsAfterSecond, 'los puntos no cambian');
  store.close();
});

test('resultados inválidos y partidos inexistentes se rechazan sin asentarse', () => {
  const store = newStore('invalid');
  const league = store.generateSeason('2026-10');
  const unsettled = league.calendar.jornadas[5].matches[0]; // jornada 6, sin asentar
  assert.strictEqual(unsettled.status, 'scheduled');

  assert.strictEqual(store.settleMatch(unsettled.id, { home: -1, away: 0 }).ok, false, 'goles negativos');
  assert.strictEqual(store.settleMatch(unsettled.id, { home: 1.5, away: 0 }).ok, false, 'goles no enteros');
  assert.strictEqual(store.settleMatch(unsettled.id, {}).ok, false, 'sin resultado');
  assert.strictEqual(store.settleMatch('m_inexistente', { home: 1, away: 0 }).reason, 'no_match');
  assert.strictEqual(unsettled.status, 'scheduled', 'el partido sigue sin asentarse');
  store.close();
});

test('una jornada completa deja la tabla coherente (suma de played y puntos)', () => {
  const store = newStore('jornada');
  const league = store.generateSeason('2026-10');
  const j1 = league.calendar.jornadas[0];
  // Mitad victorias locales 2-0, mitad empates 1-1.
  j1.matches.forEach((m, i) => store.settleMatch(m.id, i % 2 === 0 ? { home: 2, away: 0 } : { home: 1, away: 1 }));
  const st = store.getStandings('2026-10');
  assert.strictEqual(st.reduce((a, r) => a + r.played, 0), 16, 'cada uno de los 16 jugó una vez');
  // 4 victorias locales (3 pts) + 4 empates (1 pt cada lado) = 4·3 + 4·2 = 20 puntos.
  assert.strictEqual(st.reduce((a, r) => a + r.points, 0), 20);
  assert.strictEqual(st.reduce((a, r) => a + r.goalsFor, 0), st.reduce((a, r) => a + r.goalsAgainst, 0), 'GF == GA en total');
  store.close();
});

test('persistencia JSON de ida y vuelta preserva temporada, tabla y resultados', () => {
  const filePath = path.join(tmpDir, 'roundtrip.json');
  const store = new FootballStore(filePath);
  const league = store.generateSeason('2026-10');
  const j1 = league.calendar.jornadas[0];
  j1.matches.forEach(m => store.settleMatch(m.id, { home: 2, away: 1 }));
  const originalStandings = JSON.parse(JSON.stringify(store.getStandings('2026-10')));
  const originalSeed = league.seed;
  const originalCtx = JSON.parse(JSON.stringify(league.ctx));
  store.close();

  // Recarga desde disco con una instancia nueva.
  const reloaded = new FootballStore(filePath);
  const lg = reloaded.getLeague('2026-10');
  assert.ok(lg, 'la liga se recarga');
  assert.strictEqual(lg.seed, originalSeed, 'seed preservado');
  assert.strictEqual(lg.calendar.matches.length, 240);
  assert.strictEqual(lg.calendar.matches.filter(m => m.status === 'settled').length, 8, '8 asentados persistidos');
  assert.deepStrictEqual(lg.ctx, originalCtx, 'ctx (leagueAvg/homeAdv) preservado');
  assert.deepStrictEqual(reloaded.getStandings('2026-10'), originalStandings, 'tabla idéntica tras recarga');
  // Las jornadas rehidratan referencias a los mismos objetos de partido.
  const j1r = lg.calendar.jornadas[0];
  assert.strictEqual(j1r.matches.length, 8);
  assert.strictEqual(j1r.matches[0].status, 'settled', 'la jornada apunta a partidos asentados');
  assert.strictEqual(j1r.matches[0], lg.calendar.matches.find(m => m.id === j1r.matches[0].id), 'identidad preservada');
  reloaded.close();
});

test('closeSeason calcula el carryover y archiva la temporada', () => {
  const store = newStore('close');
  const league = store.generateSeason('2026-10');
  // Asienta toda la jornada 1 para que haya una tabla con posiciones.
  league.calendar.jornadas[0].matches.forEach(m => store.settleMatch(m.id, { home: 1, away: 0 }));
  const closed = store.closeSeason('2026-10');
  assert.strictEqual(closed.status, 'closed');
  assert.ok(closed.closedAt, 'marca closedAt');
  const carry = closed.carryover;
  const champion = closed.standings[0].teamId;
  const bottom = closed.standings[15].teamId;
  assert.strictEqual(carry[champion], 25, 'campeón +25');
  assert.strictEqual(carry[bottom], -25, 'colista -25');
  assert.ok(store.seasons.history.includes('2026-10'), 'archivada en history');
  store.close();
});

test('ensureSeason genera el mes en curso y archiva el anterior', () => {
  const store = newStore('ensure');
  store.generateSeason('2026-09');
  store.leagues.get('2026-09').status = 'active';
  const current = store.ensureSeason(new Date('2026-10-15T12:00:00Z'));
  assert.strictEqual(current.seasonMonth, monthKey(new Date('2026-10-15T12:00:00Z')), 'genera el mes en curso');
  assert.strictEqual(store.leagues.get('2026-09').status, 'closed', 'el mes anterior se cierra');
  // Llamar de nuevo no regenera.
  const again = store.ensureSeason(new Date('2026-10-20T12:00:00Z'));
  assert.strictEqual(again, current);
  store.close();
});

test('una temporada entera asentada produce un campeón y carryover coherente', () => {
  const store = newStore('full');
  const league = store.generateSeason('2026-10');
  // Resultado determinista: gana siempre el local 1-0.
  for (const m of league.calendar.matches) store.settleMatch(m.id, { home: 1, away: 0 });
  const st = store.getStandings('2026-10');
  assert.strictEqual(st[0].played, 30, 'el líder jugó las 30 jornadas');
  assert.ok(st.every(r => r.played === 30), 'todos jugaron 30');
  // Con «local siempre gana» cada club gana sus 15 de local y pierde sus 15 de visita.
  assert.ok(st.every(r => r.points === 45), '15 victorias = 45 puntos para todos');
  const carry = store.computeCarryover(league);
  assert.strictEqual(Object.keys(carry).length, 4, 'carryover para 4 posiciones (2 arriba, 2 abajo)');
  store.close();
});

test('rescheduleMatch actualiza el horario de kickoff, el día y persiste a disco', () => {
  const filePath = path.join(tmpDir, 'reschedule.json');
  const store = new FootballStore(filePath);
  const league = store.generateSeason('2026-10');
  const target = league.calendar.matches.find(m => m.status === 'scheduled');
  assert.ok(target, 'hay partidos programados');
  const oldKickoff = target.scheduledKickoffAt;
  const newKickoff = oldKickoff + 4 * 3600 * 1000; // 4 horas más tarde

  const res = store.rescheduleMatch(target.id, newKickoff, { now: oldKickoff - 3600 * 1000 });
  assert.ok(res.ok, 'reprogramación exitosa');
  assert.strictEqual(res.match.scheduledKickoffAt, newKickoff);
  assert.strictEqual(res.previousKickoffAt, oldKickoff);
  store.close();

  // Recarga desde disco y verifica persistencia
  const reloaded = new FootballStore(filePath);
  const reloadedMatch = reloaded.getMatch(target.id, '2026-10');
  assert.strictEqual(reloadedMatch.scheduledKickoffAt, newKickoff, 'kickoff persistido');
  assert.strictEqual(reloadedMatch.day, res.match.day, 'día persistido');
  reloaded.close();
});

test('rescheduleMatch rechaza horas en el pasado, formato inválido y partidos ya asentados', () => {
  const store = newStore('reschedule-invalids');
  const league = store.generateSeason('2026-10');
  const scheduled = league.calendar.matches.find(m => m.status === 'scheduled');
  const now = 1800000000000;

  // Pasado
  const pastRes = store.rescheduleMatch(scheduled.id, now - 1000, { now });
  assert.strictEqual(pastRes.ok, false);
  assert.strictEqual(pastRes.reason, 'kickoff_in_past');

  // Inválido
  const invalidRes = store.rescheduleMatch(scheduled.id, 'fecha-invalida', { now });
  assert.strictEqual(invalidRes.ok, false);
  assert.strictEqual(invalidRes.reason, 'invalid_kickoff');

  // Partido ya asentado
  store.settleMatch(scheduled.id, { home: 1, away: 0 });
  assert.strictEqual(scheduled.status, 'settled');
  const settledRes = store.rescheduleMatch(scheduled.id, now + 10000, { now });
  assert.strictEqual(settledRes.ok, false);
  assert.strictEqual(settledRes.reason, 'match_not_scheduled');

  // Partido inexistente
  const missingRes = store.rescheduleMatch('no-existe', now + 10000, { now });
  assert.strictEqual(missingRes.ok, false);
  assert.strictEqual(missingRes.reason, 'no_match');
  store.close();
});
