'use strict';

// Preparación transaccional de un compromiso privado. Esta función todavía no
// selecciona automáticamente V2 ni habilita mercados: el llamador debe resolver
// primero las cuotas y las garantías de liquidación del producto completo.
const { prepareMatchInputs, previousMonth } = require('./inputs');
const { makeCommitment, verifyCommitment, commitmentId } = require('./commitment');
const { withSeasonAdmission } = require('../season-admission');
const { newKey } = require('./secure-random');
const { createQuoteModel } = require('./quotes');

const pending = new WeakMap();
const accepted = item => item.status !== 'void' || Boolean(item.debited);

function hasPriorObligations(store, match) {
  const bets = store.getBets?.({ matchId: match.id }) || [];
  const parlays = store.getParlays?.() || [];
  const futures = store.getFutures?.({ seasonMonth: match.seasonMonth }) || [];
  const id = match.simulation ? commitmentId(match.simulation) : null;
  return bets.some(accepted)
    || parlays.some(item => accepted(item) && (item.legs || []).some(leg => leg.matchId === match.id))
    || futures.some(item => accepted(item) && (!id || !(item.simulationCommitments || [])
      .some(commitment => commitment.matchId === match.id && commitment.id === id)));
}

function markUnconfirmed(match, value) {
  Object.defineProperty(match, 'simulationUnconfirmed', { value, writable: true, configurable: true, enumerable: false });
}

async function commitOnce({ store, match, asOf, keyFactory }) {
  if (!store || !match || store.getMatch?.(match.id, match.seasonMonth) !== match) return { ok: false, reason: 'partido_inexistente' };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(match.seasonMonth)) || match.seasonMonth < '2026-11') {
    return { ok: false, reason: 'temporada_anterior' };
  }
  if (match.status !== 'scheduled' || match.desempate || !Number.isSafeInteger(asOf)
      || asOf < 1 || !Number.isSafeInteger(match.scheduledKickoffAt) || asOf >= match.scheduledKickoffAt) {
    return { ok: false, reason: 'partido_no_preparable' };
  }
  if (typeof store.saveStrict !== 'function') return { ok: false, reason: 'persistencia_no_confirmable' };
  if (match.simulation) {
    if (!verifyCommitment(match.simulation, match)) return { ok: false, reason: 'compromiso_invalido' };
    if (!match.simulationUnconfirmed) return { ok: true, existing: true };
  } else {
    if (hasPriorObligations(store, match)) return { ok: false, reason: 'compromisos_anteriores' };
    const league = store.getLeague(match.seasonMonth);
    const previousLeague = store.getLeague(previousMonth(match.seasonMonth));
    let inputs, key;
    try {
      inputs = prepareMatchInputs({ league, previousLeague, match, asOf, seed: 0 });
      key = keyFactory();
      match.simulation = makeCommitment(inputs, key, asOf);
      markUnconfirmed(match, true);
    } catch (error) {
      return { ok: false, reason: 'entradas_invalidas', message: String(error?.message || error) };
    }
  }
  // No deshacer el compromiso al fallar: un guardado previo en vuelo podría
  // haberlo escrito. Se conserva la misma clave y se reintenta su confirmación.
  try {
    if (!(await store.saveStrict())) return { ok: false, reason: 'persistencia_pendiente' };
  } catch (_) { return { ok: false, reason: 'persistencia_pendiente' }; }
  markUnconfirmed(match, false);
  return { ok: true, existing: false };
}

function prepareV2Match({ store, match, asOf = Date.now(), keyFactory = newKey } = {}) {
  if (!store || !match || typeof match !== 'object' || typeof keyFactory !== 'function') {
    return Promise.resolve({ ok: false, reason: 'partido_inexistente' });
  }
  let byMatch = pending.get(store);
  if (!byMatch) { byMatch = new Map(); pending.set(store, byMatch); }
  if (byMatch.has(match.id)) return byMatch.get(match.id);
  const operation = withSeasonAdmission(store, match.seasonMonth, () => commitOnce({ store, match, asOf, keyFactory }));
  byMatch.set(match.id, operation);
  return operation.finally(() => { if (byMatch.get(match.id) === operation) byMatch.delete(match.id); });
}

// Adjunta una calibración independiente al mismo compromiso, antes de que se
// acepte ningún boleto. No sustituye una calibración previamente confirmada.
function attachV2Pricing({ store, match, training, holdout, asOf = Date.now() } = {}) {
  if (!store || !match || typeof match !== 'object') return Promise.resolve({ ok: false, reason: 'partido_inexistente' });
  let byMatch = pending.get(store);
  if (!byMatch) { byMatch = new Map(); pending.set(store, byMatch); }
  if (byMatch.has(match.id)) return byMatch.get(match.id);
  const operation = withSeasonAdmission(store, match.seasonMonth, async () => {
    if (store.getMatch?.(match.id, match.seasonMonth) !== match || !match.simulation
        || !verifyCommitment(match.simulation, match)) return { ok: false, reason: 'compromiso_invalido' };
    if (match.status !== 'scheduled' || !Number.isSafeInteger(asOf) || asOf < match.simulation.preparedAt
        || asOf >= match.scheduledKickoffAt) return { ok: false, reason: 'partido_no_preparable' };
    if (typeof store.saveStrict !== 'function') return { ok: false, reason: 'persistencia_no_confirmable' };
    if (match.simulation.pricing && !match.simulationUnconfirmed) return { ok: true, existing: true };
    if (!match.simulation.pricing) {
      if (match.simulationUnconfirmed) return { ok: false, reason: 'compromiso_no_confirmado' };
      if (hasPriorObligations(store, match)) return { ok: false, reason: 'compromisos_anteriores' };
      try { match.simulation.pricing = createQuoteModel(match.simulation.inputs, match.simulation.privateSeed, training, holdout); }
      catch (error) { return { ok: false, reason: 'calibracion_invalida', message: String(error?.message || error) }; }
      markUnconfirmed(match, true);
    }
    try { if (!(await store.saveStrict())) return { ok: false, reason: 'persistencia_pendiente' }; }
    catch (_) { return { ok: false, reason: 'persistencia_pendiente' }; }
    markUnconfirmed(match, false);
    return { ok: true, existing: false };
  });
  byMatch.set(match.id, operation);
  return operation.finally(() => { if (byMatch.get(match.id) === operation) byMatch.delete(match.id); });
}

module.exports = { prepareV2Match, attachV2Pricing, hasPriorObligations };
