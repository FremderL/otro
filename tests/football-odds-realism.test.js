'use strict';

// Auditoría de realismo de cuotas (§10): el instrumento que compara lo que
// publica el Estadio con lo que publican las casas reales.
//
// Se comprueba el mecanismo (medición, bandas, veredictos y hallazgos) y no los
// números concretos de hoy: si mañana se cambia un margen, la auditoría debe
// seguir midiendo bien, y lo que cambia es el veredicto.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { matchContextFor } = require('../lib/football/match-context');
const {
  auditSeason, marketMargin, distributionFor, verdictFor, formatMetric,
  REAL_WORLD_MARGINS, REAL_WORLD_DISTRIBUTION
} = require('../lib/football/odds-audit');
const O = require('../lib/football/odds');

const SEASON = '2026-11';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-realism-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  store.generateSeason(SEASON, { createdAt: Date.now() });
  const cleanup = () => {
    try { store.close(); } catch (_) { /* ya cerrado */ }
    try { profiles.saveNow(); } catch (_) { /* opcional */ }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, profiles, cleanup };
}

test('el contexto de precio es uno solo: cuotas y auditoría pintan el mismo partido', () => {
  const h = harness();
  try {
    const match = h.store.getMatches(SEASON).find(m => m.jornada === 3);
    const betting = createBettingService({ store: h.store, profiles: h.profiles, now: () => Date.now(), log: () => {} });
    const fromBetting = betting.getMatchContext(match);
    const fromAudit = matchContextFor(h.store, match);
    assert.ok(fromBetting && fromAudit);
    assert.deepEqual(fromBetting.lambdas, fromAudit.lambdas);
    assert.deepEqual(fromBetting.matrix, fromAudit.matrix, 'la matriz de precio es la misma para los dos');
  } finally {
    h.cleanup();
  }
});

test('el margen medido respeta el divisor de los mercados que se solapan', () => {
  const h = harness();
  try {
    const match = h.store.getMatches(SEASON).find(m => m.jornada === 3);
    const markets = O.buildPreMatchMarkets(matchContextFor(h.store, match).matrix);
    const oneXtwo = marketMargin(markets['1x2']);
    assert.ok(Math.abs(oneXtwo.overround - markets['1x2'].overround) < 1e-4, 'el overround medido es el publicado');
    assert.ok(Math.abs(oneXtwo.margin - O.MARGINS['1x2']) < 0.005, 'el 1X2 va con su margen configurado');

    // La doble oportunidad publica tres pares que cubren cada resultado dos
    // veces: su suma es 2·(1+margen), no (1+margen).
    const dc = marketMargin({ ...markets.double_chance, independent: true });
    assert.ok(dc.overround > 1.9, 'la suma bruta pasa de 1.9');
    assert.ok(Math.abs(dc.margin - O.MARGINS.double_chance) < 0.006, 'y el margen normalizado es el configurado');
  } finally {
    h.cleanup();
  }
});

test('ningún mercado baja de su piso anti-arbitraje', () => {
  // El piso es por mercado: 4 % general y 2 % en el hándicap asiático, cuyo margen
  // real (2,5 %) es más fino que el piso general. En ambos casos el libro tiene
  // margen positivo: nunca es arbitrable.
  const h = harness();
  try {
    const matches = h.store.getMatches(SEASON).slice(0, 24);
    for (const match of matches) {
      const markets = O.buildPreMatchMarkets(matchContextFor(h.store, match).matrix);
      for (const [key, market] of Object.entries(markets)) {
        const floor = String(key).startsWith('asian_handicap') ? O.ASIAN_MIN_MARGIN : O.MIN_MARGIN;
        const measured = marketMargin({ ...market, independent: Boolean(market.independent) });
        assert.ok(measured.margin >= floor - 0.002, `${match.id} ${key} por debajo del piso (${measured.margin})`);
      }
    }
  } finally {
    h.cleanup();
  }
});

