'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { ACHIEVEMENTS, CHALLENGES } = require('../lib/progression');
const { FootballEngine } = require('../lib/football/engine');
const { prepareV2Match } = require('../lib/football/v2/prepare');
const { commitmentId } = require('../lib/football/v2/commitment');
const { createBettingService } = require('../lib/football/betting');
const {
  BALLON_DOR_MARKET, MAX_PAYOUT, OVERROUND, SIMULATIONS,
  BallonDorMarketService, oddsFromProbability, projectBallonDorOdds,
  officialPositions, publicBallonDorMarket
} = require('../lib/football/ballon-dor-market');
const { hash32 } = require('../lib/football/prng');
const { zonedTimeToMs } = require('../lib/football/fixtures');
const { footballSeasonResetGate } = require('../lib/football/reset-gate');
const { monthKey, calendarParts, CASINO_TIME_ZONE } = require('../lib/profile-store-shared');

const SEASON = '2099-11';
const NEXT_SEASON = '2099-12';
const DAY = 24 * 60 * 60 * 1000;
const openAt = zonedTimeToMs({ year: 2099, month: 11, day: 1 }, CASINO_TIME_ZONE);

function tempHarness({ chips = 1000, createProfiles = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdo-market-'));
  const footballPath = path.join(dir, 'football.json');
  const profilePath = path.join(dir, 'profiles.json');
  const store = new FootballStore(footballPath);
  const league = store.generateSeason(SEASON, { createdAt: openAt });
  let profiles = null;
  let profile = null;
  if (createProfiles) {
    profiles = new ProfileStore(profilePath);
    profile = profiles.getOrCreate('bdo-profile-test', 'Prueba BDO');
    profile.chips = chips;
    profiles.seasons.current = SEASON;
    profiles.saveNow();
  }
  const cleanup = () => {
    try { store.close(); } catch (_) {}
    try { profiles?.saveNow(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, footballPath, profilePath, store, league, profiles, profile, cleanup };
}

function neutralizeProgression(profile) {
  profile.achievements = ACHIEVEMENTS.map(item => item.id);
  profile.challenges = Object.fromEntries(CHALLENGES.map(item => [item.id, { completedAt: 1, reward: item.reward }]));
}

function fixedSnapshot(league, afterJornada = 0, updatedAt = openAt + 1) {
  const wins = SIMULATIONS / 16;
  return {
    updatedAt: Math.max(updatedAt, league.ballonDor.updatedAt),
    afterJornada,
    simulations: SIMULATIONS,
    seed: hash32(`fixed|${league.seasonMonth}|${afterJornada}`),
    overround: OVERROUND,
    selections: league.ballonDor.candidates.map(candidate => ({
      candidateId: candidate.id,
      wins,
      probability: wins / SIMULATIONS,
      odds: oddsFromProbability(wins / SIMULATIONS)
    })).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  };
}

function fakeProjectOdds({ league, afterJornada, updatedAt }) {
  return fixedSnapshot(league, afterJornada, updatedAt);
}

function settleThrough(league, jornada, settledAt, result = { home: 0, away: 0 }) {
  for (const match of league.calendar.matches) {
    if (match.desempate || match.jornada > jornada) continue;
    match.status = 'settled';
    match.result = {
      home: result.home,
      away: result.away,
      winner: result.home > result.away ? 'home' : result.home < result.away ? 'away' : 'draw'
    };
    match.settledAt = settledAt;
  }
}

function settleSeasonWithChampion(league, championId, settledAt) {
  for (const match of league.calendar.matches) {
    if (match.desempate || match.jornada < 1 || match.jornada > 30) continue;
    const championIsHome = match.homeId === championId;
    const championIsAway = match.awayId === championId;
    const result = championIsHome ? { home: 2, away: 0 }
      : championIsAway ? { home: 0, away: 2 } : { home: 1, away: 1 };
    match.status = 'settled';
    match.result = {
      ...result,
      winner: result.home > result.away ? 'home' : result.home < result.away ? 'away' : 'draw'
    };
    match.settledAt = settledAt;
  }
}

async function activateWithSnapshot(harness, at = openAt) {
  const transition = await harness.store.transitionBallonDor(SEASON, 'active', { at });
  assert.equal(transition.ok, true);
  const snapshot = fixedSnapshot(harness.league, 0, at + 1);
  const update = await harness.store.updateBallonDorOdds(SEASON, snapshot, snapshot.updatedAt);
  assert.equal(update.ok, true);
  return snapshot;
}

test('proyección usa 2,000 simulaciones sembradas y publica 16 cuotas antiarbitraje reproducibles', () => {
  const h = tempHarness();
  try {
    const first = projectBallonDorOdds({ league: h.league, afterJornada: 0, updatedAt: openAt + 1 });
    const repeated = projectBallonDorOdds({ league: h.league, afterJornada: 0, updatedAt: openAt + 1 });
    assert.deepEqual(first, repeated);
    assert.equal(first.simulations, 2000);
    assert.equal(first.selections.length, 16);
    assert.equal(first.selections.reduce((sum, row) => sum + row.wins, 0), 2000);
    assert.equal(first.overround, 1.1);
    assert.ok(first.selections.every(row => row.odds >= 1.01 && row.odds <= 51));
    assert.ok(first.selections.reduce((sum, row) => sum + 1 / row.odds, 0) >= 1.1);
  } finally {
    h.cleanup();
  }
});

test('la ceremonia pública se verifica con el resultado persistido y solo expone el agregado de pagos', () => {
  const candidates = Array.from({ length: 16 }, (_, index) => ({
    id: 'candidate-' + (index + 1),
    clubId: 'club-' + (index + 1),
    clubName: 'Club ' + (index + 1),
    clubShort: 'CL' + (index + 1),
    clubColors: { primary: '#223344', secondary: '#ffffff' },
    playerName: 'Delantero ' + (index + 1),
    playerNumber: 9,
    position: 'ST',
    attributes: { shooting: 70, pace: 70 },
    stats: { goals: 2, assists: 1, appearances: 10, minutes: 900, yellowCards: 0, redCards: 0 },
    points: { goals: 10, assists: 3, appearances: 10, yellowCards: 0, redCards: 0, teamBonus: 5, total: 28 - index }
  }));
  const event = {
    id: 'bdo_' + SEASON, seasonMonth: SEASON, status: 'settled', updatedAt: openAt + 5,
    formulaVersion: 1, candidates,
    result: {
      winnerCandidateId: candidates[0].id, winnerScore: candidates[0].points.total,
      finalizedAt: openAt + 5,
      ranking: candidates.map((candidate, index) => ({ candidateId: candidate.id, rank: index + 1, score: candidate.points.total }))
    }
  };
  const predictions = [
    { id: 'ticket-private-1', profileId: 'profile-private-1', market: BALLON_DOR_MARKET, status: 'won', payout: 500, payoutApplied: true },
    { id: 'ticket-private-2', profileId: 'profile-private-2', market: BALLON_DOR_MARKET, status: 'won', payout: 900, payoutApplied: false },
    { id: 'ticket-private-3', profileId: 'profile-private-3', market: BALLON_DOR_MARKET, status: 'lost', payout: 0, payoutApplied: true },
    { id: 'ticket-private-4', profileId: 'profile-private-4', market: 'match_1x2', status: 'won', payout: 1234, payoutApplied: true }
  ];
  const store = {
    getCurrentSeasonMonth: () => SEASON,
    getSeasonMonths: () => [SEASON],
    getBallonDor: () => event,
    getMatches: () => [{ id: 'final-match', jornada: 30, scheduledKickoffAt: openAt + 29 * DAY }],
    getFutures: ({ seasonMonth }) => seasonMonth === SEASON ? predictions : []
  };
  let now = openAt + 1;
  const beforeAnnouncementService = new BallonDorMarketService({ store, now: () => now });
  const beforeAnnouncement = beforeAnnouncementService.getMarket(SEASON);
  assert.equal(beforeAnnouncement.result, null);
  assert.equal(beforeAnnouncement.ceremony, null);
  assert.equal(beforeAnnouncement.awaitingAnnouncement, true);
  assert.ok(beforeAnnouncement.candidates.every(candidate => candidate.stats === null && candidate.points === null),
    'las estadísticas y puntos finales tampoco filtran quién ganó');
  assert.ok(beforeAnnouncement.resultAnnouncementAt > openAt + 1,
    'el ganador se mantiene oculto hasta las 22:00 después del último partido');
  assert.equal(beforeAnnouncementService.getArchive()[0].winner, null);
  now = beforeAnnouncement.resultAnnouncementAt + 1;
  const service = new BallonDorMarketService({ store, now: () => now });
  const first = service.getMarket(SEASON);
  assert.equal(first.candidates[0].stats.goals, 2);
  assert.equal(first.candidates[0].points.total, 28);
  assert.equal(first.awaitingAnnouncement, false);
  assert.deepEqual(first.ceremony, {
    verified: true,
    eventId: event.id,
    seasonMonth: SEASON,
    finalizedAt: event.result.finalizedAt,
    predictionCount: 3,
    settledPredictionCount: 3,
    winningPredictionCount: 2,
    paidWinningPredictionCount: 1,
    paidVirtualChips: 500,
    pendingPayoutCount: 1,
    settlementComplete: false
  });
  assert.doesNotMatch(JSON.stringify(first.ceremony), /profile-private|ticket-private/);
  assert.doesNotMatch(JSON.stringify(service.getArchive()), /profile-private|ticket-private/);
  assert.equal(service.getArchive()[0].winner.playerName, 'Delantero 1');
  assert.equal(service.getArchive()[0].winner.clubId, candidates[0].clubId);
  assert.equal(service.getArchive()[0].ceremony.paidVirtualChips, 500);

  predictions[1].payoutApplied = true;
  const complete = service.getMarket(SEASON).ceremony;
  assert.equal(complete.settlementComplete, true, 'la selección de otro mercado no entra en el agregado');
  assert.equal(complete.predictionCount, 3);
  predictions[3].market = BALLON_DOR_MARKET;
  predictions[3].seasonMonth = SEASON;
  predictions[3].status = 'lost';
  const fullySettled = service.getMarket(SEASON).ceremony;
  assert.equal(fullySettled.settlementComplete, true);
  assert.equal(fullySettled.predictionCount, 4);
  assert.equal(fullySettled.paidVirtualChips, 1400);

  const secondCandidateId = event.result.ranking[1].candidateId;
  const secondScore = event.result.ranking[1].score;
  event.result.ranking[1].candidateId = event.result.ranking[0].candidateId;
  event.result.ranking[1].score = event.result.ranking[0].score;
  assert.equal(service.getMarket(SEASON).ceremony, null, 'un ranking con candidatos duplicados no habilita ceremonia');
  event.result.ranking[1].candidateId = secondCandidateId;
  event.result.ranking[1].score = secondScore;

  event.result.ranking[0].score++;
  assert.equal(service.getMarket(SEASON).ceremony, null, 'un ranking que no coincide con el resultado no habilita ceremonia');
});

test('el ciclo abre el día 1 y recalcula cuotas una vez por jornada hasta J20', async () => {
  const h = tempHarness();
  try {
    let projectionCount = 0;
    const market = new BallonDorMarketService({
      store: h.store, now: () => openAt + 1000, projectOdds: args => {
        projectionCount++;
        return fakeProjectOdds(args);
      }
    });
    const opened = await market.sweep(openAt + 1000);
    assert.equal(opened.opened, 1);
    assert.equal(h.store.getBallonDor(SEASON).status, 'active');
    assert.equal(h.store.getBallonDor(SEASON).oddsSnapshot.afterJornada, 0);
    assert.equal(projectionCount, 1);

    await market.sweep(openAt + 2000);
    assert.equal(projectionCount, 1, 'un tick no vuelve a calcular la misma jornada');

    const afterFirstRound = openAt + 3 * DAY;
    settleThrough(h.league, 1, afterFirstRound);
    await market.sweep(afterFirstRound);
    assert.equal(h.store.getBallonDor(SEASON).oddsSnapshot.afterJornada, 1);
    assert.equal(projectionCount, 2);
    await market.sweep(afterFirstRound + 1000);
    assert.equal(projectionCount, 2);

    const afterTwentieth = openAt + 22 * DAY;
    settleThrough(h.league, 20, afterTwentieth);
    await market.sweep(afterTwentieth);
    assert.equal(h.store.getBallonDor(SEASON).status, 'locked');
    assert.equal(h.store.getBallonDor(SEASON).oddsSnapshot.afterJornada, 20);
    assert.equal(projectionCount, 3);
    await market.sweep(afterTwentieth + 1000);
    assert.equal(projectionCount, 3);
  } finally {
    h.cleanup();
  }
});

test('si el proceso no llega el día 1, el ciclo se abre tarde en vez de cancelarse', async () => {
  const h = tempHarness();
  try {
    const lateAt = openAt + 5 * DAY + 9 * 60 * 60 * 1000; // día 6, 09:00 locales
    const logEvents = [];
    const market = new BallonDorMarketService({
      store: h.store, projectOdds: fakeProjectOdds, log: eventName => logEvents.push(eventName)
    });
    const first = await market.sweep(lateAt);
    assert.equal(first.cancelled, 0, 'un servidor apagado el día 1 no cancela el ciclo');
    assert.equal(first.opened, 1);
    const event = h.store.getBallonDor(SEASON);
    assert.equal(event.status, 'active');
    assert.equal(event.cancellationReason, null);
    assert.equal(event.startedAt, lateAt);
    assert.ok(logEvents.includes('football_ballon_dor_opened_late'));
    const again = await market.sweep(lateAt + 1000);
    assert.equal(again.opened, 0, 'la apertura tardía no se repite');

    // El ciclo sigue su curso normal: se bloquea al asentarse la J20.
    const afterTwentieth = lateAt + 20 * DAY;
    settleThrough(h.league, 20, afterTwentieth);
    await market.sweep(afterTwentieth);
    assert.equal(h.store.getBallonDor(SEASON).status, 'locked');
  } finally {
    h.cleanup();
  }
});

test('un servidor apagado varios días no impide la ceremonia: se resuelve en la misma pasada', async () => {
  const h = tempHarness();
  try {
    // Nadie hizo sweep hasta después del cierre del mes: el ciclo sigue en
    // `scheduled` y la temporada se jugó y asentó completa antes del cierre.
    const championId = h.league.config[0].id;
    const regularMatches = h.league.calendar.matches.filter(match => !match.desempate && match.jornada >= 1 && match.jornada <= 30);
    const lastKickoff = Math.max(...regularMatches.map(match => match.scheduledKickoffAt));
    settleSeasonWithChampion(h.league, championId, lastKickoff + 60 * 60 * 1000);
    const lateAt = openAt + 32 * DAY; // diciembre: el mes de la temporada ya pasó
    assert.equal(h.store.getBallonDor(SEASON).status, 'scheduled');
    const market = new BallonDorMarketService({ store: h.store, projectOdds: fakeProjectOdds, log: () => {} });
    const summary = await market.sweep(lateAt);
    assert.equal(summary.cancelled, 0, 'la ceremonia no se cancela por no haber abierto el día 1');
    assert.equal(summary.settled, 1);
    const event = h.store.getBallonDor(SEASON);
    assert.equal(event.status, 'settled');
    assert.equal(event.cancellationReason, null);
    assert.ok(event.result, 'el Balón de Oro se entrega igual');
    assert.equal(event.result.winnerCandidateId, h.league.ballonDor.candidates.find(c => c.clubId === championId).id);
  } finally {
    h.cleanup();
  }
});

test('el empate del campeonato crea un solo partido de desempate y aplica su ganador oficial', async () => {
  const h = tempHarness();
  try {
    await activateWithSnapshot(h);
    await h.store.transitionBallonDor(SEASON, 'locked', { at: openAt + 1 });
    const regularCompleteAt = openAt + 25 * DAY;
    settleThrough(h.league, 30, regularCompleteAt, { home: 0, away: 0 });
    const market = new BallonDorMarketService({ store: h.store, projectOdds: fakeProjectOdds });
    const first = await market.sweep(openAt + 26 * DAY);
    assert.equal(first.locked, 0);
    let tiebreak = h.league.calendar.matches.filter(match => match.desempate);
    assert.equal(tiebreak.length, 1);
    await market.sweep(openAt + 26 * DAY + 1000);
    tiebreak = h.league.calendar.matches.filter(match => match.desempate);
    assert.equal(tiebreak.length, 1, 'el reintento no duplica el desempate');

    const match = tiebreak[0];
    const settledAt = match.scheduledKickoffAt + 60 * 60 * 1000;
    const settled = h.store.settleMatch(match.id, { home: 0, away: 0, winner: 'away' }, {
      seasonMonth: SEASON, now: settledAt
    });
    assert.equal(settled.ok, true);
    const finalized = await market.sweep(settledAt + 1000);
    assert.equal(finalized.settled, 1);
    const event = h.store.getBallonDor(SEASON);
    assert.equal(event.status, 'settled');
    assert.equal(event.result.ranking.length, 16);
    const positions = officialPositions(h.league);
    assert.equal(positions.ok, true);
    assert.equal(positions.positions[0].teamId, match.awayId);
    assert.ok(h.store.getStandings(SEASON).every(row => row.played === 30));
  } finally {
    h.cleanup();
  }
});

test('el resultado público y la liquidación de boletos esperan hasta las 22:00 posteriores al último partido', async () => {
  const h = tempHarness({ chips: 1000, createProfiles: true });
  try {
    let now = openAt + 2000;
    await activateWithSnapshot(h, openAt);
    const championId = h.league.config[0].id;
    const winnerCandidate = h.league.ballonDor.candidates.find(candidate => candidate.clubId === championId);
    assert.ok(winnerCandidate);
    neutralizeProgression(h.profile);
    const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => now, log: () => {} });
    const placed = await betting.placeBallonDorBet({
      profile: h.profile, selection: winnerCandidate.id, stake: 100,
      idempotencyKey: 'bdo-key-final-001', placedAt: now
    });
    assert.equal(placed.ok, true, placed.code);
    await h.store.transitionBallonDor(SEASON, 'locked', { at: now + 1 });

    const regularMatches = h.league.calendar.matches.filter(match => !match.desempate && match.jornada >= 1 && match.jornada <= 30);
    const lastKickoff = Math.max(...regularMatches.map(match => match.scheduledKickoffAt));
    const settledAt = lastKickoff + 60 * 60 * 1000;
    settleSeasonWithChampion(h.league, championId, settledAt);
    now = settledAt + 1000;
    const logEvents = [];
    const market = new BallonDorMarketService({
      store: h.store, betting, now: () => now, projectOdds: fakeProjectOdds,
      log: eventName => logEvents.push(eventName)
    });
    const finalized = await market.sweep(now);
    assert.equal(finalized.settled, 1);

    const privateResult = h.store.getBallonDor(SEASON);
    assert.equal(privateResult.status, 'settled', 'el resultado oficial queda persistido');
    const beforeAnnouncement = market.getMarket(SEASON);
    assert.equal(beforeAnnouncement.result, null);
    assert.equal(beforeAnnouncement.ceremony, null);
    assert.ok(beforeAnnouncement.candidates.every(candidate => candidate.stats === null && candidate.points === null));
    assert.equal(market.getArchive()[0].winner, null);
    assert.ok(beforeAnnouncement.resultAnnouncementAt > now);
    assert.equal(h.store.getFuture(placed.future.id).status, 'open', 'el estado individual no filtra el ganador');
    assert.equal(h.store.getFuture(placed.future.id).payoutApplied, false);
    assert.equal(h.profile.chips, 900, 'no se acredita el pago antes del anuncio');
    assert.equal(betting.getBetHistory(h.profile.id).entries.find(entry => entry.id === placed.future.id).status, 'open');
    assert.equal(logEvents.includes('football_ballon_dor_announcement_available'), false);

    now = beforeAnnouncement.resultAnnouncementAt;
    await market.sweep(now);
    const paid = h.store.getFuture(placed.future.id);
    assert.equal(paid.status, 'won');
    assert.equal(paid.payoutApplied, true);
    assert.equal(h.profile.chips, 900 + paid.payout);
    const announced = market.getMarket(SEASON);
    assert.equal(announced.result.winnerCandidateId, winnerCandidate.id);
    assert.equal(announced.ceremony.settlementComplete, true);
    assert.equal(announced.ceremony.paidVirtualChips, paid.payout);
    assert.equal(logEvents.filter(eventName => eventName === 'football_ballon_dor_announcement_available').length, 1);

    const chipsAfterAnnouncement = h.profile.chips;
    await market.sweep(now + 1000);
    assert.equal(h.profile.chips, chipsAfterAnnouncement, 'barridos/replays posteriores no vuelven a pagar');
    assert.equal(logEvents.filter(eventName => eventName === 'football_ballon_dor_announcement_available').length, 1);
  } finally {
    h.cleanup();
  }
});

test('el premio pendiente sobrevive al reset mensual y se liquida una sola vez tras reiniciar el proceso', async t => {
  const h = tempHarness({ chips: 1000, createProfiles: true });
  let restartedStore = null;
  let restartedProfiles = null;
  t.after(() => {
    try { restartedStore?.close(); } catch (_) {}
    try { restartedProfiles?.saveNow(); } catch (_) {}
    h.cleanup();
  });

  let now = openAt + 2000;
  await activateWithSnapshot(h, openAt);
  const championId = h.league.config[0].id;
  const championCandidate = h.league.ballonDor.candidates.find(candidate => candidate.clubId === championId);
  assert.ok(championCandidate);
  neutralizeProgression(h.profile);
  const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => now, log: () => {} });
  const placed = await betting.placeBallonDorBet({
    profile: h.profile, selection: championCandidate.id, stake: 100,
    idempotencyKey: 'bdo-key-after-reset-001', placedAt: now
  });
  assert.equal(placed.ok, true, placed.code);
  await h.store.transitionBallonDor(SEASON, 'locked', { at: now + 1 });

  const lastRegular = h.league.calendar.matches
    .filter(match => !match.desempate && match.jornada === 30)
    .sort((a, b) => a.scheduledKickoffAt - b.scheduledKickoffAt).at(-1);
  assert.ok(lastRegular);
  const lastKickoff = zonedTimeToMs({ year: 2099, month: 11, day: 30, hour: 21, minute: 30 }, CASINO_TIME_ZONE);
  lastRegular.scheduledKickoffAt = lastKickoff;
  const settledAt = lastKickoff + 90 * 60 * 1000;
  settleSeasonWithChampion(h.league, championId, settledAt);
  now = settledAt + 1000;
  const market = new BallonDorMarketService({
    store: h.store, betting, now: () => now, projectOdds: fakeProjectOdds, log: () => {}
  });
  const finalized = await market.sweep(now);
  assert.equal(finalized.settled, 1);
  const announcementAt = market.getMarket(SEASON).resultAnnouncementAt;
  assert.equal(announcementAt, zonedTimeToMs({ year: 2099, month: 12, day: 1, hour: 22 }, CASINO_TIME_ZONE),
    'si el último partido termina después de las 22:00, el anuncio va a las 22:00 locales del día siguiente');
  assert.equal(h.store.getFuture(placed.future.id).status, 'open');
  assert.equal(h.profile.chips, 900, 'la apuesta sigue abierta y sin premio hasta el anuncio');

  const resetAt = zonedTimeToMs({ year: 2099, month: 12, day: 1 }, CASINO_TIME_ZONE);
  assert.equal(footballSeasonResetGate(h.store, SEASON), null,
    'un boleto BDO no aplaza el reset del casino');
  assert.equal(footballSeasonResetGate(null, SEASON), null,
    'sin FootballStore, como cuando el flag está apagado, el reset conserva el comportamiento normal');
  now = resetAt;
  await market.beforeSeasonReset(SEASON, resetAt);
  assert.equal(h.profile.chips, 900, 'la conciliación pre-reset no acredita sobre el saldo antiguo');
  assert.equal(h.store.getFuture(placed.future.id).status, 'open');
  const reset = h.profiles.ensureSeason(new Date(resetAt));
  assert.equal(reset.type, 'closed');
  assert.equal(h.profiles.seasons.current, NEXT_SEASON);
  assert.equal(h.profile.chips, 1000, 'el reset mensual no espera a la ceremonia');

  await h.store.saveNow();
  h.profiles.saveNow();
  h.store.close();
  restartedStore = new FootballStore(h.footballPath);
  restartedProfiles = new ProfileStore(h.profilePath, { deferSeasonCheck: true });
  const restartedProfile = restartedProfiles.getProfile(h.profile.id);
  assert.equal(restartedProfiles.seasons.current, NEXT_SEASON);
  assert.equal(restartedProfile.chips, 1000);
  assert.equal(restartedStore.getFuture(placed.future.id).status, 'open', 'el boleto abierto se rehidrata desde JSON');

  now = announcementAt;
  const restartedBetting = createBettingService({
    store: restartedStore, profiles: restartedProfiles, now: () => now, log: () => {}
  });
  const restartedMarket = new BallonDorMarketService({
    store: restartedStore, betting: restartedBetting, now: () => now,
    projectOdds: fakeProjectOdds, log: () => {}
  });
  await restartedMarket.sweep(now);
  const paid = restartedStore.getFuture(placed.future.id);
  assert.equal(paid.status, 'won');
  assert.equal(paid.payoutApplied, true);
  assert.equal(restartedProfile.chips, 1000 + paid.payout,
    'el proceso nuevo acredita el premio sobre el saldo recién reiniciado');
  assert.equal(restartedMarket.getMarket(SEASON).result.winnerCandidateId, championCandidate.id);
  await restartedMarket.sweep(now + 1000);
  assert.equal(restartedProfile.chips, 1000 + paid.payout, 'la recuperación y los barridos repetidos no duplican el pago');
});

