'use strict';

// Casa Montecristo — bolsa de clubes del Estadio.
//
// QUÉ ES: cada uno de los 16 clubes cotiza en fichas virtuales. El precio sube y
// baja con hechos verificados (posición real en la tabla, Elo de la temporada y
// valor de la plantilla), no con una simulación paralela. Es una LECTURA del
// estado deportivo, igual que la tabla o el Balón de Oro.
//
// POR QUÉ JUSTIFICA LOS FICHAJES: el precio fija el PRESUPUESTO del club, y ese
// presupuesto es el techo de su oferta por un jugador o por un DT. Así el
// mercado deja de ser una permutación sin dinero: un club que sube en la Casa
// puede pagar más y uno que se hunde pierde los fichajes aunque los pida.
//
// REGLAS DURAS:
//   · Nada de Math.random(): mismo estado ⇒ mismo precio, siempre.
//   · El dinero de los usuarios usa debit()/credit() del casino, todo o nada.
//   · La Casa no toca ratings, resultados, cuotas, apuestas ni premios.

const { ageOf } = require('./careers');
const { playerValue } = require('./player-value');
const { MAX_SHARES_PER_CLUB, MAX_SHARES_TOTAL, cleanClubShares, sharesTotal } = require('./club-shares');

// Mínimo de acciones por operación: la casa no negocia fracciones.
const MIN_TRADE_SHARES = 1;

const VERSION = 'casa-montecristo-1';

// Precio de una acción, en fichas. La banda evita extremos absurdos.
const PRICE_MIN = 40;
const PRICE_MAX = 260;
const PRICE_BASE = 100;

// Pesos del valor deportivo: la tabla manda, el Elo matiza.
const SPORT_WEIGHT = { table: 0.60, elo: 0.40 };

// Pesos del precio final.
const PRICE_WEIGHT = { sport: 0.45, squad: 0.35, form: 0.20 };

// Rango de Elo con el que se normaliza (banda de diseño de las temporadas).
const ELO_FLOOR = 1360;
const ELO_CEILING = 1660;

// Rango del valor total de plantilla observado (18 jugadores, player-value).
const SQUAD_VALUE_FLOOR = 240;
const SQUAD_VALUE_CEILING = 380;

// Presupuesto de fichajes en MILLONES de fichas (la misma unidad que
// playerValue). Una acción que cotiza a 100 fichas respalda 30 M de presupuesto
// antes de aplicar el prestigio deportivo: la banda resultante (≈15 M el más
// pobre, ≈55 M el más rico) cubre justo el catálogo real de jugadores (7-31 M),
// así que un club humilde solo alcanza a los baratos y uno fuerte puede romper
// el mercado por una estrella.
const BUDGET_MILLIONS_PER_PRICE = 0.30;
const PRESTIGE_RANGE = { min: 0.55, max: 1.45 };

// Forma: puntos de las últimas N jornadas asentadas.
const FORM_MATCHES = 5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

// Posición en la tabla normalizada a 0..1 (1 = líder). Si aún no hay partidos,
// se usa la posición de diseño por Elo como referencia neutra.
function tableScore(league) {
  const rows = Array.isArray(league?.standings) ? league.standings.filter(row => row && row.clubId) : [];
  const played = rows.reduce((sum, row) => sum + (Number(row.played) || 0), 0);
  if (!rows.length || played === 0) return null;
  const sorted = rows.slice().sort((a, b) =>
    (Number(b.points) || 0) - (Number(a.points) || 0)
    || (Number(b.goalDiff) || 0) - (Number(a.goalDiff) || 0)
    || (Number(b.goalsFor) || 0) - (Number(a.goalsFor) || 0)
    || String(a.clubId).localeCompare(String(b.clubId)));
  const index = new Map(sorted.map((row, i) => [row.clubId, i]));
  const last = Math.max(1, sorted.length - 1);
  return clubId => {
    const i = index.get(clubId);
    if (i == null) return 0.5;
    return 1 - i / last;
  };
}

