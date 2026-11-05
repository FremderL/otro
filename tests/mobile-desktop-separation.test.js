'use strict';

// Separación estricta entre la vista de computadora y la de móvil: los
// controles que solo existen bajo mobile.css (≤ 900 px) —menú hamburguesa,
// drawer, chat de mesa, barra inferior y carrusel del Estadio— no deben quedar
// a la vista en escritorio, donde antes se colaban sin estilo porque mobile.js
// les quitaba el atributo `hidden` sin mirar el viewport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const readPublic = file => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
const MOBILE_CLIENT = readPublic('mobile.js');
const STYLES = readPublic('styles.css');
const ESTADIO_STYLES = readPublic('estadio.css');
const INDEX_HTML = readPublic('index.html');
const ESTADIO_HTML = readPublic('estadio.html');

function load(file, html, width) {
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.matchMedia = () => ({ matches: width <= 900, addListener() {}, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.scrollIntoView = function () {};
  window.scrollTo = () => {};
  window.eval(MOBILE_CLIENT);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return dom;
}

const CASINO_MOBILE_IDS = [
  'mobile-nav-drawer', 'mobile-nav-backdrop',
  'mobile-room-toggle', 'mobile-room-backdrop',
  'mobile-chat-toggle', 'mobile-chat-sheet', 'mobile-chat-backdrop'
];

const isHidden = node => node.hidden === true;

test('en escritorio el menú, el chat y los controles móviles del casino quedan ocultos', () => {
  const dom = load('index.html', INDEX_HTML, 1280);
  try {
    const doc = dom.window.document;
    for (const id of CASINO_MOBILE_IDS) {
      const node = doc.getElementById(id);
      assert.ok(node, `${id} existe en el marcado`);
      assert.equal(isHidden(node), true, `${id} no se muestra en la vista de computadora`);
    }
  } finally {
    dom.window.close();
  }
});

test('en móvil los controles del casino se encienden como antes', () => {
  const dom = load('index.html', INDEX_HTML, 390);
  try {
    const doc = dom.window.document;
    for (const id of CASINO_MOBILE_IDS) {
      assert.equal(isHidden(doc.getElementById(id)), false, `${id} se enciende en móvil`);
    }
  } finally {
    dom.window.close();
  }
});

test('en escritorio el Estadio no muestra la barra inferior ni el carrusel de partidos', () => {
  const dom = load('estadio.html', ESTADIO_HTML, 1280);
  try {
    const doc = dom.window.document;
    assert.equal(isHidden(doc.getElementById('est-bottom-nav')), true, 'sin barra inferior en escritorio');
    assert.equal(isHidden(doc.getElementById('est-mobile-match-bar')), true, 'sin carrusel móvil en escritorio');
    assert.equal(isHidden(doc.getElementById('est-mobile-table')), true, 'la vista Tabla no se abre en escritorio');
    assert.equal(isHidden(doc.getElementById('est-mobile-bets')), true, 'la vista Apuestas no se abre en escritorio');
  } finally {
    dom.window.close();
  }
});

test('al cruzar el breakpoint cada vista se apaga y se enciende sola', async () => {
  const dom = load('index.html', INDEX_HTML, 1280);
  try {
    const { window } = dom;
    const doc = window.document;
    const wait = () => new Promise(resolve => setTimeout(resolve, 260));

    assert.equal(isHidden(doc.getElementById('mobile-chat-sheet')), true);

    window.innerWidth = 390;
    window.dispatchEvent(new window.Event('resize'));
    await wait();
    assert.equal(isHidden(doc.getElementById('mobile-chat-sheet')), false, 'al angostar aparece la interfaz móvil');

    window.innerWidth = 1280;
    window.dispatchEvent(new window.Event('resize'));
    await wait();
    assert.equal(isHidden(doc.getElementById('mobile-chat-sheet')), true, 'al ensanchar se retira la interfaz móvil');
    assert.equal(doc.body.style.overflow, '', 'el scroll del documento queda libre');
  } finally {
    dom.window.close();
  }
});

test('los estilos de escritorio apagan explícitamente los componentes solo-móviles', () => {
  // styles.css y estadio.css se cargan siempre; mobile.css solo ≤900 px.
  const stylesGuard = STYLES.match(/@media \(min-width: 901px\) \{[\s\S]*?\n\}/);
  assert.ok(stylesGuard, 'styles.css tiene la guarda de escritorio');
  for (const selector of ['.mobile-nav-toggle', '.mobile-nav-drawer', '.mobile-chat-sheet', '.mobile-chat-toggle', '.mobile-room-toggle']) {
    assert.ok(stylesGuard[0].includes(selector), `${selector} se apaga en escritorio`);
  }
  assert.match(stylesGuard[0], /display: none !important/);

  const estadioGuard = ESTADIO_STYLES.match(/@media \(min-width: 901px\) \{[\s\S]*?\n\}/);
  assert.ok(estadioGuard, 'estadio.css tiene la guarda de escritorio');
  for (const selector of ['.est-bottom-nav', '.est-mobile-match-bar', '.est-mobile-space']) {
    assert.ok(estadioGuard[0].includes(selector), `${selector} se apaga en escritorio`);
  }
});

test('mobile.css sigue cargándose solo en móvil y no invade escritorio', () => {
  for (const file of ['index.html', 'estadio.html', 'loteria.html']) {
    const html = readPublic(file);
    assert.match(html, /<link rel="stylesheet" href="\/mobile.css" media="\(max-width: 900px\)" \/>/,
      `${file} mantiene el CSS móvil aislado por media query`);
  }
  if (!fs.existsSync(path.join(ROOT, 'public', 'mobile.css'))) return;
  const css = readPublic('mobile.css');
  assert.ok(css.includes('@media (max-width: 900px)'), 'mobile.css trabaja por media queries');
});
