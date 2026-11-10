'use strict';

// Misiones cooperativas semanales para los Clubes Sociales de la Comunidad.
// Respeta la Decisión C6: solo juegos del Casino y Lotería alimentan las metas
// cooperativas (el Estadio permanece 100 % cosmético y separado).

const CLUB_MISSION_GAMES = new Set([
  'poker',
  'blackjack',
  'roulette',
  'dice',
  'coinflip',
  'slots',
  'fortune',
  'loteria'
]);

const MAX_WEEKLY_LOG = 250;
const WEEK_KEY_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const SEASON_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const CLUB_WEEKLY_MISSIONS = Object.freeze([
  {
    id: 'coop_rounds',
    icon: '🎲',
    title: 'Mesa compartida',
    description: 'Sumen 15 rondas válidas entre integrantes del club esta semana.',
    target: 15,
    personalReward: 150,
    treasuryReward: 200,
    measure: stats => ({ progress: Math.min(15, stats.rounds), completed: stats.rounds >= 15 })
  },
  {
    id: 'coop_wins',
    icon: '🏆',
    title: 'Racha de hermandad',
    description: 'Consigan 8 victorias válidas entre integrantes esta semana.',
    target: 8,
    personalReward: 200,
    treasuryReward: 300,
    measure: stats => ({ progress: Math.min(8, stats.wins), completed: stats.wins >= 8 })
  },
  {
    id: 'coop_variety',
    icon: '🧭',
    title: 'Gira MonteCristo',
    description: 'Jueguen en 4 juegos distintos del casino como club esta semana.',
    target: 4,
    personalReward: 250,
    treasuryReward: 350,
    measure: stats => ({ progress: Math.min(4, stats.games.size), completed: stats.games.size >= 4 })
  },
  {
    id: 'coop_teamwork',
    icon: '🤝',
    title: 'Círculo activo',
    description: 'Al menos 2 integrantes activos y 6 rondas jugadas en conjunto.',
    target: 6,
    minActiveMembers: 2,
    personalReward: 200,
    treasuryReward: 250,
    measure: stats => ({
      progress: Math.min(6, stats.rounds),
      activeMembers: stats.activeMembers,
      requiredMembers: 2,
      completed: stats.activeMembers >= 2 && stats.rounds >= 6
    })
  }
]);

const CLUB_MISSION_BY_ID = Object.freeze(
  Object.fromEntries(CLUB_WEEKLY_MISSIONS.map(item => [item.id, item]))
);
const VALID_MISSION_IDS = new Set(CLUB_WEEKLY_MISSIONS.map(item => item.id));

function clubWeekKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const value = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(value.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((value - firstThursday) / 604800000);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function cleanClubWeekly(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.key !== 'string' || !WEEK_KEY_RE.test(raw.key)) return null;
  const claimed = Array.isArray(raw.claimed)
    ? [...new Set(raw.claimed.filter(id => typeof id === 'string' && VALID_MISSION_IDS.has(id)))]
    : [];
  const log = Array.isArray(raw.log)
    ? raw.log
      .filter(entry => entry && typeof entry === 'object'
        && Number.isSafeInteger(entry.at) && entry.at > 0
        && typeof entry.game === 'string' && CLUB_MISSION_GAMES.has(entry.game))
      .map(entry => ({ at: entry.at, game: entry.game, won: entry.won ? 1 : 0 }))
      .slice(-MAX_WEEKLY_LOG)
    : [];
  return { key: raw.key, claimed, log };
}

