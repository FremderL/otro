'use strict';

// Motor causal versionado. Se comparte con el navegador sin depender del DOM.
// Las decisiones usan el PRNG del partido; versiones previas se conservan para
// poder reconstruir compromisos existentes sin modificar su resultado.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MonteCristoSimulador = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 'v2-causal-2';
  const FIELD = Object.freeze({ length: 105, width: 68, goalWidth: 7.32, penaltyDepth: 16.5, penaltyWidth: 40.32 });
  const STEP = 0.5;
  const MAX_PLAYER_SPEED = 7.2;
  const MAX_BALL_SPEED = 24;
  const CONTROL_RADIUS = 1.25;
  const PASS_RANGE = 26;
  const END = 90 * 60;
  const HALF = 45 * 60;
  const MAX_ADDED_PER_HALF = 4;
  const MAX_END = END + 2 * MAX_ADDED_PER_HALF * 60;
  const SUB_MINUTES = [54, 63, 72, 80, 86];
  const POSITION_ROLE = { GK: 'GK', CB: 'DF', LB: 'DF', RB: 'DF', CDM: 'MF', CM: 'MF', CAM: 'MF', LW: 'FW', RW: 'FW', ST: 'FW' };
  const SIDES = ['home', 'away'];
  const FORMATIONS = {
    '4-4-2': [
      ['GK', 4, 34], ['DF', 19, 12], ['DF', 20, 26], ['DF', 20, 42], ['DF', 19, 56],
      ['MF', 36, 11], ['MF', 38, 26], ['MF', 38, 42], ['MF', 36, 57], ['FW', 48, 26], ['FW', 48, 42]
    ],
    '4-3-3': [
      ['GK', 4, 34], ['DF', 19, 12], ['DF', 20, 26], ['DF', 20, 42], ['DF', 19, 56],
      ['MF', 36, 20], ['MF', 38, 34], ['MF', 36, 48], ['FW', 47, 14], ['FW', 48, 34], ['FW', 47, 54]
    ],
    '3-5-2': [
      ['GK', 4, 34], ['DF', 19, 19], ['DF', 20, 34], ['DF', 19, 49],
      ['MF', 34, 8], ['MF', 37, 21], ['MF', 38, 34], ['MF', 37, 47], ['MF', 34, 60], ['FW', 48, 26], ['FW', 48, 42]
    ],
    '4-2-3-1': [
      ['GK', 4, 34], ['DF', 19, 12], ['DF', 20, 26], ['DF', 20, 42], ['DF', 19, 56],
      ['MF', 33, 25], ['MF', 33, 43], ['MF', 43, 13], ['MF', 44, 34], ['MF', 43, 55], ['FW', 49, 34]
    ]
  };

  function hash32(value) {
    const text = String(value);
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function randomFrom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function copyPoint(p) { return { x: p.x, y: p.y }; }
  function opposite(side) { return side === 'home' ? 'away' : 'home'; }
  function pointOnSegment(point, from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const length2 = dx * dx + dy * dy;
    const fraction = length2 ? clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / length2, 0, 1) : 0;
    const x = from.x + dx * fraction, y = from.y + dy * fraction;
    return { fraction, x, y, distance: Math.hypot(point.x - x, point.y - y) };
  }
  // Tiempo de primer contacto de dos trayectorias simultáneas dentro del paso.
  // Evita que un defensor que llega tarde al punto de salida intercepte un
  // balón que ya pasó por allí. `portion` es la parte del paso que tarda el
  // balón en alcanzar el destino o la línea de salida.
  function movingContact(ballFrom, ballTo, playerFrom, playerTo, portion, reach) {
    const bx = ballTo.x - ballFrom.x, by = ballTo.y - ballFrom.y;
    const px = (playerTo.x - playerFrom.x) * portion, py = (playerTo.y - playerFrom.y) * portion;
    const rx = ballFrom.x - playerFrom.x, ry = ballFrom.y - playerFrom.y;
    const dx = bx - px, dy = by - py;
    const a = dx * dx + dy * dy, b = 2 * (rx * dx + ry * dy);
    const c = rx * rx + ry * ry - reach * reach;
    let t;
    if (c <= 0) t = 0;
    else {
      const discriminant = b * b - 4 * a * c;
      if (a < 1e-12 || discriminant < 0) return null;
      t = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (t < 0 || t > 1) return null;
    }
    return { fraction: t, ball: { x: ballFrom.x + bx * t, y: ballFrom.y + by * t },
      player: { x: playerFrom.x + px * t, y: playerFrom.y + py * t } };
  }
  function advance(point, target, distanceLimit) {
    const d = distance(point, target);
    if (d <= distanceLimit || d < 1e-9) return copyPoint(target);
    return { x: point.x + (target.x - point.x) * distanceLimit / d, y: point.y + (target.y - point.y) * distanceLimit / d };
  }
  function boundary(from, to) {
    const choices = [];
    const dx = to.x - from.x, dy = to.y - from.y;
    if (dx > 0 && to.x >= FIELD.length) choices.push({ at: (FIELD.length - from.x) / dx, line: 'right' });
    if (dx < 0 && to.x <= 0) choices.push({ at: -from.x / dx, line: 'left' });
    if (dy > 0 && to.y >= FIELD.width) choices.push({ at: (FIELD.width - from.y) / dy, line: 'bottom' });
    if (dy < 0 && to.y <= 0) choices.push({ at: -from.y / dy, line: 'top' });
    const hit = choices.filter(item => item.at >= 0 && item.at <= 1).sort((a, b) => a.at - b.at)[0];
    return hit ? { ...hit,
      x: hit.line === 'left' ? 0 : hit.line === 'right' ? FIELD.length : clamp(from.x + dx * hit.at, 0, FIELD.length),
      y: hit.line === 'top' ? 0 : hit.line === 'bottom' ? FIELD.width : clamp(from.y + dy * hit.at, 0, FIELD.width)
    } : null;
  }
  function basePosition(player, direction) {
    return { x: direction === 1 ? player.baseX : FIELD.length - player.baseX, y: player.baseY };
  }
  function goalieBounds(direction) {
    return direction === 1 ? { min: 1, max: FIELD.penaltyDepth - 1 } : { min: FIELD.length - FIELD.penaltyDepth + 1, max: FIELD.length - 1 };
  }
  function inPenaltyArea(point, attackDirection) {
    const inDepth = attackDirection === 1 ? point.x >= FIELD.length - FIELD.penaltyDepth : point.x <= FIELD.penaltyDepth;
    return inDepth && Math.abs(point.y - FIELD.width / 2) <= FIELD.penaltyWidth / 2;
  }
  function teamDetails(input, side) {
    const source = input && typeof input === 'object' ? input : {};
    const formation = FORMATIONS[source.formation] ? source.formation : '4-4-2';
    return {
      id: String(source.id || side),
      name: String(source.name || (side === 'home' ? 'Local' : 'Visitante')).slice(0, 60),
      short: String(source.short || (side === 'home' ? 'LOC' : 'VIS')).slice(0, 5),
      formation
    };
  }
  function makePlayers(team, side, direction, random, input) {
    const lineup = input && input.lineup;
    let starters = null;
    if (lineup != null) {
      if (!lineup || lineup.teamId !== team.id || lineup.formation !== team.formation || !Array.isArray(lineup.players)) {
        throw new Error(`alineación inválida para ${team.id}`);
      }
      starters = lineup.players.filter(player => player && player.initialStatus === 'active');
      if (starters.length !== 11 || new Set(starters.map(player => player.id)).size !== 11
          || new Set(starters.map(player => player.slotIndex)).size !== 11
          || starters.some(player => typeof player.id !== 'string' || !player.id
            || typeof player.name !== 'string' || !player.name
            || !Number.isInteger(player.number) || player.number < 1 || player.number > 99
            || !Number.isInteger(player.slotIndex) || player.slotIndex < 0 || player.slotIndex >= 11
            || player.role !== FORMATIONS[team.formation][player.slotIndex][0]
            || !player.attrs || !['pac', 'pas', 'sho', 'def', 'gk'].every(key => Number.isFinite(player.attrs[key])))) {
        throw new Error(`once titular inválido para ${team.id}`);
      }
      starters.sort((a, b) => a.slotIndex - b.slotIndex);
    }
    return FORMATIONS[team.formation].map((slot, index) =>
      makePlayer(side, direction, random, input, slot, index, starters && starters[index]));
  }
  function makePlayer(side, direction, random, input, slot, index, starter) {
    const ratings = input && input.ratings || {};
    const rating = (key, fallback = 1) => Number.isFinite(ratings[key]) ? clamp(ratings[key], 0.7, 1.35) : fallback;
    const [role, baseX, baseY] = slot;
    const player = {
      id: starter ? starter.id : `${side}-${index + 1}`, side, number: starter ? starter.number : index + 1,
      name: starter ? starter.name : `Jugador ${index + 1}`, role, baseX, baseY, slotIndex: index,
      x: direction === 1 ? baseX : FIELD.length - baseX, y: baseY,
      active: true, status: 'active', yellowCards: 0, substitute: Boolean(starter && starter.initialStatus === 'bench'),
      speed: role === 'GK' ? 5.0 : 6.1 + random() * 1.1,
      passing: 0.56 + random() * 0.20,
      shooting: 0.52 + random() * 0.25,
      defending: 0.50 + random() * 0.23,
      keeping: 0.57 + random() * 0.18
    };
    if (starter && starter.attrs) {
      const a = starter.attrs;
      player.speed = clamp(role === 'GK' ? 3.6 + a.pac * 0.025 : 4.4 + a.pac * 0.032, 3, MAX_PLAYER_SPEED);
      player.passing = clamp(0.38 + a.pas * 0.005 + (rating('att') - 1) * 0.07, 0.35, 0.9);
      player.shooting = clamp(0.31 + a.sho * 0.005 + (rating('att') - 1) * 0.16, 0.3, 0.9);
      player.defending = clamp(0.33 + a.def * 0.0045 + (1 - rating('def')) * 0.16, 0.3, 0.9);
      player.keeping = clamp(0.31 + a.gk * 0.005 + (rating('gk') - 1) * 0.15 + (1 - rating('def')) * 0.06, 0.3, 0.9);
    }
    return player;
  }
  function makeBench(input, side) {
    if (!input || !input.lineup) {
      return ['DF', 'DF', 'MF', 'MF', 'FW', 'FW', 'GK'].map((role, index) => ({
        id: `${side}-${index + 12}`, name: `Jugador ${index + 12}`, number: index + 12,
        role, pos: role, initialStatus: 'bench'
      }));
    }
    const bench = input.lineup.players.filter(player => player && player.initialStatus === 'bench');
    if (bench.some(player => typeof player.id !== 'string' || !player.id || typeof player.name !== 'string' || !player.name
        || !Number.isInteger(player.number) || player.number < 1 || player.number > 99
        || !player.attrs || !['pac', 'pas', 'sho', 'def', 'gk'].every(key => Number.isFinite(player.attrs[key])))) {
      throw new Error(`banquillo inválido para ${input.id}`);
    }
    return bench.map(player => ({ ...player, attrs: { ...player.attrs } }));
  }

  function createMatch(options = {}) {
    const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) >>> 0 : 1;
    // En la demo se usa una semilla pública de 32 bits. El adaptador de servidor
    // puede inyectar un flujo determinista CSPRNG privado e independiente; nunca
    // se envía ese flujo ni su clave al navegador.
    const random = typeof options.random === 'function' ? options.random : randomFrom(hash32(`${VERSION}|${seed}|game`));
    const rosterRandom = randomFrom(hash32(`${VERSION}|${seed}|roster`));
    const teams = { home: teamDetails(options.home, 'home'), away: teamDetails(options.away, 'away') };
    const dirs = { home: 1, away: -1 };
    const players = [...makePlayers(teams.home, 'home', 1, rosterRandom, options.home),
      ...makePlayers(teams.away, 'away', -1, rosterRandom, options.away)];
    const benches = { home: makeBench(options.home, 'home'), away: makeBench(options.away, 'away') };
    const allIds = [...players.map(player => player.id), ...benches.home.map(player => player.id), ...benches.away.map(player => player.id)];
    if (new Set(allIds).size !== allIds.length) throw new Error('jugadores duplicados entre equipos');
    const stats = {
      home: { shots: 0, shotsOnTarget: 0, passes: 0, completedPasses: 0, corners: 0, fouls: 0, possessionSeconds: 0 },
      away: { shots: 0, shotsOnTarget: 0, passes: 0, completedPasses: 0, corners: 0, fouls: 0, possessionSeconds: 0 }
    };
    const state = {
      version: VERSION, seed, teams, dirs, players, stats,
      time: 0, half: 1, phase: 'play', score: { home: 0, away: 0 },
      ball: { x: FIELD.length / 2, y: FIELD.width / 2, mode: 'controlled', carrierId: null, lastTouch: 'home' },
      possessionTeam: 'home', events: [], nextSequence: 1, dead: null, flight: null,
      decisionIn: 1.8, challengeIn: 1.5, carrierDistance: 0, halfStarted: false, restartContext: null,
      supportCarrierId: null, supportPlayerId: null,
      benches, teamInputs: { home: options.home, away: options.away }, rosterRandom,
      substitutions: { home: 0, away: 0 }, subTargets: { home: 3 + Math.floor(random() * 3), away: 3 + Math.floor(random() * 3) },
      lastSubAt: { home: -Infinity, away: -Infinity },
      lostSeconds: { 1: 0, 2: 0 }, clock: { s1: null, s2: null, firstHalfEnd: null, matchEnd: null },
      ended: false, random
    };
    const taker = players.filter(p => p.side === 'home' && p.role === 'FW')
      .sort((a, b) => distance(a, state.ball) - distance(b, state.ball))[0];
    taker.x = state.ball.x; taker.y = state.ball.y;
    state.ball.carrierId = taker.id;
    emit(state, 'kickoff', { team: 'home', playerId: taker.id, position: copyPoint(state.ball) });
    return {
      step(count = 1) {
        const steps = Number.isSafeInteger(count) ? clamp(count, 0, 10000) : 1;
        for (let i = 0; i < steps && !state.ended; i++) tick(state);
        return snapshot(state);
      },
      snapshot() { return snapshot(state); },
      eventsAfter(index = -1) { return state.events.slice(Math.max(0, Math.floor(Number(index) || 0) + 1)).map(cloneEvent); }
    };
  }
  function cloneEvent(event) {
    // Todos los campos anidados del contrato son objetos de coordenadas o score.
    const result = { ...event };
    for (const key of ['position', 'from', 'to', 'playerPosition', 'ballPosition', 'contactPosition', 'receiverPosition', 'score']) {
      if (event[key]) result[key] = { ...event[key] };
    }
    return result;
  }
  function snapshot(s) {
    return {
      version: s.version, seed: s.seed, time: s.time, half: s.half, phase: s.phase, ended: s.ended,
      teams: { home: { ...s.teams.home }, away: { ...s.teams.away } },
      directions: { ...s.dirs }, score: { ...s.score }, possessionTeam: s.possessionTeam, clock: { ...s.clock },
      stats: { home: { ...s.stats.home }, away: { ...s.stats.away } },
      ball: { x: s.ball.x, y: s.ball.y, mode: s.ball.mode, carrierId: s.ball.carrierId, lastTouch: s.ball.lastTouch },
      players: s.players.map(p => ({ id: p.id, side: p.side, number: p.number, name: p.name, role: p.role,
        slotIndex: p.slotIndex, active: p.active, status: p.status, x: p.x, y: p.y })),
      lastEventId: s.events.length - 1
    };
  }
  function emit(s, type, details = {}) {
    const event = { i: s.events.length, time: s.time, half: s.half, type, ...details };
    s.events.push(event);
    return event;
  }
  function playerById(s, id) { return s.players.find(p => p.active && p.id === id) || null; }
  function nearest(s, side, point, allowGoalkeeper = true) {
    return s.players.filter(p => p.active && p.side === side && (allowGoalkeeper || p.role !== 'GK'))
      .sort((a, b) => distance(a, point) - distance(b, point) || a.number - b.number)[0] || null;
  }
  function setControlled(s, player, source, extra = {}) {
    s.ball.mode = 'controlled'; s.ball.carrierId = player.id;
    s.ball.x = player.x; s.ball.y = player.y; s.ball.lastTouch = player.side;
    s.flight = null; s.possessionTeam = player.side; s.decisionIn = player.role === 'GK' ? 1.6 : 2.1 + s.random() * 2.2;
    if (s.restartContext && s.restartContext.team !== player.side) s.restartContext = null;
    s.challengeIn = 1.2; s.carrierDistance = 0;
    if (source) emit(s, source, { team: player.side, playerId: player.id,
      playerPosition: copyPoint(player), ballPosition: copyPoint(s.ball), ...extra });
  }
  function choosePass(s, carrier) {
    const direction = s.dirs[carrier.side];
    const candidates = s.players.filter(p => p.active && p.side === carrier.side && p.id !== carrier.id && p.role !== 'GK')
      .map(p => ({ player: p, d: distance(p, carrier) }))
      .filter(entry => entry.d >= 3.5 && entry.d <= PASS_RANGE);
    if (!candidates.length) return null;
    const opponents = s.players.filter(p => p.active && p.side !== carrier.side);
    const weights = candidates.map(entry => {
      const forward = direction * (entry.player.x - carrier.x);
      const pressure = opponents.filter(p => distance(p, entry.player) < 4).length;
      const blocked = opponents.some(p => {
        const lane = pointOnSegment(p, carrier, entry.player);
        return lane.fraction > 0.04 && lane.fraction < 0.98 && lane.distance < 2.4;
      });
      const weight = clamp(1.2 + forward * 0.12 - entry.d * 0.018 - pressure * 0.35, 0.12, 3);
      return blocked ? weight * 0.25 : weight;
    });
    let roll = s.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return candidates[i].player;
    }
    return candidates[candidates.length - 1].player;
  }
  function startPass(s, carrier, receiver) {
    const from = copyPoint(carrier);
    // Un error modifica la trayectoria, no el alcance permitido del compañero.
    const error = s.random() > carrier.passing ? (s.random() - 0.5) * 5 : 0;
    const to = { x: receiver.x, y: receiver.y + error };
    const sequence = s.nextSequence++;
    const restart = s.restartContext && s.restartContext.team === carrier.side ? s.restartContext : null;
    s.restartContext = null;
    const speed = carrier.role === 'GK' ? 16 : 13;
    s.stats[carrier.side].passes++;
    s.ball.mode = 'pass'; s.ball.carrierId = null; s.ball.lastTouch = carrier.side;
    s.flight = { kind: 'pass', team: carrier.side, from, to, speed, receiverId: receiver.id,
      passerId: carrier.id, sequence, elapsed: 0, attempted: new Set() };
    emit(s, 'pass', { team: carrier.side, playerId: carrier.id, receiverId: receiver.id,
      from, to: copyPoint(to), receiverPosition: copyPoint(receiver), sequence,
      restartId: restart ? restart.id : null, causeSequence: restart ? restart.causeSequence : null });
  }
  function startShot(s, carrier, isPenalty) {
    const direction = s.dirs[carrier.side];
    const goalX = direction === 1 ? FIELD.length : 0;
    const from = copyPoint(carrier);
    const meters = Math.hypot(goalX - from.x, FIELD.width / 2 - from.y);
    const pressure = s.players.filter(p => p.active && p.side !== carrier.side && p.role !== 'GK' && distance(p, carrier) < 3).length;
    // La apertura angular de la portería importa, sobre todo desde la línea de fondo.
    const depth = Math.max(0.01, Math.abs(goalX - from.x));
    const angle = Math.abs(Math.atan2(FIELD.width / 2 + FIELD.goalWidth / 2 - from.y, depth)
      - Math.atan2(FIELD.width / 2 - FIELD.goalWidth / 2 - from.y, depth));
    const angleFactor = clamp(angle / 0.50, 0.02, 1);
    const onTarget = clamp((isPenalty ? 0.88 : (0.68 - meters * 0.012) * angleFactor)
      + (carrier.shooting - 0.6) * 0.18 - pressure * 0.05, 0.02, 0.9);
    const targetOnGoal = s.random() < onTarget;
    let targetY;
    if (targetOnGoal) {
      // Centro más probable que las escuadras; el portero debe alcanzar la trayectoria.
      targetY = FIELD.width / 2 + (s.random() + s.random() - 1) * (FIELD.goalWidth / 2 - 0.15);
    } else {
      const sign = s.random() < 0.5 ? -1 : 1;
      targetY = FIELD.width / 2 + sign * (FIELD.goalWidth / 2 + 1 + s.random() * 9);
    }
    // La trayectoria sobrepasa la línea para poder detectar el cruce geométrico.
    const factor = (Math.abs(goalX - from.x) + 3) / Math.max(0.01, Math.abs(goalX - from.x));
    const to = { x: goalX + direction * 3, y: from.y + (targetY - from.y) * factor };
    const sequence = s.nextSequence++;
    const restart = s.restartContext && s.restartContext.team === carrier.side ? s.restartContext : null;
    s.restartContext = null;
    s.stats[carrier.side].shots++;
    s.ball.mode = 'shot'; s.ball.carrierId = null; s.ball.lastTouch = carrier.side;
    s.flight = { kind: 'shot', team: carrier.side, from, to, speed: MAX_BALL_SPEED,
      shooterId: carrier.id, sequence, elapsed: 0, attempted: new Set(), isPenalty: Boolean(isPenalty), targetOnGoal };
    emit(s, 'shot', { team: carrier.side, playerId: carrier.id, from, to: copyPoint(to), sequence,
      targetOnGoal, penalty: Boolean(isPenalty), restartId: restart ? restart.id : null,
      causeSequence: restart ? restart.causeSequence : null });
  }
  function setDeadBall(s, kind, team, spot, options = {}) {
    const taker = kind === 'goal_kick'
      ? s.players.find(p => p.active && p.side === team && p.role === 'GK')
      : nearest(s, team, spot, false);
    s.phase = kind === 'halftime' ? 'halftime' : 'stopped';
    s.ball.mode = 'dead'; s.ball.carrierId = null; s.flight = null; s.possessionTeam = team;
    s.restartContext = null;
    s.dead = { id: s.nextSequence++, kind, team, spot: copyPoint(spot), takerId: taker && taker.id,
      causeSequence: options.causeSequence || null, elapsed: 0,
      minWait: options.minWait || 3, resetFormation: Boolean(options.resetFormation) };
    return s.dead;
  }
  function goal(s, flight, crossing) {
    s.score[flight.team]++;
    s.stats[flight.team].shotsOnTarget++;
    s.ball.x = crossing.x; s.ball.y = crossing.y;
    emit(s, 'goal', { team: flight.team, playerId: flight.shooterId, sequence: flight.sequence,
      position: { x: crossing.x, y: crossing.y }, score: { ...s.score } });
    setDeadBall(s, 'goal_restart', opposite(flight.team), { x: FIELD.length / 2, y: FIELD.width / 2 },
      { minWait: 8, resetFormation: true, causeSequence: flight.sequence });
  }
  function leaveField(s, flight, hit) {
    s.ball.x = hit.x; s.ball.y = hit.y;
    const last = s.ball.lastTouch;
    emit(s, 'ball_out', { team: last, position: { x: hit.x, y: hit.y }, line: hit.line,
      sequence: flight && flight.sequence });
    if (hit.line === 'top' || hit.line === 'bottom') {
      const team = opposite(last);
      setDeadBall(s, 'throw_in', team, { x: clamp(hit.x, 0.5, FIELD.length - 0.5), y: hit.line === 'top' ? 0 : FIELD.width },
        { causeSequence: flight && flight.sequence });
      emit(s, 'throw_in', { team, position: copyPoint(s.dead.spot), restartId: s.dead.id, causeSequence: s.dead.causeSequence });
      return;
    }
    const defending = SIDES.find(side => (hit.line === 'left' ? s.dirs[side] === 1 : s.dirs[side] === -1));
    if (last === defending) {
      const team = opposite(defending);
      const spot = { x: hit.line === 'left' ? 0 : FIELD.length, y: hit.y < FIELD.width / 2 ? 0 : FIELD.width };
      s.stats[team].corners++;
      setDeadBall(s, 'corner', team, spot, { causeSequence: flight && flight.sequence });
      emit(s, 'corner', { team, position: copyPoint(spot), restartId: s.dead.id, causeSequence: s.dead.causeSequence });
    } else {
      const spot = { x: hit.line === 'left' ? 5.5 : FIELD.length - 5.5, y: FIELD.width / 2 };
      setDeadBall(s, 'goal_kick', defending, spot, { causeSequence: flight && flight.sequence });
      emit(s, 'goal_kick', { team: defending, position: copyPoint(spot), restartId: s.dead.id, causeSequence: s.dead.causeSequence });
    }
  }
  function movePlayer(player, target, speed) {
    const to = advance(player, target, speed * STEP);
    player.x = clamp(to.x, 0.5, FIELD.length - 0.5);
    player.y = clamp(to.y, 0.5, FIELD.width - 0.5);
  }
  // Los cambios solo ocurren con balón detenido; el suplente ocupa el mismo
  // puesto y hereda la posición del saliente, no aparece en otra jugada.
  function maybeSubstitute(s) {
    if (s.half !== 2 || !s.dead || s.dead.kind === 'penalty' || s.dead.kind === 'halftime') return;
    const nominalMinute = (s.time - s.clock.s1 * 60) / 60;
    for (const side of SIDES) {
      const count = s.substitutions[side];
      if (count >= s.subTargets[side] || count >= SUB_MINUTES.length || nominalMinute < SUB_MINUTES[count]
          || s.time - s.lastSubAt[side] < 20) continue;
      const reserves = s.benches[side].filter(p => (POSITION_ROLE[p.pos] || p.role) !== 'GK');
      const starters = s.players.filter(p => p.side === side && p.active && p.role !== 'GK' && !p.substitute);
      if (!reserves.length || !starters.length) continue;
      const reserve = reserves[Math.floor(s.random() * reserves.length)];
      const role = POSITION_ROLE[reserve.pos] || reserve.role;
      const sameRole = starters.filter(p => p.role === role);
      const outgoingPool = sameRole.length ? sameRole : starters;
      const outgoing = outgoingPool[Math.floor(s.random() * outgoingPool.length)];
      const index = s.players.indexOf(outgoing);
      const slot = FORMATIONS[s.teams[side].formation][outgoing.slotIndex];
      const incoming = makePlayer(side, s.dirs[side], s.rosterRandom, s.teamInputs[side], slot, outgoing.slotIndex, reserve);
      incoming.x = outgoing.x; incoming.y = outgoing.y;
      s.players[index] = incoming;
      s.benches[side] = s.benches[side].filter(p => p.id !== reserve.id);
      if (s.dead.takerId === outgoing.id) s.dead.takerId = incoming.id;
      if (s.supportPlayerId === outgoing.id) s.supportPlayerId = null;
      s.substitutions[side]++; s.lastSubAt[side] = s.time;
      s.dead.minWait = Math.max(s.dead.minWait, s.dead.elapsed + 8);
      emit(s, 'substitution', { team: side, playerId: incoming.id, playerInId: incoming.id, playerInName: incoming.name,
        playerOutId: outgoing.id, playerOutName: outgoing.name, slotIndex: outgoing.slotIndex, position: copyPoint(outgoing) });
    }
  }
  function moveDuringStoppage(s) {
    const dead = s.dead;
    maybeSubstitute(s);
    const taker = playerById(s, dead.takerId);
    for (const player of s.players) {
      if (!player.active) continue;
      let target = basePosition(player, s.dirs[player.side]);
      if (!dead.resetFormation) {
        target = { x: player.x, y: player.y };
        // Apoyos cercanos llegan al reinicio; no aparecen por arte de magia.
        if (player.side === dead.team && player.role !== 'GK' && player.id !== dead.takerId && distance(player, dead.spot) < 32) {
          target = { x: clamp(dead.spot.x + s.dirs[player.side] * 8, 1, FIELD.length - 1),
            y: clamp(dead.spot.y + (player.baseY < 34 ? -8 : 8), 1, FIELD.width - 1) };
        }
      }
      if (dead.kind === 'penalty' && player.side !== dead.team && player.role === 'GK') {
        target = { x: s.dirs[player.side] === 1 ? 1.5 : FIELD.length - 1.5, y: FIELD.width / 2 };
      }
      if (player.id === dead.takerId) target = dead.spot;
      movePlayer(player, target, player.speed);
    }
    const ballPoint = advance(s.ball, dead.spot, 12 * STEP);
    s.ball.x = ballPoint.x; s.ball.y = ballPoint.y;
    dead.elapsed += STEP;
    const formationReady = !dead.resetFormation || s.players.every(player => {
      if (!player.active || player.id === dead.takerId) return true;
      return distance(player, basePosition(player, s.dirs[player.side])) < 3;
    });
    const penaltyKeeper = dead.kind === 'penalty' && s.players.find(player => player.active && player.side !== dead.team && player.role === 'GK');
    const keeperReady = !penaltyKeeper || distance(penaltyKeeper, {
      x: s.dirs[penaltyKeeper.side] === 1 ? 1.5 : FIELD.length - 1.5, y: FIELD.width / 2
    }) < 1;
    if (!taker || dead.elapsed < dead.minWait || !formationReady || !keeperReady
      || distance(s.ball, dead.spot) > 0.01 || distance(taker, dead.spot) > CONTROL_RADIUS) return;
    const kind = dead.kind;
    s.dead = null; s.phase = 'play';
    setControlled(s, taker, null);
    s.restartContext = { id: dead.id, team: dead.team, causeSequence: dead.causeSequence };
    if (kind === 'halftime') emit(s, 'second_half', { team: dead.team, playerId: taker.id, position: copyPoint(taker), restartId: dead.id });
    else if (kind === 'goal_restart') emit(s, 'goal_restart', { team: dead.team, playerId: taker.id, position: copyPoint(taker), restartId: dead.id, causeSequence: dead.causeSequence });
    else emit(s, 'restart', { team: dead.team, playerId: taker.id, restartType: kind, position: copyPoint(taker),
      restartId: dead.id, causeSequence: dead.causeSequence });
    if (kind === 'penalty') startShot(s, taker, true);
    else s.decisionIn = kind === 'corner' || kind === 'throw_in' || kind === 'goal_kick' || kind === 'free_kick' ? 0 : 1.5;
  }
  function targetsForPlay(s) {
    const carrier = playerById(s, s.ball.carrierId);
    const receiver = s.flight && s.flight.kind === 'pass' ? playerById(s, s.flight.receiverId) : null;
    const attacking = carrier ? carrier.side : s.possessionTeam;
    const defending = opposite(attacking || 'home');
    // Todos deciden contra la misma instantánea, no contra un jugador ya movido
    // en este paso. En otro caso el orden del arreglo favorece a un equipo.
    const relevantPoint = copyPoint(carrier || s.ball);
    const pressers = s.players.filter(p => p.active && p.side === defending && p.role !== 'GK')
      .sort((a, b) => distance(a, relevantPoint) - distance(b, relevantPoint)).slice(0, 2);
    // Un apoyo cercano ofrece una opción por delante desde su posición real.
    // La histéresis mantiene el apoyo hasta que se aleja o cambia el portador,
    // en vez de alternar cada paso entre dos compañeros igualmente cercanos.
    let support = carrier && s.supportCarrierId === carrier.id ? playerById(s, s.supportPlayerId) : null;
    if (support && (support.side !== carrier.side || distance(support, relevantPoint) > PASS_RANGE + 3)) support = null;
    if (carrier && !support) support = s.players.filter(p => p.active && p.side === carrier.side && p.role !== 'GK'
      && p.id !== carrier.id && distance(p, relevantPoint) < PASS_RANGE)
      .sort((a, b) => distance(a, relevantPoint) - distance(b, relevantPoint))[0] || null;
    s.supportCarrierId = carrier ? carrier.id : null;
    s.supportPlayerId = support ? support.id : null;
    const supporters = support ? [support] : [];
    const chasers = s.ball.mode === 'loose'
      ? SIDES.map(side => nearest(s, side, s.ball, true)).filter(Boolean) : [];
    for (const player of s.players) {
      if (!player.active) continue;
      const direction = s.dirs[player.side];
      const base = basePosition(player, direction);
      let target = {
        x: clamp(base.x + (s.ball.x - FIELD.length / 2) * 0.38, 1, FIELD.length - 1),
        y: clamp(base.y + (s.ball.y - FIELD.width / 2) * 0.20, 1, FIELD.width - 1)
      };
      let speed = player.speed * 0.66;
      if (player.role === 'GK') {
        const bounds = goalieBounds(direction);
        const defendedLine = direction === 1 ? 0 : FIELD.length;
        const threat = s.possessionTeam !== player.side && Math.abs(s.ball.x - defendedLine) < 24;
        const advanceFromLine = threat ? clamp(Math.abs(s.ball.x - defendedLine) * 0.35, 3.4, 9) : 3.4;
        target = { x: direction === 1 ? advanceFromLine : FIELD.length - advanceFromLine, y: clamp(s.ball.y, 27.5, 40.5) };
        target.x = clamp(target.x, bounds.min, bounds.max);
        speed = player.speed * 0.8;
      }
      if (pressers.includes(player) && player.role !== 'GK' && distance(player, relevantPoint) < 30) {
        const offset = pressers[0] === player ? 0 : (player.y < relevantPoint.y ? -2 : 2);
        target = { x: relevantPoint.x, y: clamp(relevantPoint.y + offset, 1, FIELD.width - 1) };
        speed = player.speed;
      }
      if (supporters.includes(player)) {
        target = { x: clamp(relevantPoint.x + direction * 7, 1, FIELD.length - 1),
          y: clamp(relevantPoint.y + (player.baseY < FIELD.width / 2 ? -9 : 9), 1, FIELD.width - 1) };
        speed = player.speed * 0.88;
      }
      if (chasers.includes(player)) { target = copyPoint(s.ball); speed = player.speed; }
      if (receiver && receiver.id === player.id) { target = copyPoint(s.flight.to); speed = player.speed; }
      if (carrier && carrier.id === player.id) {
        const directionToGoal = s.dirs[player.side];
        target = { x: clamp(player.x + directionToGoal * 7, 1, FIELD.length - 1),
          y: clamp(player.y + (FIELD.width / 2 - player.y) * 0.08, 1, FIELD.width - 1) };
        speed = player.role === 'GK' ? 1.2 : Math.min(player.speed, 4.4);
        if (player.role === 'GK') {
          const bounds = goalieBounds(directionToGoal); target.x = clamp(target.x, bounds.min, bounds.max);
        }
      }
      if (player.role === 'GK') {
        const bounds = goalieBounds(direction);
        target.x = clamp(target.x, bounds.min, bounds.max);
        target.y = clamp(target.y, (FIELD.width - FIELD.penaltyWidth) / 2, (FIELD.width + FIELD.penaltyWidth) / 2);
      }
      const before = copyPoint(player);
      movePlayer(player, target, speed);
      if (carrier && carrier.id === player.id) s.carrierDistance += distance(before, player);
    }
    if (carrier) { s.ball.x = carrier.x; s.ball.y = carrier.y; }
  }
  function challenge(s) {
    const carrier = playerById(s, s.ball.carrierId);
    if (!carrier || carrier.role === 'GK') return;
    s.challengeIn -= STEP;
    const keeper = s.players.find(p => p.active && p.side !== carrier.side && p.role === 'GK');
    // El portero puede achicar al delantero que conduce en su área, sin
    // esperar al temporizador de una entrada entre jugadores de campo.
    if (keeper && distance(keeper, carrier) <= 2.1 && s.random() < keeper.keeping * 0.8) {
      const separation = distance(keeper, carrier);
      setControlled(s, keeper, 'keeper_claim', { victimId: carrier.id, separation });
      return;
    }
    if (s.challengeIn > 0) return;
    const defender = nearest(s, opposite(carrier.side), carrier, false);
    if (!defender || distance(defender, carrier) > 1.6) return;
    s.challengeIn = 2.2;
    const separation = distance(defender, carrier);
    const roll = s.random();
    // Dentro del área los defensores son más cuidadosos al disputar el balón.
    const foulChance = inPenaltyArea(carrier, s.dirs[carrier.side]) ? 0.008 : 0.10;
    if (roll < foulChance) {
      s.stats[defender.side].fouls++;
      const pos = copyPoint(carrier), foulSequence = s.nextSequence++;
      emit(s, 'foul', { team: defender.side, playerId: defender.id, victimId: carrier.id,
        position: pos, playerPosition: copyPoint(defender), separation, sequence: foulSequence });
      // Una tarjeta solo puede surgir de una falta realmente observada. Nunca
      // expulsar por debajo de siete jugadores; el portero no entra en esta disputa.
      const cardRoll = s.random();
      const canDismiss = s.players.filter(p => p.active && p.side === defender.side).length > 7;
      if (cardRoll < 0.025 && canDismiss) {
        defender.active = false; defender.status = 'sent_off';
        emit(s, 'red_card', { team: defender.side, playerId: defender.id, sequence: foulSequence, position: copyPoint(defender) });
      } else if (cardRoll < 0.35 && (defender.yellowCards === 0 || canDismiss)) {
        defender.yellowCards++;
        const second = defender.yellowCards >= 2 && canDismiss;
        if (second) { defender.active = false; defender.status = 'sent_off'; }
        emit(s, second ? 'second_yellow' : 'yellow_card', { team: defender.side, playerId: defender.id,
          sequence: foulSequence, position: copyPoint(defender) });
      }
      if (inPenaltyArea(pos, s.dirs[carrier.side])) {
        const spot = { x: s.dirs[carrier.side] === 1 ? FIELD.length - 11 : 11, y: FIELD.width / 2 };
        setDeadBall(s, 'penalty', carrier.side, spot, { minWait: 5, causeSequence: foulSequence });
        emit(s, 'penalty_awarded', { team: carrier.side, playerId: carrier.id, position: pos,
          restartId: s.dead.id, causeSequence: foulSequence });
      } else setDeadBall(s, 'free_kick', carrier.side, pos, { causeSequence: foulSequence });
    } else if (roll < 0.45 + defender.defending * 0.25) {
      // La disputa solo se resuelve cuando ambos están a alcance del balón.
      setControlled(s, defender, 'tackle', { victimId: carrier.id, separation });
    }
  }
  function decide(s) {
    const carrier = playerById(s, s.ball.carrierId);
    if (!carrier) return;
    const direction = s.dirs[carrier.side];
    const goalX = direction === 1 ? FIELD.length : 0;
    const meters = Math.hypot(goalX - carrier.x, FIELD.width / 2 - carrier.y);
    s.decisionIn -= STEP;
    // Cerca del arco el atacante decide antes de conducir hasta la línea de fondo.
    if (carrier.role !== 'GK' && meters < 18) s.decisionIn = Math.min(1, s.decisionIn);
    if (s.decisionIn > 0) return;
    const eligibleShot = carrier.role !== 'GK' && meters < 28 && Math.abs(carrier.y - FIELD.width / 2) < 21;
    const closestMarker = nearest(s, opposite(carrier.side), carrier, false);
    const markerDistance = closestMarker ? distance(closestMarker, carrier) : 30;
    const spaceFactor = markerDistance < 2 ? 0.25 : markerDistance < 3.5 ? 0.62 : 1;
    const shootChance = clamp(0.07 + (28 - meters) * 0.013, 0.07, 0.36) * spaceFactor;
    if (eligibleShot && s.random() < shootChance) { startShot(s, carrier, false); return; }
    const receiver = choosePass(s, carrier);
    if (receiver && (carrier.role === 'GK' || s.carrierDistance > 12 || s.random() < 0.67)) {
      startPass(s, carrier, receiver);
      return;
    }
    s.decisionIn = 1.4 + s.random() * 2;
  }
  function moveFlight(s, previousPositions) {
    const flight = s.flight;
    const from = copyPoint(s.ball);
    const to = advance(from, flight.to, flight.speed * STEP);
    const hit = boundary(from, to);
    const clipped = hit ? { x: hit.x, y: hit.y } : to;
    const portion = clamp(distance(from, clipped) / (flight.speed * STEP), 0, 1);
    const candidates = [];
    for (const player of s.players) {
      if (!player.active) continue;
      if (flight.kind === 'pass' && player.id === flight.passerId && flight.elapsed < 1.5) continue;
      const isReceiver = flight.kind === 'pass' && player.id === flight.receiverId;
      const isOpponent = player.side !== flight.team;
      const canChallenge = isReceiver || (isOpponent && (flight.kind === 'pass' || flight.kind === 'shot'));
      if (!canChallenge || flight.attempted.has(player.id)) continue;
      // El portero puede estirarse en un disparo, pero el contacto debe ocurrir
      // en el mismo instante de las trayectorias del jugador y del balón.
      const reach = flight.kind === 'shot' && player.role === 'GK' ? 2.3 : CONTROL_RADIUS;
      const contact = movingContact(from, clipped, previousPositions.get(player.id), player, portion, reach);
      if (contact && distance(from, player) <= flight.speed * STEP + 1e-8) {
        candidates.push({ player, contact, isReceiver });
      }
    }
    candidates.sort((a, b) => a.contact.fraction - b.contact.fraction || a.player.number - b.player.number);
    for (const candidate of candidates) {
      const p = candidate.player;
      const contactDetails = { playerPosition: copyPoint(candidate.contact.player),
        ballPosition: copyPoint(candidate.contact.ball), contactPosition: copyPoint(candidate.contact.ball) };
      if (candidate.isReceiver) {
        s.stats[flight.team].completedPasses++;
        setControlled(s, p, 'reception', { sequence: flight.sequence, passerId: flight.passerId, ...contactDetails });
        return;
      }
      flight.attempted.add(p.id);
      if (flight.kind === 'pass' && s.random() < 0.35 + p.defending * 0.45) {
        setControlled(s, p, 'interception', { sequence: flight.sequence, passerId: flight.passerId, ...contactDetails });
        return;
      }
      if (flight.kind === 'shot' && p.role === 'GK' && s.random() < p.keeping) {
        if (flight.targetOnGoal) s.stats[flight.team].shotsOnTarget++;
        setControlled(s, p, 'save', { sequence: flight.sequence, shooterId: flight.shooterId, ...contactDetails });
        return;
      }
      if (flight.kind === 'shot' && p.role !== 'GK' && s.random() < 0.25) {
        const direction = s.dirs[flight.team];
        const deflectTarget = { x: direction === 1 ? FIELD.length + 3 : -3,
          y: p.y < FIELD.width / 2 ? 12 : FIELD.width - 12 };
        s.ball.x = p.x; s.ball.y = p.y; s.ball.lastTouch = p.side; s.ball.mode = 'deflection';
        s.flight = { ...flight, kind: 'deflection', from: copyPoint(p), to: deflectTarget, speed: 16, attempted: new Set() };
        emit(s, 'block', { team: p.side, playerId: p.id, sequence: flight.sequence, ...contactDetails });
        return;
      }
    }
    s.ball.x = clipped.x; s.ball.y = clipped.y; flight.elapsed += STEP;
    if (hit) {
      // Un desvío también puede terminar dentro de la portería. Si cruza
      // entre los postes es gol, no córner, aunque el último toque sea rival.
      const crossesOpponentGoal = (flight.kind === 'shot' || flight.kind === 'deflection')
        && ((hit.line === 'right' && s.dirs[flight.team] === 1) || (hit.line === 'left' && s.dirs[flight.team] === -1));
      if (crossesOpponentGoal && Math.abs(hit.y - FIELD.width / 2) <= FIELD.goalWidth / 2) goal(s, flight, hit);
      else leaveField(s, flight, hit);
      return;
    }
    if (distance(s.ball, flight.to) < 0.01) {
      // Un pase que no encontró al receptor queda libre, no se adjudica a distancia.
      s.ball.mode = 'loose'; s.ball.carrierId = null; s.flight = null;
    }
  }
  function moveLoose(s) {
    const candidates = s.players.filter(p => p.active && distance(p, s.ball) <= CONTROL_RADIUS)
      .sort((a, b) => distance(a, s.ball) - distance(b, s.ball));
    if (candidates.length) setControlled(s, candidates[0], 'recovery');
  }
  function tick(s) {
    if (s.ended) return;
    s.time += STEP;
    // Se anuncia el añadido al llegar al 45/90 nominal, calculado únicamente
    // con interrupciones ya ocurridas. Durante ese periodo siguen las jugadas.
    if (s.half === 1 && s.clock.s1 === null && s.time >= HALF) {
      s.clock.s1 = clamp(Math.ceil(s.lostSeconds[1] / 60), 1, MAX_ADDED_PER_HALF);
      s.clock.firstHalfEnd = 45 + s.clock.s1;
      emit(s, 'stoppage_start', { minutes: s.clock.s1 });
    }
    if (!s.halfStarted && s.clock.firstHalfEnd !== null && s.time >= s.clock.firstHalfEnd * 60) {
      emit(s, 'halftime', { score: { ...s.score } });
      s.halfStarted = true; s.half = 2; s.dirs.home = -1; s.dirs.away = 1;
      setDeadBall(s, 'halftime', 'away', { x: FIELD.length / 2, y: FIELD.width / 2 }, { minWait: 15, resetFormation: true });
    }
    if (s.half === 2 && s.clock.s2 === null && s.time >= (s.clock.firstHalfEnd + 45) * 60) {
      s.clock.s2 = clamp(Math.ceil(s.lostSeconds[2] / 60), 1, MAX_ADDED_PER_HALF);
      s.clock.matchEnd = 90 + s.clock.s1 + s.clock.s2;
      emit(s, 'stoppage_start', { minutes: s.clock.s2 });
    }
    if (s.clock.matchEnd !== null && s.time >= s.clock.matchEnd * 60) {
      s.phase = 'ended'; s.ended = true; s.ball.mode = 'dead'; s.ball.carrierId = null;
      emit(s, 'full_time', { score: { ...s.score } });
      return;
    }
    if (s.dead) {
      if (s.dead.kind !== 'halftime') s.lostSeconds[s.half] += STEP;
      moveDuringStoppage(s); return;
    }
    if (s.possessionTeam) s.stats[s.possessionTeam].possessionSeconds += STEP;
    const previousPositions = s.flight ? new Map(s.players.map(player => [player.id, copyPoint(player)])) : null;
    targetsForPlay(s);
    if (s.ball.mode === 'controlled') {
      challenge(s);
      if (s.ball.mode === 'controlled' && !s.dead) decide(s);
    } else if (s.flight) moveFlight(s, previousPositions);
    else if (s.ball.mode === 'loose') moveLoose(s);
  }
  return { VERSION, FIELD, STEP, END, MAX_END, MAX_ADDED_PER_HALF, MAX_PLAYER_SPEED, MAX_BALL_SPEED, CONTROL_RADIUS, PASS_RANGE,
    createMatch, distance, pointOnSegment, movingContact, inPenaltyArea };
});
