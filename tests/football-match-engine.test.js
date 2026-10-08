'use strict';

// Fase B — Pruebas del motor de partido (§7) y aceptación T1/T4/T7 (§20).
//
// Lo que blindan estos tests:
//   · T1 — la matriz de Poisson suma 1, es simétrica con ratings iguales y la
//     corrección Dixon-Coles eleva 0-0 y 1-1 (y reduce 1-0 / 0-1).
//   · T4 — mismo seed ⇒ línea de tiempo idéntica byte a byte (reproductibilidad
//     en auditoría, §3.2).
//   · T7 — deriveState() no fuga el futuro: el estado a un minuto dado solo
//     refleja eventos ya ocurridos.
//   · R3 — la línea de tiempo es coherente con el marcador sorteado de la matriz
//     que fija las cuotas: los goles emitidos son exactamente el marcador, y un
//     penal convertido RE-ETIQUETA un gol (nunca añade uno nuevo, §7.4/A13).
//   · §7.2 — forma del evento; §7.5 — prórroga y tanda solo en el desempate.

const test = require('node:test');
const assert = require('node:assert');
const prng = require('../lib/football/prng');
const { buildSeasonClubs } = require('../lib/football/teams');
const {
  RHO, PENALTY_XG, SHOOTOUT_INITIAL,
  poissonPmf, dcTau, scoreMatrix, sampleScore, samplePoisson,
  computePossession, planPenalties, planShots,
  generateTimeline, deriveState
} = require('../lib/football/match-engine');

const CLUBS = buildSeasonClubs(prng.mulberry32(prng.hash32('tests-fase-b')));
const rnd = (s) => prng.mulberry32(prng.hash32(s));
const ctxBase = { leagueAvg: 1.35, homeAdv: 1.12 };

// Dos clubes distintos y estables para las pruebas.
const HOME = CLUBS[0];
const AWAY = CLUBS[7];

function sumMatrix(m) {
  let s = 0;
  for (const row of m) for (const v of row) s += v;
  return s;
}

// --- T1: matriz de Poisson y Dixon-Coles ---

test('T1 — poissonPmf es una distribución válida', () => {
  let s = 0;
  for (let k = 0; k < 40; k++) s += poissonPmf(k, 1.4);
  assert.ok(Math.abs(s - 1) < 1e-6, `la PMF de Poisson suma ~1 (obtenido ${s})`);
  assert.strictEqual(poissonPmf(-1, 1.4), 0);
  assert.ok(poissonPmf(1, 1.4) > poissonPmf(5, 1.4), 'el modo está cerca de λ');
});

test('T1 — scoreMatrix suma 1 tras la normalización', () => {
  const m = scoreMatrix(1.5, 1.1, RHO);
  assert.ok(Math.abs(sumMatrix(m) - 1) < 1e-9, `suma exacta 1 (obtenido ${sumMatrix(m)})`);
  assert.strictEqual(m.length, 9);
  assert.strictEqual(m[0].length, 9);
  for (const row of m) for (const v of row) assert.ok(v >= 0 && v <= 1, 'cada celda es una probabilidad');
});

test('T1 — con ratings iguales la matriz es simétrica', () => {
  const m = scoreMatrix(1.35, 1.35, RHO);
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      assert.ok(Math.abs(m[i][j] - m[j][i]) < 1e-12, `P(${i},${j}) == P(${j},${i})`);
    }
  }
});

test('T1 — Dixon-Coles eleva 0-0 y 1-1 y reduce 1-0 / 0-1', () => {
  const lh = 1.35, la = 1.2;
  const dc = scoreMatrix(lh, la, RHO);      // con corrección
  const pp = scoreMatrix(lh, la, 0);        // Poisson puro (ρ=0 ⇒ τ=1)
  // τ(0,0)=1-λhλaρ>1 y τ(1,1)=1-ρ>1 con ρ<0 ⇒ más masa; τ(0,1),τ(1,0)<1 ⇒ menos.
  assert.ok(dc[0][0] > pp[0][0], 'Dixon-Coles eleva el 0-0');
  assert.ok(dc[1][1] > pp[1][1], 'Dixon-Coles eleva el 1-1');
  assert.ok(dc[0][1] < pp[0][1], 'Dixon-Coles reduce el 0-1');
  assert.ok(dc[1][0] < pp[1][0], 'Dixon-Coles reduce el 1-0');
  // El factor τ en sí.
  assert.ok(dcTau(0, 0, lh, la, RHO) > 1);
  assert.ok(dcTau(1, 1, lh, la, RHO) > 1);
  assert.ok(dcTau(0, 1, lh, la, RHO) < 1);
  assert.strictEqual(dcTau(3, 2, lh, la, RHO), 1, 'τ=1 fuera del bloque bajo');
});

