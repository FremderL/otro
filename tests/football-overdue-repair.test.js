'use strict';

// Regresión del incidente «Kickoff pendiente · esperando señal del partido»:
// un cruce que nunca arrancó seguía sin acta al día siguiente, la tabla mostraba
// dos clubes con menos partidos jugados y la temporada iba a cerrar incompleta.
//
// Cubre la familia completa:
//   1. Cruce de mes: la rotación se aplaza y el partido se asienta antes de cerrar.
//   2. Temporada ya cerrada con un hueco: se reconstruye tabla y carryover.
//   3. V2 todavía sin compromiso: no se pospone ni se reembolsa; se reintenta.
//   4. Pospuesto por el motor se recupera; pospuesto por administración se respeta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { FootballEngine } = require('../lib/football/engine');
const { FootballScheduler } = require('../lib/football/scheduler');
const { createOfficialV2 } = require('../lib/football/v2/official');

const NOV = '2026-11';
const DEC = '2026-12';
const DEC_WAKE = Date.UTC(2026, 11, 1, 16); // 1 dic, 10:00 en la zona del casino

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overdue-repair-'));
}

function seededStore(dir, month = NOV) {
  const store = new FootballStore(path.join(dir, 'football.json'));
  const league = store.generateSeason(month);
  return { store, league };
}

function byKickoff(league) {
  return league.calendar.matches.slice().sort((a, b) => a.scheduledKickoffAt - b.scheduledKickoffAt);
}

// Asienta todo lo que ya debía haberse jugado salvo `keep`, con fecha anterior a
// `now` para respetar la causalidad de los insumos V2.
function settleOthers(store, league, keep, now) {
  for (const match of league.calendar.matches) {
    if (match.id === keep.id) continue;
    if (match.scheduledKickoffAt + 30 * 60000 > now) continue;
    store.settleMatch(match.id, { home: 1, away: 0 }, {
      seasonMonth: league.seasonMonth,
      now: Math.min(now - 60000, match.scheduledKickoffAt + 60000),
      deferSave: true
    });
  }
}

test('un kickoff sin señal en el último día del mes aplaza la rotación y se asienta antes de cerrar', async t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { store, league } = seededStore(dir);
  const last = byKickoff(league).at(-1);
  settleOthers(store, league, last, DEC_WAKE);

  const logs = [];
  const logEvent = (event, data) => logs.push({ event, data });
  const engine = new FootballEngine(store, { logEvent });
  const scheduler = new FootballScheduler(engine, { logEvent });

  // El barrido principal (500 ms) NO puede abrir diciembre con noviembre a medias.
  scheduler.runSchedulerSweep(DEC_WAKE);
  assert.equal(store.getSeasonMonths().includes(DEC), false, 'no se crea la temporada nueva con un cruce sin acta');
  assert.ok(logs.some(item => item.event === 'football_season_rotation_deferred'),
    'la rotación aplazada queda registrada');

  // El barrido de temporada repara por jornada y recién entonces rota.
  await scheduler.runSeasonSweep(DEC_WAKE);
  assert.equal(last.status, 'settled', 'el partido colgado se asienta con su seed');
  assert.ok(Number.isInteger(last.result.home) && Number.isInteger(last.result.away));
  assert.equal(store.getCurrentSeasonMonth(), DEC, 'la temporada nueva se abre después de reparar');
  assert.equal(store.getLeague(NOV).status, 'closed');
  assert.ok(logs.some(item => item.event === 'football_overdue_settled' && item.data.match === last.id));

  const standings = store.getStandings(NOV);
  assert.equal(standings.reduce((acc, row) => acc + row.played, 0), 480,
    'la tabla del mes cerrado cuenta los 240 partidos, no 239');
  assert.equal(standings.find(row => row.teamId === last.homeId).played, 30);
  // El arrastre de ratings del mes cerrado sale de la tabla completa.
  assert.deepEqual(store.getLeague(NOV).carryover, store.computeCarryover(store.getLeague(NOV)));
  assert.equal(typeof store.getLeague(NOV).carryover[standings[0].teamId], 'number');
  store.close();
});

