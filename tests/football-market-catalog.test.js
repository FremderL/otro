'use strict';

// Catálogo ampliado del Estadio (palanca C): hándicap asiático de dos vías con
// líneas de cuarto y empuje, descanso/final y primer goleador. Lo que se prueba
// aquí es que se PUBLICAN con un libro sano y que se LIQUIDAN con el resultado
// asentado, incluidos los desenlaces parciales (media victoria / media derrota)
// y las selecciones que dependen de un hecho del partido ('sin goles', 'otro').

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService, resolveSelection, parseMarket } = require('../lib/football/betting');
const { createLineups } = require('../lib/football/match-state');
const { matchContextFor } = require('../lib/football/match-context');
const { monthKey, cleanMatch } = require('../lib/football-store-shared');
const O = require('../lib/football/odds');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcatalog-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const month = monthKey();
  store.generateSeason(month);
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const profile = profiles.getOrCreate('p1', 'Jugador', null);
  profile.chips = 1000;
  profiles.saveNow();
  const betting = createBettingService({ store, profiles, log: () => {} });
  const match = store.getMatches(month).find(m => m.status === 'scheduled');
  const cleanup = () => {
    try { store.close(); } catch (_) {}
    try { profiles.saveNow(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, profiles, profile, betting, match, month, cleanup };
}

// --- Análisis de la clave del mercado ---

test('parseMarket reconoce hándicap asiático, descanso/final y primer goleador', () => {
  assert.deepStrictEqual(parseMarket('asian_handicap_home_minus0.75'), { type: 'asian_handicap', line: -0.75 });
  assert.deepStrictEqual(parseMarket('asian_handicap_home_plus0'), { type: 'asian_handicap', line: 0 });
  assert.deepStrictEqual(parseMarket('asian_handicap_home_plus1.5'), { type: 'asian_handicap', line: 1.5 });
  assert.deepStrictEqual(parseMarket('ht_ft'), { type: 'ht_ft' });
  assert.deepStrictEqual(parseMarket('first_scorer'), { type: 'first_scorer' });
  assert.deepStrictEqual(parseMarket('yellow_cards_over_under_3.5'), { type: 'yellow_cards', line: 3.5 });
  assert.deepStrictEqual(parseMarket('yellow_cards_over_under_4.5'), { type: 'yellow_cards', line: 4.5 });
  assert.deepStrictEqual(parseMarket('both_teams_booked'), { type: 'both_teams_booked' });
  assert.deepStrictEqual(parseMarket('red_card'), { type: 'red_card' });
});

// --- Liquidación del hándicap asiático ---

test('hándicap asiático: empuje, media victoria y media derrota', () => {
  const s = (h, a) => ({ home: h, away: a });
  // Línea entera: 2-0 con local −2 devuelve el boleto.
  assert.strictEqual(resolveSelection('asian_handicap_home_minus2', 'home', s(2, 0)), 'void');
  // Media línea: 2-0 con local −0.5 gana entero.
  assert.strictEqual(resolveSelection('asian_handicap_home_minus0.5', 'home', s(2, 0)), 'won');
  assert.strictEqual(resolveSelection('asian_handicap_home_minus0.5', 'away', s(2, 0)), 'lost');
  // Cuarto de línea: 2-0 con local −0.25 gana las dos mitades (a −0.5 y a 0).
  assert.strictEqual(resolveSelection('asian_handicap_home_minus0.25', 'home', s(2, 0)), 'won');
  // Cuarto de línea: 1-1 con local −0.25 es media derrota (una mitad empuja).
  assert.strictEqual(resolveSelection('asian_handicap_home_minus0.25', 'home', s(1, 1)), 'half_lost');
  assert.strictEqual(resolveSelection('asian_handicap_home_minus0.25', 'away', s(1, 1)), 'half_won');
  // 1-1 con local +0.25 es media victoria para el local.
  assert.strictEqual(resolveSelection('asian_handicap_home_plus0.25', 'home', s(1, 1)), 'half_won');
  // Línea de nivel: el empate devuelve el boleto.
  assert.strictEqual(resolveSelection('asian_handicap_home_plus0', 'home', s(1, 1)), 'void');
  assert.strictEqual(resolveSelection('asian_handicap_home_plus0', 'away', s(0, 2)), 'won');
  // Un cuarto que gana las dos mitades cobra entero.
  assert.strictEqual(resolveSelection('asian_handicap_home_minus0.75', 'home', s(3, 1)), 'won');
  // Un cuarto que pierde las dos pierde entero.
  assert.strictEqual(resolveSelection('asian_handicap_home_minus0.75', 'home', s(0, 1)), 'lost');
});

test('descanso/final se resuelve con el marcador del descanso archivado', () => {
  const score = { home: 1, away: 1 };
  const halftime = { home: 1, away: 0 };
  assert.strictEqual(resolveSelection('ht_ft', 'home_draw', score, { halftime }), 'won');
  assert.strictEqual(resolveSelection('ht_ft', 'home_home', score, { halftime }), 'lost');
  assert.strictEqual(resolveSelection('ht_ft', 'draw_draw', score, { halftime }), 'lost');
  // Sin marcador del descanso no se adivina: se anula.
  assert.strictEqual(resolveSelection('ht_ft', 'home_draw', score, {}), 'void');
});

test('primer goleador: jugador, otro, sin goles y gol en propia puerta', () => {
  const score = { home: 2, away: 1 };
  const ctx = { firstScorer: { id: 'p10', name: 'Nueve', team: 'home', minute: 12 }, firstScorerIds: ['p10', 'p20'] };
  assert.strictEqual(resolveSelection('first_scorer', 'p10', score, ctx), 'won');
  assert.strictEqual(resolveSelection('first_scorer', 'p20', score, ctx), 'lost');
  assert.strictEqual(resolveSelection('first_scorer', 'other', score, ctx), 'lost');
  assert.strictEqual(resolveSelection('first_scorer', 'none', score, ctx), 'lost');
  // Goleador fuera de la lista ofrecida: cobra «otro jugador».
  assert.strictEqual(resolveSelection('first_scorer', 'other', score,
    { firstScorer: { id: 'p99' }, firstScorerIds: ['p10', 'p20'] }), 'won');
  // 0-0: solo cobra «sin goles».
  assert.strictEqual(resolveSelection('first_scorer', 'none', { home: 0, away: 0 }, { firstScorer: null }), 'won');
  assert.strictEqual(resolveSelection('first_scorer', 'p10', { home: 0, away: 0 }, { firstScorer: null }), 'lost');
  // Propia puerta: ningún goleador posible, se anula.
  assert.strictEqual(resolveSelection('first_scorer', 'p10', score,
    { firstScorer: { id: null, ownGoal: true }, firstScorerIds: ['p10'] }), 'void');
  // Sin fuente (partido asentado antes de existir el mercado): se anula.
  assert.strictEqual(resolveSelection('first_scorer', 'p10', score, {}), 'void');
  // «Otro» sin la lista archivada tampoco se inventa.
  assert.strictEqual(resolveSelection('first_scorer', 'other', score, { firstScorer: { id: 'p99' } }), 'void');
});

// --- Publicación del catálogo ---

test('el catálogo publica la escalera asiática, descanso/final y primer goleador', () => {
  const h = setup();
  try {
    const league = h.store.getLeague(h.month);
    const home = league.config.find(c => c.id === h.match.homeId);
    const away = league.config.find(c => c.id === h.match.awayId);
    const mc = matchContextFor(h.store, h.match);
    const lineups = createLineups(home, away);
    const markets = O.buildPreMatchMarkets(mc.matrix, { lambdas: mc.lambdas, lineups });

    const asianKeys = Object.keys(markets).filter(k => k.startsWith('asian_handicap_home_'));
    assert.strictEqual(asianKeys.length, 5, 'cinco líneas en la escalera');
    for (const key of asianKeys) {
      const market = markets[key];
      assert.deepStrictEqual(market.selections.map(s => s.key), ['home', 'away'], `${key} es de dos vías`);
      assert.strictEqual(parseMarket(key).type, 'asian_handicap', `${key} se puede liquidar`);
      assert.ok(market.overround >= 1 + O.ASIAN_MIN_MARGIN - 0.01, `${key} con margen positivo`);
    }

    const htft = markets.ht_ft;
    assert.strictEqual(htft.selections.length, 9);
    const htftSum = htft.selections.reduce((a, s) => a + s.prob, 0);
    assert.ok(Math.abs(htftSum - 1) < 1e-6, 'las nueve combinaciones cubren el partido');

    const scorer = markets.first_scorer;
    assert.ok(scorer, 'el primer goleador se publica con alineaciones');
    assert.strictEqual(scorer.selections.length, 14, 'doce nombres + otro + sin goles');
    const scorerSum = scorer.selections.reduce((a, s) => a + s.prob, 0);
    assert.ok(Math.abs(scorerSum - 1) < 1e-6, 'el mercado cubre todos los goles posibles');
    assert.ok(scorer.selections.some(s => s.key === 'none' && s.prob > 0));
    assert.strictEqual(scorer.labels.none, 'Sin goles');
    assert.strictEqual(scorer.labels.other, 'Otro jugador');
    for (const s of scorer.selections) {
      if (s.key === 'other' || s.key === 'none') continue;
      assert.ok(scorer.labels[s.key], 'cada nombre ofrecido tiene etiqueta legible');
    }

    // Sin alineaciones no se inventa el mercado.
    assert.strictEqual(O.buildPreMatchMarkets(mc.matrix).first_scorer, undefined);
  } finally {
    h.cleanup();
  }
});

// --- Pago parcial (media victoria / media derrota) ---

test('media victoria cobra media cuota y devuelve la otra mitad; media derrota devuelve media', () => {
  const h = setup();
  try {
    const base = {
      profileId: h.profile.id, matchId: h.match.id, market: 'asian_handicap_home_minus0.25',
      selection: 'home', stake: 100, oddsAtPlacement: 2.0, status: 'open', debited: true
    };
    h.store.insertBet({ ...base, id: 'b_half_won', idempotencyKey: 'k1' });
    const won = h.betting._payoutBet(h.store.getBet('b_half_won'), 'half_won');
    assert.strictEqual(won.ok, true);
    // 50 fichas a cuota 2.0 = 100 + 50 devueltas = 150.
    assert.strictEqual(won.payout, 150);
    assert.strictEqual(h.store.getBet('b_half_won').status, 'won');

    h.store.insertBet({ ...base, id: 'b_half_lost', idempotencyKey: 'k2' });
    const lost = h.betting._payoutBet(h.store.getBet('b_half_lost'), 'half_lost');
    assert.strictEqual(lost.payout, 50, 'la mitad empujada vuelve');
    assert.strictEqual(h.store.getBet('b_half_lost').status, 'lost');
    // El saldo lo escriben también los logros de progression.js: aquí se comprueba
    // el pago, que es lo que define el mercado.
  } finally {
    h.cleanup();
  }
});

// --- Resultado asentado: descanso y primer goleador viajan con el marcador ---

test('el asentado archiva descanso y primer goleador y los mercados se liquidan con ellos', () => {
  const h = setup();
  try {
    // Cronología REAL del partido (mismo generador que usa el motor): así el
    // asentado archiva hechos verificables y no una línea de tiempo de juguete.
    const league = h.store.getLeague(h.month);
    const home = league.config.find(c => c.id === h.match.homeId);
    const away = league.config.find(c => c.id === h.match.awayId);
    const { generateTimeline } = require('../lib/football/match-engine');
    const { mulberry32 } = require('../lib/football/prng');
    const gen = generateTimeline(home, away, {
      leagueAvg: league.ctx.leagueAvg, homeAdv: league.ctx.homeAdv,
      ...(league.ctx.rho != null ? { rho: league.ctx.rho } : {})
    }, mulberry32(20261030));

    const halftime = O.halfTimeScoreFromTimeline(gen.timeline);
    const firstScorer = O.firstScorerFromTimeline(gen.timeline);
    const ftHome = gen.score.home, ftAway = gen.score.away;
    const side = (a, b) => (a > b ? 'home' : a === b ? 'draw' : 'away');

    const bets = [
      { id: 'b_htft', market: 'ht_ft', selection: `${side(halftime.home, halftime.away)}_${side(ftHome, ftAway)}`, oddsAtPlacement: 4.0 },
      { id: 'b_scorer', market: 'first_scorer', selection: firstScorer ? firstScorer.id : 'none', oddsAtPlacement: 6.0 },
      { id: 'b_other', market: 'first_scorer', selection: 'other', oddsAtPlacement: 8.0 }
    ];
    for (const bet of bets) {
      h.store.insertBet({
        ...bet, idempotencyKey: `k_${bet.id}`, profileId: h.profile.id, matchId: h.match.id,
        stake: 10, status: 'open', debited: true,
        // La lista archivada es la que se ofreció al vender: el goleador real no
        // estaba en ella, así que «otro jugador» también tiene que cobrar.
        ...(firstScorer ? { firstScorerIds: ['jugador_que_no_marco'] } : {})
      });
    }

    const settled = h.store.settleMatch(h.match.id, { home: ftHome, away: ftAway },
      { timeline: gen.timeline, lineups: gen.lineups, now: Date.now() });
    assert.strictEqual(settled.ok, true, settled.reason);
    const stored = h.store.getMatch(h.match.id);
    assert.deepStrictEqual(stored.result.halftime, halftime, 'el descanso queda asentado');
    if (firstScorer && firstScorer.id) {
      assert.strictEqual(stored.result.firstScorer.id, firstScorer.id, 'el primer goleador queda asentado');
    } else {
      assert.strictEqual(stored.result.firstScorer, null, 'un 0-0 se asienta como null, no se omite');
    }

    h.betting.settleMatchBets(stored, { home: ftHome, away: ftAway });
    assert.strictEqual(h.store.getBet('b_htft').status, 'won', 'descanso/final cobra con el marcador real');
    assert.strictEqual(h.store.getBet('b_scorer').status, 'won', 'el primer goleador cobra');
    assert.strictEqual(h.store.getBet('b_other').status, 'won', 'un goleador fuera de la lista cobra en «otro»');
  } finally {
    h.cleanup();
  }
});

test('cleanMatch conserva descanso y primer goleador del resultado asentado', () => {
  const raw = {
    id: 'm1', seasonMonth: '2026-11', jornada: 1, status: 'settled', settledAt: 1,
    result: {
      home: 1, away: 1, winner: 'draw',
      halftime: { home: 1, away: 0 },
      firstScorer: { id: 'p9', name: 'Nueve', team: 'home', minute: 12 }
    }
  };
  const clean = cleanMatch(raw);
  assert.deepStrictEqual(clean.result.halftime, { home: 1, away: 0 });
  assert.strictEqual(clean.result.firstScorer.id, 'p9');
  // 0-0 se conserva como null explícito (no como «sin fuente»).
  const zero = cleanMatch({ ...raw, result: { home: 0, away: 0, winner: 'draw', halftime: { home: 0, away: 0 }, firstScorer: null } });
  assert.strictEqual(zero.result.firstScorer, null);
});

// --- Tarjetas: amarillas y rojas (tasas Poisson del motor, foto asentada) ---

test('tarjetas: el catálogo publica amarillas over/under, ambos amonestados y roja con libro sano', () => {
  const h = setup();
  try {
    const mc = matchContextFor(h.store, h.match);
    const markets = O.buildPreMatchMarkets(mc.matrix, { lambdas: mc.lambdas });
    for (const key of ['yellow_cards_over_under_3.5', 'yellow_cards_over_under_4.5', 'both_teams_booked', 'red_card']) {
      const market = markets[key];
      assert.ok(market && !market.degenerate, `falta o degenerado: ${key}`);
      assert.ok(market.overround >= 1 + O.MIN_MARGIN - 1e-9, `${key} arbitrable: ${market.overround}`);
      const sum = market.selections.reduce((a, s) => a + s.prob, 0);
      assert.ok(Math.abs(sum - 1) < 1e-6, `${key} debe cubrir todo el mercado`);
      assert.ok(parseMarket(key).type !== 'unknown', `${key} se puede liquidar`);
    }
    assert.deepStrictEqual(markets['yellow_cards_over_under_3.5'].selections.map(s => s.key), ['over', 'under']);
    assert.deepStrictEqual(markets.red_card.selections.map(s => s.key), ['yes', 'no']);
    // La línea 3.5 está cerca de la media (4.1): over no debe ser un favorito aplastante.
    const over35 = markets['yellow_cards_over_under_3.5'].selections.find(s => s.key === 'over');
    assert.ok(over35.prob > 0.45 && over35.prob < 0.75, `P(over 3.5) = ${over35.prob}`);
  } finally {
    h.cleanup();
  }
});

test('tarjetas: se liquidan con el conteo archivado y sin él se anulan (nunca a ojo)', () => {
  const s = { home: 2, away: 1 };
  const cards = { yellow: 5, red: 1, homeYellow: 3, awayYellow: 2, homeRed: 1, awayRed: 0 };
  // Amarillas 3.5: 5 amarillas ⇒ over gana, under pierde.
  assert.strictEqual(resolveSelection('yellow_cards_over_under_3.5', 'over', s, { cards }), 'won');
  assert.strictEqual(resolveSelection('yellow_cards_over_under_3.5', 'under', s, { cards }), 'lost');
  // Amarillas 4.5: 5 ⇒ over gana; con 4 amarillas perdería.
  assert.strictEqual(resolveSelection('yellow_cards_over_under_4.5', 'over', s, { cards }), 'won');
  assert.strictEqual(resolveSelection('yellow_cards_over_under_4.5', 'over', s, { cards: { ...cards, yellow: 4 } }), 'lost');
  // Ambos amonestados: 3 y 2 ⇒ sí gana; si un equipo no tiene, pierde.
  assert.strictEqual(resolveSelection('both_teams_booked', 'yes', s, { cards }), 'won');
  assert.strictEqual(resolveSelection('both_teams_booked', 'no', s, { cards }), 'lost');
  assert.strictEqual(resolveSelection('both_teams_booked', 'yes', s, { cards: { ...cards, awayYellow: 0 } }), 'lost');
  // Roja: con 1 roja (directa o segunda amarilla) el «sí» cobra.
  assert.strictEqual(resolveSelection('red_card', 'yes', s, { cards }), 'won');
  assert.strictEqual(resolveSelection('red_card', 'no', s, { cards }), 'lost');
  assert.strictEqual(resolveSelection('red_card', 'no', s, { cards: { ...cards, red: 0 } }), 'won');
  // Partido asentado antes de existir estos mercados (sin conteo): se anula.
  assert.strictEqual(resolveSelection('yellow_cards_over_under_3.5', 'over', s, {}), 'void');
  assert.strictEqual(resolveSelection('both_teams_booked', 'yes', s, {}), 'void');
  assert.strictEqual(resolveSelection('red_card', 'yes', s, {}), 'void');
  assert.strictEqual(resolveSelection('red_card', 'yes', s, { cards: null }), 'void');
});

test('el asentado archiva las tarjetas y los mercados se liquidan con ese conteo', () => {
  const h = setup();
  try {
    const league = h.store.getLeague(h.month);
    const home = league.config.find(c => c.id === h.match.homeId);
    const away = league.config.find(c => c.id === h.match.awayId);
    const { generateTimeline } = require('../lib/football/match-engine');
    const { mulberry32 } = require('../lib/football/prng');
    const gen = generateTimeline(home, away, {
      leagueAvg: league.ctx.leagueAvg, homeAdv: league.ctx.homeAdv,
      ...(league.ctx.rho != null ? { rho: league.ctx.rho } : {})
    }, mulberry32(20261103));

    const cards = O.cardsFromTimeline(gen.timeline);
    const total = cards.yellow;
    const over35 = total > 3.5 ? 'over' : 'under';
    const over45 = total > 4.5 ? 'over' : 'under';
    const booked = cards.homeYellow >= 1 && cards.awayYellow >= 1 ? 'yes' : 'no';
    const redSel = cards.red >= 1 ? 'yes' : 'no';

    h.store.insertBet({ id: 'b_y35', idempotencyKey: 'ky35', profileId: h.profile.id, matchId: h.match.id, market: 'yellow_cards_over_under_3.5', selection: over35, stake: 10, oddsAtPlacement: 1.6, status: 'open', debited: true });
    h.store.insertBet({ id: 'b_y45', idempotencyKey: 'ky45', profileId: h.profile.id, matchId: h.match.id, market: 'yellow_cards_over_under_4.5', selection: over45 === 'over' ? 'under' : 'over', stake: 10, oddsAtPlacement: 2.3, status: 'open', debited: true });
    h.store.insertBet({ id: 'b_booked', idempotencyKey: 'kb', profileId: h.profile.id, matchId: h.match.id, market: 'both_teams_booked', selection: booked, stake: 10, oddsAtPlacement: 1.3, status: 'open', debited: true });
    h.store.insertBet({ id: 'b_red', idempotencyKey: 'kr', profileId: h.profile.id, matchId: h.match.id, market: 'red_card', selection: redSel === 'yes' ? 'no' : 'yes', stake: 10, oddsAtPlacement: 9.5, status: 'open', debited: true });

    const settled = h.store.settleMatch(h.match.id, { home: gen.score.home, away: gen.score.away },
      { timeline: gen.timeline, lineups: gen.lineups, now: Date.now() });
    assert.strictEqual(settled.ok, true, settled.reason);
    const stored = h.store.getMatch(h.match.id);
    assert.deepStrictEqual(stored.result.cards, cards, 'el conteo de tarjetas queda asentado');

    // cleanMatch conserva el conteo al recargar.
    const reloaded = cleanMatch(JSON.parse(JSON.stringify(stored)));
    assert.deepStrictEqual(reloaded.result.cards, cards, 'cleanMatch conserva las tarjetas');

    h.betting.settleMatchBets(stored, { home: gen.score.home, away: gen.score.away });
    assert.strictEqual(h.store.getBet('b_y35').status, 'won', 'amarillas 3.5 cobra con el conteo real');
    assert.strictEqual(h.store.getBet('b_y45').status, 'lost', 'la selección contraria pierde');
    assert.strictEqual(h.store.getBet('b_booked').status, 'won', 'ambos amonestados cobra');
    assert.strictEqual(h.store.getBet('b_red').status, 'lost', 'la roja contraria pierde');
  } finally {
    h.cleanup();
  }
});

test('cleanMatch descarta un conteo de tarjetas corrupto (el boleto quedará void)', () => {
  const raw = {
    id: 'm1', seasonMonth: '2026-11', jornada: 1, status: 'settled', settledAt: 1,
    result: { home: 1, away: 0, winner: 'home', cards: { yellow: 3, red: -1, homeYellow: 1, awayYellow: 2, homeRed: 0, awayRed: 1 } }
  };
  const clean = cleanMatch(raw);
  assert.strictEqual(clean.result.cards, undefined, 'conteo con negativos no se conserva');
  const good = cleanMatch({ ...raw, result: { ...raw.result, cards: { yellow: 3, red: 1, homeYellow: 1, awayYellow: 2, homeRed: 0, awayRed: 1 } } });
  assert.deepStrictEqual(good.result.cards, { yellow: 3, red: 1, homeYellow: 1, awayYellow: 2, homeRed: 0, awayRed: 1 });
});
