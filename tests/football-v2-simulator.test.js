'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const simulator = require('../lib/football/v2/simulator');
const { createMatch, FIELD, STEP, END, MAX_END, MAX_PLAYER_SPEED, MAX_BALL_SPEED, CONTROL_RADIUS, PASS_RANGE, distance, inPenaltyArea } = simulator;
const EPS = 1e-7;

function finish(match) {
  while (!match.snapshot().ended) match.step(1000);
  return { state: match.snapshot(), events: match.eventsAfter(-1) };
}

const fixture = {
  home: { id: 'local', name: 'Local', short: 'LOC', formation: '4-3-3' },
  away: { id: 'visita', name: 'Visita', short: 'VIS', formation: '3-5-2' }
};

test('simulador V2 es determinista, versionado y reproduce el mismo prefijo y final', () => {
  const left = createMatch({ ...fixture, seed: 123456 });
  const right = createMatch({ ...fixture, seed: 123456 });
  for (const n of [1, 40, 701, 20, 3000]) {
    assert.deepEqual(left.step(n), right.step(n));
    assert.deepEqual(left.eventsAfter(-1), right.eventsAfter(-1));
  }
  const a = finish(left), b = finish(right);
  assert.deepEqual(a, b);
  assert.equal(a.state.version, simulator.VERSION);
  assert.equal(a.state.time, (90 + a.state.clock.s1 + a.state.clock.s2) * 60);
  assert.ok(a.state.time > END && a.state.time <= MAX_END);
  assert.equal(a.events.filter(event => event.type === 'full_time').length, 1);
  assert.equal(a.events.at(-1).type, 'full_time');
  const different = createMatch({ ...fixture, seed: 123457 });
  different.step(1000);
  assert.notDeepEqual(different.snapshot().players, createMatch({ ...fixture, seed: 123456 }).step(1000).players);
});

test('intercepciones requieren coincidir en posición y tiempo, no solo cruzar una trayectoria', () => {
  const { movingContact } = simulator;
  const ballFrom = { x: 0, y: 0 }, ballTo = { x: 10, y: 0 };
  // El defensor termina sobre la línea del pase, pero llega después del balón.
  assert.equal(movingContact(ballFrom, ballTo, { x: 5, y: 5 }, { x: 5, y: 0 }, 1, 0.5), null);
  // Esta vez ambos se acercan simultáneamente: el contacto sucede dentro del paso.
  const hit = movingContact(ballFrom, ballTo, { x: 5, y: -5 }, { x: 5, y: 5 }, 1, 0.5);
  assert.ok(hit && hit.fraction > 0 && hit.fraction < 1);
  assert.ok(distance(hit.ball, hit.player) <= 0.5 + EPS);
  // Si el balón llega al final a mitad del paso, no se concede el resto del
  // tiempo de movimiento del defensor para interceptar antes de la llegada.
  assert.equal(movingContact(ballFrom, ballTo, { x: 5, y: -5 }, { x: 5, y: 5 }, 0.5, 0.5), null);
});

test('las instantáneas y eventos son copias y no permiten cambiar el mundo simulado', () => {
  const match = createMatch({ seed: 1 });
  const initial = match.snapshot();
  initial.players[0].x = 5000;
  initial.teams.home.name = 'cambiado';
  initial.score.home = 99;
  const event = match.eventsAfter(-1)[0];
  event.position.x = 9000;
  assert.notEqual(match.snapshot().players[0].x, 5000);
  assert.notEqual(match.snapshot().teams.home.name, 'cambiado');
  assert.equal(match.snapshot().score.home, 0);
  assert.notEqual(match.eventsAfter(-1)[0].position.x, 9000);
  assert.deepEqual(match.eventsAfter(0), []);
});

