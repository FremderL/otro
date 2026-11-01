'use strict';

// Compromiso secreto de temporada: fija la versión y un seed raíz ANTES de
// aceptar futuros, sin congelar todavía los datos de cada partido. Así cada
// encuentro se prepara con la información disponible en su propio momento.
const crypto = require('node:crypto');
const { newKey, derivedKey } = require('./secure-random');
const { current, knockout, supportedVersion } = require('./versions');
const { VERSION: PRICING_VERSION } = require('./estimated-quotes');
const { VERSION: LEGACY_PRICING_VERSION } = require('./estimated-quotes-v1');
const SUPPORTED_PRICING_VERSIONS = new Set([PRICING_VERSION, LEGACY_PRICING_VERSION]);

const VERSION = 'v2-season-1';
function policyId(policy) {
  if (!policy || !/^[0-9a-f]{64}$/i.test(String(policy.privateSeed || ''))) return null;
  return crypto.createHash('sha256').update('estadio-v2-season\0').update(policy.seasonMonth)
    .update('\0').update(policy.simulatorVersion).update('\0').update(policy.knockoutVersion).update('\0').update(policy.pricingVersion)
    .update('\0').update(Buffer.from(policy.privateSeed, 'hex')).digest('hex');
}
function createPolicy(seasonMonth, at = Date.now(), privateSeed = newKey()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(seasonMonth)) || seasonMonth < '2026-11'
      || !Number.isSafeInteger(at) || at < 1 || !/^[0-9a-f]{64}$/i.test(String(privateSeed))) {
    throw new Error('política V2 inválida');
  }
  const policy = { version: VERSION, seasonMonth, simulatorVersion: current.VERSION, knockoutVersion: knockout.VERSION,
    pricingVersion: PRICING_VERSION, privateSeed, createdAt: at };
  return { ...policy, id: policyId(policy) };
}
function verifyPolicy(policy, seasonMonth) {
  try {
    return Boolean(policy && policy.version === VERSION && policy.seasonMonth === seasonMonth
      && supportedVersion(policy.simulatorVersion) && policy.knockoutVersion === knockout.VERSION
      && SUPPORTED_PRICING_VERSIONS.has(policy.pricingVersion)
      && Number.isSafeInteger(policy.createdAt) && policy.createdAt > 0
      && /^[0-9a-f]{64}$/i.test(String(policy.id || '')) && policy.id === policyId(policy));
  } catch (_) { return false; }
}
function cleanPolicy(raw, seasonMonth) {
  if (!verifyPolicy(raw, seasonMonth)) return { version: 'invalid', invalid: true };
  return { version: raw.version, seasonMonth: raw.seasonMonth, simulatorVersion: raw.simulatorVersion, knockoutVersion: raw.knockoutVersion,
    pricingVersion: raw.pricingVersion, privateSeed: raw.privateSeed, createdAt: raw.createdAt, id: raw.id };
}
function upgradePolicy(raw, seasonMonth) {
  if (!verifyPolicy(raw, seasonMonth)) throw new Error('política V2 inválida');
  const next = { ...raw, simulatorVersion: current.VERSION, pricingVersion: PRICING_VERSION };
  return { ...next, id: policyId(next) };
}
function matchKey(policy, match) {
  if (!match || !verifyPolicy(policy, match.seasonMonth) || typeof match.id !== 'string' || !match.id) {
    throw new Error('política de partido inválida');
  }
  return derivedKey(policy.privateSeed, `official-match:${match.id}`);
}

module.exports = { VERSION, createPolicy, verifyPolicy, cleanPolicy, upgradePolicy, matchKey, policyId };
