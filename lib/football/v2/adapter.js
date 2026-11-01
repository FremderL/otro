'use strict';

// El replay completo es privado. Solo deriveReplay entrega el prefijo visible.
const crypto = require('node:crypto');
const { current, simulatorFor } = require('./versions');
const { secureRandom } = require('./secure-random');
const { generateCommentary, createMemory, formatScore } = require('../commentary');
const { CLUB_BY_ID } = require('../teams');

const FRAME_COUNT = current.MAX_END / current.STEP + 1;
const PLAYERS = 22;
// 65 campos anteriores + identidad/estado de cada uno de los 22 puestos.
const STRIDE = 87;
const STAT_NAMES = ['shots', 'shotsOnTarget', 'passes', 'completedPasses', 'corners', 'fouls', 'possessionSeconds'];
const PHASES = { play: 0, stopped: 1, halftime: 2, ended: 3, shootout: 4 };
const EXPOSED_EVENTS = new Set(['kickoff', 'goal_restart', 'second_half', 'halftime', 'full_time', 'goal',
  'shot', 'save', 'block', 'corner', 'foul', 'penalty_awarded', 'restart', 'throw_in', 'goal_kick',
  'substitution', 'yellow_card', 'red_card', 'second_yellow', 'stoppage_start', 'extra_time_start', 'extra_time_half',
  'shootout_start', 'shootout_attempt', 'shootout_kick', 'shootout_end']);
const EVENT_PHASE = { kickoff: 'kickoff', goal_restart: 'kickoff', second_half: 'build_up', halftime: 'halftime', full_time: 'ended',
  goal: 'goal_celebration', shot: 'attack', save: 'build_up', block: 'build_up', corner: 'set_piece',
  foul: 'set_piece', penalty_awarded: 'set_piece', restart: 'build_up', throw_in: 'set_piece', goal_kick: 'set_piece',
  substitution: 'set_piece', yellow_card: 'set_piece', red_card: 'set_piece', second_yellow: 'set_piece', stoppage_start: 'build_up',
  extra_time_start: 'extra_time', extra_time_half: 'set_piece', shootout_start: 'shootout',
  shootout_attempt: 'shootout', shootout_kick: 'shootout', shootout_end: 'ended' };

function point(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: Math.max(0, Math.min(1, value.x / current.FIELD.length)),
      y: Math.max(0, Math.min(1, value.y / current.FIELD.width)) } : null;
}

function frameWrite(buffer, index, snapshot, playerIndices) {
  const offset = index * STRIDE;
  buffer[offset] = snapshot.ball.x;
  buffer[offset + 1] = snapshot.ball.y;
  if (snapshot.players.length !== PLAYERS) throw new Error('cantidad de puestos inválida');
  snapshot.players.forEach((player, i) => {
    const rosterIndex = playerIndices.get(player.id);
    if (rosterIndex === undefined) throw new Error('jugador fuera de la plantilla');
    buffer[offset + 2 + i * 2] = player.x;
    buffer[offset + 3 + i * 2] = player.y;
    buffer[offset + 65 + i] = (rosterIndex + 1) * (player.active === false ? -1 : 1);
  });
  buffer[offset + 46] = snapshot.possessionTeam === 'home' ? 0 : snapshot.possessionTeam === 'away' ? 1 : -1;
  buffer[offset + 47] = playerIndices.has(snapshot.ball.carrierId) ? playerIndices.get(snapshot.ball.carrierId) : -1;
  buffer[offset + 48] = PHASES[snapshot.phase] ?? 1;
  buffer[offset + 49] = snapshot.score.home;
  buffer[offset + 50] = snapshot.score.away;
  for (let side = 0; side < 2; side++) {
    const stats = snapshot.stats[side === 0 ? 'home' : 'away'];
    STAT_NAMES.forEach((name, i) => { buffer[offset + 51 + side * 7 + i] = stats[name]; });
  }
}

