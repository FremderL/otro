'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LoteriaService } = require('../lib/loteria/service');
const { FileLoteriaStore, cleanLoteriaState } = require('../lib/loteria/store');
const Game = require('../lib/loteria/game');
const { cleanProfile } = require('../lib/profile-store-shared');

// ProfileStore falso con la misma semántica de durabilidad que el real:
// saveNow() toma una instantánea profunda; crash() restaura la última
// instantánea confirmada (o una anterior) tal como lo haría un reinicio.
class FakeProfiles {
  constructor() {
    this.profiles = new Map();
    this.snapshots = [];
    this.saveCount = 0;
  }

  add(id, chips = 1000) {
    const profile = cleanProfile({ id, name: id, chips });
    this.profiles.set(id, profile);
    return profile;
  }

  getProfile(id) { return this.profiles.get(String(id == null ? '' : id)) || null; }
  touch(profile) { profile.updatedAt = Date.now(); }
  async saveNow() {
    this.saveCount++;
    this.snapshots.push(structuredClone([...this.profiles.values()]));
    return true;
  }

  crash(toIndex = this.snapshots.length - 1) {
    const snapshot = this.snapshots[toIndex] || [];
    this.profiles = new Map(structuredClone(snapshot).map(profile => [profile.id, profile]));
  }

  snapshotIndexWith(chipsOf) {
    return this.snapshots.findIndex(list => list.every(profile => chipsOf[profile.id] === undefined || profile.chips === chipsOf[profile.id]));
  }
}

// Aleatoriedad controlada: 'identity' deja la baraja en orden 1..54 y el
// cartón en 1..16; 'zero' rota el cartón a 2..17 (completa una carta después).
function makeWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loteria-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'loteria.json');
  const profiles = new FakeProfiles();
  const world = {
    dir, file, profiles,
    now: 1_000_000,
    mode: 'identity',
    events: [],
    logs: []
  };
  world.random = n => (world.mode === 'identity' ? n - 1 : 0);
  world.makeService = (store = new FileLoteriaStore(file)) => new LoteriaService({
    store, profiles,
    now: () => world.now, random: world.random,
    registrationMs: 60_000, callIntervalMs: 2_000, intermissionMs: 5_000,
    onProfileEvents: (profile, events) => world.events.push({ id: profile.id, events }),
    log: (name, data) => world.logs.push({ name, data })
  });
  world.service = world.makeService();
  world.service.load();
  return world;
}

async function joinOk(world, service, id, requestId) {
  const result = await service.join(world.profiles.getProfile(id), requestId);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test('inscripción: cobra 50 una sola vez ante reintentos y no filtra cartones ajenos', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  await joinOk(world, world.service, 'ana', 'ana-req-0001');
  assert.equal(world.profiles.getProfile('ana').chips, 950);
  assert.equal(world.profiles.getProfile('ana').stats.totalWagered, 50);
  const retry = await world.service.join(world.profiles.getProfile('ana'), 'ana-req-0001');
  assert.equal(retry.code, 'already_joined');
  assert.equal(world.profiles.getProfile('ana').chips, 950);
  assert.equal(world.profiles.getProfile('ana').stats.totalWagered, 50);
  const duplicate = await world.service.join(world.profiles.getProfile('ana'), 'ana-req-0002');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate');
  const mine = world.service.snapshotFor('ana').game;
  assert.equal(new Set(mine.board).size, 16);
  assert.equal(mine.count, 1);
  assert.equal(mine.pot, 50);
  assert.equal(world.service.snapshotFor('otra-persona').game.board, null);
  assert.equal('deck' in mine, false);
});

test('inscripción sin saldo se rechaza sin tocar el perfil ni la partida', async t => {
  const world = makeWorld(t);
  world.profiles.add('pobre', 30);
  const result = await world.service.join(world.profiles.getProfile('pobre'), 'pobre-req-001');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'insufficient_funds');
  assert.equal(world.profiles.getProfile('pobre').chips, 30);
  assert.equal(world.service.snapshotFor('pobre').game.count, 0);
});

test('salir antes del cierre reembolsa una vez y esa solicitud no puede reutilizarse', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  await joinOk(world, world.service, 'ana', 'ana-req-0001');
  const left = await world.service.leave('ana');
  assert.equal(left.ok, true);
  assert.equal(world.profiles.getProfile('ana').chips, 1000);
  assert.equal(world.service.snapshotFor('ana').game.count, 0);
  assert.equal((await world.service.leave('ana')).ok, false);
  assert.equal(world.profiles.getProfile('ana').chips, 1000);
  const reused = await world.service.join(world.profiles.getProfile('ana'), 'ana-req-0001');
  assert.equal(reused.ok, false);
  assert.equal(reused.code, 'cancelled_request');
  await joinOk(world, world.service, 'ana', 'ana-req-0002');
  assert.equal(world.profiles.getProfile('ana').chips, 950);
});

