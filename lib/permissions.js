'use strict';

const ROLES = Object.freeze(['user', 'moderator', 'admin']);
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
  MFA_RESET: 'mfa:reset'
});

const ROLE_PERMISSIONS = Object.freeze({
  user: new Set([PERMISSIONS.REPORT_CREATE]),
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
