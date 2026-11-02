'use strict';

// Una sola fuente de identidad: las plantillas de la temporada persistida.
// Los acumulados se derivan exclusivamente de partidos regulares asentados; el
// antiguo player.season no se actualiza y no se debe presentar como resultado.
const { cleanFantasyStats } = require('./fantasy');
const { playerValue } = require('./player-value');

function clubRoster(league, clubId) {
  const club = league?.config?.find(item => item.id === clubId);
  if (!club || !Array.isArray(club.squad)) return null;
  const totals = new Map(club.squad.map(player => [player.id,
    { appearances: 0, goals: 0, assists: 0, minutes: 0, yellowCards: 0, redCards: 0 }]));
  let missingMatches = 0, incompleteDetails = false;
  for (const match of league.calendar?.matches || []) {
    if (match.status !== 'settled' || match.desempate || ![match.homeId, match.awayId].includes(club.id)
        || !Number.isInteger(match.jornada) || match.jornada < 1 || match.jornada > 30) continue;
    const rows = cleanFantasyStats(match.fantasyStats, match);
    const teamRows = rows && rows.filter(row => row.teamId === club.id);
    const expectedGoals = match.result && match.result[match.homeId === club.id ? 'home' : 'away'];
    if (!teamRows || teamRows.length !== club.squad.length || teamRows.some(row => !totals.has(row.id))
        || !Number.isSafeInteger(expectedGoals) || teamRows.reduce((sum, row) => sum + row.goals, 0) !== expectedGoals) {
      missingMatches++;
      continue;
    }
    for (const row of teamRows) {
      const stat = totals.get(row.id);
      stat.appearances += row.played ? 1 : 0;
      stat.goals += row.goals; stat.assists += row.assists; stat.redCards += row.reds;
      if (row.minutes == null || row.yellows == null) incompleteDetails = true;
      else { stat.minutes += row.minutes; stat.yellowCards += row.yellows; }
    }
  }
  return {
    seasonMonth: league.seasonMonth, clubId: club.id, clubName: club.name,
    missingMatches, incompleteDetails,
    players: club.squad.map(player => ({
      id: player.id, name: player.name, number: player.num, position: player.pos,
      attributes: { ...player.attrs }, value: playerValue(player), stats: totals.get(player.id)
    })).sort((a, b) => a.number - b.number)
  };
}
module.exports = { clubRoster };