test('T1 — sampleScore devuelve marcadores dentro de la matriz', () => {
  const m = scoreMatrix(1.4, 1.2, RHO);
  for (let k = 0; k < 500; k++) {
    const s = sampleScore(m, rnd('sc' + k));
    assert.ok(Number.isInteger(s.home) && s.home >= 0 && s.home <= 8);
    assert.ok(Number.isInteger(s.away) && s.away >= 0 && s.away <= 8);
  }
});

test('samplePoisson aproxima λ', () => {
  let sum = 0;
  const N = 20000;
  for (let k = 0; k < N; k++) sum += samplePoisson(0.9, rnd('pp' + k));
  const mean = sum / N;
  assert.ok(Math.abs(mean - 0.9) < 0.05, `media empírica ~λ (obtenido ${mean.toFixed(3)})`);
  assert.strictEqual(samplePoisson(0, rnd('z')), 0);
});

// --- T4: determinismo ---

test('T4 — mismo seed ⇒ línea de tiempo idéntica byte a byte', () => {
  const a = generateTimeline(HOME, AWAY, ctxBase, rnd('mismo-seed'));
  const b = generateTimeline(HOME, AWAY, ctxBase, rnd('mismo-seed'));
  assert.deepStrictEqual(a.score, b.score, 'el marcador sorteado coincide');
  assert.strictEqual(JSON.stringify(a.timeline), JSON.stringify(b.timeline), 'la línea de tiempo es idéntica');
  assert.strictEqual(a.timeline.length, b.timeline.length);
});

test('T4 — seed distinto ⇒ partido distinto', () => {
  const a = generateTimeline(HOME, AWAY, ctxBase, rnd('seed-A'));
  const b = generateTimeline(HOME, AWAY, ctxBase, rnd('seed-B'));
  assert.notStrictEqual(JSON.stringify(a.timeline), JSON.stringify(b.timeline));
});

// --- Estructura y forma del evento (§7.2) ---

const REQUIRED_KEYS = ['i', 't', 'type', 'team', 'ball', 'formation', 'importance', 'commentary'];

test('§7.2 — todo evento tiene la forma del contrato', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('forma'));
  assert.ok(r.timeline.length > 40, 'densidad razonable de eventos');
  for (const e of r.timeline) {
    for (const k of REQUIRED_KEYS) assert.ok(k in e, `falta la clave ${k} en ${e.type}`);
    assert.ok(Number.isFinite(e.t) && e.t >= 0, 't es un minuto finito no negativo');
    assert.ok(e.ball && Number.isFinite(e.ball.x) && e.ball.x >= 0 && e.ball.x <= 1, 'ball.x en [0,1]');
    assert.ok(Number.isFinite(e.ball.y) && e.ball.y >= 0 && e.ball.y <= 1, 'ball.y en [0,1]');
    assert.ok(e.formation && e.formation.home && e.formation.away, 'formación de ambos equipos');
    assert.ok(Number.isInteger(e.importance) && e.importance >= 1 && e.importance <= 5, 'importance 1-5');
    assert.ok(Array.isArray(e.commentary), 'commentary es un array');
    for (const c of e.commentary) {
      assert.ok(c.voice === 'narrador' || c.voice === 'analista', 'voz válida');
      assert.ok(typeof c.text === 'string' && c.text.length > 0 && c.text.length <= 140, 'texto 1-140 chars');
      assert.ok(!/\{\w+\}/.test(c.text), `sin placeholders sin resolver: ${c.text}`);
    }
  }
});

