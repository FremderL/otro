'use strict';

// Fase 4 — precios deterministas, ciclo mensual y resolución del mercado BDO.
// Solo el servidor llama a este módulo: las cuotas no se aceptan desde el cliente.

const { hash32, mulberry32 } = require('./prng');
const { expectedGoals, INITIAL_LEAGUE_AVG, INITIAL_HOME_ADV } = require('./ratings');
const { scoreMatrix, sampleScore, RHO } = require('./match-engine');
const { createLineups, POS_GROUP } = require('./match-state');
const {
  BALLON_DOR_CANDIDATE_COUNT,
  calculateBallonDorPoints, compareBallonDorCandidates, teamBonusForPosition
} = require('./ballon-dor');
const {
  buildStandings, sortStandings, headToHead,
  calendarParts, monthKey, CASINO_TIME_ZONE
} = require('../football-store-shared');
const { daysInMonth, parseSeasonMonth, zonedTimeToMs } = require('./fixtures');
const { performance } = require('node:perf_hooks');

const BALLON_DOR_MARKET = 'balon_de_oro';
const SIMULATIONS = 2000;
const OVERROUND = 1.1;
const MAX_ODDS = 51;
const MAX_PAYOUT = 500000;
const TIEBREAK_RUNTIME_BUDGET_MS = 45 * 60 * 1000;

const SHOOT_WEIGHT = Object.freeze({ FW: 5, MF: 2.6, DF: 0.9, GK: 0.02 });
const PASS_WEIGHT = Object.freeze({ FW: 2.4, MF: 3.4, DF: 1.4, GK: 0.1 });
const CARD_WEIGHT = Object.freeze({ FW: 1.4, MF: 2.2, DF: 2.8, GK: 0.3 });

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function outcomePoints(home, away) {
  if (home > away) return [3, 0];
  if (home < away) return [0, 3];
  return [1, 1];
}

function primaryTie(left, right) {
  return left.points === right.points && left.goalDiff === right.goalDiff
    && left.goalsFor === right.goalsFor;
}

function compareStandingRows(left, right) {
  return sortStandings([left, right])[0] === left ? -1 : 1;
}

function cloneStanding(row) {
  return {
    teamId: row.teamId,
    played: Number(row.played) || 0,
    won: Number(row.won) || 0,
    drawn: Number(row.drawn) || 0,
    lost: Number(row.lost) || 0,
    goalsFor: Number(row.goalsFor) || 0,
    goalsAgainst: Number(row.goalsAgainst) || 0,
    goalDiff: Number(row.goalDiff) || 0,
    points: Number(row.points) || 0
  };
}

function makeH2h(teamCount, matches, teamIndex) {
  const points = Array.from({ length: teamCount }, () => new Array(teamCount).fill(0));
  for (const match of matches) {
    if (!match || match.desempate || !match.result) continue;
    const home = teamIndex.get(match.homeId);
    const away = teamIndex.get(match.awayId);
    if (home == null || away == null) continue;
    const [homePoints, awayPoints] = outcomePoints(match.result.home, match.result.away);
    points[home][away] += homePoints;
    points[away][home] += awayPoints;
  }
  return points;
}

function addScoreToStanding(rowsById, homeId, awayId, homeGoals, awayGoals) {
  const home = rowsById.get(homeId);
  const away = rowsById.get(awayId);
  if (!home || !away) return;
  home.played++; away.played++;
  home.goalsFor += homeGoals; home.goalsAgainst += awayGoals;
  away.goalsFor += awayGoals; away.goalsAgainst += homeGoals;
  home.goalDiff = home.goalsFor - home.goalsAgainst;
  away.goalDiff = away.goalsFor - away.goalsAgainst;
  const [homePoints, awayPoints] = outcomePoints(homeGoals, awayGoals);
  home.points += homePoints;
  away.points += awayPoints;
  if (homeGoals > awayGoals) { home.won++; away.lost++; }
  else if (homeGoals < awayGoals) { away.won++; home.lost++; }
  else { home.drawn++; away.drawn++; }
}

function shootWeight(player) {
  const group = POS_GROUP[player.pos] || 'MF';
  return (SHOOT_WEIGHT[group] || SHOOT_WEIGHT.MF) * (0.6 + (Number(player.attrs?.sho) || 50) / 100);
}
function passWeight(player) {
  const group = POS_GROUP[player.pos] || 'MF';
  return (PASS_WEIGHT[group] || PASS_WEIGHT.MF) * (0.6 + (Number(player.attrs?.pas) || 50) / 100);
}
function cardWeight(player) {
  const group = POS_GROUP[player.pos] || 'MF';
  return (CARD_WEIGHT[group] || CARD_WEIGHT.MF) * (0.6 + (Number(player.attrs?.agr) || 50) / 100);
}

function candidateModel(_club, candidate, lineup) {
  const player = lineup.players.find(item => item.id === candidate.playerId) || {
    id: candidate.playerId,
    pos: 'ST',
    attrs: { sho: candidate.attributes.shooting, pas: 50, agr: 50 },
    initialStatus: candidate.playerNumber <= 11 ? 'active' : 'bench'
  };
  const starters = lineup.players.filter(item => item.initialStatus === 'active'
    && POS_GROUP[item.pos] !== 'GK');
  const all = starters.length ? starters : [player];
  const totalShoot = all.reduce((sum, item) => sum + shootWeight(item), 0) || 1;
  const totalPass = all.reduce((sum, item) => sum + passWeight(item), 0) || 1;
  const totalCards = all.reduce((sum, item) => sum + cardWeight(item), 0) || 1;
  const starter = player.initialStatus === 'active';
  const minutesShare = starter ? 0.76 : 0.22;
  const shootShare = shootWeight(player) / totalShoot;
  const passShare = passWeight(player) / totalPass;
  const cardShare = cardWeight(player) / totalCards;
  return {
    candidateIndex: null,
    appearanceProbability: starter ? 0.96 : 0.56,
    goalProbability: Math.min(0.6, shootShare * minutesShare),
    assistProbability: Math.min(0.4, passShare * minutesShare * 0.72),
    yellowProbability: 1 - Math.exp(-2.05 * cardShare * minutesShare),
    redProbability: 1 - Math.exp(-0.045 * cardShare * minutesShare)
  };
}

