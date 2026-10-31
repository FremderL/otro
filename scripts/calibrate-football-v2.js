'use strict';

// Herramienta offline y de solo lectura. Los resultados son una investigación,
// no habilitan apuestas ni constituyen una aprobación para producción.
const fs = require('node:fs');
const { buildSeasonClubs } = require('../lib/football/teams');
const { hash32, mulberry32 } = require('../lib/football/prng');
const { FootballStore } = require('../lib/football-store');
const { previousMonth, prepareMatchInputs } = require('../lib/football/v2/inputs');
const { createCalibration, probabilities, validateCalibration, validateLiveCalibration, MIN_TRAIN, MIN_HOLDOUT } = require('../lib/football/v2/calibration');
const { createQuoteModel, preMatchMarkets, liveMarket } = require('../lib/football/v2/quotes');
const { resolveSelection } = require('../lib/football/betting');

function parseArgs(args) {
  const options = { samples: MIN_TRAIN, season: '2026-11' };
  for (const arg of args) {
    if (arg === '--demo') options.demo = true;
    else if (arg.startsWith('--samples=')) options.samples = Number(arg.slice(10));
    else if (arg.startsWith('--season=')) options.season = arg.slice(9);
    else if (arg.startsWith('--match=')) options.match = arg.slice(8);
    else if (arg.startsWith('--data=')) options.data = arg.slice(7);
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > 50000) throw new Error('Muestra inválida');
  if (Boolean(options.demo) === Boolean(options.data)) throw new Error('Indica --demo o --data=<archivo>, no ambos');
  return options;
}

function makeInput(options) {
  if (options.demo) {
    const clubs = buildSeasonClubs(mulberry32(hash32(`${options.season}plantillas`)));
    const league = { seasonMonth: options.season, config: clubs, calendar: { matches: [] } };
    const match = { seasonMonth: options.season, homeId: clubs[0].id, awayId: clubs[1].id };
    return { input: prepareMatchInputs({ league, match, asOf: Date.now(), seed: 0 }), synthetic: true };
  }
  if (!fs.existsSync(options.data)) throw new Error('No existe el archivo de datos indicado');
  const store = new FootballStore(options.data); // load() no escribe; no se llama close().
  const league = store.getLeague(options.season);
  if (!league) throw new Error('Temporada no encontrada en el archivo');
  const match = options.match
    ? league.calendar?.matches?.find(item => item.id === options.match)
    : league.calendar?.matches?.find(item => item.status === 'scheduled');
  if (!match) throw new Error('Partido programado no encontrado');
  const previousLeague = store.getLeague(previousMonth(options.season));
  return { input: prepareMatchInputs({ league, previousLeague, match, asOf: Date.now(), seed: 0 }), synthetic: false };
}

// Retorno observado en una muestra independiente. El margen teórico del libro
// no garantiza que todos los precios tengan ventaja económica fuera de muestra.
function economicReport(input, training, holdout) {
  const model = createQuoteModel(input, 'ef'.repeat(32), training, holdout);
  const markets = preMatchMarkets(model);
  const comparisons = [];
  for (const [market, book] of Object.entries(markets)) {
    if (!book || book.degenerate) continue;
    const correctScoreCells = market === 'correct_score' ? book.selections.filter(item => item.key !== 'other').map(item => item.key) : [];
    for (const selection of book.selections) {
      let returned = 0;
      for (const [key, count] of Object.entries(holdout.counts)) {
        const [home, away] = key.split('-').map(Number);
        const status = resolveSelection(market, selection.key, { home, away }, { correctScoreCells });
        if (status === 'won') returned += count * selection.price;
        else if (status === 'void') returned += count;
      }
      comparisons.push({ market, selection: selection.key, price: selection.price,
        observedPlayerReturn: Number((returned / holdout.samples - 1).toFixed(4)) });
    }
  }
  comparisons.sort((a, b) => b.observedPlayerReturn - a.observedPlayerReturn);
  let observedStates = 0, supportedStates = 0;
  for (const [minute, states] of (training.liveByState || []).entries()) {
    for (const [key, counts] of Object.entries(states)) {
      const match = /^(\d+)-(\d+)\|([12])\|(\d+)-(\d+)$/.exec(key);
      if (!match) continue;
      const count = counts.home + counts.draw + counts.away;
      observedStates += count;
      const state = { minute, score: { home: Number(match[1]), away: Number(match[2]) }, half: Number(match[3]),
        redCards: { home: Number(match[4]), away: Number(match[5]) }, playStopped: false };
      if (validateLiveCalibration(training, holdout, state).ok && liveMarket(model, '1x2', state)) supportedStates += count;
    }
  }
  return { selections: comparisons.length, positiveReturnSelections: comparisons.filter(item => item.observedPlayerReturn > 0).length,
    worstObserved: comparisons.slice(0, 10), liveStateCoverage: observedStates ? Number((supportedStates / observedStates).toFixed(4)) : 0,
    disclaimer: 'Solo referencia estadística: no incluye flujo, exposición, incertidumbre, cash-out ni múltiples partidos.' };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { input, synthetic } = makeInput(options);
  const started = Date.now();
  console.error(`Muestreando ${options.samples} partidos de calibración y ${options.samples} independientes de control...`);
  const training = createCalibration(input, '31'.repeat(32), options.samples);
  console.error('Primera muestra terminada; iniciando control independiente...');
  const holdout = createCalibration(input, '93'.repeat(32), options.samples);
  const validation = validateCalibration(training, holdout);
  console.log(JSON.stringify({
    mode: synthetic ? 'sintetico' : 'archivo_solo_lectura',
    match: { home: input.home.name, away: input.away.name },
    history: input.source, samplesPerGroup: options.samples,
    minimum: { training: MIN_TRAIN, holdout: MIN_HOLDOUT },
    training: probabilities(training), holdout: probabilities(holdout), validation,
    economicExploration: economicReport(input, training, holdout),
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
    notice: 'Esta prueba exploratoria no certifica los mercados, Balón de Oro, privacidad operacional ni despliegue.'
  }, null, 2));
  if (!validation.ok) process.exitCode = 2;
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
