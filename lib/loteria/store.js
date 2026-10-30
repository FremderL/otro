'use strict';

// Estado durable del servicio compartido de Lotería: la partida en curso (con su
// baraja y reloj), los reembolsos pendientes de confirmar y cuándo abre la
// siguiente partida. En desarrollo usa JSON atómico; con DATABASE_URL comparte
// Postgres con el resto del casino, igual que lib/lobby-tournament-store.js.
//
// OJO: este almacén NO mueve fichas. Los saldos viven en el ProfileStore (en
// memoria) y solo el servicio (lib/loteria/service.js) los toca, con claves de
// operación idempotentes. Aquí solo se guarda el diario de la partida para
// poder reanudarla tras un reinicio sin cobrar ni pagar dos veces.
const fs = require('node:fs');
const path = require('node:path');
const { Pool: RealPool } = require('pg');
const Game = require('./game');

const DEFAULT_STORE_PATH = process.env.LOTERIA_STORE_PATH
  || path.join(process.cwd(), 'data', 'loteria.json');
const EMPTY_STATE = Object.freeze({ version: 1, game: null, pendingRefunds: [], nextGameAt: null });
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS montecristo_loteria_service_state (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
const GAME_STATUSES = new Set(['registration', 'calling', 'settled', 'cancelled']);
const MAX_PENDING_REFUNDS = 500;

function isCardList(value, expectedLength) {
  return Array.isArray(value) && value.length === expectedLength
    && value.every(card => Number.isInteger(card) && card >= 1 && card <= Game.CARD_COUNT)
    && new Set(value).size === value.length;
}

function cleanPlayer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.profileId !== 'string' || !raw.profileId || raw.profileId.length > 80) return null;
  if (!isCardList(raw.board, Game.BOARD_SIZE)) return null;
  return {
    profileId: raw.profileId,
    board: [...raw.board],
    requestId: typeof raw.requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(raw.requestId) ? raw.requestId : null,
    entryApplied: Boolean(raw.entryApplied),
    paymentApplied: Boolean(raw.paymentApplied)
  };
}

function cleanAmountList(raw) {
  if (!Array.isArray(raw)) return null;
  const list = [];
  for (const item of raw) {
    if (!item || typeof item.profileId !== 'string' || !item.profileId || item.profileId.length > 80) return null;
    if (!Number.isSafeInteger(item.amount) || item.amount < 0) return null;
    list.push({ profileId: item.profileId, amount: item.amount });
  }
  return list;
}

function cleanGame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 80) return null;
  if (!GAME_STATUSES.has(raw.status)) return null;
  if (!Number.isSafeInteger(raw.openedAt) || raw.openedAt < 0) return null;
  if (!Number.isSafeInteger(raw.closesAt) || raw.closesAt < raw.openedAt) return null;
  if (!Number.isSafeInteger(raw.carry) || raw.carry < 0) return null;
  if (!isCardList(raw.deck, Game.CARD_COUNT)) return null;
  if (!Array.isArray(raw.called) || raw.called.length > Game.CARD_COUNT
    || !raw.called.every(card => Number.isInteger(card) && card >= 1 && card <= Game.CARD_COUNT)
    || new Set(raw.called).size !== raw.called.length) return null;
  if (!Array.isArray(raw.players) || raw.players.length > Game.MAX_PLAYERS) return null;
  const players = raw.players.map(cleanPlayer);
  if (players.some(player => !player)) return null;
  if (new Set(players.map(player => player.profileId)).size !== players.length) return null;
  let result = null;
  if (raw.result !== null && raw.result !== undefined) {
    if (typeof raw.result !== 'object' || Array.isArray(raw.result)) return null;
    if (!Number.isSafeInteger(raw.result.carry) || raw.result.carry < 0) return null;
    result = { carry: raw.result.carry };
    if (raw.result.winners !== undefined) {
      result.winners = cleanAmountList(raw.result.winners);
      if (!result.winners || !Number.isSafeInteger(raw.result.pot) || raw.result.pot < 0) return null;
      result.pot = raw.result.pot;
    }
    if (raw.result.refunds !== undefined) {
      result.refunds = cleanAmountList(raw.result.refunds);
      if (!result.refunds) return null;
    }
  }
  if ((raw.status === 'settled' || raw.status === 'cancelled') && !result) return null;
  const game = {
    id: raw.id, openedAt: raw.openedAt, closesAt: raw.closesAt, status: raw.status,
    carry: raw.carry, players, deck: [...raw.deck], called: [...raw.called], result,
    refundedRequestIds: Array.isArray(raw.refundedRequestIds)
      ? [...new Set(raw.refundedRequestIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(id)))].slice(-200)
      : [],
    paymentsApplied: Boolean(raw.paymentsApplied)
  };
  if (Number.isSafeInteger(raw.registrationMs)) game.registrationMs = raw.registrationMs;
  if (Number.isSafeInteger(raw.callIntervalMs)) game.callIntervalMs = raw.callIntervalMs;
  return game;
}