test('con menos de dos cartones la partida se cancela, reembolsa y abre la siguiente', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  await joinOk(world, world.service, 'ana', 'ana-req-0001');
  const firstId = world.service.snapshotFor('ana').game.id;
  world.now += 60_000; // cierra la inscripción con una sola persona
  await world.service.tick();
  let view = world.service.snapshotFor('ana');
  assert.equal(view.game.status, 'cancelled');
  assert.equal(view.game.result.refunded, true);
  assert.equal(world.profiles.getProfile('ana').chips, 1000);
  assert.equal(world.service.hasOpenStake(), false);
  const refunds = world.events.flatMap(item => item.events).filter(event => event.type === 'loteria_refund');
  assert.equal(refunds.length, 1);
  world.now += 5_000; // termina el intermedio
  await world.service.tick();
  view = world.service.snapshotFor('ana');
  assert.equal(view.game.status, 'registration');
  assert.notEqual(view.game.id, firstId);
  assert.equal(view.game.count, 0);
});

test('liquidación: cartón completo gana el bote, el resto pierde su entrada y no se paga dos veces', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  world.profiles.add('beto');
  await joinOk(world, world.service, 'ana', 'ana-req-0001'); // cartón 1..16
  world.mode = 'zero'; // el cartón de beto será 2..17
  await joinOk(world, world.service, 'beto', 'beto-req-001');
  world.mode = 'identity';
  assert.equal(world.service.hasOpenStake(), true);
  const closesAt = world.service.snapshotFor('ana').game.closesAt;
  world.now = closesAt; // arranca el canto
  await world.service.tick();
  assert.equal(world.service.snapshotFor('ana').game.status, 'calling');
  // Desconectarse tras el cierre NO cancela el cartón.
  assert.equal((await world.service.handleDisconnect('beto')).ok, false);
  world.now = closesAt + 2_000 * 16; // salen 1..16: ana completa su cartón
  await world.service.tick();
  const view = world.service.snapshotFor('ana');
  assert.equal(view.game.status, 'settled');
  assert.equal(view.game.result.pot, 100);
  assert.equal(view.game.result.myPayout, 100);
  assert.equal(world.service.snapshotFor('beto').game.result.myPayout, 0);
  const outcomeTxs = world.profiles.getProfile('ana').transactions.filter(tx => tx.operationId);
  assert.equal(outcomeTxs.length, 1);
  assert.equal(outcomeTxs[0].amount, 50, 'el neto de la lotería es premio − entrada');
  assert.equal(world.profiles.getProfile('ana').chips, 1150);
  assert.equal(world.profiles.getProfile('beto').chips, 950);
  assert.equal(world.profiles.getProfile('ana').stats.wins, 1);
  assert.equal(world.profiles.getProfile('beto').stats.losses, 1);
  assert.ok(world.profiles.getProfile('ana').gamesPlayed.includes('loteria'));
  assert.equal(world.profiles.getProfile('ana').gameStats.loteria.net, 50);
  assert.equal(world.profiles.getProfile('beto').gameStats.loteria.net, -50);
  const prizes = world.events.flatMap(item => item.events).filter(event => event.type === 'loteria_prize');
  assert.deepEqual(prizes.map(event => event.amount), [100]);
  // Ticks repetidos (o un barrido duplicado) no vuelven a pagar.
  await world.service.tick();
  await world.service.tick();
  assert.equal(world.profiles.getProfile('ana').chips, 1150);
  assert.equal(world.service.hasOpenStake(), false);
});

test('empate: reparto en fichas enteras y el sobrante pasa a la siguiente partida', async t => {
  const world = makeWorld(t);
  for (const id of ['a', 'b', 'c']) world.profiles.add(id);
  await world.service.tick(); // abre la partida
  world.service.state.game.carry = 1; // sobrante de una partida anterior
  for (const id of ['a', 'b', 'c']) await joinOk(world, world.service, id, `${id}-req-00001`);
  const closesAt = world.service.snapshotFor('a').game.closesAt;
  world.now = closesAt + 2_000 * 54;
  await world.service.tick();
  const view = world.service.snapshotFor('a');
  assert.equal(view.game.result.pot, 151);
  assert.equal(view.game.result.winnerCount, 3);
  assert.equal(view.game.result.carry, 1);
  for (const id of ['a', 'b', 'c']) assert.equal(world.profiles.getProfile(id).chips, 1000);
  world.now += 5_000;
  await world.service.tick();
  assert.equal(world.service.snapshotFor('a').game.pot, 1, 'el sobrante abre el siguiente bote');
});

test('recuperación: un reinicio en inscripción conserva cartón y no cobra dos veces', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  await joinOk(world, world.service, 'ana', 'ana-req-0001');
  const board = world.service.snapshotFor('ana').game.board;
  const gameId = world.service.snapshotFor('ana').game.id;
  world.profiles.crash(); // perfiles = última instantánea confirmada (950)
  const revived = world.makeService();
  await revived.recover();
  const view = revived.snapshotFor('ana');
  assert.equal(view.game.id, gameId);
  assert.deepEqual(view.game.board, board);
  assert.equal(world.profiles.getProfile('ana').chips, 950);
});

