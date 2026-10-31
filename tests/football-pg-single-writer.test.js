'use strict';

// El PR #45 añadió una ventana de espera a la concesión, pero la implementó
// BLOQUEANDO el arranque dentro de bootstrap() (antes de server.listen()), así
// que en un deploy rolling de Render el proceso nuevo nunca llegaba a pasar el
// health check y el deploy fallaba igual. Estas pruebas conservan la intención
// —"esperar una ventana acotada antes de rendirse"— sobre el modelo sin
// bloqueo: la concesión se reintenta EN SEGUNDO PLANO mientras el proceso ya
// está escuchando y sirviendo en modo lectura.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireFootballWriter,
  acquireFootballWriterWithWait,
  FOOTBALL_WRITER_BUSY,
  FOOTBALL_WRITER_PENDING
} = require('../lib/football/pg-single-writer');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function mockPool({ acquiredOnAttempt = 1 } = {}) {
  let attempts = 0;
  let released = 0;
  const run = sql => {
    if (String(sql).includes('pg_try_advisory_xact_lock')) {
      attempts += 1;
      return { rows: [{ acquired: attempts >= acquiredOnAttempt }] };
    }
    return { rows: [] };
  };
  return {
    get attempts() { return attempts; },
    get released() { return released; },
    async query(sql) { return run(sql); },
    async connect() {
      return {
        query: async sql => run(sql),
        on() {},
        release() { released += 1; }
      };
    }
  };
}

test('la concesión espera la ventana configurada sin bloquear el arranque', async () => {
  const previous = process.env.FOOTBALL_WRITER_WAIT_MS;
  process.env.FOOTBALL_WRITER_WAIT_MS = '2000';
  const pool = mockPool({ acquiredOnAttempt: 2 });
  try {
    // La llamada regresa de inmediato en estado pendiente (Render puede hacer
    // el health check ya), y la concesión llega por detrás.
    const writer = await acquireFootballWriterWithWait(pool, { waitMs: 2000, retryMs: 5 });
    assert.equal(writer.pending, true);
    const pendingError = await writer.assertTransaction(await pool.connect()).catch(error => error);
    assert.equal(pendingError.code, FOOTBALL_WRITER_PENDING);
    assert.equal(pool.released, 1, 'la conexión del intento fallido se devuelve al pool');
    await sleep(150);
    assert.equal(writer.active, true);
    assert.equal(pool.attempts, 2);
    await writer.close();
    assert.equal(pool.released, 2);
  } finally {
    if (previous === undefined) delete process.env.FOOTBALL_WRITER_WAIT_MS;
    else process.env.FOOTBALL_WRITER_WAIT_MS = previous;
  }
});

test('la concesión falla al agotarse la ventana de espera', async () => {
  const previous = process.env.FOOTBALL_WRITER_WAIT_MS;
  process.env.FOOTBALL_WRITER_WAIT_MS = '0';
  const pool = mockPool({ acquiredOnAttempt: Infinity });
  try {
    // Sin ventana, el comportamiento histórico: fallo inmediato, sin reintentos.
    await assert.rejects(acquireFootballWriterWithWait(pool), /otra instancia ya controla el Estadio/);
    await assert.rejects(acquireFootballWriter(pool), error => error.code === FOOTBALL_WRITER_BUSY);
    assert.equal(pool.released, 2, 'cada intento devuelve su conexión');
  } finally {
    if (previous === undefined) delete process.env.FOOTBALL_WRITER_WAIT_MS;
    else process.env.FOOTBALL_WRITER_WAIT_MS = previous;
  }
});

test('al agotarse la ventana con onLost, el proceso sabe que debe rendirse', async () => {
  const pool = mockPool({ acquiredOnAttempt: Infinity });
  let lost = null;
  const writer = await acquireFootballWriterWithWait(pool, { waitMs: 50, retryMs: 5, onLost: error => { lost = error; } });
  const deadline = Date.now() + 3000;
  while (!lost && Date.now() < deadline) await sleep(5);
  assert.ok(lost, 'onLost se dispara al agotarse la ventana');
  assert.match(lost.message, /otra instancia ya controla el Estadio/);
  await writer.close();
});
