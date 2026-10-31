'use strict';

// Activación progresiva del motor oficial. Una política de temporada persistida
// compromete la aleatoriedad de todos los partidos; cada snapshot se congela al
// preparar ese encuentro, no al crear el calendario de 30 jornadas.
const { withSeasonAdmission } = require('../season-admission');
const { prepareMatchInputs, previousMonth } = require('./inputs');
const { makeCommitment, verifyCommitment, commitmentId } = require('./commitment');
const policy = require('./season-policy');
const quotes = require('./quotes');
const { current } = require('./versions');

const HORIZON_MS = 24 * 60 * 60 * 1000;
function accepted(item) { return item && item.status !== 'void' && (item.status !== 'pending' || item.debited); }
function futures(store, seasonMonth) { return store.getFutures?.({ seasonMonth }) || []; }
function bets(store, matchId) { return store.getBets?.({ matchId }) || []; }
function parlays(store, seasonMonth) { return store.getParlays?.({ seasonMonth }) || []; }

function requiresLegacy(store, league, match) {
  if (bets(store, match.id).some(bet => accepted(bet) && !bet.simulationId)) return true;
  if (parlays(store, match.seasonMonth).some(parlay => accepted(parlay)
      && (parlay.legs || []).some(leg => leg.matchId === match.id && !leg.simulationId))) return true;
  return futures(store, match.seasonMonth).some(future => {
    if (!accepted(future)) return false;
    const explicit = (future.simulationCommitments || []).find(item => item.matchId === match.id);
    if (explicit) return !match.simulation || explicit.id !== commitmentId(match.simulation);
    return !policy.verifyPolicy(league?.simulationPolicy, match.seasonMonth)
      || future.simulationPolicyId !== league.simulationPolicy.id;
  });
}