function simulateCandidateMatch(model, goalsFor, random, delta) {
  if (!model || random() >= model.appearanceProbability) return;
  delta.appearances++;
  let booked = false;
  for (let goal = 0; goal < goalsFor; goal++) {
    if (random() < model.goalProbability) delta.goals++;
    else if (random() < model.assistProbability) delta.assists++;
  }
  if (random() < model.yellowProbability) {
    delta.yellowCards++;
    booked = true;
  }
  if (random() < model.redProbability) {
    // Una segunda amarilla suma también la tarjeta amarilla de expulsión.
    if (booked && random() < 0.5) delta.yellowCards++;
    delta.redCards++;
  }
}

function shootoutWinner(random) {
  let home = 0, away = 0;
  const initial = 5;
  for (let round = 0; round < initial; round++) {
    if (random() < 0.75) home++;
    if (random() < 0.75) away++;
    const remaining = initial - round - 1;
    if (Math.abs(home - away) > remaining) return home > away ? 'home' : 'away';
  }
  for (let guard = 0; home === away && guard < 40; guard++) {
    const homeScores = random() < 0.75;
    const awayScores = random() < 0.75;
    if (homeScores) home++;
    if (awayScores) away++;
    if (guard === 39 && home === away) return random() < 0.5 ? 'home' : 'away';
  }
  return home > away ? 'home' : 'away';
}

function simulateTiebreakWinner(home, away, context, random) {
  const regular = expectedGoals(home.ratings, away.ratings, context);
  const score = sampleScore(scoreMatrix(regular.lambdaHome, regular.lambdaAway, context.rho ?? RHO), random);
  if (score.home !== score.away) return score.home > score.away ? 'home' : 'away';
  const extraHome = regular.lambdaHome * (30 / 90) * 0.85;
  const extraAway = regular.lambdaAway * (30 / 90) * 0.85;
  const extra = sampleScore(scoreMatrix(extraHome, extraAway, context.rho ?? RHO), random);
  if (extra.home !== extra.away) return extra.home > extra.away ? 'home' : 'away';
  return shootoutWinner(random);
}

function projectedOrder(rows, h2h, teamIndex, clubById, context, random) {
  const sorted = sortStandings(rows);
  if (sorted.length < 2) return sorted;
  const group = sorted.filter(row => primaryTie(row, sorted[0]));
  if (group.length < 2) return sorted;

  const totalH2h = row => {
    const index = teamIndex.get(row.teamId);
    return group.reduce((sum, rival) => {
      if (rival.teamId === row.teamId) return sum;
      const rivalIndex = teamIndex.get(rival.teamId);
      return sum + (h2h[index]?.[rivalIndex] || 0);
    }, 0);
  };
  const h2hSorted = group.slice().sort((a, b) => totalH2h(b) - totalH2h(a)
    || compareStandingRows(a, b));
  if (totalH2h(h2hSorted[0]) > totalH2h(h2hSorted[1])) {
    const champion = h2hSorted[0];
    return [champion, ...sorted.filter(row => row !== champion)];
  }

  const participants = group.slice().sort(compareStandingRows).slice(0, 2);
  const [homeRow, awayRow] = participants;
  const home = clubById.get(homeRow.teamId);
  const away = clubById.get(awayRow.teamId);
  const winnerSide = simulateTiebreakWinner(home, away, context, random);
  const winner = winnerSide === 'home' ? homeRow : awayRow;
  const runnerUp = winnerSide === 'home' ? awayRow : homeRow;
  return [winner, runnerUp, ...sorted.filter(row => row !== homeRow && row !== awayRow)];
}

function oddsFromProbability(probability) {
  if (!(probability > 0)) return MAX_ODDS;
  const raw = 1 / (probability * OVERROUND);
  const roundedDown = Math.floor(raw * 100 + 1e-10) / 100;
  return Math.max(1.01, Math.min(MAX_ODDS, roundedDown));
}

