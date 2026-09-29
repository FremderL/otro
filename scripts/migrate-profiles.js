'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { cleanProfile } = require('../lib/profile-store');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Define DATABASE_URL antes de migrar.');
  const filePath = process.env.PROFILE_STORE_PATH || path.join(process.cwd(), 'data', 'profiles.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${filePath} debe contener un array JSON.`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS montecristo_profiles (
      id TEXT PRIMARY KEY,
      profile JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (const item of raw.map(cleanProfile).filter(profile => profile.id)) {
      await pool.query(`INSERT INTO montecristo_profiles (id, profile, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()`,
      [item.id, JSON.stringify(item)]);
    }
    console.log(`Migrados ${raw.length} perfiles desde ${filePath}.`);
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(`Migración fallida: ${error.message}`); process.exitCode = 1; });
