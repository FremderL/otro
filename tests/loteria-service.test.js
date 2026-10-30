'use strict';

// Pruebas del servicio de la Lotería mexicana: cobro, reembolso, reparto,
// idempotencia de pagos y recuperación tras un reinicio. Usan un almacén de
// perfiles en memoria con la misma interfaz que los backends reales
// (getProfile/touch/persistProfile) y un reloj inyectado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanProfile } = require('../lib/profile-store-shared');
const Game = require('../lib/loteria/game');
const { CARDS } = require('../lib/loteria/cards');
const { LoteriaService, operationId } = require('../lib/loteria/service');

class FakeProfiles {
  constructor(seed = {}) {
    this.profiles = new Map();
    this.saved = new Map();
    this.persistCalls = 0;
    this.failPersist = false;
    for (const [id, chips] of Object.entries(seed)) {
      this.profiles.set(id, cleanProfile({ id, name: `Jugador ${id}`, chips, createdAt: 1 }));
    }
  }
  getProfile(id) { return this.profiles.get(id) || null; }
  touch(profile) { profile.updatedAt = Date.now(); }
  async persistProfile(profile) {
    this.persistCalls++;
    if (this.failPersist) return false;
    this.saved.set(profile.id, JSON.parse(JSON.stringify(profile)));
    return true;
  }
  chips(id) { return this.profiles.get(id)?.chips ?? null; }
}

function identityRandom(n) { return n - 1; }

function makeStatePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loteria-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'loteria.json');
}

function makeService({ profiles, statePath, now, ...options }) {
  return new LoteriaService({
    profiles,
    statePath,
    now: () => now.value,
    random: identityRandom,
    registrationMs: 1000,
    callIntervalMs: 10,
    breakMs: 60_000,
    tickMs: 3_600_000,
    ...options
  });
}

test('las 54 cartas del catálogo son únicas y cubren el mazo completo', () => {
  assert.equal(CARDS.length, 54);
  assert.equal(new Set(CARDS.map(card => card.number)).size, 54);
  assert.equal(new Set(CARDS.map(card => card.name)).size, 54);
  for (let number = 1; number <= 54; number++) assert.ok(CARDS.some(card => card.number === number));
});

test('inscripción: cobra 50 fichas, entrega cartón privado y rechaza duplicados sin cobrar', async t => {
  const now = { value: 1_000_000 };
  const profiles = new FakeProfiles({ alice: 500, pobres: 10 });
  const service = makeService({ profiles, statePath: makeStatePath(t), now });
  await service.start();
  t.after(() => service.stop());

  const first = await service.join('alice', { name: 'Alice', avatar: 'fox' });
  assert.equal(first.ok, true);
  assert.equal(first.board.length, 16);
  assert.equal(new Set(first.board).size, 16);
  assert.equal(profiles.chips('alice'), 450);
  // El cobro se confirma en el perfil junto al marcador de la operación.
  const entryId = operationId('entry', service.state.game.id, 'alice', 1);
  assert.ok(profiles.getProfile('alice').appliedChipOperations.includes(entryId));
  assert.equal(profiles.saved.get('alice').chips, 450);

  const duplicate = await service.join('alice');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'already_joined');
  assert.equal(profiles.chips('alice'), 450);

  const poor = await service.join('pobres');
  assert.equal(poor.ok, false);
  assert.equal(poor.code, 'insufficient');
  assert.equal(profiles.chips('pobres'), 10);
  assert.equal(service.state.game.players.length, 1);

  const snapshot = service.snapshotFor('alice');
  assert.deepEqual(snapshot.game.board, first.board);
  assert.equal(snapshot.game.pot, 50);
  assert.ok(!JSON.stringify(snapshot).includes('profileId'), 'el estado público no filtra identificadores');
  assert.equal(service.snapshotFor('otro').game.board, null);
});