function projectBallonDorOdds({ league, afterJornada = 0, updatedAt = Date.now(), simulations = SIMULATIONS } = {}) {
  if (!league || !league.ballonDor || !Array.isArray(league.config)
      || !league.calendar || !Array.isArray(league.calendar.matches)) {
    throw new TypeError('Liga Balón de Oro inválida para proyectar cuotas');
  }
  if (simulations !== SIMULATIONS) throw new TypeError(`El mercado usa exactamente ${SIMULATIONS} simulaciones`);
  const event = league.ballonDor;
  const candidates = event.candidates || [];
  const clubs = league.config;
  if (candidates.length !== 16 || clubs.length !== 16) {
    throw new TypeError('El ciclo requiere exactamente 16 candidatos y 16 clubes');
  }
  const teamIds = clubs.map(club => club.id);
  const teamIndex = new Map(teamIds.map((id, index) => [id, index]));
  const clubById = new Map(clubs.map(club => [club.id, club]));
  const candidateIndexByClub = new Map(candidates.map((candidate, index) => [candidate.clubId, index]));
  const settledRegular = league.calendar.matches.filter(match => !match.desempate
    && match.jornada >= 1 && match.jornada <= 30 && match.status === 'settled' && match.result);
  const baseRows = buildStandings(settledRegular, teamIds).map(cloneStanding);
  const baseH2h = makeH2h(teamIds.length, settledRegular, teamIndex);
  const context = {
    leagueAvg: positiveNumber(league.ctx?.leagueAvg, INITIAL_LEAGUE_AVG),
    homeAdv: positiveNumber(league.ctx?.homeAdv, INITIAL_HOME_ADV),
    rho: Number.isFinite(league.ctx?.rho) ? league.ctx.rho : RHO
  };

  const remaining = league.calendar.matches.filter(match => !match.desempate
    && match.jornada >= 1 && match.jornada <= 30 && match.status !== 'settled')
    .slice().sort((a, b) => a.jornada - b.jornada
      || a.scheduledKickoffAt - b.scheduledKickoffAt || a.id.localeCompare(b.id))
    .map(match => {
      const home = clubById.get(match.homeId);
      const away = clubById.get(match.awayId);
      if (!home || !away) throw new TypeError(`Clubes ausentes en ${match.id}`);
      const lambdas = expectedGoals(home.ratings, away.ratings, context);
      const matrix = scoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, context.rho);
      const lineups = createLineups(home, away);
      const homeIndex = candidateIndexByClub.get(home.id);
      const awayIndex = candidateIndexByClub.get(away.id);
      const homeModel = homeIndex == null ? null : candidateModel(home, candidates[homeIndex], lineups.home);
      const awayModel = awayIndex == null ? null : candidateModel(away, candidates[awayIndex], lineups.away);
      if (homeModel) homeModel.candidateIndex = homeIndex;
      if (awayModel) awayModel.candidateIndex = awayIndex;
      return { match, home, away, matrix, homeModel, awayModel };
    });

  const seed = hash32(`balon_de_oro|${event.seasonMonth}|${afterJornada}`);
  const wins = new Array(candidates.length).fill(0);
  for (let simulation = 0; simulation < SIMULATIONS; simulation++) {
    const random = mulberry32(hash32(`${seed}|${simulation}`));
    const rows = baseRows.map(cloneStanding);
    const rowsById = new Map(rows.map(row => [row.teamId, row]));
    const h2h = baseH2h.map(row => row.slice());
    const deltas = candidates.map(() => ({ goals: 0, assists: 0, appearances: 0, yellowCards: 0, redCards: 0 }));

    for (const fixture of remaining) {
      const score = sampleScore(fixture.matrix, random);
      addScoreToStanding(rowsById, fixture.match.homeId, fixture.match.awayId, score.home, score.away);
      const homeIndex = teamIndex.get(fixture.match.homeId);
      const awayIndex = teamIndex.get(fixture.match.awayId);
      const [homePoints, awayPoints] = outcomePoints(score.home, score.away);
      h2h[homeIndex][awayIndex] += homePoints;
      h2h[awayIndex][homeIndex] += awayPoints;
      if (fixture.homeModel) simulateCandidateMatch(fixture.homeModel, score.home, random, deltas[fixture.homeModel.candidateIndex]);
      if (fixture.awayModel) simulateCandidateMatch(fixture.awayModel, score.away, random, deltas[fixture.awayModel.candidateIndex]);
    }

    const order = projectedOrder(rows, h2h, teamIndex, clubById, context, random);
    const positions = new Map(order.map((row, index) => [row.teamId, index + 1]));
    const candidateResults = candidates.map((candidate, index) => {
      const delta = deltas[index];
      const stats = {
        ...candidate.stats,
        goals: candidate.stats.goals + delta.goals,
        assists: candidate.stats.assists + delta.assists,
        appearances: candidate.stats.appearances + delta.appearances,
        yellowCards: candidate.stats.yellowCards + delta.yellowCards,
        redCards: candidate.stats.redCards + delta.redCards
      };
      const points = calculateBallonDorPoints(stats, teamBonusForPosition(positions.get(candidate.clubId) || 16));
      return { ...candidate, stats, points };
    });
    candidateResults.sort(compareBallonDorCandidates);
    const winnerIndex = candidateIndexByClub.get(candidateResults[0].clubId);
    if (winnerIndex == null) throw new Error('La simulación no produjo un ganador candidato');
    wins[winnerIndex]++;
  }

  const at = Number(updatedAt);
  if (!Number.isSafeInteger(at) || at < 1) throw new TypeError('updatedAt inválido para cuotas');
  return {
    updatedAt: at,
    afterJornada: Math.max(0, Math.min(20, Math.floor(Number(afterJornada) || 0))),
    simulations: SIMULATIONS,
    seed,
    overround: OVERROUND,
    selections: candidates.map((candidate, index) => {
      const probability = wins[index] / SIMULATIONS;
      return {
        candidateId: candidate.id,
        wins: wins[index],
        probability,
        odds: oddsFromProbability(probability)
      };
    }).sort((a, b) => a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0)
  };
}

function completedJornada(league, jornada) {
  const matches = league.calendar.matches.filter(match => !match.desempate && match.jornada === jornada);
  return matches.length === 8 && matches.every(match => match.status === 'settled' && match.result);
}

function lastCompletedJornada(league) {
  let completed = 0;
  for (let jornada = 1; jornada <= 30; jornada++) {
    if (!completedJornada(league, jornada)) break;
    completed = jornada;
  }
  return completed;
}

function allRegularMatchesSettled(league) {
  const regular = league.calendar.matches.filter(match => !match.desempate
    && match.jornada >= 1 && match.jornada <= 30);
  return regular.length === 240 && regular.every(match => match.status === 'settled' && match.result);
}

function regularMatchesSettledBy(league, deadline) {
  const regular = league.calendar.matches.filter(match => !match.desempate
    && match.jornada >= 1 && match.jornada <= 30);
  return regular.length === 240 && regular.every(match => match.status === 'settled'
    && match.result && Number.isFinite(match.settledAt) && match.settledAt <= deadline);
}

