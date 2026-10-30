'use strict';

// Reglas puras: no aceptan saldo ni modifican perfiles. La aplicación debe
// confirmar boletos y movimientos en una transacción antes de mostrarlos.
const ENTRY_COST = 50;
const PICKS = new Set(['home','draw','away']);

function jornadaMatches(league, jornada) {
  const matches = (league?.calendar?.matches || []).filter(m => m.jornada === jornada && !m.desempate);
  if (matches.length !== 8 || new Set(matches.map(m => m.id)).size !== 8 || matches.some(m => !m.id)) return null;
  return [...matches].sort((a,b) => a.scheduledKickoffAt-b.scheduledKickoffAt || a.id.localeCompare(b.id));
}
function validateEntry(league, jornada, selections, existing, now) {
  const matches=jornadaMatches(league,jornada);
  if (!matches || !Number.isSafeInteger(now)) return { ok:false, code:'invalid_round' };
  if (existing) return { ok:false, code:'already_entered' };
  // Un saque real o cualquier estado ya iniciado cierra también si se retrasó el reloj.
  if (matches.some(m => !Number.isSafeInteger(m.scheduledKickoffAt) || m.scheduledKickoffAt<=now || m.actualKickoffAt != null || m.status !== 'scheduled')) return { ok:false, code:'closed' };
  if (!Array.isArray(selections) || selections.length !== 8) return { ok:false, code:'invalid_picks' };
  const map=new Map();
  for (const item of selections) {
    if (!item || typeof item.matchId !== 'string' || !PICKS.has(item.pick) || map.has(item.matchId)) return { ok:false, code:'invalid_picks' };
    map.set(item.matchId,item.pick);
  }
  if (matches.some(m => !map.has(m.id))) return { ok:false, code:'invalid_picks' };
  return { ok:true, stake:ENTRY_COST, picks:matches.map(m=>({matchId:m.id,pick:map.get(m.id)})) };
}
function evaluate(league, jornada, entries, carry) {
  const matches=jornadaMatches(league,jornada);
  if (!matches || !Array.isArray(entries) || !Number.isSafeInteger(carry) || carry<0 || !Number.isSafeInteger(carry + entries.length*ENTRY_COST)) return { status:'invalid' };
  if (entries.some(e=>!e || typeof e.profileId !== 'string' || !e.profileId || !Array.isArray(e.picks) || e.picks.length!==8 || e.picks.some(p=>!p || typeof p.matchId !== 'string' || !PICKS.has(p.pick)) || new Set(e.picks.map(p=>p.matchId)).size!==8 || matches.some(m=>!e.picks.some(p=>p.matchId===m.id))) || new Set(entries.map(e=>e.profileId)).size!==entries.length) return {status:'invalid'};
  if (matches.some(m=>m.status==='postponed' && !m.result)) return { status:'cancelled', refunds:entries.map(e=>({profileId:e.profileId, amount:ENTRY_COST})), carry };
  if (matches.some(m=>m.status!=='settled' || !m.result || !Number.isSafeInteger(m.result.home) || !Number.isSafeInteger(m.result.away) || m.result.home<0 || m.result.away<0)) return {status:'pending'};
  const winners=entries.filter(entry=>matches.every(m=>{
    const outcome=m.result.home>m.result.away?'home':m.result.home<m.result.away?'away':'draw';
    return entry.picks.find(p=>p.matchId===m.id).pick===outcome;
  }));
  const pot=carry+entries.length*ENTRY_COST;
  const amount=winners.length?Math.floor(pot/winners.length):0;
  return {status:'settled',pot,winners:winners.map(e=>({profileId:e.profileId,amount})),carry:pot-amount*winners.length};
}
module.exports={ENTRY_COST,jornadaMatches,validateEntry,evaluate};
