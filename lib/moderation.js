'use strict';

const crypto = require('node:crypto');

const SUSPENSION_DURATIONS = Object.freeze({
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
});

function effectiveModeration(profile, now = Date.now()) {
  const moderation = profile?.moderation || { status: 'active' };
  if (moderation.status === 'suspended' && Number(moderation.until) <= now) {
    return { ...moderation, status: 'active', expired: true };
  }
  return { ...moderation, expired: false };
}

function moderationMessage(profile, now = Date.now()) {
  const state = effectiveModeration(profile, now);
  if (state.status === 'active') return null;
  if (state.status === 'banned') return { code: 'account_banned', error: 'Esta cuenta fue bloqueada permanentemente.' };
  return { code: 'account_suspended', error: 'Esta cuenta está suspendida temporalmente.', until: state.until };
}

function applyModeration(profile, { type, reason, duration, now = Date.now(), actionId = crypto.randomUUID() }) {
  if (!profile) throw new Error('Perfil obligatorio');
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 10 || cleanReason.length > 500) throw new Error('El motivo debe tener entre 10 y 500 caracteres');
  if (!['suspend', 'ban', 'unban'].includes(type)) throw new Error('Acción de moderación inválida');
  let status = 'active';
  let until = null;
  if (type === 'suspend') {
    if (!SUSPENSION_DURATIONS[duration]) throw new Error('Duración de suspensión inválida');
    status = 'suspended'; until = now + SUSPENSION_DURATIONS[duration];
  } else if (type === 'ban') status = 'banned';
  profile.moderation = { status, reason: cleanReason, until, actionId, updatedAt: now };
  profile.security = profile.security || {};
  profile.security.sessionVersion = Math.max(1, Number(profile.security.sessionVersion) || 1) + 1;
  return profile.moderation;
}

module.exports = { SUSPENSION_DURATIONS, effectiveModeration, moderationMessage, applyModeration };
