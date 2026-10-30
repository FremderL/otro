'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict');const {Pool}=require('pg');const {randomUUID}=require('node:crypto');
const {migrate}=require('../scripts/migrate-db');const {PgSessionStore}=require('../lib/account-session-store-pg');const {PgReportStore}=require('../lib/report-store-pg');const {PgModerationStore}=require('../lib/moderation-store-pg');
const URL=process.env.FOOTBALL_TEST_DATABASE_URL;
test('migración de moderación y reportes funciona en PostgreSQL real y es repetible', {skip:!URL,timeout:30000},async t=>{
 const schema='moderation_test_'+randomUUID().replace(/-/g,'');const admin=new Pool({connectionString:URL});await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:URL,options:`-c search_path=${schema}`});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 class ScopedPool extends Pool {constructor(options){super({...options,options:`-c search_path=${schema}`});}}
 await pool.query('CREATE TABLE montecristo_profiles (id TEXT PRIMARY KEY,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
 assert.equal(await migrate({connectionString:URL,PoolImpl:ScopedPool}),1);assert.equal(await migrate({connectionString:URL,PoolImpl:ScopedPool}),1);
 const pepper=Buffer.alloc(32,1).toString('base64');const sessions=new PgSessionStore(null,{pool,pepper});const reports=new PgReportStore(null,{pool});const moderation=new PgModerationStore(null,{pool});
 const profile={id:'target',username:'target',chips:1000,moderation:{status:'banned'},security:{sessionVersion:2}};
 await pool.query('INSERT INTO montecristo_profiles(id,data) VALUES($1,$2::jsonb)',[profile.id,JSON.stringify(profile)]);
 const issued=await sessions.issue({profileId:'target',sessionVersion:1});assert.equal((await sessions.findByToken(issued.token)).profileId,'target');
 const report=await reports.create({reporterProfileId:'reporter',reportedProfileId:'target',category:'harassment',description:'Un mensaje de acoso documentado'});await reports.addEvidence(report.id,'chat_message',{text:'Prueba de mensaje'});assert.equal((await reports.evidenceFor(report.id)).length,1);
 await moderation.applyAtomic({profile,action:{targetProfileId:'target',actorProfileId:'admin',reportId:report.id,type:'ban',reason:'Motivo válido de moderación'},audit:{actorRole:'admin',actorProfileId:'admin',action:'moderation.ban',targetType:'profile',targetId:'target',reason:'Motivo válido de moderación'},revokeReason:'account_banned'});
 assert.equal((await moderation.forProfile('target')).length,1);assert.ok((await sessions.findByToken(issued.token)).revokedAt);assert.equal((await pool.query('SELECT count(*)::int n FROM montecristo_audit_log')).rows[0].n,1);
});
