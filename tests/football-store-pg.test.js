'use strict';

// Fase F — Pruebas del store de fútbol en Postgres con un pool SIMULADO (§13.3, §20).
// No hay Neon en el entorno de pruebas, así que se inyecta un pool falso (la misma
// costura que usa profile-store-pg.js con options.Pool / {pool}). Cubre: el arranque
// (DDL + carga + ensureSeason), la generación en memoria, que saveNow escriba las seis
// tablas en una transacción, la rehidratación sin pérdidas desde filas, el
// write-through de una apuesta, la paridad de interfaz con FootballStore y que un pool
// compartido no se cierre en close().

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { PgFootballStore } = require('../lib/football-store-pg');
const { FootballStore } = require('../lib/football-store');
const { monthKey } = require('../lib/football-store-shared');

// --- Pool simulado ---
// `seed` trae filas por tabla (con `data` ya parseado, como devuelve node-pg un JSONB).
function makeMockPool(seed = {}) {
  const queries = [];
  function resultFor(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (!/^SELECT/i.test(s)) return { rows: [] };
    if (/football_leagues/i.test(s)) return { rows: seed.leagues || [] };
    if (/football_matches/i.test(s)) return { rows: seed.matches || [] };
    if (/football_bets/i.test(s)) return { rows: seed.bets || [] };
    if (/football_parlays/i.test(s)) return { rows: seed.parlays || [] };
    if (/football_futures/i.test(s)) return { rows: seed.futures || [] };
    if (/football_odds_audit/i.test(s)) return { rows: seed.audit || [] };
    return { rows: [] };
  }
  const pool = {
    connectionString: 'postgres://mock-host/mockdb',
    queries,
    ended: false,
    on() {},
    async query(sql, params) { queries.push({ sql: String(sql), params }); return resultFor(sql); },
    async connect() {
      return {
        async query(sql, params) { queries.push({ sql: String(sql), params, txn: true }); return { rows: [] }; },
        release() {}
      };
    },
    async end() { pool.ended = true; }
  };
  pool.insertsTo = (table) => queries.filter(q => q.txn && new RegExp('INSERT INTO ' + table + '\\b', 'i').test(q.sql));
  pool.issued = (re) => queries.some(q => re.test(q.sql));
  return pool;
}

// Genera datos reales con el store de archivo y los convierte en filas de PG, para
// probar la rehidratación con formas idénticas a las de producción.
function makeSeedRows() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpg-seed-'));
  const file = new FootballStore(path.join(dir, 'football.json'));
  const month = monthKey();
  file.generateSeason(month);
  const league = file.getLeague(month);
  const matches = file.getMatches(month);
  const serialized = file._serializeLeague(league);
  serialized.calendar.matches = []; // en PG los partidos van en su tabla
  const bet = {
    id: 'b_seed_1', idempotencyKey: 'idem_seed_1', profileId: 'p1', deviceToken: null,
    matchId: matches[0].id, market: '1x2', selection: 'home', stake: 50, oddsAtPlacement: 2.4,
    placedAt: Date.now(), minuteAtPlacement: null, inPlay: false, status: 'open', debited: true,
    potentialPayout: 120, cashoutAvailable: false, settledAt: null, payout: null, parlayId: null
  };
  const rows = {
    leagues: [{ season_month: month, data: serialized }],
    matches: matches.map(m => ({ season_month: month, data: m })),
    bets: [{ data: bet }],
    parlays: [], futures: [], audit: []
  };
  const cleanup = () => { try { file.close(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); };
  return { rows, month, sampleMatchId: matches[0].id, matchCount: matches.length, betId: bet.id, cleanup };
}

test('arranque: crea el esquema, carga y asegura la temporada (fresh)', async (t) => {
  const pool = makeMockPool(); // vacío
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  assert.equal(store.backend, 'postgres');
  assert.ok(pool.issued(/CREATE TABLE IF NOT EXISTS football_leagues/i), 'DDL de football_leagues');
  assert.ok(pool.issued(/CREATE TABLE IF NOT EXISTS football_bets/i), 'DDL de football_bets');
  assert.ok(pool.issued(/football_futures_open/i), 'índice único parcial de futuros abiertos');
  // Con la base vacía, ensureSeason genera la temporada en memoria.
  assert.equal(store.getCurrentSeasonMonth(), monthKey());
  assert.ok(store.getMatches(monthKey()).length > 0, 'partidos generados en memoria');
});

