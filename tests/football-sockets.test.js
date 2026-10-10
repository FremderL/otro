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
  const betting = createBettingService({ store, profiles, log: () => {} });

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
  const nameIssue = opts.nameIssue !== undefined ? opts.nameIssue
    : (name, { exceptId = null } = {}) => (profiles.findProfileByName(name, exceptId) ? 'Ese nombre ya lo usa otra persona.' : null);
  const verifyTosAcceptance = opts.verifyTos !== undefined ? opts.verifyTos : ((profile, tos) => String(tos) === TOS);

  const nowVal = opts.now || (() => {
    const m = store.getMatches(month).find(x => x.status === 'scheduled');
    return m ? m.scheduledKickoffAt : Date.now();
  });
  const sockets = registerFootballSockets(io.io, {
    betting, engine, store, profiles,
    config: opts.config || { matchCapacity: opts.matchCap || 40, lobbyCapacity: 200 },
    log: () => {}, now: typeof nowVal === 'function' ? nowVal : () => nowVal,
    nameIssue, verifyTosAcceptance,
    cleanMessage: (t) => String(t == null ? '' : t).replace(/[<>]/g, '').trim().slice(0, 200)
  });

  const scheduled = store.getMatches(month).find(m => m.status === 'scheduled');
  const cleanup = () => { try { sockets.stop(); } catch (_) {} try { store.close(); } catch (_) {} try { profiles.saveNow(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, profiles, betting, engine, io, sockets, spy, scheduled, month, nameIssue, cleanup };
}

function subscribe(ctx, socket, payload = {}) {
  return socket._fire('football:subscribe', { token: 'tok_' + socket.id, tos: TOS, scope: 'lobby', ...payload });
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
    'ball', 'ballCarrierId', 'displayMinute', 'half', 'matchId', 'minute', 'phase',
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

test('status del motor: avisa a la sala del partido Y refresca el lobby', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const s = ctx.io.connect();
  subscribe(ctx, s, { scope: 'match', matchId: ctx.scheduled.id, name: 'Leo' });
  ctx.engine.emit('football:status', { matchId: ctx.scheduled.id, code: 'match_started', minute: 0 });
  assert.ok(ctx.io.lastTo(matchRoom(ctx.scheduled.id), 'football:status'), 'status al partido');
  assert.ok(ctx.io.lastTo(LOBBY_ROOM, 'football:lobby'), 'lobby refrescado');
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
