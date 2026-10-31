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
function planTransfers(league) {
  if (!league?.seasonMonth || !Array.isArray(league.config) || league.config.length !== 16 || !nextMonth(league.seasonMonth)) return null;
  const clubs = league.config;
  const players = clubs.flatMap(club => club.squad || []);
  if (clubs.some(club => !club.id || !Array.isArray(club.squad) || club.squad.length !== 18 || club.squad.filter(p => p.pos === 'CM').length < 1)
      || new Set(clubs.map(c=>c.id)).size !== 16 || players.some(p=>!p.id || !p.name || !p.attrs)
      || new Set(players.map(p=>p.id)).size !== 288) return null;
  const random = mulberry32(hash32(`${league.seasonMonth}:traspasos:v1`));
  const picked = shuffled([...clubs].sort((a,b)=>a.id.localeCompare(b.id)),random).slice(0,4);
  const pairs = [];
  for (let i=0;i<4;i+=2) {
    const a=picked[i], b=picked[i+1];
    const left=shuffled(a.squad.filter(p=>p.pos==='CM').sort((x,y)=>x.id.localeCompare(y.id)),random)[0];
    const right=shuffled(b.squad.filter(p=>p.pos==='CM').sort((x,y)=>x.id.localeCompare(y.id)),random)[0];
    pairs.push({ fromId:a.id, toId:b.id, playerId:left.id, playerName:left.name });
    pairs.push({ fromId:b.id, toId:a.id, playerId:right.id, playerName:right.name });
  }
  return { seasonMonth:league.seasonMonth, effectiveSeason:nextMonth(league.seasonMonth), moves:pairs };
}

function applyTransfers(previous, clubs, targetMonth) {
  const plan=planTransfers(previous);
  if (!plan || plan.effectiveSeason !== targetMonth || !Array.isArray(clubs) || clubs.length !== 16) return false;
  const previousClubs=new Map(previous.config.map(club=>[club.id,club]));
  if (clubs.some(c=>!previousClubs.has(c.id))) return false;
  // Toda la plantilla conserva identidad entre temporadas, no solo los fichados.
  for (const club of clubs) club.squad=previousClubs.get(club.id).squad.map(player=>({ ...player, attrs:{...player.attrs}, season:emptySeasonStats() }));
  const byId=new Map(clubs.map(c=>[c.id,c]));
  for (let i=0;i<plan.moves.length;i+=2) {
    const a=plan.moves[i], b=plan.moves[i+1];
    const home=byId.get(a.fromId), away=byId.get(a.toId);
    const hi=home.squad.findIndex(p=>p.id===a.playerId), ai=away.squad.findIndex(p=>p.id===b.playerId);
    if (hi<0 || ai<0) throw new Error('Plan de traspasos inconsistente');
    const one=home.squad[hi], two=away.squad[ai];
    home.squad[hi]={...two, num:one.num}; away.squad[ai]={...one, num:two.num};
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
module.exports={ nextMonth, planTransfers, applyTransfers, publicTransfers };