test('BDO y la preparación V2 respetan el orden de admisión de compromisos', async () => {
  for (const prepareFirst of [false, true]) {
    const h = tempHarness({ createProfiles: true });
    try {
      await activateWithSnapshot(h);
      const match = h.league.calendar.matches[0];
      const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => openAt + 1000 });
      const options = { store: h.store, match, asOf: openAt + 1000, keyFactory: () => 'cc'.repeat(32) };
      if (prepareFirst) {
        assert.equal((await prepareV2Match(options)).ok, true);
        const placed = await betting.placeBallonDorBet({ profile: h.profile, selection: h.league.ballonDor.candidates[0].id,
          stake: 100, idempotencyKey: 'v2-after-prepare' });
        assert.equal(placed.ok, true, placed.code);
        assert.ok(placed.future.simulationCommitments.some(item => item.matchId === match.id && item.id === commitmentId(match.simulation)));
        assert.equal(new FootballEngine(h.store).startMatch(match, match.scheduledKickoffAt), true);
      } else {
        let entered, release;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const insert = h.store.insertBallonDorFuture.bind(h.store);
        h.store.insertBallonDorFuture = async future => { entered(); await gate; return insert(future); };
        const placing = betting.placeBallonDorBet({ profile: h.profile, selection: h.league.ballonDor.candidates[0].id,
          stake: 100, idempotencyKey: 'v2-before-prepare' });
        await started;
        const preparing = prepareV2Match(options);
        release();
        assert.equal((await placing).ok, true);
        assert.equal((await preparing).reason, 'compromisos_anteriores');
        assert.equal(match.simulation, undefined);
      }
    } finally { h.cleanup(); }
  }
});

