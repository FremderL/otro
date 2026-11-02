'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { generateTimeline } = require('../lib/football/match-engine');
const { mulberry32 } = require('../lib/football/prng');
const { cleanMatch, monthKey } = require('../lib/football-store-shared');
const fantasy = require('../lib/football/fantasy');
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mi-once-'));
  const store=new FootballStore(path.join(dir,'football.json')); const season=monthKey(); const league=store.generateSeason(season);
  const profiles=new ProfileStore(path.join(dir,'profiles.json')); const p=profiles.getOrCreate('private-token','Alma');
  t.after(()=>{store.close();clearTimeout(profiles.saveTimer);fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,season,league,profiles,p};
}
function selection(league, offset=0) {
  const all=fantasy.playersOf(league); return [['GK',1],['DF',4],['MF',4],['FW',2]].flatMap(([group,n])=>all.filter(p=>p.group===group).slice(offset,offset+n).map(p=>p.id));
}
function settle(h,m) {
  const home=h.league.config.find(c=>c.id===m.homeId), away=h.league.config.find(c=>c.id===m.awayId);
  const sim=generateTimeline(home,away,{},mulberry32(m.seed));
  const out=h.store.settleMatch(m.id,sim.score,{seasonMonth:h.season,timeline:sim.timeline,lineups:sim.lineups}); assert.equal(out.ok,true); return m;
}

test('solo acepta once futbolistas distintos en formación 1-4-4-2, sin mover fichas', t=>{
  const h=setup(t), ids=selection(h.league), next=fantasy.nextJornada(h.league,1);
  assert.ok(fantasy.lineupValid(h.league,ids)); assert.equal(fantasy.lineupValid(h.league,ids.slice(1)),false);
  assert.equal(fantasy.lineupValid(h.league,ids.map((v,i)=>i===1?ids[0]:v)),false);
  const before=h.p.chips; assert.equal(fantasy.saveLineup(h.p,h.league,ids,next.closesAt-1).ok,true); assert.equal(h.p.chips,before);
  assert.equal(fantasy.saveLineup(h.p,h.league,ids,next.closesAt).jornada,2);
});

test('puntúa solo hechos reales del motor, mantiene el candidato y persiste con JSON', async t=>{
  const h=setup(t), ids=selection(h.league), next=fantasy.nextJornada(h.league,1);
  fantasy.saveLineup(h.p,h.league,ids,next.closesAt-1); await h.profiles.persistProfile(h.p);
  const match=settle(h,next.matches.find(m=>ids.some(id=>h.league.config.filter(c=>c.id===m.homeId || c.id===m.awayId).some(c=>c.squad.some(p=>p.id===id)))));
  const expected=match.fantasyStats.filter(p=>ids.includes(p.id)).reduce((n,p)=>n+(p.played?2:0)+5*p.goals+3*p.assists-p.reds,0);
  assert.equal(fantasy.calculate(h.p,h.league).points,expected);
  assert.ok(match.fantasyStats.length>0); assert.ok(h.league.ballonDor.candidates.length===16);
  h.store.saveNow(); const store=new FootballStore(path.join(h.dir,'football.json')); const profiles=new ProfileStore(path.join(h.dir,'profiles.json'),{deferSeasonCheck:true});
  assert.equal(fantasy.calculate(profiles.getProfile('private-token'),store.getLeague(h.season)).points,expected);
  assert.deepEqual(store.getMatch(match.id,h.season).fantasyStats,match.fantasyStats);
  clearTimeout(profiles.saveTimer);store.close();
});

test('no atribuye estadísticas a resultados viejos ni a liquidaciones manuales sin timeline',t=>{
  const h=setup(t), ids=selection(h.league), next=fantasy.nextJornada(h.league,1);
  fantasy.saveLineup(h.p,h.league,ids,next.closesAt-1);
  const match=next.matches.find(m=>ids.some(id=>h.league.config.filter(c=>c.id===m.homeId || c.id===m.awayId).some(c=>c.squad.some(p=>p.id===id))));
  assert.equal(h.store.settleMatch(match.id,{home:0,away:0},{seasonMonth:h.season}).ok,true);
  assert.equal(match.fantasyStats,null); assert.equal(fantasy.calculate(h.p,h.league).points,0); assert.equal(fantasy.calculate(h.p,h.league).missing,1);
});

test('un cambio después del primer inicio afecta solo la siguiente jornada',t=>{
  const h=setup(t), day1=fantasy.nextJornada(h.league,1), old=selection(h.league), replacement=selection(h.league,2);
  fantasy.saveLineup(h.p,h.league,old,day1.closesAt-100);
  for(const m of day1.matches) m.status='live';
  assert.equal(fantasy.saveLineup(h.p,h.league,replacement,day1.closesAt+1).jornada,2);
  assert.deepEqual(h.p.footballFantasy.lineups[0].players,old); assert.deepEqual(h.p.footballFantasy.lineups[1].players,replacement);
});

