'use strict';

// Auditoría de realismo de las cuotas (§10) — el instrumento para comparar lo
// que publica el Estadio con lo que publican las casas de apuestas reales.
//
// Mide dos cosas distintas, porque «cuotas realistas» son dos problemas:
//
//   1. ESTRUCTURA DEL LIBRO (márgenes). Cuánto margen lleva cada mercado. Las
//      casas no usan un margen único: el 1X2 y el hándicap asiático van al 2-5 %
//      (2-3 % en una casa afilada tipo Pinnacle) y el marcador exacto al 15-25 %,
//      porque reparte el margen entre veinte o treinta precios y ninguno se ve
//      caro. Un margen plano del 12 % en marcador exacto no se parece a ninguna
//      casa: es *más barato* que todas.
//
//   2. CALIBRACIÓN DEL MODELO (probabilidades). Antes del margen, el precio sale
//      de la matriz de Poisson-Dixon-Coles: si el modelo espera 2.92 goles por
//      partido y el fútbol real produce 2.76, todas las cuotas de goles, de
//      «ambos marcan» y de marcador exacto quedan corridas aunque el margen sea
//      perfecto.
//
// Los rangos de referencia están documentados en docs/estadio-cuotas-realistas.md
// con su fuente. El módulo es PURO: no toca fichas, ni perfiles, ni el store.

const { matchContextFor } = require('./match-context');
const { buildPreMatchMarkets } = require('./odds');

// [min, max] de overround por mercado, según lo que publican las casas reales.
// `ideal` es el punto medio de la banda competitiva (no de la casa afilada).
const REAL_WORLD_MARGINS = {
  '1x2':               { min: 0.02, max: 0.08, ideal: 0.055, label: '1X2' },
  double_chance:       { min: 0.03, max: 0.08, ideal: 0.055, label: 'Doble oportunidad', divide: 2 },
  handicap_home_minus1: { min: 0.04, max: 0.07, ideal: 0.055, label: 'Hándicap europeo -1' },
  handicap_home_plus1: { min: 0.04, max: 0.07, ideal: 0.055, label: 'Hándicap europeo +1' },
  'over_under_1.5':      { min: 0.04, max: 0.06, ideal: 0.05, label: 'Altas/bajas 1.5' },
  'over_under_2.5':      { min: 0.04, max: 0.06, ideal: 0.05, label: 'Altas/bajas 2.5' },
  'over_under_3.5':      { min: 0.04, max: 0.07, ideal: 0.055, label: 'Altas/bajas 3.5' },
  btts:                { min: 0.04, max: 0.08, ideal: 0.06, label: 'Ambos marcan' },
  win_to_nil_home:     { min: 0.05, max: 0.09, ideal: 0.07, label: 'Gana a cero (local)' },
  win_to_nil_away:     { min: 0.05, max: 0.09, ideal: 0.07, label: 'Gana a cero (visita)' },
  'team_total_home_0.5': { min: 0.05, max: 0.08, ideal: 0.065, label: 'Goles del local 0.5' },
  'team_total_home_1.5': { min: 0.05, max: 0.08, ideal: 0.065, label: 'Goles del local 1.5' },
  'team_total_away_0.5': { min: 0.05, max: 0.08, ideal: 0.065, label: 'Goles de la visita 0.5' },
  'team_total_away_1.5': { min: 0.05, max: 0.08, ideal: 0.065, label: 'Goles de la visita 1.5' },
  correct_score:       { min: 0.15, max: 0.25, ideal: 0.18, label: 'Marcador exacto' }
};