test('§7.2 — índices secuenciales y tiempo monótono', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('mono'));
  r.timeline.forEach((e, i) => assert.strictEqual(e.i, i, 'índice == posición'));
  for (let i = 1; i < r.timeline.length; i++) {
    assert.ok(r.timeline[i].t >= r.timeline[i - 1].t, 't nunca retrocede');
  }
});

test('§5.4 — estructurales: kickoff, descanso, segundo tiempo y final en su sitio', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('estruct'));
  const tl = r.timeline;
  assert.strictEqual(tl[0].type, 'kickoff');
  assert.strictEqual(tl[0].t, 0);
  assert.strictEqual(tl[tl.length - 1].type, 'full_time');
  assert.strictEqual(tl[tl.length - 1].t, Number(r.clock.matchEnd.toFixed(2)));
  const ht = tl.find(e => e.type === 'halftime');
  const sh = tl.find(e => e.type === 'second_half');
  assert.ok(ht && sh, 'existen descanso y segundo tiempo');
  assert.strictEqual(ht.t, Number(r.clock.firstHalfEnd.toFixed(2)));
  assert.strictEqual(sh.t, ht.t, 'segundo tiempo arranca en el mismo instante del descanso');
  assert.ok(ht.i < sh.i, 'el descanso precede al segundo tiempo');
  // El agregado está dentro de rango.
  assert.ok(r.clock.s1 >= 1 && r.clock.s1 <= 4, 'agregado 1T en [1,4]');
  assert.ok(r.clock.s2 >= 1 && r.clock.s2 <= 4, 'agregado 2T en [1,4]');
  assert.strictEqual(r.clock.matchEnd, 90 + r.clock.s1 + r.clock.s2);
});

// --- R3: coherencia línea de tiempo ⇄ marcador sorteado ---

test('R3 — los goles emitidos son exactamente el marcador sorteado', () => {
  for (let s = 0; s < 120; s++) {
    const h = CLUBS[s % 16], a = CLUBS[(s * 5 + 3) % 16];
    if (h.short === a.short) continue;
    const r = generateTimeline(h, a, ctxBase, rnd('coh' + s));
    const homeGoals = r.timeline.filter(e => (e.type === 'goal' || e.type === 'penalty_scored') && e.team === 'home').length;
    const awayGoals = r.timeline.filter(e => (e.type === 'goal' || e.type === 'penalty_scored') && e.team === 'away').length;
    assert.strictEqual(homeGoals, r.score.home, `goles locales == marcador local (seed ${s})`);
    assert.strictEqual(awayGoals, r.score.away, `goles visitantes == marcador visitante (seed ${s})`);
  }
});

test('R3 — el xG generado aproxima a λ (modelo y precio no divergen)', () => {
  let dh = 0, da = 0, n = 0;
  for (let s = 0; s < 200; s++) {
    const h = CLUBS[s % 16], a = CLUBS[(s * 5 + 3) % 16];
    if (h.short === a.short) continue;
    const r = generateTimeline(h, a, ctxBase, rnd('xg' + s));
    dh += Math.abs(r.stats.xG.home - r.lambdas.lambdaHome);
    da += Math.abs(r.stats.xG.away - r.lambdas.lambdaAway);
    n++;
  }
  // El xG por partido puede desviarse (penales fallados, ruido de tiros), pero en
  // promedio debe quedar cerca de λ.
  assert.ok(dh / n < 0.6, `desvío medio xG local < 0.6 (${(dh / n).toFixed(3)})`);
  assert.ok(da / n < 0.6, `desvío medio xG visitante < 0.6 (${(da / n).toFixed(3)})`);
});

// --- §7.4: penales ---

test('§7.4 — con marcador 0-0 ningún penal se convierte (no hay gol que re-etiquetar)', () => {
  let vistos = 0;
  for (let s = 0; s < 400 && vistos < 8; s++) {
    const shots = { home: [], away: [] };
    const out = planPenalties({ home: 0, away: 0 }, shots, { lambdaHome: 1.2, lambdaAway: 1.2 }, rnd('p00' + s));
    if (out.penalties.length === 0) continue;
    vistos += out.penalties.length;
    for (const p of out.penalties) {
      assert.strictEqual(p.converted, false, 'un equipo sin goles no puede convertir');
      assert.strictEqual(p.shot, null);
    }
    // Cada penal fallado suma xG («mereció más»).
    assert.ok(out.xgBonus.home + out.xgBonus.away > 0, 'el penal fallado aporta xG');
  }
  assert.ok(vistos > 0, 'se ejercitó al menos un penal con marcador 0-0');
});

