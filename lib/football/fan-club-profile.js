'use strict';

const { CLUB_BY_ID } = require('./teams');

// Afición privada: nunca confiar en datos inventados por el navegador.
function cleanFanClub(raw) {
  if (!raw || typeof raw.clubId !== 'string' || !Object.hasOwn(CLUB_BY_ID, raw.clubId)
      || !Number.isSafeInteger(raw.joinedAt) || raw.joinedAt < 1) return null;
  const validPins = ['club-pin','fan-1','fan-2','fan-3'];
  const seen = Array.isArray(raw.wonMatchIds) ? [...new Set(raw.wonMatchIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 120))].slice(-4096) : [];
  const wins = Math.max(seen.length, Number.isSafeInteger(raw.wins) && raw.wins >= 0 ? raw.wins : 0);
  return { clubId: raw.clubId, joinedAt: raw.joinedAt, rankingOptIn: raw.rankingOptIn === true,
    wins, wonMatchIds:seen, equippedPin: validPins.includes(raw.equippedPin) ? raw.equippedPin : null };
}

function publicFanPin(profile) {
  const fan = cleanFanClub(profile?.footballFanClub);
  if (!fan?.equippedPin) return null;
  const requirements = { 'club-pin':0, 'fan-1':1, 'fan-2':3, 'fan-3':5 };
  if (fan.wins < requirements[fan.equippedPin]) return null;
  const club = CLUB_BY_ID[fan.clubId];
  return { clubId:fan.clubId, clubName:club.name, abbr:club.abbr, pin:fan.equippedPin };

}

module.exports = { cleanFanClub, publicFanPin };