// Bandas de calibración del modelo, medidas sobre ligas reales (2025/26, cinco
// grandes ligas europeas). `mean` es el centro de gravedad de la banda.
const REAL_WORLD_DISTRIBUTION = {
  homeWin:    { min: 0.38, max: 0.48, ideal: 0.44, label: 'Victorias locales' },
  draw:       { min: 0.23, max: 0.28, ideal: 0.25, label: 'Empates' },
  awayWin:    { min: 0.27, max: 0.36, ideal: 0.31, label: 'Victorias visitantes' },
  goalsPerMatch: { min: 2.55, max: 2.90, ideal: 2.75, label: 'Goles por partido', unit: 'goals' },
  over25:     { min: 0.47, max: 0.56, ideal: 0.52, label: 'Altas 2.5' },
  btts:       { min: 0.47, max: 0.56, ideal: 0.52, label: 'Ambos marcan' }
};

function verdictFor(value, band) {
  if (!Number.isFinite(value) || !band) return 'sin_datos';
  if (value < band.min - 1e-9) return 'bajo';
  if (value > band.max + 1e-9) return 'alto';
  return 'en_banda';
}

// Margen equivalente de un mercado publicado. Los mercados de selecciones
// excluyentes suman 1+margen; la doble oportunidad publica tres pares que cubren
// cada resultado dos veces, así que su suma es 2·(1+margen).
function marketMargin(market) {
  if (!market || !Array.isArray(market.selections) || !market.selections.length) return null;
  const sum = market.selections.reduce((acc, s) => acc + (Number(s.implied) || 0), 0);
  const divisor = market.independent ? 2 : 1;
  return { overround: sum, margin: sum / divisor - 1 };
}

function distributionFor(context, markets = null) {
  const { matrix, lambdas } = context;
  const built = markets || buildPreMatchMarkets(matrix);
  const oneXtwo = built['1x2'];
  const byKey = Object.fromEntries(oneXtwo.selections.map(s => [s.key, s.prob]));
  const over = built['over_under_2.5'].selections.find(s => s.key === 'over');
  const btts = built.btts.selections.find(s => s.key === 'yes');
  return {
    homeWin: byKey.home,
    draw: byKey.draw,
    awayWin: byKey.away,
    goalsPerMatch: lambdas.lambdaHome + lambdas.lambdaAway,
    over25: over ? over.prob : null,
    btts: btts ? btts.prob : null
  };
}

