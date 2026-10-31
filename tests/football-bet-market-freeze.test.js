'use strict';

// El mercado que se vende es el que se liquida.
//
// `correct_score` publica doce marcadores exactos más la selección `other`
// ("cualquier otro resultado"). Esas doce celdas se calculan con la matriz de
// goles del momento, y la matriz se mueve con cada resultado asentado de la liga
// (ratings de los clubes + contexto rodante). Si al liquidar se recalculan, la
// apuesta cambia de significado: un boleto a `other` vendido cuando 0-1 estaba
// entre las doce se resolvía contra una lista nueva que ya no la contenía y
// pagaba una apuesta que había perdido.
//
// La corrección archiva las celdas publicadas con la apuesta (y con cada pata de
// la combinada) y resuelve `other` contra ellas.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { cleanBet, cleanParlayLeg, monthKey } = require('../lib/football-store-shared');

const MIN_STAKE = 25000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmarket-'));
  const footballPath = path.join(dir, 'football.json');
  const store = new FootballStore(footballPath);
  const month = monthKey();
  const league = store.generateSeason(month);
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const profile = profiles.getOrCreate('p1', 'Jugador', null);
  profile.chips = 10_000_000;
  profiles.saveNow();
  // Un boleto se vende antes del kickoff, con el mismo guardado durable que producción.
  const now = Math.min(...league.calendar.matches.map(match => match.scheduledKickoffAt)) - 60000;
  const betting = createBettingService({ store, profiles, now: () => now, log: () => {} });
  const cleanup = () => {
    try { store.close(); } catch (_) {}
    try { profiles.saveNow(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, league, profiles, profile, betting, month, footballPath, cleanup };
}

// Mueve la matriz de goles del partido sin tocar el partido: es lo que hace la
// liga al asentar otros resultados entre la apuesta y el kickoff.
function driftMatrix(league, clubIds) {
  league.ctx = { leagueAvg: 4.2, homeAdv: 1.6, sample: 40 };
  for (const clubId of clubIds) {
    const club = league.config.find(item => item.id === clubId);
    if (!club) continue;
    club.ratings = { ...club.ratings, att: (club.ratings.att || 1) * 2.2, def: (club.ratings.def || 1) * 0.45 };
  }
}

test('la apuesta archiva las celdas publicadas y sobrevive al guardado', t => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const match = ctx.store.getMatches(ctx.month).find(item => item.status === 'scheduled');
  const market = ctx.betting.getMarket(match, 'correct_score', {});
  const published = market.selections.map(item => item.key).filter(key => key !== 'other');
  assert.equal(published.length, 12);

  return ctx.betting.placeBet({
    profile: ctx.profile, matchId: match.id, market: 'correct_score', selection: 'other', stake: MIN_STAKE
  }).then(placed => {
    assert.equal(placed.ok, true);
    assert.deepEqual(placed.bet.correctScoreCells, published);
    // Se rehidrata igual desde el JSON del store (backend de archivo y PG).
    const stored = ctx.store.getBet(placed.bet.id);
    assert.deepEqual(stored.correctScoreCells, published);
    const reloaded = new FootballStore(ctx.footballPath);
    assert.deepEqual(reloaded.getBet(placed.bet.id).correctScoreCells, published);
    reloaded.close();
    // Las apuestas de otros mercados no cargan el campo.
    assert.equal(Object.hasOwn(cleanBet({ ...placed.bet, correctScoreCells: undefined }), 'correctScoreCells'), false);
  });
});

test('"otro resultado" se resuelve contra las doce celdas que se vendieron', async t => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const match = ctx.store.getMatches(ctx.month).find(item => item.status === 'scheduled');
  const published = ctx.betting.getMarket(match, 'correct_score', {})
    .selections.map(item => item.key).filter(key => key !== 'other');

  const placed = await ctx.betting.placeBet({
    profile: ctx.profile, matchId: match.id, market: 'correct_score', selection: 'other', stake: MIN_STAKE
  });
  assert.equal(placed.ok, true);
  assert.ok(published.includes(placed.bet.correctScoreCells[0]));

  // El partido termina con un marcador que SÍ estaba entre las doce publicadas:
  // la apuesta a `other` perdió por definición.
  const score = placed.bet.correctScoreCells[0];
  const [home, away] = score.split('-').map(Number);
  ctx.store.settleMatch(match.id, { home, away }, { seasonMonth: ctx.month });

  // La liga se ha movido (es lo que dispara el error): la matriz de hoy ya no
  // contiene ese marcador entre sus doce favoritos.
  driftMatrix(ctx.league, [match.homeId, match.awayId]);
  assert.equal(ctx.betting._correctScoreCells(match).includes(score), false,
    'el escenario reproduce la divergencia entre lo vendido y lo recalculado');

  ctx.betting.settleMatchBets(match, { home, away });
  const after = ctx.store.getBet(placed.bet.id);
  assert.equal(after.status, 'lost');
  assert.equal(after.payout, 0);

  // Control: sin celdas archivadas (boleto viejo) el código caía en el recálculo.
  assert.equal(ctx.betting._cellsForBet({ correctScoreCells: null }, match).includes(score), false,
    'el recálculo, solo, habría pagado la apuesta');
});

