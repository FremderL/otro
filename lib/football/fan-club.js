'use strict';

const { CLUBS, CLUB_BY_ID } = require('./teams');
const { officialPositions } = require('./ballon-dor-market');
const {
  PIN_CATALOG,
  TITLE_CATALOG,
  BANNER_CATALOG,
  isPinUnlocked,
  isTitleUnlocked,
  isBannerUnlocked,
  formatFanTitle,
  cleanFanClub
} = require('./fan-club-profile');

// Los progresos se derivan de resultados oficiales asentados, no del cliente ni
// de estadísticas regeneradas. Las ligas retenidas permiten cruzar temporadas.
function resultIndex(leagues, now = Date.now()) {
  const winsByClub = new Map(CLUBS.map(club => [club.id, []]));
  const titlesByClub = new Map(CLUBS.map(club => [club.id, []]));
  let reigningChampion = null;
  if (!Number.isSafeInteger(now)) return { winsByClub, titlesByClub, reigningChampion };
  for (const league of leagues?.values?.() || []) {
    const matches = league?.calendar?.matches;
    if (!Array.isArray(matches)) continue;
    for (const match of matches) {
      if (match.status !== 'settled' || match.desempate || !match.result
          || !Number.isSafeInteger(match.settledAt) || match.settledAt > now) continue;
      const home = Number(match.result.home), away = Number(match.result.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home === away) continue;
      const winner = home > away ? match.homeId : match.awayId;
      if (winsByClub.has(winner) && typeof match.id === 'string' && match.id) {
        winsByClub.get(winner).push({ id: match.id, at: match.settledAt });
      }
    }
    if (typeof league.seasonMonth === 'string' && Array.isArray(league.config) && matches.length > 0
        && matches.every(m => m.status !== 'settled' || (Number.isSafeInteger(m.settledAt) && m.settledAt <= now))) {
      const resolution = officialPositions(league);
      const championId = resolution.ok ? resolution.positions[0]?.teamId : null;
      if (championId && titlesByClub.has(championId)) {
        let settledAt = 0;
        for (const m of matches) {
          if (m.status === 'settled' && Number.isSafeInteger(m.settledAt) && m.settledAt > settledAt) {
            settledAt = m.settledAt;
          }
        }
        if (settledAt > 0 && settledAt <= now) {
          titlesByClub.get(championId).push({ seasonMonth: league.seasonMonth, at: settledAt });
          if (
            !reigningChampion
            || league.seasonMonth.localeCompare(reigningChampion.seasonMonth) > 0
            || (league.seasonMonth === reigningChampion.seasonMonth && settledAt > reigningChampion.settledAt)
          ) {
            reigningChampion = {
              clubId: championId,
              seasonMonth: league.seasonMonth,
              settledAt
            };
          }
        }
      }
    }
  }
  for (const dates of winsByClub.values()) dates.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const seasons of titlesByClub.values()) seasons.sort((a, b) => a.at - b.at || a.seasonMonth.localeCompare(b.seasonMonth));
  return { winsByClub, titlesByClub, reigningChampion };
}

function reigningLeagueChampion(leagues, now = Date.now()) {
  return resultIndex(leagues, now).reigningChampion;
}

function normalizeIndex(index) {
  if (index instanceof Map) return { winsByClub: index, titlesByClub: new Map(), reigningChampion: null };
  return index || { winsByClub: new Map(), titlesByClub: new Map(), reigningChampion: null };
}

