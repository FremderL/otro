'use strict';

// Valoración de mercado de los jugadores (conferencia de prensa del mercado).
//
// La cifra es informativa: no mueve fichas ni cuotas. Lo que se prueba aquí es
// que sea DETERMINISTA (dos consultas iguales dan el mismo precio), que dependa
// de los atributos y la posición (un delantero goleador vale más que un portero),
// que se mantenga en un rango presentable y que el mercado de traspasos la
// publique con cada acuerdo, también después de aplicarse.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { playerValue, formatPlayerValue, ratingOf } = require('../lib/football/player-value');
const { publicTransfers, planTransfers } = require('../lib/football/transfers');

function withLeague(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvalue-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason('2026-10');
  try {
    return fn({ store, league, dir });
  } finally {
    try { store.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('la valoración es determinista y no depende del club ni de la tabla', () => {
  withLeague(({ league }) => {
    const players = league.config.flatMap(club => club.squad);
    const first = players.map(p => playerValue(p));
    const again = players.map(p => playerValue(p));
    assert.deepEqual(again, first, 'el mismo jugador siempre vale lo mismo');
    // Un jugador movido de club conserva su valor: la cifra es del jugador.
    const player = players.find(p => p.pos === 'CM');
    assert.equal(playerValue({ ...player, season: undefined }), playerValue(player));
  });
});

test('la posición pesa: un delantero goleador vale más que un portero del mismo nivel', () => {
  const keeper = { pos: 'GK', attrs: { gk: 80, def: 65, pas: 60 } };
  const striker = { pos: 'ST', attrs: { sho: 80, pac: 80, pas: 66, agr: 57 } };
  assert.ok(playerValue(striker) > playerValue(keeper),
    'el gol es el bien más escaso del juego: ' + playerValue(striker) + ' vs ' + playerValue(keeper));
});

test('más atributo en lo que importa, más valor', () => {
  const base = { pos: 'ST', attrs: { sho: 60, pac: 60, pas: 60, agr: 60 } };
  const better = { pos: 'ST', attrs: { ...base.attrs, sho: 90 } };
  assert.ok(playerValue(better) > playerValue(base));
  // El rendimiento de la temporada suma, pero acotado: una racha no duplica el precio.
  const hot = { ...base, season: { goals: 40, assists: 30 } };
  assert.ok(playerValue(hot) > playerValue(base));
  assert.ok(playerValue(hot) <= playerValue(base) + 4, 'una gran temporada no reescribe el precio del jugador');
  // Sin atributos no hay precio inventado.
  assert.equal(playerValue(null), 0);
  assert.equal(playerValue({ pos: 'ST', attrs: {} }), 0);
});

test('todas las plantillas quedan en un rango presentable y legible', () => {
  withLeague(({ league }) => {
    const values = league.config.flatMap(club => club.squad).map(playerValue);
    assert.ok(values.every(v => v >= 4 && v <= 60), 'valores entre 4 y 60 millones: ' + Math.min(...values) + '–' + Math.max(...values));
    assert.equal(formatPlayerValue(17.5), '17,5 M');
    assert.equal(formatPlayerValue(16), '16,0 M');
    assert.equal(formatPlayerValue(0), '—');
    // La media ponderada existe y está en la escala de los atributos.
    assert.ok(ratingOf({ pos: 'ST', attrs: { sho: 80, pac: 80, pas: 60, agr: 60 } }) > 60);
  });
});

test('el mercado publica la valoración de cada traspaso, también tras aplicarse', () => {
  withLeague(({ store, league }) => {
    const announced = publicTransfers(league, Date.parse('2026-10-15T07:00:00Z'));
    assert.equal(announced.status, 'announced');
    assert.equal(announced.moves.length, 8);
    for (const move of announced.moves) {
      const player = league.config.find(c => c.id === move.fromId).squad.find(p => p.id === move.playerId);
      assert.equal(move.playerValue, playerValue(player), 'el precio sale de los atributos del jugador');
      assert.equal(move.position, player.pos);
      assert.equal(move.playerName, player.name);
    }
    // Al entrar en vigor la temporada siguiente el acuerdo se sigue mostrando igual
    // (el plan del ciclo es estable: se consulta sobre la liga que lo generó).
    store.generateSeason('2026-11');
    const effective = publicTransfers(league, Date.parse('2026-11-02T12:00:00Z'));
    assert.equal(effective.status, 'effective');
    assert.deepEqual(effective.moves.map(m => m.playerValue), announced.moves.map(m => m.playerValue));
  });
});

test('los candidatos del Balón de Oro se leen después de aplicar los traspasos', () => {
  withLeague(({ store, league }) => {
    const plan = planTransfers(league);
    const next = store.generateSeason('2026-11');
    for (const move of plan.moves) {
      const origin = next.config.find(c => c.id === move.fromId);
      assert.ok(!origin.squad.some(p => p.id === move.playerId), 'el traspasado ya no figura en su club de origen');
      const asCandidate = next.ballonDor.candidates.find(c => c.playerId === move.playerId);
      assert.ok(!asCandidate || asCandidate.clubId === move.toId,
        'si el traspasado es candidato del Balón de Oro, lo es de su club NUEVO');
      assert.ok(!next.ballonDor.candidates.some(c => c.playerId === move.playerId && c.clubId === move.fromId),
        'nunca aparece como candidato de su club de origen');
    }
    for (const candidate of next.ballonDor.candidates) {
      const club = next.config.find(c => c.id === candidate.clubId);
      assert.ok(club, 'el club del candidato existe en la temporada nueva');
      const player = club.squad.find(p => p.id === candidate.playerId);
      assert.ok(player && player.pos === 'ST', 'la tarjeta del candidato muestra el club donde juega de verdad');
      assert.equal(player.name, candidate.playerName);
    }
  });
});
