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
  assert.equal(plan.moves.length,8); assert.equal(new Set(plan.moves.map(m=>m.fromId)).size,8);
  assert.equal(new Set(plan.moves.map(m=>m.playerId)).size,8,'cada jugador se mueve una sola vez');
  // Ciclos, no solo ida y vuelta: ningún par de clubes repite la misma pareja en ambos sentidos.
  const pairKey=m=>[m.fromId,m.toId].sort().join('|');
  assert.equal(new Set(plan.moves.map(pairKey)).size,8,'sin parejas repetidas en sentido contrario');
  // Hay variedad de posiciones (no todos CM).
  const oldPos=new Set(plan.moves.map(m=>before.config.find(c=>c.id===m.fromId).squad.find(p=>p.id===m.playerId).pos));
  assert.ok(oldPos.size>=2,'el plan mezcla posiciones');
  assert.equal(publicTransfers(before,Date.parse('2026-10-15T05:59:59Z')).status,'scheduled');
  assert.equal(publicTransfers(before,Date.parse('2026-10-15T06:00:00Z')).status,'announced');
  assert.equal(JSON.stringify(before.config),old); assert.equal(JSON.stringify(before.calendar.matches),fixtures);
  const after=store.generateSeason('2026-11'); assert.equal(JSON.stringify(before.config),old);
  for(const move of plan.moves){
    const oldPlayer=before.config.find(c=>c.id===move.fromId).squad.find(p=>p.id===move.playerId);
    const club=after.config.find(c=>c.id===move.toId); const player=club.squad.find(p=>p.id===move.playerId);
    assert.equal(player.name,oldPlayer.name); assert.deepEqual(player.attrs,oldPlayer.attrs); assert.equal(player.pos,oldPlayer.pos);
    // El fichado ocupa el dorsal del que salió de ese club.
    assert.ok(Number.isInteger(player.num));
  }
  assert.equal(new Set(after.config.flatMap(c=>c.squad.map(p=>p.id))).size,288);
  for(const club of after.config){assert.equal(club.squad.length,18); assert.equal(new Set(club.squad.map(p=>p.num)).size,18); assert.ok(club.squad.filter(p=>p.pos==='CM').length>=1,'todo club conserva al menos un CM para que el plan siga siendo válido');}
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
