'use strict';

const crypto = require('node:crypto');

function sanitizeAuditData(value) {
  if (value == null) return null;
  const allowed = ['role', 'status', 'mfaEnabled', 'sessionVersion', 'until', 'reportId', 'challengeId', 'expiresAt', 'evidenceCount'];
  return Object.fromEntries(allowed.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function createAuditEntry(input) {
  if (!input?.action || !input?.targetType) throw new Error('Acción y objetivo de auditoría son obligatorios');
  if (!['system', 'moderator', 'admin'].includes(input.actorRole)) throw new Error('Rol de auditoría inválido');
  const reason = input.reason == null ? null : String(input.reason).trim();
  if (reason && (reason.length < 10 || reason.length > 500)) throw new Error('Motivo de auditoría inválido');
  return {
    id: crypto.randomUUID(),
    actorProfileId: input.actorProfileId || null,
    actorRole: input.actorRole,
    action: String(input.action).slice(0, 120),
    targetType: String(input.targetType).slice(0, 60),
    targetId: input.targetId == null ? null : String(input.targetId).slice(0, 120),
    requestId: input.requestId || crypto.randomUUID(),
    ipHash: input.ipHash || null,
    beforeData: sanitizeAuditData(input.beforeData),
    afterData: sanitizeAuditData(input.afterData),
    reason,
    createdAt: input.createdAt || Date.now()
  };
}

class MemoryAuditStore {
  constructor() { this.entries = []; }
  async append(input) {
    const entry = createAuditEntry(input);
    this.entries.push(entry);
    return { ...entry };
  }
}

module.exports = { MemoryAuditStore, createAuditEntry, sanitizeAuditData };
