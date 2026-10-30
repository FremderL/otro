'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', 'preview', 'zona-aficion');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'demo.js'), 'utf8');

function setup() {
  const dom = new JSDOM(html, { url: 'http://localhost:3001/', runScripts: 'outside-only' });
  dom.window.fetch = () => { throw new Error('La demostración no debe llamar a ninguna API'); };
  dom.window.eval(script);
  return dom;
}

test('la demo identifica los datos ficticios y permite navegar sin alterar Mi Once real', () => {
  const dom = setup();
  try {
    const { document } = dom.window;
    assert.match(document.querySelector('.demo-notice').textContent, /Datos ficticios.*Nada se guarda/i);
    const sections = ['once', 'mercado', 'quiniela', 'aficion', 'escudos'];
    for (const id of sections) {
      document.querySelector(`[data-view="${id}"]`).click();
      assert.equal(document.querySelector(`[data-panel="${id}"]`).hidden, false);
      assert.equal(document.querySelector(`[data-view="${id}"]`).getAttribute('aria-current'), 'page');
      assert.equal(document.querySelectorAll('[data-panel]:not([hidden])').length, 1);
    }
    assert.equal(document.querySelectorAll('.pitch-player').length, 11);
    document.getElementById('lineup-edit').click();
    document.querySelector('[data-player="0"]').click();
    assert.match(document.getElementById('lineup-feedback').textContent, /No se guardan datos/);
    assert.equal(document.querySelectorAll('.transfer-card').length, 4);
    assert.match(document.querySelector('#view-mercado').textContent, /siguiente temporada/i);
  } finally { dom.window.close(); }
});

test('la quiniela de ejemplo requiere ocho selecciones y no registra boletos', () => {
  const dom = setup();
  try {
    const { document, Event } = dom.window;
    assert.equal(document.querySelectorAll('.match-row').length, 8);
    const submit = document.getElementById('prediction-submit');
    assert.equal(submit.disabled, true);
    const inputs = document.querySelectorAll('.match-row input[value="L"]');
    inputs.forEach((input, index) => {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      assert.equal(submit.disabled, index !== 7);
    });
    assert.equal(document.getElementById('prediction-count').textContent, '8');
    submit.click();
    assert.match(document.getElementById('prediction-feedback').textContent, /no se registró ningún boleto ni se cobraron fichas/i);
    assert.match(document.querySelector('#view-quiniela').textContent, /se acumula.*siguiente jornada/i);
    assert.match(document.querySelector('#view-quiniela').textContent, /se reembolsan las entradas/i);
  } finally { dom.window.close(); }
});

test('la selección de clubes es local, accesible y cuenta con los 16 equipos ficticios', () => {
  const dom = setup();
  try {
    const { document } = dom.window;
    const toggle = document.getElementById('change-club');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(document.getElementById('club-picker').hidden, false);
    assert.equal(document.querySelectorAll('.club-option').length, 16);
    document.querySelector('[data-club="FAR"]').click();
    assert.equal(document.getElementById('club-confirm').hidden, true);
    assert.match(document.getElementById('fan-wins').textContent, /3/);
    document.querySelector('[data-club="LVP"]').click();
    assert.equal(document.getElementById('club-confirm').hidden, false);
    assert.equal(document.getElementById('chosen-club').textContent, 'Farselona FC');
    assert.match(document.getElementById('club-confirm').textContent, /pierdes el progreso, nivel y recompensas/);
    document.getElementById('cancel-club').click();
    assert.equal(document.getElementById('club-confirm').hidden, true);
    assert.equal(document.getElementById('chosen-club').textContent, 'Farselona FC');
    assert.match(document.getElementById('fan-wins').textContent, /3/);
    document.querySelector('[data-club="LVP"]').click();
    document.getElementById('confirm-club').click();
    assert.equal(document.getElementById('chosen-club').textContent, 'Liverpulpo FC');
    assert.equal(document.querySelector('[data-club="LVP"]').getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement.getAttribute('data-club'), 'LVP');
    assert.match(document.getElementById('fan-wins').textContent, /0/);
    assert.match(document.getElementById('fan-level').textContent, /NIVEL 0/);
    assert.equal(document.querySelectorAll('#fan-rewards .locked').length, 3);
    assert.equal(document.getElementById('fan-opt').checked, false);
    document.querySelector('[data-club="FAR"]').click();
    document.getElementById('confirm-club').click();
    assert.equal(document.getElementById('chosen-club').textContent, 'Farselona FC');
    assert.match(document.getElementById('fan-wins').textContent, /0/);
    assert.match(document.getElementById('club-feedback').textContent, /No se modificó tu perfil real/);
    assert.match(document.querySelector('#club-picker').textContent, /Ejemplo sin guardar/);
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  } finally { dom.window.close(); }
});


test('la galería muestra los 16 escudos originales y cada SVG existe por separado', () => {
  const dom = setup();
  try {
    const { document } = dom.window;
    assert.equal(document.getElementById('view-escudos').hidden, false);
    const cards = [...document.querySelectorAll('.crest-card')];
    assert.equal(cards.length, 16);
    const sources = cards.map(card => card.querySelector('a').getAttribute('href'));
    assert.equal(document.querySelectorAll('.crest-card svg').length, 16);
    assert.equal(new Set(sources).size, 16);
    for (const src of sources) {
      const file = path.join(root, src.slice(1));
      const svg = fs.readFileSync(file, 'utf8');
      assert.match(svg, /<svg[^>]*viewBox="0 0 240 280"/);
      assert.match(svg, /<title id="title">Escudo original de /);
      assert.doesNotMatch(svg, /<script|<image|https?:\/\/(?!www\.w3\.org)/i);
    }
    assert.equal(document.querySelectorAll('.crest-card a[download]').length, 16);
  } finally { dom.window.close(); }
});


test('los escudos están visibles incluso si el navegador no ejecuta JavaScript', () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3001/' });
  try {
    const { document } = dom.window;
    assert.equal(document.getElementById('view-escudos').hidden, false);
    assert.equal(document.querySelectorAll('#crest-gallery .crest-card svg').length, 16);
    assert.equal(document.querySelectorAll('#crest-gallery a[download]').length, 16);
    assert.equal(document.getElementById('view-once').hidden, true);
  } finally { dom.window.close(); }
});