// Puntos de las últimas jornadas asentadas, normalizados a 0..1 (3 puntos por
// partido como techo). Sin partidos, 0.5: neutro, no castigo.
function formScore(league, clubId) {
  const matches = Array.isArray(league?.calendar?.matches) ? league.calendar.matches : [];
  const settled = matches
    .filter(match => match && match.status === 'settled' && !match.desempate
      && (match.homeId === clubId || match.awayId === clubId)
      && Number.isInteger(match.jornada))
    .sort((a, b) => b.jornada - a.jornada || String(b.id).localeCompare(String(a.id)))
    .slice(0, FORM_MATCHES);
  if (!settled.length) return 0.5;
  let points = 0;
  for (const match of settled) {
    const home = match.homeId === clubId;
    const own = Number(match.result?.[home ? 'home' : 'away']);
    const rival = Number(match.result?.[home ? 'away' : 'home']);
    if (!Number.isFinite(own) || !Number.isFinite(rival)) continue;
    points += own > rival ? 3 : own === rival ? 1 : 0;
  }
  return clamp(points / (settled.length * 3), 0, 1);
}

function squadValue(club) {
  return (Array.isArray(club?.squad) ? club.squad : []).reduce((sum, player) => sum + playerValue(player), 0);
}

// Precio de la acción de un club, en fichas. Determinista y sin estado extra:
// el mismo estado de liga produce siempre el mismo precio.
function clubPrice(league, clubId) {
  const club = Array.isArray(league?.config) ? league.config.find(item => item.id === clubId) : null;
  if (!club) return null;

  const tableOf = tableScore(league);
  const elo = Number(club.ratings?.elo) || 1500;
  const eloScore = clamp((elo - ELO_FLOOR) / (ELO_CEILING - ELO_FLOOR), 0, 1);
  const sportTable = tableOf ? tableOf(club.id) : eloScore;
  const sport = sportTable * SPORT_WEIGHT.table + eloScore * SPORT_WEIGHT.elo;

  const value = squadValue(club);
  const squad = clamp((value - SQUAD_VALUE_FLOOR) / (SQUAD_VALUE_CEILING - SQUAD_VALUE_FLOOR), 0, 1);
  const form = formScore(league, club.id);

  const composite = sport * PRICE_WEIGHT.sport + squad * PRICE_WEIGHT.squad + form * PRICE_WEIGHT.form;
  const price = clamp(roundHalf(PRICE_BASE * (0.55 + composite * 1.15)), PRICE_MIN, PRICE_MAX);
  return { price, sport: Number(sport.toFixed(3)), squad: Number(squad.toFixed(3)), form: Number(form.toFixed(3)) };
}

// El precio sube o baja más de lo que justifica un solo partido: solo se anuncia
// un movimiento cuando el salto es visible (≥ 8 %), para no inundar el noticiero.
const MOVEMENT_THRESHOLD = 0.08;

function priceMovement(previousPrice, price) {
  if (!Number.isFinite(previousPrice) || previousPrice <= 0) return null;
  const change = (price - previousPrice) / previousPrice;
  if (Math.abs(change) < MOVEMENT_THRESHOLD) return null;
  return { change: Number(change.toFixed(3)), direction: change > 0 ? 'up' : 'down' };
}

// Presupuesto de fichajes del club: precio × 100 × prestigio deportivo.
// El prestigio sale de la misma posición que el precio → nunca se contradicen.
function clubBudget(league, clubId) {
  const quote = clubPrice(league, clubId);
  if (!quote) return null;
  const tableOf = tableScore(league);
  const prestigeBase = tableOf ? tableOf(clubId) : quote.sport;
  const factor = PRESTIGE_RANGE.min + prestigeBase * (PRESTIGE_RANGE.max - PRESTIGE_RANGE.min);
  return {
    price: quote.price,
    factor: Number(factor.toFixed(3)),
    budget: Math.round(quote.price * BUDGET_MILLIONS_PER_PRICE * factor * 10) / 10
  };
}

