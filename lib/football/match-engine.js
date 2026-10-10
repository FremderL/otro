'use strict';

// Fase B — Motor de partido (§7).
//
// Generador DETERMINISTA de la línea de tiempo completa de un partido a partir
// de un PRNG sembrado (§3.2). El principio rector: el marcador final se sortea
// PRIMERO de la matriz de Poisson con corrección Dixon-Coles —la misma
// distribución que fija las cuotas— y después se reparten goles, tiros, tarjetas
// y posesiones coherentes con ese marcador. Eso es lo que hace verdadero el
// margen declarado (R3/§3.3): el modelo que genera el partido y el que lo precia
// no divergen.
//
// La línea de tiempo es inmutable tras generarse y NO se persiste (§13.2): se
// regenera desde el seed. `deriveState(timeline, minute)` pliega los eventos ya
// revelados para reconstruir el estado (§6.2) sin mirar el futuro (T7).
//
// El partido de desempate (§7.5, A14) reutiliza este generador y le añade
// prórroga y tanda de penales, que solo ese partido puede alcanzar.

const { randInt, randRange, chance, shuffle } = require('./prng');
const { expectedGoals } = require('./ratings');
const { createMemory, generateCommentary, formatScore } = require('./commentary');
const {
  POS_GROUP, createLineups, activePlayersAt, chooseGoalkeeper, zoneFor,
  normalizeAndDecorateTimeline, deriveState: deriveMatchState
} = require('./match-state');

// --- Constantes del modelo ---
const RHO = -0.06;                 // corrección Dixon-Coles (§10.2)
const MAX_GOALS = 8;               // matriz 0..8 goles por equipo
const PENALTY_RATE = 0.25;         // penales señalados por partido (§7.4, A13)
const PENALTY_CONVERSION = 0.76;   // tasa de conversión en partido
const PENALTY_XG = 0.79;           // xG de un penal
const EXTRA_TIME_MINUTES = 30;     // 2 × 15' de prórroga (§7.5, A14)
const EXTRA_TIME_FATIGUE = 0.85;   // rendimiento reducido en la prórroga
const SHOOTOUT_INITIAL = 5;        // lanzamientos por equipo antes de muerte súbita
const SHOOTOUT_CONVERSION = 0.75;  // conversión en la tanda (menor: presión)
const YELLOW_RATE = 4.1;           // amarillas por partido (§7.3)
const RED_RATE = 0.09;             // rojas por partido (§7.3)
const SUBS_MIN = 3, SUBS_MAX = 5;  // cambios por equipo (§7.3)
const STOPPAGE_MIN = 1, STOPPAGE_MAX = 4; // agregado por mitad (§5.4)
const MAX_SHOOTOUT_ROUNDS = 40;    // cota de seguridad de la muerte súbita (el PRNG es finito)

// Curva empírica de minutos de gol (§7.1 paso 4): más goles al final de cada
// mitad. Peso por minuto nominal 1..90.
const GOAL_WEIGHT_BY_MIN = (() => {
  const w = new Array(91).fill(1);
  for (let m = 1; m <= 90; m++) {
    let base = 1;
    if (m >= 38 && m <= 45) base = 1.18;        // cierre del primer tiempo
    else if (m >= 46 && m <= 52) base = 1.05;    // arranque del segundo
    else if (m >= 68 && m <= 78) base = 1.10;    // desgaste
    else if (m >= 79) base = 1.32;               // tramo final
    else if (m <= 12) base = 0.85;               // arranque frío
    w[m] = base;
  }
  return w;
})();

// Relevancia por tipo (1-5). Alta relevancia (>=4) se emite de inmediato; baja
// (<=2) se agrupa en el tick posicional (§7.2).
const IMPORTANCE = {
  kickoff: 2, goal_restart: 1, restart: 1, pass_sequence: 1, possession_change: 1, throw_in: 1, goal_kick: 1,
  shot: 2, shot_on_target: 3, save: 3, corner: 2, foul: 1, offside: 1, injury: 2,
  big_chance: 4, goal: 5, goal_disallowed: 4, yellow_card: 3, red_card: 5, second_yellow: 4,
  penalty_awarded: 4, penalty_scored: 5, penalty_missed: 4, substitution: 2,
  halftime: 3, second_half: 2, stoppage_start: 1, full_time: 4,
  formation_change: 2, tactic_change: 2, momentum_shift: 2,
  extra_time_start: 3, extra_time_end: 3, shootout_start: 4, shootout_kick: 4, shootout_end: 5
};

const PHASE = {
  kickoff: 'kickoff', goal_restart: 'kickoff', restart: 'build_up',
  goal: 'goal_celebration', penalty_scored: 'goal_celebration',
  goal_disallowed: 'danger', shot: 'attack', shot_on_target: 'danger', big_chance: 'danger',
  save: 'build_up', corner: 'set_piece', foul: 'set_piece', offside: 'set_piece',
  penalty_awarded: 'set_piece', penalty_missed: 'set_piece', throw_in: 'set_piece',
  goal_kick: 'set_piece', pass_sequence: 'build_up', possession_change: 'build_up',
  yellow_card: 'set_piece', red_card: 'set_piece', second_yellow: 'set_piece',
  substitution: 'set_piece', injury: 'build_up', halftime: 'halftime', second_half: 'build_up',
  full_time: 'ended', extra_time_start: 'extra_time', extra_time_end: 'halftime',
  shootout_start: 'shootout', shootout_kick: 'shootout', shootout_end: 'ended',
  formation_change: 'build_up', tactic_change: 'build_up', momentum_shift: 'build_up',
  stoppage_start: 'build_up'
};

// --- Poisson y Dixon-Coles (§10.2) ---

function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  if (lambda === 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}

const _factCache = [0];
function logFactorial(n) {
  while (_factCache.length <= n) _factCache.push(_factCache[_factCache.length - 1] + Math.log(_factCache.length));
  return _factCache[n];
}

// Factor de corrección Dixon-Coles para los marcadores bajos. Con ρ < 0 eleva
// 0-0 y 1-1 y reduce 1-0 y 0-1, que es donde el Poisson independiente se
// desvía de la realidad (T1 lo verifica).
function dcTau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

// Matriz de marcadores 9×9 normalizada (suma 1).
function scoreMatrix(lambdaHome, lambdaAway, rho = RHO) {
  const rows = [];
  let total = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    const row = [];
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poissonPmf(i, lambdaHome) * poissonPmf(j, lambdaAway) * dcTau(i, j, lambdaHome, lambdaAway, rho);
      const clamped = Math.max(0, p);
      row.push(clamped);
      total += clamped;
    }
    rows.push(row);
  }
  if (total > 0) for (const row of rows) for (let j = 0; j < row.length; j++) row[j] /= total;
  return rows;
}