test('el gate del reset conserva la protección de otras apuestas de fútbol', () => {
  const store = {
    hasOpenBets: () => false,
    getParlays: () => [],
    getOpenFutures: () => [{ market: 'football_champion' }]
  };
  assert.deepEqual(footballSeasonResetGate(store, SEASON), {
    type: 'deferred', reason: 'apuestas_de_futbol_abiertas', requireSettlement: true
  });
});

test('el engine conserva el ganador de una tanda empatada del desempate', async () => {
  const h = tempHarness();
  try {
    await h.store.transitionBallonDor(SEASON, 'active', { at: openAt });
    h.league.ballonDor.status = 'locked';
    h.league.ballonDor.startedAt = openAt;
    h.league.ballonDor.lockedAt = openAt + 1;
    h.league.ballonDor.updatedAt = openAt + 1;
    settleThrough(h.league, 30, openAt + 25 * DAY);
    const teams = h.league.config.slice(0, 2);
    const created = await h.store.createBallonDorTiebreak(SEASON, {
      homeId: teams[0].id, awayId: teams[1].id, kickoffAt: openAt + 30 * DAY + 13 * 60 * 60 * 1000
    });
    assert.equal(created.ok, true);
    const engine = new FootballEngine(h.store);
    const settledAt = created.match.scheduledKickoffAt + 60 * 60 * 1000;
    const settled = engine._settleResult(created.match, {
      score: { home: 0, away: 0 },
      result: { home: 0, away: 0, winner: 'away' },
      timeline: [], lineups: {}
    }, settledAt);
    assert.equal(settled.ok, true);
    assert.equal(h.store.getMatch(created.match.id).result.winner, 'away');
  } finally {
    h.cleanup();
  }
});