// Catálogo público de la Casa: una fila por club, con su precio, su variación y
// su presupuesto. Es lo que ve el usuario y lo que lee el mercado.
function publicMarket(league, { previousLeague = null } = {}) {
  if (!league || !Array.isArray(league.config)) return { version: VERSION, seasonMonth: null, clubs: [] };
  const previousPrices = new Map();
  if (previousLeague && Array.isArray(previousLeague.config)) {
    for (const club of previousLeague.config) {
      const quote = clubPrice(previousLeague, club.id);
      if (quote) previousPrices.set(club.id, quote.price);
    }
  }
  const rows = league.config.map(club => {
    const quote = clubPrice(league, club.id) || { price: PRICE_BASE, sport: 0.5, squad: 0.5, form: 0.5 };
    const budget = clubBudget(league, club.id);
    const previous = previousPrices.get(club.id);
    const movement = priceMovement(previous, quote.price);
    return {
      clubId: club.id,
      clubName: club.name,
      abbr: club.abbr || club.short || null,
      price: quote.price,
      previousPrice: Number.isFinite(previous) ? previous : null,
      change: movement ? movement.change : 0,
      direction: movement ? movement.direction : 'flat',
      budget: budget ? budget.budget : null,
      sport: quote.sport,
      squad: quote.squad,
      form: quote.form
    };
  });
  rows.sort((a, b) => b.price - a.price || String(a.clubId).localeCompare(String(b.clubId)));
  return { version: VERSION, seasonMonth: league.seasonMonth || null, clubs: rows };
}

// Precio de un DT para el club que quiera contratarlo: sale de su prestigio
// verificado (títulos, temporadas en el banquillo y récord), no del azar.
function coachPrice(league, coach) {
  if (!coach || !coach.id) return 0;
  const honours = Number(coach.titles) || 0;
  const tenure = Number(coach.tenureSeasons) || 1;
  const base = 900 + honours * 1200 + Math.min(tenure, 12) * 260;
  // Un DT sin banquillo hace tiempo abarata su ficha (nadie puja por él).
  const idle = coach.sackedAfterSeason ? 0.85 : 1;
  return Math.round(base * idle);
}

// ¿Puede el club pagar esta operación? Devuelve el motivo cuando no.
function canAfford(league, clubId, amount) {
  const budget = clubBudget(league, clubId);
  if (!budget) return { ok: false, code: 'club_invalido', budget: null };
  const cost = Math.max(0, Math.round(Number(amount) || 0));
  return {
    ok: cost <= budget.budget,
    code: cost <= budget.budget ? null : 'presupuesto_insuficiente',
    budget: budget.budget,
    cost,
    missing: Math.max(0, cost - budget.budget)
  };
}

// --- Lado usuario: comprar y vender acciones ---------------------------------
//
// Módulo PURO: solo muta el perfil en memoria. Quien llama debe ejecutar
// profiles.touch() (igual que openCardCapsule) y debe usar las funciones de
// lib/progression.js para mover fichas, nunca tocar profile.chips a mano.

// Vista privada de la cartera: cuántas acciones, a qué precio medio y cuánto
// valen hoy. La valoración usa el precio actual, nunca el de compra.
function portfolioView(profile, league) {
  const holdings = cleanClubShares(profile?.clubShares);
  const clubs = Array.isArray(league?.config) ? league.config : [];
  const rows = [];
  let invested = 0, value = 0;
  for (const club of clubs) {
    const entry = holdings[club.id];
    if (!entry) continue;
    const quote = clubPrice(league, club.id);
    const price = quote ? quote.price : 0;
    const worth = Math.round(entry.shares * price);
    invested += entry.costChips;
    value += worth;
    rows.push({
      clubId: club.id,
      clubName: club.name,
      shares: entry.shares,
      price,
      averageCost: entry.shares ? Math.round(entry.costChips / entry.shares) : 0,
      value: worth,
      profit: worth - entry.costChips
    });
  }
  rows.sort((a, b) => b.value - a.value || String(a.clubId).localeCompare(String(b.clubId)));
  // `shares` va al final del objeto y con otro nombre para no pisar el bucle de
  // filas: se expone como total accionario del perfil.
  return { rows, invested, value, profit: value - invested, totalShares: sharesTotal(profile?.clubShares) };
}