test('clasificación voluntaria sin nombres ni IDs, con retos cosméticos y revocación',t=>{
  const h=setup(t), ids=selection(h.league), next=fantasy.nextJornada(h.league,1);
  fantasy.saveLineup(h.p,h.league,ids,next.closesAt-1); h.p.footballFantasy.rankingOptIn=true;
  settle(h,next.matches.find(m=>ids.some(id=>h.league.config.filter(c=>c.id===m.homeId || c.id===m.awayId).some(c=>c.squad.some(p=>p.id===id)))));
  const snap=fantasy.snapshot(h.p,h.league,h.profiles.profiles,next.closesAt+1);
  assert.equal(snap.rank,1); assert.doesNotMatch(JSON.stringify(snap.ranking),/private-token|Alma/);
  assert.equal(snap.challenges.length,3); assert.equal(h.p.chips,1000);
  h.p.footballFantasy.rankingOptIn=false; assert.equal(fantasy.snapshot(h.p,h.league,h.profiles.profiles,next.closesAt+1).ranking.length,0);
});

test('datos de partido corruptos no se convierten en puntos',()=>{
  const m={jornada:1,homeId:'a',awayId:'b'};
  assert.equal(fantasy.cleanFantasyStats([{id:'x',teamId:'a',played:true,goals:1,assists:0,reds:-1}],m),null);
  assert.equal(cleanMatch({...m,id:'x',status:'settled',result:{home:0,away:0},fantasyStats:[{id:'x',teamId:'a',played:true,goals:1,assists:0,reds:-1}]}).fantasyStats,null);
});

test('participar incluso menos de un minuto suma y tarjetas, goles y asistencia usan la timeline real',()=>{
  const match={jornada:1,homeId:'home',awayId:'away'};
  const lineups={home:{teamId:'home',players:[{id:'A',initialStatus:'active'},{id:'B',initialStatus:'active'},{id:'C',initialStatus:'bench'}]},away:{teamId:'away',players:[{id:'D',initialStatus:'active'}]}};
  const timeline=[
    {t:5,half:1,type:'goal',team:'home',playerId:'A',assistId:'B'},
    {t:10,half:1,type:'red_card',team:'home',playerId:'B'},
    {t:89.8,half:2,type:'substitution',team:'home',playerOutId:'A',playerInId:'C'},
    {t:90,half:2,type:'full_time'}
  ];
  const rows=fantasy.matchStats(match,timeline,lineups,{home:1,away:0});
  // El archivo guarda también minutos y amarillas: es lo que permite auditar el
  // acumulado del Balón de Oro contra el partido (ver docs/estadio-estadisticas-del-resumen.md).
  assert.deepEqual(rows.find(p=>p.id==='A'),{id:'A',teamId:'home',played:true,goals:1,assists:0,yellows:0,minutes:89,reds:0});
  assert.deepEqual(rows.find(p=>p.id==='B'),{id:'B',teamId:'home',played:true,goals:0,assists:1,yellows:0,minutes:10,reds:1});
  assert.equal(rows.find(p=>p.id==='C').played,true);
  assert.equal(fantasy.matchStats(match,timeline,lineups,{home:2,away:0}),null);
});

test('la columna JSONB de PG conserva y rehidrata los puntos de partidos', async t=>{
  const { PgFootballStore } = require('../lib/football-store-pg');
  const h=setup(t), next=fantasy.nextJornada(h.league,1), ids=selection(h.league);
  fantasy.saveLineup(h.p,h.league,ids,next.closesAt-1);
  const match=settle(h,next.matches.find(m=>ids.some(id=>h.league.config.filter(c=>c.id===m.homeId || c.id===m.awayId).some(c=>c.squad.some(p=>p.id===id)))));
  const data=h.store._serializeLeague(h.league); data.calendar.matches=[];
  const rows={league:[{season_month:h.season,data}],matches:h.league.calendar.matches.map(m=>({season_month:h.season,data:m}))};
  const queries=[];
  const pool={on(){},async query(sql){if(/FROM football_leagues/.test(sql))return {rows:rows.league};if(/FROM football_matches/.test(sql))return {rows:rows.matches};return {rows:[]};},async connect(){return {async query(sql,params){queries.push({sql,params});return {rows:[]};},release(){}};},async end(){}};
  const pg=new PgFootballStore('postgres://mock/test',{pool}); await pg.ready;
  const actual=pg.getMatch(match.id,h.season); assert.deepEqual(actual.fantasyStats,match.fantasyStats);
  assert.equal(fantasy.calculate(h.p,pg.getLeague(h.season)).points,fantasy.calculate(h.p,h.league).points);
  await pg.saveNow(); const insert=queries.filter(q=>/INSERT INTO football_matches/.test(q.sql)).at(-1);
  const index=insert.params[0].indexOf(match.id); assert.deepEqual(JSON.parse(insert.params[13][index]).fantasyStats,match.fantasyStats);
  await pg.close();
});