test('apuesta BDO congela cuota servidor, aplica límites comunes e idempotencia por perfil/ciclo', async () => {
  const h = tempHarness({ chips: 1000, createProfiles: true });
  try {
    const at = openAt;
    const snapshot = await activateWithSnapshot(h, at);
    let now = at + 2000;
    const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => now, log: () => {} });
    neutralizeProgression(h.profile);
    const candidateId = h.league.ballonDor.candidates[0].id;
    const low = await betting.placeBallonDorBet({
      profile: h.profile, selection: candidateId, stake: 50,
      idempotencyKey: 'bdo-key-low-0001', placedAt: now
    });
    assert.equal(low.code, 'stake_bajo_minimo');
    h.profiles.seasons.current = '2099-10';
    const staleProfileSeason = await betting.placeBallonDorBet({
      profile: h.profile, selection: candidateId, stake: 100,
      idempotencyKey: 'bdo-key-stale-0001', placedAt: now
    });
    assert.equal(staleProfileSeason.code, 'temporada_no_actual');
    assert.equal(h.profile.chips, 1000);
    h.profiles.seasons.current = SEASON;
    const accepted = await betting.placeBallonDorBet({
      profile: h.profile, selection: candidateId, stake: 100,
      idempotencyKey: 'bdo-key-place-0001', placedAt: now,
      odds: 1.01, jornada: 999
    });
    assert.equal(accepted.ok, true, accepted.code);
    assert.equal(accepted.future.odds, snapshot.selections.find(row => row.candidateId === candidateId).odds,
      'el servidor ignora la cuota del cliente');
    assert.equal(accepted.future.placedAtJornada, 0, 'el servidor usa la jornada de su foto de cuotas');
    assert.equal(accepted.future.potentialPayout, Math.min(MAX_PAYOUT, Math.floor(100 * accepted.future.odds)));
    assert.equal(h.profile.chips, 900);

    const replay = await betting.placeBallonDorBet({
      profile: h.profile, selection: candidateId, stake: 100,
      idempotencyKey: 'bdo-key-place-0001', placedAt: now + 1
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(h.profile.chips, 900);
    const other = await betting.placeBallonDorBet({
      profile: h.profile, selection: h.league.ballonDor.candidates[1].id, stake: 100,
      idempotencyKey: 'bdo-key-place-0002', placedAt: now + 2
    });
    assert.equal(other.code, 'boleto_ya_colocado');
    const generic = await betting.placeFuture({
      profile: h.profile, seasonMonth: SEASON, market: BALLON_DOR_MARKET,
      selection: candidateId, odds: 51, stake: 100, placedAtJornada: 0
    });
    assert.equal(generic.code, 'usa_mercado_balon_de_oro');

    await betting.settleBallonDorBets(SEASON, candidateId, now + DAY);
    const paidChips = h.profile.chips;
    assert.equal(paidChips, 900 + accepted.future.potentialPayout);
    assert.equal(h.store.getFuture(accepted.future.id).status, 'won');
    assert.equal(h.store.getFuture(accepted.future.id).payoutApplied, true);
    await betting.settleBallonDorBets(SEASON, candidateId, now + DAY + 1);
    assert.equal(h.profile.chips, paidChips);
  } finally {
    h.cleanup();
  }
});