function clockLabel(time, clock) {
  const firstEnd = clock.firstHalfEnd || 45;
  const s1 = clock.s1 || 0;
  if (clock.shootoutStart != null && time >= clock.shootoutStart) return 'PEN';
  if (clock.extraTimeStart != null && time >= clock.extraTimeStart) {
    return String(Math.min(120, 90 + Math.floor(time - clock.extraTimeStart)));
  }
  if (time >= 45 && time < firstEnd) return `45+${Math.floor(time - 45) + 1}`;
  if (time >= firstEnd + 45 && time < (clock.regularEnd || clock.matchEnd)) return `90+${Math.floor(time - firstEnd - 45) + 1}`;
  const nominal = time < firstEnd ? time : time - s1;
  return String(Math.max(0, Math.min(90, Math.floor(nominal))));
}

function convertEvents(events, lineups, input, keyHex, clock, step) {
  const people = new Map(['home', 'away'].flatMap(side => lineups[side].players.map(player => [player.id, player])));
  const shots = new Map();
  const timeline = [];
  const memory = createMemory();
  const commentRandom = secureRandom(keyHex, 'commentary');
  const runningScore = { home: 0, away: 0 };
  for (const raw of events) {
    if (raw.type === 'shot') shots.set(raw.sequence, raw);
    if (!EXPOSED_EVENTS.has(raw.type)) continue;
    const shot = raw.type === 'goal' ? shots.get(raw.sequence) : null;
    if (raw.type === 'goal' && (!shot || shot.playerId !== raw.playerId || shot.team !== raw.team)) {
      throw new Error('gol sin tiro causal');
    }
    // En la primera versión el saque tras gol se llamaba kickoff. No debe
    // reiniciar el marcador de los espectadores al retransmitirlo.
    const action = raw.type === 'kickoff' && raw.time > 0 ? 'goal_restart' : raw.type;
    const type = raw.type === 'goal' && shot.penalty ? 'penalty_scored'
      : action === 'shot' && raw.targetOnGoal ? 'shot_on_target' : action;
    const actor = people.get(raw.playerId);
    const outgoing = people.get(raw.playerOutId);
    const actorPoint = point(raw.playerPosition || raw.from || raw.position);
    const event = {
      i: timeline.length, t: raw.time / 60, tick: Math.round(raw.time / step), type, team: raw.team || null,
      phase: EVENT_PHASE[action], half: raw.half || (raw.type === 'halftime' || raw.time < current.END / 2 ? 1 : 2),
      clockLabel: raw.type === 'halftime' && clock.s1 ? `45+${clock.s1}`
        : raw.type === 'full_time' && raw.half <= 2 && clock.s2 ? `90+${clock.s2}` : clockLabel(raw.time / 60, clock)
    };
    if (raw.playerId) event.playerId = raw.playerId;
    if (actor && actor.name) event.playerName = actor.name;
    if (raw.playerInId) { event.playerInId = raw.playerInId; event.playerInName = actor && actor.name; }
    if (raw.playerOutId) { event.playerOutId = raw.playerOutId; event.playerOutName = outgoing && outgoing.name; }
    if (raw.slotIndex != null) event.slotIndex = raw.slotIndex;
    if (raw.sequence != null) event.sequenceId = String(raw.sequence);
    if (raw.restartType) event.restartType = raw.restartType;
    if (raw.minutes != null) event.addedMinutes = raw.minutes;
    if (raw.scored != null) { event.scored = Boolean(raw.scored); event.resultado = raw.scored ? 'gol' : 'fallo'; }
    if (raw.suddenDeath != null) event.suddenDeath = Boolean(raw.suddenDeath);
    if (raw.marks) event.marcadorTanda = `${raw.marks.home}-${raw.marks.away}`;
    if (actorPoint) { event.ball = actorPoint; event.actorPosition = { ...actorPoint }; }
    if (type === 'goal' || type === 'penalty_scored') {
      runningScore[raw.team]++;
      event.outcome = 'goal'; event.crossedGoalLine = true;
    }
    event.marcador = formatScore(runningScore);
    const attack = raw.team === 'away' ? input.away : input.home;
    const defend = raw.team === 'away' ? input.home : input.away;
    const vars = { equipo: attack.name, rival: defend.name, estadio: input.home.stadium || CLUB_BY_ID[input.home.id]?.stadium,
      jugador: event.playerName, sale: event.playerOutName, minuto: event.clockLabel, marcador: event.marcador,
      resultado: event.resultado, marcadorTanda: event.marcadorTanda };
    event.commentary = type === 'stoppage_start'
      ? [{ voice: 'narrador', text: `El árbitro añade ${raw.minutes} minuto${raw.minutes === 1 ? '' : 's'} en ${raw.half === 1 ? 'el primer' : 'el segundo'} tiempo.` }]
      : generateCommentary(type, vars, commentRandom, memory);
    timeline.push(event);
  }
  return timeline;
}

