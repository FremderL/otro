'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {retentionConfig,cutoffs}=require('../lib/retention');
test('retención usa plazos seguros recomendados',()=>{assert.deepEqual(retentionConfig({}),{sessionsDays:90,reportsDays:365,auditDays:730,batchSize:500});});
test('cutoffs se calculan desde reloj controlado',()=>{const now=Date.UTC(2026,9,1);const result=cutoffs(retentionConfig({}),now);assert.equal(result.sessions.toISOString(),'2026-07-03T00:00:00.000Z');assert.equal(result.reports.toISOString(),'2025-10-01T00:00:00.000Z');assert.equal(result.audit.toISOString(),'2024-10-01T00:00:00.000Z');});
test('configuración rechaza periodos inválidos y limita lotes',()=>{assert.throws(()=>retentionConfig({RETENTION_REPORTS_DAYS:'0'}),/entero positivo/);assert.equal(retentionConfig({RETENTION_BATCH_SIZE:'9000'}).batchSize,5000);});
