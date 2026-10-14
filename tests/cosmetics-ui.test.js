'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { cleanProfile } = require('../lib/profile-store-shared');
const { equipCosmetic } = require('../lib/cosmetics');
const { publicProgress } = require('../lib/progression');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const SESSION_KEY = 'montecristo-account-session';

function makeProfile() {
  const profile = cleanProfile({
    id: 'cosmetic-ui-account', username: 'cosmetic_ui', name: 'Colección UI', avatar: 'fox', chips: 1000,
    stats: { roundsPlayed: 10, wins: 0 },
    collection: { unlocked: ['avatar-phoenix', 'frame-obsidian'], equipped: { avatar: 'avatar-phoenix' } }
  });
  return profile;
}

test('la colección muestra metas, filtra por espacio y equipa el arte sin modificar el Pasaporte', async t => {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const profile = makeProfile();
  const handlers = {};
  const emitted = [];
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'cosmetic-ui-device');
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(publicProgress(profile, true)));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'cosmetic-ui-device';
  window.fetch = async url => String(url).includes('/healthz')
    ? { ok: true, json: async () => ({ accountSessionsEnabled: false, passportEnabled: false, football: { enabled: false } }) }
    : { ok: false, status: 404, json: async () => ({}) };
  const socket = {
    connected: true,
    io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      if (event === 'account_profile') return ack({ ok: true, profile: publicProgress(profile, true) });
      if (event === 'cosmetic_equip') {
        const result = equipCosmetic(profile, payload);
        return ack(result.ok
          ? { ok: true, changed: result.changed, profile: publicProgress(profile, true) }
          : { ok: false, error: result.error });
      }
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {}, connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.connect?.();
  await new Promise(resolve => setTimeout(resolve, 25));

  window.document.getElementById('profile-card').click();
  await new Promise(resolve => setTimeout(resolve, 35));
  const document = window.document;
  document.getElementById('profile-tab-collection').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(document.getElementById('collection-count').textContent, '2 / 11 objetos');
  assert.equal(document.querySelectorAll('#collection-items .collection-item').length, 11);
  assert.match(document.getElementById('collection-items').textContent, /Completa 10 rondas válidas/u);
  assert.equal(document.querySelector('#collection-items .cosmetic-avatar img')?.getAttribute('src'), '/assets/cosmetics/avatars/phoenix.svg');
  assert.ok(document.getElementById('profile-big-avatar').classList.contains('avatar-art-equipped'));

  document.querySelector('[data-collection-filter="frame"]').click();
  assert.equal(document.querySelectorAll('#collection-items .collection-item').length, 2);
  const frameButton = document.querySelector('[data-cosmetic-equip="frame-obsidian"]');
  assert.ok(frameButton);
  frameButton.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(JSON.parse(JSON.stringify(emitted.find(item => item.event === 'cosmetic_equip').payload)), {
    slot: 'frame', itemId: 'frame-obsidian', accountId: profile.id
  });
  assert.ok(document.getElementById('profile-big-avatar').classList.contains('frame-obsidian'));
  assert.equal(document.querySelector('[data-cosmetic-unequip="frame"]')?.textContent, 'Equipado · quitar');
  assert.deepEqual(profile.passport.unlockedCosmetics, [], 'la colección permanente no añade objetos al Pasaporte');

  document.querySelector('[data-collection-filter="avatar"]').click();
  assert.equal(document.querySelectorAll('#collection-items .collection-item').length, 3);
  assert.equal(document.querySelectorAll('#collection-items .collection-equip').length, 1);
});

// Regresión: el Libro de cartas (54 cartas) se había quedado INTERCALADO entre
// los filtros y la cuadrícula de cosméticos. Al pulsar un filtro la cuadrícula
// se repintaba más de mil píxeles más abajo, fuera de la vista, y la ventana
// parecía congelada («no se mueve ni se abre nada»). Orden correcto: filtros,
// cuadrícula que ordenan y, después, el Libro como bloque propio.
test('los filtros de la colección quedan pegados a la cuadrícula que ordenan', t => {
  const dom = new JSDOM(HTML);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const filters = document.querySelector('#profile-section-collection .collection-filters');
  const grid = document.getElementById('collection-items');
  const book = document.querySelector('#profile-section-collection .card-book');
  assert.ok(filters, 'existe la fila de filtros de la colección');
  assert.ok(grid, 'existe la cuadrícula de cosméticos');
  assert.ok(book, 'existe el Libro de cartas');
  assert.equal(filters.nextElementSibling, grid, 'la cuadrícula va justo debajo de los filtros');
  assert.ok(
    grid.compareDocumentPosition(book) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'el Libro de cartas va después de la cuadrícula, no entre los filtros y la cuadrícula'
  );
  const albumFilters = document.querySelector('#profile-section-album .collection-filters');
  assert.equal(albumFilters?.nextElementSibling, document.getElementById('album-grid'),
    'en el Álbum los filtros también van junto a su cuadrícula');
});
