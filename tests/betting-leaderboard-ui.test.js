'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function rankingSnapshot() {
  const entry = (place, name, totalWagered, casinoWagered, stadiumWagered, avatar) => ({
    place, name, avatar, totalWagered, casinoWagered, stadiumWagered
  });
  return {
    updatedAt: 1760000000000,
    participants: 3,
    participantsBySource: { total: 3, casino: 2, stadium: 2 },
    totalWagered: 14500,
    me: {
      name: 'Alicia', avatar: 'fox', totalWagered: 5000, casinoWagered: 2000, stadiumWagered: 3000,
      stadiumBets: 4, stadiumWins: 3, stadiumLosses: 1, stadiumDecisions: 4,
      stadiumSettledBets: 5, stadiumHitRate: 75, stadiumNet: -250,
      totalRank: 2, casinoRank: 2, stadiumRank: 1
    },
    ranking: {
      total: [entry(1, 'Beto', 9500, 8000, 1500, 'owl'), entry(2, 'Alicia', 5000, 2000, 3000, 'fox'), entry(3, 'Carla', 0, 0, 0, 'panda')],
      casino: [entry(1, 'Beto', 8000, 8000, 0, 'owl'), entry(2, 'Alicia', 5000, 2000, 3000, 'fox')],
      stadium: [entry(1, 'Alicia', 5000, 2000, 3000, 'fox'), entry(2, 'Beto', 1500, 8000, 1500, 'owl')]
    }
  };
}

test('Mi espacio en Casino muestra volumen combinado, filtros y actualización en vivo', async t => {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const account = {
    accountId: 'account-alicia', username: 'alicia', name: 'Alicia', avatar: 'fox', chips: 1000,
    stats: { roundsPlayed: 5, wins: 2, losses: 3, biggestWin: 500, totalWagered: 2000, bestStreak: 1, winRate: 40 }
  };
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'ranking-device');
  window.localStorage.setItem('montecristo-account-session', JSON.stringify(account));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.fetch = async url => {
    const pathName = new URL(String(url), 'http://localhost:3000').pathname;
    if (pathName === '/healthz') return response({ accountSessionsEnabled: false, football: { enabled: true } });
    if (pathName === '/api/seasonal-theme') return response({ active: false });
    return response({}, 404);
  };
  const handlers = {};
  const emitted = [];
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      if (event === 'account_profile') return ack({ ok: true, profile: { ...account } });
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {},
    connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  await new Promise(resolve => setTimeout(resolve, 20));

  window.document.getElementById('account-open-btn').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const launcher = window.document.querySelector('[data-open-betting-space]');
  assert.ok(launcher, 'el perfil incorpora un acceso independiente a Mi espacio');
  assert.equal(launcher.getAttribute('aria-haspopup'), 'dialog');
  launcher.click();
  const bettingModal = window.document.getElementById('betting-space-modal');
  assert.ok(bettingModal.classList.contains('open'), 'Mi espacio abre su propia ventana');
  assert.equal(bettingModal.closest('#profile-modal'), null, 'la ventana del ranking es independiente del modal del perfil');
  assert.equal(bettingModal.getAttribute('aria-hidden'), 'false');
  assert.ok(emitted.some(item => item.event === 'bet_ranking_get'), 'al abrir Mi espacio se solicita el ranking en vivo');

  handlers.bet_ranking_state(rankingSnapshot());
  const personal = window.document.getElementById('bet-ranking-personal');
  assert.match(personal.textContent, /TU PUESTO · TOTAL/);
  assert.match(personal.textContent, /3,000/);
  assert.match(personal.textContent, /75%/);
  assert.match(personal.textContent, /−◆ 250/);
  assert.match(window.document.getElementById('bet-ranking-list').textContent, /Beto/);
  assert.match(window.document.getElementById('bet-ranking-list').textContent, /Alicia/);
  assert.equal(window.document.querySelector('[data-bet-ranking-source="total"]').getAttribute('aria-pressed'), 'true');

  window.document.querySelector('[data-bet-ranking-source="stadium"]').click();
  assert.equal(window.document.querySelector('[data-bet-ranking-source="stadium"]').getAttribute('aria-pressed'), 'true');
  assert.match(personal.textContent, /TU PUESTO · ESTADIO/);
  assert.match(window.document.getElementById('bet-ranking-list').textContent.trim(), /Alicia/);

  window.document.querySelector('#betting-space-modal .modal-close').click();
  assert.ok(!bettingModal.classList.contains('open'), 'el botón de cierre cierra Mi espacio');
  assert.ok(window.document.getElementById('profile-modal').classList.contains('open'), 'el perfil permanece detrás de su ventana independiente');
  assert.ok(window.document.body.classList.contains('modal-open'), 'el desplazamiento sigue bloqueado mientras el perfil está abierto');
  assert.ok(emitted.some(item => item.event === 'bet_ranking_unsubscribe'), 'al cerrar Mi espacio se libera la suscripción');

  launcher.click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!bettingModal.classList.contains('open'), 'Escape también cierra la ventana independiente');
  assert.ok(window.document.getElementById('profile-modal').classList.contains('open'), 'Escape deja abierto el perfil que estaba debajo');
});
