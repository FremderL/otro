'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const { FootballStore }=require('../lib/football-store');
const { planTransfers, publicTransfers }=require('../lib/football/transfers');
const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');

test('traspasos se anuncian a mitad de mes, conservan identidad y aplican solo a la siguiente temporada', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'traspasos-')); const file=path.join(dir,'football.json');
  const store=new FootballStore(file); t.after(()=>{clearTimeout(store.saveTimer);fs.rmSync(dir,{recursive:true,force:true});});
  const before=store.generateSeason('2026-10'); const old=JSON.stringify(before.config); const fixtures=JSON.stringify(before.calendar.matches);
  const plan=planTransfers(before);
  assert.equal(plan.moves.length,4); assert.equal(new Set(plan.moves.map(m=>m.fromId)).size,4);
  assert.equal(publicTransfers(before,Date.parse('2026-10-15T05:59:59Z')).status,'scheduled');
  assert.equal(publicTransfers(before,Date.parse('2026-10-15T06:00:00Z')).status,'announced');
  assert.equal(JSON.stringify(before.config),old); assert.equal(JSON.stringify(before.calendar.matches),fixtures);
  const after=store.generateSeason('2026-11'); assert.equal(JSON.stringify(before.config),old);
  for(const move of plan.moves){
    const oldPlayer=before.config.find(c=>c.id===move.fromId).squad.find(p=>p.id===move.playerId);
    const club=after.config.find(c=>c.id===move.toId); const player=club.squad.find(p=>p.id===move.playerId);
    assert.equal(player.name,oldPlayer.name); assert.deepEqual(player.attrs,oldPlayer.attrs); assert.equal(player.pos,'CM');
  }
  assert.equal(new Set(after.config.flatMap(c=>c.squad.map(p=>p.id))).size,288);
  for(const club of after.config){assert.equal(club.squad.length,18); assert.equal(new Set(club.squad.map(p=>p.num)).size,18); assert.equal(club.squad.filter(p=>p.pos==='ST').length,2);}
  const reopened=new FootballStore(file); t.after(()=>clearTimeout(reopened.saveTimer));
  assert.deepEqual(planTransfers(reopened.getLeague('2026-10')),plan);
  for(const move of plan.moves) assert.ok(reopened.getLeague('2026-11').config.find(c=>c.id===move.toId).squad.some(p=>p.id===move.playerId));
});

test('si falta la temporada anterior inmediata no se fabrican traspasos',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'traspasos-gap-')); const store=new FootballStore(path.join(dir,'f.json'));
 t.after(()=>{clearTimeout(store.saveTimer);fs.rmSync(dir,{recursive:true,force:true});});
 store.generateSeason('2026-10'); const january=store.generateSeason('2027-01');
 assert.equal(january.config.length,16); assert.equal(planTransfers(january).effectiveSeason,'2027-02');
});