test('salir antes del cierre reembolsa una sola vez y permite reentrar con nuevo intento', async t => {
  const now = { value: 1_000_000 };
  const profiles = new FakeProfiles({ alice: 100 });
  const service = makeService({ profiles, statePath: makeStatePath(t), now });
  await service.start();
  t.after(() => service.stop());

  await service.join('alice');
  assert.equal(profiles.chips('alice'), 50);
  const left = await service.leave('alice');
  assert.equal(left.ok, true);
  assert.equal(left.refunded, true);
  assert.equal(profiles.chips('alice'), 100);
  assert.equal((await service.leave('alice')).ok, false);

  // Reentrar crea un intento nuevo: se vuelve a cobrar (no es gratis).
  const again = await service.join('alice');
  assert.equal(again.ok, true);
  assert.equal(profiles.chips('alice'), 50);
  assert.equal(service.state.game.players.length, 1);
  await service.leave('alice');
  assert.equal(profiles.chips('alice'), 100);
});

test('con menos de dos cartones la ronda se cancela y devuelve la entrada, conservando el acumulado', async t => {
  const now = { value: 1_000_000 };
  const profiles = new FakeProfiles({ alice: 200 });
  const statePath = makeStatePath(t);
  const service = makeService({ profiles, statePath, now });
  await service.start();
  t.after(() => service.stop());
  service.state.game.carry = 7;
  await service.join('alice');

  now.value += 1000;
  await service.tick();
  assert.equal(service.state.game.status, 'cancelled');
  assert.equal(profiles.chips('alice'), 200);
  const snapshot = service.snapshotFor('alice');
  assert.equal(snapshot.game.result.cancelled, true);
  assert.equal(snapshot.game.result.carry, 7);
  assert.equal(snapshot.game.carry, 7);

  // Repetir el avance no repite el reembolso.
  await service.tick();
  await service.tick();
  assert.equal(profiles.chips('alice'), 200);
});

test('el canto es automático: gana el cartón completo, se reparte en fichas enteras y el sobrante se acumula', async t => {
  const now = { value: 5_000_000 };
  const profiles = new FakeProfiles({ alice: 300, bob: 300 });
  const statePath = makeStatePath(t);
  const service = makeService({ profiles, statePath, now });
  await service.start();
  t.after(() => service.stop());

  await service.join('alice');
  await service.join('bob');
  // Bob recibe un cartón alto para que solo Alice complete en los primeros 16 cantos.
  service.state.game.players[1].board = Array.from({ length: 16 }, (_, index) => 17 + index);
  service.state.game.carry = 3;

  now.value += 1000; // cierra la inscripción y empieza el canto
  await service.tick();
  assert.equal(service.state.game.status, 'calling');

  for (let call = 1; call <= 15; call++) {
    now.value += 10;
    await service.tick();
    assert.equal(service.state.game.status, 'calling', `sigue cantando en la carta ${call}`);
    assert.equal(service.state.game.called.length, call);
  }
  now.value += 10;
  await service.tick();
  const game = service.state.game;
  assert.equal(game.status, 'settled');
  assert.equal(game.called.length, 16);
  assert.equal(game.result.pot, 103);
  assert.deepEqual(game.result.winners.map(winner => [winner.profileId, winner.amount]), [['alice', 103]]);
  assert.equal(game.result.carry, 0);
  // El premio son 103 fichas exactas. Además, el perfil puede recibir los
  // logros y retos normales del casino (se comprueba el movimiento exacto).
  const alice = profiles.getProfile('alice');
  assert.equal(alice.transactions.find(item => item.reason === 'Lotería mexicana: premio').amount, 103);
  assert.ok(profiles.chips('alice') >= 250 + 103);
  assert.equal(profiles.chips('bob'), 250);

  const snapshot = service.snapshotFor('alice');
  assert.equal(snapshot.game.result.won, true);
  assert.equal(snapshot.game.result.myPayout, 103);
  assert.deepEqual(snapshot.game.result.winners.map(winner => winner.name), ['Jugador alice']);
  assert.equal(service.snapshotFor('bob').game.result.won, false);
  // Estadísticas del juego nuevas, sin tocar el Pasaporte.
  const stats = profiles.getProfile('bob').gameStats.loteria;
  assert.deepEqual(stats, { rounds: 1, wins: 0, net: -50 });

  // Liquidar otra vez (reinicio, reloj repetido) no vuelve a pagar.
  const after = profiles.chips('alice');
  await service.tick();
  await service.tick();
  assert.equal(profiles.chips('alice'), after);
});

