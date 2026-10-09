'use strict';

// Fase E2 — Pruebas de las rutas HTTP del Estadio (§14.3, §15.8).
// Cubre: API pública de lectura, página propia, fail-closed de las palancas admin
// (ADMIN_FEATURE_ENABLED + guardia), el bloque de /healthz y la regla A11 aplicada
// a HTTP (un token opcional NUNCA crea un perfil).

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { installFootballRoutes, installFootballAdminRoutes, footballHealth, MARKET_KEYS } = require('../lib/football/http');
const { monthKey } = require('../lib/football-store-shared');

// --- Mock de Express (app + req + res) ---
function makeApp() {
  const routes = {};
  const app = {
    routes,
    get(p, ...h) { routes['GET ' + p] = h; },
    post(p, ...h) { routes['POST ' + p] = h; },
    run(method, p, { params = {}, query = {}, body = {}, adminAuth = null } = {}) {
      const handlers = routes[method + ' ' + p];
      if (!handlers) throw new Error('ruta no registrada: ' + method + ' ' + p);
      const req = { params, query, body, adminAuth, get: () => undefined };
      const res = makeRes();
      let i = 0;
      const next = () => { if (res._done) return; const h = handlers[i++]; if (h) h(req, res, next); };
      next();
      return res;
    }
  };
  return app;
}
function makeRes() {
  const res = {
    statusCode: 200, body: null, headers: {}, sentFile: null, _done: false,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; res._done = true; return res; },
    send(b) { res.body = b; res._done = true; return res; },
    sendFile(p) { res.sentFile = p; res._done = true; return res; },
    set(k, v) { if (k && typeof k === 'object') Object.assign(res.headers, k); else res.headers[k] = v; return res; }
  };
  return res;
}

function makeEngine(spy) {
  return {
    healthSnapshot: () => ({ enabled: true, seasonMonth: '2026-10', jornada: 12, matchesActive: 3, matchesScheduledToday: 8, lastSweepAgeMs: 1, lastTickAgeMs: 2, openBets: 47, escrowChips: 18400, ledgerBalanced: true, quarantined: 0, degraded: false }),
    forceFinish: (_match) => { spy.forceFinish++; return { winner: 'home' }; },
    quarantine: (match) => { spy.quarantine++; match.status = 'postponed'; return true; }
  };
}
function makeBetting(spy) {
  return {
    suspend: (id, m) => { spy.suspend++; spy.suspended.push(m); },
    closeMarket: (id, m) => { spy.close++; spy.closed = m; }
  };
}

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhttp-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const month = monthKey();
  store.generateSeason(month);
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const spy = { getOrCreate: 0, getProfile: 0, suspend: 0, suspended: [], close: 0, closed: null, forceFinish: 0, quarantine: 0, audit: [] };
  const realGetOrCreate = profiles.getOrCreate.bind(profiles);
  const realGetProfile = profiles.getProfile.bind(profiles);
  profiles.getOrCreate = (...a) => { spy.getOrCreate++; return realGetOrCreate(...a); };
  profiles.getProfile = (...a) => { spy.getProfile++; return realGetProfile(...a); };

  const app = makeApp();
  const engine = makeEngine(spy);
  const betting = makeBetting(spy);
  const buildLobby = () => ({ seasonMonth: month, matches: [], standings: [], nextKickoffAt: null });
  const buildMatchState = (id, profileId) => ({ match: { id }, profileId: profileId || null, state: { minute: 0 } });
  const audit = (type, data) => spy.audit.push({ type, data });

  installFootballRoutes(app, {
    store, profiles, buildLobby, buildMatchState,
    config: { tosVersion: 'v1' }, log: () => {},
    enabled: opts.enabled !== undefined ? opts.enabled : () => true,
    publicDir: opts.publicDir || path.join(dir, 'public')
  });
  installFootballAdminRoutes(app, {
    adminConfig: opts.adminConfig !== undefined ? opts.adminConfig : { enabled: true },
    guard: opts.guard || ((_req, _res, next) => next()),
    engine, betting, store, log: () => {}, audit, now: () => 1000
  });

  const scheduled = store.getMatches(month).find(m => m.status === 'scheduled');
  const cleanup = () => { try { store.close(); } catch (_) {} try { profiles.saveNow(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, profiles, app, engine, betting, spy, scheduled, month, cleanup };
}

// ===================== RUTAS PÚBLICAS =====================

test('GET /estadio sirve estadio.html', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/estadio');
  assert.ok(res.sentFile && res.sentFile.endsWith('estadio.html'), 'sendFile estadio.html');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('GET /api/estadio/state devuelve lobby + profile null sin token', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/api/estadio/state');
  assert.equal(res.body.ok, true);
  assert.ok(res.body.lobby, 'lobby presente');
  assert.equal(res.body.profile, null, 'anónimo sin token');
  assert.equal(res.body.tosVersion, 'v1');
  assert.equal(ctx.spy.getOrCreate, 0, 'HTTP nunca crea perfiles');
});

test('A11 HTTP — token inexistente NO crea perfil (getOrCreate 0)', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/api/estadio/state', { query: { token: 'fantasma' } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.profile, null);
  assert.equal(ctx.spy.getOrCreate, 0);
  assert.ok(ctx.spy.getProfile >= 1, 'usa lectura estricta');
});

