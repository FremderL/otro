'use strict';

// Fase E — Capa de protocolo Socket.IO del Estadio (§14).
//
// Regla de identidad (A11, §12.7 hallazgo 10): `football:subscribe` es la ÚNICA
// puerta que resuelve identidad (getOrCreate aparece una sola vez en toda la
// sección). El resto de handlers NUNCA acepta un identificador del payload: leen
// `socket.data.football` y resuelven con la lectura estricta `profiles.getProfile`,
// rechazando si no está. Sin esto, un bucle de `football:bet` con tokens
// inventados crearía un perfil con 1000 fichas por cada token (T37).
//
// Regla de privacidad (§14.2, T7): `football:match_state` y `football:tick` solo
// contienen eventos ya revelados. El timeline completo nunca viaja.
//
// Este módulo no toca server.js: recibe io + servicios + helpers por inyección,
// así que se prueba en aislamiento y se cablea en la integración (server.js).

const { generateCommentary, createMemory, formatScore } = require('./commentary');
const { mulberry32, hash32 } = require('./prng');
const { CLUB_BY_ID } = require('./teams');
const { monthKey, calendarParts, CASINO_TIME_ZONE } = require('../football-store-shared');

const LOBBY_ROOM = 'football:lobby';
const matchRoom = (matchId) => `football:m:${matchId}`;
const profileRoom = (profileId) => `football:p:${profileId}`;
const COMMENTARY_RING = 40;      // últimos 40 mensajes (§6.2, §14.2)
const TOS_REQUIRED = 'Debes aceptar los términos y condiciones vigentes para entrar al Estadio.';
const LIVE_STATUSES = ['live', 'halftime', 'extra_time', 'shootout'];

// Meta pública de los 16 clubes (id → nombre, colores, kit y táctica pública).
// El canvas la necesita para pintar escudos y kits; La Previa usa formación/estilo
// en su comparativa. Es estática: se envía al suscribir y en /api/estadio/state,
// nunca en el refresco periódico del lobby.
function publicTeams() {
  const out = {};
  for (const id of Object.keys(CLUB_BY_ID)) {
    const c = CLUB_BY_ID[id];
    out[id] = {
      id, name: c.name, short: c.short, city: c.city, stadium: c.stadium,
      colors: { primary: c.colors.primary, secondary: c.colors.secondary, kit: c.colors.kit },
      formation: c.tactics.formation,
      style: c.tactics.style
    };
  }
  return out;
}

// Campos de una apuesta que SÍ pueden viajar al cliente (nunca profileId/token).
function publicBet(bet) {
  if (!bet) return null;
  return {
    id: bet.id, matchId: bet.matchId, market: bet.market, selection: bet.selection,
    stake: bet.stake, odds: bet.oddsAtPlacement, status: bet.status,
    potentialPayout: bet.potentialPayout, inPlay: bet.inPlay, minuteAtPlacement: bet.minuteAtPlacement,
    payout: bet.payout, placedAt: bet.placedAt
  };
}

