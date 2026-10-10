'use strict';

// Fase E2/E4 — Rutas HTTP del Estadio (§14.3).
//
// installFootballRoutes: página propia + API pública de lectura (sin socket),
//   para la primera pintura y para reconexiones. DEBE registrarse ANTES del
//   catch-all `app.get('*')` de server.js (igual que `/terminos`).
// installFootballAdminRoutes: palancas operativas tras ADMIN_FEATURE_ENABLED y
//   una guardia admin inyectada (fail-closed, fiel a lib/admin-config.js).
// footballHealth: bloque `football` de /healthz (§15.8), nunca lanza.
//
// Las deps se leen en DIFERIDO (deps.X dentro de cada handler), no al registrar:
// server.js declara las rutas en carga de módulo (antes del catch-all) pero crea
// los servicios en bootstrap(). Es el mismo patrón de getters que usa el casino
// (getProfiles: () => profiles). Así el objeto de deps puede rellenarse después.
//
// Identidad HTTP (A11 también aquí): NINGUNA ruta crea perfiles. El token opcional
// se resuelve con profiles.getProfile (estricto); si no existe, se trata como
// anónimo. getOrCreate vive únicamente en football:subscribe (sockets.js).

const path = require('path');
const crypto = require('node:crypto');
const { publicTeams } = require('./sockets');
const { debit } = require('../progression');
const { HISTORY_LIMITS } = require('../profile-store-shared');
const { csrfToken } = require('../account-auth-http');
const { requireIdempotency } = require('../idempotency-http');
const {
  PROMOTION_FEE, PROMOTION_ROTATION_MS,
  normalizePromotionText, normalizePromotionPath, cleanPromotions,
  isPreshowWindow, selectRotatingPromotion, publicPromotion
} = require('./promotions');

// Claves de mercado pre-partido (espejo de odds.buildPreMatchMarkets). Se usan
// para suspender todos los mercados de un partido desde la palanca admin.
const MARKET_KEYS = [
  '1x2', 'double_chance', 'handicap_home_minus1', 'handicap_home_plus1',
  'over_under_1.5', 'over_under_2.5', 'over_under_3.5', 'btts', 'correct_score',
  'win_to_nil_home', 'win_to_nil_away',
  'team_total_home_0.5', 'team_total_home_1.5', 'team_total_away_0.5', 'team_total_away_1.5'
];

// Resuelve el perfil de un token opcional SIN crearlo nunca (lectura estricta).
function tokenProfileId(req, profiles) {
  const raw = req && req.query ? req.query.token : null;
  if (!raw || !profiles) return null;
  const profile = profiles.getProfile(String(raw).slice(0, 80));
  return profile ? profile.id : null;
}

