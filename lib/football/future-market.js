'use strict';

// Proyección orientativa e independiente de la trayectoria privada del partido.
// El modelo estima el calendario restante; NO constituye validación económica
// de V2 ni habilita por sí mismo la selección automática de motor.
const crypto = require('node:crypto');
const { hash32, mulberry32 } = require('./prng');
const { expectedGoals, INITIAL_LEAGUE_AVG, INITIAL_HOME_ADV } = require('./ratings');
const { scoreMatrix, sampleScore, RHO } = require('./match-engine');
const { buildStandings, sortStandings } = require('../football-store-shared');
const { createLineups, POS_GROUP } = require('./match-state');
const { lastCompletedJornada, allRegularMatchesSettled, officialPositions } = require('./ballon-dor-market');
const V2 = require('./v2/calibration');
const { verifyCommitment } = require('./v2/commitment');

const VERSION = 'season-futures-1';
const SIMULATIONS = 2000;
const MAX_ODDS = 51;
const MAX_STAKE = 2000;
const SCORE_WEIGHT = { GK: 0.01, DF: 0.8, MF: 2.4, FW: 5 };

function samePrimary(a, b) {
  return a.points === b.points && a.goalDiff === b.goalDiff && a.goalsFor === b.goalsFor;
}
function addScore(rows, h2h, home, away, score) {
  const h = rows[home], a = rows[away];
  h.played++; a.played++;
  h.goalsFor += score.home; h.goalsAgainst += score.away;
  a.goalsFor += score.away; a.goalsAgainst += score.home;
  h.goalDiff = h.goalsFor - h.goalsAgainst;
  a.goalDiff = a.goalsFor - a.goalsAgainst;
  const hp = score.home > score.away ? 3 : score.home === score.away ? 1 : 0;
  const ap = score.away > score.home ? 3 : score.home === score.away ? 1 : 0;
  h.points += hp; a.points += ap; h2h[home][away] += hp; h2h[away][home] += ap;
}
function champion(rows, h2h, indexById, random) {
  const sorted = sortStandings(rows);
  const tied = sorted.filter(row => samePrimary(row, sorted[0]));
  if (tied.length === 1) return tied[0].teamId;
  const totals = tied.map(row => ({ row, points: tied.reduce((sum, rival) =>
    sum + (rival === row ? 0 : h2h[indexById.get(row.teamId)][indexById.get(rival.teamId)]), 0) }));
  totals.sort((a, b) => b.points - a.points || a.row.teamId.localeCompare(b.row.teamId));
  if (totals[0].points > totals[1].points) return totals[0].row.teamId;
  // Aproximación de un desempate, no el resultado de ningún partido comprometido.
  return totals[random() < 0.5 ? 0 : 1].row.teamId;
}
function boundaryVoids(sorted, cutoff) {
  if (!sorted[cutoff] || !samePrimary(sorted[cutoff - 1], sorted[cutoff])) return new Set();
  const boundary = sorted[cutoff - 1];
  return new Set(sorted.filter(row => samePrimary(row, boundary)).map(row => row.teamId));
}
function quote(wins, samples) {
  // Límite superior conservador para el error de muestreo (no modela errores
  // estructurales). Nunca inventa una probabilidad cero para cuotas altas.
  const p = wins / samples;
  const upper = Math.min(1, p + 2.33 * Math.sqrt(p * (1 - p) / samples) + 6 / samples);
  const raw = Math.floor((1 / (upper * 1.10)) * 100) / 100;
  return raw < 1.01 ? null : Math.min(MAX_ODDS, raw);
}
function weightedPlayers(lineup, playerIndex) {
  let total = 0;
  return lineup.players.map(player => {
    const group = POS_GROUP[player.pos] || 'MF';
    const rating = Number(player.attrs?.sho) || 50;
    const weight = (SCORE_WEIGHT[group] || 1) * (0.5 + rating / 100) * (player.initialStatus === 'active' ? 1 : 0.24);
    total += weight;
    return { index: playerIndex.get(player.id), upper: total };
  }).filter(item => item.index != null).map(item => ({ ...item, upper: item.upper / total }));
}
function drawPlayer(weighted, random) {
  const r = random();
  return (weighted.find(player => r <= player.upper) || weighted[weighted.length - 1])?.index;
}

// Cada campo usado para invalidar la caché ya es público o deriva de ratings y
// conteos de entrenamiento; no se incluyen claves ni resultados futuros privados.
function fingerprint(league) {
  const clubs = league.config.map(club => ({ id: club.id, ratings: club.ratings, squad: club.squad }));
  const matches = league.calendar.matches.filter(match => !match.desempate).map(match => ({
    id: match.id, status: match.status, result: match.result, fantasyStats: match.fantasyStats,
    simulation: match.simulation ? { inputHash: match.simulation.inputsHash,
      counts: match.simulation.pricing?.training?.counts || null, unconfirmed: Boolean(match.simulationUnconfirmed) } : null
  }));
  return crypto.createHash('sha256').update(JSON.stringify({ version: VERSION, season: league.seasonMonth, ctx: league.ctx, clubs, matches })).digest('hex');
}

