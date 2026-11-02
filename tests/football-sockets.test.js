'use strict';

// Fase E — Pruebas de la capa de protocolo Socket.IO (§14, §20: T7, T37, T38).
// Cubre: la puerta de identidad (A11, subscribe es la ÚNICA getOrCreate), la
// privacidad del estado revelado (el timeline completo nunca viaja), el cableado
// de apuestas/liquidaciones, el cupo de salas y la difusión de eventos del motor.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { BallonDorMarketService } = require('../lib/football/ballon-dor-market');
const { QuinielaService } = require('../lib/football/quiniela-service');
const { registerFootballSockets, publicBet, matchRoom, LOBBY_ROOM, profileRoom } = require('../lib/football/sockets');
const { monthKey } = require('../lib/football-store-shared');
const { CLUB_BY_ID } = require('../lib/football/teams');

const TOS = 'v1';

// --- Mocks de Socket.IO ---
function makeIo() {
  const emitted = [];
  const connectionHandlers = [];
  const io = {
    on(event, cb) { if (event === 'connection') connectionHandlers.push(cb); },
    to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; }
  };
  function connect() {
    const socket = makeSocket();
    connectionHandlers.forEach(cb => cb(socket));
    return socket;
  }
  function emittedTo(room, event) { return emitted.filter(e => e.room === room && (!event || e.event === event)); }
  return { io, emitted, emittedTo, connect, lastTo: (room, event) => { const m = emittedTo(room, event); return m.length ? m[m.length - 1].payload : null; } };
}

function makeSocket(id = 'sock_' + Math.random().toString(36).slice(2, 9)) {
  const handlers = {};
  const socket = {
    id, data: {}, rooms: new Set(), sent: [],
    on(event, cb) { handlers[event] = cb; },
    join(room) { socket.rooms.add(room); },
    leave(room) { socket.rooms.delete(room); },
    emit(event, payload) { socket.sent.push({ event, payload }); },
    _fire(event, payload, ack) {
      let captured;
      const cb = handlers[event];
      if (!cb) throw new Error('sin handler para ' + event);
      cb(payload, ack || ((res) => { captured = res; }));
      return captured;
    },
    _has(event) { return Boolean(handlers[event]); }
  };
  return socket;
}

// Mock del motor: controla deriveMatchState y permite emitir eventos.
function makeEngine(derive) {
  const handlers = {};
  return {
    _handlers: handlers,
    on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); },
    off(event, cb) { handlers[event] = (handlers[event] || []).filter(h => h !== cb); },
    emit(event, payload) { (handlers[event] || []).forEach(cb => cb(payload)); },
    deriveMatchState(match, now) { return derive ? derive(match, now) : defaultDerive(match); }
  };
}
function defaultDerive(_match) {
  return {
    minute: 0, phase: 'pre', ended: false, revealedIndex: -1,
    state: {
      minute: 0, half: 1, phase: 'kickoff', score: { home: 0, away: 0 },
      stats: { xG: { home: 0, away: 0 } }, possession: { home: 0.5, away: 0.5 },
      shots: { home: 0, away: 0 }, shotsOnTarget: { home: 0, away: 0 },
      corners: { home: 0, away: 0 }, fouls: { home: 0, away: 0 },
      cards: { home: [], away: [] }, redCards: { home: 0, away: 0 }, ball: { x: 0.5, y: 0.5, zone: 'midfield' }
    }
  };
}

// --- Arnés completo: stores reales + mocks io/engine + spies ---
function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsock-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const month = monthKey();
  store.generateSeason(month);
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const betting = createBettingService({ store, profiles,
    now: () => Math.min(...store.getMatches(month).map(item => item.scheduledKickoffAt)) - 60000, log: () => {} });

  // Spies de identidad (A11): contamos getOrCreate/getProfile.
  const spy = { getOrCreate: 0, getProfile: 0, placeBet: 0 };
  const realGetOrCreate = profiles.getOrCreate.bind(profiles);
  const realGetProfile = profiles.getProfile.bind(profiles);
  profiles.getOrCreate = (...a) => { spy.getOrCreate++; return realGetOrCreate(...a); };
  profiles.getProfile = (...a) => { spy.getProfile++; return realGetProfile(...a); };
  const realPlaceBet = betting.placeBet.bind(betting);
  betting.placeBet = (...a) => { spy.placeBet++; return realPlaceBet(...a); };

  const io = makeIo();
  const engine = makeEngine(opts.derive);
  const quiniela = opts.quiniela === undefined ? null : opts.quiniela;
  const nameIssue = opts.nameIssue !== undefined ? opts.nameIssue
    : (name, { exceptId = null } = {}) => (profiles.findProfileByName(name, exceptId) ? 'Ese nombre ya lo usa otra persona.' : null);
  const verifyTosAcceptance = opts.verifyTos !== undefined ? opts.verifyTos : ((profile, tos) => String(tos) === TOS);

  const nowVal = opts.now || (() => {
    if (opts.withQuiniela) return Math.min(...store.getMatches(month).map(item => item.scheduledKickoffAt)) - 60000;
    const m = store.getMatches(month).find(x => x.status === 'scheduled');
    return m ? m.scheduledKickoffAt : Date.now();
  });
  const betPlacements = [];
  const quinielaService = opts.withQuiniela
    ? new QuinielaService({ store, profiles, log: () => {}, now: () => (typeof nowVal === 'function' ? nowVal() : nowVal), enabled: true })
    : null;
  const sockets = registerFootballSockets(io.io, {
    betting, engine, store, profiles,
    quiniela: quiniela || quinielaService, ballonDorMarket: opts.ballonDorMarket || null, accountSessionsEnabled: opts.accountSessionsEnabled || false,
    onBetPlaced: details => { betPlacements.push(details); opts.onBetPlaced?.(details); },
    config: opts.config || { matchCapacity: opts.matchCap || 40, lobbyCapacity: 200 },
    log: () => {}, now: typeof nowVal === 'function' ? nowVal : () => nowVal,
    nameIssue, verifyTosAcceptance,
    cleanMessage: (t) => String(t == null ? '' : t).replace(/[<>]/g, '').trim().slice(0, 200)
  });

  const scheduled = store.getMatches(month).find(m => m.status === 'scheduled');
  const cleanup = () => { try { sockets.stop(); } catch (_) {} try { store.close(); } catch (_) {} try { profiles.saveNow(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, profiles, betting, engine, io, sockets, spy, betPlacements, scheduled, month, nameIssue, cleanup };
}

function subscribe(ctx, socket, payload = {}) {
  return socket._fire('football:subscribe', { token: 'tok_' + socket.id, tos: TOS, scope: 'lobby', ...payload });
}

// Para handlers async: devuelve una promesa que resuelve con el ack real.
function fireAsync(socket, event, payload = {}) {
  return new Promise(resolve => socket._fire(event, payload, resolve));
}

// ===================== PUERTA DE IDENTIDAD (A11) =====================

test('subscribe es la ÚNICA puerta que crea identidad (getOrCreate una sola vez)', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const res = subscribe(ctx, s, { name: 'Alice' });
  assert.equal(res.ok, true);
  assert.equal(ctx.spy.getOrCreate, 1, 'subscribe crea el perfil una vez');
  assert.ok(s.data.football && s.data.football.profileId, 'socket.data.football fijado');
  assert.equal(res.profile.name, 'Alice');
});

