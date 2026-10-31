'use strict';

// Preparación pura de un partido experimental. No programa partidos, no publica
// semillas y no modifica la liga. El llamador que lo integre deberá guardar esta
// instantánea antes del kickoff y recuperarla sin volver a leer ratings mutables.
const { createLineups } = require('../match-state');
const { VERSION } = require('./simulator');
const { recomputeLeagueStats } = require('../ratings');

function previousMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('temporada inválida');
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function settledAsOf(league, asOf) {
  const matches = league?.calendar?.matches;
  if (!Array.isArray(matches)) throw new Error('calendario de estadísticas ausente');
  const settled = matches.filter(match => match && !match.desempate && match.status === 'settled');
  // Los ratings persistidos son el acumulado actual, no una serie histórica.
  // Si incluyen resultados posteriores o sin fecha no se pueden reconstruir
  // legítimamente a una fecha anterior. Fallar es mejor que filtrar el futuro.
  if (settled.some(match => !Number.isSafeInteger(match.settledAt) || match.settledAt > asOf)) {
    throw new Error('ratings posteriores al instante de preparación');
  }
  if (settled.some(match => typeof match.homeId !== 'string' || typeof match.awayId !== 'string'
      || match.homeId === match.awayId || !match.result
      || !Number.isSafeInteger(match.result.home) || match.result.home < 0
      || !Number.isSafeInteger(match.result.away) || match.result.away < 0)) {
    throw new Error('resultado histórico inválido');
  }
  return settled;
}

function ratingCopy(ratings) {
  const result = {};
  for (const key of ['elo', 'att', 'def', 'gk']) {
    if (!Number.isFinite(ratings && ratings[key]) || ratings[key] <= 0) throw new Error(`rating ${key} inválido`);
    result[key] = ratings[key];
  }
  return result;
}

function prepareMatchInputs({ league, previousLeague = null, match, asOf = Date.now(), seed }) {
  if (!league || !match || league.seasonMonth !== match.seasonMonth || !Array.isArray(league.config)
      || match.homeId === match.awayId || !Number.isSafeInteger(asOf) || asOf < 1
      || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('entradas del partido inválidas');
  }
  const home = league.config.find(club => club.id === match.homeId);
  const away = league.config.find(club => club.id === match.awayId);
  if (!home || !away || !Array.isArray(home.squad) || !Array.isArray(away.squad)) throw new Error('plantillas ausentes');
  const current = settledAsOf(league, asOf);
  let prior = [], previous = null;
  if (previousLeague && previousLeague.seasonMonth === previousMonth(league.seasonMonth)) {
    prior = settledAsOf(previousLeague, asOf);
    previous = previousLeague;
  }
  const lineups = createLineups(home, away);
  const countMatches = (matches, id) => matches.filter(item => item.homeId === id || item.awayId === id).length;
  const dataFor = (club, side) => {
    const ratings = ratingCopy(club.ratings);
    const currentMatches = countMatches(current, club.id);
    const previousMatches = countMatches(prior, club.id);
    const oldClub = previous?.config?.find(item => item.id === club.id);
    // Lo disputado en el mes previo influencia el arranque; su peso decae al
    // acumularse resultados en el mes actual. Sin partidos previos no se inventa
    // un historial. El portero conserva el rating de la plantilla actual.
    const weight = oldClub && previousMatches > 0
      ? Math.min(0.65, 0.65 * previousMatches / (previousMatches + 8)) * 8 / (8 + currentMatches) : 0;
    if (weight > 0) {
      const old = ratingCopy(oldClub.ratings);
      for (const key of ['elo', 'att', 'def']) {
        ratings[key] = Number((ratings[key] * (1 - weight) + old[key] * weight).toFixed(key === 'elo' ? 0 : 4));
      }
    }
    return {
      team: {
        id: club.id, name: club.name, short: club.abbr || club.short,
        formation: lineups[side].formation, ratings, lineup: lineups[side]
      },
      source: { currentMatches, previousMatches, previousWeight: Number(weight.toFixed(4)) }
    };
  };
  const h = dataFor(home, 'home'), a = dataFor(away, 'away');
  // El calendario puede estar reprogramado y su orden de almacenamiento no es
  // necesariamente cronológico. Calcular la ventana reciente desde los datos
  // asentados evita usar un promedio obsoleto o resultados aún no confirmados.
  const leagueStats = matches => recomputeLeagueStats(matches.slice().sort((a, b) => {
    const date = item => Number.isSafeInteger(item.scheduledKickoffAt) && item.scheduledKickoffAt > 0
      ? item.scheduledKickoffAt : item.settledAt;
    return (date(a) - date(b)) || (a.settledAt - b.settledAt);
  }));
  const currentStats = leagueStats(current);
  const previousStats = previous && prior.length ? leagueStats(prior) : null;
  const currentAvg = currentStats.leagueAvg;
  const previousAvg = previousStats ? previousStats.leagueAvg : currentAvg;
  // Al comenzar la temporada aún hay poca muestra propia. El promedio del mes
  // anterior aporta contexto y pierde peso conforme se asientan partidos nuevos.
  const previousWeight = previous && prior.length
    ? Math.min(0.65, 0.65 * prior.length / (prior.length + 20)) * 10 / (10 + current.length) : 0;
  const context = { leagueAvg: Number((currentAvg * (1 - previousWeight) + previousAvg * previousWeight).toFixed(4)),
    sample: currentStats.sample,
    previousSample: previousStats ? previousStats.sample : 0, previousWeight: Number(previousWeight.toFixed(4)) };
  // createLineups construye objetos nuevos, pero los attrs también se copian;
  // una serialización explícita garantiza que ninguna mutación del store pueda
  // cambiar las entradas antes de persistirlas.
  return JSON.parse(JSON.stringify({
    version: VERSION, seed, asOf, context,
    home: h.team, away: a.team,
    source: {
      currentSeason: league.seasonMonth,
      previousSeason: previous && prior.length ? previous.seasonMonth : null,
      home: h.source, away: a.source
    }
  }));
}

module.exports = { previousMonth, prepareMatchInputs };
