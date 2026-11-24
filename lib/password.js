'use strict';

// Fase 11.2 — Hash de contraseñas para el login opcional.
//
// Usa `scrypt` de node:crypto (nativo, sin dependencia npm nueva) con una
// sal aleatoria por contraseña. El formato guardado es "saltHex:hashHex" en
// un solo string, para no tener que tocar el esquema de cada backend
// (archivo JSON o Postgres) con una columna extra.
//
// Dos APIs:
//   · hashPassword / verifyPassword (síncronas, vía scryptSync): se mantienen
//     para compatibilidad con tests y flujos ya existentes. Bloquean el loop
//     ~50-100 ms por llamada: NO usar en el camino caliente de login.
//   · hashPasswordAsync / verifyPasswordAsync (asíncronas, vía crypto.scrypt):
//     es la vía que usan los handlers HTTP/socket de login y registro. Un
//     semáforo limita la concurrencia para que un ataque de fuerza bruta no
//     sature la CPU del proceso.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scryptAsync = promisify(crypto.scrypt);

const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;

// Semáforo simple para acotar scrypt concurrentes. scrypt es deliberadamente
// caro; sin límite, N logins simultáneos agotan la CPU y bloquean el resto
// del casino (todas las mesas comparten el mismo loop).
const MAX_CONCURRENT_SCRYPT = 4;
let scryptActive = 0;
const scryptQueue = [];

function withScryptSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      scryptActive += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          scryptActive -= 1;
          const next = scryptQueue.shift();
          if (next) next();
        });
    };
    if (scryptActive < MAX_CONCURRENT_SCRYPT) start();
    else scryptQueue.push(start);
  });
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `La contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y ${MAX_PASSWORD_LENGTH} caracteres.` };
  }
  return { ok: true };
}

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

async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await withScryptSlot(() => scryptAsync(String(password), salt, KEY_LENGTH));
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPasswordAsync(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch (_) {
    return false;
  }
  const derived = await withScryptSlot(() => scryptAsync(String(password), salt, KEY_LENGTH));
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// Hash de una contraseña aleatoria, generado una sola vez por proceso. Se usa
// para igualar el tiempo de respuesta cuando el usuario no existe: sin esto,
// un login con usuario inexistente responde al instante y uno real tarda
// ~50 ms en scrypt, lo que permite enumerar cuentas por timing.
let dummyHash = null;
function getDummyHash() {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(24).toString('base64url'));
  return dummyHash;
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashPasswordAsync,
  verifyPasswordAsync,
  validatePassword,
  getDummyHash,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH
};