test('recuperación tras reinicio y dos liquidadores concurrentes acreditan una sola vez; cancelar devuelve el stake exacto', async () => {
  const h = tempHarness({ chips: 1000, createProfiles: true });
  try {
    const at = openAt;
    await activateWithSnapshot(h, at);
    let now = at + 2000;
    const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => now, log: () => {} });
    neutralizeProgression(h.profile);
    const candidateId = h.league.ballonDor.candidates[0].id;
    const placed = await betting.placeBallonDorBet({
      profile: h.profile, selection: candidateId, stake: 100,
      idempotencyKey: 'bdo-key-recovery-1', placedAt: now
    });
    assert.equal(placed.ok, true);
    assert.equal(h.profile.chips, 900);

    const terminal = h.store.settleFuture(placed.future.id, {
      status: 'won', payout: Math.floor(placed.future.stake * placed.future.odds), settledAt: now + DAY
    });
    assert.equal(terminal.ok, true);
    await h.store.saveNow();
    h.profiles.seasons.current = monthKey(new Date(), CASINO_TIME_ZONE);
    h.profiles.saveNow();

    // Rehidrata ambos stores como tras un reinicio; el terminal quedó guardado antes del crédito.
    const restartedStore = new FootballStore(h.footballPath);
    const restartedProfiles = new ProfileStore(h.profilePath);
    const restartedProfile = restartedProfiles.getProfile(h.profile.id);
    neutralizeProgression(restartedProfile);
    const restartedBetting = createBettingService({
      store: restartedStore, profiles: restartedProfiles, now: () => Date.now(), log: () => {}
    });
    const persistedFuture = restartedStore.getFuture(placed.future.id);
    const concurrent = await Promise.all([
      restartedBetting._applyBallonDorFuturePayout(persistedFuture),
      restartedBetting._applyBallonDorFuturePayout(persistedFuture)
    ]);
    assert.ok(concurrent.every(result => result.ok));
    const afterRecovery = restartedProfile.chips;
    assert.equal(afterRecovery, 900 + persistedFuture.payout);
    assert.equal((await restartedBetting.reconcileBallonDorPayouts(SEASON)).applied, 0);
    assert.equal(restartedProfile.chips, afterRecovery);
    const operationId = `football:bdo:${placed.future.id}`;
    assert.ok(restartedProfile.appliedChipOperations.includes(operationId));
    restartedProfiles.saveNow();
    const hydrated = new ProfileStore(h.profilePath);
    assert.ok(hydrated.getProfile(h.profile.id).appliedChipOperations.includes(operationId));

    const cancelHarness = tempHarness({ chips: 1000, createProfiles: true });
    try {
      await activateWithSnapshot(cancelHarness, at);
      const cancelBetting = createBettingService({
        store: cancelHarness.store, profiles: cancelHarness.profiles, now: () => now, log: () => {}
      });
      neutralizeProgression(cancelHarness.profile);
      const cancelCandidate = cancelHarness.league.ballonDor.candidates[0].id;
      const cancelPlaced = await cancelBetting.placeBallonDorBet({
        profile: cancelHarness.profile, selection: cancelCandidate, stake: 100,
        idempotencyKey: 'bdo-key-refund-001', placedAt: now
      });
      assert.equal(cancelPlaced.ok, true);
      cancelHarness.league.status = 'truncated';
      const market = new BallonDorMarketService({
        store: cancelHarness.store, betting: cancelBetting, now: () => now + DAY,
        timeZone: CASINO_TIME_ZONE, projectOdds: fakeProjectOdds, log: () => {}
      });
      await market.sweep(now + DAY);
      const refunded = cancelHarness.store.getFuture(cancelPlaced.future.id);
      assert.equal(refunded.status, 'void');
      assert.equal(refunded.payout, 100);
      assert.equal(refunded.payoutApplied, true);
      assert.equal(cancelHarness.profile.chips, 1000);
      await market.sweep(now + DAY + 1000);
      assert.equal(cancelHarness.profile.chips, 1000, 'el reembolso repetido no acredita dos veces');
    } finally {
      cancelHarness.cleanup();
    }
    restartedStore.close();
    restartedProfiles.saveNow();
    hydrated.saveNow();
  } finally {
    h.cleanup();
  }
});

