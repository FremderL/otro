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
const fantasy = require('./fantasy');
const fanClub = require('./fan-club');
const { publicTransfers } = require('./transfers');
const { publicFanPin } = require('./fan-club-profile');
const { moderationMessage } = require('../moderation');
const { seatIdentity } = require('../seat-identity');
const { mulberry32, hash32 } = require('./prng');
const { CLUB_BY_ID } = require('./teams');
const { createStands } = require('./stands');
const { ballonDorFinalizationSchedule, ballonDorResultAnnouncementAt } = require('./ballon-dor-market');
const { matchRealMs, zonedTimeToMs } = require('./fixtures');
const { footballSeasonResetGate } = require('./reset-gate');
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
      id, name: c.name, short: c.abbr || c.short, abbr: c.abbr || c.short,
      city: c.city, stadium: c.stadium,
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

function publicFuture(future) {
  if (!future) return null;
  return {
    id: future.id, market: future.market, selection: future.selection,
    stake: future.stake, odds: future.odds, potentialPayout: future.potentialPayout,
    status: future.status, payout: future.payout, placedAt: future.placedAt,
    seasonMonth: future.seasonMonth
  };
}

function registerFootballSockets(io, deps) {
  const {
    betting, engine, store, profiles, ballonDorMarket = null, accountSessionsEnabled = false, onFanChanged = () => {},
    config = {}, log = () => {}, now = () => Date.now(),
    // Helpers del casino. Por defecto son permisivos para poder probar el módulo
    // en aislamiento; server.js DEBE inyectar los reales en la integración.
    ackOk = (ack, extra = {}) => { if (typeof ack === 'function') ack({ ok: true, ...extra }); },
    ackError = (ack, message, code) => { if (typeof ack === 'function') ack({ ok: false, error: message, code }); },
    cleanMessage = (text) => String(text == null ? '' : text).replace(/[<>]/g, '').trim().slice(0, 200),
    nameIssue = () => null,
    verifyTosAcceptance = () => true,
    onBetPlaced = () => {},
    commentate = null
  } = deps;

  // Grada: moderación opt-in por votación (lib/football/stands.js). Vive en
  // memoria del proceso junto a las salas: la autorización es efímera y por
  // partido, así que no toca el almacén de temporada.
  const stands = createStands(store, { now, log });
  const standsCodes = {
    match_requerido: 'Elige un partido para la votación.',
    ya_permitido: 'La grada ya habilitó los insultos en este partido.',
    votacion_en_curso: 'Ya hay una votación en curso.',
    espera_para_repetir: 'Espera un momento antes de repetir la votación.',
    votacion_cerrada: 'La votación ya cerró.',
    ya_votaste: 'Ya votaste en esta votación.',
    sin_votacion: 'No hay ninguna votación en curso.'
  };
  function standsCodeMessage(code) { return standsCodes[code] || 'No se pudo registrar el voto.'; }
  function publishStands(matchId, profileId = null) {
    io.to(matchRoom(matchId)).emit('football:stands_state', {
      matchId, stands: stands.stateFor(matchId), yourVote: profileId == null ? null : stands.stateFor(matchId, profileId)?.yourVote || null
    });
  }

  const lobbyCap = config.lobbyCapacity || 200;
  const matchCap = config.matchCapacity || 40;
  const betDelayMs = config.betDelayMs || 4000;
  function notifyBetPlaced(details) {
    try { onBetPlaced(details); }
    catch (error) { log('football_bet_placement_hook_error', { message: String(error && error.message || error) }); }
  }

  // Ranking anónimo: caché corta y revocación inmediata al cambiar consentimiento.
  let fantasyRankingCache = null;
  const fantasyQueues = new Map();
  function fantasyTable(league) {
    const time = Date.now();
    if (!fantasyRankingCache || fantasyRankingCache.season !== league.seasonMonth || time - fantasyRankingCache.at > 3000) {
      fantasyRankingCache = { season:league.seasonMonth, at:time, value:fantasy.ranking(profiles.profiles, league) };
    }
    return fantasyRankingCache.value;
  }
  function fantasySnapshot(profile, league) {
    return fantasy.snapshot(profile, league, profiles.profiles, now(), fantasyTable(league));
  }
  function enqueueFantasy(profileId, task) {
    const prior = fantasyQueues.get(profileId) || Promise.resolve();
    const work = prior.catch(() => {}).then(task);
    fantasyQueues.set(profileId, work);
    work.finally(() => { if (fantasyQueues.get(profileId) === work) fantasyQueues.delete(profileId); }).catch(() => {});
    return work;
  }

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
    if (event.added != null) vars.agregado = event.added; // tiempo agregado del árbitro
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

  // Inicio del mes siguiente en hora local del casino: el instante en que el
  // casino cierra la temporada y reinicia las fichas (§5.2). Si quedan apuestas
  // de fútbol abiertas el reset se aplaza, y el payload lo dice.
  function nextMonthStartAt(atMs) {
    const parts = calendarParts(new Date(atMs), CASINO_TIME_ZONE);
    const year = Number(parts.year);
    const month = Number(parts.month);
    return zonedTimeToMs({
      year: month === 12 ? year + 1 : year,
      month: month === 12 ? 1 : month + 1,
      day: 1, hour: 0, minute: 0, second: 0
    }, CASINO_TIME_ZONE);
  }

  // Cuentas regresivas del Estadio: fin de temporada del casino (reinicio de
  // fichas) y ciclo del Balón de Oro (cierre de apuestas J20 + ceremonia de las
  // 22:00 posteriores al último partido). Todo son instantes absolutos en ms:
  // el cliente solo resta contra el reloj del servidor que ya recibe.
  function buildCountdowns(serverNow, month) {
    const resetAt = nextMonthStartAt(serverNow);
    let resetDeferred = false;
    try { resetDeferred = Boolean(footballSeasonResetGate(store, month)); } catch (_) { resetDeferred = false; }
    const countdowns = {
      serverNow,
      casino: { seasonMonth: month, endsAt: resetAt, chipsResetAt: resetAt, resetDeferred },
      ballonDor: null
    };
    // El ciclo del Balón de Oro se lee del almacén (no del contrato público del
    // mercado: ese se reserva para la petición del cliente y no debe pagarse dos
    // veces por refresco del lobby).
    const bdoEvent = typeof store.getBallonDor === 'function' ? store.getBallonDor(month) : null;
    if (bdoEvent) {
      const j20 = store.getMatches(month)
        .filter(m => m && !m.desempate && Number(m.jornada) === 20 && Number(m.scheduledKickoffAt) > 0);
      const ends = j20.map(match => {
        // Es solo una estimación pública, jamás el agregado privado del replay.
        const v2 = Boolean(match.simulation) || (betting.officialV2 && match.seasonMonth >= '2026-11'
          && !betting.officialV2.requiresLegacy(match));
        const duration = v2 ? 90 * 15 * 1000 : matchRealMs();
        return Number(match.scheduledKickoffAt) + duration;
      });
      const estimatedEnd = ends.length ? Math.max(...ends) : null;
      let ceremonyAt = null;
      try { ceremonyAt = ballonDorResultAnnouncementAt(store, bdoEvent, CASINO_TIME_ZONE); } catch (_) { ceremonyAt = null; }
      if (ceremonyAt == null) {
        try {
          ceremonyAt = ballonDorFinalizationSchedule(store, bdoEvent, CASINO_TIME_ZONE)?.scheduledAt ?? null;
        } catch (_) { ceremonyAt = null; }
      }
      countdowns.ballonDor = {
        seasonMonth: month,
        status: bdoEvent.status,
        betsOpen: bdoEvent.status === 'active',
        betsCloseAfterJornada: 20,
        // El bloqueo real ocurre al asentarse el último partido, no al vencer esta estimación.
        betsCloseAt: estimatedEnd,
        betsCloseEstimated: true,
        ceremonyAt: bdoEvent.status === 'settled' ? null : ceremonyAt,
        settledAt: bdoEvent.status === 'settled' && bdoEvent.result ? bdoEvent.result.finalizedAt : null
      };
    }
    return countdowns;
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
      countdowns: buildCountdowns(serverNow, month),
      featured: (matches.find(m => m.featured) || null) && (matches.find(m => m.featured) || {}).id || null
    };
  }

  function safeMinute(match) {
    try {
      const minute = engine.deriveMatchState(match, now()).minute;
      return Number.isFinite(minute) ? Math.max(0, Math.floor(minute)) : null;
    } catch (_) { return null; }
  }

  // Marcador oficial de un partido ya cerrado. La ficha del partido (marcador,
  // cancha y resumen) se pinta SIEMPRE con él: el resultado asentado es la única
  // fuente autoritativa (§15.4) y ninguna regeneración de la línea de tiempo
  // puede hacer que la pantalla muestre un marcador distinto al de la tabla.
  function officialScore(match) {
    if (!match || !(match.status === 'settled' || match.status === 'finished')) return null;
    const result = match.result;
    if (!result) return null;
    const home = Number(result.home);
    const away = Number(result.away);
    if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
    return { home, away };
  }

  function buildMatchState(matchId, profileId) {
    const match = store.getMatch(matchId);
    if (!match) return null;
    let derived = null;
    try { derived = engine.deriveMatchState(match, now()); } catch (_) { derived = null; }
    const state = derived ? derived.state : null;
    const official = officialScore(match);
    const inPlay = match && LIVE_STATUSES.includes(match.status) && state;
    const markets = buildMarkets(match, inPlay ? {
      minute: derived.minute, score: state.score, matchEnd: derived.matchEnd,
      half: state.half, redCards: state.redCards, phase: state.phase, playStopped: state.playStopped
    } : {});
    const own = profileId ? betting.getBetsForProfile(profileId) : { bets: [], parlays: [], futures: [] };
    let commentary = (commentaryRings.get(matchId) || []).slice(-COMMENTARY_RING);
    // Tras un reinicio la memoria está vacía. Reconstruir únicamente el
    // prefijo ya revelado evita perder el relato sin filtrar eventos futuros.
    if (match.simulation && derived && derived.revealedIndex >= 0 && commentary.length === 0) {
      try {
        commentary = engine._ensureTimeline(match).timeline.slice(0, derived.revealedIndex + 1)
          .flatMap(event => Array.isArray(event.commentary) ? event.commentary : []).slice(-COMMENTARY_RING);
      } catch (_) { commentary = []; }
    }
    return {
      match: {
        id: match.id, jornada: match.jornada, block: match.block, featured: Boolean(match.featured),
        homeId: match.homeId, awayId: match.awayId, status: match.status,
        scheduledKickoffAt: match.scheduledKickoffAt,
        ...(match.simulation ? { engine: 'v2', secondsPerMinute: 15 } : {}),
        result: match.status === 'settled' || match.status === 'finished' ? match.result : null,
        highlights: match.status === 'settled' ? match.highlights || null : null
      },
      // Estado ya ocurrido (marcador, cancha y jugadores); nunca se envía el timeline futuro.
      state: state ? {
        minute: state.minute, displayMinute: state.displayMinute, clockLabel: state.clockLabel, half: state.half, phase: state.phase,
        score: official || state.score,
        ...(state.shootout ? { shootout: state.shootout } : {}),
        stats: { xG: state.xG, possession: state.possession, shots: state.shots, shotsOnTarget: state.shotsOnTarget, corners: state.corners, fouls: state.fouls },
        cards: state.cards, redCards: state.redCards, ball: state.ball,
        possessionTeam: state.possessionTeam, ballCarrierId: state.ballCarrierId,
        formation: state.formation, players: publicPlayers(state.players), roster: state.roster,
        playStopped: state.playStopped, lastAction: state.lastAction
      } : null,
      commentary,
      // Estado de la votación de la grada.
      stands: stands.stateFor(matchId, profileId),
      markets,
      myBets: own.bets.filter(b => b.matchId === matchId).map(publicBet),
      suspended: Boolean(inPlay && state.playStopped)
    };
  }

  function buildMarkets(match, state = {}) {
    const out = {};
    // En vivo solo hay precio de 1X2 (§11.2). Antes del partido se publica el
    // catálogo entero, incluidas las líneas del hándicap asiático, que dependen
    // del partido: sale de betting.marketKeysFor y nunca de una lista fija.
    const inPlay = Boolean(match && LIVE_STATUSES.includes(match.status) && state.minute != null);
    const keys = inPlay ? ['1x2']
      : (typeof betting.marketKeysFor === 'function' ? betting.marketKeysFor(match) : []);
    for (const key of keys) {
      const mkt = betting.getMarket(match, key, state);
      if (mkt) out[key] = mkt.selections.map(s => ({ key: s.key, price: s.price, implied: s.implied, ...(s.label ? { label: s.label } : {}) }));
    }
    return out;
  }

  function buildTick(state, minute) {
    // Subset revelado para el tick de 2 s (§14.2).
    return {
      minute, displayMinute: state.displayMinute, ...(state.clockLabel != null ? { clockLabel: state.clockLabel } : {}), score: state.score,
      ...(state.shootout ? { shootout: state.shootout } : {}),
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
    const profile = profiles.getProfile(id.profileId); // lectura estricta, NUNCA getOrCreate
    return profile && !moderationMessage(profile, now()) ? profile : null;
  }

  io.on('connection', (socket) => {
    socket.data = socket.data || {};

    socket.on('football:subscribe', (payload = {}, ack) => {
      try {
        const { scope, matchId, name, token, tos, avatar } = payload || {};
        const id = seatIdentity({ accountSessionsEnabled, accountProfileId:socket.data.accountProfileId, token });
        if (!id) return ackError(ack, 'token requerido', 'token_required');
        if (scope === 'match' && !matchId) return ackError(ack, 'matchId requerido', 'match_required');
        const existing = profiles.getProfile(id);
        const verified = Boolean(accountSessionsEnabled && socket.data.accountProfileId === id);
        // Un ID de cuenta no es una credencial, ni siquiera si viene como token.
        if (accountSessionsEnabled && existing?.username && !verified) return ackError(ack, 'Inicia sesión para utilizar esta cuenta.', 'account_auth_required');
        if (!verified) {
          const issue = nameIssue(name, { exceptId: id });
          if (issue) return ackError(ack, issue, 'name_taken');
        }
        const profile = verified ? existing : profiles.getOrCreate(id, name, avatar);
        if (!profile) return ackError(ack, 'no se pudo resolver la identidad', 'identity_error');
        const blocked = moderationMessage(profile, now());
        if (blocked) return ackError(ack, blocked.error, blocked.code);
        if (!verifyTosAcceptance(profile, tos)) return ackError(ack, TOS_REQUIRED, 'tos_required');
        socket.data.football = { profileId: profile.id, name: profile.name, avatar: profile.avatar };
        // Sala directa del perfil: por aquí llegan sus liquidaciones (§14.2).
        if (typeof socket.join === 'function') socket.join(profileRoom(profile.id));

        if (scope === 'match') {
          if (!joinRoom(socket, matchRoom(matchId), matchCap)) return ackError(ack, 'el partido está lleno', 'room_full');
          ackOk(ack, { scope: 'match', teams: publicTeams(), matchState: buildMatchState(matchId, profile.id), profile: { id: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips, fanPin:publicFanPin(profile) } });
        } else {
          if (!joinRoom(socket, LOBBY_ROOM, lobbyCap)) return ackError(ack, 'el lobby está lleno', 'room_full');
          ackOk(ack, { scope: 'lobby', teams: publicTeams(), lobby: buildLobby(), profile: { id: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips, fanPin:publicFanPin(profile) } });
        }
      } catch (error) {
        log('football_subscribe_error', { message: String(error && error.message || error) });
        ackError(ack, 'error al suscribir', 'internal');
      }
    });

    // Mi Once no recibe identidades ni puntos del cliente. La sesión verificada
    // prevalece cuando está activa; el modo legado conserva su riesgo conocido.
    function fantasyIdentity() {
      if (!identityOf(socket)) return null;
      const profile = accountSessionsEnabled ? profiles.getProfile(socket.data.accountProfileId) : identityOf(socket);
      return profile && !moderationMessage(profile, now()) ? profile : null;
    }
    socket.on('football:quiniela_get', (_payload = {}, ack) => {
      if (!fantasyIdentity()) return ackError(ack, 'Primero entra al Estadio.', 'no_identity');
      const league = store.getLeague(store.getCurrentSeasonMonth());
      const day = league && fantasy.nextJornada(league, now());
      return ackOk(ack, { quiniela: { available:false, season:league?.seasonMonth || null,
        jornada:day?.jornada || null, closesAt:day?.closesAt || null,
        matches:(day?.matches || []).map(m => ({ id:m.id, homeId:m.homeId, awayId:m.awayId, scheduledKickoffAt:m.scheduledKickoffAt })) } });
    });
    socket.on('football:transfers_get', (_payload = {}, ack) => {
      if (!identityOf(socket)) return ackError(ack, 'Primero entra al Estadio.', 'no_identity');
      const league = store.getLeague(store.getCurrentSeasonMonth());
      return ackOk(ack, { transfers:publicTransfers(league, now()) });
    });
    socket.on('football:fantasy_get', (_payload = {}, ack) => {
      const profile = fantasyIdentity(), league = store.getLeague(store.getCurrentSeasonMonth());
      if (!profile) return ackError(ack, 'Primero entra al Estadio con tu cuenta.', 'no_identity');
      if (!league) return ackError(ack, 'Mi Once no está disponible.', 'unavailable');
      return ackOk(ack, { fantasy:fantasySnapshot(profile, league) });
    });
    socket.on('football:fantasy_save', async (payload = {}, ack) => {
      const profile = fantasyIdentity();
      if (!profile) return ackError(ack, 'Primero entra al Estadio con tu cuenta.', 'no_identity');
      try {
        return await enqueueFantasy(profile.id, async () => {
          const league = store.getLeague(store.getCurrentSeasonMonth());
          if (!league || payload.season !== league.seasonMonth) return ackError(ack, 'La temporada cambió; actualiza Mi Once.', 'season_changed');
          if (!verifyTosAcceptance(profile, payload.tos)) return ackError(ack, TOS_REQUIRED, 'tos_required');
          const result = fantasy.saveLineup(profile, league, payload.players, now());
          if (!result.ok) return ackError(ack, result.code === 'no_open_jornada' ? 'No hay otra jornada abierta.' : 'Elige 1 portero, 4 defensas, 4 medios y 2 delanteros distintos.', result.code);
          fantasyRankingCache = null;
          if (!await profiles.persistProfile(profile)) return ackError(ack, 'No se pudo confirmar el guardado; consulta Mi Once.', 'save_pending');
          return ackOk(ack, { fantasy:fantasySnapshot(profile, league), appliedJornada:result.jornada });
        });
      } catch (error) { log('fantasy_save_error', { message:String(error?.message || error) }); return ackError(ack, 'No se pudo guardar Mi Once.', 'save_error'); }
    });
    socket.on('football:fantasy_ranking_opt', async (payload = {}, ack) => {
      const profile = fantasyIdentity();
      if (!profile) return ackError(ack, 'Primero entra al Estadio con tu cuenta.', 'no_identity');
      if (typeof payload.enabled !== 'boolean') return ackError(ack, 'Opción inválida.', 'invalid_option');
      try {
        return await enqueueFantasy(profile.id, async () => {
          const league = store.getLeague(store.getCurrentSeasonMonth());
          if (!league) return ackError(ack, 'Mi Once no está disponible.', 'unavailable');
          const data = fantasy.cleanFantasy(profile.footballFantasy);
          profile.footballFantasy = data?.season === league.seasonMonth ? data : { season:league.seasonMonth, lineups:[], rankingOptIn:false };
          profile.footballFantasy.rankingOptIn = payload.enabled;
          fantasyRankingCache = null;
          if (!await profiles.persistProfile(profile)) return ackError(ack, 'No se pudo guardar la preferencia.', 'save_pending');
          return ackOk(ack, { fantasy:fantasySnapshot(profile, league) });
        });
      } catch (error) { log('fantasy_opt_error', { message:String(error?.message || error) }); return ackError(ack, 'No se pudo guardar la preferencia.', 'save_error'); }
    });

    // Afición nunca recibe victorias, premios o perfiles desde el cliente.
    function fanSnapshot(profile) {
      fanClub.syncProfiles(profiles.profiles, store.leagues, now(), p => profiles.touch(p));
      return fanClub.snapshot(profile, profiles.profiles, store.leagues, now());
    }
    socket.on('football:fan_get', (_payload = {}, ack) => {
      const profile = fantasyIdentity();
      if (!profile) return ackError(ack, 'Primero entra al Estadio con tu cuenta.', 'no_identity');
      return ackOk(ack, { fan:fanSnapshot(profile) });
    });
    socket.on('football:fan_select', async (payload = {}, ack) => {
      const profile = fantasyIdentity();
      if (!profile) return ackError(ack, 'Primero entra al Estadio con tu cuenta.', 'no_identity');
      try {
        return await enqueueFantasy(profile.id, async () => {
          if (!verifyTosAcceptance(profile, payload.tos)) return ackError(ack, TOS_REQUIRED, 'tos_required');
          const outcome = fanClub.select(profile, payload.clubId, payload.currentClubId, payload.confirmed, now());
          if (!outcome.ok) return ackError(ack, outcome.code === 'confirmation_required' ? 'Confirma que perderás el progreso y pines del club anterior.' : outcome.code === 'club_changed' ? 'Tu club cambió; consulta el estado antes de continuar.' : 'Elige un club válido.', outcome.code);
          if (!outcome.unchanged && !await profiles.persistProfile(profile)) return ackError(ack, 'No se pudo confirmar el guardado. Consulta Mi afición antes de reintentar.', 'save_pending');
          if (!outcome.unchanged) onFanChanged(profile);
          return ackOk(ack, { fan:fanSnapshot(profile) });
        });
      } catch (error) { log('fan_select_error', { message:String(error?.message || error) }); return ackError(ack, 'No se pudo guardar tu club.', 'save_error'); }
    });
    socket.on('football:fan_equip', async (payload = {}, ack) => {
      const profile = fantasyIdentity();
      if (!profile) return ackError(ack, 'Primero entra al Estadio con tu cuenta.', 'no_identity');
      try {
        return await enqueueFantasy(profile.id, async () => {
          const current = fanSnapshot(profile), fan = fanClub.cleanFanClub(profile.footballFanClub);
          if (!fan) return ackError(ack, 'Elige un club primero.', 'no_club');
          if (payload?.currentClubId !== fan.clubId) return ackError(ack, 'Tu club cambió; actualiza Mi afición.', 'club_changed');
          const pin = payload?.pin == null ? null : payload.pin;
          if (pin !== null && !current.rewards.some(reward => reward.id === pin && reward.unlocked)) return ackError(ack, 'Ese pin todavía no está desbloqueado.', 'pin_locked');
          profile.footballFanClub = { ...fan, equippedPin:pin };
          if (!await profiles.persistProfile(profile)) return ackError(ack, 'No se pudo confirmar el cambio; consulta Mi afición.', 'save_pending');
          onFanChanged(profile);
          return ackOk(ack, { fan:fanSnapshot(profile), fanPin:publicFanPin(profile) });
        });
      } catch (error) { log('fan_equip_error', { message:String(error?.message || error) }); return ackError(ack, 'No se pudo equipar el pin.', 'save_error'); }
    });
    socket.on('football:fan_ranking_opt', async (payload = {}, ack) => {
      const profile = fantasyIdentity();
      if (!profile) return ackError(ack, 'Primero entra al Estadio con tu cuenta.', 'no_identity');
      if (!payload || typeof payload.enabled !== 'boolean') return ackError(ack, 'Opción inválida.', 'invalid_option');
      try {
        return await enqueueFantasy(profile.id, async () => {
          const fan = fanClub.cleanFanClub(profile.footballFanClub);
          if (!fan) return ackError(ack, 'Elige un club primero.', 'no_club');
          if (payload.currentClubId !== fan.clubId) return ackError(ack, 'Tu club cambió; actualiza Mi afición.', 'club_changed');
          profile.footballFanClub = { ...fan, rankingOptIn:payload.enabled };
          if (!await profiles.persistProfile(profile)) return ackError(ack, 'No se pudo confirmar la preferencia.', 'save_pending');
          return ackOk(ack, { fan:fanSnapshot(profile) });
        });
      } catch (error) { log('fan_opt_error', { message:String(error?.message || error) }); return ackError(ack, 'No se pudo guardar la preferencia.', 'save_error'); }
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
        const result = await betting.placeBet({ profile, deviceToken: null, matchId, market, selection, stake, state,
          refreshState: () => liveStateFor(store.getMatch(matchId)), idempotencyKey: idemKey || null });
        if (!result.ok) return ackError(ack, result.code, result.code);
        ackOk(ack, { bet: publicBet(result.bet), chips: profile.chips, replayed: Boolean(result.replayed) });
        if (!result.replayed) notifyBetPlaced({ profileId: profile.id, kind: 'bet', stake: result.bet?.stake });
        broadcastOdds(matchId, market, state);
      } catch (error) {
        log('football_bet_error', { message: String(error && error.message || error) });
        ackError(ack, 'error al apostar', 'internal');
      }
    });

    socket.on('football:cashout', async (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity');
      const { betId } = payload || {};
      const bet = store.getBet(betId);
      if (!bet || bet.profileId !== profile.id) return ackError(ack, 'apuesta ajena o inexistente', 'not_your_bet');
      try {
        const match = store.getMatch(bet.matchId);
        const result = await betting.cashout(profile, betId, liveStateFor(match));
        if (!result.ok) return ackError(ack, result.code, result.code);
        ackOk(ack, { betId, cashout: result.cashout, chips: profile.chips });
      } catch (error) {
        log('football_cashout_error', { message: String(error?.message || error) });
        ackError(ack, 'error al cobrar', 'internal');
      }
    });

    socket.on('football:parlay', async (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity');
      const { legs, stake, idemKey } = payload || {};
      const result = await betting.placeParlay({ profile, legs, stake, idempotencyKey: idemKey || null });
      if (!result.ok) return ackError(ack, result.code, result.code);
      ackOk(ack, { parlay: result.parlay, chips: profile.chips, replayed: Boolean(result.replayed) });
      if (!result.replayed) notifyBetPlaced({ profileId: profile.id, kind: 'parlay', stake: result.parlay?.stake });
    });

    socket.on('football:futures_market', (_payload = {}, ack) => {
      const market = betting.futureMarket?.getMarket(store.getCurrentSeasonMonth());
      if (!market) return ackError(ack, 'mercado de futuros no disponible', 'market_unavailable');
      ackOk(ack, { market });
    });

    socket.on('football:future', async (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity');
      const { market, selection, stake, idemKey } = payload || {};
      const month = store.getCurrentSeasonMonth();
      const result = await betting.placeFuture({ profile, seasonMonth: month, market, selection, stake, idempotencyKey: idemKey || null });
      if (!result.ok) return ackError(ack, result.code, result.code);
      ackOk(ack, { future: publicFuture(result.future), chips: profile.chips, replayed: Boolean(result.replayed) });
      if (!result.replayed) notifyBetPlaced({ profileId: profile.id, kind: 'future', stake: result.future?.stake });
    });

    socket.on('football:ballon_dor_market', (payload = {}, ack) => {
      if (!ballonDorMarket?.getMarket) return ackError(ack, 'mercado no disponible', 'market_unavailable');
      const requestedMonth = payload && payload.seasonMonth;
      if (requestedMonth != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(requestedMonth))) {
        return ackError(ack, 'temporada inválida', 'season_month_invalid');
      }
      const seasonMonth = requestedMonth == null ? store.getCurrentSeasonMonth() : String(requestedMonth);
      ackOk(ack, { market: ballonDorMarket.getMarket(seasonMonth) });
    });

    socket.on('football:ballon_dor_bet', async (payload = {}, ack) => {
      const profile = identityOf(socket);
      if (!profile) return ackError(ack, 'no suscrito', 'no_identity');
      try {
        const selection = payload?.selection;
        const stake = payload?.stake;
        const idempotencyKey = payload?.idempotencyKey || payload?.idemKey;
        const result = await betting.placeBallonDorBet({ profile, selection, stake, idempotencyKey });
        if (!result.ok) return ackError(ack, result.code, result.code);
        ackOk(ack, {
          future: publicFuture(result.future), chips: profile.chips,
          replayed: Boolean(result.replayed)
        });
        if (!result.replayed) notifyBetPlaced({ profileId: profile.id, kind: 'future', stake: result.future?.stake });
      } catch (error) {
        log('football_ballon_dor_bet_error', { message: String(error?.message || error) });
        ackError(ack, 'error al apostar al Balón de Oro', 'internal');
      }
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
      if (!matchId) return ackError(ack, 'elige un partido', 'no_match');
      const atMs = now();
      // La autorización termina con el partido real, no con una duración
      // estimada que podría cortar V2 antes o prolongarse después del final.
      const fixture = store.getMatch(matchId);
      if (!fixture || !LIVE_STATUSES.includes(fixture.status)) stands.forget(matchId);
      // Grada normal: el texto pasa por el censor del casino. Grada "picante"
      // (votada por mayoría en ese partido): se publica tal cual, salvo los
      // términos que la votación nunca levanta (stands.js).
      const clean = stands.composeText(text, { matchId, atMs, censored: cleanMessage });
      if (!clean) return ackError(ack, 'mensaje vacío', 'empty');
      io.to(matchRoom(matchId)).emit('football:chat', {
        matchId, text: clean, name: identity.name, at: atMs,
        soft: stands.allowsInsults(matchId, atMs),
        id: `c_${atMs}_${hash32(`${matchId}|${identity.name}|${atMs}`)}`
      });
      ackOk(ack, {});
    });

    // --- Grada: votación para habilitar los insultos en ese partido ---
    socket.on('football:stands_open', (payload = {}, ack) => {
      const identity = socket.data.football;
      if (!identity) return ackError(ack, 'no suscrito', 'no_identity');
      const matchId = payload?.matchId;
      const match = matchId ? store.getMatch(matchId) : null;
      if (!match) return ackError(ack, 'partido no encontrado', 'no_match');
      if (!LIVE_STATUSES.includes(match.status)) return ackError(ack, 'la grada vota con el partido en juego', 'not_live');
      const wants = payload?.allow !== false;
      const atMs = now();
      // Reutiliza la votación abierta: abrir y votar en la misma acción.
      let opened = stands.stateFor(matchId);
      let result = null;
      if (!opened || opened.status !== 'open' || atMs >= (opened.closesAt || 0)) {
        // La vigencia se cierra con el estado oficial de fin/posposición. No
        // publicar ni usar como fecha la duración futura privada del replay.
        const open = stands.openVote({ matchId, profileId: identity.profileId || identity.name, atMs });
        if (!open.ok && open.code !== 'votacion_en_curso') return ackError(ack, standsCodeMessage(open.code), open.code);
      }
      result = stands.castVote({ matchId, profileId: identity.profileId || identity.name, allow: wants, atMs });
      if (!result.ok) return ackError(ack, standsCodeMessage(result.code), result.code);
      publishStands(matchId, identity.profileId || identity.name);
      ackOk(ack, { stands: stands.stateFor(matchId, identity.profileId || identity.name) });
    });

    socket.on('football:stands_vote', (payload = {}, ack) => {
      const identity = socket.data.football;
      if (!identity) return ackError(ack, 'no suscrito', 'no_identity');
      const matchId = payload?.matchId;
      if (!matchId) return ackError(ack, 'partido no encontrado', 'no_match');
      const match = store.getMatch(matchId);
      if (!match || !LIVE_STATUSES.includes(match.status)) {
        stands.forget(matchId);
        return ackError(ack, 'la grada vota con el partido en juego', 'not_live');
      }
      const allow = payload?.allow !== false;
      const result = stands.castVote({ matchId, profileId: identity.profileId || identity.name, allow, atMs: now() });
      if (!result.ok) return ackError(ack, standsCodeMessage(result.code), result.code);
      publishStands(matchId, identity.profileId || identity.name);
      ackOk(ack, { stands: stands.stateFor(matchId, identity.profileId || identity.name) });
    });

    socket.on('football:stands_state', (payload = {}, ack) => {
      const identity = socket.data.football;
      const matchId = payload?.matchId;
      if (!matchId) return ackError(ack, 'partido no encontrado', 'no_match');
      const match = store.getMatch(matchId);
      if (!match || !LIVE_STATUSES.includes(match.status)) stands.forget(matchId);
      else stands.sweep(matchId, now());
      ackOk(ack, { stands: stands.stateFor(matchId, identity ? (identity.profileId || identity.name) : null) });
    });

    socket.on('disconnect', () => { leaveAll(socket); });
  });

  function liveStateFor(match) {
    if (!match || !LIVE_STATUSES.includes(match.status)) return {};
    try {
      const derived = engine.deriveMatchState(match, now());
      return {
        minute: derived.minute, score: derived.state.score, matchEnd: derived.matchEnd,
        half: derived.state.half, redCards: derived.state.redCards, phase: derived.state.phase,
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
      half: state.half, redCards: state.redCards, phase: state.phase, playStopped: state.playStopped
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

  onEngine('football:status', (payload) => {
    const { matchId, code, minute, scheduledKickoffAt, day, block } = payload || {};
    const completedMatch = code === 'full_time' ? store.getMatch(matchId) : null;
    if (['finished', 'full_time', 'postponed'].includes(code)) {
      stands.forget(matchId);
      publishStands(matchId);
    }
    io.to(matchRoom(matchId)).emit('football:status', { matchId, code, minute, scheduledKickoffAt, day, block, result:completedMatch?.status === 'settled' ? completedMatch.result : null, highlights:completedMatch?.status === 'settled' ? completedMatch.highlights || null : null });
    io.to(LOBBY_ROOM).emit('football:lobby', buildLobby());
    if (code === 'full_time') {
      fantasyRankingCache = null;
      fanClub.syncProfiles(profiles.profiles, store.leagues, now(), p => profiles.touch(p));
      const settled = store.getMatch(matchId);
      if (settled) broadcastBallonDorMarket(settled.seasonMonth);
    }
    publishLiveOdds(matchId);
  });

  onEngine('football:rescheduled', (payload) => {
    const { matchId, scheduledKickoffAt, day, block } = payload || {};
    io.to(matchRoom(matchId)).emit('football:rescheduled', { matchId, scheduledKickoffAt, day, block });
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
    if (event.clockLabel != null) out.clockLabel = String(event.clockLabel);
    if (event.addedMinutes != null) out.addedMinutes = event.addedMinutes;
    if (event.added != null) out.added = Number(event.added); // minutos de agregado que anuncia el árbitro
    if (event.marcador) out.marcador = event.marcador;
    else if (sc) out.marcador = formatScore(sc);
    return out;
  }

  function broadcastBallonDorMarket(seasonMonth = store.getCurrentSeasonMonth()) {
    if (!ballonDorMarket?.getMarket) return null;
    const market = ballonDorMarket.getMarket(seasonMonth);
    io.to(LOBBY_ROOM).emit('football:ballon_dor_market', { market });
    return market;
  }

  // Difunde las cuotas vigentes de un mercado a la sala del partido.
  function broadcastOdds(matchId, marketKey, state = {}) {
    const match = store.getMatch(matchId);
    if (!match) return;
    const mkt = betting.getMarket(match, marketKey, state);
    if (!mkt) return;
    io.to(matchRoom(matchId)).emit('football:odds', {
      matchId, market: marketKey,
      selections: mkt.selections.map(s => ({ key: s.key, price: s.price, implied: s.implied, ...(s.label ? { label: s.label } : {}) })),
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
    stop, broadcastOdds, broadcastSettlement, broadcastBallonDorMarket,
    buildLobby, buildMatchState, publicBet,
    roomSize, commentaryRings, LOBBY_ROOM, matchRoom
  };
}

module.exports = { registerFootballSockets, publicBet, publicTeams, LOBBY_ROOM, matchRoom, profileRoom, COMMENTARY_RING, LIVE_STATUSES };
