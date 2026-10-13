'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const account = { id: 'alice-id', username: 'alice', name: 'Alicia', avatar: 'fox', chips: 1000 };
const bob = { id: 'bob-id', username: 'bob', name: 'Roberto', avatar: 'owl' };
const carla = { id: 'carla-id', username: 'carla', name: 'Carla', avatar: 'panda' };

function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }

test('interfaz social carga amigos, acepta solicitudes, busca cuentas y funda clubes', async t => {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'social-ui-device');
  window.localStorage.setItem('montecristo-account-session', JSON.stringify(account));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  let idempotencyCounter = 0;
  window.crypto.randomUUID = () => `social-ui-uuid-${++idempotencyCounter}`;
  let friends = [];
  let incomingRequests = [{ id: 'friend-request-1', profile: bob, createdAt: Date.now() }];
  let memberships = [];
  let clubs = [];
  let clubData = null;
  let movementCounter = 0;
  const apiCalls = [];
  window.fetch = async (url, options = {}) => {
    const route = new URL(String(url), 'http://localhost:3000');
    apiCalls.push({ path: route.pathname, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (route.pathname === '/healthz') return response({ accountSessionsEnabled: true, passportEnabled: false, football: { enabled: false } });
    if (route.pathname === '/api/seasonal-theme') return response({ active: true, refreshAt: null, theme: { id: 'halloween', label: 'Noche de Halloween', symbol: '☾', particle: '✦', accent: '#f29a57', decoration: 'calabazas y luz ámbar', animation: 'embers', intensity: 'subtle' } });
    if (route.pathname === '/api/auth/session') return response({ ok: true, csrfToken: 'csrf-for-test', profile: account });
    if (route.pathname === '/api/social/v1/me') return response({
      ok: true, profile: { ...account }, seasonKey: '2026-10', friends, incomingRequests, outgoingRequests: [], clubs: clubData ? [clubData] : memberships
    });
    if (route.pathname === '/api/social/v1/clubs/ranking') {
      const ranking = clubData?.visibility === 'public' && clubData.treasury.balance > 0
        ? [{ rank: 1, id: clubData.id, name: clubData.name, emblemGlyph: clubData.emblemGlyph, color: clubData.color, owner: account, memberCount: clubData.memberCount, balance: clubData.treasury.balance }]
        : [];
      return response({ ok: true, seasonKey: '2026-10', ranking });
    }
    if (route.pathname === '/api/social/v1/clubs' && options.method !== 'POST') {
      const q = (route.searchParams.get('q') || '').toLowerCase();
      const results = clubData ? [clubData] : clubs;
      return response({ ok: true, clubs: results.filter(club => !q || club.name.toLowerCase().includes(q)) });
    }
    if (route.pathname.endsWith('/deposits') && options.method === 'POST') {
      const { amount } = JSON.parse(options.body);
      account.chips -= amount;
      clubData.treasury.balance += amount;
      clubData.treasury.movements.push({ id: `movement-${++movementCounter}`, type: 'deposit', amount, actor: account, target: null, note: '', time: Date.now() });
      return response({ ok: true, code: 'deposit_complete', profileChips: account.chips, balance: clubData.treasury.balance, seasonKey: '2026-10', movement: clubData.treasury.movements.at(-1) });
    }
    if (route.pathname.endsWith('/transfers') && options.method === 'POST') {
      const { amount, targetProfileId, note } = JSON.parse(options.body);
      if (targetProfileId === account.id) account.chips += amount;
      clubData.treasury.balance -= amount;
      clubData.treasury.movements.push({ id: `movement-${++movementCounter}`, type: 'transfer', amount, actor: account, target: account, note, time: Date.now() });
      return response({ ok: true, code: 'transfer_complete', profileChips: account.chips, targetChips: account.chips, balance: clubData.treasury.balance, seasonKey: '2026-10', movement: clubData.treasury.movements.at(-1) });
    }
    if (route.pathname === '/api/social/v1/users') return response({ ok: true, users: [carla].map(profile => ({ ...profile, relationship: 'none' })) });
    if (route.pathname === '/api/social/v1/friends/requests/friend-request-1/accept' && options.method === 'POST') {
      friends = [bob];
      incomingRequests = [];
      return response({ ok: true, message: 'Solicitud aceptada.' });
    }
    if (route.pathname === '/api/social/v1/clubs' && options.method === 'POST') {
      const input = JSON.parse(options.body);
      const club = {
        id: 'club-1', name: input.name, description: input.description, emblemGlyph: '♠', color: input.color,
        colorHex: '#67d9a5', visibility: input.visibility, ownerId: account.id, owner: account,
        memberCount: 1, memberLimit: 30, membershipStatus: 'member',
        members: [{ ...account, role: 'owner' }], requests: [],
        treasury: { balance: 0, seasonKey: '2026-10', movements: [] }
      };
      clubData = club;
      clubs = [club];
      memberships = [club];
      return response({ ok: true, message: 'Club fundado.', club }, 201);
    }
    return response({ ok: false, error: `Ruta de prueba inesperada: ${route.pathname}` }, 404);
  };
  const socketHandlers = {};
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { socketHandlers[event] = handler; },
    emit(_event, _payload, ack) { if (typeof ack === 'function') ack({ ok: true }); },
    disconnect() {},
    connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  await new Promise(resolve => setTimeout(resolve, 25));
  const seasonalPill = window.document.getElementById('seasonal-theme-pill');
  assert.equal(seasonalPill.hidden, false);
  assert.match(seasonalPill.textContent, /Noche de Halloween/);
  assert.equal(window.document.getElementById('seasonal-effects').dataset.theme, 'halloween');
  assert.equal(window.document.querySelectorAll('.seasonal-effect-particle').length, 0, 'respeta la preferencia de movimiento reducido');
  socketHandlers.seasonal_theme_updated?.({ active: true, refreshAt: null, theme: { id: 'christmas', label: 'Navidad', symbol: '✦', particle: '❄', animation: 'snow', intensity: 'festive' } });
  assert.equal(window.document.getElementById('seasonal-effects').dataset.theme, 'christmas', 'el cambio administrativo se refleja en tiempo real');

  window.document.getElementById('community-open-btn').click();
  await new Promise(resolve => setTimeout(resolve, 35));
  const document = window.document;
  assert.equal(document.getElementById('community-modal').classList.contains('open'), true);
  assert.match(document.getElementById('community-incoming-list').textContent, /Roberto/);
  assert.equal(document.getElementById('community-request-count').textContent, '1');

  document.querySelector('[data-community-tab="requests"]').click();
  document.querySelector('[data-social-action="accept-friend"]').click();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.match(document.getElementById('community-friends-list').textContent, /Roberto/);
  assert.equal(document.getElementById('community-request-count').textContent, '0');
  const acceptCall = apiCalls.find(call => call.path.endsWith('/accept'));
  assert.equal(acceptCall.method, 'POST');
  assert.equal(acceptCall.headers['X-CSRF-Token'], 'csrf-for-test');

  document.getElementById('community-search').value = 'car';
  document.getElementById('community-search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(document.getElementById('community-search-results').textContent, /Carla/);
  assert.ok(document.querySelector('[data-social-action="add-friend"][data-username="carla"]'));

  document.querySelector('[data-community-tab="clubs"]').click();
  document.getElementById('community-create-club-details').open = true;
  document.getElementById('community-club-name').value = 'La Mesa del Río';
  document.getElementById('community-club-description').value = 'Una comunidad de prueba';
  document.getElementById('community-create-club-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(document.getElementById('community-clubs-list').textContent, /La Mesa del Río/);
  assert.equal(document.getElementById('community-create-club-details').classList.contains('hidden'), true);
  assert.ok(apiCalls.some(call => call.path === '/api/social/v1/clubs' && call.method === 'POST'));
  assert.match(document.getElementById('community-clubs-list').textContent, /tesorería/i);

  let depositForm = document.querySelector('[data-club-money="deposit"]');
  depositForm.elements.namedItem('amount').value = '200';
  depositForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(account.chips, 800);
  assert.equal(clubData.treasury.balance, 200);
  const depositCall = apiCalls.find(call => call.path.endsWith('/deposits'));
  assert.equal(depositCall.method, 'POST');
  assert.ok(depositCall.headers['Idempotency-Key']);

  const transferForm = document.querySelector('[data-club-money="transfer"]');
  transferForm.elements.namedItem('targetProfileId').value = account.id;
  transferForm.elements.namedItem('amount').value = '50';
  transferForm.elements.namedItem('note').value = 'Premio amistoso';
  transferForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(account.chips, 850);
  assert.equal(clubData.treasury.balance, 150);
  assert.equal(JSON.parse(window.localStorage.getItem('montecristo-account-session')).chips, 850, 'actualiza la caché de la sesión');
  const transferCall = apiCalls.find(call => call.path.endsWith('/transfers'));
  assert.ok(transferCall.headers['Idempotency-Key']);
  assert.match(document.getElementById('community-clubs-list').textContent, /150/);

  document.querySelector('[data-community-tab="ranking"]').click();
  assert.match(document.getElementById('community-club-ranking-podium').textContent, /La Mesa del Río/);
  assert.match(document.getElementById('community-club-ranking-podium').textContent, /150/);
  assert.match(document.getElementById('community-club-ranking-season').textContent, /2026-10/);
});

test('HTML publica una entrada a Comunidad y controles de solicitudes y clubes accesibles', () => {
  const dom = new JSDOM(HTML);
  const document = dom.window.document;
  assert.ok(document.getElementById('community-open-btn'));
  assert.equal(document.getElementById('community-modal').querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
  assert.ok(document.querySelector('[data-community-tab="friends"]'));
  assert.ok(document.querySelector('[data-community-tab="requests"]'));
  assert.ok(document.querySelector('[data-community-tab="clubs"]'));
  assert.ok(document.querySelector('[data-community-tab="ranking"]'));
  assert.equal(document.querySelector('[data-community-tab="friends"]').getAttribute('aria-controls'), 'community-panel-friends');
  assert.ok(document.getElementById('community-create-club-form'));
  assert.ok(document.getElementById('community-panel-ranking'));
  assert.ok(CLIENT.includes('data-club-money'));
  dom.window.close();
});
