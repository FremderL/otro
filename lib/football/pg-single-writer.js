'use strict';

// Los stores actuales conservan una copia completa en memoria. Dos procesos
// independientes no pueden escribir esas copias de forma segura. La concesión
// usa una transacción dedicada (también funciona con poolers transaccionales) y
// un token de fencing que todas las escrituras deben comprobar en su transacción.
const { randomUUID } = require('node:crypto');

async function acquireFootballWriter(pool, { onLost = () => {}, heartbeatMs = 5000 } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS football_writer_fence (
    id SMALLINT PRIMARY KEY,
    token TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const connection = await pool.connect();
  let closing = false, lost = false, timer = null;
  const fail = error => {
    if (closing || lost) return;
    lost = true;
    try { onLost(error instanceof Error ? error : new Error('concesión de fútbol perdida')); } catch (_) { /* el llamador decide cómo detenerse */ }
  };
  if (typeof connection.on === 'function') {
    connection.on('error', fail);
    connection.on('end', () => fail(new Error('conexión de la concesión de fútbol cerrada')));
  }
  try {
    await connection.query('BEGIN');
    const lock = await connection.query(`SELECT pg_try_advisory_xact_lock(
      hashtextextended('montecristo-football-writer:' || current_schema(), 0)
    ) AS acquired`);
    if (!lock.rows?.[0]?.acquired) throw new Error('otra instancia ya controla el Estadio en esta base de datos');
    const token = randomUUID();
    // El UPDATE espera a cualquier escritura que ya haya tomado FOR SHARE con
    // el token anterior. Solo entonces puede entrar el nuevo propietario.
    await pool.query(`INSERT INTO football_writer_fence (id, token) VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token, updated_at = now()`, [token]);
    timer = setInterval(() => { connection.query('SELECT 1').catch(fail); }, Math.max(1000, heartbeatMs));
    timer.unref?.();
    return {
      token,
      get active() { return !lost && !closing; },
      async assertTransaction(client) {
        if (lost || closing) throw new Error('concesión de fútbol perdida');
        const result = await client.query('SELECT token FROM football_writer_fence WHERE id = 1 FOR SHARE');
        if (result.rows?.[0]?.token !== token) throw new Error('concesión de fútbol reemplazada');
      },
      async close() {
        if (closing) return;
        closing = true;
        clearInterval(timer);
        try { await connection.query('ROLLBACK'); } catch (_) { /* conexión perdida */ }
        connection.release();
      }
    };
  } catch (error) {
    closing = true;
    clearInterval(timer);
    try { await connection.query('ROLLBACK'); } catch (_) { /* conexión perdida */ }
    connection.release();
    throw error;
  }
}

// Envuelve las escrituras puntuales que normalmente usan pool.query(). Si no
// hay concesión se conserva el comportamiento original de los stores de prueba.
async function withWriterFence(pool, writer, work) {
  if (!writer) return work(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await writer.assertTransaction(client);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conservar el error original */ }
    throw error;
  } finally { client.release(); }
}

module.exports = { acquireFootballWriter, withWriterFence };
