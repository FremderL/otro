'use strict';

const crypto = require('node:crypto');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');

function encryptionKey(base64) {
  const key = Buffer.from(String(base64 || ''), 'base64');
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY inválida');
  return key;
}

function encryptSecret(secret, keyBase64) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyBase64), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptSecret(value, keyBase64) {
  const [version, iv, tag, encrypted] = String(value || '').split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Secreto MFA cifrado inválido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyBase64), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

function createTotp({ username, secret = new OTPAuth.Secret({ size: 20 }).base32 }) {
  return new OTPAuth.TOTP({ issuer: 'MonteCristo', label: String(username), algorithm: 'SHA1', digits: 6, period: 30, secret });
}

function verifyTotp(secret, token, timestamp = Date.now()) {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const totp = createTotp({ username: 'cuenta', secret });
  return totp.validate({ token: String(token), timestamp, window: 1 }) !== null;
}

async function beginEnrollment(username, keyBase64) {
  const totp = createTotp({ username: `@${username}` });
  return {
    encryptedSecret: encryptSecret(totp.secret.base32, keyBase64),
    manualKey: totp.secret.base32,
    uri: totp.toString(),
    qrDataUrl: await QRCode.toDataURL(totp.toString(), { errorCorrectionLevel: 'M', margin: 1, width: 240 })
  };
}

function normalizeRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code, pepperBase64) {
  const pepper = Buffer.from(String(pepperBase64 || ''), 'base64');
  if (pepper.length < 32) throw new Error('SESSION_PEPPER inválido');
  return crypto.createHmac('sha256', pepper).update(`recovery:${normalizeRecoveryCode(code)}`).digest('hex');
}

function generateRecoveryCodes(count = 10, pepperBase64) {
  const codes = [];
  const hashes = [];
  for (let index = 0; index < count; index += 1) {
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
    codes.push(code);
    hashes.push(hashRecoveryCode(code, pepperBase64));
  }
  return { codes, hashes };
}

function consumeRecoveryCode(hashes, code, pepperBase64) {
  const candidate = hashRecoveryCode(code, pepperBase64);
  const index = Array.isArray(hashes) ? hashes.findIndex(hash => {
    const left = Buffer.from(String(hash));
    const right = Buffer.from(candidate);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }) : -1;
  if (index < 0) return { valid: false, hashes: Array.isArray(hashes) ? [...hashes] : [] };
  return { valid: true, hashes: hashes.filter((_, itemIndex) => itemIndex !== index) };
}

module.exports = {
  encryptSecret, decryptSecret, createTotp, verifyTotp, beginEnrollment,
  normalizeRecoveryCode, hashRecoveryCode, generateRecoveryCodes, consumeRecoveryCode
};
