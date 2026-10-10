'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { ProfileStore } = require('../lib/profile-store');
const { cleanProfile } = require('../lib/profile-store-shared');
const { PgProfileStore } = require('../lib/profile-store-pg');
const { csrfToken, COOKIE_NAME } = require('../lib/account-auth-http');
const { installFootballRoutes, installFootballAdminRoutes } = require('../lib/football/http');
const {
  PROMOTION_FEE, PROMOTION_ROTATION_MS, normalizePromotionPath,
  selectRotatingPromotion
} = require('../lib/football/promotions');

const NOW = 1_800_000_000_000;
const SESSION_PEPPER = crypto.randomBytes(32).toString('base64');
const APP_ORIGIN = 'https://montecristo.test';

function makeApp() {
  const routes = {};
  return {
    routes,
    get(route, ...handlers) { routes[`GET ${route}`] = handlers; },
    post(route, ...handlers) { routes[`POST ${route}`] = handlers; },
    async run(method, route, options = {}) {
      const handlers = routes[`${method} ${route}`];
      assert.ok(handlers, `ruta registrada: ${method} ${route}`);
      const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
      const req = {
        params: options.params || {}, query: options.query || {}, body: options.body || {},
        headers, adminAuth: options.adminAuth || null, route: { path: route },
        get(name) { return headers[String(name).toLowerCase()]; }
      };
      const res = {
        statusCode: 200, body: null, headers: {}, _done: false,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this._done = true; return this; },
        send(body) { this.body = body; this._done = true; return this; },
        sendFile(file) { this.file = file; this._done = true; return this; },
        set(name, value) {
          if (name && typeof name === 'object') Object.assign(this.headers, name);
          else this.headers[name] = value;
          return this;
        }
      };
      let index = 0;
      async function next() {
        if (res._done) return;
        const handler = handlers[index++];
        if (!handler) return;
        let downstream;
        const returned = handler(req, res, () => { downstream = next(); return downstream; });
        await returned;
        if (downstream) await downstream;
      }
      await next();
      return res;
    }
  };
}

