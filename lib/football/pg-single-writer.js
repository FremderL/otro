'use strict';

// Los stores actuales conservan una copia completa en memoria. Dos procesos
// independientes no pueden escribir esas copias de forma segura. La concesión
// usa una transacción dedicada (también funciona con poolers transaccionales) y
// un token de fencing que todas las escrituras deben comprobar en su transacción.
const { randomUUID } = require('node:crypto');

const FOOTBALL_WRITER_BUSY = 'FOOTBALL_WRITER_BUSY';
const FOOTBALL_WRITER_PENDING = 'FOOTBALL_WRITER_PENDING';
const BUSY_MESSAGE = 'otra instancia ya controla el Estadio en esta base de datos';

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
    if (!lock.rows?.[0]?.acquired) {
      const error = new Error(BUSY_MESSAGE);
      error.code = FOOTBALL_WRITER_BUSY;
      throw error;
    }
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

// Modo "en espera" para deploys sin caída: Render inicia la instancia nueva
// ANTES de detener la vieja, así que durante unos segundos hay dos procesos
// vivos sobre la misma base. Con waitMs > 0, si la concesión está ocupada no se
// falla al instante: se devuelve un handle pendiente que (a) rechaza escrituras
// (assertTransaction lanza FOOTBALL_WRITER_PENDING) y (b) reintenta adquirir la
// concesión en segundo plano cada retryMs. Al conseguirla se ejecuta
// onAcquired (p. ej. recargar la copia en memoria) ANTES de habilitar escrituras.
// Si pasan waitMs sin conseguirla se dispara onLost (fail-closed, como antes).
// Con waitMs = 0 (defecto) el comportamiento es exactamente el de
// acquireFootballWriter: falla al instante si el lock está tomado.
async function acquireFootballWriterWithWait(pool, {
  onLost = () => {},
  heartbeatMs = 5000,
  waitMs = 0,
  retryMs = 2000,
  onAcquired = null
} = {}) {
  try {
    return await acquireFootballWriter(pool, { onLost, heartbeatMs });
  } catch (error) {
    if (error?.code !== FOOTBALL_WRITER_BUSY || !(waitMs > 0)) throw error;
  }
  const startedAt = Date.now();
  const delayMs = () => Math.max(50, Number(retryMs) || 2000);
  let inner = null;
  let closed = false;
  let timer = null;
  const handle = {
    token: null,
    pending: true,
    get active() { return Boolean(inner && inner.active); },
    async assertTransaction(client) {
      if (!inner) {
        const error = new Error('la concesión de fútbol todavía no se adquirió en esta instancia');
        error.code = FOOTBALL_WRITER_PENDING;
        throw error;
      }
      return inner.assertTransaction(client);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      await inner?.close();
    }
  };
  const attempt = async () => {
    if (closed || inner) return;
    let lease = null;
    try {
      lease = await acquireFootballWriter(pool, { onLost, heartbeatMs });
      if (onAcquired) await onAcquired(lease);
    } catch (error) {
      if (closed || inner) { await lease?.close().catch(() => {}); return; }
      // Si la adquisición tuvo éxito pero onAcquired falló, se libera el lock
      // y se reintenta dentro de la ventana; si no, se reintenta mientras quede
      // waitMs (también cubre hipos transitorios de la base al arrancar).
      if (lease) await lease.close().catch(() => {});
      if (Date.now() - startedAt < waitMs) {
        timer = setTimeout(attempt, delayMs());
        timer.unref?.();
        return;
      }
      handle.pending = false;
      try { onLost(error instanceof Error ? error : new Error(BUSY_MESSAGE)); } catch (_) { /* el llamador decide cómo detenerse */ }
      return;
    }
    if (closed) { await lease.close(); return; }
    inner = lease;
    handle.pending = false;
    handle.token = lease.token;
  };
  timer = setTimeout(attempt, delayMs());
  timer.unref?.();
  return handle;
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

module.exports = {
  acquireFootballWriter,
  acquireFootballWriterWithWait,
  withWriterFence,
  FOOTBALL_WRITER_BUSY,
  FOOTBALL_WRITER_PENDING
};
