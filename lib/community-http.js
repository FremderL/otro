'use strict';

const crypto = require('node:crypto');
const { csrfToken } = require('./account-auth-http');
const { FixedWindowRateLimiter } = require('./rate-limit');
const Community = require('./community');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicAccount(profile) {
  if (!profile?.username) return null;
  return { id: profile.id, username: profile.username, name: profile.name || profile.username, avatar: profile.avatar || 'fox' };
}

function errorStatus(code) {
  if (code === 'account_required' || code === 'session_required') return 401;
  if (code === 'friend_not_found' || code === 'request_not_found' || code === 'club_not_found' || code === 'member_not_found') return 404;
  if (['owner_required', 'owner_protected', 'leader_required', 'not_club_member'].includes(code)) return 403;
  if (['already_friends', 'duplicate_request', 'incoming_request', 'friend_limit', 'request_limit', 'incoming_request_limit', 'name_taken', 'owner_limit', 'membership_limit', 'club_full', 'club_request_limit', 'already_member', 'request_pending', 'not_member', 'owner_must_disband', 'club_treasury_not_empty', 'treasury_insufficient', 'balance_insufficient', 'idempotency_conflict', 'treasury_limit', 'recipient_balance_limit', 'chips_in_play'].includes(code)) return 409;
  return 400;
}

function sendOutcome(res, outcome, details = {}) {
  if (!outcome.ok) return res.status(errorStatus(outcome.code)).json({ ok: false, code: outcome.code, error: outcome.error });
  return res.json({ ok: true, code: outcome.code, message: outcome.error, ...details });
}

function serializeMovement(movement, profiles) {
  const getProfile = id => typeof profiles.getProfile === 'function' ? profiles.getProfile(id) : profiles.profiles.get(id);
  return {
    id: movement.id,
    type: movement.type,
    amount: movement.amount,
    actor: publicAccount(getProfile(movement.actorId)),
    target: movement.targetId ? publicAccount(getProfile(movement.targetId)) : null,
    note: movement.note || '',
    time: movement.time
  };
}

function serializeClub(club, actorId, profiles) {
  const isMember = Community.memberIn(club, actorId);
  const isOwner = club.ownerId === String(actorId);
  const pending = club.requests.find(item => item.profileId === String(actorId));
  const owner = profiles.profiles.get(club.ownerId);
  const serialized = {
    id: club.id,
    name: club.name,
    description: club.description,
    emblem: club.emblem,
    emblemGlyph: Community.CLUB_EMBLEMS[club.emblem] || '♠',
    color: club.color,
    colorHex: Community.CLUB_COLORS[club.color] || Community.CLUB_COLORS.emerald,
    visibility: club.visibility,
    owner: publicAccount(owner),
    ownerId: club.ownerId,
    memberCount: club.members.length,
    memberLimit: Community.CLUB_MEMBER_LIMIT,
    membershipStatus: isMember ? 'member' : pending ? 'pending' : 'none',
    createdAt: club.createdAt
  };
  if (isMember) {
    serialized.members = club.members.map(member => ({
      ...publicAccount(profiles.profiles.get(member.profileId)),
      role: member.role,
      joinedAt: member.joinedAt
    })).filter(member => member.id);
  }
  if (isMember) {
    const treasury = typeof profiles.getClubTreasury === 'function'
      ? profiles.getClubTreasury(club.id)
      : { seasonKey: profiles.seasons?.current || null, balance: 0, movements: [] };
    serialized.treasury = {
      balance: treasury.balance,
      seasonKey: treasury.seasonKey,
      movements: treasury.movements.slice(-12).reverse().map(movement => serializeMovement(movement, profiles))
    };
  }
  if (isOwner) {
    serialized.requests = club.requests.map(request => ({
      id: request.id,
      profile: publicAccount(profiles.profiles.get(request.profileId)),
      createdAt: request.createdAt
    })).filter(request => request.profile);
  }
  return serialized;
}

