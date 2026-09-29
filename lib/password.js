'use strict';

// Fase 11.2 — Hash de contraseñas para el login opcional.
//
// Usa `scrypt` de node:crypto (nativo, sin dependencia npm nueva) con una
// sal aleatoria por contraseña. El formato guardado es "saltHex:hashHex" en
// un solo string, para no tener que tocar el esquema de cada backend
// (archivo JSON o Postgres) con una columna extra.

const crypto = require('node:crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch (_) {
    return false;
  }
  const derived = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  // Longitud distinta -> timingSafeEqual lanzaría; tratamos eso como "no coincide".
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