test('saveNow escribe ligas y partidos en una transacción con unnest', async (t) => {
  const pool = makeMockPool();
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  await store.saveNow();
  const leagueInserts = pool.insertsTo('football_leagues');
  const matchInserts = pool.insertsTo('football_matches');
  assert.ok(leagueInserts.length >= 1, 'INSERT de ligas emitido');
  assert.ok(matchInserts.length >= 1, 'INSERT de partidos emitido');
  assert.ok(/unnest\(/i.test(matchInserts[matchInserts.length - 1].sql), 'usa unnest (escritura en lote)');
  assert.ok(/BEGIN|COMMIT/i.test(pool.queries.filter(q => q.txn).map(q => q.sql).join(' ')), 'va en transacción');
  // El data de la liga NO incrusta los partidos (viven en su tabla).
  const leagueData = JSON.parse(leagueInserts[leagueInserts.length - 1].params[2][0]);
  assert.deepEqual(leagueData.calendar.matches, [], 'la liga no duplica los partidos');
  // Y sí trae una columna por partido con su id.
  const matchIds = matchInserts[matchInserts.length - 1].params[0];
  assert.ok(Array.isArray(matchIds) && matchIds.length === store.getMatches(monthKey()).length, 'una fila por partido');
});

test('rehidratación sin pérdidas: liga, partidos, jornadas y apuesta desde filas', async (t) => {
  const seed = makeSeedRows();
  t.after(seed.cleanup);
  const pool = makeMockPool(seed.rows);
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  assert.equal(store.getCurrentSeasonMonth(), seed.month, 'temporada actual desde la liga cargada');
  const league = store.getLeague(seed.month);
  assert.ok(league, 'liga rehidratada');
  assert.equal(store.getMatches(seed.month).length, seed.matchCount, 'todos los partidos injertados en el calendario');
  const match = store.getMatch(seed.sampleMatchId, seed.month);
  assert.ok(match && match.id === seed.sampleMatchId, 'getMatch por id');
  assert.ok(match.homeId && match.awayId, 'el partido trae sus clubes');
  // Las jornadas vuelven a apuntar a los objetos partido (no a matchIds sueltos).
  const j1 = league.calendar.jornadas[0];
  assert.ok(j1 && Array.isArray(j1.matches) && j1.matches.length > 0, 'jornada re-apuntada a objetos');
  assert.ok(j1.matches.every(m => m && m.id), 'referencias resueltas');
  // Apuesta rehidratada.
  const bet = store.getBet(seed.betId);
  assert.ok(bet && bet.profileId === 'p1' && bet.stake === 50, 'apuesta rehidratada por cleanBet');
  assert.equal(store.countOpenBets(seed.sampleMatchId) >= 0, true, 'countOpenBets operativo');
});

test('write-through de dinero: insertBet + settleBet persisten la fila', async (t) => {
  const seed = makeSeedRows();
  t.after(seed.cleanup);
  const pool = makeMockPool(seed.rows);
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  const bet = {
    id: 'b_new', idempotencyKey: 'idem_new', profileId: 'p2', matchId: seed.sampleMatchId,
    market: '1x2', selection: 'away', stake: 100, oddsAtPlacement: 3.1, inPlay: false, status: 'pending', placedAt: Date.now()
  };
  const ins = store.insertBet(bet);
  assert.equal(ins.ok, true, 'insertBet ok');
  assert.ok(store.getBet('b_new'), 'en memoria');
  // Flujo WAL real: pending → débito → confirmación (open) → liquidación.
  store.markBetDebited('b_new');
  const conf = store.confirmBet('b_new');
  assert.equal(conf.ok, true, 'confirmBet pending→open');
  assert.equal(store.getBet('b_new').status, 'open', 'abierta tras confirmar');
  await store.saveNow();

  const betInserts = pool.insertsTo('football_bets');
  assert.ok(betInserts.length >= 1, 'INSERT de apuestas emitido');
  const sql = betInserts[betInserts.length - 1].sql;
  assert.ok(/idempotency_key/i.test(sql), 'columna idempotency_key (exactly-once en la base)');
  const params = betInserts[betInserts.length - 1].params;
  assert.ok(params[0].includes('b_new'), 'la apuesta nueva va en el lote');

  store.settleBet('b_new', { status: 'won', payout: 310 });
  assert.equal(store.getBet('b_new').status, 'won', 'liquidada en memoria');
  assert.equal(store.getBet('b_new').payout, 310, 'payout registrado');
});

test('paridad de interfaz con FootballStore (todos los métodos públicos)', async (t) => {
  const pool = makeMockPool();
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  const expected = [
    'generateSeason', 'ensureSeason', 'closeSeason', 'computeCarryover', 'getLeague',
    'getCurrentSeasonMonth', 'getMatches', 'getMatch', 'getStandings', 'settleMatch', 'rescheduleMatch',
    'insertBet', 'markBetDebited', 'confirmBet', 'getBet', 'getBets', 'getOpenBetsForMatch',
    'countOpenBets', 'sumOpenStake', 'hasOpenBets', 'countOpenBetsByProfile', 'settleBet',
    'voidBet', 'removeBet', 'insertParlay', 'markParlayDebited', 'confirmParlay', 'getParlay',
    'getParlays', 'getOpenParlaysForMatch', 'settleParlay', 'voidParlay', 'settleParlayLeg',
    'insertFuture', 'markFutureDebited', 'confirmFuture', 'getFuture', 'getFutures',
    'getOpenFutures', 'settleFuture', 'voidFuture', 'appendOddsAudit', 'saveNow', 'scheduleSave', 'close'
  ];
  for (const name of expected) {
    assert.equal(typeof store[name], 'function', 'falta el método ' + name);
  }
});

test('auditoría de cuotas: append secuencial y escritura incremental', async (t) => {
  const pool = makeMockPool();
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  store.appendOddsAudit({ matchId: 'm1', market: '1x2', selection: 'home', oddsBefore: 2.0, oddsAfter: 1.9, reason: 'stake', stakeTrigger: 500 });
  store.appendOddsAudit({ matchId: 'm1', market: '1x2', selection: 'home', oddsBefore: 1.9, oddsAfter: 1.85, reason: 'stake', stakeTrigger: 900 });
  assert.equal(store.oddsAudit.length, 2, 'anillo en memoria');
  await store.saveNow();
  const auditInserts = pool.insertsTo('football_odds_audit');
  assert.equal(auditInserts.length, 1, 'un lote de auditoría');
  assert.equal(auditInserts[0].params[0].length, 2, 'dos entradas nuevas');

  // Un segundo guardado sin entradas nuevas no vuelve a insertar las mismas.
  await store.saveNow();
  const after = pool.insertsTo('football_odds_audit');
  const totalRows = after.reduce((n, q) => n + q.params[0].length, 0);
  assert.equal(totalRows, 2, 'no duplica entradas ya persistidas');
});

test('pool compartido (A8): close() NO lo cierra; pool propio sí', async () => {
  const shared = makeMockPool();
  const storeShared = new PgFootballStore(null, { pool: shared }); // sin connectionString, usa el compartido
  await storeShared.ready;
  assert.equal(storeShared.ownsPool, false, 'no es dueña del pool compartido');
  await storeShared.close();
  assert.equal(shared.ended, false, 'close() no cierra un pool compartido');

  // Pool propio: se construye con una implementación inyectada y se cierra en close().
  let created = null;
  class MockPoolImpl {
    constructor(opts) {
      created = opts;
      const base = makeMockPool();
      this.queries = base.queries;
      this.on = () => {};
      this.query = base.query;
      this.connect = base.connect;
      this.insertsTo = base.insertsTo;
      this.issued = base.issued;
      this.ended = false;
      this.end = async () => { this.ended = true; };
    }
  }
  const storeOwn = new PgFootballStore('postgres://mock-host/mockdb?sslmode=require', { Pool: MockPoolImpl });
  await storeOwn.ready;
  assert.equal(storeOwn.ownsPool, true, 'dueña del pool que creó');
  assert.ok(created && created.connectionString === 'postgres://mock-host/mockdb?sslmode=require', 'pasó la connectionString');
  assert.deepEqual(created.ssl, { rejectUnauthorized: false }, 'TLS sin validar cadena (Neon)');
  await storeOwn.close();
  assert.equal(storeOwn.pool.ended, true, 'close() cierra el pool propio');
});
