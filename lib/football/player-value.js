'use strict';

// Valoración de mercado de un jugador del Estadio.
//
// Es una cifra DE LECTURA: sirve para la conferencia de prensa del mercado (qué
// vale un jugador, cuánto se mueve en un traspaso) y no toca fichas, apuestas,
// ratings ni ninguna otra economía del juego. Por eso se calcula siempre, no se
// guarda: si mañana cambia el criterio, cambia en un solo sitio.
//
// El criterio es el mismo lenguaje que usa el resto del fútbol del Estadio: los
// atributos que ya deciden quién marca, quién asiste y quién defiende
// (lib/football/teams.js) y la posición en la cancha. Un delantero con 90 de tiro
// vale más que un central con 90 de defensa, porque en este juego el gol es el
// bien más escaso.

const { POS_GROUP } = require('./match-state');

// Valor base (millones de fichas) a una media de atributos "de liga" (70).
const BASE = { GK: 7.5, DF: 12, MF: 17, FW: 23 };

// Qué atributos definen a cada grupo. Pesos que suman 1.
const WEIGHTS = {
  GK: { gk: 0.80, def: 0.10, pas: 0.10 },
  DF: { def: 0.55, pac: 0.20, pas: 0.15, agr: 0.10 },
  MF: { pas: 0.35, pac: 0.20, sho: 0.20, def: 0.15, agr: 0.10 },
  FW: { sho: 0.45, pac: 0.30, pas: 0.15, agr: 0.10 }
};

function groupOf(player) {
  return POS_GROUP[player && player.pos] || 'MF';
}

// Media ponderada de los atributos que importan en esa posición (0-100).
function ratingOf(player) {
  const weights = WEIGHTS[groupOf(player)];
  const attrs = (player && player.attrs) || {};
  let sum = 0, weight = 0;
  for (const key of Object.keys(weights)) {
    const value = Number(attrs[key]);
    if (!Number.isFinite(value)) continue;
    sum += value * weights[key];
    weight += weights[key];
  }
  return weight > 0 ? sum / weight : 0;
}

// Rendimiento de la temporada: cuenta poco (la valoración es del jugador, no de
// una racha) y nunca dispara el precio por encima de +15 %.
function formFactor(player) {
  const season = (player && player.season) || {};
  const goals = Math.max(0, Number(season.goals) || 0);
  const assists = Math.max(0, Number(season.assists) || 0);
  const bonus = Math.min(0.15, goals * 0.012 + assists * 0.008);
  return 1 + bonus;
}

// Valor en millones de fichas, redondeado a media unidad.
function playerValue(player) {
  if (!player) return 0;
  const rating = ratingOf(player);
  if (!rating) return 0;
  const curve = Math.min(2.4, Math.max(0.45, Math.pow(rating / 70, 1.7)));
  const raw = BASE[groupOf(player)] * curve * formFactor(player);
  return Math.round(raw * 2) / 2;
}

// «17,5 M» — el separador decimal es-MX, sin sufijo de moneda real: son fichas.
function formatPlayerValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n.toFixed(1).replace('.', ',') + ' M';
}

module.exports = { playerValue, formatPlayerValue, ratingOf, BASE, WEIGHTS };
