'use strict';

// Regresión del bug reportado en producción: una apuesta a Local se liquidó como
// ganada con 1-0 (y la tabla sumó esa victoria), pero al entrar al partido la
// ficha mostraba «0 Final 2» para el mismo partido — y lo mismo le pasó a otro
// partido del mismo horario.
//
// Causa: la línea de tiempo se regeneraba desde el seed con los ratings y el
// contexto VIGENTES, y ambos se mueven cada vez que se asienta un resultado. En
// cuanto otro proceso volvía a generar el partido (reinicio, re-derivación,
// palanca admin), el mismo seed producía OTRO marcador: la pantalla contradecía
// al resultado asentado, a la tabla y al boleto.
//
// Estos tests fijan las tres invariantes de la corrección:
//   1. Con el seed y los insumos congelados, el marcador derivado no cambia
//      aunque la liga avance (y sobrevive a un reinicio).
//   2. Un partido ya asentado nunca se reescribe: ni resultado, ni tabla, ni
//      ratings (aunque el motor marque 'finished' antes de asentar).
//   3. Lo que se paga a las apuestas es el marcador ASENTADO, no la
//      re-derivación del proceso.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { FootballEngine } = require('../lib/football/engine');

const SEASON = '2026-10';
const T0 = Date.UTC(2026, 9, 10, 18, 0, 0);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-determinism-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* mejor esfuerzo */ } });

let n = 0;
function freshStore() {
  const filePath = path.join(TMP, `store-${n++}.json`);
  const store = new FootballStore(filePath);
  store.generateSeason(SEASON);
  return { store, filePath };
}

// Deja UN partido con kickoff en T0 (día 10) y empuja el resto a un futuro lejano.
function isolate(store, index = 0) {
  const matches = store.getMatches();
  const match = matches[index];
  match.scheduledKickoffAt = T0;
  match.day = 10;
  for (const other of matches) {
    if (other === match) continue;
    other.scheduledKickoffAt = T0 + 100 * 86400000;
    other.day = 25;
  }
  return match;
}

function newEngine(store, extra = {}) {
  return new FootballEngine(store, { logEvent: () => {}, ...extra });
}

function reload({ store, filePath }) {
  store.close();
  const again = new FootballStore(filePath);
  return { store: again, filePath };
}

test('el marcador derivado es estable aunque los ratings se muevan después del kickoff', () => {
  const fixture = freshStore();
  const match = isolate(fixture.store);
  const engine = newEngine(fixture.store);

  // Primer partido del bloque: se juega completo y se asienta.
  engine.advance(match, T0 + 3 * 60 * 60 * 1000);
  assert.strictEqual(match.status, 'settled');
  const official = { home: match.result.home, away: match.result.away };

  // Esa liquidación movió ratings y contexto: el siguiente partido del mismo
  // horario NO puede cambiar de marcador por eso.
  const second = fixture.store.getMatches().find(m => m.status === 'scheduled' && m.id !== match.id);
  second.scheduledKickoffAt = T0;
  second.day = 10;
  assert.ok(engine._freezeGenerationInputs(second), 'la foto de insumos se crea antes de generar');

  const before = engine.deriveMatchState(second, T0 + 3 * 60 * 60 * 1000).state.score;

  // Ahora se asientan resultados que mueven ratings/contexto de la liga.
  for (const other of fixture.store.getMatches()) {
    if (other.id === match.id || other.id === second.id) continue;
    fixture.store.settleMatch(other.id, { home: 4, away: 0 }, { seasonMonth: SEASON });
  }

  // Reinicio: proceso nuevo, sin caché, leyendo el mismo archivo.
  const restarted = reload(fixture);
  const engine2 = newEngine(restarted.store);
  const afterRestart = engine2.deriveMatchState(restarted.store.getMatch(second.id), T0 + 3 * 60 * 60 * 1000).state.score;

  assert.deepStrictEqual(afterRestart, before, 'el mismo seed y la misma foto deben dar el mismo marcador');
  assert.deepStrictEqual({ home: official.home, away: official.away }, { home: match.result.home, away: match.result.away });
});

test('la foto de insumos se persiste con el partido y sobrevive a un reinicio', () => {
  const fixture = freshStore();
  const match = isolate(fixture.store);
  const engine = newEngine(fixture.store);
  engine._ensureTimeline(match);
  assert.ok(match.generationInputs, 'el partido guarda la foto');
  const snapshot = JSON.parse(JSON.stringify(match.generationInputs));
  assert.ok(Number.isFinite(snapshot.leagueAvg) && Number.isFinite(snapshot.home.att));

  fixture.store.saveNow();
  const restarted = reload(fixture);
  const stored = restarted.store.getMatch(match.id).generationInputs;
  assert.deepStrictEqual(stored, snapshot, 'el JSON conserva la foto tal cual');

  // Aunque la liga avance, la foto no se reescribe.
  for (const other of restarted.store.getMatches()) {
    if (other.id === match.id) continue;
    restarted.store.settleMatch(other.id, { home: 5, away: 0 }, { seasonMonth: SEASON });
  }
  assert.deepStrictEqual(restarted.store.getMatch(match.id).generationInputs, snapshot);
});

