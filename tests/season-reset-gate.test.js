'use strict';

// Fase F (A12) — Gate del reset mensual del casino.
//
// Cuando cambia el mes, ensureSeason() cierra la temporada y reinicia TODOS los
// saldos a INITIAL_CHIPS. Con el Estadio activo eso podría pisar una temporada de
// fútbol con apuestas abiertas (el jugador perdería el saldo con el que apostó y
// luego cobraría sobre fichas ya reiniciadas). El gancho onBeforeSeasonReset permite
// aplazar el cierre mientras queden apuestas abiertas, con un tope de aplazamientos
// para que el casino nunca quede atascado para siempre.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { ProfileStore } = require('../lib/profile-store');
const { INITIAL_CHIPS } = require('../lib/profile-store-shared');
const { emptyClubTreasury } = require('../lib/profile-store-base');
const { FootballStore } = require('../lib/football-store');
const { footballSeasonResetGate } = require('../lib/football/reset-gate');

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProfileStore(path.join(dir, 'profiles.json'));
  // Un perfil con saldo distinto del inicial, para comprobar si se reinicia o no.
  const profile = store.getOrCreate({ token: 'tok-gate', name: 'Jugador', deviceToken: 'dev-gate' });
  profile.chips = 4321;
  store.saveNow();
  return { store, profile };
}

// Simula una temporada vieja (enero 2020) frente a "ahora" (mes actual) para forzar
// la detección de cambio de mes en ensureSeason.
function ageSeason(store) { store.seasons.current = '2020-01'; }

test('sin gate: el cambio de mes cierra y reinicia saldos (comportamiento histórico)', (t) => {
  const { store, profile } = makeStore(t);
  ageSeason(store);
  const result = store.ensureSeason(new Date());
  assert.equal(result.type, 'closed', 'cierra la temporada');
  assert.equal(profile.chips, INITIAL_CHIPS, 'saldo reiniciado');
  assert.notEqual(store.seasons.current, '2020-01', 'avanza el mes actual');
});

test('gate que aplaza: NO reinicia saldos ni avanza el mes', (t) => {
  const { store, profile } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = ({ fromMonth }) => ({ type: 'deferred', reason: 'apuestas_de_futbol_abiertas', fromMonth });
  const result = store.ensureSeason(new Date());
  assert.equal(result.type, 'deferred', 'devuelve deferred');
  assert.equal(result.deferrals, 1, 'primer aplazamiento');
  assert.equal(result.reason, 'apuestas_de_futbol_abiertas', 'motivo propagado');
  assert.equal(profile.chips, 4321, 'saldo INTACTO (no se reinició)');
  assert.equal(store.seasons.current, '2020-01', 'el mes NO avanzó');
});

test('gate que permite el cierre (null) cierra con normalidad', (t) => {
  const { store, profile } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = () => null;
  const result = store.ensureSeason(new Date());
  assert.equal(result.type, 'closed', 'cierra');
  assert.equal(profile.chips, INITIAL_CHIPS, 'saldo reiniciado');
});

test('tope de aplazamientos: al agotarse, fuerza el cierre', (t) => {
  const prev = process.env.SEASON_RESET_MAX_DEFERRALS;
  process.env.SEASON_RESET_MAX_DEFERRALS = '3';
  t.after(() => { if (prev == null) delete process.env.SEASON_RESET_MAX_DEFERRALS; else process.env.SEASON_RESET_MAX_DEFERRALS = prev; });

  const { store, profile } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = () => ({ type: 'deferred', reason: 'apuestas_de_futbol_abiertas' });

  // Aplazamientos 1 y 2 (menores que el tope 3): se aplaza.
  const r1 = store.ensureSeason(new Date());
  const r2 = store.ensureSeason(new Date());
  assert.equal(r1.type, 'deferred'); assert.equal(r1.deferrals, 1);
  assert.equal(r2.type, 'deferred'); assert.equal(r2.deferrals, 2);
  assert.equal(profile.chips, 4321, 'seguía intacto tras aplazar');
  assert.equal(store.seasons.current, '2020-01', 'seguía sin avanzar');

  // Tercer intento: deferrals llegaría a 3, que NO es < 3 → se fuerza el cierre.
  const r3 = store.ensureSeason(new Date());
  assert.equal(r3.type, 'closed', 'cierre forzado al agotar el tope');
  assert.equal(profile.chips, INITIAL_CHIPS, 'saldo reiniciado al forzar');
  assert.notEqual(store.seasons.current, '2020-01', 'el mes avanzó');
});

test('un pago sin confirmar impide el reset incluso si se agota el límite ordinario', (t) => {
  const previous = process.env.SEASON_RESET_MAX_DEFERRALS;
  process.env.SEASON_RESET_MAX_DEFERRALS = '2';
  t.after(() => { if (previous == null) delete process.env.SEASON_RESET_MAX_DEFERRALS; else process.env.SEASON_RESET_MAX_DEFERRALS = previous; });
  const { store: profiles, profile } = makeStore(t);
  ageSeason(profiles);
  const football = new FootballStore(path.join(path.dirname(profiles.filePath), 'football.json'));
  const match = football.generateSeason('2020-01').calendar.matches[0];
  football.insertBet({ id: 'pending-payout', idempotencyKey: 'pending-payout', profileId: profile.id,
    matchId: match.id, market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2,
    status: 'open', debited: true });
  football.settleBet('pending-payout', { status: 'won', payout: 200 });
  profiles.onBeforeSeasonReset = ({ fromMonth }) => footballSeasonResetGate(football, fromMonth);
  for (let i = 0; i < 4; i++) {
    const result = profiles.ensureSeason(new Date());
    assert.equal(result.type, 'deferred');
    assert.equal(result.reason, 'pagos_de_futbol_pendientes');
    assert.equal(profile.chips, 4321);
  }
  football.markBetPayoutApplied('pending-payout');
  assert.equal(profiles.ensureSeason(new Date()).type, 'closed');
  football.close();
});

