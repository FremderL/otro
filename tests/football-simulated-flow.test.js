'use strict';

// Fase D — Flujo de apuestas simulado (§11.6, decisión D8, §20: T18, T19, T20).
//
// Garantiza que el dinero sintético: mueve las cuotas cuando no hay nadie, se
// vuelve irrelevante en cuanto hay dinero real, es reproducible por seed, y sobre
// todo NO se filtra al cliente ni toca fichas, exposición o responsabilidad.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const SF = require('../lib/football/simulated-flow');
const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { monthKey } = require('../lib/football-store-shared');

const PROBS = { home: 0.5, draw: 0.27, away: 0.23 };
const MATCH = { id: 'm1', seed: 4242, block: 'estelar', featured: false };

test('decaimiento: el dinero real manda (tabla §11.6)', () => {
  assert.strictEqual(SF.decay(0), 1, '0 reales → 100 % de influencia');
  assert.ok(Math.abs(SF.decay(2000) - 0.5) < 1e-9, '2.000 → 50 %');
  assert.ok(SF.decay(10000) > 0.16 && SF.decay(10000) < 0.18, '10.000 → ~17 %');
  assert.ok(SF.decay(40000) < 0.05, '40.000 → por debajo del 5 %');
  // Monótono decreciente.
  assert.ok(SF.decay(0) > SF.decay(1000) && SF.decay(1000) > SF.decay(10000) && SF.decay(10000) > SF.decay(100000));
});

test('T20: con 0 reales el simulado domina; con 40.000 su influencia cae bajo el 5 %', () => {
  const simTotal = 3000;
  assert.strictEqual(SF.influence(0, simTotal), 1, 'sin dinero real, todo el peso es simulado');
  assert.ok(SF.influence(40000, simTotal) < 0.05, 'con 40.000 reales el simulado es irrelevante');
  // El peso simulado (SIM_WEIGHT · decaimiento) también cae bajo 5 % con 40.000.
  assert.ok(SF.simWeight(40000) < 0.05);
});

test('distribute es determinista por seed, sensible al seed y sesga al favorito', () => {
  const a = SF.distribute(MATCH, '1x2', PROBS, {});
  const b = SF.distribute(MATCH, '1x2', PROBS, {});
  assert.deepStrictEqual(a, b, 'mismo seed → mismo flujo (auditable)');
  const c = SF.distribute({ ...MATCH, seed: 99 }, '1x2', PROBS, {});
  assert.notDeepStrictEqual(a, c, 'otro seed → otro flujo');
  // Sesgo de público: el favorito (home, p=0.5) atrae más dinero que el resto.
  assert.ok(a.home > a.draw && a.home > a.away, 'el favorito atrae más');
  // Volumen dentro del rango (§11.6: 500-5000, más en estelar).
  const total = a.home + a.draw + a.away;
  assert.ok(total >= 500 * 0.8 && total <= 5000 * 1.4 * 1.3 + 1, `volumen fuera de rango: ${total}`);
  // En vivo el volumen baja a ~20 %.
  const live = SF.distribute(MATCH, '1x2', PROBS, { inPlay: true });
  const liveTotal = live.home + live.draw + live.away;
  assert.ok(liveTotal < total, 'en vivo baja el volumen');
});

test('combine pondera el flujo simulado por el decaimiento del dinero real', () => {
  const sim = { home: 2000, draw: 1000, away: 1000 };
  // Sin dinero real: peso = SIM_WEIGHT (0.6), el simulado aporta todo el volumen.
  const zero = SF.combine({}, sim, {});
  assert.ok(Math.abs(zero.peso - SF.SIM_WEIGHT) < 1e-9);
  assert.ok(Math.abs(zero.stakes.home - 2000 * SF.SIM_WEIGHT) < 1e-6);
  // Con mucho dinero real: el peso se desploma y manda el real.
  const many = SF.combine({ home: 40000, draw: 0, away: 0 }, sim, {});
  const shareHome = many.stakes.home / (many.stakes.home + many.stakes.draw + many.stakes.away);
  assert.ok(shareHome > 0.95, 'el dinero real domina por completo');
});

test('T18: el flujo simulado no mueve fichas ni toca un perfil', () => {
  // distribute/combine son puros: no reciben perfiles ni stores, solo números.
  const before = JSON.stringify(PROBS);
  SF.distribute(MATCH, '1x2', PROBS, {});
  SF.combine({ home: 100 }, SF.distribute(MATCH, '1x2', PROBS, {}), {});
  assert.strictEqual(JSON.stringify(PROBS), before, 'no muta las probabilidades de entrada');
  // El generador con caché tampoco llama a credit/debit: solo acumula contadores.
  const logs = [];
  const flow = new SF.SimulatedFlow({ log: (code, data) => logs.push({ code, data }) });
  flow.stakesFor(MATCH, '1x2', PROBS, {});
  assert.ok(flow.totalForMatch(MATCH.id) > 0, 'acumula un total por partido (para /healthz)');
  assert.ok(logs.some(l => l.code === 'football_simulated_flow'), 'registra el aporte en auditoría');
});

