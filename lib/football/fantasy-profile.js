'use strict';

// Solo datos privados de Mi Once; nunca contiene saldo, nombres de cuentas ni
// estadísticas calculadas en el navegador.
function cleanFantasy(raw) {
  if (!raw || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw.season || '') || !Array.isArray(raw.lineups)) return null;
  const seen = new Set();
  const lineups = [];
  for (const item of raw.lineups.slice(0, 30)) {
    if (!item || !Number.isInteger(item.jornada) || item.jornada < 1 || item.jornada > 30 || seen.has(item.jornada)
      || !Number.isSafeInteger(item.savedAt) || item.savedAt < 1 || !Array.isArray(item.players) || item.players.length !== 11
      || !item.players.every(id => typeof id === 'string' && id.length > 0 && id.length <= 80)
      || new Set(item.players).size !== 11) continue;
    seen.add(item.jornada);
    lineups.push({ jornada: item.jornada, savedAt: item.savedAt, players: item.players.slice() });
  }
  lineups.sort((a, b) => a.jornada - b.jornada);
  return { season: raw.season, lineups, rankingOptIn: raw.rankingOptIn === true };
}
module.exports = { cleanFantasy };