// Recorre todos los partidos regulares de una temporada y devuelve:
//   · margins:     estadística de margen por mercado (min/media/max + veredicto)
//   · distribution: medias del modelo (1X2, goles, altas 2.5, ambos marcan)
//   · findings:    lista legible de desviaciones con la corrección propuesta
function auditSeason(store, seasonMonth, options = {}) {
  const league = store && store.getLeague ? store.getLeague(seasonMonth) : null;
  if (!league) return { seasonMonth, matches: 0, margins: {}, distribution: null, findings: [] };
  const matches = store.getMatches(seasonMonth).filter(m => m && !m.desempate);
  const bands = { ...REAL_WORLD_MARGINS, ...(options.marginBands || {}) };
  const distBands = { ...REAL_WORLD_DISTRIBUTION, ...(options.distributionBands || {}) };

  const acc = {};
  const dist = { homeWin: 0, draw: 0, awayWin: 0, goalsPerMatch: 0, over25: 0, btts: 0, n: 0 };

  for (const match of matches) {
    const context = matchContextFor(store, match);
    if (!context) continue;
    const markets = buildPreMatchMarkets(context.matrix, options.buildOptions || {});
    for (const key of Object.keys(markets)) {
      const measured = marketMargin({ ...markets[key], independent: Boolean(markets[key].independent) });
      if (!measured) continue;
      const market = markets[key];
      const row = acc[key] = acc[key] || { sum: 0, n: 0, min: Infinity, max: -Infinity, selections: 0, prices: [] };
      row.sum += measured.margin;
      row.n += 1;
      row.min = Math.min(row.min, measured.margin);
      row.max = Math.max(row.max, measured.margin);
      row.selections = market.selections.length;
      for (const s of market.selections) row.prices.push(s.price);
    }
    const d = distributionFor(context, markets);
    dist.homeWin += d.homeWin; dist.draw += d.draw; dist.awayWin += d.awayWin;
    dist.goalsPerMatch += d.goalsPerMatch;
    dist.over25 += d.over25 || 0; dist.btts += d.btts || 0;
    dist.n += 1;
  }

  const margins = {};
  for (const key of Object.keys(acc)) {
    const row = acc[key];
    const mean = row.sum / row.n;
    const band = bands[key] || null;
    margins[key] = {
      label: band ? band.label : key,
      matches: row.n,
      selections: row.selections,
      meanMargin: Number(mean.toFixed(5)),
      minMargin: Number(row.min.toFixed(5)),
      maxMargin: Number(row.max.toFixed(5)),
      priceMin: Math.min(...row.prices),
      priceMax: Math.max(...row.prices),
      band: band ? [band.min, band.max] : null,
      ideal: band ? band.ideal : null,
      verdict: band ? verdictFor(mean, band) : 'sin_banda'
    };
  }

  const n = dist.n || 1;
  const distribution = {
    matches: dist.n,
    homeWin: Number((dist.homeWin / n).toFixed(4)),
    draw: Number((dist.draw / n).toFixed(4)),
    awayWin: Number((dist.awayWin / n).toFixed(4)),
    goalsPerMatch: Number((dist.goalsPerMatch / n).toFixed(3)),
    over25: Number((dist.over25 / n).toFixed(4)),
    btts: Number((dist.btts / n).toFixed(4)),
    bands: Object.fromEntries(Object.entries(distBands).map(([key, band]) => [key, {
      label: band.label, min: band.min, max: band.max,
      verdict: verdictFor(distributionValue(dist, n, key), band)
    }]))
  };

  const findings = [];
  for (const [key, row] of Object.entries(margins)) {
    if (row.verdict === 'bajo') {
      findings.push({
        kind: 'margen_bajo', market: key, label: row.label,
        value: row.meanMargin, band: row.band, ideal: row.ideal,
        fix: `Subir el margen de ${row.label} de ${(row.meanMargin * 100).toFixed(1)} % a ~${(row.ideal * 100).toFixed(1)} %: ninguna casa lo publica tan barato.`
      });
    } else if (row.verdict === 'alto') {
      findings.push({
        kind: 'margen_alto', market: key, label: row.label,
        value: row.meanMargin, band: row.band, ideal: row.ideal,
        fix: `Bajar el margen de ${row.label} de ${(row.meanMargin * 100).toFixed(1)} % a ~${(row.ideal * 100).toFixed(1)} %: por encima del techo de las casas recreativas.`
      });
    }
  }
  for (const [key, band] of Object.entries(distBands)) {
    const value = distributionValue(dist, n, key);
    const verdict = verdictFor(value, band);
    if (verdict === 'sin_datos' || verdict === 'en_banda') continue;
    findings.push({
      kind: 'calibracion', metric: key, label: band.label,
      value: Number(value.toFixed(4)), band: [band.min, band.max], ideal: band.ideal,
      fix: `${band.label}: ${formatMetric(value, band)} frente a ${formatMetric(band.ideal, band)} del fútbol real`
        + (value > band.max ? ' — el modelo está cargado.' : ' — el modelo se queda corto.')
    });
  }

  return { seasonMonth, matches: dist.n, margins, distribution, findings };
}

// Los goles por partido se leen en goles (2,94), no en porcentaje.
function formatMetric(value, band) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  return band && band.unit === 'goals' ? Number(value).toFixed(2) : `${(Number(value) * 100).toFixed(1)} %`;
}

function distributionValue(dist, n, key) {
  if (key === 'goalsPerMatch') return dist.goalsPerMatch / n;
  return dist[key] == null ? NaN : dist[key] / n;
}

module.exports = {
  REAL_WORLD_MARGINS, REAL_WORLD_DISTRIBUTION,
  marketMargin, distributionFor, auditSeason, verdictFor, formatMetric
};
