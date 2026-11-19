'use strict';

// El once titular de un partido, en una sola definición.
//
// El Estadio ya sabía qué once juega: lo decide `createTeamLineup()`
// (lib/football/match-state.js) y, desde que existe el motor V2, queda
// **congelado** dentro del compromiso del partido
// (`match.simulation.inputs.{home,away}.lineup`). Lo que faltaba era publicarlo:
// la previa solo decía formación y estilo, y el aficionado no sabía quiénes
// eran los once del 11.
//
// Este módulo no inventa un tercer once. Expone exactamente uno de estos dos,
// en este orden:
//
//   1. `commitment` — el del compromiso verificado del partido. Es el mismo
//      objeto con el que `generateReplay()` produce frames y eventos, así que
//      publicarlo no puede contradecir la simulación (causalidad estricta).
//   2. `projected`  — el que resulta de la MISMA precedencia que usa
//      `lib/football/v2/inputs.js` para preparar el compromiso:
//        resolveClubTactics(club, league, asOf) →
//        { ...club, tactics:{formation,style}, manager } → createTeamLineup()
//      Es determinista y es lo que el DT alinearía hoy; se etiqueta como
//      proyección porque un fichaje o un ajuste táctico aún puede cambiarlo.
//
// Sin liga, sin clubes o sin plantel se devuelve `null`. Nunca se rellena un
// once con nombres de fantasía ni con suplentes de otro club.

const { createTeamLineup } = require('./match-state');
const { resolveClubTactics } = require('./managers');
const { verifyCommitment } = require('./v2/commitment');
const { CLUB_BY_ID } = require('./teams');

const MAX_NAME = 60;

function cleanName(name, fallback) {
  const text = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
  return text || fallback;
}

// Un jugador de alineación, reducido a lo que la pantalla necesita: quién es,
// con qué dorsal juega, en qué puesto y qué papel le toca en el dibujo.
function publicPlayer(player, slotIndex) {
  if (!player || typeof player !== 'object') return null;
  const id = typeof player.id === 'string' && player.id ? player.id : null;
  if (!id) return null;
  return {
    id,
    name: cleanName(player.name, 'Jugador sin nombre'),
    number: Number.isFinite(Number(player.number)) ? Number(player.number) : null,
    pos: typeof player.pos === 'string' && player.pos ? player.pos : null,
    role: typeof player.role === 'string' && player.role ? player.role : null,
    slotIndex: Number.isInteger(slotIndex) ? slotIndex : null
  };
}

// Separa los 11 titulares del banquillo respetando el orden del dibujo
// (`slotIndex` 0..10, portero primero). Alineaciones heredadas sin slotIndex se
// ordenan al final por dorsal para que la lista siga siendo estable.
function structure(lineup) {
  const players = Array.isArray(lineup?.players) ? lineup.players : [];
  const starters = [];
  const bench = [];
  for (const player of players) {
    if (!player) continue;
    const view = publicPlayer(player, player.slotIndex);
    if (!view) continue;
    if (player.initialStatus === 'active') starters.push(view);
    else bench.push(view);
  }
  starters.sort((a, b) => {
    const ia = a.slotIndex == null ? Number.MAX_SAFE_INTEGER : a.slotIndex;
    const ib = b.slotIndex == null ? Number.MAX_SAFE_INTEGER : b.slotIndex;
    return (ia - ib) || ((a.number ?? 99) - (b.number ?? 99));
  });
  bench.sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
  return { starters, bench: bench.map(player => ({ ...player, slotIndex: null })) };
}

function managerView(manager) {
  if (!manager || typeof manager !== 'object') return null;
  const name = cleanName(manager.name, '');
  if (!name) return null;
  // «Dirección Técnica» es el banquillo genérico de un club sin DT resuelto; se
  // publica igual que lo publica el motor, sin inventarle un nombre propio.
  return { id: String(manager.id || ''), name };
}

function teamView(clubId, lineup) {
  const identity = CLUB_BY_ID[clubId] || {};
  const { starters, bench } = structure(lineup);
  return {
    clubId: String(clubId || ''),
    name: identity.name || String(clubId || ''),
    short: identity.abbr || identity.short || String(clubId || '').slice(0, 3).toUpperCase(),
    formation: typeof lineup?.formation === 'string' ? lineup.formation : null,
    style: typeof lineup?.style === 'string' ? lineup.style : null,
    manager: managerView(lineup?.manager),
    starters,
    bench
  };
}

// Con la pizarra resuelta, igual que `v2/inputs.js`. Se conserva el `manager`
// resuelto en el objeto de equipo para que la ficha muestre al DT que de verdad
// firma ese once.
function projectLineup(club, league, asOf) {
  if (!club || !Array.isArray(club.squad) || !club.squad.length) return null;
  let resolved = null;
  try { resolved = resolveClubTactics(club, league, asOf); } catch (_) { resolved = null; }
  const tacticalClub = resolved
    ? { ...club, tactics: { formation: resolved.formation, style: resolved.style }, manager: resolved.manager }
    : club;
  let lineup = null;
  try { lineup = createTeamLineup(tacticalClub); } catch (_) { return null; }
  if (!lineup) return null;
  return { ...lineup, manager: tacticalClub.manager || null };
}

// Alineación congelada del compromiso V2. Se valida el compromiso completo
// (hash, versión, ids del partido) antes de publicar nada de su interior: un
// compromiso dañado no se convierte en la previa del partido.
function committedLineup(match, side) {
  const simulation = match && match.simulation;
  if (!simulation || simulation.invalid || simulationUnconfirmed(match)) return null;
  if (!verifyCommitment(simulation, match)) return null;
  const lineup = simulation?.inputs?.[side]?.lineup;
  if (!lineup || !Array.isArray(lineup.players) || !lineup.players.length) return null;
  const manager = simulation?.inputs?.[side]?.manager || null;
  return { ...lineup, manager };
}

// `simulationUnconfirmed` vive como propiedad no enumerable en el motor: se
// comprueba sin asumir que exista.
function simulationUnconfirmed(match) {
  return Boolean(match && match.simulationUnconfirmed);
}

function clubFor(league, id) {
  const clubs = Array.isArray(league?.config) ? league.config : [];
  return clubs.find(club => club && club.id === id) || null;
}

// Única puerta pública: devuelve los dos onces de un partido o `null`.
function matchLineups(store, match, at = Date.now()) {
  if (!match || !match.homeId || !match.awayId) return null;
  let league = null;
  try {
    league = store && typeof store.getLeague === 'function'
      ? (store.getLeague(match.seasonMonth) || null)
      : null;
  } catch (_) { league = null; }

  const homeCommit = committedLineup(match, 'home');
  const awayCommit = committedLineup(match, 'away');
  if (homeCommit && awayCommit) {
    return {
      matchId: match.id,
      seasonMonth: match.seasonMonth || null,
      asOf: at,
      source: 'commitment',
      home: teamView(match.homeId, homeCommit),
      away: teamView(match.awayId, awayCommit)
    };
  }

  if (!league) return null;
  const home = clubFor(league, match.homeId);
  const away = clubFor(league, match.awayId);
  if (!home || !away) return null;
  const homeLineup = homeCommit || projectLineup(home, league, at);
  const awayLineup = awayCommit || projectLineup(away, league, at);
  if (!homeLineup || !awayLineup) return null;
  return {
    matchId: match.id,
    seasonMonth: match.seasonMonth || league.seasonMonth || null,
    asOf: at,
    source: 'projected',
    home: teamView(match.homeId, homeLineup),
    away: teamView(match.awayId, awayLineup)
  };
}

module.exports = { matchLineups, structure, projectLineup };
