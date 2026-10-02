'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

async function migrate({ connectionString = process.env.DATABASE_URL, PoolImpl = Pool } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL es obligatorio para ejecutar migraciones');
  const pool = new PoolImpl({
    connectionString,
    ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000
  });
  const client = await pool.connect();
  try {
    // Un solo despliegue migra a la vez. El lock se libera con la conexión.
    await client.query("SELECT pg_advisory_lock(hashtext('montecristo_schema_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS montecristo_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const directory = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(directory).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
    for (const name of files) {
      const sql = fs.readFileSync(path.join(directory, name), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const previous = await client.query('SELECT checksum FROM montecristo_schema_migrations WHERE name = $1', [name]);
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) throw new Error(`La migración aplicada ${name} fue modificada`);
        console.log(`= ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO montecristo_schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
        console.log(`+ ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return files.length;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('montecristo_schema_migrations'))").catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch(error => {
    console.error(`Migración fallida: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