test('empate: reparto igual, sobrante al acumulado y todos cobran una sola vez', async t => {
  const now = { value: 7_000_000 };
  const profiles = new FakeProfiles({ a: 100, b: 100, c: 100 });
  const service = makeService({ profiles, statePath: makeStatePath(t), now });
  await service.start();
  t.after(() => service.stop());
  for (const id of ['a', 'b', 'c']) await service.join(id);
  service.state.game.players.forEach(player => { player.board = Array.from({ length: 16 }, (_, index) => index + 1); });
  service.state.game.carry = 1;

  now.value += 1000;
  await service.tick();
  now.value += 160;
  await service.tick();
  const game = service.state.game;
  assert.equal(game.status, 'settled');
  assert.equal(game.result.pot, 151);
  assert.equal(game.result.winners.length, 3);
  assert.deepEqual(game.result.winners.map(winner => winner.amount), [50, 50, 50]);
  assert.equal(game.result.carry, 1);
  for (const id of ['a', 'b', 'c']) assert.equal(profiles.chips(id), 50 + 50);

  // La siguiente ronda hereda el acumulado y abre tras el descanso.
  now.value += 60_000;
  await service.tick();
  assert.equal(service.state.game.status, 'registration');
  assert.equal(service.state.game.carry, 1);
  assert.notEqual(service.state.game.id, game.id);
});

test('recuperación tras reinicio: termina el cobro a medias y no duplica el pago ya confirmado', async t => {
  const now = { value: 9_000_000 };
  const statePath = makeStatePath(t);
  const profiles = new FakeProfiles({ alice: 500, bob: 500 });
  const first = makeService({ profiles, statePath, now });
  await first.start();
  await first.join('alice');
  await first.join('bob');
  const gameId = first.state.game.id;

  // Simula una caída justo después de anotar una entrada y antes de cobrarla:
  // el perfil pierde el marcador de la operación de Bob.
  const bob = profiles.getProfile('bob');
  bob.chips = 500;
  bob.appliedChipOperations = bob.appliedChipOperations.filter(id => id !== operationId('entry', gameId, 'bob', 1));
  assert.equal(bob.chips, 500);

  first.stop();
  const second = makeService({ profiles, statePath, now });
  await second.start();
  t.after(() => second.stop());
  assert.equal(profiles.chips('bob'), 450, 'la recuperación completa el cobro pendiente');
  assert.equal(profiles.chips('alice'), 450, 'no vuelve a cobrar lo ya confirmado');
  assert.equal(second.state.game.status, 'registration');
  assert.equal(second.state.game.players.length, 2);

  // Y si cae después de pagar pero antes de limpiar los pendientes, el premio
  // no se acredita dos veces.
  second.state.game.players.forEach(player => { player.board = Array.from({ length: 16 }, (_, index) => index + 1); });
  now.value += 1000;
  await second.tick();
  now.value += 160;
  await second.tick();
  assert.equal(profiles.chips('alice'), 450 + 50);
  second.stop();

  const third = makeService({ profiles, statePath, now });
  await third.start();
  t.after(() => third.stop());
  assert.equal(profiles.chips('alice'), 500);
  assert.equal(profiles.chips('bob'), 500);
});

test('si el guardado del perfil falla, el movimiento queda pendiente y se reintenta sin doble cobro', async t => {
  const now = { value: 11_000_000 };
  const profiles = new FakeProfiles({ alice: 100 });
  const service = makeService({ profiles, statePath: makeStatePath(t), now });
  await service.start();
  t.after(() => service.stop());

  profiles.failPersist = true;
  const joined = await service.join('alice');
  assert.equal(joined.ok, true, 'el cobro ya está aplicado en memoria');
  assert.equal(profiles.chips('alice'), 50);
  assert.equal(service.state.pending.length, 1);

  profiles.failPersist = false;
  await service.tick();
  assert.equal(service.state.pending.length, 0);
  assert.equal(profiles.saved.get('alice').chips, 50);
  assert.equal(profiles.chips('alice'), 50);
});

