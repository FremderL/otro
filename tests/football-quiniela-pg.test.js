'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {Pool}=require('pg');const {randomUUID}=require('node:crypto');
const {PgQuinielaStore}=require('../lib/football/quiniela-pg');
const URL=process.env.FOOTBALL_TEST_DATABASE_URL;
function league(season,jornada,at=10000){return {seasonMonth:season,calendar:{matches:Array.from({length:8},(_,i)=>({id:`${season}-${jornada}-${i}`,jornada,homeId:`h${i}`,awayId:`a${i}`,scheduledKickoffAt:at+i,status:'scheduled'}))}};}
function picks(l,pick='home'){return l.calendar.matches.map(m=>({matchId:m.id,pick}));}
function settle(l,home=1,away=0){for(const m of l.calendar.matches){m.status='settled';m.result={home,away};}}
test('Quiniela PostgreSQL: diario atómico, concurrencia, bote entre temporadas y reembolsos', {skip:!URL,timeout:30000}, async t=>{
 const schema='quiniela_test_'+randomUUID().replace(/-/g,'');const admin=new Pool({connectionString:URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:URL,options:`-c search_path=${schema}`});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE test_wallet(id TEXT PRIMARY KEY,chips BIGINT NOT NULL CHECK(chips>=0)); INSERT INTO test_wallet VALUES (\'a\',500),(\'b\',500),(\'c\',10)');
 const wallet={async move(client,{profileId,amount}){const r=await client.query('UPDATE test_wallet SET chips=chips+$2 WHERE id=$1 AND chips+$2>=0 RETURNING chips',[profileId,amount]);if(!r.rowCount)throw new Error('Saldo insuficiente');}};
 let now=1000;const service=new PgQuinielaStore(pool,wallet,{now:()=>now});await service.init();const other=new PgQuinielaStore(pool,wallet,{now:()=>now});
 const one=league('2026-10',30),two=league('2026-11',1),three=league('2026-11',2);
 const simultaneous=await Promise.all([service.enter(one,30,'a',picks(one,'away')),other.enter(one,30,'a',picks(one,'away')),other.enter(one,30,'b',picks(one,'away'))]);
 assert.equal(simultaneous.filter(x=>x.replayed).length,1);assert.deepEqual((await pool.query('SELECT id,chips::int FROM test_wallet ORDER BY id')).rows,[{id:'a',chips:450},{id:'b',chips:450},{id:'c',chips:10}]);
 await assert.rejects(service.enter(one,30,'c',picks(one)),/Saldo insuficiente/);assert.equal(await service.ticket('2026-10',30,'c'),null);
 // Segunda temporada: nunca se liquida antes de la jornada anterior pendiente.
 assert.equal((await service.enter(two,1,'a',picks(two))).ok,true);settle(two);assert.equal((await other.settle(two,1)).status,'waiting_previous');
 settle(one);assert.deepEqual(await service.settle(one,30),{status:'settled',pot:100,winners:0,carry:100,entries:2});
 assert.deepEqual(await other.settle(two,1),{status:'settled',pot:150,winners:1,carry:0,entries:1});
 assert.deepEqual(await service.settle(two,1),{status:'settled',pot:150,winners:1,carry:0,entries:1});
 assert.equal(Number((await pool.query("SELECT chips FROM test_wallet WHERE id='a'")).rows[0].chips),550);
 assert.equal((await service.ticket('2026-11',1,'a')).status,'won');
 // Un bote previo se conserva al cancelar; cada boleto se reembolsa una vez.
 await service.enter(three,2,'a',picks(three));await service.enter(three,2,'b',picks(three));
 await pool.query('UPDATE montecristo_quiniela_bank SET carry=7 WHERE id=1');three.calendar.matches[0].status='postponed';three.calendar.matches[0].scheduledKickoffAt=50000;
 const cancel=await Promise.all([service.settle(three,2),other.settle(three,2)]);assert.deepEqual(cancel[0],{status:'cancelled',pot:null,winners:0,carry:7,entries:2});assert.deepEqual(cancel[0],cancel[1]);
 assert.deepEqual((await pool.query('SELECT id,chips::int FROM test_wallet ORDER BY id')).rows,[{id:'a',chips:550},{id:'b',chips:450},{id:'c',chips:10}]);
 assert.equal(Number((await pool.query('SELECT count(*) FROM montecristo_quiniela_movements')).rows[0].count),8);
 // Un fallo del proceso antes del COMMIT no deja boletos ni débitos.
 const four=league('2026-11',3);const failing=new PgQuinielaStore(pool,{async move(client,move){await wallet.move(client,move);throw new Error('simula caída');}},{now:()=>now});
 await assert.rejects(failing.enter(four,3,'a',picks(four)),/simula caída/);assert.equal(await service.ticket('2026-11',3,'a'),null);
 assert.equal(Number((await pool.query("SELECT chips FROM test_wallet WHERE id='a'")).rows[0].chips),550);
 // Tres ganadores: partes enteras iguales y sobrante en el bote siguiente.
 await pool.query("UPDATE test_wallet SET chips=500 WHERE id='c'");
 const picksFour=picks(four);await Promise.all(['a','b','c'].map(id=>service.enter(four,3,id,picksFour)));
 assert.equal((await service.enter(four,3,'a',picks(four,'away'))).code,'already_entered');
 settle(four);const split=await service.settle(four,3);assert.deepEqual(split,{status:'settled',pot:157,winners:3,carry:1,entries:3});
 assert.deepEqual((await Promise.all(['a','b','c'].map(id=>other.ticket('2026-11',3,id)))).map(ticket=>ticket.payout),[52,52,52]);
 const fifth=league('2026-12',1);now=1000;await service.enter(fifth,1,'b',picks(fifth));
 now=10000;assert.equal((await service.enter(fifth,1,'a',picks(fifth))).code,'closed');
 // Recuperación tras un COMMIT confirmado cuya respuesta de red se perdió.
 now=1000;const sixth=league('2026-12',2);let drop=true;
 const uncertainPool={async connect(){const c=await pool.connect();return {release:()=>c.release(),async query(sql,params){const result=await c.query(sql,params);if(drop && sql==='COMMIT'){drop=false;throw new Error('respuesta de red perdida');}return result;}};}};
 const uncertain=new PgQuinielaStore(uncertainPool,wallet,{now:()=>now});await assert.rejects(uncertain.enter(sixth,2,'a',picks(sixth)),/respuesta de red perdida/);
 const retry=await other.enter(sixth,2,'a',picks(sixth));assert.equal(retry.ok,true);assert.equal(retry.replayed,true);
 assert.equal(Number((await pool.query("SELECT count(*) FROM montecristo_quiniela_movements WHERE season='2026-12' AND jornada=2 AND profile_id='a' AND kind='entry'")).rows[0].count),1);
});
