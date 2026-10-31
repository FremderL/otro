'use strict';

// Flujo privado, determinista y separado por dominio. La clave de un partido
// se debe generar con randomBytes(32), persistir de forma segura y nunca enviar
// al cliente. ChaCha20 evita depender de la semilla pública de 32 bits de V1.
const crypto = require('node:crypto');

function secureRandom(keyHex, domain = 'match') {
  if (!/^[0-9a-f]{64}$/i.test(String(keyHex))) throw new Error('se requiere una clave de 256 bits');
  if (typeof domain !== 'string' || !domain || domain.length > 128) throw new Error('dominio aleatorio inválido');
  const key = crypto.createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(`estadio-v2:${domain}`, 'utf8').digest();
  const cipher = crypto.createCipheriv('chacha20', key, Buffer.alloc(16));
  let block = Buffer.alloc(0), offset = 0;
  return function next() {
    if (offset + 4 > block.length) {
      block = cipher.update(Buffer.alloc(4096));
      offset = 0;
    }
    const value = block.readUInt32LE(offset);
    offset += 4;
    return value / 0x100000000;
  };
}

function newKey() { return crypto.randomBytes(32).toString('hex'); }
function derivedKey(keyHex, domain) {
  if (!/^[0-9a-f]{64}$/i.test(String(keyHex))) throw new Error('se requiere una clave de 256 bits');
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(String(domain), 'utf8').digest('hex');
}

module.exports = { secureRandom, newKey, derivedKey };