function officialPositions(league) {
  if (!allRegularMatchesSettled(league)) return { ok: false, reason: 'temporada_incompleta' };
  const matches = league.calendar.matches;
  const regularMatches = matches.filter(match => !match.desempate
    && match.jornada >= 1 && match.jornada <= 30 && match.status === 'settled' && match.result);
  const standings = buildStandings(regularMatches, league.config.map(club => club.id));
  const group = standings.filter(row => primaryTie(row, standings[0]));
  let ordered = standings.slice();
  if (group.length > 1) {
    let champion = null;
    let finalists = group.slice().sort(compareStandingRows);
    if (group.length === 2) {
      const direct = headToHead(regularMatches, group[0].teamId, group[1].teamId);
      if (direct.a !== direct.b) champion = direct.a > direct.b ? group[0].teamId : group[1].teamId;
    } else {
      const totals = new Map(group.map(row => [row.teamId, 0]));
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const direct = headToHead(regularMatches, group[i].teamId, group[j].teamId);
          totals.set(group[i].teamId, totals.get(group[i].teamId) + direct.a);
          totals.set(group[j].teamId, totals.get(group[j].teamId) + direct.b);
        }
      }
      const h2hOrder = group.slice().sort((a, b) => totals.get(b.teamId) - totals.get(a.teamId)
        || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
      if (totals.get(h2hOrder[0].teamId) > totals.get(h2hOrder[1].teamId)) champion = h2hOrder[0].teamId;
      finalists = h2hOrder.slice(0, 2);
    }
    if (champion) {
      ordered = [standings.find(row => row.teamId === champion), ...standings.filter(row => row.teamId !== champion)];
    } else {
      const tiebreak = matches.find(match => match.desempate);
      if (!tiebreak) {
        return {
          ok: false, reason: 'desempate_requerido',
          homeId: finalists[0].teamId, awayId: finalists[1].teamId,
          standings
        };
      }
      if (tiebreak.status !== 'settled' || !tiebreak.result) {
        return { ok: false, reason: 'desempate_pendiente', tiebreakMatch: tiebreak, standings };
      }
      let winnerId = null;
      if (tiebreak.result.winner === 'home') winnerId = tiebreak.homeId;
      else if (tiebreak.result.winner === 'away') winnerId = tiebreak.awayId;
      else if (tiebreak.result.home !== tiebreak.result.away) {
        winnerId = tiebreak.result.home > tiebreak.result.away ? tiebreak.homeId : tiebreak.awayId;
      }
      if (!winnerId || !finalists.some(row => row.teamId === winnerId)
          || !finalists.some(row => row.teamId === (winnerId === tiebreak.homeId ? tiebreak.awayId : tiebreak.homeId))) {
        return { ok: false, reason: 'resultado_desempate_invalido', standings };
      }
      const runnerId = winnerId === tiebreak.homeId ? tiebreak.awayId : tiebreak.homeId;
      ordered = [standings.find(row => row.teamId === winnerId), standings.find(row => row.teamId === runnerId),
        ...standings.filter(row => row.teamId !== winnerId && row.teamId !== runnerId)];
    }
  }
  return {
    ok: true,
    standings,
    positions: ordered.map((row, index) => ({ teamId: row.teamId, position: index + 1 }))
  };
}

function closeDeadline(seasonMonth, timeZone = CASINO_TIME_ZONE) {
  const { year, month } = parseSeasonMonth(seasonMonth);
  return zonedTimeToMs({ year, month, day: daysInMonth(seasonMonth), hour: 23, minute: 59, second: 59 }, timeZone);
}

function tiebreakKickoffAt(seasonMonth, now, timeZone = CASINO_TIME_ZONE) {
  const { year, month } = parseSeasonMonth(seasonMonth);
  const lastDay = daysInMonth(seasonMonth);
  const reserved = zonedTimeToMs({ year, month, day: lastDay, hour: 13, minute: 0 }, timeZone);
  const kickoffAt = Math.max(reserved, now + 60_000);
  return kickoffAt + TIEBREAK_RUNTIME_BUDGET_MS <= closeDeadline(seasonMonth, timeZone) ? kickoffAt : null;
}

function ballonDorFinalizationSchedule(store, event, timeZone = CASINO_TIME_ZONE) {
  if (!store || !event || typeof store.getMatches !== 'function') return null;
  const finalMatches = store.getMatches(event.seasonMonth).filter(match => match
    && (match.desempate || Number(match.jornada) === 30)
    && Number.isSafeInteger(Number(match.scheduledKickoffAt))
    && Number(match.scheduledKickoffAt) > 0);
  finalMatches.sort((a, b) => Number(a.scheduledKickoffAt) - Number(b.scheduledKickoffAt));
  const lastMatch = finalMatches[finalMatches.length - 1];
  if (!lastMatch) return null;

  const kickoffAt = Number(lastMatch.scheduledKickoffAt);
  const parts = calendarParts(new Date(kickoffAt), timeZone);
  const localDate = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
  let scheduledAt = zonedTimeToMs({ ...localDate, hour: 22, minute: 0 }, timeZone);
  if (scheduledAt <= kickoffAt) {
    scheduledAt = zonedTimeToMs({ ...localDate, day: localDate.day + 1, hour: 22, minute: 0 }, timeZone);
  }
  return {
    scheduledAt,
    timeZone,
    hour: 22,
    minute: 0,
    afterMatch: {
      id: lastMatch.id,
      jornada: lastMatch.desempate ? null : Number(lastMatch.jornada) || null,
      desempate: Boolean(lastMatch.desempate),
      kickoffAt
    },
    actualAt: event.status === 'settled' && event.result ? event.result.finalizedAt : null
  };
}

function ballonDorResultAnnouncementAt(store, event, timeZone = CASINO_TIME_ZONE) {
  if (!event || event.status !== 'settled' || !event.result
      || !Number.isSafeInteger(event.result.finalizedAt) || event.result.finalizedAt <= 0) return null;
  const finalization = ballonDorFinalizationSchedule(store, event, timeZone);
  const finalizedAt = event.result.finalizedAt;
  const local = calendarParts(new Date(finalizedAt), timeZone);
  let afterActualMatchAt = zonedTimeToMs({
    year: Number(local.year), month: Number(local.month), day: Number(local.day), hour: 22
  }, timeZone);
  if (afterActualMatchAt <= finalizedAt) {
    afterActualMatchAt = zonedTimeToMs({
      year: Number(local.year), month: Number(local.month), day: Number(local.day) + 1, hour: 22
    }, timeZone);
  }
  return Math.max(Number(finalization?.scheduledAt) || 0, finalizedAt, afterActualMatchAt);
}

