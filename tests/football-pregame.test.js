'use strict';

// Previa de los comentaristas: la conversación que narrador y analista
// sostienen unos minutos antes del saque inicial (§9, Estadio).
//
// Se prueba el guion (dos voces alternadas, datos reales, límite de longitud,
// determinismo) y el runner (ritmo, ventana de seis minutos, cierre de sesión al
// arrancar el partido). La emisión real por Socket.IO se cubre en
// tests/football-sockets.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildPregameScript, createPregameRunner, contextFor, formText, marketSummary,
  forecastOf, holdFor, PREGAME_LEAD_MS
} = require('../lib/football/pregame');
const pregame = require('../lib/football/pregame');
const { FootballStore } = require('../lib/football-store');
const { FootballScheduler } = require('../lib/football/scheduler');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { monthKey } = require('../lib/football-store-shared');
const { MAX_LEN } = require('../lib/football/commentary');

const KICKOFF = Date.UTC(2026, 10, 5, 22, 0);

function clubs() {
  return [
    { id: 'alfa', name: 'Alfa FC', stadium: 'Arena Norte', capacity: 30000, tactics: { formation: '4-3-3', style: 'possession' } },
    { id: 'beta', name: 'Beta Unidos', stadium: 'Campo Sur', capacity: 18000, tactics: { formation: '4-4-2', style: 'counter' } }
  ];
}

function scriptContext(overrides = {}) {
  return {
    match: { id: 'm-1', seed: 4242, jornada: 4, homeId: 'alfa', awayId: 'beta', scheduledKickoffAt: KICKOFF },
    league: { config: clubs(), calendar: { matches: [] }, standings: [] },
    home: clubs()[0],
    away: clubs()[1],
    homeRow: { teamId: 'alfa', points: 9, played: 3, goalsFor: 5, goalsAgainst: 3, form: ['W', 'D', 'W'] },
    awayRow: { teamId: 'beta', points: 4, played: 3, goalsFor: 2, goalsAgainst: 4, form: ['L', 'D', 'W'] },
    homePosition: 3,
    awayPosition: 9,
    market: {
      selections: [
        { key: 'home', price: 1.8, prob: 0.5 },
        { key: 'draw', price: 3.6, prob: 0.27 },
        { key: 'away', price: 4.4, prob: 0.23 }
      ]
    },
    ...overrides
  };
}

test('la previa es una conversación: dos voces alternadas y mensajes cortos', () => {
  const lines = buildPregameScript(scriptContext());
  assert.ok(lines.length >= 8, `una previa real tiene varias intervenciones (${lines.length})`);
  for (const [index, line] of lines.entries()) {
    assert.ok(['narrador', 'analista'].includes(line.voice), 'solo hablan el narrador y el analista');
    assert.equal(line.voice, index % 2 === 0 ? 'narrador' : 'analista', `turno ${index} alterna la voz`);
    assert.ok(line.text.length > 0 && line.text.length <= MAX_LEN, `límite de ${MAX_LEN} caracteres: ${line.text}`);
    assert.ok(!/\{[a-zA-Z]+\}/.test(line.text), `sin variables sin resolver: ${line.text}`);
  }
  // Hablan del partido de verdad: equipos, estadio y hora.
  const all = lines.map(line => line.text).join(' ');
  assert.match(all, /Alfa FC/);
  assert.match(all, /Beta Unidos/);
  assert.match(all, /Arena Norte/);
});

test('la previa usa tabla, forma y mercado; el pronóstico respeta al favorito', () => {
  const lines = buildPregameScript(scriptContext());
  const all = lines.map(line => line.text).join(' ');
  assert.match(all, /3\.º con 9 puntos/);
  assert.match(all, /2 victorias y 1 empate/);
  assert.match(all, /50% de probabilidad/);
  assert.match(all, /cuota 1\.80/);
  assert.match(all, /El empate paga 3\.60/);
  // Con el local como favorito (50 %), el marcador pronosticado es del local.
  const prediction = lines.map(line => line.text).find(text => text.includes('Me la juego por un'));
  const score = /Me la juego por un (\d+)-(\d+)/.exec(prediction);
  assert.ok(score, 'el analista da un marcador');
  assert.ok(Number(score[1]) > Number(score[2]), 'el pronóstico no contradice las cuotas');
});

