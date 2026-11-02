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

test('las identidades y atributos de los 288 jugadores sobreviven traspasos y meses ausentes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
  const store = new FootballStore(path.join(dir, 'f.json'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = store.generateSeason('2026-10');
  const initial = new Map(first.config.flatMap(c => c.squad.map(p => [p.id, { name: p.name, attrs: p.attrs, pos: p.pos }])));
  assert.equal(initial.size, 288);
  assert.equal(new Set(first.config.flatMap(c => c.squad.map(p => p.name))).size, 288);
  const moves = planTransfers(first).moves;
  const second = store.generateSeason('2026-11');
  for (const club of second.config) for (const p of club.squad) {
    assert.deepEqual({ name: p.name, attrs: p.attrs, pos: p.pos }, initial.get(p.id));
    const transfer = moves.find(m => m.playerId === p.id);
    if (transfer) assert.equal(club.id, transfer.toId);
  }
  const january = store.generateSeason('2027-01');
  assert.deepEqual(january.config.map(c => c.squad.map(p => ({ id: p.id, name: p.name, attrs: p.attrs, num: p.num }))),
    second.config.map(c => c.squad.map(p => ({ id: p.id, name: p.name, attrs: p.attrs, num: p.num }))), 'un salto no inventa traspasos ni regenera personas');
  for (const club of january.config) for (const p of club.squad) assert.deepEqual(p.season, { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 });
  const { createLineups } = require('../lib/football/match-state');
  const moved = moves[0], destination = second.config.find(c => c.id === moved.toId);
  const opponent = second.config.find(c => c.id !== moved.toId);
  const lineups = createLineups(destination, opponent);
  assert.equal(lineups.home.players.find(p => p.id === moved.playerId).name, moved.playerName);
  assert.ok(!lineups.away.players.some(p => p.id === moved.playerId));
  const { prepareMatchInputs } = require('../lib/football/v2/inputs');
  const fixture = second.calendar.matches.find(m => m.homeId === destination.id || m.awayId === destination.id);
  const input = prepareMatchInputs({ league: second, previousLeague: first, match: fixture, asOf: Date.UTC(2026, 10, 1), seed: 1 });
  const side = fixture.homeId === destination.id ? 'home' : 'away';
  const snap = input[side].lineup.players.find(p => p.id === moved.playerId);
  assert.equal(snap.name, moved.playerName);
  assert.deepEqual(snap.attrs, initial.get(moved.playerId).attrs);
  assert.ok(!input[side === 'home' ? 'away' : 'home'].lineup.players.some(p => p.id === moved.playerId));
});

test('una plantilla anterior inválida no se sustituye silenciosamente con otras personas', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-invalid-'));
  const store = new FootballStore(path.join(dir, 'f.json'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const previous = store.generateSeason('2026-10');
  previous.config[0].squad.pop();
  assert.throws(() => store.generateSeason('2026-11'), /conservar la identidad/);
  assert.equal(store.getLeague('2026-11'), null);
});