test('el reset no espera al premio: el reembolso de corte se recupera después de reiniciar el saldo', async () => {
  const h = tempHarness({ chips: 1000, createProfiles: true });
  try {
    await activateWithSnapshot(h, openAt);
    let now = openAt + 2000;
    const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => now, log: () => {} });
    neutralizeProgression(h.profile);
    const placed = await betting.placeBallonDorBet({
      profile: h.profile, selection: h.league.ballonDor.candidates[0].id, stake: 100,
      idempotencyKey: 'bdo-key-reset-001', placedAt: now
    });
    assert.equal(placed.ok, true);

    const resetAt = zonedTimeToMs({ year: 2099, month: 12, day: 1 }, CASINO_TIME_ZONE);
    now = resetAt;
    h.league.status = 'truncated';
    const market = new BallonDorMarketService({
      store: h.store, betting, now: () => resetAt, timeZone: CASINO_TIME_ZONE,
      projectOdds: fakeProjectOdds, log: () => {}
    });
    await market.beforeSeasonReset(SEASON, resetAt);
    assert.equal(h.store.getFuture(placed.future.id).status, 'void');
    assert.equal(h.store.getFuture(placed.future.id).payoutApplied, false,
      'el recovery no acredita antes de que el reset borre el saldo');

    h.profiles.ensureSeason(new Date(resetAt));
    assert.equal(h.profiles.seasons.current, NEXT_SEASON);
    assert.equal(h.profile.chips, 1000);
    await market.sweep(resetAt + 1000);
    assert.equal(h.profile.chips, 1100, 'reembolso exacto aplicado sobre el saldo nuevo');
    assert.equal(h.store.getFuture(placed.future.id).payoutApplied, true);
  } finally {
    h.cleanup();
  }
});

