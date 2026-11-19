'use strict';

// Transición de carrera entre temporadas: quién se retira, quién sube de la
// cantera, si aparece la promesa del año y qué queda en la lista de inactivos.
//
// Se ejecuta SIEMPRE después de aplicar los traspasos (o de conservar las
// plantillas si se saltó un mes) y ANTES de generar el calendario, porque el
// calendario consume el PRNG y aquí no se toca ni un número: todo sale de hash32
// sobre el id y la temporada. Así las semillas fijas no se desplazan.
//
// ORDEN (importa):
//   1. Retiros: el club pierde a un jugador y la plaza queda libre.
//   2. Cantera: un cantero ocupa esa plaza —dorsal y posición del retirado—,
//      así la plantilla vuelve a 18 sin que nadie tenga que vender a nadie.
//   3. Promesa: si la temporada la tiene, el juvenil excepcional entra a la
//      lista de inactivos y los clubes lo intentarán fichar (§ mercado).
//   4. Fondo: se normaliza y se persiste con la liga.

const { planRetirements, buildYouth, buildWonderkid, hasWonderkid, careerSummary, ageOf } = require('./careers');
const { initialFreeAgents, cleanFreeAgents, addFreePlayer, playerInFreeAgents } = require('./free-agents');

const SQUAD_SIZE = 18;

// Totales verificados de un jugador en una temporada (para el legado de la
// noticia): se derivan de los partidos asentados, nunca se acumulan a mano.
function seasonTotalsFor(club, playerId, previousLeague) {
  const totals = { appearances: 0, goals: 0, assists: 0, minutes: 0 };
  const matches = Array.isArray(previousLeague?.calendar?.matches) ? previousLeague.calendar.matches : [];
  for (const match of matches) {
    if (!match || match.status !== 'settled' || match.desempate) continue;
    if (match.homeId !== club.id && match.awayId !== club.id) continue;
    const rows = Array.isArray(match.fantasyStats) ? match.fantasyStats : [];
    for (const row of rows) {
      if (!row || row.id !== playerId) continue;
      totals.appearances += row.played ? 1 : 0;
      totals.goals += Math.max(0, Number(row.goals) || 0);
      totals.assists += Math.max(0, Number(row.assists) || 0);
      totals.minutes += Math.max(0, Number(row.minutes) || 0);
    }
  }
  return totals;
}

// Nombres ya usados en toda la liga: el cantero y la promesa nunca son homónimos.
function leagueNames(clubs) {
  const names = new Set();
  for (const club of Array.isArray(clubs) ? clubs : []) {
    for (const player of Array.isArray(club.squad) ? club.squad : []) {
      if (player && typeof player.name === 'string') names.add(player.name);
    }
  }
  return names;
}

// Aplica los eventos de carrera a las plantillas ya resueltas para `seasonMonth`.
// Devuelve { retirements, debuts, wonderkid, freeAgents } y MUTA `clubs`.
function applyCareers({ clubs, seasonMonth, previousLeague = null, freeAgents = null }) {
  const result = { retirements: [], debuts: [], wonderkid: null, freeAgents: cleanFreeAgents(freeAgents) };
  if (!Array.isArray(clubs) || !seasonMonth) return result;
  const byId = new Map(clubs.map(club => [club.id, club]));
  const avoidNames = leagueNames(clubs);

  // 1 y 2. Retiros y cantera.
  const planned = planRetirements(clubs, seasonMonth);
  for (const entry of planned) {
    const club = byId.get(entry.clubId);
    if (!club || !Array.isArray(club.squad)) continue;
    const player = club.squad.find(item => item.id === entry.player.id);
    if (!player) continue;
    const totals = previousLeague ? seasonTotalsFor(club, player.id, previousLeague) : null;
    const legacy = careerSummary(player, totals, entry.age);
    // El cantero ocupa la plaza exacta: mismo dorsal, misma posición.
    const youth = buildYouth({
      club,
      seasonMonth,
      position: player.pos,
      number: player.num,
      avoidNames,
      idSuffix: `${String(seasonMonth).replace(/[^0-9]/g, '')}${String(player.num).padStart(2, '0')}`
    });
    avoidNames.add(youth.name);
    const index = club.squad.indexOf(player);
    club.squad[index] = youth;
    result.retirements.push({
      clubId: club.id,
      clubName: club.name,
      player: { id: player.id, name: player.name, pos: player.pos, num: player.num },
      age: entry.age,
      legacy
    });
    result.debuts.push({
      clubId: club.id,
      clubName: club.name,
      player: { id: youth.id, name: youth.name, pos: youth.pos, num: youth.num },
      replaces: { id: player.id, name: player.name }
    });
  }

  // 3. La promesa de la temporada, si toca. Entra al fondo, no a un club.
  if (hasWonderkid(seasonMonth)) {
    const kid = buildWonderkid({ seasonMonth, avoidNames });
    if (!playerInFreeAgents(result.freeAgents, kid.id)) {
      result.freeAgents = addFreePlayer(result.freeAgents, kid, { releasedFrom: null, seasonMonth: null });
      result.wonderkid = {
        id: kid.id,
        name: kid.name,
        pos: kid.pos,
        age: ageOf(kid, seasonMonth)
      };
    }
  }

  // 4. Invariantes: 18 por club y dorsales únicos. Si un cantero no pudo entrar
  // (no debería), no se inventa un hueco: se deja constancia y la temporada
  // sigue, porque romper la liga entera por un juvenil sería peor.
  for (const club of clubs) {
    if (!Array.isArray(club.squad)) continue;
    const numbers = new Set(club.squad.map(player => player.num));
    result.squadIntegrity = result.squadIntegrity !== false && club.squad.length === SQUAD_SIZE && numbers.size === club.squad.length;
  }

  return result;
}

// Marca de nacimiento del fondo en una temporada sin historia previa. Se usa en
// la primera temporada generada, que no arrastra nada de nadie.
function bootstrapFreeAgents() {
  return initialFreeAgents();
}

module.exports = {
  SQUAD_SIZE,
  applyCareers,
  bootstrapFreeAgents,
  seasonTotalsFor,
  leagueNames
};