function synchronize(profile, rawIndex) {
  const fan = cleanFanClub(profile?.footballFanClub);
  if (!fan) return false;
  const { winsByClub, titlesByClub, reigningChampion } = normalizeIndex(rawIndex);
  const seen = new Set(fan.wonMatchIds);
  const seenTitles = new Set(fan.championSeasons);
  let changed = false;
  for (const match of winsByClub.get(fan.clubId) || []) {
    if (match.at < fan.joinedAt || seen.has(match.id)) continue;
    seen.add(match.id);
    fan.wonMatchIds.push(match.id);
    fan.wins++;
    changed = true;
  }
  for (const title of titlesByClub.get(fan.clubId) || []) {
    if (title.at < fan.joinedAt || seenTitles.has(title.seasonMonth)) continue;
    seenTitles.add(title.seasonMonth);
    fan.championSeasons.push(title.seasonMonth);
    changed = true;
  }
  // Si el banner de campeón vigente expiró por coronarse un nuevo club, se limpia del almacenamiento.
  if (fan.equippedBanner === 'champion-banner' && reigningChampion && !isBannerUnlocked('champion-banner', fan, reigningChampion)) {
    fan.equippedBanner = null;
    changed = true;
  }
  if (changed) {
    fan.wonMatchIds = fan.wonMatchIds.slice(-4096);
    fan.championSeasons = fan.championSeasons.sort().slice(-120);
    profile.footballFanClub = fan;
  }
  return changed;
}

function indexedProgress(fan, index) {
  const temp = { footballFanClub: cleanFanClub(fan) };
  if (!temp.footballFanClub) return { wins: 0, championSeasons: [] };
  synchronize(temp, index);
  return {
    wins: temp.footballFanClub.wins,
    championSeasons: temp.footballFanClub.championSeasons
  };
}

function indexedVictories(fan, index) {
  return indexedProgress(fan, index).wins;
}

function victories(fan, leagues, now = Date.now()) {
  return indexedVictories(fan, resultIndex(leagues, now));
}

function syncProfiles(profiles, leagues, now = Date.now(), touch = () => {}) {
  const index = resultIndex(leagues, now);
  for (const profile of profiles?.values?.() || []) {
    if (synchronize(profile, index)) touch(profile);
  }
}

function synchronizeProfile(profile, leagues, now = Date.now()) {
  return synchronize(profile, resultIndex(leagues, now));
}

function select(profile, clubId, expectedClubId, confirmed, now = Date.now()) {
  if (!profile || typeof clubId !== 'string' || !Object.hasOwn(CLUB_BY_ID, clubId)
      || !Number.isSafeInteger(now) || now < 1) return { ok: false, code: 'invalid_club' };
  const current = cleanFanClub(profile.footballFanClub);
  if ((current?.clubId || null) !== (expectedClubId || null)) return { ok: false, code: 'club_changed' };
  if (current?.clubId === clubId) return { ok: true, unchanged: true };
  if (current && confirmed !== true) return { ok: false, code: 'confirmation_required' };
  // Sustituir toda la adhesión hace que también al volver comience desde cero;
  // no se tocan Mi Once, saldo, colección independiente ni otros juegos.
  profile.footballFanClub = {
    clubId,
    joinedAt: now,
    rankingOptIn: false,
    wins: 0,
    wonMatchIds: [],
    championSeasons: [],
    equippedPin: null,
    equippedTitle: null,
    equippedBanner: null
  };
  return { ok: true, unchanged: false };
}

function level(wins) {
  if (wins >= 20) return 5;
  if (wins >= 10) return 4;
  if (wins >= 5) return 3;
  if (wins >= 3) return 2;
  if (wins >= 1) return 1;
  return 0;
}

function ranking(profiles, leagues, now = Date.now(), index = resultIndex(leagues, now), options = {}) {
  const withMilestones = Boolean(options?.includeMilestones);
  const totals = new Map(CLUBS.map(c => [c.id, {
    clubId: c.id,
    wins: 0,
    participants: 0,
    legendFans: 0,
    championFans: 0
  }]));
  for (const profile of profiles?.values?.() || []) {
    const fan = cleanFanClub(profile?.footballFanClub);
    if (!fan?.rankingOptIn) continue;
    const row = totals.get(fan.clubId);
    const progress = indexedProgress(fan, index);
    row.wins += progress.wins;
    row.participants++;
    if (progress.wins >= 5) row.legendFans++;
    if (progress.championSeasons.length > 0) row.championFans++;
  }
  const rows = [...totals.values()].filter(row => row.participants > 0)
    .sort((a, b) => b.wins - a.wins || b.participants - a.participants || a.clubId.localeCompare(b.clubId));
  return rows.map((row, idx) => {
    const base = { clubId: row.clubId, wins: row.wins, participants: row.participants, rank: idx + 1 };
    if (withMilestones) {
      base.legendFans = row.legendFans;
      base.championFans = row.championFans;
    }
    return base;
  });
}