function projectSeasonFutures(league, { simulations = SIMULATIONS, at = Date.now(), sourceId = fingerprint(league) } = {}) {
  if (!league || !Array.isArray(league.config) || league.config.length !== 16 || !Array.isArray(league.calendar?.matches)
      || !Number.isSafeInteger(simulations) || simulations < 100 || simulations > 10000) throw new Error('liga o muestra de futuros inválida');
  const clubs = league.config, indexById = new Map(clubs.map((club, index) => [club.id, index]));
  const players = clubs.flatMap(club => (club.squad || []).map(player => ({ id: player.id, name: player.name, clubId: club.id })));
  const playerIndex = new Map(players.map((player, index) => [player.id, index]));
  if (players.length < 16 || playerIndex.size !== players.length) throw new Error('plantillas inválidas');
  const regular = league.calendar.matches.filter(match => !match.desempate && match.jornada >= 1 && match.jornada <= 30);
  const settled = regular.filter(match => match.status === 'settled' && match.result);
  const rows = buildStandings(settled, clubs.map(club => club.id));
  const base = clubs.map(club => ({ ...rows.find(row => row.teamId === club.id) }));
  const baseH2h = Array.from({ length: clubs.length }, () => new Array(clubs.length).fill(0));
  const goals = new Uint16Array(players.length);
  let completeGoalStats = true;
  for (const match of settled) {
    const home = indexById.get(match.homeId), away = indexById.get(match.awayId);
    if (home == null || away == null) throw new Error('club histórico ausente');
    const score = match.result;
    baseH2h[home][away] += score.home > score.away ? 3 : score.home === score.away ? 1 : 0;
    baseH2h[away][home] += score.away > score.home ? 3 : score.home === score.away ? 1 : 0;
    if (!Array.isArray(match.fantasyStats)) { completeGoalStats = false; continue; }
    let homeGoals = 0, awayGoals = 0, valid = true;
    for (const stat of match.fantasyStats) {
      const index = playerIndex.get(stat.id);
      if (index == null || !Number.isSafeInteger(stat.goals) || stat.goals < 0
          || ![match.homeId, match.awayId].includes(stat.teamId)) { valid = false; break; }
      goals[index] += stat.goals;
      if (stat.teamId === match.homeId) homeGoals += stat.goals; else awayGoals += stat.goals;
    }
    if (!valid || homeGoals !== score.home || awayGoals !== score.away) completeGoalStats = false;
  }
  const context = { leagueAvg: league.ctx?.leagueAvg || INITIAL_LEAGUE_AVG,
    homeAdv: league.ctx?.homeAdv || INITIAL_HOME_ADV, rho: Number.isFinite(league.ctx?.rho) ? league.ctx.rho : RHO };
  const remaining = regular.filter(match => match.status !== 'settled').map(match => {
    const home = indexById.get(match.homeId), away = indexById.get(match.awayId);
    if (home == null || away == null) throw new Error('club ausente');
    let matrix;
    if (match.simulation) {
      if (match.simulationUnconfirmed || !match.simulation.pricing || !verifyCommitment(match.simulation, match)) throw new Error('V2 sin calibración confirmada');
      matrix = V2.scoreMatrix(match.simulation.pricing.training);
    } else {
      const lambdas = expectedGoals(clubs[home].ratings, clubs[away].ratings, context);
      matrix = scoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, context.rho);
    }
    const lineup = createLineups(clubs[home], clubs[away]);
    return { home, away, matrix, homePlayers: weightedPlayers(lineup.home, playerIndex),
      awayPlayers: weightedPlayers(lineup.away, playerIndex) };
  });
  const wins = { champion: new Array(clubs.length).fill(0), top2: new Array(clubs.length).fill(0),
    top4: new Array(clubs.length).fill(0), golden_boot: new Array(players.length).fill(0) };
  const seed = hash32(`${VERSION}|${sourceId}`);
  for (let n = 0; n < simulations; n++) {
    const random = mulberry32(hash32(`${seed}|${n}`));
    const projected = base.map(row => ({ ...row }));
    const h2h = baseH2h.map(row => row.slice());
    const scoring = completeGoalStats ? goals.slice() : null;
    for (const fixture of remaining) {
      const score = sampleScore(fixture.matrix, random);
      addScore(projected, h2h, fixture.home, fixture.away, score);
      if (scoring) {
        for (let i = 0; i < score.home; i++) { const index = drawPlayer(fixture.homePlayers, random); if (index != null) scoring[index]++; }
        for (let i = 0; i < score.away; i++) { const index = drawPlayer(fixture.awayPlayers, random); if (index != null) scoring[index]++; }
      }
    }
    const sorted = sortStandings(projected);
    wins.champion[indexById.get(champion(projected, h2h, indexById, random))]++;
    for (const [market, cutoff] of [['top2', 2], ['top4', 4]]) {
      const voided = boundaryVoids(sorted, cutoff);
      sorted.slice(0, cutoff).forEach(row => { if (!voided.has(row.teamId)) wins[market][indexById.get(row.teamId)]++; });
    }
    if (scoring) {
      const best = Math.max(...scoring);
      const leaders = [];
      for (let i = 0; i < scoring.length; i++) if (scoring[i] === best) leaders.push(i);
      if (leaders.length === 1) wins.golden_boot[leaders[0]]++;
    }
  }
  const teamSelections = market => clubs.map((club, index) => ({ selection: club.id, wins: wins[market][index],
    probability: wins[market][index] / simulations, odds: quote(wins[market][index], simulations) })).filter(item => item.odds != null);
  const markets = { champion: teamSelections('champion'), top2: teamSelections('top2'), top4: teamSelections('top4') };
  if (completeGoalStats) markets.golden_boot = players.map((player, index) => ({ selection: player.id, clubId: player.clubId,
    name: player.name, wins: wins.golden_boot[index], probability: wins.golden_boot[index] / simulations,
    odds: quote(wins.golden_boot[index], simulations) })).filter(item => item.odds != null);
  return { version: VERSION, seasonMonth: league.seasonMonth, sourceId, updatedAt: at,
    afterJornada: lastCompletedJornada(league), simulations, markets };
}

