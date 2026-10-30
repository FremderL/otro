'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const { Pool }=require('pg');
const { randomUUID }=require('node:crypto');
const { PgFootballStore }=require('../lib/football-store-pg');
const { planTransfers }=require('../lib/football/transfers');
const URL=process.env.FOOTBALL_TEST_DATABASE_URL;

test('traspasos sobreviven a guardar y reabrir PostgreSQL real', {skip:!URL,timeout:30000}, async t=>{
 const schema='transfer_test_'+randomUUID().replace(/-/g,''); const admin=new Pool({connectionString:URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:URL,options:`-c search_path=${schema}`});
 let store,copy; t.after(async()=>{if(copy) await copy.close();if(store) await store.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 store=new PgFootballStore(null,{pool}); await store.ready;
 const first=store.generateSeason('2031-01'); await store.saveNow(); await store.saveNow();
 const plan=planTransfers(first); store.generateSeason('2031-02'); await store.saveNow(); await store.saveNow();
 copy=new PgFootballStore(null,{pool}); await copy.ready;
 const loaded=copy.getLeague('2031-02'); assert.ok(loaded);
 for(const move of plan.moves) assert.ok(loaded.config.find(c=>c.id===move.toId).squad.some(p=>p.id===move.playerId));
 assert.deepEqual(planTransfers(copy.getLeague('2031-01')),plan);
});

test('destacados verificados se guardan y reabren con PostgreSQL real', {skip:!URL,timeout:30000}, async t=>{
 const {generateTimeline}=require('../lib/football/match-engine');const {mulberry32}=require('../lib/football/prng');
 const schema='highlights_test_'+randomUUID().replace(/-/g,'');const admin=new Pool({connectionString:URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:URL,options:`-c search_path=${schema}`});let store,copy;t.after(async()=>{if(copy)await copy.close();if(store)await store.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 store=new PgFootballStore(null,{pool});await store.ready;const league=store.generateSeason('2031-01'),match=league.calendar.matches[0];
 const home=league.config.find(c=>c.id===match.homeId),away=league.config.find(c=>c.id===match.awayId);const played=generateTimeline(home,away,{...league.ctx,forcedScore:{home:1,away:0}},mulberry32(match.seed));
 assert.equal(store.settleMatch(match.id,played.score,{seasonMonth:'2031-01',timeline:played.timeline,lineups:played.lineups}).ok,true);await store.saveNow();await store.saveNow();
 copy=new PgFootballStore(null,{pool});await copy.ready;assert.deepEqual(copy.getMatch(match.id,'2031-01').highlights,match.highlights);assert.equal(match.highlights.goals.length,1);
});