function publicBallonDorMarket(event) {
  if (!event) return null;
  const oddsByCandidate = new Map((event.oddsSnapshot?.selections || []).map(row => [row.candidateId, row]));
  return {
    market: BALLON_DOR_MARKET,
    eventId: event.id,
    seasonMonth: event.seasonMonth,
    status: event.status,
    updatedAt: event.updatedAt,
    formulaVersion: event.formulaVersion,
    opensOnDay: 1,
    closesAfterJornada: 20,
    oddsSnapshot: event.oddsSnapshot ? {
      updatedAt: event.oddsSnapshot.updatedAt,
      afterJornada: event.oddsSnapshot.afterJornada,
      simulations: event.oddsSnapshot.simulations,
      overround: event.oddsSnapshot.overround
    } : null,
    candidates: event.candidates.map(candidate => {
      const quote = oddsByCandidate.get(candidate.id);
      return {
        id: candidate.id,
        clubId: candidate.clubId,
        clubName: candidate.clubName,
        clubShort: candidate.clubShort,
        clubColors: candidate.clubColors,
        playerId: candidate.playerId,
        playerName: candidate.playerName,
        playerNumber: candidate.playerNumber,
        position: candidate.position,
        attributes: candidate.attributes,
        stats: candidate.stats,
        points: candidate.points,
        probability: quote ? quote.probability : null,
        odds: quote ? quote.odds : null,
        impliedProbability: quote ? Number((1 / quote.odds).toFixed(6)) : null
      };
    }),
    result: event.status === 'settled' ? event.result : null,
    cancellationReason: event.status === 'cancelled' ? event.cancellationReason : null
  };
}

function isOfficialBallonDorResult(event) {
  if (!event || event.status !== 'settled' || !event.result
      || !Array.isArray(event.candidates) || event.candidates.length !== BALLON_DOR_CANDIDATE_COUNT
      || !Array.isArray(event.result.ranking)
      || event.result.ranking.length !== BALLON_DOR_CANDIDATE_COUNT) return false;
  const candidateById = new Map(event.candidates.map(candidate => [candidate.id, candidate]));
  const ranking = event.result.ranking.slice().sort((a, b) => a.rank - b.rank);
  const seen = new Set();
  const validRows = ranking.every((row, index) => {
    if (!row || !Number.isSafeInteger(row.rank) || row.rank !== index + 1
        || !Number.isSafeInteger(row.score) || !candidateById.has(row.candidateId)
        || seen.has(row.candidateId)
        || candidateById.get(row.candidateId)?.points?.total !== row.score) return false;
    seen.add(row.candidateId);
    return true;
  });
  return validRows && seen.size === BALLON_DOR_CANDIDATE_COUNT
    && ranking[0].candidateId === event.result.winnerCandidateId
    && ranking[0].score === event.result.winnerScore
    && Number.isSafeInteger(event.result.finalizedAt)
    && event.result.finalizedAt > 0;
}

function publicBallonDorCeremony(store, event) {
  if (!isOfficialBallonDorResult(event)) return null;
  const predictions = typeof store.getFutures === 'function'
    ? store.getFutures({ seasonMonth: event.seasonMonth }).filter(future => future.market === BALLON_DOR_MARKET)
    : [];
  const settled = predictions.filter(future => future.status === 'won' || future.status === 'lost');
  const applied = predictions.filter(future => (future.status === 'won' || future.status === 'lost') && future.payoutApplied);
  const paidWinners = applied.filter(future => future.status === 'won');
  const pendingCount = predictions.length - applied.length;
  return {
    verified: true,
    eventId: event.id,
    seasonMonth: event.seasonMonth,
    finalizedAt: event.result.finalizedAt,
    predictionCount: predictions.length,
    settledPredictionCount: settled.length,
    winningPredictionCount: predictions.filter(future => future.status === 'won').length,
    paidWinningPredictionCount: paidWinners.length,
    paidVirtualChips: paidWinners.reduce((sum, future) => sum + (Number(future.payout) || 0), 0),
    pendingPayoutCount: pendingCount,
    settlementComplete: predictions.length === applied.length
      && settled.length === predictions.length
  };
}

class BallonDorMarketService {
  constructor({
    store, betting, now = () => Date.now(), timeZone = CASINO_TIME_ZONE,
    log = () => {}, projectOdds = projectBallonDorOdds
  } = {}) {
    if (!store) throw new TypeError('store requerido para el mercado Balón de Oro');
    this.store = store;
    this.betting = betting || null;
    this.now = now;
    this.timeZone = timeZone;
    this.log = log;
    this.projectOdds = projectOdds;
    this.running = false;
    this.runningPromise = null;
    this.resettingMonths = new Set();
    this.announcedSeasons = new Set();
    this.sweepMetrics = {
      count: 0,
      errors: 0,
      lastRunAt: null,
      lastDurationMs: null,
      maxDurationMs: 0,
      lastStatus: 'never',
      durationSamplesMs: []
    };
  }