// Si una partida guardada está dañada y no puede reanudarse, nadie debe perder
// su entrada por ello: se rescata un reembolso pendiente por cada inscripción
// legible y el servicio lo aplica al arrancar (de forma idempotente).
function salvageRefunds(rawGame) {
  if (!rawGame || typeof rawGame !== 'object' || !Array.isArray(rawGame.players)) return [];
  const gameId = typeof rawGame.id === 'string' && rawGame.id ? rawGame.id.slice(0, 80) : 'partida-danada';
  const refunds = [];
  for (const raw of rawGame.players.slice(0, Game.MAX_PLAYERS)) {
    if (!raw || typeof raw.profileId !== 'string' || !raw.profileId || raw.profileId.length > 80) continue;
    refunds.push({
      gameId, profileId: raw.profileId,
      requestId: typeof raw.requestId === 'string' ? raw.requestId.slice(0, 100) : '',
      amount: Game.ENTRY_COST, salvaged: true
    });
  }
  return refunds;
}

function cleanPendingRefund(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.gameId !== 'string' || !raw.gameId || raw.gameId.length > 80) return null;
  if (typeof raw.profileId !== 'string' || !raw.profileId || raw.profileId.length > 80) return null;
  if (!Number.isSafeInteger(raw.amount) || raw.amount <= 0) return null;
  return {
    gameId: raw.gameId, profileId: raw.profileId,
    requestId: typeof raw.requestId === 'string' ? raw.requestId.slice(0, 100) : '',
    amount: raw.amount, ...(raw.salvaged ? { salvaged: true } : {})
  };
}

function cleanLoteriaState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const game = value.game ? cleanGame(value.game) : null;
  const pendingRefunds = (Array.isArray(value.pendingRefunds) ? value.pendingRefunds : [])
    .map(cleanPendingRefund).filter(Boolean);
  if (value.game && !game && value.game.status !== 'settled') {
    // Una partida ya liquidada ya pagó (o sus pagos quedan marcados por jugador);
    // rescatar reembolsos ahí pagaría la entrada dos veces. En cualquier otro
    // estado, devolver la entrada es lo seguro.
    for (const refund of salvageRefunds(value.game)) {
      if (!pendingRefunds.some(item => item.gameId === refund.gameId && item.profileId === refund.profileId)) {
        pendingRefunds.push(refund);
      }
    }
  }
  return {
    version: 1,
    game,
    pendingRefunds: pendingRefunds.slice(-MAX_PENDING_REFUNDS),
    nextGameAt: Number.isSafeInteger(value.nextGameAt) && value.nextGameAt >= 0 ? value.nextGameAt : null
  };
}

class FileLoteriaStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.backend = 'file';
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this._writeTail = Promise.resolve();
    this.ready = Promise.resolve();
    this.load();
  }

  load() {
    try {
      this.state = cleanLoteriaState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudo cargar el estado de la lotería:', error.message);
    }
    return this.state;
  }

  getState() { return this.state; }

  save(snapshot = this.state) {
    const state = cleanLoteriaState(snapshot);
    this.state = state;
    const run = this._writeTail.then(() => this._write(state));
    this._writeTail = run.catch(() => {});
    return run;
  }

  async saveNow(snapshot = this.state) {
    await this._writeTail;
    const state = cleanLoteriaState(snapshot);
    this.state = state;
    await this._write(state);
  }

  async _write(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  async close() { await this.saveNow(); }
}

class PgLoteriaStore {
  constructor(connectionString, { Pool = RealPool } = {}) {
    if (!connectionString) throw new Error('PgLoteriaStore requiere DATABASE_URL');
    this.backend = 'postgres';
    this.filePath = 'postgres://loteria';
    this.pool = new Pool({
      connectionString,
      ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: 10000
    });
    this.pool.on('error', error => console.warn('Postgres (lotería) error:', error.message));
    this.state = structuredClone(EMPTY_STATE);
    this._writeTail = Promise.resolve();
    this.ready = this.init();
  }

  async init() {
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(
      'INSERT INTO montecristo_loteria_service_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(EMPTY_STATE)]
    );
    const result = await this.pool.query('SELECT data FROM montecristo_loteria_service_state WHERE id = 1');
    if (result.rows[0]?.data) this.state = cleanLoteriaState(result.rows[0].data);
    return this.state;
  }

  getState() { return this.state; }

  save(snapshot = this.state) {
    const state = cleanLoteriaState(snapshot);
    this.state = state;
    const run = this._writeTail.then(async () => {
      await this.ready;
      await this._write(state);
    });
    this._writeTail = run.catch(() => {});
    return run;
  }

  async saveNow(snapshot = this.state) {
    await this.ready;
    await this._writeTail;
    const state = cleanLoteriaState(snapshot);
    this.state = state;
    await this._write(state);
  }

  async _write(state) {
    await this.pool.query(
      `INSERT INTO montecristo_loteria_service_state (id, data, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(state)]
    );
  }

  async close() {
    await this.saveNow();
    await this.pool.end();
  }
}

async function createLoteriaStore(filePath = DEFAULT_STORE_PATH, databaseUrl = process.env.DATABASE_URL, options = {}) {
  if (databaseUrl) {
    const store = new PgLoteriaStore(databaseUrl, options);
    await store.ready;
    return store;
  }
  return new FileLoteriaStore(filePath || DEFAULT_STORE_PATH);
}

module.exports = {
  DEFAULT_STORE_PATH,
  EMPTY_STATE,
  cleanLoteriaState,
  cleanGame,
  FileLoteriaStore,
  PgLoteriaStore,
  createLoteriaStore
};
