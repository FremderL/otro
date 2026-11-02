'use strict';

// Ficha editorial de lectura: no modifica la liga ni la alineación del motor.
const { CLUB_BY_ID } = require('./teams');
const { clubRoster } = require('./roster');
const { createLineups } = require('./match-state');
const { officialPositions } = require('./ballon-dor-market');
const { publicTransfers } = require('./transfers');

// Historias y técnicos ficticios, estables por club. No son resultados ni tienen
// atributos ocultos que afecten la simulación.
const LORE = {
  vantora_fc: ['Camilo Valera', 'En Vantora, un grupo de vecinos convirtió una cancha de barrio en un punto de reunión. Desde entonces la grada celebra cada pase como una promesa de volver a empezar.'],
  united_vanguard: ['Bruno Alcázar', 'En Vanguard City, los primeros aficionados pintaron sus colores en una vieja pared. El club creció entre tardes de presión alta y cánticos que nunca se apagan.'],
  olympique_estevin: ['Lucien Vidal', 'Estevin aprendió a reír y competir en la misma tarde. Sus primeros equipos jugaron entre plazas y cafés antes de encontrar casa en su estadio.'],
  atletico_solaris: ['Mateo Solís', 'En Solaris, un equipo de amigos siguió jugando hasta que se encendían las luces. Su identidad quedó ligada a la energía de esas noches.'],
  sporting_almar: ['Marina Salcedo', 'Almara juntó a familias de distintos barrios alrededor de una pelota. Su grada convirtió aquella reunión en una tradición que acompaña al club.'],
  dynamo_kelvar: ['Héctor Mena', 'Kelvar nació con la idea de recuperar cada balón. En sus calles se cuenta que el primer entrenamiento terminó solo cuando ya no quedaba luz.'],
  cs_verdania: ['Nora Beltrán', 'Verdania encontró en el fútbol un lenguaje común. Sus colores recorrieron patios y parques hasta reunir a toda una comunidad.'],
  halcyon_bay_fc: ['Iván Faro', 'Junto al puerto de Halcyon Bay, los partidos se anunciaban mirando al faro. La afición conserva esa costumbre como símbolo de encuentro.'],
  athletic_ferrata: ['Renato Forja', 'En Ferrata, los veteranos del barrio enseñaron a los más jóvenes a jugar con paciencia. La mezcla de experiencia y entusiasmo dio forma al club.'],
  royal_corvane: ['Émile Corona', 'Corvane convirtió las tardes de fútbol en una fiesta de barrio. Su público aprendió a disfrutar tanto de una buena defensa como de una celebración.'],
  sv_talbruck: ['Greta Vogel', 'Talbruck se reunió por primera vez en un campo junto a la estación. De aquellos viajes cortos nació una afición que acompaña al club a todas partes.'],
  velmar_harbour_fc: ['Luca Marino', 'En el muelle de Velmar, trabajadores y vecinos improvisaban partidos después de la jornada. El humor de la grada se volvió parte de su identidad.'],
  norvela_sporting: ['Amelia Rojas', 'Norvela levantó su equipo con la ayuda de comercios y familias. Cada encuentro sigue siendo una excusa para reunirse en torno a sus colores.'],
  ironvale_fc: ['Darío Neri', 'Ironvale forjó su carácter en canchas difíciles y partidos disputados. Sus seguidores valoran el esfuerzo colectivo tanto como el marcador.'],
  peregrine_rovers: ['Celia Ocampo', 'Peregrine empezó como una reunión itinerante de aficionados. Sus viajes dejaron historias que la grada sigue contando antes de cada encuentro.'],
  puerto_ambar: ['Ámbar Paredes', 'En Puerto Ámbar, el primer equipo reunió a vecinos de la costa. El club conserva el espíritu solidario de aquellas tardes compartidas.']
};

function clubProfile(store, clubId, now = Date.now()) {
  const identity = CLUB_BY_ID[clubId];
  const league = store?.getLeague(store.getCurrentSeasonMonth());
  const club = league?.config?.find(c => c.id === clubId);
  if (!identity || !club || !Array.isArray(club.squad) || !league.calendar?.matches) return null;
  const results = league.calendar.matches.filter(m => m.status === 'settled' && !m.desempate && m.result
    && [m.homeId, m.awayId].includes(clubId) && Number.isSafeInteger(m.settledAt) && m.settledAt <= now);
  const record = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
  for (const match of results) {
    const home = match.homeId === clubId;
    const scored = Number(home ? match.result.home : match.result.away);
    const conceded = Number(home ? match.result.away : match.result.home);
    if (!Number.isSafeInteger(scored) || scored < 0 || !Number.isSafeInteger(conceded) || conceded < 0) continue;
    record.played++; record.goalsFor += scored; record.goalsAgainst += conceded;
    if (scored > conceded) record.wins++; else if (scored === conceded) record.draws++; else record.losses++;
  }
  const titles = [];
  const transfers = [];
  const leagues = [...(store.leagues?.values?.() || [])].filter(item => item && item.seasonMonth <= league.seasonMonth)
    .sort((a, b) => b.seasonMonth.localeCompare(a.seasonMonth));
  for (const item of leagues) {
    if (!item.calendar?.matches || !Array.isArray(item.config)) continue;
    // Solo temporadas completas y resueltas según las reglas oficiales.
    if (item.calendar.matches.every(m => m.status !== 'settled' || (Number.isSafeInteger(m.settledAt) && m.settledAt <= now))) {
      const resolution = officialPositions(item);
      if (resolution.ok && resolution.positions[0]?.teamId === clubId) titles.push(item.seasonMonth);
    }
    const plan = publicTransfers(item, now);
    if (!['announced', 'effective'].includes(plan.status)) continue;
    const target = store.getLeague(plan.effectiveSeason);
    for (const move of plan.moves) {
      if (move.fromId !== clubId && move.toId !== clubId) continue;
      // Un anuncio efectivo sin plantilla destino no demuestra que se aplicara.
      if (plan.status === 'effective' && !target?.config?.find(c => c.id === move.toId)?.squad?.some(p => p.id === move.playerId)) continue;
      transfers.push({ ...move, status: plan.status, seasonMonth: plan.seasonMonth, effectiveSeason: plan.effectiveSeason });
    }
  }
  const other = league.config.find(c => c.id !== clubId && Array.isArray(c.squad));
  const lineup = other ? createLineups(club, other).home : null;
  const roster = clubRoster(league, clubId);
  return {
    clubId, name: identity.name, city: identity.city, stadium: identity.stadium, capacity: identity.capacity,
    colors: identity.colors, seasonMonth: league.seasonMonth,
    manager: { name: LORE[clubId][0], formation: club.tactics.formation, style: club.tactics.style, record },
    story: LORE[clubId][1], titles, record, transfers, roster,
    lineup: lineup ? lineup.players.map(p => ({ id: p.id, role: p.role, initialStatus: p.initialStatus })) : []
  };
}
module.exports = { clubProfile, LORE };
