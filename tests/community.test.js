'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../lib/community');
const { emptyCommunityState } = require('../lib/community-store');

const accounts = new Map([
  ['alice', { id: 'alice', username: 'alice', name: 'Alicia' }],
  ['bob', { id: 'bob', username: 'bob', name: 'Roberto' }],
  ['carla', { id: 'carla', username: 'carla', name: 'Carla' }],
  ['dana', { id: 'dana', username: 'dana', name: 'Dana' }]
]);

test('solicitudes de amistad evitan duplicados, resuelven solicitudes cruzadas y aceptan solo al destinatario', () => {
  const state = emptyCommunityState();
  const alice = accounts.get('alice');
  const bob = accounts.get('bob');
  const sent = Community.requestFriend(state, alice, bob, { now: 100 });
  assert.equal(sent.ok, true);
  assert.equal(sent.code, 'request_sent');
  assert.equal(Community.requestFriend(state, alice, bob).code, 'duplicate_request');
  assert.equal(Community.requestFriend(state, bob, alice).code, 'incoming_request');
  assert.equal(Community.requestFriend(state, alice, alice).code, 'self_request');
  assert.equal(Community.acceptFriendRequest(state, 'alice', sent.request.id, accounts).code, 'request_not_found');
  const accepted = Community.acceptFriendRequest(state, 'bob', sent.request.id, accounts, { now: 200 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.code, 'friend_added');
  assert.equal(accepted.friendship.createdAt, 200);
  assert.equal(Community.friendshipExists(state, 'alice', 'bob'), true);
  assert.equal(state.friendRequests.length, 0);
  assert.equal(Community.requestFriend(state, alice, bob).code, 'already_friends');
  assert.equal(Community.removeFriend(state, 'carla', 'alice').code, 'friend_not_found');
  assert.equal(Community.removeFriend(state, 'alice', 'bob').ok, true);
  assert.equal(Community.friendshipExists(state, 'alice', 'bob'), false);
});

test('límites de amistad y solicitudes pendientes se aplican a ambos perfiles', () => {
  const state = emptyCommunityState();
  state.friendRequests = Array.from({ length: Community.FRIEND_REQUEST_LIMIT }, (_, index) => ({
    id: `outgoing-${index}`, fromId: 'alice', toId: `target-${index}`
  }));
  assert.equal(Community.requestFriend(state, accounts.get('alice'), accounts.get('bob')).code, 'request_limit');
  state.friendRequests = Array.from({ length: Community.FRIEND_LIMIT }, (_, index) => ({
    id: `incoming-${index}`, fromId: `sender-${index}`, toId: 'bob'
  }));
  assert.equal(Community.requestFriend(state, accounts.get('alice'), accounts.get('bob')).code, 'incoming_request_limit');
  state.friendRequests = [];
  state.friendships = Array.from({ length: Community.FRIEND_LIMIT }, (_, index) => ({
    id: `friend-${index}`, profileA: 'alice', profileB: `profile-${index}`
  }));
  assert.equal(Community.requestFriend(state, accounts.get('alice'), accounts.get('bob')).code, 'friend_limit');
  state.friendships = [];
  state.friendships = Array.from({ length: Community.FRIEND_LIMIT }, (_, index) => ({
    id: `friend-${index}`, profileA: 'bob', profileB: `profile-${index}`
  }));
  assert.equal(Community.requestFriend(state, accounts.get('alice'), accounts.get('bob')).code, 'friend_limit');
});

test('club privado aprueba membresías y protege la gestión del liderazgo', () => {
  const state = emptyCommunityState();
  const owner = accounts.get('alice');
  const bob = accounts.get('bob');
  const created = Community.createClub(state, owner, {
    name: 'La Mesa Esmeralda', description: 'Amistades y partidas tranquilas', emblem: 'diamond', color: 'gold', visibility: 'private'
  }, { now: 100 });
  assert.equal(created.ok, true);
  assert.equal(created.club.members[0].role, 'owner');
  assert.equal(Community.createClub(state, owner, { name: 'Otro club' }).code, 'owner_limit');
  assert.equal(Community.createClub(state, bob, { name: 'la mesa esmeralda' }).code, 'name_taken');

  const join = Community.joinClub(state, bob, created.club.id, { now: 200 });
  assert.equal(join.code, 'join_requested');
  assert.equal(created.club.members.length, 1);
  assert.equal(Community.joinClub(state, bob, created.club.id).code, 'request_pending');
  assert.equal(Community.respondToClubRequest(state, 'bob', created.club.id, join.request.id, true, accounts).code, 'owner_required');
  const accepted = Community.respondToClubRequest(state, 'alice', created.club.id, join.request.id, true, accounts, { now: 300 });
  assert.equal(accepted.code, 'request_accepted');
  assert.equal(created.club.members.length, 2);
  assert.equal(Community.memberIn(created.club, 'bob'), true);
  assert.equal(Community.removeClubMember(state, 'bob', created.club.id, 'alice').code, 'owner_required');
  assert.equal(Community.removeClubMember(state, 'alice', created.club.id, 'alice').code, 'owner_protected');
  assert.equal(Community.leaveClub(state, 'alice', created.club.id).code, 'owner_must_disband');
  assert.equal(Community.removeClubMember(state, 'alice', created.club.id, 'bob').ok, true);
  assert.equal(Community.disbandClub(state, 'bob', created.club.id).code, 'owner_required');
  assert.equal(Community.disbandClub(state, 'alice', created.club.id).ok, true);
  assert.equal(state.clubs.length, 0);
});

test('club privado limita la cola de solicitudes pendientes', () => {
  const state = emptyCommunityState();
  const club = Community.createClub(state, accounts.get('alice'), { name: 'Club Reservado', visibility: 'private' }).club;
  club.requests = Array.from({ length: Community.CLUB_REQUEST_LIMIT }, (_, index) => ({ id: `request-${index}`, profileId: `profile-${index}` }));
  assert.equal(Community.joinClub(state, accounts.get('bob'), club.id).code, 'club_request_limit');
});

test('club público admite hasta tres membresías y limita su capacidad', () => {
  const state = emptyCommunityState();
  const club = Community.createClub(state, accounts.get('alice'), { name: 'Club del Río' }).club;
  assert.equal(Community.joinClub(state, accounts.get('bob'), club.id).code, 'joined');
  assert.equal(Community.joinClub(state, accounts.get('bob'), club.id).code, 'already_member');

  for (let index = 0; index < 3; index += 1) {
    const other = Community.createClub(state, { id: `owner-${index}`, username: `owner${index}` }, { name: `Club ${index + 1}` }).club;
    other.members.push({ profileId: 'carla', role: 'member', joinedAt: 1 });
  }
  const another = Community.createClub(state, accounts.get('dana'), { name: 'Club adicional' }).club;
  assert.equal(Community.joinClub(state, accounts.get('carla'), another.id).code, 'membership_limit');

  const full = Community.createClub(state, { id: 'owner-full', username: 'ownerfull' }, { name: 'Club Completo' }).club;
  full.members = Array.from({ length: Community.CLUB_MEMBER_LIMIT }, (_, index) => ({ profileId: `m-${index}`, role: index ? 'member' : 'owner', joinedAt: 1 }));
  assert.equal(Community.joinClub(state, accounts.get('dana'), full.id).code, 'club_full');
  assert.equal(Community.cleanText('  <Mesa>\u0000   Verde  ', 30), 'Mesa Verde');
});
