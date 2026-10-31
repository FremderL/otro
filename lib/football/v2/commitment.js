'use strict';

// Contrato privado para pruebas de integración. El `privateSeed` NO es un
// payload público. La activación de producción requiere persistencia durable
// antes de comenzar, control de apuestas y calibración aprobada por separado.
const crypto = require('node:crypto');
const { supportedVersion, knockout } = require('./versions');
const { hashInputs } = require('./calibration');
const quotes = require('./quotes');

function makeCommitment(input, privateSeed, preparedAt = Date.now(), pricing = null) {
  if (!input || !supportedVersion(input.version) || !/^[0-9a-f]{64}$/i.test(String(privateSeed))
      || !Number.isSafeInteger(preparedAt) || preparedAt < 1) throw new Error('compromiso V2 inválido');
  const frozen = JSON.parse(JSON.stringify(input));
  if (JSON.stringify(frozen).length > 100000) throw new Error('entrada V2 demasiado grande');
  const record = { version: frozen.version, inputs: frozen, inputsHash: hashInputs(frozen), privateSeed, preparedAt };
  if (pricing) {
    if (pricing.version === quotes.ESTIMATED_VERSION) {
      if (!quotes.validModel(pricing, frozen)) throw new Error('calibración estimada inválida');
      record.pricing = quotes.createEstimatedModel(frozen);
    } else record.pricing = quotes.createQuoteModel(frozen, privateSeed, pricing.training, pricing.holdout, pricing.version);
  }
  return record;
}

// Identifica las obligaciones del partido sin publicar la clave aleatoria.
function commitmentId(record) {
  if (!record || !/^[0-9a-f]{64}$/i.test(String(record.privateSeed || '')) || !/^[0-9a-f]{64}$/i.test(String(record.inputsHash || ''))) return null;
  return crypto.createHash('sha256').update('estadio-v2-commitment\0').update(String(record.version))
    .update('\0').update(record.inputsHash).update('\0').update(record.privateSeed).digest('hex');
}

function verifyCommitment(record, match) {
  if (!record || !supportedVersion(record.version) || !record.inputs || record.inputs.version !== record.version
      || !/^[0-9a-f]{64}$/i.test(String(record.privateSeed || ''))
      || !/^[0-9a-f]{64}$/i.test(String(record.inputsHash || ''))
      || !Number.isSafeInteger(record.preparedAt) || record.preparedAt < 1
      || record.inputs.home?.id !== match?.homeId || record.inputs.away?.id !== match?.awayId
      || record.inputs.source?.currentSeason !== match?.seasonMonth
      || Boolean(match?.desempate) !== (record.version === knockout.VERSION && record.inputs.knockout === true)
      || (!match?.desempate && record.inputs.knockout === true)) return false;
  try {
    if (JSON.stringify(record.inputs).length > 100000 || hashInputs(record.inputs) !== record.inputsHash) return false;
    if (record.pricing) {
      const seedHash = crypto.createHash('sha256').update(Buffer.from(record.privateSeed, 'hex')).digest('hex');
      if (JSON.stringify(record.pricing).length > 2000000 || record.pricing.simulatorVersion !== record.version
          || record.pricing.inputHash !== record.inputsHash
          || record.pricing.training?.keyCommitment === seedHash || record.pricing.holdout?.keyCommitment === seedHash
          || !quotes.validModel(record.pricing, record.inputs)) return false;
    }
    return true;
  } catch (_) { return false; }
}

// Al rehidratar se conserva una marca inválida en vez de convertir un V2 dañado
// en V1: nunca se cambia de motor silenciosamente después de aceptar apuestas.
function cleanCommitment(raw, match) {
  // PostgreSQL conserva el orden original del JSON del compromiso en una
  // cadena; JSONB ordenaría sus claves y rompería los hashes versionados.
  if (typeof raw === 'string') {
    try { raw = raw.length <= 2200000 ? JSON.parse(raw) : null; }
    catch (_) { raw = null; }
  }
  if (!raw || typeof raw !== 'object') return { version: 'invalid', invalid: true };
  if (!verifyCommitment(raw, match)) return { version: String(raw.version || 'invalid').slice(0, 80), invalid: true };
  return makeCommitment(raw.inputs, raw.privateSeed, raw.preparedAt, raw.pricing || null);
}

module.exports = { makeCommitment, verifyCommitment, cleanCommitment, commitmentId };
