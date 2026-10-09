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
  kickoff: 2, pass_sequence: 1, possession_change: 1, throw_in: 1, goal_kick: 1,
  shot: 2, shot_on_target: 3, save: 3, corner: 2, foul: 1, offside: 1, injury: 2,
  big_chance: 4, goal: 5, goal_disallowed: 4, yellow_card: 3, red_card: 5, second_yellow: 4,
  penalty_awarded: 4, penalty_scored: 5, penalty_missed: 4, substitution: 2,
  halftime: 3, second_half: 2, stoppage_start: 1, full_time: 4,
  formation_change: 2, tactic_change: 2, momentum_shift: 2,
  extra_time_start: 3, extra_time_end: 3, shootout_start: 4, shootout_kick: 4, shootout_end: 5
};

const PHASE = {
  kickoff: 'kickoff', goal: 'goal_celebration', penalty_scored: 'goal_celebration',
  goal_disallowed: 'danger', shot: 'attack', shot_on_target: 'danger', big_chance: 'danger',
  save: 'danger', corner: 'set_piece', foul: 'set_piece', offside: 'set_piece',
  penalty_awarded: 'set_piece', penalty_missed: 'set_piece', throw_in: 'set_piece',
  goal_kick: 'set_piece', pass_sequence: 'build_up', possession_change: 'build_up',
  yellow_card: 'set_piece', red_card: 'set_piece', second_yellow: 'set_piece',
  substitution: 'build_up', injury: 'build_up', halftime: 'halftime', second_half: 'build_up',
  full_time: 'build_up', extra_time_start: 'extra_time', extra_time_end: 'extra_time',
  shootout_start: 'shootout', shootout_kick: 'shootout', shootout_end: 'shootout',
  formation_change: 'build_up', tactic_change: 'build_up', momentum_shift: 'build_up',
  stoppage_start: 'build_up'
};

// --- Poisson y Dixon-Coles (§10.2) ---

