'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { COOKIE_NAME, parseCookies, csrfToken } = require('./account-auth-http');
const { sessionState } = require('./account-sessions');
const { hasPermission, canModerate, PERMISSIONS } = require('./permissions');
const { applyModeration } = require('./moderation');
const { requireIdempotency } = require('./idempotency-http');

const RECENT_AUTH_MS = 10 * 60 * 1000;

function asyncMiddleware(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Fase E4b — Fábrica de la guardia de administración, reutilizable fuera del panel
// del casino. server.js la usa para proteger las palancas operativas del Estadio
// (/admin/estadio/*) con EXACTAMENTE la misma disciplina que /api/admin: sesión staff
// válida (rol + MFA), permiso concreto, MFA reciente y escritura de confianza (origen
// + CSRF). Devuelve los middlewares por separado y `fullGuard(permission)`, que los
// encadena en el orden correcto en un solo middleware inyectable.
function makeAdminGuard({ config, getProfiles, getSessionStore }) {
  async function resolveAdmin(req, res, next) {
    if (!config.enabled) return res.status(404).json({ error: 'Administración no disponible.' });
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = token ? await getSessionStore().findByToken(token) : null;
    const profile = session ? getProfiles().profiles.get(session.profileId) : null;
    const state = profile && sessionState(session, { sessionVersion: profile.security?.sessionVersion || 1 });
    if (!profile?.username || !state?.valid) return res.status(401).json({ error: 'Sesión no válida.', code: 'session_required' });
    if (!['moderator', 'admin'].includes(profile.role)) return res.status(403).json({ error: 'Acceso restringido.', code: 'staff_required' });
    if (!profile.security?.mfaEnabled) return res.status(403).json({ error: 'Debes configurar MFA.', code: 'mfa_enrollment_required' });
    if (!session.mfaVerifiedAt) return res.status(403).json({ error: 'Debes verificar MFA.', code: 'mfa_required' });
    req.adminAuth = { profile, session };
    await getSessionStore().touch(session.id, { role: profile.role });
    next();
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      if (!req.adminAuth || !hasPermission(req.adminAuth.profile.role, permission)) {
        return res.status(403).json({ error: 'Permiso insuficiente.', code: 'permission_denied' });
      }
      next();
    };
  }

  function requireRecentAuth(req, res, next) {
    const verifiedAt = Number(req.adminAuth?.session?.mfaVerifiedAt) || 0;
    if (Date.now() - verifiedAt > RECENT_AUTH_MS) {
      return res.status(403).json({ error: 'Vuelve a verificar MFA para continuar.', code: 'recent_auth_required' });
    }
    next();
  }

  function requireTrustedWrite(req, res, next) {
    if (req.get('origin') !== config.appOrigin) return res.status(403).json({ error: 'Origen no permitido.', code: 'origin_denied' });
    const expected = csrfToken(req.adminAuth.session.id, config.sessionPepper);
    const supplied = String(req.get('x-csrf-token') || '');
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      return res.status(403).json({ error: 'Validación CSRF fallida.', code: 'csrf_denied' });
    }
    next();
  }

  // Middleware único: sesión → permiso → MFA reciente → CSRF/origen, en orden.
  function fullGuard(permission) {
    const steps = [resolveAdmin, requirePermission(permission), requireRecentAuth, requireTrustedWrite];
    return function guard(req, res, next) {
      let index = 0;
      const step = () => {
        const mw = steps[index++];
        if (!mw) return next();
        return mw(req, res, step);
      };
      step();
    };
  }

  return { resolveAdmin, requirePermission, requireRecentAuth, requireTrustedWrite, fullGuard };
}

