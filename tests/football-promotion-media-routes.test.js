'use strict';

// Flujo completo de la creatividad de imagen: envío con imagen, bandeja admin,
// aprobación, servicio de la imagen solo dentro de T−30 y borrado al kickoff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { ProfileStore } = require('../lib/profile-store');
const { csrfToken, COOKIE_NAME } = require('../lib/account-auth-http');
const { installFootballRoutes, installFootballAdminRoutes, runPromotionMediaSweep } = require('../lib/football/http');
const { PROMOTION_FEE } = require('../lib/football/promotions');

const NOW = 1_800_000_000_000;
const KICKOFF = NOW + 15 * 60 * 1000;
const SESSION_PEPPER = crypto.randomBytes(32).toString('base64');
const APP_ORIGIN = 'https://montecristo.test';

// Mini-enrutador: ejecuta la cadena de manejadores registrada para cada ruta.
function makeApp() {
  const routes = {};
  return {
    routes,
    get(route, ...handlers) { routes[`GET ${route}`] = handlers; },
    post(route, ...handlers) { routes[`POST ${route}`] = handlers; },
    async run(method, route, options = {}) {
      const handlers = routes[`${method} ${route}`];
      assert.ok(handlers, `ruta registrada: ${method} ${route}`);
      const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
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
        await handler(req, res, () => { downstream = next(); return downstream; });
        if (downstream) await downstream;
      }
      await next();
      return res;
    }
  };
}

// --- PNG mínimo válido, con CRC correcto -------------------------------------
function crcOf(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(body));
  return Buffer.concat([len, body, crc]);
}
function pngDataUrl(width, height, extra = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), ...extra.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))
  ]);
  return { buffer, dataUrl: `data:image/png;base64,${buffer.toString('base64')}` };
}

