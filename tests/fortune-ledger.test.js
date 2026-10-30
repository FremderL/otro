'use strict';

// Diario transaccional de la Rueda de la Fortuna: cobro, devolución, pago,
// idempotencia y recuperación tras un reinicio. Usa un almacén de perfiles en
// memoria con la misma interfaz que los backends reales.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanProfile, monthKey } = require('../lib/profile-store-shared');
const { FortuneLedger, operationId } = require('../lib/fortune/ledger');

// Reloj fijo realista: la devolución exige que la apuesta sea de la temporada
// en curso (si el cierre mensual ya reinició el saldo, no se devuelve).
const NOW = Date.parse('2026-10-15T18:00:00Z');
const SEASON = monthKey(new Date(NOW));

class FakeProfiles {
  constructor(seed = {}, season = SEASON) {
    this.profiles = new Map();
    this.saved = new Map();
    this.seasons = { current: season, history: [] };
    for (const [id, chips] of Object.entries(seed)) {
      this.profiles.set(id, cleanProfile({ id, name: `Jugador ${id}`, chips, createdAt: 1 }));
    }
  }
  getProfile(id) { return this.profiles.get(id) || null; }
  touch(profile) { profile.updatedAt = Date.now(); }
  async persistProfile(profile) {
    this.saved.set(profile.id, JSON.parse(JSON.stringify(profile)));
    return true;
  }
  chips(id) { return this.profiles.get(id)?.chips ?? null; }
}

function makeStatePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fortune-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'fortune-ledger.json');
}

function makeLedger(profiles, statePath, now = { value: NOW }) {
  return new FortuneLedger({ profiles, statePath, now: () => now.value });
}

test('cobrar apuesta: descuenta una vez, es idempotente y registra la intención en disco', async t => {
  const profiles = new FakeProfiles({ ana: 1000, pobre: 20 });
  const statePath = makeStatePath(t);
  const ledger = makeLedger(profiles, statePath);
  ledger.start();

  const placed = ledger.placeBet({ roundId: 'ronda-1', roomCode: 'ABC12', profileId: 'ana', name: 'Ana', amount: 100, choice: '5' });
  assert.equal(placed.ok, true);
  assert.equal(profiles.chips('ana'), 900);
  assert.equal(profiles.saved.get('ana').chips, 900, 'el cobro queda confirmado en el perfil');
  const betId = operationId('bet', 'ronda-1', 'ana');
  assert.ok(profiles.getProfile('ana').appliedChipOperations.includes(betId));
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).rounds['ronda-1'].bets.length, 1);

  // Otra apuesta en la misma ronda se rechaza y no cobra.
  const duplicate = ledger.placeBet({ roundId: 'ronda-1', profileId: 'ana', amount: 50, choice: '1' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate');
  assert.equal(profiles.chips('ana'), 900);

  // Saldo insuficiente: la ronda no se queda con una apuesta fantasma.
  const poor = ledger.placeBet({ roundId: 'ronda-1', profileId: 'pobre', amount: 50, choice: '1' });
  assert.equal(poor.ok, false);
  assert.equal(poor.code, 'insufficient');
  assert.equal(profiles.chips('pobre'), 20);
  assert.equal(ledger.rounds['ronda-1'].bets.length, 1);

  // Apostar en una ronda ya liquidada se rechaza.
  ledger.settleRound({ roundId: 'ronda-1', result: { value: 2 }, payouts: [{ profileId: 'ana', amount: 0, net: -100 }] });
  const late = ledger.placeBet({ roundId: 'ronda-1', profileId: 'ana', amount: 10, choice: '1' });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'closed');
});

test('liquidar: paga el premio exacto, registra la ronda y no repite el pago', async t => {
  const profiles = new FakeProfiles({ ana: 1000, beto: 1000 });
  const ledger = makeLedger(profiles, makeStatePath(t));
  ledger.start();
  ledger.placeBet({ roundId: 'r1', profileId: 'ana', name: 'Ana', amount: 100, choice: '5' });
  ledger.placeBet({ roundId: 'r1', profileId: 'beto', name: 'Beto', amount: 50, choice: '1' });
  assert.equal(profiles.chips('ana'), 900);
  assert.equal(profiles.chips('beto'), 950);

  // Ana acierta el sector 5 (pago total x6 = 600); Beto no acierta.
  const settled = ledger.settleRound({
    roundId: 'r1', result: { value: 5 },
    payouts: [{ profileId: 'ana', amount: 600, net: 500 }, { profileId: 'beto', amount: 0, net: -50 }]
  });
  assert.equal(settled.ok, true);
  const prize = profiles.getProfile('ana').transactions.find(item => item.reason === 'Rueda de la Fortuna: premio');
  assert.equal(prize.amount, 600, 'el premio son 600 fichas exactas');
  // El saldo puede crecer además por logros o retos normales del casino.
  assert.ok(profiles.chips('ana') >= 1500);
  assert.equal(profiles.chips('beto'), 950);
  assert.equal(profiles.getProfile('ana').gameStats.fortune.rounds, 1);
  assert.equal(profiles.getProfile('ana').gameStats.fortune.wins, 1);
  assert.equal(profiles.getProfile('beto').gameStats.fortune.net, -50);
  assert.equal(profiles.getProfile('ana').transactions.find(item => item.reason === 'Rueda de la Fortuna: premio').amount, 600);
  assert.equal(ledger.rounds.r1.status, 'paid');

  // Repetir la liquidación (reloj o reinicio) no vuelve a pagar.
  const chipsAfterPrize = profiles.chips('ana');
  ledger.settleRound({ roundId: 'r1', result: { value: 5 }, payouts: [{ profileId: 'ana', amount: 600, net: 500 }] });
  assert.equal(profiles.chips('ana'), chipsAfterPrize);
  assert.equal(profiles.getProfile('ana').transactions.filter(item => item.reason === 'Rueda de la Fortuna: premio').length, 1);

  // Y un diario nuevo releyendo el archivo tampoco duplica nada.
  const reopened = new FortuneLedger({ profiles, statePath: ledger.statePath, now: () => NOW + 60_000 });
  reopened.start();
  assert.equal(profiles.chips('ana'), chipsAfterPrize);
});

