'use strict';
const DAY_MS=86400000;
const DEFAULTS=Object.freeze({sessionsDays:90,reportsDays:365,auditDays:730,batchSize:500});
function positiveInteger(value,name){const number=Number(value);if(!Number.isSafeInteger(number)||number<1)throw new Error(`${name} debe ser entero positivo`);return number;}
function retentionConfig(env=process.env){return{sessionsDays:positiveInteger(env.RETENTION_SESSIONS_DAYS||DEFAULTS.sessionsDays,'RETENTION_SESSIONS_DAYS'),reportsDays:positiveInteger(env.RETENTION_REPORTS_DAYS||DEFAULTS.reportsDays,'RETENTION_REPORTS_DAYS'),auditDays:positiveInteger(env.RETENTION_AUDIT_DAYS||DEFAULTS.auditDays,'RETENTION_AUDIT_DAYS'),batchSize:Math.min(5000,positiveInteger(env.RETENTION_BATCH_SIZE||DEFAULTS.batchSize,'RETENTION_BATCH_SIZE'))};}
function cutoffs(config,now=Date.now()){return{sessions:new Date(now-config.sessionsDays*DAY_MS),reports:new Date(now-config.reportsDays*DAY_MS),audit:new Date(now-config.auditDays*DAY_MS),idempotency:new Date(now)};}
module.exports={DEFAULTS,retentionConfig,cutoffs};
