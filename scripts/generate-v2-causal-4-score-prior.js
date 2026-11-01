'use strict';

// Generate the small, reproducible score prior used by v2-estimated-2.
// This is an offline synthetic Monte Carlo experiment, not observed bookmaker
// data, production results, or a claim of calibration to real football.
const fs = require('node:fs');
const path = require('node:path');
const { buildSeasonClubs } = require('../lib/football/teams');
const { hash32, mulberry32 } = require('../lib/football/prng');
const { createLineups } = require('../lib/football/match-state');
const simulator = require('../lib/football/v2/simulator');

const FIXTURES = 32;
const REPLICATES_PER_SPLIT = 64;
const SEASON = '2026-11';
const clubs = buildSeasonClubs(mulberry32(hash32(`${SEASON}plantillas`)));
const squad = new Map(clubs.map(club => [club.id, {
  id: club.id, name: club.name, short: club.abbr || club.short, formation: club.tactics.formation,
  ratings: { ...club.ratings }, lineup: createLineups(club, club).home
}]));
function cloneTeam(team, suffix) {
  const id = `${team.id}-${suffix}`;
  const lineup = JSON.parse(JSON.stringify(team.lineup));
  lineup.teamId = id;
  lineup.players.forEach(player => { player.id = `${id}-${player.number}`; });
  return { ...team, id, name: `${team.name} ${suffix}`, short: `${team.short}${suffix}`.slice(0, 5), lineup };
}
const fixtures = [];
for (let i = 0; i < 16; i++) {
  const club = squad.get(clubs[i].id);
  fixtures.push({ home: club, away: cloneTeam(club, 'espejo') });
}
for (let i = 0; i < 16; i++) {
  fixtures.push({ home: squad.get(clubs[i].id), away: squad.get(clubs[(i + 7) % clubs.length].id) });
}
const counts = {}, holdoutCounts = {};
for (let fixture = 0; fixture < FIXTURES; fixture++) {
  const { home, away } = fixtures[fixture];
  for (let replicate = 0; replicate < REPLICATES_PER_SPLIT * 2; replicate++) {
    const seed = hash32(`${simulator.VERSION}|score-prior|${fixture}|${replicate}`);
    const match = simulator.createMatch({ version: simulator.VERSION, seed, context: { leagueAvg: 1.35 }, home, away });
    while (!match.snapshot().ended) match.step(10000);
    const { home: h, away: a } = match.snapshot().score;
    const key = `${h}-${a}`;
    const bucket = replicate < REPLICATES_PER_SPLIT ? counts : holdoutCounts;
    bucket[key] = (bucket[key] || 0) + 1;
  }
}
const samples = Object.values(counts).reduce((sum, count) => sum + count, 0);
const holdoutSamples = Object.values(holdoutCounts).reduce((sum, count) => sum + count, 0);
const rates = histogram => {
  const result = { home: 0, draw: 0, away: 0, goalsHome: 0, goalsAway: 0 };
  const total = Object.values(histogram).reduce((sum, count) => sum + count, 0);
  for (const [key, count] of Object.entries(histogram)) {
    const [h, a] = key.split('-').map(Number);
    result[h > a ? 'home' : h === a ? 'draw' : 'away'] += count / total;
    result.goalsHome += h * count / total; result.goalsAway += a * count / total;
  }
  return result;
};
if (samples !== FIXTURES * REPLICATES_PER_SPLIT || holdoutSamples !== samples) {
  throw new Error('el conteo Monte Carlo no coincide con las muestras');
}
const trainingRates = rates(counts), holdoutRates = rates(holdoutCounts);
const validation = Object.fromEntries(Object.keys(trainingRates).map(key =>
  [key, Number(Math.abs(trainingRates[key] - holdoutRates[key]).toFixed(5))]));
const output = {
  version: 'v2-causal-4-mc-prior-1',
  simulatorVersion: simulator.VERSION,
  fixtures: FIXTURES,
  samples,
  holdoutSamples,
  validation,
  design: `16 espejos + 16 cruces sintéticos; ${REPLICATES_PER_SPLIT} seeds deterministas por cruce y grupo independiente`,
  counts,
  holdoutCounts
};
const destination = path.join(__dirname, '../lib/football/v2/score-prior-causal-4.json');
fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ file: destination, samples, holdoutSamples, trainingRates, holdoutRates,
  validation, scorelines: Object.keys(counts).length }, null, 2));
