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
const { normalizeTransitions } = require('../lib/football/match-state');
const { buildSeasonClubs } = require('../lib/football/teams');
const {
  RHO, PENALTY_XG, SHOOTOUT_INITIAL,
  poissonPmf, dcTau, scoreMatrix, sampleScore, samplePoisson,
  computePossession, planPenalties, planShots,
  generateTimeline, generateShootout, deriveState
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
  assert.strictEqual(poissonPmf(0, 0), 1, 'λ=0 concentra toda la masa en cero goles');
  assert.strictEqual(poissonPmf(1, 0), 0);
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
    assert.ok(e.ball && Number.isFinite(e.ball.x) && e.ball.x >= -0.01 && e.ball.x <= 1.01, 'ball.x en [-0.01,1.01]');
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

test('estado autoritativo — alineación, portador y balón parten del saque inicial', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('authoritative-state'));
  const kickoff = r.timeline[0];
  const { state, revealedIndex } = deriveState(r.timeline, 0);
  assert.equal(kickoff.type, 'kickoff');
  assert.deepEqual(kickoff.ball, { x: 0.5, y: 0.5 });
  assert.ok(kickoff.playerId, 'el saque tiene un jugador identificado');
  assert.equal(state.ballCarrierId, kickoff.playerId);
  assert.equal(state.ball.carrierId, kickoff.playerId);
  assert.equal(state.possessionTeam, 'home');
  assert.equal(revealedIndex, kickoff.i);
  assert.equal(state.players.filter(player => player.active && player.team === 'home').length, 11);
  assert.equal(state.players.filter(player => player.active && player.team === 'away').length, 11);
  assert.ok(state.players.filter(player => player.active).every(player => player.x >= 0 && player.x <= 1 && player.y >= 0 && player.y <= 1));
  assert.equal(r.lineups.home.players.length, HOME.squad.length);
});

test('límites de período — no hay saque tras el silbatazo ni reinicio de centro en la tanda', () => {
  const timeline = normalizeTransitions([
    { t: 10, type: 'goal', team: 'home', half: 1 },
    { t: 47.99, type: 'goal', team: 'away', half: 1 },
    { t: 48, type: 'halftime', team: null, half: 1 },
    { t: 48, type: 'second_half', team: 'away', half: 2 },
    { t: 94.99, type: 'goal', team: 'home', half: 2 },
    { t: 95, type: 'full_time', team: null, half: 2 },
    { t: 100, type: 'penalty_scored', team: 'home', half: 4, sequenceId: 'shootout-kick-1' },
    { t: 101, type: 'shootout_end', team: 'home', half: 4 }
  ], { firstHalfEnd: 48, matchEnd: 95, shootoutEnd: 101 });
  const restarts = timeline.filter(event => event.type === 'goal_restart');
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].t, 10.22);
  assert.ok(!timeline.some(event => event.type === 'goal_restart' && (event.t >= 48 || event.half === 4)));
});