  // Snapshot agregado, apto para /healthz: no incluye identidades, selecciones,
  // stakes ni pagos individuales. Los tiempos se mantienen en memoria y se reinician
  // al arrancar el proceso; el estado del evento/boletos sigue siendo persistente.
  healthSnapshot() {
    const summarizeSeason = seasonMonth => {
      if (!seasonMonth) return null;
      const event = this.store.getBallonDor(seasonMonth);
      if (!event) return null;
      const predictions = typeof this.store.getFutures === 'function'
        ? this.store.getFutures({ seasonMonth }).filter(future => future.market === BALLON_DOR_MARKET)
        : [];
      const terminal = predictions.filter(future => ['won', 'lost', 'void'].includes(future.status));
      return {
        seasonMonth,
        status: event.status,
        predictions: {
          total: predictions.length,
          open: predictions.filter(future => future.status === 'open').length,
          pending: predictions.filter(future => future.status === 'pending').length,
          terminal: terminal.length,
          refunded: predictions.filter(future => future.status === 'void' && future.payoutApplied).length,
          pendingPayouts: terminal.filter(future => !future.payoutApplied).length
        }
      };
    };
    const currentMonth = typeof this.store.getCurrentSeasonMonth === 'function'
      ? this.store.getCurrentSeasonMonth() : null;
    const months = typeof this.store.getSeasonMonths === 'function'
      ? this.store.getSeasonMonths().slice().sort().reverse() : currentMonth ? [currentMonth] : [];
    const lastCompletedMonth = months.find(month => {
      const event = this.store.getBallonDor(month);
      return event && ['settled', 'cancelled'].includes(event.status);
    });
    const samples = this.sweepMetrics.durationSamplesMs.slice().sort((a, b) => a - b);
    const p95Index = samples.length ? Math.ceil(samples.length * 0.95) - 1 : -1;
    return {
      current: summarizeSeason(currentMonth),
      lastCompleted: lastCompletedMonth ? summarizeSeason(lastCompletedMonth) : null,
      sweep: {
        count: this.sweepMetrics.count,
        errors: this.sweepMetrics.errors,
        lastRunAt: this.sweepMetrics.lastRunAt,
        lastDurationMs: this.sweepMetrics.lastDurationMs,
        p95DurationMs: p95Index >= 0 ? samples[p95Index] : null,
        maxDurationMs: this.sweepMetrics.maxDurationMs,
        lastStatus: this.sweepMetrics.lastStatus
      }
    };
  }

  _beginRun() {
    this.running = true;
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this.runningPromise = promise;
    return () => {
      if (this.runningPromise === promise) this.runningPromise = null;
      this.running = false;
      release();
    };
  }

  getMarket(seasonMonth = this.store.getCurrentSeasonMonth()) {
    const event = this.store.getBallonDor(seasonMonth);
    const market = publicBallonDorMarket(event);
    if (!market) return null;
    market.finalization = ballonDorFinalizationSchedule(this.store, event, this.timeZone);
    const announcedAt = ballonDorResultAnnouncementAt(this.store, event, this.timeZone);
    market.resultAnnouncementAt = announcedAt;
    const official = isOfficialBallonDorResult(event);
    const announcementDue = announcedAt != null && this.now() >= announcedAt;
    market.awaitingAnnouncement = event.status === 'settled' && !announcementDue;
    if (event.status === 'settled' && (!announcementDue || !official)) {
      // No filtrar el ganador ni indirectamente por los puntos/estadísticas finales.
      market.result = null;
      market.candidates = market.candidates.map(candidate => ({
        ...candidate, stats: null, points: null
      }));
    }
    market.ceremony = announcementDue && official ? publicBallonDorCeremony(this.store, event) : null;
    return market;
  }

  // El archivo es una proyección pública de temporadas persistidas. Nunca
  // incluye perfiles, selecciones individuales ni identificadores de boletos.
  getArchive() {
    const months = typeof this.store.getSeasonMonths === 'function'
      ? this.store.getSeasonMonths() : [this.store.getCurrentSeasonMonth()];
    return months.slice().sort().reverse().map(seasonMonth => {
      const market = this.getMarket(seasonMonth);
      if (!market) return null;
      const winner = market.status === 'settled' && market.result
        ? market.candidates.find(candidate => candidate.id === market.result.winnerCandidateId) : null;
      return {
        eventId: market.eventId,
        seasonMonth: market.seasonMonth,
        status: market.status,
        finalizedAt: market.result?.finalizedAt || null,
        winner: winner ? {
          candidateId: winner.id,
          playerName: winner.playerName,
          clubId: winner.clubId,
          clubName: winner.clubName,
          score: market.result.winnerScore
        } : null,
        ceremony: market.ceremony ? {
          verified: market.ceremony.verified,
          settlementComplete: market.ceremony.settlementComplete,
          predictionCount: market.ceremony.predictionCount,
          paidVirtualChips: market.ceremony.paidVirtualChips
        } : null
      };
    }).filter(Boolean);
  }

  async sweep(at = this.now()) {
    if (this.running || this.resettingMonths.size) return { skipped: true };
    const startedAt = performance.now();
    const release = this._beginRun();
    const summary = { opened: 0, locked: 0, settled: 0, cancelled: 0, refunded: 0, oddsUpdated: 0, recoveredPayouts: 0, errors: 0 };
    let sweepError = null;
    try {
      if (this.betting?.reconcileBallonDorPayouts) {
        const recovery = await this.betting.reconcileBallonDorPayouts();
        summary.recoveredPayouts = recovery?.applied || 0;
      }
      const today = monthKey(new Date(at), this.timeZone);
      const months = typeof this.store.getSeasonMonths === 'function'
        ? this.store.getSeasonMonths() : [this.store.getCurrentSeasonMonth()];
      for (const seasonMonth of months.slice().sort()) {
        const league = this.store.getLeague(seasonMonth);
        if (!league?.ballonDor) continue;
        try {
          const was = this.store.getBallonDor(seasonMonth)?.status;
          await this._advanceLeague(league, at, today, summary);
          const is = this.store.getBallonDor(seasonMonth)?.status;
          if (was !== is) {
            if (is === 'active') summary.opened++;
            else if (is === 'locked') summary.locked++;
            else if (is === 'settled') summary.settled++;
            else if (is === 'cancelled') summary.cancelled++;
          }
        } catch (error) {
          summary.errors++;
          this.log('football_ballon_dor_lifecycle_error', {
            seasonMonth, message: String(error?.message || error)
          });
        }
      }
      return summary;
    } catch (error) {
      sweepError = error;
      throw error;
    } finally {
      const durationMs = Number(Math.max(0, performance.now() - startedAt).toFixed(3));
      const metric = this.sweepMetrics;
      metric.count++;
      metric.errors += summary.errors + (sweepError ? 1 : 0);
      metric.lastRunAt = Number.isSafeInteger(Number(at)) ? Number(at) : null;
      metric.lastDurationMs = durationMs;
      metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
      metric.lastStatus = sweepError ? 'error' : summary.errors ? 'partial' : 'ok';
      metric.durationSamplesMs.push(durationMs);
      if (metric.durationSamplesMs.length > 100) metric.durationSamplesMs.shift();
      try {
        const operationalSummary = { ...summary };
        delete operationalSummary.refunded;
        this.log('football_ballon_dor_sweep_completed', {
          seasonMonth: typeof this.store.getCurrentSeasonMonth === 'function'
            ? this.store.getCurrentSeasonMonth() : null,
          durationMs,
          status: metric.lastStatus,
          errorCount: summary.errors + (sweepError ? 1 : 0),
          ...operationalSummary
        });
      } catch (_) {
        // La instrumentación no debe alterar la liberación del lock del sweep.
      }
      release();
    }
  }

