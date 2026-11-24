'use strict';

// Orígenes permitidos para el handshake de Socket.IO y para las conexiones
// con credenciales.
//
// Antes el servidor usaba `cors: { origin: true, credentials: true }`, que
// refleja CUALQUIER origen: una página de terceros podía abrir un socket con
// las cookies de la víctima y actuar en su nombre (el CSRF de socket no lo
// cubre el token CSRF de /api/auth, que es solo HTTP). Además el handshake no
// miraba el header Origin.
//
// Reglas:
//   · APP_ORIGIN (el mismo que valida /api/auth) siempre se permite.
//   · ALLOWED_ORIGINS admite una lista separada por comas (previews, dominios
//     antiguos, etc.).
//   · En producción se exige lista: un origen desconocido se rechaza.
//   · Fuera de producción, sin lista configurada, se permite cualquier origen
//     (comodidad de desarrollo y previews) y se permite localhost siempre.

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '').toLowerCase();
}

function splitList(value) {
  return String(value || '').split(',').map(item => normalizeOrigin(item)).filter(Boolean);
}

function resolveAllowedOrigins(env = process.env, adminConfig = {}) {
  const allowed = new Set();
  if (adminConfig.appOrigin) allowed.add(normalizeOrigin(adminConfig.appOrigin));
  for (const origin of splitList(env.ALLOWED_ORIGINS)) allowed.add(origin);
  return allowed;
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function isProduction(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

// `origin` puede venir vacío en clientes que no son navegadores (scripts,
// tests, apps nativas). Esos no llevan cookies de un origen ajeno, así que se
// permiten: bloquearlos rompería los tests de integración y herramientas CLI.
function originAllowed(origin, allowed, env = process.env) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return true;
  if (allowed.has(normalized)) return true;
  if (!isProduction(env) && isLoopbackOrigin(normalized)) return true;
  if (!isProduction(env) && allowed.size === 0) return true;
  return false;
}

// Valor para la opción `cors` de Socket.IO: función que devuelve el origen
// reflejado solo si está permitido. Devolver `false` hace que Socket.IO no
// emita los headers CORS (el navegador rechaza la conexión).
function socketCorsOptions(env = process.env, adminConfig = {}) {
  const allowed = resolveAllowedOrigins(env, adminConfig);
  return {
    credentials: true,
    origin: (origin, callback) => callback(null, originAllowed(origin, allowed, env))
  };
}

module.exports = {
  resolveAllowedOrigins, originAllowed, socketCorsOptions, normalizeOrigin, isLoopbackOrigin
};