test('§7.4 — un penal convertido RE-ETIQUETA un gol existente y nunca añade uno', () => {
  let convertidos = 0;
  for (let s = 0; s < 400 && convertidos < 10; s++) {
    // Construye un escenario con 2 goles locales ya sorteados.
    const lambdas = { lambdaHome: 1.6, lambdaAway: 0.8 };
    const goals = [{ team: 'home', half: 1, nominal: 20 }, { team: 'home', half: 2, nominal: 70 }];
    const shots = planShots(lambdas, goals, HOME, AWAY, 0.55, rnd('ps' + s));
    const golesAntes = shots.home.filter(x => x.isGoal).length;
    assert.strictEqual(golesAntes, 2, 'dos goles locales planificados');
    const out = planPenalties({ home: 2, away: 0 }, shots, lambdas, rnd('pc' + s));
    const conv = out.penalties.find(p => p.converted && p.team === 'home');
    if (!conv) continue;
    convertidos++;
    // El gol sigue siendo 2: el penal re-etiquetó uno, no añadió otro.
    const golesDespues = shots.home.filter(x => x.isGoal).length;
    assert.strictEqual(golesDespues, golesAntes, 're-etiquetar no cambia el total de goles');
    assert.strictEqual(conv.shot.isPenalty, true, 'el tiro queda marcado como penal');
    assert.strictEqual(conv.shot.xg, Number(PENALTY_XG.toFixed(3)), 'el xG del tiro pasa a ser el del penal');
  }
  assert.ok(convertidos > 0, 'se ejercitó al menos un penal convertido');
});

test('§7.4 — a lo sumo 2 penales por partido', () => {
  for (let s = 0; s < 300; s++) {
    const shots = { home: [], away: [] };
    const out = planPenalties({ home: 1, away: 1 }, shots, { lambdaHome: 1.2, lambdaAway: 1.2 }, rnd('pn' + s));
    assert.ok(out.penalties.length <= 2, `nunca más de 2 penales (${out.penalties.length})`);
  }
});

test('§7.4 — en la línea de tiempo, penalty_scored cuenta como gol y penalty_missed no', () => {
  let conPenal = 0;
  for (let s = 0; s < 400 && conPenal < 5; s++) {
    const r = generateTimeline(HOME, AWAY, ctxBase, rnd('ptl' + s));
    const scored = r.timeline.filter(e => e.type === 'penalty_scored');
    const missed = r.timeline.filter(e => e.type === 'penalty_missed');
    if (scored.length === 0 && missed.length === 0) continue;
    conPenal++;
    // Cada penalty_scored está precedido por un penalty_awarded del mismo equipo.
    for (const ps of scored) {
      const awarded = r.timeline.find(e => e.type === 'penalty_awarded' && e.team === ps.team && Math.abs(e.t - ps.t) < 1.5);
      assert.ok(awarded, 'un penal convertido tuvo su penalty_awarded');
    }
    // La coherencia global ya la garantiza el test R3 (goles == marcador).
    assert.ok(scored.length + missed.length <= 2, 'a lo sumo 2 penales en el timeline');
  }
  assert.ok(conPenal > 0, 'se ejercitó al menos un penal en la línea de tiempo');
});

// --- T7: deriveState sin fuga del futuro ---