// Sortea un marcador {home, away} de la matriz por inversa de la CDF.
function sampleScore(matrix, random) {
  const r = random();
  let acc = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      acc += matrix[i][j];
      if (r <= acc) return { home: i, away: j };
    }
  }
  return { home: MAX_GOALS, away: MAX_GOALS };
}

// Muestreo de Poisson por inversa de la CDF (para penales, tiros, tarjetas).
function samplePoisson(lambda, random) {
  if (lambda <= 0) return 0;
  const target = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= random();
  } while (p > target && k < 100);
  return k - 1;
}

// --- Utilidades de generación ---

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Elección ponderada determinista: weightFn(item) >= 0.
function weightedPick(random, items, weightFn) {
  if (!items.length) return undefined;
  let total = 0;
  const weights = items.map(item => { const w = Math.max(0, weightFn(item)); total += w; return w; });
  if (total <= 0) return items[randInt(random, 0, items.length - 1)];
  let r = random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const SHOOT_WEIGHT = { FW: 5.0, MF: 2.6, DF: 0.9, GK: 0.02 };
const PASS_WEIGHT = { FW: 2.4, MF: 3.4, DF: 1.4, GK: 0.1 };
const CARD_WEIGHT = { FW: 1.4, MF: 2.2, DF: 2.8, GK: 0.3 };

function shootWeight(player) { return SHOOT_WEIGHT[POS_GROUP[player.pos] || 'MF'] * (0.6 + player.attrs.sho / 100); }
function passWeight(player) { return PASS_WEIGHT[POS_GROUP[player.pos] || 'MF'] * (0.6 + player.attrs.pas / 100); }
function cardWeight(player) { return CARD_WEIGHT[POS_GROUP[player.pos] || 'MF'] * (0.6 + player.attrs.agr / 100); }

// Posesión del local [0,1], con ventaja de campo, ratings y estilo (§10.1).
function computePossession(home, away) {
  const attDiff = (home.ratings.att - away.ratings.att);
  const eloDiff = (home.ratings.elo - away.ratings.elo) / 400;
  const styleEdge = (home.tactics.style === 'possession' ? 0.04 : home.tactics.style === 'counter' ? -0.03 : 0)
    - (away.tactics.style === 'possession' ? 0.04 : away.tactics.style === 'counter' ? -0.03 : 0);
  return clamp(0.5 + 0.12 * attDiff + 0.05 * eloDiff + 0.02 + styleEdge, 0.32, 0.68);
}

// Convierte un minuto nominal (0-90) a t continuo dentro de la mitad elegida,
// aplicando el agregado. half 1 → (0, 45+s1]; half 2 → (45+s1, 90+s1+s2].
function makeClock(s1, s2) {
  const firstHalfEnd = 45 + s1;
  const matchEnd = 90 + s1 + s2;
  return {
    s1, s2, firstHalfEnd, matchEnd,
    nominalToT(nominal, half) {
      if (half === 1) {
        const n = clamp(nominal, 0.3, 45);
        // Todo evento del 45' ocurre antes del silbatazo, nunca detrás de
        // halftime/second_half con el mismo timestamp.
        if (n >= 45) return firstHalfEnd - 0.01;
        return n * (firstHalfEnd / 45);
      }
      const intoSecond = clamp(nominal, 45.3, 90) - 45;
      return firstHalfEnd + intoSecond * ((matchEnd - firstHalfEnd) / 45);
    }
  };
}

// Sortea un minuto nominal 1..90 con la curva de goles (o plana si flat=true).
function sampleNominalMinute(random, half, flat = false) {
  const lo = half === 1 ? 1 : 46;
  const hi = half === 1 ? 45 : 90;
  if (flat) return randInt(random, lo, hi) + randRange(random, 0, 0.9);
  let total = 0;
  for (let m = lo; m <= hi; m++) total += GOAL_WEIGHT_BY_MIN[m];
  let r = random() * total;
  for (let m = lo; m <= hi; m++) {
    r -= GOAL_WEIGHT_BY_MIN[m];
    if (r <= 0) return m + randRange(random, 0, 0.9);
  }
  return hi + randRange(random, 0, 0.9);
}

// --- Planes de eventos (§7.3) ---

// Reparte los goles del marcador en minutos con la curva empírica. Devuelve
// [{team:'home'|'away', nominal, half}] ordenado por tiempo.
function spreadGoals(score, random) {
  const goals = [];
  const push = (team, count) => {
    for (let g = 0; g < count; g++) {
      const half = chance(random, 0.45) ? 1 : 2;
      goals.push({ team, half, nominal: sampleNominalMinute(random, half) });
    }
  };
  push('home', score.home);
  push('away', score.away);
  return goals;
}

// Planifica los tiros de cada equipo de modo que su xG sume ~λ (§7.1 paso 6).
// Los goles son tiros con isGoal; el resto se reparte entre a puerta y fuera.
function planShots(lambdas, goals, home, away, possessionHome, random, substitutions = [], lineups = createLineups(home, away), dismissals = []) {
  const shots = { home: [], away: [] };
  const teams = { home, away };
  const lambda = { home: lambdas.lambdaHome, away: lambdas.lambdaAway };
  const poss = { home: possessionHome, away: 1 - possessionHome };

  for (const side of ['home', 'away']) {
    const teamGoals = goals.filter(g => g.team === side);
    // Número de tiros: crece con λ y con la posesión.
    const base = 6 + lambda[side] * 4 + poss[side] * 5;
    const nShots = clamp(Math.round(base + randRange(random, -2, 2)), Math.max(4, teamGoals.length + 3), 22);
    const nOnTarget = clamp(Math.round(nShots * randRange(random, 0.30, 0.45)), teamGoals.length, nShots);

    // xG base por tiro: los goles llevan xG alto, el resto bajo; luego se escala
    // para que la suma iguale λ (coherencia con el marcador, §7.1).
    const raw = [];
    for (let i = 0; i < nShots; i++) {
      const isGoal = i < teamGoals.length;
      raw.push(isGoal ? randRange(random, 0.18, 0.55) : randRange(random, 0.02, 0.16));
    }
    const rawSum = raw.reduce((a, b) => a + b, 0) || 1;
    const scale = lambda[side] / rawSum;

    for (let i = 0; i < nShots; i++) {
      const isGoal = i < teamGoals.length;
      const onTarget = isGoal || i < nOnTarget;
      const goalInfo = isGoal ? teamGoals[i] : null;
      const half = goalInfo ? goalInfo.half : (chance(random, 0.45) ? 1 : 2);
      const nominal = goalInfo ? goalInfo.nominal : sampleNominalMinute(random, half, true);
      const eligible = activePlayersAt(lineups[side], side, half, nominal, substitutions, { outfield: true, dismissals });
      const shooter = weightedPick(random, eligible, shootWeight);
      const defendingSide = side === 'home' ? 'away' : 'home';
      const keeper = chooseGoalkeeper(lineups[defendingSide], defendingSide, half, nominal, substitutions, dismissals);
      const saveChance = clamp(0.32 + (Number(keeper && keeper.attrs.gk) || 75) / 100 * 0.32
        + (Number(teams[defendingSide].ratings.gk) || 1) * 0.1 - (Number(shooter && shooter.attrs.sho) || 65) / 100 * 0.08, 0.3, 0.75);
      const saved = onTarget && !isGoal && chance(random, saveChance);
      shots[side].push({
        team: side,
        isGoal,
        onTarget,
        saved,
        keeperId: keeper ? keeper.id : null,
        keeperName: keeper ? keeper.name : null,
        xg: Number((raw[i] * scale).toFixed(3)),
        half,
        nominal,
        shooterId: shooter ? shooter.id : null,
        shooterName: shooter ? shooter.name : null,
        assistId: null,
        assistName: null,
        isPenalty: false
      });
    }
    // Asistencia para cada gol: un compañero distinto del goleador, ponderado por pase.
    for (const shot of shots[side]) {
      if (!shot.isGoal) continue;
      const active = activePlayersAt(lineups[side], side, shot.half, shot.nominal, substitutions, { outfield: true, dismissals });
      const candidates = active.filter(p => p.id !== shot.shooterId);
      const assister = weightedPick(random, candidates, passWeight);
      if (assister && chance(random, 0.72)) { shot.assistId = assister.id; shot.assistName = assister.name; }
    }
  }
  return shots;
}

// Penales (§7.4, A13). Un penal convertido RE-ETIQUETA un gol ya sorteado (nunca
// añade uno nuevo): eso preserva la distribución de la matriz de Poisson que fija
// las cuotas (R3). Un equipo con score=0 no puede convertir (no hay gol que
// re-etiquetar) y se degrada a penalty_missed. Devuelve eventos y ajusta el xG.
function planPenalties(score, shots, lambdas, random, home = null, away = null, substitutions = [], lineups = null, dismissals = []) {
  const events = [];
  const xgBonus = { home: 0, away: 0 };
  const n = Math.min(2, samplePoisson(PENALTY_RATE, random));
  if (n === 0) return { events, xgBonus, penalties: [] };

  const penalties = [];
  const teams = { home, away };
  lineups = lineups || (home && away ? createLineups(home, away) : null);
  for (let k = 0; k < n; k++) {
    // El equipo que más ataca gana más penales (peso = xG + 0.10·localía).
    const wHome = Math.max(0.05, lambdas.lambdaHome) + 0.10;
    const wAway = Math.max(0.05, lambdas.lambdaAway);
    const team = chance(random, wHome / (wHome + wAway)) ? 'home' : 'away';
    const defending = team === 'home' ? 'away' : 'home';
    const half = chance(random, 0.4) ? 1 : 2;
    const nominal = randRange(random, 20, 88);
    const wantsConvert = chance(random, PENALTY_CONVERSION);

    // Un penal usa futbolistas que siguen en cancha en el minuto señalado.
    const attackPool = lineups && teams[team]
      ? activePlayersAt(lineups[team], team, half, nominal, substitutions, { outfield: true, dismissals })
      : [];
    const defensePool = lineups && teams[defending]
      ? activePlayersAt(lineups[defending], defending, half, nominal, substitutions, { outfield: true, dismissals })
      : [];
    const fallbackShot = shots[team].find(shot => shot.isGoal && !shot.isPenalty) || shots[team][0] || null;
    const shooter = weightedPick(random, attackPool, shootWeight);
    const fouled = weightedPick(random, attackPool.filter(player => !shooter || player.id !== shooter.id), passWeight)
      || attackPool[0] || null;
    const fouler = weightedPick(random, defensePool, cardWeight);
    const keeper = lineups && teams[defending]
      ? chooseGoalkeeper(lineups[defending], defending, half, nominal, substitutions, dismissals)
      : null;

    // Busca un gol sin etiquetar del equipo para re-etiquetar (solo si convirtió
    // y tiene goles). Así el penal nunca modifica la distribución del marcador.
    const teamGoalShots = shots[team].filter(shot => shot.isGoal && !shot.isPenalty);
    const canConvert = wantsConvert && teamGoalShots.length > 0 && score[team] > 0;
    const penaltyId = `penalty_${k + 1}`;
    if (canConvert) {
      const shot = teamGoalShots[0];
      shot.isPenalty = true;
      shot.half = half;
      shot.nominal = nominal;
      if (shooter) { shot.shooterId = shooter.id; shot.shooterName = shooter.name; }
      // El tiro ya cuenta en `shots`; solo cambia su valor xG a 0.79.
      shot.xg = Number(PENALTY_XG.toFixed(3));
      penalties.push({
        id: penaltyId, team, nominal, half, converted: true, shot,
        shooterId: shot.shooterId, shooterName: shot.shooterName,
        fouledId: fouled ? fouled.id : null, fouledName: fouled ? fouled.name : null,
        foulerId: fouler ? fouler.id : null, foulerName: fouler ? fouler.name : null,
        keeperId: keeper ? keeper.id : null, keeperName: keeper ? keeper.name : null,
        outcome: 'goal'
      });
    } else {
      // Fallado (o sin gol que re-etiquetar): sin tanto, pero suma xG («mereció más»).
      xgBonus[team] += PENALTY_XG;
      const outcomeRoll = random();
      const outcome = outcomeRoll < 0.62 ? 'saved' : outcomeRoll < 0.82 ? 'post' : 'wide';
      penalties.push({
        id: penaltyId, team, nominal, half, converted: false, shot: null,
        shooterId: shooter ? shooter.id : fallbackShot && fallbackShot.shooterId,
        shooterName: shooter ? shooter.name : fallbackShot && fallbackShot.shooterName,
        fouledId: fouled ? fouled.id : null, fouledName: fouled ? fouled.name : null,
        foulerId: fouler ? fouler.id : null, foulerName: fouler ? fouler.name : null,
        keeperId: keeper ? keeper.id : null, keeperName: keeper ? keeper.name : null,
        outcome
      });
    }
  }
  return { events, xgBonus, penalties };
}

// Tarjetas (§7.3): ~4.1 amarillas y ~0.09 rojas por partido, repartidas por
// agresividad y reparto de faltas. Una roja puede ser directa o por doble amarilla.
function planCards(home, away, random, substitutions = [], lineups = createLineups(home, away)) {
  const cards = [];
  const nYellow = samplePoisson(YELLOW_RATE, random);
  const booked = { home: [], away: [] };
  const bookedIds = { home: new Set(), away: new Set() };
  const sentOff = { home: new Set(), away: new Set() };

  for (let i = 0; i < nYellow; i++) {
    const side = chance(random, 0.5) ? 'home' : 'away';
    const half = chance(random, 0.45) ? 1 : 2;
    const nominal = sampleNominalMinute(random, half, true);
    const squad = activePlayersAt(lineups[side], side, half, nominal, substitutions, { outfield: true })
      .filter(player => !bookedIds[side].has(player.id) && !sentOff[side].has(player.id));
    const player = weightedPick(random, squad, cardWeight);
    if (!player) continue;
    const sequenceId = `card_foul_${side}_${i + 1}`;
    cards.push({ type: 'yellow_card', team: side, playerId: player.id, playerName: player.name, half, nominal, sequenceId, reason: 'foul' });
    booked[side].push({ player, half, nominal });
    bookedIds[side].add(player.id);
  }

  const nRed = samplePoisson(RED_RATE, random);
  for (let i = 0; i < nRed; i++) {
    const side = chance(random, 0.5) ? 'home' : 'away';
    const half = 2; // las rojas suelen llegar con el partido caliente
    const nominal = sampleNominalMinute(random, half, true);
    const active = activePlayersAt(lineups[side], side, half, nominal, substitutions, { outfield: true })
      .filter(player => !sentOff[side].has(player.id));
    const priorBookings = booked[side].filter(item => item.half < half || (item.half === half && item.nominal < nominal))
      .filter(item => active.some(player => player.id === item.player.id));
    const secondYellow = priorBookings.length > 0 && chance(random, 0.5);
    let player;
    let type;
    if (secondYellow) {
      player = priorBookings[priorBookings.length - 1].player;
      type = 'second_yellow';
    } else {
      player = weightedPick(random, active.filter(item => !bookedIds[side].has(item.id)), cardWeight);
      type = 'red_card';
    }
    if (!player) continue;
    const sequenceId = `card_foul_${side}_red_${i + 1}`;
    cards.push({ type, team: side, playerId: player.id, playerName: player.name, half, nominal, sequenceId, reason: 'serious_foul' });
    sentOff[side].add(player.id);
  }
  return cards;
}

// Cambios (§7.3): 3-5 por equipo, con titular saliente y suplente elegible.
function planSubs(home, away, random, lineups = createLineups(home, away)) {
  const subs = [];
  for (const side of ['home', 'away']) {
    const bench = shuffle(random, lineups[side].players.filter(player => player.initialStatus === 'bench'));
    const n = Math.min(randInt(random, SUBS_MIN, SUBS_MAX), bench.length);
    const usedOutgoing = new Set();
    for (let i = 0; i < n; i++) {
      const incoming = bench[i];
      const active = lineups[side].players.filter(player => player.initialStatus === 'active' && !usedOutgoing.has(player.id));
      if (!incoming || !active.length) continue;
      const incomingGroup = POS_GROUP[incoming.pos] || 'MF';
      const compatible = active.filter(player => (POS_GROUP[player.pos] || 'MF') === incomingGroup);
      const outgoing = weightedPick(random, compatible.length ? compatible : active, player => 1 + (player.attrs.pac || 50) / 100);
      if (!outgoing) continue;
      usedOutgoing.add(outgoing.id);
      subs.push({
        team: side, playerId: incoming.id, playerName: incoming.name,
        playerInId: incoming.id, playerInName: incoming.name,
        playerOutId: outgoing.id, playerOutName: outgoing.name,
        slotIndex: outgoing.slotIndex,
        half: 2, nominal: randRange(random, 55, 88)
      });
    }
  }
  return subs;
}

// Acciones de balón parado de baja relevancia, con ejecutores disponibles en
// cancha; normalizeTransitions añade la pausa y reanudación que las acompaña.
function planSetPieces(possessionHome, random, home = null, away = null, substitutions = [], lineups = null, dismissals = []) {
  const events = [];
  const teams = { home, away };
  lineups = lineups || (home && away ? createLineups(home, away) : null);
  const corners = { home: randInt(random, 2, 8), away: randInt(random, 2, 8) };
  const fouls = { home: randInt(random, 7, 16), away: randInt(random, 7, 16) };
  const other = side => side === 'home' ? 'away' : 'home';
  const choosePlayer = (side, half, nominal, goalkeeper = false) => {
    if (!lineups || !teams[side]) return null;
    if (goalkeeper) return chooseGoalkeeper(lineups[side], side, half, nominal, substitutions, dismissals);
    const candidates = activePlayersAt(lineups[side], side, half, nominal, substitutions, { outfield: true, dismissals });
    return weightedPick(random, candidates, player => 1 + ((player.attrs.pas || 50) + (player.attrs.pac || 50)) / 200);
  };

  for (const side of ['home', 'away']) {
    for (let i = 0; i < corners[side]; i++) {
      const half = chance(random, 0.45) ? 1 : 2;
      const nominal = sampleNominalMinute(random, half, true);
      const player = choosePlayer(side, half, nominal);
      events.push({
        type: 'corner', team: side, half, nominal,
        cornerSide: chance(random, 0.5) ? 'top' : 'bottom',
        playerId: player ? player.id : null, playerName: player ? player.name : null
      });
    }
    for (let i = 0; i < fouls[side]; i++) {
      const half = chance(random, 0.45) ? 1 : 2;
      const nominal = sampleNominalMinute(random, half, true);
      const fouler = choosePlayer(side, half, nominal);
      const victim = choosePlayer(other(side), half, nominal);
      events.push({
        type: 'foul', team: side, beneficiaryTeam: other(side), half, nominal,
        sequenceId: `foul_${side}_${i + 1}`,
        playerId: fouler ? fouler.id : null, playerName: fouler ? fouler.name : null,
        victimId: victim ? victim.id : null, victimName: victim ? victim.name : null,
        reason: 'contact'
      });
    }
    if (chance(random, 0.7)) {
      const half = chance(random, 0.45) ? 1 : 2;
      const nominal = sampleNominalMinute(random, half, true);
      const player = choosePlayer(side, half, nominal);
      events.push({
        type: 'offside', team: side, beneficiaryTeam: other(side), half, nominal,
        playerId: player ? player.id : null, playerName: player ? player.name : null
      });
    }
    const nThrowIns = randInt(random, 2, 5);
    for (let i = 0; i < nThrowIns; i++) {
      const half = chance(random, 0.45) ? 1 : 2;
      const nominal = sampleNominalMinute(random, half, true);
      const player = choosePlayer(side, half, nominal);
      events.push({
        type: 'throw_in', team: side, half, nominal,
        lineSide: chance(random, 0.5) ? 'top' : 'bottom',
        playerId: player ? player.id : null, playerName: player ? player.name : null
      });
    }
    const nGoalKicks = randInt(random, 0, 2);
    for (let i = 0; i < nGoalKicks; i++) {
      const half = chance(random, 0.45) ? 1 : 2;
      const nominal = sampleNominalMinute(random, half, true);
      const player = choosePlayer(side, half, nominal, true);
      events.push({ type: 'goal_kick', team: side, half, nominal, playerId: player ? player.id : null, playerName: player ? player.name : null });
    }
  }
  return events;
}

// Tramos de posesión (§7.3): pass_sequence / possession_change de alta densidad
// que dan la sensación de transmisión continua. ~1 cada 0.5-1.2 min simulados.
function planPossessionEvents(possessionHome, random) {
  const events = [];
  let t = randRange(random, 0.5, 1.5);
  let prev = chance(random, possessionHome) ? 'home' : 'away';
  while (t < 90) {
    const half = t <= 45 ? 1 : 2;
    // El poseedor de cada tramo se sortea con el sesgo real de posesión, de modo
    // que la fracción de tramos locales ≈ possessionHome. Así la posesión que
    // deriveState() reconstruye contando estos eventos coincide con stats.possession.
    const current = chance(random, possessionHome) ? 'home' : 'away';
    events.push({ type: current === prev ? 'pass_sequence' : 'possession_change', team: current, half, nominal: t });
    prev = current;
    t += randRange(random, 0.5, 1.4);
  }
  return events;
}

// --- Ensamblado ---

function assembleEvents(plans, home, away, clock, random, lineups = createLineups(home, away)) {
  const events = [];
  const memory = createMemory();
  const pushEvent = (nominal, half, type, team, extra = {}) => {
    const t = half ? clock.nominalToT(nominal, half) : nominal;
    events.push({ t: Number(t.toFixed(2)), type, team, half, ...extra });
  };
  const other = side => side === 'home' ? 'away' : side === 'away' ? 'home' : null;

  // Reinicios: el saque inicial es local y el segundo tiempo visitante.
  events.push({ t: 0, type: 'kickoff', team: 'home', half: 1 });
  events.push({ t: Number(clock.firstHalfEnd.toFixed(2)), type: 'halftime', team: null, half: 1 });
  events.push({ t: Number(clock.firstHalfEnd.toFixed(2)), type: 'second_half', team: 'away', half: 2 });
  events.push({ t: Number(clock.matchEnd.toFixed(2)), type: 'full_time', team: null, half: 2 });

  // Tiros y goles confirmados. El resultado del remate a puerta lo determina
  // el delantero + el portero, no un dado independiente del atributo del arquero.
  for (const side of ['home', 'away']) {
    for (const [shotIndex, shot] of plans.shots[side].entries()) {
      if (shot.isGoal && shot.isPenalty) continue; // el penal se publica una sola vez
      const shooter = { playerId: shot.shooterId, playerName: shot.shooterName };
      if (shot.isGoal) {
        pushEvent(shot.nominal, shot.half, 'goal', side, {
          ...shooter, assistId: shot.assistId, assistName: shot.assistName,
          keeperId: shot.keeperId, keeperName: shot.keeperName, xg: shot.xg, outcome: 'goal'
        });
      } else if (shot.onTarget) {
        const sequenceId = `shot_${side}_${shotIndex + 1}`;
        pushEvent(shot.nominal, shot.half, 'shot_on_target', side, {
          ...shooter, xg: shot.xg, saved: Boolean(shot.saved), keeperId: shot.keeperId,
          keeperName: shot.keeperName, outcome: shot.saved ? 'saved' : 'rebound', sequenceId
        });
        if (shot.saved) pushEvent(shot.nominal + 0.05, shot.half, 'save', other(side), {
          playerId: shot.keeperId, playerName: shot.keeperName,
          keeperId: shot.keeperId, shooterName: shot.shooterName, xg: shot.xg,
          outcome: 'saved', sequenceId
        });
      } else {
        const sequenceId = `miss_${side}_${shotIndex + 1}`;
        const type = chance(random, 0.18) ? 'big_chance' : 'shot';
        pushEvent(shot.nominal, shot.half, type, side, {
          ...shooter, keeperId: shot.keeperId, keeperName: shot.keeperName,
          xg: shot.xg, outcome: 'wide', sequenceId
        });
        pushEvent(shot.nominal + 0.16, shot.half, 'goal_kick', other(side), {
          sequenceId: `goal_kick_${sequenceId}`, playerId: shot.keeperId, playerName: shot.keeperName,
          outcome: 'shot_wide'
        });
      }
    }
  }

  // Penales: infracción, lanzador, víctima, guardameta y resultado forman una
  // misma secuencia. Un penal fallado siempre tiene un desenlace visible.
  const penaltyResult = { saved: 'fue atajado', post: 'pegó en el poste', wide: 'se fue fuera' };
  for (const pen of plans.penalties) {
    const sequenceId = pen.id;
    pushEvent(pen.nominal, pen.half, 'penalty_awarded', pen.team, {
      sequenceId, playerId: pen.fouledId, playerName: pen.fouledName,
      fouledId: pen.fouledId, fouledName: pen.fouledName,
      foulerId: pen.foulerId, foulerName: pen.foulerName,
      shooterId: pen.shooterId, shooterName: pen.shooterName,
      keeperId: pen.keeperId, keeperName: pen.keeperName
    });
    if (pen.converted) {
      pushEvent(pen.nominal + 0.4, pen.half, 'penalty_scored', pen.team, {
        sequenceId, playerId: pen.shooterId, playerName: pen.shooterName,
        xg: PENALTY_XG, outcome: 'goal'
      });
    } else {
      pushEvent(pen.nominal + 0.4, pen.half, 'penalty_missed', pen.team, {
        sequenceId, playerId: pen.shooterId, playerName: pen.shooterName,
        keeperId: pen.keeperId, keeperName: pen.keeperName,
        xg: PENALTY_XG, outcome: pen.outcome, resultado: penaltyResult[pen.outcome] || 'se fue fuera'
      });
    }
  }

  // Las amonestaciones/expulsiones quedan ligadas a una falta real y registrada.
  for (const card of plans.cards) {
    pushEvent(card.nominal, card.half, 'foul', card.team, {
      sequenceId: card.sequenceId, playerId: card.playerId, playerName: card.playerName,
      beneficiaryTeam: other(card.team), reason: card.reason || 'foul', cardIncident: true
    });
    pushEvent(card.nominal, card.half, card.type, card.team, {
      sequenceId: card.sequenceId, playerId: card.playerId, playerName: card.playerName,
      beneficiaryTeam: other(card.team), reason: card.reason || 'foul'
    });
  }
  for (const sub of plans.subs) pushEvent(sub.nominal, sub.half, 'substitution', sub.team, {
    playerId: sub.playerInId, playerName: sub.playerInName,
    playerInId: sub.playerInId, playerInName: sub.playerInName,
    playerOutId: sub.playerOutId, playerOutName: sub.playerOutName, slotIndex: sub.slotIndex
  });
  for (const item of plans.setPieces) {
    const { nominal, half, type, team, ...extra } = item;
    pushEvent(nominal, half, type, team, extra);
  }
  for (const item of plans.possession) pushEvent(item.nominal, item.half, item.type, item.team, {});

  const decorated = normalizeAndDecorateTimeline(events, { home, away, lineups, random, clock });
  const runningScore = { home: 0, away: 0 };
  const runningXg = { home: 0, away: 0 };
  const runningShots = { home: 0, away: 0 };
  const possessionCount = { home: 0, away: 0 };
  const timeline = decorated.map((event, index) => {
    if (event.type === 'goal' || event.type === 'penalty_scored') runningScore[event.team]++;
    if (event.xg != null && event.team && ['shot', 'shot_on_target', 'goal', 'penalty_scored', 'penalty_missed', 'big_chance'].includes(event.type)) {
      runningXg[event.team] = Number((runningXg[event.team] + event.xg).toFixed(2));
    }
    if (event.type === 'shot' || event.type === 'shot_on_target' || event.type === 'goal' || event.type === 'penalty_scored' || event.type === 'penalty_missed' || event.type === 'big_chance') {
      if (event.team) runningShots[event.team]++;
    }
    if ((event.type === 'pass_sequence' || event.type === 'possession_change') && event.team) possessionCount[event.team]++;
    const possTotal = possessionCount.home + possessionCount.away;
    const possHome = possTotal ? possessionCount.home / possTotal : .5;
    const teamXg = event.team ? runningXg[event.team] : 0;
    const vars = {
      ...sideVars(home, away, event.team),
      minuto: Math.round(event.t), marcador: formatScore(runningScore),
      posesion: `${Math.round((event.team === 'away' ? 1 - possHome : possHome) * 100)} %`,
      tiros: `${runningShots.home}-${runningShots.away}`,
      xg: Number((event.xg != null ? event.xg : teamXg).toFixed(2)).toFixed(2),
      xgFavor: Number(teamXg.toFixed(2)).toFixed(2),
      ...eventVars(event)
    };
    // El dato del equipo se calcula con el prefijo ya ocurrido; un penal
    // señalado comunica xG esperado, pero aún no altera el xG registrado.
    vars.xgFavor = Number((teamXg + (event.type === 'penalty_awarded' ? PENALTY_XG : 0)).toFixed(2)).toFixed(2);
    const commentary = event.cardIncident ? [] : generateCommentary(event.type, vars, random, memory);
    return {
      ...event,
      i: index,
      marcador: formatScore(runningScore),
      team: event.team || null,
      importance: IMPORTANCE[event.type] || 2,
      phase: event.type === 'penalty_missed' && event.outcome === 'saved' ? 'build_up'
        : (['shot', 'big_chance'].includes(event.type) && event.outcome === 'wide' ? 'set_piece' : (PHASE[event.type] || 'build_up')),
      commentary
    };
  });
  return timeline;
}

// {equipo}/{rival} son RELATIVOS al equipo del evento: en un gol visitante el
// narrador debe nombrar al visitante como «equipo». Los eventos neutros
// (kickoff, descanso, final) usan al local como «equipo» (anfitrión primero).
function sideVars(home, away, team) {
  const base = { estadio: home.stadium };
  if (team === 'away') return { ...base, equipo: away.name, rival: home.name };
  return { ...base, equipo: home.name, rival: away.name };
}

function eventVars(e) {
  const vars = {};
  if (e.playerName) vars.jugador = e.playerName;
  if (e.playerOutName) vars.sale = e.playerOutName;
  if (e.assistName) vars.asistencia = e.assistName;
  if (e.xg != null) { vars.xg = Number(e.xg).toFixed(2); vars.xgFavor = Number(e.xg).toFixed(2); }
  if (e.marcador) vars.marcador = e.marcador;              // prórroga/tanda: marcador explícito
  if (e.resultado) vars.resultado = e.resultado;
  else if (e.outcome) vars.resultado = ({ goal: 'gol', saved: 'atajado', rebound: 'rechazado', post: 'al poste', wide: 'fuera' })[e.outcome] || e.outcome;
  if (e.marcadorTanda) vars.marcadorTanda = e.marcadorTanda;
  if (e.goles) vars.goles = e.goles;
  return vars;
}

// --- Generador principal (§7.3) ---

// Genera la línea de tiempo de los 90' + agregado. Devuelve
// { timeline, score, stats, lambdas, clock }. Si ctx.esDesempate y el marcador
// queda empatado, añade prórroga y (si persiste) tanda (§7.5).
function generateTimeline(home, away, ctx = {}, random) {
  const rho = Number.isFinite(ctx.rho) ? ctx.rho : RHO;
  const lambdas = expectedGoals(home.ratings, away.ratings, { leagueAvg: ctx.leagueAvg, homeAdv: ctx.homeAdv });
  const matrix = scoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, rho);
  const score = sampleScore(matrix, random);

  const s1 = randInt(random, STOPPAGE_MIN, STOPPAGE_MAX);
  const s2 = randInt(random, STOPPAGE_MIN, STOPPAGE_MAX);
  const clock = makeClock(s1, s2);

  const possessionHome = computePossession(home, away);
  const lineups = createLineups(home, away);
  const plannedSubs = planSubs(home, away, random, lineups);
  const cards = planCards(home, away, random, plannedSubs, lineups);
  const dismissals = cards.filter(event => event.type === 'red_card' || event.type === 'second_yellow');
  const subs = plannedSubs.filter(sub => !dismissals.some(card => card.team === sub.team
    && card.playerId === sub.playerOutId
    && (card.half < sub.half || (card.half === sub.half && card.nominal <= sub.nominal))));
  const goals = spreadGoals(score, random);
  const shots = planShots(lambdas, goals, home, away, possessionHome, random, subs, lineups, dismissals);
  const pens = planPenalties(score, shots, lambdas, random, home, away, subs, lineups, dismissals);
  const setPieces = planSetPieces(possessionHome, random, home, away, subs, lineups, dismissals);
  const possession = planPossessionEvents(possessionHome, random);

  // xG final por equipo: tiros más penales fallados. El penal convertido ya
  // sustituyó el xG del gol de su propio tiro y no se suma dos veces.
  const xg = { home: 0, away: 0 };
  for (const side of ['home', 'away']) {
    for (const shot of shots[side]) xg[side] += shot.xg;
    xg[side] += pens.xgBonus[side];
    xg[side] = Number(xg[side].toFixed(2));
  }

  const timeline = assembleEvents({ shots, penalties: pens.penalties, cards, subs, setPieces, possession }, home, away, clock, random, lineups);
  Object.defineProperty(timeline, 'lineups', { value: lineups, enumerable: false });
  const missedPenalties = { home: 0, away: 0 };
  const savedPenalties = { home: 0, away: 0 };
  for (const penalty of pens.penalties) {
    if (!penalty.converted) {
      missedPenalties[penalty.team]++;
      if (penalty.outcome === 'saved') savedPenalties[penalty.team]++;
    }
  }
  const stats = {
    xG: xg,
    possession: { home: Number(possessionHome.toFixed(2)), away: Number((1 - possessionHome).toFixed(2)) },
    shots: {
      home: shots.home.length + missedPenalties.home,
      away: shots.away.length + missedPenalties.away
    },
    shotsOnTarget: {
      home: shots.home.filter(shot => shot.onTarget).length + savedPenalties.home,
      away: shots.away.filter(shot => shot.onTarget).length + savedPenalties.away
    },
    corners: { home: setPieces.filter(e => e.type === 'corner' && e.team === 'home').length, away: setPieces.filter(e => e.type === 'corner' && e.team === 'away').length }
  };

  let result = { timeline, lineups, score, stats, lambdas, clock, possessionHome };

  // Prórroga y tanda solo en el partido de desempate empatado al 90' (§7.5).
  if (ctx.esDesempate && score.home === score.away) {
    result = generateExtraTime(result, home, away, ctx, random);
  }
  return result;
}