test('devolver antes del resultado: reembolsa una vez y no paga si la apuesta se anuló', async t => {
  const profiles = new FakeProfiles({ ana: 1000 });
  const ledger = makeLedger(profiles, makeStatePath(t));
  ledger.start();
  ledger.placeBet({ roundId: 'r2', profileId: 'ana', amount: 200, choice: '2' });
  assert.equal(profiles.chips('ana'), 800);

  const refund = ledger.refundBet({ roundId: 'r2', profileId: 'ana', reason: 'left_before_result' });
  assert.equal(refund.ok, true);
  assert.equal(refund.refunded, 200);
  assert.equal(profiles.chips('ana'), 1000);
  assert.equal(ledger.rounds.r2.status, 'refunded');

  const again = ledger.refundBet({ roundId: 'r2', profileId: 'ana' });
  assert.equal(again.ok, false);
  assert.equal(profiles.chips('ana'), 1000);

  // Cerrar la mesa devuelve solo lo que sigue abierto.
  ledger.placeBet({ roundId: 'r3', profileId: 'ana', amount: 100, choice: '1' });
  ledger.placeBet({ roundId: 'r3', profileId: 'ana2', amount: 100, choice: '1' });
  const closed = ledger.refundOpenRound({ roundId: 'r3', reason: 'room_closed' });
  // 'ana2' no tiene perfil: se anota la devolución sin poder acreditarla.
  assert.equal(closed.refunded, 100);
  assert.equal(profiles.chips('ana'), 1000);
  assert.equal(ledger.rounds.r3.status, 'refunded');
});

test('recuperación: devuelve lo que no tenía resultado y paga lo ya confirmado', async t => {
  const statePath = makeStatePath(t);
  const profiles = new FakeProfiles({ ana: 1000, beto: 1000 });
  const first = makeLedger(profiles, statePath);
  first.start();
  // Ronda A: apuesta sin resultado (el proceso "cae" aquí).
  first.placeBet({ roundId: 'abierta', profileId: 'ana', amount: 150, choice: '10' });
  // Ronda B: resultado confirmado pero pago no aplicado (se simula borrando el
  // recibo del perfil y el saldo, como si el guardado no hubiera llegado).
  first.placeBet({ roundId: 'resuelta', profileId: 'beto', amount: 100, choice: '20' });
  // Copia del perfil justo después de apostar: es lo que quedó en disco si el
  // proceso cayó después de confirmar el resultado y antes de guardar el pago.
  const betoAfterBet = JSON.parse(JSON.stringify(profiles.getProfile('beto')));
  first.settleRound({ roundId: 'resuelta', result: { value: 20 }, payouts: [{ profileId: 'beto', amount: 2100, net: 2000 }] });
  profiles.profiles.set('beto', cleanProfile(betoAfterBet));
  const beto = profiles.getProfile('beto');
  assert.equal(beto.chips, 900);
  // Y la ronda A queda en disco pero el archivo se reescribe como "abierta".
  const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  stored.rounds.resuelta.status = 'resolved';
  fs.writeFileSync(statePath, JSON.stringify(stored));

  const second = new FortuneLedger({ profiles, statePath, now: () => NOW + 60_000 });
  const summary = second.start();
  assert.equal(summary.refunded, 1, 'una apuesta abierta devuelta');
  assert.equal(profiles.chips('ana'), 1000, 'Ana recupera sus 150');
  assert.equal(second.rounds.abierta.status, 'refunded');
  // El premio confirmado se paga una sola vez (además, el perfil puede recibir
  // logros del casino por esa misma ronda, que también se habían perdido).
  const prizes = profiles.getProfile('beto').transactions.filter(item => item.reason === 'Rueda de la Fortuna: premio');
  assert.equal(prizes.length, 1);
  assert.equal(prizes[0].amount, 2100);
  assert.ok(profiles.chips('beto') >= 900 + 2100);
  assert.equal(second.rounds.resuelta.status, 'paid');

  // Un tercer arranque no vuelve a pagar ni a devolver.
  const chipsAna = profiles.chips('ana');
  const chipsBeto = profiles.chips('beto');
  const third = new FortuneLedger({ profiles, statePath, now: () => NOW + 120_000 });
  third.start();
  assert.equal(profiles.chips('ana'), chipsAna);
  assert.equal(profiles.chips('beto'), chipsBeto);
  assert.equal(profiles.getProfile('beto').transactions.filter(item => item.reason === 'Rueda de la Fortuna: premio').length, 1);
});

