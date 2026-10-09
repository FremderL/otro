'use strict';

// Fase D — Pruebas de integridad de las fichas (§12, §20: T8, T15, T21, T27,
// T33, T34, T35). Dinero real: escrow WAL, liquidación exactamente-una-vez,
// límites, idempotencia, touch obligatorio y reconciliación.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const P = require('../lib/progression');
const { createBettingService, resolveSelection } = require('../lib/football/betting');
const { SimulatedFlow } = require('../lib/football/simulated-flow');
const { monthKey } = require('../lib/football-store-shared');

// --- Arnés: store de fútbol + store de perfiles reales sobre archivos temporales ---
function setup({ chips = 1000, withSim = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbet-'));
  const footballPath = path.join(dir, 'football.json');
  const profilesPath = path.join(dir, 'profiles.json');
  const store = new FootballStore(footballPath);
  const month = monthKey();
  store.generateSeason(month);
  const profiles = new ProfileStore(profilesPath);
  const profile = profiles.getOrCreate('p1', 'Jugador', null);
  profile.chips = chips;
  profiles.saveNow();
  const betting = createBettingService({
    store, profiles,
    simulatedFlow: withSim ? new SimulatedFlow({ log: () => {} }) : null,
    log: () => {}
  });
  const match = store.getMatches(month).find(m => m.status === 'scheduled');
  const cleanup = () => { try { store.close(); } catch (_) {} try { profiles.saveNow(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, profiles, profile, betting, match, month, footballPath, profilesPath, cleanup };
}

// Silencia logros/retos para que evaluate() no acredite nada y poder contar las
// escrituras de UNA liquidación sin ruido (T35).
function neuterProgression(profile) {
  profile.achievements = P.ACHIEVEMENTS.map(a => a.id);
  profile.challenges = Object.fromEntries(P.CHALLENGES.map(c => [c.id, { completedAt: 1, reward: c.reward }]));
  P.recordOutcome(profile, { game: 'dice', net: 0, eligible: false }); // crea los períodos rotatorios
  profile.rotatingChallenges.daily.completed = true;
  profile.rotatingChallenges.weekly.completed = true;
  profile.transactions.length = 0;
  profile.balanceHistory.length = 0;
}

// --- Resolución de selecciones (puro) ---

test('resolveSelection resuelve cada mercado contra el marcador', () => {
  const s = (h, a) => ({ home: h, away: a });
  assert.strictEqual(resolveSelection('1x2', 'home', s(2, 0)), 'won');
  assert.strictEqual(resolveSelection('1x2', 'draw', s(2, 0)), 'lost');
  assert.strictEqual(resolveSelection('1x2', 'draw', s(1, 1)), 'won');
  assert.strictEqual(resolveSelection('double_chance', '1X', s(1, 1)), 'won');
  assert.strictEqual(resolveSelection('double_chance', '12', s(1, 1)), 'lost');
  assert.strictEqual(resolveSelection('double_chance', 'X2', s(0, 2)), 'won');
  assert.strictEqual(resolveSelection('over_under_2.5', 'over', s(2, 1)), 'won');   // 3 > 2.5
  assert.strictEqual(resolveSelection('over_under_2.5', 'over', s(1, 1)), 'lost');  // 2 < 2.5
  assert.strictEqual(resolveSelection('over_under_2', 'over', s(1, 1)), 'void');    // empuje en línea entera
  assert.strictEqual(resolveSelection('btts', 'yes', s(1, 1)), 'won');
  assert.strictEqual(resolveSelection('btts', 'yes', s(2, 0)), 'lost');
  assert.strictEqual(resolveSelection('correct_score', '2-0', s(2, 0)), 'won');
  assert.strictEqual(resolveSelection('correct_score', 'other', s(2, 0), { correctScoreCells: ['1-0', '2-0'] }), 'lost');
  assert.strictEqual(resolveSelection('correct_score', 'other', s(7, 7), { correctScoreCells: ['1-0', '2-0'] }), 'won');
  assert.strictEqual(resolveSelection('handicap_home_minus1', 'home', s(2, 0)), 'won');  // 2-1-0 → +1 local
  assert.strictEqual(resolveSelection('handicap_home_minus1', 'draw', s(2, 1)), 'won');  // 2-1=1 → empuje hándicap
  assert.strictEqual(resolveSelection('win_to_nil_home', 'yes', s(2, 0)), 'won');
  assert.strictEqual(resolveSelection('win_to_nil_home', 'yes', s(2, 1)), 'lost');
  assert.strictEqual(resolveSelection('team_total_away_1.5', 'over', s(0, 2)), 'won');
  assert.strictEqual(resolveSelection('mercado_raro', 'x', s(1, 0)), 'void');
});

// --- Colocación: orden WAL (A8) ---

test('placeBet sigue el WAL: queda open, debita el stake y es idempotente', async () => {
  const h = setup({ chips: 1000 });
  const r = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(r.bet.status, 'open');
  assert.strictEqual(r.bet.debited, true);
  assert.strictEqual(h.profile.chips, 900, 'el stake salió del perfil');
  assert.ok(r.bet.oddsAtPlacement > 1, 'cuota real, no el fallback 1');
  // Reintento con la misma clave → devuelve la original, no crea una segunda.
  const r2 = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  assert.strictEqual(r2.replayed, true);
  assert.strictEqual(h.store.getBets({ profileId: 'p1' }).length, 1, 'no se duplicó la apuesta');
  assert.strictEqual(h.profile.chips, 900, 'no se debitó dos veces');
  h.cleanup();
});

test('T34: la sección crítica es síncrona — apuestas concurrentes nunca dejan saldo negativo', async () => {
  const h = setup({ chips: 1000 });
  // 15 apuestas concurrentes de 100. El tope (25 %) y el débito síncrono impiden
  // que el saldo baje de 0 aunque todas comprueben «a la vez».
  const calls = [];
  for (let i = 0; i < 15; i++) {
    calls.push(h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 5000 + i * 3000 }));
  }
  const results = await Promise.all(calls);
  const ok = results.filter(r => r.ok && !r.replayed);
  const debited = ok.reduce((s, r) => s + r.bet.stake, 0);
  assert.ok(h.profile.chips >= 0, `saldo negativo: ${h.profile.chips}`);
  assert.strictEqual(h.profile.chips, 1000 - debited, 'el saldo refleja exactamente lo debitado');
  assert.ok(debited <= 1000, 'nunca se debita más que el saldo');
  h.cleanup();
});

test('T34: ninguna apuesta open sin débito, y cancelPendingBets reembolsa solo lo debitado', () => {
  const h = setup({ chips: 1000 });
  // Simula dos huérfanos del WAL: uno llegó a debitar, otro no.
  h.profile.chips = 800; // como si uno de 200 ya se hubiera debitado
  h.store.insertBet({ id: 'b_orphan1', idempotencyKey: 'k_o1', profileId: 'p1', matchId: h.match.id, market: '1x2', selection: 'home', stake: 200, oddsAtPlacement: 2, status: 'pending', debited: true, placedAt: 1 });
  h.store.insertBet({ id: 'b_orphan2', idempotencyKey: 'k_o2', profileId: 'p1', matchId: h.match.id, market: '1x2', selection: 'away', stake: 300, oddsAtPlacement: 3, status: 'pending', debited: false, placedAt: 2 });
  h.profiles.saveNow();
  const before = h.profile.chips;
  const cancelled = h.betting.cancelPendingBets();
  assert.strictEqual(cancelled, 2);
  assert.strictEqual(h.store.getBet('b_orphan1').status, 'void');
  assert.strictEqual(h.store.getBet('b_orphan2').status, 'void');
  // Solo el debitado se reembolsa: 800 + 200 = 1000. El otro nunca sacó fichas.
  assert.strictEqual(h.profile.chips, before + 200);
  assert.strictEqual(h.store.getBets({ status: 'pending' }).length, 0, 'no queda ningún pending');
  h.cleanup();
});

// --- Liquidación exactamente una vez (T8) ---

test('T8: 50 llamadas concurrentes a liquidar pagan una sola vez', () => {
  const h = setup({ chips: 1000 });
  neuterProgression(h.profile);
  // Fuerza una apuesta ganadora abierta.
  h.profile.chips = 900;
  h.store.insertBet({ id: 'b_win', idempotencyKey: 'k_w', profileId: 'p1', matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true, placedAt: 1, potentialPayout: 200 });
  h.profiles.saveNow();
  const before = h.profile.chips;
  let paid = 0;
  for (let i = 0; i < 50; i++) {
    const res = h.betting.settleMatchBets(h.match, { home: 2, away: 0 }); // local gana
    paid += res.paid;
  }
  assert.strictEqual(h.store.getBet('b_win').status, 'won');
  assert.strictEqual(h.store.getBet('b_win').payout, 200);
  assert.strictEqual(paid, 200, 'se pagó exactamente una vez, no 50');
  assert.strictEqual(h.profile.chips, before + 200, 'el perfil recibió un único pago');
  h.cleanup();
});

test('T35: una liquidación escribe UNA transacción (el neto) y UN punto de saldo, nunca el bruto', () => {
  const h = setup({ chips: 1000 });
  neuterProgression(h.profile);
  h.profile.chips = 900;
  h.store.insertBet({ id: 'b_w', idempotencyKey: 'k_w', profileId: 'p1', matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2.5, status: 'open', debited: true, placedAt: 1, potentialPayout: 250 });
  h.profiles.saveNow();
  const t0 = h.profile.transactions.length, b0 = h.profile.balanceHistory.length;
  h.betting.settleMatchBets(h.match, { home: 1, away: 0 }); // gana, payout 250, net +150
  const newTx = h.profile.transactions.slice(t0);
  assert.strictEqual(newTx.length, 1, `una sola transacción, no ${newTx.length}`);
  assert.strictEqual(newTx[0].amount, 150, 'la transacción es el NETO (payout−stake), no el bruto');
  assert.ok(!newTx.some(t => t.amount === 250), 'nadie reintrodujo credit(payout) junto a recordOutcome');
  assert.strictEqual(h.profile.balanceHistory.length - b0, 1, 'un solo punto en la gráfica de saldo');
  assert.strictEqual(h.profile.chips, 900 + 250);
  h.cleanup();
});

test('T27: 20 apuestas liquidadas a la vez no alteran eligibleBestStreak pero sí gameStats.football', () => {
  const h = setup({ chips: 100000 });
  neuterProgression(h.profile);
  h.profile.stats.eligibleBestStreak = 0;
  // 20 apuestas ganadoras sobre el mismo partido.
  for (let i = 0; i < 20; i++) {
    h.store.insertBet({ id: `b_${i}`, idempotencyKey: `k_${i}`, profileId: 'p1', matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true, placedAt: i, potentialPayout: 200 });
  }
  h.betting.settleMatchBets(h.match, { home: 3, away: 0 });
  assert.strictEqual(h.profile.stats.eligibleBestStreak, 0, 'la racha de platino no se fabrica con 20 victorias simultáneas');
  assert.strictEqual(h.profile.gameStats.football.rounds, 20, 'las estadísticas generales sí cuentan cada apuesta');
  assert.strictEqual(h.profile.gameStats.football.wins, 20);
  h.cleanup();
});

// --- Límites (T15, T21) ---

test('T21: mínimo 10 % y tope 50 % del saldo; denominaciones filtradas; con saldo bajo se ajusta', () => {
  const h = setup({ chips: 1000 });
  let b = h.betting.stakeBounds(h.profile);
  assert.strictEqual(b.min, 100, '10 % de 1000');
  assert.strictEqual(b.max, 500, '50 % de 1000');
  assert.deepStrictEqual(h.betting.availableDenominations(h.profile), [100, 250, 500], 'filtradas por mínimo y tope');
  // Saldo 8: tope 4 y mínimo ajustado a 1; ninguna denominación estándar cabe.
  h.profile.chips = 8;
  b = h.betting.stakeBounds(h.profile);
  assert.strictEqual(b.max, 4, '50 % de 8');
  assert.strictEqual(b.min, 1, 'mínimo con piso de 1 ficha');
  assert.deepStrictEqual(h.betting.availableDenominations(h.profile), [], 'ninguna denominación estándar cabe');
  // Saldo enorme: el tope absoluto (25 000) manda y el mínimo se ajusta a él.
  h.profile.chips = 1000000;
  b = h.betting.stakeBounds(h.profile);
  assert.strictEqual(b.max, 25000, 'tope absoluto');
  assert.strictEqual(b.min, 25000, 'el mínimo (10 %) se ajusta al tope absoluto');
  h.cleanup();
});

test('T15: stake fuera de límites, mercado suspendido y rate limit rechazan con su código', async () => {
  const h = setup({ chips: 1000 });
  // Tope excedido.
  const over = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 600, placedAt: 1000 });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.code, 'stake_excede_tope');
  // Bajo el mínimo.
  const low = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 3, placedAt: 2000 });
  assert.strictEqual(low.code, 'stake_bajo_minimo');
  // Mercado suspendido (§10.6).
  h.betting.suspend(h.match.id, '1x2', Date.now() + 60000);
  const susp = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 3000 });
  assert.strictEqual(susp.code, 'market_suspended');
  h.betting.resume(h.match.id, '1x2');
  // Selección inexistente.
  const badSel = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'nope', stake: 100, placedAt: 4000 });
  assert.strictEqual(badSel.code, 'selection_invalida');
  // Rate limit: 10 intentos / 10 s. Con mínimo del 10 %, diez apuestas agotarían el
  // saldo antes de que el límite de frecuencia actúe (y la exposición por partido
  // rechazaría antes); se relajan exposición y se da saldo alto para AISLAR el rate
  // limit, que es lo que esta parte prueba.
  h.profile.chips = 1000000;
  h.betting.config.maxExposurePerProfileMatch = 1e12;
  h.betting.config.maxExposurePerMatch = 1e12;
  // Cada intento va a un partido distinto: la regla de una selección por categoría
  // (mercado + partido) no debe enmascarar el rate limit.
  const others = h.store.getMatches(h.month).filter(m => m.status === 'scheduled');
  let rateLimited = false;
  for (let i = 0; i < 14; i++) {
    const r = await h.betting.placeBet({ profile: h.profile, matchId: others[i].id, market: 'over_under_2.5', selection: 'over', stake: 25000, placedAt: 100000 + i * 3000 });
    if (r.code === 'rate_limit') { rateLimited = true; break; }
  }
  assert.ok(rateLimited, 'el rate limit debió activarse');
  h.cleanup();
});