test('un perfil borrado no impide pagar al resto de la mesa', async t => {
  const now = { value: 13_000_000 };
  const profiles = new FakeProfiles({ alice: 100, fantasma: 100 });
  const service = makeService({ profiles, statePath: makeStatePath(t), now });
  await service.start();
  t.after(() => service.stop());
  await service.join('alice');
  await service.join('fantasma');
  service.state.game.players[0].board = Array.from({ length: 16 }, (_, index) => index + 1);
  service.state.game.players[1].board = Array.from({ length: 16 }, (_, index) => 20 + index);
  profiles.profiles.delete('fantasma');

  now.value += 1000;
  await service.tick();
  now.value += 160;
  await service.tick();
  assert.equal(service.state.game.status, 'settled');
  assert.equal(profiles.getProfile('alice').transactions.find(item => item.reason === 'Lotería mexicana: premio').amount, 100);
  assert.ok(profiles.chips('alice') >= 50 + 100);
  assert.equal(service.state.pending.length, 0);
});

test('el perfil se confirma aunque la ronda no dé logros y la siguiente ronda se anuncia', async t => {
  const now = { value: 17_000_000 };
  const profiles = new FakeProfiles({ a: 100, b: 100 });
  const announced = [];
  const service = makeService({
    profiles, statePath: makeStatePath(t), now,
    onStateChange: snapshot => announced.push(snapshot)
  });
  await service.start();
  t.after(() => service.stop());
  await service.join('a');
  await service.join('b');
  // Una persona gana y la otra pierde: la perdedora no recibe logros, pero su
  // perfil debe quedar guardado con la ronda jugada (no depender del guardado
  // diferido del almacén).
  service.state.game.players[0].board = Array.from({ length: 16 }, (_, index) => index + 1);
  service.state.game.players[1].board = Array.from({ length: 16 }, (_, index) => 20 + index);
  now.value += 1000;
  await service.tick();
  now.value += 160;
  await service.tick();
  const loser = profiles.getProfile('b');
  assert.equal(service.state.game.status, 'settled');
  assert.deepEqual(loser.gameStats.loteria, { rounds: 1, wins: 0, net: -50 });
  assert.equal(profiles.saved.get('b').gameStats.loteria.rounds, 1, 'el perfil quedó confirmado en disco');
  assert.equal(profiles.saved.get('b').chips, 50);

  // Tras el descanso se abre la siguiente ronda y se difunde el cambio aunque
  // todavía no se haya cantado ninguna carta.
  const previousId = service.state.game.id;
  announced.length = 0;
  now.value += 60_000;
  await service.tick();
  assert.equal(service.state.game.status, 'registration');
  assert.notEqual(service.state.game.id, previousId);
  assert.ok(announced.length >= 1, 'se avisó a la sala del cambio de ronda');
  assert.equal(announced.at(-1).game.status, 'registration');
});

test('el archivo de estado corrupto se descarta sin tumbar el servicio', async t => {
  const now = { value: 15_000_000 };
  const statePath = makeStatePath(t);
  fs.writeFileSync(statePath, '{ esto no es json');
  const profiles = new FakeProfiles({ alice: 100 });
  const service = makeService({ profiles, statePath, now });
  await service.start();
  t.after(() => service.stop());
  assert.equal(service.state.game.status, 'registration');
  assert.equal((await service.join('alice')).ok, true);
});

test('las reglas puras siguen rechazando límites fuera de rango', () => {
  assert.throws(() => Game.newGame({ id: 'x', openedAt: 1, registrationMs: -1 }), TypeError);
  assert.throws(() => Game.newGame({ id: 'x', openedAt: 1, callIntervalMs: 0 }), TypeError);
  assert.throws(() => Game.newGame({ id: 'x', openedAt: 1, random: () => 99 }), RangeError);
});