test('11 contra 11, continuidad espacial, porteros en zona y marcador derivado de goles', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const match = createMatch({ seed });
    let previous = match.snapshot();
    let count = 0;
    while (!previous.ended) {
      const next = match.step();
      const events = match.eventsAfter(previous.lastEventId);
      assert.equal(next.players.length, 22);
      for (const side of ['home', 'away']) {
        assert.equal(next.players.filter(player => player.side === side).length, 11);
        assert.equal(next.players.filter(player => player.side === side && player.role === 'GK').length, 1);
        assert.equal(next.score[side] - previous.score[side], events.filter(e => e.type === 'goal' && e.team === side).length);
        assert.ok(next.stats[side].shotsOnTarget <= next.stats[side].shots);
        assert.ok(next.stats[side].completedPasses <= next.stats[side].passes);
      }
      assert.equal(new Set(next.players.map(player => player.id)).size, 22);
      for (let i = 0; i < next.players.length; i++) {
        const player = next.players[i];
        if (player.id !== previous.players[i].id) {
          assert.ok(events.some(event => event.type === 'substitution' && event.playerInId === player.id
            && event.playerOutId === previous.players[i].id), 'cambio autorizado con balón detenido');
        }
        assert.ok(Number.isFinite(player.x) && Number.isFinite(player.y));
        assert.ok(player.x >= 0 && player.x <= FIELD.length && player.y >= 0 && player.y <= FIELD.width);
        assert.ok(distance(previous.players[i], player) <= MAX_PLAYER_SPEED * STEP + EPS, `seed ${seed}, tiempo ${next.time}, jugador ${player.id}`);
        if (next.phase === 'play' && player.role === 'GK') {
          const direction = next.directions[player.side];
          assert.ok(direction === 1 ? player.x >= 1 - EPS && player.x <= 15.5 + EPS : player.x >= 89.5 - EPS && player.x <= 104 + EPS);
          assert.ok(player.y >= (FIELD.width - FIELD.penaltyWidth) / 2 - EPS && player.y <= (FIELD.width + FIELD.penaltyWidth) / 2 + EPS);
        }
      }
      assert.ok(Number.isFinite(next.ball.x) && Number.isFinite(next.ball.y));
      assert.ok(next.ball.x >= 0 && next.ball.x <= FIELD.length && next.ball.y >= 0 && next.ball.y <= FIELD.width);
      assert.ok(distance(previous.ball, next.ball) <= MAX_BALL_SPEED * STEP + EPS, `balón seed ${seed}, tiempo ${next.time}`);
      if (next.ball.carrierId) {
        const carrier = next.players.find(player => player.id === next.ball.carrierId);
        assert.ok(carrier, 'existe el portador');
        assert.equal(carrier.side, next.possessionTeam);
        assert.ok(distance(carrier, next.ball) <= CONTROL_RADIUS + EPS);
      }
      previous = next;
      assert.ok(++count <= MAX_END / STEP, 'el reloj siempre llega al final');
    }
  }
});

