'use strict';

const { hash32, mulberry32 } = require('./prng');
const { emptySeasonStats } = require('./teams');
const { playerValue } = require('./player-value');
const {
  managerOfClub,
  diagnoseSquadNeed,
  goalkeepingNeed,
  improvementOverCurrent,
  scoreStarterForCoach,
  scoreTransferTarget,
  describeManagerSigning
} = require('./managers');
const { buildClubNews } = require('./club-news');
const { clubBudget, canAfford } = require('./club-stock');
const { addFreePlayer, removeFreePlayer, cleanFreeAgents } = require('./free-agents');
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
// Intercambio de porteros entre dos clubes. Se elige al DT con el arco más
// débil y se le busca el mejor portero suplente disponible: el que llega tiene
// que mejorar a su titular, y el club que lo cede recibe a cambio el suplente
// del comprador, así ambos mantienen dos guardametas.
function planKeeperSwaps(clubs, league, usedPlayers, allocated = 0) {
  if (!Array.isArray(clubs) || clubs.length < 2) return [];
  const month = league.seasonMonth;
  const budget = Math.max(0, 4 - Math.max(0, allocated - 8));
  if (!budget) return [];

  const keepersOf = club => (club.squad || [])
    .filter(p => p.pos === 'GK' && !usedPlayers.has(p.id))
    .sort((a, b) => keeperValue(b) - keeperValue(a) || a.id.localeCompare(b.id));

  const needy = clubs
    .map(club => {
      const coach = managerOfClub(club, month);
      const need = goalkeepingNeed(club, coach);
      return { club, coach, need, keepers: keepersOf(club) };
    })
    .filter(entry => entry.need.needsKeeper && entry.keepers.length >= 2)
    .sort((a, b) => b.need.deficit - a.need.deficit || a.club.id.localeCompare(b.club.id));

  const moves = [];
  const touched = new Set();
  for (const buyer of needy) {
    if (moves.length >= budget * 2) break;
    if (touched.has(buyer.club.id)) continue;
    const starter = buyer.keepers[0];
    // El suplente del otro club: tiene que superar al titular del comprador.
    let best = null;
    for (const donor of clubs) {
      if (donor.id === buyer.club.id) continue;
      if (touched.has(donor.id)) continue;
      const candidates = keepersOf(donor);
      if (candidates.length < 2) continue;
      const spare = candidates[1];
      const donorCoach = managerOfClub(donor, month);
      if (keeperValue(spare, donorCoach) <= keeperValue(starter, buyer.coach) + 1) continue;
      if (!best || keeperValue(spare, donorCoach) > keeperValue(best.spare, managerOfClub(best.donor, month))) {
        best = { donor, spare };
      }
    }
    if (!best) continue;
    const returned = buyer.keepers[buyer.keepers.length - 1];
    if (!returned || returned.id === starter.id) continue;
    touched.add(buyer.club.id);
    touched.add(best.donor.id);
    usedPlayers.add(best.spare.id);
    usedPlayers.add(returned.id);
    moves.push({
      fromId: best.donor.id,
      toId: buyer.club.id,
      playerId: best.spare.id,
      playerName: best.spare.name,
      managerId: buyer.coach.id,
      managerName: buyer.coach.name,
      kind: 'goalkeeper'
    });
    const donorCoach = managerOfClub(best.donor, month);
    moves.push({
      fromId: buyer.club.id,
      toId: best.donor.id,
      playerId: returned.id,
      playerName: returned.name,
      managerId: donorCoach.id,
      managerName: donorCoach.name,
      kind: 'goalkeeper_return'
    });
  }
  return moves;
}

// Valor del portero con la misma métrica que usa el DT para elegir el once.
function keeperValue(player, coach) {
  return scoreStarterForCoach(player, 'GK', coach);
}

