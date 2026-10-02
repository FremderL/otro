'use strict';

const crypto = require('node:crypto');

const USER_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const USER_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const STAFF_IDLE_MS = 30 * 60 * 1000;
const STAFF_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function hashSessionToken(token, pepperBase64) {
  if (typeof token !== 'string' || !token) return null;
  const pepper = Buffer.from(String(pepperBase64 || ''), 'base64');
  if (pepper.length < 32) throw new Error('SESSION_PEPPER inválido');
  return crypto.createHash('sha256').update(token, 'utf8').update(pepper).digest('hex');
}

function sessionPolicy(role) {
  const staff = role === 'admin' || role === 'moderator';
  return {
    idleMs: staff ? STAFF_IDLE_MS : USER_IDLE_MS,
    absoluteMs: staff ? STAFF_ABSOLUTE_MS : USER_ABSOLUTE_MS
  };
}

function createSessionRecord({ profileId, sessionVersion = 1, role = 'user', now = Date.now(), ipHash = null, userAgentHash = null }, pepperBase64) {
  if (!profileId) throw new Error('profileId es obligatorio');
  const token = crypto.randomBytes(32).toString('base64url');
  const policy = sessionPolicy(role);
  return {
    token,
    record: {
      id: crypto.randomUUID(),
      profileId: String(profileId),
      tokenHash: hashSessionToken(token, pepperBase64),
      sessionVersion: Math.max(1, Number(sessionVersion) || 1),
      role,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: now + policy.idleMs,
      absoluteExpiresAt: now + policy.absoluteMs,
      revokedAt: null,
      revokeReason: null,
      mfaVerifiedAt: null,
      ipHash,
      userAgentHash
    }
  };
}

function sessionState(record, { now = Date.now(), sessionVersion } = {}) {
  if (!record) return { valid: false, reason: 'not_found' };
  if (record.revokedAt) return { valid: false, reason: 'revoked' };
  if (Number(record.absoluteExpiresAt) <= now) return { valid: false, reason: 'absolute_expired' };
  if (Number(record.idleExpiresAt) <= now) return { valid: false, reason: 'idle_expired' };
  if (sessionVersion !== undefined && Number(record.sessionVersion) !== Number(sessionVersion)) {
    return { valid: false, reason: 'version_mismatch' };
  }
  return { valid: true, reason: null };
}

class MemorySessionStore {
  constructor({ pepper }) {
    this.pepper = pepper;
    this.sessions = new Map();
    this.byHash = new Map();
  }

  async issue(input) {
    const issued = createSessionRecord(input, this.pepper);
    this.sessions.set(issued.record.id, issued.record);
    this.byHash.set(issued.record.tokenHash, issued.record.id);
    return { token: issued.token, session: { ...issued.record } };
  }

  async findByToken(token) {
    const hash = hashSessionToken(token, this.pepper);
    const id = hash && this.byHash.get(hash);
    const record = id && this.sessions.get(id);
    return record ? { ...record } : null;
  }

  async touch(id, { now = Date.now(), role = 'user' } = {}) {
    const record = this.sessions.get(id);
    if (!record || record.revokedAt || now - record.lastSeenAt < TOUCH_INTERVAL_MS) return false;
    const policy = sessionPolicy(role);
    record.lastSeenAt = now;
    record.idleExpiresAt = Math.min(now + policy.idleMs, record.absoluteExpiresAt);
    return true;
  }

  async markMfaVerified(id, now = Date.now()) {
    const record = this.sessions.get(id);
    if (!record || record.revokedAt) return false;
    record.mfaVerifiedAt = now;
    return true;
  }

  async revoke(id, reason = 'logout', now = Date.now()) {
    const record = this.sessions.get(id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = now;
    record.revokeReason = String(reason).slice(0, 120);
    return true;
  }

  async revokeProfile(profileId, reason = 'logout_all', { exceptId = null, now = Date.now() } = {}) {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.profileId === String(profileId) && record.id !== exceptId && !record.revokedAt) {
        record.revokedAt = now;
        record.revokeReason = String(reason).slice(0, 120);
        count += 1;
      }
    }
    return count;
  }
}

module.exports = {
  MemorySessionStore,
  createSessionRecord,
  hashSessionToken,
  sessionPolicy,
  sessionState,
  USER_IDLE_MS,
  USER_ABSOLUTE_MS,
  STAFF_IDLE_MS,
  STAFF_ABSOLUTE_MS,
  TOUCH_INTERVAL_MS
};
