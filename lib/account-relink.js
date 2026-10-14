'use strict';

// Reasigna una cuenta (usuario, contraseña, rol y seguridad/MFA) a un perfil
// existente que hoy no tiene cuenta. Caso de uso: la cuenta quedó en un
// perfil congelado mientras la persona jugaba con el perfil de su dispositivo.
//
// Solo mueve credenciales. No toca fichas, historial, estadísticas ni logros de
// ningún perfil. El perfil de origen conserva sus datos, pero deja de tener
// usuario y contraseña, así que ya no puede iniciar sesión.
//
// planAccountRelink() no modifica nada. applyAccountRelink() cambia los objetos
// del plan en memoria; quien llama los persiste (ver scripts/relink-account.js,
// que lo hace en una sola transacción). Hay que detener el servidor antes: si
// sigue vivo, sus copias en memoria pisarían el cambio.

const { normalizeUsername } = require('./profile-store-shared');

function planAccountRelink(store, { username, targetId } = {}) {
  const normalized = normalizeUsername(username);
  if (!normalized) return { ok: false, error: 'Usuario no válido.' };
  const source = store.findByUsername(normalized);
  if (!source) return { ok: false, error: `No existe la cuenta «${normalized}».` };
  const target = targetId ? store.profiles.get(String(targetId)) : null;
  if (!target) return { ok: false, error: 'No existe el perfil destino con ese id.' };
  if (target.id === source.id) return { ok: false, error: 'El perfil destino ya es esa cuenta.' };
  if (target.username) return { ok: false, error: `El perfil destino ya tiene el usuario «${target.username}».` };
  return {
    ok: true,
    source: { id: source.id, name: source.name, chips: source.chips, role: source.role },
    target: { id: target.id, name: target.name, chips: target.chips, role: target.role },
    // Referencias internas para aplicar el plan; no se devuelven en la salida.
    _source: source,
    _target: target,
    username: normalized
  };
}

function applyAccountRelink(plan) {
  if (!plan?.ok) return { ok: false, error: plan?.error || 'Plan no válido.' };
  const source = plan._source;
  const target = plan._target;
  // Un usuario solo puede pertenecer a un perfil: primero se libera en origen.
  const credentials = {
    username: source.username,
    passwordHash: source.passwordHash,
    role: source.role || 'user',
    security: { ...(source.security || {}) }
  };
  source.username = null;
  source.passwordHash = null;
  source.role = 'user';
  // Versión de sesión nueva en origen: las cookies emitidas para la cuenta ya no valen.
  source.security = {
    ...(source.security || {}),
    sessionVersion: Math.max(1, Math.floor(Number(source.security?.sessionVersion) || 1)) + 1,
    mfaEnabled: false, mfaSecretEncrypted: null, mfaPendingSecretEncrypted: null,
    recoveryCodeHashes: [], mfaEnrolledAt: null
  };
  target.username = credentials.username;
  target.passwordHash = credentials.passwordHash;
  target.role = credentials.role;
  target.security = {
    ...credentials.security,
    sessionVersion: Math.max(1, Math.floor(Number(credentials.security.sessionVersion) || 1)) + 1
  };
  return { ok: true, username: credentials.username, sourceId: source.id, targetId: target.id };
}

module.exports = { planAccountRelink, applyAccountRelink };
