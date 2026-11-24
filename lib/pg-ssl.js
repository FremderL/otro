'use strict';

// Configuración TLS para pools de Postgres.
//
// Por defecto se verifica el certificado del servidor (rejectUnauthorized: true).
// Solo se desactiva cuando:
//   · la cadena trae `sslmode=disable` explícito (Postgres local de pruebas), o
//   · el operador define PGSSL_REJECT_UNAUTHORIZED=false de forma explícita
//     (entornos con CA auto-firmada sin bundle; se registra un aviso).
//
// Antes todos los pools usaban rejectUnauthorized:false, lo que permitía MITM
// contra Neon/hosted PG y exponer passwordHash, tokens de sesión y secretos MFA.

function resolvePgSsl(connectionString, env = process.env) {
  const cs = String(connectionString || '');
  if (/sslmode=disable/i.test(cs)) return false;
  if (String(env.PGSSL_REJECT_UNAUTHORIZED || '').toLowerCase() === 'false') {
    console.warn('[PG-SSL] PGSSL_REJECT_UNAUTHORIZED=false: verificación TLS desactivada. Solo para desarrollo local.');
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

module.exports = { resolvePgSsl };
