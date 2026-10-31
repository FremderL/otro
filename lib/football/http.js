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
  VALID_TEXT_POSITIONS, VALID_TEXT_SIZES, VALID_SCOPES,
  normalizePromotionText, normalizePromotionPath, cleanPromotions,
  isPreshowWindow, selectRotatingPromotion, publicPromotion
} = require('./promotions');
const media = require('./promotion-media');
const { PERMISSIONS, hasPermission } = require('../permissions');

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

function publicBallonDorReceipt(future) {
  if (!future) return null;
  return {
    id: future.id,
    seasonMonth: future.seasonMonth,
    market: future.market,
    selection: future.selection,
    odds: future.odds,
    stake: future.stake,
    potentialPayout: future.potentialPayout,
    status: future.status,
    payout: future.payout == null ? null : future.payout,
    placedAt: future.placedAt || 0,
    settledAt: future.settledAt == null ? null : future.settledAt
  };
}

function isSameOriginWrite(req, d) {
  const origin = typeof req.get === 'function' ? req.get('origin') : null;
  if (!origin) return false;
  const configuredOrigin = d.accountConfig && d.accountConfig.appOrigin;
  if (configuredOrigin) return origin === configuredOrigin;
  const host = typeof req.get === 'function' ? req.get('host') : null;
  if (!host) return false;
  try { return new URL(origin).host.toLowerCase() === String(host).toLowerCase(); }
  catch (_) { return false; }
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
    scope: promotion.scope || (promotion.isPermanent ? 'all' : 'single'),
    isPermanent: Boolean(promotion.isPermanent || promotion.scope === 'all'),
    matchesTotal: promotion.matchesTotal || null,
    matchesRemaining: promotion.matchesRemaining != null ? promotion.matchesRemaining : null,
    text: promotion.text || '',
    textPosition: promotion.textPosition || (promotion.text ? 'bottom' : 'hidden'),
    textSize: promotion.textSize || 'medium',
    textAlign: promotion.textAlign || 'left',
    ctaText: promotion.ctaText || null,
    themeColor: promotion.themeColor || null,
    targetPath: promotion.targetPath,
    status: promotion.status,
    createdAt: promotion.createdAt,
    reviewedAt: promotion.reviewedAt || null,
    reviewedBy: promotion.reviewedBy || null,
    reviewReason: promotion.reviewReason || null,
    chargedAmount: promotion.chargedAmount || 0,
    hasImage: Boolean(promotion.imageFile)
  };
}

// Perfiles en memoria del almacén, para el barrido de creatividades y la bandeja.
function allProfilesOf(d) {
  const store = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
  return store?.profiles instanceof Map ? [...store.profiles.values()] : [];
}