function setup({ promotionsEnabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-promo-route-'));
  const mediaDir = path.join(dir, 'promotion-media');
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'), { deferSeasonCheck: true });
  const profile = profiles.getOrCreate('linked-profile', 'Promotor');
  profile.username = 'promotor';
  profile.role = 'sponsor';
  profile.chips = 1000;
  profile.transactions = [];
  profile.balanceHistory = [];
  profile.updatedAt = NOW;
  const clock = { now: NOW };
  const match = { id: 'match-01', status: 'scheduled', scheduledKickoffAt: KICKOFF, homeId: 'home', awayId: 'away' };
  const store = { getMatch: id => (id === match.id ? match : null) };
  const session = { id: 'session-01', profileId: profile.id };
  const token = 'linked-session-token';
  const accountAuth = {
    resolveSession: async req => (req.headers.cookie === `${COOKIE_NAME}=${token}` ? { session, profile } : null)
  };
  const app = makeApp();
  const deps = {
    store, profiles, promotionMediaDir: mediaDir,
    getAccountAuth: () => accountAuth,
    accountConfig: { accountSessionsEnabled: true, appOrigin: APP_ORIGIN, sessionPepper: SESSION_PEPPER },
    promotionsEnabled: () => promotionsEnabled, enabled: () => true,
    config: { tosVersion: 'v1' }, now: () => clock.now, log: () => {}
  };
  installFootballRoutes(app, deps);
  installFootballAdminRoutes(app, {
    adminConfig: { enabled: true }, guard: (_q, _s, next) => next(), readGuard: (_q, _s, next) => next(),
    store, getProfiles: () => profiles, getAuditStore: () => ({ append: async e => e }), promotionMediaDir: mediaDir,
    now: () => clock.now, audit: () => {}, log: () => {}
  });
  function userHeaders() {
    return { cookie: `${COOKIE_NAME}=${token}`, origin: APP_ORIGIN, 'x-csrf-token': csrfToken(session.id, SESSION_PEPPER) };
  }
  function cleanup() {
    clearTimeout(profiles.saveTimer);
    try { profiles.saveNow(); } catch (_) { /* ya limpio */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { app, profiles, profile, match, clock, mediaDir, deps, userHeaders, cleanup };
}

function adminAuth() {
  return { profile: { id: 'admin-01', role: 'admin' }, session: { id: 'admin-session' } };
}

test('envío con imagen: se guarda sin metadatos, queda pendiente y no se sirve al público', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const { dataUrl } = pngDataUrl(1600, 900, [['tEXt', Buffer.from('Author\0juan@example.com')]]);
  const submitted = await ctx.app.run('POST', '/api/estadio/promotions', {
    body: { matchId: ctx.match.id, text: 'Mesa de póker abierta', targetPath: '/', image: dataUrl },
    headers: ctx.userHeaders()
  });
  assert.equal(submitted.statusCode, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.promotion.hasImage, true);
  assert.equal(submitted.body.promotion.status, 'pending');
  assert.equal(submitted.body.charged, false);
  const stored = ctx.profile.promotions[0];
  assert.match(stored.imageFile, /^[a-f0-9-]{36}\.png$/);
  const onDisk = fs.readFileSync(path.join(ctx.mediaDir, stored.imageFile));
  assert.ok(!onDisk.includes(Buffer.from('juan@example.com')), 'el dato del autor se elimina');

  const publicBefore = await ctx.app.run('GET', '/api/estadio/promotion-media/:promotionId', { params: { promotionId: stored.id } });
  assert.equal(publicBefore.statusCode, 404, 'una pendiente no es pública');

  const inbox = await ctx.app.run('GET', '/admin/estadio/promotions');
  assert.equal(inbox.body.promotions[0].imageUrl, `/admin/estadio/promotions/media/${stored.id}`);
  const preview = await ctx.app.run('GET', '/admin/estadio/promotions/media/:promotionId', { params: { promotionId: stored.id } });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.headers['Content-Type'], 'image/png');
});

test('imagen inválida se rechaza sin escribir en disco ni cobrar', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const bad = await ctx.app.run('POST', '/api/estadio/promotions', {
    body: { matchId: ctx.match.id, text: 'Texto válido', targetPath: '/', image: 'data:image/png;base64,PGh0bWw+' },
    headers: ctx.userHeaders()
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.code, 'invalid_image');
  assert.equal(ctx.profile.promotions.length, 0);
  assert.ok(!fs.existsSync(ctx.mediaDir), 'no se crea nada en disco');
  assert.equal(ctx.profile.chips, 1000);
});

test('aprobada: la imagen se sirve dentro de T−30 y se borra al kickoff', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const { buffer, dataUrl } = pngDataUrl(1600, 900);
  await ctx.app.run('POST', '/api/estadio/promotions', {
    body: { matchId: ctx.match.id, text: 'Mesa de póker abierta', targetPath: '/', image: dataUrl },
    headers: ctx.userHeaders()
  });
  const promo = ctx.profile.promotions[0];
  const review = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: promo.id }, body: { decision: 'approve' }, adminAuth: adminAuth()
  });
  assert.equal(review.statusCode, 200, JSON.stringify(review.body));
  assert.equal(ctx.profile.chips, 1000 - PROMOTION_FEE);

  const served = await ctx.app.run('GET', '/api/estadio/promotion-media/:promotionId', { params: { promotionId: promo.id } });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['Content-Type'], 'image/png');
  assert.equal(served.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(served.body.length, buffer.length, 'se sirve la versión sin metadatos');

  const state = await ctx.app.run('GET', '/api/estadio/promotions/:matchId', { params: { matchId: ctx.match.id } });
  assert.equal(state.body.promotion.image, `/api/estadio/promotion-media/${promo.id}`);

  // Kickoff: el barrido libera el archivo y la ruta deja de servirlo.
  ctx.clock.now = KICKOFF;
  const removed = await runPromotionMediaSweep({
    getProfiles: () => ctx.profiles, store: ctx.deps.store, now: () => KICKOFF, promotionMediaDir: ctx.mediaDir
  });
  assert.equal(removed, 1);
  assert.equal(ctx.profile.promotions[0].imageFile, null);
  assert.equal(fs.readdirSync(ctx.mediaDir).length, 0, 'no queda ningún archivo de imagen');
  const after = await ctx.app.run('GET', '/api/estadio/promotion-media/:promotionId', { params: { promotionId: promo.id } });
  assert.equal(after.statusCode, 404);
});

test('rechazada: la imagen se borra al instante', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const { dataUrl } = pngDataUrl(1600, 900);
  await ctx.app.run('POST', '/api/estadio/promotions', {
    body: { matchId: ctx.match.id, text: 'Mesa de póker abierta', targetPath: '/', image: dataUrl },
    headers: ctx.userHeaders()
  });
  const promo = ctx.profile.promotions[0];
  const review = await ctx.app.run('POST', '/admin/estadio/promotions/:profileId/:promotionId/review', {
    params: { profileId: ctx.profile.id, promotionId: promo.id },
    body: { decision: 'reject', reason: 'La imagen no cumple las reglas de contenido' }, adminAuth: adminAuth()
  });
  assert.equal(review.statusCode, 200, JSON.stringify(review.body));
  assert.equal(ctx.profile.chips, 1000, 'rechazar no cobra');
  assert.equal(ctx.profile.promotions[0].imageFile, null);
  assert.equal(fs.readdirSync(ctx.mediaDir).length, 0);
});