test('el corte de J20 gana contra una solicitud que empezó antes pero confirma después', async () => {
  const h = tempHarness({ chips: 1000, createProfiles: true });
  try {
    const at = openAt;
    await activateWithSnapshot(h, at);
    let now = at + 2000;
    const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => now, log: () => {} });
    neutralizeProgression(h.profile);
    const originalInsert = h.store.insertBallonDorFuture.bind(h.store);
    h.store.insertBallonDorFuture = async future => {
      const inserted = await originalInsert(future);
      if (inserted.ok) await h.store.transitionBallonDor(SEASON, 'locked', { at: now + 1 });
      return inserted;
    };
    const result = await betting.placeBallonDorBet({
      profile: h.profile, selection: h.league.ballonDor.candidates[0].id, stake: 100,
      idempotencyKey: 'bdo-key-close-race', placedAt: now
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'mercado_cerrado');
    assert.equal(h.profile.chips, 1000);
    const future = h.store.getFutures({ seasonMonth: SEASON })[0];
    assert.equal(future.status, 'void');
    assert.equal(future.payout, 0);
    assert.equal(future.payoutApplied, true);
  } finally {
    h.cleanup();
  }
});

test('pre-reset espera el barrido en curso para no duplicar transiciones ni reembolsos', async () => {
  const h = tempHarness();
  try {
    let entered;
    let releaseGate;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { releaseGate = resolve; });
    let recoveries = 0;
    const betting = {
      async reconcileBallonDorPayouts() {
        recoveries++;
        if (recoveries === 1) {
          entered();
          await gate;
        }
        return { applied: 0 };
      }
    };
    const market = new BallonDorMarketService({ store: h.store, betting, projectOdds: fakeProjectOdds });
    const sweep = market.sweep(openAt + 1000);
    await started;
    const reset = market.beforeSeasonReset(SEASON, zonedTimeToMs({ year: 2099, month: 12, day: 1 }, CASINO_TIME_ZONE));
    assert.equal(market.resettingMonths.has(SEASON), true);
    releaseGate();
    await sweep;
    const result = await reset;
    assert.ok(result.ok !== false);
    assert.equal(h.store.getBallonDor(SEASON).status, 'cancelled');
    assert.equal(market.running, false);
    assert.equal(market.resettingMonths.size, 0);
  } finally {
    h.cleanup();
  }
});

