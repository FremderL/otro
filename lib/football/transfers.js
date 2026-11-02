'use strict';

const { hash32, mulberry32 } = require('./prng');
const { emptySeasonStats } = require('./teams');
const { playerValue } = require('./player-value');
const {
  managerOfClub,
  diagnoseSquadNeed,
  scoreTransferTarget,
  describeManagerSigning
} = require('./managers');
const { buildClubNews } = require('./club-news');
const { calendarParts, monthKey, CASINO_TIME_ZONE } = require('../profile-store-shared');

const POS_GROUP = {
  GK: 'GK',
  CB: 'DF', LB: 'DF', RB: 'DF', LWB: 'DF', RWB: 'DF',
  CDM: 'MF', CM: 'MF', CAM: 'MF', LM: 'MF', RM: 'MF',
  LW: 'FW', RW: 'FW', ST: 'FW', CF: 'FW'
};

function nextMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
}

function shuffled(array, random) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Protege el equilibrio estructural del club vendedor a través de múltiples temporadas:
// nunca vende porteros ni deja al plantel sin CM, sin ST o sin suficientes defensas/medios.
function canClubSellPlayer(club, player) {
  if (!club || !Array.isArray(club.squad) || !player || player.pos === 'GK') return false;
  if (player.pos === 'CM' && club.squad.filter(p => p.pos === 'CM').length <= 1) return false;
  if (player.pos === 'ST' && club.squad.filter(p => p.pos === 'ST').length <= 1) return false;
  const group = POS_GROUP[player.pos] || 'MF';
  if (group === 'DF' && club.squad.filter(p => (POS_GROUP[p.pos] || 'MF') === 'DF').length <= 4) return false;
  if (group === 'MF' && club.squad.filter(p => (POS_GROUP[p.pos] || 'MF') === 'MF').length <= 5) return false;
  return true;
}

// El plan no altera la liga en curso; es estable tras reinicio y no depende del reloj.
// v3: 8 clubes en dos CICLOS de 4 (A→B→C→D→A) donde el DT del club comprador
// elige el fichaje según las carencias reales de su plantilla y su sistema táctico.
const TRANSFER_VERSION = 'traspasos:v3-dt';
function planTransfers(league) {
  if (!league?.seasonMonth || !Array.isArray(league.config) || league.config.length !== 16 || !nextMonth(league.seasonMonth)) return null;
  const clubs = league.config;
  const players = clubs.flatMap(club => club.squad || []);
  if (clubs.some(club => !club.id || !Array.isArray(club.squad) || club.squad.length !== 18 || club.squad.filter(p => p.pos === 'CM').length < 1)
      || new Set(clubs.map(c => c.id)).size !== 16 || players.some(p => !p.id || !p.name || !p.attrs)
      || new Set(players.map(p => p.id)).size !== 288) return null;

  const random = mulberry32(hash32(`${league.seasonMonth}:${TRANSFER_VERSION}`));
  const picked = shuffled([...clubs].sort((a, b) => a.id.localeCompare(b.id)), random).slice(0, 8);
  const moves = [];
  const usedPlayers = new Set();
  const pickedPositions = new Set();

  for (let group = 0; group < 2; group++) {
    const cycle = picked.slice(group * 4, group * 4 + 4);
    for (let i = 0; i < 4; i++) {
      const from = cycle[i], to = cycle[(i + 1) % 4];
      const buyingCoach = managerOfClub(to, league.seasonMonth);
      const need = diagnoseSquadNeed(to, buyingCoach);
      const eligible = from.squad
        .filter(p => !usedPlayers.has(p.id) && canClubSellPlayer(from, p))
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));
      const fallbackPool = from.squad
        .filter(p => !usedPlayers.has(p.id) && p.pos !== 'GK' && !(p.pos === 'CM' && from.squad.filter(x => x.pos === 'CM').length <= 1))
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));
      const pool = eligible.length ? eligible : fallbackPool;
      if (!pool.length) return null;

      // Garantiza diversidad de puestos si las primeras 7 operaciones coincidieron en posición.
      const mustVaryPosition = moves.length === 7 && pickedPositions.size < 2;
      const candidatePool = mustVaryPosition && pool.some(p => !pickedPositions.has(p.pos))
        ? pool.filter(p => !pickedPositions.has(p.pos))
        : pool;

      const scored = candidatePool
        .map(p => ({
          player: p,
          score: scoreTransferTarget(p, to, buyingCoach, need) + random() * 1.5
        }))
        .sort((a, b) => b.score - a.score || a.player.id.localeCompare(b.player.id));

      const player = scored[0].player;
      usedPlayers.add(player.id);
      pickedPositions.add(player.pos);
      moves.push({
        fromId: from.id,
        toId: to.id,
        playerId: player.id,
        playerName: player.name,
        managerId: buyingCoach.id,
        managerName: buyingCoach.name
      });
    }
  }
  return { seasonMonth: league.seasonMonth, effectiveSeason: nextMonth(league.seasonMonth), moves };
}

