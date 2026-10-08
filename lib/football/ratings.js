'use strict';

// Fase A — Ratings (§10.1).
//
// Modelo mínimo y coherente con el que fija los precios (§10.2): los goles
// esperados de un partido salen de leagueAvg · att · def · homeAdv, y esa MISMA
// esperanza es la que se usa para actualizar att/def tras cada resultado. Es la
// condición que hace verdadero el margen declarado (R3/§3.3): el modelo que
// genera el partido y el que fija la cuota no pueden divergir.
//
// En Fase A se usa la actualización de ratings (Elo + att/def) al asentar un
// resultado y el cálculo rodante de leagueAvg/homeAdv. El muestreo del marcador
// desde la matriz de Poisson con corrección Dixon-Coles vive en odds.js (Fase D)
// y el generador de la línea de tiempo en match-engine.js (Fase B); ambos
// consumen expectedGoals() de aquí para no duplicar la fórmula.

// --- Constantes del modelo (§10.1) ---
const K = 20;                    // factor Elo por partido
const HFA = 60;                  // ventaja de local en puntos Elo
const ALPHA = 0.18;              // suavizado exponencial de att/def
const ATT_DEF_MIN = 0.70;        // cota inferior de att/def
const ATT_DEF_MAX = 1.35;        // cota superior de att/def

const INITIAL_LEAGUE_AVG = 1.35; // goles por equipo por partido al arrancar
const LEAGUE_AVG_MIN = 0.95;     // suelo: un arranque con pocos datos no lo hunde
const LEAGUE_AVG_MAX = 1.85;     // techo: idem, no lo dispara
const INITIAL_HOME_ADV = 1.12;   // multiplicador de λ del local
const HOME_ADV_MIN = 1.0;        // el local nunca espera menos que el visitante
const HOME_ADV_MAX = 1.35;

const ROLLING_WINDOW = 60;       // partidos de la ventana rodante (§10.1)
const MIN_SAMPLE = 10;           // por debajo de esto no se fía del observado

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Resultado del marcador como 'home' | 'draw' | 'away'.
function outcome(scoreHome, scoreAway) {
  if (scoreHome > scoreAway) return 'home';
  if (scoreHome < scoreAway) return 'away';
  return 'draw';
}

// Puntos Elo esperados del local (S del visitante = 1 - E_home).
function eloExpected(eloHome, eloAway, hfa = HFA) {
  const exponent = -((Number(eloHome) - Number(eloAway)) + hfa) / 400;
  return 1 / (1 + Math.pow(10, exponent));
}

// Goles esperados de cada equipo con los ratings PRE-partido.
//   λ_home = leagueAvg · att_home · def_away · homeAdv
//   λ_away = leagueAvg · att_away · def_home
// `def` es el multiplicador de goles EN CONTRA (más alto = más concede), que es
// exactamente lo que actualiza §10.1: def' crece si el equipo concede más de lo
// esperado. home y away son objetos con { att, def } (y elo, que aquí no se usa).
function expectedGoals(home, away, ctx = {}) {
  const leagueAvg = Number.isFinite(ctx.leagueAvg) ? ctx.leagueAvg : INITIAL_LEAGUE_AVG;
  const homeAdv = Number.isFinite(ctx.homeAdv) ? ctx.homeAdv : INITIAL_HOME_ADV;
  const lambdaHome = Math.max(0.05, leagueAvg * home.att * away.def * homeAdv);
  const lambdaAway = Math.max(0.05, leagueAvg * away.att * home.def);
  return { lambdaHome, lambdaAway };
}

