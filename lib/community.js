'use strict';

const crypto = require('node:crypto');

const FRIEND_LIMIT = 100;
const FRIEND_REQUEST_LIMIT = 25;
const CLUB_MEMBER_LIMIT = 30;
const CLUB_REQUEST_LIMIT = 100;
const CLUBS_PER_MEMBER_LIMIT = 3;
const CLUB_EMBLEMS = Object.freeze({ spade: '♠', diamond: '♦', dice: '⚄', moon: '☾', crown: '♛', compass: '✥' });
const CLUB_COLORS = Object.freeze({ emerald: '#67d9a5', gold: '#dfbc70', violet: '#b39af2', ocean: '#77c9df' });

function result(ok, code, error, data = {}) { return { ok, code, error, ...data }; }
function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function profileExists(profiles, id) { return Boolean(profiles?.get(String(id))?.username); }
function pairKey(a, b) { return [String(a), String(b)].sort().join('\u0000'); }
function friendshipExists(state, a, b) {
  const wanted = pairKey(a, b);
  return state.friendships.some(item => pairKey(item.profileA, item.profileB) === wanted);
}
function addFriendship(state, a, b, now = Date.now()) {
  if (friendshipExists(state, a, b)) return null;
  const [profileA, profileB] = [String(a), String(b)].sort();
  const friendship = { id: crypto.randomUUID(), profileA, profileB, createdAt: now };
  state.friendships.push(friendship);
  return friendship;
}
function friendshipCount(state, profileId) {
  return state.friendships.reduce((count, item) => count + (item.profileA === String(profileId) || item.profileB === String(profileId) ? 1 : 0), 0);
}
function hasPendingRequest(state, fromId, toId) {
  return state.friendRequests.find(item => item.fromId === String(fromId) && item.toId === String(toId));
}
function pendingFriendRequestCount(state, profileId, field = 'fromId') {
  return state.friendRequests.reduce((count, item) => count + (item[field] === String(profileId) ? 1 : 0), 0);
}

function requestFriend(state, requester, target, { now = Date.now() } = {}) {
  if (!requester?.id || !requester.username || !target?.id || !target.username) return result(false, 'account_required', 'Se necesitan cuentas activas para agregar amistades.');
  if (requester.id === target.id) return result(false, 'self_request', 'No puedes enviarte una solicitud a ti mismo.');
  if (friendshipExists(state, requester.id, target.id)) return result(false, 'already_friends', 'Ya son amigos.');
  if (hasPendingRequest(state, requester.id, target.id)) return result(false, 'duplicate_request', 'Ya enviaste una solicitud a esa persona.');
  if (hasPendingRequest(state, target.id, requester.id)) return result(false, 'incoming_request', 'Esta persona ya te envió una solicitud; acéptala desde Recibidas.');
  if (pendingFriendRequestCount(state, requester.id) >= FRIEND_REQUEST_LIMIT) return result(false, 'request_limit', 'Tienes demasiadas solicitudes pendientes. Retira algunas antes de enviar más.');
  if (pendingFriendRequestCount(state, target.id, 'toId') >= FRIEND_LIMIT) return result(false, 'incoming_request_limit', 'Esa cuenta tiene demasiadas solicitudes pendientes. Inténtalo más tarde.');
  if (friendshipCount(state, requester.id) >= FRIEND_LIMIT || friendshipCount(state, target.id) >= FRIEND_LIMIT) {
    return result(false, 'friend_limit', 'Una de las cuentas llegó al límite de amistades.');
  }
  const request = { id: crypto.randomUUID(), fromId: requester.id, toId: target.id, createdAt: now };
  state.friendRequests.push(request);
  return result(true, 'request_sent', 'Solicitud enviada.', { request });
}

function acceptFriendRequest(state, recipientId, requestId, profiles, { now = Date.now() } = {}) {
  const index = state.friendRequests.findIndex(item => item.id === String(requestId) && item.toId === String(recipientId));
  if (index < 0) return result(false, 'request_not_found', 'La solicitud ya no está disponible.');
  const request = state.friendRequests[index];
  if (!profileExists(profiles, request.fromId) || !profileExists(profiles, request.toId)) {
    state.friendRequests.splice(index, 1);
    return result(false, 'account_not_found', 'Una de las cuentas ya no está disponible.');
  }
  if (friendshipExists(state, request.fromId, request.toId)) {
    state.friendRequests.splice(index, 1);
    return result(true, 'already_friends', 'Ya son amigos.');
  }
  if (friendshipCount(state, recipientId) >= FRIEND_LIMIT || friendshipCount(state, request.fromId) >= FRIEND_LIMIT) {
    return result(false, 'friend_limit', 'Una de las cuentas llegó al límite de amistades.');
  }
  state.friendRequests.splice(index, 1);
  const friendship = addFriendship(state, request.fromId, request.toId, now);
  state.friendRequests = state.friendRequests.filter(item => !(item.fromId === request.toId && item.toId === request.fromId));
  return result(true, 'friend_added', 'Solicitud aceptada.', { friendship });
}

