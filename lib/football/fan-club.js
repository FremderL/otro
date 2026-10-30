'use strict';

const { CLUBS, CLUB_BY_ID } = require('./teams');
const { cleanFanClub } = require('./fan-club-profile');

// Los progresos se derivan de resultados oficiales asentados, no del cliente ni
// de estadísticas regeneradas. Las ligas retenidas permiten cruzar temporadas.
function resultIndex(leagues, now = Date.now()) {
  const index = new Map(CLUBS.map(club => [club.id, []]));
  if (!Number.isSafeInteger(now)) return index;
  for (const league of leagues?.values?.() || []) {
    for (const match of league?.calendar?.matches || []) {
      if (match.status !== 'settled' || match.desempate || !match.result
          || !Number.isSafeInteger(match.settledAt) || match.settledAt > now) continue;
      const home = Number(match.result.home), away = Number(match.result.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home === away) continue;
      const winner = home > away ? match.homeId : match.awayId;
      if (index.has(winner) && typeof match.id === 'string' && match.id) index.get(winner).push({ id:match.id, at:match.settledAt });
    }
  }
  for (const dates of index.values()) dates.sort((a,b) => a.at-b.at || a.id.localeCompare(b.id));
  return index;
}
function synchronize(profile, index) {
  const fan = cleanFanClub(profile?.footballFanClub);
  if (!fan) return false;
  const seen = new Set(fan.wonMatchIds);
  let changed = false;
  for (const match of index.get(fan.clubId) || []) {
    if (match.at < fan.joinedAt || seen.has(match.id)) continue;
    seen.add(match.id); fan.wonMatchIds.push(match.id); fan.wins++; changed = true;
  }
  if (changed) { fan.wonMatchIds = fan.wonMatchIds.slice(-4096); profile.footballFanClub = fan; }
  return changed;
}
function indexedVictories(fan, index) {
  const temp = { footballFanClub:cleanFanClub(fan) };
  if (!temp.footballFanClub) return 0;
  synchronize(temp, index);
  return temp.footballFanClub.wins;
}
function victories(fan, leagues, now = Date.now()) { return indexedVictories(fan, resultIndex(leagues, now)); }
function syncProfiles(profiles, leagues, now = Date.now(), touch = () => {}) {
  const index = resultIndex(leagues, now);
  for (const profile of profiles?.values?.() || []) if (synchronize(profile, index)) touch(profile);
}

function select(profile, clubId, expectedClubId, confirmed, now = Date.now()) {
  if (!profile || typeof clubId !== 'string' || !Object.hasOwn(CLUB_BY_ID, clubId)
      || !Number.isSafeInteger(now) || now < 1) return { ok:false, code:'invalid_club' };
  const current = cleanFanClub(profile.footballFanClub);
  if ((current?.clubId || null) !== (expectedClubId || null)) return { ok:false, code:'club_changed' };
  if (current?.clubId === clubId) return { ok:true, unchanged:true };
  if (current && confirmed !== true) return { ok:false, code:'confirmation_required' };
  // Sustituir toda la adhesión hace que también al volver comience desde cero;
  // no se tocan Mi Once, saldo, colección independiente ni otros juegos.
  profile.footballFanClub = { clubId, joinedAt:now, rankingOptIn:false, wins:0, wonMatchIds:[], equippedPin:null };
  return { ok:true, unchanged:false };
}

function level(wins) { return wins >= 5 ? 3 : wins >= 3 ? 2 : wins >= 1 ? 1 : 0; }
function ranking(profiles, leagues, now = Date.now(), index = resultIndex(leagues, now)) {
  const totals = new Map(CLUBS.map(c => [c.id, { clubId:c.id, wins:0, participants:0 }]));
  for (const profile of profiles?.values?.() || []) {
    const fan = cleanFanClub(profile?.footballFanClub);
    if (!fan?.rankingOptIn) continue;
    const row = totals.get(fan.clubId);
    row.wins += indexedVictories(fan, index); row.participants++;
  }
  const rows = [...totals.values()].filter(row => row.participants > 0)
    .sort((a,b) => b.wins - a.wins || b.participants - a.participants || a.clubId.localeCompare(b.clubId));
  return rows.map((row, index) => ({ ...row, rank:index + 1 }));
}
function snapshot(profile, profiles, leagues, now = Date.now()) {
  const fan = cleanFanClub(profile?.footballFanClub);
  const index = resultIndex(leagues, now);
  const wins = indexedVictories(fan, index);
  const currentLevel = level(wins);
  const equipped = fan?.equippedPin || null;
  return { clubId:fan?.clubId || null, joinedAt:fan?.joinedAt || null, wins, level:currentLevel,
    rankingOptIn:fan?.rankingOptIn === true, ranking:ranking(profiles, leagues, now, index), equippedPin:equipped,
    rewards:fan ? [{ id:'club-pin', title:'Pin del club', target:0, progress:0, unlocked:true, equipped:equipped==='club-pin' },
      { id:'fan-1', title:'Primera victoria', target:1, progress:Math.min(1,wins), unlocked:currentLevel >= 1, equipped:equipped==='fan-1' },
      { id:'fan-2', title:'Tribuna fiel', target:3, progress:Math.min(3,wins), unlocked:currentLevel >= 2, equipped:equipped==='fan-2' },
      { id:'fan-3', title:'Afición de leyenda', target:5, progress:Math.min(5,wins), unlocked:currentLevel >= 3, equipped:equipped==='fan-3' }] : [] };
}
module.exports = { cleanFanClub, victories, select, level, ranking, snapshot, syncProfiles };