test('T37 — bet sin suscribir NO crea perfil ni apuesta (identidad nunca del payload)', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  // Payload con token/profileId inventados: el handler DEBE ignorarlos.
  const res = s._fire('football:bet', {
    matchId: ctx.scheduled.id, market: '1x2', selection: 'home', stake: 50,
    token: 'tok_inventado', profileId: 'p_fantasma'
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_identity');
  assert.equal(ctx.spy.getOrCreate, 0, 'nunca getOrCreate fuera de subscribe');
  assert.equal(ctx.spy.placeBet, 0, 'nunca placeBet sin identidad');
  assert.equal(ctx.profiles.getProfile('tok_inventado'), null);
  assert.equal(ctx.profiles.getProfile('p_fantasma'), null);
});

test('T37 — cashout/chat/reaction/parlay/future sin suscribir rechazan sin crear', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  assert.equal(s._fire('football:cashout', { betId: 'b_x' }).code, 'no_identity');
  assert.equal(s._fire('football:chat', { matchId: ctx.scheduled.id, text: 'hola' }).code, 'no_identity');
  assert.equal(s._fire('football:parlay', { legs: [], stake: 10 }).code, 'no_identity');
  assert.equal(s._fire('football:future', { market: 'champion', selection: 'x', stake: 10 }).code, 'no_identity');
  assert.equal(ctx.spy.getOrCreate, 0);
  // reaction sin identidad no difunde (no lanza).
  s._fire('football:reaction', { matchId: ctx.scheduled.id, emoji: 'gol' });
  assert.equal(ctx.io.emittedTo(matchRoom(ctx.scheduled.id), 'football:reaction').length, 0);
});

test('T38 — nombre tomado: la comprobación corre ANTES de crear (getOrCreate 0)', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.profiles.getOrCreate('dueña', 'Alice', null); // otra persona ya usa 'Alice'
  ctx.spy.getOrCreate = 0; // reinicia el conteo tras la creación previa
  const s = ctx.io.connect();
  const res = subscribe(ctx, s, { name: 'Alice', token: 'tok_nueva' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'name_taken');
  assert.equal(ctx.spy.getOrCreate, 0, 'nameIssue bloquea antes de getOrCreate');
  assert.equal(ctx.profiles.getProfile('tok_nueva'), null, 'no se creó el perfil');
});

test('T38 — nombre libre: suscribe y crea una vez', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const res = subscribe(ctx, s, { name: 'Bob', token: 'tok_bob' });
  assert.equal(res.ok, true);
  assert.equal(ctx.spy.getOrCreate, 1);
  assert.ok(ctx.profiles.getProfile('tok_bob'));
});

test('TOS no aceptado: subscribe rechaza con tos_required', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const res = s._fire('football:subscribe', { scope: 'lobby', token: 'tok_x', name: 'Cara', tos: 'viejo' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'tos_required');
});

test('token ausente: subscribe rechaza con token_required', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const res = s._fire('football:subscribe', { scope: 'lobby', name: 'Dan' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'token_required');
});

test('el lobby expone hora del servidor y estilo táctico público para La Previa', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const res = subscribe(ctx, s, { name: 'Aficionado' });
  assert.equal(res.ok, true);
  assert.equal(res.lobby.serverNow, ctx.scheduled.scheduledKickoffAt);
  assert.equal(res.teams.vantora_fc.formation, CLUB_BY_ID.vantora_fc.tactics.formation);
  assert.equal(res.teams.vantora_fc.style, CLUB_BY_ID.vantora_fc.tactics.style);
});

// ===================== PRIVACIDAD DEL ESTADO REVELADO (T7) =====================

test('T7 — match_state SOLO lleva estado revelado: el timeline nunca viaja', (t) => {
  // Motor malicioso: state incluye timeline completo + eventos futuros.
  const derive = () => ({
    minute: 30, phase: 'first_half', ended: false, revealedIndex: 4,
    state: {
      minute: 30, half: 1, phase: 'first_half', score: { home: 1, away: 0 },
      possession: { home: 0.55, away: 0.45 }, xG: { home: 0.8, away: 0.2 },
      shots: { home: 5, away: 2 }, shotsOnTarget: { home: 2, away: 1 },
      corners: { home: 3, away: 1 }, fouls: { home: 4, away: 6 },
      cards: { home: [], away: [] }, redCards: { home: 0, away: 0 }, ball: { x: 0.6, y: 0.4, zone: 'attack' },
      // Campos que NO deben salir:
      timeline: [{ t: 88, type: 'goal', team: 'away' }], futureEvents: [{ t: 90 }], seed: 'secreto'
    }
  });
  const ctx = setup({ derive });
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const res = subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Eve' });
  assert.equal(res.ok, true);
  const ms = res.matchState;
  assert.ok(ms && ms.state, 'match_state con state');
  const json = JSON.stringify(ms);
  assert.ok(!json.includes('timeline'), 'sin clave timeline');
  assert.ok(!json.includes('futureEvents'), 'sin eventos futuros');
  assert.ok(!json.includes('secreto'), 'sin seed interno');
  assert.equal(ms.state.minute, 30);
  assert.deepEqual(ms.state.score, { home: 1, away: 0 });
  // El state expuesto es un subconjunto explícito, sin campos crudos.
  assert.ok(!('timeline' in ms.state) && !('futureEvents' in ms.state) && !('seed' in ms.state));
});

test('match_state anuncia mercado suspendido durante una interrupción del juego', (t) => {
  const derive = () => {
    const base = defaultDerive();
    base.minute = 30;
    base.matchEnd = 90;
    base.phase = 'first_half';
    base.state.minute = 30;
    base.state.phase = 'set_piece';
    base.state.playStopped = true;
    base.state.players = [{
      id: 'h9', team: 'home', name: 'A. Vitale', number: 9, pos: 'ST', role: 'FW', slotIndex: 10,
      x: 0.82, y: 0.5, status: 'active', active: true, shooting: 91
    }];
    return base;
  };
  const ctx = setup({ derive });
  t.after(ctx.cleanup);
  ctx.scheduled.status = 'live';
  const socket = ctx.io.connect();
  const res = subscribe(ctx, socket, { scope: 'match', matchId: ctx.scheduled.id, name: 'Pausa' });
  assert.equal(res.ok, true);
  assert.equal(res.matchState.state.playStopped, true);
  assert.equal(res.matchState.suspended, true);
  assert.ok(Array.isArray(res.matchState.markets['1x2']));
  assert.deepEqual(Object.keys(res.matchState.state.players[0]).sort(), [
    'active', 'id', 'name', 'number', 'pos', 'role', 'slotIndex', 'status', 'team', 'x', 'y'
  ]);
  assert.ok(!('shooting' in res.matchState.state.players[0]), 'no se filtran atributos internos del jugador');
});

test('T7 — tick lleva solo minute/score/phase/ball/possession (subconjunto revelado)', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Fay' });
  const state = {
    minute: 12, phase: 'first_half', score: { home: 0, away: 0 }, ball: { x: 0.5, y: 0.5, zone: 'midfield' },
    possession: { home: 0.5, away: 0.5 }, timeline: [{ t: 80, type: 'goal' }]
  };
  ctx.engine.emit('football:tick', { matchId: ctx.scheduled.id, state, minute: 12 });
  const tick = ctx.io.lastTo(matchRoom(ctx.scheduled.id), 'football:tick');
  assert.ok(tick, 'tick difundido');
  assert.equal(tick.minute, 12);
  assert.deepEqual(Object.keys(tick).sort(), [
    'ball', 'ballCarrierId', 'cards', 'displayMinute', 'half', 'matchId', 'minute', 'phase',
    'playStopped', 'players', 'possession', 'possessionTeam', 'score'
  ].sort());
  assert.ok(!JSON.stringify(tick).includes('timeline'));
});

// ===================== CABLEADO DE APUESTAS =====================