test('normalización — las acciones relacionadas permanecen juntas frente a pausas superpuestas', () => {
  const timeline = normalizeTransitions([
    { t: 10, type: 'goal', team: 'home', half: 1 },
    { t: 10.1, type: 'foul', team: 'away', half: 1, sequenceId: 'card-seq' },
    { t: 10.1, type: 'yellow_card', team: 'away', half: 1, sequenceId: 'card-seq' },
    { t: 10.11, type: 'foul', team: 'home', half: 1, sequenceId: 'overlapping-foul' },
    { t: 20, type: 'penalty_awarded', team: 'home', half: 1, sequenceId: 'penalty-seq' },
    { t: 20.4, type: 'penalty_scored', team: 'home', half: 1, sequenceId: 'penalty-seq' },
    { t: 20.2, type: 'substitution', team: 'away', half: 1, sequenceId: 'penalty-overlap-sub' },
    { t: 30, type: 'shot_on_target', team: 'home', half: 1, sequenceId: 'shot-seq' },
    { t: 30.05, type: 'save', team: 'away', half: 1, sequenceId: 'shot-seq' },
    { t: 30.02, type: 'substitution', team: 'away', half: 1, sequenceId: 'shot-overlap-sub' },
    { t: 40, type: 'shot', team: 'home', half: 1, sequenceId: 'wide-seq', outcome: 'wide' },
    { t: 40.16, type: 'goal_kick', team: 'away', half: 1, sequenceId: 'goal_kick_wide-seq' },
    { t: 40.02, type: 'pass_sequence', team: 'away', half: 1 }
  ], { firstHalfEnd: 45, matchEnd: 90 });
  const bySequence = (sequenceId, type) => timeline.find(event => event.sequenceId === sequenceId && event.type === type);

  const cardFoul = bySequence('card-seq', 'foul');
  const card = bySequence('card-seq', 'yellow_card');
  assert.equal(card.t, cardFoul.t, 'la tarjeta sigue a la falta aunque otra pausa ocurra en medio');
  assert.ok(card.t >= timeline.find(event => event.type === 'goal_restart').t, 'el incidente espera al saque tras el gol');

  const awarded = bySequence('penalty-seq', 'penalty_awarded');
  const scored = bySequence('penalty-seq', 'penalty_scored');
  assert.equal(Number((scored.t - awarded.t).toFixed(2)), 0.4, 'el resultado conserva la duración del penal');
  assert.ok(bySequence('penalty-overlap-sub', 'substitution').t > scored.t, 'ningún cambio interrumpe la ejecución del penal');

  const shot = bySequence('shot-seq', 'shot_on_target');
  const save = bySequence('shot-seq', 'save');
  assert.equal(Number((save.t - shot.t).toFixed(2)), 0.05, 'la atajada conserva su posición relativa al remate');
  assert.ok(bySequence('shot-overlap-sub', 'substitution').t > save.t, 'un cambio no se intercala entre remate y atajada');

  const wideShot = bySequence('wide-seq', 'shot');
  const goalKick = bySequence('goal_kick_wide-seq', 'goal_kick');
  assert.ok(timeline.find(event => event.type === 'pass_sequence').t > goalKick.t,
    'no hay una acción de juego entre el tiro desviado y su saque de meta');
  assert.ok(goalKick.t > wideShot.t);
});

test('identificadores — dos remates del mismo minuto conservan secuencias independientes', () => {
  const r = generateTimeline(CLUBS[2], CLUBS[13], ctxBase, rnd('seq-collision-2'));
  const shots = r.timeline.filter(event => ['shot', 'big_chance', 'shot_on_target'].includes(event.type));
  const ids = shots.map(event => event.sequenceId);
  assert.ok(ids.every(Boolean), 'cada remate recibe un id de secuencia');
  assert.equal(new Set(ids).size, ids.length, 'los ids no dependen de minutos redondeados y no colisionan');
  for (const shot of shots.filter(event => event.outcome === 'wide')) {
    assert.ok(r.timeline.some(event => event.type === 'goal_kick' && event.sequenceId === `goal_kick_${shot.sequenceId}`),
      'el saque de meta corresponde al remate que salió');
  }
});