function removeFriendRequest(state, actorId, requestId) {
  const index = state.friendRequests.findIndex(item => item.id === String(requestId) && (item.fromId === String(actorId) || item.toId === String(actorId)));
  if (index < 0) return result(false, 'request_not_found', 'La solicitud ya no está disponible.');
  state.friendRequests.splice(index, 1);
  return result(true, 'request_removed', 'Solicitud retirada.');
}

function removeFriend(state, actorId, targetId) {
  const index = state.friendships.findIndex(item => pairKey(item.profileA, item.profileB) === pairKey(actorId, targetId));
  if (index < 0) return result(false, 'friend_not_found', 'Esa persona no está en tu lista.');
  state.friendships.splice(index, 1);
  return result(true, 'friend_removed', 'Amistad eliminada.');
}

function membershipFor(state, profileId) {
  return state.clubs.filter(club => club.members.some(member => member.profileId === String(profileId)));
}
function memberCount(club) { return club.members.length; }
function memberIn(club, profileId) { return club.members.some(member => member.profileId === String(profileId)); }

function createClub(state, owner, input, { now = Date.now() } = {}) {
  if (!owner?.id || !owner.username) return result(false, 'account_required', 'Inicia sesión con una cuenta para crear un club.');
  const name = cleanText(input?.name, 24);
  const description = cleanText(input?.description, 160);
  if ([...name].length < 3) return result(false, 'name_invalid', 'El nombre del club debe tener al menos 3 caracteres.');
  if (state.clubs.some(club => club.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)) {
    return result(false, 'name_taken', 'Ya existe un club con ese nombre.');
  }
  if (state.clubs.some(club => club.ownerId === owner.id)) return result(false, 'owner_limit', 'Cada cuenta puede crear un club. Puedes liderar el que ya tienes.');
  if (membershipFor(state, owner.id).length >= CLUBS_PER_MEMBER_LIMIT) return result(false, 'membership_limit', 'Puedes pertenecer como máximo a tres clubes.');
  const emblem = Object.prototype.hasOwnProperty.call(CLUB_EMBLEMS, input?.emblem) ? input.emblem : 'spade';
  const color = Object.prototype.hasOwnProperty.call(CLUB_COLORS, input?.color) ? input.color : 'emerald';
  const visibility = input?.visibility === 'private' ? 'private' : 'public';
  const club = {
    id: crypto.randomUUID(), name, description, emblem, color, visibility,
    ownerId: owner.id, createdAt: now, updatedAt: now,
    members: [{ profileId: owner.id, role: 'owner', joinedAt: now }], requests: []
  };
  state.clubs.push(club);
  return result(true, 'club_created', 'Club creado.', { club });
}

function joinClub(state, profile, clubId, { now = Date.now() } = {}) {
  const club = state.clubs.find(item => item.id === String(clubId));
  if (!club) return result(false, 'club_not_found', 'No se encontró ese club.');
  if (!profile?.id || !profile.username) return result(false, 'account_required', 'Inicia sesión con una cuenta para unirte a un club.');
  if (memberIn(club, profile.id)) return result(false, 'already_member', 'Ya eres miembro de este club.');
  if (membershipFor(state, profile.id).length >= CLUBS_PER_MEMBER_LIMIT) return result(false, 'membership_limit', 'Puedes pertenecer como máximo a tres clubes.');
  if (memberCount(club) >= CLUB_MEMBER_LIMIT) return result(false, 'club_full', 'El club llegó a su límite de miembros.');
  const existingRequest = club.requests.find(item => item.profileId === profile.id);
  if (existingRequest) return result(false, 'request_pending', 'Tu solicitud ya está pendiente.');
  if (club.visibility === 'private' && club.requests.length >= CLUB_REQUEST_LIMIT) return result(false, 'club_request_limit', 'El club tiene muchas solicitudes pendientes. Inténtalo más tarde.');
  if (club.visibility === 'private') {
    const request = { id: crypto.randomUUID(), profileId: profile.id, createdAt: now };
    club.requests.push(request);
    club.updatedAt = now;
    return result(true, 'join_requested', 'Solicitud enviada al liderazgo del club.', { club, request });
  }
  const member = { profileId: profile.id, role: 'member', joinedAt: now };
  club.members.push(member);
  club.updatedAt = now;
  return result(true, 'joined', 'Te uniste al club.', { club, member });
}

