'use strict';

// Diario transaccional de Quiniela. No conectar con PgProfileStore hasta que
// la cartera compartida implemente el contrato transaccional y sincronice su
// caché. Las funciones reciben partidos del servidor, jamás del navegador.
const Rules = require('./quiniela');
const SCHEMA = `
 CREATE TABLE IF NOT EXISTS montecristo_quiniela_bank (
   id SMALLINT PRIMARY KEY CHECK(id=1), carry BIGINT NOT NULL CHECK(carry>=0)
 );
 INSERT INTO montecristo_quiniela_bank(id,carry) VALUES(1,0) ON CONFLICT(id) DO NOTHING;
 CREATE TABLE IF NOT EXISTS montecristo_quiniela_rounds (
   season TEXT NOT NULL, jornada INTEGER NOT NULL CHECK(jornada>0),
   match_ids JSONB NOT NULL, closes_at BIGINT NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('open','settled','cancelled')),
   result JSONB, PRIMARY KEY(season,jornada)
 );
 CREATE TABLE IF NOT EXISTS montecristo_quiniela_tickets (
   season TEXT NOT NULL, jornada INTEGER NOT NULL, profile_id TEXT NOT NULL,
   picks JSONB NOT NULL, placed_at BIGINT NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('open','won','lost','refunded')),
   payout BIGINT NOT NULL DEFAULT 0 CHECK(payout>=0),
   PRIMARY KEY(season,jornada,profile_id),
   FOREIGN KEY(season,jornada) REFERENCES montecristo_quiniela_rounds(season,jornada)
 );
 CREATE TABLE IF NOT EXISTS montecristo_quiniela_movements (
   season TEXT NOT NULL, jornada INTEGER NOT NULL, profile_id TEXT NOT NULL,
   kind TEXT NOT NULL CHECK(kind IN ('entry','prize','refund')), amount BIGINT NOT NULL,
   PRIMARY KEY(season,jornada,profile_id,kind),
   FOREIGN KEY(season,jornada,profile_id) REFERENCES montecristo_quiniela_tickets(season,jornada,profile_id)
 );`;

