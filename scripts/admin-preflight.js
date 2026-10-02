#!/usr/bin/env node
'use strict';const {Pool}=require('pg');const {inspectDatabase}=require('../lib/deployment-preflight');
if(!process.env.DATABASE_URL){console.error('DATABASE_URL obligatorio');process.exit(2);}const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:/sslmode=disable/i.test(process.env.DATABASE_URL)?false:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:10000});
inspectDatabase(pool).then(result=>{console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}).catch(error=>{console.error(`Preflight falló: ${error.message}`);process.exitCode=1;}).finally(()=>pool.end());
