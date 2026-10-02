'use strict';

const crypto = require('node:crypto');
const { publicProgress } = require('./progression');
const { sessionPolicy, sessionState } = require('./account-sessions');
const { normalizeUsername } = require('./profile-store-shared');
const { FixedWindowRateLimiter } = require('./rate-limit');
const { verifyPassword } = require('./password');
const {
  beginEnrollment, decryptSecret, verifyTotp, generateRecoveryCodes, consumeRecoveryCode
} = require('./mfa');

const COOKIE_NAME = 'mc_session';

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    try { result[name] = decodeURIComponent(part.slice(separator + 1).trim()); } catch (_) { /* ignorar cookie inválida */ }
  }
  return result;
}

function cookieOptions(maxAge) {
  return { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge };
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
}

function csrfToken(sessionId, pepperBase64) {
  return crypto.createHmac('sha256', Buffer.from(pepperBase64, 'base64')).update(`csrf:${sessionId}`).digest('base64url');
}

function authState(profile, session) {
  const staff = profile.role === 'admin' || profile.role === 'moderator';
  return {
    staff,
    role: profile.role || 'user',
    mfaRequired: staff && (!profile.security?.mfaEnabled || !session?.mfaVerifiedAt),
    mfaEnrollmentRequired: staff && !profile.security?.mfaEnabled,
    mfaVerified: Boolean(staff && session?.mfaVerifiedAt)
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function installAccountAuthRoutes(app, { config, getProfiles, getSessionStore, getAuditStore = () => null, logEvent = () => {} }) {
  const ipLimiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 60 * 1000 });
  const accountLimiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 60 * 1000 });
  const mfaLimiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
  const auditStaffLogin = async (profile, action, req) => { if (!profile || !['admin','moderator'].includes(profile.role) || !getAuditStore()) return; const ipHash=config.auditIpPepper?crypto.createHmac('sha256',Buffer.from(config.auditIpPepper,'base64')).update(String(req.ip)).digest('hex'):null; await getAuditStore().append({actorProfileId:action==='admin.login_succeeded'?profile.id:null,actorRole:action==='admin.login_succeeded'?profile.role:'system',action,targetType:'profile',targetId:profile.id,ipHash,reason:action==='admin.login_succeeded'?'Inicio de sesión administrativo exitoso':'Intento administrativo rechazado'}); };
  // Se instala siempre para devolver un estado explícito mientras el rollout
  // está apagado. El parser queda limitado a esta API.
  app.use('/api/auth', require('express').json({ limit: '16kb', strict: true }));

  function requireFeature(_req, res, next) {
    if (!config.accountSessionsEnabled) return res.status(404).json({ error: 'Autenticación de sesión no disponible.' });
    next();
  }

  function requireTrustedOrigin(req, res, next) {
    if (req.get('origin') !== config.appOrigin) return res.status(403).json({ error: 'Origen no permitido.' });
    next();
  }

  async function resolveSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const store = getSessionStore();
    const session = await store.findByToken(token);
    if (!session) return null;
    const profile = getProfiles().profiles.get(session.profileId);
    if (!profile || !profile.username) return null;
    const state = sessionState(session, { sessionVersion: profile.security?.sessionVersion || 1 });
    if (!state.valid) return null;
    await store.touch(session.id, { role: profile.role || 'user' });
    return { session, profile };
  }

  function requireCsrf(resolved, req, res) {
    const supplied = req.get('x-csrf-token');
    const expected = csrfToken(resolved.session.id, config.sessionPepper);
    if (!safeEqual(supplied, expected)) {
      res.status(403).json({ error: 'Validación CSRF fallida.' });
      return false;
    }
    return true;
  }

  app.post('/api/auth/login', requireFeature, requireTrustedOrigin, asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    const limits = [ipLimiter.consume(`ip:${req.ip}`), accountLimiter.consume(`account:${normalizeUsername(username) || 'invalid'}`)];
    const denied = limits.find(result => !result.allowed);
    if (denied) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(denied.retryAfterMs / 1000))));
      return res.status(429).json({ error: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.' });
    }
    const result = getProfiles().authenticate(username, password);
    if (!result.ok) { await auditStaffLogin(getProfiles().findByUsername(username), 'admin.login_failed', req); return res.status(401).json({ error: result.error }); }
    const profile = result.profile;
    const store = getSessionStore();
    const issued = await store.issue({
      profileId: profile.id,
      sessionVersion: profile.security?.sessionVersion || 1,
      role: profile.role || 'user'
    });
    const policy = sessionPolicy(profile.role || 'user');
    res.cookie(COOKIE_NAME, issued.token, cookieOptions(policy.absoluteMs));
    res.set('Cache-Control', 'no-store');
    logEvent('account_session_created', { profileId: profile.id, sessionId: issued.session.id });
    await auditStaffLogin(profile, 'admin.login_succeeded', req);
    return res.json({
      ok: true,
      profile: publicProgress(profile, true),
      csrfToken: csrfToken(issued.session.id, config.sessionPepper),
      auth: authState(profile, issued.session)
    });
  }));

  app.get('/api/auth/session', requireFeature, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const resolved = await resolveSession(req);
    if (!resolved) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Sesión no válida.' });
    }
    return res.json({
      ok: true,
      profile: publicProgress(resolved.profile, true),
      csrfToken: csrfToken(resolved.session.id, config.sessionPepper),
      auth: authState(resolved.profile, resolved.session)
    });
  }));

  app.post('/api/auth/logout', requireFeature, requireTrustedOrigin, asyncRoute(async (req, res) => {
    const resolved = await resolveSession(req);
    if (resolved) {
      if (!requireCsrf(resolved, req, res)) return;
      await getSessionStore().revoke(resolved.session.id, 'logout');
      logEvent('account_session_revoked', { profileId: resolved.profile.id, sessionId: resolved.session.id, reason: 'logout' });
    }
    clearSessionCookie(res);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  }));

  app.post('/api/auth/mfa/enroll/start', requireFeature, requireTrustedOrigin, asyncRoute(async (req, res) => {
    if (!config.enabled) return res.status(404).json({ error: 'MFA no disponible.' });
    const resolved = await resolveSession(req);
    if (!resolved) return res.status(401).json({ error: 'Sesión no válida.' });
    if (!requireCsrf(resolved, req, res)) return;
    if (!['moderator', 'admin'].includes(resolved.profile.role)) return res.status(403).json({ error: 'MFA está reservado para personal.' });
    if (!verifyPassword(req.body?.currentPassword, resolved.profile.passwordHash)) {
      return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
    }
    const enrollment = await beginEnrollment(resolved.profile.username, config.mfaEncryptionKey);
    resolved.profile.security.mfaPendingSecretEncrypted = enrollment.encryptedSecret;
    getProfiles().touch(resolved.profile);
    logEvent('mfa_enrollment_started', { profileId: resolved.profile.id });
    return res.json({ ok: true, qrDataUrl: enrollment.qrDataUrl, manualKey: enrollment.manualKey });
  }));

  app.post('/api/auth/mfa/enroll/confirm', requireFeature, requireTrustedOrigin, asyncRoute(async (req, res) => {
    if (!config.enabled) return res.status(404).json({ error: 'MFA no disponible.' });
    const resolved = await resolveSession(req);
    if (!resolved) return res.status(401).json({ error: 'Sesión no válida.' });
    if (!requireCsrf(resolved, req, res)) return;
    const pending = resolved.profile.security?.mfaPendingSecretEncrypted;
    if (!pending) return res.status(400).json({ error: 'No hay un enrolamiento pendiente.' });
    const limit = mfaLimiter.consume(`enroll:${resolved.profile.id}`);
    if (!limit.allowed) return res.status(429).json({ error: 'Demasiados intentos MFA.' });
    const secret = decryptSecret(pending, config.mfaEncryptionKey);
    if (!verifyTotp(secret, req.body?.token)) return res.status(401).json({ error: 'Código MFA incorrecto.' });
    const recovery = generateRecoveryCodes(10, config.sessionPepper);
    resolved.profile.security.mfaSecretEncrypted = pending;
    resolved.profile.security.mfaPendingSecretEncrypted = null;
    resolved.profile.security.mfaEnabled = true;
    resolved.profile.security.mfaEnrolledAt = Date.now();
    resolved.profile.security.recoveryCodeHashes = recovery.hashes;
    getProfiles().touch(resolved.profile);
    await getSessionStore().revokeProfile(resolved.profile.id, 'mfa_enrolled', { exceptId: resolved.session.id });
    await getSessionStore().markMfaVerified(resolved.session.id);
    logEvent('mfa_enrolled', { profileId: resolved.profile.id, recoveryCodes: recovery.codes.length });
    return res.json({ ok: true, recoveryCodes: recovery.codes });
  }));

  app.post('/api/auth/mfa/verify', requireFeature, requireTrustedOrigin, asyncRoute(async (req, res) => {
    if (!config.enabled) return res.status(404).json({ error: 'MFA no disponible.' });
    const resolved = await resolveSession(req);
    if (!resolved) return res.status(401).json({ error: 'Sesión no válida.' });
    if (!requireCsrf(resolved, req, res)) return;
    if (!['moderator', 'admin'].includes(resolved.profile.role) || !resolved.profile.security?.mfaEnabled) {
      return res.status(403).json({ error: 'MFA no está configurado.' });
    }
    const limit = mfaLimiter.consume(`verify:${resolved.profile.id}`);
    if (!limit.allowed) return res.status(429).json({ error: 'Demasiados intentos MFA.' });
    let valid = false;
    if (req.body?.recoveryCode) {
      const consumed = consumeRecoveryCode(resolved.profile.security.recoveryCodeHashes, req.body.recoveryCode, config.sessionPepper);
      valid = consumed.valid;
      if (valid) {
        resolved.profile.security.recoveryCodeHashes = consumed.hashes;
        getProfiles().touch(resolved.profile);
      }
    } else {
      const secret = decryptSecret(resolved.profile.security.mfaSecretEncrypted, config.mfaEncryptionKey);
      valid = verifyTotp(secret, req.body?.token);
    }
    if (!valid) return res.status(401).json({ error: 'Código MFA incorrecto.' });
    await getSessionStore().markMfaVerified(resolved.session.id);
    logEvent('mfa_verified', { profileId: resolved.profile.id, recovery: Boolean(req.body?.recoveryCode) });
    return res.json({ ok: true, auth: { ...authState(resolved.profile, { ...resolved.session, mfaVerifiedAt: Date.now() }) } });
  }));

  app.post('/api/auth/change-password', requireFeature, requireTrustedOrigin, asyncRoute(async (req, res) => {
    const resolved = await resolveSession(req);
    if (!resolved) return res.status(401).json({ error: 'Sesión no válida.' });
    if (!requireCsrf(resolved, req, res)) return;
    const { currentPassword, newPassword } = req.body || {};
    const changed = getProfiles().changePassword(resolved.profile, currentPassword, newPassword);
    if (!changed.ok) return res.status(400).json({ error: changed.error });

    const store = getSessionStore();
    const revoked = await store.revokeProfile(resolved.profile.id, 'password_changed');
    const issued = await store.issue({
      profileId: resolved.profile.id,
      sessionVersion: resolved.profile.security.sessionVersion,
      role: resolved.profile.role || 'user'
    });
    const policy = sessionPolicy(resolved.profile.role || 'user');
    res.cookie(COOKIE_NAME, issued.token, cookieOptions(policy.absoluteMs));
    res.set('Cache-Control', 'no-store');
    logEvent('account_password_changed', { profileId: resolved.profile.id, revokedSessions: revoked });
    return res.json({
      ok: true,
      profile: publicProgress(resolved.profile, true),
      csrfToken: csrfToken(issued.session.id, config.sessionPepper)
    });
  }));

  app.post('/api/auth/logout-all', requireFeature, requireTrustedOrigin, asyncRoute(async (req, res) => {
    const resolved = await resolveSession(req);
    if (!resolved) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Sesión no válida.' });
    }
    if (!requireCsrf(resolved, req, res)) return;
    const count = await getSessionStore().revokeProfile(resolved.profile.id, 'logout_all');
    clearSessionCookie(res);
    res.set('Cache-Control', 'no-store');
    logEvent('account_sessions_revoked', { profileId: resolved.profile.id, count, reason: 'logout_all' });
    return res.json({ ok: true, revoked: count });
  }));

  return { resolveSession };
}

module.exports = { COOKIE_NAME, parseCookies, cookieOptions, csrfToken, installAccountAuthRoutes };
