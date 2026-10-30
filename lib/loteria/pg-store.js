'use strict';

// Adaptador experimental aislado. No conectar a perfiles de la aplicación hasta
// coordinar el caché en memoria y el reset mensual con esta misma transacción.
const { randomUUID, createHash } = require('node:crypto');
const operationKey = (kind, gameId, profileId, requestId) => `${kind}:${createHash('sha256').update(JSON.stringify([gameId, profileId, requestId])).digest('hex')}`;
const Game = require('./game');

const SCHEMA = `
 CREATE TABLE IF NOT EXISTS montecristo_loteria_state (
   id SMALLINT PRIMARY KEY CHECK (id=1), game JSONB NOT NULL
 );
 CREATE TABLE IF NOT EXISTS montecristo_loteria_movements (
   id TEXT PRIMARY KEY, game_id TEXT NOT NULL, profile_id TEXT NOT NULL,
   kind TEXT NOT NULL CHECK(kind IN ('entry','refund','prize')),
   amount BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
 );`;

class PgLoteriaStore {
  constructor(pool, { now = () => Date.now(), random } = {}) {
    if (!pool?.connect) throw new TypeError('Se requiere pool de PostgreSQL');
    this.pool = pool;
    this.now = now;
    this.random = random;
  }

  async init() { await this.pool.query(SCHEMA); }

  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Una sola partida compartida; evita carreras aun con varios procesos.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['montecristo:loteria:state:v1']);
      const row = await client.query('SELECT game FROM montecristo_loteria_state WHERE id=1 FOR UPDATE');
      const game = row.rows[0]?.game || null;
      const result = await work(client, game);
      if (result.game) {
        await client.query('INSERT INTO montecristo_loteria_state(id,game) VALUES(1,$1::jsonb) ON CONFLICT(id) DO UPDATE SET game=EXCLUDED.game', [JSON.stringify(result.game)]);
      }
      await client.query('COMMIT');
      return result.value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async move(client, { id, gameId, profileId, kind, amount }) {
    if (!Number.isSafeInteger(amount)) throw new Error('Importe inválido');
    const previous = await client.query('SELECT game_id, profile_id, kind, amount FROM montecristo_loteria_movements WHERE id=$1', [id]);
    if (previous.rowCount) {
      const record = previous.rows[0];
      if (record.game_id !== gameId || record.profile_id !== profileId || record.kind !== kind || Number(record.amount) !== amount) throw new Error('Conflicto de movimiento');
      return;
    }
    const selected = await client.query('SELECT data FROM montecristo_profiles WHERE id=$1 FOR UPDATE', [profileId]);
    if (!selected.rowCount) throw new Error('Perfil inexistente');
    const profile = selected.rows[0].data;
    const balance = Number(profile.chips);
    if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(balance + amount) || balance + amount < 0) throw new Error('Saldo insuficiente o inválido');
    profile.chips = balance + amount;
    profile.updatedAt = Math.max(this.now(), (Number(profile.updatedAt) || 0) + 1);
    await client.query('UPDATE montecristo_profiles SET data=$2::jsonb,updated_at=now() WHERE id=$1', [profileId, JSON.stringify(profile)]);
    await client.query('INSERT INTO montecristo_loteria_movements(id,game_id,profile_id,kind,amount) VALUES($1,$2,$3,$4,$5)', [id, gameId, profileId, kind, amount]);
  }

  async open() {
    return this.transaction(async (_client, game) => {
      if (game && !['settled','cancelled'].includes(game.status)) return { value: Game.publicState(game, null) };
      const next = Game.newGame({ id: randomUUID(), openedAt: this.now(), carry: game?.result?.carry || 0, random: this.random });
      return { game: next, value: Game.publicState(next, null) };
    });
  }

  async view(profileId) {
    return this.transaction(async (_client, game) => ({ value: game ? Game.publicState(game, profileId) : null }));
  }

  async join(profileId, requestId) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new TypeError('Falta identificador único de solicitud');
    return this.transaction(async (client, game) => {
      if (!game) throw new Error('No hay partida');
      const previous = game.players.find(player => player.profileId === profileId);
      if (previous && previous.requestId === requestId) return { value: Game.publicState(game, profileId) };
      const entryId = operationKey('entry', game.id, profileId, requestId);
      const existing = await client.query('SELECT id FROM montecristo_loteria_movements WHERE id=$1', [entryId]);
      if (existing.rowCount) throw new Error('La inscripción ya fue cancelada');
      const joined = Game.join(game, profileId, this.now(), this.random);
      if (!joined.ok) throw new Error(`Inscripción rechazada: ${joined.reason}`);
      const player = game.players.find(entry => entry.profileId === profileId);
      player.requestId = requestId;
      await this.move(client, { id: entryId, gameId: game.id, profileId, kind:'entry', amount:-joined.debit });
      return { game, value: Game.publicState(game, profileId) };
    });
  }

  async disconnect(profileId) {
    return this.transaction(async (client, game) => {
      if (!game) return { value:false };
      const player = game.players.find(entry => entry.profileId === profileId);
      if (!player) return { value:false };
      const result = Game.disconnect(game, profileId, this.now());
      if (!result.ok) return { value:false };
      await this.move(client, { id:operationKey('refund', game.id, profileId, player.requestId), gameId:game.id, profileId, kind:'refund', amount:result.refund });
      return { game, value:true };
    });
  }

  async advance() {
    return this.transaction(async (client, game) => {
      if (!game) return { value:null };
      const events = Game.advance(game, this.now());
      const terminal = events.find(event => event.type === 'settled' || event.type === 'cancelled');
      if (terminal) {
        const payments = terminal.type === 'settled' ? terminal.winners : terminal.refunds;
        // Orden consistente para evitar deadlocks al bloquear varios perfiles.
        for (const payment of [...payments].sort((a,b) => a.profileId.localeCompare(b.profileId))) {
          const player = game.players.find(entry => entry.profileId === payment.profileId);
          const kind = terminal.type === 'settled' ? 'prize' : 'refund';
          await this.move(client, { id:operationKey(kind, game.id, payment.profileId, player.requestId), gameId:game.id, profileId:payment.profileId, kind, amount:payment.amount });
        }
      }
      return { game:events.length ? game : null, value:Game.publicState(game, null) };
    });
  }
}
module.exports = { PgLoteriaStore, SCHEMA };