test('el guion es determinista (misma semilla, misma previa)', () => {
  const first = buildPregameScript(scriptContext());
  const second = buildPregameScript(scriptContext());
  assert.deepEqual(first, second);
  // Otro partido (otra seed) puede cambiar el pronóstico, nunca la estructura.
  const other = buildPregameScript(scriptContext({ match: { ...scriptContext().match, id: 'm-2', seed: 99 } }));
  assert.equal(other.length, first.length);
});

test('sin mercado ni tabla sigue habiendo conversación y no inventa datos', () => {
  const lines = buildPregameScript(scriptContext({
    homeRow: null, awayRow: null, homePosition: null, awayPosition: null, market: null
  }));
  assert.ok(lines.length >= 6, 'la previa existe aunque la temporada acabe de arrancar');
  const all = lines.map(line => line.text).join(' ');
  assert.doesNotMatch(all, /undefined|NaN|null/);
  assert.doesNotMatch(all, /cuota/, 'sin mercado no se citan cuotas');
});

test('nunca anuncia un resultado: la previa ocurre antes del partido', () => {
  const lines = buildPregameScript(scriptContext());
  for (const line of lines) {
    assert.doesNotMatch(line.text, /(ganó|venció|derrotó|cayó|marcador final|resultado final)/i);
  }
});

test('formText resume las últimas letras de la tabla', () => {
  assert.equal(formText(['W', 'W', 'D', 'L', 'W']), '3 victorias, 1 empate y 1 derrota');
  assert.equal(formText(['W']), '1 victoria');
  assert.equal(formText([]), '');
  assert.equal(formText(null), '');
});

test('marketSummary normaliza las tres cuotas y cae a la probabilidad implícita', () => {
  const summary = marketSummary({ selections: [
    { key: 'home', price: 2, prob: 0.48 }, { key: 'draw', price: 3.2, implied: 0.29 }, { key: 'away', price: 3.9, prob: 0.23 }
  ] });
  assert.deepEqual(summary, {
    home: { price: '2.00', prob: 48 },
    draw: { price: '3.20', prob: 29 },
    away: { price: '3.90', prob: 23 }
  });
  assert.equal(marketSummary({ selections: [{ key: 'home', price: 2 }] }), null, 'sin 1X2 completo no hay resumen');
  assert.equal(marketSummary(null), null);
  assert.equal(forecastOf(null), '');
});

test('el runner reúne los datos del store real (tabla, clubes y mercado)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'previa-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const month = monthKey();
  store.generateSeason(month);
  const betting = createBettingService({ store, profiles, now: () => Date.now(), log: () => {} });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { profiles.saveNow(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const match = store.getMatches(month).find(item => item.status === 'scheduled');
  const context = contextFor(match, { store, getMarket: m => betting.getMarket(m, '1x2'), asOf: Date.now() });
  assert.ok(context, 'el contexto se resuelve con la temporada persistida');
  assert.ok(context.home && context.away, 'los dos clubes existen');
  assert.ok(Number.isFinite(context.homePosition) && Number.isFinite(context.awayPosition), 'hay posiciones de tabla');
  assert.ok(context.market && context.market.selections.length >= 3, 'hay mercado 1X2 pre-partido');
  const lines = buildPregameScript(context);
  assert.ok(lines.length >= 8);
});

test('el runner emite una intervención por vuelta y cierra la sesión al arrancar', () => {
  const league = {
    seasonMonth: '2026-11',
    config: clubs(),
    standings: [],
    calendar: {
      matches: [{ id: 'm-1', seed: 7, jornada: 4, homeId: 'alfa', awayId: 'beta', status: 'scheduled', scheduledKickoffAt: KICKOFF }]
    }
  };
  const store = { getLeague: () => league };
  const emitted = [];
  const runner = createPregameRunner({ store, getMarket: () => null, emit: (match, line, at) => emitted.push({ matchId: match.id, line, at }) });

  const start = KICKOFF - 5 * 60 * 1000;
  runner.tick(start);
  assert.equal(emitted.length, 1, 'la previa arranca con la bienvenida en cuanto entra en ventana');
  assert.equal(emitted[0].line.voice, 'narrador');

  // Un segundo después todavía no toca hablar: el ritmo es de conversación.
  runner.tick(start + 1000);
  assert.equal(emitted.length, 1);

  // Pasada la pausa de la primera línea, llega la respuesta del analista.
  runner.tick(start + holdFor(emitted[0].line) + 1);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].line.voice, 'analista');

  // Al arrancar el partido (fuera de la ventana) la sesión se cierra.
  assert.equal(runner.sessions.size, 1);
  runner.tick(KICKOFF + 1000);
  assert.equal(runner.sessions.size, 0, 'no hay previa después del saque inicial');
});

