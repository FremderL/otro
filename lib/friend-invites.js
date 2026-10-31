'use strict';

// Invitaciones efímeras entre amistades. Viven SOLO en memoria a propósito:
// una invitación apunta a una mesa viva y a un socket conectado, así que no
// tiene sentido (ni es seguro) persistir códigos de salas privadas en disco.
// Cuando la mesa se cierra, la invitación expira o la persona entra, la
// invitación desaparece.
const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;
const DEFAULT_TARGET_CAP = 5;
const DEFAULT_SENDER_LIMIT = 20;
const SENDER_WINDOW_MS = 60 * 1000;
const ROOM_CODE = /^[A-Z0-9]{5}$/;

function text(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanAccount(value) {
  if (!value || !value.id) return null;
  const id = text(value.id, 80);
  if (!id) return null;
  return {
    id,
    name: text(value.name || value.username || 'Una amistad', 40),
    avatar: text(value.avatar, 24) || 'fox',
    username: text(value.username, 20)
  };
}

function cleanRoom(value) {
  if (!value || !ROOM_CODE.test(String(value.code || '').toUpperCase())) return null;
  const players = Math.max(0, Math.floor(Number(value.players) || 0));
  const capacity = Math.min(12, Math.max(2, Math.floor(Number(value.capacity) || 6)));
  return {
    code: String(value.code).toUpperCase(),
    name: text(value.name, 40) || 'Mesa privada',
    game: text(value.game, 20) || 'poker',
    players: Math.min(players, capacity),
    capacity
  };
}

function failure(code, error) {
  return { ok: false, code, error };
}

class FriendInviteService {
  constructor({ now = Date.now, makeId = () => crypto.randomUUID(), isFriend = () => false, ttlMs = DEFAULT_TTL_MS, cooldownMs = DEFAULT_COOLDOWN_MS, maxPerTarget = DEFAULT_TARGET_CAP, senderLimit = DEFAULT_SENDER_LIMIT } = {}) {
    this.now = now;
    this.makeId = makeId;
    this.isFriend = isFriend;
    this.ttlMs = ttlMs;
    this.cooldownMs = cooldownMs;
    this.maxPerTarget = maxPerTarget;
    this.senderLimit = senderLimit;
    this.pending = new Map(); // targetProfileId -> [invite]
    this.senderHits = new Map(); // senderProfileId -> [timestamps]
  }

  prune(now = this.now()) {
    let removed = 0;
    for (const [targetId, invites] of this.pending) {
      const alive = invites.filter(invite => invite.expiresAt > now);
      removed += invites.length - alive.length;
      if (alive.length) this.pending.set(targetId, alive);
      else this.pending.delete(targetId);
    }
    for (const [senderId, hits] of this.senderHits) {
      const alive = hits.filter(time => now - time < SENDER_WINDOW_MS);
      if (alive.length) this.senderHits.set(senderId, alive);
      else this.senderHits.delete(senderId);
    }
    return removed;
  }

  // Devuelve { ok, code, invite, duplicate }. La comprobación de amistad se
  // delega en el servidor (isFriend) para que este módulo no dependa del store.
  send({ from, toId, room } = {}) {
    const sender = cleanAccount(from);
    const targetId = text(toId, 80);
    if (!sender) return failure('account_required', 'Inicia sesión para invitar a tus amistades.');
    if (!targetId) return failure('invalid_target', 'No pudimos identificar a esa persona.');
    if (sender.id === targetId) return failure('self_invite', 'No puedes invitarte a ti mismo.');
    if (typeof this.isFriend !== 'function' || !this.isFriend(sender.id, targetId)) {
      return failure('not_friends', 'Solo puedes invitar a personas de tu lista de amistades.');
    }
    const clean = cleanRoom(room);
    if (!clean) return failure('room_required', 'Esa mesa ya no está disponible para invitar.');

    const now = this.now();
    this.prune(now);
    const hits = this.senderHits.get(sender.id) || [];
    if (hits.length >= this.senderLimit) {
      return failure('rate_limited', 'Has enviado muchas invitaciones. Espera un minuto antes de enviar más.');
    }

    const existing = (this.pending.get(targetId) || []).find(invite => invite.from.id === sender.id && invite.room.code === clean.code);
    if (existing) {
      // Reinvitar en la ventana de enfriamiento no molesta a la persona: se
      // devuelve la misma invitación para que la interfaz confirme el estado.
      if (now - existing.createdAt < this.cooldownMs) return { ok: true, code: 'already_invited', error: '', invite: existing, duplicate: true };
      existing.createdAt = now;
      existing.expiresAt = now + this.ttlMs;
      return { ok: true, code: 'invite_sent', error: '', invite: existing, duplicate: true };
    }

    const invite = {
      id: this.makeId(),
      from: sender,
      toId: targetId,
      room: clean,
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    const list = [...(this.pending.get(targetId) || []), invite].slice(-this.maxPerTarget);
    this.pending.set(targetId, list);
    this.senderHits.set(sender.id, [...hits, now]);
    return { ok: true, code: 'invite_sent', error: '', invite, duplicate: false };
  }

  pendingFor(profileId, now = this.now()) {
    this.prune(now);
    const targetId = text(profileId, 80);
    if (!targetId) return [];
    return [...(this.pending.get(targetId) || [])].sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(targetId, inviteId) {
    const key = text(targetId, 80);
    const invites = this.pending.get(key);
    if (!invites) return null;
    const index = invites.findIndex(invite => invite.id === String(inviteId || ''));
    if (index < 0) return null;
    const [invite] = invites.splice(index, 1);
    if (!invites.length) this.pending.delete(key);
    return invite;
  }

  dismiss(profileId, inviteId) {
    return Boolean(this.remove(profileId, inviteId));
  }

  accept(profileId, inviteId, now = this.now()) {
    this.prune(now);
    const invite = this.remove(profileId, inviteId);
    if (!invite || invite.expiresAt <= now) return null;
    return invite;
  }

  // Al entrar a la mesa (por el enlace o por el botón de la invitación) se
  // consume la invitación pendiente de esa sala para no repetir el aviso.
  takeForRoom(profileId, roomCode) {
    const key = text(profileId, 80);
    const invites = this.pending.get(key);
    if (!invites) return null;
    const code = String(roomCode || '').toUpperCase();
    const index = invites.findIndex(invite => invite.room.code === code);
    if (index < 0) return null;
    const [invite] = invites.splice(index, 1);
    if (!invites.length) this.pending.delete(key);
    return invite;
  }

  dropRoom(roomCode) {
    const code = String(roomCode || '').toUpperCase();
    let removed = 0;
    for (const [targetId, invites] of this.pending) {
      const alive = invites.filter(invite => invite.room.code !== code);
      removed += invites.length - alive.length;
      if (alive.length) this.pending.set(targetId, alive);
      else this.pending.delete(targetId);
    }
    return removed;
  }

  snapshot() {
    return { pendingTargets: this.pending.size, pending: [...this.pending.values()].reduce((total, list) => total + list.length, 0) };
  }
}

module.exports = {
  FriendInviteService,
  cleanAccount,
  cleanRoom,
  DEFAULT_TTL_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TARGET_CAP,
  DEFAULT_SENDER_LIMIT,
  SENDER_WINDOW_MS
};
