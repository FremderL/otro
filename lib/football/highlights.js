'use strict';

// Resumen exclusivo de la cronología oficial que llegó al asentar el resultado.
// No se regenera para partidos antiguos: el contexto y los planteles pueden cambiar.
const { extractBallonDorMatchStats } = require('./ballon-dor-stats');
const TYPES = new Set(['goal','penalty_scored','shot_on_target','big_chance','red_card','second_yellow']);
const name = value => typeof value === 'string' ? value.trim().slice(0,100) : '';

function buildHighlights(match, timeline, lineups, score) {
  if (!match || match.desempate || !Array.isArray(timeline) || !lineups || !score) return null;
  const source=extractBallonDorMatchStats(match,timeline,lineups,{includeParticipated:true});
  if (!source.ok || !source.included || source.score.home!==score.home || source.score.away!==score.away) return null;
  const players=new Map(['home','away'].flatMap(side=>(lineups[side]?.players || []).map(p=>[p.id,{name:name(p.name),side}])));
  const active=new Set(['home','away'].flatMap(side=>lineups[side].players.filter(p=>p.initialStatus==='active').map(p=>p.id)));
  const validAssists=new Set();
  for (const event of [...timeline].sort((a,b)=>a.t-b.t || (a.i||0)-(b.i||0))) {
    if (Number(event.half)>2) continue;
    if (event.type==='substitution') { active.delete(event.playerOutId);active.add(event.playerInId || event.playerId); }
    else if (event.type==='goal' && event.assistId && event.assistId!==event.playerId && active.has(event.assistId) && players.get(event.assistId)?.side===event.team) validAssists.add(event);
    else if (event.type==='red_card' || event.type==='second_yellow') active.delete(event.playerId);
  }
  const relevant=timeline.filter(e=>e && TYPES.has(e.type) && ['home','away'].includes(e.team) && Number.isFinite(e.t) && Number(e.half)<=2);
  function item(e) {
    const player=players.get(e.playerId), assister=players.get(e.assistId);
    return {type:e.type,minute:Math.max(0,Math.ceil(e.t)),side:e.team,player:player?.name || '',
      assist:e.type==='goal' && validAssists.has(e) && assister ? assister.name : ''};
  }
  const goals=relevant.filter(e=>e.type==='goal'||e.type==='penalty_scored').map(item);
  const scored=goals.reduce((acc,g)=>{acc[g.side]++;return acc;},{home:0,away:0});
  if (scored.home!==score.home || scored.away!==score.away || goals.some(g=>!g.player)) return null;
  // Tres hechos priorizando goles y expulsiones; después se ordenan por minuto.
  const rank=e=>e.type==='goal'||e.type==='penalty_scored'?0:e.type==='red_card'||e.type==='second_yellow'?1:2;
  const moments=relevant.map((event,index)=>({event,index})).sort((a,b)=>rank(a.event)-rank(b.event)||a.index-b.index).slice(0,3).sort((a,b)=>a.index-b.index).map(x=>item(x.event));
  const standout=[...source.players.entries()].map(([id,stats])=>({id,stats,player:players.get(id)}))
    .filter(x=>x.player?.name && x.stats.participated)
    .sort((a,b)=>(b.stats.goals*5+b.stats.assists*3)-(a.stats.goals*5+a.stats.assists*3) || b.stats.minutes-a.stats.minutes || a.id.localeCompare(b.id))[0];
  const star=standout ? {name:standout.player.name,side:standout.player.side,goals:standout.stats.goals,assists:standout.stats.assists,minutes:standout.stats.minutes} : null;
  return {goals,moments,star};
}

function cleanHighlights(raw, match) {
  if (!raw || !match?.result || !Array.isArray(raw.goals) || !Array.isArray(raw.moments) || raw.goals.length>200 || raw.moments.length>3) return null;
  function cleanItem(item) {
    if (!item || !TYPES.has(item.type) || !['home','away'].includes(item.side) || !Number.isSafeInteger(item.minute) || item.minute<0 || item.minute>150) return null;
    return {type:item.type,minute:item.minute,side:item.side,player:name(item.player),assist:name(item.assist)};
  }
  const goals=raw.goals.map(cleanItem), moments=raw.moments.map(cleanItem);
  if (goals.some(g=>!g || !g.player || !['goal','penalty_scored'].includes(g.type)) || moments.some(m=>!m)) return null;
  if (goals.filter(g=>g.side==='home').length!==match.result.home || goals.filter(g=>g.side==='away').length!==match.result.away) return null;
  let star=null;
  if (raw.star) {
    if (!name(raw.star.name) || !['home','away'].includes(raw.star.side) || !['goals','assists','minutes'].every(k=>Number.isSafeInteger(raw.star[k]) && raw.star[k]>=0 && raw.star[k]<=150)) return null;
    star={name:name(raw.star.name),side:raw.star.side,goals:raw.star.goals,assists:raw.star.assists,minutes:raw.star.minutes};
  }
  return {goals,moments,star};
}
module.exports={buildHighlights,cleanHighlights};
