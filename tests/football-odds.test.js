'use strict';

// Fase D — Pruebas del motor de cuotas (§10, §20: T2, T3, T22).
//
// Cubre: margen y overround, invariante anti-arbitraje bajo peso del dinero,
// ventaja real medida, derivación de mercados desde la matriz Dixon-Coles,
// redondeo de libro, movimiento por responsabilidad con sus topes, cuotas en
// vivo y cash-out. odds.js es puro: aquí no se mueve una sola ficha.

const { test } = require('node:test');
const assert = require('node:assert');

const { scoreMatrix, RHO } = require('../lib/football/match-engine');
const O = require('../lib/football/odds');

const M = (lh, la) => scoreMatrix(lh, la, RHO);

test('T2: Σ 1/cuota == 1 + margen en mercados de partición', () => {
  // 1X2 sobre una parrilla de λ: el overround publicado debe quedar pegado al
  // objetivo. El redondeo de libro (pasos 0.05/0.10 en cuotas altas) impide el
  // ±0.001 ideal; se acota a ±0.005 y SIEMPRE por encima del piso anti-arbitraje.
  let maxDev = 0, minOR = Infinity;
  for (let lh = 0.6; lh <= 3.0; lh += 0.2) {
    for (let la = 0.6; la <= 3.0; la += 0.2) {
      const mk = O.publishMarket(O.prob1x2(M(lh, la)), O.MARGINS['1x2']);
      if (mk.repaired || mk.degenerate) continue;
      maxDev = Math.max(maxDev, Math.abs(mk.overround - (1 + O.MARGINS['1x2'])));
      minOR = Math.min(minOR, mk.overround);
    }
  }
  assert.ok(maxDev <= 0.005, `desviación del overround demasiado grande: ${maxDev}`);
  assert.ok(minOR >= 1 + O.MIN_MARGIN - 1e-9, `overround bajo el piso: ${minOR}`);
});

test('T2: el precio justo antes de redondear suma exactamente 1 + margen', () => {
  const probs = O.prob1x2(M(1.6, 1.1));
  const margin = O.MARGINS['1x2'];
  // Σ p_k · (1 + margen) == 1 + margen cuando Σ p_k == 1 (construcción exacta).
  const sum = Object.values(probs).reduce((a, p) => a + p * (1 + margin), 0);
  assert.ok(Math.abs(sum - (1 + margin)) < 1e-9);
});

test('T3: 1.000 apuestas concentradas nunca dejan el libro arbitrable', () => {
  const probs = O.prob1x2(M(1.5, 1.1));
  const open = O.publishMarket(probs, O.MARGINS['1x2']);
  const openPrices = {};
  open.selections.forEach(s => { openPrices[s.key] = s.price; });

  const stakes = { home: 0, draw: 0, away: 0 };
  for (let i = 0; i < 1000; i++) {
    stakes.home += 37; // todo el dinero va al local
    if (i % 50 === 0) stakes.away += 5; // un poco de ruido
    const moved = O.applyMoneyWeight(probs, openPrices, stakes, O.MARGINS['1x2']);
    const or = O.overround(Object.values(moved.prices));
    assert.ok(or >= 1 + O.MIN_MARGIN - 1e-9, `libro arbitrable en la apuesta ${i}: overround ${or}`);
  }
});

test('T3: el peso del dinero baja la cuota de lo muy apostado y respeta el tope ±25 %', () => {
  const probs = O.prob1x2(M(1.5, 1.1));
  const open = O.publishMarket(probs, O.MARGINS['1x2']);
  const openPrices = {};
  open.selections.forEach(s => { openPrices[s.key] = s.price; });
  const homeOpen = openPrices.home;

  const moved = O.applyMoneyWeight(probs, openPrices, { home: 100000, draw: 10, away: 10 }, O.MARGINS['1x2']);
  assert.ok(moved.prices.home < homeOpen, 'la cuota del local debió bajar con tanto dinero encima');
  // Tope acumulado: nunca más de ±25 % respecto de la apertura.
  assert.ok(moved.prices.home >= homeOpen * 0.75 - 0.11, 'se pasó del tope inferior −25 %');
  assert.ok(moved.capped.includes('home'), 'el local debió tocar el tope con esa responsabilidad');
});

test('T22: la ventaja real medida coincide con el margen declarado (7 % → 6,54 %)', () => {
  // EV de apostar 1 al local = P_home · cuota_home; agregado sobre muchos λ da la
  // ventaja real. Con margen m, EV → 1/(1+m) y la ventaja → m/(1+m) = 6,54 %.
  let sumEV = 0, n = 0;
  for (let lh = 0.6; lh <= 3.2; lh += 0.1) {
    for (let la = 0.6; la <= 3.2; la += 0.1) {
      const mk = O.publishMarket(O.prob1x2(M(lh, la)), O.MARGINS['1x2']);
      const home = mk.selections.find(s => s.key === 'home');
      sumEV += home.prob * home.price;
      n++;
    }
  }
  const edge = 1 - sumEV / n;
  assert.ok(Math.abs(edge - 0.0654) < 0.004, `ventaja real ${edge.toFixed(4)} lejos de 0.0654`);
});

