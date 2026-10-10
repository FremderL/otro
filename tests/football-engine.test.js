'use strict';

// Fase C — Pruebas del motor de ejecución y el scheduler (§15).
// Aceptación: T5 (catch-up anti-inactividad), T6 (recuperación desde seed+now),
// T13 (watchdog auto-repara un partido atascado) y T14 (cuarentena aísla sin
// tocar a los demás).

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FootballStore } = require('../lib/football-store');
const { FootballEngine, matchClock, phaseToStatus } = require('../lib/football/engine');
const { FootballScheduler } = require('../lib/football/scheduler');

const SEASON = '2026-10';
const T0 = Date.UTC(2026, 9, 10, 18, 0, 0); // ancla controlada (mediodía en CDMX)
const MS_MIN = 10000;                        // 10 s reales por minuto simulado
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-engine-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* mejor esfuerzo */ } });

let n = 0;
function freshStore() {
  const filePath = path.join(TMP, `store-${n++}.json`);
  const store = new FootballStore(filePath);
  store.generateSeason(SEASON);
  return { store, filePath };
}

// Deja UN partido con kickoff en T0 (día 10) y empuja los demás a un futuro
// lejano fuera de hoy, para que ningún barrido los toque.
function isolate(store, index = 0) {
  const matches = store.getMatches();
  const m = matches[index];
  m.scheduledKickoffAt = T0;
  m.day = 10;
  for (const other of matches) {
    if (other === m) continue;
    other.scheduledKickoffAt = T0 + 100 * 86400000;
    other.day = 25;
  }
  return m;
}

function collect(engine) {
  const bag = { events: [], goals: [], statuses: [], ticks: 0, tickPayloads: [], logs: [] };
  engine.on('football:event', p => bag.events.push(p.event.i));
  engine.on('football:goal', p => bag.goals.push(p.event.i));
  engine.on('football:status', p => bag.statuses.push(p.code));
  engine.on('football:tick', p => { bag.ticks++; bag.tickPayloads.push(p); });
  const origLog = engine.logEvent;
  engine.logEvent = (type, data) => { bag.logs.push({ type, data }); origLog(type, data); };
  return bag;
}

// --- Reloj de simulación (§3.2) ---

test('matchClock traduce tiempo real a minuto simulado y pausa en el intermedio', () => {
  const clock = { s1: 2, s2: 3, firstHalfEnd: 47, matchEnd: 95 };
  const opts = { secondsPerMinute: 10, halftimeMs: 45000 };
  assert.deepStrictEqual(matchClock(T0 - 1, T0, clock, opts), { minute: 0, phase: 'pre', ended: false });
  const first = matchClock(T0 + 10 * MS_MIN, T0, clock, opts);
  assert.ok(Math.abs(first.minute - 10) < 1e-9 && first.phase === 'first_half');
  const half = matchClock(T0 + 47 * MS_MIN + 10000, T0, clock, opts);
  assert.strictEqual(half.phase, 'halftime');
  assert.strictEqual(half.minute, 47); // reloj pausado durante el intermedio
  const second = matchClock(T0 + 47 * MS_MIN + 45000 + 10 * MS_MIN, T0, clock, opts);
  assert.strictEqual(second.phase, 'second_half');
  assert.ok(Math.abs(second.minute - 57) < 1e-9);
  const end = matchClock(T0 + 47 * MS_MIN + 45000 + 60 * MS_MIN, T0, clock, opts);
  assert.strictEqual(end.phase, 'ended');
  assert.strictEqual(end.ended, true);
  assert.strictEqual(end.minute, 95); // nunca pasa del final
});

test('phaseToStatus mapea fases a estados válidos', () => {
  assert.strictEqual(phaseToStatus('pre'), null);
  assert.strictEqual(phaseToStatus('first_half'), 'live');
  assert.strictEqual(phaseToStatus('halftime'), 'halftime');
  assert.strictEqual(phaseToStatus('second_half'), 'live');
  assert.strictEqual(phaseToStatus('extra_time'), 'extra_time');
  assert.strictEqual(phaseToStatus('shootout'), 'shootout');
  assert.strictEqual(phaseToStatus('ended'), 'finished');
});

