'use strict';

// 'sponsor' es un rol de cliente: no es personal (no entra al panel) y solo añade el derecho
// a solicitar publicidad en La Previa. Lo otorga un administrador.
const ROLES = Object.freeze(['user', 'sponsor', 'moderator', 'admin']);
const PERMISSIONS = Object.freeze({
  REPORT_CREATE: 'report:create',
  REPORT_READ_ASSIGNED: 'report:read_assigned',
  REPORT_RESOLVE: 'report:resolve',
  USER_SUSPEND: 'user:suspend',
  USER_BAN: 'user:ban',
  USER_UNBAN: 'user:unban',
  PASSWORD_RESET: 'password:reset',
  ROLE_MANAGE: 'role:manage',
  AUDIT_READ: 'audit:read',
  MFA_RESET: 'mfa:reset',
  // Fase E4b: palancas operativas del Estadio (suspender/liquidar/posponer partidos,
  // cerrar mercados). Solo el rol admin: los moderadores no tocan el motor de fútbol.
  FOOTBALL_MANAGE: 'football:manage',
  // Solicitar promociones de La Previa (rol Patrocinador, o admin).
  PROMOTION_SUBMIT: 'promotion:submit'
});

const ROLE_PERMISSIONS = Object.freeze({
  user: new Set([PERMISSIONS.REPORT_CREATE]),
  sponsor: new Set([PERMISSIONS.REPORT_CREATE, PERMISSIONS.PROMOTION_SUBMIT]),
  moderator: new Set([
    PERMISSIONS.REPORT_CREATE,
    PERMISSIONS.REPORT_READ_ASSIGNED,
    PERMISSIONS.REPORT_RESOLVE,
    PERMISSIONS.USER_SUSPEND
  ]),
  admin: new Set(Object.values(PERMISSIONS))
});

function normalizeRole(role) {
  return ROLES.includes(role) ? role : 'user';
}

function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[normalizeRole(role)].has(permission);
}

function roleRank(role) {
  return ROLES.indexOf(normalizeRole(role));
}

function canModerate(actor, target, permission) {
  if (!actor || !target || actor.id === target.id) return false;
  if (!hasPermission(actor.role, permission)) return false;
  return roleRank(actor.role) > roleRank(target.role);
}

module.exports = { ROLES, PERMISSIONS, ROLE_PERMISSIONS, normalizeRole, hasPermission, roleRank, canModerate };
