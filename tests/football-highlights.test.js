'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
const {FootballStore}=require('../lib/football-store'); const {generateTimeline}=require('../lib/football/match-engine');const {mulberry32}=require('../lib/football/prng');const {buildHighlights,cleanHighlights}=require('../lib/football/highlights');
test('destacados nacen de la cronología oficial, coinciden con el marcador y sobreviven al reinicio', t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'highlights-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'football.json'), store=new FootballStore(file);const league=store.generateSeason('2026-10');const match=league.calendar.matches[0];
 const home=league.config.find(c=>c.id===match.homeId),away=league.config.find(c=>c.id===match.awayId);
 const played=generateTimeline(home,away,{...league.ctx,forcedScore:{home:2,away:1}},mulberry32(match.seed));
 const highlights=buildHighlights(match,played.timeline,played.lineups,played.score);assert.ok(highlights);assert.equal(highlights.goals.length,3);assert.ok(highlights.moments.length<=3);assert.ok(highlights.star?.name);
 assert.equal(highlights.goals.filter(g=>g.side==='home').length,2);assert.equal(highlights.goals.filter(g=>g.side==='away').length,1);
 assert.equal(buildHighlights(match,played.timeline,played.lineups,{home:99,away:0}),null);assert.equal(buildHighlights(match,null,played.lineups,played.score),null);
 assert.equal(store.settleMatch(match.id,played.score,{seasonMonth:'2026-10',timeline:played.timeline,lineups:played.lineups}).ok,true);store.close();
 const reloaded=new FootballStore(file), restored=reloaded.getMatch(match.id,'2026-10');assert.deepEqual(restored.highlights,highlights);assert.deepEqual(cleanHighlights(highlights,restored),highlights);reloaded.close();
});
test('sin cronología verificada no se inventan hechos de partidos manuales o históricos', t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'highlights-manual-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new FootballStore(path.join(dir,'f.json'));
 const league=store.generateSeason('2026-10'),match=league.calendar.matches[0];assert.equal(store.settleMatch(match.id,{home:2,away:0},{seasonMonth:'2026-10'}).ok,true);assert.equal(match.highlights,null);store.close();
});