test('transiciones — goles, tiros atajados y balón parado tienen reinicio coherente', () => {
  let sawGoal = false, sawSetPiece = false, sawSave = false, sawWide = false;
  for (let seed = 0; seed < 32; seed++) {
    const r = generateTimeline(CLUBS[seed % 16], CLUBS[(seed * 5 + 3) % 16], ctxBase, rnd('transitions-' + seed));
    const tl = r.timeline;
    for (const goal of tl.filter(event => event.type === 'goal' || event.type === 'penalty_scored')) {
      assert.equal(goal.ball.x, goal.team === 'home' ? 1.01 : -0.01, 'el gol entra en la red');
      const restart = tl.find(event => event.type === 'goal_restart' && event.t >= goal.t && event.team !== goal.team);
      if (restart) {
        sawGoal = true;
        assert.ok(restart.t >= goal.t, 'el saque de centro no precede al gol');
        assert.deepEqual(restart.ball, { x: 0.5, y: 0.5 });
        assert.deepEqual(restart.ballFrom, { x: 0.5, y: 0.5 }, 'el saque de centro comienza en el círculo, no vuela desde la portería');
        assert.ok(restart.playerId, 'el saque de centro tiene ejecutor');
      }
    }
    for (const stop of tl.filter(event => ['foul', 'offside', 'corner', 'throw_in', 'goal_kick'].includes(event.type))) {
      const restart = tl.find(event => event.type === 'restart' && event.restartFor === stop.sequenceId);
      if (restart) {
        sawSetPiece = true;
        assert.ok(restart.t >= stop.t && restart.t - stop.t <= 0.081, 'el reinicio sigue a la interrupción');
        assert.equal(restart.team, stop.beneficiaryTeam || stop.team);
        assert.ok(restart.playerId, 'el reinicio asigna ejecutor');
      }
    }
    for (const sub of tl.filter(event => event.type === 'substitution')) {
      const restart = tl.find(event => event.type === 'restart' && event.restartFor === sub.sequenceId);
      assert.ok(restart, 'la sustitución se reanuda con una acción explícita');
      assert.ok(restart.t > sub.t && restart.t - sub.t <= 0.081);
      const { state } = deriveState(tl, sub.t, r.lineups, sub.i);
      assert.equal(state.playStopped, true);
      const outgoing = state.players.find(player => player.id === sub.playerOutId);
      const incoming = state.players.find(player => player.id === sub.playerInId);
      assert.equal(outgoing.status, 'substituted');
      assert.equal(incoming.status, 'active');
      assert.equal(incoming.slotIndex, outgoing.slotIndex);
      assert.equal(incoming.role, outgoing.role);
    }
    for (const shot of tl.filter(event => ['shot', 'big_chance'].includes(event.type) && event.outcome === 'wide')) {
      sawWide = true;
      assert.equal(shot.phase, 'set_piece', 'el balón queda detenido cuando el tiro sale');
      assert.equal(shot.crossedGoalLine, true);
      assert.ok(tl.some(event => event.type === 'goal_kick' && event.sequenceId === `goal_kick_${shot.sequenceId}`), 'el tiro desviado termina en saque de meta');
    }
    for (const pass of tl.filter(event => event.type === 'pass_sequence')) {
      assert.ok(pass.actorPosition, 'el pase tiene un jugador ejecutor visible');
      assert.deepEqual(pass.ballFrom, pass.actorPosition, 'el balón sale del jugador que lo controla');
    }
    for (const shot of tl.filter(event => event.type === 'shot_on_target')) {
      const save = tl.find(event => event.type === 'save' && event.sequenceId === shot.sequenceId);
      assert.equal(Boolean(save), Boolean(shot.saved), 'la atajada coincide con el resultado del tiro');
      if (save) {
        sawSave = true;
        assert.equal(save.team, shot.team === 'home' ? 'away' : 'home');
        assert.equal(save.playerId, shot.keeperId);
        assert.equal(save.keeperId, shot.keeperId, 'la identidad del guardameta coincide en toda la secuencia');
        const recovered = deriveState(tl, save.t, r.lineups, save.i).state;
        assert.equal(recovered.phase, 'build_up', 'el guardameta que controla el balón pasa a salida, no sigue en peligro');
        assert.equal(recovered.possessionTeam, save.team, 'la posesión pasa al equipo del guardameta');
        assert.equal(recovered.ballCarrierId, save.playerId, 'el guardameta queda identificado como portador');
      }
    }
  }
  assert.ok(sawGoal, 'se ejercitó un gol con saque de centro');
  assert.ok(sawSetPiece, 'se ejercitó al menos un reinicio a balón parado');
  assert.ok(sawSave, 'se ejercitó al menos una atajada');
  assert.ok(sawWide, 'se ejercitó un tiro fuera y su saque de meta');
});

test('disciplina — una expulsión retira al jugador de las acciones posteriores', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('red-card-2'));
  const red = r.timeline.find(event => event.type === 'red_card' || event.type === 'second_yellow');
  assert.ok(red, 'la semilla fija debe contener una expulsión');
  const references = event => [event.playerId, event.receiverId, event.assistId, event.keeperId, event.victimId, event.fouledId, event.foulerId, event.shooterId];
  assert.ok(!r.timeline.some(event => event.i > red.i && references(event).includes(red.playerId)), 'el expulsado no reaparece como participante');
  assert.ok(!r.timeline.some(event => event.type === 'substitution' && event.playerOutId === red.playerId && event.i > red.i), 'no se sustituye a un expulsado');
  const { state } = deriveState(r.timeline, red.t, r.lineups);
  assert.equal(state.redCards[red.team], 1);
  assert.equal(state.players.filter(player => player.active && player.team === red.team).length, 10);
});

