'use strict';

// Regresión de la navegación inferior del Estadio en móvil: la jornada, las
// posiciones, los mercados y «Mis apuestas» ya no ocupan las columnas apiladas;
// cada pareja vive en su propia vista a pantalla completa (como la Zona de
// afición) y se abre desde el botón correspondiente de la barra inferior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.html'), 'utf8');
const MOBILE = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile.js'), 'utf8');
const MOBILE_STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile.css'), 'utf8');

function createHarness({ width = 390 } = {}) {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000/estadio',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const document = window.document;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.matchMedia = () => ({ matches: width <= 900, addListener() {}, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.scrollIntoView = function () {};
  window.scrollTo = () => {};

  // Lista de partidos como la pinta estadio.js, sin sockets.
  const matches = [];
  const selected = [];
  function addMatch(id, home, away, status) {
    const li = document.createElement('li');
    li.className = 'est-match-item' + (status === 'live' ? ' live' : '');
    li.dataset.matchId = id;
    li.innerHTML = '<div><div class="est-match-teams">' + home + ' vs ' + away + '</div>' +
      '<div class="est-match-meta">Turno · J7</div></div>' +
      '<div><div class="est-match-score">20:30</div>' +
      '<div class="est-match-status ' + status + '">' + status + '</div></div>';
    li.addEventListener('click', () => {
      selected.push(id);
      document.querySelectorAll('#est-match-list .est-match-item')
        .forEach(node => node.classList.toggle('active', node === li));
    });
    document.getElementById('est-match-list').appendChild(li);
    matches.push(li);
    return li;
  }

  function boot() {
    window.eval(MOBILE);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }

  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

  return {
    dom, window, document, addMatch, boot, flush, selected,
    nav: () => document.getElementById('est-bottom-nav'),
    close() { dom.window.close(); }
  };
}

test('el Estadio móvil tiene vistas propias para Tabla y Apuestas en lugar de columnas apiladas', () => {
  const h = createHarness();
  try {
    const doc = h.document;
    const table = doc.getElementById('est-mobile-table');
    const bets = doc.getElementById('est-mobile-bets');
    assert.ok(table && bets, 'existen las dos vistas');
    assert.equal(table.hidden, true, 'la vista Tabla nace cerrada');
    assert.equal(bets.hidden, true, 'la vista Apuestas nace cerrada');
    assert.equal(table.getAttribute('role'), 'dialog');
    assert.equal(bets.getAttribute('role'), 'dialog');
    assert.equal(table.closest('.estadio-shell'), null, 'no ocupan espacio dentro del Estadio');
    assert.equal(bets.closest('.estadio-shell'), null, 'no ocupan espacio dentro del Estadio');

    const tableBtn = h.nav().querySelector('[data-est-space="table"]');
    const betsBtn = h.nav().querySelector('[data-est-space="bets"]');
    assert.ok(tableBtn && betsBtn, 'la barra inferior tiene los accesos');
    assert.equal(tableBtn.getAttribute('aria-controls'), 'est-mobile-table');
    assert.equal(betsBtn.getAttribute('aria-controls'), 'est-mobile-bets');
    assert.equal(tableBtn.textContent.replace(/\s+/g, ''), '📊Tabla');
  } finally {
    h.close();
  }
});

test('en móvil la jornada, las posiciones, los mercados y Mis apuestas se trasladan a su vista', async () => {
  const h = createHarness();
  try {
    h.boot();
    await h.flush();
    const doc = h.document;
    assert.equal(doc.getElementById('est-bottom-nav').hidden, false, 'la barra inferior se muestra');

    assert.equal(doc.getElementById('est-lobby-panel').parentNode.id, 'est-mobile-table-body', 'la jornada vive en la vista Tabla');
    assert.equal(doc.getElementById('est-standings-panel').parentNode.id, 'est-mobile-table-body', 'las posiciones viven en la vista Tabla');
    assert.equal(doc.getElementById('est-bet-panel').parentNode.id, 'est-mobile-bets-slot', 'los mercados viven en la vista Apuestas');
    assert.equal(doc.getElementById('est-mybets-panel').parentNode.id, 'est-mobile-mybets-slot', 'las apuestas abiertas viven en la vista Apuestas');

    assert.equal(doc.querySelector('.est-col-left #est-match-list'), null, 'la columna izquierda ya no muestra la jornada');
    assert.equal(doc.querySelector('.est-col-left #est-standings'), null, 'la columna izquierda ya no muestra las posiciones');
    assert.equal(doc.querySelector('.est-col-right #est-bet-panel'), null, 'la columna derecha ya no muestra los mercados');
  } finally {
    h.close();
  }
});

test('los botones Tabla y Apuestas abren su vista y solo una queda abierta', async () => {
  const h = createHarness();
  try {
    h.boot();
    await h.flush();
    const doc = h.document;
    const nav = h.nav();

    nav.querySelector('[data-est-space="table"]').click();
    assert.equal(doc.getElementById('est-mobile-table').hidden, false, 'el botón Tabla abre la vista');
    assert.equal(doc.querySelector('[data-est-space="table"]').getAttribute('aria-pressed'), 'true');
    assert.equal(doc.body.classList.contains('est-mobile-space-open'), true, 'el fondo no se desplaza');

    nav.querySelector('[data-est-space="bets"]').click();
    assert.equal(doc.getElementById('est-mobile-bets').hidden, false, 'el botón Apuestas abre su vista');
    assert.equal(doc.getElementById('est-mobile-table').hidden, true, 'la vista anterior se cierra');

    doc.getElementById('est-mobile-bets-close').click();
    assert.equal(doc.getElementById('est-mobile-bets').hidden, true, 'Cerrar cierra la vista');
    assert.equal(doc.querySelector('[data-est-tab="center"]').getAttribute('aria-pressed'), 'true', 'vuelve a Partido');

    nav.querySelector('[data-est-space="table"]').click();
    doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.getElementById('est-mobile-table').hidden, true, 'Escape cierra la vista');
  } finally {
    h.close();
  }
});