test('recuperación: caída entre el diario y el cobro cobra la entrada al volver, una sola vez', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  await world.profiles.saveNow(); // instantánea 0: 1000 fichas, sin marca de cobro
  await joinOk(world, world.service, 'ana', 'ana-req-0001');
  // Se simula la caída justo tras guardar el diario (cartón sin confirmar)
  // y antes de que el cobro llegara a la instantánea de perfiles.
  const store = new FileLoteriaStore(world.file);
  const raw = structuredClone(store.getState());
  raw.game.players[0].entryApplied = false;
  await store.saveNow(raw);
  world.profiles.crash(0);
  assert.equal(world.profiles.getProfile('ana').chips, 1000);
  const revived = world.makeService(new FileLoteriaStore(world.file));
  await revived.recover();
  assert.equal(world.profiles.getProfile('ana').chips, 950);
  assert.equal(revived.state.game.players[0].entryApplied, true);
  await revived.tick();
  assert.equal(world.profiles.getProfile('ana').chips, 950);
});

test('recuperación: partida liquidada sin pagar paga al volver, una sola vez', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  world.profiles.add('beto');
  await joinOk(world, world.service, 'ana', 'ana-req-0001');
  world.mode = 'zero';
  await joinOk(world, world.service, 'beto', 'beto-req-001');
  world.mode = 'identity';
  await world.profiles.saveNow();
  const beforePayIndex = world.profiles.snapshots.length - 1;
  const closesAt = world.service.snapshotFor('ana').game.closesAt;
  world.now = closesAt + 2_000 * 20;
  await world.service.tick();
  assert.equal(world.profiles.getProfile('ana').chips, 1150);
  // Caída entre «resultado en el diario» y «saldos confirmados»: se rebobina
  // perfiles a antes del pago y el diario a «pagos sin aplicar».
  const store = new FileLoteriaStore(world.file);
  const raw = structuredClone(store.getState());
  raw.game.paymentsApplied = false;
  for (const player of raw.game.players) player.paymentApplied = false;
  await store.saveNow(raw);
  world.profiles.crash(beforePayIndex);
  assert.equal(world.profiles.getProfile('ana').chips, 950);
  const revived = world.makeService(new FileLoteriaStore(world.file));
  await revived.recover();
  assert.equal(world.profiles.getProfile('ana').chips, 1150);
  assert.equal(world.profiles.getProfile('beto').chips, 950);
  await revived.tick();
  assert.equal(world.profiles.getProfile('ana').chips, 1150);
});

test('recuperación: el canto reanuda por reloj tras un reinicio a mitad de partida', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  world.profiles.add('beto');
  await joinOk(world, world.service, 'ana', 'ana-req-0001');
  await joinOk(world, world.service, 'beto', 'beto-req-001');
  const closesAt = world.service.snapshotFor('ana').game.closesAt;
  world.now = closesAt + 2_000 * 5; // ya salieron 5 cartas
  await world.service.tick();
  assert.deepEqual(world.service.snapshotFor('ana').game.called, [1, 2, 3, 4, 5]);
  world.profiles.crash();
  const revived = world.makeService();
  revived.load();
  world.now = closesAt + 2_000 * 9;
  await revived.recover();
  assert.deepEqual(revived.snapshotFor('ana').game.called, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(revived.snapshotFor('ana').game.status, 'calling');
});

test('diario dañado: se descarta la partida y solo se reembolsa a quien sí pagó', async t => {
  const world = makeWorld(t);
  world.profiles.add('ana');
  world.profiles.add('beto');
  await joinOk(world, world.service, 'ana', 'ana-req-0001'); // ana sí pagó (950)
  const store = new FileLoteriaStore(world.file);
  const raw = structuredClone(store.getState());
  raw.game.deck = [1, 2, 3]; // baraja imposible: el limpiador debe descartarla
  raw.game.players.push({ profileId: 'beto', board: raw.game.players[0].board, requestId: 'beto-req-001' });
  fs.writeFileSync(world.file, JSON.stringify(raw));
  const cleaned = cleanLoteriaState(JSON.parse(fs.readFileSync(world.file, 'utf8')));
  assert.equal(cleaned.game, null);
  assert.equal(cleaned.pendingRefunds.length, 2);
  const revived = world.makeService(new FileLoteriaStore(world.file));
  await revived.recover();
  assert.equal(world.profiles.getProfile('ana').chips, 1000, 'ana recupera su entrada');
  assert.equal(world.profiles.getProfile('beto').chips, 1000, 'beto nunca pagó: no se crean fichas');
  assert.equal(revived.snapshotFor('ana').game.status, 'registration', 'se abre una partida nueva');
});

test('constantes del juego: la partida usa los tiempos acordados por defecto', async t => {
  assert.equal(Game.ENTRY_COST, 50);
  assert.equal(Game.REGISTRATION_MS, 60_000);
  assert.equal(Game.CALL_INTERVAL_MS, 2_000);
  const world = makeWorld(t);
  world.profiles.add('ana');
  await world.service.tick();
  const game = world.service.snapshotFor('ana').game;
  assert.equal(game.entryCost, 50);
  assert.equal(game.minPlayers, 2);
  assert.equal(game.maxPlayers, 100);
});