// Directorio de creatividades: configurable por dependencia o por PROMOTION_MEDIA_DIR.
// Lo usan tanto las rutas públicas como las de administración y el barrido.
function mediaDirOf(d) {
  return d.promotionMediaDir || process.env.PROMOTION_MEDIA_DIR || path.join(__dirname, '..', '..', 'data', 'promotion-media');
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

  // La vista de Estadio y el espacio dedicado del Balón de Oro comparten
  // el cliente, pero cada ruta presenta su propio contexto de navegación.
  const sendEstadioPage = (_req, res) => {
    if (!isEnabled()) return res.status(404).send('Not found');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(publicDir(), 'estadio.html'));
  };
  // GET /estadio — página general de la sección (antes del catch-all).
  app.get('/estadio', sendEstadioPage);
  // GET /balon-de-oro — página exclusiva del evento mensual.
  app.get('/balon-de-oro', sendEstadioPage);

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

  // Telemetría operacional agregada de reproducción. No resuelve identidad, no
  // modifica fichas y solo acepta la lista cerrada de eventos del mismo origen.
  app.post('/api/estadio/telemetry/audio', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    if (!isSameOriginWrite(req, d)) {
      return res.status(403).json({ ok: false, code: 'origin_denied' });
    }
    const telemetry = typeof d.getAudioTelemetry === 'function'
      ? d.getAudioTelemetry() : d.audioTelemetry;
    if (!telemetry || typeof telemetry.record !== 'function') {
      return res.status(503).json({ ok: false, code: 'telemetry_unavailable' });
    }
    const result = telemetry.record(req.body);
    if (!result.ok) {
      const status = result.code === 'rate_limit' ? 429 : 400;
      return res.status(status).json({ ok: false, code: result.code });
    }
    return res.status(202).json({ ok: true });
  });

  // GET /api/estadio/ballon-dor — ciclo actual o resultado oficial archivado.
  app.get('/api/estadio/ballon-dor', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const marketService = typeof d.getBallonDorMarket === 'function'
      ? d.getBallonDorMarket() : d.ballonDorMarket;
    if (!marketService || typeof marketService.getMarket !== 'function') return unavailable(res);
    const requestedMonth = req.query && req.query.seasonMonth;
    if (requestedMonth != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(requestedMonth))) {
      return res.status(400).json({ ok: false, error: 'season_month_invalid' });
    }
    try {
      const market = requestedMonth == null
        ? marketService.getMarket()
        : marketService.getMarket(String(requestedMonth));
      return res.json({ ok: true, market });
    } catch (error) {
      log('football_http_error', { route: 'ballon_dor', message: String(error?.message || error) });
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  // Archivo público de ediciones; cada replay vuelve a leer el resultado persistido.
  app.get('/api/estadio/ballon-dor/archive', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const marketService = typeof d.getBallonDorMarket === 'function'
      ? d.getBallonDorMarket() : d.ballonDorMarket;
    if (!marketService || typeof marketService.getArchive !== 'function') return unavailable(res);
    try {
      return res.json({ ok: true, cycles: marketService.getArchive() });
    } catch (error) {
      log('football_http_error', { route: 'ballon_dor_archive', message: String(error?.message || error) });
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  // POST /api/estadio/ballon-dor/bet — fallback same-origin cuando Socket.IO no
  // está disponible. Identidad estricta por token existente; nunca crea perfiles.
  // Cuota/jornada no forman parte del contrato y el servicio del servidor las decide.
  app.post('/api/estadio/ballon-dor/bet', asyncRoute(async (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    if (!isSameOriginWrite(req, d)) {
      return res.status(403).json({ ok: false, error: 'Origen no permitido.', code: 'origin_denied' });
    }
    const profiles = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
    const token = String(req.body && req.body.token || '').slice(0, 80);
    const profile = token && profiles && typeof profiles.getProfile === 'function'
      ? profiles.getProfile(token) : null;
    if (!profile) return res.status(401).json({ ok: false, error: 'Sin identidad de jugador.', code: 'no_identity' });
    if (typeof d.verifyTosAcceptance !== 'function'
        || !d.verifyTosAcceptance(profile, req.body && req.body.tos)) {
      return res.status(403).json({ ok: false, error: 'Debes aceptar los términos vigentes para apostar.', code: 'tos_required' });
    }
    const betting = typeof d.getBetting === 'function' ? d.getBetting() : d.betting;
    if (!betting || typeof betting.placeBallonDorBet !== 'function') return unavailable(res);
    const idempotencyKey = (typeof req.get === 'function' && req.get('idempotency-key'))
      || (req.body && req.body.idempotencyKey);
    try {
      const result = await betting.placeBallonDorBet({
        profile,
        selection: req.body && req.body.selection,
        stake: req.body && req.body.stake,
        idempotencyKey
      });
      if (!result || !result.ok) {
        const code = result && result.code || 'bet_rejected';
        const status = code === 'rate_limit' ? 429 : code === 'no_identity' ? 401 : 409;
        return res.status(status).json({ ok: false, code, error: code });
      }
      if (!result.replayed && typeof d.onBetPlaced === 'function') {
        try { d.onBetPlaced({ profileId: profile.id, kind: 'future', stake: result.future?.stake }); }
        catch (error) { log('football_ballon_dor_http_notify_error', { message: String(error?.message || error) }); }
      }
      return res.json({
        ok: true,
        future: publicBallonDorReceipt(result.future),
        chips: profile.chips,
        replayed: Boolean(result.replayed)
      });
    } catch (error) {
      log('football_http_error', { route: 'ballon_dor_bet', message: String(error?.message || error) });
      return res.status(500).json({ ok: false, error: 'internal', code: 'internal' });
    }
  }));

  // GET /api/estadio/my-bets — historial completo de apuestas y pagos del perfil.
  //
  // Es la vía por la que un jugador que entra DESPUÉS del partido ve lo que apostó,
  // cómo quedó y cuánto se le pagó: la liquidación ya ocurrió en el servidor (es
  // automática y no depende de que estuviera conectado), así que aquí solo se lee.
  // Identidad: token de dispositivo opcional, lectura estricta (A11: nunca crea
  // perfiles). Sin token se responde 401 y no se filtra nada de nadie.
  app.get('/api/estadio/my-bets', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const profileId = tokenProfileId(req, d.profiles);
    if (!profileId) {
      return res.status(401).json({ ok: false, error: 'Sin identidad de jugador.', code: 'no_identity' });
    }
    const betting = typeof d.getBetting === 'function' ? d.getBetting() : d.betting;
    if (!betting || typeof betting.getBetHistory !== 'function') return unavailable(res);
    try {
      const limit = Math.floor(Number(req.query.limit) || 40);
      const since = Math.floor(Number(req.query.since) || 0);
      return res.json({
        ok: true,
        history: betting.getBetHistory(profileId, { limit, since }),
        profile: publicProfile(d.profiles.getProfile(profileId))
      });
    } catch (error) {
      log('football_http_error', { route: 'my_bets', message: String(error && error.message || error) });
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

  // GET /api/estadio/promotions/:matchId — todas las campañas aprobadas activas
  // para que el carrusel cree una ficha por anuncio; `promotion` conserva la
  // selección histórica para clientes anteriores.
  app.get('/api/estadio/promotions/:matchId', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const matchId = String(req.params.matchId || '').slice(0, 80);
    const match = d.store ? d.store.getMatch(matchId) : null;
    const now = typeof d.now === 'function' ? d.now() : Date.now();
    if (!match || !isPreshowWindow(match, now) || !d.profiles) {
      return res.json({ ok: true, promotion: null, promotions: [], rotationIntervalMs: PROMOTION_ROTATION_MS });
    }
    const promotions = [];
    for (const profile of d.profiles.profiles.values()) {
      for (const item of profile.promotions || []) {
        if (item.status === 'approved') {
          const isMatch = item.matchId === matchId;
          const isPermanent = item.isPermanent || item.scope === 'all';
          const isCount = item.scope === 'count' && (item.matchesRemaining == null || item.matchesRemaining > 0);
          if (isMatch || isPermanent || isCount) {
            promotions.push(item);
          }
        }
      }
    }
    promotions.sort((a, b) => (Number(a.reviewedAt) || Number(a.createdAt) || 0) - (Number(b.reviewedAt) || Number(b.createdAt) || 0)
      || String(a.id).localeCompare(String(b.id)));
    const publicPromotions = promotions.map(publicPromotion).filter(Boolean);
    const selected = selectRotatingPromotion(promotions, now);
    return res.json({
      ok: true,
      promotion: publicPromotion(selected),
      promotions: publicPromotions,
      rotationIntervalMs: PROMOTION_ROTATION_MS
    });
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
    return res.json({
      ok: true,
      canSubmit: hasPermission(resolved.profile.role, PERMISSIONS.PROMOTION_SUBMIT),
      promotion: promotionSummary(promotions[0] || null)
    });
  }));

  // El envío solo crea una revisión pendiente. Las fichas se debitan en la
  // ruta administrativa, dentro de la aprobación, nunca aquí.
  app.post('/api/estadio/promotions', asyncRoute(async (req, res) => {
    if (!isEnabled()) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const resolved = await resolveLinkedProfile(req, res, { write: true });
    if (!resolved) return undefined;
    if (!hasPermission(resolved.profile.role, PERMISSIONS.PROMOTION_SUBMIT)) {
      return res.status(403).json({ ok: false, error: 'Solo las cuentas con rol Patrocinador pueden solicitar publicidad.', code: 'sponsor_required' });
    }
    if (!d.store || !d.profiles) return unavailable(res);

    const matchId = String(req.body?.matchId || '').trim().slice(0, 80);
    const match = d.store.getMatch(matchId);
    const now = typeof d.now === 'function' ? d.now() : Date.now();
    if (!match || !isPreshowWindow(match, now)) {
      return res.status(409).json({ ok: false, error: 'Solo se puede enviar durante los últimos 30 minutos previos al kickoff.', code: 'preshow_window_closed' });
    }

    // Imagen opcional: se valida antes de escribir nada en disco.
    let prepared = null;
    if (req.body?.image !== undefined && req.body.image !== null && req.body.image !== '') {
      prepared = media.prepareImage(req.body.image);
      if (!prepared.ok) return res.status(400).json({ ok: false, error: prepared.error, code: prepared.code });
    }
    const imageFile = prepared ? media.saveMedia(mediaDirOf(d), prepared.buffer, prepared.ext) : null;
    const hasImage = Boolean(imageFile);

    const text = normalizePromotionText(req.body?.text, { required: !hasImage });
    const targetPath = normalizePromotionPath(req.body?.targetPath);
    if (text === null || !targetPath) {
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      if (!hasImage) {
        return res.status(400).json({ ok: false, error: 'Escribe un texto de 3 a 140 caracteres y elige un enlace interno permitido.', code: 'invalid_promotion' });
      }
      return res.status(400).json({ ok: false, error: 'Elige un enlace interno permitido.', code: 'invalid_promotion' });
    }

    const textPosition = VALID_TEXT_POSITIONS.has(req.body?.textPosition)
      ? req.body.textPosition : (text ? 'bottom' : 'hidden');
    const textSize = VALID_TEXT_SIZES.has(req.body?.textSize)
      ? req.body.textSize : 'medium';
    const textAlign = req.body?.textAlign === 'center' || req.body?.textAlign === 'right' ? req.body.textAlign : 'left';
    const ctaText = typeof req.body?.ctaText === 'string' ? req.body.ctaText.replace(/[<>]/g, '').trim().slice(0, 30) : null;
    const themeColor = typeof req.body?.themeColor === 'string' && /^#[0-9a-f]{3,8}$/i.test(req.body.themeColor) ? req.body.themeColor : null;

    const profile = resolved.profile;
    profile.promotions = cleanPromotions(profile.promotions);
    const previous = profile.promotions.filter(item => item.matchId === matchId);
    const active = previous.find(item => item.status === 'pending' || item.status === 'approved');
    if (active?.status === 'pending') {
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      return res.json({ ok: true, promotion: promotionSummary(active), fee: PROMOTION_FEE, charged: false, replayed: true });
    }
    if (active?.status === 'approved') {
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      return res.status(409).json({ ok: false, error: 'Ya tienes una promoción aprobada para este partido.', code: 'promotion_already_approved' });
    }
    if (previous.length >= 3) {
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      return res.status(429).json({ ok: false, error: 'Ya se alcanzó el máximo de envíos para este partido.', code: 'promotion_attempt_limit' });
    }

    const promotion = {
      id: crypto.randomUUID(), matchId, scope: 'single', isPermanent: false, matchesTotal: null, matchesRemaining: null,
      text: text || '', textPosition, textSize, textAlign, ctaText: ctaText || null, themeColor: themeColor || null,
      targetPath, status: 'pending', createdAt: now,
      reviewedAt: null, reviewedBy: null, reviewReason: null, chargedAmount: 0,
      imageFile, imageMime: prepared ? prepared.mime : null
    };
    const priorPromotions = profile.promotions;
    profile.promotions = cleanPromotions([...priorPromotions, promotion]);
    d.profiles.touch(profile);
    try {
      if (typeof d.profiles.saveNow === 'function') await d.profiles.saveNow();
    } catch (error) {
      profile.promotions = priorPromotions;
      d.profiles.touch(profile);
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      throw error;
    }
    log('football_promotion_submitted', { profileId: profile.id, promotionId: promotion.id, matchId });
    return res.status(201).json({ ok: true, promotion: promotionSummary(promotion), fee: PROMOTION_FEE, charged: false });
  }));

  // GET /api/estadio/promotion-media/:promotionId — imagen de una promoción aprobada
  // se sirve para campañas permanentes o durante la ventana T−30 de su partido.
  app.get('/api/estadio/promotion-media/:promotionId', (req, res) => {
    if (!isEnabled()) return unavailable(res);
    const id = String(req.params.promotionId || '').slice(0, 80);
    const now = typeof d.now === 'function' ? d.now() : Date.now();
    for (const profile of allProfilesOf(d)) {
      const promotion = cleanPromotions(profile.promotions).find(item => item.id === id);
      if (!promotion) continue;
      const isPermanent = Boolean(promotion.isPermanent || promotion.scope === 'all');
      const isCount = promotion.scope === 'count' && (promotion.matchesRemaining == null || promotion.matchesRemaining > 0);
      const match = d.store ? d.store.getMatch(promotion.matchId) : null;
      const allowed = promotion.status === 'approved' && promotion.imageFile && (isPermanent || isCount || isPreshowWindow(match, now));
      const buffer = allowed ? media.readMedia(mediaDirOf(d), promotion.imageFile) : null;
      if (!buffer) break;
      res.set({
        'Content-Type': media.mimeOfName(promotion.imageFile),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=60'
      });
      return res.send(buffer);
    }
    return res.status(404).json({ ok: false, error: 'Imagen no disponible.' });
  });

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
  app.get('/admin/estadio/promotions/media/:promotionId', readGate, (req, res) => {
    const id = String(req.params.promotionId || '').slice(0, 80);
    for (const profile of allProfilesOf(d)) {
      const promotion = cleanPromotions(profile.promotions).find(item => item.id === id);
      if (!promotion) continue;
      const buffer = promotion.imageFile ? media.readMedia(mediaDirOf(d), promotion.imageFile) : null;
      if (!buffer) break;
      res.set({
        'Content-Type': media.mimeOfName(promotion.imageFile),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      return res.send(buffer);
    }
    return res.status(404).json({ ok: false, error: 'Imagen no disponible.' });
  });

  app.get('/admin/estadio/promotions', readGate, (req, res) => {
    const profiles = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
    if (!d.store || !profiles?.profiles) return res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
    const now = nowMs();
    const pendingPromotions = [];
    const activePromotions = [];
    for (const profile of profiles.profiles.values()) {
      for (const promotion of cleanPromotions(profile.promotions)) {
        const isPermanent = Boolean(promotion.isPermanent || promotion.scope === 'all');
        const match = d.store.getMatch(promotion.matchId);
        const windowOpen = isPermanent || isPreshowWindow(match, now);
        const item = {
          ...promotionSummary(promotion),
          imageUrl: promotion.imageFile ? `/admin/estadio/promotions/media/${encodeURIComponent(promotion.id)}` : null,
          profileId: profile.id,
          username: profile.username,
          profileName: profile.name,
          match: match ? {
            id: match.id, homeId: match.homeId, awayId: match.awayId,
            scheduledKickoffAt: match.scheduledKickoffAt
          } : null,
          canApprove: isPermanent || windowOpen,
          unavailableReason: (isPermanent || windowOpen) ? null : 'La ventana T−30 está cerrada o el partido ya no está programado.'
        };
        if (promotion.status === 'pending') {
          pendingPromotions.push(item);
        } else if (promotion.status === 'approved') {
          activePromotions.push(item);
        }
      }
    }
    pendingPromotions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    activePromotions.sort((a, b) => (b.reviewedAt || b.createdAt) - (a.reviewedAt || a.createdAt) || a.id.localeCompare(b.id));
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      promotions: pendingPromotions.slice(0, 200),
      activePromotions: activePromotions.slice(0, 200),
      fee: PROMOTION_FEE
    });
  });

  app.post('/admin/estadio/promotions/:profileId/:promotionId/delete', gate, idempotentWrite, asyncRoute(async (req, res) => {
    const profiles = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
    if (!profiles?.profiles || !d.store) return res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
    const profileId = String(req.params.profileId || '').slice(0, 80);
    const promotionId = String(req.params.promotionId || '').slice(0, 80);
    const profile = profiles.getProfile ? profiles.getProfile(profileId) : profiles.profiles.get(profileId);
    if (!profile) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada.' });
    profile.promotions = cleanPromotions(profile.promotions);
    const promotion = profile.promotions.find(item => item.id === promotionId);
    if (!promotion) return res.status(404).json({ ok: false, error: 'Promoción no encontrada.' });

    const prior = profile.promotions;
    profile.promotions = profile.promotions.filter(item => item.id !== promotionId);
    profiles.touch(profile);
    if (promotion.imageFile) {
      media.removeMedia(mediaDirOf(d), promotion.imageFile);
    }
    try {
      if (typeof profiles.saveNow === 'function') await profiles.saveNow();
    } catch (error) {
      profile.promotions = prior;
      profiles.touch(profile);
      throw error;
    }
    audit('football_promotion_deleted', { admin: who(req), profileId: profile.id, promotionId });
    return res.json({ ok: true, deleted: true });
  }));

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
      if (decision === 'reject' && promotion.imageFile) {
        media.removeMedia(mediaDirOf(d), promotion.imageFile);
        promotion.imageFile = null;
        promotion.imageMime = null;
        profiles.touch(profile);
        try { if (typeof profiles.saveNow === 'function') await profiles.saveNow(); } catch (_) { /* el barrido lo corrige */ }
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

  // Creación directa por administración: campaña de la casa o patrocinador permanente/multi-partido/específico.
  // Se aprueba al instante y no cobra fichas (no pasa por la bandeja de revisión).
  // Permite scope: 'all' (permanente), 'count' (por N partidos) o 'single' (partido específico).
  app.post('/admin/estadio/promotions/create', gate, idempotentWrite, asyncRoute(async (req, res) => {
    const profiles = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
    if (!profiles?.profiles || !d.store) return res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
    res.set('Cache-Control', 'no-store');
    // La cuenta se indica por ID o por nombre de usuario vinculado.
    const accountRef = String(req.body?.profileId || '').trim().slice(0, 80);
    const byId = accountRef ? (profiles.getProfile ? profiles.getProfile(accountRef) : profiles.profiles.get(accountRef)) : null;
    const profile = byId || (accountRef ? [...profiles.profiles.values()].find(p => p && p.username && p.username.toLowerCase() === accountRef.toLowerCase()) : null);
    if (!profile) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada.', code: 'profile_not_found' });

    const rawScope = String(req.body?.scope || '').trim().toLowerCase();
    const scope = VALID_SCOPES.has(rawScope) ? rawScope : 'single';
    const isPermanent = scope === 'all' || Boolean(req.body?.isPermanent);
    const matchesCount = scope === 'count' ? Math.max(1, Math.min(100, Math.floor(Number(req.body?.matchesCount) || 5))) : null;

    let matchId = String(req.body?.matchId || '').trim().slice(0, 80);
    const now = nowMs();
    if (scope === 'all') {
      matchId = matchId || 'all';
    } else {
      if (!matchId) {
        return res.status(400).json({ ok: false, error: 'Elige un partido o selecciona alcance permanente.', code: 'invalid_match' });
      }
      const match = d.store.getMatch(matchId);
      if (!match) {
        return res.status(404).json({ ok: false, error: 'Partido no encontrado.', code: 'match_not_found' });
      }
      if (scope === 'single' && !isPreshowWindow(match, now)) {
        return res.status(409).json({ ok: false, error: 'Solo se puede crear durante los últimos 30 minutos previos al kickoff.', code: 'preshow_window_closed' });
      }
    }

    let prepared = null;
    if (req.body?.image !== undefined && req.body.image !== null && req.body.image !== '') {
      prepared = media.prepareImage(req.body.image);
      if (!prepared.ok) return res.status(400).json({ ok: false, error: prepared.error, code: prepared.code });
    }
    const imageFile = prepared ? media.saveMedia(mediaDirOf(d), prepared.buffer, prepared.ext) : null;
    const hasImage = Boolean(imageFile);

    const text = normalizePromotionText(req.body?.text, { required: !hasImage });
    const targetPath = normalizePromotionPath(req.body?.targetPath);
    if (text === null || !targetPath) {
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      if (!hasImage) {
        return res.status(400).json({ ok: false, error: 'Escribe un texto de 3 a 140 caracteres y elige un enlace interno permitido.', code: 'invalid_promotion' });
      }
      return res.status(400).json({ ok: false, error: 'Elige un enlace interno permitido.', code: 'invalid_promotion' });
    }

    const textPosition = VALID_TEXT_POSITIONS.has(req.body?.textPosition)
      ? req.body.textPosition : (text ? 'bottom' : 'hidden');
    const textSize = VALID_TEXT_SIZES.has(req.body?.textSize)
      ? req.body.textSize : 'medium';
    const textAlign = req.body?.textAlign === 'center' || req.body?.textAlign === 'right' ? req.body.textAlign : 'left';
    const ctaText = typeof req.body?.ctaText === 'string' ? req.body.ctaText.replace(/[<>]/g, '').trim().slice(0, 30) : null;
    const themeColor = typeof req.body?.themeColor === 'string' && /^#[0-9a-f]{3,8}$/i.test(req.body.themeColor) ? req.body.themeColor : null;

    profile.promotions = cleanPromotions(profile.promotions);
    if (scope === 'single' && profile.promotions.some(item => item.matchId === matchId && item.status === 'approved' && item.scope === 'single')) {
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      return res.status(409).json({ ok: false, error: 'Esa cuenta ya tiene una promoción aprobada para este partido.', code: 'promotion_already_approved' });
    }

    const actor = req.adminAuth?.profile || { id: 'admin', role: 'admin' };
    const promotion = {
      id: crypto.randomUUID(),
      matchId,
      scope,
      isPermanent,
      matchesTotal: matchesCount,
      matchesRemaining: matchesCount,
      text: text || '',
      textPosition,
      textSize,
      textAlign,
      ctaText: ctaText || null,
      themeColor: themeColor || null,
      targetPath,
      status: 'approved',
      createdAt: now,
      reviewedAt: now,
      reviewedBy: actor.id,
      reviewReason: isPermanent
        ? 'Campaña permanente creada por administración'
        : (scope === 'count' ? `Campaña por ${matchesCount} partidos creada por administración` : 'Campaña creada por administración'),
      chargedAmount: 0,
      imageFile,
      imageMime: prepared ? prepared.mime : null
    };

    const priorPromotions = profile.promotions;
    profile.promotions = cleanPromotions([...priorPromotions, promotion]);
    profiles.touch(profile);
    try {
      if (typeof profiles.saveNow === 'function') await profiles.saveNow();
    } catch (error) {
      profile.promotions = priorPromotions;
      profiles.touch(profile);
      if (imageFile) media.removeMedia(mediaDirOf(d), imageFile);
      throw error;
    }
    audit('football_promotion_created', { admin: who(req), profileId: profile.id, promotionId: promotion.id, matchId, scope });
    log('football_promotion_created', { admin: actor.id, profileId: profile.id, promotionId: promotion.id, matchId, scope });
    return res.status(201).json({ ok: true, promotion: promotionSummary(promotion), chargedAmount: 0 });
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

  // Forzar liquidación al marcador determinista ya revelado. Si el partido YA está
  // asentado no se re-liquida (el motor devuelve alreadySettled): el resultado
  // asentado es autoritativo y nunca se reescribe desde aquí.
  app.post('/admin/estadio/matches/:id/settle', gate, (req, res) => {
    const match = getMatch(req, res); if (!match) return undefined;
    const out = d.engine.forceFinish(match, nowMs());
    audit('football_match_force_settled', { admin: who(req), match: match.id });
    log('football_match_force_settled', { match: match.id });
    // Se informa el marcador asentado; nunca el que mande el cliente. Un `out`
    // con `ok` es el sobre interno del store y no se devuelve como resultado.
    const envelope = Boolean(out && typeof out === 'object' && 'ok' in out);
    const settled = match.result
      || (out && out.result && Number.isFinite(Number(out.result.home)) ? out.result : null);
    return res.json({
      ok: true,
      status: match.status,
      result: settled || (envelope ? null : (out || null)),
      alreadySettled: Boolean(out && out.alreadySettled)
    });
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
    const health = { ...snap, enabled: on };
    try {
      const market = typeof d.getBallonDorMarket === 'function'
        ? d.getBallonDorMarket() : d.ballonDorMarket;
      const audioTelemetry = typeof d.getAudioTelemetry === 'function'
        ? d.getAudioTelemetry() : d.audioTelemetry;
      const ballonDor = market && typeof market.healthSnapshot === 'function'
        ? market.healthSnapshot() : null;
      const audio = audioTelemetry && typeof audioTelemetry.snapshot === 'function'
        ? audioTelemetry.snapshot() : null;
      if (ballonDor || audio) health.ballonDor = {
        ...(ballonDor || {}),
        ...(audio ? { audioTelemetry: audio } : {})
      };
    } catch (_) {
      health.ballonDor = { observabilityAvailable: false };
    }
    return health;
  } catch (_) {
    return { enabled: on, degraded: true, seasonMonth: null, jornada: null, matchesActive: 0, matchesScheduledToday: 0, openBets: 0, escrowChips: 0, ledgerBalanced: false, quarantined: 0 };
  }
}

// Retención de creatividades (La Previa): borra las imágenes rechazadas y las de
// partidos que ya no están programados o que ya arrancaron. Devuelve cuántas quitó.
async function runPromotionMediaSweep(deps = {}) {
  const d = deps;
  const store = typeof d.getProfiles === 'function' ? d.getProfiles() : d.profiles;
  if (!(store?.profiles instanceof Map) || !d.store) return 0;
  const now = typeof d.now === 'function' ? d.now() : Date.now();
  const dir = mediaDirOf(d);
  const expired = media.sweepPromotionMedia({
    profileList: [...store.profiles.values()],
    getMatch: id => d.store.getMatch(id),
    dir, now
  });
  const touched = new Set(expired.map(item => item.profile));
  for (const profile of touched) {
    store.touch(profile);
  }
  if (touched.size && typeof store.saveNow === 'function') {
    try { await store.saveNow(); } catch (_) { /* el siguiente barrido reintenta */ }
  }
  return expired.length;
}

// Programa el barrido periódico. Se llama una vez desde el arranque del servidor.
function startPromotionMediaSweep(deps = {}, intervalMs = 60 * 1000) {
  const tick = () => runPromotionMediaSweep(deps).catch(() => 0);
  // Primera pasada tras el arranque (los almacenes se crean en bootstrap), luego periódica.
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, intervalMs);
  for (const handle of [first, timer]) if (typeof handle.unref === 'function') handle.unref();
  return timer;
}

module.exports = {
  installFootballRoutes, installFootballAdminRoutes, footballHealth,
  tokenProfileId, publicProfile, MARKET_KEYS,
  runPromotionMediaSweep, startPromotionMediaSweep
};