function createOfficialV2({ store, now = () => Date.now(), log = () => {} }) {
  if (!store || typeof store.saveStrict !== 'function') throw new Error('V2 requiere persistencia durable');
  let preparing = null;

  async function ensureSeason(seasonMonth, at = now()) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(seasonMonth || ''))) return { ok: false, reason: 'temporada_invalida' };
    if (seasonMonth < '2026-11') return { ok: false, legacy: true, reason: 'temporada_anterior' };
    return withSeasonAdmission(store, seasonMonth, async () => {
      const league = store.getLeague(seasonMonth);
      if (!league) return { ok: false, reason: 'sin_temporada' };
      if (league.simulationPolicy && !policy.verifyPolicy(league.simulationPolicy, seasonMonth)) {
        return { ok: false, reason: 'politica_invalida' };
      }
      // Futuros antiguos no se reinterpretan. No se les asigna una política
      // posterior a su aceptación, ni se crean futuros V2 engañosos.
      if (!league.simulationPolicy && futures(store, seasonMonth).some(accepted)) {
        return { ok: false, legacy: true, reason: 'futuro_anterior' };
      }
      if (!league.simulationPolicy) {
        league.simulationPolicy = policy.createPolicy(seasonMonth, at);
        league.simulationPolicyUnconfirmed = true;
        // La cuota no aceptada del ciclo anterior se recalcula con V2. Nunca se
        // toca si existe un futuro aceptado (la admisión anterior lo impide).
        if (league.ballonDor?.status === 'active' && league.ballonDor.oddsSnapshot) league.ballonDor.oddsSnapshot = null;
      }
      if (league.simulationPolicyUnconfirmed) {
        try { if (!(await store.saveStrict())) throw new Error('guardado fallido'); delete league.simulationPolicyUnconfirmed; }
        catch (error) {
          log('football_v2_policy_persist_error', { seasonMonth, message: String(error?.message || error) });
          return { ok: false, reason: 'persistencia_pendiente' };
        }
      }
      return { ok: true, policyId: league.simulationPolicy.id };
    });
  }

  function snapshot(league, match, at) {
    const input = prepareMatchInputs({ league, previousLeague: store.getLeague(previousMonth(match.seasonMonth)), match, asOf: at, seed: 0 });
    input.version = match.desempate ? league.simulationPolicy?.knockoutVersion
      : (league.simulationPolicy?.simulatorVersion || current.VERSION);
    if (match.desempate) input.knockout = true;
    return input;
  }
  function preview(match, at = now()) {
    if (!match || match.seasonMonth < '2026-11' || match.simulation || match.status !== 'scheduled') return null;
    const league = store.getLeague(match.seasonMonth);
    if (!league || (league.simulationPolicy && !policy.verifyPolicy(league.simulationPolicy, match.seasonMonth))
        || requiresLegacy(store, league, match)) return null;
    try {
      const input = snapshot(league, match, at), model = quotes.createEstimatedModel(input);
      return { quoteModel: model, matrix: quotes.scoreMatrix(model),
        lineups: { home: input.home.lineup, away: input.away.lineup }, provisional: true };
    } catch (_) { return null; }
  }
  function attach(league, match, at) {
    if (match.simulation) {
      if (!verifyCommitment(match.simulation, match)) throw new Error('compromiso V2 inválido');
      if (!match.simulation.pricing) {
        // Añadir cuotas no cambia ni el replay ni el identificador de compromisos previos.
        match.simulation.pricing = quotes.createEstimatedModel(match.simulation.inputs);
        match.simulationUnconfirmed = true;
      }
      return;
    }
    const input = snapshot(league, match, at);
    const model = quotes.createEstimatedModel(input);
    match.simulation = makeCommitment(input, policy.matchKey(league.simulationPolicy, match), at, model);
    match.simulationUnconfirmed = true;
  }
  async function prepareMatches(seasonMonth, matches, at = now()) {
    const ensured = await ensureSeason(seasonMonth, at);
    if (!ensured.ok) return ensured;
    return withSeasonAdmission(store, seasonMonth, async () => {
      const league = store.getLeague(seasonMonth);
      if (!league || !policy.verifyPolicy(league.simulationPolicy, seasonMonth) || league.simulationPolicyUnconfirmed) {
        return { ok: false, reason: 'politica_invalida' };
      }
      let changed = false, legacy = false;
      try {
        for (const match of matches) {
          if (!match || match.seasonMonth !== seasonMonth || match.status !== 'scheduled') continue;
          if (!match.simulation && requiresLegacy(store, league, match)) { legacy = true; continue; }
          attach(league, match, at);
          if (match.simulationUnconfirmed) changed = true;
        }
      } catch (error) {
        log('football_v2_prepare_error', { seasonMonth, message: String(error?.message || error) });
        return { ok: false, reason: 'preparacion_invalida' };
      }
      if (changed) {
        try {
          if (!(await store.saveStrict())) throw new Error('guardado fallido');
          for (const match of matches) if (match?.simulationUnconfirmed) delete match.simulationUnconfirmed;
        } catch (error) {
          log('football_v2_prepare_persist_error', { seasonMonth, message: String(error?.message || error) });
          return { ok: false, reason: 'persistencia_pendiente' };
        }
      }
      return { ok: true, legacy };
    });
  }
  async function prepareMatch(match, at = now()) {
    if (!match || match.seasonMonth < '2026-11') return { ok: false, legacy: true, reason: 'temporada_anterior' };
    if (match.status !== 'scheduled') {
      return match.simulation && verifyCommitment(match.simulation, match) && !match.simulationUnconfirmed
        ? { ok: true } : { ok: false, reason: 'partido_no_programado' };
    }
    const out = await prepareMatches(match.seasonMonth, [match], at);
    if (out.ok && !match.simulation) return { ok: false, legacy: out.legacy, reason: 'obligacion_anterior' };
    return out;
  }
  async function prepareUpcoming(at = now()) {
    if (preparing) return preparing;
    preparing = (async () => {
      const month = store.getCurrentSeasonMonth();
      if (!month || month < '2026-11') return { ok: true };
      const scheduled = (store.getMatches(month) || []).filter(match => match.status === 'scheduled'
        && match.scheduledKickoffAt <= at + HORIZON_MS);
      return prepareMatches(month, scheduled, at);
    })();
    try { return await preparing; } finally { preparing = null; }
  }
  return { ensureSeason, prepareMatch, prepareUpcoming, preview,
    requiresLegacy: match => requiresLegacy(store, store.getLeague(match.seasonMonth), match) };
}
module.exports = { HORIZON_MS, createOfficialV2, requiresLegacy };