test('T7 — deriveState solo refleja eventos hasta el minuto pedido', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('t7'));
  const tl = r.timeline;
  // Puntos de corte: justo antes/después de cada gol y en el descanso.
  const cortes = [0, tl.find(e => e.type === 'halftime').t, r.clock.matchEnd];
  for (const g of tl.filter(e => e.type === 'goal' || e.type === 'penalty_scored')) {
    cortes.push(g.t - 0.01, g.t, g.t + 0.01);
  }
  for (const M of cortes) {
    const { state, revealedIndex } = deriveState(tl, M);
    // revealedIndex es el último evento con t <= M.
    if (revealedIndex >= 0) {
      assert.ok(tl[revealedIndex].t <= M + 1e-9, 'el evento revelado ocurrió');
      if (revealedIndex + 1 < tl.length) assert.ok(tl[revealedIndex + 1].t > M, 'el siguiente aún no ocurre');
    }
    // El marcador derivado == goles con t <= M (nunca los futuros).
    const eh = tl.filter(e => (e.type === 'goal' || e.type === 'penalty_scored') && e.team === 'home' && e.t <= M).length;
    const ea = tl.filter(e => (e.type === 'goal' || e.type === 'penalty_scored') && e.team === 'away' && e.t <= M).length;
    assert.strictEqual(state.score.home, eh, `marcador local sin fuga @${M}`);
    assert.strictEqual(state.score.away, ea, `marcador visitante sin fuga @${M}`);
    assert.ok(state.minute <= M + 1e-9, 'el minuto del estado no excede el corte');
  }
});

test('T7 — deriveState al final reproduce el marcador completo', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('t7fin'));
  const { state, revealedIndex } = deriveState(r.timeline, r.clock.matchEnd + 1000);
  assert.deepStrictEqual(state.score, r.score, 'al final el estado == marcador final');
  assert.strictEqual(revealedIndex, r.timeline.length - 1, 'todo revelado');
});

test('T7 — deriveState acumula tarjetas, tiros y posesión sin mirar adelante', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('t7acc'));
  const M = r.clock.firstHalfEnd; // al descanso
  const { state } = deriveState(r.timeline, M);
  const yellowsH = r.timeline.filter(e => e.type === 'yellow_card' && e.team === 'home' && e.t <= M).length;
  assert.strictEqual(state.cards.home.filter(c => c.type === 'yellow').length, yellowsH);
  assert.ok(state.shots.home >= 0 && state.shots.away >= 0);
  assert.ok(state.possession.home >= 0 && state.possession.home <= 1);
});

test('T7 — la posesión derivada de los tramos es insesgada respecto de stats.possession', () => {
  // Por partido hay ruido de muestreo (los tramos son Bernoulli de la posesión
  // esperada), pero en promedio la posesión que reconstruye deriveState debe
  // coincidir con la que reporta el motor.
  let suma = 0, n = 0;
  for (let s = 0; s < 60; s++) {
    const h = CLUBS[s % 16], a = CLUBS[(s * 3 + 1) % 16];
    if (h.short === a.short) continue;
    const r = generateTimeline(h, a, ctxBase, rnd('poss' + s));
    const fin = deriveState(r.timeline, r.clock.matchEnd + 10).state;
    suma += fin.possession.home - r.stats.possession.home;
    n++;
  }
  assert.ok(Math.abs(suma / n) < 0.05, `desvío medio de posesión < 0.05 (${(suma / n).toFixed(3)})`);
});

// --- Posesión ---

test('computePossession queda acotada y favorece al mejor ataque local', () => {
  const p = computePossession(HOME, AWAY);
  assert.ok(p > 0.32 && p < 0.68, `posesión en rango (${p.toFixed(3)})`);
  const fuerte = { ...HOME, ratings: { ...HOME.ratings, att: 1.3, elo: 1600 } };
  const debil = { ...AWAY, ratings: { ...AWAY.ratings, att: 0.85, elo: 1400 } };
  assert.ok(computePossession(fuerte, debil) > 0.5, 'el local fuerte domina la posesión');
});

// --- §7.5: prórroga y tanda SOLO en el desempate ---

test('§7.5 — un partido normal empatado NO va a prórroga', () => {
  let empates = 0;
  for (let s = 0; s < 400 && empates < 6; s++) {
    const r = generateTimeline(HOME, AWAY, ctxBase, rnd('nodraw' + s)); // esDesempate ausente
    if (r.score.home !== r.score.away) continue;
    empates++;
    const tipos = r.timeline.map(e => e.type);
    assert.ok(!tipos.includes('extra_time_start'), 'sin prórroga fuera del desempate');
    assert.ok(!tipos.includes('shootout_start'), 'sin tanda fuera del desempate');
    assert.ok(!r.shootout, 'sin shootout');
  }
  assert.ok(empates > 0, 'se ejercitó al menos un empate normal');
});