test('tick en vivo difunde cuotas con el estado de suspensión actualizado', (t) => {
  let paused = true;
  const derive = () => {
    const base = defaultDerive();
    base.minute = 30;
    base.matchEnd = 95;
    base.phase = 'first_half';
    base.state.minute = 30;
    base.state.score = { home: 1, away: 0 };
    base.state.redCards = { home: 1, away: 0 };
    base.state.playStopped = paused;
    return base;
  };
  const ctx = setup({ derive });
  t.after(ctx.cleanup);
  ctx.scheduled.status = 'live';
  const socket = ctx.io.connect();
  subscribe(ctx, socket, { scope: 'match', matchId: ctx.scheduled.id, name: 'Cuotas' });
  const room = matchRoom(ctx.scheduled.id);
  ctx.engine.emit('football:status', { matchId: ctx.scheduled.id, code: 'halftime', minute: 45 });
  assert.equal(ctx.io.lastTo(room, 'football:odds').suspended, true, 'el status de descanso publica la suspensión de inmediato');
  ctx.engine.emit('football:tick', { matchId: ctx.scheduled.id, state: derive().state, minute: 30 });
  assert.equal(ctx.io.lastTo(room, 'football:odds').suspended, true);
  assert.equal(ctx.io.lastTo(room, 'football:odds').selections.length, 3);
  paused = false;
  ctx.engine.emit('football:event', {
    matchId: ctx.scheduled.id,
    event: { t: 0, type: 'kickoff', team: 'home', phase: 'kickoff', commentary: [] },
    catchUp: false, replay: false
  });
  assert.equal(ctx.io.lastTo(room, 'football:odds').suspended, false, 'el saque inicial reactiva cuotas sin esperar al siguiente tick');
  ctx.engine.emit('football:tick', { matchId: ctx.scheduled.id, state: derive().state, minute: 30.5 });
  assert.equal(ctx.io.lastTo(room, 'football:odds').suspended, false);
});

test('bet suscrito: debita, guarda y devuelve publicBet sin fugas', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const sub = subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Gus' });
  assert.equal(sub.ok, true);
  const profile = ctx.profiles.getProfile(sub.profile.id);
  profile.chips = 1000; ctx.profiles.saveNow();
  const res = await new Promise((resolve) => s._fire('football:bet', {
    matchId: ctx.scheduled.id, market: '1x2', selection: 'home', stake: 100
  }, resolve));
  assert.equal(res.ok, true, 'apuesta aceptada: ' + JSON.stringify(res));
  assert.equal(res.chips, 900, 'debitado');
  assert.equal(ctx.spy.placeBet, 1);
  // publicBet: sin profileId ni deviceToken.
  const pb = res.bet;
  assert.ok(!('profileId' in pb) && !('deviceToken' in pb), 'publicBet sin identidad cruda');
  assert.equal(pb.market, '1x2');
  assert.equal(pb.stake, 100);
  assert.ok(pb.odds >= 1.05);
  assert.deepEqual(ctx.betPlacements, [{ profileId: sub.profile.id, kind: 'bet', stake: 100 }]);

  const replay = await new Promise(resolve => s._fire('football:bet', {
    matchId: ctx.scheduled.id, market: '1x2', selection: 'home', stake: 100
  }, resolve));
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(ctx.betPlacements.length, 1, 'un reintento no vuelve a difundir volumen');
});

test('publicBet() proyecta solo campos públicos', () => {
  const bet = {
    id: 'b_1', matchId: 'm_1', market: '1x2', selection: 'home', stake: 50, oddsAtPlacement: 2.1,
    status: 'open', potentialPayout: 105, inPlay: false, minuteAtPlacement: 0, payout: null, placedAt: 1,
    profileId: 'SECRETO', deviceToken: 'SECRETO', debited: true
  };
  const pb = publicBet(bet);
  assert.ok(!JSON.stringify(pb).includes('SECRETO'));
  assert.equal(pb.id, 'b_1');
  assert.equal(pb.odds, 2.1);
});

test('cashout de apuesta ajena se rechaza (not_your_bet)', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const sub = subscribe(ctx, s, { name: 'Hal' });
  assert.equal(sub.ok, true);
  const res = s._fire('football:cashout', { betId: 'b_inexistente' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not_your_bet');
});

// ===================== SALAS, CUPO Y CICLO DE VIDA =====================

test('subscribe a match une a la sala del partido; unsubscribe la deja', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Ivo' });
  assert.ok(s.rooms.has(matchRoom(ctx.scheduled.id)), 'en la sala del partido');
  assert.ok(s.rooms.has(profileRoom(sub2id(s))), 'en la sala directa del perfil');
  assert.equal(ctx.sockets.roomSize(matchRoom(ctx.scheduled.id)), 1);
  s._fire('football:unsubscribe', { scope: 'match', matchId: ctx.scheduled.id });
  assert.equal(ctx.sockets.roomSize(matchRoom(ctx.scheduled.id)), 0);
});
function sub2id(s) { return s.data.football.profileId; }

test('cupo de sala: al llenarse rechaza con room_full', (t) => {
  const ctx = setup({ matchCap: 2 });
  t.after(ctx.cleanup);
  const a = ctx.io.connect(); const b = ctx.io.connect(); const c = ctx.io.connect();
  assert.equal(subscribe(ctx, a, { scope: 'match', matchId: ctx.scheduled.id, name: 'A1' }).ok, true);
  assert.equal(subscribe(ctx, b, { scope: 'match', matchId: ctx.scheduled.id, name: 'B1' }).ok, true);
  assert.equal(subscribe(ctx, a, { scope: 'match', matchId: ctx.scheduled.id, name: 'A1' }).ok, true, 'un miembro puede actualizar su estado aunque la sala esté llena');
  const res = subscribe(ctx, c, { scope: 'match', matchId: ctx.scheduled.id, name: 'C1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'room_full');
  assert.equal(ctx.sockets.roomSize(matchRoom(ctx.scheduled.id)), 2);
});

test('disconnect libera todas las salas del socket', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Jon' });
  assert.equal(ctx.sockets.roomSize(matchRoom(ctx.scheduled.id)), 1);
  s._fire('disconnect', {});
  assert.equal(ctx.sockets.roomSize(matchRoom(ctx.scheduled.id)), 0);
});

// ===================== DIFUSIÓN DE EVENTOS DEL MOTOR (§14.2) =====================

test('evento del motor: difunde football:event público + comentario + anillo', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Kai' });
  const room = matchRoom(ctx.scheduled.id);
  ctx.engine.emit('football:event', {
    matchId: ctx.scheduled.id,
    event: { i: 7, t: 23, type: 'goal', team: 'home', playerId: 'h9', marcador: '1-0', importance: 'high', seedInterno: 'X' },
    catchUp: false, replay: false
  });
  const ev = ctx.io.lastTo(room, 'football:event');
  assert.ok(ev, 'evento difundido');
  assert.equal(ev.event.type, 'goal');
  assert.equal(ev.event.minute, 23);
  assert.ok(!JSON.stringify(ev).includes('seedInterno'), 'publicEvent recorta campos internos');
});

test('el lobby publica las cuentas regresivas: fin de temporada y ceremonia del Balón de Oro', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  const res = subscribe(ctx, s, { name: 'Relojes' });
  assert.equal(res.ok, true);
  const lobby = res.lobby;
  assert.ok(lobby && lobby.countdowns, 'el lobby lleva el bloque countdowns');
  const casino = lobby.countdowns.casino;
  assert.equal(casino.seasonMonth, ctx.month);
  const ends = new Date(casino.endsAt);
  assert.equal(ends.getUTCDate() <= 2, true, 'endsAt es el inicio del mes siguiente en hora local del casino');
  assert.equal(typeof casino.resetDeferred, 'boolean');
  assert.equal(casino.chipsResetAt, casino.endsAt, 'el reinicio de fichas usa el mismo instante');

  const bdo = lobby.countdowns.ballonDor;
  assert.ok(bdo, 'el ciclo del Balón de Oro viaja con su reloj');
  assert.equal(bdo.seasonMonth, ctx.month);
  assert.ok(bdo.ceremonyAt > 0, 'hay hora de ceremonia');
  const ceremony = new Date(bdo.ceremonyAt).toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City'
  });
  assert.equal(ceremony, '22:00', 'la ceremonia es a las 22:00 locales');
  // Y el último partido termina antes de esa hora.
  const lastKickoff = Math.max(...ctx.store.getMatches(ctx.month).map(m => m.scheduledKickoffAt));
  assert.ok(lastKickoff + 15.75 * 60 * 1000 <= bdo.ceremonyAt, 'ningún partido pisa la clausura');
});