function registerFootballSockets(io, deps) {
  const {
    betting, engine, store, profiles,
    config = {}, log = () => {}, now = () => Date.now(),
    // Helpers del casino. Por defecto son permisivos para poder probar el módulo
    // en aislamiento; server.js DEBE inyectar los reales en la integración.
    ackOk = (ack, extra = {}) => { if (typeof ack === 'function') ack({ ok: true, ...extra }); },
    ackError = (ack, message, code) => { if (typeof ack === 'function') ack({ ok: false, error: message, code }); },
    cleanMessage = (text) => String(text == null ? '' : text).replace(/[<>]/g, '').trim().slice(0, 200),
    nameIssue = () => null,
    verifyTosAcceptance = () => true,
    commentate = null
  } = deps;

  const lobbyCap = config.lobbyCapacity || 200;
  const matchCap = config.matchCapacity || 40;
  const betDelayMs = config.betDelayMs || 4000;

  const roomMembers = new Map();      // room → Set(socketId) para el cupo
  const commentaryRings = new Map();  // matchId → [mensajes] (últimos 40)
  const commentaryMemory = new Map(); // matchId → memory de plantillas
  const scoreTrack = new Map();       // matchId → {home, away} para el {marcador} del relato
  const engineListeners = [];

  // --- Comentario (anillo por partido) ---
  function memoryFor(matchId) {
    if (!commentaryMemory.has(matchId)) commentaryMemory.set(matchId, createMemory());
    return commentaryMemory.get(matchId);
  }
  function pushCommentary(matchId, messages) {
    if (!messages || !messages.length) return [];
    const ring = commentaryRings.get(matchId) || [];
    for (const m of messages) ring.push({ ...m, at: now() });
    const trimmed = ring.slice(-COMMENTARY_RING);
    commentaryRings.set(matchId, trimmed);
    return messages;
  }
  // Marcador corrido por partido, para el {marcador} del relato. Se reinicia en el
  // kickoff (t=0), así un catch-up/replay que vuelve a emitir los eventos desde el
  // principio no duplica goles: kickoff pone 0-0 y los goles siguientes re-suman.
  function trackScore(matchId, event) {
    if (!scoreTrack.has(matchId) || event.type === 'kickoff') scoreTrack.set(matchId, { home: 0, away: 0 });
    const sc = scoreTrack.get(matchId);
    if (event.type === 'goal' || event.type === 'penalty_scored') {
      if (event.team === 'away') sc.away++; else sc.home++;
    }
    return sc;
  }

  // Mapea un evento del motor a las variables que esperan las plantillas de
  // relato (§9): {equipo} {rival} {equipoRival} {jugador} {asistencia} {minuto}
  // {marcador} {estadio} {xg} {xgFavor}. Los eventos YA traen playerName/assistName
  // resueltos por el match-engine, así que no hace falta consultar los squads.
  // Las vars ausentes (posesión, tiros, puesto) simplemente dejan fuera las
  // plantillas que las exigen (satisfied en commentary.js); el resto se usa.
  function buildVars(match, event, sc) {
    const home = CLUB_BY_ID[match.homeId] || {};
    const away = CLUB_BY_ID[match.awayId] || {};
    const attack = event.team === 'away' ? away : home;
    const defend = event.team === 'away' ? home : away;
    const vars = {
      equipo: attack.name, rival: defend.name, equipoRival: defend.name,
      estadio: home.stadium,
      minuto: Math.round(event.t != null ? event.t : 0),
      marcador: formatScore(sc)
    };
    if (event.playerName) vars.jugador = event.playerName;
    if (event.assistName) vars.asistencia = event.assistName;
    if (event.playerOutName) vars.sale = event.playerOutName;
    if (event.xg != null) { const x = Number(event.xg).toFixed(2); vars.xg = x; vars.xgFavor = x; }
    return vars;
  }

  function commentateEvent(match, event, sc) {
    // La narración sellada por match-engine viaja con el mismo evento autoritativo
    // que movió balón/marcador. No se vuelve a sortear al retransmitirlo.
    if (event && Array.isArray(event.commentary)) return event.commentary;
    if (!match) return [];
    if (commentate) return commentate(match, event, memoryFor(match.id)) || [];
    // Compatibilidad temporal con eventos antiguos sin campo commentary.
    const random = mulberry32(hash32(`${match.seed}|cmt|${event.type}|${Math.round((event.t != null ? event.t : 0) * 100)}|${event.team || ''}`));
    try { return generateCommentary(event.type, buildVars(match, event, sc), random, memoryFor(match.id)) || []; }
    catch (_) { return []; }
  }

  // --- Cupo de rooms (§14.1) ---
  function roomSize(room) { return (roomMembers.get(room) || new Set()).size; }
  function joinRoom(socket, room, cap) {
    if (roomSize(room) >= cap) return false;
    if (!roomMembers.has(room)) roomMembers.set(room, new Set());
    roomMembers.get(room).add(socket.id);
    if (typeof socket.join === 'function') socket.join(room);
    return true;
  }
  function leaveRoom(socket, room) {
    roomMembers.get(room)?.delete(socket.id);
    if (typeof socket.leave === 'function') socket.leave(room);
  }
  function leaveAll(socket) {
    for (const room of [...roomMembers.keys()]) {
      if (roomMembers.get(room).has(socket.id)) leaveRoom(socket, room);
    }
  }

  // --- Constructores de payload (solo estado revelado) ---
  function todayMatches(atMs = now()) {
    const date = new Date(atMs);
    const parts = calendarParts(date, CASINO_TIME_ZONE);
    const month = monthKey(date);
    return store.getMatches(month).filter(m => Number(m.day) === Number(parts.day));
  }

  function buildLobby() {
    const serverNow = now();
    const month = store.getCurrentSeasonMonth();
    const matches = todayMatches(serverNow).map(m => ({
      id: m.id, jornada: m.jornada, block: m.block, featured: Boolean(m.featured),
      homeId: m.homeId, awayId: m.awayId, status: m.status,
      scheduledKickoffAt: m.scheduledKickoffAt, day: m.day,
      result: m.status === 'settled' || m.status === 'finished' ? m.result : null,
      minute: LIVE_STATUSES.includes(m.status) ? safeMinute(m) : null
    }));
    const next = matches.filter(m => m.status === 'scheduled').sort((a, b) => a.scheduledKickoffAt - b.scheduledKickoffAt)[0] || null;
    return {
      seasonMonth: month,
      serverNow,
      matches,
      standings: store.getStandings(month),
      nextKickoffAt: next ? next.scheduledKickoffAt : null,
      countdownMs: next ? Math.max(0, next.scheduledKickoffAt - serverNow) : null,
      featured: (matches.find(m => m.featured) || null) && (matches.find(m => m.featured) || {}).id || null
    };
  }

  function safeMinute(match) {
    try { return engine.deriveMatchState(match, now()).minute; } catch (_) { return null; }
  }

  function buildMatchState(matchId, profileId) {
    const match = store.getMatch(matchId);
    if (!match) return null;
    let derived = null;
    try { derived = engine.deriveMatchState(match, now()); } catch (_) { derived = null; }
    const state = derived ? derived.state : null;
    const inPlay = match && LIVE_STATUSES.includes(match.status) && state;
    const markets = buildMarkets(match, inPlay ? {
      minute: derived.minute, score: state.score, matchEnd: derived.matchEnd,
      redCards: state.redCards, playStopped: state.playStopped
    } : {});
    const own = profileId ? betting.getBetsForProfile(profileId) : { bets: [], parlays: [], futures: [] };
    return {
      match: {
        id: match.id, jornada: match.jornada, block: match.block, featured: Boolean(match.featured),
        homeId: match.homeId, awayId: match.awayId, status: match.status,
        scheduledKickoffAt: match.scheduledKickoffAt,
        result: match.status === 'settled' || match.status === 'finished' ? match.result : null
      },
      // Estado ya ocurrido (marcador, cancha y jugadores); nunca se envía el timeline futuro.
      state: state ? {
        minute: state.minute, displayMinute: state.displayMinute, half: state.half, phase: state.phase, score: state.score,
        stats: { xG: state.xG, possession: state.possession, shots: state.shots, shotsOnTarget: state.shotsOnTarget, corners: state.corners, fouls: state.fouls },
        cards: state.cards, redCards: state.redCards, ball: state.ball,
        possessionTeam: state.possessionTeam, ballCarrierId: state.ballCarrierId,
        formation: state.formation, players: publicPlayers(state.players), roster: state.roster,
        playStopped: state.playStopped, lastAction: state.lastAction
      } : null,
      commentary: (commentaryRings.get(matchId) || []).slice(-COMMENTARY_RING),
      markets,
      myBets: own.bets.filter(b => b.matchId === matchId).map(publicBet),
      suspended: Boolean(inPlay && state.playStopped)
    };
  }

  function buildMarkets(match, state = {}) {
    const out = {};
    const keys = match && LIVE_STATUSES.includes(match.status) && state.minute != null
      ? ['1x2'] : ['1x2', 'double_chance', 'over_under_1.5', 'over_under_2.5', 'over_under_3.5', 'btts', 'correct_score', 'win_to_nil_home', 'win_to_nil_away', 'handicap_home_minus1', 'handicap_home_plus1', 'team_total_home_0.5', 'team_total_home_1.5', 'team_total_away_0.5', 'team_total_away_1.5'];
    for (const key of keys) {
      const mkt = betting.getMarket(match, key, state);
      if (mkt) out[key] = mkt.selections.map(s => ({ key: s.key, price: s.price, implied: s.implied }));
    }
    return out;
  }

  function buildTick(state, minute) {
    // Subset revelado para el tick de 2 s (§14.2).
    return {
      minute, displayMinute: state.displayMinute, score: state.score,
      phase: state.phase, half: state.half, ball: state.ball,
      possession: state.possession, possessionTeam: state.possessionTeam,
      ballCarrierId: state.ballCarrierId, players: publicPlayers(state.players),
      playStopped: state.playStopped
    };
  }

  // --- Handlers por conexión ---
  function identityOf(socket) {
    const id = socket.data && socket.data.football;
    if (!id || !id.profileId) return null;
    return profiles.getProfile(id.profileId); // lectura estricta, NUNCA getOrCreate
  }

  io.on('connection', (socket) => {
    socket.data = socket.data || {};

    socket.on('football:subscribe', (payload = {}, ack) => {
      try {
        const { scope, matchId, name, token, tos, avatar } = payload || {};
        const id = String(token == null ? '' : token).slice(0, 80);
        if (!id) return ackError(ack, 'token requerido', 'token_required');
        if (scope === 'match' && !matchId) return ackError(ack, 'matchId requerido', 'match_required');
        // Unicidad global de nombres ANTES de crear nada (T38).
        const issue = nameIssue(name, { exceptId: id });
        if (issue) return ackError(ack, issue, 'name_taken');
        // ÚNICA puerta que resuelve identidad (A11).
        const profile = profiles.getOrCreate(id, name, avatar);
        if (!profile) return ackError(ack, 'no se pudo resolver la identidad', 'identity_error');
        if (!verifyTosAcceptance(profile, tos)) return ackError(ack, TOS_REQUIRED, 'tos_required');
        socket.data.football = { profileId: profile.id, name: profile.name, avatar: profile.avatar };
        // Sala directa del perfil: por aquí llegan sus liquidaciones (§14.2).
        if (typeof socket.join === 'function') socket.join(profileRoom(profile.id));

        if (scope === 'match') {
          if (!joinRoom(socket, matchRoom(matchId), matchCap)) return ackError(ack, 'el partido está lleno', 'room_full');
          ackOk(ack, { scope: 'match', teams: publicTeams(), matchState: buildMatchState(matchId, profile.id), profile: { id: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips } });
        } else {
          if (!joinRoom(socket, LOBBY_ROOM, lobbyCap)) return ackError(ack, 'el lobby está lleno', 'room_full');
          ackOk(ack, { scope: 'lobby', teams: publicTeams(), lobby: buildLobby(), profile: { id: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips } });
        }
      } catch (error) {
        log('football_subscribe_error', { message: String(error && error.message || error) });
        ackError(ack, 'error al suscribir', 'internal');
      }
    });

    socket.on('football:unsubscribe', (payload = {}) => {
      const { scope, matchId } = payload || {};
      if (scope === 'match' && matchId) leaveRoom(socket, matchRoom(matchId));
      else leaveRoom(socket, LOBBY_ROOM);
    });

    socket.on('football:bet', async (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity'); // A11: nunca del payload
      try {
        const { matchId, market, selection, stake, idemKey } = payload || {};
        const match = store.getMatch(matchId);
        const state = liveStateFor(match);
        const result = await betting.placeBet({ profile, deviceToken: null, matchId, market, selection, stake, state, idempotencyKey: idemKey || null });
        if (!result.ok) return ackError(ack, result.code, result.code);
        ackOk(ack, { bet: publicBet(result.bet), chips: profile.chips, replayed: Boolean(result.replayed) });
        broadcastOdds(matchId, market, state);
      } catch (error) {
        log('football_bet_error', { message: String(error && error.message || error) });
        ackError(ack, 'error al apostar', 'internal');
      }
    });

    socket.on('football:cashout', (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity');
      const { betId } = payload || {};
      const bet = store.getBet(betId);
      if (!bet || bet.profileId !== profile.id) return ackError(ack, 'apuesta ajena o inexistente', 'not_your_bet');
      const match = store.getMatch(bet.matchId);
      const result = betting.cashout(profile, betId, liveStateFor(match));
      if (!result.ok) return ackError(ack, result.code, result.code);
      ackOk(ack, { betId, cashout: result.cashout, chips: profile.chips });
    });

    socket.on('football:parlay', async (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity');
      const { legs, stake, idemKey } = payload || {};
      const result = await betting.placeParlay({ profile, legs, stake, idempotencyKey: idemKey || null });
      if (!result.ok) return ackError(ack, result.code, result.code);
      ackOk(ack, { parlay: result.parlay, chips: profile.chips });
    });

    socket.on('football:future', async (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity');
      const { market, selection, stake, idemKey } = payload || {};
      const month = store.getCurrentSeasonMonth();
      const result = await betting.placeFuture({ profile, seasonMonth: month, market, selection, odds: Number(payload.odds) || 1, stake, placedAtJornada: Number(payload.jornada) || 0, idempotencyKey: idemKey || null });
      if (!result.ok) return ackError(ack, result.code, result.code);
      ackOk(ack, { future: result.future, chips: profile.chips });
    });

    socket.on('football:reaction', (payload = {}) => {
      const identity = socket.data.football;
      if (!identity) return;
      const { matchId, emoji } = payload || {};
      if (!matchId || !emoji) return;
      io.to(matchRoom(matchId)).emit('football:reaction', { matchId, emoji, from: identity.name });
    });

    socket.on('football:chat', (payload = {}, ack) => {
      const identity = socket.data.football;
      if (!identity) return ackError(ack, 'no suscrito', 'no_identity');
      const { matchId, text } = payload || {};
      const clean = cleanMessage(text);
      if (!clean) return ackError(ack, 'mensaje vacío', 'empty');
      io.to(matchRoom(matchId)).emit('football:chat', { matchId, text: clean, name: identity.name, at: now() });
      ackOk(ack, {});
    });

    socket.on('disconnect', () => { leaveAll(socket); });
  });

  function liveStateFor(match) {
    if (!match || !LIVE_STATUSES.includes(match.status)) return {};
    try {
      const derived = engine.deriveMatchState(match, now());
      return {
        minute: derived.minute, score: derived.state.score, matchEnd: derived.matchEnd,
        redCards: derived.state.redCards, phase: derived.state.phase,
        playStopped: derived.state.playStopped
      };
    } catch (_) { return {}; }
  }

  function publishLiveOdds(matchId, state = null) {
    const match = store.getMatch(matchId);
    if (!match || !LIVE_STATUSES.includes(match.status)) return;
    broadcastOdds(matchId, '1x2', state || liveStateFor(match));
  }

  // --- Difusión de eventos del motor (§14.2) ---
  function onEngine(event, handler) {
    engine.on(event, handler);
    engineListeners.push([event, handler]);
  }

  onEngine('football:tick', ({ matchId, state, minute, matchEnd }) => {
    io.to(matchRoom(matchId)).emit('football:tick', { matchId, ...buildTick(state, minute) });
    publishLiveOdds(matchId, {
      minute, score: state.score, matchEnd,
      redCards: state.redCards, phase: state.phase, playStopped: state.playStopped
    });
  });

  onEngine('football:event', ({ matchId, event, catchUp, replay }) => {
    const match = store.getMatch(matchId);
    const room = matchRoom(matchId);
    const sc = trackScore(matchId, event); // una sola vez por evento
    const messages = commentateEvent(match, event, sc);
    pushCommentary(matchId, messages);
    io.to(room).emit('football:event', { matchId, event: publicEvent(event, sc), catchUp, replay, importance: importanceOf(event) });
    for (const m of messages) io.to(room).emit('football:commentary', { matchId, ...m });
    if (event && ['kickoff', 'restart', 'goal_restart', 'second_half', 'penalty_missed'].includes(event.type)) publishLiveOdds(matchId);
  });

  onEngine('football:goal', ({ matchId, event }) => {
    io.to(matchRoom(matchId)).emit('football:goal', { matchId, event: publicEvent(event, scoreTrack.get(matchId)) });
  });

  onEngine('football:status', ({ matchId, code, minute }) => {
    io.to(matchRoom(matchId)).emit('football:status', { matchId, code, minute });
    io.to(LOBBY_ROOM).emit('football:lobby', buildLobby());
    publishLiveOdds(matchId);
  });

  // Relevancia de un evento (§14.2): permite al cliente priorizar (banner de gol,
  // campana en tarjetas) sin inspeccionar el tipo uno por uno.
  function importanceOf(event) {
    const t = event && event.type;
    if (t === 'goal' || t === 'penalty_scored' || t === 'red_card' || t === 'second_yellow' || t === 'penalty_awarded') return 'high';
    if (t === 'shot_on_target' || t === 'big_chance' || t === 'yellow_card' || t === 'penalty_missed' || t === 'substitution') return 'medium';
    return 'normal';
  }

  function publicPlayers(players) {
    return (Array.isArray(players) ? players : []).map(player => ({
      id: player.id, team: player.team, name: player.name, number: player.number,
      pos: player.pos, role: player.role, slotIndex: player.slotIndex, x: player.x, y: player.y,
      status: player.status, active: Boolean(player.active)
    }));
  }

  // Evento crudo → versión pública (sin campos internos; solo lo revelado).
  function publicEvent(event, sc) {
    if (!event) return null;
    const out = {
      t: event.t, type: event.type, team: event.team,
      minute: event.t != null ? Math.round(event.t) : null,
      importance: importanceOf(event)
    };
    if (event.i != null) out.id = event.i;
    if (event.playerId != null) out.playerId = event.playerId;
    if (event.playerName) out.playerName = event.playerName;
    if (event.assistId != null) out.assistId = event.assistId;
    if (event.assistName) out.assistName = event.assistName;
    if (event.playerInId != null) out.playerInId = event.playerInId;
    if (event.playerInName) out.playerInName = event.playerInName;
    if (event.playerOutId != null) out.playerOutId = event.playerOutId;
    if (event.playerOutName) out.playerOutName = event.playerOutName;
    if (event.receiverId != null) out.receiverId = event.receiverId;
    if (event.receiverName) out.receiverName = event.receiverName;
    if (event.xg != null) out.xg = Number(event.xg);
    if (event.scored != null) out.scored = Boolean(event.scored);
    if (event.outcome) out.outcome = event.outcome;
    if (event.resultado) out.resultado = event.resultado;
    if (event.marcadorTanda) out.marcadorTanda = event.marcadorTanda;
    if (event.ball && Number.isFinite(event.ball.x) && Number.isFinite(event.ball.y)) out.ball = { x: event.ball.x, y: event.ball.y };
    if (event.ballFrom) out.ballFrom = { x: event.ballFrom.x, y: event.ballFrom.y };
    if (event.ballVelocity) out.ballVelocity = { x: event.ballVelocity.x, y: event.ballVelocity.y };
    if (event.actorPosition) out.actorPosition = { x: event.actorPosition.x, y: event.actorPosition.y };
    if (event.keeperId != null) out.keeperId = event.keeperId;
    if (event.keeperPosition) out.keeperPosition = { x: event.keeperPosition.x, y: event.keeperPosition.y };
    if (event.ballAction) out.ballAction = event.ballAction;
    if (Object.prototype.hasOwnProperty.call(event, 'ballCarrierId')) out.ballCarrierId = event.ballCarrierId;
    if (Object.prototype.hasOwnProperty.call(event, 'possessionTeam')) out.possessionTeam = event.possessionTeam;
    if (event.phase) out.phase = event.phase;
    out.playStopped = ['goal_celebration', 'set_piece', 'halftime', 'ended', 'shootout'].includes(event.phase)
      || ['full_time', 'extra_time_end', 'shootout_end'].includes(event.type);
    if (event.formation) out.formation = event.formation;
    if (event.crossedGoalLine != null) out.crossedGoalLine = Boolean(event.crossedGoalLine);
    if (event.restartType) out.restartType = event.restartType;
    if (event.cornerSide) out.cornerSide = event.cornerSide;
    if (event.lineSide) out.lineSide = event.lineSide;
    if (event.half != null) out.half = event.half;
    if (event.marcador) out.marcador = event.marcador;
    else if (sc) out.marcador = formatScore(sc);
    return out;
  }

  // Difunde las cuotas vigentes de un mercado a la sala del partido.
  function broadcastOdds(matchId, marketKey, state = {}) {
    const match = store.getMatch(matchId);
    if (!match) return;
    const mkt = betting.getMarket(match, marketKey, state);
    if (!mkt) return;
    io.to(matchRoom(matchId)).emit('football:odds', {
      matchId, market: marketKey,
      selections: mkt.selections.map(s => ({ key: s.key, price: s.price, implied: s.implied })),
      suspended: mkt.suspended, betDelay: betDelayMs
    });
  }

  // Notifica una liquidación al socket del perfil (lo llama betting vía log en la
  // integración). payload: { betId, profileId, status, payout, reason }.
  function broadcastSettlement({ profileId, betId, status, payout, reason }) {
    if (!profileId) return;
    io.to(profileRoom(profileId)).emit('football:settlement', { betId, status, payout, reason });
  }

  function stop() {
    for (const [event, handler] of engineListeners) engine.off(event, handler);
    engineListeners.length = 0;
    roomMembers.clear();
  }

  return {
    stop, broadcastOdds, broadcastSettlement, buildLobby, buildMatchState, publicBet,
    roomSize, commentaryRings, LOBBY_ROOM, matchRoom
  };
}

module.exports = { registerFootballSockets, publicBet, publicTeams, LOBBY_ROOM, matchRoom, profileRoom, COMMENTARY_RING, LIVE_STATUSES };
