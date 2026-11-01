'use strict';

// Ficha de una persona de la misma mesa: ver su perfil público y, entre
// cuentas, mandar o aceptar la solicitud de amistad sin salir de la partida.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tableProfileCard, relationshipFor, mutualFriendCount, requestFriendshipFromTable, RELATIONSHIPS } = require('../lib/table-social');
const { emptyCommunityState } = require('../lib/community-store');
const Community = require('../lib/community');

function profile(id, username, extra = {}) {
  return {
    id,
    username,
    name: `Jugador ${id}`,
    avatar: 'fox',
    chips: 1200,
    stats: { roundsPlayed: 10, wins: 4, losses: 6, biggestWin: 300, totalWagered: 900, currentStreak: 1, bestStreak: 3 },
    gamesPlayed: ['poker'],
    achievements: ['first_win'],
    challenges: {},
    passport: { equipped: { frame: null, title: null, badge: null } },
    collection: { equipped: { avatar: null, frame: null, chips: null, felt: null, cards: null } },
    transactions: [{ id: 'secret' }],
    security: { passwordHash: 'no-debe-salir' },
    ...extra
  };
}

const ALICE = profile('alice-id', 'alice', { name: 'Alicia', avatar: 'fox' });
const BOB = profile('bob-id', 'bob', { name: 'Roberto', avatar: 'owl' });

test('la ficha pública nunca expone datos privados de la cuenta', () => {
  const card = tableProfileCard({ viewer: ALICE, target: BOB, seat: { index: 2, chips: 950 } });
  assert.equal(card.profile.id, 'bob-id');
  assert.equal(card.profile.name, 'Roberto');
  assert.equal(card.profile.username, 'bob');
  assert.equal(card.profile.seat.index, 2);
  assert.equal(card.profile.chips, 950, 'el saldo de la mesa manda sobre el del perfil');
  const serialized = JSON.stringify(card);
  for (const secret of ['no-debe-salir', 'passwordHash', 'transactions', 'security', 'dailyBonusDate', 'challenges']) {
    assert.ok(!serialized.includes(secret), `la ficha no debe incluir ${secret}`);
  }
  assert.ok(!serialized.includes('achievement"'), 'los logros viajan solo como resumen público');
});

test('la relación se calcula con el store de comunidad, no con el navegador', () => {
  const state = emptyCommunityState();
  const self = tableProfileCard({ viewer: ALICE, target: ALICE, state });
  assert.equal(self.profile.relationship, 'self');

  const stranger = tableProfileCard({ viewer: ALICE, target: BOB, state });
  assert.equal(stranger.profile.relationship, 'none');
  assert.equal(stranger.profile.requestId, null);

  const sent = Community.requestFriend(state, ALICE, BOB);
  assert.equal(sent.ok, true);
  const outgoing = tableProfileCard({ viewer: ALICE, target: BOB, state });
  assert.equal(outgoing.profile.relationship, 'outgoing');
  assert.equal(outgoing.profile.requestId, sent.request.id, 'el id permite retirar la solicitud desde la mesa');
  const incoming = tableProfileCard({ viewer: BOB, target: ALICE, state });
  assert.equal(incoming.profile.relationship, 'incoming');
  assert.equal(incoming.profile.requestId, sent.request.id, 'el id permite aceptarla desde la mesa');

  Community.acceptFriendRequest(state, BOB.id, sent.request.id, new Map([[ALICE.id, ALICE], [BOB.id, BOB]]));
  assert.equal(tableProfileCard({ viewer: ALICE, target: BOB, state }).profile.relationship, 'friend');
  assert.equal(relationshipFor(state, ALICE.id, BOB.id).relationship, 'friend');
  assert.ok(RELATIONSHIPS.includes('friend'));
});

test('bots, invitados y la propia ficha se distinguen sin pedir comunidad', () => {
  const bot = tableProfileCard({
    viewer: ALICE,
    target: profile('bot:1', null, { flags: { bot: true } }),
    bot: { difficultyLabel: 'Experto', styleLabel: 'Equilibrado', thinking: true }
  });
  assert.equal(bot.profile.relationship, 'bot');
  assert.equal(bot.profile.isBot, true);
  assert.equal(bot.profile.username, null);
  assert.equal(bot.profile.bot.thinking, true);
  assert.equal(bot.profile.bot.difficultyLabel, 'Experto');

  const guestTarget = profile('device-token', null, { name: 'Invitada' });
  const guest = tableProfileCard({ viewer: ALICE, target: guestTarget });
  assert.equal(guest.profile.relationship, 'guest');
  assert.equal(guest.profile.account, false);
  assert.equal(guest.profile.mutualFriends, 0);
});

test('sin sesión verificada no se revelan @usuario ni relaciones ajenas', () => {
  const state = emptyCommunityState();
  Community.requestFriend(state, ALICE, BOB);
  // Quien juega sin cuenta ve la ficha pública del asiento (como en la mesa),
  // pero ni el @usuario ni la relación de esa persona con nadie.
  const card = tableProfileCard({ viewer: null, target: BOB, state });
  assert.equal(card.viewerAccount, false);
  assert.equal(card.profile.username, null);
  assert.equal(card.profile.relationship, 'none');
  assert.equal(card.profile.mutualFriends, 0);
});