// Fichajes desde la lista de inactivos. Tres reglas:
//   1. Solo se ficha si MEJORA el once (improvementOverCurrent) o si cubre el
//      arco; no se ficha por cambiar.
//   2. Solo se ficha si el club puede PAGARLO con su presupuesto de la Casa.
//   3. La plantilla sigue en 18: quien llega desplaza a un suplente, que vuelve
//      al fondo. Nunca se debilita a otro club para reforzarse.
// El resultado es determinista: se ordena por prioridad y por id.
function planFreeAgentSignings(clubs, league, usedPlayers, random) {
  const moves = [];
  const freeAgents = cleanFreeAgents(league.freeAgents);
  if (!freeAgents.players.length || !Array.isArray(clubs)) return moves;

  // Prioridad: primero la promesa de la temporada (es LA noticia del año), luego
  // los agentes libres normales. Un club por jugador.
  const queue = freeAgents.players.slice().sort((a, b) => {
    if (Boolean(b.wonderkid) !== Boolean(a.wonderkid)) return b.wonderkid ? 1 : -1;
    return String(a.id).localeCompare(String(b.id));
  });

  const taken = new Set();
  for (const player of queue) {
    const ranked = clubs
      .filter(club => !taken.has(club.id))
      .map(club => {
        const coach = managerOfClub(club, league.seasonMonth);
        const improvement = improvementOverCurrent(player, club, coach);
        const keeper = player.pos === 'GK' ? goalkeepingNeed(club, coach) : null;
        const fitsKeeper = keeper && keeper.needsKeeper;
        const priority = (player.wonderkid ? 40 : 0) + improvement.delta + (fitsKeeper ? 6 : 0)
          + random() * 2;
        return { club, coach, improvement, fitsKeeper, priority };
      })
      // Sin mejora real (ni arco en crisis) el DT no se molesta.
      .filter(entry => entry.improvement.delta > 0.5 || entry.fitsKeeper)
      .sort((a, b) => b.priority - a.priority || a.club.id.localeCompare(b.club.id));

    for (const entry of ranked) {
      const value = playerValue(player);
      const multiplier = entry.improvement.delta > 6 ? 1.35 : entry.improvement.delta > 3 ? 1.15 : 1;
      const fee = Math.round(value * multiplier * 10) / 10;
      const affordable = canAfford(league, entry.club.id, fee);
      if (!affordable.ok) continue;

      // Quién sale para dejar su plaza: el suplente más flojo de la misma línea,
      // y nunca el único portero.
      const group = POS_GROUP[player.pos] || 'MF';
      const candidates = entry.club.squad
        .filter(p => !usedPlayers.has(p.id))
        .filter(p => p.id !== player.id)
        .filter(p => (POS_GROUP[p.pos] || 'MF') === group)
        .filter(p => p.pos !== 'GK')
        .map(p => ({ player: p, score: scoreStarterForCoach(p, group, entry.coach) }))
        .sort((a, b) => a.score - b.score || a.player.id.localeCompare(b.player.id));
      const outgoing = candidates.length ? candidates[0].player : null;
      if (outgoing && !canClubSellPlayer(entry.club, outgoing)) continue;

      const budget = clubBudget(league, entry.club.id);
      moves.push({
        fromId: null,
        toId: entry.club.id,
        playerId: player.id,
        playerName: player.name,
        managerId: entry.coach.id,
        managerName: entry.coach.name,
        kind: player.wonderkid ? 'wonderkid' : 'free_agent',
        fee,
        budget: budget ? budget.budget : null,
        improvement: Number(entry.improvement.delta.toFixed(2)),
        releasedPlayerId: outgoing ? outgoing.id : null,
        releasedPlayerName: outgoing ? outgoing.name : null
      });
      taken.add(entry.club.id);
      usedPlayers.add(player.id);
      if (outgoing) usedPlayers.add(outgoing.id);
      break;
    }
  }
  return moves;
}

