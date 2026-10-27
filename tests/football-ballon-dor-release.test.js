'use strict';

// Fase 9 — dress rehearsal completa del ciclo de lanzamiento, incluyendo el
// corte de J20, cierre de 30 jornadas, anuncio, pago, reset y apertura siguiente.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { ACHIEVEMENTS, CHALLENGES } = require('../lib/progression');
const { createBettingService } = require('../lib/football/betting');
const { BallonDorMarketService, SIMULATIONS } = require('../lib/football/ballon-dor-market');
const { footballSeasonResetGate } = require('../lib/football/reset-gate');
const { CASINO_TIME_ZONE, calendarParts } = require('../lib/profile-store-shared');
const { zonedTimeToMs } = require('../lib/football/fixtures');

const SEASON = '2099-11';
const NEXT_SEASON = '2099-12';
const DAY = 24 * 60 * 60 * 1000;
const MATCH_RUNTIME_MS = 90 * 60 * 1000;
const OPEN_AT = zonedTimeToMs({ year: 2099, month: 11, day: 1 }, CASINO_TIME_ZONE);
const RESET_AT = zonedTimeToMs({ year: 2099, month: 12, day: 1 }, CASINO_TIME_ZONE);
const RELEASE_SWEEP_BUDGET_MS = 30_000;

function makePilotHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdo-release-pilot-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason(SEASON, { createdAt: OPEN_AT });
  // Evita 240 escrituras síncronas de un fixture de prueba; los escenarios de
  // persistencia/reinicio reales permanecen cubiertos por market/store tests.
  store.saveNow = () => {};

  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const pilotProfiles = league.ballonDor.candidates.map((candidate, index) => profiles.getOrCreate(
    `bdo-release-pilot-${String(index + 1).padStart(2, '0')}`,
    `Piloto ${String(index + 1).padStart(2, '0')}`
  ));
  profiles.seasons.current = SEASON;
  for (const profile of pilotProfiles) {
    profile.chips = 1000;
    profile.achievements = ACHIEVEMENTS.map(item => item.id);
    profile.challenges = Object.fromEntries(CHALLENGES.map(item => [
      item.id, { completedAt: 1, reward: item.reward }
    ]));
  }
  profiles.saveNow();

  let now = OPEN_AT + 1000;
  const logs = [];
  const log = (event, data) => logs.push({ event, data });
  const betting = createBettingService({ store, profiles, now: () => now, log });
  const market = new BallonDorMarketService({ store, betting, now: () => now, log });
  return {
    dir, store, league, profiles, pilotProfiles, profile: pilotProfiles[0], betting, market, logs,
    setNow(value) { now = value; },
    getNow() { return now; },
    cleanup() {
      try { store.close(); } catch (_) {}
      try { clearTimeout(profiles.saveTimer); profiles.saveNow(); } catch (_) {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function placePilotTicket(h, profile, candidateId, idempotencyKey) {
  const result = await h.betting.placeBallonDorBet({
    profile,
    selection: candidateId,
    stake: 100,
    idempotencyKey,
    placedAt: h.getNow()
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.future;
}

function deterministicResult(match, teamOrder) {
  const homeOrder = teamOrder.get(match.homeId);
  const awayOrder = teamOrder.get(match.awayId);
  // El orden del fixture es una clasificación estricta: garantiza un campeón
  // único sin recurrir a un partido de desempate en esta corrida de control.
  return homeOrder < awayOrder ? { home: 2, away: 0 } : { home: 0, away: 2 };
}

test('ciclo completo: 240 partidos, J20 bloqueado, anuncio 22:00, pago único y reset sin demora', async t => {
  const h = makePilotHarness();
  t.after(h.cleanup);
  const opened = await h.market.sweep(OPEN_AT + 1000);
  assert.equal(opened.opened, 1);
  assert.equal(h.store.getBallonDor(SEASON).status, 'active');
  assert.equal(h.store.getBallonDor(SEASON).oddsSnapshot.simulations, SIMULATIONS);
  const tickets = [];
  for (let index = 0; index < h.league.ballonDor.candidates.length; index++) {
    const candidate = h.league.ballonDor.candidates[index];
    tickets.push(await placePilotTicket(
      h,
      h.pilotProfiles[index],
      candidate.id,
      `release-pilot-ticket-${String(index + 1).padStart(3, '0')}`
    ));
  }
  assert.equal(tickets.length, 16, 'cada candidato tiene un boleto de un perfil distinto');
  assert.ok(h.pilotProfiles.every(profile => profile.chips === 900));

  const teamOrder = new Map(h.league.config.map((club, index) => [club.id, index]));
  let totalSettledMatches = 0;
  let lastRoundAt = OPEN_AT;
  for (let jornada = 1; jornada <= 30; jornada++) {
    const matches = h.store.getMatches(SEASON).filter(match => !match.desempate && match.jornada === jornada);
    assert.equal(matches.length, 8, `J${jornada} tiene ocho partidos`);
    let roundSettledAt = 0;
    for (const match of matches) {
      const settledAt = match.scheduledKickoffAt + MATCH_RUNTIME_MS;
      const result = h.store.settleMatch(match.id, deterministicResult(match, teamOrder), {
        seasonMonth: SEASON,
        now: settledAt
      });
      assert.equal(result.ok, true, `${match.id} se asienta: ${result.reason || ''}`);
      totalSettledMatches++;
      roundSettledAt = Math.max(roundSettledAt, settledAt);
    }
    assert.ok(roundSettledAt > lastRoundAt, `la hora de J${jornada} avanza`);
    lastRoundAt = roundSettledAt;
    h.setNow(roundSettledAt);
    await h.market.sweep(roundSettledAt);
    if (jornada < 20) assert.equal(h.store.getBallonDor(SEASON).status, 'active');
    if (jornada === 20) assert.equal(h.store.getBallonDor(SEASON).status, 'locked');
  }

  assert.equal(totalSettledMatches, 240);
  const matchResults = h.store.getMatches(SEASON).filter(match => !match.desempate);
  assert.equal(matchResults.filter(match => match.status === 'settled').length, 240);
  assert.equal(h.league.standings[0].teamId, h.league.config[0].id);
  assert.equal(h.store.getBallonDor(SEASON).status, 'settled');
  assert.equal(h.market.getMarket(SEASON).awaitingAnnouncement, true);
  assert.equal(h.market.getMarket(SEASON).result, null, 'no se filtra el ganador antes del anuncio');
  assert.ok(h.market.getMarket(SEASON).candidates.every(item => item.points === null));

  const announcementAt = h.market.getMarket(SEASON).resultAnnouncementAt;
  assert.ok(announcementAt > lastRoundAt, 'el anuncio espera a que termine el último partido');
  const announcementParts = calendarParts(new Date(announcementAt), CASINO_TIME_ZONE);
  assert.equal(announcementAt, zonedTimeToMs({
    year: Number(announcementParts.year), month: Number(announcementParts.month),
    day: Number(announcementParts.day), hour: 22, minute: 0
  }, CASINO_TIME_ZONE), 'el cierre público cae exactamente a las 22:00 de Ciudad de México');

  h.setNow(announcementAt);
  const announced = await h.market.sweep(announcementAt);
  assert.equal(announced.errors, 0);
  const settledTickets = tickets.map(ticket => h.store.getFuture(ticket.id));
  const winningTickets = settledTickets.filter(ticket => ticket.status === 'won');
  assert.equal(winningTickets.length, 1, 'la cobertura del piloto contiene exactamente un ganador');
  assert.ok(settledTickets.every(ticket => ticket.payoutApplied && ['won', 'lost'].includes(ticket.status)));
  const winningTicket = winningTickets[0];
  const winningProfile = h.profiles.getProfile(winningTicket.profileId);
  const exactPayout = Math.floor(winningTicket.stake * winningTicket.odds);
  assert.equal(winningTicket.payout, exactPayout);
  assert.equal(winningProfile.chips, 900 + exactPayout);
  assert.equal(winningProfile.appliedChipOperations.filter(id => id === `football:bdo:${winningTicket.id}`).length, 1);
  for (const ticket of settledTickets.filter(item => item.status === 'lost')) {
    const profile = h.profiles.getProfile(ticket.profileId);
    assert.equal(ticket.payout, 0);
    assert.equal(profile.chips, 900);
    assert.equal(profile.appliedChipOperations.filter(id => id === `football:bdo:${ticket.id}`).length, 1);
  }
  assert.equal(h.market.getMarket(SEASON).ceremony.predictionCount, 16);
  assert.equal(h.market.getMarket(SEASON).ceremony.winningPredictionCount, 1);
  assert.equal(h.market.getMarket(SEASON).ceremony.settlementComplete, true);

  const announcementsBeforeRetry = h.logs.filter(item => item.event === 'football_ballon_dor_announcement_available').length;
  await h.market.sweep(announcementAt + 1000);
  assert.equal(winningProfile.chips, 900 + exactPayout, 'un retry no acredita dos veces');
  assert.equal(h.logs.filter(item => item.event === 'football_ballon_dor_announcement_available').length, announcementsBeforeRetry);
  assert.equal(h.logs.filter(item => item.event === 'football_ballon_dor_bet_settled').length, 16);
  const sweepEvents = h.logs.filter(item => item.event === 'football_ballon_dor_sweep_completed');
  assert.equal(sweepEvents.length, h.market.healthSnapshot().sweep.count);
  assert.ok(sweepEvents.every(item => !Object.hasOwn(item.data, 'refunded')
    && !Object.hasOwn(item.data, 'paidVirtualChips')), 'los logs de sweep son operacionales, no financieros');
  assert.ok(h.logs.filter(item => item.event === 'football_ballon_dor_payouts_updated')
    .every(item => !Object.hasOwn(item.data, 'paidVirtualChips')), 'el log de pago no expone importes');

  const sweepHealth = h.market.healthSnapshot().sweep;
  assert.equal(sweepHealth.errors, 0);
  assert.ok(sweepHealth.p95DurationMs < RELEASE_SWEEP_BUDGET_MS,
    `p95 de sweep ${sweepHealth.p95DurationMs} ms excede el presupuesto ${RELEASE_SWEEP_BUDGET_MS} ms`);
  assert.ok(sweepHealth.maxDurationMs < 60_000,
    `algún sweep excedió el intervalo de 60 s: ${sweepHealth.maxDurationMs} ms`);
  t.diagnostic(`dress rehearsal ${SEASON}: ${totalSettledMatches} partidos; tickets=${tickets.length}; sweeps=${sweepHealth.count}; p95=${sweepHealth.p95DurationMs} ms; max=${sweepHealth.maxDurationMs} ms; pagos=1; errores=0`);

  // El reset del casino no se aplaza por un boleto BDO terminal. Se procesa el
  // hook pre-reset y se abre la siguiente edición enseguida.
  h.setNow(RESET_AT);
  h.profiles.onBeforeSeasonReset = ({ fromMonth }) => footballSeasonResetGate(h.store, fromMonth);
  assert.equal(footballSeasonResetGate(h.store, SEASON), null);
  await h.market.beforeSeasonReset(SEASON, RESET_AT);
  const reset = h.profiles.ensureSeason(new Date(RESET_AT));
  assert.equal(reset.type, 'closed');
  assert.equal(reset.month, SEASON);
  assert.equal(h.profiles.seasons.current, NEXT_SEASON);
  assert.ok(h.pilotProfiles.every(profile => profile.chips === 1000), 'el nuevo mes empieza con el saldo virtual inicial');

  const nextLeague = h.store.ensureSeason(new Date(RESET_AT));
  assert.equal(nextLeague.seasonMonth, NEXT_SEASON);
  assert.equal(nextLeague.ballonDor.status, 'scheduled');
  const nextOpen = await h.market.sweep(RESET_AT + 1000);
  assert.equal(nextOpen.opened, 1);
  assert.equal(h.store.getBallonDor(NEXT_SEASON).status, 'active');
  assert.ok(tickets.every(ticket => h.store.getFuture(ticket.id).payoutApplied));
  assert.equal(h.market.getMarket(SEASON).ceremony.settlementComplete, true);
});

test('ciclo de prueba truncado devuelve el stake exacto una sola vez y tampoco aplaza el reset', async t => {
  const h = makePilotHarness();
  t.after(h.cleanup);
  const candidate = h.league.ballonDor.candidates[0];
  assert.equal((await h.market.sweep(OPEN_AT + 1000)).opened, 1);
  const ticket = await placePilotTicket(h, h.profile, candidate.id, 'release-refund-ticket-001');
  assert.equal(h.profile.chips, 900);

  h.league.status = 'truncated';
  const cancelAt = OPEN_AT + DAY;
  h.setNow(cancelAt);
  const cancelled = await h.market.sweep(cancelAt);
  assert.equal(cancelled.cancelled, 1);
  assert.equal(cancelled.refunded, 100);
  assert.equal(h.store.getBallonDor(SEASON).status, 'cancelled');
  assert.equal(h.store.getFuture(ticket.id).status, 'void');
  assert.equal(h.store.getFuture(ticket.id).payout, 100);
  assert.equal(h.store.getFuture(ticket.id).payoutApplied, true);
  assert.equal(h.profile.chips, 1000);

  await h.market.sweep(cancelAt + 1000);
  assert.equal(h.profile.chips, 1000, 'el barrido repetido no duplica el reembolso');
  assert.equal(h.profile.appliedChipOperations.filter(id => id === `football:bdo:${ticket.id}`).length, 1);
  const refundEvents = h.logs.filter(item => item.event === 'football_ballon_dor_bet_refunded');
  assert.equal(refundEvents.length, 1, 'un reintento no emite un segundo evento de reembolso');
  assert.equal(refundEvents[0].data.payout, 100);
  assert.equal(footballSeasonResetGate(h.store, SEASON), null);

  h.profiles.onBeforeSeasonReset = ({ fromMonth }) => footballSeasonResetGate(h.store, fromMonth);
  const reset = h.profiles.ensureSeason(new Date(RESET_AT));
  assert.equal(reset.type, 'closed');
  assert.equal(h.profiles.seasons.current, NEXT_SEASON);
  const nextLeague = h.store.ensureSeason(new Date(RESET_AT));
  assert.equal(nextLeague.seasonMonth, NEXT_SEASON);
  assert.equal(h.store.getFuture(ticket.id).payoutApplied, true);
});