// --- Cadencia: los simulados apuestan poco a poco hasta el saque inicial ---

const HOUR = 60 * 60 * 1000;
const KICKOFF = Date.UTC(2026, 10, 12, 19, 0, 0);
const TIMED = { ...MATCH, scheduledKickoffAt: KICKOFF };
const sumOf = stakes => Object.values(stakes).reduce((a, b) => a + b, 0);

test('schedule reparte EXACTAMENTE el libro de cierre en aportes enteros dentro de la ventana', () => {
  const plan = SF.schedule(TIMED, '1x2', PROBS);
  const closing = SF.distribute(TIMED, '1x2', PROBS, {});
  assert.deepStrictEqual(plan.closing, closing, 'el cierre es el libro de siempre');
  const bySelection = {};
  for (const bet of plan.bets) {
    assert.ok(Number.isInteger(bet.stake) && bet.stake >= 1, `aporte sin fichas enteras: ${JSON.stringify(bet)}`);
    assert.ok(bet.at >= plan.opensAt && bet.at <= plan.closesAt, 'aporte fuera de la ventana');
    bySelection[bet.selection] = (bySelection[bet.selection] || 0) + bet.stake;
  }
  assert.deepStrictEqual(bySelection, closing, 'los aportes suman el cierre, selección por selección');
  assert.strictEqual(plan.closesAt, KICKOFF);
  assert.strictEqual(plan.opensAt, KICKOFF - SF.WINDOW_MS);
  assert.deepStrictEqual(plan.bets.map(b => b.at), plan.bets.map(b => b.at).slice().sort((a, b) => a - b), 'ordenados por hora');
  // Mismo seed → mismo calendario; otro seed u otro mercado → otro.
  assert.deepStrictEqual(SF.schedule(TIMED, '1x2', PROBS), plan);
  assert.notDeepStrictEqual(SF.schedule({ ...TIMED, seed: 99 }, '1x2', PROBS).bets, plan.bets);
  // El 1X2 es el mercado principal: recibe más boletos que cualquier otro.
  const secondary = SF.schedule(TIMED, 'over_under_2.5', { over: 0.52, under: 0.48 });
  assert.ok(plan.bets.length > secondary.bets.length, `${plan.bets.length} aportes en 1X2 frente a ${secondary.bets.length}`);
  assert.ok(secondary.bets.length >= SF.APORTES_MIN - 1, 'un mercado secundario también recibe aportes');
});

test('schedule concentra el dinero hacia el saque inicial y se desplaza con el partido', () => {
  let lastHour = 0, firstHalf = 0, total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const plan = SF.schedule({ ...TIMED, seed }, '1x2', PROBS);
    for (const bet of plan.bets) {
      total += 1;
      if (bet.at > KICKOFF - HOUR) lastHour += 1;
      if (bet.at <= KICKOFF - SF.WINDOW_MS / 2) firstHalf += 1;
    }
  }
  // Reparto uniforme en 12 h: 8 % en la última hora y 50 % en la primera mitad.
  assert.ok(lastHour / total > 0.2, `solo ${(lastHour / total * 100).toFixed(1)} % en la última hora`);
  assert.ok(firstHalf / total < 0.4, `${(firstHalf / total * 100).toFixed(1)} % en la primera mitad`);
  assert.ok(firstHalf > 0, 'también llega dinero temprano: la cuota se mueve desde que abre la ventana');
  // Reprogramar el partido desplaza el calendario entero, sin cambiar los aportes.
  const plan = SF.schedule(TIMED, '1x2', PROBS);
  const later = SF.schedule({ ...TIMED, scheduledKickoffAt: KICKOFF + HOUR }, '1x2', PROBS);
  assert.deepStrictEqual(later.bets, plan.bets.map(bet => ({ ...bet, at: bet.at + HOUR })));
  // Sin saque inicial o con la ventana apagada no hay calendario: libro fijo.
  assert.deepStrictEqual(SF.schedule(MATCH, '1x2', PROBS).bets, []);
  assert.deepStrictEqual(SF.schedule(TIMED, '1x2', PROBS, { windowMs: 0 }).bets, []);
});