// Fondo de inactivos después del mercado: sale quien ficha y entra quien libera
// su plaza. Si el plan no trae jugadores del fondo, el resultado es el mismo
// fondo de entrada (no se rellena solo, nunca).
function resultingFreeAgents(league, moves) {
  let freeAgents = cleanFreeAgents(league.freeAgents);
  const squadOf = clubId => (league.config.find(club => club.id === clubId)?.squad || []);
  for (const move of moves || []) {
    if (!move || move.fromId != null) continue;
    freeAgents = removeFreePlayer(freeAgents, move.playerId);
    if (move.releasedPlayerId) {
      const released = squadOf(move.toId).find(player => player.id === move.releasedPlayerId);
      if (released) {
        freeAgents = addFreePlayer(freeAgents, released, { releasedFrom: move.toId, seasonMonth: league.seasonMonth });
      }
    }
  }
  return freeAgents;
}

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
      // Los porteros no entran en la cadena normal (ver el intercambio pareado
      // al final): un club nunca se queda sin guardameta.
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

      // El DT no ficha para cambiar: puntúa cada candidato por lo que sube el
      // once real y descarta a quien no lo mejora si hay alternativa.
      const scored = candidatePool
        .map(p => {
          const improvement = improvementOverCurrent(p, to, buyingCoach);
          return {
            player: p,
            improvement,
            score: scoreTransferTarget(p, to, buyingCoach, need)
              + improvement.delta * 0.6
              + (improvement.delta > 0.5 ? 2 : -3)
              + random() * 1.5
          };
        })
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

  // Fichajes desde la lista de inactivos: aquí NO hay entrada por salida. El club
  // paga con su presupuesto de la Casa Montecristo y, si el fondo se queda corto
  // de plazas, libera a un suplente que vuelve al fondo. Es el camino natural
  // para la promesa de la temporada y para reforzar sin debilitar a otro club.
  const freeMoves = planFreeAgentSignings(clubs, league, usedPlayers, random);
  moves.push(...freeMoves);

  // El arco también se refuerza. Un club no puede vender a su único portero, así
  // que el guardameta viaja en un intercambio pareado: cada club manda un
  // portero y recibe otro, y ninguno baja de dos. El DT comprador se lleva al
  // suplente del otro club solo si mejora a su titular; a cambio cede su propio
  // suplente, que pedía minutos.
  const keeperMoves = planKeeperSwaps(clubs, league, usedPlayers, moves.length);
  moves.push(...keeperMoves);

  return {
    seasonMonth: league.seasonMonth,
    effectiveSeason: nextMonth(league.seasonMonth),
    moves,
    // El fondo resultante viaja con el plan: quien lo aplica no tiene que
    // recalcularlo y las dos piezas (plantillas y lista de inactivos) nunca se
    // contradicen. Es una función pura de los movimientos.
    freeAgents: resultingFreeAgents(league, moves)
  };
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
  // Los fichajes desde la lista de inactivos se aplican ANTES del intercambio:
  // sustituyen en su plaza a un suplente que no participa en él, así que los
  // índices del intercambio siguen siendo válidos y nadie se mueve dos veces.
  applyFreeAgentMoves(previous, clubs, plan);
  const byId = new Map(clubs.map(c => [c.id, c]));
  // El plan debe ser una permutación por club: mismos entrantes que salientes.
  // El invariante de permutación (lo que sale de un club es lo que entra a ese
  // club) solo aplica al intercambio entre clubes. Los fichajes desde la lista
  // de inactivos van aparte: ahí no hay club vendedor y el que llega ocupa la
  // plaza de un liberado, no la de un traspasado.
  const outCount = new Map(), inCount = new Map();
  for (const m of plan.moves) {
    if (m.fromId == null) continue;
    outCount.set(m.fromId, (outCount.get(m.fromId) || 0) + 1);
    inCount.set(m.toId, (inCount.get(m.toId) || 0) + 1);
  }
  for (const [clubId, n] of outCount) if ((inCount.get(clubId) || 0) !== n) throw new Error('Plan de traspasos inconsistente');
  // Lee TODOS los jugadores que se mueven antes de escribir ninguno (cada uno se mueve una sola vez).
  const outgoingSlots = new Map(), incomingPlayers = new Map();
  for (const m of plan.moves) {
    const from = m.fromId == null ? null : byId.get(m.fromId);
    if (!from) continue;
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

// Fichajes desde la lista de inactivos. El jugador llega del fondo y ocupa la
// plaza del suplente liberado (mismo dorsal, misma línea), así la plantilla
// sigue en 18 y el fondo registra la baja y la entrada. Sin esto, el mercado
// libre sería solo decorativo.
function applyFreeAgentMoves(previous, clubs, plan) {
  const freeMoves = (plan.moves || []).filter(move => move && move.fromId == null);
  if (!freeMoves.length) return;
  let freeAgents = cleanFreeAgents(previous.freeAgents);
  const byId = new Map(clubs.map(club => [club.id, club]));
  for (const move of freeMoves) {
    const club = byId.get(move.toId);
    if (!club || !Array.isArray(club.squad)) continue;
    const incoming = freeAgents.players.find(player => player.id === move.playerId);
    if (!incoming) continue;
    const outIndex = move.releasedPlayerId
      ? club.squad.findIndex(player => player.id === move.releasedPlayerId)
      : -1;
    if (move.releasedPlayerId && outIndex < 0) continue;
    // Quien sale deja su dorsal y su línea al que llega.
    const slotNumber = outIndex >= 0 ? club.squad[outIndex].num : null;
    const signing = {
      id: incoming.id,
      num: slotNumber != null ? slotNumber : (club.squad.find(player => player.num > 18)?.num || 0),
      name: incoming.name,
      pos: incoming.pos,
      attrs: { ...incoming.attrs },
      season: emptySeasonStats()
    };
    if (slotNumber == null) {
      // Sin suplente concreto no se inventa una plaza: el fichaje se descarta y
      // el jugador se queda en el fondo para la próxima temporada.
      continue;
    }
    club.squad[outIndex] = signing;
    freeAgents = removeFreePlayer(freeAgents, move.playerId);
    const out = { id: move.releasedPlayerId, name: move.releasedPlayerName, pos: incoming.pos, attrs: {} };
    // El liberado vuelve al fondo con sus atributos reales, no con un hueco.
    const original = previous.config.find(c => c.id === club.id)?.squad.find(p => p.id === move.releasedPlayerId);
    freeAgents = addFreePlayer(freeAgents, original || out, { releasedFrom: club.id, seasonMonth: previous.seasonMonth });
  }
  // El fondo actualizado viaja con la liga nueva; el store lo copia a su campo.
  plan.freeAgents = freeAgents;
}

// La conferencia de prensa del mercado muestra cada acuerdo con el valor del
// jugador y el pedido táctico del DT comprador.
function valuedMove(league, move) {
  const fromClub = league.config.find(c => c.id === move.fromId);
  const toClub = league.config.find(c => c.id === move.toId);
  // Un fichaje de la lista de inactivos no viene de un club: el jugador se busca
  // en el fondo, que es donde está antes de firmar.
  const freeAgent = move.fromId == null
    ? cleanFreeAgents(league.freeAgents).players.find(p => p.id === move.playerId)
    : null;
  const player = freeAgent || (fromClub && fromClub.squad.find(p => p.id === move.playerId));
  const signingMeta = toClub ? describeManagerSigning(move, toClub, league.seasonMonth, player) : {};
  if (!player) return { ...move, ...signingMeta };
  return {
    ...move,
    ...signingMeta,
    position: player.pos,
    playerValue: playerValue(player)
  };
}

// Movimientos ya valorados con su porqué, sin la compuerta de fecha del anuncio.
// Lo usa MonteCristo News: la noticia del fichaje existe en cuanto el plan está
// cerrado, aunque la conferencia de prensa se abra el día 15.
function announcedMoves(league) {
  const plan = planTransfers(league);
  if (!plan) return [];
  return plan.moves.map(move => valuedMove(league, move));
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

module.exports = {
  nextMonth,
  announcedMoves,
  planTransfers,
  applyTransfers,
  retainPreviousSquads,
  publicTransfers,
  resultingFreeAgents
};
