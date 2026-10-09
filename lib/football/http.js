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
const { publicTeams } = require('./sockets');

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

function installFootballRoutes(app, deps) {
  const d = deps || {};
  const isEnabled = () => (typeof d.enabled === 'function' ? d.enabled() : true);
  const log = (event, data) => { if (typeof d.log === 'function') d.log(event, data); };
  const unavailable = (res) => res.status(404).json({ ok: false, error: 'Estadio no disponible.' });
  const publicDir = () => d.publicDir || path.join(__dirname, '..', '..', 'public');

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

  function gate(req, res, next) {
    if (!d.adminConfig || !d.adminConfig.enabled) return res.status(404).json({ error: 'Administración no disponible.' });
    return guard(req, res, next);
  }
  function getMatch(req, res) {
    const id = String(req.params.id || req.params.matchId || '').slice(0, 80);
    const match = d.store ? d.store.getMatch(id) : null;
    if (!match) { res.status(404).json({ ok: false, error: 'no_match' }); return null; }
    return match;
  }
  const who = (req) => (req.adminAuth && req.adminAuth.profile ? req.adminAuth.profile.id : 'admin');

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