function setup({ promotionsEnabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-promo-'));
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
  const profile = profiles.getOrCreate('linked-profile', 'Promotor');
  profile.username = 'promotor';
  profile.role = 'sponsor';
  profile.chips = 1000;
  profile.transactions = [];
  profile.balanceHistory = [];
  profile.updatedAt = NOW;

  const match = {
    id: 'match-01', status: 'scheduled', scheduledKickoffAt: NOW + 15 * 60 * 1000,
    homeId: 'home', awayId: 'away'
  };
  const store = { getMatch: id => (id === match.id ? match : null) };
  const session = { id: 'session-01', profileId: profile.id };
  const token = 'linked-session-token';
  const accountAuth = {
    resolveSession: async req => req.headers.cookie === `${COOKIE_NAME}=${token}`
      ? { session, profile }
      : null
  };
  const app = makeApp();
  const logs = [];
  const deps = {
    store, profiles,
    getAccountAuth: () => accountAuth,
    accountConfig: { accountSessionsEnabled: true, appOrigin: APP_ORIGIN, sessionPepper: SESSION_PEPPER },
    promotionsEnabled: () => promotionsEnabled,
    enabled: () => true,
    config: { tosVersion: 'v1' },
    now: () => NOW,
    log: (event, data) => logs.push({ event, data })
  };
  installFootballRoutes(app, deps);
  const auditEntries = [];
  const charged = [];
  installFootballAdminRoutes(app, {
    adminConfig: { enabled: true },
    guard: (_req, _res, next) => next(),
    readGuard: (_req, _res, next) => next(),
    store,
    getProfiles: () => profiles,
    getAuditStore: () => ({ append: async entry => { auditEntries.push(entry); return entry; } }),
    onPromotionCharged: async (target, promotion) => charged.push({ profileId: target.id, promotionId: promotion.id }),
    now: () => NOW,
    audit: () => {},
    log: (event, data) => logs.push({ event, data })
  });

  function userHeaders({ origin = APP_ORIGIN, csrf = true, authenticated = true } = {}) {
    return {
      ...(authenticated ? { cookie: `${COOKIE_NAME}=${token}` } : {}),
      ...(origin ? { origin } : {}),
      ...(csrf ? { 'x-csrf-token': csrfToken(session.id, SESSION_PEPPER) } : {})
    };
  }
  function cleanup() {
    clearTimeout(profiles.saveTimer);
    try { profiles.saveNow(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { app, profiles, profile, store, match, session, auditEntries, charged, logs, userHeaders, cleanup };
}

function pendingPromotion(id = 'promo-01', matchId = 'match-01') {
  return {
    id, matchId, text: 'Visita nuestra mesa de juegos', targetPath: '/',
    status: 'pending', createdAt: NOW - 1000, reviewedAt: null,
    reviewedBy: null, reviewReason: null, chargedAmount: 0
  };
}

function adminAuth() {
  return { profile: { id: 'admin-01', role: 'admin' }, session: { id: 'admin-session' } };
}

test('la allowlist conserva solo rutas internas y canonicaliza las salas', () => {
  assert.equal(normalizePromotionPath('/'), '/');
  assert.equal(normalizePromotionPath('/estadio'), '/estadio');
  assert.equal(normalizePromotionPath('/terminos'), '/terminos');
  assert.equal(normalizePromotionPath('/room/a1b2c'), '/room/A1B2C');
  for (const value of ['https://outside.test', '//outside.test', '/admin', '/api/auth', '/room/ABCDE?next=/', '/room/ABCDE/']) {
    assert.equal(normalizePromotionPath(value), null, `${value} queda fuera de la allowlist`);
  }
});

test('cleanProfile preserva campañas válidas sin aceptar HTML/rutas externas ni publicar el historial', () => {
  const profile = cleanProfile({
    id: 'p1', promotions: [
      pendingPromotion('good'),
      { ...pendingPromotion('bad-link'), targetPath: 'https://outside.test' },
      { ...pendingPromotion('bad-state'), status: 'published' }
    ]
  });
  assert.deepEqual(profile.promotions.map(item => item.id), ['good']);
  assert.equal(profile.promotions[0].status, 'pending');
});

test('solo un patrocinador puede solicitar publicidad: una cuenta vinculada sin rol recibe 403 y no crea nada', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  ctx.profile.role = 'user';
  const body = { matchId: ctx.match.id, text: 'Ven a jugar en MonteCristo', targetPath: '/estadio' };
  const denied = await ctx.app.run('POST', '/api/estadio/promotions', { body, headers: ctx.userHeaders() });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'sponsor_required');
  assert.equal(ctx.profile.promotions.length, 0);
  const mine = await ctx.app.run('GET', '/api/estadio/promotions/:matchId/mine', { params: { matchId: ctx.match.id }, headers: ctx.userHeaders() });
  assert.equal(mine.body.canSubmit, false);
  ctx.profile.role = 'sponsor';
  const mineSponsor = await ctx.app.run('GET', '/api/estadio/promotions/:matchId/mine', { params: { matchId: ctx.match.id }, headers: ctx.userHeaders() });
  assert.equal(mineSponsor.body.canSubmit, true);
});

test('solo una sesión de cuenta vinculada puede enviar durante T−30; el envío no debita', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const body = { matchId: ctx.match.id, text: 'Ven a jugar en MonteCristo', targetPath: '/estadio' };
  const anonymous = await ctx.app.run('POST', '/api/estadio/promotions', { body, headers: ctx.userHeaders({ authenticated: false }) });
  assert.equal(anonymous.statusCode, 401);
  const wrongOrigin = await ctx.app.run('POST', '/api/estadio/promotions', { body, headers: ctx.userHeaders({ origin: 'https://other.test' }) });
  assert.equal(wrongOrigin.statusCode, 403);
  const invalidPath = await ctx.app.run('POST', '/api/estadio/promotions', {
    body: { ...body, targetPath: 'https://outside.test' }, headers: ctx.userHeaders()
  });
  assert.equal(invalidPath.statusCode, 400);
  const submitted = await ctx.app.run('POST', '/api/estadio/promotions', { body, headers: ctx.userHeaders() });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.body.promotion.status, 'pending');
  assert.equal(submitted.body.fee, PROMOTION_FEE);
  assert.equal(submitted.body.charged, false);
  assert.equal(ctx.profile.chips, 1000);
  assert.equal(ctx.profile.promotions.length, 1);
  assert.equal(ctx.profile.transactions.length, 0);

  const duplicate = await ctx.app.run('POST', '/api/estadio/promotions', { body, headers: ctx.userHeaders() });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.replayed, true);
  assert.equal(ctx.profile.promotions.length, 1);
});

