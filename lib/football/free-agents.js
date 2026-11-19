'use strict';

// Lista de inactivos del Estadio: jugadores sin club y DTs sin banquillo.
//
// POR QUÉ EXISTE: hasta ahora el mercado era una permutación cerrada —cada club
// vendía exactamente lo que compraba— y los DTs despedidos desaparecían del
// sistema. Eso obligaba a un cambio *entrada por salida*: para reforzarte
// tenías que debilitar a otro club, y no había forma de fichar a nadie libre.
//
// El fondo arregla las dos mitades:
//   · Jugadores: quien se retira deja plaza y quien ficha desde el fondo libera
//     a otro. El fondo NO se rellena solo: crece con bajas reales.
//   · DTs: el que pierde el banquillo vuelve al fondo con su historial y puede
//     ser contratado por cualquier club en el futuro.
//
// Todo es determinista y no toca el PRNG de la temporada (ver careers.js).

const { ageOf } = require('./careers');
const { FREE_AGENT_COACHES } = require('./managers');

// El fondo no es un cajón infinito: 24 futbolistas y los DTs disponibles.
const MAX_FREE_PLAYERS = 24;
const MAX_FREE_COACHES = 32;

function emptyFreeAgents() {
  return { players: [], coaches: [] };
}

// Normaliza el fondo tal como llega del disco o de Postgres. Cualquier campo
// desconocido se descarta; nada se inventa si falta.
function cleanFreeAgents(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const players = Array.isArray(source.players) ? source.players : [];
  const coaches = Array.isArray(source.coaches) ? source.coaches : [];
  return {
    players: players.filter(player => player && typeof player.id === 'string' && player.id
      && typeof player.name === 'string' && player.name && typeof player.pos === 'string'
      && player.attrs && typeof player.attrs === 'object')
      .slice(0, MAX_FREE_PLAYERS)
      .map(player => ({
        id: String(player.id).slice(0, 80),
        num: null,
        name: String(player.name).slice(0, 60),
        pos: String(player.pos).slice(0, 4),
        attrs: { ...player.attrs },
        season: { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 },
        ...(player.wonderkid ? { wonderkid: true } : {}),
        ...(player.releasedFrom ? { releasedFrom: String(player.releasedFrom).slice(0, 60) } : {}),
        ...(Number.isInteger(player.releasedAtSeason) ? { releasedAtSeason: String(player.releasedAtSeason).slice(0, 7) } : {})
      })),
    coaches: coaches.filter(coach => coach && typeof coach.id === 'string' && coach.id
      && typeof coach.name === 'string' && coach.name)
      .slice(0, MAX_FREE_COACHES)
      .map(coach => ({
        id: String(coach.id).slice(0, 80),
        name: String(coach.name).slice(0, 80),
        preferredFormation: String(coach.preferredFormation || '4-4-2').slice(0, 10),
        secondaryFormation: String(coach.secondaryFormation || '4-2-3-1').slice(0, 10),
        style: String(coach.style || 'balanced').slice(0, 20),
        subProfile: String(coach.subProfile || 'equilibrado').slice(0, 20),
        marketFocus: String(coach.marketFocus || 'equilibrio').slice(0, 20),
        ...(coach.sackedAfterSeason ? { sackedAfterSeason: String(coach.sackedAfterSeason).slice(0, 7) } : {}),
        ...(coach.lastClubName ? { lastClubName: String(coach.lastClubName).slice(0, 60) } : {}),
        ...(Number.isFinite(Number(coach.tenureSeasons)) ? { tenureSeasons: Math.max(0, Math.floor(Number(coach.tenureSeasons))) } : {})
      }))
  };
}

// Estado inicial: los DTs libres de siempre más ningún jugador. El fondo de
// jugadores empieza vacío a propósito — solo lo llena una baja real.
function initialFreeAgents() {
  return cleanFreeAgents({ players: [], coaches: FREE_AGENT_COACHES.map(coach => ({ ...coach })) });
}

function playerInFreeAgents(freeAgents, playerId) {
  return (freeAgents?.players || []).some(player => player.id === playerId);
}

function coachInFreeAgents(freeAgents, coachId) {
  return (freeAgents?.coaches || []).some(coach => coach.id === coachId);
}

// Alta de un futbolista que se queda sin club. Idempotente por id: si ya está, no
// se duplica. Devuelve el fondo nuevo (no muta el de entrada).
function addFreePlayer(freeAgents, player, { releasedFrom = null, seasonMonth = null } = {}) {
  const base = cleanFreeAgents(freeAgents);
  if (!player || !player.id || playerInFreeAgents(base, player.id)) return base;
  const entry = {
    id: player.id,
    name: player.name,
    pos: player.pos,
    attrs: { ...player.attrs },
    ...(player.wonderkid ? { wonderkid: true } : {}),
    ...(releasedFrom ? { releasedFrom } : {}),
    ...(seasonMonth ? { releasedAtSeason: seasonMonth } : {})
  };
  return cleanFreeAgents({ ...base, players: [...base.players, entry] });
}

// Baja de un futbolista que ficha por un club.
function removeFreePlayer(freeAgents, playerId) {
  const base = cleanFreeAgents(freeAgents);
  return { ...base, players: base.players.filter(player => player.id !== playerId) };
}

// Alta de un DT que pierde el banquillo; conserva su último club y el motivo.
function addFreeCoach(freeAgents, coach, { lastClubName = null, sackedAfterSeason = null } = {}) {
  const base = cleanFreeAgents(freeAgents);
  if (!coach || !coach.id || coachInFreeAgents(base, coach.id)) return base;
  return cleanFreeAgents({
    ...base,
    coaches: [...base.coaches, {
      ...coach,
      ...(lastClubName ? { lastClubName } : {}),
      ...(sackedAfterSeason ? { sackedAfterSeason } : {})
    }]
  });
}

function removeFreeCoach(freeAgents, coachId) {
  const base = cleanFreeAgents(freeAgents);
  return { ...base, coaches: base.coaches.filter(coach => coach.id !== coachId) };
}

// Vista pública del fondo: lo justo para que la UI muestre a quién se puede
// fichar, sin atributos completos de 24 jugadores en cada respuesta.
function publicFreeAgents(freeAgents, { seasonMonth = null, includeAttrs = false } = {}) {
  const base = cleanFreeAgents(freeAgents);
  return {
    players: base.players.map(player => ({
      id: player.id,
      name: player.name,
      pos: player.pos,
      ...(seasonMonth ? { age: ageOf(player, seasonMonth) } : {}),
      ...(player.wonderkid ? { wonderkid: true } : {}),
      ...(player.releasedFrom ? { releasedFrom: player.releasedFrom } : {}),
      ...(includeAttrs ? { attrs: { ...player.attrs } } : {})
    })),
    coaches: base.coaches.map(coach => ({
      id: coach.id,
      name: coach.name,
      preferredFormation: coach.preferredFormation,
      secondaryFormation: coach.secondaryFormation,
      style: coach.style,
      marketFocus: coach.marketFocus,
      ...(coach.lastClubName ? { lastClubName: coach.lastClubName } : {}),
      ...(coach.sackedAfterSeason ? { sackedAfterSeason: coach.sackedAfterSeason } : {})
    }))
  };
}

module.exports = {
  MAX_FREE_PLAYERS,
  MAX_FREE_COACHES,
  emptyFreeAgents,
  cleanFreeAgents,
  initialFreeAgents,
  playerInFreeAgents,
  coachInFreeAgents,
  addFreePlayer,
  removeFreePlayer,
  addFreeCoach,
  removeFreeCoach,
  publicFreeAgents
};