test('un cruce de la jornada en curso con 0 partidos jugados se asienta por el barrido periódico', async t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { store, league } = seededStore(dir);
  // Jornada 1: todos los cruces se juegan menos uno (el que nunca recibió señal).
  const firstJornada = league.calendar.matches.filter(match => match.jornada === 1);
  const stuck = firstJornada[0];
  for (const match of firstJornada) {
    if (match.id === stuck.id) continue;
    store.settleMatch(match.id, { home: 2, away: 1 }, { seasonMonth: NOV, now: match.scheduledKickoffAt + 20 * 60000, deferSave: true });
  }
  for (const match of league.calendar.matches) {
    if (match.jornada !== 1) match.scheduledKickoffAt = Date.UTC(2027, 5, 1);
  }
  const both = () => store.getStandings(NOV).filter(row => row.teamId === stuck.homeId || row.teamId === stuck.awayId);
  assert.deepEqual(both().map(row => row.played), [0, 0], 'el incidente: los dos clubes con 0 partidos jugados');
  const playedBefore = store.getStandings(NOV).reduce((acc, row) => acc + row.played, 0);

  const wake = stuck.scheduledKickoffAt + 26 * 3600000;
  const logs = [];
  const logEvent = (event, data) => logs.push({ event, data });
  const settledBets = [];
  const engine = new FootballEngine(store, {
    logEvent,
    settleBets: (match, score) => settledBets.push({ matchId: match.id, score })
  });
  const scheduler = new FootballScheduler(engine, { logEvent });
  // Solo el barrido de temporada (una vuelta por minuto): el resultado entra solo.
  await scheduler.runSeasonSweep(wake);

  assert.equal(stuck.status, 'settled');
  assert.deepEqual(both().map(row => row.played), [1, 1], 'los dos clubes suman su partido y la tabla queda completa');
  assert.equal(store.getStandings(NOV).reduce((acc, row) => acc + row.played, 0), playedBefore + 2);
  assert.ok(both().every(row => row.points === 0 || row.points === 1 || row.points === 3));
  assert.ok(logs.some(item => item.event === 'football_overdue_settled' && item.data.match === stuck.id && item.data.source === 'repair'));
  assert.deepEqual(settledBets, [{ matchId: stuck.id, score: { home: stuck.result.home, away: stuck.result.away } }],
    'los boletos abiertos del cruce se liquidan con el mismo marcador que la tabla');
  store.close();
});

test('una temporada que ya se cerró con un hueco se reconstruye cuando entra el acta', async t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { store, league } = seededStore(dir);
  const last = byKickoff(league).at(-1);
  settleOthers(store, league, last, DEC_WAKE);

  // Estado que dejaba el incidente: diciembre se abrió y noviembre quedó cerrado
  // con 239 actas (dos clubes con un partido menos).
  store.ensureSeason(new Date(DEC_WAKE));
  assert.equal(store.getLeague(NOV).status, 'closed');
  assert.equal(store.getStandings(NOV).find(row => row.teamId === last.homeId).played, 29);

  const engine = new FootballEngine(store, { logEvent: () => {} });
  const summary = await engine.repairOverdueMatches(DEC_WAKE);
  assert.equal(summary.liquidados, 1, 'el barrido de vencidos encuentra el cruce aunque el mes ya rotó');
  assert.equal(last.status, 'settled');
  assert.equal(store.getStandings(NOV).find(row => row.teamId === last.homeId).played, 30);
  assert.deepEqual(store.getLeague(NOV).carryover, store.computeCarryover(store.getLeague(NOV)),
    'el carryover de la temporada cerrada se recalcula desde las actas');
  store.close();

  // El acta quedó persistida: un reinicio no la vuelve a perder.
  const restored = new FootballStore(path.join(dir, 'football.json'));
  assert.equal(restored.getMatch(last.id, NOV).status, 'settled');
  assert.equal(restored.getStandings(NOV).reduce((acc, row) => acc + row.played, 0), 480);
  restored.close();
});