function snapshot(profile, profiles, leagues, now = Date.now()) {
  const fan = cleanFanClub(profile?.footballFanClub);
  const index = resultIndex(leagues, now);
  const reigning = index.reigningChampion;
  const progress = indexedProgress(fan, index);
  const wins = progress.wins;
  const championSeasons = progress.championSeasons;
  const championships = championSeasons.length;
  const currentLevel = level(wins);
  const club = fan ? CLUB_BY_ID[fan.clubId] : null;
  const equippedPin = fan?.equippedPin && isPinUnlocked(fan.equippedPin, wins, championships) ? fan.equippedPin : null;
  const equippedTitle = fan?.equippedTitle && isTitleUnlocked(fan.equippedTitle, wins, championships) ? fan.equippedTitle : null;
  const equippedBanner = fan?.equippedBanner && isBannerUnlocked(fan.equippedBanner, fan, reigning) ? fan.equippedBanner : null;

  const rewards = fan
    ? PIN_CATALOG.map(spec => ({
      id: spec.id,
      tier: spec.tier,
      badge: spec.badge,
      kind: spec.kind || 'wins',
      title: spec.title,
      subtitle: spec.subtitle,
      target: spec.target,
      progress: spec.kind === 'championship' ? Math.min(spec.target, championships) : Math.min(spec.target, wins),
      unlocked: isPinUnlocked(spec.id, wins, championships),
      equipped: equippedPin === spec.id
    }))
    : [];

  const titles = fan
    ? TITLE_CATALOG.map(spec => ({
      id: spec.id,
      kind: spec.kind,
      title: spec.title,
      label: formatFanTitle(spec.id, club),
      target: spec.target,
      progress: spec.kind === 'championship' ? Math.min(spec.target, championships) : Math.min(spec.target, wins),
      unlocked: isTitleUnlocked(spec.id, wins, championships),
      equipped: equippedTitle === spec.id
    }))
    : [];

  const banners = fan
    ? BANNER_CATALOG.map(spec => ({
      id: spec.id,
      kind: spec.kind,
      limitedTime: spec.limitedTime,
      art: spec.art,
      crest: `/assets/escudos/${club.abbr}.svg`,
      clubId: club.id,
      clubName: club.name,
      abbr: club.abbr,
      primary: club.primary,
      secondary: club.secondary,
      title: spec.title,
      subtitle: spec.subtitle,
      seasonMonth: spec.kind === 'reigning_champion' && reigning?.clubId === club.id ? reigning.seasonMonth : null,
      unlocked: isBannerUnlocked(spec.id, fan, reigning),
      equipped: equippedBanner === spec.id
    }))
    : [];

  return {
    clubId: fan?.clubId || null,
    joinedAt: fan?.joinedAt || null,
    wins,
    level: currentLevel,
    championships,
    championSeasons,
    reigningChampion: reigning ? {
      clubId: reigning.clubId,
      clubName: CLUB_BY_ID[reigning.clubId]?.name || reigning.clubId,
      seasonMonth: reigning.seasonMonth
    } : null,
    rankingOptIn: fan?.rankingOptIn === true,
    ranking: ranking(profiles, leagues, now, index),
    equippedPin,
    equippedTitle,
    equippedTitleLabel: equippedTitle && club ? formatFanTitle(equippedTitle, club) : null,
    equippedBanner,
    rewards,
    titles,
    banners
  };
}

module.exports = {
  cleanFanClub,
  victories,
  reigningLeagueChampion,
  select,
  level,
  ranking,
  snapshot,
  syncProfiles,
  synchronizeProfile
};
