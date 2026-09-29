'use strict';

const assert = require('node:assert/strict');
const { cleanProfile } = require('../lib/profile-store-shared');
const { ACHIEVEMENTS, CHALLENGES, recordOutcome, publicProgress } = require('../lib/progression');

function main() {
  assert.ok(ACHIEVEMENTS.length >= 12, 'la colección de logros creció');
  assert.ok(CHALLENGES.length >= 12, 'la colección de desafíos creció');
  assert.ok(ACHIEVEMENTS.some(item => item.id === 'platinum_streak' && item.rarity === 'platino' && item.test({ stats: { bestStreak: 1000 }, flags: {} })), 'existe el logro de platino de 1.000 victorias seguidas');

  const profile = cleanProfile({ id: 'progression-test', name: 'Coleccionista' });
  for (let index = 0; index < 3; index++) recordOutcome(profile, { game: 'coinflip', net: 10 });
  assert.ok(profile.achievements.includes('first_win'), 'se desbloquea la primera victoria');
  assert.ok(profile.achievements.includes('hot_streak'), 'se desbloquea la racha corta');
  assert.ok(profile.challenges.play_three, 'se completa el desafío de tres rondas');
  assert.ok(profile.challenges.streak_five === undefined, 'una racha de tres no completa la de cinco');

  // Simula las 999 victorias consecutivas previas: la siguiente victoria debe
  // otorgar el logro difícil y dejarlo visible como medalla de platino.
  profile.stats.currentStreak = 999;
  profile.stats.bestStreak = 999;
  profile.stats.eligibleTracking = true;
  profile.stats.eligibleCurrentStreak = 999;
  profile.stats.eligibleBestStreak = 999;
  const events = recordOutcome(profile, { game: 'coinflip', net: 10 });
  assert.equal(profile.stats.bestStreak, 1000, 'la victoria número mil actualiza la mejor racha');
  assert.ok(profile.achievements.includes('platinum_streak'), 'se desbloquea la medalla de platino');
  assert.ok(events.some(event => event.id === 'platinum_streak' && event.rarity === 'platino'), 'el evento anuncia la rareza platino');

  const progress = publicProgress(profile, true);
  const platinum = progress.allAchievements.find(item => item.id === 'platinum_streak');
  assert.equal(platinum.unlocked, true, 'el logro platino se publica como desbloqueado');
  assert.equal(platinum.rarity, 'platino', 'la rareza llega al perfil privado');
  assert.ok(progress.challenges.some(item => item.id === 'platinum_preview'), 'el desafío de camino al platino está disponible');
  assert.equal(progress.dailyChallenges.length, 1, 'hay un desafío diario activo');
  assert.equal(progress.weeklyChallenges.length, 1, 'hay un desafío semanal activo');
  assert.ok(progress.dailyChallenges[0].periodKey && progress.weeklyChallenges[0].periodKey, 'los desafíos rotativos tienen periodo');

  const eligibleBefore = profile.stats.eligibleBestStreak;
  recordOutcome(profile, { game: 'coinflip', net: 10, eligible: false });
  assert.equal(profile.stats.eligibleBestStreak, eligibleBefore, 'una ronda no elegible no mejora la racha de platino');
  assert.equal(profile.stats.eligibleCurrentStreak, 0, 'una ronda no elegible corta la racha válida');
  console.log('✅ progression-smoke: nuevos logros, desafíos rotativos, vitrina y medalla de platino OK');
}

try {
  main();
} catch (error) {
  console.error('❌ progression-smoke:', error.message);
  process.exitCode = 1;
}
