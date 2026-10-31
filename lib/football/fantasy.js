'use strict';

const { cleanFantasy } = require('./fantasy-profile');
const { extractBallonDorMatchStats, isRegularBallonDorMatch } = require('./ballon-dor-stats');
const POS = { GK:'GK', CB:'DF', LB:'DF', RB:'DF', LWB:'DF', RWB:'DF', CDM:'MF', CM:'MF', CAM:'MF', LM:'MF', RM:'MF', LW:'FW', RW:'FW', ST:'FW', CF:'FW' };
const SHAPE = { GK:1, DF:4, MF:4, FW:2 };
const CHALLENGES = [
  { id:'debut', title:'Debut del once', description:'Suma puntos en un partido', icon:'✦', target:1 },
  { id:'ten', title:'Diez en la cancha', description:'Alcanza 10 puntos en la temporada', icon:'★', target:10 },
  { id:'thirty', title:'Once de oro', description:'Alcanza 30 puntos en la temporada', icon:'♛', target:30 }
];
function playersOf(league) {
  return (league?.config || []).flatMap(club => (club.squad || []).map(p => ({ id:p.id, name:p.name, position:p.pos, group:POS[p.pos], number:p.num, clubId:club.id, clubName:club.name })));
}
function lineupValid(league, ids) {
  if (!Array.isArray(ids) || ids.length !== 11 || new Set(ids).size !== 11 || !ids.every(id => typeof id === 'string')) return false;
  const catalog = new Map(playersOf(league).map(p => [p.id,p]));
  const counts = { GK:0, DF:0, MF:0, FW:0 };
  for (const id of ids) { const p = catalog.get(id); if (!p || !p.group) return false; counts[p.group]++; }
  return Object.keys(SHAPE).every(group => counts[group] === SHAPE[group]);
}
function matchStats(match, timeline, lineups, score) {
  if (!isRegularBallonDorMatch(match) || !Array.isArray(timeline)) return null;
  try {
    const stats = extractBallonDorMatchStats(match, timeline, lineups, { includeParticipated:true });
    if (!stats.ok || !stats.included || stats.score.home !== score.home || stats.score.away !== score.away) return null;
    // El archivo guarda TODO lo que el Balón de Oro acumula (incluidos minutos y
    // amarillas) para que su acumulado se pueda auditar y rehacer partido a
    // partido sin depender de una línea de tiempo que ya no existe.
    return [...stats.players.entries()].map(([id, p]) => ({
      id, teamId:p.teamId, played:p.participated, goals:p.goals, assists:p.assists,
      yellows:p.yellowCards, minutes:p.minutes, reds:p.redCards
    }));
  } catch (_) { return null; }
}
function cleanFantasyStats(raw, match) {
  if (!Array.isArray(raw) || raw.length > 36 || !match || !isRegularBallonDorMatch(match)) return null;
  const ids = new Set(), rows = [];
  for (const p of raw) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 80 || ids.has(p.id)
      || ![match.homeId, match.awayId].includes(p.teamId) || typeof p.played !== 'boolean'
      || !['goals','assists','reds'].every(k => Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 100)) return null;
    ids.add(p.id);
    const row = { id:p.id, teamId:p.teamId, played:p.played, goals:p.goals, assists:p.assists, reds:p.reds };
    // Opcionales: los partidos asentados antes de este cambio no los traen y
    // deben seguir cargando igual (la auditoría los marca como no verificables).
    if (Number.isInteger(p.minutes) && p.minutes >= 0 && p.minutes <= 150) row.minutes = p.minutes;
    if (Number.isInteger(p.yellows) && p.yellows >= 0 && p.yellows <= 10) row.yellows = p.yellows;
    rows.push(row);
  }
  return rows;
}
function jornadas(league) {
  const grouped = new Map();
  for (const match of league?.calendar?.matches || []) {
    if (!isRegularBallonDorMatch(match) || !Number.isSafeInteger(match.scheduledKickoffAt)) continue;
    if (!grouped.has(match.jornada)) grouped.set(match.jornada, []);
    grouped.get(match.jornada).push(match);
  }
  return [...grouped].map(([jornada,matches]) => ({ jornada, matches, closesAt:Math.min(...matches.map(m=>m.scheduledKickoffAt)) }))
    .filter(j => j.matches.length === 8).sort((a,b)=>a.jornada-b.jornada);
}
function nextJornada(league, now) {
  return jornadas(league).find(j => now < j.closesAt && j.matches.every(m => m.status === 'scheduled')) || null;
}
function saveLineup(profile, league, ids, now = Date.now()) {
  if (!profile || !league || !Number.isSafeInteger(now) || now < 1 || !lineupValid(league, ids)) return { ok:false, code:'invalid_lineup' };
  const next = nextJornada(league, now);
  if (!next) return { ok:false, code:'no_open_jornada' };
  const current = cleanFantasy(profile.footballFantasy);
  const data = current?.season === league.seasonMonth ? current : { season:league.seasonMonth, lineups:[], rankingOptIn:current?.rankingOptIn === true };
  data.lineups = data.lineups.filter(item => item.jornada !== next.jornada);
  data.lineups.push({ jornada:next.jornada, savedAt:now, players:ids.slice() });
  data.lineups.sort((a,b)=>a.jornada-b.jornada);
  profile.footballFantasy = data;
  return { ok:true, jornada:next.jornada, closesAt:next.closesAt };
}
function calculate(profile, league) {
  const data = cleanFantasy(profile?.footballFantasy);
  if (!league || !data || data.season !== league.seasonMonth) return { points:0, matches:0, missing:0, challenges:[], selected:[], data:null };
  let points = 0, matches = 0, scoringMatches = 0, missing = 0;
  const catalog = new Map(playersOf(league).map(player => [player.id, player]));
  for (const day of jornadas(league)) {
    const version = data.lineups.filter(v => v.jornada <= day.jornada && v.savedAt < day.closesAt).at(-1);
    if (!version || !lineupValid(league, version.players)) continue;
    const selected = new Set(version.players);
    const clubs = new Set(version.players.map(id => catalog.get(id)?.clubId));
    for (const m of day.matches) {
      if (m.status !== 'settled' || (!clubs.has(m.homeId) && !clubs.has(m.awayId))) continue;
      const rows = cleanFantasyStats(m.fantasyStats, m);
      if (!rows) { missing++; continue; }
      let matchPoints = 0;
      for (const p of rows) if (selected.has(p.id)) matchPoints += (p.played ? 2 : 0) + 5*p.goals + 3*p.assists - p.reds;
      points += matchPoints; matches++; if (matchPoints > 0) scoringMatches++;
    }
  }
  const challenges = CHALLENGES.map(c => {
    const value = c.id === 'debut' ? (scoringMatches > 0 ? 1 : 0) : Math.max(0, points);
    return { ...c, progress:Math.min(c.target, value), completed:value >= c.target };
  });
  return { points, matches, missing, challenges, selected:data.lineups.at(-1)?.players || [], data };
}
function ranking(profiles, league) {
  const rows = [];
  for (const profile of profiles?.values?.() || []) {
    const data = cleanFantasy(profile?.footballFantasy);
    if (!data || data.season !== league?.seasonMonth || !data.rankingOptIn || !data.lineups.length) continue;
    const score = calculate(profile, league); rows.push({ profileId:profile.id, points:score.points });
  }
  rows.sort((a,b)=>b.points-a.points || String(a.profileId).localeCompare(String(b.profileId)));
  let rank = 0;
  rows.forEach((row, i) => { if (!i || rows[i-1].points !== row.points) rank = i+1; row.rank = rank; });
  return { rows:rows.slice(0,25).map(r=>({ rank:r.rank, points:r.points })), all:rows };
}
function snapshot(profile, league, profiles, now = Date.now(), rankingCache = null) {
  if (!league) return null;
  const score = calculate(profile, league), next = nextJornada(league, now), table = rankingCache || ranking(profiles, league);
  const me = table.all.find(row=>row.profileId === profile?.id);
  return { season:league.seasonMonth, points:score.points, countedMatches:score.matches, missingMatches:score.missing,
    selected:score.selected, next:next ? { jornada:next.jornada, closesAt:next.closesAt } : null,
    rankingOptIn:score.data?.rankingOptIn === true, rank:me?.rank || null, ranking:table.rows,
    challenges:score.challenges, players:playersOf(league), serverNow:now };
}
module.exports = { cleanFantasy, lineupValid, matchStats, cleanFantasyStats, nextJornada, saveLineup, calculate, ranking, snapshot, playersOf };
