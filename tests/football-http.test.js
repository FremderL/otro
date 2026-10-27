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
const { createBallonDorAudioTelemetry } = require('../lib/football/rollout-telemetry');
const { monthKey } = require('../lib/football-store-shared');

// --- Mock de Express (app + req + res) ---
function makeApp() {
  const routes = {};
  const app = {
    routes,
    get(p, ...h) { routes['GET ' + p] = h; },
    post(p, ...h) { routes['POST ' + p] = h; },
    run(method, p, { params = {}, query = {}, body = {}, adminAuth = null, headers = {} } = {}) {
      const handlers = routes[method + ' ' + p];
      if (!handlers) throw new Error('ruta no registrada: ' + method + ' ' + p);
      const req = {
        params, query, body, adminAuth,
        get: name => headers[String(name).toLowerCase()] ?? headers[name] ?? undefined
      };
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
    quarantine: (match) => { spy.quarantine++; match.status = 'postponed'; return true; },
    rescheduleMatch: (match, kickoff) => { spy.reschedule = (spy.reschedule || 0) + 1; match.scheduledKickoffAt = kickoff; return true; }
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
  const betting = opts.betting || makeBetting(spy);
  const buildLobby = () => ({ seasonMonth: month, matches: [], standings: [], nextKickoffAt: null });
  const buildMatchState = (id, profileId) => ({ match: { id }, profileId: profileId || null, state: { minute: 0 } });
  const audit = (type, data) => spy.audit.push({ type, data });

  installFootballRoutes(app, {
    store, profiles, betting, buildLobby, buildMatchState,
    getBallonDorMarket: () => opts.ballonDorMarket || null,
    accountConfig: opts.accountConfig || null,
    audioTelemetry: opts.audioTelemetry,
    verifyTosAcceptance: opts.verifyTosAcceptance || ((_profile, tos) => String(tos || '') === 'v1'),
    onBetPlaced: opts.onBetPlaced,
    config: { tosVersion: 'v1' }, log: opts.log || (() => {}),
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

async function runAsync(app, method, route, options) {
  const response = app.run(method, route, options);
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

// ===================== RUTAS PÚBLICAS =====================

test('GET /estadio sirve estadio.html', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/estadio');
  assert.ok(res.sentFile && res.sentFile.endsWith('estadio.html'), 'sendFile estadio.html');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('GET /balon-de-oro sirve la página del evento dedicado', t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/balon-de-oro');
  assert.ok(res.sentFile && res.sentFile.endsWith('estadio.html'), 'usa el cliente de Estadio con contexto de evento dedicado');
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
  assert.equal(ctx.app.run('GET', '/balon-de-oro').statusCode, 404);
  assert.equal(ctx.app.run('GET', '/api/estadio/state').statusCode, 404);
  assert.equal(ctx.app.run('GET', '/api/estadio/standings').statusCode, 404);
  assert.equal(ctx.app.run('GET', '/api/estadio/ballon-dor').statusCode, 404);
  assert.equal(ctx.app.run('POST', '/api/estadio/ballon-dor/bet', { body: { token: 'ignored' } }).statusCode, 404);
  assert.equal(ctx.app.run('POST', '/api/estadio/telemetry/audio', { body: {} }).statusCode, 404);
  assert.equal(ctx.app.run('GET', '/api/estadio/matches/:id', { params: { id: ctx.scheduled.id } }).statusCode, 404);
});

test('telemetría de audio es same-origin, agregada y no conserva tokens ni IDs personales', t => {
  const logged = [];
  const telemetry = createBallonDorAudioTelemetry({
    log: (event, data) => logged.push({ event, data }), limit: 100
  });
  const ctx = setup({ audioTelemetry: telemetry, log: (event, data) => logged.push({ event, data }) });
  t.after(ctx.cleanup);
  const accepted = ctx.app.run('POST', '/api/estadio/telemetry/audio', {
    headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    body: {
      seasonMonth: '2026-11', track: 'opening_narration', outcome: 'started',
      profileId: 'private-profile', token: 'private-token', userAgent: 'private-agent'
    }
  });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(telemetry.snapshot().opening_narration, {
    started: 1, completed: 0, blocked: 0, error: 0
  });
  assert.doesNotMatch(JSON.stringify(logged), /private-profile|private-token|private-agent/);

  const crossOrigin = ctx.app.run('POST', '/api/estadio/telemetry/audio', {
    headers: { origin: 'https://attacker.example', host: 'localhost:3000' },
    body: { seasonMonth: '2026-11', track: 'opening_narration', outcome: 'started' }
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(telemetry.snapshot().opening_narration.started, 1);
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

test('el cliente no puede inventar el resultado: settle ignora su marcador y consulta al motor', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/settle', {
    params: { id: ctx.scheduled.id },
    body: { score: { home: 99, away: 0 }, result: { home: 99, away: 0, winner: 'home' }, winner: 'away' }
  });
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.result, { winner: 'home' }, 'el resultado vuelve exclusivamente de engine.forceFinish');
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

test('GET /admin/estadio/matches devuelve los partidos para gestión administrativa', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/admin/estadio/matches');
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.matches));
  assert.ok(res.body.matches.length > 0);
  assert.equal(res.body.seasonMonth, ctx.month);
});

test('POST /admin/estadio/matches/:id/reschedule reprograma el kickoff y audita', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const oldKickoff = ctx.scheduled.scheduledKickoffAt;
  const newKickoff = 1000 + 3600 * 1000; // futuro respecto a now=1000
  const res = ctx.app.run('POST', '/admin/estadio/matches/:id/reschedule', {
    params: { id: ctx.scheduled.id },
    body: { kickoffAt: newKickoff },
    adminAuth: { profile: { id: 'admin1' } }
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.match.scheduledKickoffAt, newKickoff);
  assert.equal(res.body.oldKickoffAt, oldKickoff);
  assert.equal(ctx.store.getMatch(ctx.scheduled.id).scheduledKickoffAt, newKickoff);
  assert.equal(ctx.spy.audit.some(a => a.type === 'football_match_rescheduled'), true);
});

test('POST /admin/estadio/matches/:id/reschedule rechaza kickoff en el pasado o partido no scheduled', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  // Pasado
  const pastRes = ctx.app.run('POST', '/admin/estadio/matches/:id/reschedule', {
    params: { id: ctx.scheduled.id },
    body: { kickoffAt: 500 } // now es 1000
  });
  assert.equal(pastRes.statusCode, 400);
  assert.equal(pastRes.body.code, 'kickoff_in_past');

  // No scheduled
  ctx.scheduled.status = 'live';
  const liveRes = ctx.app.run('POST', '/admin/estadio/matches/:id/reschedule', {
    params: { id: ctx.scheduled.id },
    body: { kickoffAt: 5000 }
  });
  assert.equal(liveRes.statusCode, 409);
  assert.equal(liveRes.body.code, 'match_not_scheduled');
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

test('footballHealth incluye duración de sweeps y audio únicamente como agregados', () => {
  const engine = makeEngine({});
  const h = footballHealth({
    engine,
    enabled: true,
    ballonDorMarket: { healthSnapshot: () => ({ current: { seasonMonth: '2026-11', status: 'active' }, sweep: { count: 20, errors: 0, p95DurationMs: 19 } }) },
    audioTelemetry: { snapshot: () => ({ opening_narration: { started: 4, completed: 3, blocked: 1, error: 0 } }) }
  });
  assert.equal(h.ballonDor.sweep.p95DurationMs, 19);
  assert.equal(h.ballonDor.audioTelemetry.opening_narration.completed, 3);
  assert.doesNotMatch(JSON.stringify(h.ballonDor), /profileId|token|stake|payout|winner/);
});

test('GET /api/estadio/ballon-dor expone solo la proyección pública del ciclo', t => {
  const market = { market: 'balon_de_oro', seasonMonth: '2026-10', status: 'active', candidates: [{ id: 'c1', odds: 2.5 }] };
  const ctx = setup({ ballonDorMarket: { getMarket: () => market } });
  t.after(ctx.cleanup);
  const res = ctx.app.run('GET', '/api/estadio/ballon-dor');
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.market, market);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('la API permite leer una edición persistida y el archivo solo publica resúmenes públicos', t => {
  const requested = [];
  const archived = [{ seasonMonth: '2026-09', status: 'settled', winner: { playerName: 'Delantero 9', clubName: 'Club 9', score: 300 } }];
  const service = {
    getMarket: month => { requested.push(month); return { seasonMonth: month || '2026-10', status: 'settled', result: null }; },
    getArchive: () => archived
  };
  const ctx = setup({ ballonDorMarket: service });
  t.after(ctx.cleanup);
  const detail = ctx.app.run('GET', '/api/estadio/ballon-dor', { query: { seasonMonth: '2026-09' } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.market.seasonMonth, '2026-09');
  assert.deepEqual(requested, ['2026-09']);
  assert.equal(detail.headers['Cache-Control'], 'no-store');
  const invalid = ctx.app.run('GET', '/api/estadio/ballon-dor', { query: { seasonMonth: '2026-19' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, 'season_month_invalid');
  const archive = ctx.app.run('GET', '/api/estadio/ballon-dor/archive');
  assert.equal(archive.body.ok, true);
  assert.deepEqual(archive.body.cycles, archived);
  assert.equal(archive.headers['Cache-Control'], 'no-store');
});

test('POST Balón de Oro fallback exige origen e identidad existente, usa cuota del servidor y notifica una sola colocación', async t => {
  const received = [];
  const notifications = [];
  let mode = 'success';
  const betting = {
    suspend() {}, closeMarket() {},
    async placeBallonDorBet(args) {
      received.push(args);
      if (mode === 'closed') return { ok: false, code: 'mercado_cerrado' };
      const future = {
        id: 'future-http-test', market: 'balon_de_oro', seasonMonth: '2026-10',
        selection: args.selection, stake: args.stake, odds: 3.25,
        potentialPayout: 325, status: 'open', payout: null, placedAt: 100,
        profileId: args.profile.id, idempotencyKey: args.idempotencyKey
      };
      if (mode !== 'replay') args.profile.chips -= args.stake;
      return { ok: true, future, replayed: mode === 'replay' };
    }
  };
  const ctx = setup({
    betting,
    accountConfig: { appOrigin: 'https://game.example' },
    onBetPlaced: payload => notifications.push(payload)
  });
  t.after(ctx.cleanup);
  const profile = ctx.profiles.getOrCreate('bdo-device-token', 'Alicia');
  profile.chips = 500;
  ctx.profiles.saveNow();
  const headers = {
    origin: 'https://game.example', host: 'game.example', 'idempotency-key': 'header-bdo-key-001'
  };
  const body = {
    token: 'bdo-device-token', selection: 'candidate-server', stake: 100, tos: 'v1',
    idempotencyKey: 'body-key-should-not-win', odds: 999, jornada: 30
  };

  const success = await runAsync(ctx.app, 'POST', '/api/estadio/ballon-dor/bet', { headers, body });
  assert.equal(success.statusCode, 200);
  assert.equal(success.body.ok, true);
  assert.equal(success.body.chips, 400);
  assert.equal(success.body.future.odds, 3.25, 'no se refleja la cuota falsa enviada por el navegador');
  assert.equal(success.body.future.selection, 'candidate-server');
  assert.ok(!('profileId' in success.body.future) && !('idempotencyKey' in success.body.future));
  assert.deepEqual(received[0], {
    profile, selection: 'candidate-server', stake: 100, idempotencyKey: 'header-bdo-key-001'
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].profileId, profile.id);
  assert.equal(success.headers['Cache-Control'], 'no-store');

  const tosRequired = await runAsync(ctx.app, 'POST', '/api/estadio/ballon-dor/bet', {
    headers, body: { ...body, tos: '' }
  });
  assert.equal(tosRequired.statusCode, 403);
  assert.equal(tosRequired.body.code, 'tos_required');
  assert.equal(received.length, 1, 'no se intenta apostar antes de aceptar los términos');

  const deniedOrigin = await runAsync(ctx.app, 'POST', '/api/estadio/ballon-dor/bet', {
    headers: { origin: 'https://evil.example', host: 'game.example' }, body
  });
  assert.equal(deniedOrigin.statusCode, 403);
  assert.equal(deniedOrigin.body.code, 'origin_denied');
  assert.equal(received.length, 1, 'no se toca el servicio de apuesta antes de validar el origen');

  const noIdentity = await runAsync(ctx.app, 'POST', '/api/estadio/ballon-dor/bet', {
    headers, body: { ...body, token: 'not-an-existing-profile' }
  });
  assert.equal(noIdentity.statusCode, 401);
  assert.equal(noIdentity.body.code, 'no_identity');
  assert.equal(ctx.spy.getOrCreate, 1, 'la ruta nunca crea un perfil para el token recibido');

  mode = 'closed';
  const closed = await runAsync(ctx.app, 'POST', '/api/estadio/ballon-dor/bet', { headers, body });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.body.code, 'mercado_cerrado');
  assert.equal(notifications.length, 1, 'los rechazos no actualizan el ranking');

  mode = 'replay';
  const replay = await runAsync(ctx.app, 'POST', '/api/estadio/ballon-dor/bet', { headers, body });
  assert.equal(replay.body.ok, true);
  assert.equal(replay.body.replayed, true);
  assert.equal(notifications.length, 1, 'una reproducción idempotente no vuelve a difundir el ranking');
});

test('POST Balón de Oro fallback admite el mismo host cuando no hay origen configurado', async t => {
  const profile = { id: 'host-profile', chips: 250 };
  let calls = 0;
  const betting = {
    suspend() {}, closeMarket() {},
    async placeBallonDorBet(args) {
      calls++;
      return { ok: true, future: {
        id: 'host-future', market: 'balon_de_oro', seasonMonth: '2026-10',
        selection: args.selection, stake: args.stake, odds: 2, potentialPayout: 200,
        status: 'open', payout: null, placedAt: 1
      } };
    }
  };
  const ctx = setup({ betting });
  t.after(ctx.cleanup);
  ctx.profiles.getProfile = token => token === 'host-token' ? profile : null;
  const res = await runAsync(ctx.app, 'POST', '/api/estadio/ballon-dor/bet', {
    headers: { origin: 'https://arena.local:8443', host: 'arena.local:8443', 'idempotency-key': 'same-host-key-001' },
    body: { token: 'host-token', selection: 'candidate', stake: 100, tos: 'v1' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
});