test('la proyección del mercado anuncia el cierre a las 22:00 después del último partido del ciclo', () => {
  const h = tempHarness();
  try {
    const service = new BallonDorMarketService({ store: h.store, timeZone: CASINO_TIME_ZONE });
    const matches = h.store.getMatches(SEASON);
    const lastRegular = matches.filter(match => !match.desempate && Number(match.jornada) === 30)
      .sort((a, b) => a.scheduledKickoffAt - b.scheduledKickoffAt).at(-1);
    assert.ok(lastRegular, 'el calendario incluye los partidos de J30');
    const parts = calendarParts(new Date(lastRegular.scheduledKickoffAt), CASINO_TIME_ZONE);
    const localDate = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
    let expectedAt = zonedTimeToMs({ ...localDate, hour: 22, minute: 0 }, CASINO_TIME_ZONE);
    if (expectedAt <= lastRegular.scheduledKickoffAt) {
      expectedAt = zonedTimeToMs({ ...localDate, day: localDate.day + 1, hour: 22, minute: 0 }, CASINO_TIME_ZONE);
    }
    const market = service.getMarket(SEASON);
    assert.equal(market.finalization.scheduledAt, expectedAt);
    assert.equal(market.finalization.timeZone, CASINO_TIME_ZONE);
    assert.equal(market.finalization.hour, 22);
    assert.deepEqual(market.finalization.afterMatch, {
      id: lastRegular.id, jornada: 30, desempate: false, kickoffAt: lastRegular.scheduledKickoffAt
    });
    assert.equal(market.finalization.actualAt, null);
    assert.ok(!JSON.stringify(market.finalization).includes('profileId'));
  } finally {
    h.cleanup();
  }
});

test('el contrato público incluye probabilidades y cuotas, nunca boletos personales', () => {
  const h = tempHarness();
  try {
    h.league.ballonDor.oddsSnapshot = fixedSnapshot(h.league, 0, openAt + 1);
    const market = publicBallonDorMarket(h.league.ballonDor);
    assert.equal(market.market, BALLON_DOR_MARKET);
    assert.equal(market.candidates.length, 16);
    assert.ok(market.candidates.every(candidate => candidate.probability === 1 / 16 && candidate.odds <= 51));
    assert.ok(!JSON.stringify(market).includes('profileId'));
    assert.ok(!JSON.stringify(market).includes('deviceToken'));
    assert.ok(!JSON.stringify(market).includes('futureId'));
  } finally {
    h.cleanup();
  }
});