test('un bloque entero del mismo horario termina con la ficha igual al resultado asentado (caso reportado)', () => {
  const fixture = freshStore();
  const matches = fixture.store.getMatches();
  const block = matches.slice(0, 4);
  for (const match of block) { match.scheduledKickoffAt = T0; match.day = 10; }
  for (const other of matches.slice(4)) { other.scheduledKickoffAt = T0 + 100 * 86400000; other.day = 25; }

  let engine = newEngine(fixture.store);
  engine.reconcile(T0 + 1000);
  for (const match of block) engine.advance(match, T0 + 25 * 60 * 1000);
  assert.ok(block.every(match => match.status === 'settled'), 'los cuatro se liquidaron');

  // Lo que ve el jugador al entrar después (proceso nuevo, sin caché) debe ser el
  // MISMO marcador que quedó en la tabla y con el que se pagaron las apuestas.
  const restarted = reload(fixture);
  const engine2 = newEngine(restarted.store);
  for (const original of block) {
    const stored = restarted.store.getMatch(original.id);
    const derived = engine2.deriveMatchState(stored, T0 + 40 * 60 * 1000).state.score;
    assert.deepStrictEqual(derived, { home: stored.result.home, away: stored.result.away },
      `la ficha de ${original.id} contradice su resultado asentado`);
  }
});

test('un partido ya asentado se deriva con su marcador oficial aunque el seed diga otra cosa', () => {
  const fixture = freshStore();
  const match = fixture.store.getMatches()[0];
  // Datos «viejos»: asentado sin foto de insumos y con un marcador elegido a mano.
  fixture.store.settleMatch(match.id, { home: 0, away: 2 }, { seasonMonth: SEASON });
  const restarted = reload(fixture);
  const stored = restarted.store.getMatch(match.id);
  assert.strictEqual(stored.generationInputs, null, 'sin foto previa');

  const engine = newEngine(restarted.store);
  const derived = engine.deriveMatchState(stored, T0 + 5 * 24 * 60 * 60 * 1000);
  assert.deepStrictEqual(derived.state.score, { home: 0, away: 2 }, 'la ficha nunca contradice al resultado asentado');
});

test('asentar dos veces no reescribe resultado, tabla ni ratings (guarda por resultado, no por status)', () => {
  const { store } = freshStore();
  store.generateSeason(SEASON);
  const match = store.getMatches()[0];
  const first = store.settleMatch(match.id, { home: 1, away: 0 }, { seasonMonth: SEASON });
  assert.ok(first.ok && !first.alreadySettled);

  const league = store.getLeague(SEASON);
  const standingsBefore = JSON.stringify(store.getStandings(SEASON));
  const ratingsBefore = JSON.stringify(league.config.map(c => c.ratings));
  const ballonDorBefore = JSON.stringify(league.ballonDor);

  // El motor marcaba 'finished' en el objeto compartido antes de asentar: eso
  // desactivaba la guarda vieja (`status === 'settled'`) y permitía sobrescribir.
  match.status = 'finished';
  const again = store.settleMatch(match.id, { home: 0, away: 2 }, { seasonMonth: SEASON });

  assert.ok(again.ok && again.alreadySettled, 'la segunda llamada se reconoce como repetida');
  assert.deepStrictEqual(match.result, { home: 1, away: 0, winner: 'home' }, 'el resultado oficial no cambia');
  assert.strictEqual(JSON.stringify(store.getStandings(SEASON)), standingsBefore, 'la tabla no se mueve');
  assert.strictEqual(JSON.stringify(league.config.map(c => c.ratings)), ratingsBefore, 'los ratings no se aplican dos veces');
  assert.strictEqual(JSON.stringify(league.ballonDor), ballonDorBefore, 'el Balón de Oro no duplica estadísticas');
  store.close();
});

test('forzar el final de un partido ya asentado no lo vuelve a liquidar', () => {
  const fixture = freshStore();
  const match = isolate(fixture.store);
  const engine = newEngine(fixture.store);
  engine.advance(match, T0 + 3 * 60 * 60 * 1000);
  const official = JSON.stringify(match.result);
  const standingsBefore = JSON.stringify(fixture.store.getStandings(SEASON));

  const forced = engine.forceFinish(match, T0 + 4 * 60 * 60 * 1000);
  assert.ok(forced.ok && forced.alreadySettled);
  assert.strictEqual(JSON.stringify(match.result), official);
  assert.strictEqual(JSON.stringify(fixture.store.getStandings(SEASON)), standingsBefore);
  assert.strictEqual(match.status, 'settled');
});

test('las apuestas se pagan con el marcador asentado, no con una re-derivación', () => {
  const { store } = freshStore();
  const match = store.getMatches()[0];
  let settledWith = null;
  const engine = newEngine(store, { settleBets: (_match, score) => { settledWith = score; } });

  // El store ya tiene un resultado oficial (0-2) que la re-derivación de este
  // proceso no reproduce: lo que se paga debe ser el oficial.
  store.settleMatch(match.id, { home: 0, away: 2 }, { seasonMonth: SEASON });
  const realSettle = store.settleMatch.bind(store);
  store.settleMatch = () => ({ ok: true, alreadySettled: true, match });

  engine._settleResult(match, { score: { home: 1, away: 0 }, timeline: [], lineups: null }, T0);

  assert.deepStrictEqual(settledWith, { home: 0, away: 2 }, 'se paga el marcador asentado');
  assert.strictEqual(match.status, 'settled');
  store.settleMatch = realSettle;
  store.close();
});