function cleanClubSeasonBadges(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const seasonKey = typeof item.seasonKey === 'string' && SEASON_KEY_RE.test(item.seasonKey) ? item.seasonKey : null;
    const clubId = typeof item.clubId === 'string' && item.clubId.length > 0 && item.clubId.length <= 80 ? item.clubId : null;
    const place = Math.floor(Number(item.place) || 0);
    if (!seasonKey || !clubId || ![1, 2, 3].includes(place)) continue;
    const dedupe = `${seasonKey}:${clubId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      seasonKey,
      clubId,
      clubName: typeof item.clubName === 'string' ? item.clubName.slice(0, 60) : 'Club',
      place
    });
  }
  return out.slice(-48);
}

function recordClubRoundOnProfile(profile, { game, won = false, at = Date.now() } = {}) {
  if (!profile || !game || !CLUB_MISSION_GAMES.has(game)) return false;
  const timestamp = Number.isSafeInteger(at) && at > 0 ? at : Date.now();
  const currentKey = clubWeekKey(new Date(timestamp));
  const current = cleanClubWeekly(profile.clubWeekly);
  const base = current && current.key === currentKey
    ? current
    : { key: currentKey, claimed: [], log: [] };
  if (base.log.length < MAX_WEEKLY_LOG) {
    base.log.push({ at: timestamp, game, won: won ? 1 : 0 });
  }
  profile.clubWeekly = base;
  return true;
}

function evaluateClubWeeklyMissions({
  club,
  profilesMap,
  treasuryMissions = null,
  viewerId = null,
  now = Date.now()
} = {}) {
  const week = clubWeekKey(new Date(now));
  if (!club || !Array.isArray(club.members)) {
    return { weekKey: week, summary: { rounds: 0, wins: 0, distinctGames: 0, activeMembers: 0, viewerRounds: 0 }, items: [] };
  }
  const getProfile = id => (profilesMap instanceof Map ? profilesMap.get(id) : profilesMap?.getProfile?.(id)) || null;
  const stats = { rounds: 0, wins: 0, games: new Set(), activeMembers: 0, viewerRounds: 0 };

  for (const member of club.members) {
    const profile = getProfile(member.profileId);
    const weekly = cleanClubWeekly(profile?.clubWeekly);
    if (!weekly || weekly.key !== week) continue;
    const joinedAt = Math.max(0, Math.floor(Number(member.joinedAt) || 0));
    let memberRounds = 0;
    for (const entry of weekly.log) {
      if (entry.at < joinedAt) continue;
      memberRounds++;
      stats.rounds++;
      if (entry.won) stats.wins++;
      stats.games.add(entry.game);
    }
    if (memberRounds > 0) stats.activeMembers++;
    if (viewerId && member.profileId === viewerId) stats.viewerRounds = memberRounds;
  }

  const viewerProfile = viewerId ? getProfile(viewerId) : null;
  const viewerWeekly = cleanClubWeekly(viewerProfile?.clubWeekly);
  const viewerClaimed = new Set(viewerWeekly && viewerWeekly.key === week ? viewerWeekly.claimed : []);
  const isMember = Boolean(viewerId && club.members.some(m => m.profileId === viewerId));
  const rewardedList = treasuryMissions && treasuryMissions.weekKey === week
    && Array.isArray(treasuryMissions.clubs?.[club.id]?.rewarded)
    ? treasuryMissions.clubs[club.id].rewarded
    : [];
  const rewardedSet = new Set(rewardedList);

  const items = CLUB_WEEKLY_MISSIONS.map(spec => {
    const measured = spec.measure(stats);
    const claimedByViewer = viewerClaimed.has(spec.id);
    const viewerContributed = stats.viewerRounds >= 1;
    return {
      id: spec.id,
      icon: spec.icon,
      title: spec.title,
      description: spec.description,
      progress: measured.progress,
      target: spec.target,
      activeMembers: measured.activeMembers ?? stats.activeMembers,
      requiredMembers: measured.requiredMembers ?? 1,
      completed: measured.completed,
      personalReward: spec.personalReward,
      treasuryReward: spec.treasuryReward,
      treasuryCredited: rewardedSet.has(spec.id),
      claimedByViewer,
      viewerContributed,
      canClaim: Boolean(isMember && measured.completed && viewerContributed && !claimedByViewer)
    };
  });

  return {
    weekKey: week,
    summary: {
      rounds: stats.rounds,
      wins: stats.wins,
      distinctGames: stats.games.size,
      activeMembers: stats.activeMembers,
      viewerRounds: stats.viewerRounds
    },
    items
  };
}

module.exports = {
  CLUB_MISSION_GAMES,
  CLUB_WEEKLY_MISSIONS,
  CLUB_MISSION_BY_ID,
  VALID_MISSION_IDS,
  WEEK_KEY_RE,
  clubWeekKey,
  cleanClubWeekly,
  cleanClubSeasonBadges,
  recordClubRoundOnProfile,
  evaluateClubWeeklyMissions
};
