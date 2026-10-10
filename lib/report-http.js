'use strict';

const crypto = require('node:crypto');
const { COOKIE_NAME, parseCookies, csrfToken } = require('./account-auth-http');
const { sessionState } = require('./account-sessions');
const { FixedWindowRateLimiter } = require('./rate-limit');

function safe(a, b) {
  a = Buffer.from(String(a || ''));
  b = Buffer.from(String(b || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deviceHash(token, pepper) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(token || ''))) return null;
  return crypto.createHmac('sha256', Buffer.from(pepper, 'base64'))
    .update(`report-device:${token}`).digest('hex');
}

function installReportRoutes(app, { config, getProfiles, getSessionStore, getReportStore, findEvidence = () => null }) {
  const limiter = new FixedWindowRateLimiter({ limit: 3, windowMs: 10 * 60 * 1000 });
  app.use('/api/reports', require('express').json({ limit: '16kb' }));

  app.get('/api/reports/mine', async (req, res, next) => {
    try {
      if (!config.enabled) return res.status(404).json({ error: 'Reportes no disponibles.' });
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      const session = token && await getSessionStore().findByToken(token);
      const reporter = session && getProfiles().profiles.get(session.profileId);
      if (!reporter || !sessionState(session, { sessionVersion: reporter.security?.sessionVersion || 1 }).valid) {
        return res.status(401).json({ error: 'Sesión no válida.' });
      }
      const reports = await getReportStore().list({ reporterProfileId: reporter.id, limit: 50 });
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        reports: reports.map(report => ({
          id: report.id, category: report.category, status: report.status,
          createdAt: report.createdAt, updatedAt: report.updatedAt
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/reports', async (req, res, next) => {
    try {
      if (!config.enabled) return res.status(404).json({ error: 'Reportes no disponibles.' });
      if (req.get('origin') !== config.appOrigin) return res.status(403).json({ error: 'Origen no permitido.' });

      const hasMessageId = Object.prototype.hasOwnProperty.call(req.body || {}, 'messageId');
      let messageId = null;
      if (hasMessageId) {
        if (typeof req.body.messageId !== 'string') return res.status(400).json({ error: 'Identificador de mensaje inválido.' });
        messageId = req.body.messageId.trim();
        if (!messageId || messageId.length > 120) return res.status(400).json({ error: 'Identificador de mensaje inválido.' });
      }

      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      const session = token && await getSessionStore().findByToken(token);
      let reporter = session && getProfiles().profiles.get(session.profileId);
      if (reporter && !sessionState(session, { sessionVersion: reporter.security?.sessionVersion || 1 }).valid) reporter = null;

      let guestHash = null;
      if (reporter) {
        if (!safe(req.get('x-csrf-token'), csrfToken(session.id, config.sessionPepper))) {
          return res.status(403).json({ error: 'Validación CSRF fallida.' });
        }
      } else {
        if (!config.reportGuestEnabled) return res.status(401).json({ error: 'Inicia sesión para reportar.' });
        guestHash = deviceHash(req.get('x-device-token'), config.auditIpPepper);
        if (!guestHash) return res.status(401).json({ error: 'Identidad de dispositivo no válida.' });
        if (!messageId) return res.status(400).json({ error: 'Los invitados solo pueden reportar mensajes visibles.' });
      }

      const rateKeys = reporter
        ? [`account:${reporter.id}`]
        : [
            `device:${guestHash}`,
            `ip:${crypto.createHmac('sha256', Buffer.from(config.auditIpPepper, 'base64')).update(String(req.ip)).digest('hex')}`
          ];
      if (rateKeys.some(key => !limiter.consume(key).allowed)) {
        return res.status(429).json({ error: 'Has enviado demasiados reportes. Espera unos minutos.' });
      }

      let target;
      let evidence = null;
      if (messageId) {
        // La autoría se resuelve exclusivamente con el mensaje retenido por el
        // servidor; reportedUsername enviado por el cliente no interviene.
        evidence = await findEvidence(messageId);
        const authorProfileId = String(evidence?.authorProfileId || '');
        if (!evidence || !authorProfileId || String(evidence.messageId || messageId) !== messageId) {
          return res.status(400).json({ error: 'No se encontró evidencia válida para ese mensaje.' });
        }
        target = getProfiles().profiles.get(authorProfileId);
        if (!target || String(target.id) !== authorProfileId) {
          return res.status(404).json({ error: 'No se encontró el perfil del autor.' });
        }
      } else {
        target = await getProfiles().findByUsername(req.body?.reportedUsername);
        if (!target?.username) return res.status(404).json({ error: 'Usuario reportado no encontrado.' });
      }

      if (reporter && target.id === reporter.id) return res.status(400).json({ error: 'No puedes reportarte a ti mismo.' });

      const report = await getReportStore().create({
        reporterProfileId: reporter?.id || null,
        reporterDeviceHash: guestHash,
        reportedProfileId: target.id,
        category: req.body?.category,
        description: req.body?.description
      });
      if (evidence) {
        await getReportStore().addEvidence(report.id, 'chat_message', {
          messageId: String(evidence.messageId || messageId).slice(0, 120),
          authorProfileId: target.id,
          text: String(evidence.text || '').slice(0, 1000),
          time: Number.isFinite(Number(evidence.time)) ? Number(evidence.time) : null
        });
      }
      res.status(201).json({ ok: true, reportId: report.id, status: report.status });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { installReportRoutes, deviceHash };
