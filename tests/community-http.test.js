'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { csrfToken } = require('../lib/account-auth-http');
const { createCommunityStore } = require('../lib/community-store');
const { ProfileStore } = require('../lib/profile-store');
const { installCommunityRoutes } = require('../lib/community-http');

function profilesFixture() {
  const profiles = new Map([
    ['alice-id', { id: 'alice-id', username: 'alice', name: 'Alicia', avatar: 'fox' }],
    ['bob-id', { id: 'bob-id', username: 'bob', name: 'Roberto', avatar: 'owl' }]
  ]);
  return {
    profiles,
    findByUsername(username) { return [...profiles.values()].find(profile => profile.username === username) || null; }
  };
}

test('API social requiere sesión, CSRF y origen; solicitudes y clubes persisten con control de roles', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pepper = Buffer.alloc(32, 43).toString('base64');
  const config = { accountSessionsEnabled: true, appOrigin: '', sessionPepper: pepper };
  const profiles = profilesFixture();
  const store = createCommunityStore(path.join(directory, 'community.json'), '');
  const app = express();
  installCommunityRoutes(app, {
    config,
    resolveSession: async req => {
      const profile = profiles.profiles.get(req.get('x-test-profile'));
      return profile ? { profile, session: { id: `session-${profile.id}` } } : null;
    },
    getProfiles: () => profiles,
    getCommunityStore: () => store
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.appOrigin = `http://127.0.0.1:${server.address().port}`;
  const base = config.appOrigin;
  async function call(route, { actor = 'alice-id', method = 'GET', body, origin = base, csrf = true } = {}) {
    const headers = {};
    if (actor) headers['x-test-profile'] = actor;
    if (origin) headers.origin = origin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf && actor && method !== 'GET') headers['x-csrf-token'] = csrfToken(`session-${actor}`, pepper);
    const response = await fetch(`${base}${route}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json() };
  }

  const anonymous = await call('/api/social/v1/me', { actor: null });
  assert.equal(anonymous.status, 401);
  const badOrigin = await call('/api/social/v1/friends/requests', { method: 'POST', body: { username: 'bob' }, origin: 'https://attacker.example' });
  assert.equal(badOrigin.status, 403);
  const badCsrf = await call('/api/social/v1/friends/requests', { method: 'POST', body: { username: 'bob' }, csrf: false });
  assert.equal(badCsrf.status, 403);

  const sent = await call('/api/social/v1/friends/requests', { method: 'POST', body: { username: '@bob' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.code, 'request_sent');
  const incoming = await call('/api/social/v1/me', { actor: 'bob-id' });
  assert.equal(incoming.body.incomingRequests.length, 1);
  const accepted = await call(`/api/social/v1/friends/requests/${sent.body.requestId}/accept`, { actor: 'bob-id', method: 'POST' });
  assert.equal(accepted.body.code, 'friend_added');
  const aliceState = await call('/api/social/v1/me');
  assert.equal(aliceState.body.friends[0].username, 'bob');

  const created = await call('/api/social/v1/clubs', {
    method: 'POST', body: { name: 'La Mesa del Río', visibility: 'private', emblem: 'moon', color: 'violet' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.club.visibility, 'private');
  const joined = await call(`/api/social/v1/clubs/${created.body.club.id}/join`, { actor: 'bob-id', method: 'POST' });
  assert.equal(joined.body.code, 'join_requested');
  const ownerView = await call('/api/social/v1/clubs');
  const club = ownerView.body.clubs.find(item => item.id === created.body.club.id);
  assert.equal(club.requests.length, 1);
  const approved = await call(`/api/social/v1/clubs/${club.id}/requests/${club.requests[0].id}/accept`, { method: 'POST' });
  assert.equal(approved.body.code, 'request_accepted');
  const memberView = await call('/api/social/v1/clubs', { actor: 'bob-id' });
  assert.equal(memberView.body.clubs.find(item => item.id === club.id).membershipStatus, 'member');

  const unauthorizedMemberRemoval = await call(`/api/social/v1/clubs/${club.id}/members/alice-id`, { actor: 'bob-id', method: 'DELETE' });
  assert.equal(unauthorizedMemberRemoval.status, 403);
  const restored = createCommunityStore(path.join(directory, 'community.json'), '');
  assert.equal(restored.getState().friendships.length, 1);
  assert.equal(restored.getState().clubs[0].members.length, 2);
  await Promise.all([store.close(), restored.close()]);
});

test('API de tesorerías aplica permisos, saldos, privacidad, idempotencia, cierre y mesas activas', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-treasury-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pepper = Buffer.alloc(32, 37).toString('base64');
  const config = { accountSessionsEnabled: true, appOrigin: '', sessionPepper: pepper };
  const profiles = new ProfileStore(path.join(directory, 'profiles.json'), { deferSeasonCheck: true });
  const alice = profiles.getOrCreate('alice-id', 'Alicia');
  Object.assign(alice, { username: 'alice', chips: 1000 }); profiles.touch(alice);
  const bob = profiles.getOrCreate('bob-id', 'Roberto');
  Object.assign(bob, { username: 'bob', chips: 1000 }); profiles.touch(bob);
  const carol = profiles.getOrCreate('carol-id', 'Carla');
  Object.assign(carol, { username: 'carol', chips: 1000 }); profiles.touch(carol);
  const community = createCommunityStore(path.join(directory, 'community.json'), '');
  t.after(() => community.close());
  const activeProfiles = new Set();
  const app = express();
  installCommunityRoutes(app, {
    config,
    resolveSession: async req => {
      const profile = profiles.getProfile(req.get('x-test-profile'));
      return profile ? { profile, session: { id: `session-${profile.id}` } } : null;
    },
    getProfiles: () => profiles,
    getCommunityStore: () => community,
    canMoveChips: profileId => !activeProfiles.has(profileId)
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => { clearTimeout(profiles.saveTimer); });
  config.appOrigin = `http://127.0.0.1:${server.address().port}`;
  const base = config.appOrigin;
  async function call(route, { actor = 'alice-id', method = 'GET', body, idempotency, origin = base } = {}) {
    const headers = {};
    if (actor) headers['x-test-profile'] = actor;
    if (origin) headers.origin = origin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (actor && method !== 'GET') headers['x-csrf-token'] = csrfToken(`session-${actor}`, pepper);
    if (idempotency) headers['idempotency-key'] = idempotency;
    const response = await fetch(`${base}${route}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json() };
  }

  const createdPrivate = await call('/api/social/v1/clubs', {
    method: 'POST', body: { name: 'Círculo Privado', visibility: 'private', emblem: 'moon', color: 'violet' }
  });
  assert.equal(createdPrivate.status, 201);
  const privateId = createdPrivate.body.club.id;
  const joinRequest = await call(`/api/social/v1/clubs/${privateId}/join`, { actor: bob.id, method: 'POST' });
  assert.equal(joinRequest.body.code, 'join_requested');
  const privateOwner = await call('/api/social/v1/clubs');
  const requestId = privateOwner.body.clubs[0].requests[0].id;
  assert.equal((await call(`/api/social/v1/clubs/${privateId}/requests/${requestId}/accept`, { method: 'POST' })).status, 200);

  const privateDeposit = await call(`/api/social/v1/clubs/${privateId}/deposits`, {
    method: 'POST', body: { amount: 300 }, idempotency: 'private-deposit-key-01'
  });
  assert.equal(privateDeposit.status, 200);
  assert.equal(privateDeposit.body.balance, 300);
  assert.equal(privateDeposit.body.profileChips, 700);
  const duplicate = await call(`/api/social/v1/clubs/${privateId}/deposits`, {
    method: 'POST', body: { amount: 300 }, idempotency: 'private-deposit-key-01'
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(profiles.getProfile(alice.id).chips, 700);
  const conflict = await call(`/api/social/v1/clubs/${privateId}/deposits`, {
    method: 'POST', body: { amount: 301 }, idempotency: 'private-deposit-key-01'
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');
  const missingKey = await call(`/api/social/v1/clubs/${privateId}/deposits`, { method: 'POST', body: { amount: 1 } });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.code, 'idempotency_required');
  const insufficientPersonal = await call(`/api/social/v1/clubs/${privateId}/deposits`, {
    method: 'POST', body: { amount: 701 }, idempotency: 'private-deposit-key-02'
  });
  assert.equal(insufficientPersonal.status, 409);
  assert.equal(insufficientPersonal.body.code, 'balance_insufficient');
  const memberFunds = await call(`/api/social/v1/clubs/${privateId}/transfers`, {
    actor: bob.id, method: 'POST', body: { amount: 1, targetProfileId: bob.id }, idempotency: 'member-transfer-key-01'
  });
  assert.equal(memberFunds.status, 403);
  assert.equal(memberFunds.body.code, 'leader_required');
  const notVisibleToCarol = await call('/api/social/v1/clubs', { actor: carol.id });
  assert.equal(notVisibleToCarol.body.clubs.some(item => item.id === privateId), false);
  assert.equal(notVisibleToCarol.body.clubs.length, 0);
  const privateRanking = await call('/api/social/v1/clubs/ranking', { actor: carol.id });
  assert.deepEqual(privateRanking.body.ranking, [], 'las tesorerías privadas no aparecen en el ranking');
  const privateMemberView = await call('/api/social/v1/clubs', { actor: bob.id });
  const privateMemberClub = privateMemberView.body.clubs.find(item => item.id === privateId);
  assert.equal(privateMemberClub.treasury.balance, 300);
  assert.equal(privateMemberClub.treasury.movements.length, 1);
  const privatePublicView = await call('/api/social/v1/clubs', { actor: carol.id });
  assert.equal(privatePublicView.body.clubs.some(item => 'treasury' in item), false);
  const memberDeposit = await call(`/api/social/v1/clubs/${privateId}/deposits`, {
    actor: bob.id, method: 'POST', body: { amount: 50 }, idempotency: 'member-deposit-key-01'
  });
  assert.equal(memberDeposit.status, 200, 'cualquier integrante puede aportar');
  assert.equal(memberDeposit.body.balance, 350);
  assert.equal(memberDeposit.body.profileChips, 950);
  const nonMemberPayout = await call(`/api/social/v1/clubs/${privateId}/transfers`, {
    method: 'POST', body: { amount: 1, targetProfileId: carol.id }, idempotency: 'nonmember-transfer-01'
  });
  assert.equal(nonMemberPayout.body.code, 'recipient_unavailable');

  const activeDepositKey = 'active-deposit-key-01';
  activeProfiles.add(alice.id);
  const activeDeposit = await call(`/api/social/v1/clubs/${privateId}/deposits`, {
    method: 'POST', body: { amount: 1 }, idempotency: activeDepositKey
  });
  assert.equal(activeDeposit.status, 409);
  assert.equal(activeDeposit.body.code, 'chips_in_play');
  activeProfiles.delete(alice.id);
  activeProfiles.add(bob.id);
  const activeRecipient = await call(`/api/social/v1/clubs/${privateId}/transfers`, {
    method: 'POST', body: { amount: 50, targetProfileId: bob.id }, idempotency: 'active-target-key-01'
  });
  assert.equal(activeRecipient.status, 409);
  assert.equal(activeRecipient.body.code, 'chips_in_play');
  activeProfiles.delete(bob.id);

  const tooMuchTreasury = await call(`/api/social/v1/clubs/${privateId}/transfers`, {
    method: 'POST', body: { amount: 351, targetProfileId: bob.id }, idempotency: 'treasury-short-key-01'
  });
  assert.equal(tooMuchTreasury.status, 409);
  assert.equal(tooMuchTreasury.body.code, 'treasury_insufficient');
  const transferred = await call(`/api/social/v1/clubs/${privateId}/transfers`, {
    method: 'POST', body: { amount: 100, targetProfileId: bob.id, note: 'Apoyo al equipo' }, idempotency: 'private-transfer-key-01'
  });
  assert.equal(transferred.status, 200);
  assert.equal(transferred.body.balance, 250);
  assert.equal(transferred.body.targetChips, 1050);
  const closeWithFunds = await call(`/api/social/v1/clubs/${privateId}`, { method: 'DELETE' });
  assert.equal(closeWithFunds.status, 409);
  assert.equal(closeWithFunds.body.code, 'club_treasury_not_empty');
  const transferRemainder = await call(`/api/social/v1/clubs/${privateId}/transfers`, {
    method: 'POST', body: { amount: 250, targetProfileId: bob.id }, idempotency: 'private-transfer-key-02'
  });
  assert.equal(transferRemainder.body.balance, 0);
  assert.equal((await call(`/api/social/v1/clubs/${privateId}`, { method: 'DELETE' })).status, 200);

  const createdPublic = await call('/api/social/v1/clubs', {
    actor: bob.id, method: 'POST', body: { name: 'Los Faros', visibility: 'public', emblem: 'compass', color: 'ocean' }
  });
  assert.equal(createdPublic.status, 201);
  const publicId = createdPublic.body.club.id;
  const publicDeposit = await call(`/api/social/v1/clubs/${publicId}/deposits`, {
    actor: bob.id, method: 'POST', body: { amount: 120 }, idempotency: 'public-deposit-key-01'
  });
  assert.equal(publicDeposit.status, 200);
  const publicList = await call('/api/social/v1/clubs', { actor: carol.id });
  const publicClubView = publicList.body.clubs.find(item => item.id === publicId);
  assert.equal(publicClubView.treasury, undefined, 'las visitas no reciben saldo ni historial detallado');
  const ranking = await call('/api/social/v1/clubs/ranking', { actor: carol.id });
  assert.deepEqual(ranking.body.ranking.map(item => ({ name: item.name, balance: item.balance })), [{ name: 'Los Faros', balance: 120 }]);
  assert.equal(ranking.body.ranking[0].rank, 1);

  await Promise.all([community.close()]);
});