test('tras el cierre mensual no se devuelven fichas que el reinicio ya borró', async t => {
  const statePath = makeStatePath(t);
  const profiles = new FakeProfiles({ ana: 1000 }, '2026-09');
  const first = new FortuneLedger({ profiles, statePath, now: () => Date.parse('2026-09-30T12:00:00Z') });
  first.start();
  first.placeBet({ roundId: 'septiembre', profileId: 'ana', amount: 300, choice: '1' });
  assert.equal(profiles.chips('ana'), 700);

  // El casino cambia de mes (todos vuelven a 1000) y luego arranca el diario.
  profiles.seasons.current = '2026-10';
  profiles.getProfile('ana').chips = 1000;
  const second = new FortuneLedger({ profiles, statePath, now: () => Date.parse('2026-10-01T12:00:00Z') });
  second.start();
  assert.equal(profiles.chips('ana'), 1000, 'no se crean fichas de la nada');
  assert.equal(second.rounds.septiembre.status, 'refunded');
});

test('el archivo corrupto se aparta y el diario arranca vacío', async t => {
  const statePath = makeStatePath(t);
  fs.writeFileSync(statePath, '{ roto');
  const profiles = new FakeProfiles({ ana: 100 });
  const ledger = new FortuneLedger({ profiles, statePath, now: () => NOW });
  const summary = ledger.start();
  assert.deepEqual(summary, { refunded: 0, paid: 0, skipped: 0 });
  assert.deepEqual(ledger.rounds, {});
  assert.ok(fs.readdirSync(path.dirname(statePath)).some(name => name.includes('.corrupt-')), 'se conserva el archivo dañado');
  assert.equal(ledger.placeBet({ roundId: 'ok', profileId: 'ana', amount: 10, choice: '1' }).ok, true);
});

test('la retención conserva solo las rondas cerradas recientes', async t => {
  const now = { value: NOW };
  const profiles = new FakeProfiles({ ana: 100_000 });
  const ledger = makeLedger(profiles, makeStatePath(t), now);
  ledger.start();
  ledger.placeBet({ roundId: 'vieja', profileId: 'ana', amount: 10, choice: '1' });
  ledger.refundOpenRound({ roundId: 'vieja' });
  now.value += 25 * 60 * 60 * 1000; // 25 h después
  ledger.placeBet({ roundId: 'nueva', profileId: 'ana', amount: 10, choice: '1' });
  ledger.start(); // arranque: purga + recuperación
  assert.equal(ledger.rounds.vieja, undefined);
  assert.ok(ledger.rounds.nueva);
});

test('liquidar sin fila para una apuesta la devuelve en lugar de perderla', async t => {
  const profiles = new FakeProfiles({ ana: 1000, beto: 1000 });
  const ledger = makeLedger(profiles, makeStatePath(t));
  ledger.start();
  ledger.placeBet({ roundId: 'r5', profileId: 'ana', amount: 100, choice: '1' });
  ledger.placeBet({ roundId: 'r5', profileId: 'beto', amount: 100, choice: '1' });
  // Beto desapareció de la mesa antes de liquidar: el servidor solo manda a Ana.
  const settled = ledger.settleRound({ roundId: 'r5', result: { value: 1 }, payouts: [{ profileId: 'ana', amount: 200, net: 100 }] });
  assert.equal(settled.ok, true);
  assert.equal(profiles.chips('beto'), 1000, 'su apuesta se devuelve');
  const betoBet = ledger.rounds.r5.bets.find(bet => bet.profileId === 'beto');
  assert.equal(betoBet.refundReason, 'settled_without_player');
  assert.equal(ledger.rounds.r5.status, 'paid');
  // Y un reinicio no vuelve a devolverla ni a pagarla.
  const reopened = new FortuneLedger({ profiles, statePath: ledger.statePath, now: () => NOW + 60_000 });
  reopened.start();
  assert.equal(profiles.chips('beto'), 1000);
});

test('los topes del diario acotan apuestas y montos', async t => {
  const profiles = new FakeProfiles({});
  const ledger = makeLedger(profiles, makeStatePath(t));
  ledger.start();
  assert.equal(ledger.placeBet({ roundId: 'x', profileId: '', amount: 10 }).code, 'invalid');
  assert.equal(ledger.placeBet({ roundId: 'x', profileId: 'nadie', amount: 10 }).code, 'profile');
  assert.equal(ledger.ensureRound('id inválido'), null);
  assert.equal(ledger.settleRound({ roundId: 'no-existe', result: { value: 1 } }).ok, true, 'liquidar una ronda desconocida no rompe');
});
