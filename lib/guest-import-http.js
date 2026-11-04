'use strict';

const { publicProgress } = require('./progression');
const { csrfToken } = require('./account-auth-http');

function installGuestImportRoutes(app, { config, resolveSession, getDeviceLinks, getImportService, logEvent = () => {} }) {
  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  function available(res) {
    if (!config.accountSessionsEnabled) { res.status(404).json({ ok: false, error: 'No disponible.' }); return false; }
    return true;
  }
  async function identity(req, res) {
    const resolved = await resolveSession(req);
    if (!resolved?.profile?.username) { res.status(401).json({ ok: false, code: 'account_session_required', error: 'Inicia sesión con tu cuenta.' }); return null; }
    return resolved;
  }
  function tokenOf(req) { return String(req.get('x-device-token') || req.body?.deviceToken || '').slice(0, 80); }
  app.get('/api/account/guest-import', asyncRoute(async (req, res) => {
    if (!available(res)) return;
    res.set('Cache-Control', 'no-store');
    const resolved = await identity(req, res); if (!resolved) return;
    const service = getImportService();
    if (!service) return res.status(503).json({ ok: false, error: 'Importación no disponible.' });
    return res.json(service.inspect(resolved.profile.id, tokenOf(req)));
  }));
  app.post('/api/account/guest-import', asyncRoute(async (req, res) => {
    if (!available(res)) return;
    res.set('Cache-Control', 'no-store');
    const resolved = await identity(req, res); if (!resolved) return;
    if (req.get('origin') !== config.appOrigin) return res.status(403).json({ ok: false, error: 'Origen no permitido.' });
    const expected = csrfToken(resolved.session.id, config.sessionPepper);
    if (req.get('x-csrf-token') !== expected) return res.status(403).json({ ok: false, error: 'Validación CSRF fallida.' });
    if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: 'Confirma la vista previa antes de importar.' });
    const service = getImportService();
    if (!service) return res.status(503).json({ ok: false, error: 'Importación no disponible.' });
    const result = await service.import({ accountId: resolved.profile.id, guestToken: tokenOf(req), operationId: req.body.operationId, version: req.body.version });
    if (!result.ok) return res.status(409).json(result);
    logEvent('guest_import_http_confirmed', { profileId: resolved.profile.id, replayed: result.replayed });
    return res.json({ ok: true, replayed: result.replayed, profile: publicProgress(result.profile, true) });
  }));
  app.post('/api/auth/device-mode', asyncRoute(async (req, res) => {
    if (!available(res)) return;
    const resolved = await identity(req, res); if (!resolved) return;
    if (req.get('origin') !== config.appOrigin || req.get('x-csrf-token') !== csrfToken(resolved.session.id, config.sessionPepper)) return res.status(403).json({ ok: false, error: 'Validación CSRF fallida.' });
    const mode = req.body?.mode;
    if (!['account', 'guest'].includes(mode)) return res.status(400).json({ ok: false, error: 'Modo inválido.' });
    const link = await getDeviceLinks().set(tokenOf(req), resolved.profile.id, mode);
    return res.json({ ok: true, mode: link.mode });
  }));
}

module.exports = { installGuestImportRoutes };
