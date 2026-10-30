'use strict';
const { test }=require('node:test'); const assert=require('node:assert/strict');
const { Pool }=require('pg'); const { randomUUID }=require('node:crypto');
const { PgProfileStore }=require('../lib/profile-store-pg');
const fan=require('../lib/football/fan-club');
const { publicFanPin }=require('../lib/football/fan-club-profile');
const URL=process.env.FOOTBALL_TEST_DATABASE_URL;

test('Mi afición: club, victorias, pin equipado y cambio sobreviven a PostgreSQL real', {skip:!URL,timeout:30000}, async t=>{
 const schema='fan_test_'+randomUUID().replace(/-/g,''); const admin=new Pool({connectionString:URL}); await admin.query(`CREATE SCHEMA ${schema}`);
 class ScopedPool extends Pool { constructor(options){super({...options,options:`-c search_path=${schema}`});} }
 let first,second; t.after(async()=>{for(const item of [first,second]) if(item){clearTimeout(item.saveTimer);clearTimeout(item._backgroundRetryTimer);await item.saveNow();await item.pool.end();}await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 first=new PgProfileStore(URL,{Pool:ScopedPool,deferSeasonCheck:true});await first.ready;
 const profile=first.getOrCreate('fan-profile-test','Afición'); fan.select(profile,'united_vanguard',null,false,100);
 const leagues=new Map([['x',{calendar:{matches:[{id:'m1',status:'settled',settledAt:101,homeId:'united_vanguard',awayId:'sporting_almar',result:{home:1,away:0}}]}}]]);
 fan.syncProfiles(new Map([[profile.id,profile]]),leagues,200,()=>{});
 profile.footballFanClub.equippedPin='fan-1'; assert.equal(await first.persistProfile(profile),true);
 second=new PgProfileStore(URL,{Pool:ScopedPool,deferSeasonCheck:true});await second.ready;
 const loaded=second.getProfile(profile.id); assert.equal(loaded.footballFanClub.wins,1);assert.equal(publicFanPin(loaded).abbr,'FAR');
 assert.equal(fan.select(loaded,'sporting_almar','united_vanguard',true,300).ok,true);
 assert.equal(await second.persistProfile(loaded),true);assert.equal(publicFanPin(loaded),null);assert.equal(loaded.footballFanClub.wins,0);
 // No volver a volcar la copia vieja durante el cierre de la prueba.
 first._dirtyProfiles.clear();
});