function installAdminRoutes(app, {
  config, getProfiles, getSessionStore, getAuditStore = () => null,
  getModerationStore = () => null, getReportStore = () => null, getPasswordResetStore = () => null, getIdempotencyStore = () => null, onModerated = async () => {}
}) {
  const idempotentWrite = requireIdempotency(getIdempotencyStore);
  app.get('/admin', (_req, res) => {
    if (!config.enabled) return res.status(404).send('Not found');
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    });
    return res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  const { resolveAdmin, requirePermission, requireRecentAuth, requireTrustedWrite } = makeAdminGuard({ config, getProfiles, getSessionStore });

  app.use('/api/admin', require('express').json({ limit: '16kb', strict: true }));
  app.use('/api/admin', (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });

  app.get('/api/admin/v1/me', asyncMiddleware(resolveAdmin), (req, res) => {
    const { profile, session } = req.adminAuth;
    res.json({
      ok: true,
      staff: {
        id: profile.id,
        username: profile.username,
        name: profile.name,
        role: profile.role,
        mfaVerifiedAt: session.mfaVerifiedAt
      }
    });
  });

  app.post('/api/admin/v1/users/:id/mfa-reset',
    asyncMiddleware(resolveAdmin), requirePermission(PERMISSIONS.MFA_RESET), requireRecentAuth,
    requireTrustedWrite, idempotentWrite, asyncMiddleware(async (req, res) => {
      const actor = req.adminAuth.profile;
      const target = getProfiles().profiles.get(String(req.params.id || '').slice(0, 80));
      const reason = String(req.body?.reason || '').trim();
      if (!target?.username) return res.status(404).json({ error: 'Cuenta no encontrada.' });
      if (target.id === actor.id) return res.status(400).json({ error: 'No puedes restablecer tu propio MFA.', code: 'self_action_denied' });
      if (!['moderator', 'admin'].includes(target.role)) return res.status(400).json({ error: 'La cuenta no pertenece al personal.' });
      if (reason.length < 10 || reason.length > 500) return res.status(400).json({ error: 'El motivo debe tener entre 10 y 500 caracteres.' });

      const previousSecurity = structuredClone(target.security || {});
      const beforeData = { role: target.role, mfaEnabled: Boolean(previousSecurity.mfaEnabled), sessionVersion: previousSecurity.sessionVersion || 1 };
      target.security = target.security || {};
      target.security.mfaEnabled = false;
      target.security.mfaSecretEncrypted = null;
      target.security.mfaPendingSecretEncrypted = null;
      target.security.recoveryCodeHashes = [];
      target.security.mfaEnrolledAt = null;
      target.security.sessionVersion = beforeData.sessionVersion + 1;
      target.updatedAt=Date.now();
      const afterData = { role: target.role, mfaEnabled: false, sessionVersion: target.security.sessionVersion };

      const auditInput={actorProfileId:actor.id,actorRole:actor.role,action:'mfa.reset',targetType:'profile',targetId:target.id,beforeData,afterData,reason};
      try {
        if(typeof getProfiles().applyMfaResetAtomic==='function'){const result=await getProfiles().applyMfaResetAtomic({profile:target,audit:auditInput,idempotency:req.idempotency});req.idempotency.completed=true;return res.json(result.responseBody);}
        const audit=await getAuditStore().append(auditInput);getProfiles().touch(target);await getSessionStore().revokeProfile(target.id,'mfa_reset');return res.json({ok:true,requestId:audit.requestId,target:{id:target.id,username:target.username}});
      } catch (error) { target.security=previousSecurity; throw error; }
    })
  );

  app.post('/api/admin/v1/users/:id/password-reset', asyncMiddleware(resolveAdmin), requirePermission(PERMISSIONS.PASSWORD_RESET), requireTrustedWrite, idempotentWrite, asyncMiddleware(async(req,res)=>{
    const actor=req.adminAuth.profile,target=getProfiles().profiles.get(String(req.params.id));
    if(!target?.username)return res.status(404).json({error:'Cuenta no encontrada.'});
    if(!canModerate(actor,target,PERMISSIONS.PASSWORD_RESET))return res.status(403).json({error:'No puedes restablecer esta cuenta.',code:'target_not_allowed'});
    const reason=String(req.body?.reason||'').trim();if(reason.length<10||reason.length>500)return res.status(400).json({error:'Motivo obligatorio entre 10 y 500 caracteres.'});
    const store=getPasswordResetStore(),auditFactory=challenge=>({actorProfileId:actor.id,actorRole:actor.role,action:'password_reset.created',targetType:'profile',targetId:target.id,beforeData:null,afterData:{challengeId:challenge.id,expiresAt:challenge.expiresAt},reason}),responseFactory=(token,challenge)=>({ok:true,expiresAt:challenge.expiresAt,resetUrl:`${config.appOrigin}/reset-password#token=${token}`});let issued,responseBody;if(typeof store.createWithAudit==='function'){issued=await store.createWithAudit(target.id,actor.id,reason,auditFactory,responseFactory,req.idempotency);req.idempotency.completed=true;responseBody=issued.responseBody;}else{issued=await store.create(target.id,actor.id,reason);await getAuditStore().append(auditFactory(issued.challenge));responseBody=responseFactory(issued.token,issued.challenge);}res.set('Cache-Control','no-store');res.status(201).json(responseBody);
  }));

  app.get('/api/admin/v1/reports', asyncMiddleware(resolveAdmin), requirePermission(PERMISSIONS.REPORT_READ_ASSIGNED), asyncMiddleware(async(req,res)=>{
    const reports=await getReportStore().list({status:req.query.status||undefined,limit:Math.min(100,Number(req.query.limit)||50)});
    res.json({ok:true,reports});
  }));
  app.get('/api/admin/v1/reports/:id', asyncMiddleware(resolveAdmin), requirePermission(PERMISSIONS.REPORT_READ_ASSIGNED), asyncMiddleware(async(req,res)=>{
    const report=await getReportStore().get(req.params.id);if(!report)return res.status(404).json({error:'Reporte no encontrado.'});
    const evidence=await getReportStore().evidenceFor(report.id);await getAuditStore().append({actorProfileId:req.adminAuth.profile.id,actorRole:req.adminAuth.profile.role,action:'report.evidence_read',targetType:'report',targetId:report.id,beforeData:null,afterData:{reportId:report.id,evidenceCount:evidence.length},reason:'Consulta de evidencia para investigación'});res.set('Cache-Control','no-store');res.json({ok:true,report,evidence});
  }));
  app.patch('/api/admin/v1/reports/:id', asyncMiddleware(resolveAdmin), requirePermission(PERMISSIONS.REPORT_RESOLVE), requireTrustedWrite, idempotentWrite, asyncMiddleware(async(req,res)=>{
    try{const store=getReportStore(),changes={status:req.body?.status,priority:req.body?.priority,assignedTo:req.body?.assignedTo,resolution:req.body?.resolution},version=Number(req.body?.version),auditFactory=(report,before)=>({actorProfileId:req.adminAuth.profile.id,actorRole:req.adminAuth.profile.role,action:'report.updated',targetType:'report',targetId:report.id,beforeData:{reportId:report.id,status:before?.status},afterData:{reportId:report.id,status:report.status},reason:req.body?.resolution||'Actualización de flujo del reporte'});const atomic=typeof store.updateWithAudit==='function',report=atomic?await store.updateWithAudit(req.params.id,changes,version,auditFactory,req.idempotency):await store.update(req.params.id,changes,version);if(atomic&&report)req.idempotency.completed=true;if(!report)return res.status(404).json({error:'Reporte no encontrado.'});if(typeof store.updateWithAudit!=='function')await getAuditStore().append(auditFactory(report));res.json({ok:true,report});}catch(error){if(error.code==='VERSION_CONFLICT')return res.status(409).json({error:'El reporte fue modificado por otra persona.',code:'version_conflict'});throw error;}
  }));

  app.get('/api/admin/v1/users', asyncMiddleware(resolveAdmin),
    requirePermission(PERMISSIONS.REPORT_READ_ASSIGNED), (req,res)=>{
      const query=String(req.query.query||'').trim().toLocaleLowerCase('es-MX').slice(0,40);
      if(query.length<2)return res.status(400).json({error:'Escribe al menos 2 caracteres.'});
      const limit=Math.min(50,Math.max(1,Number(req.query.limit)||20));
      const users=[...getProfiles().profiles.values()]
        .filter(profile=>profile.username&&(`${profile.username} ${profile.name}`.toLocaleLowerCase('es-MX').includes(query)))
        .sort((a,b)=>String(a.username).localeCompare(String(b.username))).slice(0,limit)
        .map(profile=>({id:profile.id,username:profile.username,name:profile.name,role:profile.role||'user',status:profile.moderation?.status||'active',until:profile.moderation?.until||null}));
      res.json({ok:true,users});
    });

  app.get('/api/admin/v1/users/:id', asyncMiddleware(resolveAdmin),
    requirePermission(PERMISSIONS.REPORT_READ_ASSIGNED), asyncMiddleware(async(req,res)=>{
      const profile=getProfiles().profiles.get(String(req.params.id||'').slice(0,80));
      if(!profile?.username)return res.status(404).json({error:'Cuenta no encontrada.'});
      const actions=await getModerationStore().forProfile(profile.id);
      res.json({ok:true,user:{id:profile.id,username:profile.username,name:profile.name,role:profile.role||'user',status:profile.moderation?.status||'active',until:profile.moderation?.until||null,createdAt:profile.createdAt,updatedAt:profile.updatedAt},actions});
    }));

  function registerModerationRoute(pathSuffix, type, permission) {
    app.post(`/api/admin/v1/users/:id/${pathSuffix}`,
      asyncMiddleware(resolveAdmin), requirePermission(permission), requireRecentAuth,
      requireTrustedWrite, idempotentWrite, asyncMiddleware(async (req, res) => {
        const actor = req.adminAuth.profile;
        const target = getProfiles().profiles.get(String(req.params.id || '').slice(0, 80));
        if (!target?.username) return res.status(404).json({ error: 'Cuenta no encontrada.' });
        if (!canModerate(actor, target, permission)) return res.status(403).json({ error: 'No puedes moderar esta cuenta.', code: 'hierarchy_denied' });
        if (type === 'unban' && target.moderation?.status === 'active') return res.status(400).json({ error: 'La cuenta ya está activa.' });
        const previous = { moderation: structuredClone(target.moderation || { status:'active' }), security: structuredClone(target.security || {}) };
        let state;
        try {
          state = applyModeration(target, { type, reason:req.body?.reason, duration:req.body?.duration });
          target.updatedAt=state.updatedAt;
          const actionInput={id:state.actionId,targetProfileId:target.id,actorProfileId:actor.id,type:type==='suspend'?'suspension':type,reason:state.reason,startsAt:state.updatedAt,endsAt:state.until,metadata:{previousStatus:previous.moderation.status}};
          const auditInput={actorProfileId:actor.id,actorRole:actor.role,action:`moderation.${type}`,targetType:'profile',targetId:target.id,beforeData:{role:target.role,status:previous.moderation.status,until:previous.moderation.until,sessionVersion:previous.security.sessionVersion||1},afterData:{role:target.role,status:state.status,until:state.until,sessionVersion:target.security.sessionVersion},reason:state.reason};
          let action;
          if(typeof getModerationStore().applyAtomic==='function')action=await getModerationStore().applyAtomic({action:actionInput,audit:auditInput,profile:target,revokeReason:`moderation_${type}`,idempotency:req.idempotency});
          if(typeof getModerationStore().applyAtomic==='function')req.idempotency.completed=true;
          else{action=await getModerationStore().append(actionInput);await getAuditStore().append(auditInput);getProfiles().touch(target);await getSessionStore().revokeProfile(target.id,`moderation_${type}`);}
          await onModerated(target, state);
          return res.json({ok:true,actionId:action.id,target:{id:target.id,username:target.username,status:state.status,until:state.until}});
        } catch (error) {
          target.moderation=previous.moderation; target.security=previous.security;
          throw error;
        }
      })
    );
  }
  registerModerationRoute('suspend','suspend',PERMISSIONS.USER_SUSPEND);
  registerModerationRoute('ban','ban',PERMISSIONS.USER_BAN);
  registerModerationRoute('unban','unban',PERMISSIONS.USER_UNBAN);

  app.get('/api/admin/v1/users/:id/moderation', asyncMiddleware(resolveAdmin),
    requirePermission(PERMISSIONS.REPORT_READ_ASSIGNED), asyncMiddleware(async(req,res)=>{
      const target=getProfiles().profiles.get(String(req.params.id||'').slice(0,80));
      if(!target?.username)return res.status(404).json({error:'Cuenta no encontrada.'});
      const actions=await getModerationStore().forProfile(target.id);
      res.json({ok:true,target:{id:target.id,username:target.username,status:target.moderation?.status||'active',until:target.moderation?.until||null},actions});
    }));

  return {
    resolveAdmin: asyncMiddleware(resolveAdmin),
    requirePermission,
    requireRecentAuth
  };
}

module.exports = { installAdminRoutes, makeAdminGuard, RECENT_AUTH_MS };