// Compra de acciones. `debit` y `credit` se inyectan desde progression.js para
// que este módulo no dependa del casino (y se pueda probar solo).
function buyShares({ profile, league, clubId, shares, debit, now = Date.now() }) {
  if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
  const quote = clubPrice(league, clubId);
  if (!quote) return { ok: false, code: 'club_invalido' };
  const count = Math.floor(Number(shares) || 0);
  if (count < MIN_TRADE_SHARES) return { ok: false, code: 'cantidad_invalida' };
  const current = cleanClubShares(profile.clubShares)[clubId];
  const held = current ? current.shares : 0;
  if (held + count > MAX_SHARES_PER_CLUB) {
    return { ok: false, code: 'limite_por_club', max: MAX_SHARES_PER_CLUB, held };
  }
  if (sharesTotal(profile.clubShares) + count > MAX_SHARES_TOTAL) {
    return { ok: false, code: 'limite_total', max: MAX_SHARES_TOTAL };
  }
  const cost = Math.round(count * quote.price);
  const club = league.config.find(item => item.id === clubId);
  const paid = debit(profile, cost, `Casa Montecristo: ${count} acciones de ${club?.name || clubId}`);
  if (!paid.ok) return { ok: false, code: paid.error === 'saldo_insuficiente' ? 'fichas_insuficientes' : paid.error };
  profile.clubShares = cleanClubShares(profile.clubShares);
  profile.clubShares[clubId] = {
    shares: held + count,
    costChips: (current ? current.costChips : 0) + cost,
    updatedAt: now
  };
  return { ok: true, clubId, shares: count, price: quote.price, cost, chips: profile.chips };
}

// Venta de acciones al precio actual. Nunca se abona el precio de compra.
function sellShares({ profile, league, clubId, shares, credit, now = Date.now() }) {
  if (!profile || !profile.id) return { ok: false, code: 'sin_identidad' };
  const quote = clubPrice(league, clubId);
  if (!quote) return { ok: false, code: 'club_invalido' };
  const count = Math.floor(Number(shares) || 0);
  if (count < MIN_TRADE_SHARES) return { ok: false, code: 'cantidad_invalida' };
  const holdings = cleanClubShares(profile.clubShares);
  const current = holdings[clubId];
  if (!current || current.shares < count) return { ok: false, code: 'sin_acciones', held: current ? current.shares : 0 };
  const gross = Math.round(count * quote.price);
  const club = league.config.find(item => item.id === clubId);
  const remaining = current.shares - count;
  // El costo se prorratea: vender la mitad deja la mitad del costo original.
  const remainingCost = Math.round(current.costChips * (remaining / current.shares));
  if (remaining <= 0) delete holdings[clubId];
  else holdings[clubId] = { shares: remaining, costChips: remainingCost, updatedAt: now };
  profile.clubShares = holdings;
  credit(profile, gross, `Casa Montecristo: venta de ${count} acciones de ${club?.name || clubId}`);
  return { ok: true, clubId, shares: count, price: quote.price, gross, chips: profile.chips };
}

module.exports = {
  VERSION,
  PRICE_MIN,
  PRICE_MAX,
  PRICE_BASE,
  MOVEMENT_THRESHOLD,
  MAX_SHARES_PER_CLUB,
  MAX_SHARES_TOTAL,
  MIN_TRADE_SHARES,
  BUDGET_MILLIONS_PER_PRICE,
  clubPrice,
  clubBudget,
  publicMarket,
  canAfford,
  priceMovement,
  coachPrice,
  cleanClubShares,
  sharesTotal,
  portfolioView,
  buyShares,
  sellShares,
  // Expuestas para pruebas y para el módulo de noticias.
  tableScore,
  formScore,
  squadValue,
  ageOf
};
