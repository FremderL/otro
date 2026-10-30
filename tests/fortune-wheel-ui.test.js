'use strict';

// Rueda de la Fortuna (interfaz): geometría de los 54 sectores, flecha que
// marca el sector ganador, leyenda de pagos y giro real dentro de la mesa.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const WHEEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'fortune-wheel.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const wheel = require('../public/fortune-wheel.js');

test('la rueda tiene 54 sectores con la distribución exacta de premios', () => {
  assert.equal(wheel.TOTAL, 54);
  assert.equal(wheel.LAYOUT.length, 54);
  for (const value of wheel.VALUES) {
    assert.equal(wheel.LAYOUT.filter(sector => sector === value).length, wheel.COUNTS[value], `sectores de ${value}`);
  }
  assert.deepEqual([...new Set(wheel.LAYOUT)].sort((a, b) => a - b), [1, 2, 5, 10, 20, 40]);
  // Los premios altos no se agrupan: entre dos casillas de 20 hay al menos 20 sectores.
  const twenties = wheel.LAYOUT.map((value, index) => (value === 20 ? index : -1)).filter(index => index >= 0);
  assert.equal(twenties.length, 2);
  const gap = Math.abs(twenties[0] - twenties[1]);
  assert.ok(Math.min(gap, 54 - gap) >= 20, `las dos casillas de 20 están separadas (${gap})`);
  assert.deepEqual(wheel.VALUES.map(wheel.payout), [2, 3, 6, 11, 21, 41]);
});

test('la rueda se detiene con el sector ganador bajo la flecha', () => {
  for (const value of wheel.VALUES) {
    const angle = wheel.landingAngle(value, 0, 4);
    assert.ok(angle >= 4 * 360, 'da varias vueltas completas antes de frenar');
    // La flecha está a las 12 en punto: el centro del sector debe caer ahí.
    const index = wheel.indexOf(value);
    const position = ((angle + wheel.sectorAngle(index)) % 360 + 360) % 360;
    assert.ok(position < 1e-6 || position > 360 - 1e-6, `el sector ${value} queda bajo la flecha (${position})`);
    // Y el ángulo no depende del sentido del giro previo.
    const from = 123.45;
    const again = wheel.landingAngle(value, from, 3);
    assert.ok(again > from, 'siempre gira hacia adelante');
    const landing = ((again + wheel.sectorAngle(index)) % 360 + 360) % 360;
    assert.ok(landing < 1e-6 || landing > 360 - 1e-6);
  }
});