test('la grada vota: sin partido en juego no se abre y con mayoría se publican los insultos', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s1 = ctx.io.connect();
  subscribe(ctx, s1, { scope: 'match', matchId: ctx.scheduled.id, name: 'Votante1' });
  const early = s1._fire('football:stands_open', { matchId: ctx.scheduled.id });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'not_live', 'la votación se abre con el partido en juego');

  ctx.scheduled.status = 'live';
  const votes = [s1];
  for (const name of ['Votante2', 'Votante3']) {
    const s = ctx.io.connect();
    subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name });
    votes.push(s);
  }
  assert.equal(votes[0]._fire('football:stands_open', { matchId: ctx.scheduled.id }).ok, true);
  assert.equal(votes[1]._fire('football:stands_vote', { matchId: ctx.scheduled.id, allow: true }).ok, true);
  const passed = votes[2]._fire('football:stands_vote', { matchId: ctx.scheduled.id, allow: true });
  assert.equal(passed.ok, true);
  assert.equal(passed.stands.allowsInsults, true, 'tres votos a favor habilitan la grada picante');

  const repeated = votes[1]._fire('football:stands_vote', { matchId: ctx.scheduled.id, allow: false });
  assert.equal(repeated.ok, false, 'la votación ya cerró con la mayoría a favor');
  assert.equal(votes[1]._fire('football:stands_state', { matchId: ctx.scheduled.id }).stands.allowsInsults, true);

  // Con la grada habilitada el mensaje se publica sin censura y marcado.
  assert.equal(votes[0]._fire('football:chat', { matchId: ctx.scheduled.id, text: 'hola' }).ok, true);
  const chat = ctx.io.lastTo(matchRoom(ctx.scheduled.id), 'football:chat');
  assert.equal(chat.soft, true);
  assert.ok(chat.id, 'cada comentario lleva id propio para su botón de quitar');

  const state = votes[0]._fire('football:stands_state', { matchId: ctx.scheduled.id });
  assert.equal(state.ok, true);
  assert.equal(state.stands.status, 'allowed');
});

test('status del motor: avisa a la sala del partido Y refresca el lobby', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Leo' });
  ctx.engine.emit('football:status', { matchId: ctx.scheduled.id, code: 'match_started', minute: 0 });
  assert.ok(ctx.io.lastTo(matchRoom(ctx.scheduled.id), 'football:status'), 'status al partido');
  assert.ok(ctx.io.lastTo(LOBBY_ROOM, 'football:lobby'), 'lobby refrescado');
});

test('cada full_time difunde al lobby el mercado BDO recalculado para la temporada del partido asentado', (t) => {
  const requestedMonths = [];
  const ballonDorMarket = {
    getMarket(seasonMonth) {
      requestedMonths.push(seasonMonth);
      return { market: 'balon_de_oro', seasonMonth, status: 'active', updatedAt: requestedMonths.length };
    }
  };
  const ctx = setup({ ballonDorMarket });
  t.after(ctx.cleanup);
  const matches = ctx.store.getMatches(ctx.month).filter(match => match.status === 'scheduled').slice(0, 2);
  assert.equal(matches.length, 2);

  matches.forEach(match => ctx.engine.emit('football:status', {
    matchId: match.id, code: 'full_time', minute: 90
  }));

  const updates = ctx.io.emittedTo(LOBBY_ROOM, 'football:ballon_dor_market');
  assert.equal(updates.length, 2, 'cada partido asentado publica una actualización del mercado');
  assert.deepEqual(requestedMonths, matches.map(match => match.seasonMonth));
  assert.deepEqual(updates.map(update => update.payload.market.seasonMonth), requestedMonths);
  assert.deepEqual(updates.map(update => update.payload.market.updatedAt), [1, 2]);
});

test('reprogramación del motor: difunde football:rescheduled y status con nuevo kickoff y actualiza el lobby', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Reprogramado' });
  const newKickoff = ctx.scheduled.scheduledKickoffAt + 7200000;
  ctx.engine.emit('football:rescheduled', { matchId: ctx.scheduled.id, scheduledKickoffAt: newKickoff, day: 15, block: 'estelar' });
  const reschedEv = ctx.io.lastTo(matchRoom(ctx.scheduled.id), 'football:rescheduled');
  assert.ok(reschedEv, 'evento football:rescheduled recibido');
  assert.equal(reschedEv.scheduledKickoffAt, newKickoff);
  assert.ok(ctx.io.lastTo(LOBBY_ROOM, 'football:lobby'), 'lobby refrescado al reprogramar');
});

test('stop() desregistra los listeners del motor', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const before = (ctx.engine._handlers['football:tick'] || []).length;
  assert.ok(before > 0, 'listeners registrados');
  ctx.sockets.stop();
  assert.equal((ctx.engine._handlers['football:tick'] || []).length, 0, 'listeners retirados');
});

// ===================== CHAT / REACCIONES =====================

test('chat suscrito difunde texto limpio; vacío se rechaza', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Mia' });
  const room = matchRoom(ctx.scheduled.id);
  const ok = s._fire('football:chat', { matchId: ctx.scheduled.id, text: 'golazo' });
  assert.equal(ok.ok, true);
  const msg = ctx.io.lastTo(room, 'football:chat');
  assert.equal(msg.text, 'golazo');
  assert.equal(msg.name, 'Mia');
  // cleanMessage retira < > (anti-inyección): '<b>x</b>' → 'bx/b'.
  s._fire('football:chat', { matchId: ctx.scheduled.id, text: '<b>x</b>' });
  assert.equal(ctx.io.lastTo(room, 'football:chat').text, 'bx/b');
  const empty = s._fire('football:chat', { matchId: ctx.scheduled.id, text: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');
});

test('reaction suscrita difunde a la sala con el nombre del perfil', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Nia' });
  s._fire('football:reaction', { matchId: ctx.scheduled.id, emoji: 'gol' });
  const r = ctx.io.lastTo(matchRoom(ctx.scheduled.id), 'football:reaction');
  assert.equal(r.emoji, 'gol');
  assert.equal(r.from, 'Nia');
});

// ===================== RELATO EN VIVO (§9) =====================

test('relato: un gol real (con playerName) genera comentario que nombra club y jugador', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Kai' });
  const room = matchRoom(ctx.scheduled.id);
  const homeName = CLUB_BY_ID[ctx.scheduled.homeId].name;

  // Kickoff primero (reinicia el marcador corrido del relato) y luego el gol, tal
  // como los emite el match-engine: con playerName/assistName/xg ya resueltos.
  ctx.engine.emit('football:event', { matchId: ctx.scheduled.id, event: { t: 0, type: 'kickoff', team: 'home', half: 1 }, catchUp: false, replay: false });
  ctx.engine.emit('football:event', {
    matchId: ctx.scheduled.id,
    event: { t: 23, type: 'goal', team: 'home', half: 1, playerId: 'h9', playerName: 'A. Vitale', assistName: 'L. Marrero', xg: 0.31 },
    catchUp: false, replay: false
  });

  const cmt = ctx.io.emittedTo(room, 'football:commentary').map(e => e.payload);
  assert.ok(cmt.length > 0, 'el gol produjo al menos una línea de relato');
  const texto = cmt.map(c => c.text).join(' ');
  assert.ok(texto.includes(homeName) || texto.includes('Vitale'), 'el relato nombra al club o al goleador: ' + texto);
  assert.ok(cmt.every(c => c.voice === 'narrador' || c.voice === 'analista'), 'voces válidas');
  assert.ok(cmt.every(c => typeof c.text === 'string' && c.text.length > 0 && c.text.length <= 140), 'cada línea ≤ 140 chars');
  // El evento público arrastra el marcador actualizado (1-0) para el cliente.
  const ev = ctx.io.lastTo(room, 'football:event');
  assert.equal(ev.event.marcador, '1-0');
  assert.equal(ev.event.importance, 'high');
});