// Si se saltó un mes se conserva el último plantel conocido, sin inventar
// acuerdos no anunciados. Nunca se infiere el club por el prefijo del ID.
function retainPreviousSquads(previous, clubs) {
  if (!planTransfers(previous) || !Array.isArray(clubs) || clubs.length !== 16) return false;
  const byId = new Map(previous.config.map(club => [club.id, club]));
  if (new Set(clubs.map(club => club.id)).size !== 16 || clubs.some(club => !byId.has(club.id))) return false;
  for (const club of clubs) club.squad = byId.get(club.id).squad.map(player => ({
    ...player, attrs: { ...player.attrs }, season: emptySeasonStats()
  }));
  return true;
}

function applyTransfers(previous, clubs, targetMonth) {
  const plan = planTransfers(previous);
  if (!plan || plan.effectiveSeason !== targetMonth || !Array.isArray(clubs) || clubs.length !== 16) return false;
  // Toda la plantilla conserva identidad entre temporadas, no solo los fichados.
  if (!retainPreviousSquads(previous, clubs)) return false;
  const byId = new Map(clubs.map(c => [c.id, c]));
  // El plan debe ser una permutación por club: mismos entrantes que salientes.
  const outCount = new Map(), inCount = new Map();
  for (const m of plan.moves) {
    outCount.set(m.fromId, (outCount.get(m.fromId) || 0) + 1);
    inCount.set(m.toId, (inCount.get(m.toId) || 0) + 1);
  }
  for (const [clubId, n] of outCount) if ((inCount.get(clubId) || 0) !== n) throw new Error('Plan de traspasos inconsistente');
  // Lee TODOS los jugadores que se mueven antes de escribir ninguno (cada uno se mueve una sola vez).
  const outgoingSlots = new Map(), incomingPlayers = new Map();
  for (const m of plan.moves) {
    const from = byId.get(m.fromId);
    const idx = from.squad.findIndex(p => p.id === m.playerId);
    if (idx < 0) throw new Error('Plan de traspasos inconsistente');
    if (!outgoingSlots.has(m.fromId)) outgoingSlots.set(m.fromId, []);
    outgoingSlots.get(m.fromId).push(idx);
    if (!incomingPlayers.has(m.toId)) incomingPlayers.set(m.toId, []);
    incomingPlayers.get(m.toId).push(from.squad[idx]);
  }
  // El que llega a un club ocupa el dorsal del que sale (mismo orden del plan).
  for (const [clubId, slots] of outgoingSlots) {
    const club = byId.get(clubId);
    const arrivals = incomingPlayers.get(clubId) || [];
    if (arrivals.length !== slots.length) throw new Error('Plan de traspasos inconsistente');
    slots.forEach((slot, i) => { club.squad[slot] = { ...arrivals[i], num: club.squad[slot].num }; });
  }
  return true;
}

// La conferencia de prensa del mercado muestra cada acuerdo con el valor del
// jugador y el pedido táctico del DT comprador.
function valuedMove(league, move) {
  const fromClub = league.config.find(c => c.id === move.fromId);
  const toClub = league.config.find(c => c.id === move.toId);
  const player = fromClub && fromClub.squad.find(p => p.id === move.playerId);
  const signingMeta = toClub ? describeManagerSigning(move, toClub, league.seasonMonth) : {};
  if (!player) return { ...move, ...signingMeta };
  return {
    ...move,
    ...signingMeta,
    position: player.pos,
    playerValue: playerValue(player)
  };
}

function publicTransfers(league, at = Date.now(), options = {}) {
  const plan = planTransfers(league);
  if (!plan) return { status: 'unavailable', moves: [], clubNews: [] };
  const clubNews = buildClubNews({
    league,
    previousLeague: options.previousLeague || null,
    at,
    fanRanking: options.fanRanking || []
  });
  const date = new Date(at), month = monthKey(date, CASINO_TIME_ZONE), day = Number(calendarParts(date, CASINO_TIME_ZONE).day);
  if (month < plan.seasonMonth || (month === plan.seasonMonth && day < 15)) {
    return {
      status: 'scheduled',
      seasonMonth: plan.seasonMonth,
      effectiveSeason: plan.effectiveSeason,
      moves: [],
      clubNews
    };
  }
  return {
    ...plan,
    moves: plan.moves.map(move => valuedMove(league, move)),
    clubNews,
    status: month >= plan.effectiveSeason ? 'effective' : 'announced'
  };
}

module.exports = { nextMonth, planTransfers, applyTransfers, retainPreviousSquads, publicTransfers };