test('§7.5 — el desempate empatado al 90 va a prórroga y, si sigue, a tanda con ganador', () => {
  let prorrogas = 0, tandas = 0;
  for (let s = 0; s < 1500 && (prorrogas < 5 || tandas < 5); s++) {
    const r = generateTimeline(HOME, AWAY, { ...ctxBase, esDesempate: true }, rnd('des' + s));
    const tipos = r.timeline.map(e => e.type);
    if (!tipos.includes('extra_time_start')) continue;
    prorrogas++;
    // La prórroga añade 30' al reloj.
    const etStart = r.timeline.find(e => e.type === 'extra_time_start').t;
    const etEnd = r.timeline.find(e => e.type === 'extra_time_end').t;
    assert.ok(Math.abs((etEnd - etStart) - 30) < 1e-6, 'la prórroga dura 30 minutos');
    // Tiempo monótono e índices coherentes tras añadir prórroga/tanda.
    r.timeline.forEach((e, i) => assert.strictEqual(e.i, i, 'índice tras prórroga'));
    for (let i = 1; i < r.timeline.length; i++) assert.ok(r.timeline[i].t >= r.timeline[i - 1].t, 't monótono con prórroga');

    if (r.shootout) {
      tandas++;
      assert.ok(tipos.includes('shootout_start') && tipos.includes('shootout_end'), 'tanda completa');
      // SIEMPRE hay ganador: los marcadores difieren.
      assert.notStrictEqual(r.shootout.marks.home, r.shootout.marks.away, 'la tanda no queda empatada');
      assert.ok(r.shootout.winner === 'home' || r.shootout.winner === 'away', 'ganador válido');
      assert.ok(r.result.winner === r.shootout.winner, 'result.winner coherente');
      // Los lanzamientos alternan y son al menos la fase inicial (salvo eliminación temprana).
      const kicks = r.timeline.filter(e => e.type === 'shootout_kick');
      assert.ok(kicks.length >= 2, 'hubo lanzamientos');
      assert.ok(kicks.every(k => typeof k.scored === 'boolean'), 'cada lanzamiento dice si entró');
      // La muerte súbita está acotada.
      assert.ok(r.shootout.suddenDeathRounds <= 40, 'muerte súbita acotada');
    }
  }
  assert.ok(prorrogas > 0, 'se ejercitó la prórroga');
  assert.ok(tandas > 0, 'se ejercitó la tanda');
});

test('§7.5 — la tanda respeta la eliminación temprana (no lanza de más)', () => {
  for (let s = 0; s < 1500; s++) {
    const r = generateTimeline(HOME, AWAY, { ...ctxBase, esDesempate: true }, rnd('sd' + s));
    if (!r.shootout) continue;
    const kicks = r.timeline.filter(e => e.type === 'shootout_kick');
    const iniciales = kicks.filter(k => !k.suddenDeath).length;
    // En la fase inicial se lanzan <= 2·SHOOTOUT_INITIAL (10) tiros.
    assert.ok(iniciales <= 2 * SHOOTOUT_INITIAL, 'la fase inicial no excede 10 tiros');
    // Si terminó antes de los 10 iniciales, es porque uno ya no podía ser alcanzado.
    if (iniciales < 2 * SHOOTOUT_INITIAL) {
      assert.notStrictEqual(r.shootout.marks.home, r.shootout.marks.away, 'terminó temprano por diferencia insalvable');
      assert.strictEqual(r.shootout.suddenDeathRounds, 0, 'sin muerte súbita si ya había ganador');
    }
    break; // basta con validar la estructura en el primer desempate con tanda
  }
});

// --- Rendimiento (§7.6) ---

test('§7.6 — genera un partido muy por debajo de 8 ms', () => {
  const N = 300;
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < N; s++) {
    generateTimeline(CLUBS[s % 16], CLUBS[(s * 3 + 1) % 16], ctxBase, rnd('perf' + s));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(ms < 8, `promedio ${ms.toFixed(3)} ms/partido < 8 ms`);
});