test('ningún aporte es tan grande como para mover solo una cuota más de MAX_APORTE_MOVE', () => {
  const { MONEY_WEIGHT } = require('../lib/football/odds');
  // Un mercado de muchas selecciones con colas largas (marcador exacto): ahí un
  // boleto «normal» sobre una selección improbable movería su cuota un 10 %.
  const longTail = { a: 0.14, b: 0.12, c: 0.11, d: 0.1, e: 0.09, f: 0.08, g: 0.07, h: 0.06, i: 0.05, j: 0.04, k: 0.03, l: 0.02, other: 0.09 };
  for (const [marketKey, probs] of [['1x2', PROBS], ['correct_score', longTail], ['over_under_3.5', { over: 0.27, under: 0.73 }]]) {
    for (let seed = 1; seed <= 25; seed++) {
      const plan = SF.schedule({ ...TIMED, seed }, marketKey, probs);
      for (const bet of plan.bets) {
        const p = probs[bet.selection];
        const move = MONEY_WEIGHT * (bet.stake / plan.total) * (1 - p) / p;
        // +1 ficha de holgura: los boletos son enteros.
        const slack = MONEY_WEIGHT * (1 / plan.total) * (1 - p) / p;
        assert.ok(move <= SF.MAX_APORTE_MOVE + slack + 1e-9,
          `${marketKey}/${bet.selection}: un aporte de ${bet.stake} sobre ${plan.total} movería la cuota un ${(move * 100).toFixed(1)} %`);
      }
    }
  }
});

test('stakesAt va de un libro neutro (apertura) al libro de cierre con volumen constante', () => {
  const plan = SF.schedule(TIMED, '1x2', PROBS);
  const before = SF.stakesAt(plan, PROBS, plan.opensAt - 1);
  assert.strictEqual(before.arrived, 0);
  for (const key of Object.keys(PROBS)) {
    assert.ok(Math.abs(before.stakes[key] / plan.total - PROBS[key]) < 1e-9,
      'antes de la ventana el libro es neutro: no empuja ninguna cuota');
  }
  assert.strictEqual(before.nextAt, plan.bets[0].at);
  let previous = 0;
  for (let step = 0; step <= 48; step++) {
    const at = plan.opensAt + step * (SF.WINDOW_MS / 48);
    const now = SF.stakesAt(plan, PROBS, at);
    assert.ok(Math.abs(sumOf(now.stakes) - plan.total) < 1e-6, 'el volumen sintético no cambia con la hora (T20 intacto)');
    assert.ok(now.arrived >= previous, 'un aporte colocado no se retira');
    assert.strictEqual(now.arrived, plan.bets.filter(bet => bet.at <= at).length);
    previous = now.arrived;
  }
  const closing = SF.stakesAt(plan, PROBS, KICKOFF);
  assert.deepStrictEqual(closing.stakes, SF.distribute(TIMED, '1x2', PROBS, {}), 'en el saque inicial queda el libro de siempre');
  assert.strictEqual(closing.arrived, plan.bets.length);
  assert.strictEqual(closing.nextAt, null);
  assert.deepStrictEqual(SF.stakesAt(plan, PROBS, KICKOFF + HOUR).stakes, closing.stakes, 'y no se mueve después');
});

test('SimulatedFlow: el libro depende solo del seed y de la hora (sobrevive a un reinicio)', () => {
  const at = KICKOFF - 3 * HOUR;
  const a = new SF.SimulatedFlow({});
  const b = new SF.SimulatedFlow({}); // «otro proceso»: no comparte memoria
  assert.deepStrictEqual(a.stakesFor(TIMED, '1x2', PROBS, { now: at }), b.stakesFor(TIMED, '1x2', PROBS, { now: at }));
  assert.notDeepStrictEqual(a.stakesFor(TIMED, '1x2', PROBS, { now: at }), a.stakesFor(TIMED, '1x2', PROBS, { now: KICKOFF }));
  // Preguntar en desorden da lo mismo: no hay estado que avance.
  assert.deepStrictEqual(a.stakesFor(TIMED, '1x2', PROBS, { now: at }), b.stakesFor(TIMED, '1x2', PROBS, { now: at }));
  const closing = SF.distribute(TIMED, '1x2', PROBS, {});
  // Sin reloj (llamadas antiguas) y con la ventana apagada: el libro completo.
  assert.deepStrictEqual(a.stakesFor(TIMED, '1x2', PROBS, {}), closing);
  assert.deepStrictEqual(new SF.SimulatedFlow({ config: { windowMs: 0 } }).stakesFor(TIMED, '1x2', PROBS, { now: at }), closing);
  // En vivo el reloj no interviene: el libro en vivo es fijo, como antes.
  const live = SF.distribute(TIMED, '1x2', PROBS, { inPlay: true });
  assert.deepStrictEqual(a.stakesFor(TIMED, '1x2', PROBS, { inPlay: true, now: at }), live);
});