test('un V2 todavía sin compromiso no se pospone: se reintenta y se asienta al prepararse', async t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { store, league } = seededStore(dir);
  const target = byKickoff(league)[0];
  // El resto del calendario queda muy adelante: solo el colgado está vencido.
  for (const match of league.calendar.matches) {
    if (match.id === target.id) continue;
    match.scheduledKickoffAt = Date.UTC(2027, 5, 1);
  }
  const now = target.scheduledKickoffAt + 2 * 3600000;
  const logs = [];
  const officialV2 = createOfficialV2({ store, now: () => now, log: () => {} });
  const engine = new FootballEngine(store, { officialV2, logEvent: (event, data) => logs.push({ event, data }) });

  const summary = engine.reconcile(now);
  assert.equal(target.status, 'scheduled', 'sin compromiso confirmado no se pospone ni se asienta a ciegas');
  assert.equal(target.postponed, undefined, 'no se reembolsan los boletos de un fallo transitorio');
  assert.ok(summary.pendientes >= 1);

  const repaired = await engine.repairOverdueMatches(now);
  assert.equal(repaired.liquidados, 1);
  assert.equal(target.status, 'settled');
  assert.ok(target.simulation, 'el acta se asienta con el compromiso V2 que se preparó en el reintento');
  store.close();
});

test('el pospuesto por el motor se recupera; el pospuesto por administración se respeta', async t => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { store, league } = seededStore(dir);
  const sorted = byKickoff(league);
  const technical = sorted[0];
  const editorial = sorted[1];
  for (const match of league.calendar.matches) {
    if (match.id === technical.id || match.id === editorial.id) continue;
    match.scheduledKickoffAt = Date.UTC(2027, 5, 1);
  }
  const now = Math.max(technical.scheduledKickoffAt, editorial.scheduledKickoffAt) + 3 * 3600000;
  const engine = new FootballEngine(store, { logEvent: () => {} });
  engine.quarantine(technical, 'boot_underivable', { now });
  engine.quarantine(editorial, 'decisión editorial', { now, by: 'admin' });
  store.saveNow();

  const repaired = await engine.repairOverdueMatches(now);
  assert.equal(repaired.recuperados, 1);
  assert.equal(technical.status, 'settled', 'un fallo técnico no puede dejar la jornada a medias');
  assert.equal(editorial.status, 'postponed', 'una decisión administrativa no se convierte en partido jugado');
  store.close();

  // El origen de la posposición viaja con el partido y sobrevive al reinicio.
  const restored = new FootballStore(path.join(dir, 'football.json'));
  assert.equal(restored.getMatch(editorial.id, NOV).status, 'postponed');
  assert.equal(restored.getMatch(editorial.id, NOV).postponed.by, 'admin');
  assert.equal(restored.getMatch(technical.id, NOV).postponed, undefined);

  // La palanca admin devuelve el pospuesto al ciclo y el barrido lo asienta.
  const reopenedEngine = new FootballEngine(restored, { logEvent: () => {} });
  const target = restored.getMatch(editorial.id, NOV);
  assert.equal(reopenedEngine.reopenMatch(target, { by: 'admin' }).ok, true);
  assert.equal(target.status, 'scheduled');
  const after = await reopenedEngine.repairOverdueMatches(now);
  assert.equal(after.liquidados, 1);
  assert.equal(restored.getMatch(editorial.id, NOV).status, 'settled');
  restored.close();
});

test('West Hamón–Arcenico del día anterior confirma un guardado fallido y suma PJ una sola vez', async t => {
  const dir = tmpdir();
  const { store, league } = seededStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const target = league.calendar.matches.find(m => m.homeId === 'norvela_sporting' && m.awayId === 'dynamo_kelvar' && m.jornada === 1);
  assert.ok(target);
  for (const match of league.calendar.matches) if (match !== target) match.scheduledKickoffAt = Date.UTC(2027, 5, 1);
  const now = target.scheduledKickoffAt + 24 * 3600000;
  const officialV2 = createOfficialV2({ store, now: () => now });
  assert.equal((await officialV2.ensureSeason(NOV)).ok, true);
  const save = store.saveStrict.bind(store);
  store.saveStrict = async () => false;
  assert.equal((await officialV2.prepareMatch(target)).reason, 'persistencia_pendiente');
  assert.equal(target.simulationUnconfirmed, true);
  const commitment = JSON.stringify(target.simulation);
  store.saveStrict = save;
  const engine = new FootballEngine(store, { officialV2 });
  const scheduler = new FootballScheduler(engine, { officialV2 });
  await scheduler.runSeasonSweep(now);
  assert.equal(target.status, 'settled');
  assert.equal(target.simulationUnconfirmed, undefined);
  assert.equal(JSON.stringify(target.simulation), commitment, 'no vuelve a sortear el resultado');
  const score = { ...target.result };
  const rows = () => store.getStandings(NOV).filter(row => [target.homeId, target.awayId].includes(row.teamId));
  assert.deepEqual(rows().map(row => row.played), [1, 1]);
  await scheduler.runAutoRescheduleSweep(now + 5000);
  await scheduler.runSeasonSweep(now + 60000);
  assert.deepEqual(target.result, score);
  assert.deepEqual(rows().map(row => row.played), [1, 1]);
  const loaded = new FootballStore(path.join(dir, 'football.json'));
  try {
    assert.deepEqual(loaded.getMatch(target.id, NOV).result, score);
    assert.equal(loaded.getMatch(target.id, NOV).status, 'settled');
    assert.deepEqual(loaded.getStandings(NOV).filter(row => [target.homeId, target.awayId].includes(row.teamId)).map(row => row.played), [1, 1]);
  } finally { loaded.close(); }
});

