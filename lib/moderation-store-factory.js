'use strict';
const {MemoryModerationStore}=require('./moderation-store');const {PgModerationStore}=require('./moderation-store-pg');
function createModerationStore(config,{databaseUrl=process.env.DATABASE_URL,pool}={}){if(!config?.enabled)return null;if(databaseUrl)return new PgModerationStore(databaseUrl,{pool});if(process.env.NODE_ENV==='test')return new MemoryModerationStore();throw new Error('Moderación requiere PostgreSQL');}
module.exports={createModerationStore};