  async beforeSeasonReset(seasonMonth, at = this.now()) {
    if (this.resettingMonths.has(seasonMonth)) return { ok: true, skipped: true };
    this.resettingMonths.add(seasonMonth);
    try {
      while (this.runningPromise) await this.runningPromise;
      const release = this._beginRun();
      try {
        const league = this.store.getLeague(seasonMonth);
        if (!league?.ballonDor) return { ok: true, skipped: true };
        const monthAfter = monthKey(new Date(at), this.timeZone);
        const summary = { opened: 0, locked: 0, settled: 0, cancelled: 0, refunded: 0, oddsUpdated: 0 };
        await this._advanceLeague(league, at, monthAfter, summary, { resetting: true });
        if (this.betting?.reconcileBallonDorPayouts) {
          const recovery = await this.betting.reconcileBallonDorPayouts();
          summary.recoveredPayouts = recovery?.applied || 0;
        }
        return summary;
      } finally {
        release();
      }
    } finally {
      this.resettingMonths.delete(seasonMonth);
    }
  }

  async _advanceLeague(league, at, currentMonth, summary, { resetting = false } = {}) {
    let event = this.store.getBallonDor(league.seasonMonth);
    if (!event) return;
    const seasonMonth = league.seasonMonth;
    if (event.status === 'settled') {
      const announcementAt = ballonDorResultAnnouncementAt(this.store, event, this.timeZone);
      if (!isOfficialBallonDorResult(event) || announcementAt == null || at < announcementAt) return;
      if (!this.announcedSeasons.has(seasonMonth)) {
        this.announcedSeasons.add(seasonMonth);
        summary.announced = (summary.announced || 0) + 1;
        this.log('football_ballon_dor_announcement_available', { seasonMonth, resultAnnouncementAt: announcementAt });
      }
      if (this.betting?.settleBallonDorBets) {
        const payout = await this.betting.settleBallonDorBets(seasonMonth, event.result.winnerCandidateId, at);
        if (payout && (payout.settled || payout.paid || payout.recovered)) {
          const ceremony = publicBallonDorCeremony(this.store, event);
          this.log('football_ballon_dor_payouts_updated', {
            seasonMonth,
            settledPredictions: ceremony?.settledPredictionCount || 0,
            settlementComplete: Boolean(ceremony?.settlementComplete)
          });
        }
      }
      return;
    }
    if (event.status === 'cancelled') {
      if (this.betting?.refundBallonDorBets) {
        const result = await this.betting.refundBallonDorBets(seasonMonth, event.cancellationReason, at);
        summary.refunded += result.refunded || 0;
      }
      return;
    }

    const isExpired = currentMonth > seasonMonth;
    if (league.status === 'truncated') {
      await this._cancel(league, 'temporada_truncada', at, summary);
      return;
    }

    if (event.status === 'scheduled') {
      if (isExpired || currentMonth < seasonMonth) {
        await this._cancel(league, 'apertura_no_realizada_dia_1', at, summary);
        return;
      }
      const local = calendarParts(new Date(at), this.timeZone);
      if (Number(local.day) !== 1) {
        await this._cancel(league, 'apertura_no_realizada_dia_1', at, summary);
        return;
      }
      const firstRound = league.calendar.matches.filter(match => !match.desempate && match.jornada === 1);
      if (firstRound.length !== 8) {
        await this._cancel(league, 'calendario_invalido', at, summary);
        return;
      }
      const transition = await this.store.transitionBallonDor(seasonMonth, 'active', {
        at: Math.max(at, event.updatedAt)
      });
      if (!transition.ok) return;
      event = transition.event;
      try {
        const completed = Math.min(20, lastCompletedJornada(league));
        await this._refreshOdds(league, completed, at);
        summary.oddsUpdated++;
      } catch (error) {
        this.log('football_ballon_dor_odds_error', { seasonMonth, jornada: 0, message: String(error?.message || error) });
      }
      return;
    }

    if (event.status === 'active') {
      if (isExpired || resetting || at >= closeDeadline(seasonMonth, this.timeZone)) {
        const completed = lastCompletedJornada(league);
        if (completed >= 20) {
          await this._refreshIfDue(league, completed, at, summary);
          const locked = await this.store.transitionBallonDor(seasonMonth, 'locked', {
            at: Math.max(at, this.store.getBallonDor(seasonMonth).updatedAt)
          });
          if (!locked.ok) return;
          event = locked.event;
        } else {
          await this._cancel(league, 'temporada_no_cerrada_antes_reset', at, summary);
          return;
        }
      } else {
        const completed = lastCompletedJornada(league);
        await this._refreshIfDue(league, completed, at, summary);
        if (completed >= 20) {
          const locked = await this.store.transitionBallonDor(seasonMonth, 'locked', {
            at: Math.max(at, this.store.getBallonDor(seasonMonth).updatedAt)
          });
          if (!locked.ok) return;
          event = locked.event;
        } else return;
      }
    }

    if (event.status !== 'locked') return;
    const completed = lastCompletedJornada(league);
    if (completed >= 20 && (event.oddsSnapshot?.afterJornada || -1) < 20) {
      await this._refreshIfDue(league, 20, at, summary);
      event = this.store.getBallonDor(seasonMonth);
    }

    const deadline = closeDeadline(seasonMonth, this.timeZone);
    if (completed < 30 || !allRegularMatchesSettled(league)) {
      if (isExpired || at >= deadline) {
        await this._cancel(league, 'temporada_no_cerrada_antes_reset', at, summary);
      }
      return;
    }
    if (!regularMatchesSettledBy(league, deadline)) {
      await this._cancel(league, 'temporada_no_cerrada_antes_reset', at, summary);
      return;
    }

    let resolution = officialPositions(league);
    if (resolution.reason === 'desempate_requerido') {
      if (isExpired || at >= deadline) {
        await this._cancel(league, 'desempate_no_resuelto_antes_reset', at, summary);
        return;
      }
      const kickoffAt = tiebreakKickoffAt(seasonMonth, at, this.timeZone);
      if (kickoffAt == null) {
        await this._cancel(league, 'desempate_no_cabe_en_ventana_de_cierre', at, summary);
        return;
      }
      const created = await this.store.createBallonDorTiebreak(seasonMonth, {
        homeId: resolution.homeId, awayId: resolution.awayId, kickoffAt
      });
      if (!created.ok && created.reason !== 'already_exists') {
        this.log('football_ballon_dor_tiebreak_error', { seasonMonth, reason: created.reason });
      }
      return;
    }
    if (!resolution.ok) {
      const tiebreak = league.calendar.matches.find(match => match.desempate);
      if (tiebreak && (isExpired || at >= deadline)) {
        await this._cancel(league, 'desempate_no_resuelto_antes_reset', at, summary);
      }
      return;
    }
    const tiebreak = league.calendar.matches.find(match => match.desempate);
    if (tiebreak && (!tiebreak.settledAt || tiebreak.settledAt > deadline)) {
      await this._cancel(league, 'desempate_no_resuelto_antes_reset', at, summary);
      return;
    }

    const currentEvent = this.store.getBallonDor(seasonMonth);
    const finalized = await this.store.finalizeBallonDor(seasonMonth, resolution.positions, {
      at: Math.max(at, currentEvent.updatedAt)
    });
    if (!finalized.ok) {
      this.log('football_ballon_dor_finalize_error', { seasonMonth, reason: finalized.reason });
      return;
    }
    let payout = null;
    const announcementAt = ballonDorResultAnnouncementAt(this.store, finalized.event, this.timeZone);
    if (this.betting?.settleBallonDorBets && announcementAt != null && at >= announcementAt) {
      payout = await this.betting.settleBallonDorBets(seasonMonth, finalized.event.result.winnerCandidateId, at);
    }
    this.log('football_ballon_dor_settled', {
      seasonMonth, winnerCandidateId: finalized.event.result.winnerCandidateId,
      rankCount: finalized.event.result.ranking.length,
      resultAnnouncementAt: announcementAt
    });
    if (payout && (payout.settled || payout.paid || payout.recovered)) {
      const ceremony = publicBallonDorCeremony(this.store, finalized.event);
      this.log('football_ballon_dor_payouts_updated', {
        seasonMonth,
        settledPredictions: ceremony?.settledPredictionCount || 0,
        settlementComplete: Boolean(ceremony?.settlementComplete)
      });
    }
  }

