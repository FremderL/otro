'use strict';

// Fase F — Store de fútbol respaldado en Postgres/Neon (§13.3, §12.7 hallazgos 4 y 7).
//
// Misma interfaz pública que FootballStore (archivo): generateSeason, ensureSeason,
// closeSeason, getLeague/getMatches/getMatch/getStandings, settleMatch y todo el
// ciclo de apuestas/combinadas/futuros/auditoría. server.js y el motor no saben qué
// backend está activo (lib/football-store-factory.js elige por DATABASE_URL).
//
// ESTRATEGIA (espejo de lib/profile-store-pg.js, el único store PG que hoy funciona
// de punta a punta en producción):
//   · Todo el estado vive en memoria (this.leagues/bets/parlays/futures/oddsAudit,
//     los Maps que inicializa FootballStore). Las lecturas son síncronas contra esa
//     caché, igual que en archivo — el motor y las apuestas llaman getMatch/getBets
//     de forma síncrona y no pueden esperar una promesa.
//   · La persistencia es `saveNow()`: una foto a las seis tablas en UNA transacción,
//     con `unnest` (un query por tabla). `saveNow()` es asíncrono; los métodos de
//     dinero heredados lo llaman sin esperar (write-through no bloqueante) y el
//     guardado tiene guarda de solapamiento + reintentos (Neon escala a cero y
//     "despierta" lento, §11.3) + reintento en segundo plano si falla.
//   · `PgFootballStore extends FootballStore`: la lógica de temporada/asentado/
//     apuestas se HEREDA sin tocar (muta los Maps en memoria y llama this.saveNow /
//     this.scheduleSave, que aquí persisten en Postgres). Solo se sobrescribe la E/S:
//     load (no-op, PG carga en _init), saveNow, close, y el append de auditoría.
//
// ESQUEMA (§13.3, hallazgo 4: se crea INLINE con CREATE TABLE IF NOT EXISTS al
// construir el store, como profile-store-pg.js — la vía de migraciones está rota,
// migrations/ no existe). Se columnizan las claves de integridad y consulta que el
// diseño exige (PK, idempotency_key UNIQUE para el exactly-once en la base, stake
// CHECK>0, el índice único parcial de futuros abiertos, los índices por
// perfil/partido/estado y season_month/status) y el objeto COMPLETO viaja en una
// columna `data JSONB` para una rehidratación sin pérdidas — el patrón id+data de
// montecristo_profiles. Los campos puramente consultables (cuota, mercado, goles,
// minuto…) quedan dentro de data; si mañana hace falta filtrar por ellos en SQL, se
// promueven a columna con una migración (R24: IF NOT EXISTS crea pero no altera).
//
// ATOMICIDAD ENTRE STORES (A8, §12.7 hallazgo 7): colocar una apuesta toca dos
// stores (la fila en football_bets y el débito en profile.chips). En archivo la
// garantía la da el orden WAL (pending → débito+touch → confirmBet) + la
// reconciliación de arranque, que es exactamente lo que hace betting.js y funciona
// igual sobre este backend. Para el despliegue multi-instancia el diseño prevé una
// única transacción con SELECT…FOR UPDATE sobre un pool compartido: por eso este
// store acepta {pool} + ownsPool (como password-reset-store-pg.js) en vez de exigir
// crear el suyo. Con una sola instancia (Render free) el WAL + reconciliación basta.

const { Pool: RealPool } = require('pg');
const { FootballStore, ODDS_AUDIT_LIMIT } = require('./football-store');
const { monthKey, cleanLeague, cleanMatch, cleanBet, cleanParlay, cleanFuture } = require('./football-store-shared');