test('la ventana de envío cierra en kickoff y publicar requiere la bandera de administración', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  ctx.match.scheduledKickoffAt = NOW;
  const closed = await ctx.app.run('POST', '/api/estadio/promotions', {
    body: { matchId: ctx.match.id, text: 'Anuncio breve', targetPath: '/' }, headers: ctx.userHeaders()
  });
  assert.equal(closed.statusCode, 409);

  const unavailable = setup({ promotionsEnabled: false });
  t.after(unavailable.cleanup);
  const gated = await unavailable.app.run('POST', '/api/estadio/promotions', {
    body: { matchId: unavailable.match.id, text: 'Anuncio breve', targetPath: '/' }, headers: unavailable.userHeaders()
  });
  assert.equal(gated.statusCode, 404);
});

test('la ruta pública muestra solo promociones aprobadas dentro de T−30', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  ctx.profile.promotions = [
    pendingPromotion('pending'),
    { ...pendingPromotion('approved'), status: 'approved', reviewedAt: NOW - 1, chargedAmount: PROMOTION_FEE }
  ];
  const visible = await ctx.app.run('GET', '/api/estadio/promotions/:matchId', { params: { matchId: ctx.match.id } });
  assert.equal(visible.body.ok, true);
  assert.equal(visible.body.promotion.label, 'Promoción pagada');
  assert.equal(visible.body.promotion.text, 'Visita nuestra mesa de juegos');
  assert.equal(visible.body.promotion.href, '/');
  assert.equal(visible.body.rotationIntervalMs, PROMOTION_ROTATION_MS);

  ctx.match.scheduledKickoffAt = NOW + 31 * 60 * 1000;
  const hidden = await ctx.app.run('GET', '/api/estadio/promotions/:matchId', { params: { matchId: ctx.match.id } });
  assert.equal(hidden.body.promotion, null);
});

test('rotación determinista alterna una sola promoción cada 15 segundos', () => {
  const items = [
    { id: 'a', status: 'approved', createdAt: 1, text: 'Promo A', targetPath: '/' },
    { id: 'b', status: 'approved', createdAt: 2, text: 'Promo B', targetPath: '/estadio' }
  ];
  const bucket = Math.floor(NOW / PROMOTION_ROTATION_MS) * PROMOTION_ROTATION_MS;
  assert.equal(selectRotatingPromotion(items, bucket).id, 'a');
  assert.equal(selectRotatingPromotion(items, bucket + PROMOTION_ROTATION_MS).id, 'b');
  assert.equal(selectRotatingPromotion(items, bucket + PROMOTION_ROTATION_MS * 2).id, 'a');
});

test('bandeja administrativa y aprobación cobran exactamente 250 una sola vez', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  ctx.profile.promotions = [pendingPromotion()];
  const inbox = await ctx.app.run('GET', '/admin/estadio/promotions');
  assert.equal(inbox.body.promotions.length, 1);
  assert.equal(inbox.body.promotions[0].canApprove, true);
  const review = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: 'promo-01' },
    body: { decision: 'approve' }, adminAuth: adminAuth()
  });
  assert.equal(review.statusCode, 200);
  assert.equal(ctx.profile.chips, 750);
  assert.equal(ctx.profile.promotions[0].status, 'approved');
  assert.equal(ctx.profile.promotions[0].chargedAmount, 250);
  assert.deepEqual(ctx.profile.transactions.map(item => item.amount), [-250]);
  assert.equal(ctx.auditEntries.length, 1);
  assert.equal(ctx.charged.length, 1);

  const repeated = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: 'promo-01' },
    body: { decision: 'approve' }, adminAuth: adminAuth()
  });
  assert.equal(repeated.statusCode, 409);
  assert.equal(ctx.profile.chips, 750);
  assert.equal(ctx.profile.transactions.length, 1);
  assert.equal(ctx.charged.length, 1);
});

test('rechazar no debita; aprobar fuera de T−30 o sin saldo deja la campaña pendiente', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  ctx.profile.promotions = [pendingPromotion('reject-me'), pendingPromotion('later', 'match-01')];
  const rejected = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: 'reject-me' },
    body: { decision: 'reject', reason: 'El enlace no cumple las reglas.' }, adminAuth: adminAuth()
  });
  assert.equal(rejected.statusCode, 200);
  assert.equal(ctx.profile.chips, 1000);
  assert.equal(ctx.profile.promotions.find(item => item.id === 'reject-me').status, 'rejected');
  assert.equal(ctx.profile.transactions.length, 0);

  ctx.profile.chips = 100;
  const insufficient = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: 'later' },
    body: { decision: 'approve' }, adminAuth: adminAuth()
  });
  assert.equal(insufficient.statusCode, 409);
  assert.equal(insufficient.body.code, 'insufficient_chips');
  assert.equal(ctx.profile.chips, 100);
  assert.equal(ctx.profile.promotions.find(item => item.id === 'later').status, 'pending');

  ctx.profile.chips = 1000;
  ctx.match.scheduledKickoffAt = NOW - 1;
  const expired = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: 'later' },
    body: { decision: 'approve' }, adminAuth: adminAuth()
  });
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.body.code, 'preshow_window_closed');
  assert.equal(ctx.profile.chips, 1000);
});

