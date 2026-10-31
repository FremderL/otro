#!/usr/bin/env node
'use strict';

// Calendario del Estadio MonteCristo, derivado del MISMO generador que usa la
// temporada (lib/football/fixtures.js): lo que imprime es lo que se juega.
//
//   node scripts/estadio-calendario.js                    # mes en curso
//   node scripts/estadio-calendario.js --season 2026-11
//   node scripts/estadio-calendario.js --months 6          # el mes y los 5 siguientes
//   node scripts/estadio-calendario.js --json
//
// Construye la temporada en un directorio temporal: no toca datos reales.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { monthKey, CASINO_TIME_ZONE } = require('../lib/football-store-shared');
const { ballonDorFinalizationSchedule, closeDeadline } = require('../lib/football/ballon-dor-market');

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function formatMs(ms) {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: CASINO_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms));
}

function formatTime(ms) {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: CASINO_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms));
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return null;
  const value = process.argv[index + 1];
  return value.startsWith('--') ? null : value;
}

function addMonths(seasonMonth, count) {
  const [year, month] = seasonMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + count, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(seasonMonth) {
  const [year, month] = seasonMonth.split('-').map(Number);
  return `${MONTHS_ES[month - 1]} ${year}`;
}

// Días del calendario: qué jornada(s) se juegan y a qué hora.
function buildMonth(seasonMonth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendario-estadio-'));
  const store = new FootballStore(path.join(dir, 'temporada.json'));
  store.saveNow = () => undefined;
  try {
    const league = store.generateSeason(seasonMonth);
    const calendar = league.calendar;
    const days = new Map();
    for (const jornada of calendar.jornadas) {
      if (!days.has(jornada.day)) days.set(jornada.day, []);
      days.get(jornada.day).push({
        jornada: jornada.jornada,
        wave: jornada.wave,
        kickoffs: jornada.matches.map(match => match.scheduledKickoffAt).sort((a, b) => a - b),
        matches: jornada.matches.length
      });
    }
    const finalization = ballonDorFinalizationSchedule(store, { seasonMonth, status: 'active' }, CASINO_TIME_ZONE);
    return {
      seasonMonth,
      label: monthLabel(seasonMonth),
      daysInMonth: calendar.daysInMonth,
      availableDays: calendar.diasDisponibles,
      doubles: calendar.dobles,
      jornadas: calendar.jornadas.length,
      matches: calendar.matches.length,
      days: [...days.entries()].sort((a, b) => a[0] - b[0]).map(([day, entries]) => ({
        day,
        jornadas: entries.sort((a, b) => a.wave - b.wave)
      })),
      ballonDor: {
        opensAt: `${seasonMonth}-01 a las 00:00`,
        locksAfter: 'jornada 20',
        ceremonyAt: finalization ? formatMs(finalization.scheduledAt) : null,
        lastMatchAt: finalization ? formatMs(finalization.afterMatch.kickoffAt) : null,
        lastMatchJornada: finalization ? finalization.afterMatch.jornada : null,
        closeDeadline: formatMs(closeDeadline(seasonMonth, CASINO_TIME_ZONE)),
        tiebreakSlot: `día ${calendar.daysInMonth} a las 13:00`
      }
    };
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printMarkdown(months) {
  for (const month of months) {
    console.log(`\n## ${month.label} · \`${month.seasonMonth}\``);
    console.log('');
    console.log(`${month.matches} partidos en ${month.jornadas} jornadas · ${month.daysInMonth} días `
      + `(${month.availableDays} con fútbol, ${month.doubles} día(s) doble(s))`);
    console.log('');
    console.log('| Día | Jornada | Horarios (hora local) |');
    console.log('| --- | --- | --- |');
    for (const day of month.days) {
      const jornadas = day.jornadas.map(item => `J${item.jornada}`).join(' + ');
      const times = [...new Set(day.jornadas.flatMap(item => item.kickoffs.map(formatTime)))].sort().join(' · ');
      console.log(`| ${day.day} | ${jornadas} | ${times} |`);
    }
    const lastDay = month.daysInMonth;
    console.log(`| ${lastDay} | — (cierre y liquidación) | hasta las 23:59 |`);
    console.log('');
    console.log('**Balón de Oro**');
    console.log('');
    console.log(`- Apertura del ciclo: día 1 (${month.ballonDor.opensAt}). Sin apertura el día 1, el ciclo se cancela y se reembolsan las predicciones.`);
    console.log('- Apuestas abiertas de la J1 al final de la J20; las cuotas se refrescan al completar cada jornada.');
    console.log(`- Cierre de mercado: al asentarse el último partido de la **J20**.`);
    console.log(`- Último partido de la J${month.ballonDor.lastMatchJornada ?? 30}: ${month.ballonDor.lastMatchAt}.`);
    console.log(`- Ceremonia y pago de predicciones: **${month.ballonDor.ceremonyAt}** (22:00 del día del último partido; si el resultado se cierra más tarde, al día siguiente a esa hora).`);
    console.log(`- Cierre de temporada: ${month.ballonDor.closeDeadline}. Desempate (solo si el título o el podio quedan empatados): ${month.ballonDor.tiebreakSlot}.`);
  }
}

function main() {
  const requested = argValue('season');
  const count = Number(argValue('months') || 1);
  const first = requested && /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
    ? requested : monthKey(new Date());
  const months = [];
  for (let index = 0; index < Math.max(1, Math.min(12, count)); index++) {
    months.push(buildMonth(addMonths(first, index)));
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ timeZone: CASINO_TIME_ZONE, months }, null, 2));
    return;
  }
  console.log(`# Calendario del Estadio · zona ${CASINO_TIME_ZONE}`);
  printMarkdown(months);
}

main();
