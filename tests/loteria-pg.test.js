'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { PgLoteriaStore } = require('../lib/loteria/pg-store');
const URL = process.env.LOTERIA_TEST_DATABASE_URL;

test('PostgreSQL: inscripción atómica, cancelación, recuperación y liquidación idempotente', {skip:!URL, timeout:30000}, async t => {
  const schema = `loteria_test_${randomUUID().replace(/-/g,'')}`;
  const admin = new Pool({ connectionString:URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString:URL, options:`-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query('CREATE TABLE montecristo_profiles(id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
  for (const id of ['alice','bob','poor']) {
    await pool.query('INSERT INTO montecristo_profiles(id,data) VALUES($1,$2::jsonb)', [id,JSON.stringify({id,chips:id==='poor'?10:1000,updatedAt:1})]);
  }
  let now=1000;
  const options={now:()=>now,random:n=>n-1};
  const store = new PgLoteriaStore(pool,options); await store.init();
  const opened=await store.open();
  const responses=await Promise.all([store.join('alice','alice-key-01'),store.join('alice','alice-key-01')]);
  assert.deepEqual(responses[0].board,responses[1].board);
  assert.equal((await pool.query("SELECT data->>'chips' AS chips FROM montecristo_profiles WHERE id='alice'")).rows[0].chips,'950');
  await assert.rejects(store.join('poor','poor-key-001'),/Saldo insuficiente/);
  assert.equal((await store.view('poor')).board,null);
  assert.equal((await pool.query('SELECT count(*) FROM montecristo_loteria_movements')).rows[0].count,'1');
  assert.equal(await store.disconnect('alice'),true);
  assert.equal(await store.disconnect('alice'),false);
  await assert.rejects(store.join('alice','alice-key-01'),/cancelada/);
  assert.equal((await pool.query("SELECT data->>'chips' AS chips FROM montecristo_profiles WHERE id='alice'")).rows[0].chips,'1000');
  await store.join('alice','alice-key-02'); await store.join('bob','bob-key-0001');
  // Un nuevo objeto representa reinicio del servicio: vuelve a leer estado SQL.
  const restarted = new PgLoteriaStore(pool,options);
  assert.equal((await restarted.view('alice')).id,opened.id);
  now=opened.closesAt+54*2000;
  // Una falla durante el pago del segundo ganador revierte también el primero.
  await pool.query("DELETE FROM montecristo_profiles WHERE id='bob'");
  await assert.rejects(restarted.advance(), /Perfil inexistente/);
  assert.equal((await restarted.view('alice')).status,'registration');
  assert.equal((await pool.query("SELECT data->>'chips' AS chips FROM montecristo_profiles WHERE id='alice'")).rows[0].chips,'950');
  assert.equal((await pool.query("SELECT count(*) FROM montecristo_loteria_movements WHERE kind='prize'")).rows[0].count,'0');
  await pool.query('INSERT INTO montecristo_profiles(id,data) VALUES($1,$2::jsonb)', ['bob',JSON.stringify({id:'bob',chips:950,updatedAt:1})]);
  await Promise.all([restarted.advance(),store.advance(),restarted.advance()]);
  assert.equal((await restarted.view('alice')).status,'settled');
  const rows=await pool.query("SELECT id,data->>'chips' AS chips FROM montecristo_profiles WHERE id IN ('alice','bob') ORDER BY id");
  assert.deepEqual(rows.rows.map(row=>row.chips),['1000','1000']);
  assert.equal((await pool.query("SELECT count(*) FROM montecristo_loteria_movements WHERE kind='prize'")).rows[0].count,'2');
  const next=await store.open();
  await store.join('alice','alice-key-03');
  now=next.closesAt;
  await Promise.all([store.advance(),restarted.advance()]);
  assert.equal((await store.view('alice')).status,'cancelled');
  assert.equal((await pool.query("SELECT data->>'chips' AS chips FROM montecristo_profiles WHERE id='alice'")).rows[0].chips,'1000');
});