test('un partido reprogramado actualiza la ventana T−30 para envíos y aprobaciones de promociones', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  // Inicialmente en T-10 min (ventana abierta)
  ctx.match.scheduledKickoffAt = NOW + 10 * 60 * 1000;

  // Enviar promoción dentro de la ventana inicial
  const first = await ctx.app.run('POST', '/api/estadio/promotions', {
    headers: ctx.userHeaders(),
    body: { matchId: ctx.match.id, text: 'Promoción válida', targetPath: '/room/ABC12' }
  });
  assert.equal(first.statusCode, 201);

  // Reprogramar el partido a 2 horas en el futuro (fuera de T-30)
  ctx.match.scheduledKickoffAt = NOW + 120 * 60 * 1000;

  // Intento de envío fuera de la nueva ventana T-30 se rechaza
  const outside = await ctx.app.run('POST', '/api/estadio/promotions', {
    headers: ctx.userHeaders(),
    body: { matchId: ctx.match.id, text: 'Intento fuera de ventana', targetPath: '/room/XYZ89' }
  });
  assert.equal(outside.statusCode, 409);
  assert.equal(outside.body.code, 'preshow_window_closed');

  // Intento de aprobación por admin mientras está fuera de la nueva ventana se rechaza
  const promoId = first.body.promotion.id;
  const earlyReview = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: promoId },
    body: { decision: 'approve' }, adminAuth: adminAuth()
  });
  assert.equal(earlyReview.statusCode, 409);
  assert.equal(earlyReview.body.code, 'preshow_window_closed');

  // Ahora reprogramamos a 20 minutos en el futuro (dentro de la nueva ventana T-30)
  ctx.match.scheduledKickoffAt = NOW + 20 * 60 * 1000;
  const approvedReview = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: promoId },
    body: { decision: 'approve' }, adminAuth: adminAuth()
  });
  assert.equal(approvedReview.statusCode, 200);
  assert.equal(ctx.profile.promotions.find(p => p.id === promoId).status, 'approved');
});

test('PgProfileStore hace perfil, auditoría e idempotencia atómicos al revisar', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('UPDATE montecristo_admin_idempotency')) return { rowCount: 1 };
      if (sql.includes('UPDATE montecristo_profiles')) return { rowCount: 1 };
      return { rowCount: 1 };
    },
    release() {}
  };
  const store = Object.create(PgProfileStore.prototype);
  store.pool = { connect: async () => client };
  store._dirtyProfiles = new Set(['linked-profile']);
  const profile = {
    id: 'linked-profile', username: 'promotor', chips: 750, updatedAt: NOW,
    promotions: [{ ...pendingPromotion(), status: 'approved', reviewedAt: NOW, chargedAmount: 250 }]
  };
  const result = await store.applyPromotionReviewAtomic({
    profile,
    audit: {
      actorProfileId: 'admin-01', actorRole: 'admin', action: 'football.promotion_approved',
      targetType: 'promotion', targetId: 'promo-01', reason: 'Aprobación de promoción La Previa'
    },
    idempotency: {
      actorId: 'admin-01', key: 'key-01', encodeResponse: body => body
    }
  });
  assert.equal(result.responseBody.chips, 750);
  assert.ok(queries.some(item => item.sql === 'BEGIN'));
  assert.ok(queries.some(item => item.sql.includes('UPDATE montecristo_profiles')));
  assert.ok(queries.some(item => item.sql.includes('INSERT INTO montecristo_audit_log')));
  assert.ok(queries.some(item => item.sql.includes('UPDATE montecristo_admin_idempotency')));
  assert.ok(queries.some(item => item.sql === 'COMMIT'));
  assert.equal(store._dirtyProfiles.has(profile.id), true, 'el snapshot posterior conserva cambios concurrentes del perfil');
});
