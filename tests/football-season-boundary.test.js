'use strict';

// Fronteras y reconstrucciones del Estadio: los tres agujeros de la misma familia
// que el incidente del marcador y del resumen — un hecho de los que mueven fichas
// o estadísticas resuelto con dos fuentes distintas.
//
//   1. Un partido que quedó en vuelo cuando cambió el mes: la temporada anterior
//      se cerraba con partidos sin asentar (tabla incompleta, premio sin cerrar)
//      y sus apuestas se anulaban buscando el partido en la temporada nueva.
//   2. Un asentado sin línea de tiempo (palanca admin, reproceso): el Balón de
//      Oro sumaba una regeneración mientras el archivo de Mi Once y los
//      destacados quedaban vacíos, así que el premio contaba goles que el resumen
//      del partido no mostraba.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { FootballEngine } = require('../lib/football/engine');
const { createBettingService } = require('../lib/football/betting');
const { cleanGenerationInputs } = require('../lib/football-store-shared');

const PAST = '2026-09';
const NEXT = '2026-10';
const OCT_FIRST = Date.parse('2026-10-01T18:00:00Z');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'season-boundary-'));
}

test('un partido en vuelo de la temporada anterior se asienta antes de rotar', t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FootballStore(path.join(dir, 'football.json'));
  store.saveNow = () => undefined; // la unidad bajo prueba no es la E/S repetida
  const league = store.generateSeason(PAST);
  const target = league.calendar.matches.find(match => match.jornada === 30 && match.status === 'scheduled');
  assert.ok(target, 'el partido de la última jornada existe');
  // Todos los demás partidos del mes ya se jugaron; este quedó colgado al filo.
  for (const match of league.calendar.matches) {
    if (match.id === target.id) continue;
    store.settleMatch(match.id, { home: 1, away: 0 }, { seasonMonth: PAST, now: OCT_FIRST - 86400000 });
  }
  const engine = new FootballEngine(store, { logEvent: () => {} });

  const summary = engine.reconcile(OCT_FIRST);

  assert.equal(target.status, 'settled', 'el partido colgado se asienta con su seed');
  assert.ok(Number.isInteger(target.result.home) && Number.isInteger(target.result.away));
  assert.equal(store.getSeasonMonths().includes(NEXT), true, 'la temporada nueva se creó');
  const standings = store.getStandings(PAST);
  // 240 partidos × 2 clubes: la tabla del mes cerrado no deja ninguno fuera.
  assert.equal(standings.reduce((acc, row) => acc + row.played, 0), 480,
    'la tabla del mes cerrado cuenta los 240 partidos, no 239');
  assert.ok(summary.partidos >= 0);
  store.close();
});

test('sus apuestas se liquidan, no se anulan por «partido inexistente»', t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FootballStore(path.join(dir, 'football.json'));
  store.saveNow = () => undefined;
  const league = store.generateSeason(PAST);
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const profile = profiles.getOrCreate('p1', 'Jugador', null);
  profile.chips = 1_000_000;
  profiles.saveNow();
  const betting = createBettingService({ store, profiles, log: () => {} });
  const match = league.calendar.matches.find(item => item.jornada === 30);

  return betting.placeBet({
    profile, matchId: match.id, market: '1x2', selection: 'home', stake: 25000
  }).then(placed => {
    assert.equal(placed.ok, true);
    // El mes cambia y el partido se asienta fuera de la temporada vigente.
    store.ensureSeason(new Date(OCT_FIRST));
    assert.equal(store.getCurrentSeasonMonth(), NEXT);
    store.settleMatch(match.id, { home: 2, away: 0 }, { seasonMonth: PAST, now: OCT_FIRST });
    // El partido se busca en todas las temporadas: la apuesta gana y se paga.
    assert.equal(store.getMatchAnywhere(match.id)?.id, match.id);
    betting.reconcileEscrow();
    const after = store.getBet(placed.bet.id);
    assert.equal(after.status, 'won', 'no se anula un boleto ganador');
    assert.equal(after.payout, Math.floor(25000 * placed.bet.oddsAtPlacement));
    // Los logros/reto del perfil pueden sumar aparte: se comprueba el neto de la apuesta.
    assert.ok(profile.chips >= 1_000_000 - 25000 + after.payout);
    store.close();
    profiles.saveNow();
  });
});

test('un asentado sin línea de tiempo archiva lo mismo que premio y destacados', t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FootballStore(path.join(dir, 'football.json'));
  store.saveNow = () => undefined;
  const league = store.generateSeason(PAST);
  const engine = new FootballEngine(store, { logEvent: () => {} });
  const match = league.calendar.matches.find(item => item.jornada === 1);
  // La foto de insumos la deja el motor en la primera generación (§3.2).
  const frozen = engine._freezeGenerationInputs(match);
  assert.ok(cleanGenerationInputs(frozen), 'el partido tiene insumos congelados');
  const timeline = engine._ensureTimeline(match);
  const score = { home: timeline.score.home, away: timeline.score.away };

  // Asentado directo en el store, SIN pasar la timeline (palanca admin/reproceso).
  const settled = store.settleMatch(match.id, score, { seasonMonth: PAST, now: OCT_FIRST });
  assert.equal(settled.ok, true);

  assert.ok(Array.isArray(match.fantasyStats) && match.fantasyStats.length > 0,
    'el archivo de Mi Once ya no queda vacío');
  assert.ok(match.highlights && Array.isArray(match.highlights.goals), 'los destacados se archivan');

  // Premio, archivo y destacados salen de la misma línea de tiempo.
  const candidate = league.ballonDor.candidates.find(item => item.clubId === match.homeId)
    || league.ballonDor.candidates.find(item => item.clubId === match.awayId);
  const archived = match.fantasyStats.find(row => row.id === candidate.playerId);
  assert.equal(candidate.stats.goals, archived.goals, 'los goles del premio son los del archivo');
  assert.equal(candidate.stats.assists, archived.assists, 'las asistencias del premio son las del archivo');
  const archivedGoals = match.fantasyStats.reduce((acc, row) => acc + row.goals, 0);
  assert.equal(archivedGoals, score.home + score.away, 'el archivo cuenta todos los goles del marcador');
  const listedGoals = match.highlights.goals.length;
  assert.equal(listedGoals, score.home + score.away, 'la lista de goles del resumen también');
  store.close();
});