test('T7 — kickoff y segundo tiempo no se revelan antes de su fase de reloj', () => {
  const { store } = freshStore();
  const m = isolate(store);
  const engine = new FootballEngine(store, { secondsPerMinute: 10, halftimeMs: 45000 });
  const bag = collect(engine);
  const timeline = engine._ensureTimeline(m).timeline;
  const halftime = timeline.find(event => event.type === 'halftime');
  const secondHalf = timeline.find(event => event.type === 'second_half');

  const pre = engine.deriveMatchState(m, T0 - 1);
  assert.equal(pre.revealedIndex, -1, 'antes del kickoff no se revela el evento t=0');

  engine.startMatch(m, T0);
  const atHalf = T0 + halftime.t * MS_MIN + 1;
  const halftimeState = engine.advance(m, atHalf);
  assert.equal(halftimeState.phase, 'halftime');
  assert.equal(halftimeState.state.phase, 'halftime');
  assert.equal(halftimeState.revealedIndex, halftime.i);
  assert.ok(!bag.events.includes(secondHalf.i), 'el saque del segundo tiempo espera al fin del descanso');

  const afterBreak = T0 + halftime.t * MS_MIN + 45000 + 1;
  const resumed = engine.advance(m, afterBreak);
  assert.equal(resumed.phase, 'second_half');
  assert.ok(resumed.revealedIndex >= secondHalf.i);
  assert.ok(bag.events.includes(secondHalf.i), 'el segundo tiempo se revela al reanudar el reloj');
});

// --- Ciclo de vida ---

test('un partido arranca, revela eventos y se asienta con el marcador del seed', () => {
  const { store } = freshStore();
  const m = isolate(store);
  const engine = new FootballEngine(store);
  const bag = collect(engine);

  assert.strictEqual(engine.startMatch(m, T0 - 1000), false, 'no arranca antes de hora');
  assert.strictEqual(m.status, 'scheduled');
  assert.strictEqual(engine.startMatch(m, T0), true);
  assert.strictEqual(m.status, 'live');
  assert.ok(bag.statuses.includes('kickoff'));

  // Avanza hasta bien pasado el final (~16.6 min reales).
  const end = T0 + 1100000;
  engine.advance(m, T0 + 300000);
  engine.advance(m, end);
  assert.strictEqual(m.status, 'settled', 'termina asentado');
  assert.ok(m.result && Number.isInteger(m.result.home) && Number.isInteger(m.result.away), 'resultado entero registrado');
  assert.ok(bag.statuses.includes('full_time'), 'emite el final');
  assert.ok(bag.events.length > 40, 'reveló la línea de tiempo');
  assert.ok(bag.tickPayloads.length > 0 && bag.tickPayloads.every(tick => tick.matchEnd === engine._ensureTimeline(m).clock.matchEnd), 'el tick interno lleva el límite real para calcular cuotas sin derivar de nuevo');
  assert.ok(bag.goals.length === m.result.home + m.result.away, 'los goles emitidos cuadran con el marcador');
});

test('advance es idempotente: un barrido duplicado no re-emite ni corrompe (§15.1)', () => {
  const { store } = freshStore();
  const m = isolate(store);
  const engine = new FootballEngine(store);
  const bag = collect(engine);
  engine.startMatch(m, T0);
  const now = T0 + 300000;
  const first = engine.advance(m, now);
  const emittedAfterFirst = bag.events.length;
  const second = engine.advance(m, now); // mismo now: barrido duplicado
  assert.strictEqual(bag.events.length, emittedAfterFirst, 'no re-emite eventos ya revelados');
  assert.strictEqual(second.revealedIndex, first.revealedIndex);
  assert.deepStrictEqual(second.state.score, first.state.score);
});

// --- T5: catch-up (la propiedad anti-inactividad) ---

test('T5 — pausar y reanudar produce el mismo estado que correr sin pausa', () => {
  // Camino A: barridos continuos cada 60 s hasta T0+300000.
  const a = freshStore(); const mA = isolate(a.store);
  const engineA = new FootballEngine(a.store); const bagA = collect(engineA);
  engineA.startMatch(mA, T0);
  for (let dt = 60000; dt <= 300000; dt += 60000) engineA.advance(mA, T0 + dt);

  // Camino B: un único salto a T0+300000 (como si el proceso hubiera estado caído).
  const b = freshStore(); const mB = isolate(b.store);
  const engineB = new FootballEngine(b.store); const bagB = collect(engineB);
  engineB.startMatch(mB, T0);
  engineB.advance(mB, T0 + 300000);

  const stateA = engineA.deriveMatchState(mA, T0 + 300000);
  const stateB = engineB.deriveMatchState(mB, T0 + 300000);
  assert.ok(Math.abs(stateA.minute - stateB.minute) < 1e-9, 'mismo minuto');
  assert.deepStrictEqual(stateA.state.score, stateB.state.score, 'mismo marcador');
  assert.strictEqual(stateA.revealedIndex, stateB.revealedIndex, 'mismo prefijo revelado');
  // El conjunto de eventos revelados es idéntico (A incremental, B de una vez).
  assert.deepStrictEqual([...new Set(bagA.events)].sort((x, y) => x - y), [...new Set(bagB.events)].sort((x, y) => x - y));
  // B lo reveló como catch-up (lote), A de a poco.
  assert.ok(bagB.events.length > 1, 'B revela el prefijo acumulado de golpe');
});