test('la liquidación de arranque usa las mismas celdas archivadas', async t => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const match = ctx.store.getMatches(ctx.month).find(item => item.status === 'scheduled');
  const placed = await ctx.betting.placeBet({
    profile: ctx.profile, matchId: match.id, market: 'correct_score', selection: 'other', stake: MIN_STAKE
  });
  assert.equal(placed.ok, true);
  const score = placed.bet.correctScoreCells[0];
  const [home, away] = score.split('-').map(Number);
  ctx.store.settleMatch(match.id, { home, away }, { seasonMonth: ctx.month });
  driftMatrix(ctx.league, [match.homeId, match.awayId]);

  // Sin pasar por el hook del motor: el reconciliador de arranque liquida solo.
  ctx.betting.reconcileEscrow();
  const after = ctx.store.getBet(placed.bet.id);
  assert.equal(after.status, 'lost');
  assert.equal(after.payout, 0);
});

test('cada pata de una combinada guarda sus propias celdas', async t => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const matches = ctx.store.getMatches(ctx.month).filter(item => item.status === 'scheduled').slice(0, 2);
  assert.equal(matches.length, 2);
  const first = ctx.betting.getMarket(matches[0], 'correct_score', {});
  const published = first.selections.map(item => item.key).filter(key => key !== 'other');

  const placed = await ctx.betting.placeParlay({
    profile: ctx.profile,
    stake: MIN_STAKE,
    legs: [
      { matchId: matches[0].id, market: 'correct_score', selection: 'other' },
      { matchId: matches[1].id, market: '1x2', selection: 'home' }
    ]
  });
  assert.equal(placed.ok, true);
  const leg = placed.parlay.legs.find(item => item.market === 'correct_score');
  assert.deepEqual(leg.correctScoreCells, published);

  const score = leg.correctScoreCells[0];
  const [home, away] = score.split('-').map(Number);
  ctx.store.settleMatch(matches[0].id, { home, away }, { seasonMonth: ctx.month });
  driftMatrix(ctx.league, [matches[0].homeId, matches[0].awayId]);
  ctx.betting.settleMatchBets(matches[0], { home, away });

  const parlay = ctx.store.getParlay(placed.parlay.id);
  const settledLeg = parlay.legs.find(item => item.matchId === matches[0].id);
  assert.equal(settledLeg.status, 'lost', 'la pata de marcador exacto pierde con el marcador vendido');
  assert.equal(parlay.status, 'lost');
});

test('las celdas corruptas no se aceptan y no rompen la apuesta', () => {
  const base = {
    id: 'b1', profileId: 'p1', matchId: 'm1', market: 'correct_score', selection: 'other',
    stake: 1000, oddsAtPlacement: 2, placedAt: 1, status: 'open'
  };
  // Un campo auxiliar corrupto NUNCA hace desaparecer la apuesta: se descarta y
  // la liquidación cae al recálculo, como un boleto anterior a este cambio.
  for (const corrupt of [
    ['1-0', '1-0'], ['1-0', 'dos-uno'], '1-0',
    Array.from({ length: 41 }, (_, i) => `${i}-0`)
  ]) {
    const cleaned = cleanBet({ ...base, correctScoreCells: corrupt });
    assert.ok(cleaned, 'la apuesta sigue siendo válida');
    assert.equal(Object.hasOwn(cleaned, 'correctScoreCells'), false);
  }
  assert.deepEqual(cleanBet({ ...base, correctScoreCells: ['1-0', '2-2'] }).correctScoreCells, ['1-0', '2-2']);
  assert.deepEqual(
    cleanParlayLeg({ matchId: 'm1', market: 'correct_score', selection: 'other', correctScoreCells: ['0-0'] }).correctScoreCells,
    ['0-0']
  );
  assert.equal(Object.hasOwn(cleanParlayLeg({ matchId: 'm1', market: '1x2', selection: 'home' }), 'correctScoreCells'), false);
});