// Proyección pública de un perfil (nunca flags/seguridad/transacciones).
function publicProfile(profile) {
  if (!profile) return null;
  return { id: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function promotionSummary(promotion) {
  if (!promotion) return null;
  return {
    id: promotion.id,
    matchId: promotion.matchId,
    text: promotion.text,
    targetPath: promotion.targetPath,
    status: promotion.status,
    createdAt: promotion.createdAt,
    reviewedAt: promotion.reviewedAt || null,
    reviewReason: promotion.reviewReason || null,
    chargedAmount: promotion.chargedAmount || 0
  };
}

function installFootballRoutes(app, deps) {
  const d = deps || {};
  const isEnabled = () => (typeof d.enabled === 'function' ? d.enabled() : true);
  const log = (event, data) => { if (typeof d.log === 'function') d.log(event, data); };
  const unavailable = (res) => res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
  const publicDir = () => d.publicDir || path.join(__dirname, '..', '..', 'public');
  const promotionsEnabled = () => isEnabled() && (typeof d.promotionsEnabled === 'function' ? d.promotionsEnabled() : false);

  async function resolveLinkedProfile(req, res, { write = false } = {}) {
    const auth = typeof d.getAccountAuth === 'function' ? d.getAccountAuth() : d.accountAuth;
    const config = d.accountConfig;
    if (!promotionsEnabled() || !config?.accountSessionsEnabled || !auth?.resolveSession) {
      res.status(404).json({ ok: false, error: 'Promociones no disponibles.' });
      return null;
    }
    const resolved = await auth.resolveSession(req);
    if (!resolved?.profile?.username) {
      res.status(401).json({ ok: false, error: 'Inicia sesión con una cuenta vinculada.', code: 'account_session_required' });
      return null;
    }
    if (write) {
      if (req.get('origin') !== config.appOrigin) {
        res.status(403).json({ ok: false, error: 'Origen no permitido.', code: 'origin_denied' });
        return null;
      }
      const expected = csrfToken(resolved.session.id, config.sessionPepper);
      if (!safeEqual(req.get('x-csrf-token'), expected)) {
        res.status(403).json({ ok: false, error: 'Validación CSRF fallida.', code: 'csrf_denied' });
        return null;
      }
    }
    return resolved;
  }

  // GET /estadio — página propia de la sección (antes del catch-all).
  app.get('/estadio', (_req, res) => {
    if (!isEnabled()) return res.status(404).send('Not found');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(publicDir(), 'estadio.html'));
  });

  // GET /api/estadio/state — instantánea de lobby sin socket.
  app.get('/api/estadio/state', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    try {
      const profileId = tokenProfileId(req, d.profiles);
      return res.json({
        ok: true,
        teams: publicTeams(),
        lobby: d.buildLobby ? d.buildLobby() : null,
        profile: publicProfile(profileId && d.profiles ? d.profiles.getProfile(profileId) : null),
        tosVersion: (d.config && d.config.tosVersion) || null
      });
    } catch (error) {
      log('football_http_error', { route: 'state', message: String(error && error.message || error) });
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  // GET /api/estadio/matches/:id — estado revelado + mercados (+ apuestas propias
  // si hay token). Misma garantía de privacidad que el socket: solo lo revelado.
  app.get('/api/estadio/matches/:id', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    const id = String(req.params.id || '').slice(0, 80);
    const match = d.store ? d.store.getMatch(id) : null;
    if (!match) return res.status(404).json({ ok: false, error: 'no_match' });
    try {
      const profileId = tokenProfileId(req, d.profiles);
      return res.json({ ok: true, matchState: d.buildMatchState ? d.buildMatchState(id, profileId) : null });
    } catch (error) {
      log('football_http_error', { route: 'match', message: String(error && error.message || error) });
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  // GET /api/estadio/promotions/:matchId — una sola creatividad de texto por
  // llamada; el servidor elige la campaña aprobada según el bucket de rotación.
  app.get('/api/estadio/promotions/:matchId', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const matchId = String(req.params.matchId || '').slice(0, 80);
    const match = d.store ? d.store.getMatch(matchId) : null;
    const now = typeof d.now === 'function' ? d.now() : Date.now();
    if (!match || !isPreshowWindow(match, now) || !d.profiles) {
      return res.json({ ok: true, promotion: null, rotationIntervalMs: PROMOTION_ROTATION_MS });
    }
    const promotions = [];
    for (const profile of d.profiles.profiles.values()) {
      for (const item of profile.promotions || []) {
        if (item.matchId === matchId && item.status === 'approved') promotions.push(item);
      }
    }
    const selected = selectRotatingPromotion(promotions, now);
    return res.json({ ok: true, promotion: publicPromotion(selected), rotationIntervalMs: PROMOTION_ROTATION_MS });
  });

  // Estado privado del envío propio: nunca se devuelve al público ni se leen
  // campañas ajenas desde una cookie inválida.
  app.get('/api/estadio/promotions/:matchId/mine', asyncRoute(async (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const resolved = await resolveLinkedProfile(req, res);
    if (!resolved) return undefined;
    const matchId = String(req.params.matchId || '').slice(0, 80);
    const promotions = cleanPromotions(resolved.profile.promotions)
      .filter(item => item.matchId === matchId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return res.json({ ok: true, promotion: promotionSummary(promotions[0] || null) });
  }));

  // El envío solo crea una revisión pendiente. Las fichas se debitan en la
  // ruta administrativa, dentro de la aprobación, nunca aquí.
  app.post('/api/estadio/promotions', asyncRoute(async (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const resolved = await resolveLinkedProfile(req, res, { write: true });
    if (!resolved) return undefined;
    if (!d.store || !d.profiles) return unavailable(res);

    const matchId = String(req.body?.matchId || '').trim().slice(0, 80);
    const match = d.store.getMatch(matchId);
    const now = typeof d.now === 'function' ? d.now() : Date.now();
    if (!match || !isPreshowWindow(match, now)) {
      return res.status(409).json({ ok: false, error: 'Solo se puede enviar durante los últimos 30 minutos previos al kickoff.', code: 'preshow_window_closed' });
    }

    const text = normalizePromotionText(req.body?.text);
    const targetPath = normalizePromotionPath(req.body?.targetPath);
    if (!text || !targetPath) {
      return res.status(400).json({ ok: false, error: 'Escribe un texto de 3 a 140 caracteres y elige un enlace interno permitido.', code: 'invalid_promotion' });
    }

    const profile = resolved.profile;
    profile.promotions = cleanPromotions(profile.promotions);
    const previous = profile.promotions.filter(item => item.matchId === matchId);
    const active = previous.find(item => item.status === 'pending' || item.status === 'approved');
    if (active?.status === 'pending') {
      return res.json({ ok: true, promotion: promotionSummary(active), fee: PROMOTION_FEE, charged: false, replayed: true });
    }
    if (active?.status === 'approved') {
      return res.status(409).json({ ok: false, error: 'Ya tienes una promoción aprobada para este partido.', code: 'promotion_already_approved' });
    }
    if (previous.length >= 3) {
      return res.status(429).json({ ok: false, error: 'Ya se alcanzó el máximo de envíos para este partido.', code: 'promotion_attempt_limit' });
    }

    const promotion = {
      id: crypto.randomUUID(), matchId, text, targetPath, status: 'pending', createdAt: now,
      reviewedAt: null, reviewedBy: null, reviewReason: null, chargedAmount: 0
    };
    const priorPromotions = profile.promotions;
    profile.promotions = cleanPromotions([...priorPromotions, promotion]);
    d.profiles.touch(profile);
    try {
      if (typeof d.profiles.saveNow === 'function') await d.profiles.saveNow();
    } catch (error) {
      profile.promotions = priorPromotions;
      d.profiles.touch(profile);
      throw error;
    }
    log('football_promotion_submitted', { profileId: profile.id, promotionId: promotion.id, matchId });
    return res.status(201).json({ ok: true, promotion: promotionSummary(promotion), fee: PROMOTION_FEE, charged: false });
  }));

  // GET /api/estadio/standings — tabla de la temporada en curso.
  app.get('/api/estadio/standings', (_req, res) => {
    if (!isEnabled()) return unavailable(res);
    if (!d.store) return unavailable(res);
    const month = d.store.getCurrentSeasonMonth();
    return res.json({ ok: true, seasonMonth: month, standings: d.store.getStandings(month) });
  });
}

// Palancas operativas. `guard` es el middleware de autenticación admin (sesión +
// rol + MFA + CSRF) que server.js inyecta en la integración; aquí solo se aplica.
// Todo queda 404 con ADMIN_FEATURE_ENABLED apagado (fail-closed).
function installFootballAdminRoutes(app, deps) {
  const d = deps || {};
  const log = (event, data) => { if (typeof d.log === 'function') d.log(event, data); };
  const audit = (type, data) => { if (typeof d.audit === 'function') d.audit(type, data); };
  const nowMs = () => (typeof d.now === 'function' ? d.now() : Date.now());
  const guard = typeof d.guard === 'function' ? d.guard : (_req, _res, next) => next();
  const readGuard = typeof d.readGuard === 'function' ? d.readGuard : guard;
  const idempotentWrite = typeof d.getIdempotencyStore === 'function'
    ? requireIdempotency(d.getIdempotencyStore)
    : (_req, _res, next) => next();

  function gate(req, res, next) {
    if (!d.adminConfig || !d.adminConfig.enabled) return res.status(404).json({ error: 'Administración no disponible.' });
    return guard(req, res, next);
  }
  function readGate(req, res, next) {
    if (!d.adminConfig || !d.adminConfig.enabled) return res.status(404).json({ error: 'Administración no disponible.' });
    return readGuard(req, res, next);
  }
  function getMatch(req, res) {
    const id = String(req.params.id || req.params.matchId || '').slice(0, 80);
    const match = d.store ? d.store.getMatch(id) : null;
    if (!match) { res.status(404).json({ ok: false, error: 'no_match' }); return null; }
    return match;
  }
  const who = (req) => (req.adminAuth && req.adminAuth.profile ? req.adminAuth.profile.id : 'admin');

  // Bandeja de revisión de promociones. Para lecturas basta sesión staff + permiso;
  // aprobar/rechazar sí exige MFA reciente, origen/CSRF e idempotencia.
  app.get('/admin/estadio/promotions', readGate, (req, res) => {
    const profiles = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
    if (!d.store || !profiles?.profiles) return res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
    const now = nowMs();
    const promotions = [];
    for (const profile of profiles.profiles.values()) {
      for (const promotion of cleanPromotions(profile.promotions)) {
        if (promotion.status !== 'pending') continue;
        const match = d.store.getMatch(promotion.matchId);
        const windowOpen = isPreshowWindow(match, now);
        promotions.push({
          ...promotionSummary(promotion),
          profileId: profile.id,
          username: profile.username,
          profileName: profile.name,
          match: match ? {
            id: match.id, homeId: match.homeId, awayId: match.awayId,
            scheduledKickoffAt: match.scheduledKickoffAt
          } : null,
          canApprove: windowOpen,
          unavailableReason: windowOpen ? null : 'La ventana T−30 está cerrada o el partido ya no está programado.'
        });
      }
    }
    promotions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, promotions: promotions.slice(0, 200), fee: PROMOTION_FEE });
  });

  app.post('/admin/estadio/promotions/:profileId/:promotionId/review', gate, idempotentWrite, asyncRoute(async (req, res) => {
    const profiles = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
    if (!profiles?.profiles || !d.store) return res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
    const profileId = String(req.params.profileId || '').slice(0, 80);
    const promotionId = String(req.params.promotionId || '').slice(0, 80);
    const profile = profiles.getProfile ? profiles.getProfile(profileId) : profiles.profiles.get(profileId);
    if (!profile) return res.status(404).json({ ok: false, error: 'Promoción no encontrada.' });
    profile.promotions = cleanPromotions(profile.promotions);
    const promotion = profile.promotions.find(item => item.id === promotionId);
    if (!promotion) return res.status(404).json({ ok: false, error: 'Promoción no encontrada.' });
    if (promotion.status !== 'pending') {
      return res.status(409).json({ ok: false, error: 'La promoción ya fue revisada.', code: 'promotion_already_reviewed' });
    }

    const decision = String(req.body?.decision || '').trim();
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ ok: false, error: 'La decisión debe ser approve o reject.', code: 'invalid_decision' });
    }
    const reasonInput = String(req.body?.reason || '').trim();
    if ((decision === 'reject' && (reasonInput.length < 10 || reasonInput.length > 500))
      || (decision === 'approve' && reasonInput && (reasonInput.length < 10 || reasonInput.length > 500))) {
      return res.status(400).json({ ok: false, error: 'El motivo debe tener entre 10 y 500 caracteres.', code: 'reason_invalid' });
    }
    const match = d.store.getMatch(promotion.matchId);
    const now = nowMs();
    if (decision === 'approve' && !isPreshowWindow(match, now)) {
      return res.status(409).json({ ok: false, error: 'La ventana T−30 de este partido ya está cerrada.', code: 'preshow_window_closed' });
    }

    const actor = req.adminAuth?.profile || { id: 'admin', role: 'admin' };
    const reason = decision === 'reject' ? reasonInput : (reasonInput || 'Aprobación de promoción La Previa');
    const chargeReason = 'Promoción pagada en La Previa';
    let chargeTransaction = null;
    if (decision === 'approve') {
      const result = debit(profile, PROMOTION_FEE, chargeReason);
      if (!result.ok) {
        return res.status(409).json({ ok: false, error: 'Saldo insuficiente para aprobar la promoción.', code: 'insufficient_chips', required: PROMOTION_FEE });
      }
      chargeTransaction = { amount: -PROMOTION_FEE, reason: chargeReason, time: now };
      profile.transactions = Array.isArray(profile.transactions) ? profile.transactions : [];
      profile.transactions.push(chargeTransaction);
      profile.transactions = profile.transactions.slice(-HISTORY_LIMITS.transactions);
    }

    const previous = {
      status: promotion.status,
      reviewedAt: promotion.reviewedAt,
      reviewedBy: promotion.reviewedBy,
      reviewReason: promotion.reviewReason,
      chargedAmount: promotion.chargedAmount
    };
    promotion.status = decision === 'approve' ? 'approved' : 'rejected';
    promotion.reviewedAt = now;
    promotion.reviewedBy = actor.id;
    promotion.reviewReason = reason;
    promotion.chargedAmount = decision === 'approve' ? PROMOTION_FEE : 0;
    const auditInput = {
      actorProfileId: actor.id,
      actorRole: actor.role || 'admin',
      action: `football.promotion_${decision === 'approve' ? 'approved' : 'rejected'}`,
      targetType: 'promotion',
      targetId: promotion.id,
      beforeData: { status: 'pending' },
      afterData: { status: promotion.status },
      reason
    };
    profiles.touch(profile);

    try {
      let responseBody;
      if (typeof profiles.applyPromotionReviewAtomic === 'function') {
        const result = await profiles.applyPromotionReviewAtomic({
          profile, audit: auditInput, idempotency: req.idempotency
        });
        if (req.idempotency) req.idempotency.completed = true;
        responseBody = result.responseBody || result;
      } else {
        const auditStore = typeof d.getAuditStore === 'function' ? d.getAuditStore() : null;
        if (auditStore?.append) await auditStore.append(auditInput);
        if (typeof profiles.saveNow === 'function') await profiles.saveNow();
        responseBody = {
          ok: true,
          promotion: promotionSummary(promotion),
          chips: profile.chips,
          chargedAmount: promotion.chargedAmount
        };
      }
      log('football_promotion_reviewed', {
        admin: actor.id, profileId, promotionId, matchId: promotion.matchId,
        decision, chargedAmount: promotion.chargedAmount
      });
      if (decision === 'approve' && typeof d.onPromotionCharged === 'function') {
        try { await d.onPromotionCharged(profile, promotion); } catch (_) { /* el aviso no revierte un cobro confirmado */ }
      }
      res.set('Cache-Control', 'no-store');
      return res.json(responseBody);
    } catch (error) {
      if (chargeTransaction) {
        // Compensa solo el débito de esta aprobación; conserva cambios de saldo
        // concurrentes que hayan ocurrido mientras Postgres atendía la transacción.
        profile.chips += PROMOTION_FEE;
        profile.transactions = (profile.transactions || []).filter(item => item !== chargeTransaction);
        profile.balanceHistory = profile.balanceHistory || [];
        profile.balanceHistory.push({ t: Date.now(), chips: profile.chips });
        profile.balanceHistory = profile.balanceHistory.slice(-HISTORY_LIMITS.balance);
      }
      Object.assign(promotion, previous);
      profiles.touch(profile);
      throw error;
    }
  }));

  // Suspender apuestas de un partido (un mercado concreto o todos).
  app.post('/admin/estadio/matches/:id/suspend', gate, (req, res) => {
    const match = getMatch(req, res); if (!match) return undefined;
    const untilMs = Number(req.body && req.body.untilMs) || (nowMs() + 15 * 60 * 1000);
    const one = req.body && req.body.market ? String(req.body.market).slice(0, 40) : null;
    const markets = one ? [one] : MARKET_KEYS;
    for (const m of markets) d.betting.suspend(match.id, m, untilMs);
    audit('football_match_suspended', { admin: who(req), match: match.id, markets: markets.length, untilMs });
    log('football_match_suspended', { match: match.id, markets: markets.length });
    return res.json({ ok: true, suspended: markets.length, untilMs });
  });

  // Listado de partidos para gestión de calendario (solo staff con permiso).
  app.get('/admin/estadio/matches', readGate, (req, res) => {
    if (!d.store) return res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
    const month = d.store.getCurrentSeasonMonth();
    const matches = (d.store.getMatches(month) || []).map(m => ({
      id: m.id,
      seasonMonth: m.seasonMonth,
      jornada: m.jornada,
      day: m.day,
      block: m.block,
      featured: Boolean(m.featured),
      homeId: m.homeId,
      awayId: m.awayId,
      status: m.status,
      scheduledKickoffAt: m.scheduledKickoffAt
    }));
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, matches, teams: publicTeams(), seasonMonth: month });
  });

  // Reprogramar el kickoff de un partido programado (§28).
  app.post('/admin/estadio/matches/:id/reschedule', gate, (req, res) => {
    const match = getMatch(req, res); if (!match) return undefined;
    if (match.status !== 'scheduled') {
      return res.status(409).json({
        ok: false,
        error: 'Solo se pueden reprogramar partidos con estado "scheduled".',
        code: 'match_not_scheduled',
        status: match.status
      });
    }

    const raw = req.body?.kickoffAt ?? req.body?.scheduledKickoffAt;
    const kickoff = Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : Date.parse(String(raw || ''));
    if (!Number.isFinite(kickoff) || kickoff <= 0) {
      return res.status(400).json({ ok: false, error: 'Hora de kickoff inválida.', code: 'invalid_kickoff' });
    }
    const currentNow = nowMs();
    if (kickoff <= currentNow) {
      return res.status(400).json({ ok: false, error: 'La nueva hora de kickoff debe ser posterior a la actual.', code: 'kickoff_in_past' });
    }

    const previousKickoffAt = match.scheduledKickoffAt;
    let outcome = null;
    if (d.store && typeof d.store.rescheduleMatch === 'function') {
      outcome = d.store.rescheduleMatch(match.id, kickoff, { now: currentNow, block: req.body?.block });
      if (!outcome.ok) {
        const statusCode = outcome.reason === 'match_not_scheduled' ? 409 : 400;
        return res.status(statusCode).json(outcome);
      }
      if (outcome.match) {
        match.scheduledKickoffAt = outcome.match.scheduledKickoffAt;
        if (outcome.match.day != null) match.day = outcome.match.day;
        if (outcome.match.block != null) match.block = outcome.match.block;
      }
    } else {
      match.scheduledKickoffAt = kickoff;
      if (req.body?.block) match.block = String(req.body.block).slice(0, 40);
    }

    if (d.engine && typeof d.engine.rescheduleMatch === 'function') {
      d.engine.rescheduleMatch(match, kickoff, { now: currentNow, day: match.day, block: match.block });
    } else if (d.engine && typeof d.engine.emit === 'function') {
      const payload = { matchId: match.id, scheduledKickoffAt: match.scheduledKickoffAt, day: match.day, block: match.block };
      d.engine.emit('football:rescheduled', payload);
      d.engine.emit('football:status', { code: 'rescheduled', ...payload });
    }

    audit('football_match_rescheduled', {
      admin: who(req), match: match.id, oldKickoffAt: previousKickoffAt, newKickoffAt: match.scheduledKickoffAt
    });
    log('football_match_rescheduled', {
      match: match.id, oldKickoffAt: previousKickoffAt, newKickoffAt: match.scheduledKickoffAt
    });

    return res.json({
      ok: true,
      match: {
        id: match.id,
        status: match.status,
        scheduledKickoffAt: match.scheduledKickoffAt,
        day: match.day,
        block: match.block
      },
      oldKickoffAt: previousKickoffAt
    });
  });

  // Forzar liquidación al marcador determinista ya revelado.
  app.post('/admin/estadio/matches/:id/settle', gate, (req, res) => {
    const match = getMatch(req, res); if (!match) return undefined;
    const result = d.engine.forceFinish(match, nowMs());
    audit('football_match_force_settled', { admin: who(req), match: match.id });
    log('football_match_force_settled', { match: match.id });
    return res.json({ ok: true, status: match.status, result: result || match.result });
  });

  // Posponer y reembolsar (engine.quarantine: status='postponed' + refundBets + emite).
  app.post('/admin/estadio/matches/:id/postpone', gate, (req, res) => {
    const match = getMatch(req, res); if (!match) return undefined;
    const reason = String((req.body && req.body.reason) || 'pospuesto por administración').slice(0, 120);
    const done = d.engine.quarantine(match, reason);
    audit('football_match_postponed', { admin: who(req), match: match.id, reason });
    log('football_match_postponed', { match: match.id, reason });
    return res.json({ ok: true, postponed: done !== false, status: match.status });
  });

  // Cerrar un mercado por precio incorrecto (no reembolsa: las apuestas abiertas
  // se liquidan normal; solo impide nuevas).
  app.post('/admin/estadio/markets/:matchId/:market/close', gate, (req, res) => {
    const match = getMatch(req, res); if (!match) return undefined;
    const market = String(req.params.market || '').slice(0, 40);
    d.betting.closeMarket(match.id, market);
    audit('football_market_closed', { admin: who(req), match: match.id, market });
    log('football_market_closed', { match: match.id, market });
    return res.json({ ok: true, closed: market });
  });
}

// Bloque `football` de /healthz (§15.8). Render lo usa como health check: debe
// responder rápido y NUNCA fallar por culpa del motor.
function footballHealth(deps) {
  const d = deps || {};
  const on = typeof d.enabled === 'function' ? d.enabled() : Boolean(d.enabled);
  const nowMs = typeof d.now === 'function' ? d.now() : Date.now();
  try {
    const snap = d.engine.healthSnapshot(nowMs);
    return { ...snap, enabled: on };
  } catch (_) {
    return { enabled: on, degraded: true, seasonMonth: null, jornada: null, matchesActive: 0, matchesScheduledToday: 0, openBets: 0, escrowChips: 0, ledgerBalanced: false, quarantined: 0 };
  }
}

module.exports = {
  installFootballRoutes, installFootballAdminRoutes, footballHealth,
  tokenProfileId, publicProfile, MARKET_KEYS
};
