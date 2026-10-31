'use strict';

// Proyecciones de futuros: usan los mismos snapshots y precios cuando existen;
// para encuentros aún no preparados estiman con datos públicos actuales, no
// consultan la semilla privada ni anticipan el replay.
const { prepareMatchInputs } = require('./inputs');
const { verifyCommitment } = require('./commitment');
const { verifyPolicy } = require('./season-policy');
const quotes = require('./quotes');
const { expectedGoals } = require('../ratings');
const { scoreMatrix } = require('../match-engine');
const { createLineups } = require('../match-state');

function projectFixture(league, match, home, away, context, at, previousLeague = null) {
  if (match.simulation) {
    if (match.simulationUnconfirmed || !match.simulation.pricing || !verifyCommitment(match.simulation, match)) {
      throw new Error('compromiso V2 sin precios confirmados');
    }
    return { matrix: quotes.scoreMatrix(match.simulation.pricing),
      lineups: { home: match.simulation.inputs.home.lineup, away: match.simulation.inputs.away.lineup } };
  }
  if (league.simulationPolicy) {
    if (league.simulationPolicyUnconfirmed || !verifyPolicy(league.simulationPolicy, league.seasonMonth)) {
      throw new Error('política V2 no confirmada');
    }
    const input = prepareMatchInputs({ league, previousLeague, match, asOf: at, seed: 0 });
    input.version = match.desempate ? league.simulationPolicy.knockoutVersion : league.simulationPolicy.simulatorVersion;
    if (match.desempate) input.knockout = true;
    const model = quotes.createEstimatedModel(input);
    return { matrix: quotes.scoreMatrix(model), lineups: { home: input.home.lineup, away: input.away.lineup } };
  }
  const goals = expectedGoals(home.ratings, away.ratings, context);
  return { matrix: scoreMatrix(goals.lambdaHome, goals.lambdaAway, context.rho), lineups: createLineups(home, away) };
}
function publicProjectionState(engine, match, at) {
  if (!engine || !match?.simulation) return null;
  const derived = engine.deriveMatchState(match, at);
  const state = derived.state;
  // Se lee exclusivamente el prefijo que el reloj ya reveló. Ninguna cuota de
  // futuro debe depender del marcador o los goleadores del replay completo.
  const revealed = engine._ensureTimeline(match).timeline.slice(0, derived.revealedIndex + 1);
  const goals = revealed.filter(event => event.type === 'goal' || event.type === 'penalty_scored')
    .map(event => ({ team: event.team, playerId: event.playerId }));
  return { minute: Math.floor(derived.minute), half: state.half, score: { ...state.score },
    redCards: { ...state.redCards }, phase: state.phase, playStopped: Boolean(state.playStopped),
    ended: Boolean(derived.ended), goals };
}
module.exports = { projectFixture, publicProjectionState };
