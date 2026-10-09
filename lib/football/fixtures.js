'use strict';

// Fase A — Liga y calendario (§5).
//
// Genera, de forma determinista a partir del seed de la temporada, el calendario
// completo de un mes: doble vuelta de 16 clubes (240 partidos, 30 jornadas de 8),
// repartido en los días disponibles del mes y en los tres bloques de transmisión
// diarios. Es la pieza que valida T17 («calendario válido para cualquier mes»).
//
// Reglas que implementa (§5.2 y §5.3):
//   · diasDisponibles = díasDelMes − 1   (el último día se reserva para cierre y
//     liquidación, y ahí viviría el partido de desempate de §7.5 si hace falta).
//   · dobles = max(0, 30 − diasDisponibles): días con dos jornadas, repartidas
//     uniformemente para que no se concentren al final del mes.
//   · Cada jornada: 3 partidos Matutino (13:00), 3 Vespertino (18:00), 2 Estelar
//     (21:30, uno destacado). En día de doble jornada la segunda oleada va +35 min.
//   · Kickoff en CASINO_TIME_ZONE (America/Mexico_City por defecto), no en la zona
//     del proceso: Render/Neon corren en UTC y una temporada mexicana no debe
//     terminar seis horas antes (ver calendarParts en profile-store-shared.js).

const { hash32, mulberry32, shuffle } = require('./prng');
const { CASINO_TIME_ZONE } = require('../profile-store-shared');

// --- Configuración de bloques (§17 FOOTBALL_BLOCKS por defecto) ---
const DEFAULT_BLOCKS = [
  { id: 'matutino',   num: 1, time: '13:00', matches: 3, featured: false },
  { id: 'vespertino', num: 2, time: '18:00', matches: 3, featured: false },
  { id: 'estelar',    num: 3, time: '21:30', matches: 2, featured: true  }
];
const WAVE_OFFSET_MIN = 35;   // desfase de la segunda oleada en día doble (§5.3)
const JORNADAS = 30;          // 16 clubes, doble vuelta (§5.1)

// --- Utilidades de calendario y zona horaria ---

// '2026-10' → { year: 2026, month: 10 }. Acepta también un Date.
function parseSeasonMonth(seasonMonth) {
  if (seasonMonth instanceof Date) {
    return { year: seasonMonth.getUTCFullYear(), month: seasonMonth.getUTCMonth() + 1 };
  }
  const match = /^(\d{4})-(\d{2})$/.exec(String(seasonMonth || ''));
  if (!match) throw new Error(`seasonMonth inválido: ${seasonMonth} (se espera 'AAAA-MM')`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`mes fuera de rango en ${seasonMonth}`);
  return { year, month };
}

// Días del mes calendario (28..31), bisiestos incluidos. Independiente de zona:
// octubre tiene 31 días en cualquier parte.
function daysInMonth(seasonMonth) {
  const { year, month } = parseSeasonMonth(seasonMonth);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Offset (en ms) de una zona horaria respecto a UTC en un instante dado.
function timeZoneOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );
  const asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour) % 24, +parts.minute, +parts.second);
  return asIfUTC - utcMs;
}

// Convierte una fecha-hora «de pared» en una zona horaria a epoch ms. Dos pasadas
// de offset para ser correcto incluso en transiciones de DST (México ya no usa
// DST desde 2022, pero el helper no debe depender de eso).
function zonedTimeToMs({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = CASINO_TIME_ZONE) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const candidate = utcGuess - timeZoneOffsetMs(utcGuess, timeZone);
  return utcGuess - timeZoneOffsetMs(candidate, timeZone);
}

// 'HH:MM' + minutos de desfase → { hour, minute } (sin cruzar medianoche aquí;
// los bloques + 35 min nunca pasan de 22:05).
function shiftTime(hhmm, offsetMin) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const total = h * 60 + m + offsetMin;
  return { hour: Math.floor(total / 60) % 24, minute: total % 60 };
}

// --- Doble vuelta (método del círculo / Berger) ---
// Devuelve 30 jornadas de 8 enfrentamientos {home, away}. Primera vuelta: 15
// rondas con un pivote fijo y el resto rotando. Segunda vuelta: las mismas 15
// con local/visitante invertido, así cada pareja se enfrenta dos veces, una en
// cada cancha. `ids` ya viene barajado con el seed de la temporada.
function doubleRoundRobin(ids) {
  const n = ids.length;
  if (n % 2 !== 0) throw new Error('El método del círculo requiere un número par de clubes');
  let arr = ids.slice();
  const firstHalf = [];
  for (let round = 0; round < n - 1; round++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      let home = arr[i];
      let away = arr[n - 1 - i];
      // El pivote (i === 0) alterna local/visitante cada ronda para que ningún
      // club quede siempre en casa; el resto ya alterna por la propia rotación.
      if (i === 0 && round % 2 === 1) { const t = home; home = away; away = t; }
      pairs.push({ home, away });
    }
    firstHalf.push(pairs);
    // Rota arr[1..] a la derecha manteniendo arr[0] fijo.
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  const secondHalf = firstHalf.map(pairs => pairs.map(({ home, away }) => ({ home: away, away: home })));
  return [...firstHalf, ...secondHalf]; // 30 jornadas
}

// Reparte las `dobles` jornadas extra entre los días disponibles de forma
// uniforme (centro de cada cubo), para que no se concentren al final del mes.
function jornadasPorDia(diasDisponibles, dobles) {
  const perDay = new Array(diasDisponibles).fill(1);
  for (let k = 0; k < dobles; k++) {
    const idx = Math.min(diasDisponibles - 1, Math.floor(((k + 0.5) * diasDisponibles) / dobles));
    perDay[idx] += 1;
  }
  return perDay;
}