function roundData(league, jornada) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(league?.seasonMonth || '')) || !Number.isSafeInteger(jornada) || jornada<1) throw new Error('Jornada inválida');
  const matches=Rules.jornadaMatches(league,jornada);
  if (!matches || matches.some(m=>!Number.isSafeInteger(m.scheduledKickoffAt))) throw new Error('Calendario inválido');
  return { season:league.seasonMonth, jornada, ids:matches.map(m=>m.id).sort(), closesAt:Math.min(...matches.map(m=>m.scheduledKickoffAt)) };
}
function ticketView(row) {
  return row && { season:row.season, jornada:row.jornada, picks:row.picks, placedAt:Number(row.placed_at), status:row.status, payout:Number(row.payout) };
}
class PgQuinielaStore {
  constructor(pool, wallet, {now=()=>Date.now()}={}) {
    if (!pool?.connect || typeof wallet?.move !== 'function') throw new TypeError('Se requiere PostgreSQL y una cartera transaccional');
    this.pool=pool; this.wallet=wallet; this.now=now;
  }
  async init() { await this.pool.query(SCHEMA); }
  async transaction(work) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serie global ordenada, también entre procesos y cambios de temporada.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['montecristo:quiniela:v1']);
      const value=await work(client); await client.query('COMMIT'); return value;
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }
  async move(client, round, profileId, kind, amount) {
    if (!Number.isSafeInteger(amount)) throw new Error('Movimiento inválido');
    const recorded=await client.query(`INSERT INTO montecristo_quiniela_movements(season,jornada,profile_id,kind,amount)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING kind`,[round.season,round.jornada,profileId,kind,amount]);
    if (recorded.rowCount) await this.wallet.move(client,{season:round.season,jornada:round.jornada,profileId,kind,amount});
  }
  async enter(league,jornada,profileId,picks) {
    const round=roundData(league,jornada);
    if (typeof profileId!=='string' || !profileId || profileId.length>200) throw new Error('Perfil inválido');
    return this.transaction(async client=>{
      const previous=await client.query('SELECT * FROM montecristo_quiniela_tickets WHERE season=$1 AND jornada=$2 AND profile_id=$3',[round.season,jornada,profileId]);
      if (previous.rowCount) {
        const saved=previous.rows[0].picks;
        const same=Array.isArray(picks) && picks.length===saved.length && saved.every(p=>picks.some(x=>x?.matchId===p.matchId && x.pick===p.pick));
        return same ? {ok:true,replayed:true,ticket:ticketView(previous.rows[0])} : {ok:false,code:'already_entered'};
      }
      const checked=Rules.validateEntry(league,jornada,picks,false,this.now());
      if (!checked.ok) return {ok:false,code:checked.code};
      await client.query(`INSERT INTO montecristo_quiniela_rounds(season,jornada,match_ids,closes_at,status)
        VALUES($1,$2,$3::jsonb,$4,'open') ON CONFLICT DO NOTHING`,[round.season,jornada,JSON.stringify(round.ids),round.closesAt]);
      const found=await client.query('SELECT * FROM montecristo_quiniela_rounds WHERE season=$1 AND jornada=$2 FOR UPDATE',[round.season,jornada]);
      const stored=found.rows[0];
      if (stored.status!=='open' || Number(stored.closes_at)!==round.closesAt || JSON.stringify(stored.match_ids)!==JSON.stringify(round.ids)) return {ok:false,code:'round_changed'};
      const inserted=await client.query(`INSERT INTO montecristo_quiniela_tickets(season,jornada,profile_id,picks,placed_at,status)
        VALUES($1,$2,$3,$4::jsonb,$5,'open') RETURNING *`,[round.season,jornada,profileId,JSON.stringify(checked.picks),this.now()]);
      await this.move(client,round,profileId,'entry',-Rules.ENTRY_COST);
      if (this.now() >= round.closesAt) throw new Error('La inscripción cerró antes de confirmar el boleto');
      return {ok:true,replayed:false,ticket:ticketView(inserted.rows[0])};
    });
  }
  async ticket(season,jornada,profileId) {
    const result=await this.pool.query('SELECT * FROM montecristo_quiniela_tickets WHERE season=$1 AND jornada=$2 AND profile_id=$3',[season,jornada,profileId]);
    return ticketView(result.rows[0]) || null;
  }
  async settle(league,jornada) {
    const round=roundData(league,jornada);
    return this.transaction(async client=>{
      const found=await client.query('SELECT * FROM montecristo_quiniela_rounds WHERE season=$1 AND jornada=$2 FOR UPDATE',[round.season,jornada]);
      if (!found.rowCount) return {status:'empty'};
      const stored=found.rows[0];
      if (stored.status!=='open') return stored.result;
      if (JSON.stringify(stored.match_ids)!==JSON.stringify(round.ids)) return {status:'invalid'};
      const previous=await client.query(`SELECT 1 FROM montecristo_quiniela_rounds
        WHERE status='open' AND (season<$1 OR (season=$1 AND jornada<$2)) LIMIT 1`,[round.season,jornada]);
      if (previous.rowCount) return {status:'waiting_previous'};
      const bank=await client.query('SELECT carry FROM montecristo_quiniela_bank WHERE id=1 FOR UPDATE');
      const carry=Number(bank.rows[0].carry);
      const tickets=await client.query('SELECT * FROM montecristo_quiniela_tickets WHERE season=$1 AND jornada=$2 ORDER BY profile_id FOR UPDATE',[round.season,jornada]);
      const outcome=Rules.evaluate(league,jornada,tickets.rows.map(row=>({profileId:row.profile_id,picks:row.picks})),carry);
      if (outcome.status!=='settled' && outcome.status!=='cancelled') return outcome;
      const awards=new Map((outcome.status==='settled'?outcome.winners:outcome.refunds).map(x=>[x.profileId,x.amount]));
      for (const ticket of tickets.rows) {
        const winner=awards.has(ticket.profile_id), amount=awards.get(ticket.profile_id) || 0;
        const status=outcome.status==='cancelled'?'refunded':winner?'won':'lost';
        if (winner && amount>0) await this.move(client,round,ticket.profile_id,outcome.status==='cancelled'?'refund':'prize',amount);
        await client.query('UPDATE montecristo_quiniela_tickets SET status=$4,payout=$5 WHERE season=$1 AND jornada=$2 AND profile_id=$3',[round.season,jornada,ticket.profile_id,status,amount]);
      }
      // El resultado público nunca incluye IDs de perfiles ganadores.
      const result={status:outcome.status,pot:outcome.pot ?? null,winners:outcome.winners?.length || 0,carry:outcome.carry,entries:tickets.rowCount};
      await client.query('UPDATE montecristo_quiniela_bank SET carry=$1 WHERE id=1',[outcome.carry]);
      await client.query('UPDATE montecristo_quiniela_rounds SET status=$3,result=$4::jsonb WHERE season=$1 AND jornada=$2',[round.season,jornada,outcome.status,JSON.stringify(result)]);
      return result;
    });
  }
}
module.exports={PgQuinielaStore,SCHEMA};