function generateReplay(input, keyHex) {
  const simulator = simulatorFor(input?.version);
  if (!simulator || !input.home?.lineup || !input.away?.lineup) throw new Error('versión o entradas V2 inválidas');
  const simulation = simulator.createMatch({ ...input, random: secureRandom(keyHex, 'game') });
  const first = simulation.snapshot();
  const lineups = JSON.parse(JSON.stringify({ home: input.home.lineup, away: input.away.lineup }));
  const players = ['home', 'away'].flatMap(side => lineups[side].players.map(player => ({
    id: player.id, team: side, name: player.name, number: player.number, pos: player.pos,
    role: player.role, slotIndex: player.slotIndex, initialStatus: player.initialStatus
  })));
  if (new Set(players.map(player => player.id)).size !== players.length) throw new Error('jugadores duplicados');
  const indices = new Map(players.map((player, index) => [player.id, index]));
  const maxEnd = input.knockout && simulator.MAX_KNOCKOUT_END ? simulator.MAX_KNOCKOUT_END : (simulator.MAX_END || simulator.END);
  const maxFrames = maxEnd / simulator.STEP + 1;
  const buffer = new Float32Array(maxFrames * STRIDE);
  frameWrite(buffer, 0, first, indices);
  let snapshot = first, frameCount = 1;
  while (!snapshot.ended && frameCount < maxFrames) {
    snapshot = simulation.step();
    frameWrite(buffer, frameCount++, snapshot, indices);
  }
  if (!snapshot.ended || snapshot.time < simulator.END || snapshot.time > maxEnd) {
    throw new Error('partido incompleto');
  }
  const clock = snapshot.clock || { s1: 0, s2: 0, firstHalfEnd: 45, matchEnd: 90 };
  const timeline = convertEvents(simulation.eventsAfter(-1), lineups, input, keyHex, clock, simulator.STEP);
  Object.defineProperty(timeline, 'lineups', { value: lineups, enumerable: false });
  return { version: simulator.VERSION, frames: buffer.subarray(0, frameCount * STRIDE), frameCount,
    players, timeline, lineups, clock, score: { ...snapshot.score },
    ...(snapshot.result ? { result: { ...snapshot.score, ...snapshot.result } } : {}),
    inputHash: crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex') };
}

function deriveReplay(replay, minute, { pre = false } = {}) {
  const simulator = simulatorFor(replay?.version);
  if (!simulator || !(replay.frames instanceof Float32Array)) throw new Error('replay inválido');
  const time = Number.isFinite(minute) ? Math.max(0, Math.min(replay.clock.matchEnd, minute)) : 0;
  // Un tiempo exactamente alineado a un frame puede caer una ULP por debajo
  // al convertir minutos→frames. Compensar solo el error numérico evita
  // ocultar eventos del mismo tick en los límites de revelación.
  const frame = Math.min(replay.frameCount - 1, Math.floor(time * 60 / simulator.STEP + 1e-9));
  const offset = frame * STRIDE;
  const read = index => replay.frames[offset + index];
  const readStat = (side, name) => read(51 + (side === 'home' ? 0 : 7) + STAT_NAMES.indexOf(name));
  const pair = name => ({ home: readStat('home', name), away: readStat('away', name) });
  const elapsedHome = readStat('home', 'possessionSeconds'), elapsedAway = readStat('away', 'possessionSeconds');
  const elapsedTotal = elapsedHome + elapsedAway;
  const possession = elapsedTotal ? { home: elapsedHome / elapsedTotal, away: elapsedAway / elapsedTotal } : { home: 0.5, away: 0.5 };
  const code = read(48), carrier = read(47);
  let revealedIndex = -1;
  if (!pre) {
    let low = 0, high = replay.timeline.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (replay.timeline[middle].tick <= frame) low = middle + 1; else high = middle;
    }
    revealedIndex = low - 1;
  }
  const slots = new Map();
  for (let i = 0; i < PLAYERS; i++) {
    const encoded = read(65 + i), index = Math.abs(encoded) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= replay.players.length) throw new Error('fotograma de plantilla inválido');
    slots.set(index, { active: encoded > 0, status: encoded > 0 ? 'active' : 'sent_off',
      slotIndex: i % 11, x: read(2 + i * 2) / simulator.FIELD.length, y: read(3 + i * 2) / simulator.FIELD.width });
  }
  const substituted = new Set();
  const cards = { home: [], away: [] }, subs = { home: [], away: [] }, redCards = { home: 0, away: 0 };
  let shootout = null;
  for (let i = 0; i <= revealedIndex; i++) {
    const event = replay.timeline[i];
    if (event.type === 'substitution') { substituted.add(event.playerOutId); subs[event.team].push(event.playerInId); }
    if (event.type === 'shootout_start') shootout = { home: 0, away: 0 };
    if (event.type === 'shootout_kick' && shootout && event.scored) shootout[event.team]++;
    if (['yellow_card', 'second_yellow', 'red_card'].includes(event.type)) {
      cards[event.team].push({ playerId: event.playerId, type: event.type });
      if (event.type !== 'yellow_card') redCards[event.team]++;
    }
  }
  const state = {
    minute: time, displayMinute: time, clockLabel: clockLabel(time, replay.clock),
    half: replay.clock.shootoutStart != null && time >= replay.clock.shootoutStart ? 4
      : replay.clock.extraTimeStart != null && time >= replay.clock.extraTimeStart ? 3
        : time < replay.clock.firstHalfEnd ? 1 : 2,
    phase: pre ? 'pre' : code === 3 ? 'ended' : code === 4 ? 'shootout' : code === 2 ? 'halftime'
      : code === 1 ? 'set_piece' : replay.clock.extraTimeStart != null && time >= replay.clock.extraTimeStart ? 'extra_time' : 'build_up',
    score: { home: read(49), away: read(50) },
    ...(shootout ? { shootout } : {}),
    xG: null, possession, shots: pair('shots'), shotsOnTarget: pair('shotsOnTarget'),
    corners: pair('corners'), fouls: pair('fouls'), cards, subs, redCards,
    ball: { x: read(0) / simulator.FIELD.length, y: read(1) / simulator.FIELD.width },
    possessionTeam: read(46) === 0 ? 'home' : read(46) === 1 ? 'away' : null,
    ballCarrierId: carrier >= 0 && carrier < replay.players.length ? replay.players[carrier].id : null,
    formation: { home: replay.lineups.home.formation, away: replay.lineups.away.formation },
    players: replay.players.map((player, index) => ({ ...player,
      ...(slots.get(index) || { active: false, status: substituted.has(player.id) ? 'substituted' : 'bench', x: .5, y: .5 }) })),
    roster: Object.fromEntries(['home', 'away'].map(side => [side, replay.lineups[side].players.map(player => ({
      id: player.id, name: player.name, number: player.number, pos: player.pos
    }))])),
    playStopped: pre || code !== 0,
    lastAction: revealedIndex >= 0 ? replay.timeline[revealedIndex].type : null
  };
  return { state, revealedIndex };
}

module.exports = { FRAME_COUNT, STRIDE, generateReplay, deriveReplay, clockLabel };