test('relato: Socket.IO reutiliza el comentario confirmado y publica el balón del mismo evento', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Ivo' });
  const room = matchRoom(ctx.scheduled.id);
  const authoritative = [{ voice: 'narrador', text: 'Texto sellado por el motor para esta acción.' }];
  ctx.engine.emit('football:event', {
    matchId: ctx.scheduled.id,
    event: {
      i: 14, t: 22.5, type: 'shot_on_target', team: 'home', playerId: 'h9', playerName: 'A. Vitale',
      ball: { x: 0.96, y: 0.5 }, ballAction: 'shot', outcome: 'saved', ballCarrierId: null,
      possessionTeam: 'home', commentary: authoritative, sequenceId: 'private-sequence'
    },
    catchUp: false, replay: false
  });
  const commentary = ctx.io.emittedTo(room, 'football:commentary').map(item => item.payload);
  assert.deepEqual(commentary.map(item => ({ voice: item.voice, text: item.text })), authoritative);
  const event = ctx.io.lastTo(room, 'football:event').event;
  assert.deepEqual(event.ball, { x: 0.96, y: 0.5 });
  assert.equal(event.ballAction, 'shot');
  assert.equal(event.outcome, 'saved');
  assert.equal(event.id, 14);
  assert.ok(!('sequenceId' in event), 'no expone metadatos internos de secuencia');
});

test('relato: dos eventos iguales seguidos no repiten la misma plantilla (memoria §9)', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Kai' });
  const room = matchRoom(ctx.scheduled.id);
  ctx.engine.emit('football:event', { matchId: ctx.scheduled.id, event: { t: 0, type: 'kickoff', team: 'home', half: 1 }, catchUp: false, replay: false });
  // Dos tiros al arco consecutivos del mismo tipo.
  for (const minuto of [31, 33]) {
    ctx.engine.emit('football:event', {
      matchId: ctx.scheduled.id,
      event: { t: minuto, type: 'shot_on_target', team: 'away', half: 1, playerId: 'a4', playerName: 'R. Estevin', xg: 0.12 },
      catchUp: false, replay: false
    });
  }
  const narr = ctx.io.emittedTo(room, 'football:commentary').map(e => e.payload).filter(c => c.voice === 'narrador').map(c => c.text);
  // Con memoria anti-repetición, si hay dos líneas de narrador no deben ser idénticas.
  if (narr.length >= 2) assert.notEqual(narr[0], narr[narr.length - 1], 'la memoria evita la repetición inmediata');
  assert.ok(narr.length >= 1, 'shot_on_target produce relato');
});

test('socket de futuros usa la cotización del servidor y descarta cuota y jornada manipuladas', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const socket = ctx.io.connect();
  const subscribed = subscribe(ctx, socket, { scope: 'lobby', name: 'Futuro socket' });
  const profile = ctx.profiles.getProfile(subscribed.profile.id);
  profile.chips = 1000; ctx.profiles.saveNow();
  const market = socket._fire('football:futures_market', {});
  assert.equal(market.ok, true);
  const quote = market.market.markets.champion[0];
  const reply = await new Promise(resolve => socket._fire('football:future', {
    market: 'champion', selection: quote.selection, stake: 100, odds: 999999, jornada: 29
  }, resolve));
  assert.equal(reply.ok, true, reply.code);
  assert.equal(reply.future.odds, quote.odds);
  assert.equal(ctx.store.getFuture(reply.future.id).placedAtJornada, 0);
  assert.equal(reply.future.potentialPayout, Math.floor(100 * quote.odds));
  assert.ok(!('profileId' in reply.future));
  assert.equal(profile.chips, 900);
});