  async _refreshIfDue(league, completed, at, summary) {
    const event = this.store.getBallonDor(league.seasonMonth);
    if (completed < 0 || completed > 20) return false;
    if (event?.oddsSnapshot && completed <= event.oddsSnapshot.afterJornada) return false;
    await this._refreshOdds(league, completed, at);
    summary.oddsUpdated++;
    return true;
  }

  async _refreshOdds(league, completed, at) {
    const event = this.store.getBallonDor(league.seasonMonth);
    if (!event || !['active', 'locked'].includes(event.status)) return { ok: false, reason: 'mercado_no_activo' };
    const updatedAt = Math.max(at, event.updatedAt);
    const snapshot = this.projectOdds({ league, afterJornada: completed, updatedAt });
    const updated = await this.store.updateBallonDorOdds(league.seasonMonth, snapshot, updatedAt);
    if (updated.ok && !updated.already) {
      this.log('football_ballon_dor_odds_updated', {
        seasonMonth: league.seasonMonth, jornada: completed,
        simulations: SIMULATIONS, seed: snapshot.seed
      });
    }
    return updated;
  }

  async _cancel(league, reason, at, summary) {
    const event = this.store.getBallonDor(league.seasonMonth);
    if (!event || ['settled', 'cancelled'].includes(event.status)) return { ok: true, already: true };
    const transition = await this.store.transitionBallonDor(league.seasonMonth, 'cancelled', {
      at: Math.max(at, event.updatedAt), reason
    });
    if (!transition.ok) return transition;
    if (this.betting?.refundBallonDorBets) {
      const refunded = await this.betting.refundBallonDorBets(league.seasonMonth, reason, at);
      summary.refunded += refunded.refunded || 0;
    }
    this.log('football_ballon_dor_cancelled', { seasonMonth: league.seasonMonth, reason });
    return transition;
  }
}

module.exports = {
  BALLON_DOR_MARKET,
  SIMULATIONS,
  OVERROUND,
  MAX_ODDS,
  MAX_PAYOUT,
  TIEBREAK_RUNTIME_BUDGET_MS,
  oddsFromProbability,
  projectBallonDorOdds,
  lastCompletedJornada,
  allRegularMatchesSettled,
  regularMatchesSettledBy,
  officialPositions,
  closeDeadline,
  tiebreakKickoffAt,
  ballonDorFinalizationSchedule,
  ballonDorResultAnnouncementAt,
  publicBallonDorMarket,
  isOfficialBallonDorResult,
  publicBallonDorCeremony,
  BallonDorMarketService
};
