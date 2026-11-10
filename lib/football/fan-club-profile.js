'use strict';

const { CLUB_BY_ID } = require('./teams');

const SEASON_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const PIN_CATALOG = Object.freeze([
  { id: 'club-pin', tier: 0, target: 0, badge: '', title: 'Pin del club', subtitle: 'Escudo oficial de adhesión' },
  { id: 'fan-1', tier: 1, target: 1, badge: 'I', title: 'Primera victoria', subtitle: 'Marco de bronce · 1 victoria' },
  { id: 'fan-2', tier: 2, target: 3, badge: '✦', title: 'Tribuna fiel', subtitle: 'Halo dorado · 3 victorias' },
  { id: 'fan-3', tier: 3, target: 5, badge: '★', title: 'Afición de leyenda', subtitle: 'Aureola ámbar · 5 victorias' },
  { id: 'fan-4', tier: 4, target: 10, badge: '❖', title: 'Guardián del escudo', subtitle: 'Halo esmeralda · 10 victorias' },
  { id: 'fan-5', tier: 5, target: 20, badge: '♛', title: 'Patrimonio del club', subtitle: 'Corona imperial · 20 victorias' },
  { id: 'fan-champ', tier: 6, target: 1, kind: 'championship', badge: '🏆', title: 'Estrella de campeón', subtitle: 'Campeón oficial de liga desde tu adhesión' }
]);

const PIN_BY_ID = Object.freeze(Object.fromEntries(PIN_CATALOG.map(item => [item.id, item])));
const VALID_PIN_IDS = Object.freeze(PIN_CATALOG.map(item => item.id));

const TITLE_CATALOG = Object.freeze([
  { id: 'title-hincha', target: 1, kind: 'wins', title: 'Voz de grada', format: club => `Grada de ${club.name}` },
  { id: 'title-fiel', target: 3, kind: 'wins', title: 'Tribuna fiel', format: club => `Tribuna Fiel · ${club.abbr}` },
  { id: 'title-leyenda', target: 5, kind: 'wins', title: 'Leyenda del club', format: club => `Leyenda de ${club.name}` },
  { id: 'title-guardian', target: 10, kind: 'wins', title: 'Guardián del escudo', format: club => `Guardián de ${club.name}` },
  { id: 'title-campeon', target: 1, kind: 'championship', title: 'Campeón vigente', format: club => `Campeón con ${club.name}` }
]);

const TITLE_BY_ID = Object.freeze(Object.fromEntries(TITLE_CATALOG.map(item => [item.id, item])));
const VALID_TITLE_IDS = Object.freeze(TITLE_CATALOG.map(item => item.id));

const BANNER_CATALOG = Object.freeze([
  {
    id: 'club-banner',
    kind: 'club',
    limitedTime: false,
    art: '/assets/banners/club-banner-bg.jpg',
    title: 'Estandarte del club',
    subtitle: 'Seda oficial con el escudo y colores de tu club'
  },
  {
    id: 'champion-banner',
    kind: 'reigning_champion',
    limitedTime: true,
    art: '/assets/banners/champion-banner-bg.jpg',
    title: 'Estandarte de Campeón Vigente',
    subtitle: 'Laureles de gala · activo hasta que se corone un nuevo campeón (solo leales previos al título)'
  }
]);

const BANNER_BY_ID = Object.freeze(Object.fromEntries(BANNER_CATALOG.map(item => [item.id, item])));
const VALID_BANNER_IDS = Object.freeze(BANNER_CATALOG.map(item => item.id));

let reigningChampionResolver = () => null;

function setReigningChampionResolver(fn) {
  reigningChampionResolver = typeof fn === 'function' ? fn : () => null;
}

function getReigningChampion() {
  try {
    return reigningChampionResolver() || null;
  } catch (_) {
    return null;
  }
}

function isPinUnlocked(pinId, wins, championships = 0) {
  const spec = PIN_BY_ID[pinId];
  if (!spec) return false;
  if (spec.kind === 'championship') return championships >= spec.target;
  return wins >= spec.target;
}

function isTitleUnlocked(titleId, wins, championships = 0) {
  const spec = TITLE_BY_ID[titleId];
  if (!spec) return false;
  if (spec.kind === 'championship') return championships >= spec.target;
  return wins >= spec.target;
}

function isBannerUnlocked(bannerId, fan, reigningChampion = getReigningChampion()) {
  const spec = BANNER_BY_ID[bannerId];
  if (!spec || !fan || !fan.clubId || !Object.hasOwn(CLUB_BY_ID, fan.clubId)) return false;
  if (spec.kind === 'club') return true;
  if (spec.kind === 'reigning_champion') {
    if (!reigningChampion || reigningChampion.clubId !== fan.clubId) return false;
    if (Number.isSafeInteger(reigningChampion.settledAt)) {
      return fan.joinedAt <= reigningChampion.settledAt;
    }
    if (typeof reigningChampion.seasonMonth === 'string') {
      return Array.isArray(fan.championSeasons) && fan.championSeasons.includes(reigningChampion.seasonMonth);
    }
    return false;
  }
  return false;
}

function formatFanTitle(titleId, club) {
  const spec = TITLE_BY_ID[titleId];
  if (!spec || !club) return null;
  return spec.format(club);
}

