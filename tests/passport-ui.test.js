'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Catalog = require('../lib/passport-catalog');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const SESSION_KEY = 'montecristo-account-session';

function makeProfile() {
  const seasonKey = '2026-10';
  const rewards = Catalog.rewardsForSeason(seasonKey).map(reward => ({
    ...reward,
    unlocked: reward.threshold !== null && reward.threshold <= 15,
    equipped: false
  }));
  const frame = Catalog.cosmeticFromId(Catalog.makeCosmeticId(seasonKey, 'frame-15'));
  return {
    id: 'passport-ui-account', username: 'passport_user', name: 'Pasaporte UI', avatar: 'fox', chips: 1000,
    stats: {
      roundsPlayed: 12, wins: 4, losses: 5, currentStreak: 0, bestStreak: 2,
      biggestWin: 100, totalWagered: 500, eligibleBestStreak: 1, differentGames: 2, winRate: 33
    },
    achievements: [], allAchievements: [], challenges: [], dailyChallenges: [], weeklyChallenges: [],
    featuredAchievements: [], gameStats: {}, balanceHistory: [], medals: 0, championBanner: false,
    dailyBonusClaimed: false, dailyBonusAvailableAt: Date.now(),
    passport: {
      season: {
        key: seasonKey, label: 'Octubre de 2026', startDate: '1 de octubre de 2026', endDate: '31 de octubre de 2026',
        timeZone: 'America/Mexico_City', points: 15, pointCap: 75, progressPercent: 20,
        nextMilestone: { threshold: 30, rewardName: 'Explorador MonteCristo', remaining: 15 },
        games: Catalog.PASSPORT_GAMES.map((game, index) => ({ ...game, completed: index < 2 })),
        completedGames: 2, allGamesComplete: false, rewards
      },
      equipped: { frame: null, title: null, badge: null },
      inventory: [frame]
    }
  };
}

function cloneProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

test('los accesos del perfil tienen áreas táctiles de al menos 44 px también en el breakpoint compacto', () => {
  assert.match(CSS, /\.profile-tab\s*\{[^}]*min-height:\s*44px/u, 'tabs del perfil en escritorio/tablet');
  assert.match(CSS, /@media \(max-width:\s*680px\)[\s\S]*?\.profile-tab\s*\{[^}]*min-height:\s*44px/u, 'tabs compactas mantienen el área táctil');
});