test('acciones — todos los participantes siguen activos y pertenecen al partido', () => {
  for (let seed = 0; seed < 24; seed++) {
    const home = CLUBS[seed % 16], away = CLUBS[(seed * 5 + 3) % 16];
    const { timeline, lineups } = generateTimeline(home, away, ctxBase, rnd('active-roster-' + seed));
    const playerTeam = new Map([
      ...lineups.home.players.map(player => [player.id, 'home']),
      ...lineups.away.players.map(player => [player.id, 'away'])
    ]);
    const status = {
      home: new Map(lineups.home.players.map(player => [player.id, player.initialStatus])),
      away: new Map(lineups.away.players.map(player => [player.id, player.initialStatus]))
    };
    for (const event of timeline) {
      if (event.type === 'substitution') {
        assert.equal(status[event.team].get(event.playerOutId), 'active', 'sale un titular activo');
        assert.equal(status[event.team].get(event.playerInId), 'bench', 'entra un suplente');
        status[event.team].set(event.playerOutId, 'substituted');
        status[event.team].set(event.playerInId, 'active');
      }
      for (const [field, id] of Object.entries({
        playerId: event.playerId, receiverId: event.receiverId, assistId: event.assistId,
        keeperId: event.keeperId, victimId: event.victimId, fouledId: event.fouledId,
        foulerId: event.foulerId, shooterId: event.shooterId
      })) {
        if (!id) continue;
        const team = playerTeam.get(id);
        assert.ok(team, `${field} siempre pertenece a una alineación (${event.type})`);
        assert.equal(status[team].get(id), 'active', `${field} pertenece a alguien en cancha (${event.type})`);
      }
      if (event.ballCarrierId) {
        const carrierTeam = playerTeam.get(event.ballCarrierId);
        assert.equal(status[carrierTeam].get(event.ballCarrierId), 'active', 'el portador no está en la banca ni expulsado');
        assert.equal(event.possessionTeam, carrierTeam, 'portador y posesión coinciden');
      }
      if (event.type === 'red_card' || event.type === 'second_yellow') status[event.team].set(event.playerId, 'sent_off');
    }
  }
});

test('penal atajado — el guardameta controla el balón, suma la falta y el juego se reanuda', () => {
  const r = generateTimeline(HOME, AWAY, ctxBase, rnd('pen-save-7'));
  const missed = r.timeline.find(event => event.type === 'penalty_missed' && event.outcome === 'saved');
  assert.ok(missed, 'la semilla fija debe contener un penal atajado');
  const { state } = deriveState(r.timeline, missed.t, r.lineups);
  assert.equal(state.phase, 'build_up');
  assert.equal(state.playStopped, false);
  assert.equal(state.possessionTeam, missed.team === 'home' ? 'away' : 'home');
  assert.equal(state.ballCarrierId, missed.keeperId);

  const award = r.timeline.find(event => event.type === 'penalty_awarded' && event.sequenceId === missed.sequenceId);
  assert.ok(award, 'el penal fallado tiene una infracción previa');
  const before = deriveState(r.timeline, award.t, r.lineups, award.i - 1).state;
  const after = deriveState(r.timeline, award.t, r.lineups, award.i).state;
  const defending = award.team === 'home' ? 'away' : 'home';
  assert.equal(after.fouls[defending], before.fouls[defending] + 1, 'la infracción del penal suma al equipo que la cometió');
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
      const shootoutStart = r.timeline.find(event => event.type === 'shootout_start').t;
      const breakState = deriveState(r.timeline, (etEnd + shootoutStart) / 2, r.lineups).state;
      assert.equal(breakState.phase, 'halftime', 'el descanso antes de la tanda no se anuncia como final');
      assert.equal(breakState.playStopped, true, 'no se reabren acciones durante el descanso');
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

test('§7.5 — el tope de la muerte súbita nunca deja el ganador empatado', () => {
  const base = generateTimeline(HOME, AWAY, ctxBase, rnd('shootout-guard-base'));
  const result = generateShootout(base, HOME, AWAY, () => 0.99, base.clock.matchEnd);
  assert.notStrictEqual(result.shootout.marks.home, result.shootout.marks.away);
  assert.equal(result.shootout.winner, result.shootout.marks.home > result.shootout.marks.away ? 'home' : 'away');
  assert.equal(result.shootout.suddenDeathRounds, 40, 'la secuencia adversa alcanza el tope antes del desempate forzado');
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