test('socket BDO usa identidad suscrita, devuelve mercado público y descarta cuota/jornada del cliente', async (t) => {
  let actualMarket;
  const marketService = { getMarket: month => actualMarket.getMarket(month) };
  const ctx = setup({ ballonDorMarket: marketService });
  t.after(ctx.cleanup);
  ctx.store.generateSeason('2026-09');
  ctx.store.seasons.current = ctx.month;
  actualMarket = new BallonDorMarketService({ store: ctx.store });
  const socket = ctx.io.connect();
  const subscribed = subscribe(ctx, socket, { scope: 'lobby', name: 'BDO socket' });
  assert.equal(subscribed.ok, true);
  const marketReply = socket._fire('football:ballon_dor_market', {});
  assert.equal(marketReply.ok, true);
  assert.equal(marketReply.market.seasonMonth, ctx.month);
  const archivedReply = socket._fire('football:ballon_dor_market', { seasonMonth: '2026-09' });
  assert.equal(archivedReply.ok, true);
  assert.equal(archivedReply.market.seasonMonth, '2026-09');
  const invalidArchive = socket._fire('football:ballon_dor_market', { seasonMonth: 'not-a-month' });
  assert.equal(invalidArchive.ok, false);
  assert.equal(invalidArchive.code, 'season_month_invalid');

  ctx.sockets.broadcastBallonDorMarket(ctx.month);
  const broadcast = ctx.io.emittedTo(LOBBY_ROOM, 'football:ballon_dor_market');
  assert.equal(broadcast.length, 1);
  const mediaWire = JSON.stringify({ marketReply, archivedReply, broadcast });
  assert.doesNotMatch(mediaWire, /\.(?:mp3|wav|ogg|mp4|webm)(?:["\s]|$)|data:(?:audio|video)/i,
    'ni la respuesta del mercado ni su difusión Socket.IO contienen audio o video');
  assert.deepEqual(Object.keys(marketReply.market).filter(key => /audio|video|media/i.test(key)), []);

  const received = [];
  ctx.betting.placeBallonDorBet = async args => {
    received.push(args);
    return {
      ok: true,
      future: {
        id: 'bdo_test', market: 'balon_de_oro', selection: args.selection,
        stake: args.stake, odds: 3.25, potentialPayout: 325, status: 'open',
        payout: null, placedAt: 1, seasonMonth: ctx.month, profileId: 'no-publicar'
      }
    };
  };
  const reply = await new Promise(resolve => socket._fire('football:ballon_dor_bet', {
    selection: 'candidate-test', stake: 100, idemKey: 'socket-bdo-key-001', odds: 1.01, jornada: 30
  }, resolve));
  assert.equal(reply.ok, true);
  assert.equal(reply.future.odds, 3.25);
  assert.ok(!('profileId' in reply.future));
  assert.deepEqual(received[0], {
    profile: ctx.profiles.getProfile(subscribed.profile.id),
    selection: 'candidate-test', stake: 100, idempotencyKey: 'socket-bdo-key-001'
  });
  assert.equal(ctx.betPlacements.at(-1).kind, 'future');
});


test('Mi Once acepta solo la sesión verificada, guarda sin fichas y permite revocar ranking', async () => {
  let clock = Date.now();
  const ctx = setup({ accountSessionsEnabled: true, now: () => clock });
  try {
    const { playersOf } = require('../lib/football/fantasy');
    const day = ctx.store.getMatches(ctx.month).filter(match => match.jornada === 1 && !match.desempate);
    clock = Math.min(...day.map(match => match.scheduledKickoffAt)) - 10000;
    const socket = ctx.io.connect();
    subscribe(ctx, socket, { name:'Alicia' });
    let res = socket._fire('football:fantasy_get', {}); assert.equal(res.code,'no_identity');
    const account=ctx.profiles.getOrCreate('cuenta-real','Beto'); socket.data.accountProfileId=account.id;
    const players=playersOf(ctx.store.getLeague(ctx.month));
    const selected=[['GK',1],['DF',4],['MF',4],['FW',2]].flatMap(([group,n])=>players.filter(p=>p.group===group).slice(0,n).map(p=>p.id));
    res=await new Promise(resolve=>socket._fire('football:fantasy_save',{season:ctx.month,players:selected,tos:TOS,profileId:'victima'},resolve));
    assert.equal(res.ok,true); assert.deepEqual(account.footballFantasy.lineups[0].players,selected); assert.equal(account.chips,1000);
    res=await new Promise(resolve=>socket._fire('football:fantasy_ranking_opt',{enabled:true},resolve));
    assert.equal(res.ok,true); assert.equal(res.fantasy.rank,1); assert.doesNotMatch(JSON.stringify(res.fantasy.ranking),/cuenta-real|Beto/);
    res=await new Promise(resolve=>socket._fire('football:fantasy_ranking_opt',{enabled:false},resolve));
    assert.equal(res.fantasy.ranking.length,0);
  } finally { ctx.cleanup(); }
});

test('Mi afición guarda en el perfil, exige confirmación y no expone identidad en ranking', async () => {
  let clock = Date.now();
  const ctx = setup({ accountSessionsEnabled:true, now:() => clock });
  try {
    const socket = ctx.io.connect();
    subscribe(ctx, socket, { name:'Invitado' });
    assert.equal(socket._fire('football:fan_get', {}).code, 'no_identity');
    const account = ctx.profiles.getOrCreate('cuenta-aficion', 'Aficionado');
    socket.data.accountProfileId = account.id;
    const act = (event, payload) => new Promise(resolve => socket._fire(event, payload, resolve));
    let result = await act('football:fan_select', { clubId:'united_vanguard', currentClubId:null, tos:TOS, profileId:'victima' });
    assert.equal(result.ok,true); assert.equal(result.fan.clubId,'united_vanguard'); assert.equal(account.chips,1000);
    result = await act('football:fan_equip', { pin:'fan-3', currentClubId:'united_vanguard' });
    assert.equal(result.code,'pin_locked');
    result = await act('football:fan_equip', { pin:'club-pin', currentClubId:'united_vanguard' });
    assert.equal(result.ok,true); assert.equal(result.fanPin.abbr,'FAR');
    assert.equal(account.footballFanClub.equippedPin,'club-pin');
    result = await act('football:fan_ranking_opt', { enabled:true, currentClubId:'united_vanguard' });
    assert.equal(result.ok,true); assert.equal(result.fan.ranking.length,1);
    assert.doesNotMatch(JSON.stringify(result.fan.ranking),/cuenta-aficion|Aficionado/);
    result = await act('football:fan_select', { clubId:'sporting_almar', currentClubId:'united_vanguard', tos:TOS });
    assert.equal(result.code,'confirmation_required'); assert.equal(account.footballFanClub.clubId,'united_vanguard');
    clock++;
    result = await act('football:fan_select', { clubId:'sporting_almar', currentClubId:'united_vanguard', confirmed:true, tos:TOS });
    assert.equal(result.ok,true); assert.equal(result.fan.rankingOptIn,false); assert.equal(result.fan.wins,0); assert.equal(account.footballFanClub.equippedPin,null);
    const restarted = new ProfileStore(path.join(ctx.dir, 'profiles.json'));
    try { assert.equal(restarted.getProfile(account.id).footballFanClub.clubId,'sporting_almar'); } finally { clearTimeout(restarted.saveTimer); }
    result = await act('football:fan_select', { clubId:'united_vanguard', currentClubId:'united_vanguard', confirmed:true, tos:TOS });
    assert.equal(result.code,'club_changed'); assert.equal(account.footballFanClub.clubId,'sporting_almar');
  } finally { ctx.cleanup(); }
});

test('mercado de traspasos se revela a partir del día 15 y exige suscripción', async t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const s = ctx.io.connect();
  assert.equal(s._fire('football:transfers_get',{}).code,'no_identity');
  assert.equal(subscribe(ctx,s,{name:'Mercado'}).ok,true);
  const result=await fireAsync(s,'football:transfers_get',{});
  assert.equal(result.ok,true);
  assert.ok(['scheduled','announced','effective'].includes(result.transfers.status));
  if (result.transfers.status==='scheduled') { assert.equal(result.transfers.moves.length,0); assert.equal(result.firstView,false); }
  else { assert.equal(result.transfers.moves.length,8); assert.equal(result.firstView,true); }
});

test('la primera vista del mercado (MonteCristo News) se marca una vez por temporada y persiste', async t => {
  const d=new Date(); d.setDate(16); d.setHours(12,0,0,0); // día 15+ del mes en curso
  const ctx=setup({ now: d.getTime() }); t.after(ctx.cleanup);
  const s=ctx.io.connect();
  const sub=subscribe(ctx,s,{name:'News'}); assert.equal(sub.ok,true);
  const first=await fireAsync(s,'football:transfers_get',{});
  assert.equal(first.ok,true);
  assert.equal(first.transfers.status,'announced');
  assert.equal(first.transfers.moves.length,8);
  assert.equal(first.firstView,true,'la primera consulta tras anunciarse abre la transmisión');
  const second=await fireAsync(s,'football:transfers_get',{});
  assert.equal(second.firstView,false,'la segunda ya no repite el bumper');
  assert.equal(second.transfers.status,'announced');
  const month=monthKey();
  const profile=ctx.profiles.getProfile(sub.profile.id);
  assert.equal(profile.flags.traspasosNewsSeen[month],true,'el flag quedó en el perfil');
  const reloaded=new ProfileStore(path.join(ctx.dir,'profiles.json'));
  try { assert.equal(reloaded.getProfile(sub.profile.id).flags.traspasosNewsSeen[month],true,'y sobrevive a un reload'); }
  finally { clearTimeout(reloaded.saveTimer); }
  // Otro perfil nuevo sí vuelve a recibir firstView.
  const s2=ctx.io.connect();
  const sub2=subscribe(ctx,s2,{name:'News2'}); assert.equal(sub2.ok,true);
  const other=await fireAsync(s2,'football:transfers_get',{});
  assert.equal(other.firstView,true);
});

test('Quiniela sin servicio inyectado responde no disponible (compatibilidad)', t => {
  const ctx=setup(); t.after(ctx.cleanup); const s=ctx.io.connect();
  assert.equal(s._fire('football:quiniela_get',{}).code,'no_identity');
  assert.equal(subscribe(ctx,s,{name:'Quiniela'}).ok,true);
  const result=s._fire('football:quiniela_get',{}); assert.equal(result.ok,true);
  assert.equal(result.quiniela.available,false);
  assert.ok(result.quiniela.matches.length===8 || result.quiniela.matches.length===0);
  assert.ok(result.quiniela.matches.every(m=>m.homeId&&m.awayId));
  assert.equal(s._fire('football:quiniela_enter',{jornada:1,picks:[],tos:TOS}).code,'unavailable');
});

test('Quiniela activa: inscripción con fichas reales, TOS y reintento idempotente', async (t) => {
  const ctx=setup({ withQuiniela:true }); t.after(ctx.cleanup); const s=ctx.io.connect();
  assert.equal(s._fire('football:quiniela_get',{}).code,'no_identity');
  const sub=subscribe(ctx,s,{name:'Quiniela'}); assert.equal(sub.ok,true);
  const profile=ctx.profiles.getProfile(sub.profile.id);
  const get1=s._fire('football:quiniela_get',{}); assert.equal(get1.ok,true);
  assert.equal(get1.quiniela.available,true);
  assert.equal(get1.quiniela.matches.length,8);
  assert.equal(get1.quiniela.entryCost,50);
  assert.equal(get1.quiniela.myTicket,null);
  const { jornada, matches } = get1.quiniela;
  const picks=matches.map(m=>({matchId:m.id,pick:'home'}));
  // Sin TOS vigente: no entra.
  assert.equal((await fireAsync(s,'football:quiniela_enter',{season:get1.quiniela.season,jornada,picks,tos:'vieja'})).code,'tos_required');
  // Picks incompletos: invalid_picks.
  assert.equal((await fireAsync(s,'football:quiniela_enter',{season:get1.quiniela.season,jornada,picks:picks.slice(1),tos:TOS})).code,'invalid_picks');
  // Entrada correcta: descuenta 50 fichas y deja boleto.
  const chipsBefore=profile.chips;
  const enter=await fireAsync(s,'football:quiniela_enter',{season:get1.quiniela.season,jornada,picks,tos:TOS});
  assert.equal(enter.ok,true);
  assert.equal(profile.chips,chipsBefore-50);
  assert.equal(enter.quiniela.myTicket.picks.length,8);
  // Reintento idempotente: replayed, sin cobro extra.
  const replay=await fireAsync(s,'football:quiniela_enter',{season:get1.quiniela.season,jornada,picks,tos:TOS});
  assert.equal(replay.ok,true); assert.equal(replay.replayed,true);
  assert.equal(profile.chips,chipsBefore-50);
  // Picks distintos: ya entró.
  const other=await fireAsync(s,'football:quiniela_enter',{season:get1.quiniela.season,jornada,picks:picks.map(p=>({...p,pick:'away'})),tos:TOS});
  assert.equal(other.code,'already_entered');
  // La inscripción avisó al lobby (sin datos de nadie en el broadcast).
  const updates=ctx.io.emittedTo('football:lobby','football:quiniela_updated');
  assert.ok(updates.length>=1);
  assert.ok(!JSON.stringify(updates[0].payload).includes(profile.id));
});

test('destacados no se filtran antes del final y viajan con el resultado asentado', t=>{
 const ctx=setup();t.after(ctx.cleanup);const s=ctx.io.connect();const match=ctx.scheduled;
 match.highlights={goals:[],moments:[],star:null};
 const before=subscribe(ctx,s,{scope:'match',matchId:match.id,name:'Resumen'});assert.equal(before.matchState.match.highlights,null);
 match.status='settled';match.result={home:0,away:0,winner:'draw'};ctx.engine.emit('football:status',{matchId:match.id,code:'full_time'});
 const sent=ctx.io.lastTo(matchRoom(match.id),'football:status');assert.deepEqual(sent.highlights,match.highlights);assert.deepEqual(sent.result,match.result);
 const after=subscribe(ctx,s,{scope:'match',matchId:match.id,name:'Resumen'});assert.deepEqual(after.matchState.match.highlights,match.highlights);
});

test('sesión verificada prevalece en Estadio y una cuenta no se suplanta con su ID', t=>{
 const ctx=setup({accountSessionsEnabled:true});t.after(ctx.cleanup);const victim=ctx.profiles.getOrCreate('victima','Víctima');victim.username='victima';
 const attacker=ctx.io.connect();const rejected=subscribe(ctx,attacker,{token:'victima',name:'Impostor'});assert.equal(rejected.code,'account_auth_required');assert.equal(attacker.data.football,undefined);
 const owner=ctx.io.connect();owner.data.accountProfileId=victim.id;const ok=subscribe(ctx,owner,{token:'otro-token',name:'Otro'});assert.equal(ok.ok,true);assert.equal(ok.profile.id,'victima');assert.equal(owner.data.football.profileId,'victima');assert.equal(ctx.profiles.getProfile('otro-token'),null);
});

test('Estadio bloquea una cuenta suspendida incluso en conexiones ya abiertas', t=>{
 const ctx=setup({accountSessionsEnabled:true});t.after(ctx.cleanup);const profile=ctx.profiles.getOrCreate('moderada','Moderada');profile.username='moderada';const s=ctx.io.connect();s.data.accountProfileId=profile.id;
 assert.equal(subscribe(ctx,s,{name:'Moderada'}).ok,true);profile.moderation={status:'banned'};
 assert.equal(subscribe(ctx,s,{name:'Moderada'}).code,'account_banned');assert.equal(s._fire('football:fan_get',{}).code,'no_identity');
});

test('la grada V2 no caduca con el reloj V1 y se cierra al terminar el partido', t => {
  let at = 0;
  const ctx = setup({ now: () => at });
  t.after(ctx.cleanup);
  const match = ctx.scheduled;
  match.simulation = { version: 'v2-test' }; // el motor falso no necesita el replay privado
  match.status = 'live';
  at = match.scheduledKickoffAt + 20 * 60 * 1000; // después de los 15:45 de V1, pero V2 aún juega
  const voters = ['V2Grada1', 'V2Grada2', 'V2Grada3'].map(name => {
    const socket = ctx.io.connect();
    subscribe(ctx, socket, { scope: 'match', matchId: match.id, name });
    return socket;
  });
  assert.equal(voters[0]._fire('football:stands_open', { matchId: match.id }).ok, true);
  assert.equal(voters[1]._fire('football:stands_vote', { matchId: match.id, allow: true }).ok, true);
  assert.equal(voters[2]._fire('football:stands_vote', { matchId: match.id, allow: true }).stands.allowsInsults, true);
  assert.equal(voters[0]._fire('football:chat', { matchId: match.id, text: 'hola' }).ok, true);
  assert.equal(ctx.io.lastTo(matchRoom(match.id), 'football:chat').soft, true);
  match.status = 'settled';
  ctx.engine.emit('football:status', { matchId: match.id, code: 'full_time' });
  assert.equal(voters[0]._fire('football:stands_state', { matchId: match.id }).stands, null);
  assert.equal(voters[1]._fire('football:stands_vote', { matchId: match.id, allow: true }).code, 'not_live');
  assert.equal(voters[0]._fire('football:chat', { matchId: match.id, text: 'hola' }).ok, true);
  assert.equal(ctx.io.lastTo(matchRoom(match.id), 'football:chat').soft, false);
});

test('el reloj de cierre del Balón de Oro usa el ritmo público V2 y lo identifica como estimado', t => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const j20 = ctx.store.getMatches(ctx.month).filter(match => match.jornada === 20);
  const lastKickoff = Math.max(...j20.map(match => match.scheduledKickoffAt));
  for (const match of j20) if (match.scheduledKickoffAt === lastKickoff) match.simulation = { version: 'v2-test' };
  const socket = ctx.io.connect();
  const subscribed = subscribe(ctx, socket, { name: 'RelojV2' });
  assert.equal(subscribed.ok, true);
  const bdo = subscribed.lobby.countdowns.ballonDor;
  assert.equal(bdo.betsCloseAt, lastKickoff + 90 * 15 * 1000);
  assert.equal(bdo.betsCloseEstimated, true);
});

