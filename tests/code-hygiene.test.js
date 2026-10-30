'use strict';

// Higiene del código: evita que vuelvan a aparecer piezas que "existen pero no
// hacen nada". No sustituye a eslint: comprueba cosas que el linter no ve,
// como eventos de Socket.IO que nadie escucha o CSS de interfaces retiradas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Todos los emisores del servidor: server.js y los módulos de lib/.
function serverSources() {
  const files = ['server.js'];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.js')) files.push(path.relative(ROOT, full));
    }
  })(path.join(ROOT, 'lib'));
  return files.map(read).join('\n');
}
// Eventos propios del cliente de Socket.IO, no del casino.
const SOCKET_LIFECYCLE = ['connect', 'connect_error', 'connect_timeout', 'disconnect', 'reconnect', 'reconnect_attempt', 'reconnect_failed', 'reconnect_error'];
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const UI_FILES = ['public/app.js', 'public/estadio.js', 'public/admin.js', 'public/loteria.js'];
const HTML_FILES = ['public/index.html', 'public/estadio.html', 'public/admin.html', 'public/loteria.html'];

// Eventos que el servidor anuncia y ningún cliente escucha todavía. Cada uno es
// una deuda consciente: o se le pone interfaz, o se deja de emitir.
const EVENTS_WITHOUT_CLIENT = new Set([
  // Se emite justo antes de expulsar la sesión; el aviso nunca llega. Ver
  // docs/auditoria-codigo-inerte.md (hallazgo B1).
  'account_moderated',
  // Estadio: el servidor los emite pero el cliente todavía no los pinta. La
  // función está apagada en producción (FOOTBALL_ENABLED=off); se revisan antes
  // de encenderla. Ver el mismo informe (hallazgo B2).
  'football:goal', 'football:reaction', 'football:chat', 'football:reconcile'
]);

test('cada evento que emite el servidor tiene quien lo escuche', () => {
  const server = serverSources();
  const clients = UI_FILES.map(read).join('\n');
  const emitted = new Set([...server.matchAll(/\.emit\(\s*['"`]([\w:]+)['"`]/g)].map(m => m[1]));
  const listened = new Set([...clients.matchAll(/\.on\(\s*['"`]([\w:]+)['"`]/g)].map(m => m[1]));
  const orphans = [...emitted].filter(event => !listened.has(event) && !EVENTS_WITHOUT_CLIENT.has(event));
  assert.deepEqual(orphans, [], `eventos sin cliente: ${orphans.join(', ')}`);
});

test('cada evento que escucha el cliente lo emite el servidor', () => {
  const server = serverSources();
  const clients = UI_FILES.map(read).join('\n');
  const emitted = new Set([...server.matchAll(/\.emit\(\s*['"`]([\w:]+)['"`]/g)].map(m => m[1]));
  const listened = [...new Set([...clients.matchAll(/\.on\(\s*['"`]([\w:]+)['"`]/g)].map(m => m[1]))];
  const missing = listened.filter(event => !emitted.has(event) && !SOCKET_LIFECYCLE.includes(event));
  assert.deepEqual(missing, [], `el cliente espera eventos que el servidor no emite: ${missing.join(', ')}`);
});

test('no quedan reglas CSS de las tarjetas y ruedas retiradas', () => {
  const css = read('public/styles.css');
  const html = HTML_FILES.map(read).join('\n');
  const js = UI_FILES.concat(['public/fortune-wheel.js', 'public/loteria.js']).map(read).join('\n');
  // Clases eliminadas al rehacer la Rueda y las miniaturas del lobby. Si alguna
  // vuelve, o se usa de verdad en el marcado o no debe estar en la hoja.
  const retired = ['quick-art', 'mini-wheel', 'mini-die', 'mini-coin', 'mini-table-surface', 'mini-table-chip',
    'chip-red', 'chip-gold', 'chip-cyan', 'coin-shadow', 'coin-surface', 'dice-surface', 'mini-die-second',
    'roulette-wheel', 'quick-result-number', 'mini-table-surface'];
  for (const name of retired) {
    assert.ok(!css.includes(`.${name}`), `styles.css conserva .${name}`);
    assert.ok(!html.includes(name) && !js.includes(name), `${name} volvió al marcado: hay que devolverle su estilo`);
  }
});

test('la Rueda conserva 54 sectores y su flecha en el cliente', () => {
  const wheel = require('../public/fortune-wheel.js');
  assert.equal(wheel.LAYOUT.length, 54);
  const markup = wheel.markup({ value: 5, phase: 'results', landed: true, angle: 0 });
  assert.equal((markup.match(/data-fortune-sector="/g) || []).length, 54);
  assert.match(markup, /fortune-pointer/);
});