// Solo resultados asentados de las 30 jornadas; nunca se liquida una tabla parcial.
function seasonOutcome(league) {
  if (!league || !allRegularMatchesSettled(league)) return { complete: false };
  const regular = league.calendar.matches.filter(match => !match.desempate && match.jornada >= 1 && match.jornada <= 30);
  const standings = buildStandings(regular, league.config.map(club => club.id));
  const official = officialPositions(league);
  const cut2 = boundaryVoids(standings, 2), cut4 = boundaryVoids(standings, 4);
  const result = { complete: true, championTeamId: official.ok ? official.positions[0]?.teamId || null : null,
    championPending: !official.ok && ['desempate_requerido', 'desempate_pendiente'].includes(official.reason),
    top2TeamIds: standings.slice(0, 2).map(row => row.teamId).filter(id => !cut2.has(id)),
    top4TeamIds: standings.slice(0, 4).map(row => row.teamId).filter(id => !cut4.has(id)),
    goldenBootPlayerId: null, voidSelections: { top2: [...cut2], top4: [...cut4], golden_boot: [] } };
  const totals = new Map();
  for (const match of regular) {
    if (!Array.isArray(match.fantasyStats)) return result;
    let home = 0, away = 0;
    for (const stat of match.fantasyStats) {
      if (!stat || typeof stat.id !== 'string' || !Number.isSafeInteger(stat.goals) || stat.goals < 0
          || ![match.homeId, match.awayId].includes(stat.teamId)) return result;
      totals.set(stat.id, (totals.get(stat.id) || 0) + stat.goals);
      if (stat.teamId === match.homeId) home += stat.goals; else away += stat.goals;
    }
    if (home !== match.result.home || away !== match.result.away) return result;
  }
  if (totals.size) {
    const max = Math.max(...totals.values());
    const leaders = [...totals].filter(([, count]) => count === max).map(([id]) => id);
    result.goldenBootPlayerId = leaders[0] || null;
    if (leaders.length > 1) result.voidSelections.golden_boot = leaders;
  }
  return result;
}

class FutureMarketService {
  constructor({ store, now = () => Date.now(), project = projectSeasonFutures } = {}) {
    if (!store) throw new Error('store requerido');
    this.store = store; this.now = now; this.project = project; this.cache = new Map();
  }
  getMarket(seasonMonth = this.store.getCurrentSeasonMonth()) {
    const league = this.store.getLeague(seasonMonth);
    if (!league || league.status !== 'active' || this.store.getCurrentSeasonMonth() !== seasonMonth) return null;
    const now = this.now(), matches = league.calendar?.matches || [];
    if (lastCompletedJornada(league) >= 20) return null;
    // No publicar con resultados parciales conocidos que la proyección aún no
    // incorpora. Se actualiza de nuevo al asentarse el partido en curso.
    if (matches.some(match => !match.desempate && match.status !== 'settled'
        && (match.status !== 'scheduled' || now >= match.scheduledKickoffAt))) return null;
    const sourceId = fingerprint(league);
    const existing = this.cache.get(seasonMonth);
    if (existing?.sourceId === sourceId) return existing;
    try {
      const snapshot = this.project(league, { at: now, sourceId });
      this.cache.set(seasonMonth, snapshot);
      return snapshot;
    } catch (_) { return null; }
  }
}
module.exports = { VERSION, SIMULATIONS, MAX_STAKE, fingerprint, projectSeasonFutures, FutureMarketService, boundaryVoids, seasonOutcome };