test('relato: cada línea viaja con su minuto, su relevancia y la marca de historia', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Nuria' });
  const room = matchRoom(ctx.scheduled.id);
  ctx.engine.emit('football:event', { matchId: ctx.scheduled.id, event: { t: 0, type: 'kickoff', team: 'home', half: 1 }, catchUp: false, replay: false });
  ctx.engine.emit('football:event', {
    matchId: ctx.scheduled.id,
    event: { t: 56, type: 'goal', team: 'home', half: 2, playerId: 'h9', playerName: 'A. Vitale' },
    catchUp: true, replay: false
  });
  const lines = ctx.io.emittedTo(room, 'football:commentary').map(e => e.payload);
  const goals = lines.filter(line => line.type === 'goal');
  assert.ok(goals.length > 0, 'el gol produjo relato');
  // La cabina del cliente necesita estos datos para no hablar del pasado:
  // minuto del hecho, relevancia y si el texto es historia ya ocurrida.
  assert.ok(goals.every(line => line.minute === 56), 'cada línea sabe en qué minuto ocurrió el hecho');
  assert.ok(goals.every(line => line.importance === 'high'), 'un gol viaja como jugada relevante');
  assert.ok(goals.every(line => line.catchUp === true), 'la historia se marca para no narrarse en voz alta');
  const kickoff = lines.filter(line => line.type === 'kickoff');
  assert.ok(kickoff.length > 0, 'el saque inicial también se relata');
  assert.ok(kickoff.every(line => line.catchUp === false), 'lo que ocurre en vivo no se marca como historia');
  assert.ok(kickoff.every(line => line.importance === 'normal'), 'y conserva su relevancia real');
});


