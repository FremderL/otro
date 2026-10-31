#!/usr/bin/env node
'use strict';

// `npm run football:odds-audit` — ¿se parecen nuestras cuotas a las de una casa?
//
// Imprime, para una temporada, el margen medio de cada mercado frente a la banda
// que publican las casas reales, la calibración del modelo (1X2, goles, altas,
// ambos marcan) y la lista de desviaciones con la corrección propuesta.
//
// Usa un store temporal: nunca abre ni escribe el archivo de la temporada real.
//
//   npm run football:odds-audit
//   npm run football:odds-audit -- --season 2026-11
//   npm run football:odds-audit -- --json
//   npm run football:odds-audit -- --margins          # solo márgenes
//
// Detalle del método y de las fuentes: docs/estadio-cuotas-realistas.md

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { createOfficialV2 } = require('../lib/football/v2/official');
const { auditSeason, formatMetric, REAL_WORLD_DISTRIBUTION } = require('../lib/football/odds-audit');

function parseArgs(argv) {
  const args = { season: null, json: false, margins: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--margins') args.margins = true;
    else if (arg === '--season') args.season = argv[++i];
    else if (arg.startsWith('--season=')) args.season = arg.split('=')[1];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function currentSeasonMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit'
  }).format(new Date());
  return parts; // «2026-10»
}

function pct(value, digits = 2) {
  return `${(Number(value) * 100).toFixed(digits)} %`;
}

function verdictLabel(verdict) {
  if (verdict === 'en_banda') return 'en banda';
  if (verdict === 'alto') return 'ALTO';
  if (verdict === 'bajo') return 'BAJO';
  return 'sin datos';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Uso: npm run football:odds-audit -- [--season 2026-11] [--json] [--margins]');
    return;
  }
  const season = args.season || currentSeasonMonth();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuotas-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  let report;
  try {
    store.generateSeason(season, { createdAt: Date.now() });
    // La auditoría temporal también respeta la política oficial de V2; no
    // presenta Poisson V1 como si fueran cuotas de la temporada nueva.
    const officialV2 = createOfficialV2({ store });
    report = auditSeason(store, season, { officialV2, at: Date.now() });
  } finally {
    try { store.close(); } catch (_) { /* el store temporal se borra igual */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const { margins, distribution, findings } = report;
  console.log(`\nCuotas del Estadio · temporada ${season} · ${report.matches} partidos\n`);

  console.log('MERCADO                  MARGEN MEDIO   BANDA REAL      VEREDICTO');
  console.log('─'.repeat(72));
  const rows = Object.entries(margins).sort((a, b) => b[1].meanMargin - a[1].meanMargin);
  for (const [, row] of rows) {
    const band = row.band ? `[${pct(row.band[0], 1)}–${pct(row.band[1], 1)}]` : '—';
    console.log(
      `${row.label.padEnd(24)} ${pct(row.meanMargin).padStart(12)}   ${band.padEnd(14)}  ${verdictLabel(row.verdict)}`
    );
  }

  if (!args.margins && distribution) {
    console.log('\nCALIBRACIÓN DEL MODELO       VALOR     FÚTBOL REAL    VEREDICTO');
    console.log('─'.repeat(72));
    const order = ['homeWin', 'draw', 'awayWin', 'goalsPerMatch', 'over25', 'btts'];
    for (const key of order) {
      const band = distribution.bands[key];
      if (!band) continue;
      const realBand = REAL_WORLD_DISTRIBUTION[key];
      const value = distribution[key];
      const ideal = realBand ? formatMetric(realBand.ideal, realBand) : '—';
      console.log(
        `${band.label.padEnd(27)} ${formatMetric(value, realBand).padStart(8)}   ${ideal.padEnd(12)}  ${verdictLabel(band.verdict)}`
      );
    }
  }

  if (findings.length) {
    console.log(`\nDESVIACIONES (${findings.length})`);
    for (const finding of findings) console.log(` · ${finding.fix}`);
  } else {
    console.log('\nSin desviaciones: márgenes y calibración dentro de las bandas reales.');
  }
  console.log('\nMétodo y fuentes: docs/estadio-cuotas-realistas.md\n');
}

main();