test('la sección Pasaporte muestra temporada, puntos, sellos, catálogo y equipa desde el perfil', async t => {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const profile = makeProfile();
  const handlers = {};
  const emitted = [];
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'passport-ui-device');
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(profile));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'passport-ui-device';
  window.fetch = async url => String(url).includes('/healthz')
    ? { ok: true, json: async () => ({ accountSessionsEnabled: false, passportEnabled: true, football: { enabled: false } }) }
    : { ok: false, status: 404, json: async () => ({}) };
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      if (event === 'account_profile') return ack({ ok: true, profile: cloneProfile(profile) });
      if (event === 'passport_equip') {
        const slot = payload.slot;
        const item = payload.itemId ? profile.passport.inventory.find(entry => entry.id === payload.itemId) : null;
        profile.passport.equipped[slot] = item ? { ...item } : null;
        profile.passport.inventory.forEach(entry => { entry.equipped = entry.id === payload.itemId; });
        profile.passport.season.rewards.forEach(entry => { entry.equipped = entry.id === payload.itemId; });
        return ack({ ok: true, profile: cloneProfile(profile) });
      }
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {},
    connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.connect?.();

  window.document.getElementById('profile-card').click();
  await new Promise(resolve => setTimeout(resolve, 35));
  const document = window.document;
  const overviewTab = document.getElementById('profile-tab-overview');
  const passportTab = document.getElementById('profile-tab-passport');
  const scrollPane = document.getElementById('profile-content-scroll');
  const identityHeader = document.querySelector('.profile-identity-header');
  const sectionNav = document.getElementById('profile-section-nav');
  assert.ok(identityHeader.compareDocumentPosition(sectionNav) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'la identidad se muestra antes de los accesos rápidos');
  assert.equal(document.getElementById('profile-display-name').textContent, profile.name, 'el encabezado muestra el nombre real del perfil');
  const contentOffsets = { overview: 0, passport: 380, activity: 760, betting: 950, goals: 1140 };
  scrollPane.getBoundingClientRect = () => ({ top: 100 });
  for (const [id, offset] of Object.entries(contentOffsets)) {
    const section = document.getElementById(`profile-section-${id}`);
    section.getBoundingClientRect = () => ({ top: 100 + offset - scrollPane.scrollTop });
  }
  assert.equal(overviewTab.getAttribute('aria-current'), 'location', 'el perfil abre en Resumen');
  assert.equal(passportTab.classList.contains('hidden'), false, 'el acceso aparece cuando el servidor habilita el Pasaporte');
  passportTab.click();
  assert.equal(passportTab.getAttribute('aria-current'), 'location');
  assert.equal(passportTab.getAttribute('aria-controls'), 'profile-section-passport');
  assert.equal(document.activeElement.id, 'passport-heading', 'el acceso rápido mueve el foco al título de la sección');
  assert.equal(document.getElementById('profile-section-passport').classList.contains('hidden'), false);
  assert.ok(scrollPane.scrollTop > 0, 'el acceso rápido desplaza el panel interno hasta el Pasaporte');
  assert.equal(document.getElementById('profile-section-activity').classList.contains('hidden'), false, 'las secciones permanecen disponibles para desplazamiento');

  scrollPane.scrollTop = 800;
  scrollPane.dispatchEvent(new window.Event('scroll'));
  assert.equal(document.getElementById('profile-tab-activity').getAttribute('aria-current'), 'location', 'el indicador acompaña el desplazamiento manual');
  passportTab.click();
  assert.equal(document.getElementById('passport-season-label').textContent, 'Octubre de 2026');
  assert.equal(document.getElementById('passport-points').textContent, '15');
  assert.match(document.getElementById('passport-next-milestone').textContent, /faltan 15/);
  assert.equal(document.querySelectorAll('#passport-stamps .passport-stamp.done').length, 2);
  const gameArtwork = [...document.querySelectorAll('#passport-stamps .passport-game-art')];
  assert.equal(gameArtwork.length, Catalog.PASSPORT_GAMES.length, 'cada sello usa su emblema SVG propio');
  for (const game of Catalog.PASSPORT_GAMES) {
    const artPath = path.join(__dirname, '..', 'public', 'assets', 'passport', 'games', `${game.id}.svg`);
    assert.ok(fs.existsSync(artPath), `falta el emblema de ${game.id}`);
  }
  assert.match(document.getElementById('passport-rewards').textContent, /Insignia de temporada/);
  assert.match(document.getElementById('passport-rewards').textContent, /Explorador MonteCristo/);
  const rewardArtwork = [...document.querySelectorAll('#passport-rewards .passport-reward-art')];
  assert.equal(rewardArtwork.length, Catalog.rewardsForSeason('2026-10').length, 'cada recompensa muestra arte vectorial propio');
  for (const reward of Catalog.rewardsForSeason('2026-10')) {
    const artPath = path.join(__dirname, '..', 'public', 'assets', 'passport', 'rewards', `${reward.slug}.svg`);
    assert.ok(fs.existsSync(artPath), `falta el arte de ${reward.slug}`);
  }
  const profileAside = document.getElementById('profile-overview');
  const profileMain = document.querySelector('.profile-main');
  assert.ok(profileAside.compareDocumentPosition(profileMain) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'el cuadro completo de identidad y cuenta precede al progreso');
  assert.equal(document.getElementById('profile-edit-jump'), null, 'se elimina el acceso directo que no servía');
  const profileNameInput = document.getElementById('profile-name-input');
  profileNameInput.value = 'Casino Explorer';
  profileNameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.getElementById('profile-display-name').textContent, 'Casino Explorer', 'el encabezado previsualiza el nombre antes de guardarlo');

  const frameId = Catalog.makeCosmeticId('2026-10', 'frame-15');
  const equipButton = [...document.querySelectorAll('[data-passport-equip]')]
    .find(button => button.dataset.passportEquip === frameId);
  assert.ok(equipButton, 'el marco desbloqueado ofrece control Equipar');
  equipButton.click();
  await new Promise(resolve => setTimeout(resolve, 35));
  const equipEvent = emitted.find(item => item.event === 'passport_equip');
  assert.deepEqual(JSON.parse(JSON.stringify(equipEvent.payload)), { slot: 'frame', itemId: frameId, accountId: profile.id });
  assert.equal(profile.passport.equipped.frame.id, frameId);
  assert.ok(document.getElementById('profile-big-avatar').classList.contains('passport-frame-15'));
  assert.equal(document.querySelector('#passport-rewards [data-passport-unequip="frame"]')?.textContent, 'Quitar');
});

test('con PASSPORT_ENABLED apagado se oculta el panel y no se muestran cosméticos equipados', async t => {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const profile = makeProfile();
  const frame = Catalog.cosmeticFromId(Catalog.makeCosmeticId('2026-10', 'frame-15'));
  const title = Catalog.cosmeticFromId(Catalog.makeCosmeticId('2026-10', 'title-30'));
  const badge = Catalog.cosmeticFromId(Catalog.makeCosmeticId('2026-10', 'season-badge'));
  profile.passport.equipped = { frame, title, badge };
  profile.passport.inventory = [frame, title, badge];
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'passport-ui-disabled-device');
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(profile));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'passport-ui-disabled-device';
  window.fetch = async url => String(url).includes('/healthz')
    ? { ok: true, json: async () => ({ accountSessionsEnabled: false, passportEnabled: false }) }
    : { ok: false, status: 404, json: async () => ({}) };
  const socket = {
    connected: true,
    io: { on() {} },
    on() {},
    emit(event, _payload, ack) {
      if (event === 'account_profile') return ack({ ok: true, profile: cloneProfile(profile) });
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {},
    connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  await new Promise(resolve => setTimeout(resolve, 35));
  window.document.getElementById('profile-card').click();
  await new Promise(resolve => setTimeout(resolve, 35));

  const document = window.document;
  assert.ok(document.getElementById('passport-panel').classList.contains('hidden'));
  assert.ok(document.getElementById('profile-section-passport').classList.contains('hidden'));
  assert.ok(document.getElementById('profile-tab-passport').classList.contains('hidden'));
  assert.ok(!document.getElementById('profile-big-avatar').classList.contains('passport-frame-15'));
  assert.equal(document.querySelectorAll('.passport-equipped-title, .passport-equipped-badge, .passport-mini-badge, .passport-nameplate').length, 0);
  assert.equal(document.querySelectorAll('[data-passport-equip], [data-passport-unequip]').length, 0);
});
