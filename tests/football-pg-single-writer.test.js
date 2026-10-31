'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { acquireFootballWriter } = require('../lib/football/pg-single-writer');

function mockPool({ acquiredOnAttempt = 1 } = {}) {
  let attempts = 0;
  let released = 0;
  return {
    get attempts() { return attempts; },
    get released() { return released; },
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('pg_try_advisory_xact_lock')) {
            attempts += 1;
            return { rows: [{ acquired: attempts >= acquiredOnAttempt }] };
          }
          return { rows: [] };
        },
        on() {},
        release() { released += 1; }
      };
    }
  };
}

test('la concesión del Estadio reintenta durante la ventana configurada', async () => {
  const previous = process.env.FOOTBALL_WRITER_WAIT_MS;
  process.env.FOOTBALL_WRITER_WAIT_MS = '2000';
  const pool = mockPool({ acquiredOnAttempt: 2 });
  try {
    const writer = await acquireFootballWriter(pool);
    assert.equal(pool.attempts, 2);
    assert.equal(pool.released, 1, 'la conexión del intento fallido se devuelve al pool');
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
    await assert.rejects(acquireFootballWriter(pool), /otra instancia ya controla el Estadio/);
    assert.equal(pool.attempts, 1);
    assert.equal(pool.released, 1);
  } finally {
    if (previous === undefined) delete process.env.FOOTBALL_WRITER_WAIT_MS;
    else process.env.FOOTBALL_WRITER_WAIT_MS = previous;
  }
});