test('derivación de mercados: particiones suman 1 y la doble oportunidad suma 2', () => {
  const matrix = M(1.7, 1.0);
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(O.prob1x2(matrix)) - 1) < 1e-9);
  assert.ok(Math.abs(sum(O.probOverUnder(matrix, 2.5)) - 1) < 1e-9);
  assert.ok(Math.abs(sum(O.probBtts(matrix)) - 1) < 1e-9);
  assert.ok(Math.abs(sum(O.probHandicap(matrix, -1)) - 1) < 1e-9);
  assert.ok(Math.abs(sum(O.probCorrectScore(matrix, 12)) - 1) < 1e-6);
  // Doble oportunidad: 1X + 12 + X2 cubren cada resultado dos veces ⇒ suma 2.
  assert.ok(Math.abs(sum(O.probDoubleChance(matrix)) - 2) < 1e-9);
});

test('redondeo de libro: pasos 0.01 / 0.05 / 0.10 y clamp [1.05, 101]', () => {
  assert.strictEqual(O.gridStep(1.5), 0.01);
  assert.strictEqual(O.gridStep(3.0), 0.05);
  assert.strictEqual(O.gridStep(6.0), 0.10);
  assert.strictEqual(O.roundBook(1.234), 1.23);
  assert.strictEqual(O.roundBook(3.37), 3.35);
  assert.strictEqual(O.roundBook(6.27), 6.3);
  assert.strictEqual(O.roundBook(0.5), O.PRICE_MIN);   // clamp inferior
  assert.strictEqual(O.roundBook(500), O.PRICE_MAX);   // clamp superior
});

test('catálogo pre-partido: genera los mercados y la doble oportunidad es independiente', () => {
  const mk = O.buildPreMatchMarkets(M(1.5, 1.1));
  for (const key of ['1x2', 'double_chance', 'over_under_2.5', 'btts', 'correct_score',
    'win_to_nil_home', 'win_to_nil_away', 'team_total_home_1.5', 'handicap_home_minus1']) {
    assert.ok(mk[key], `falta el mercado ${key}`);
  }
  assert.strictEqual(mk.double_chance.independent, true);
  // Ningún mercado publicado es arbitrable.
  for (const key of Object.keys(mk)) {
    const m = mk[key];
    if (m.degenerate) continue;
    if (m.independent) {
      const imp = {}; m.selections.forEach(s => { imp[s.key] = s.implied; });
      for (const oc of ['home', 'draw', 'away']) {
        const cover = O.DOUBLE_CHANCE_COVER[oc].reduce((a, k) => a + imp[k], 0);
        assert.ok(cover >= 1 - 1e-9, `doble oportunidad arbitrable en ${oc}: ${cover}`);
      }
    } else {
      assert.ok(m.overround >= 1 + O.MIN_MARGIN - 1e-9, `${key} arbitrable: ${m.overround}`);
    }
  }
});

test('enforceInvariant repara un libro por debajo del piso o lo marca degenerado', () => {
  // Precios altísimos ⇒ overround bajo el piso; debe reparar bajando cuotas.
  const bad = [50, 50];
  const fixed = O.enforceInvariant(bad, O.MIN_MARGIN);
  assert.ok(fixed.overround >= 1 + O.MIN_MARGIN - 1e-9 || fixed.degenerate,
    'ni reparó ni marcó degenerado');
  // Un libro sano no se toca.
  const good = O.enforceInvariant([1.85, 3.5, 4.2], O.MIN_MARGIN);
  assert.strictEqual(good.repaired, false);
});

test('cuotas en vivo: λ restantes caen con el minuto y el marcador condiciona el 1X2', () => {
  const base = { lambdaHome: 1.5, lambdaAway: 1.1 };
  const early = O.liveLambdas(base, { minute: 10, score: { home: 0, away: 0 }, matchEnd: 90 });
  const late = O.liveLambdas(base, { minute: 80, score: { home: 0, away: 0 }, matchEnd: 90 });
  assert.ok(late.lambdaHome < early.lambdaHome, 'quedan menos goles esperados al minuto 80');

  // Equipo local perdiendo 0-1 ⇒ su λ restante sube (se adelanta) respecto del empate.
  const losing = O.liveLambdas(base, { minute: 60, score: { home: 0, away: 1 }, matchEnd: 90 });
  const level = O.liveLambdas(base, { minute: 60, score: { home: 0, away: 0 }, matchEnd: 90 });
  assert.ok(losing.lambdaHome > level.lambdaHome, 'el local perdiendo ataca más');

  const live = O.publishLive(base, { minute: 60, score: { home: 1, away: 0 }, matchEnd: 90 });
  const home = live.selections.find(s => s.key === 'home');
  assert.ok(home.prob > 0.5, 'ganando 1-0 al 60 el local es favorito');
  assert.ok(live.overround >= 1 + O.MIN_MARGIN - 1e-9, 'libro en vivo arbitrable');
});

test('cash-out: valor esperado del boleto menos el margen, acotado', () => {
  // stake 100 a cuota 2.0, probabilidad actual 0.6 ⇒ valor 120, cash-out 108.
  const co = O.cashoutValue(100, 2.0, 0.6);
  assert.strictEqual(co, 108); // 100·2·0.6·(1−0.10)
  // Nunca por encima del pago potencial (200) ni por debajo de 0.
  assert.ok(O.cashoutValue(100, 2.0, 1.5) <= 200);
  assert.ok(O.cashoutValue(100, 2.0, -0.5) >= 0);
});

test('las probabilidades implícitas se exponen junto a la cuota (transparencia §10.3)', () => {
  const mk = O.publishMarket(O.prob1x2(M(1.6, 1.1)), O.MARGINS['1x2']);
  for (const s of mk.selections) {
    assert.ok(typeof s.implied === 'number' && s.implied > 0 && s.implied < 1,
      `implícita inválida en ${s.key}`);
    assert.ok(Math.abs(s.implied - 1 / s.price) < 1e-3, 'la implícita no coincide con 1/cuota');
  }
});