test('el runner solo habla de partidos dentro de los seis minutos previos', () => {
  const league = {
    seasonMonth: '2026-11',
    config: clubs(),
    standings: [],
    calendar: {
      matches: [
        { id: 'pronto', seed: 1, jornada: 4, homeId: 'alfa', awayId: 'beta', status: 'scheduled', scheduledKickoffAt: KICKOFF },
        { id: 'lejos', seed: 2, jornada: 4, homeId: 'beta', awayId: 'alfa', status: 'scheduled', scheduledKickoffAt: KICKOFF + 3 * 60 * 60 * 1000 },
        { id: 'vivo', seed: 3, jornada: 3, homeId: 'alfa', awayId: 'beta', status: 'live', scheduledKickoffAt: KICKOFF - 20 * 60 * 1000 }
      ]
    }
  };
  const store = { getLeague: () => league };
  const emitted = [];
  const runner = createPregameRunner({ store, emit: (match, line) => emitted.push({ matchId: match.id, line }) });
  assert.ok(PREGAME_LEAD_MS >= 5 * 60 * 1000 && PREGAME_LEAD_MS <= 10 * 60 * 1000, 'la previa empieza «unos minutos» antes');
  runner.tick(KICKOFF - PREGAME_LEAD_MS + 1000);
  assert.deepEqual([...new Set(emitted.map(item => item.matchId))], ['pronto']);
});

test('el runner tolera un store sin liga y un emit que falla', () => {
  const runner = createPregameRunner({ store: { getLeague: () => null } });
  assert.deepEqual(runner.tick(Date.now()), { matches: 0, sessions: 0 });
  const broken = createPregameRunner({
    store: { getLeague: () => ({ config: [], calendar: { matches: [] } }) },
    emit: () => { throw new Error('socket cerrado'); }
  });
  assert.doesNotThrow(() => broken.tick(Date.now()));
});

test('el scheduler impulsa la previa y aísla sus fallos del resto de barridos', () => {
  const engine = { store: {} };
  let calls = 0;
  const scheduler = new FootballScheduler(engine, {
    pregameService: { tick: at => { calls++; return { at }; } }
  });
  assert.deepEqual(scheduler.runPregameSweep(1234), { at: 1234 });
  assert.equal(calls, 1);

  const broken = new FootballScheduler(engine, {
    pregameService: { tick: () => { throw new Error('socket cerrado'); } }
  });
  assert.deepEqual(broken.runPregameSweep(1), { ok: false });

  // Sin servicio inyectado el barrido es un no-op (servidor sin Estadio).
  assert.deepEqual(new FootballScheduler(engine).runPregameSweep(1), { skipped: true });
});

test('el scheduler impulsa el barrido de cuotas pre-partido y aísla sus fallos', () => {
  const engine = { store: {} };
  const seen = [];
  const scheduler = new FootballScheduler(engine, {
    oddsService: { tick: at => { seen.push(at); return { rooms: 1, checked: 2, emitted: 1 }; } }
  });
  assert.deepEqual(scheduler.runOddsSweep(1234), { rooms: 1, checked: 2, emitted: 1 });
  assert.deepEqual(seen, [1234], 'el barrido recibe la hora, no consulta un reloj propio');

  const logged = [];
  const broken = new FootballScheduler(engine, {
    logEvent: (code, data) => logged.push({ code, data }),
    oddsService: { tick: () => { throw new Error('socket cerrado'); } }
  });
  assert.deepEqual(broken.runOddsSweep(1), { ok: false });
  assert.equal(logged[0].code, 'football_odds_sweep_error');

  assert.deepEqual(new FootballScheduler(engine).runOddsSweep(1), { skipped: true });
  // Se arma junto a los demás barridos y se detiene con ellos.
  scheduler.start();
  try {
    assert.ok(scheduler.timers.odds, 'start() arma el barrido de cuotas');
  } finally {
    scheduler.stop();
  }
  assert.deepEqual(scheduler.timers, {});
});

// Guardas de exportación: el módulo expone lo que usan el scheduler y las pruebas.
test('el módulo publica la ventana, el runner y los helpers del guion', () => {
  for (const key of ['PREGAME_LEAD_MS', 'PREGAME_STEP_MS', 'buildPregameScript', 'createPregameRunner', 'contextFor', 'formText']) {
    assert.ok(pregame[key] !== undefined, `falta ${key}`);
  }
  assert.equal(typeof pregame.createPregameRunner, 'function');
});