// Actualiza los ratings de ambos equipos tras un partido asentado. Devuelve
// objetos NUEVOS (no muta los entrantes) para que el llamador decida cuándo
// persistir. Usa los λ esperados PRE-partido como denominador, que es lo que da
// sentido al ratio goles/esperado de §10.1.
//   home/away: { elo, att, def, gk }
//   scoreHome/scoreAway: goles finales
//   ctx: { leagueAvg, homeAdv } vigentes ANTES del partido
function updateAfterMatch(home, away, scoreHome, scoreAway, ctx = {}) {
  const { lambdaHome, lambdaAway } = expectedGoals(home, away, ctx);

  const sHome = scoreHome > scoreAway ? 1 : scoreHome < scoreAway ? 0 : 0.5;
  const sAway = 1 - sHome;
  const eHome = eloExpected(home.elo, away.elo);
  const eAway = 1 - eHome;

  const nextHome = {
    elo: Math.round(home.elo + K * (sHome - eHome)),
    // att_home se mide contra lo que se esperaba que MARCARA (λ_home).
    att: clamp(home.att * (1 - ALPHA) + ALPHA * (scoreHome / lambdaHome), ATT_DEF_MIN, ATT_DEF_MAX),
    // def_home se mide contra lo que se esperaba que CONCEDIERA (λ_away).
    def: clamp(home.def * (1 - ALPHA) + ALPHA * (scoreAway / lambdaAway), ATT_DEF_MIN, ATT_DEF_MAX),
    gk: home.gk // §10.1 no da fórmula de actualización del portero; se mantiene sembrado.
  };
  const nextAway = {
    elo: Math.round(away.elo + K * (sAway - eAway)),
    att: clamp(away.att * (1 - ALPHA) + ALPHA * (scoreAway / lambdaAway), ATT_DEF_MIN, ATT_DEF_MAX),
    def: clamp(away.def * (1 - ALPHA) + ALPHA * (scoreHome / lambdaHome), ATT_DEF_MIN, ATT_DEF_MAX),
    gk: away.gk
  };

  // Redondeo a 3 decimales para que att/def sean estables al persistir en JSON.
  nextHome.att = Number(nextHome.att.toFixed(3));
  nextHome.def = Number(nextHome.def.toFixed(3));
  nextAway.att = Number(nextAway.att.toFixed(3));
  nextAway.def = Number(nextAway.def.toFixed(3));

  return { home: nextHome, away: nextAway };
}

// leagueAvg y homeAdv rodantes sobre los últimos ROLLING_WINDOW partidos
// asentados (§10.1). Con pocos datos (< MIN_SAMPLE) devuelve las constantes
// iniciales: es el «suelo y techo para que un arranque de temporada con pocos
// datos no dispare los precios». `matches` son partidos con result {home,away}.
function recomputeLeagueStats(matches) {
  const settled = (Array.isArray(matches) ? matches : [])
    .filter(match => match && match.result && Number.isFinite(match.result.home) && Number.isFinite(match.result.away))
    .slice(-ROLLING_WINDOW);

  if (settled.length < MIN_SAMPLE) {
    return { leagueAvg: INITIAL_LEAGUE_AVG, homeAdv: INITIAL_HOME_ADV, sample: settled.length };
  }

  let homeGoals = 0;
  let awayGoals = 0;
  for (const match of settled) {
    homeGoals += match.result.home;
    awayGoals += match.result.away;
  }
  const total = homeGoals + awayGoals;
  // Goles por equipo por partido.
  const observedAvg = total / (2 * settled.length);
  // homeAdv empírico: cuántos más goles marca el local frente al visitante.
  const observedHomeAdv = awayGoals > 0 ? homeGoals / awayGoals : INITIAL_HOME_ADV;

  return {
    leagueAvg: Number(clamp(observedAvg, LEAGUE_AVG_MIN, LEAGUE_AVG_MAX).toFixed(3)),
    homeAdv: Number(clamp(observedHomeAdv, HOME_ADV_MIN, HOME_ADV_MAX).toFixed(3)),
    sample: settled.length
  };
}

module.exports = {
  K,
  HFA,
  ALPHA,
  ATT_DEF_MIN,
  ATT_DEF_MAX,
  INITIAL_LEAGUE_AVG,
  LEAGUE_AVG_MIN,
  LEAGUE_AVG_MAX,
  INITIAL_HOME_ADV,
  HOME_ADV_MIN,
  HOME_ADV_MAX,
  ROLLING_WINDOW,
  MIN_SAMPLE,
  clamp,
  outcome,
  eloExpected,
  expectedGoals,
  updateAfterMatch,
  recomputeLeagueStats
};
