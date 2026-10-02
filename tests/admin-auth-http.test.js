'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { MemorySessionStore } = require('../lib/account-sessions');
const { installAdminRoutes, RECENT_AUTH_MS } = require('../lib/admin-auth-http');
const { csrfToken } = require('../lib/account-auth-http');
const { PERMISSIONS } = require('../lib/permissions');
const { MemoryAuditStore } = require('../lib/audit-store');
const { MemoryModerationStore } = require('../lib/moderation-store');
const { MemoryReportStore } = require('../lib/report-store');
const { MemoryPasswordResetStore } = require('../lib/password-reset-store');
const { MemoryIdempotencyStore } = require('../lib/idempotency-store');

const pepper = Buffer.alloc(32, 2).toString('base64');

async function fixture(t, { role = 'admin', mfaEnabled = true, mfaVerifiedAt = Date.now() } = {}) {
  const profile = { id:'staff-1', username:'staff', name:'Personal', role, security:{ sessionVersion:1, mfaEnabled } };
  const target = { id:'staff-2', username:'target', name:'Objetivo', role:'moderator', security:{ sessionVersion:1, mfaEnabled:true, mfaSecretEncrypted:'secret', recoveryCodeHashes:['hash'], mfaEnrolledAt:1 } };
  const profiles = { profiles:new Map([[profile.id, profile],[target.id,target]]), touch(item) { item.updatedAt = Date.now(); } };
  const sessions = new MemorySessionStore({ pepper });
  const issued = await sessions.issue({ profileId:profile.id, role, sessionVersion:1 });
  if (mfaVerifiedAt) await sessions.markMfaVerified(issued.session.id, mfaVerifiedAt);
  const targetSession = await sessions.issue({ profileId:target.id, role:'moderator', sessionVersion:1 });
  const audit = new MemoryAuditStore();
  const moderation = new MemoryModerationStore();
  const reports = new MemoryReportStore();
  const passwordResets = new MemoryPasswordResetStore(pepper);
  const idempotency = new MemoryIdempotencyStore();
  const moderated=[];
  const config = { enabled:true, sessionPepper:pepper, appOrigin:'' };
  const app = express();
  const auth = installAdminRoutes(app, { config, getProfiles:()=>profiles, getSessionStore:()=>sessions, getAuditStore:()=>audit, getModerationStore:()=>moderation, getReportStore:()=>reports, getPasswordResetStore:()=>passwordResets, getIdempotencyStore:()=>idempotency, onModerated:async(target,state)=>moderated.push({target,state}) });
  app.get('/test-ban', auth.resolveAdmin, auth.requirePermission(PERMISSIONS.USER_BAN), (_req,res)=>res.json({ok:true}));
  app.get('/test-recent', auth.resolveAdmin, auth.requireRecentAuth, (_req,res)=>res.json({ok:true}));
  const server = app.listen(0, '127.0.0.1');
  const origin = await new Promise(resolve => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  config.appOrigin = origin;
  t.after(() => server.close());
  return { origin, cookie:`mc_session=${issued.token}`, csrf:csrfToken(issued.session.id, pepper), profile, target, targetToken:targetSession.token, sessions, audit, moderation, reports, passwordResets, moderated };
}

test('ruta me exige rol de personal y MFA de esa sesión', async t => {
  const active = await fixture(t);
  const page = await fetch(`${active.origin}/admin`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const response = await fetch(`${active.origin}/api/admin/v1/me`, { headers:{cookie:active.cookie} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).staff.role, 'admin');
});

test('rechaza personal sin enrolamiento o sin verificación', async t => {
  const noEnrollment = await fixture(t, { mfaEnabled:false, mfaVerifiedAt:null });
  let response = await fetch(`${noEnrollment.origin}/api/admin/v1/me`, { headers:{cookie:noEnrollment.cookie} });
  assert.equal((await response.json()).code, 'mfa_enrollment_required');
  const notVerified = await fixture(t, { mfaEnabled:true, mfaVerifiedAt:null });
  response = await fetch(`${notVerified.origin}/api/admin/v1/me`, { headers:{cookie:notVerified.cookie} });
  assert.equal((await response.json()).code, 'mfa_required');
});

test('permiso diferencia moderador de admin', async t => {
  const moderator = await fixture(t, { role:'moderator' });
  assert.equal((await fetch(`${moderator.origin}/test-ban`, {headers:{cookie:moderator.cookie}})).status, 403);
  const admin = await fixture(t);
  assert.equal((await fetch(`${admin.origin}/test-ban`, {headers:{cookie:admin.cookie}})).status, 200);
});

test('otro admin restablece MFA con CSRF, revocación y auditoría', async t => {
  const admin = await fixture(t);
  const response = await fetch(`${admin.origin}/api/admin/v1/users/${admin.target.id}/mfa-reset`, {
    method:'POST', headers:{ origin:admin.origin, cookie:admin.cookie, 'content-type':'application/json', 'x-csrf-token':admin.csrf,'idempotency-key':crypto.randomUUID() },
    body:JSON.stringify({reason:'Solicitud verificada por soporte'})
  });
  assert.equal(response.status, 200);
  assert.equal(admin.target.security.mfaEnabled, false);
  assert.equal(admin.target.security.mfaSecretEncrypted, null);
  assert.equal(admin.target.security.sessionVersion, 2);
  assert.equal(admin.audit.entries.length, 1);
  assert.equal(admin.audit.entries[0].action, 'mfa.reset');
  assert.equal((await admin.sessions.findByToken(admin.targetToken)).revokeReason, 'mfa_reset');
});

test('prohíbe auto-reset de MFA', async t => {
  const admin = await fixture(t);
  const response = await fetch(`${admin.origin}/api/admin/v1/users/${admin.profile.id}/mfa-reset`, {
    method:'POST', headers:{ origin:admin.origin, cookie:admin.cookie, 'content-type':'application/json', 'x-csrf-token':admin.csrf,'idempotency-key':crypto.randomUUID() },
    body:JSON.stringify({reason:'Intento sobre cuenta propia'})
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'self_action_denied');
});

test('escritura administrativa repetida reproduce respuesta sin duplicar efectos',async t=>{const admin=await fixture(t);admin.target.role='user';const key=crypto.randomUUID(),options={method:'POST',headers:{origin:admin.origin,cookie:admin.cookie,'content-type':'application/json','x-csrf-token':admin.csrf,'idempotency-key':key},body:JSON.stringify({reason:'Acoso confirmado de forma reiterada',duration:'24h'})};let response=await fetch(`${admin.origin}/api/admin/v1/users/${admin.target.id}/suspend`,options);assert.equal(response.status,200);const first=await response.json();response=await fetch(`${admin.origin}/api/admin/v1/users/${admin.target.id}/suspend`,options);assert.equal(response.status,200);assert.equal(response.headers.get('idempotency-replayed'),'true');assert.deepEqual(await response.json(),first);assert.equal(admin.moderation.actions.length,1);});

test('admin crea enlace de contraseña de un uso sin conocer la nueva clave',async t=>{const admin=await fixture(t);const response=await fetch(`${admin.origin}/api/admin/v1/users/${admin.target.id}/password-reset`,{method:'POST',headers:{origin:admin.origin,cookie:admin.cookie,'content-type':'application/json','x-csrf-token':admin.csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({reason:'Identidad confirmada mediante procedimiento de soporte'})});assert.equal(response.status,201);const body=await response.json();assert.match(body.resetUrl,/\/reset-password#token=/);assert.equal(JSON.stringify(admin.audit.entries).includes('token='),false);assert.equal(admin.audit.entries.at(-1).action,'password_reset.created');});

test('cola administrativa consulta evidencia, actualiza y detecta conflicto',async t=>{const admin=await fixture(t);const report=await admin.reports.create({reporterProfileId:'reporter',reportedProfileId:admin.target.id,category:'threat',description:'Amenaza directa y verificable dentro del chat'});await admin.reports.addEvidence(report.id,'chat_message',{text:'amenaza'});let response=await fetch(`${admin.origin}/api/admin/v1/reports`,{headers:{cookie:admin.cookie}});assert.equal(response.status,200);assert.equal((await response.json()).reports.length,1);response=await fetch(`${admin.origin}/api/admin/v1/reports/${report.id}`,{headers:{cookie:admin.cookie}});assert.equal((await response.json()).evidence.length,1);assert.equal(admin.audit.entries.at(-1).action,'report.evidence_read');assert.equal(admin.audit.entries.at(-1).afterData.evidenceCount,1);response=await fetch(`${admin.origin}/api/admin/v1/reports/${report.id}`,{method:'PATCH',headers:{origin:admin.origin,cookie:admin.cookie,'content-type':'application/json','x-csrf-token':admin.csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({version:1,status:'investigating',priority:'high'})});assert.equal(response.status,200);assert.equal(admin.audit.entries.at(-1).action,'report.updated');response=await fetch(`${admin.origin}/api/admin/v1/reports/${report.id}`,{method:'PATCH',headers:{origin:admin.origin,cookie:admin.cookie,'content-type':'application/json','x-csrf-token':admin.csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({version:1,status:'rejected'})});assert.equal(response.status,409);assert.equal((await response.json()).code,'version_conflict');});

test('buscador y detalle exponen solo datos administrativos permitidos', async t=>{const admin=await fixture(t);const search=await fetch(`${admin.origin}/api/admin/v1/users?query=target`,{headers:{cookie:admin.cookie}});assert.equal(search.status,200);const body=await search.json();assert.equal(body.users[0].username,'target');assert.equal(JSON.stringify(body).includes('passwordHash'),false);const detail=await fetch(`${admin.origin}/api/admin/v1/users/${admin.target.id}`,{headers:{cookie:admin.cookie}});assert.equal(detail.status,200);assert.equal((await detail.json()).user.id,admin.target.id);});

test('admin suspende, revoca sesiones, persiste y notifica expulsión', async t => {
  const admin=await fixture(t);admin.target.role='user';
  const response=await fetch(`${admin.origin}/api/admin/v1/users/${admin.target.id}/suspend`,{method:'POST',headers:{origin:admin.origin,cookie:admin.cookie,'content-type':'application/json','x-csrf-token':admin.csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({reason:'Acoso confirmado en chat público',duration:'24h'})});
  assert.equal(response.status,200);
  assert.equal(admin.target.moderation.status,'suspended');
  assert.equal(admin.moderation.actions.length,1);
  assert.equal(admin.audit.entries.at(-1).action,'moderation.suspend');
  assert.equal((await admin.sessions.findByToken(admin.targetToken)).revokeReason,'moderation_suspend');
  assert.equal(admin.moderated.length,1);
});

test('moderador no puede suspender a otro moderador', async t => {
  const moderator=await fixture(t,{role:'moderator'});
  const response=await fetch(`${moderator.origin}/api/admin/v1/users/${moderator.target.id}/suspend`,{method:'POST',headers:{origin:moderator.origin,cookie:moderator.cookie,'content-type':'application/json','x-csrf-token':moderator.csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({reason:'Motivo válido para comprobar jerarquía',duration:'1h'})});
  assert.equal(response.status,403);
  assert.equal((await response.json()).code,'hierarchy_denied');
});

test('operación sensible exige MFA reciente', async t => {
  const stale = await fixture(t, { mfaVerifiedAt:Date.now() - RECENT_AUTH_MS - 1000 });
  const response = await fetch(`${stale.origin}/test-recent`, {headers:{cookie:stale.cookie}});
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'recent_auth_required');
});