// Afición privada: nunca confiar en datos inventados por el navegador.
function cleanFanClub(raw) {
  if (!raw || typeof raw.clubId !== 'string' || !Object.hasOwn(CLUB_BY_ID, raw.clubId)
      || !Number.isSafeInteger(raw.joinedAt) || raw.joinedAt < 1) return null;
  const seen = Array.isArray(raw.wonMatchIds)
    ? [...new Set(raw.wonMatchIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 120))].slice(-4096)
    : [];
  const wins = Math.max(seen.length, Number.isSafeInteger(raw.wins) && raw.wins >= 0 ? raw.wins : 0);
  const championSeasons = Array.isArray(raw.championSeasons)
    ? [...new Set(raw.championSeasons.filter(key => typeof key === 'string' && SEASON_KEY_RE.test(key)))].sort().slice(-120)
    : [];
  return {
    clubId: raw.clubId,
    joinedAt: raw.joinedAt,
    rankingOptIn: raw.rankingOptIn === true,
    wins,
    wonMatchIds: seen,
    championSeasons,
    equippedPin: VALID_PIN_IDS.includes(raw.equippedPin) ? raw.equippedPin : null,
    equippedTitle: VALID_TITLE_IDS.includes(raw.equippedTitle) ? raw.equippedTitle : null,
    equippedBanner: VALID_BANNER_IDS.includes(raw.equippedBanner) ? raw.equippedBanner : null
  };
}

function publicFanPin(profile) {
  const fan = cleanFanClub(profile?.footballFanClub);
  if (!fan) return null;
  const championships = fan.championSeasons.length;
  const validPin = fan.equippedPin && isPinUnlocked(fan.equippedPin, fan.wins, championships) ? fan.equippedPin : null;
  const validTitle = fan.equippedTitle && isTitleUnlocked(fan.equippedTitle, fan.wins, championships) ? fan.equippedTitle : null;
  if (!validPin && !validTitle) return null;
  const club = CLUB_BY_ID[fan.clubId];
  const pinSpec = validPin ? PIN_BY_ID[validPin] : null;
  return {
    clubId: fan.clubId,
    clubName: club.name,
    abbr: club.abbr,
    pin: validPin,
    pinTitle: pinSpec ? pinSpec.title : null,
    pinBadge: pinSpec ? pinSpec.badge : '',
    tier: pinSpec ? pinSpec.tier : 0,
    titleId: validTitle,
    titleLabel: validTitle ? formatFanTitle(validTitle, club) : null,
    championships
  };
}

function publicFanBanner(profile, options = {}) {
  const fan = cleanFanClub(profile?.footballFanClub);
  if (!fan || !fan.equippedBanner) return null;
  const reigning = Object.prototype.hasOwnProperty.call(options, 'reigningChampion')
    ? options.reigningChampion
    : getReigningChampion();
  if (!isBannerUnlocked(fan.equippedBanner, fan, reigning)) return null;
  const club = CLUB_BY_ID[fan.clubId];
  const spec = BANNER_BY_ID[fan.equippedBanner];
  const isChampion = spec.kind === 'reigning_champion';
  return {
    clubId: fan.clubId,
    clubName: club.name,
    abbr: club.abbr,
    primary: club.primary,
    secondary: club.secondary,
    banner: spec.id,
    title: spec.title,
    art: spec.art,
    crest: `/assets/escudos/${club.abbr}.svg`,
    isReigningChampion: isChampion,
    limitedTime: spec.limitedTime,
    seasonMonth: isChampion && reigning?.seasonMonth ? reigning.seasonMonth : null
  };
}

function publicFanBannersInventory(profile, options = {}) {
  const fan = cleanFanClub(profile?.footballFanClub);
  const reigning = Object.prototype.hasOwnProperty.call(options, 'reigningChampion')
    ? options.reigningChampion
    : getReigningChampion();
  if (!fan) {
    return {
      clubId: null,
      clubName: null,
      abbr: null,
      primary: null,
      secondary: null,
      equippedBanner: null,
      reigningSeasonMonth: reigning?.seasonMonth || null,
      reigningClubId: reigning?.clubId || null,
      reigningClubName: reigning?.clubId && CLUB_BY_ID[reigning.clubId] ? CLUB_BY_ID[reigning.clubId].name : null,
      items: []
    };
  }
  const club = CLUB_BY_ID[fan.clubId];
  const activeBanner = fan.equippedBanner && isBannerUnlocked(fan.equippedBanner, fan, reigning)
    ? fan.equippedBanner
    : null;
  const items = BANNER_CATALOG.map(spec => {
    const unlocked = isBannerUnlocked(spec.id, fan, reigning);
    return {
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
      unlocked,
      equipped: activeBanner === spec.id
    };
  });
  return {
    clubId: club.id,
    clubName: club.name,
    abbr: club.abbr,
    primary: club.primary,
    secondary: club.secondary,
    equippedBanner: activeBanner,
    reigningSeasonMonth: reigning?.seasonMonth || null,
    reigningClubId: reigning?.clubId || null,
    reigningClubName: reigning?.clubId && CLUB_BY_ID[reigning.clubId] ? CLUB_BY_ID[reigning.clubId].name : null,
    items
  };
}

module.exports = {
  PIN_CATALOG,
  PIN_BY_ID,
  VALID_PIN_IDS,
  TITLE_CATALOG,
  TITLE_BY_ID,
  VALID_TITLE_IDS,
  BANNER_CATALOG,
  BANNER_BY_ID,
  VALID_BANNER_IDS,
  setReigningChampionResolver,
  getReigningChampion,
  isPinUnlocked,
  isTitleUnlocked,
  isBannerUnlocked,
  formatFanTitle,
  cleanFanClub,
  publicFanPin,
  publicFanBanner,
  publicFanBannersInventory
};