test('una colocación o pago huérfanos no se pierden al faltar el partido', (t) => {
  const previous = process.env.SEASON_RESET_MAX_DEFERRALS;
  process.env.SEASON_RESET_MAX_DEFERRALS = '1';
  t.after(() => { if (previous == null) delete process.env.SEASON_RESET_MAX_DEFERRALS; else process.env.SEASON_RESET_MAX_DEFERRALS = previous; });
  const { store: profiles, profile } = makeStore(t);
  ageSeason(profiles);
  const football = new FootballStore(path.join(path.dirname(profiles.filePath), 'football-orphan.json'));
  football.insertBet({ id: 'missing-match', idempotencyKey: 'missing-match', profileId: profile.id,
    seasonMonth: '2020-01', matchId: 'missing', market: '1x2', selection: 'home', stake: 100, oddsAtPlacement: 2,
    status: 'pending', debited: true, escrowProtocol: 'durable-1' });
  profiles.onBeforeSeasonReset = ({ fromMonth }) => footballSeasonResetGate(football, fromMonth);
  for (let i = 0; i < 3; i++) assert.equal(profiles.ensureSeason(new Date()).type, 'deferred');
  assert.equal(profile.chips, 4321);
  football.voidBet('missing-match', { payout: 100 });
  assert.equal(profiles.ensureSeason(new Date()).reason, 'pagos_de_futbol_pendientes');
  football.markBetPayoutApplied('missing-match');
  assert.equal(profiles.ensureSeason(new Date()).type, 'closed');
  football.close();
});

test('el contador de aplazamientos se reinicia tras un cierre real', (t) => {
  const { store } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = () => ({ type: 'deferred' });
  store.ensureSeason(new Date());
  store.ensureSeason(new Date());
  assert.equal(store._seasonDeferrals, 2, 'dos aplazamientos acumulados');

  // Ahora el gate permite cerrar.
  store.onBeforeSeasonReset = () => null;
  const closed = store.ensureSeason(new Date());
  assert.equal(closed.type, 'closed', 'cerró');
  assert.equal(store._seasonDeferrals, 0, 'contador reiniciado');
});

test('el saldo de tesorería espera el cierre efectivo y se reinicia junto al perfil', (t) => {
  const { store, profile } = makeStore(t);
  profile.username = 'gamer';
  profile.chips = 4321;
  ageSeason(store);
  store.seasons.clubTreasury = emptyClubTreasury('2020-01');
  const deposit = store.applyClubTreasuryMovement({
    clubId: 'club-gate', type: 'deposit', amount: 500, actorId: profile.id,
    operationId: 'gate-deposit-idem-01', now: Date.parse('2020-01-15T12:00:00Z'),
    validate: () => ({ ok: true, club: { name: 'Gate Club' } })
  });
  assert.equal(deposit.ok, true);
  assert.equal(profile.chips, 3821);
  assert.equal(store.getClubTreasuryBalance('club-gate'), 500);

  store.onBeforeSeasonReset = () => ({ type: 'deferred', reason: 'apuestas_de_futbol_abiertas' });
  const deferred = store.ensureSeason(new Date());
  assert.equal(deferred.type, 'deferred');
  assert.equal(profile.chips, 3821, 'la cartera personal se conserva mientras el gate aplaza');
  assert.equal(store.getClubTreasuryBalance('club-gate'), 500, 'la tesorería tampoco se adelanta');
  assert.equal(store.seasons.clubTreasury.history.length, 0);

  store.onBeforeSeasonReset = () => null;
  const closed = store.ensureSeason(new Date());
  assert.equal(closed.type, 'closed');
  assert.equal(profile.chips, INITIAL_CHIPS);
  assert.equal(store.getClubTreasuryBalance('club-gate'), 0);
  assert.equal(store.seasons.clubTreasury.seasonKey, store.seasons.current);
  assert.equal(store.seasons.clubTreasury.history.at(-1).seasonKey, '2020-01');
  assert.deepEqual(store.seasons.clubTreasury.history.at(-1).top, [{ clubId: 'club-gate', balance: 500 }]);
});

test('el gate recibe fromMonth/toMonth para consultar la temporada correcta', (t) => {
  const { store } = makeStore(t);
  ageSeason(store);
  let seen = null;
  store.onBeforeSeasonReset = (arg) => { seen = arg; return { type: 'deferred' }; };
  store.ensureSeason(new Date());
  assert.ok(seen, 'se llamó al gate');
  assert.equal(seen.fromMonth, '2020-01', 'fromMonth es la temporada que iba a cerrar');
  assert.ok(seen.toMonth && seen.toMonth !== '2020-01', 'toMonth es el mes nuevo');
  assert.ok(seen.date instanceof Date, 'recibe la fecha');
});
