'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FriendInviteService, cleanRoom } = require('../lib/friend-invites');
const { presenceFor } = require('../lib/friend-presence');

const ALICE = { id: 'alice-id', name: 'Alicia', avatar: 'fox', username: 'alice' };
const BOB = 'bob-id';
const ROOM = { code: 'ABC12', name: 'Mesa de Alicia', game: 'poker', players: 2, capacity: 6 };

function setup({ friends = [ALICE.id, BOB].sort().join('|'), now } = {}) {
  let clock = 1_000_000;
  let counter = 0;
  const service = new FriendInviteService({
    now: now ? () => now.value : () => clock,
    makeId: () => `invite-${++counter}`,
    isFriend: (a, b) => [a, b].sort().join('|') === friends
  });
  return { service, clock: () => clock, advance: ms => { clock += ms; }, set: value => { clock = value; } };
}

test('solo se invita a amistades y desde una mesa válida', () => {
  const { service } = setup();
  assert.equal(service.send({ from: ALICE, toId: 'stranger-id', room: ROOM }).code, 'not_friends');
  assert.equal(service.send({ from: ALICE, toId: ALICE.id, room: ROOM }).code, 'self_invite');
  assert.equal(service.send({ from: null, toId: BOB, room: ROOM }).code, 'account_required');
  assert.equal(service.send({ from: ALICE, toId: BOB, room: { code: 'MALA' } }).code, 'room_required');
  const sent = service.send({ from: ALICE, toId: BOB, room: ROOM });
  assert.equal(sent.ok, true);
  assert.equal(sent.code, 'invite_sent');
  assert.equal(sent.invite.room.code, 'ABC12');
  assert.equal(sent.invite.from.name, 'Alicia');
  assert.equal(service.pendingFor(BOB).length, 1);
  assert.deepEqual(service.pendingFor('otra-persona'), []);
});

test('reinvitar no duplica el aviso ni reinicia el enfriamiento', () => {
  const { service, advance } = setup();
  const first = service.send({ from: ALICE, toId: BOB, room: ROOM });
  advance(5_000);
  const again = service.send({ from: ALICE, toId: BOB, room: ROOM });
  assert.equal(again.code, 'already_invited');
  assert.equal(again.duplicate, true);
  assert.equal(again.invite.id, first.invite.id);
  assert.equal(service.pendingFor(BOB).length, 1);
  const originalExpiry = first.invite.expiresAt;
  advance(31_000);
  const renewed = service.send({ from: ALICE, toId: BOB, room: ROOM });
  assert.equal(renewed.code, 'invite_sent');
  assert.equal(renewed.duplicate, true);
  assert.equal(renewed.invite.id, first.invite.id);
  assert.ok(renewed.invite.expiresAt > originalExpiry, 'revalidar extiende la caducidad');
});

test('cada persona conserva un máximo de invitaciones y las viejas caducan', () => {
  let clock = 1_000_000;
  let id = 0;
  const service = new FriendInviteService({
    now: () => clock,
    makeId: () => `invite-${++id}`,
    isFriend: () => true,
    maxPerTarget: 2,
    cooldownMs: 0
  });
  for (const code of ['AAA11', 'BBB22', 'CCC33']) {
    assert.equal(service.send({ from: ALICE, toId: BOB, room: { ...ROOM, code } }).ok, true);
    clock += 1000;
  }
  assert.deepEqual(service.pendingFor(BOB).map(invite => invite.room.code), ['CCC33', 'BBB22']);
  clock += 11 * 60 * 1000;
  assert.equal(service.pendingFor(BOB).length, 0, 'expiran a los 10 minutos');
  const expired = service.send({ from: ALICE, toId: BOB, room: ROOM });
  clock += 11 * 60 * 1000;
  assert.equal(service.accept(BOB, expired.invite.id), null, 'una invitación vencida no se puede aceptar');
});

