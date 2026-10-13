'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const SESSION_KEY = 'montecristo-account-session';

function makeProfile() {
  return {
    id: 'account-daily-bonus', username: 'daily_user', name: 'Daily User', avatar: 'fox', chips: 1000,
    stats: {
      roundsPlayed: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0,
      biggestWin: 0, totalWagered: 0, eligibleBestStreak: 0, differentGames: 0, winRate: 0
    },
    achievements: [], allAchievements: [], challenges: [], dailyChallenges: [], weeklyChallenges: [],
    featuredAchievements: [], gameStats: {}, balanceHistory: [], medals: 0, championBanner: false,
    dailyBonusClaimed: false, dailyBonusAvailableAt: Date.now()
  };
}

test('el botón del perfil reclama +100 fichas y queda bloqueado hasta el siguiente día', async t => {
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
  let claims = 0;
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'daily-bonus-device');
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(profile));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'daily-bonus-device';
  window.fetch = async url => String(url).includes('/healthz')
    ? { ok: true, json: async () => ({ accountSessionsEnabled: false, football: { enabled: false } }) }
    : { ok: false, status: 404, json: async () => ({}) };
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      if (event === 'account_profile') return ack({ ok: true, profile: { ...profile } });
      if (event === 'daily_bonus_claim') {
        claims++;
        if (profile.dailyBonusClaimed) return ack({ ok: true, claimed: false, reward: 0, profile: { ...profile } });
        profile.chips += 100;
        profile.dailyBonusClaimed = true;
        profile.dailyBonusAvailableAt = Date.now() + 24 * 60 * 60 * 1000;
        return ack({ ok: true, claimed: true, reward: 100, profile: { ...profile } });
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
  await new Promise(resolve => setTimeout(resolve, 30));
  const claimButton = window.document.getElementById('daily-bonus-claim');
  assert.equal(claimButton.disabled, false);
  assert.match(claimButton.textContent, /Reclamar/);

  claimButton.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(claims, 1);
  assert.equal(emitted.filter(item => item.event === 'daily_bonus_claim')[0].payload.accountId, profile.id);
  assert.equal(profile.chips, 1100);
  assert.equal(claimButton.disabled, true);
  assert.equal(claimButton.textContent, 'Reclamado');
  assert.match(window.document.getElementById('daily-bonus-status').textContent, /Bono de hoy recibido/);
  assert.match(window.document.getElementById('toast-stack').textContent, /Bono diario reclamado/);

  claimButton.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(claims, 1, 'el botón bloqueado no permite reclamar una segunda vez ese día');
});
