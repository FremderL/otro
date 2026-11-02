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

// Eventos que el servidor anuncia y ningún cliente escucha todavía. Cada uno
// sería una deuda consciente: o se le pone interfaz, o se deja de emitir.
// Vacío desde que se cerraron los hallazgos B1 y B2 de
// docs/auditoria-codigo-inerte.md; se mantiene el mecanismo para que cualquier
// evento nuevo sin consumidor rompa la suite.
const EVENTS_WITHOUT_CLIENT = new Set([]);

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

test('regla obligatoria MonteCristo News: todo módulo que afecte a clubes está registrado y cubierto', () => {
  const agentsDoc = read('AGENTS.md');
  const ruleDoc = read('docs/montecristo-news-regla-clubes.md');
  assert.match(agentsDoc, /MonteCristo News/i);
  assert.match(agentsDoc, /afecte a (los )?clubes/i);
  assert.match(ruleDoc, /REGLA OBLIGATORIA/i);

  const {
    CLUB_NEWS_TYPES,
    CLUB_IMPACT_REGISTRY,
    NON_CLUB_NEWS_MODULES
  } = require('../lib/football/club-news');

  const footballDir = path.join(ROOT, 'lib', 'football');
  const jsFiles = fs.readdirSync(footballDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name)
    .sort();

  const unclassified = jsFiles.filter(name => !CLUB_IMPACT_REGISTRY[name] && !NON_CLUB_NEWS_MODULES[name]);
  assert.deepEqual(
    unclassified,
    [],
    `Regla MonteCristo News: los siguientes módulos de lib/football/ no declaran su cobertura en CLUB_IMPACT_REGISTRY (o NON_CLUB_NEWS_MODULES si no afectan a clubes) de lib/football/club-news.js: ${unclassified.join(', ')}. Todo desarrollo que afecte a clubes debe incluirse en MonteCristo News.`
  );

  const overlap = jsFiles.filter(name => CLUB_IMPACT_REGISTRY[name] && NON_CLUB_NEWS_MODULES[name]);
  assert.deepEqual(overlap, [], `Módulos clasificados simultáneamente como con y sin impacto de club: ${overlap.join(', ')}`);

  for (const [moduleName, meta] of Object.entries(CLUB_IMPACT_REGISTRY)) {
    assert.ok(jsFiles.includes(moduleName), `CLUB_IMPACT_REGISTRY referencia un módulo inexistente: ${moduleName}`);
    assert.ok(meta && typeof meta.domain === 'string' && meta.domain.trim().length > 0, `${moduleName} requiere descripción de dominio`);
    assert.ok(Array.isArray(meta.newsTypes) && meta.newsTypes.length > 0, `${moduleName} debe declarar al menos un tipo de anuncio en MonteCristo News`);
  }

  const coveredTypes = new Set(Object.values(CLUB_IMPACT_REGISTRY).flatMap(meta => meta.newsTypes));
  for (const type of CLUB_NEWS_TYPES) {
    assert.ok(coveredTypes.has(type), `El tipo de anuncio de club "${type}" no tiene módulo emisor registrado`);
  }
});