test('la vista Apuestas permite elegir el partido y separa Apostar de Mis apuestas', async () => {
  const h = createHarness();
  try {
    h.addMatch('m1', 'Alfa FC', 'Beta FC', 'scheduled');
    h.addMatch('m2', 'Gamma FC', 'Delta FC', 'live');
    h.boot();
    await h.flush();
    const doc = h.document;
    doc.querySelector('[data-est-space="bets"]').click();

    const picker = doc.getElementById('est-mobile-match-picker-list');
    const picks = picker.querySelectorAll('.est-mobile-pick-match');
    assert.equal(picks.length, 2, 'el selector lista los partidos de hoy');
    assert.match(picks[0].textContent, /Alfa FC vs Beta FC/);
    assert.match(picks[0].textContent, /Turno · J7/, 'muestra turno y jornada');
    assert.match(picks[0].textContent, /scheduled/, 'muestra el estado del partido');

    picks[0].click();
    assert.deepEqual(h.selected, ['m1'], 'tocar un partido lo selecciona');
    assert.equal(doc.getElementById('est-mobile-bets').hidden, false, 'la vista sigue abierta al elegir partido');
    await h.flush();
    assert.equal(picks[0].classList.contains('is-selected'), true, 'el partido elegido queda marcado');
    assert.match(doc.getElementById('est-mobile-match-picker-note').textContent, /Alfa FC/);

    doc.querySelector('[data-mobile-bets-view="mis"]').click();
    assert.equal(doc.querySelector('[data-mobile-bets-panel="mis"]').hidden, false, 'la sección Mis apuestas se muestra');
    assert.equal(doc.querySelector('[data-mobile-bets-panel="apostar"]').hidden, true, 'Apostar se oculta');
    assert.ok(doc.querySelector('#est-mobile-mybets-slot #est-mybets-panel'), 'las apuestas abiertas viven en su sección');

    doc.querySelector('[data-mobile-bets-view="apostar"]').click();
    assert.equal(doc.querySelector('[data-mobile-bets-panel="apostar"]').hidden, false, 'se vuelve a Apostar');
  } finally {
    h.close();
  }
});

test('el selector se sincroniza con la jornada y se vacía cuando no hay partidos', async () => {
  const h = createHarness();
  try {
    h.boot();
    await h.flush();
    const doc = h.document;
    doc.querySelector('[data-est-space="bets"]').click();
    const picker = doc.getElementById('est-mobile-match-picker-list');
    assert.match(picker.textContent, /No hay partidos programados hoy/);

    h.addMatch('m1', 'Alfa FC', 'Beta FC', 'scheduled');
    await h.flush();
    assert.equal(picker.querySelectorAll('.est-mobile-pick-match').length, 1, 'aparece el partido nuevo');

    doc.getElementById('est-match-list').innerHTML = '';
    await h.flush();
    assert.equal(picker.querySelectorAll('.est-mobile-pick-match').length, 0, 'se limpia al vaciar la jornada');
  } finally {
    h.close();
  }
});

test('el marcador de teléfono da su propia fila al nombre y no lo divide letra por letra', () => {
  const dom = new JSDOM(HTML);
  try {
    const doc = dom.window.document;
    for (const id of ['name-home', 'name-away']) {
      assert.ok(doc.getElementById(id).classList.contains('est-team-name'), `${id} tiene estilos propios`);
    }

    const phone = MOBILE_STYLES.match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/);
    assert.ok(phone, 'existe una disposición específica para teléfonos');
    assert.match(phone[0], /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/,
      'los equipos y el resultado tienen columnas independientes');

    const name = phone[0].match(/\.est-team > span\.est-team-name \{([^}]+)\}/);
    assert.ok(name, 'el nombre ocupa una fila completa dentro de su equipo');
    assert.match(name[1], /grid-row: 2/);
    assert.match(name[1], /width: 100%/);
    assert.match(name[1], /overflow-wrap: break-word/, 'una palabra solo se rompe si ella sola no cabe');
    assert.match(name[1], /word-break: normal/, 'no se fuerza el corte entre letras');
    assert.match(name[1], /white-space: normal/, 'los nombres largos pueden usar varias líneas');
    assert.match(phone[0], /\.est-team \.est-team-cards \{[^}]*grid-row: 3/,
      'las tarjetas ya no les quitan ancho a los nombres');
  } finally {
    dom.window.close();
  }
});

test('al volver a escritorio los paneles regresan a sus columnas y la barra inferior se oculta', async () => {
  const h = createHarness();
  try {
    const doc = h.document;
    const homes = ['est-lobby-panel', 'est-standings-panel', 'est-bet-panel', 'est-mybets-panel']
      .reduce((acc, id) => { acc[id] = doc.getElementById(id).parentNode; return acc; }, {});
    h.boot();
    await h.flush();
    assert.equal(doc.getElementById('est-lobby-panel').parentNode.id, 'est-mobile-table-body');

    h.window.innerWidth = 1200;
    h.window.dispatchEvent(new h.window.Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 250));
    for (const [id, parent] of Object.entries(homes)) {
      assert.equal(doc.getElementById(id).parentNode, parent, id + ' vuelve a su columna');
    }
    assert.equal(doc.getElementById('est-bottom-nav').hidden, true, 'la barra inferior es solo móvil');
    assert.equal(doc.getElementById('est-mobile-table').hidden, true);
  } finally {
    h.close();
  }
});