function poissonPmf(k, lambda) {
  if (k < 0) return 0;
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

const POS_GROUP = { GK: 'GK', CB: 'DF', LB: 'DF', RB: 'DF', CDM: 'MF', CM: 'MF', CAM: 'MF', LW: 'FW', RW: 'FW', ST: 'FW' };
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
      if (half === 1) return clamp(nominal, 0.3, 45) * (firstHalfEnd / 45);
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
function planShots(lambdas, goals, home, away, possessionHome, random) {
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
    const squad = teams[side].squad;

    for (let i = 0; i < nShots; i++) {
      const isGoal = i < teamGoals.length;
      const onTarget = isGoal || i < nOnTarget;
      const shooter = weightedPick(random, squad, shootWeight);
      const goalInfo = isGoal ? teamGoals[i] : null;
      shots[side].push({
        team: side,
        isGoal,
        onTarget,
        xg: Number((raw[i] * scale).toFixed(3)),
        half: goalInfo ? goalInfo.half : (chance(random, 0.45) ? 1 : 2),
        nominal: goalInfo ? goalInfo.nominal : sampleNominalMinute(random, chance(random, 0.45) ? 1 : 2, true),
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
      const candidates = squad.filter(p => p.id !== shot.shooterId && POS_GROUP[p.pos] !== 'GK');
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
function planPenalties(score, shots, lambdas, random) {
  const events = [];
  const xgBonus = { home: 0, away: 0 };
  const n = Math.min(2, samplePoisson(PENALTY_RATE, random));
  if (n === 0) return { events, xgBonus, penalties: [] };

  const penalties = [];
  for (let k = 0; k < n; k++) {
    // El equipo que más ataca gana más penales (peso = xG + 0.10·localía).
    const wHome = Math.max(0.05, lambdas.lambdaHome) + 0.10;
    const wAway = Math.max(0.05, lambdas.lambdaAway);
    const team = chance(random, wHome / (wHome + wAway)) ? 'home' : 'away';
    const half = chance(random, 0.4) ? 1 : 2;
    const nominal = randRange(random, 20, 88);
    const wantsConvert = chance(random, PENALTY_CONVERSION);

    // Busca un gol sin etiquetar del equipo para re-etiquetar (solo si convirtió
    // y tiene goles). Los goles son los tiros isGoal aún no marcados isPenalty.
    const teamGoalShots = shots[team].filter(s => s.isGoal && !s.isPenalty);
    const canConvert = wantsConvert && teamGoalShots.length > 0 && score[team] > 0;

    if (canConvert) {
      const shot = teamGoalShots[0];
      shot.isPenalty = true;
      // El xG del tiro re-etiquetado se sustituye por el del penal (0.79).
      xgBonus[team] += PENALTY_XG - shot.xg;
      shot.xg = Number(PENALTY_XG.toFixed(3));
      shot.half = half;
      shot.nominal = nominal;
      penalties.push({ team, nominal, half, converted: true, shot });
    } else {
      // Fallado (o sin gol que re-etiquetar): sin tanto, pero suma xG («mereció más»).
      xgBonus[team] += PENALTY_XG;
      penalties.push({ team, nominal, half, converted: false, shot: null });
    }
  }
  return { events, xgBonus, penalties };
}

// Tarjetas (§7.3): ~4.1 amarillas y ~0.09 rojas por partido, repartidas por
// agresividad y reparto de faltas. Una roja puede ser directa o por doble amarilla.
function planCards(home, away, random) {
  const cards = [];
  const teams = { home, away };
  const nYellow = samplePoisson(YELLOW_RATE, random);
  const booked = { home: [], away: [] };

  for (let i = 0; i < nYellow; i++) {
    const team = chance(random, 0.5) ? 'home' : 'away';
    const squad = teams[team].squad.filter(p => POS_GROUP[p.pos] !== 'GK');
    const player = weightedPick(random, squad, cardWeight);
    if (!player) continue;
    const half = chance(random, 0.45) ? 1 : 2;
    cards.push({ type: 'yellow_card', team, playerId: player.id, playerName: player.name, half, nominal: sampleNominalMinute(random, half, true) });
    booked[team].push(player);
  }

  const nRed = samplePoisson(RED_RATE, random);
  for (let i = 0; i < nRed; i++) {
    const team = chance(random, 0.5) ? 'home' : 'away';
    const half = 2; // las rojas suelen llegar con el partido caliente
    const alreadyBooked = booked[team];
    const secondYellow = alreadyBooked.length > 0 && chance(random, 0.5);
    let player;
    if (secondYellow) {
      player = alreadyBooked[alreadyBooked.length - 1];
      cards.push({ type: 'second_yellow', team, playerId: player.id, playerName: player.name, half, nominal: sampleNominalMinute(random, half, true) });
    } else {
      const squad = teams[team].squad.filter(p => POS_GROUP[p.pos] !== 'GK');
      player = weightedPick(random, squad, cardWeight);
      if (player) cards.push({ type: 'red_card', team, playerId: player.id, playerName: player.name, half, nominal: sampleNominalMinute(random, half, true) });
    }
  }
  return cards;
}

// Cambios (§7.3): 3-5 por equipo, en el segundo tiempo.
function planSubs(home, away, random) {
  const subs = [];
  const teams = { home, away };
  for (const side of ['home', 'away']) {
    const n = randInt(random, SUBS_MIN, SUBS_MAX);
    const bench = shuffle(random, teams[side].squad.filter(p => p.num >= 12));
    for (let i = 0; i < n; i++) {
      const player = bench[i % Math.max(1, bench.length)];
      if (!player) continue;
      subs.push({ team: side, playerId: player.id, playerName: player.name, half: 2, nominal: randRange(random, 55, 90) });
    }
  }
  return subs;
}

// Tiros de esquina, faltas, fuera de juego y saques: relleno de baja relevancia
// coherente con la posesión (§7.1 paso 6).
function planSetPieces(possessionHome, random) {
  const events = [];
  const corners = { home: randInt(random, 2, 8), away: randInt(random, 2, 8) };
  const fouls = { home: randInt(random, 7, 16), away: randInt(random, 7, 16) };
  for (const side of ['home', 'away']) {
    for (let i = 0; i < corners[side]; i++) {
      const half = chance(random, 0.45) ? 1 : 2;
      events.push({ type: 'corner', team: side, half, nominal: sampleNominalMinute(random, half, true) });
    }
    for (let i = 0; i < fouls[side]; i++) {
      const half = chance(random, 0.45) ? 1 : 2;
      events.push({ type: 'foul', team: side, half, nominal: sampleNominalMinute(random, half, true) });
    }
    if (chance(random, 0.7)) {
      const half = chance(random, 0.45) ? 1 : 2;
      events.push({ type: 'offside', team: side, half, nominal: sampleNominalMinute(random, half, true) });
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

function ballFor(team, type, random) {
  // home ataca hacia x=1, away hacia x=0.
  let x;
  if (type === 'goal' || type === 'penalty_scored' || type === 'shot_on_target' || type === 'big_chance') {
    x = team === 'home' ? randRange(random, 0.82, 0.98) : randRange(random, 0.02, 0.18);
  } else if (type === 'shot' || type === 'save' || type === 'corner') {
    x = team === 'home' ? randRange(random, 0.68, 0.92) : randRange(random, 0.08, 0.32);
  } else if (type === 'penalty_awarded' || type === 'penalty_missed') {
    x = team === 'home' ? 0.89 : 0.11;
  } else {
    x = randRange(random, 0.25, 0.75);
  }
  const y = randRange(random, 0.2, 0.8);
  return { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
}

function zoneFor(x) {
  if (x >= 0.6) return 'final_third_home';
  if (x <= 0.4) return 'final_third_away';
  return 'midfield';
}

// Orden canónico para desempatar eventos con el mismo t (estructurales primero).
const TIE_ORDER = { kickoff: 0, halftime: 1, second_half: 2, extra_time_start: 3, extra_time_end: 4, shootout_start: 5, shootout_kick: 6, shootout_end: 7, full_time: 8 };

function assembleEvents(plans, home, away, clock, random, finalVars = {}, possessionHome = 0.5) {
  const events = [];
  const formations = { home: home.tactics.formation, away: away.tactics.formation };
  const memory = createMemory();

  const pushEvent = (nominal, half, type, team, extra = {}) => {
    const t = half ? clock.nominalToT(nominal, half) : nominal;
    events.push({ t: Number(t.toFixed(2)), type, team, half, ...extra });
  };

  // Estructurales.
  events.push({ t: 0, type: 'kickoff', team: 'home', half: 1 });
  events.push({ t: Number(clock.firstHalfEnd.toFixed(2)), type: 'halftime', team: null, half: 1 });
  events.push({ t: Number(clock.firstHalfEnd.toFixed(2)), type: 'second_half', team: null, half: 2 });
  events.push({ t: Number(clock.matchEnd.toFixed(2)), type: 'full_time', team: null, half: 2 });

  // Goles y tiros.
  for (const side of ['home', 'away']) {
    for (const shot of plans.shots[side]) {
      if (shot.isGoal && shot.isPenalty) continue; // se emite como penalty_scored
      if (shot.isGoal) {
        pushEvent(shot.nominal, shot.half, 'goal', side, { playerId: shot.shooterId, playerName: shot.shooterName, assistId: shot.assistId, assistName: shot.assistName, xg: shot.xg });
      } else if (shot.onTarget) {
        const saved = chance(random, 0.55);
        pushEvent(shot.nominal, shot.half, 'shot_on_target', side, { playerId: shot.shooterId, playerName: shot.shooterName, xg: shot.xg });
        if (saved) pushEvent(shot.nominal + 0.05, shot.half, 'save', side === 'home' ? 'away' : 'home', { xg: shot.xg });
      } else {
        pushEvent(shot.nominal, shot.half, 'shot', side, { playerId: shot.shooterId, playerName: shot.shooterName, xg: shot.xg });
        if (chance(random, 0.18)) pushEvent(shot.nominal + 0.05, shot.half, 'big_chance', side, { playerId: shot.shooterId, playerName: shot.shooterName, xg: shot.xg });
      }
    }
  }

  // Penales (§7.4).
  for (const pen of plans.penalties) {
    pushEvent(pen.nominal, pen.half, 'penalty_awarded', pen.team, {});
    if (pen.converted) {
      pushEvent(pen.nominal + 0.4, pen.half, 'penalty_scored', pen.team, { playerId: pen.shot.shooterId, playerName: pen.shot.shooterName, xg: PENALTY_XG });
    } else {
      pushEvent(pen.nominal + 0.4, pen.half, 'penalty_missed', pen.team, { playerId: null, playerName: null, xg: PENALTY_XG });
    }
  }

  // Tarjetas, cambios, set pieces, posesión.
  for (const c of plans.cards) pushEvent(c.nominal, c.half, c.type, c.team, { playerId: c.playerId, playerName: c.playerName });
  for (const s of plans.subs) pushEvent(s.nominal, s.half, 'substitution', s.team, { playerId: s.playerId, playerName: s.playerName });
  for (const e of plans.setPieces) pushEvent(e.nominal, e.half, e.type, e.team, {});
  for (const e of plans.possession) pushEvent(e.nominal, e.half, e.type, e.team, {});

  // Orden cronológico estable; desempata estructurales por TIE_ORDER.
  events.sort((a, b) => (a.t - b.t) || ((TIE_ORDER[a.type] ?? 99) - (TIE_ORDER[b.type] ?? 99)));

  // Meta: índice, balón, formación, relevancia, fase y comentario. El marcador
  // se acumula en orden cronológico para que el narrador diga el tanteo vigente
  // en cada gol, descanso y final (nunca un marcador futuro).
  let runHome = 0, runAway = 0;
  const timeline = events.map((e, index) => {
    if (e.type === 'goal' || e.type === 'penalty_scored') {
      if (e.team === 'home') runHome++; else runAway++;
    }
    const ball = ballFor(e.team, e.type, random);
    const marcador = formatScore({ home: runHome, away: runAway });
    const posesion = `${Math.round((e.team === 'away' ? (1 - possessionHome) : possessionHome) * 100)} %`;
    const vars = { ...sideVars(home, away, e.team), ...finalVars, minuto: Math.round(e.t), marcador, posesion, ...eventVars(e) };
    const commentary = generateCommentary(e.type, vars, random, memory);
    return {
      i: index,
      t: e.t,
      type: e.type,
      team: e.team || null,
      playerId: e.playerId || null,
      ball,
      formation: { home: formations.home, away: formations.away },
      importance: IMPORTANCE[e.type] || 2,
      phase: PHASE[e.type] || 'build_up',
      ...(e.xg != null ? { xg: e.xg } : {}),
      ...(e.playerName ? { playerName: e.playerName } : {}),
      ...(e.assistId ? { assistId: e.assistId, assistName: e.assistName } : {}),
      ...(e.suddenDeath != null ? { suddenDeath: e.suddenDeath } : {}),
      ...(e.scored != null ? { scored: e.scored } : {}),
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
  if (e.assistName) vars.asistencia = e.assistName;
  if (e.xg != null) { vars.xg = Number(e.xg).toFixed(2); vars.xgFavor = Number(e.xg).toFixed(2); }
  if (e.marcador) vars.marcador = e.marcador;              // prórroga/tanda: marcador explícito
  if (e.resultado) vars.resultado = e.resultado;           // tanda: «¡gol!» / «¡atajado!»
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
  const goals = spreadGoals(score, random);
  const shots = planShots(lambdas, goals, home, away, possessionHome, random);
  const pens = planPenalties(score, shots, lambdas, random);
  const cards = planCards(home, away, random);
  const subs = planSubs(home, away, random);
  const setPieces = planSetPieces(possessionHome, random);
  const possession = planPossessionEvents(possessionHome, random);

  // xG final por equipo: suma de xG de tiros + bonus de penales fallados.
  const xg = { home: 0, away: 0 };
  for (const side of ['home', 'away']) {
    for (const shot of shots[side]) xg[side] += shot.xg;
    xg[side] += pens.xgBonus[side];
    xg[side] = Number(xg[side].toFixed(2));
  }

  const finalVars = { tiros: `${shots.home.length}-${shots.away.length}` };
  const timeline = assembleEvents({ shots, penalties: pens.penalties, cards, subs, setPieces, possession }, home, away, clock, random, finalVars, possessionHome);

  const stats = {
    xG: xg,
    possession: { home: Number(possessionHome.toFixed(2)), away: Number((1 - possessionHome).toFixed(2)) },
    shots: { home: shots.home.length, away: shots.away.length },
    shotsOnTarget: { home: shots.home.filter(s => s.onTarget).length, away: shots.away.filter(s => s.onTarget).length },
    corners: { home: setPieces.filter(e => e.type === 'corner' && e.team === 'home').length, away: setPieces.filter(e => e.type === 'corner' && e.team === 'away').length }
  };

  let result = { timeline, score, stats, lambdas, clock, possessionHome };

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

  // Reparte los goles de la prórroga entre etStart y etEnd, ordenados.
  const etGoals = [];
  for (let i = 0; i < etScore.home; i++) etGoals.push({ team: 'home', t: etStart + randRange(random, 1, etMinutes - 0.5) });
  for (let i = 0; i < etScore.away; i++) etGoals.push({ team: 'away', t: etStart + randRange(random, 1, etMinutes - 0.5) });
  etGoals.sort((x, y) => x.t - y.t);

  const events = [];
  let runH = score.home, runA = score.away;
  events.push({ t: Number(etStart.toFixed(2)), type: 'extra_time_start', team: null, half: 3, marcador: formatScore({ home: runH, away: runA }) });
  for (const g of etGoals) {
    if (g.team === 'home') runH++; else runA++;
    const shooter = weightedPick(random, (g.team === 'home' ? home : away).squad, shootWeight);
    events.push({
      t: Number(g.t.toFixed(2)), type: 'goal', team: g.team, half: 3,
      playerId: shooter ? shooter.id : null, playerName: shooter ? shooter.name : null,
      xg: Number(randRange(random, 0.15, 0.5).toFixed(2)), marcador: formatScore({ home: runH, away: runA })
    });
  }
  events.push({ t: Number(etEnd.toFixed(2)), type: 'extra_time_end', team: null, half: 3, marcador: formatScore({ home: runH, away: runA }) });

  const extraTimeline = finalizeExtraEvents(events, home, away, random, timeline.length);
  const fullTimeline = [...timeline, ...extraTimeline];

  const totalHome = score.home + etScore.home;
  const totalAway = score.away + etScore.away;

  let result = {
    ...base,
    timeline: fullTimeline,
    score: { home: totalHome, away: totalAway },
    extraTime: { score: etScore, start: etStart, end: etEnd }
  };

  // Si al 120' sigue empatado → tanda de penales.
  if (totalHome === totalAway) {
    result = generateShootout(result, home, away, random, etEnd);
  }
  return result;
}

// Sella los eventos de prórroga con la misma meta que el resto (balón, fase,
// relevancia, comentario), continuando la numeración desde `startIndex`.
function finalizeExtraEvents(events, home, away, random, startIndex) {
  const memory = createMemory();
  const sorted = events.slice().sort((a, b) => (a.t - b.t) || ((TIE_ORDER[a.type] ?? 99) - (TIE_ORDER[b.type] ?? 99)));
  return sorted.map((e, k) => {
    const ball = ballFor(e.team, e.type, random);
    const vars = { ...sideVars(home, away, e.team), minuto: Math.round(e.t), ...eventVars(e) };
    return {
      i: startIndex + k,
      t: e.t, type: e.type, team: e.team || null, playerId: e.playerId || null,
      ball, formation: { home: home.tactics.formation, away: away.tactics.formation },
      importance: IMPORTANCE[e.type] || 2, phase: PHASE[e.type] || 'build_up',
      ...(e.xg != null ? { xg: e.xg } : {}),
      ...(e.playerName ? { playerName: e.playerName } : {}),
      ...(e.scored != null ? { scored: e.scored } : {}),
      ...(e.suddenDeath != null ? { suddenDeath: e.suddenDeath } : {}),
      ...(e.marcadorTanda != null ? { marcadorTanda: e.marcadorTanda } : {}),
      commentary: generateCommentary(e.type, vars, random, memory)
    };
  });
}

// Tanda de penales (§7.5): 5 por equipo alternos con eliminación temprana, luego
// muerte súbita. SIEMPRE produce ganador (el lazo termina: el PRNG es finito y la
// muerte súbita se corta en cuanto uno falla y el otro no).
function generateShootout(base, home, away, random, startT) {
  const events = [];
  let t = startT + 1;
  const marks = { home: 0, away: 0 };
  const marcador120 = formatScore(base.score);
  events.push({ t: Number(t.toFixed(2)), type: 'shootout_start', team: null, half: 4, marcador: marcador120, marcadorTanda: '0-0' });
  t += 0.3;

  const takers = { home: shuffle(random, home.squad.filter(p => POS_GROUP[p.pos] !== 'GK')), away: shuffle(random, away.squad.filter(p => POS_GROUP[p.pos] !== 'GK')) };
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
    for (const side of ['home', 'away']) {
      const taker = nextTaker(side);
      const scored = chance(random, SHOOTOUT_CONVERSION);
      if (scored) marks[side]++;
      events.push({ t: Number(t.toFixed(2)), type: 'shootout_kick', team: side, half: 4, playerId: taker ? taker.id : null, playerName: taker ? taker.name : null, scored, suddenDeath: true, resultado: scored ? '¡gol!' : '¡atajado!', marcadorTanda: `${marks.home}-${marks.away}` });
      t += 0.3;
    }
    if (marks.home !== marks.away) break;
  }

  const winner = marks.home > marks.away ? 'home' : marks.away > marks.home ? 'away' : 'home'; // el lazo garantiza diferencia
  events.push({ t: Number(t.toFixed(2)), type: 'shootout_end', team: winner, half: 4, marcador: marcador120, marcadorTanda: `${marks.home}-${marks.away}` });

  const shootTimeline = finalizeExtraEvents(events, home, away, random, base.timeline.length);
  return {
    ...base,
    timeline: [...base.timeline, ...shootTimeline],
    shootout: { marks, winner, suddenDeathRounds: Math.max(0, guard) },
    result: { home: base.score.home, away: base.score.away, winner }
  };
}

// --- Estado derivado (§6.2) y privacidad del futuro (T7) ---

// Pliega los eventos con t <= minute y devuelve el estado público + el índice
// revelado. NUNCA incluye eventos futuros: es la base de T7 (sin fuga).
function deriveState(timeline, minute) {
  const state = {
    minute: 0, half: 1, stoppage: 0,
    score: { home: 0, away: 0 },
    cards: { home: [], away: [] },
    subs: { home: [], away: [] },
    xG: { home: 0, away: 0 },
    possession: { home: 0.5, away: 0.5 },
    shots: { home: 0, away: 0 }, shotsOnTarget: { home: 0, away: 0 },
    corners: { home: 0, away: 0 },
    formation: { home: '4-4-2', away: '4-4-2' },
    ball: { x: 0.5, y: 0.5, zone: 'midfield' },
    phase: 'kickoff',
    redCards: { home: 0, away: 0 }
  };
  const lastT = timeline.length ? timeline[timeline.length - 1].t : 0;
  const possCount = { home: 0, away: 0 };
  let revealedIndex = -1;
  for (const e of timeline) {
    if (e.t > minute) break;
    revealedIndex = e.i;
    if (e.formation) state.formation = { home: e.formation.home, away: e.formation.away };
    if (e.ball) state.ball = { x: e.ball.x, y: e.ball.y, zone: zoneFor(e.ball.x) };
    state.phase = e.phase || state.phase;
    const team = e.team;
    if ((e.type === 'pass_sequence' || e.type === 'possession_change') && team) possCount[team]++;
    switch (e.type) {
      case 'goal':
      case 'penalty_scored':
        if (team) state.score[team]++;
        break;
      case 'yellow_card':
        if (team) state.cards[team].push({ playerId: e.playerId, type: 'yellow', minute: e.t });
        break;
      case 'red_card':
        if (team) { state.cards[team].push({ playerId: e.playerId, type: 'red', minute: e.t }); state.redCards[team]++; }
        break;
      case 'second_yellow':
        if (team) { state.cards[team].push({ playerId: e.playerId, type: 'red', minute: e.t }); state.redCards[team]++; }
        break;
      case 'substitution':
        if (team) state.subs[team].push({ playerId: e.playerId, minute: e.t });
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
      default:
        break;
    }
    if (e.xg != null && team && (e.type === 'shot' || e.type === 'shot_on_target' || e.type === 'goal' || e.type === 'penalty_scored' || e.type === 'penalty_missed' || e.type === 'big_chance')) {
      state.xG[team] = Number((state.xG[team] + e.xg).toFixed(2));
    }
  }
  // Minuto vivo (§6.2): el reloj pedido, acotado al último evento generado.
  state.minute = Number(Math.max(0, Math.min(minute, lastT)).toFixed(2));
  // Posesión derivada de los tramos revelados: coincide con stats.possession
  // porque planPossessionEvents sesga cada tramo con la posesión real.
  const possTotal = possCount.home + possCount.away;
  if (possTotal > 0) {
    state.possession.home = Number((possCount.home / possTotal).toFixed(2));
    state.possession.away = Number((possCount.away / possTotal).toFixed(2));
  }
  return { state, revealedIndex };
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
