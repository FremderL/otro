'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PERMISSIONS, normalizeRole, hasPermission, canModerate } = require('../lib/permissions');

test('roles desconocidos degradan a usuario', () => {
  assert.equal(normalizeRole('superadmin'), 'user');
  assert.equal(hasPermission('superadmin', PERMISSIONS.ROLE_MANAGE), false);
  assert.equal(hasPermission('superadmin', PERMISSIONS.REPORT_CREATE), true);
});

test('moderador puede suspender usuarios pero no pares ni admins', () => {
  const moderator = { id: 'm', role: 'moderator' };
  assert.equal(canModerate(moderator, { id: 'u', role: 'user' }, PERMISSIONS.USER_SUSPEND), true);
  assert.equal(canModerate(moderator, { id: 'm2', role: 'moderator' }, PERMISSIONS.USER_SUSPEND), false);
  assert.equal(canModerate(moderator, { id: 'a', role: 'admin' }, PERMISSIONS.USER_SUSPEND), false);
  assert.equal(hasPermission('moderator', PERMISSIONS.USER_BAN), false);
});

test('admin tiene permisos sensibles pero no puede moderarse a sí mismo', () => {
  const admin = { id: 'a', role: 'admin' };
  assert.equal(hasPermission('admin', PERMISSIONS.ROLE_MANAGE), true);
  assert.equal(hasPermission('admin', PERMISSIONS.PASSWORD_RESET), true);
  assert.equal(canModerate(admin, { id: 'u', role: 'user' }, PERMISSIONS.USER_BAN), true);
  assert.equal(canModerate(admin, admin, PERMISSIONS.USER_BAN), false);
});