test('una preparación V2 fallida no impide liquidar el siguiente vencido de la jornada', async t => {
  const dir = tmpdir();
  const { store, league } = seededStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const [bad, good] = league.calendar.matches.filter(m => m.jornada === 1).slice(0, 2);
  for (const match of league.calendar.matches) if (match !== bad && match !== good) match.scheduledKickoffAt = Date.UTC(2027, 5, 1);
  const now = Math.max(bad.scheduledKickoffAt, good.scheduledKickoffAt) + 24 * 3600000;
  const officialV2 = createOfficialV2({ store, now: () => now });
  const prepare = officialV2.prepareMatches;
  officialV2.prepareMatches = async (month, matches, at) => {
    if (matches.some(m => m === bad)) throw new Error('fallo de preparación aislado');
    return prepare(month, matches, at);
  };
  const engine = new FootballEngine(store, { officialV2 });
  const summary = await engine.repairOverdueMatches(now);
  assert.equal(bad.status, 'scheduled');
  assert.equal(good.status, 'settled');
  assert.equal(summary.liquidados, 1);
  assert.equal(summary.pendientes, 1);
});

test('el barrido de cinco segundos también confirma y liquida un compromiso pendiente', async t => {
  const dir = tmpdir();
  const { store, league } = seededStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const target = league.calendar.matches[0];
  for (const match of league.calendar.matches) if (match !== target) match.scheduledKickoffAt = Date.UTC(2027, 5, 1);
  const now = target.scheduledKickoffAt + 24 * 3600000;
  const officialV2 = createOfficialV2({ store, now: () => now });
  assert.equal((await officialV2.ensureSeason(NOV)).ok, true);
  const save = store.saveStrict.bind(store);
  store.saveStrict = async () => false;
  assert.equal((await officialV2.prepareMatch(target)).reason, 'persistencia_pendiente');
  const engine = new FootballEngine(store, { officialV2 });
  const scheduler = new FootballScheduler(engine, { officialV2 });
  await scheduler.runAutoRescheduleSweep(now);
  assert.equal(target.status, 'scheduled', 'no publica un resultado sin confirmar');
  store.saveStrict = save;
  await scheduler.runAutoRescheduleSweep(now + 5000);
  assert.equal(target.status, 'settled');
  assert.equal(target.simulationUnconfirmed, undefined);
});

