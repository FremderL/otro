'use strict';

const { hash32, mulberry32 } = require('./prng');
const { emptySeasonStats } = require('./teams');
const { playerValue } = require('./player-value');
const { calendarParts, monthKey, CASINO_TIME_ZONE } = require('../profile-store-shared');

function nextMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2,'0')}`;
}
function shuffled(array, random) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i],copy[j]] = [copy[j],copy[i]];
  }
  return copy;
}
// El plan no altera la liga en curso; es estable tras reinicio y no depende del reloj.
// v2: 8 clubes en dos CICLOS de 4 (A→B→C→D→A), no simples ida y vuelta, y las
// posiciones rotan para que haya traspasos de todas las zonas del campo.
const TRANSFER_VERSION = 'traspasos:v2';
const POSITION_ROTATION = ['CM', 'ST', 'CB', 'CAM'];
function planTransfers(league) {
  if (!league?.seasonMonth || !Array.isArray(league.config) || league.config.length !== 16 || !nextMonth(league.seasonMonth)) return null;
  const clubs = league.config;
  const players = clubs.flatMap(club => club.squad || []);
  if (clubs.some(club => !club.id || !Array.isArray(club.squad) || club.squad.length !== 18 || club.squad.filter(p => p.pos === 'CM').length < 1)
      || new Set(clubs.map(c=>c.id)).size !== 16 || players.some(p=>!p.id || !p.name || !p.attrs)
      || new Set(players.map(p=>p.id)).size !== 288) return null;
  const random = mulberry32(hash32(`${league.seasonMonth}:${TRANSFER_VERSION}`));
  const picked = shuffled([...clubs].sort((a,b)=>a.id.localeCompare(b.id)),random).slice(0,8);
  const moves = [];
  const usedPlayers = new Set();
  for (let group = 0; group < 2; group++) {
    const cycle = picked.slice(group * 4, group * 4 + 4);
    for (let i = 0; i < 4; i++) {
      const from = cycle[i], to = cycle[(i + 1) % 4];
      let pos = POSITION_ROTATION[(group * 4 + i) % POSITION_ROTATION.length];
      // Nunca dejar a un club sin CM: la validación del plan exige al menos uno.
      if (pos === 'CM' && from.squad.filter(p => p.pos === 'CM').length <= 1) pos = 'ST';
      const byPos = from.squad.filter(p => p.pos === pos && !usedPlayers.has(p.id));
      const pool = byPos.length ? byPos : from.squad.filter(p => !usedPlayers.has(p.id));
      if (!pool.length) return null;
      const player = shuffled(pool.sort((a,b)=>a.id.localeCompare(b.id)),random)[0];
      usedPlayers.add(player.id);
      moves.push({ fromId: from.id, toId: to.id, playerId: player.id, playerName: player.name });
    }
  }
  return { seasonMonth:league.seasonMonth, effectiveSeason:nextMonth(league.seasonMonth), moves };
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
  const plan=planTransfers(previous);
  if (!plan || plan.effectiveSeason !== targetMonth || !Array.isArray(clubs) || clubs.length !== 16) return false;
  // Toda la plantilla conserva identidad entre temporadas, no solo los fichados.
  if (!retainPreviousSquads(previous, clubs)) return false;
  const byId=new Map(clubs.map(c=>[c.id,c]));
  // El plan debe ser una permutación por club: mismos entrantes que salientes.
  const outCount=new Map(), inCount=new Map();
  for (const m of plan.moves) {
    outCount.set(m.fromId,(outCount.get(m.fromId)||0)+1);
    inCount.set(m.toId,(inCount.get(m.toId)||0)+1);
  }
  for (const [clubId,n] of outCount) if ((inCount.get(clubId)||0)!==n) throw new Error('Plan de traspasos inconsistente');
  // Lee TODOS los jugadores que se mueven antes de escribir ninguno (cada uno se mueve una sola vez).
  const outgoingSlots=new Map(), incomingPlayers=new Map();
  for (const m of plan.moves) {
    const from=byId.get(m.fromId);
    const idx=from.squad.findIndex(p=>p.id===m.playerId);
    if (idx<0) throw new Error('Plan de traspasos inconsistente');
    if (!outgoingSlots.has(m.fromId)) outgoingSlots.set(m.fromId,[]);
    outgoingSlots.get(m.fromId).push(idx);
    if (!incomingPlayers.has(m.toId)) incomingPlayers.set(m.toId,[]);
    incomingPlayers.get(m.toId).push(from.squad[idx]);
  }
  // El que llega a un club ocupa el dorsal del que sale (mismo orden del plan).
  for (const [clubId,slots] of outgoingSlots) {
    const club=byId.get(clubId);
    const arrivals=incomingPlayers.get(clubId)||[];
    if (arrivals.length!==slots.length) throw new Error('Plan de traspasos inconsistente');
    slots.forEach((slot,i)=>{ club.squad[slot]={ ...arrivals[i], num:club.squad[slot].num }; });
  }
  return true;
}

// La conferencia de prensa del mercado muestra cada acuerdo con el valor del
// jugador: la cifra es de lectura (lib/football/player-value.js) y sale de los
// atributos, así que no cambia porque un club esté mejor o peor en la tabla.
function valuedMove(league, move) {
  const club = league.config.find(c => c.id === move.fromId);
  const player = club && club.squad.find(p => p.id === move.playerId);
  if (!player) return { ...move };
  return { ...move, position: player.pos, playerValue: playerValue(player) };
}
function publicTransfers(league, at = Date.now()) {
  const plan=planTransfers(league);
  if (!plan) return { status:'unavailable', moves:[] };
  const date=new Date(at), month=monthKey(date, CASINO_TIME_ZONE), day=Number(calendarParts(date, CASINO_TIME_ZONE).day);
  if (month < plan.seasonMonth || (month===plan.seasonMonth && day<15)) return { status:'scheduled', seasonMonth:plan.seasonMonth, moves:[] };
  return {
    ...plan,
    moves: plan.moves.map(move => valuedMove(league, move)),
    status:month>=plan.effectiveSeason?'effective':'announced'
  };
}
module.exports={ nextMonth, planTransfers, applyTransfers, retainPreviousSquads, publicTransfers };