test('SimulatedFlow: registra y suma cada libro una sola vez aunque se consulte a cada rato', () => {
  const logs = [];
  const flow = new SF.SimulatedFlow({ log: (code, data) => logs.push({ code, data }) });
  for (let step = 0; step < 30; step++) flow.stakesFor(TIMED, '1x2', PROBS, { now: KICKOFF - step * 20 * 60 * 1000 });
  flow.stakesFor(TIMED, '1x2', PROBS, {}); // misma contabilidad por la vía sin reloj
  const closing = SF.distribute(TIMED, '1x2', PROBS, {});
  assert.strictEqual(logs.length, 1, 'un registro de auditoría por mercado, no uno por consulta');
  assert.strictEqual(logs[0].code, 'football_simulated_flow');
  assert.deepStrictEqual(logs[0].data.stakes, closing);
  assert.ok(logs[0].data.aportes > 0 && logs[0].data.closesAt === KICKOFF);
  assert.strictEqual(flow.totalForMatch(TIMED.id), sumOf(closing), 'el total de /healthz no se duplica');
  // Otras probabilidades de apertura (alineación nueva) rehacen el calendario sin volver a sumar.
  flow.stakesFor(TIMED, '1x2', { home: 0.4, draw: 0.3, away: 0.3 }, { now: KICKOFF - HOUR });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(flow.totalForMatch(TIMED.id), sumOf(closing));
  flow.reset(TIMED.id);
  assert.strictEqual(flow.totalForMatch(TIMED.id), 0);
  assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', KICKOFF - HOUR, KICKOFF), null, 'reset olvida el calendario');
});

test('arrivedBetween dice qué mercados pudieron moverse sin recalcular nada', () => {
  const flow = new SF.SimulatedFlow({});
  const plan = SF.schedule(TIMED, '1x2', PROBS);
  // Fuera de la ventana se sabe la respuesta sin tener el calendario en memoria.
  assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', plan.opensAt - 2 * HOUR, plan.opensAt - HOUR), false);
  assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', KICKOFF, KICKOFF + HOUR), false);
  // Dentro, sin haber cotizado el mercado todavía: no se sabe (hay que recalcular).
  assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', KICKOFF - HOUR, KICKOFF), null);
  flow.stakesFor(TIMED, '1x2', PROBS, { now: KICKOFF - HOUR });
  const [first, second] = plan.bets;
  assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', first.at - 1, first.at), true, 'el intervalo incluye su extremo derecho');
  assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', first.at, first.at), false, 'intervalo vacío');
  if (second.at - first.at > 2) {
    assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', first.at, second.at - 1), false, 'entre dos aportes no cambia nada');
  }
  assert.strictEqual(flow.arrivedBetween(TIMED, '1x2', plan.opensAt, KICKOFF), true);
  // Partido reprogramado: el calendario en memoria ya no vale.
  assert.strictEqual(flow.arrivedBetween({ ...TIMED, scheduledKickoffAt: KICKOFF + HOUR }, '1x2', KICKOFF - HOUR, KICKOFF), null);
  // Ventana apagada o partido sin horario: nunca se mueve solo.
  assert.strictEqual(new SF.SimulatedFlow({ config: { windowMs: 0 } }).arrivedBetween(TIMED, '1x2', plan.opensAt, KICKOFF), false);
  assert.strictEqual(flow.arrivedBetween(MATCH, '1x2', 0, KICKOFF), false);
});

test('T19: ningún payload de mercado dirigido al cliente contiene datos del flujo simulado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf19-'));
  const store = new FootballStore(path.join(dir, 'f.json'));
  const month = monthKey();
  store.generateSeason(month);
  const profiles = new ProfileStore(path.join(dir, 'p.json'));
  const flow = new SF.SimulatedFlow({ log: () => {} });
  const betting = createBettingService({ store, profiles, simulatedFlow: flow, log: () => {} });
  const match = store.getMatches(month).find(m => m.status === 'scheduled');

  const market = betting.getMarket(match, '1x2', {});
  // El payload del mercado solo lleva lo que el cliente debe ver.
  const serialized = JSON.stringify(market);
  for (const forbidden of ['sim', 'simulated', 'flow', 'simStakes', 'peso', 'synthetic', 'stake']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()),
      `el payload del mercado filtra "${forbidden}": ${serialized}`);
  }
  // Las selecciones exponen únicamente clave, probabilidad, cuota e implícita.
  for (const sel of market.selections) {
    assert.deepStrictEqual(Object.keys(sel).sort(), ['implied', 'key', 'price', 'prob'].sort(),
      'la selección expone campos de más');
  }
  // El total simulado vive solo en el generador (para /healthz), nunca en el mercado.
  assert.ok(flow.totalForMatch(match.id) > 0);
  assert.ok(!('totalForMatch' in market) && !('simulated' in market));
  try { store.close(); } catch (_) {}
  profiles.saveNow();
  fs.rmSync(dir, { recursive: true, force: true });
});