test('auditSeason mide todos los mercados publicados y devuelve veredicto y banda', () => {
  const h = harness();
  try {
    const report = auditSeason(h.store, SEASON);
    assert.equal(report.matches, 240, 'audita los 240 partidos regulares');
    for (const key of ['1x2', 'btts', 'correct_score', 'over_under_2.5', 'double_chance']) {
      const row = report.margins[key];
      assert.ok(row, `falta el mercado ${key}`);
      assert.ok(row.matches === 240);
      assert.ok(Number.isFinite(row.meanMargin));
      assert.ok(Array.isArray(row.band) && row.band.length === 2);
      assert.ok(['en_banda', 'alto', 'bajo', 'sin_banda'].includes(row.verdict));
      assert.ok(row.priceMax > row.priceMin, 'hay rango de precios');
    }
    // El margen configurado del 1X2 se mide tal cual (±0,2 pp).
    assert.ok(Math.abs(report.margins['1x2'].meanMargin - O.MARGINS['1x2']) < 0.002);
    assert.ok(report.distribution.matches === 240);
    for (const key of ['homeWin', 'draw', 'awayWin', 'goalsPerMatch', 'over25', 'btts']) {
      assert.ok(Number.isFinite(report.distribution[key]), `falta ${key}`);
    }
    const total = report.distribution.homeWin + report.distribution.draw + report.distribution.awayWin;
    assert.ok(Math.abs(total - 1) < 0.01, 'las tres probabilidades del 1X2 suman 1');
  } finally {
    h.cleanup();
  }
});

test('con bandas inyectadas la auditoría señala la desviación y propone la corrección', () => {
  const h = harness();
  try {
    const report = auditSeason(h.store, SEASON, {
      marginBands: { '1x2': { min: 0.10, max: 0.12, ideal: 0.11, label: '1X2' } },
      distributionBands: { goalsPerMatch: { min: 3.4, max: 3.8, ideal: 3.6, label: 'Goles por partido', unit: 'goals' } }
    });
    assert.equal(report.margins['1x2'].verdict, 'bajo');
    const marginFinding = report.findings.find(f => f.kind === 'margen_bajo' && f.market === '1x2');
    assert.ok(marginFinding, 'se informa del margen por debajo de la banda');
    assert.match(marginFinding.fix, /11\.0 %/);
    const calibration = report.findings.find(f => f.kind === 'calibracion' && f.metric === 'goalsPerMatch');
    assert.ok(calibration, 'se informa de la calibración de goles');
    assert.match(calibration.fix, /frente a 3\.60/);
    assert.equal(verdictFor(0.5, { min: 0.2, max: 0.4 }), 'alto');
    assert.equal(verdictFor(NaN, { min: 0.2, max: 0.4 }), 'sin_datos');
  } finally {
    h.cleanup();
  }
});

test('las bandas reales son coherentes y los goles se leen en goles, no en porcentaje', () => {
  assert.ok(REAL_WORLD_MARGINS['1x2'].min < REAL_WORLD_MARGINS['1x2'].ideal);
  assert.ok(REAL_WORLD_MARGINS['1x2'].ideal < REAL_WORLD_MARGINS['1x2'].max);
  assert.ok(REAL_WORLD_MARGINS.correct_score.min >= REAL_WORLD_MARGINS['1x2'].max,
    'el marcador exacto es siempre más caro que el 1X2');
  assert.ok(REAL_WORLD_MARGINS.correct_score.min >= 0.15, 'las casas no venden marcador exacto por debajo del 15 %');
  assert.equal(formatMetric(2.75, REAL_WORLD_DISTRIBUTION.goalsPerMatch), '2.75');
  assert.equal(formatMetric(0.44, REAL_WORLD_DISTRIBUTION.homeWin), '44.0 %');
  assert.equal(formatMetric(null, REAL_WORLD_DISTRIBUTION.homeWin), '—');
});

test('la distribución del modelo se calcula sobre la misma matriz que publica las cuotas', () => {
  const h = harness();
  try {
    const match = h.store.getMatches(SEASON).find(m => m.jornada === 5);
    const context = matchContextFor(h.store, match);
    const dist = distributionFor(context);
    const oneXtwo = O.prob1x2(context.matrix);
    assert.ok(Math.abs(dist.homeWin - oneXtwo.home) < 1e-5, 'misma probabilidad local');
    assert.ok(Math.abs(dist.draw - oneXtwo.draw) < 1e-5, 'misma probabilidad de empate');
    assert.ok(Math.abs(dist.goalsPerMatch - (context.lambdas.lambdaHome + context.lambdas.lambdaAway)) < 1e-9);
    assert.ok(dist.over25 > 0 && dist.over25 < 1);
    assert.ok(dist.btts > 0 && dist.btts < 1);
  } finally {
    h.cleanup();
  }
});
