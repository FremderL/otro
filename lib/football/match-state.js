'use strict';

// Estado autoritativo de partido. La línea de tiempo sigue siendo determinista
// (seed → eventos); este módulo hace que balón, posesión, plantillas, disciplina,
// cambios y posiciones sean una proyección única de esos eventos confirmados.

const { chance } = require('./prng');

const GOAL_RESTART_DELAY = 0.22;
const SET_PIECE_RESTART_DELAY = 0.08;

const POS_GROUP = {
  GK: 'GK', CB: 'DF', LB: 'DF', RB: 'DF', CDM: 'MF', CM: 'MF', CAM: 'MF',
  LW: 'FW', RW: 'FW', ST: 'FW'
};

const FORMATION_SLOTS = {
  '4-4-2': [
    { x: .04, y: .5, role: 'GK' }, { x: .2, y: .18, role: 'DF' }, { x: .2, y: .39, role: 'DF' },
    { x: .2, y: .61, role: 'DF' }, { x: .2, y: .82, role: 'DF' }, { x: .46, y: .15, role: 'MF' },
    { x: .46, y: .38, role: 'MF' }, { x: .46, y: .62, role: 'MF' }, { x: .46, y: .85, role: 'MF' },
    { x: .72, y: .4, role: 'FW' }, { x: .72, y: .6, role: 'FW' }
  ],
  '4-3-3': [
    { x: .04, y: .5, role: 'GK' }, { x: .2, y: .18, role: 'DF' }, { x: .2, y: .39, role: 'DF' },
    { x: .2, y: .61, role: 'DF' }, { x: .2, y: .82, role: 'DF' }, { x: .46, y: .3, role: 'MF' },
    { x: .46, y: .5, role: 'MF' }, { x: .46, y: .7, role: 'MF' }, { x: .72, y: .2, role: 'FW' },
    { x: .72, y: .5, role: 'FW' }, { x: .72, y: .8, role: 'FW' }
  ],
  '3-5-2': [
    { x: .04, y: .5, role: 'GK' }, { x: .2, y: .3, role: 'DF' }, { x: .2, y: .5, role: 'DF' },
    { x: .2, y: .7, role: 'DF' }, { x: .46, y: .12, role: 'MF' }, { x: .46, y: .31, role: 'MF' },
    { x: .46, y: .5, role: 'MF' }, { x: .46, y: .69, role: 'MF' }, { x: .46, y: .88, role: 'MF' },
    { x: .72, y: .4, role: 'FW' }, { x: .72, y: .6, role: 'FW' }
  ],
  '4-2-3-1': [
    { x: .04, y: .5, role: 'GK' }, { x: .2, y: .18, role: 'DF' }, { x: .2, y: .39, role: 'DF' },
    { x: .2, y: .61, role: 'DF' }, { x: .2, y: .82, role: 'DF' }, { x: .4, y: .4, role: 'MF' },
    { x: .4, y: .6, role: 'MF' }, { x: .56, y: .22, role: 'MF' }, { x: .56, y: .5, role: 'MF' },
    { x: .56, y: .78, role: 'MF' }, { x: .76, y: .5, role: 'FW' }
  ]
};

const FORMATION_ROLES = {
  '4-4-2': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'],
  '4-3-3': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'],
  '3-5-2': ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'],
  '4-2-3-1': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW']
};

const STRUCTURAL = new Set(['kickoff', 'halftime', 'second_half', 'full_time', 'extra_time_start', 'extra_time_end', 'shootout_start', 'shootout_end']);
const STOPPAGE = new Set(['foul', 'offside', 'corner', 'throw_in', 'goal_kick', 'substitution']);
const TIE_ORDER = {
  kickoff: 0, goal_restart: 0, restart: 1, halftime: 2, second_half: 3,
  substitution: 4, penalty_awarded: 5, penalty_scored: 6, penalty_missed: 6,
  foul: 7, yellow_card: 8, red_card: 8, second_yellow: 8,
  shot: 9, shot_on_target: 9, goal: 9, save: 10,
  pass_sequence: 11, possession_change: 11, full_time: 20
};

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round(value, places = 3) { const f = 10 ** places; return Math.round(value * f) / f; }
function otherSide(side) { return side === 'home' ? 'away' : side === 'away' ? 'home' : null; }
function randRange(random, min, max) { return min + random() * (max - min); }

