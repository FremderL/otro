'use strict';

// Fase A — Pruebas de ratings (§10.1).
// La coherencia entre expectedGoals() y updateAfterMatch() es lo que hace que el
// modelo que genera el partido y el que fija el precio no diverjan (R3/§3.3).

const test = require('node:test');
const assert = require('node:assert');
const {
  outcome, eloExpected, expectedGoals, updateAfterMatch, recomputeLeagueStats,
  INITIAL_LEAGUE_AVG, INITIAL_HOME_ADV, ATT_DEF_MIN, ATT_DEF_MAX, K, MIN_SAMPLE
} = require('../lib/football/ratings');

const ratings = (elo, att, def, gk = 1) => ({ elo, att, def, gk });

test('outcome clasifica el marcador', () => {
  assert.strictEqual(outcome(2, 1), 'home');
  assert.strictEqual(outcome(0, 3), 'away');
  assert.strictEqual(outcome(1, 1), 'draw');
});

test('eloExpected da más de 0.5 al favorito y es complementaria', () => {
  const e = eloExpected(1600, 1400);
  assert.ok(e > 0.5, 'el favorito local espera ganar');
  assert.ok(e <= 1);
  // Con HFA, el local siempre tiene algo de ventaja incluso con igual elo.
  assert.ok(eloExpected(1500, 1500) > 0.5, 'la ventaja de local inclina el empate de elo');
});

test('expectedGoals aplica homeAdv y los ratings de ataque/defensa', () => {
  const home = ratings(1500, 1.2, 0.9);
  const away = ratings(1500, 0.9, 1.2);
  const { lambdaHome, lambdaAway } = expectedGoals(home, away, { leagueAvg: 1.35, homeAdv: 1.12 });
  // λ_home = 1.35 · 1.2 · 1.2 · 1.12 ; λ_away = 1.35 · 0.9 · 0.9
  assert.ok(lambdaHome > lambdaAway, 'el local con mejor ataque y peor defensa rival espera más goles');
  assert.ok(Math.abs(lambdaHome - 1.35 * 1.2 * 1.2 * 1.12) < 1e-9);
  assert.ok(Math.abs(lambdaAway - 1.35 * 0.9 * 0.9) < 1e-9);
  // Sin contexto usa las constantes iniciales.
  const def = expectedGoals(ratings(1500, 1, 1), ratings(1500, 1, 1));
  assert.ok(Math.abs(def.lambdaHome - INITIAL_LEAGUE_AVG * INITIAL_HOME_ADV) < 1e-9);
  assert.ok(Math.abs(def.lambdaAway - INITIAL_LEAGUE_AVG) < 1e-9);
});

test('updateAfterMatch: el ganador sube elo, el perdedor baja, y es suma cero', () => {
  const home = ratings(1500, 1.0, 1.0, 1.0);
  const away = ratings(1500, 1.0, 1.0, 1.0);
  const ctx = { leagueAvg: INITIAL_LEAGUE_AVG, homeAdv: INITIAL_HOME_ADV };
  const { home: h2, away: a2 } = updateAfterMatch(home, away, 2, 0, ctx);
  assert.ok(h2.elo > 1500, 'local ganador sube');
  assert.ok(a2.elo < 1500, 'visitante perdedor baja');
  assert.strictEqual((h2.elo - home.elo) + (a2.elo - away.elo), 0, 'el ajuste Elo es suma cero');
  assert.ok(Math.abs(h2.elo - home.elo) <= K, 'el salto no excede K');
});

test('updateAfterMatch mueve att/def en la dirección correcta y acota', () => {
  const home = ratings(1500, 1.0, 1.0, 1.0);
  const away = ratings(1500, 1.0, 1.0, 1.0);
  const ctx = { leagueAvg: INITIAL_LEAGUE_AVG, homeAdv: INITIAL_HOME_ADV };
  // Local golea 4-0: su att sube (marcó más de lo esperado), su def baja (concedió menos).
  const { home: h2 } = updateAfterMatch(home, away, 4, 0, ctx);
  assert.ok(h2.att > 1.0, 'att sube al marcar de más');
  assert.ok(h2.def < 1.0, 'def baja al conceder de menos');
  assert.ok(h2.att <= ATT_DEF_MAX && h2.def >= ATT_DEF_MIN, 'dentro de cotas');
  // Goleada absurda repetida no rompe las cotas.
  let r = ratings(1500, 1.0, 1.0, 1.0);
  let opp = ratings(1500, 1.0, 1.0, 1.0);
  for (let i = 0; i < 50; i++) {
    const u = updateAfterMatch(r, opp, 9, 0, ctx);
    r = u.home; opp = u.away;
  }
  assert.ok(r.att <= ATT_DEF_MAX && r.att >= ATT_DEF_MIN, 'att acotado tras 50 goleadas');
  assert.ok(r.def <= ATT_DEF_MAX && r.def >= ATT_DEF_MIN, 'def acotado');
});

test('updateAfterMatch no muta los ratings entrantes', () => {
  const home = ratings(1500, 1.0, 1.0, 1.0);
  const away = ratings(1500, 1.0, 1.0, 1.0);
  const snapshotHome = { ...home };
  updateAfterMatch(home, away, 2, 1, { leagueAvg: 1.35, homeAdv: 1.12 });
  assert.deepStrictEqual(home, snapshotHome, 'el objeto de entrada queda intacto');
});

test('recomputeLeagueStats devuelve las constantes con pocos datos y observa con muchos', () => {
  // Menos de MIN_SAMPLE → constantes iniciales (arranque de temporada).
  const few = Array.from({ length: MIN_SAMPLE - 1 }, () => ({ result: { home: 2, away: 0 } }));
  const early = recomputeLeagueStats(few);
  assert.strictEqual(early.leagueAvg, INITIAL_LEAGUE_AVG);
  assert.strictEqual(early.homeAdv, INITIAL_HOME_ADV);

  // Muestra suficiente → observado, acotado.
  const many = Array.from({ length: 60 }, () => ({ result: { home: 2, away: 1 } }));
  const obs = recomputeLeagueStats(many);
  assert.strictEqual(obs.sample, 60);
  assert.ok(Math.abs(obs.leagueAvg - 1.5) < 1e-9, '3 goles/2 equipos = 1.5 por equipo');
  assert.ok(obs.homeAdv > 1 && obs.homeAdv <= 1.35, 'homeAdv observado acotado (2/1)');
});

test('recomputeLeagueStats ignora partidos sin resultado y usa la última ventana', () => {
  const mixed = [
    { result: null },
    { status: 'scheduled' },
    ...Array.from({ length: 20 }, () => ({ result: { home: 1, away: 1 } }))
  ];
  const stats = recomputeLeagueStats(mixed);
  assert.strictEqual(stats.sample, 20, 'solo cuenta los asentados');
});
