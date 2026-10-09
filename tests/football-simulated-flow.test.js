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
