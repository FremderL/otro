#!/usr/bin/env node
'use strict';

// Partido de prueba para la vista previa del Estadio.
//
// El store de fútbol nace vacío y se genera solo, y la parrilla de cada mes es
// determinista a partir de la fecha: en un sandbox recién creado "hoy" puede no
// tener ningún partido (o haberlos dado todos por jugados), así que la cancha no
// tiene nada en vivo donde probar la grada ni los comentarios bala.
//
// Este script NO toca el calendario oficial ni el motor: escribe/actualiza un
// partido `scheduled` de demostración dentro del día local del casino, con dos
// clubes de la temporada en curso. El barrido de kickoff del scheduler lo arranca
// solo cuando llega su hora, igual que un partido normal, y a partir de ahí es
// indistinguible de uno de la parrilla para el cliente.
//
// Uso:
//   node scripts/estadio-partido-demo.js                 # kickoff en 2 minutos (V1, mes en curso)
//   node scripts/estadio-partido-demo.js --in 5          # kickoff en 5 minutos
//   node scripts/estadio-partido-demo.js --status=live   # ya en juego al arrancar el servidor
//   node scripts/estadio-partido-demo.js --remove        # quita el partido de demo
//   node scripts/estadio-partido-demo.js --v2            # demo V2 (noviembre +, motor nuevo)
//
// La ruta del store es la misma que usa el servidor (`FOOTBALL_STORE_PATH`).
// El partido se marca `demo: true` para que sea evidente de dónde salió.
//
// `--v2`: el motor se elige por MES de temporada (`>= 2026-11` ⇒ V2), así que
// este modo escribe el partido en la temporada de noviembre con su reloj de
// demo. Hay que ejecutarlo con el MISMO reloj y el MISMO store con los que se
// arranca el servidor, y el servidor tiene que estar parado:
//
//   export DEMO_NOW=2026-11-01T17:00:00-06:00
//   export FOOTBALL_STORE_PATH=$PWD/data/demo/football-v2.json
//   node scripts/estadio-partido-demo.js --v2 --in 3
//   FOOTBALL_ENABLED=on PORT=4173 \
//     NODE_OPTIONS=--require=./scripts/estadio-demo-clock.cjs node server.js
//
// El primer arranque del servidor genera la temporada de noviembre y prepara los
// compromisos V2 (política durable + cuotas estimadas); el partido de demo es uno
// más de esa parrilla y corre a 15 s reales por minuto simulado. Se niega a
// escribir si la temporada de noviembre aún no existe (arranca el servidor una
// vez primero).

const path = require('path');

const { FootballStore } = require('../lib/football-store');
const { calendarParts, monthKey } = require('../lib/football-store-shared');

const TZ = process.env.CASINO_TIME_ZONE || 'America/Mexico_City';
const STORE = process.env.FOOTBALL_STORE_PATH || path.join(process.cwd(), 'data', 'football.json');
const DEMO_PREFIX = 'm_demo_';
// Temporada desde la que el motor oficial es V2 (lib/football/v2/official.js).
const V2_FROM_MONTH = '2026-11';