function weightedPick(random, items, weightFn) {
  if (!items.length) return null;
  const weights = items.map(item => Math.max(0, weightFn(item)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return items[Math.floor(random() * items.length)];
  let roll = random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

function createTeamLineup(team) {
  const formation = FORMATION_SLOTS[team.tactics.formation] ? team.tactics.formation : '4-4-2';
  const remaining = team.squad.filter(player => player.num <= 11).slice();
  const assigned = new Map();
  const preference = (player, role) => {
    const group = POS_GROUP[player.pos] || 'MF';
    if (role === 'GK') return group === 'GK' ? 0 : 50;
    if (role === 'DF') return group === 'DF' ? (player.pos === 'CB' ? 0 : 1) : 50;
    if (role === 'MF') return group === 'MF' ? 0 : (group === 'DF' && ['RB', 'LB'].includes(player.pos) ? 1 : group === 'FW' ? 2 : 50);
    if (role === 'FW') return group === 'FW' ? 0 : (player.pos === 'CAM' ? 1 : group === 'MF' ? 2 : 50);
    return 50;
  };
  FORMATION_ROLES[formation].forEach((role, slotIndex) => {
    const candidates = remaining.slice().sort((a, b) => preference(a, role) - preference(b, role) || a.num - b.num);
    const selected = candidates[0];
    if (!selected || preference(selected, role) >= 50) return;
    assigned.set(selected.id, { slotIndex, role });
    remaining.splice(remaining.findIndex(player => player.id === selected.id), 1);
  });
  return {
    teamId: team.id,
    formation,
    style: team.tactics.style,
    goalkeeperRating: Number(team.ratings && team.ratings.gk) || 1,
    players: team.squad.map(player => {
      const slot = assigned.get(player.id);
      return {
        id: player.id, name: player.name, number: player.num, pos: player.pos,
        attrs: { ...player.attrs }, slotIndex: slot ? slot.slotIndex : null,
        role: slot ? slot.role : (POS_GROUP[player.pos] || 'MF'),
        initialStatus: slot ? 'active' : 'bench'
      };
    })
  };
}

function createLineups(home, away) {
  return { home: createTeamLineup(home), away: createTeamLineup(away) };
}

function playerAvailableAt(player, side, half, nominal, substitutions = []) {
  let active = player.initialStatus === 'active';
  for (const sub of substitutions) {
    if (sub.team !== side) continue;
    const hasEntered = sub.half < half || (sub.half === half && sub.nominal <= nominal);
    if (!hasEntered) continue;
    if (player.id === sub.playerOutId) active = false;
    if (player.id === sub.playerInId) active = true;
  }
  return active;
}

function activePlayersAt(lineup, side, half, nominal, substitutions = [], { outfield = false, dismissals = [] } = {}) {
  const players = lineup.players.filter(player => playerAvailableAt(player, side, half, nominal, substitutions)
    && !dismissals.some(card => card.team === side && card.playerId === player.id
      && (card.half < half || (card.half === half && card.nominal <= nominal))));
  return outfield ? players.filter(player => POS_GROUP[player.pos] !== 'GK') : players;
}

function chooseGoalkeeper(lineup, side, half = 1, nominal = 0, substitutions = [], dismissals = []) {
  const active = activePlayersAt(lineup, side, half, nominal, substitutions, { dismissals });
  return active.find(player => POS_GROUP[player.pos] === 'GK')
    || active.slice().sort((a, b) => (Number(b.attrs.gk) || 0) - (Number(a.attrs.gk) || 0))[0] || null;
}

function cmpEvents(a, b) {
  return (a.t - b.t) || ((TIE_ORDER[a.type] ?? 15) - (TIE_ORDER[b.type] ?? 15)) || ((a._order ?? 0) - (b._order ?? 0));
}

// Las interrupciones tienen un evento de reanudación explícito. Los eventos no
// estructurales que caen dentro de la pausa se llevan al instante de reanudación;
// así no se puede narrar un tiro/pase de la jugada anterior mientras el balón está parado.
function normalizeTransitions(events, clock) {
  const source = events.map((event, index) => ({ ...event, _order: index }));
  const sequenceOf = event => {
    // Un remate desviado y su saque de meta forman una sola acción: nada puede
    // colarse entre el balón que sale y el reinicio de juego.
    if (event.type === 'goal_kick' && event.sequenceId && event.sequenceId.startsWith('goal_kick_')) {
      return event.sequenceId.slice('goal_kick_'.length);
    }
    return event.sequenceId || null;
  };
  const bySequence = new Map();
  const units = [];
  for (const event of source) {
    const key = sequenceOf(event);
    if (!key) {
      units.push({ events: [event], start: event.t, end: event.t });
      continue;
    }
    if (!bySequence.has(key)) bySequence.set(key, []);
    bySequence.get(key).push(event);
  }
  for (const grouped of bySequence.values()) {
    grouped.sort(cmpEvents);
    units.push({ events: grouped, start: grouped[0].t, end: Math.max(...grouped.map(event => event.t)) });
  }
  units.sort((a, b) => cmpEvents(a.events[0], b.events[0]));

  const normalized = [];
  let blockedUntil = -Infinity;
  let blockedSequence = null;
  let atomicUntil = -Infinity;
  let restartSequence = 0;

  for (const unit of units) {
    const structural = unit.events.every(event => STRUCTURAL.has(event.type));
    let moveTo = -Infinity;
    if (!structural) {
      if (unit.start < blockedUntil) moveTo = Math.max(moveTo, blockedUntil);
      // Secuencias como tiro-atajada y penal-señalado/resultado son indivisibles.
      // Un cambio, falta u otra acción que caiga en medio espera a que la secuencia
      // termine (un centésimo después evita invertir el orden en el empate).
      if (unit.start <= atomicUntil) moveTo = Math.max(moveTo, atomicUntil + 0.01);
    }
    const shift = Number.isFinite(moveTo) ? Math.max(0, moveTo - unit.start) : 0;
    if (shift > 0) {
      for (const event of unit.events) {
        event.t = round(event.t + shift, 2);
        if (event.t >= clock.firstHalfEnd && event.half === 1) event.half = 2;
        if (event.t >= clock.matchEnd) event.t = round(clock.matchEnd - 0.01, 2);
      }
    }

    for (const event of unit.events) {
      const sameSequence = Boolean(blockedSequence && event.sequenceId === blockedSequence);
      if (Number.isFinite(blockedUntil) && event.t < blockedUntil && !STRUCTURAL.has(event.type) && !sameSequence) {
        event.t = round(blockedUntil, 2);
        if (event.t >= clock.firstHalfEnd && event.half === 1) event.half = 2;
        if (event.t >= clock.matchEnd) event.t = round(clock.matchEnd - 0.01, 2);
      } else if (event.t >= blockedUntil && !sameSequence) {
        blockedUntil = -Infinity;
        blockedSequence = null;
      }
      normalized.push(event);

      const boundary = event.half === 1 ? clock.firstHalfEnd
        : event.half === 3 ? (clock.extraTimeEnd || clock.matchEnd)
          : event.half === 4 ? (clock.shootoutEnd || clock.matchEnd) : clock.matchEnd;
      if (event.type === 'goal' || event.type === 'penalty_scored') {
        if (event.half !== 4) {
          const restartAt = round(Math.min(event.t + GOAL_RESTART_DELAY, boundary), 2);
          const restartSequenceId = `goal_restart_${++restartSequence}`;
          if (restartAt > event.t && restartAt < boundary) {
            normalized.push({
              t: restartAt, type: 'goal_restart', team: otherSide(event.team),
              half: event.half, sequenceId: restartSequenceId, restartType: 'kickoff', _order: source.length + restartSequence
            });
          }
          // Si el período termina antes de la pausa de gol, no hay saque de centro
          // al borde del silbatazo: el reinicio reglamentario ocurre tras la pausa.
          blockedUntil = restartAt;
          blockedSequence = restartSequenceId;
        } else if (sameSequence) {
          blockedUntil = -Infinity;
          blockedSequence = null;
        }
      } else if (event.type === 'penalty_awarded') {
        blockedUntil = round(Math.min(event.t + 0.4, boundary), 2);
        blockedSequence = event.sequenceId || `penalty_${++restartSequence}`;
      } else if ((event.type === 'penalty_missed' && event.outcome !== 'saved') || STOPPAGE.has(event.type)) {
        const sequenceId = event.sequenceId || `restart_${++restartSequence}`;
        event.sequenceId = sequenceId;
        const restartAt = round(Math.min(event.t + SET_PIECE_RESTART_DELAY, boundary), 2);
        if (restartAt > event.t && restartAt < boundary) {
          const restartType = event.type === 'penalty_missed' ? 'goal_kick'
            : event.type === 'substitution' ? 'play' : event.type;
          const beneficiary = event.beneficiaryTeam || (event.type === 'penalty_missed' ? otherSide(event.team) : event.team);
          normalized.push({
            t: restartAt, type: 'restart', team: beneficiary,
            half: event.half, sequenceId: `restart_${sequenceId}`, restartFor: sequenceId,
            restartType, _order: source.length + ++restartSequence
          });
        }
        // El descanso/final puede llegar antes de ejecutar el reinicio; en ese caso
        // se conserva la pausa hasta el límite, pero no se inventa una reanudación.
        blockedUntil = restartAt;
        // Tarjetas con la misma secuencia pertenecen a la falta, no al reinicio.
        blockedSequence = sequenceId;
      } else if (event.type === 'penalty_scored' || event.type === 'penalty_missed') {
        if (sameSequence) { blockedUntil = -Infinity; blockedSequence = null; }
      }
    }

    if (unit.end > unit.start) {
      const normalizedEnd = Math.max(...unit.events.map(event => event.t));
      atomicUntil = Math.max(atomicUntil, normalizedEnd);
    }
  }

  normalized.sort(cmpEvents);
  return normalized.map(({ _order, ...event }) => ({ ...event, t: round(event.t, 2) }));
}

function formationPosition(player, side, lineup, ball, possessionTeam, phase = null) {
  let slot = player.slotIndex == null ? null : FORMATION_SLOTS[lineup.formation][player.slotIndex];
  if (!slot) slot = FORMATION_SLOTS[lineup.formation].find(item => item.role === (player.role || 'MF')) || FORMATION_SLOTS[lineup.formation][5];
  const ownBallX = side === 'home' ? ball.x : 1 - ball.x;
  const hasPossession = possessionTeam === side;
  const attrs = player.attrs || {};
  const pacBonus = ((Number(attrs.pac) || 65) - 65) * 0.0003;
  const defBonus = ((Number(attrs.def) || 55) - 55) * 0.0003;

  let ownX;
  if (player.role === 'GK' || POS_GROUP[player.pos] === 'GK') {
    ownX = .035 + clamp(ownBallX - .55, 0, .35) * .08;
  } else {
    const roleAdvance = (player.role === 'FW' ? .05 : player.role === 'MF' ? .02 : 0) + pacBonus;
    const defensiveDepth = hasPossession ? 0 : ((player.role === 'DF' ? .015 : 0) + defBonus);
    ownX = clamp(slot.x + (ownBallX - .5) * .14 + (hasPossession ? roleAdvance : defensiveDepth), .025, .97);
  }

  // Restricción estricta de saque de centro / reinicio de gol:
  // Los jugadores no pueden estar en el campo contrario durante el saque
  const isKickoff = phase === 'kickoff' || (ball.x === 0.5 && ball.y === 0.5 && ['kickoff', 'goal_celebration'].includes(phase));
  if (isKickoff) {
    ownX = clamp(ownX, 0.025, 0.485);
    if (!hasPossession) {
      ownX = Math.min(ownX, 0.40);
    }
  }

  const x = side === 'home' ? ownX : 1 - ownX;
  const yTracking = player.role === 'GK' ? .2 : (player.role === 'DF' ? .08 : .12);
  const y = clamp(slot.y + (ball.y - slot.y) * yTracking, .035, .965);
  return { x: round(x), y: round(y) };
}

function chooseNearest(players, lineup, side, ball, possessionTeam, phase = null) {
  let nearest = null;
  let best = Infinity;
  for (const player of players) {
    if (POS_GROUP[player.pos] === 'GK') continue;
    const point = formationPosition(player, side, lineup, ball, possessionTeam, phase);
    const d = Math.hypot((point.x - ball.x), (point.y - ball.y) * 1.5);
    if (d < best) { best = d; nearest = player; }
  }
  return nearest;
}

function attackerApproach(side, random, spot = false) {
  const ownX = spot ? .89 : randRange(random, .79, .87);
  return { x: round(side === 'home' ? ownX : 1 - ownX), y: round(spot ? .5 : randRange(random, .3, .7)) };
}

function goalMouth(side, random, crossed = false) {
  const lineX = crossed
    ? (side === 'home' ? 1.01 : -0.01)
    : (side === 'home' ? 1 : 0);
  return { x: lineX, y: round(clamp(.5 + randRange(random, -.035, .035), .455, .545)), crossedGoalLine: Boolean(crossed) };
}

function goalArea(side) { return { x: side === 'home' ? .045 : .955, y: .5 }; }

function setBall(event, next, action, from, priorBall, deltaMinutes) {
  const safe = { x: round(clamp(next.x, -0.01, 1.01)), y: round(clamp(next.y, 0, 1)) };
  const previous = from || priorBall;
  const dt = Math.max(.05, Number(deltaMinutes) || .05);
  event.ball = safe;
  event.ballFrom = previous ? { x: round(previous.x), y: round(previous.y) } : { ...safe };
  event.ballAction = action;
  event.ballVelocity = {
    x: round((safe.x - event.ballFrom.x) / dt, 4),
    y: round((safe.y - event.ballFrom.y) / dt, 4)
  };
}

function normalizeAndDecorateTimeline(events, { home, away, lineups, random, clock, initialState = null }) {
  const normalized = normalizeTransitions(events, clock);
  const dismissals = new Map();
  normalized.forEach((event, index) => {
    if (event.type !== 'red_card' && event.type !== 'second_yellow') return;
    const key = `${event.team}|${event.playerId}`;
    if (!dismissals.has(key)) dismissals.set(key, []);
    dismissals.get(key).push({ t: event.t, index });
  });
  const cancelledSubs = new Set();
  normalized.forEach((event, index) => {
    if (event.type !== 'substitution') return;
    const dismissalBefore = playerId => (dismissals.get(`${event.team}|${playerId}`) || [])
      .some(red => red.t < event.t || (red.t === event.t && red.index < index));
    if (dismissalBefore(event.playerOutId) || dismissalBefore(event.playerInId || event.playerId)) {
      cancelledSubs.add(event.sequenceId);
    }
  });
  const ordered = normalized.filter(event => !(event.type === 'substitution' && cancelledSubs.has(event.sequenceId))
    && !(event.type === 'restart' && cancelledSubs.has(event.restartFor)));
  const sideLineups = lineups || createLineups(home, away);
  const playerStatus = {
    home: new Map(sideLineups.home.players.map(player => [player.id, { status: player.initialStatus, slotIndex: player.slotIndex, role: player.role }])),
    away: new Map(sideLineups.away.players.map(player => [player.id, { status: player.initialStatus, slotIndex: player.slotIndex, role: player.role }]))
  };
  for (const player of (initialState && initialState.players) || []) {
    const status = playerStatus[player.team] && playerStatus[player.team].get(player.id);
    if (status) { status.status = player.status; status.slotIndex = player.slotIndex; status.role = player.role || status.role; }
  }
  const lookup = {
    home: new Map(sideLineups.home.players.map(player => [player.id, player])),
    away: new Map(sideLineups.away.players.map(player => [player.id, player]))
  };
  const stoppageSpots = new Map();
  let ball = initialState && initialState.ball
    ? { x: initialState.ball.x, y: initialState.ball.y }
    : { x: .5, y: .5 };
  let possessionTeam = initialState && initialState.possessionTeam || 'home';
  let carrierId = initialState && initialState.ballCarrierId || null;
  let lastTime = initialState && Number.isFinite(initialState.minute) ? initialState.minute : 0;
  const passWeight = player => 1 + (Number(player.attrs.pas) || 50) / 100;
  const getActive = (side, { outfield = false } = {}) => sideLineups[side].players.flatMap(player => {
    const status = playerStatus[side].get(player.id);
    if (!status || status.status !== 'active' || (outfield && POS_GROUP[player.pos] === 'GK')) return [];
    return [{ ...player, slotIndex: status.slotIndex, role: status.role || player.role }];
  });
  const pickActive = (side, { outfield = false, preferredId = null } = {}) => {
    if (!side || !sideLineups[side]) return null;
    const active = getActive(side, { outfield });
    const preferred = preferredId && active.find(player => player.id === preferredId);
    if (preferred) return preferred;
    return weightedPick(random, active, passWeight);
  };
  const pickGoalkeeper = (side, preferredId = null) => {
    const active = getActive(side);
    const preferred = preferredId && active.find(player => player.id === preferredId);
    return preferred || active.find(player => POS_GROUP[player.pos] === 'GK')
      || active.slice().sort((a, b) => (Number(b.attrs.gk) || 0) - (Number(a.attrs.gk) || 0))[0] || null;
  };
  const nameActor = (event, player, prefix = '') => {
    if (!player) return;
    if (prefix) {
      event[`${prefix}Id`] = player.id;
      event[`${prefix}Name`] = player.name;
    } else {
      event.playerId = player.id;
      event.playerName = player.name;
    }
  };
  const ballDelta = (nextTime) => Math.max(.05, nextTime - lastTime);

  for (const event of ordered) {
    const previousBall = { ...ball };
    const dt = ballDelta(event.t);
    const side = event.team;
    const defender = otherSide(side);
    const prevPossession = possessionTeam;
    let next = { ...ball };
    let actorPosition = null;
    let nextCarrier = carrierId;
    let nextPossession = possessionTeam;
    let action = 'hold';

    if (event.type === 'kickoff' || event.type === 'second_half' || event.type === 'goal_restart') {
      const restartSide = event.team || (event.type === 'second_half' ? 'away' : 'home');
      const taker = pickActive(restartSide, { outfield: true, preferredId: event.playerId });
      nameActor(event, taker);
      actorPosition = { x: restartSide === 'home' ? .485 : .515, y: .5 };
      next = { x: .5, y: .5 };
      nextPossession = restartSide;
      nextCarrier = taker ? taker.id : null;
      action = 'kickoff';
    } else if (event.type === 'restart') {
      const restartType = event.restartType || 'free_kick';
      const spot = stoppageSpots.get(event.restartFor) || ball;
      const restartSide = spot.team || event.team;
      event.team = restartSide;
      const taker = pickActive(restartSide, { outfield: restartType !== 'goal_kick', preferredId: event.playerId });
      nameActor(event, taker);
      if (restartType === 'goal_kick') next = goalArea(restartSide);
      else next = { x: spot.x, y: spot.y };
      actorPosition = next;
      nextPossession = restartSide;
      nextCarrier = taker ? taker.id : null;
      action = `restart_${restartType}`;
    } else if (event.type === 'pass_sequence') {
      const passer = pickActive(side, { outfield: true, preferredId: carrierId });
      if (passer) nameActor(event, passer);
      const passerPosition = passer ? formationPosition(passer, side, sideLineups[side], ball, side) : ball;
      const candidates = getActive(side).filter(player => player.id !== (passer && passer.id) && POS_GROUP[player.pos] !== 'GK');
      const receiver = weightedPick(random, candidates, player => passWeight(player) / (1 + Math.hypot(formationPosition(player, side, sideLineups[side], ball, side).x - ball.x, formationPosition(player, side, sideLineups[side], ball, side).y - ball.y)));
      if (receiver) {
        nameActor(event, receiver, 'receiver');
        const target = formationPosition(receiver, side, sideLineups[side], ball, side);
        const attackDir = side === 'home' ? 1 : -1;
        next = {
          x: round(clamp(target.x + attackDir * .012, .04, .96)),
          y: round(clamp(target.y + randRange(random, -.012, .012), .05, .95))
        };
        nextCarrier = receiver.id;
        event.receiverPosition = { ...next };
      } else {
        next = { ...ball };
        nextCarrier = passer ? passer.id : null;
      }
      actorPosition = passerPosition;
      nextPossession = side;
      action = 'pass';
    } else if (event.type === 'possession_change') {
      const interceptor = chooseNearest(getActive(side, { outfield: true }), sideLineups[side], side, ball, side);
      if (interceptor) nameActor(event, interceptor);
      const target = interceptor ? formationPosition(interceptor, side, sideLineups[side], ball, side) : ball;
      next = { x: round(clamp((ball.x + target.x) / 2, .03, .97)), y: round(clamp((ball.y + target.y) / 2, .04, .96)) };
      actorPosition = target;
      nextPossession = side;
      nextCarrier = interceptor ? interceptor.id : null;
      action = 'interception';
    } else if (event.type === 'shot' || event.type === 'shot_on_target' || event.type === 'goal' || event.type === 'big_chance') {
      const shooter = pickActive(side, { outfield: true, preferredId: event.playerId });
      if (shooter) nameActor(event, shooter);
      if (event.assistId != null) {
        const assistants = getActive(side, { outfield: true }).filter(player => player.id !== (shooter && shooter.id));
        const assister = assistants.find(player => player.id === event.assistId)
          || weightedPick(random, assistants, passWeight);
        if (assister) { event.assistId = assister.id; event.assistName = assister.name; }
        else { delete event.assistId; delete event.assistName; }
      }
      const keeper = pickGoalkeeper(defender, event.keeperId);
      if (keeper) {
        event.keeperId = keeper.id;
        event.keeperName = keeper.name;
        event.keeperPosition = goalArea(defender);
      }
      const approach = attackerApproach(side, random);
      actorPosition = approach;
      let target;
      if (event.type === 'goal') target = goalMouth(side, random, true);
      else if (event.type === 'shot_on_target') target = goalMouth(side, random, false);
      else if (event.type === 'big_chance' && event.outcome !== 'wide') target = goalMouth(side, random, false);
      else target = { x: side === 'home' ? 1 : 0, y: chanceForWide(random) };
      next = target;
      nextCarrier = null;
      nextPossession = event.type === 'goal' ? null : side;
      action = event.type === 'goal' ? 'goal' : 'shot';
    } else if (event.type === 'save') {
      const keeperSide = event.team || defender;
      const keeper = pickGoalkeeper(keeperSide, event.keeperId || event.playerId);
      if (keeper) {
        nameActor(event, keeper);
        event.keeperId = keeper.id;
        event.keeperName = keeper.name;
      } else {
        event.keeperId = null;
        event.keeperName = null;
        event.playerId = null;
        event.playerName = null;
      }
      const goal = goalArea(keeperSide);
      event.keeperPosition = goal;
      next = { x: goal.x, y: clamp(ball.y, .43, .57) };
      actorPosition = goal;
      nextPossession = keeperSide;
      nextCarrier = keeper ? keeper.id : null;
      action = 'save';
    } else if (event.type === 'penalty_awarded') {
      const taker = pickActive(side, { outfield: true, preferredId: event.shooterId });
      const fouled = pickActive(side, { outfield: true, preferredId: event.fouledId || event.playerId });
      if (fouled) {
        nameActor(event, fouled);
        event.fouledId = fouled.id;
        event.fouledName = fouled.name;
      } else {
        event.playerId = null;
        event.fouledId = null;
        event.fouledName = null;
      }
      const fouler = pickActive(defender, { outfield: true, preferredId: event.foulerId });
      if (fouler) {
        nameActor(event, fouler, 'fouler');
        event.foulerId = fouler.id;
        event.foulerName = fouler.name;
      }
      event.shooterId = (taker && taker.id) || null;
      event.shooterName = (taker && taker.name) || null;
      const keeper = pickGoalkeeper(defender, event.keeperId);
      event.keeperId = keeper ? keeper.id : null;
      event.keeperName = keeper ? keeper.name : null;
      event.keeperPosition = goalArea(defender);
      next = attackerApproach(side, random, true);
      nextPossession = side;
      nextCarrier = null;
      action = 'penalty_awarded';
    } else if (event.type === 'penalty_scored' || event.type === 'penalty_missed') {
      const shooter = pickActive(side, { outfield: true, preferredId: event.playerId });
      if (shooter) {
        nameActor(event, shooter);
        event.shooterId = shooter.id;
        event.shooterName = shooter.name;
      }
      const spot = attackerApproach(side, random, true);
      actorPosition = spot;
      if (event.type === 'penalty_scored') {
        next = goalMouth(side, random, true);
        nextPossession = null;
        nextCarrier = null;
        action = 'penalty_goal';
      } else if (event.outcome === 'saved') {
        const saveSide = defender;
        const keeper = pickGoalkeeper(saveSide, event.keeperId);
        if (keeper) nameActor(event, keeper, 'keeper');
        event.keeperPosition = goalArea(saveSide);
        next = goalArea(saveSide);
        actorPosition = spot;
        nextPossession = saveSide;
        nextCarrier = keeper ? keeper.id : null;
        action = 'penalty_save';
      } else {
        next = { x: defender === 'away' ? 1 : 0, y: event.outcome === 'post' ? .51 : (chance(random, .5) ? .005 : .995) };
        nextPossession = defender;
        nextCarrier = null;
        action = `penalty_${event.outcome}`;
      }
    } else if (event.type === 'foul') {
      const fouler = pickActive(side, { outfield: true, preferredId: event.playerId });
      if (fouler) nameActor(event, fouler);
      const victim = defender ? pickActive(defender, { outfield: true, preferredId: event.victimId }) : null;
      if (victim) nameActor(event, victim, 'victim');
      nextPossession = event.beneficiaryTeam || defender;
      nextCarrier = null;
      action = 'foul';
      stoppageSpots.set(event.sequenceId, { ...ball });
    } else if (event.type === 'offside') {
      const attacker = pickActive(side, { outfield: true, preferredId: event.playerId });
      if (attacker) nameActor(event, attacker);
      next = attackerApproach(side, random);
      nextPossession = event.beneficiaryTeam || defender;
      nextCarrier = null;
      action = 'offside';
      stoppageSpots.set(event.sequenceId, { ...next });
    } else if (event.type === 'corner') {
      const kicker = pickActive(side, { outfield: true, preferredId: event.playerId });
      if (kicker) nameActor(event, kicker);
      next = { x: side === 'home' ? 1 : 0, y: event.cornerSide === 'bottom' ? 1 : 0 };
      nextPossession = side;
      nextCarrier = null;
      action = 'corner';
      stoppageSpots.set(event.sequenceId, { ...next });
    } else if (event.type === 'throw_in') {
      const thrower = pickActive(side, { outfield: true, preferredId: event.playerId });
      if (thrower) nameActor(event, thrower);
      const x = round(clamp(ball.x + randRange(random, -.08, .08), .08, .92));
      next = { x, y: event.lineSide === 'bottom' ? 1 : 0 };
      nextPossession = side;
      nextCarrier = null;
      action = 'throw_in';
      stoppageSpots.set(event.sequenceId, { ...next });
    } else if (event.type === 'goal_kick') {
      const keeper = pickGoalkeeper(side, event.playerId);
      if (keeper) nameActor(event, keeper);
      next = goalArea(side);
      actorPosition = next;
      nextPossession = side;
      nextCarrier = keeper ? keeper.id : null;
      action = 'goal_kick';
      stoppageSpots.set(event.sequenceId, { ...next });
    } else if (event.type === 'substitution') {
      const outgoing = event.playerOutId && lookup[side] ? lookup[side].get(event.playerOutId) : null;
      const incoming = event.playerInId && lookup[side] ? lookup[side].get(event.playerInId) : lookup[side] && lookup[side].get(event.playerId);
      const outgoingStatus = outgoing && playerStatus[side].get(outgoing.id);
      const outgoingRole = outgoingStatus && (outgoingStatus.role || outgoing.role);
      if (outgoingStatus) outgoingStatus.status = 'substituted';
      if (incoming) {
        const status = playerStatus[side].get(incoming.id);
        if (status) {
          status.status = 'active';
          status.slotIndex = event.slotIndex != null ? event.slotIndex : outgoingStatus && outgoingStatus.slotIndex;
          status.role = outgoingRole || status.role;
        }
        event.playerId = incoming.id;
        event.playerName = incoming.name;
        event.playerInId = incoming.id;
        event.playerInName = incoming.name;
      }
      event.playerOutName = event.playerOutName || (outgoing && outgoing.name) || null;
      next = { x: round(clamp(ball.x, .08, .92)), y: ball.y < .5 ? .005 : .995 };
      nextPossession = possessionTeam || event.team;
      nextCarrier = null;
      action = 'substitution';
      stoppageSpots.set(event.sequenceId, { ...next, team: nextPossession });
    } else if (event.type === 'yellow_card' || event.type === 'red_card' || event.type === 'second_yellow') {
      const offender = side && pickActive(side, { outfield: true, preferredId: event.playerId });
      if (offender) nameActor(event, offender);
      nextPossession = event.beneficiaryTeam || (event.sequenceId && prevPossession !== side ? prevPossession : defender);
      nextCarrier = null;
      action = event.type;
      if (event.type === 'red_card' || event.type === 'second_yellow') {
        const status = event.playerId && playerStatus[side] && playerStatus[side].get(event.playerId);
        if (status) status.status = 'sent_off';
      }
      if (event.sequenceId && stoppageSpots.has(event.sequenceId)) next = { ...stoppageSpots.get(event.sequenceId) };
    } else if (event.type === 'halftime' || event.type === 'full_time' || event.type === 'extra_time_end' || event.type === 'shootout_end') {
      nextCarrier = null;
      nextPossession = null;
      action = event.type;
    } else if (event.type === 'shootout_start') {
      next = attackerApproach('home', random, true);
      nextCarrier = null;
      nextPossession = null;
      action = 'shootout';
    } else if (event.type === 'shootout_kick') {
      const taker = pickActive(side, { outfield: true, preferredId: event.playerId });
      if (taker) nameActor(event, taker);
      const spot = attackerApproach(side, random, true);
      actorPosition = spot;
      next = event.scored ? goalMouth(side, random, true) : goalArea(otherSide(side));
      nextCarrier = null;
      nextPossession = event.scored ? null : otherSide(side);
      action = event.scored ? 'shootout_goal' : 'shootout_save';
    } else if (event.type === 'extra_time_start') {
      nextPossession = null;
      nextCarrier = null;
      next = { x: .5, y: .5 };
      action = 'kickoff';
    } else {
      if (event.sequenceId && stoppageSpots.has(event.sequenceId)) next = { ...stoppageSpots.get(event.sequenceId) };
      action = event.type;
    }

    if (event.type === 'yellow_card' || event.type === 'red_card' || event.type === 'second_yellow') {
      const foulSpot = event.sequenceId && stoppageSpots.get(event.sequenceId);
      if (foulSpot) next = { ...foulSpot };
    }
    if (event.type === 'goal_restart' || event.type === 'restart') {
      const taker = event.playerId && lookup[event.team] ? lookup[event.team].get(event.playerId) : null;
      if (taker) actorPosition = next;
    }

    if (event.type !== 'substitution') {
      const pathStart = ['kickoff', 'second_half', 'goal_restart', 'extra_time_start', 'shootout_start'].includes(event.type)
        ? next
        : (event.type === 'pass_sequence' || event.type === 'shot' || event.type === 'shot_on_target'
          || event.type === 'goal' || event.type === 'big_chance' || event.type === 'penalty_scored'
          || event.type === 'penalty_missed') ? actorPosition : previousBall;
      setBall(event, next, action, pathStart, previousBall, dt);
    } else {
      setBall(event, next, action, previousBall, previousBall, dt);
    }
    if (actorPosition) event.actorPosition = { x: round(actorPosition.x), y: round(actorPosition.y) };
    if (event.type === 'goal' || event.type === 'penalty_scored'
      || (['shot', 'big_chance'].includes(event.type) && event.outcome === 'wide')) event.crossedGoalLine = true;
    if (event.type === 'shot_on_target' && event.saved) event.outcome = 'saved';
    event.possessionTeam = nextPossession;
    event.ballCarrierId = nextCarrier;
    event.previousPossessionTeam = prevPossession;
    event.formation = { home: sideLineups.home.formation, away: sideLineups.away.formation };
    if (event.type === 'yellow_card' || event.type === 'red_card' || event.type === 'second_yellow') {
      event.beneficiaryTeam = event.beneficiaryTeam || otherSide(side);
    }

    if (event.type === 'substitution') {
      const outgoingStatus = event.playerOutId && playerStatus[side] && playerStatus[side].get(event.playerOutId);
      const incomingStatus = event.playerInId && playerStatus[side] && playerStatus[side].get(event.playerInId);
      if (outgoingStatus) outgoingStatus.status = 'substituted';
      if (incomingStatus) {
        incomingStatus.status = 'active';
        incomingStatus.slotIndex = event.slotIndex != null ? event.slotIndex : outgoingStatus && outgoingStatus.slotIndex;
        incomingStatus.role = (outgoingStatus && outgoingStatus.role) || incomingStatus.role;
      }
    }
    if (event.type === 'red_card' || event.type === 'second_yellow') {
      const status = event.playerId && playerStatus[side] && playerStatus[side].get(event.playerId);
      if (status) status.status = 'sent_off';
    }
    ball = { ...event.ball };
    possessionTeam = event.possessionTeam;
    carrierId = event.ballCarrierId;
    lastTime = event.t;
  }

  return ordered;
}

function chanceForWide(random) {
  return random() < .5 ? .005 : .995;
}

function zoneFor(x) {
  if (x >= 0.6) return 'final_third_home';
  if (x <= 0.4) return 'final_third_away';
  return 'midfield';
}

function initialDynamic(lineups) {
  const statuses = { home: new Map(), away: new Map() };
  for (const side of ['home', 'away']) {
    for (const player of (lineups && lineups[side] && lineups[side].players) || []) {
      statuses[side].set(player.id, { status: player.initialStatus, slotIndex: player.slotIndex, role: player.role });
    }
  }
  return statuses;
}

function cloneDynamic(state) {
  return {
    ball: { ...state.ball }, possessionTeam: state.possessionTeam,
    ballCarrierId: state.ballCarrierId, phase: state.phase, formation: { ...state.formation },
    statuses: {
      home: new Map([...state.statuses.home].map(([id, value]) => [id, { ...value }])),
      away: new Map([...state.statuses.away].map(([id, value]) => [id, { ...value }]))
    }, lastEvent: state.lastEvent ? { ...state.lastEvent } : null,
    possession: { ...state.possession }
  };
}

function makePlayerStates(dynamic, lineups, minute) {
  if (!lineups || !lineups.home || !lineups.away) return [];
  const players = [];
  const activeBySide = { home: [], away: [] };
  for (const side of ['home', 'away']) {
    const lineup = lineups[side];
    for (const player of lineup.players) {
      const runtime = dynamic.statuses[side].get(player.id) || { status: player.initialStatus, slotIndex: player.slotIndex, role: player.role };
      if (runtime.status !== 'active') continue;
      const currentPlayer = { ...player, slotIndex: runtime.slotIndex, role: runtime.role || player.role };
      const position = formationPosition(currentPlayer, side, lineup, dynamic.ball, dynamic.possessionTeam, dynamic.phase);
      activeBySide[side].push({ player: currentPlayer, ...position });
    }
  }

  // Un solo defensor cercano presiona; el resto protege líneas y espacios.
  const pressers = {};
  if (!['goal_celebration', 'set_piece', 'halftime', 'ended', 'shootout'].includes(dynamic.phase)) {
    for (const side of ['home', 'away']) {
      if (!dynamic.possessionTeam || dynamic.possessionTeam === side) continue;
      const nearest = chooseNearest(activeBySide[side].map(item => item.player), lineups[side], side, dynamic.ball, dynamic.possessionTeam, dynamic.phase);
      if (nearest) pressers[side] = nearest.id;
    }
  }

  for (const side of ['home', 'away']) {
    const lineup = lineups[side];
    for (const player of lineup.players) {
      const runtime = dynamic.statuses[side].get(player.id) || { status: player.initialStatus, slotIndex: player.slotIndex, role: player.role };
      let position;
      let vx = 0, vy = 0;
      if (runtime.status === 'active') {
        const active = activeBySide[side].find(item => item.player.id === player.id);
        position = active ? { x: active.x, y: active.y } : formationPosition({ ...player, slotIndex: runtime.slotIndex, role: runtime.role || player.role }, side, lineup, dynamic.ball, dynamic.possessionTeam, dynamic.phase);

        // Presión del defensor más próximo hacia el balón
        if (pressers[side] === player.id) {
          const pressSpeed = 0.32 + ((Number(player.attrs && player.attrs.pac) || 65) - 65) * 0.002;
          const pDx = dynamic.ball.x - position.x;
          const pDy = dynamic.ball.y - position.y;
          const pDist = Math.hypot(pDx, pDy) || 1;
          const moveSpeed = 0.025 * ((Number(player.attrs && player.attrs.pac) || 65) / 65);
          vx = round((pDx / pDist) * moveSpeed, 3);
          vy = round((pDy / pDist) * moveSpeed, 3);
          position.x = round(position.x + pDx * pressSpeed);
          position.y = round(position.y + pDy * pressSpeed);
        }

        // Apoyo y desmarques de compañeros ofensivos
        if (dynamic.possessionTeam === side && dynamic.ballCarrierId && dynamic.ballCarrierId !== player.id) {
          const attackDir = side === 'home' ? 1 : -1;
          if (player.role === 'FW' && (position.x - dynamic.ball.x) * attackDir > 0) {
            position.x = round(clamp(position.x + attackDir * 0.02, 0.03, 0.97));
          }
        }

        // Festejo de gol: compañeros acuden hacia el autor del gol
        if (dynamic.phase === 'goal_celebration' && dynamic.lastEvent && dynamic.lastEvent.team === side) {
          const scorerPos = dynamic.lastEvent.actorPosition || { x: side === 'home' ? 0.9 : 0.1, y: 0.5 };
          if (player.id !== dynamic.lastEvent.playerId) {
            position.x = round(position.x + (scorerPos.x - position.x) * 0.35);
            position.y = round(position.y + (scorerPos.y - position.y) * 0.35);
          }
        }

        // Portador del balón alineado en el eje de ataque con velocidad
        if (dynamic.ballCarrierId === player.id) {
          const direction = side === 'home' ? 1 : -1;
          position = { x: round(clamp(dynamic.ball.x - direction * .012, .025, .975)), y: round(clamp(dynamic.ball.y, .025, .975)) };
          vx = round(direction * 0.02 * ((Number(player.attrs && player.attrs.pac) || 65) / 65), 3);
          vy = 0;
        }

        // Posiciones explícitas del evento actual (actor, receptor o arquero)
        if (dynamic.lastEvent && dynamic.lastEvent.playerId === player.id && dynamic.lastEvent.actorPosition) {
          position = { ...dynamic.lastEvent.actorPosition };
        }
        if (dynamic.lastEvent && dynamic.lastEvent.receiverId === player.id) {
          const targetBall = dynamic.lastEvent.ball || dynamic.ball;
          if (targetBall) {
            position = { x: round(clamp(targetBall.x, .025, .975)), y: round(clamp(targetBall.y, .025, .975)) };
          }
        }
        if (dynamic.lastEvent && dynamic.lastEvent.keeperId === player.id && dynamic.lastEvent.keeperPosition) {
          position = { ...dynamic.lastEvent.keeperPosition };
        }
      } else {
        const benchIndex = lineup.players.filter(item => item.initialStatus === 'bench').findIndex(item => item.id === player.id);
        position = {
          x: side === 'home' ? .02 : .98,
          y: round(1.035 + Math.max(0, benchIndex) * .012)
        };
      }
      const aim = dynamic.ballCarrierId === player.id
        ? (side === 'home' ? 0 : Math.PI)
        : Math.atan2(dynamic.ball.y - position.y, dynamic.ball.x - position.x);
      const staminaBase = Number(player.attrs.sta) || 82;
      players.push({
        id: player.id, team: side, name: player.name, number: player.number,
        pos: player.pos, role: runtime.role || player.role, slotIndex: runtime.slotIndex, x: position.x, y: position.y,
        vx, vy, orientation: round(aim, 3), speed: Number(player.attrs.pac) || 65,
        passing: Number(player.attrs.pas) || 60, shooting: Number(player.attrs.sho) || 55,
        control: Number(player.attrs.con) || 60, defending: Number(player.attrs.def) || 55,
        goalkeeping: Number(player.attrs.gk) || 20,
        stamina: Math.round(clamp(staminaBase - Math.max(0, minute) * .24, 45, 100)),
        status: runtime.status, active: runtime.status === 'active'
      });
    }
  }
  return players;
}

// Pliega únicamente los eventos ya ocurridos. `throughIndex` permite construir
// la instantánea exacta del evento antes de difundir su comentario, incluso si
// varios sucesos comparten el mismo minuto.
function deriveState(timeline, minute, lineups = null, throughIndex = Infinity) {
  const state = {
    minute: 0, displayMinute: 0, half: 1, stoppage: 0,
    score: { home: 0, away: 0 },
    cards: { home: [], away: [] }, subs: { home: [], away: [] }, injuries: [],
    xG: { home: 0, away: 0 },
    possession: { home: 0.5, away: 0.5 },
    possessionTeam: 'home', ballCarrierId: null, playStopped: true,
    shots: { home: 0, away: 0 }, shotsOnTarget: { home: 0, away: 0 },
    corners: { home: 0, away: 0 }, fouls: { home: 0, away: 0 },
    throwIns: { home: 0, away: 0 }, goalKicks: { home: 0, away: 0 },
    formation: { home: '4-4-2', away: '4-4-2' },
    ball: { x: .5, y: .5, zone: 'midfield', vx: 0, vy: 0, controlled: false },
    phase: 'kickoff', redCards: { home: 0, away: 0 },
    lastAction: null, eventIndex: -1
  };
  const lastT = timeline.length ? timeline[timeline.length - 1].t : 0;
  const possCount = { home: 0, away: 0 };
  const statuses = initialDynamic(lineups);
  let revealedIndex = -1;
  let priorDynamic = null;
  let lastEvent = null;
  let lastBall = { x: .5, y: .5 };
  let lastBallTime = 0;

  for (const event of timeline) {
    if (event.t > minute || event.i > throughIndex) break;
    priorDynamic = cloneDynamic({
      ball: state.ball, possessionTeam: state.possessionTeam,
      ballCarrierId: state.ballCarrierId, phase: state.phase,
      formation: state.formation, statuses, lastEvent: state.lastAction,
      possession: state.possession
    });
    revealedIndex = event.i;
    lastEvent = event;
    if (event.formation) state.formation = { ...event.formation };
    if (event.ball) {
      const from = lastBall;
      const dt = Math.max(.05, event.t - lastBallTime);
      state.ball = {
        x: event.ball.x, y: event.ball.y, zone: zoneFor(event.ball.x),
        vx: event.ballVelocity ? event.ballVelocity.x : round((event.ball.x - from.x) / dt, 4),
        vy: event.ballVelocity ? event.ballVelocity.y : round((event.ball.y - from.y) / dt, 4),
        controlled: Boolean(event.ballCarrierId), carrierId: event.ballCarrierId || null,
        crossedGoalLine: Boolean(event.crossedGoalLine)
      };
      lastBall = { x: event.ball.x, y: event.ball.y };
      lastBallTime = event.t;
    }
    state.phase = event.phase || state.phase;
    if (Object.prototype.hasOwnProperty.call(event, 'possessionTeam')) state.possessionTeam = event.possessionTeam;
    else if (event.type === 'pass_sequence' || event.type === 'possession_change') state.possessionTeam = event.team;
    if (Object.prototype.hasOwnProperty.call(event, 'ballCarrierId')) state.ballCarrierId = event.ballCarrierId;
    state.eventIndex = event.i;
    state.lastAction = {
      id: event.i, type: event.type, team: event.team || null,
      playerId: event.playerId || null, playerName: event.playerName || null,
      receiverId: event.receiverId || null, receiverName: event.receiverName || null,
      keeperId: event.keeperId || null, keeperPosition: event.keeperPosition || null,
      playerOutId: event.playerOutId || null, playerOutName: event.playerOutName || null,
      minute: event.t, action: event.ballAction || event.type,
      outcome: event.outcome || null, ballFrom: event.ballFrom || null,
      actorPosition: event.actorPosition || null, crossedGoalLine: Boolean(event.crossedGoalLine)
    };
    if ((event.type === 'pass_sequence' || event.type === 'possession_change') && event.team) possCount[event.team]++;
    const team = event.team;
    switch (event.type) {
      case 'goal':
      case 'penalty_scored':
        if (team) {
          state.score[team]++;
          state.shots[team]++;
          state.shotsOnTarget[team]++;
        }
        break;
      case 'penalty_missed':
        if (team) {
          state.shots[team]++;
          if (event.outcome === 'saved') state.shotsOnTarget[team]++;
        }
        break;
      case 'yellow_card':
        if (team) state.cards[team].push({ playerId: event.playerId, playerName: event.playerName, type: 'yellow', minute: event.t, reason: event.reason || null });
        break;
      case 'red_card':
        if (team) {
          state.cards[team].push({ playerId: event.playerId, playerName: event.playerName, type: 'red', minute: event.t, reason: event.reason || null });
          state.redCards[team]++;
          const status = statuses[team].get(event.playerId); if (status) status.status = 'sent_off';
        }
        break;
      case 'second_yellow':
        if (team) {
          state.cards[team].push({ playerId: event.playerId, playerName: event.playerName, type: 'yellow', minute: event.t, second: true, reason: event.reason || null });
          state.cards[team].push({ playerId: event.playerId, playerName: event.playerName, type: 'red', minute: event.t, reason: 'second_yellow' });
          state.redCards[team]++;
          const status = statuses[team].get(event.playerId); if (status) status.status = 'sent_off';
        }
        break;
      case 'substitution': {
        if (team) {
          const outgoing = statuses[team].get(event.playerOutId);
          const incoming = statuses[team].get(event.playerInId || event.playerId);
          if (outgoing) outgoing.status = 'substituted';
          if (incoming) {
            incoming.status = 'active';
            incoming.slotIndex = event.slotIndex != null ? event.slotIndex : outgoing && outgoing.slotIndex;
            incoming.role = (outgoing && outgoing.role) || incoming.role;
          }
          state.subs[team].push({
            playerInId: event.playerInId || event.playerId, playerInName: event.playerInName || event.playerName,
            playerOutId: event.playerOutId || null, playerOutName: event.playerOutName || null,
            minute: event.t
          });
        }
        break;
      }
      case 'foul':
        if (team) state.fouls[team]++;
        break;
      case 'penalty_awarded':
        if (team) state.fouls[otherSide(team)]++;
        break;
      case 'shot':
        if (team) state.shots[team]++;
        break;
      case 'shot_on_target':
        if (team) { state.shots[team]++; state.shotsOnTarget[team]++; }
        break;
      case 'big_chance':
        if (team) state.shots[team]++;
        break;
      case 'corner':
        if (team) state.corners[team]++;
        break;
      case 'throw_in':
        if (team) state.throwIns[team]++;
        break;
      case 'goal_kick':
        if (team) state.goalKicks[team]++;
        break;
      case 'halftime':
        state.half = 1; state.phase = 'halftime';
        break;
      case 'second_half':
        state.half = 2;
        break;
      case 'extra_time_start':
        state.half = 3; state.phase = 'extra_time';
        break;
      case 'shootout_start':
        state.half = 4; state.phase = 'shootout';
        break;
      case 'full_time':
      case 'shootout_end':
        state.phase = 'ended';
        break;
      default:
        break;
    }
    if (event.xg != null && team && ['shot', 'shot_on_target', 'goal', 'penalty_scored', 'penalty_missed', 'big_chance'].includes(event.type)) {
      state.xG[team] = Number((state.xG[team] + event.xg).toFixed(2));
    }
  }

  state.minute = Number(Math.max(0, Math.min(minute, lastT)).toFixed(2));
  const possTotal = possCount.home + possCount.away;
  if (possTotal > 0) {
    state.possession.home = Number((possCount.home / possTotal).toFixed(2));
    state.possession.away = Number((possCount.away / possTotal).toFixed(2));
  }
  state.playStopped = ['goal_celebration', 'set_piece', 'halftime', 'ended', 'shootout'].includes(state.phase);
  state.displayMinute = state.playStopped && lastEvent ? Number(lastEvent.t.toFixed(2)) : state.minute;
  if (lastEvent && state.playStopped && state.phase === 'goal_celebration') state.ballCarrierId = null;

  const dynamic = { ball: state.ball, possessionTeam: state.possessionTeam, ballCarrierId: state.ballCarrierId,
    phase: state.phase, formation: state.formation, statuses, lastEvent: state.lastAction, possession: state.possession };
  const previous = priorDynamic ? {
    time: priorDynamic.lastEvent ? priorDynamic.lastEvent.minute : 0,
    state: priorDynamic
  } : null;
  const players = makePlayerStates(dynamic, lineups, state.minute);
  if (previous && previous.state && lineups && lastEvent) {
    const priorPlayers = makePlayerStates(previous.state, lineups, previous.time);
    const priorById = new Map(priorPlayers.map(player => [player.id, player]));
    const dt = Math.max(.05, lastEvent.t - previous.time);
    for (const player of players) {
      const old = priorById.get(player.id);
      if (!old || player.status !== 'active' || old.status !== 'active') continue;
      player.vx = round((player.x - old.x) / dt, 4);
      player.vy = round((player.y - old.y) / dt, 4);
    }
  }
  state.players = players;
  state.roster = lineups ? {
    home: lineups.home.players.map(player => ({ id: player.id, name: player.name, number: player.number, pos: player.pos })),
    away: lineups.away.players.map(player => ({ id: player.id, name: player.name, number: player.number, pos: player.pos }))
  } : { home: [], away: [] };
  return { state, revealedIndex };
}

module.exports = {
  POS_GROUP, FORMATION_SLOTS, createLineups, activePlayersAt, chooseGoalkeeper,
  normalizeTransitions, normalizeAndDecorateTimeline, deriveState, zoneFor
};
