#!/usr/bin/env node
'use strict';

// Auditoría del acumulado del Balón de Oro contra el archivo de cada partido.
//
//   node scripts/audit-ballon-dor.js                       # temporada actual, solo lectura
//   node scripts/audit-ballon-dor.js --season 2026-10
//   node scripts/audit-ballon-dor.js --player "ravi"       # filtra el detalle impreso
//   node scripts/audit-ballon-dor.js --apply               # repara (active/locked)
//
// Con DATABASE_URL usa Postgres; sin ella, el archivo de FOOTBALL_STORE_PATH.

const { createFootballStore } = require('../lib/football-store-factory');

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return null;
  const value = process.argv[index + 1];
  return value.startsWith('--') ? null : value;
}

function describe(candidate) {
  return {
    player: candidate.playerName,
    clubId: candidate.clubId,
    event: { goals: candidate.event.goals, assists: candidate.event.assists, appearances: candidate.event.appearances },
    archived: { goals: candidate.archived.goals, assists: candidate.archived.assists, appearances: candidate.archived.appearances },
    delta: { goals: candidate.delta.goals, assists: candidate.delta.assists },
    consistent: candidate.consistent,
    matches: candidate.matches.map(match => ({
      jornada: match.jornada,
      score: `${match.score.home}-${match.score.away}`,
      goals: match.goals,
      assists: match.assists,
      minutes: match.minutes
    }))
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const filter = (argValue('player') || '').toLowerCase();
  const store = await createFootballStore();
  try {
    const seasonMonth = argValue('season') || store.getCurrentSeasonMonth();
    const audit = store.auditBallonDor(seasonMonth);
    if (!audit.ok) {
      console.log(JSON.stringify({ ok: false, seasonMonth, reason: audit.reason }, null, 2));
      return;
    }
    const candidates = audit.candidates
      .filter(candidate => !filter || `${candidate.playerName} ${candidate.clubId}`.toLowerCase().includes(filter))
      .map(describe);
    const report = {
      ok: true,
      seasonMonth,
      status: audit.status,
      repairable: audit.repairable,
      checked: audit.checked,
      mismatched: audit.mismatched,
      candidates: filter ? candidates : candidates.filter(candidate => !candidate.consistent)
    };
    if (apply && audit.mismatched > 0) {
      const repair = await store.repairBallonDor(seasonMonth, { apply: true });
      report.repair = {
        ok: repair.ok,
        already: Boolean(repair.already),
        reason: repair.reason || null,
        skipped: repair.skipped || 0,
        changes: repair.changes || []
      };
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
