'use strict';

// Casa Montecristo, carreras e inactivos: las tres piezas nuevas del Estadio.
//
// Se prueban las promesas que el diseño hace al jugador:
//   · nadie se inventa una edad ni un retiro por azar: todo es determinista;
//   · un retiro deja la plantilla en 18 con un cantero del propio club;
//   · el fondo de inactivos no se rellena solo y recicla a quien libera su plaza;
//   · el precio de un club sale de datos verificados y fija su presupuesto;
//   · un club no puede pagar lo que no le alcanza;
//   · comprar y vender acciones mueve fichas de verdad, con topes;
//   · todo hecho de club se anuncia en MonteCristo News.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const careers = require('../lib/football/careers');
const freeAgents = require('../lib/football/free-agents');
const stock = require('../lib/football/club-stock');
const { cleanClubShares, sharesTotal } = require('../lib/football/club-shares');
const { buildClubNews } = require('../lib/football/club-news');
const { debit, credit } = require('../lib/progression');
const { playerValue } = require('../lib/football/player-value');

function withStore(t, seasons = ['2026-10']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casa-'));
  const store = new FootballStore(path.join(dir, 'f.json'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const leagues = seasons.map(season => store.generateSeason(season));
  return { store, dir, leagues };
}

// --- Carreras ---------------------------------------------------------------

test('la edad se deriva del id y la temporada, sin almacenar nada y siempre en banda', () => {
  const ages = new Set();
  for (let i = 0; i < 200; i++) ages.add(careers.ageOf(`vtr_${String(i).padStart(2, '0')}`, '2026-10'));
  for (const age of ages) {
    assert.ok(age >= careers.MIN_AGE && age <= careers.MAX_AGE, `edad en banda: ${age}`);
  }
  assert.ok(ages.size > 10, 'no todos los jugadores tienen la misma edad');
  // La misma consulta devuelve siempre lo mismo, y avanza una temporada por mes.
  assert.equal(careers.ageOf('vtr_01', '2026-10'), careers.ageOf('vtr_01', '2026-10'));
  // Cada temporada es un mes de liga: la edad avanza exactamente una unidad
  // (o se queda en el techo, porque a los 37 el retiro es seguro).
  // Se prueba con un jugador que aún no toca el techo, para medir la progresión
  // sin que la saturación la enmascare.
  const youngId = Array.from({ length: 400 }, (_, i) => `joven_${i}`)
    .find(id => careers.ageOf(id, careers.CAREER_EPOCH) <= 22);
  const youngBase = careers.ageOf(youngId, careers.CAREER_EPOCH);
  assert.equal(careers.ageOf(youngId, '2026-11'), youngBase + 1, 'la siguiente temporada suma un año');
  assert.equal(careers.ageOf(youngId, '2027-10'), youngBase + 12, 'doce temporadas, doce años');
  // Y con uno veterano: la edad se satura en el techo, nunca lo pasa.
  assert.equal(careers.ageOf('vtr_01', '2027-10'), careers.MAX_AGE, 'nadie pasa de la edad máxima');
  // La edad nunca retrocede: un veterano no rejuvenece.
  let previous = 0;
  for (let year = 2026; year <= 2032; year++) {
    const age = careers.ageOf('vtr_01', `${year}-10`);
    assert.ok(age >= previous, 'la edad es monótona');
    previous = age;
  }
  assert.equal(careers.retirementRoll(`retiro_fijo`, '2026-10').age <= careers.MAX_AGE, true);
});

test('los retiros son un evento: no en toda temporada, deterministas y con tope', t => {
  const { leagues } = withStore(t, ['2026-10']);
  const clubs = leagues[0].config;
  let withRetirements = 0;
  for (let month = 1; month <= 12; month++) {
    const season = `2027-${String(month).padStart(2, '0')}`;
    const planned = careers.planRetirements(clubs, season);
    assert.ok(planned.length <= careers.MAX_RETIREMENTS_PER_SEASON, 'tope por temporada');
    assert.deepEqual(planned, careers.planRetirements(clubs, season), 'determinista');
    if (planned.length) withRetirements++;
  }
  assert.ok(withRetirements > 0, 'alguna temporada tiene retiros');
  assert.ok(withRetirements < 12, 'pero no todas: es un evento, no una nómina');
});

test('un retiro deja la plantilla en 18 con un cantero del propio club', t => {
  const { leagues } = withStore(t, ['2026-10', '2026-11']);
  const before = leagues[0];
  const after = leagues[1];
  const retirements = after.careers.retirements;
  const debuts = after.careers.debuts;
  assert.equal(retirements.length, debuts.length, 'cada retiro tiene su canterano');
  for (const club of after.config) {
    assert.equal(club.squad.length, 18);
    assert.equal(new Set(club.squad.map(p => p.num)).size, 18, 'dorsales únicos');
  }
  for (const debut of debuts) {
    const club = after.config.find(c => c.id === debut.clubId);
    const youth = club.squad.find(p => p.id === debut.player.id);
    assert.ok(youth, 'el canterano está en el club');
    assert.equal(youth.num, debut.player.num, 'hereda el dorsal');
    assert.equal(youth.pos, debut.player.pos, 'hereda la posición');
    // Nunca estaba antes: es una persona nueva, no un id reciclado.
    assert.ok(!before.config.some(c => c.squad.some(p => p.id === youth.id)), 'id nuevo');
  }
});

test('la promesa del año aparece en algunas temporadas y entra al fondo, no a un club', t => {
  const { leagues } = withStore(t, ['2026-10']);
  const league = leagues[0];
  if (careers.hasWonderkid(league.seasonMonth)) {
    const kid = league.careers.wonderkid;
    assert.ok(kid && kid.id, 'la promesa queda registrada');
    assert.ok(league.freeAgents.players.some(p => p.id === kid.id && p.wonderkid), 'está en la lista de inactivos');
    assert.ok(!league.config.some(c => c.squad.some(p => p.id === kid.id)), 'no nace dentro de un club');
  }
  // Una de cada dos, aproximadamente: en 12 temporadas hay de las dos clases.
  const seasons = Array.from({ length: 12 }, (_, i) => `2030-${String((i % 12) + 1).padStart(2, '0')}`);
  const hits = seasons.filter(season => careers.hasWonderkid(season)).length;
  assert.ok(hits > 0 && hits < seasons.length, 'no siempre, y no nunca');
});

// --- Lista de inactivos -----------------------------------------------------

test('el fondo no se rellena solo: empieza vacío de jugadores y crece con bajas', () => {
  const initial = freeAgents.initialFreeAgents();
  assert.equal(initial.players.length, 0, 'nadie se inventa agentes libres');
  assert.ok(initial.coaches.length > 0, 'los DT libres sí existen desde el inicio');

  const player = { id: 'p1', name: 'Prueba Uno', pos: 'CM', attrs: { pas: 70, pac: 60, sho: 50, def: 40, gk: 10, agr: 40 } };
  const grown = freeAgents.addFreePlayer(initial, player, { releasedFrom: 'vantora_fc', seasonMonth: '2026-10' });
  assert.equal(grown.players.length, 1);
  assert.equal(freeAgents.addFreePlayer(grown, player).players.length, 1, 'idempotente por id');
  assert.equal(freeAgents.removeFreePlayer(grown, 'p1').players.length, 0);
});

test('un DT despedido vuelve a la lista de inactivos con su último club', t => {
  const { leagues } = withStore(t, ['2026-10', '2026-11']);
  const listed = leagues[1].freeAgents.coaches;
  assert.ok(listed.length > 0);
  for (const coach of listed) {
    assert.ok(coach.id && coach.name, 'todo DT del fondo tiene identidad');
    if (coach.lastClubName) assert.ok(coach.sackedAfterSeason, 'si salió de un club, consta cuándo');
  }
});

// --- Casa Montecristo -------------------------------------------------------

test('el precio de cada club es determinista y sale de datos verificados', t => {
  const { leagues } = withStore(t, ['2026-10']);
  const league = leagues[0];
  const market = stock.publicMarket(league);
  assert.equal(market.clubs.length, 16);
  for (const row of market.clubs) {
    assert.ok(row.price >= stock.PRICE_MIN && row.price <= stock.PRICE_MAX, `precio en banda: ${row.price}`);
    assert.ok(row.budget > 0, 'todo club tiene presupuesto');
    assert.equal(row.price, stock.clubPrice(league, row.clubId).price, 'misma consulta, mismo precio');
  }
  // Ordenado de mayor a menor: el parqué se lee de un vistazo.
  for (let i = 1; i < market.clubs.length; i++) {
    assert.ok(market.clubs[i - 1].price >= market.clubs[i].price);
  }
});

test('los resultados mueven el precio: un club que gana sube y uno que pierde baja', t => {
  const { leagues } = withStore(t, ['2026-10']);
  const league = leagues[0];
  const before = stock.clubPrice(league, 'vantora_fc').price;
  // Simular la temporada con un líder claro y un colista claro.
  league.standings = league.config.map((club, index) => ({
    clubId: club.id,
    played: 10,
    points: index === 0 ? 30 : index === 15 ? 0 : 12,
    goalDiff: index === 0 ? 20 : index === 15 ? -20 : 0,
    goalsFor: 20,
    goalsAgainst: 10
  }));
  const leader = stock.clubPrice(league, league.config[0].id).price;
  const bottom = stock.clubPrice(league, league.config[15].id).price;
  assert.ok(leader > bottom, 'el líder cotiza por encima del colista');
  // Con la liga vacía el precio del club es el mismo que antes de tocar la tabla.
  league.standings = [];
  assert.equal(stock.clubPrice(league, 'vantora_fc').price, before, 'sin partidos el precio vuelve al de diseño');
  assert.ok(Number.isFinite(leader));
});

test('el presupuesto es el techo de la oferta: el club rico puede, el pobre no', t => {
  const { leagues } = withStore(t, ['2026-10']);
  const league = leagues[0];
  // Empujar un club arriba y otro abajo para tener un rico y un pobre claros.
  league.standings = league.config.map((club, index) => ({
    clubId: club.id,
    played: 10,
    points: index === 0 ? 30 : index === 15 ? 0 : 15,
    goalDiff: index === 0 ? 25 : index === 15 ? -25 : 0,
    goalsFor: 20,
    goalsAgainst: 10
  }));
  const rich = league.config[0].id, poor = league.config[15].id;
  const richBudget = stock.clubBudget(league, rich).budget;
  const poorBudget = stock.clubBudget(league, poor).budget;
  assert.ok(richBudget > poorBudget, 'el rico tiene más presupuesto');
  assert.equal(stock.canAfford(league, rich, richBudget + 1).code, 'presupuesto_insuficiente');
  assert.equal(stock.canAfford(league, rich, Math.floor(richBudget)).ok, true, 'dentro del presupuesto se puede');
  assert.equal(stock.canAfford(league, poor, Math.floor(poorBudget) + 1).ok, false, 'un millón de más ya no');
});

test('comprar y vender acciones mueve fichas de verdad, con topes por club y totales', t => {
  const { leagues } = withStore(t, ['2026-10']);
  const league = leagues[0];
  const market = stock.publicMarket(league);
  const target = market.clubs[0];
  const profile = { id: 'u1', chips: 100000, clubShares: {} };

  const bought = stock.buyShares({ profile, league, clubId: target.clubId, shares: 3, debit, now: 1 });
  assert.equal(bought.ok, true);
  assert.equal(bought.cost, Math.round(3 * target.price));
  assert.equal(profile.chips, 100000 - bought.cost, 'el débito es real');
  assert.equal(stock.portfolioView(profile, league).totalShares, 3);

  const sold = stock.sellShares({ profile, league, clubId: target.clubId, shares: 1, credit, now: 2 });
  assert.equal(sold.ok, true);
  assert.equal(sold.gross, Math.round(1 * target.price));
  assert.equal(stock.portfolioView(profile, league).totalShares, 2);

  // Sin acciones no se vende; sin fichas no se compra.
  assert.equal(stock.sellShares({ profile, league, clubId: target.clubId, shares: 9, credit }).ok, false);
  const broke = { id: 'u2', chips: 1, clubShares: {} };
  assert.equal(stock.buyShares({ profile: broke, league, clubId: target.clubId, shares: 2, debit }).code, 'fichas_insuficientes');

  // Topes: 200 por club y 600 en total.
  const whale = { id: 'u3', chips: 1000000, clubShares: {} };
  let totalBought = 0;
  for (const club of market.clubs) {
    const result = stock.buyShares({ profile: whale, league, clubId: club.clubId, shares: 200, debit });
    if (result.ok) totalBought += 200;
    else { assert.equal(result.code, 'limite_total'); break; }
  }
  assert.equal(totalBought, stock.MAX_SHARES_TOTAL, 'el tope global es 600');
});

test('la cartera del perfil se normaliza: enteros, topes y sin basura', () => {
  const dirty = {
    vantora_fc: { shares: 999, costChips: 12.7, updatedAt: 'x' },
    otro: { shares: -3 },
    inventado: { shares: 4.9, costChips: 100 }
  };
  const clean = cleanClubShares(dirty);
  assert.equal(clean.vantora_fc.shares, stock.MAX_SHARES_PER_CLUB, 'tope por club');
  assert.equal(clean.otro, undefined, 'cero acciones no se guarda');
  assert.equal(clean.inventado.shares, 4, 'entero hacia abajo');
  assert.ok(sharesTotal(clean) <= stock.MAX_SHARES_TOTAL);
});

// --- Noticias y mercado -----------------------------------------------------

test('MonteCristo News anuncia retiros, cantera, promesa, fichajes y la Casa', t => {
  const { leagues } = withStore(t, ['2026-10', '2026-11']);
  const news = buildClubNews({ league: leagues[1], previousLeague: leagues[0] });
  const types = new Set(news.map(item => item.type));
  // Cada anuncio es una tarjeta completa, nunca un texto suelto.
  for (const item of news) {
    assert.ok(item.id && item.type && item.badge && item.headline, 'tarjeta completa');
    assert.ok(item.summary && item.spoken, 'resumen y locución');
    assert.ok(Number.isFinite(item.priority));
  }
  if (leagues[1].careers.retirements.length) {
    assert.ok(types.has('player_retirement'), 'el retiro se anuncia');
    assert.ok(types.has('youth_debut'), 'el canterano se anuncia');
  }
  if (leagues[1].careers.wonderkid) assert.ok(types.has('wonderkid_spotlight'), 'la promesa se anuncia');
  assert.ok(news.every(item => item.type !== 'transfer_signing' || /DT|promesa|puja/i.test(item.summary)),
    'el fichaje explica el porqué');
});

test('un fichaje desde la lista de inactivos conserva la plantilla en 18 y recicla el fondo', t => {
  const { store, leagues } = withStore(t, ['2026-10', '2026-11']);
  const before = leagues[0];
  const after = leagues[1];
  const plan = require('../lib/football/transfers').planTransfers(before);
  const free = plan.moves.filter(move => move.fromId == null);
  for (const move of free) {
    const club = after.config.find(c => c.id === move.toId);
    assert.equal(club.squad.length, 18, 'la plantilla no crece');
    assert.ok(club.squad.some(p => p.id === move.playerId), 'el fichado está en el club');
    assert.ok(move.releasedPlayerId, 'alguien libera su plaza');
    // El liberado es ahora quien está en el fondo: el fondo se recicla, no crece.
    assert.ok(after.freeAgents.players.some(p => p.id === move.releasedPlayerId), 'el liberado entra al fondo');
  }
  assert.ok(plan.freeAgents, 'el plan devuelve el fondo resultante');
  assert.ok(!after.freeAgents.players.some(p => free.some(m => m.playerId === p.id)), 'quien ficha sale del fondo');
  // Y ningún jugador del fondo ficha por encima de su presupuesto.
  for (const move of free) {
    assert.ok(move.fee <= move.budget, `${move.playerName}: ${move.fee} dentro de ${move.budget}`);
    assert.ok(playerValue({ pos: move.position || 'CM', attrs: {} }) >= 0);
  }
  store.close;
});

test('un salto de mes no inventa retiros ni canteranos', t => {
  const { leagues } = withStore(t, ['2026-10', '2027-01']);
  assert.equal(leagues[1].careers.retirements.length, 0, 'nadie se retira en un hueco');
  assert.equal(leagues[1].careers.debuts.length, 0);
  assert.equal(leagues[1].freeAgents.players.length, leagues[0].freeAgents.players.length, 'el fondo no cambia solo');
  for (const club of leagues[1].config) assert.equal(club.squad.length, 18);
});