// Asigna a cada jornada su día (1-based) y su oleada (0 = primera, 1 = segunda
// en día doble). Recorre los días en orden consumiendo las jornadas que tocan.
function asignarDias(diasDisponibles, dobles) {
  const perDay = jornadasPorDia(diasDisponibles, dobles);
  const schedule = [];
  let jornada = 1;
  for (let dayIdx = 0; dayIdx < diasDisponibles; dayIdx++) {
    const count = perDay[dayIdx];
    for (let wave = 0; wave < count; wave++) {
      schedule.push({ jornada, day: dayIdx + 1, wave });
      jornada++;
    }
  }
  return schedule; // longitud 30
}

// Ordena los 8 enfrentamientos de una jornada para que los dos de mayor suma de
// elo inicial vayan al bloque Estelar (uno destacado), los tres siguientes al
// Vespertino y los tres últimos al Matutino. Determinista: desempata por el
// índice de entrada para que el sorteo no dependa del orden de las parejas.
function asignarBloques(pairs, clubById, blocks) {
  const combinedElo = pair => {
    const home = clubById[pair.home];
    const away = clubById[pair.away];
    return (home && home.ratings ? home.ratings.elo : 1500) + (away && away.ratings ? away.ratings.elo : 1500);
  };
  const ranked = pairs
    .map((pair, index) => ({ pair, index, elo: combinedElo(pair) }))
    .sort((a, b) => (b.elo - a.elo) || (a.index - b.index))
    .map(item => item.pair);

  // El bloque destacado (Estelar) se lleva los de mayor elo; el resto se reparte
  // de mayor a menor entre Vespertino y Matutino (la tarde con mejores juegos que
  // la mañana). Dentro de cada bloque, slot 1 = el mejor del bloque.
  const estelar = blocks.find(b => b.featured) || blocks[blocks.length - 1];
  const others = blocks.filter(b => b !== estelar).slice().reverse(); // vespertino, matutino

  const placed = [];
  ranked.slice(0, estelar.matches).forEach((pair, i) => placed.push({ pair, block: estelar, slot: i + 1 }));
  let cursor = estelar.matches;
  for (const block of others) {
    ranked.slice(cursor, cursor + block.matches).forEach((pair, i) => placed.push({ pair, block, slot: i + 1 }));
    cursor += block.matches;
  }
  return placed;
}

// Genera el calendario completo de una temporada.
//   seasonMonth: 'AAAA-MM'
//   clubs: los 16 clubes de la temporada (con ratings sembrados) — de teams.js
//   options: { blocks, timeZone }
// Devuelve { seasonMonth, seed, daysInMonth, diasDisponibles, dobles,
//            jornadas:[{jornada,day,wave,matches:[...]}], matches:[...planos] }.
function generateCalendar(seasonMonth, clubs, options = {}) {
  const blocks = options.blocks || DEFAULT_BLOCKS;
  const timeZone = options.timeZone || CASINO_TIME_ZONE;
  const { year, month } = parseSeasonMonth(seasonMonth);

  const totalMatches = blocks.reduce((sum, b) => sum + b.matches, 0);
  if (totalMatches * JORNADAS !== clubs.length * (clubs.length - 1)) {
    throw new Error(`Los bloques suman ${totalMatches} partidos/jornada y no cuadran con ${clubs.length} clubes a doble vuelta`);
  }

  const seed = hash32(`${seasonMonth}liga`);
  const random = mulberry32(seed);

  const clubById = Object.fromEntries(clubs.map(club => [club.id, club]));
  const ids = shuffle(random, clubs.map(club => club.id));
  const rounds = doubleRoundRobin(ids); // 30 jornadas de `totalMatches` pairs

  const dim = daysInMonth(seasonMonth);
  const diasDisponibles = dim - 1;
  const dobles = Math.max(0, JORNADAS - diasDisponibles);
  const daySchedule = asignarDias(diasDisponibles, dobles);

  const jornadas = [];
  const matches = [];

  for (let j = 0; j < JORNADAS; j++) {
    const { jornada, day, wave } = daySchedule[j];
    const placed = asignarBloques(rounds[j], clubById, blocks);
    const waveOffset = wave * WAVE_OFFSET_MIN;

    // El destacado del bloque estelar: el de mayor elo (slot 1). En jornadas sin
    // bloque estelar destacado, featured queda en false.
    const jornadaMatches = placed.map(({ pair, block, slot }) => {
      const { hour, minute } = shiftTime(block.time, waveOffset);
      const id = `m_${seasonMonth}_j${jornada}_b${block.num}_${slot}`;
      const featured = Boolean(block.featured) && slot === 1;
      const shell = {
        id,
        seasonMonth,
        jornada,
        block: block.id,
        featured,
        homeId: pair.home,
        awayId: pair.away,
        seed: hash32(`${id}|${jornada}|${seasonMonth}`),
        scheduledKickoffAt: zonedTimeToMs({ year, month, day, hour, minute }, timeZone),
        day,
        wave,
        actualKickoffAt: null,
        status: 'scheduled',
        result: null
      };
      matches.push(shell);
      return shell;
    });

    jornadas.push({ jornada, day, wave, matches: jornadaMatches });
  }

  return {
    seasonMonth,
    seed,
    daysInMonth: dim,
    diasDisponibles,
    dobles,
    timeZone,
    jornadas,
    matches
  };
}

module.exports = {
  DEFAULT_BLOCKS,
  WAVE_OFFSET_MIN,
  JORNADAS,
  parseSeasonMonth,
  daysInMonth,
  timeZoneOffsetMs,
  zonedTimeToMs,
  shiftTime,
  doubleRoundRobin,
  jornadasPorDia,
  asignarDias,
  asignarBloques,
  generateCalendar
};