function respondToClubRequest(state, actorId, clubId, requestId, accept, profiles, { now = Date.now() } = {}) {
  const club = state.clubs.find(item => item.id === String(clubId));
  if (!club) return result(false, 'club_not_found', 'No se encontró ese club.');
  if (club.ownerId !== String(actorId)) return result(false, 'owner_required', 'Solo quien creó el club puede gestionar solicitudes.');
  const index = club.requests.findIndex(item => item.id === String(requestId));
  if (index < 0) return result(false, 'request_not_found', 'La solicitud ya no está disponible.');
  const request = club.requests[index];
  if (!accept) {
    club.requests.splice(index, 1);
    club.updatedAt = now;
    return result(true, 'request_rejected', 'Solicitud rechazada.');
  }
  if (!profileExists(profiles, request.profileId)) {
    club.requests.splice(index, 1);
    return result(false, 'account_not_found', 'La cuenta ya no está disponible.');
  }
  if (memberCount(club) >= CLUB_MEMBER_LIMIT) return result(false, 'club_full', 'El club llegó a su límite de miembros.');
  if (membershipFor(state, request.profileId).length >= CLUBS_PER_MEMBER_LIMIT) {
    return result(false, 'membership_limit', 'Esa persona ya pertenece al máximo de tres clubes.');
  }
  club.requests.splice(index, 1);
  const member = { profileId: request.profileId, role: 'member', joinedAt: now };
  club.members.push(member);
  club.updatedAt = now;
  return result(true, 'request_accepted', 'Solicitud aceptada.', { club, member });
}

function leaveClub(state, profileId, clubId, { now = Date.now() } = {}) {
  const clubIndex = state.clubs.findIndex(item => item.id === String(clubId));
  if (clubIndex < 0) return result(false, 'club_not_found', 'No se encontró ese club.');
  const club = state.clubs[clubIndex];
  if (club.ownerId === String(profileId)) return result(false, 'owner_must_disband', 'Como líder, puedes cerrar el club desde Gestionar club.');
  const memberIndex = club.members.findIndex(member => member.profileId === String(profileId));
  if (memberIndex < 0) return result(false, 'not_member', 'No formas parte de ese club.');
  club.members.splice(memberIndex, 1);
  club.updatedAt = now;
  return result(true, 'left', 'Saliste del club.');
}

function disbandClub(state, actorId, clubId) {
  const index = state.clubs.findIndex(item => item.id === String(clubId) && item.ownerId === String(actorId));
  if (index < 0) return result(false, 'owner_required', 'Solo quien creó el club puede cerrarlo.');
  state.clubs.splice(index, 1);
  return result(true, 'club_disbanded', 'Club cerrado.');
}

function removeClubMember(state, actorId, clubId, memberId, { now = Date.now() } = {}) {
  const club = state.clubs.find(item => item.id === String(clubId));
  if (!club) return result(false, 'club_not_found', 'No se encontró ese club.');
  if (club.ownerId !== String(actorId)) return result(false, 'owner_required', 'Solo quien creó el club puede gestionar miembros.');
  if (club.ownerId === String(memberId)) return result(false, 'owner_protected', 'No puedes expulsarte con esta acción.');
  const index = club.members.findIndex(member => member.profileId === String(memberId));
  if (index < 0) return result(false, 'member_not_found', 'Esa persona no forma parte del club.');
  club.members.splice(index, 1);
  club.updatedAt = now;
  return result(true, 'member_removed', 'Miembro eliminado.');
}

module.exports = {
  FRIEND_LIMIT,
  FRIEND_REQUEST_LIMIT,
  CLUB_MEMBER_LIMIT,
  CLUB_REQUEST_LIMIT,
  CLUBS_PER_MEMBER_LIMIT,
  CLUB_EMBLEMS,
  CLUB_COLORS,
  cleanText,
  friendshipExists,
  requestFriend,
  acceptFriendRequest,
  removeFriendRequest,
  removeFriend,
  createClub,
  joinClub,
  respondToClubRequest,
  leaveClub,
  disbandClub,
  removeClubMember,
  membershipFor,
  memberIn
};