// --- Prórroga y tanda (§7.5, A14) ---

// Añade 2 × 15' de prórroga con fatiga. Si al 120' sigue empatado, añade la
// tanda. Devuelve el resultado ampliado con extraTime y (quizá) shootout.
function generateExtraTime(base, home, away, ctx, random) {
  const { timeline, score, clock } = base;
  const lineups = base.lineups || createLineups(home, away);
  const fatigue = Number.isFinite(ctx.extraTimeFatigue) ? ctx.extraTimeFatigue : EXTRA_TIME_FATIGUE;
  const etMinutes = Number.isFinite(ctx.extraTimeMinutes) ? ctx.extraTimeMinutes : EXTRA_TIME_MINUTES;
  const lambdas = base.lambdas;
  // λ de prórroga: 30/90 del partido, con fatiga.
  const etLambdaHome = lambdas.lambdaHome * (etMinutes / 90) * fatigue;
  const etLambdaAway = lambdas.lambdaAway * (etMinutes / 90) * fatigue;
  const etMatrix = scoreMatrix(etLambdaHome, etLambdaAway, ctx.rho ?? RHO);
  const etScore = sampleScore(etMatrix, random);

  const etStart = clock.matchEnd;
  const etEnd = etStart + etMinutes;
  const totalHome = score.home + etScore.home;
  const totalAway = score.away + etScore.away;
  const needsShootout = totalHome === totalAway;
  // El full_time de los 90' se sustituye por el cierre real del desempate.
  const regularTimeline = timeline.filter(event => event.type !== 'full_time');
  Object.defineProperty(regularTimeline, 'lineups', { value: lineups, enumerable: false });
  const beforeExtraTime = deriveMatchState(regularTimeline, etStart, lineups).state;
  beforeExtraTime.minute = etStart;

  // Reparte los goles de la prórroga entre etStart y etEnd, ordenados.
  const etGoals = [];
  for (let i = 0; i < etScore.home; i++) etGoals.push({ team: 'home', t: etStart + randRange(random, 1, etMinutes - 0.5) });
  for (let i = 0; i < etScore.away; i++) etGoals.push({ team: 'away', t: etStart + randRange(random, 1, etMinutes - 0.5) });
  etGoals.sort((x, y) => x.t - y.t);

  const events = [];
  let runH = score.home, runA = score.away;
  events.push({ t: Number(etStart.toFixed(2)), type: 'extra_time_start', team: null, half: 3, marcador: formatScore({ home: runH, away: runA }) });
  for (const goal of etGoals) {
    if (goal.team === 'home') runH++; else runA++;
    const availableIds = new Set(beforeExtraTime.players.filter(player => player.team === goal.team && player.active && POS_GROUP[player.pos] !== 'GK').map(player => player.id));
    const active = lineups[goal.team].players.filter(player => availableIds.has(player.id));
    const shooter = weightedPick(random, active.length ? active : (goal.team === 'home' ? home : away).squad, shootWeight);
    events.push({
      t: Number(goal.t.toFixed(2)), type: 'goal', team: goal.team, half: 3,
      playerId: shooter ? shooter.id : null, playerName: shooter ? shooter.name : null,
      xg: Number(randRange(random, 0.15, 0.5).toFixed(2)), outcome: 'goal',
      marcador: formatScore({ home: runH, away: runA })
    });
  }
  events.push({ t: Number(etEnd.toFixed(2)), type: 'extra_time_end', team: null, half: 3, marcador: formatScore({ home: runH, away: runA }) });
  if (!needsShootout) events.push({ t: Number(etEnd.toFixed(2)), type: 'full_time', team: null, half: 3, marcador: formatScore({ home: runH, away: runA }) });

  const extraClock = { ...clock, matchEnd: etEnd, extraTimeStart: etStart, extraTimeEnd: etEnd };
  const extraTimeline = finalizeExtraEvents(events, home, away, random, regularTimeline.length, {
    lineups, initialState: beforeExtraTime, clock: extraClock
  });
  const fullTimeline = [...regularTimeline, ...extraTimeline];
  Object.defineProperty(fullTimeline, 'lineups', { value: lineups, enumerable: false });

  let result = {
    ...base,
    timeline: fullTimeline,
    lineups,
    clock: extraClock,
    score: { home: totalHome, away: totalAway },
    extraTime: { score: etScore, start: etStart, end: etEnd }
  };

  // Si al 120' sigue empatado → tanda de penales.
  if (needsShootout) result = generateShootout(result, home, away, random, etEnd);
  return result;
}

