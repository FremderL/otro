'use strict';
const { test }=require('node:test'); const assert=require('node:assert/strict');
const Q=require('../lib/football/quiniela');
function fixture(){return {calendar:{matches:Array.from({length:8},(_,i)=>({id:'m'+i,jornada:1,scheduledKickoffAt:1000+i*100,status:'scheduled',actualKickoffAt:null,result:null}))}};}
function picks(){return Array.from({length:8},(_,i)=>({matchId:'m'+i,pick:'home'}));}
test('entrada única, ocho selecciones y cierre al primer partido',()=>{
 const league=fixture(); assert.equal(Q.validateEntry(league,1,picks(),false,999).stake,50);
 assert.equal(Q.validateEntry(league,1,picks(),true,999).code,'already_entered');
 assert.equal(Q.validateEntry(league,1,picks(),false,1000).code,'closed');
 assert.equal(Q.validateEntry(league,1,picks().slice(1),false,999).code,'invalid_picks');
 const invalid=picks();invalid[1].matchId=invalid[0].matchId;assert.equal(Q.validateEntry(league,1,invalid,false,999).code,'invalid_picks');
 league.calendar.matches[7].actualKickoffAt=900;assert.equal(Q.validateEntry(league,1,picks(),false,901).code,'closed');
});
test('solo ocho aciertos reparten; el sobrante y bote sin ganadores se acumulan',()=>{
 const l=fixture(), entries=[{profileId:'a',picks:picks()},{profileId:'b',picks:picks()},{profileId:'c',picks:picks().map((p,i)=>i===7?{...p,pick:'draw'}:p)}];
 for(const m of l.calendar.matches){m.status='settled';m.result={home:2,away:1};}
 const out=Q.evaluate(l,1,entries,1);assert.equal(out.pot,151);assert.equal(out.carry,1);assert.deepEqual(out.winners.map(w=>w.amount),[75,75]);
 const no=Q.evaluate(l,1,[entries[2]],2);assert.equal(no.carry,52);assert.deepEqual(no.winners,[]);
});
test('postergación sin resultado reembolsa entradas y conserva el acumulado',()=>{
 const l=fixture();l.calendar.matches[2].status='postponed';
 const out=Q.evaluate(l,1,[{profileId:'a',picks:picks()}],70);assert.deepEqual(out,{status:'cancelled',refunds:[{profileId:'a',amount:50}],carry:70});
});
test('espera el resultado de los ocho y no admite boletos corruptos',()=>{
 const l=fixture();assert.equal(Q.evaluate(l,1,[],0).status,'pending');
 assert.equal(Q.evaluate(l,1,[{profileId:'a',picks:picks()},{profileId:'a',picks:picks()}],0).status,'invalid');
 assert.equal(Q.evaluate(l,1,[null],0).status,'invalid');
});