test('pases, contactos, faltas, córners, penales y goles conservan una causa física', () => {
  const coverage = { passes: 0, contacts: 0, goals: 0, corners: 0, penalties: 0, penaltyShots: 0 };
  for (let seed = 1; seed <= 8; seed++) {
    const { state, events } = finish(createMatch({ seed }));
    const passes = new Map(), shots = new Map(), fouls = new Map(), restarts = new Map();
    let running = { home: 0, away: 0 };
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (i) assert.ok(event.time >= events[i - 1].time, 'eventos en orden');
      if (event.type === 'pass') {
        coverage.passes++;
        assert.ok(distance(event.from, event.receiverPosition) <= PASS_RANGE + EPS);
        assert.ok(event.playerId.startsWith(`${event.team}-`) && event.receiverId.startsWith(`${event.team}-`));
        assert.notEqual(event.playerId, event.receiverId);
        passes.set(event.sequence, event);
      }
      if (event.type === 'shot') {
        shots.set(event.sequence, event);
        assert.ok(event.playerId.startsWith(`${event.team}-`));
        if (event.penalty) {
          coverage.penaltyShots++;
          const restart = restarts.get(event.restartId);
          assert.ok(restart && restart.restartType === 'penalty');
          assert.equal(restart.team, event.team);
          assert.equal(restart.causeSequence, event.causeSequence);
          assert.ok(fouls.has(event.causeSequence));
          assert.ok(Math.abs(event.from.x - (event.from.x < FIELD.length / 2 ? 11 : FIELD.length - 11)) < CONTROL_RADIUS + EPS);
        }
      }
      if (['reception', 'interception', 'save', 'block'].includes(event.type)) {
        coverage.contacts++;
        assert.ok(event.playerPosition && event.contactPosition);
        assert.ok(distance(event.playerPosition, event.contactPosition) <= (event.type === 'save' ? 2.3 : CONTROL_RADIUS) + EPS);
        const source = event.type === 'reception' || event.type === 'interception' ? passes.get(event.sequence) : shots.get(event.sequence);
        assert.ok(source && source.time < event.time, `${event.type} debe tener una acción previa`);
      }
      if (event.type === 'tackle' || event.type === 'foul') assert.ok(event.separation <= 1.6 + EPS);
      if (event.type === 'keeper_claim') assert.ok(event.separation <= 2.1 + EPS);
      if (event.type === 'foul') fouls.set(event.sequence, event);
      if (event.type === 'restart') restarts.set(event.restartId, event);
      if (event.type === 'penalty_awarded') {
        coverage.penalties++;
        const foul = fouls.get(event.causeSequence);
        assert.ok(foul && foul.team !== event.team);
        assert.deepEqual(foul.position, event.position);
        const dir = event.team === 'home' ? (event.half === 1 ? 1 : -1) : (event.half === 1 ? -1 : 1);
        assert.ok(inPenaltyArea(foul.position, dir));
        assert.ok(event.restartId);
      }
      if (event.type === 'corner') {
        coverage.corners++;
        const out = events[i - 1];
        assert.equal(out.type, 'ball_out');
        assert.notEqual(out.team, event.team);
        assert.ok(out.line === 'left' || out.line === 'right');
        assert.equal(out.sequence, event.causeSequence);
        assert.ok(event.restartId);
      }
      if (event.type === 'goal') {
        coverage.goals++;
        const shot = shots.get(event.sequence);
        assert.ok(shot && shot.team === event.team && shot.time < event.time);
        assert.equal(shot.playerId, event.playerId);
        assert.ok(event.position.x === 0 || event.position.x === FIELD.length);
        assert.ok(Math.abs(event.position.y - FIELD.width / 2) <= FIELD.goalWidth / 2 + EPS);
        running = { ...running, [event.team]: running[event.team] + 1 };
        assert.deepEqual(event.score, running);
      }
    }
    assert.deepEqual(state.score, running);
    assert.deepEqual(events.filter(e => e.type === 'halftime').length, 1);
    assert.deepEqual(events.filter(e => e.type === 'second_half').length, 1);
  }
  for (const [kind, count] of Object.entries(coverage)) assert.ok(count > 0, `el corpus debe ejercitar ${kind}`);
});

test('el corpus exploratorio evita partidos bloqueados o marcadores sistemáticamente desbocados', () => {
  const totals = { home: 0, away: 0, shots: 0, passes: 0, completed: 0 };
  const size = 24;
  for (let seed = 1; seed <= size; seed++) {
    const { state } = finish(createMatch({ seed }));
    totals.home += state.score.home; totals.away += state.score.away;
    for (const side of ['home', 'away']) {
      totals.shots += state.stats[side].shots;
      totals.passes += state.stats[side].passes;
      totals.completed += state.stats[side].completedPasses;
    }
  }
  // Son límites de humo deliberadamente amplios, NO una calibración de cuotas.
  assert.ok(totals.shots / size > 8 && totals.shots / size < 60);
  assert.ok((totals.home + totals.away) / size > 0.5 && (totals.home + totals.away) / size < 7);
  assert.ok(totals.completed / totals.passes > 0.5 && totals.completed / totals.passes < 0.97);
  assert.ok(totals.home > totals.away * 0.25 && totals.away > totals.home * 0.25);
});

test('un 0–0 es un partido válido que termina sin reintentar ni retrasar', () => {
  const match = createMatch({ seed: 14 });
  const { state, events } = finish(match);
  assert.deepEqual(state.score, { home: 0, away: 0 });
  assert.equal(state.time, state.clock.matchEnd * 60);
  assert.equal(events.filter(event => event.type === 'goal').length, 0);
  assert.equal(events.at(-1).type, 'full_time');
  assert.deepEqual(match.step(1000), state);
});