test('A11 HTTP — token válido proyecta el perfil público (sin datos sensibles)', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const p = ctx.profiles.getOrCreate('tok_real', 'Ada', null); p.chips = 777; ctx.profiles.saveNow();
  const res = ctx.app.run('GET', '/api/estadio/state', { query: { token: 'tok_real' } });
  assert.equal(res.body.profile.id, 'tok_real');
  assert.equal(res.body.profile.chips, 777);
  assert.ok(!('flags' in res.body.profile) && !('transactions' in res.body.profile), 'solo campos públicos');
  assert.equal(ctx.spy.getOrCreate, 1, 'solo el getOrCreate explícito del test');
});

test('GET /api/estadio/matches/:id — existe y no existe', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const ok = ctx.app.run('GET', '/api/estadio/matches/:id', { params: { id: ctx.scheduled.id } });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.matchState.match.id, ctx.scheduled.id);
  const missing = ctx.app.run('GET', '/api/estadio/matches/:id', { params: { id: 'm_inexistente' } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error, 'no_match');
});

test('GET /api/estadio/standings devuelve la tabla de la temporada en curso', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/api/estadio/standings');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.seasonMonth, ctx.month);
  assert.ok(Array.isArray(res.body.standings));
});

test('FOOTBALL_ENABLED apagado: todas las rutas públicas responden 404', (t) => {
  const ctx = setup({ enabled: () => false }); t.after(ctx.cleanup);
  assert.equal(ctx.app.run('GET', '/estadio').statusCode, 404);
  assert.equal(ctx.app.run('GET', '/api/estadio/state').statusCode, 404);
  assert.equal(ctx.app.run('GET', '/api/estadio/standings').statusCode, 404);
  assert.equal(ctx.app.run('GET', '/api/estadio/matches/:id', { params: { id: ctx.scheduled.id } }).statusCode, 404);
});

// ===================== PALANCAS ADMIN (fail-closed) =====================

test('ADMIN_FEATURE_ENABLED apagado: rutas admin 404 (fail-closed)', (t) => {
  const ctx = setup({ adminConfig: { enabled: false } }); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/suspend', { params: { id: ctx.scheduled.id } });
  assert.equal(res.statusCode, 404);
  assert.equal(ctx.spy.suspend, 0, 'no toca servicios');
});

test('guardia que rechaza: la ruta admin no procede', (t) => {
  const ctx = setup({ guard: (_req, res) => res.status(403).json({ error: 'Sesión no válida.' }) }); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/settle', { params: { id: ctx.scheduled.id } });
  assert.equal(res.statusCode, 403);
  assert.equal(ctx.spy.forceFinish, 0);
});

test('suspend sin market suspende TODOS los mercados + audita', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/suspend', { params: { id: ctx.scheduled.id }, adminAuth: { profile: { id: 'admin1' } } });
  assert.equal(res.body.ok, true);
  assert.equal(ctx.spy.suspend, MARKET_KEYS.length);
  assert.deepEqual(ctx.spy.suspended.slice().sort(), MARKET_KEYS.slice().sort());
  assert.equal(ctx.spy.audit[0].type, 'football_match_suspended');
  assert.equal(ctx.spy.audit[0].data.admin, 'admin1');
});

test('suspend con market suspende solo ese', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  ctx.app.run('POST', '/admin/estadio/matches/:id/suspend', { params: { id: ctx.scheduled.id }, body: { market: '1x2' } });
  assert.equal(ctx.spy.suspend, 1);
  assert.deepEqual(ctx.spy.suspended, ['1x2']);
});

test('settle fuerza liquidación (engine.forceFinish) + audita', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/settle', { params: { id: ctx.scheduled.id } });
  assert.equal(res.body.ok, true);
  assert.equal(ctx.spy.forceFinish, 1);
  assert.equal(ctx.spy.audit[0].type, 'football_match_force_settled');
});

test('postpone pone status postponed (engine.quarantine) + audita', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/postpone', { params: { id: ctx.scheduled.id }, body: { reason: 'clima' } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'postponed');
  assert.equal(ctx.spy.quarantine, 1);
  assert.equal(ctx.spy.audit[0].data.reason, 'clima');
});

test('close de mercado llama closeMarket + audita', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/markets/:matchId/:market/close', { params: { matchId: ctx.scheduled.id, market: 'btts' } });
  assert.equal(res.body.ok, true);
  assert.equal(ctx.spy.close, 1);
  assert.equal(ctx.spy.closed, 'btts');
  assert.equal(ctx.spy.audit[0].type, 'football_market_closed');
});

test('admin sobre partido inexistente: 404 no_match', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/settle', { params: { id: 'm_x' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'no_match');
});

// ===================== /healthz (§15.8) =====================

test('footballHealth refleja el snapshot del motor + enabled del flag', () => {
  const spy = {};
  const engine = makeEngine(spy);
  const h = footballHealth({ engine, enabled: false, now: () => 1 });
  assert.equal(h.enabled, false, 'el flag manda sobre el snapshot');
  assert.equal(h.seasonMonth, '2026-10');
  assert.equal(h.matchesActive, 3);
  assert.equal(h.ledgerBalanced, true);
  const on = footballHealth({ engine, enabled: true });
  assert.equal(on.enabled, true);
});

test('footballHealth NUNCA lanza: si el motor falla, devuelve degraded', () => {
  const engine = { healthSnapshot: () => { throw new Error('boom'); } };
  const h = footballHealth({ engine, enabled: true });
  assert.equal(h.degraded, true);
  assert.equal(h.enabled, true);
  assert.equal(h.ledgerBalanced, false);
});