// --- Esquema inline (§13.3, hallazgo 4) ---
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS football_leagues (
    season_month TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'active',
    data         JSONB NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS football_matches (
    id           TEXT PRIMARY KEY,
    season_month TEXT NOT NULL REFERENCES football_leagues(season_month) ON DELETE CASCADE,
    jornada      INT  NOT NULL DEFAULT 1,
    day          INT  NOT NULL DEFAULT 1,
    block        TEXT NOT NULL DEFAULT 'estelar',
    featured     BOOLEAN NOT NULL DEFAULT false,
    home_id      TEXT NOT NULL DEFAULT '',
    away_id      TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    score_home   INT,
    score_away   INT,
    settled_at   TIMESTAMPTZ,
    data         JSONB NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS football_matches_season_status ON football_matches (season_month, status);
  CREATE INDEX IF NOT EXISTS football_matches_status_sched  ON football_matches (status, scheduled_at);

  CREATE TABLE IF NOT EXISTS football_bets (
    id                TEXT PRIMARY KEY,
    idempotency_key   TEXT NOT NULL UNIQUE,
    profile_id        TEXT NOT NULL,
    match_id          TEXT NOT NULL REFERENCES football_matches(id) ON DELETE CASCADE,
    parlay_id         TEXT,
    market            TEXT NOT NULL DEFAULT '',
    selection         TEXT NOT NULL DEFAULT '',
    stake             INT  NOT NULL CHECK (stake > 0),
    odds_at_placement NUMERIC(6,2) NOT NULL DEFAULT 1,
    in_play           BOOLEAN NOT NULL DEFAULT false,
    minute_at_placement INT,
    status            TEXT NOT NULL DEFAULT 'open',
    payout            INT,
    placed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at        TIMESTAMPTZ,
    data              JSONB NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS football_bets_profile_status ON football_bets (profile_id, status);
  CREATE INDEX IF NOT EXISTS football_bets_match_status   ON football_bets (match_id, status);

  CREATE TABLE IF NOT EXISTS football_parlays (
    id            TEXT PRIMARY KEY,
    profile_id    TEXT NOT NULL,
    season_month  TEXT NOT NULL,
    combined_odds NUMERIC(8,2) NOT NULL DEFAULT 1,
    stake         INT NOT NULL CHECK (stake > 0),
    status        TEXT NOT NULL DEFAULT 'open',
    payout        INT,
    legs          JSONB NOT NULL DEFAULT '[]'::jsonb,
    placed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at    TIMESTAMPTZ,
    data          JSONB NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS football_parlays_profile_status ON football_parlays (profile_id, status);

  CREATE TABLE IF NOT EXISTS football_futures (
    id                TEXT PRIMARY KEY,
    profile_id        TEXT NOT NULL,
    season_month      TEXT NOT NULL,
    market            TEXT NOT NULL,
    selection         TEXT NOT NULL,
    odds              NUMERIC(6,2) NOT NULL DEFAULT 1,
    stake             INT NOT NULL CHECK (stake > 0),
    status            TEXT NOT NULL DEFAULT 'open',
    payout            INT,
    placed_at_jornada INT NOT NULL DEFAULT 0,
    placed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at        TIMESTAMPTZ,
    data              JSONB NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS football_futures_open ON football_futures (profile_id, market, selection)
    WHERE status = 'open';

  CREATE TABLE IF NOT EXISTS football_odds_audit (
    id            BIGSERIAL PRIMARY KEY,
    seq           BIGINT NOT NULL,
    match_id      TEXT NOT NULL DEFAULT '',
    market        TEXT NOT NULL DEFAULT '',
    selection     TEXT NOT NULL DEFAULT '',
    odds_before   NUMERIC(6,2),
    odds_after    NUMERIC(6,2),
    reason        TEXT NOT NULL DEFAULT '',
    stake_trigger INT,
    data          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS football_odds_audit_match ON football_odds_audit (match_id, created_at);
`;

// --- Utilidades de conexión (espejo de profile-store-pg.js) ---

function resolveSsl(connectionString) {
  // Neon exige TLS; `sslmode=disable` explícito lo desactiva (Postgres local de prueba).
  if (/sslmode=disable/i.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

function describeConnection(connectionString) {
  try {
    const url = new URL(connectionString);
    const db = url.pathname.replace(/^\//, '') || 'postgres';
    return `postgres://${url.hostname}/${db}`;
  } catch (_) {
    return 'postgres://(pool compartido)';
  }
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withRetries(fn, { attempts = 3, delaysMs = [1000, 2500], label = 'operación' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delay = delaysMs[attempt - 1] ?? delaysMs[delaysMs.length - 1];
      console.warn(`Postgres (fútbol): ${label} falló (intento ${attempt}/${attempts}), reintentando en ${delay}ms:`, error.message);
      await wait(delay);
    }
  }
  throw lastError;
}

// Convierte ms desde epoch a un ISO-8601 apto para ::timestamptz, o null.
function iso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}
function numOrNull(v) { return v == null || !Number.isFinite(Number(v)) ? null : Number(v); }

class PgFootballStore extends FootballStore {
  // `options`:
  //   · Pool       — implementación del pool (costura de prueba; por defecto el de `pg`).
  //   · pool       — pool YA creado y compartido (A8/§16 fila 11b). Si se aporta, no se crea uno.
  //   · ownsPool   — si este store creó el pool y debe cerrarlo en close() (por defecto true cuando lo crea).
  //   · el resto   — opciones del pool de node-postgres (max, connectionTimeoutMillis…).
  constructor(connectionString, options = {}) {
    // super() inicializa los Maps en memoria y llama this.load() (aquí no-op: PG carga en _init).
    super(options.filePath);
    const { Pool: PoolImpl = RealPool, pool: sharedPool, ownsPool, ...poolOptions } = options;

    if (sharedPool) {
      this.pool = sharedPool;
      this.ownsPool = ownsPool === true; // un pool compartido NO se cierra aquí por defecto
      this.connectionString = sharedPool.connectionString || null;
    } else {
      if (!connectionString) throw new Error('PgFootballStore requiere una cadena de conexión (DATABASE_URL) o un {pool} compartido');
      this.connectionString = connectionString;
      this.pool = new PoolImpl({
        connectionString, ssl: resolveSsl(connectionString), max: 5, connectionTimeoutMillis: 10000, ...poolOptions
      });
      this.pool.on('error', error => console.warn('Postgres (fútbol, pool) error inesperado:', error.message));
      this.ownsPool = ownsPool !== false; // por defecto cerramos el pool que creamos
    }

    this.backend = 'postgres';
    // Mismo nombre de campo que el store de archivo para que los logs de arranque
    // de server.js no necesiten distinguir el backend.
    this.filePath = describeConnection(this.connectionString || '');
    this._saving = false;
    this._savePending = false;
    this._savingPromise = null;
    this._loading = true;          // durante _init se suprimen los guardados sueltos
    this._backgroundRetryTimer = null;
    this._auditSeq = 0;          // seq monotónico cliente para la auditoría (append-only)
    this._auditPersistedSeq = 0; // último seq ya escrito en football_odds_audit
    // Promesa de arranque: la fábrica la espera antes de que el servidor acepte
    // tráfico, así getMatch/getBets nunca se llaman con la caché vacía.
    this.ready = this._init();
  }

  async _init() {
    // §11.3: si Neon tarda en responder al arrancar (despertando de escalar a cero),
    // reintentamos en vez de arrancar con la liga vacía. Si aun así falla, el error
    // sube a la fábrica → bootstrap(): es preferible que el proceso falle y Render lo
    // reintente a servir con la temporada en blanco y sobrescribir datos reales después.
    await withRetries(() => this.pool.query(SCHEMA_SQL), { label: 'crear tablas de fútbol' });
    await withRetries(() => this._loadOnce(), { label: 'cargar liga de fútbol' });
    // La temporada de fútbol SIEMPRE se asegura al arrancar (es independiente del
    // reset mensual del casino; el gate A12 vive en el store de perfiles, no aquí).
    // Con _loading activo, el saveNow que generateSeason dispara de forma suelta queda
    // suprimido; al final se hace UN volcado determinista y aguardado de todo el estado.
    this.ensureSeason(new Date());
    this._loading = false;
    await this.saveNow();
  }

  // Sobrescribe la carga de archivo: en PG la carga real es asíncrona (_loadOnce).
  load() { /* no-op: el estado se carga en _init() vía _loadOnce() */ }

  async _loadOnce() {
    const [leagueRes, matchRes, betRes, parlayRes, futureRes, auditRes] = await Promise.all([
      this.pool.query('SELECT season_month, data FROM football_leagues'),
      this.pool.query('SELECT season_month, data FROM football_matches'),
      this.pool.query('SELECT data FROM football_bets'),
      this.pool.query('SELECT data FROM football_parlays'),
      this.pool.query('SELECT data FROM football_futures'),
      this.pool.query('SELECT seq, data FROM football_odds_audit ORDER BY seq ASC')
    ]);

    // 1) Partidos por temporada (cleanMatch es sin pérdidas: data trae el objeto entero).
    const matchesBySeason = new Map();
    for (const row of matchRes.rows) {
      const match = cleanMatch(row.data);
      if (!match || !match.id) continue;
      const seasonMonth = row.season_month || match.seasonMonth;
      if (!matchesBySeason.has(seasonMonth)) matchesBySeason.set(seasonMonth, []);
      matchesBySeason.get(seasonMonth).push(match);
    }

    // 2) Ligas: rehidrata y vuelve a apuntar las jornadas a los objetos partido,
    //    igual que FootballStore._hydrateLeague (calendar guarda matchIds, no objetos).
    this.leagues.clear();
    for (const row of leagueRes.rows) {
      const league = cleanLeague(row.data);
      if (!league) continue;
      const seasonMatches = matchesBySeason.get(league.seasonMonth) || [];
      const cal = league.calendar;
      if (cal && typeof cal === 'object') {
        cal.matches = seasonMatches;
        const byId = new Map(seasonMatches.map(m => [m.id, m]));
        if (Array.isArray(cal.jornadas)) {
          for (const j of cal.jornadas) j.matches = (j.matchIds || []).map(id => byId.get(id)).filter(Boolean);
        }
      }
      this.leagues.set(league.seasonMonth, league);
    }

    // 3) Apuestas, combinadas y futuros.
    this.bets.clear(); this.parlays.clear(); this.futures.clear();
    for (const row of betRes.rows) { const bet = cleanBet(row.data); if (bet && bet.id) this.bets.set(bet.id, bet); }
    for (const row of parlayRes.rows) { const p = cleanParlay(row.data); if (p && p.id) this.parlays.set(p.id, p); }
    for (const row of futureRes.rows) { const f = cleanFuture(row.data); if (f && f.id) this.futures.set(f.id, f); }

    // 4) Auditoría de cuotas: anillo en memoria (últimas N) + seq persistido.
    this.oddsAudit = auditRes.rows.slice(-ODDS_AUDIT_LIMIT).map(row => row.data);
    this._auditPersistedSeq = auditRes.rows.length ? Number(auditRes.rows[auditRes.rows.length - 1].seq) || 0 : 0;
    this._auditSeq = this._auditPersistedSeq;

    // 5) seasons se deriva de las ligas (no hay tabla aparte): current = la activa más
    //    reciente (o la más reciente), history = las cerradas ordenadas.
    const keys = [...this.leagues.keys()].sort();
    if (keys.length) {
      const active = keys.filter(k => this.leagues.get(k).status === 'active');
      this.seasons = {
        current: active.length ? active[active.length - 1] : keys[keys.length - 1],
        history: keys.filter(k => this.leagues.get(k).status === 'closed').slice(-12)
      };
    } else {
      this.seasons = { current: monthKey(), history: [] };
    }
  }

  // --- Persistencia (write-behind con guarda de solapamiento, espejo de PgProfileStore) ---

  // Durante la carga inicial no se guarda (generateSeason dispara saveNow sueltos que
  // correrían en paralelo con _loadOnce); _init() hace un único volcado al final.
  scheduleSave() {
    if (this._loading) return;
    return super.scheduleSave();
  }

  // saveNow es aguardable: si ya hay un guardado en vuelo, devuelve SU promesa (que
  // refleja el estado en memoria actual, incluida la mutación que lo disparó), en vez
  // de devolver de inmediato. Así `await store.saveNow()` de verdad espera a que la
  // escritura termine — importante para el apagado limpio y para las pruebas.
  saveNow() {
    if (this._loading) return Promise.resolve();
    if (this._saving) { this._savePending = true; return this._savingPromise || Promise.resolve(); }
    this._saving = true;
    clearTimeout(this._backgroundRetryTimer);
    this._savingPromise = this._runSave();
    return this._savingPromise;
  }

  async _runSave() {
    try {
      await withRetries(() => this._writeSnapshot(), { attempts: 3, delaysMs: [700, 2000], label: 'guardar liga de fútbol' });
    } catch (error) {
      console.warn('No se pudo guardar la liga de fútbol en Postgres tras varios intentos; se reintentará en segundo plano:', error.message);
      // §11.3: mientras el proceso viva, se reintenta cada 10s (p. ej. en cuanto Neon despierte).
      this._backgroundRetryTimer = setTimeout(() => { this.saveNow(); }, 10000);
      this._backgroundRetryTimer.unref?.();
    } finally {
      this._saving = false;
      this._savingPromise = null;
      if (this._savePending) { this._savePending = false; this.saveNow(); }
    }
  }

  async _writeSnapshot() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // a) Ligas (primero: football_matches y football_bets las referencian).
      const leagues = [...this.leagues.values()];
      if (leagues.length) {
        await client.query(
          `INSERT INTO football_leagues (season_month, status, data, updated_at)
           SELECT season_month, status, data, now()
           FROM unnest($1::text[], $2::text[], $3::jsonb[]) AS t(season_month, status, data)
           ON CONFLICT (season_month) DO UPDATE
             SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = now()`,
          [
            leagues.map(l => l.seasonMonth),
            leagues.map(l => l.status || 'active'),
            // _serializeLeague incrusta calendar.matches; en PG los partidos viven en
            // football_matches, así que se podan del data de la liga (sin duplicar 240
            // partidos por temporada). Al cargar, _loadOnce vuelve a injertarlos.
            leagues.map(l => { const s = this._serializeLeague(l); if (s.calendar) s.calendar.matches = []; return JSON.stringify(s); })
          ]
        );
      }

      // b) Partidos de todas las ligas.
      const matches = [];
      for (const l of leagues) if (l.calendar && Array.isArray(l.calendar.matches)) matches.push(...l.calendar.matches);
      if (matches.length) {
        await client.query(
          `INSERT INTO football_matches
             (id, season_month, jornada, day, block, featured, home_id, away_id, status, scheduled_at, score_home, score_away, settled_at, data, updated_at)
           SELECT id, season_month, jornada, day, block, featured, home_id, away_id, status,
                  scheduled_at::timestamptz, score_home::int, score_away::int, settled_at::timestamptz, data, now()
           FROM unnest($1::text[], $2::text[], $3::int[], $4::int[], $5::text[], $6::bool[], $7::text[], $8::text[],
                       $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::jsonb[])
             AS t(id, season_month, jornada, day, block, featured, home_id, away_id, status,
                  scheduled_at, score_home, score_away, settled_at, data)
           ON CONFLICT (id) DO UPDATE SET
             season_month = EXCLUDED.season_month, jornada = EXCLUDED.jornada, day = EXCLUDED.day,
             block = EXCLUDED.block, featured = EXCLUDED.featured, home_id = EXCLUDED.home_id,
             away_id = EXCLUDED.away_id, status = EXCLUDED.status, scheduled_at = EXCLUDED.scheduled_at,
             score_home = EXCLUDED.score_home, score_away = EXCLUDED.score_away, settled_at = EXCLUDED.settled_at,
             data = EXCLUDED.data, updated_at = now()`,
          [
            matches.map(m => m.id),
            matches.map(m => m.seasonMonth),
            matches.map(m => Number(m.jornada) || 1),
            matches.map(m => Number(m.day) || 1),
            matches.map(m => String(m.block || 'estelar')),
            matches.map(m => Boolean(m.featured)),
            matches.map(m => String(m.homeId || '')),
            matches.map(m => String(m.awayId || '')),
            matches.map(m => String(m.status || 'scheduled')),
            matches.map(m => iso(m.scheduledKickoffAt) || new Date().toISOString()),
            matches.map(m => (m.result ? String(m.result.home) : null)),
            matches.map(m => (m.result ? String(m.result.away) : null)),
            matches.map(m => iso(m.settledAt)),
            matches.map(m => JSON.stringify(m))
          ]
        );
      }

      // c) Apuestas (dinero: la fila entera, con idempotency_key UNIQUE en la base).
      const bets = [...this.bets.values()];
      if (bets.length) {
        await client.query(
          `INSERT INTO football_bets
             (id, idempotency_key, profile_id, match_id, parlay_id, market, selection, stake, odds_at_placement,
              in_play, minute_at_placement, status, payout, placed_at, settled_at, data, updated_at)
           SELECT id, idempotency_key, profile_id, match_id, parlay_id, market, selection, stake::int,
                  odds_at_placement::numeric, in_play, minute_at_placement::int, status, payout::int,
                  placed_at::timestamptz, settled_at::timestamptz, data, now()
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                       $8::text[], $9::text[], $10::bool[], $11::text[], $12::text[], $13::text[],
                       $14::text[], $15::text[], $16::jsonb[])
             AS t(id, idempotency_key, profile_id, match_id, parlay_id, market, selection, stake, odds_at_placement,
                  in_play, minute_at_placement, status, payout, placed_at, settled_at, data)
           ON CONFLICT (id) DO UPDATE SET
             idempotency_key = EXCLUDED.idempotency_key, profile_id = EXCLUDED.profile_id, match_id = EXCLUDED.match_id,
             parlay_id = EXCLUDED.parlay_id, market = EXCLUDED.market, selection = EXCLUDED.selection,
             stake = EXCLUDED.stake, odds_at_placement = EXCLUDED.odds_at_placement, in_play = EXCLUDED.in_play,
             minute_at_placement = EXCLUDED.minute_at_placement, status = EXCLUDED.status, payout = EXCLUDED.payout,
             placed_at = EXCLUDED.placed_at, settled_at = EXCLUDED.settled_at, data = EXCLUDED.data, updated_at = now()`,
          [
            bets.map(b => b.id),
            bets.map(b => String(b.idempotencyKey || b.id)),
            bets.map(b => String(b.profileId)),
            bets.map(b => String(b.matchId)),
            bets.map(b => (b.parlayId == null ? null : String(b.parlayId))),
            bets.map(b => String(b.market || '')),
            bets.map(b => String(b.selection || '')),
            bets.map(b => String(Math.max(1, Math.floor(Number(b.stake) || 0)))),
            bets.map(b => String(numOrNull(b.oddsAtPlacement) ?? 1)),
            bets.map(b => Boolean(b.inPlay)),
            bets.map(b => (b.minuteAtPlacement == null ? null : String(b.minuteAtPlacement))),
            bets.map(b => String(b.status || 'open')),
            bets.map(b => (b.payout == null ? null : String(b.payout))),
            bets.map(b => iso(b.placedAt) || new Date().toISOString()),
            bets.map(b => iso(b.settledAt)),
            bets.map(b => JSON.stringify(b))
          ]
        );
      }

      // d) Combinadas.
      const parlays = [...this.parlays.values()];
      if (parlays.length) {
        await client.query(
          `INSERT INTO football_parlays
             (id, profile_id, season_month, combined_odds, stake, status, payout, legs, placed_at, settled_at, data, updated_at)
           SELECT id, profile_id, season_month, combined_odds::numeric, stake::int, status, payout::int,
                  legs::jsonb, placed_at::timestamptz, settled_at::timestamptz, data, now()
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                       $8::text[], $9::text[], $10::text[], $11::jsonb[])
             AS t(id, profile_id, season_month, combined_odds, stake, status, payout, legs, placed_at, settled_at, data)
           ON CONFLICT (id) DO UPDATE SET
             profile_id = EXCLUDED.profile_id, season_month = EXCLUDED.season_month, combined_odds = EXCLUDED.combined_odds,
             stake = EXCLUDED.stake, status = EXCLUDED.status, payout = EXCLUDED.payout, legs = EXCLUDED.legs,
             placed_at = EXCLUDED.placed_at, settled_at = EXCLUDED.settled_at, data = EXCLUDED.data, updated_at = now()`,
          [
            parlays.map(p => p.id),
            parlays.map(p => String(p.profileId)),
            parlays.map(p => String(p.seasonMonth || '')),
            parlays.map(p => String(numOrNull(p.combinedOdds) ?? 1)),
            parlays.map(p => String(Math.max(1, Math.floor(Number(p.stake) || 0)))),
            parlays.map(p => String(p.status || 'open')),
            parlays.map(p => (p.payout == null ? null : String(p.payout))),
            parlays.map(p => JSON.stringify(p.legs || [])),
            parlays.map(p => iso(p.placedAt) || new Date().toISOString()),
            parlays.map(p => iso(p.settledAt)),
            parlays.map(p => JSON.stringify(p))
          ]
        );
      }

      // e) Futuros (el índice único parcial garantiza un abierto por perfil+mercado+selección).
      const futures = [...this.futures.values()];
      if (futures.length) {
        await client.query(
          `INSERT INTO football_futures
             (id, profile_id, season_month, market, selection, odds, stake, status, payout, placed_at_jornada, placed_at, settled_at, data, updated_at)
           SELECT id, profile_id, season_month, market, selection, odds::numeric, stake::int, status, payout::int,
                  placed_at_jornada::int, placed_at::timestamptz, settled_at::timestamptz, data, now()
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                       $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::jsonb[])
             AS t(id, profile_id, season_month, market, selection, odds, stake, status, payout, placed_at_jornada, placed_at, settled_at, data)
           ON CONFLICT (id) DO UPDATE SET
             profile_id = EXCLUDED.profile_id, season_month = EXCLUDED.season_month, market = EXCLUDED.market,
             selection = EXCLUDED.selection, odds = EXCLUDED.odds, stake = EXCLUDED.stake, status = EXCLUDED.status,
             payout = EXCLUDED.payout, placed_at_jornada = EXCLUDED.placed_at_jornada, placed_at = EXCLUDED.placed_at,
             settled_at = EXCLUDED.settled_at, data = EXCLUDED.data, updated_at = now()`,
          [
            futures.map(f => f.id),
            futures.map(f => String(f.profileId)),
            futures.map(f => String(f.seasonMonth || '')),
            futures.map(f => String(f.market || '')),
            futures.map(f => String(f.selection || '')),
            futures.map(f => String(numOrNull(f.odds) ?? 1)),
            futures.map(f => String(Math.max(1, Math.floor(Number(f.stake) || 0)))),
            futures.map(f => String(f.status || 'open')),
            futures.map(f => (f.payout == null ? null : String(f.payout))),
            futures.map(f => String(Number(f.placedAtJornada) || 0)),
            futures.map(f => iso(f.placedAt) || new Date().toISOString()),
            futures.map(f => iso(f.settledAt)),
            futures.map(f => JSON.stringify(f))
          ]
        );
      }

      // f) Auditoría de cuotas: append-only, solo las entradas nuevas (seq > persistido).
      const newAudit = this.oddsAudit.filter(e => e && Number(e._seq) > this._auditPersistedSeq);
      if (newAudit.length) {
        const maxSeq = newAudit.reduce((mx, e) => Math.max(mx, Number(e._seq) || 0), this._auditPersistedSeq);
        await client.query(
          `INSERT INTO football_odds_audit (seq, match_id, market, selection, odds_before, odds_after, reason, stake_trigger, data)
           SELECT seq::bigint, match_id, market, selection, odds_before::numeric, odds_after::numeric, reason, stake_trigger::int, data
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[])
             AS t(seq, match_id, market, selection, odds_before, odds_after, reason, stake_trigger, data)`,
          [
            newAudit.map(e => String(e._seq)),
            newAudit.map(e => String(e.matchId || '')),
            newAudit.map(e => String(e.market || '')),
            newAudit.map(e => String(e.selection || '')),
            newAudit.map(e => (e.oddsBefore == null ? null : String(e.oddsBefore))),
            newAudit.map(e => (e.oddsAfter == null ? null : String(e.oddsAfter))),
            newAudit.map(e => String(e.reason || '')),
            newAudit.map(e => (e.stakeTrigger == null ? null : String(e.stakeTrigger))),
            newAudit.map(e => JSON.stringify(e))
          ]
        );
        this._auditPersistedSeq = maxSeq;
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    clearTimeout(this.saveTimer);
    clearTimeout(this._backgroundRetryTimer);
    try { await this.saveNow(); } catch (_) { /* saveNow ya reporta y reintenta */ }
    if (this.ownsPool) await this.pool.end().catch(() => {});
  }

  // Auditoría: añade un seq monotónico cliente (para el append incremental) y delega
  // en el anillo en memoria de FootballStore. No fuerza un guardado: la auditoría no es
  // dinero y se escribe en el próximo saveNow (igual que en el backend de archivo).
  appendOddsAudit(entry) {
    if (entry && typeof entry === 'object' && entry._seq == null) entry._seq = ++this._auditSeq;
    return super.appendOddsAudit(entry);
  }
}

module.exports = { PgFootballStore, SCHEMA_SQL, resolveSsl, describeConnection };