// --- T6: reinicio transparente ---

test('T6 — matar el store y reconstruir desde seed+now recupera minuto, marcador y eventos', () => {
  const { store, filePath } = freshStore();
  const m = isolate(store);
  const engine1 = new FootballEngine(store);
  engine1.startMatch(m, T0);
  const now = T0 + 300000;
  engine1.advance(m, now);
  const state1 = engine1.deriveMatchState(m, now);
  const types1 = engine1._ensureTimeline(m).timeline.slice(0, state1.revealedIndex + 1).map(e => e.type);
  store.saveNow(); // persiste status='live', kickoff real y ratings

  // «Matar el proceso»: un store nuevo que recarga desde el disco.
  const store2 = new FootballStore(filePath);
  const m2 = store2.getMatch(m.id);
  assert.ok(m2, 'el partido sobrevive al reinicio');
  assert.strictEqual(m2.status, 'live', 'se recargó en juego');
  const engine2 = new FootballEngine(store2);
  const state2 = engine2.deriveMatchState(m2, now);

  assert.ok(Math.abs(state2.minute - state1.minute) < 1e-9, 'mismo minuto tras reiniciar');
  assert.deepStrictEqual(state2.state.score, state1.state.score, 'mismo marcador tras reiniciar');
  assert.strictEqual(state2.revealedIndex, state1.revealedIndex, 'mismos eventos revelados');
  const types2 = engine2._ensureTimeline(m2).timeline.slice(0, state2.revealedIndex + 1).map(e => e.type);
  assert.deepStrictEqual(types2, types1, 'la línea regenerada desde el seed es idéntica');
});

// --- T13: watchdog de partido atascado ---

test('T13 — un partido live con lastTickAt viejo se auto-repara en un barrido', () => {
  const { store } = freshStore();
  const m = isolate(store);
  const engine = new FootballEngine(store);
  const bag = collect(engine);
  const scheduler = new FootballScheduler(engine);

  scheduler.runKickoffSweep(T0);            // arranca
  scheduler.runSchedulerSweep(T0 + 60000);  // último tick en T0+60000
  const rt = engine.runtime.get(m.id);
  assert.strictEqual(rt.lastTickAt, T0 + 60000);

  // Simula un atasco: pasan 20 s (> stallMs=15 s) SIN que corra el barrido.
  const stalled = T0 + 80000;
  const acciones = scheduler.runStuckSweep(stalled);
  assert.strictEqual(acciones.stalled, 1, 'detecta el partido atascado');
  assert.ok(bag.logs.some(l => l.type === 'football_match_stalled' && l.data.match === m.id), 'loguea football_match_stalled');
  assert.strictEqual(engine.runtime.get(m.id).lastTickAt, stalled, 're-deriva y refresca el tick');
  assert.ok(['live', 'halftime'].includes(m.status), 'sigue en juego, no lo pierde');
});

// --- T14: cuarentena y aislamiento ---

test('T14 — 3 errores seguidos posponen el partido y reembolsan sin tocar a los demás', () => {
  const { store } = freshStore();
  const matches = store.getMatches();
  const good = matches[0];
  const bad = matches[1];
  good.scheduledKickoffAt = T0; good.day = 10;
  bad.scheduledKickoffAt = T0; bad.day = 10;
  for (const other of matches) {
    if (other === good || other === bad) continue;
    other.scheduledKickoffAt = T0 + 100 * 86400000; other.day = 25;
  }

  const refunds = [];
  const engine = new FootballEngine(store, { refundBets: (match) => refunds.push(match.id) });
  const bag = collect(engine);
  const scheduler = new FootballScheduler(engine);

  scheduler.runKickoffSweep(T0);
  assert.strictEqual(good.status, 'live');
  assert.strictEqual(bad.status, 'live');

  // Inyecta un fallo persistente SOLO en el partido problemático.
  const original = engine.advance.bind(engine);
  engine.advance = (match, now) => {
    if (match.id === bad.id) throw new Error('fallo inyectado');
    return original(match, now);
  };

  const now = T0 + 60000;
  scheduler.runSchedulerSweep(now);
  scheduler.runSchedulerSweep(now + 1000);
  assert.strictEqual(bad.status, 'live', 'aún no alcanza el umbral');
  scheduler.runSchedulerSweep(now + 2000); // tercer error ⇒ cuarentena

  assert.strictEqual(bad.status, 'postponed', 'el partido problemático se pospone');
  assert.ok(refunds.includes(bad.id), 'se reembolsa el partido en cuarentena');
  assert.ok(bag.logs.some(l => l.type === 'football_match_quarantined' && l.data.match === bad.id));
  // El partido sano NO se vio afectado.
  assert.notStrictEqual(good.status, 'postponed', 'el partido sano sigue en juego');
  assert.ok(!refunds.includes(good.id), 'no se reembolsa el partido sano');
  assert.strictEqual(engine.runtime.get(bad.id).quarantined, true);
});