test('aceptar y descartar consumen solo la invitación indicada', () => {
  let clock = 1_000_000;
  let id = 0;
  const service = new FriendInviteService({
    now: () => clock, makeId: () => `invite-${++id}`, isFriend: () => true, cooldownMs: 0
  });
  const first = service.send({ from: ALICE, toId: BOB, room: ROOM }).invite;
  clock += 1000;
  const second = service.send({ from: ALICE, toId: BOB, room: { ...ROOM, code: 'XYZ99' } }).invite;
  assert.equal(service.dismiss(BOB, first.id), true);
  assert.deepEqual(service.pendingFor(BOB).map(invite => invite.id), [second.id]);
  assert.equal(service.dismiss(BOB, first.id), false);
  assert.equal(service.accept(BOB, second.id).room.code, 'XYZ99');
  assert.equal(service.pendingFor(BOB).length, 0);
});

test('al entrar a la mesa se consume la invitación de esa sala', () => {
  let clock = 1_000_000;
  let id = 0;
  const service = new FriendInviteService({
    now: () => clock, makeId: () => `invite-${++id}`, isFriend: () => true, cooldownMs: 0
  });
  const first = service.send({ from: ALICE, toId: BOB, room: ROOM }).invite;
  clock += 500;
  const second = service.send({ from: ALICE, toId: BOB, room: { ...ROOM, code: 'XYZ99' } }).invite;
  assert.equal(service.takeForRoom(BOB, 'xyz99').id, second.id, 'el código no distingue mayúsculas');
  assert.equal(service.takeForRoom(BOB, 'XYZ99'), null);
  assert.deepEqual(service.pendingFor(BOB).map(invite => invite.id), [first.id]);
});

test('cerrar la mesa descarta sus invitaciones y el envío tiene límite por remitente', () => {
  let clock = 1_000_000;
  let id = 0;
  const service = new FriendInviteService({
    now: () => clock, makeId: () => `invite-${++id}`, isFriend: () => true, senderLimit: 2, cooldownMs: 0
  });
  service.send({ from: ALICE, toId: BOB, room: ROOM });
  service.send({ from: ALICE, toId: BOB, room: { ...ROOM, code: 'XYZ99' } });
  assert.equal(service.dropRoom('ABC12'), 1);
  assert.deepEqual(service.pendingFor(BOB).map(invite => invite.room.code), ['XYZ99']);
  assert.equal(service.send({ from: ALICE, toId: BOB, room: { ...ROOM, code: 'NEW11' } }).code, 'rate_limited');
  clock += 61_000;
  assert.equal(service.send({ from: ALICE, toId: BOB, room: { ...ROOM, code: 'NEW11' } }).ok, true);
});

test('cleanRoom normaliza y acota el resumen que viaja en la invitación', () => {
  assert.equal(cleanRoom(null), null);
  assert.equal(cleanRoom({ code: 'MALA', name: 'Mesa' }), null, 'el código debe tener exactamente 5 caracteres');
  assert.equal(cleanRoom({ code: 'ABC12', name: 'Mesa' }).name, 'Mesa');
  const room = cleanRoom({ code: 'abc12', name: 'Mesa', game: 'poker', players: 99, capacity: 6 });
  assert.equal(room.code, 'ABC12', 'normaliza el código a mayúsculas');
  assert.equal(room.players, 6, 'nunca reporta más jugadores que asientos');
});

test('la presencia distingue mesa, tribuna, lobby y desconexión', () => {
  const online = new Set(['bob-id', 'carla-id', 'dani-id']);
  const tables = new Map([
    ['bob-id', { code: 'ABC12', name: 'Mesa de Bob', game: 'poker', players: 3, capacity: 6 }],
    ['carla-id', { code: 'XYZ99', name: 'Ruleta', game: 'roulette', players: 1, capacity: 6, spectating: true }]
  ]);
  const presence = presenceFor(['bob-id', 'carla-id', 'dani-id', 'eva-id', 'bob-id'], { online, tables });
  assert.deepEqual(Object.keys(presence), ['bob-id', 'carla-id', 'dani-id', 'eva-id']);
  assert.equal(presence['bob-id'].status, 'playing');
  assert.equal(presence['bob-id'].room.code, 'ABC12');
  assert.equal(presence['carla-id'].status, 'spectating');
  assert.equal(presence['carla-id'].room.game, 'roulette');
  assert.equal(presence['dani-id'].status, 'lobby');
  assert.equal(presence['dani-id'].room, null);
  assert.equal(presence['eva-id'].online, false);
  assert.equal(presence['eva-id'].status, 'offline');
});