function arg(name, fallback = null) {
  const flag = `--${name}=`;
  const found = process.argv.find(value => value.startsWith(flag));
  return found ? found.slice(flag.length) : fallback;
}
function has(name) { return process.argv.includes(`--${name}`); }
function minutes(name, fallback) {
  const raw = arg(name);
  const value = raw == null ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function main() {
  const v2 = has('v2');
  const store = new FootballStore(STORE);
  store.load();
  const now = Date.now();
  const month = monthKey(now);
  // En modo V2 la temporada de referencia es noviembre (o posterior): ahí vive el
  // motor nuevo. En modo normal es la temporada en curso del store.
  let seasonMonth = store.getCurrentSeasonMonth();
  if (v2) {
    if (month < V2_FROM_MONTH) {
      console.error(`--v2 necesita un reloj de noviembre o posterior; hoy es ${month}. Arranca con NODE_OPTIONS=--require=./scripts/estadio-demo-clock.cjs.`);
      process.exitCode = 1;
      store.close();
      return;
    }
    seasonMonth = month;
  } else if (seasonMonth !== month) {
    console.error(`El store está en ${seasonMonth} pero hoy es ${month}. Arranca el servidor una vez para que ruede la temporada y reintenta.`);
    process.exitCode = 1;
    store.close();
    return;
  }
  const league = store.getLeague(seasonMonth);
  if (!league || !league.calendar) {
    console.error(`No hay calendario para ${seasonMonth}. Arranca el servidor una vez (FOOTBALL_ENABLED=on) y reintenta.`);
    process.exitCode = 1;
    store.close();
    return;
  }

  const existing = league.calendar.matches.filter(match => String(match.id).startsWith(DEMO_PREFIX));
  if (has('remove')) {
    league.calendar.matches = league.calendar.matches.filter(match => !existing.includes(match));
    for (const jornada of league.calendar.jornadas || []) {
      jornada.matches = (jornada.matches || []).filter(match => !existing.includes(match));
    }
    store.saveNow();
    console.log(`Partido(s) de demo eliminados: ${existing.map(match => match.id).join(', ') || 'ninguno'}.`);
    store.close();
    return;
  }

  const clubs = league.config || [];
  if (clubs.length < 2) {
    console.error('La temporada no tiene clubes suficientes para un partido de prueba.');
    process.exitCode = 1;
    return;
  }
  // Reparto de clubes estable por día para no repetir siempre el mismo cartel.
  const day = Number(calendarParts(new Date(now), TZ).day) || 1;
  const homeClub = clubs[day % clubs.length];
  const awayClub = clubs[(day + 5) % clubs.length] === homeClub ? clubs[(day + 9) % clubs.length] : clubs[(day + 5) % clubs.length];

  const inMinutes = minutes('in', 2);
  const status = String(arg('status', 'scheduled')).toLowerCase();
  const kickoff = status === 'live'
    ? now - minutes('elapsed', 1) * 60000
    : now + inMinutes * 60000;
  const parts = calendarParts(new Date(kickoff), TZ);

  // Si el día local del kickoff cae fuera del mes de la temporada, el lobby no
  // lo mostraría (filtra por día y mes): se avisa en vez de crear algo invisible.
  const kickoffMonth = monthKey(new Date(kickoff));
  if (kickoffMonth !== seasonMonth) {
    console.error(`El kickoff caería en ${kickoffMonth}, fuera de la temporada ${seasonMonth}. Usa --in con un margen dentro del mes.`);
    process.exitCode = 1;
    return;
  }

  const id = `${DEMO_PREFIX}${seasonMonth.replace('-', '')}_${parts.day}`;
  const match = {
    id,
    seasonMonth,
    jornada: 0,                     // 0 = fuera de la tabla de jornadas (partido de prueba)
    block: 'estelar',
    featured: true,
    desempate: false,
    demo: true,
    homeId: homeClub.id,
    awayId: awayClub.id,
    seed: Math.floor(now / 1000) % 2147483647,
    scheduledKickoffAt: kickoff,
    day: Number(parts.day),
    wave: 0,
    actualKickoffAt: null,
    status: status === 'live' ? 'scheduled' : status, // 'scheduled' lo arranca el sweep al pasar la hora
    result: null
  };

  // Reemplaza el de demo del día (idempotente) y no toca ningún partido real.
  league.calendar.matches = league.calendar.matches.filter(item => !String(item.id).startsWith(DEMO_PREFIX));
  league.calendar.matches.push(match);
  store.saveNow();

  console.log(JSON.stringify({
    event: 'estadio_demo_match_ready',
    id: match.id,
    seasonMonth,
    engine: v2 ? 'v2 (compromiso al arrancar el servidor)' : 'v1 (temporada anterior a ' + V2_FROM_MONTH + ')',
    home: homeClub.name,
    away: awayClub.name,
    status: match.status,
    kickoffLocal: new Date(kickoff).toLocaleString('es-MX', { timeZone: TZ }),
    inMinutes: Math.round((kickoff - now) / 60000),
    store: STORE,
    url: '/estadio'
  }, null, 2));
  store.close();
}

main();