test('arranque aísla compromiso dañado y recupera West Hamón–Arsénico sin borrar evidencia', async t => {
  const dir = tmpdir();
  const { store, league } = seededStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const target = league.calendar.matches.find(m => m.homeId === 'norvela_sporting' && m.awayId === 'dynamo_kelvar' && m.jornada === 1);
  const bad = league.calendar.matches.find(m => m.jornada === 1 && m !== target);
  const now = Math.max(target.scheduledKickoffAt, bad.scheduledKickoffAt) + 24 * 3600000;
  for (const match of league.calendar.matches) if (match !== target && match !== bad) match.scheduledKickoffAt = now + 10 * 86400000;
  bad.simulation = { version: 'v2-causal-4', privateSeed: 'ab'.repeat(32), inputsHash: 'cd'.repeat(32), inputs: { damaged: true }, preparedAt: now - 1 };
  store.saveNow();
  const loaded = new FootballStore(path.join(dir, 'football.json'));
  const broken = loaded.getMatch(bad.id, NOV);
  assert.equal(broken.simulation.invalid, true);
  assert.equal(broken.simulation.original.privateSeed, 'ab'.repeat(32));
  const logs = [];
  const officialV2 = createOfficialV2({ store: loaded, now: () => now, log: (event, data) => logs.push({ event, data }) });
  const engine = new FootballEngine(loaded, { officialV2 });
  await engine.reconcileBoot(now);
  assert.equal(loaded.getMatch(target.id, NOV).status, 'settled');
  assert.equal(broken.status, 'scheduled');
  assert.equal(broken.postponed, undefined);
  assert.ok(logs.some(e => e.event === 'football_v2_prepare_error' && e.data.match === bad.id));
  assert.deepEqual(loaded.getStandings(NOV).filter(row => [target.homeId, target.awayId].includes(row.teamId)).map(row => row.played), [1, 1]);
  loaded.close();
  const reloaded = new FootballStore(path.join(dir, 'football.json'));
  try {
    assert.equal(reloaded.getMatch(bad.id, NOV).simulation.original.privateSeed, 'ab'.repeat(32));
    assert.equal(reloaded.getMatch(target.id, NOV).status, 'settled');
  } finally { reloaded.close(); }
});

test('una reparación que espera preparación no asienta un partido reprogramado durante el await', async t => {
  const dir = tmpdir();
  const { store, league } = seededStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const target = league.calendar.matches[0];
  const now = target.scheduledKickoffAt + 24 * 3600000;
  for (const match of league.calendar.matches) if (match !== target) match.scheduledKickoffAt = now + 10 * 86400000;
  const officialV2 = createOfficialV2({ store, now: () => now });
  const prepare = officialV2.prepareMatches;
  let release, reached;
  const entered = new Promise(resolve => { reached = resolve; });
  officialV2.prepareMatches = async (...args) => {
    reached();
    await new Promise(resolve => { release = resolve; });
    return prepare(...args);
  };
  const engine = new FootballEngine(store, { officialV2 });
  const repairing = engine.repairOverdueMatches(now);
  await entered;
  target.scheduledKickoffAt = now + 3600000;
  release();
  const result = await repairing;
  assert.equal(result.liquidados, 0);
  assert.equal(target.status, 'scheduled');
  assert.equal(target.result, null);
});

test('watchdog aísla un partido live inválido y sigue procesando los demás', t => {
  const dir = tmpdir();
  const { store, league } = seededStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const [bad, good] = league.calendar.matches;
  bad.status = 'live'; bad.simulation = { version: 'invalid', invalid: true };
  good.status = 'live';
  const now = Math.max(bad.scheduledKickoffAt, good.scheduledKickoffAt) + 3600000;
  const events = [];
  const engine = new FootballEngine(store);
  const scheduler = new FootballScheduler(engine, { logEvent: (event, data) => events.push({ event, data }) });
  const result = scheduler.runStuckSweep(now);
  assert.equal(result.forcedFinish, 1);
  assert.equal(good.status, 'settled');
  assert.equal(bad.status, 'live');
  assert.ok(events.some(e => e.event === 'football_stuck_match_error' && e.data.match === bad.id));
});

test('un V2 live con compromiso dañado no se pospone ni reembolsa por reintentos', t => {
  const dir = tmpdir();
  const { store, league } = seededStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const match = league.calendar.matches[0];
  match.status = 'live'; match.simulation = { version: 'invalid', invalid: true };
  let refunds = 0;
  const events = [];
  const engine = new FootballEngine(store, { refundBets: () => refunds++ });
  const scheduler = new FootballScheduler(engine, { logEvent: (event, data) => events.push({ event, data }) });
  const now = match.scheduledKickoffAt + 1000;
  for (let i = 0; i < 4; i++) scheduler.runSchedulerSweep(now + i * 500);
  assert.equal(match.status, 'live');
  assert.equal(refunds, 0);
  assert.equal(events.filter(e => e.event === 'football_v2_commitment_blocked').length, 1);
});