test('las amistades en común se cuentan sin exponer los perfiles', () => {
  const state = emptyCommunityState();
  const carla = profile('carla-id', 'carla');
  Community.requestFriend(state, ALICE, carla);
  const request = state.friendRequests[0];
  Community.requestFriend(state, BOB, carla);
  const request2 = state.friendRequests.find(item => item.fromId === BOB.id);
  const profiles = new Map([[ALICE.id, ALICE], [BOB.id, BOB], [carla.id, carla]]);
  Community.acceptFriendRequest(state, carla.id, request.id, profiles);
  Community.acceptFriendRequest(state, carla.id, request2.id, profiles);
  assert.equal(mutualFriendCount(state, ALICE.id, BOB.id), 1);
  const card = tableProfileCard({ viewer: ALICE, target: BOB, state });
  assert.equal(card.profile.mutualFriends, 1);
  const serialized = JSON.stringify(card);
  assert.ok(!serialized.includes('carla-id'), 'los ids de las amistades en común no viajan');
  assert.equal(mutualFriendCount(state, ALICE.id, ALICE.id), 0);
});

test('la ficha resume los logros y su total sin entregar la lista privada', () => {
  const unlocked = ['first_win', 'hot_streak', 'comeback', 'high_roller', 'explorer', 'rounds_10', 'rounds_100'];
  const card = tableProfileCard({ viewer: ALICE, target: profile('dana-id', 'dana', { achievements: unlocked }) });
  assert.equal(card.profile.achievementCount, unlocked.length);
  assert.ok(card.profile.achievementTotal >= unlocked.length);
  assert.equal(card.profile.achievements.length, 6, 'se muestran como máximo seis logros');
  assert.ok(!JSON.stringify(card).includes('unlocked\":false'), 'no se revelan los logros bloqueados');
  assert.equal(tableProfileCard({ viewer: ALICE, target: null }), null);
});

test('pedir amistad desde la mesa reutiliza la regla de comunidad y cierra las solicitudes cruzadas', () => {
  const state = emptyCommunityState();
  const profiles = new Map([[ALICE.id, ALICE], [BOB.id, BOB]]);
  const sent = requestFriendshipFromTable({ viewer: ALICE, target: BOB, state, profiles, now: 100 });
  assert.equal(sent.ok, true);
  assert.equal(sent.code, 'request_sent');
  assert.equal(sent.relationship, 'outgoing');
  assert.equal(sent.mutual, false);
  assert.equal(state.friendRequests.length, 1);

  // La otra persona abre la ficha de quien le escribió: no hay «Mandar
  // solicitud» sino «Aceptar»; si igual se pulsa, se acepta en el acto.
  const cross = requestFriendshipFromTable({ viewer: BOB, target: ALICE, state, profiles, now: 200 });
  assert.equal(cross.ok, true);
  assert.equal(cross.code, 'friend_added');
  assert.equal(cross.relationship, 'friend');
  assert.equal(cross.mutual, true);
  assert.equal(state.friendRequests.length, 0);
  assert.equal(Community.friendshipExists(state, ALICE.id, BOB.id), true);

  // Volver a pulsar (botón viejo o doble clic) no rompe ni duplica nada.
  const again = requestFriendshipFromTable({ viewer: ALICE, target: BOB, state, profiles });
  assert.equal(again.ok, true);
  assert.equal(again.code, 'already_friends');
  assert.equal(again.relationship, 'friend');
  assert.equal(state.friendships.length, 1);
});

test('un doble clic en «Mandar solicitud» no falla ni duplica el pendiente', () => {
  const state = emptyCommunityState();
  const profiles = new Map([[ALICE.id, ALICE], [BOB.id, BOB]]);
  const first = requestFriendshipFromTable({ viewer: ALICE, target: BOB, state, profiles, now: 10 });
  assert.equal(first.code, 'request_sent');
  // La segunda pulsación llega antes de que la ficha se repinte: el servidor
  // responde «ya la enviaste», pero eso es éxito para quien pulsó.
  const second = requestFriendshipFromTable({ viewer: ALICE, target: BOB, state, profiles, now: 20 });
  assert.equal(second.ok, true);
  assert.equal(second.code, 'duplicate_request');
  assert.equal(second.relationship, 'outgoing');
  assert.equal(state.friendRequests.length, 1, 'no se crea una segunda solicitud');
});

test('pedir amistad desde la mesa rechaza invitados, bots y cuentas sin sesión', () => {
  const state = emptyCommunityState();
  const profiles = new Map([[ALICE.id, ALICE], [BOB.id, BOB]]);
  assert.equal(requestFriendshipFromTable({ viewer: ALICE, state, profiles }).code, 'player_not_found');
  assert.equal(requestFriendshipFromTable({ viewer: null, target: BOB, state, profiles }).code, 'account_required');
  assert.equal(
    requestFriendshipFromTable({ viewer: ALICE, target: profile('device-1', null), state, profiles }).code,
    'account_target_required'
  );
  assert.equal(state.friendRequests.length, 0, 'nada se escribe cuando la solicitud no procede');
});
