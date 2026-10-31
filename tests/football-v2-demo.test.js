'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const simulator = require('../lib/football/v2/simulator');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/estadio-simulador.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'lib/football/v2/simulator.js'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/estadio-simulador.js'), 'utf8');
const { publicTeams } = require('../lib/football/sockets');

function setup({ reducedMotion = false, seed = 1 } = {}) {
  const dom = new JSDOM(html, { url: `http://localhost:3001/?seed=${seed}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  let frame = null;
  let playersDrawn = 0;
  const requests = [];
  const drawing = new Proxy({}, { get(_target, key) {
    if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (key === 'fillText') return () => { playersDrawn++; };
    return () => {};
  }, set() { return true; } });
  window.HTMLCanvasElement.prototype.getContext = () => drawing;
  window.requestAnimationFrame = callback => { frame = callback; return 1; };
  window.matchMedia = () => ({ matches: reducedMotion });
  window.fetch = (url, options) => { requests.push({ url, options }); return Promise.resolve({ ok: true, json: async () => ({ teams: publicTeams() }) }); };
  window.eval(engine);
  window.eval(script);
  return { dom, requests, get playersDrawn() { return playersDrawn; }, tick(now) { assert.ok(frame); const callback = frame; frame = null; callback(now); } };
}

async function loaded() { await new Promise(resolve => setImmediate(resolve)); }

test('la vista es un partido local sin apuestas y permite elegir dos clubes', async () => {
  const ctx = setup();
  try {
    await loaded();
    const { document, Event } = ctx.dom.window;
    assert.match(document.querySelector('.demo-notice').textContent, /Sin apuestas ni fichas/i);
    assert.match(document.querySelector('.safety-note').textContent, /motor oficial.*sin cambios/i);
    assert.equal(document.querySelectorAll('#home-select option').length, 16);
    assert.equal(document.querySelector('#score-home').textContent, '0');
    assert.equal(document.querySelector('#score-away').textContent, '0');
    assert.ok(ctx.playersDrawn >= 22, 'la cancha dibuja las 22 fichas');
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].url, '/api/estadio/state');
    assert.equal(ctx.requests[0].options.body, undefined);

    const home = document.querySelector('#home-select');
    const away = document.querySelector('#away-select');
    away.value = home.value;
    away.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#match-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    assert.match(document.querySelector('#setup-feedback').textContent, /clubes diferentes/i);
    assert.equal(document.querySelector('#home-name').textContent, 'Real Mandril');
    away.value = 'dynamo_kelvar';
    away.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#match-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(document.querySelector('#away-name').textContent, 'Arsénico FC');
    assert.equal(document.querySelector('#setup-feedback').textContent, '');
    assert.equal(document.querySelector('#score-home').textContent, '0');
    assert.equal(document.querySelector('#match-clock').textContent, '00:00');
  } finally { ctx.dom.window.close(); }
});

test('pausa y velocidad controlan el reloj y respetan movimiento reducido', () => {
  const ctx = setup({ reducedMotion: true });
  try {
    const { document } = ctx.dom.window;
    assert.equal(document.querySelector('#play-toggle').getAttribute('aria-pressed'), 'false');
    assert.match(document.querySelector('#playback-status').textContent, /pausa/i);
    ctx.tick(0); ctx.tick(1000);
    assert.equal(document.querySelector('#match-clock').textContent, '00:00');
    document.querySelector('#play-toggle').click();
    document.querySelector('[data-speed="16"]').click();
    assert.equal(document.querySelector('[data-speed="16"]').getAttribute('aria-pressed'), 'true');
    ctx.tick(1100); ctx.tick(1200); ctx.tick(1300);
    assert.notEqual(document.querySelector('#match-clock').textContent, '00:00');
    document.querySelector('#play-toggle').click();
    const clock = document.querySelector('#match-clock').textContent;
    ctx.tick(2000); ctx.tick(3000);
    assert.equal(document.querySelector('#match-clock').textContent, clock);
    assert.equal(document.querySelector('#play-toggle').getAttribute('aria-pressed'), 'false');
  } finally { ctx.dom.window.close(); }
});

test('el marcador y las jugadas no se muestran antes del instante simulado', () => {
  const home = { id: 'vantora_fc', name: 'Real Mandril', short: 'RMD', formation: '4-3-3' };
  const away = { id: 'united_vanguard', name: 'Farselona FC', short: 'FAR', formation: '4-4-2' };
  const reference = simulator.createMatch({ seed: 1, home, away });
  while (!reference.snapshot().ended) reference.step(10000);
  const firstGoal = reference.eventsAfter(-1).find(event => event.type === 'goal');
  assert.ok(firstGoal);
  const ctx = setup({ seed: 1 });
  try {
    const { document } = ctx.dom.window;
    ctx.tick(0);
    let sawGoal = false;
    for (let tick = 1; tick <= Math.ceil((firstGoal.time + 2) / 0.4) + 2; tick++) {
      ctx.tick(tick * 100);
      const [minutes, seconds] = document.querySelector('#match-clock').textContent.split(':').map(Number);
      const time = minutes * 60 + seconds;
      const score = Number(document.querySelector('#score-home').textContent) + Number(document.querySelector('#score-away').textContent);
      if (time < Math.floor(firstGoal.time)) assert.equal(score, 0, `no revelar gol en ${time}`);
      if (score > 0) {
        assert.ok(time >= Math.floor(firstGoal.time));
        assert.match(document.querySelector('#event-feed').textContent, /¡Gol de/);
        sawGoal = true;
        break;
      }
    }
    assert.ok(sawGoal, 'el gol aparece cuando llega su instante');
  } finally { ctx.dom.window.close(); }
});

test('partido completo de 90 minutos se reproduce a 4× sin adelantar el resultado', () => {
  const seed = 20261102;
  const home = { id: 'vantora_fc', name: 'Real Mandril', short: 'RMD', formation: '4-3-3' };
  const away = { id: 'united_vanguard', name: 'Farselona FC', short: 'FAR', formation: '4-4-2' };
  const reference = simulator.createMatch({ seed, home, away });
  while (!reference.snapshot().ended) reference.step(10000);
  const final = reference.snapshot();
  const ctx = setup({ seed });
  try {
    const { document } = ctx.dom.window;
    assert.equal(document.querySelector('[data-speed="4"]').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('#match-clock').textContent, '00:00');
    ctx.tick(0);
    // A 4×, diez segundos reales corresponden a 40 segundos de juego.
    for (let i = 1; i <= 100; i++) ctx.tick(i * 100);
    assert.equal(document.querySelector('#match-clock').textContent, '00:40');
    assert.notEqual(document.querySelector('#match-phase').textContent, 'FINAL');
    // El añadido también se juega: a los 90 minutos de reloj transcurrido
    // todavía no se conoce el resultado final.
    for (let i = 101; i <= 13502; i++) ctx.tick(i * 100);
    assert.notEqual(document.querySelector('#match-phase').textContent, 'FINAL');
    const finalTick = Math.ceil(final.time / 0.4) + 2;
    for (let i = 13503; i <= finalTick; i++) ctx.tick(i * 100);
    assert.match(document.querySelector('#match-clock').textContent, /^90\+\d\d:\d\d$/);
    assert.equal(document.querySelector('#match-phase').textContent, 'FINAL');
    assert.equal(Number(document.querySelector('#score-home').textContent), final.score.home);
    assert.equal(Number(document.querySelector('#score-away').textContent), final.score.away);
    assert.equal(document.querySelector('#play-toggle').disabled, true);
    const finalRow = [...document.querySelectorAll('#event-feed .feed-item')].find(row => /Final del partido/.test(row.textContent));
    assert.ok(finalRow);
    assert.equal(finalRow.querySelector('time').textContent, `90+${final.clock.s2}′`);
  } finally { ctx.dom.window.close(); }
});