test('el marcado incluye los 54 sectores, la flecha y el centro con el resultado', () => {
  const html = wheel.markup({ value: 10, phase: 'results', angle: wheel.landingAngle(10, 0), landed: true, label: 'Gana +100 fichas' });
  assert.equal((html.match(/data-fortune-sector="/g) || []).length, 54);
  assert.equal((html.match(/class="fortune-sector-label/g) || []).length, 54);
  assert.match(html, /class="fortune-pointer"/);
  const dom = new JSDOM(`<body>${html}</body>`);
  const hit = dom.window.document.querySelectorAll('[data-fortune-sector].is-hit');
  assert.equal(hit.length, 1, 'solo el sector ganador se resalta');
  assert.equal(hit[0].getAttribute('data-value'), '10');
  assert.match(dom.window.document.querySelector('[data-fortune-hub]').textContent, /^10$/);
  assert.match(dom.window.document.querySelector('.fortune-hub').textContent, /SECTOR · PAGA x11/);
  assert.match(dom.window.document.querySelector('.fortune-hub').textContent, /Gana \+100 fichas/);
  // Cada sector lleva su color y su número visible.
  const labels = [...dom.window.document.querySelectorAll('.fortune-sector-label')].map(node => Number(node.textContent));
  assert.deepEqual(labels, wheel.LAYOUT);
});

test('los sectores elegidos por la mesa se marcan en la rueda', () => {
  const html = wheel.markup({ value: null, phase: 'betting', angle: 0, winning: [5, 20] });
  const dom = new JSDOM(`<body>${html}</body>`);
  const picked = [...dom.window.document.querySelectorAll('.fortune-sector.is-picked')];
  assert.ok(picked.length > 0);
  assert.deepEqual([...new Set(picked.map(node => node.dataset.value))].sort((a, b) => Number(a) - Number(b)), ['5', '20']);
  assert.equal(picked.length, wheel.COUNTS[5] + wheel.COUNTS[20], 'se iluminan todas las casillas de esos valores');
});

test('antes de aterrizar no se revela el sector y la leyenda muestra los pagos', () => {
  const html = wheel.markup({ value: null, phase: 'results', choice: '5', angle: 0, landed: false });
  const dom = new JSDOM(`<body>${html}<div id="legend">${wheel.legend({ choice: '5' })}</div></body>`);
  assert.equal(dom.window.document.querySelectorAll('.fortune-sector.is-hit').length, 0);
  assert.match(dom.window.document.querySelector('.fortune-hub').textContent, /TU SECTOR · PAGA x6/);
  const legend = [...dom.window.document.querySelectorAll('.fortune-legend-item')];
  assert.equal(legend.length, 6);
  assert.deepEqual(legend.map(item => [
    item.dataset.fortuneTier,
    item.querySelector('b').textContent.trim(),
    item.querySelector('small').textContent.trim()
  ]), [
    ['1', 'x2', '25 sectores'], ['2', 'x3', '15 sectores'], ['5', 'x6', '7 sectores'],
    ['10', 'x11', '4 sectores'], ['20', 'x21', '2 sectores'], ['40', 'x41', '1 sector']
  ]);
  assert.equal(legend.filter(item => item.classList.contains('active')).length, 1);
  assert.equal(dom.window.document.querySelector('.fortune-legend-item.active').dataset.fortuneTier, '5');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8'), /\.fortune-legend-item\.active/);
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fortuneRoom({ phase = 'results', value = 10, chips = 940 } = {}) {
  const players = [
    {
      id: 'wheel-device', name: 'Ana', avatar: 'fox', chips, bet: 0, quickChoice: '10', roundBet: 0, totalBet: 60,
      status: phase === 'results' ? 'winner' : 'waiting', folded: false, allIn: false, connected: true, isBot: false, hand: []
    },
    {
      id: 'guest-device', name: 'Beto', avatar: 'panda', chips: 900, bet: 0, quickChoice: '1', roundBet: 0, totalBet: 40,
      status: 'lost', folded: false, allIn: false, connected: true, isBot: false, hand: []
    }
  ];
  return {
    code: 'RUEDA', game: 'fortune', phase, hostId: 'wheel-device', viewerId: 'wheel-device',
    handNumber: 1, players, spectators: [], messages: [], results: phase === 'results'
      ? [{ id: 'wheel-device', name: 'Ana', choice: '10', choiceLabel: 'Sector 10', label: 'Gana', payout: 660, amount: 600, specialBonus: 0 },
        { id: 'guest-device', name: 'Beto', choice: '1', choiceLabel: 'Sector 1', label: 'Pierde', payout: 0, amount: -40, specialBonus: 0 }]
      : [],
    quickResult: phase === 'results' ? { value } : null,
    specialEvent: null,
    viewerProfile: { id: 'wheel-device', name: 'Ana', avatar: 'fox', chips, stats: {}, passport: null, collection: { equipped: {} }, fanPin: null },
    recentWinners: [], roundSessionId: 's1', dealerHand: [], community: [], pot: 0
  };
}

test('en la mesa, la rueda marca con la flecha el sector que decidió el servidor', async t => {
  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'wheel-device');
  window.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  window.fetch = async url => {
    const pathName = new URL(String(url), 'http://localhost:3000').pathname;
    if (pathName === '/healthz') return response({ fortuneEnabled: true, accountSessionsEnabled: false });
    if (pathName === '/api/seasonal-theme') return response({ active: false });
    return response({}, 404);
  };
  const handlers = {};
  const socket = {
    connected: true, io: { on() {} },
    on(event, handler) { handlers[event] = handler; },
    emit(_event, _payload, ack) { if (typeof ack === 'function') ack({ ok: true }); },
    disconnect() {}, connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(WHEEL);
  window.eval(CLIENT);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(window.FortuneWheel, 'la rueda se carga como script propio (CSP sin inline)');
  assert.match(HTML, /<script src="\/fortune-wheel\.js"><\/script>/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(HTML), 'sin scripts en línea');

  handlers.room_state(fortuneRoom());
  await new Promise(resolve => setTimeout(resolve, 40));

  const document = window.document;
  const sectors = document.querySelectorAll('[data-fortune-sector]');
  assert.equal(sectors.length, 54, 'se dibujan los 54 sectores');
  assert.ok(document.querySelector('.fortune-pointer'), 'la flecha existe en la mesa');
  const stage = document.querySelector('[data-fortune-stage]');
  assert.ok(stage.classList.contains('is-spinning'), 'la rueda gira antes de frenar');
  assert.equal(document.querySelectorAll('.fortune-sector.is-hit').length, 0, 'el sector no se revela antes de tiempo');
  assert.match(document.querySelector('.fortune-hub').textContent, /TU SECTOR · PAGA x11/);

  // La animación termina (aquí simulada con transitionend) y la flecha queda fija.
  const rotor = document.querySelector('[data-fortune-rotor]');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(rotor.getAttribute('style'), /transform 3\.1s/, 'la rueda frena con transición');
  const spinningAngle = Number((rotor.getAttribute('style').match(/rotate\((-?[\d.]+)deg\)/) || [])[1]);
  assert.ok(spinningAngle > 4 * 360, 'da varias vueltas antes de detenerse');
  rotor.dispatchEvent(new window.Event('transitionend'));
  await new Promise(resolve => setTimeout(resolve, 30));

  const settled = document.querySelector('[data-fortune-stage]');
  assert.ok(settled.classList.contains('landed'), 'la flecha queda marcando el sector');
  const hit = document.querySelectorAll('[data-fortune-sector].is-hit');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].getAttribute('data-value'), '10');
  const landedRotor = document.querySelector('[data-fortune-rotor]');
  const angle = Number((landedRotor.getAttribute('style').match(/rotate\((-?[\d.]+)deg\)/) || [])[1]);
  const position = ((angle + wheel.sectorAngle(wheel.indexOf(10))) % 360 + 360) % 360;
  assert.ok(position < 1e-6 || position > 360 - 1e-6, `el sector 10 queda bajo la flecha (${position})`);
  assert.match(document.querySelector('.fortune-hub').textContent, /SECTOR · PAGA x11/);
  assert.match(document.querySelector('.fortune-hub').textContent, /Gana \+600 fichas/);
  assert.equal(document.querySelector('.fortune-legend-item.active')?.dataset.fortuneTier, '10');

  // Una ronda nueva vuelve a ocultar el resultado anterior.
  handlers.room_state(fortuneRoom({ phase: 'betting', value: null, chips: 940 }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(document.querySelectorAll('.fortune-sector.is-hit').length, 0, 'la ronda nueva no conserva el brillo anterior');
  assert.ok(!document.querySelector('[data-fortune-stage]').classList.contains('landed'));
});