test('relato de posesión llena pausas sin inventar jugadas y respeta hechos recientes', t => {
  let time = 100000;
  const ctx = setup({ now: () => time });
  t.after(ctx.cleanup);
  ctx.scheduled.status = 'live';
  const id = ctx.scheduled.id, room = matchRoom(id);
  const state = { phase: 'build_up', playStopped: false, possessionTeam: 'home',
    ballCarrierId: 'p1', players: [{ id: 'p1', name: 'Jugador Real', active: true }],
    score: { home: 0, away: 0 }, cards: { home: [{ type: 'yellow_card' }], away: [] } };
  const tick = () => ctx.engine.emit('football:tick', { matchId: id, state, minute: 20 });
  tick();
  assert.match(ctx.io.lastTo(room, 'football:commentary').text, /Jugador Real/);
  assert.deepEqual(ctx.io.lastTo(room, 'football:tick').cards, state.cards);
  time += 11000; tick();
  assert.equal(ctx.io.emittedTo(room, 'football:commentary').length, 1);
  time += 1000; tick();
  assert.equal(ctx.io.emittedTo(room, 'football:commentary').length, 2);
  time += 12000;
  ctx.engine.emit('football:event', { matchId: id, event: { type: 'save', t: 21, team: 'away', commentary: [{ voice: 'narrador', text: 'Atajada.' }] }, catchUp: false });
  tick();
  assert.equal(ctx.io.emittedTo(room, 'football:commentary').length, 3, 'no rellena encima de la atajada');
  assert.equal(ctx.io.lastTo(room, 'football:commentary').importance, 'high');
  time += 12000; state.playStopped = true; tick();
  assert.equal(ctx.io.emittedTo(room, 'football:commentary').length, 3, 'sin posesión durante una detención');
});

test('goles, faltas, atajadas, penales y tarjetas viajan con prioridad alta', t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const id = ctx.scheduled.id, room = matchRoom(id);
  for (const type of ['goal', 'foul', 'save', 'penalty_awarded', 'penalty_missed', 'yellow_card', 'red_card', 'second_yellow', 'shootout_kick']) {
    ctx.engine.emit('football:event', { matchId: id, event: { type, t: 20, team: 'home', commentary: [{ voice: 'narrador', text: type }] }, catchUp: false });
    assert.equal(ctx.io.lastTo(room, 'football:commentary').importance, 'high', type);
    assert.equal(ctx.io.lastTo(room, 'football:event').importance, 'high', type);
  }
});

test('plantillas oficiales muestran identidad, atributos y solo estadísticas asentadas', t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const socket = ctx.io.connect();
  assert.equal(socket._fire('football:roster_get', { clubId: ctx.scheduled.homeId }).code, 'no_identity');
  subscribe(ctx, socket, { name: 'Rosa' });
  const league = ctx.store.getLeague(ctx.month);
  const club = league.config.find(c => c.id === ctx.scheduled.homeId);
  let response = socket._fire('football:roster_get', { clubId: club.id });
  assert.equal(response.roster.players.length, 18);
  assert.equal(response.roster.seasonMonth, league.seasonMonth);
  assert.deepEqual(response.roster.players.map(p => p.id), club.squad.slice().sort((a,b) => a.num-b.num).map(p => p.id));
  assert.deepEqual(response.roster.players[0].attributes, club.squad[0].attrs);
  assert.equal(socket._fire('football:roster_get', { clubId: 'desconocido' }).ok, false);
  const match = league.calendar.matches.find(m => m.homeId === club.id || m.awayId === club.id);
  const opponent = league.config.find(c => c.id === (match.homeId === club.id ? match.awayId : match.homeId));
  match.status = 'settled'; match.result = { home: 0, away: 0 };
  match.fantasyStats = [club, opponent].flatMap(c => c.squad.map((p, i) => ({ id: p.id, teamId: c.id, played: i < 11, goals: 0, assists: 0, reds: 0, yellows: i === 0 ? 1 : 0, minutes: i < 11 ? 90 : 0 })));
  response = socket._fire('football:roster_get', { clubId: club.id });
  assert.equal(response.roster.players[0].stats.appearances, 1);
  assert.equal(response.roster.players[0].stats.minutes, 90);
  assert.equal(response.roster.players[0].stats.yellowCards, 1);
  assert.equal(response.roster.missingMatches, 0);
  match.fantasyStats[0].minutes = undefined;
  response = socket._fire('football:roster_get', { clubId: club.id });
  assert.equal(response.roster.incompleteDetails, true);
  match.fantasyStats = null;
  response = socket._fire('football:roster_get', { clubId: club.id });
  assert.equal(response.roster.missingMatches, 1);
  assert.equal(response.roster.players[0].stats.appearances, 0, 'no se inventan registros');
});

test('al cambiar del invitado a una cuenta, el socket abandona la sala privada anterior', t => {
  const ctx = setup({ accountSessionsEnabled: true }); t.after(ctx.cleanup);
  const socket = ctx.io.connect();
  const guest = subscribe(ctx, socket, { name: 'Invitado' });
  assert.ok(guest.ok && socket.rooms.has(profileRoom(guest.profile.id)));
  const account = ctx.profiles.getOrCreate('cuenta-verificada', 'Cuenta'); account.username = 'cuenta'; account.chips = 700;
  socket.data.accountProfileId = account.id;
  const logged = subscribe(ctx, socket, { name: 'Invitado' });
  assert.equal(logged.profile.id, account.id); assert.equal(logged.profile.chips, 700);
  assert.ok(!socket.rooms.has(profileRoom(guest.profile.id)));
  assert.ok(socket.rooms.has(profileRoom(account.id)));
});

test('la ficha de club usa la liga actual y permite consultar sin elegir afición', t => {
  const ctx = setup(); t.after(ctx.cleanup);
  const s = ctx.io.connect(), id = ctx.scheduled.homeId;
  assert.equal(s._fire('football:club_profile_get', { clubId: id }).code, 'no_identity');
  subscribe(ctx, s, { name: 'Curiosa' });
  const result = s._fire('football:club_profile_get', { clubId: id });
  assert.equal(result.club.clubId, id);
  assert.equal(result.club.roster.players.length, 18);
  assert.equal(result.club.manager.formation, ctx.store.getLeague(ctx.month).config.find(c => c.id === id).tactics.formation);
  assert.equal(s._fire('football:club_profile_get', { clubId: 'club_inventado' }).ok, false);
});

test('reprogramación automática solo publica la nueva hora tras persistirla', t => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const m = ctx.scheduled, old = m.scheduledKickoffAt, next = old + 30 * 60000;
  m.autoRescheduledAt = old + 120000;
  m.autoReschedulePreviousKickoffAt = old;
  m.autoReschedulePending = true;
  m.autoReschedulePreviousDay = m.day;
  m.scheduledKickoffAt = next;
  assert.equal(ctx.sockets.buildMatchState(m.id, null).match.scheduledKickoffAt, old);
  assert.equal(ctx.sockets.buildMatchState(m.id, null).match.autoRescheduled, false);
  assert.deepEqual(ctx.sockets.buildMatchState(m.id, null).markets, {});
  m.autoReschedulePending = false;
  assert.equal(ctx.sockets.buildMatchState(m.id, null).match.scheduledKickoffAt, next);
  assert.equal(ctx.sockets.buildMatchState(m.id, null).match.autoRescheduled, true);
  ctx.engine.emit('football:status', { matchId: m.id, code: 'rescheduled', scheduledKickoffAt: next, automatic: true });
  assert.equal(ctx.io.lastTo(matchRoom(m.id), 'football:status').automatic, true);
});
