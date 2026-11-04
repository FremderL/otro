'use strict';

const { sessionState } = require('./account-sessions');
const { deviceIdentity } = require('./device-links');

// Lecturas sin cartera. Todo lo demás (mesas, bonos, compras, apuestas, cobros,
// perfil privado, comunidad y torneos) exige identidad económica válida.
const READ_EVENTS = new Set([
  'disconnect', 'bet_ranking_get', 'bet_ranking_unsubscribe', 'lobby_get', 'lobby_state_get',
  'lobby_chat_history', 'lobby_tournaments_get', 'account_session_status',
  'football:subscribe', 'football:unsubscribe', 'football:lobby_get', 'football:match_get',
  'football:bet_history', 'football:commentary_history', 'football:news_get', 'football:daily_news_get',
  'football:ballon_dor_market', 'football:futures_market', 'football:quiniela_get', 'football:fan_get',
  'football:fantasy_get', 'football:club_profile_get', 'football:roster_get', 'football:transfers_get',
  'football:stands_state', 'loteria_subscribe', 'account_profile', 'table_profile_get', 'friend_invites_get', 'friend_presence_get'
]);
const SESSION_RECHECK_MS = 15000;

function createSocketIdentityGuard({ enabled, profiles, sessions, deviceLinks, now = () => Date.now() }) {
  async function resolve(socket, { force = false } = {}) {
    if (!enabled()) return { mode: 'guest', profileId: socket.handshake?.auth?.deviceToken || null };
    const token = String(socket.handshake?.auth?.deviceToken || '').slice(0, 80);
    const link = await deviceLinks.get(token);
    socket.data.deviceLink = link?.profileId ? link : null;
    let sessionId = socket.data.accountSessionId;
    let profileId = socket.data.accountProfileId;
    if (sessionId && profileId && !force && now() - (socket.data.sessionCheckedAt || 0) < SESSION_RECHECK_MS) {
      const profile = profiles.getProfile(profileId);
      const expiresAt = socket.data.sessionExpiresAt || 0;
      if (profile?.username && expiresAt > now()) return deviceIdentity({ link, accountProfileId: profileId, token });
      sessionId = null; profileId = null;
    }
    if (sessionId) {
      const session = await sessions.findByToken(socket.data.accountSessionToken);
      const profile = session && profiles.getProfile(session.profileId);
      const state = profile && sessionState(session, { now: now(), sessionVersion: profile.security?.sessionVersion || 1 });
      if (state?.valid && profile.username) {
        socket.data.accountProfileId = profile.id;
        socket.data.accountRole = profile.role || 'user';
        socket.data.sessionCheckedAt = now();
        socket.data.sessionExpiresAt = Math.min(session.idleExpiresAt, session.absoluteExpiresAt);
        await sessions.touch(session.id, { now: now(), role: profile.role || 'user' });
        if (link?.profileId !== profile.id || link?.mode !== 'account') {
          socket.data.deviceLink = await deviceLinks.set(token, profile.id, 'account', now());
        }
        return { mode: 'account', profileId: profile.id };
      }
    }
    socket.data.accountProfileId = null;
    socket.data.accountSessionId = null;
    socket.data.accountSessionToken = null;
    socket.data.sessionCheckedAt = now();
    return deviceIdentity({ link: socket.data.deviceLink, accountProfileId: null, token });
  }

  function deny(socket, ack, identity) {
    const code = identity.mode === 'login_required' ? 'account_session_required' : 'identity_required';
    socket.emit('account_session_state', { mode: identity.mode, code });
    if (typeof ack === 'function') ack({ ok: false, code, error: 'Tu sesión caducó. Inicia sesión para continuar; tus fichas siguen en tu cuenta.' });
  }

  async function guard(socket, event, args) {
    if (!enabled()) return true;
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      const identity = await resolve(socket, { force: !READ_EVENTS.has(event) });
      socket.data.identityMode = identity.mode;
      if (identity.mode === 'account') return true;
      // No conservar una identidad privada de cuenta en lecturas tras caducar.
      if (identity.mode === 'login_required') { socket.data.football = null; socket.data.loteriaProfileId = null; }
      if (identity.mode === 'login_required' && !READ_EVENTS.has(event)) { deny(socket, ack, identity); return false; }
      // Una cuenta autenticada nunca puede usar un perfil invitado aunque el
      // handler tenga un fallback legado por asiento o accountId.
      const profile = socket.data.playerId ? profiles.getProfile(socket.data.playerId) : null;
      if (profile?.mergedInto) { deny(socket, ack, { mode: 'login_required' }); return false; }
      return true;
    } catch (_) {
      // Error de identidad/almacén: no se convierte en modo invitado.
      if (typeof ack === 'function') ack({ ok: false, code: 'session_unavailable', error: 'No se pudo verificar la sesión. Intenta de nuevo.' });
      return false;
    }
  }
  return { resolve, guard };
}

module.exports = { createSocketIdentityGuard, READ_EVENTS };