// Sella los eventos de prórroga con la misma meta que el resto (balón, fase,
// relevancia, comentario), continuando la numeración desde `startIndex`.
function finalizeExtraEvents(events, home, away, random, startIndex, { lineups, initialState, clock }) {
  const memory = createMemory();
  const decorated = normalizeAndDecorateTimeline(events, { home, away, lineups, random, clock, initialState });
  const runningScore = initialState && initialState.score
    ? { home: initialState.score.home, away: initialState.score.away }
    : { home: 0, away: 0 };
  return decorated.map((event, index) => {
    if (event.type === 'goal' || event.type === 'penalty_scored') runningScore[event.team]++;
    const vars = {
      ...sideVars(home, away, event.team),
      minuto: Math.round(event.t), marcador: event.marcador || formatScore(runningScore),
      ...eventVars(event)
    };
    return {
      ...event,
      i: startIndex + index,
      team: event.team || null,
      importance: IMPORTANCE[event.type] || 2,
      phase: PHASE[event.type] || 'build_up',
      commentary: event.cardIncident ? [] : generateCommentary(event.type, vars, random, memory)
    };
  });
}

// Tanda de penales (§7.5): 5 por equipo alternos con eliminación temprana, luego
// muerte súbita. SIEMPRE produce ganador (el lazo termina: el PRNG es finito y la
// muerte súbita se corta en cuanto uno falla y el otro no).
function generateShootout(base, home, away, random, startT) {
  const events = [];
  const lineups = base.lineups || createLineups(home, away);
  const initialState = deriveMatchState(base.timeline, startT, lineups).state;
  initialState.minute = startT;
  let t = startT + 1;
  const marks = { home: 0, away: 0 };
  const marcador120 = formatScore(base.score);
  events.push({ t: Number(t.toFixed(2)), type: 'shootout_start', team: null, half: 4, marcador: marcador120, marcadorTanda: '0-0' });
  t += 0.3;

  const takers = {};
  for (const side of ['home', 'away']) {
    const activeIds = new Set(initialState.players.filter(player => player.team === side && player.active && POS_GROUP[player.pos] !== 'GK').map(player => player.id));
    takers[side] = shuffle(random, lineups[side].players.filter(player => activeIds.has(player.id)));
  }
  const taken = { home: 0, away: 0 };
  const nextTaker = (side) => {
    const list = takers[side];
    const p = list[taken[side] % list.length];
    taken[side]++;
    return p;
  };

  // Fase inicial: SHOOTOUT_INITIAL por equipo, con eliminación temprana.
  for (let round = 0; round < SHOOTOUT_INITIAL; round++) {
    for (const side of ['home', 'away']) {
      const taker = nextTaker(side);
      const scored = chance(random, SHOOTOUT_CONVERSION);
      if (scored) marks[side]++;
      events.push({ t: Number(t.toFixed(2)), type: 'shootout_kick', team: side, half: 4, playerId: taker ? taker.id : null, playerName: taker ? taker.name : null, scored, suddenDeath: false, resultado: scored ? '¡gol!' : '¡atajado!', marcadorTanda: `${marks.home}-${marks.away}` });
      t += 0.3;
    }
    const remaining = SHOOTOUT_INITIAL - (round + 1);
    if (Math.abs(marks.home - marks.away) > remaining) break; // uno ya no puede ser alcanzado
  }

  // Muerte súbita: rondas de un tiro por equipo hasta que difieran.
  let guard = 0;
  while (marks.home === marks.away && guard < MAX_SHOOTOUT_ROUNDS) {
    guard++;
    const kicks = ['home', 'away'].map(side => ({
      side, taker: nextTaker(side), scored: chance(random, SHOOTOUT_CONVERSION)
    }));
    if (guard === MAX_SHOOTOUT_ROUNDS && kicks[0].scored === kicks[1].scored) {
      // El tope protege al generador incluso ante una secuencia adversa del PRNG;
      // el último par rompe el empate en vez de declarar un ganador con marcas iguales.
      const winnerSide = chance(random, 0.5) ? 'home' : 'away';
      for (const kick of kicks) kick.scored = kick.side === winnerSide;
    }
    for (const kick of kicks) {
      if (kick.scored) marks[kick.side]++;
      events.push({
        t: Number(t.toFixed(2)), type: 'shootout_kick', team: kick.side, half: 4,
        playerId: kick.taker ? kick.taker.id : null, playerName: kick.taker ? kick.taker.name : null,
        scored: kick.scored, suddenDeath: true,
        resultado: kick.scored ? '¡gol!' : '¡atajado!', marcadorTanda: `${marks.home}-${marks.away}`
      });
      t += 0.3;
    }
    if (marks.home !== marks.away) break;
  }

  const winner = marks.home > marks.away ? 'home' : marks.away > marks.home ? 'away' : 'home'; // el lazo garantiza diferencia
  const finishedAt = Number(t.toFixed(2));
  events.push({ t: finishedAt, type: 'shootout_end', team: winner, half: 4, marcador: marcador120, marcadorTanda: `${marks.home}-${marks.away}` });
  events.push({ t: finishedAt, type: 'full_time', team: null, half: 4, marcador: marcador120, marcadorTanda: `${marks.home}-${marks.away}` });
  const shootoutStart = startT + 1;
  const shootoutClock = { ...base.clock, matchEnd: finishedAt, shootoutStart, shootoutEnd: finishedAt };
  const shootTimeline = finalizeExtraEvents(events, home, away, random, base.timeline.length, {
    lineups, initialState, clock: shootoutClock
  });
  const timeline = [...base.timeline, ...shootTimeline];
  Object.defineProperty(timeline, 'lineups', { value: lineups, enumerable: false });
  return {
    ...base,
    timeline,
    lineups,
    clock: shootoutClock,
    shootout: { marks, winner, suddenDeathRounds: Math.max(0, guard) },
    result: { home: base.score.home, away: base.score.away, winner }
  };
}

// La reducción autoritativa de estado vive en match-state.js. Se conserva
// la firma histórica de dos argumentos usando las alineaciones enlazadas al
// timeline por generateTimeline(); Engine también las pasa explícitamente.
function deriveState(timeline, minute, lineups = timeline && timeline.lineups, throughIndex = Infinity) {
  return deriveMatchState(timeline, minute, lineups, throughIndex);
}

module.exports = {
  // constantes
  RHO, MAX_GOALS, PENALTY_RATE, PENALTY_CONVERSION, PENALTY_XG,
  EXTRA_TIME_MINUTES, EXTRA_TIME_FATIGUE, SHOOTOUT_INITIAL, SHOOTOUT_CONVERSION,
  YELLOW_RATE, RED_RATE, STOPPAGE_MIN, STOPPAGE_MAX,
  // Poisson / Dixon-Coles
  poissonPmf, dcTau, scoreMatrix, sampleScore, samplePoisson,
  // planes
  computePossession, spreadGoals, planShots, planPenalties, planCards, planSubs,
  // generadores
  generateTimeline, generateExtraTime, generateShootout,
  // estado
  deriveState, zoneFor, IMPORTANCE, PHASE
};