test('T15: no se apuesta en un partido terminado y el saldo insuficiente se rechaza', async () => {
  const h = setup({ chips: 1000 });
  h.match.status = 'settled';
  const r = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 50, placedAt: 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'mercado_cerrado');
  h.cleanup();

  const h2 = setup({ chips: 1000 });
  h2.profile.chips = 5; // por debajo del mínimo ajustable
  const r2 = await h2.betting.placeBet({ profile: h2.profile, matchId: h2.match.id, market: '1x2', selection: 'home', stake: 5, placedAt: 1000 });
  assert.strictEqual(r2.ok, false);
  h2.cleanup();
});

// --- Reembolso y cash-out ---

test('refundMatchBets anula y reembolsa al posponer un partido', async () => {
  const h = setup({ chips: 1000 });
  await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  assert.strictEqual(h.profile.chips, 900);
  const out = h.betting.refundMatchBets(h.match, 'partido pospuesto');
  assert.strictEqual(out.refunded, 1);
  assert.strictEqual(h.store.getBets({ profileId: 'p1' })[0].status, 'void');
  assert.strictEqual(h.profile.chips, 1000, 'stake devuelto');
  assert.ok(h.profile.transactions.some(t => /Anulación/.test(t.reason)), 'transacción con motivo legible');
  h.cleanup();
});

