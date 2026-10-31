'use strict';

// Contexto de precio de un partido: la ÚNICA definición de «con qué λ se pinta
// este partido y de qué matriz salen todas sus cuotas».
//
// Antes vivía dentro de BettingService.getMatchContext; el auditor de cuotas
// (`lib/football/odds-audit.js`) necesita exactamente lo mismo, y dos copias de
// la misma fórmula acaban divergiendo (es la clase de fallo que arregla
// docs/estadio-auditoria-fuentes-unicas.md). BettingService delega aquí.
//
// Devuelve null si el partido o la liga no existen: quien lo consuma decide si
// eso es un error o un mercado que no se ofrece.

const { expectedGoals, INITIAL_LEAGUE_AVG, INITIAL_HOME_ADV } = require('./ratings');
const { scoreMatrix, RHO } = require('./match-engine');

function matchContextFor(store, match, options = {}) {
  if (!store || !match) return null;
  const league = store.getLeague(match.seasonMonth);
  if (!league) return null;
  const homeClub = league.config.find(c => c.id === match.homeId);
  const awayClub = league.config.find(c => c.id === match.awayId);
  if (!homeClub || !awayClub) return null;
  const ctx = league.ctx || { leagueAvg: INITIAL_LEAGUE_AVG, homeAdv: INITIAL_HOME_ADV };
  const lambdas = expectedGoals(homeClub.ratings, awayClub.ratings, ctx);
  const rho = options.rho != null ? options.rho : RHO;
  const matrix = scoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, rho);
  return { league, homeClub, awayClub, ctx, lambdas, rho, matrix };
}

module.exports = { matchContextFor };
