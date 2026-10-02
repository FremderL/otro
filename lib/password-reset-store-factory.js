'use strict';const {MemoryPasswordResetStore}=require('./password-reset-store');const {PgPasswordResetStore}=require('./password-reset-store-pg');
function createPasswordResetStore(config,env=process.env){if(!config?.enabled)return null;if(env.NODE_ENV==='test'&&!env.DATABASE_URL)return new MemoryPasswordResetStore(config.sessionPepper);if(!env.DATABASE_URL)throw new Error('DATABASE_URL obligatorio para restablecimientos');return new PgPasswordResetStore(env.DATABASE_URL,config.sessionPepper);}
module.exports={createPasswordResetStore};