test('cash-out devuelve el valor esperado del boleto menos el margen', async () => {
  const h = setup({ chips: 1000 });
  const r = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  assert.strictEqual(r.ok, true);
  h.match.status = 'live';
  const co = h.betting.cashout(h.profile, r.bet.id, { minute: 30, score: { home: 1, away: 0 } });
  assert.strictEqual(co.ok, true, co.code);
  assert.ok(co.cashout > 0 && co.cashout <= r.bet.potentialPayout, 'cash-out acotado');
  assert.strictEqual(h.store.getBet(r.bet.id).status, 'cashed');
  // No disponible con el partido terminado.
  const h2 = setup({ chips: 1000 });
  const r2 = await h2.betting.placeBet({ profile: h2.profile, matchId: h2.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  h2.match.status = 'settled';
  assert.strictEqual(h2.betting.cashout(h2.profile, r2.bet.id, {}).code, 'match_ended');
  h.cleanup(); h2.cleanup();
});

// --- Combinadas y futuros ---

test('combinada: escrow, patas y pago multiplicado; pata anulada → cuota 1.00', async () => {
  const h = setup({ chips: 1000 });
  const matches = h.store.getMatches(h.month).filter(m => m.status === 'scheduled');
  const [m1, m2] = matches;
  const r = await h.betting.placeParlay({ profile: h.profile, legs: [
    { matchId: m1.id, market: '1x2', selection: 'home' },
    { matchId: m2.id, market: '1x2', selection: 'home' }
  ], stake: 100, placedAt: 1000 });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(h.profile.chips, 900);
  assert.strictEqual(r.parlay.legs.length, 2);
  assert.ok(r.parlay.combinedOdds > 1);
  // Resuelve la primera pata (ganadora): aún abierta.
  h.betting.settleParlayLeg(r.parlay.id, m1.id, { home: 2, away: 0 }, []);
  assert.strictEqual(h.store.getParlay(r.parlay.id).status, 'open', 'falta una pata');
  // Segunda pata ganadora → paga la combinada.
  h.betting.settleParlayLeg(r.parlay.id, m2.id, { home: 1, away: 0 }, []);
  const settled = h.store.getParlay(r.parlay.id);
  assert.strictEqual(settled.status, 'won');
  assert.ok(settled.payout >= 100 * settled.combinedOdds - 1, 'pago = stake × cuota combinada');
  h.cleanup();
});

test('combinada: una pata perdida → lost inmediato; todas anuladas → reembolso', async () => {
  const h = setup({ chips: 1000 });
  const [m1, m2] = h.store.getMatches(h.month).filter(m => m.status === 'scheduled');
  const r = await h.betting.placeParlay({ profile: h.profile, legs: [
    { matchId: m1.id, market: '1x2', selection: 'home' }, { matchId: m2.id, market: '1x2', selection: 'home' }
  ], stake: 100, placedAt: 1000 });
  h.betting.settleParlayLeg(r.parlay.id, m1.id, { home: 0, away: 2 }, []); // pata perdida
  assert.strictEqual(h.store.getParlay(r.parlay.id).status, 'lost', 'una pata perdida tumba la combinada');
  assert.strictEqual(h.store.getParlay(r.parlay.id).payout, 0);

  const h2 = setup({ chips: 1000 });
  const [n1, n2] = h2.store.getMatches(h2.month).filter(m => m.status === 'scheduled');
  const r2 = await h2.betting.placeParlay({ profile: h2.profile, legs: [
    { matchId: n1.id, market: '1x2', selection: 'home' }, { matchId: n2.id, market: '1x2', selection: 'home' }
  ], stake: 100, placedAt: 1000 });
  h2.betting.settleParlayLeg(r2.parlay.id, n1.id, null, [], 'pospuesto'); // anulada
  h2.betting.settleParlayLeg(r2.parlay.id, n2.id, null, [], 'pospuesto'); // anulada
  assert.strictEqual(h2.store.getParlay(r2.parlay.id).status, 'void');
  assert.strictEqual(h2.profile.chips, 1000, 'todas anuladas → reembolso completo');
  h.cleanup(); h2.cleanup();
});

test('futuros: escrow al colocar, pago al cerrar la temporada y reembolso si se trunca', async () => {
  const h = setup({ chips: 1000 });
  neuterProgression(h.profile);
  const r = await h.betting.placeFuture({ profile: h.profile, seasonMonth: h.month, market: 'champion', selection: 'atletico_solaris', odds: 8, stake: 100, placedAtJornada: 1, placedAt: 1000 });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(h.profile.chips, 900);
  // Duplicado abierto → rechazado.
  const dup = await h.betting.placeFuture({ profile: h.profile, seasonMonth: h.month, market: 'champion', selection: 'atletico_solaris', odds: 8, stake: 100, placedAtJornada: 1, placedAt: 2000 });
  assert.strictEqual(dup.code, 'futuro_duplicado');
  // Cierra la temporada con ese campeón → gana.
  const res = h.betting.settleFutures(h.month, { championTeamId: 'atletico_solaris' });
  assert.strictEqual(res.settled, 1);
  assert.strictEqual(h.store.getFutures({ profileId: 'p1' })[0].status, 'won');
  assert.strictEqual(h.profile.chips, 900 + 800, 'pago = 100 × 8');

  const h2 = setup({ chips: 1000 });
  await h2.betting.placeFuture({ profile: h2.profile, seasonMonth: h2.month, market: 'champion', selection: 'vantora', odds: 6, stake: 100, placedAtJornada: 1, placedAt: 1000 });
  const ref = h2.betting.refundFutures(h2.month, 'temporada truncada');
  assert.strictEqual(ref.refunded, 1);
  assert.strictEqual(h2.profile.chips, 1000, 'futuro reembolsado');
  h.cleanup(); h2.cleanup();
});

// --- Durabilidad y reconciliación (T33) ---

test('T33: placeBet persiste el débito — tras un reinicio el stake sigue descontado y se liquida bien', async () => {
  const h = setup({ chips: 1000 });
  neuterProgression(h.profile);
  const r = await h.betting.placeBet({ profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  assert.strictEqual(r.ok, true);
  const odds = r.bet.oddsAtPlacement;
  // Reinicio: nuevos stores sobre los MISMOS archivos.
  const store2 = new FootballStore(h.footballPath);
  const profiles2 = new ProfileStore(h.profilesPath);
  const profile2 = profiles2.getProfile('p1');
  assert.ok(profile2, 'el perfil sobrevive');
  assert.strictEqual(profile2.chips, 900, 'el stake sigue descontado tras reiniciar');
  const bet2 = store2.getBet(r.bet.id);
  assert.strictEqual(bet2.status, 'open', 'la apuesta sobrevive como open');
  // Liquida contra el saldo correcto.
  const betting2 = createBettingService({ store: store2, profiles: profiles2, log: () => {} });
  const match2 = store2.getMatch(h.match.id);
  betting2.settleMatchBets(match2, { home: 2, away: 0 });
  assert.strictEqual(profile2.chips, 900 + Math.floor(100 * odds), 'pago contra el saldo ya debitado');
  try { store2.close(); } catch (_) {}
  profiles2.saveNow();
  h.cleanup();
});

test('reconcileEscrow fuerza la liquidación de apuestas open en partidos ya asentados', () => {
  const h = setup({ chips: 1000 });
  neuterProgression(h.profile);
  h.profile.chips = 900;
  h.match.status = 'settled';
  h.match.result = { home: 2, away: 0, winner: 'home' };
  h.store.insertBet({ id: 'b_late', idempotencyKey: 'k_l', profileId: 'p1', matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2, status: 'open', debited: true, placedAt: 1, potentialPayout: 200 });
  h.profiles.saveNow();
  h.betting.reconcileEscrow();
  assert.strictEqual(h.store.getBet('b_late').status, 'won', 'se liquidó al reconciliar');
  assert.strictEqual(h.profile.chips, 900 + 200);
  h.cleanup();
});

// --- Flujo simulado: contabilidad separada (T18) ---

test('T18: el flujo simulado mueve cuotas pero no altera exposición ni toca ningún perfil', async () => {
  const h = setup({ chips: 1000, withSim: true });
  const plain = setup({ chips: 1000 });
  const simMkt = h.betting.getMarket(h.match, '1x2', {});
  const openMkt = plain.betting.getMarket(plain.match, '1x2', {});
  // Con 0 apuestas reales, el simulado mueve las cuotas respecto de la apertura.
  assert.notDeepStrictEqual(simMkt.selections.map(s => s.price), openMkt.selections.map(s => s.price), 'el sim debió mover las cuotas');
  // Pero NO cuenta para exposición ni escrow.
  assert.strictEqual(h.store.sumOpenStake(h.match.id), 0, 'el sim no es exposición real');
  assert.strictEqual(h.betting.countEscrow(), 0);
  assert.strictEqual(h.betting.countOpenBets(), 0);
  assert.strictEqual(h.profile.chips, 1000, 'ningún perfil fue tocado');
  h.cleanup(); plain.cleanup();
});

test('T18/T20: con dinero real el flujo simulado pierde influencia por debajo del 5 %', () => {
  const SF = require('../lib/football/simulated-flow');
  assert.strictEqual(SF.decay(0), 1, 'sin reales, 100 % de influencia');
  assert.ok(Math.abs(SF.decay(2000) - 0.5) < 1e-9, '2.000 reales → 50 %');
  assert.ok(SF.decay(10000) < 0.18 && SF.decay(10000) > 0.16, '10.000 → ~17 %');
  assert.ok(SF.decay(40000) < 0.05, '40.000 reales → influencia por debajo del 5 %');
  // El flujo es determinista por seed (auditable).
  const probs = { home: 0.5, draw: 0.27, away: 0.23 };
  const m = { id: 'm1', seed: 4242, block: 'estelar' };
  assert.deepStrictEqual(SF.distribute(m, '1x2', probs, {}), SF.distribute(m, '1x2', probs, {}));
  assert.notDeepStrictEqual(SF.distribute(m, '1x2', probs, {}), SF.distribute({ ...m, seed: 99 }, '1x2', probs, {}));
});