function installCommunityRoutes(app, { config, resolveSession, getProfiles, getCommunityStore, canMoveChips = () => true }) {
  const searchLimiter = new FixedWindowRateLimiter({ limit: 40, windowMs: 60 * 1000 });
  const actionLimiter = new FixedWindowRateLimiter({ limit: 20, windowMs: 60 * 1000 });
  app.use('/api/social/v1', require('express').json({ limit: '12kb', strict: true }));
  app.use('/api/social/v1', (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });

  function secured(write, handler) {
    return asyncRoute(async (req, res, next) => {
      if (!config.accountSessionsEnabled) return res.status(404).json({ ok: false, code: 'social_unavailable', error: 'La comunidad requiere iniciar sesión segura.' });
      const auth = await resolveSession(req);
      const actor = auth?.profile;
      if (!actor?.username) return res.status(401).json({ ok: false, code: 'session_required', error: 'Inicia sesión para usar amigos y clubes.' });
      if (write) {
        if (req.get('origin') !== config.appOrigin) return res.status(403).json({ ok: false, code: 'origin_denied', error: 'Origen no permitido.' });
        if (!safeEqual(req.get('x-csrf-token'), csrfToken(auth.session.id, config.sessionPepper))) {
          return res.status(403).json({ ok: false, code: 'csrf_denied', error: 'Validación CSRF fallida. Actualiza la página e inténtalo de nuevo.' });
        }
        if (!actionLimiter.consume(`account:${actor.id}`).allowed) {
          return res.status(429).json({ ok: false, code: 'rate_limited', error: 'Has hecho demasiadas acciones. Espera un momento.' });
        }
      }
      const store = getCommunityStore();
      if (store?.ready) await store.ready;
      if (store?.refresh) await store.refresh();
      return handler(req, res, actor, store, next);
    });
  }

  async function clubFinancialMovement(req, res, actor, store, type) {
    const profiles = getProfiles();
    profiles.ensureSeason?.();
    const targetId = type === 'transfer' ? String(req.body?.targetProfileId || '').slice(0, 80) : null;
    const outcome = profiles.applyClubTreasuryMovement({
      clubId: req.params.clubId,
      type,
      amount: req.body?.amount,
      actorId: actor.id,
      targetId,
      operationId: req.get('idempotency-key'),
      note: req.body?.note,
      validate: () => {
        const club = store.getState().clubs.find(item => item.id === req.params.clubId);
        if (!club) return { ok: false, code: 'club_not_found', error: 'No se encontró ese club.' };
        if (!Community.memberIn(club, actor.id)) return { ok: false, code: 'not_club_member', error: 'Solo los miembros pueden usar la tesorería.' };
        if (!canMoveChips(actor.id)) return { ok: false, code: 'chips_in_play', error: 'Sal de la mesa antes de mover fichas del perfil.' };
        if (type === 'transfer') {
          if (club.ownerId !== actor.id) return { ok: false, code: 'leader_required', error: 'Solo la persona líder puede distribuir fondos.' };
          if (!club.members.some(member => member.profileId === targetId)) return { ok: false, code: 'recipient_unavailable', error: 'Elige a una persona que siga en el club.' };
          if (!canMoveChips(targetId)) return { ok: false, code: 'chips_in_play', error: 'La persona destinataria debe salir de su mesa antes de recibir fichas.' };
        }
        return { ok: true, club };
      }
    });
    if (!outcome.ok) return sendOutcome(res, outcome);
    if (typeof profiles.flushClubTreasury === 'function') await profiles.flushClubTreasury();
    const movement = serializeMovement(outcome.movement, profiles);
    return res.json({
      ok: true,
      code: outcome.code,
      duplicate: Boolean(outcome.duplicate),
      message: outcome.duplicate ? 'Este movimiento ya estaba registrado.' : type === 'deposit' ? 'Aportación registrada en la tesorería del club.' : 'Movimiento enviado a la persona integrante.',
      balance: outcome.balance,
      profileChips: outcome.actorChips,
      targetChips: outcome.targetChips,
      seasonKey: outcome.seasonKey,
      movement
    });
  }

  app.get('/api/social/v1/me', secured(false, (req, res, actor, store) => {
    const profiles = getProfiles();
    profiles.ensureSeason?.();
    const state = store.getState();
    const friendships = state.friendships.filter(item => item.profileA === actor.id || item.profileB === actor.id);
    const friendCards = friendships.map(item => publicAccount(profiles.profiles.get(item.profileA === actor.id ? item.profileB : item.profileA))).filter(Boolean);
    const incoming = state.friendRequests.filter(item => item.toId === actor.id).map(item => ({
      id: item.id, profile: publicAccount(profiles.profiles.get(item.fromId)), createdAt: item.createdAt
    })).filter(item => item.profile);
    const outgoing = state.friendRequests.filter(item => item.fromId === actor.id).map(item => ({
      id: item.id, profile: publicAccount(profiles.profiles.get(item.toId)), createdAt: item.createdAt
    })).filter(item => item.profile);
    const clubs = Community.membershipFor(state, actor.id);
    res.json({
      ok: true,
      profile: { ...publicAccount(actor), chips: Math.max(0, Math.floor(Number(actor.chips) || 0)) },
      seasonKey: profiles.seasons?.current || null,
      friends: friendCards,
      incomingRequests: incoming,
      outgoingRequests: outgoing,
      clubs: clubs.map(club => serializeClub(club, actor.id, profiles))
    });
  }));

  app.get('/api/social/v1/users', secured(false, (req, res, actor) => {
    const query = String(req.query.q || '').trim().replace(/^@/, '').toLocaleLowerCase('es-MX').slice(0, 40);
    if ([...query].length < 2) return res.json({ ok: true, users: [] });
    if (!searchLimiter.consume(`account:${actor.id}`).allowed) return res.status(429).json({ ok: false, code: 'search_limited', error: 'Demasiadas búsquedas. Espera un momento.' });
    const profiles = getProfiles();
    const state = getCommunityStore().getState();
    const users = [...profiles.profiles.values()]
      .filter(profile => profile.username && profile.id !== actor.id)
      .filter(profile => `${profile.username} ${profile.name || ''}`.toLocaleLowerCase('es-MX').includes(query))
      .slice(0, 20)
      .map(profile => ({
        ...publicAccount(profile),
        relationship: Community.friendshipExists(state, actor.id, profile.id) ? 'friend'
          : state.friendRequests.some(item => item.fromId === actor.id && item.toId === profile.id) ? 'outgoing'
            : state.friendRequests.some(item => item.fromId === profile.id && item.toId === actor.id) ? 'incoming' : 'none'
      }));
    res.json({ ok: true, users });
  }));

  app.post('/api/social/v1/friends/requests', secured(true, async (req, res, actor, store) => {
    const username = String(req.body?.username || '').trim().replace(/^@/, '').toLowerCase();
    const target = getProfiles().findByUsername(username);
    if (!target?.username) return res.status(404).json({ ok: false, code: 'user_not_found', error: 'No encontramos esa cuenta. Comprueba el nombre de usuario.' });
    const outcome = await store.transact(state => Community.requestFriend(state, actor, target));
    return sendOutcome(res, outcome, { requestId: outcome.request?.id });
  }));

  app.post('/api/social/v1/friends/requests/:requestId/accept', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.acceptFriendRequest(state, actor.id, req.params.requestId, getProfiles().profiles));
    return sendOutcome(res, outcome);
  }));

  app.delete('/api/social/v1/friends/requests/:requestId', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.removeFriendRequest(state, actor.id, req.params.requestId));
    return sendOutcome(res, outcome);
  }));

  app.delete('/api/social/v1/friends/:profileId', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.removeFriend(state, actor.id, req.params.profileId));
    return sendOutcome(res, outcome);
  }));

  app.get('/api/social/v1/clubs', secured(false, (req, res, actor, store) => {
    const query = String(req.query.q || '').trim().toLocaleLowerCase('es-MX').slice(0, 50);
    const profiles = getProfiles();
    profiles.ensureSeason?.();
    const clubs = store.getState().clubs
      .filter(club => club.visibility === 'public' || Community.memberIn(club, actor.id))
      .filter(club => !query || `${club.name} ${club.description}`.toLocaleLowerCase('es-MX').includes(query))
      .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name, 'es-MX'))
      .slice(0, 60)
      .map(club => serializeClub(club, actor.id, profiles));
    res.json({ ok: true, clubs });
  }));

  app.get('/api/social/v1/clubs/ranking', secured(false, (req, res, _actor, store) => {
    const profiles = getProfiles();
    profiles.ensureSeason?.();
    const ranking = store.getState().clubs
      .filter(club => club.visibility === 'public')
      .map(club => ({
        id: club.id,
        name: club.name,
        emblemGlyph: Community.CLUB_EMBLEMS[club.emblem] || '♠',
        color: club.color,
        colorHex: Community.CLUB_COLORS[club.color] || Community.CLUB_COLORS.emerald,
        owner: publicAccount(profiles.profiles.get(club.ownerId)),
        memberCount: club.members.length,
        balance: profiles.getClubTreasuryBalance?.(club.id) || 0
      }))
      .filter(club => club.balance > 0)
      .sort((a, b) => b.balance - a.balance || b.memberCount - a.memberCount || a.name.localeCompare(b.name, 'es-MX'))
      .slice(0, 20)
      .map((club, index) => ({ rank: index + 1, ...club }));
    res.json({ ok: true, seasonKey: profiles.seasons?.current || null, ranking });
  }));

  app.post('/api/social/v1/clubs', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.createClub(state, actor, {
      name: req.body?.name,
      description: req.body?.description,
      emblem: req.body?.emblem,
      color: req.body?.color,
      visibility: req.body?.visibility
    }));
    if (!outcome.ok) return sendOutcome(res, outcome);
    return res.status(201).json({ ok: true, message: outcome.error, club: serializeClub(outcome.club, actor.id, getProfiles()) });
  }));

  app.post('/api/social/v1/clubs/:clubId/deposits', secured(true, async (req, res, actor, store) =>
    clubFinancialMovement(req, res, actor, store, 'deposit')
  ));

  app.post('/api/social/v1/clubs/:clubId/transfers', secured(true, async (req, res, actor, store) =>
    clubFinancialMovement(req, res, actor, store, 'transfer')
  ));

  app.post('/api/social/v1/clubs/:clubId/join', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.joinClub(state, actor, req.params.clubId));
    if (!outcome.ok) return sendOutcome(res, outcome);
    return res.json({ ok: true, code: outcome.code, message: outcome.error, club: serializeClub(outcome.club, actor.id, getProfiles()) });
  }));

  app.delete('/api/social/v1/clubs/:clubId/membership', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.leaveClub(state, actor.id, req.params.clubId));
    return sendOutcome(res, outcome);
  }));

  app.post('/api/social/v1/clubs/:clubId/requests/:requestId/accept', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.respondToClubRequest(
      state, actor.id, req.params.clubId, req.params.requestId, true, getProfiles().profiles
    ));
    return sendOutcome(res, outcome);
  }));

  app.delete('/api/social/v1/clubs/:clubId/requests/:requestId', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.respondToClubRequest(
      state, actor.id, req.params.clubId, req.params.requestId, false, getProfiles().profiles
    ));
    return sendOutcome(res, outcome);
  }));

  app.delete('/api/social/v1/clubs/:clubId/members/:profileId', secured(true, async (req, res, actor, store) => {
    const outcome = await store.transact(state => Community.removeClubMember(state, actor.id, req.params.clubId, req.params.profileId));
    return sendOutcome(res, outcome);
  }));

  app.delete('/api/social/v1/clubs/:clubId', secured(true, async (req, res, actor, store) => {
    const profiles = getProfiles();
    const outcome = await store.transact(state => {
      const club = state.clubs.find(item => item.id === req.params.clubId);
      if (!club) return { ok: false, code: 'club_not_found', error: 'No se encontró ese club.' };
      if (club.ownerId !== actor.id) return { ok: false, code: 'owner_required', error: 'Solo quien creó el club puede cerrarlo.' };
      if (profiles.getClubTreasuryBalance?.(club.id) > 0) {
        return { ok: false, code: 'club_treasury_not_empty', error: 'Distribuye el saldo restante antes de cerrar el club.' };
      }
      return Community.disbandClub(state, actor.id, req.params.clubId);
    });
    return sendOutcome(res, outcome);
  }));
}

module.exports = { installCommunityRoutes, publicAccount, serializeClub, errorStatus };
