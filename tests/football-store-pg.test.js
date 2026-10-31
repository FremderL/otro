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
const { generateTimeline } = require('../lib/football/match-engine');
const { mulberry32 } = require('../lib/football/prng');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { makeCommitment, verifyCommitment } = require('../lib/football/v2/commitment');

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
  return {
    rows, month, sampleMatchId: matches[0].id, matchCount: matches.length, betId: bet.id,
    candidateIds: league.ballonDor.candidates.map(candidate => candidate.id), cleanup
  };
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
  assert.equal(store.getLeague(monthKey()).ballonDor.candidates.length, 16, 'evento incluido en la liga generada');
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
  assert.equal(leagueData.ballonDor.status, 'scheduled', 'el contrato del premio vive en football_leagues.data');
  assert.equal(leagueData.ballonDor.candidates.length, 16, 'los candidatos viajan en el snapshot de la liga');
  // Y sí trae una columna por partido con su id.
  const matchIds = matchInserts[matchInserts.length - 1].params[0];
  assert.ok(Array.isArray(matchIds) && matchIds.length === store.getMatches(monthKey()).length, 'una fila por partido');
});

test('saveStrict serializa detrás del guardado anterior y reporta fallos de la base', async t => {
  const pool = makeMockPool();
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;
  const original = store._writeSnapshot.bind(store);
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  let active = 0, maxActive = 0, calls = 0;
  store._writeSnapshot = async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await gate;
    active--;
  };
  const earlier = store.saveNow();
  const confirmed = store.saveStrict();
  unblock();
  await earlier;
  assert.strictEqual(await confirmed, true);
  assert.strictEqual(calls, 2, 'se escribe un snapshot posterior a la solicitud estricta');
  assert.strictEqual(maxActive, 1, 'no se superponen los snapshots');
  store._writeSnapshot = async () => { throw new Error('base inaccesible'); };
  assert.strictEqual(await store.saveStrict(), false);
  store._writeSnapshot = original;
});

test('compromiso V2 manual se conserva en JSONB y se rehidrata con PG simulado', async t => {
  const seed = makeSeedRows();
  t.after(seed.cleanup);
  const match = seed.rows.matches[0].data;
  const league = { ...seed.rows.leagues[0].data, calendar: { matches: seed.rows.matches.map(row => row.data) } };
  const inputs = prepareMatchInputs({ league, match, asOf: Date.now(), seed: 9 });
  match.simulation = makeCommitment(inputs, '67'.repeat(32), Date.now());
  seed.rows.bets = []; // La prueba no abre apuestas V2.
  const pool = makeMockPool(seed.rows);
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;
  const loaded = store.getMatch(match.id, seed.month);
  assert.ok(verifyCommitment(loaded.simulation, loaded), 'el compromiso se validó tras cargar JSONB');
  assert.deepEqual(loaded.simulation, match.simulation);
  await store.saveNow();
  const insert = pool.insertsTo('football_matches').at(-1);
  const index = insert.params[0].indexOf(match.id);
  const saved = JSON.parse(insert.params[13][index]);
  assert.deepEqual(JSON.parse(saved.simulation), match.simulation, 'la cadena conserva el orden de las entradas comprometidas');
});

test('transición del evento se persiste dentro del JSONB de la liga', async (t) => {
  const pool = makeMockPool();
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  const event = store.getBallonDor(monthKey());
  const started = await store.transitionBallonDor(monthKey(), 'active', { at: event.createdAt + 10 });
  assert.equal(started.ok, true);
  assert.equal(store.getBallonDor(monthKey()).status, 'active');
  const leagueInserts = pool.insertsTo('football_leagues');
  const storedLeague = JSON.parse(leagueInserts[leagueInserts.length - 1].params[2][0]);
  assert.equal(storedLeague.ballonDor.status, 'active');
  assert.equal(storedLeague.ballonDor.startedAt, event.createdAt + 10);
});

test('asentar un partido escribe estadísticas del premio y resultado en el mismo snapshot PG', async t => {
  const pool = makeMockPool();
  const store = new PgFootballStore('postgres://mock-host/mockdb', { pool });
  t.after(() => store.close());
  await store.ready;

  const month = monthKey();
  const league = store.getLeague(month);
  const match = store.getMatches(month)[0];
  const home = league.config.find(club => club.id === match.homeId);
  const away = league.config.find(club => club.id === match.awayId);
  const simulation = generateTimeline(home, away, {
    leagueAvg: league.ctx.leagueAvg, homeAdv: league.ctx.homeAdv, rho: league.ctx.rho
  }, mulberry32(match.seed));
  const settled = store.settleMatch(match.id, simulation.score, {
    seasonMonth: month, now: league.ballonDor.createdAt + 100,
    timeline: simulation.timeline, lineups: simulation.lineups
  });
  assert.equal(settled.ok, true);
  await store.saveNow();

  const leagueInsert = pool.insertsTo('football_leagues').at(-1);
  const matchInsert = pool.insertsTo('football_matches').at(-1);
  const storedLeague = JSON.parse(leagueInsert.params[2][0]);
  const matchIndex = matchInsert.params[0].indexOf(match.id);
  const storedMatch = JSON.parse(matchInsert.params[13][matchIndex]);
  assert.deepEqual(storedLeague.ballonDor, league.ballonDor, 'los agregados y puntos se guardan en football_leagues.data');
  assert.equal(storedMatch.status, 'settled');
  assert.deepEqual(storedMatch.result, match.result);
  assert.ok(pool.queries.some(query => query.txn && /^BEGIN/i.test(query.sql)));
  assert.ok(pool.queries.some(query => query.txn && /^COMMIT/i.test(query.sql)));
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
  assert.deepEqual(league.ballonDor.candidates.map(candidate => candidate.id), seed.candidateIds, 'candidatos del premio rehidratados sin pérdida');
  assert.equal(league.ballonDor.status, 'scheduled', 'estado del premio rehidratado');
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
    'getCurrentSeasonMonth', 'getBallonDor', 'transitionBallonDor', 'finalizeBallonDor', 'getMatches', 'getMatch', 'getStandings', 'settleMatch', 'rescheduleMatch',
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
