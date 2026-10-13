'use strict';

const { makeAdminGuard } = require('./admin-auth-http');
const { PERMISSIONS } = require('./permissions');
const { requireIdempotency } = require('./idempotency-http');
const {
  SEASONAL_MONTHS,
  SEASONAL_PRESETS,
  SEASONAL_ANIMATIONS,
  normalizeSeasonalTheme,
  resolveSeasonalTheme
} = require('./seasonal-theme');

function asyncMiddleware(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function auditThemeData(theme) {
  const months = Array.isArray(theme?.months) ? theme.months : [];
  return {
    seasonalThemeEnabled: theme?.enabled === true,
    seasonalThemeMonthCount: months.length,
    seasonalThemeCalendar: months.map(item => `${item.month}:${item.presetId}:${item.animation}:${item.intensity}:${item.enabled ? 'on' : 'off'}`).join('|'),
    seasonalThemeStartAt: theme?.startAt || null,
    seasonalThemeEndAt: theme?.endAt || null
  };
}

function installSeasonalThemeRoutes(app, {
  config,
  getProfiles,
  getSessionStore,
  getCommunityStore,
  getAuditStore = () => null,
  getIdempotencyStore = () => null,
  onChanged = () => {}
}) {
  const { resolveAdmin, requirePermission, requireRecentAuth, requireTrustedWrite } = makeAdminGuard({ config, getProfiles, getSessionStore });
  const idempotentWrite = requireIdempotency(getIdempotencyStore);

  app.get('/api/seasonal-theme', asyncMiddleware(async (_req, res) => {
    const store = getCommunityStore();
    if (store?.ready) await store.ready;
    if (store?.refresh) await store.refresh();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.json(resolveSeasonalTheme(store.getState().seasonalTheme));
  }));

  app.get('/api/admin/v1/seasonal-theme', asyncMiddleware(resolveAdmin), requirePermission(PERMISSIONS.SEASONAL_THEME_MANAGE), asyncMiddleware(async (_req, res) => {
    const store = getCommunityStore();
    if (store?.ready) await store.ready;
    if (store?.refresh) await store.refresh();
    res.set('Cache-Control', 'no-store');
    const configuration = store.getState().seasonalTheme;
    const preview = resolveSeasonalTheme(configuration);
    res.json({
      ok: true,
      configuration,
      preview,
      calendarMonth: preview.calendarMonth,
      months: SEASONAL_MONTHS,
      presets: Object.values(SEASONAL_PRESETS),
      animations: SEASONAL_ANIMATIONS
    });
  }));

  app.put('/api/admin/v1/seasonal-theme',
    asyncMiddleware(resolveAdmin),
    requirePermission(PERMISSIONS.SEASONAL_THEME_MANAGE),
    requireRecentAuth,
    requireTrustedWrite,
    idempotentWrite,
    asyncMiddleware(async (req, res) => {
      const normalized = normalizeSeasonalTheme(req.body, { actorId: req.adminAuth.profile.id });
      if (!normalized.ok) return res.status(400).json({ ok: false, error: normalized.error });
      const store = getCommunityStore();
      if (store?.ready) await store.ready;
      if (store?.refresh) await store.refresh();
      const previous = structuredClone(store.getState().seasonalTheme);
      const outcome = await store.transact(state => {
        state.seasonalTheme = normalized.theme;
        return { ok: true, theme: normalized.theme };
      });
      const preview = resolveSeasonalTheme(outcome.theme);
      const audit = getAuditStore();
      if (audit) {
        await audit.append({
          actorProfileId: req.adminAuth.profile.id,
          actorRole: req.adminAuth.profile.role,
          action: 'seasonal_theme.updated',
          targetType: 'system_setting',
          targetId: 'seasonal-theme',
          beforeData: auditThemeData(previous),
          afterData: auditThemeData(normalized.theme),
          reason: `Calendario mensual ${normalized.theme.enabled ? 'activado' : 'actualizado'} con 12 diseños configurados.`
        });
      }
      onChanged(preview);
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, configuration: normalized.theme, preview });
    })
  );
}

module.exports = { installSeasonalThemeRoutes };