// --- Reconciliación al arrancar (§15.6 / §15.9) ---

test('reconcile liquida lo terminado durante la caída, reanuda lo vivo y deja lo futuro', () => {
  const { store } = freshStore();
  const matches = store.getMatches();
  const ended = matches[0];   // terminó durante el apagón
  const live = matches[1];    // en juego al arrancar
  const future = matches[2];  // aún no jugado, es de hoy
  ended.scheduledKickoffAt = T0 - 1100000; ended.day = 10;
  live.scheduledKickoffAt = T0 - 300000; live.day = 10;
  future.scheduledKickoffAt = T0 + 200000; future.day = 10;
  for (const other of matches) {
    if ([ended, live, future].includes(other)) continue;
    other.scheduledKickoffAt = T0 + 100 * 86400000; other.day = 25;
  }

  const engine = new FootballEngine(store);
  const summary = engine.reconcile(T0);

  assert.strictEqual(ended.status, 'settled', 'lo terminado durante la caída se liquida (nunca se anula)');
  assert.ok(ended.result && Number.isInteger(ended.result.home), 'con resultado registrado');
  assert.strictEqual(live.status, 'live', 'lo que estaba en juego se reanuda');
  assert.strictEqual(future.status, 'scheduled', 'lo futuro queda programado');
  assert.ok(summary.liquidados >= 1 && summary.en_juego >= 1 && summary.reprogramados >= 1);
});

test('reconcile marca lo recuperado como replay (§15.9: sin avalancha en tiempo real)', () => {
  const { store } = freshStore();
  const m = isolate(store);
  m.scheduledKickoffAt = T0 - 300000; // en juego al arrancar
  const engine = new FootballEngine(store);
  engine.reconcile(T0);
  assert.strictEqual(engine.runtime.get(m.id).replay, true, 'lo reanudado al arrancar es replay');
});

// --- Observabilidad (§15.8) ---

test('healthSnapshot expone el payload de /healthz', () => {
  const { store } = freshStore();
  const m = isolate(store);
  const engine = new FootballEngine(store);
  engine.startMatch(m, T0);
  engine.advance(m, T0 + 60000);
  const h = engine.healthSnapshot(T0 + 60000);
  for (const k of ['enabled', 'seasonMonth', 'jornada', 'matchesActive', 'matchesScheduledToday', 'lastSweepAgeMs', 'lastTickAgeMs', 'openBets', 'escrowChips', 'ledgerBalanced', 'quarantined', 'degraded']) {
    assert.ok(k in h, `falta ${k} en healthSnapshot`);
  }
  assert.strictEqual(h.enabled, true);
  assert.strictEqual(h.seasonMonth, SEASON);
  assert.strictEqual(h.matchesActive, 1);
  assert.strictEqual(h.degraded, false);
});

test('el watchdog marca degraded si el barrido principal no corre (§15.4)', () => {
  const { store } = freshStore();
  const engine = new FootballEngine(store);
  const scheduler = new FootballScheduler(engine);
  scheduler.lastSweepAt = T0;             // último ciclo hace mucho
  const acc = scheduler.runStuckSweep(T0 + 20000); // 20 s > degradedAfterMs
  assert.strictEqual(acc.degraded, true);
  assert.strictEqual(engine.degraded, true);
  assert.strictEqual(engine.healthSnapshot(T0 + 20000).degraded, true);
});

// --- Pre-generación (§15.3) ---

test('pregenerateUpcoming cachea las líneas del bloque siguiente', () => {
  const { store } = freshStore();
  const matches = store.getMatches();
  const soon = matches[0];
  soon.scheduledKickoffAt = T0 + 60000; // arranca en 1 min
  soon.day = 10;
  for (const other of matches) { if (other !== soon) { other.scheduledKickoffAt = T0 + 100 * 86400000; other.day = 25; } }
  const engine = new FootballEngine(store);
  const count = engine.pregenerateUpcoming(T0, 5 * 60 * 1000);
  assert.strictEqual(count, 1, 'pre-genera el partido inminente');
  assert.ok(engine.runtime.get(soon.id).result, 'la línea queda cacheada');
});

// --- Gate del reset mensual (A7) ---

test('seasonGate no bloquea sin apuestas y pospone cuando el hook las reporta', () => {
  const { store } = freshStore();
  const engine = new FootballEngine(store);
  assert.deepStrictEqual(engine.seasonGate(), { type: 'proceed' }, 'sin apuestas, el reset procede');
  const gated = new FootballEngine(store, { hasOpenBets: () => true });
  assert.strictEqual(gated.seasonGate().type, 'deferred', 'con apuestas abiertas, se pospone');
});
