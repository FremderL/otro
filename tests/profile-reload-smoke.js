'use strict';

// Regresión: editar el nombre dentro de una mesa y pulsar F5 no debe recuperar
// el nombre con el que se entró originalmente ni sobrescribir el perfil del
// servidor. Se valida también la sesión de reingreso y el alias histórico del
// chat del lobby, las dos fuentes que antes podían revivir el valor anterior.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { TOS_VERSION } = require('../lib/terms');

const port = 5800 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-profile-reload-${process.pid}.json`);
const doms = [];
let server;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, description, timeout = 10000, step = 60) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = fn();
      if (value) return value;
    } catch (_) { /* reintento */ }
    await sleep(step);
  }
  throw new Error(`Tiempo agotado esperando: ${description}`);
}

function storageDump(storage) {
  const result = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    result[key] = storage.getItem(key);
  }
  return result;
}

async function openPage(pathname = '/', { local = {}, session = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    if (!/Not implemented/i.test(error.message)) errors.push(error.message);
  });
  const dom = await JSDOM.fromURL(`${url}${pathname}`, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem('montecristo-gate-bypass', '1');
      window.localStorage.setItem('montecristo-tos', TOS_VERSION);
      Object.entries(local).forEach(([key, value]) => window.localStorage.setItem(key, value));
      Object.entries(session).forEach(([key, value]) => window.sessionStorage.setItem(key, value));
    }
  });
  dom.pageErrors = errors;
  dom.window.scrollTo = () => {};
  doms.push(dom);
  await until(() => dom.window.document.getElementById('account-open-btn')?.hasAttribute('aria-label'),
    'app.js inicializó la página', 6000);
  return dom;
}

function click(doc, selector) {
  const element = doc.querySelector(selector);
  assert.ok(element, `No existe ${selector}`);
  element.click();
  return element;
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`El servidor terminó antes de iniciar.\n${server.log}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (_) { /* todavía iniciando */ }
    await sleep(60);
  }
  throw new Error(`El servidor no abrió el puerto.\n${server.log}`);
}

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', DATABASE_URL: '', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.log = '';
  server.stdout.on('data', chunk => { server.log += chunk; });
  server.stderr.on('data', chunk => { server.log += chunk; });
  await waitForServer();

  const previousName = 'Nombre anterior';
  const currentName = 'Nombre vigente';
  let dom = await openPage('/', { local: {
    'montecristo-name': previousName,
    'montecristo-lobby-name': previousName
  } });
  let doc = dom.window.document;
  const win = dom.window;
  await until(() => doc.getElementById('hero-online-count').textContent === '1', 'el socket conectó');

  click(doc, '[data-open-mode="create"][data-game="coinflip"]');
  await until(() => win.getComputedStyle(doc.getElementById('join-modal')).visibility === 'visible', 'modal de crear mesa');
  doc.getElementById('player-name').value = previousName;
  doc.getElementById('room-name').value = 'Mesa de recarga';
  doc.getElementById('join-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !doc.getElementById('room-app').classList.contains('hidden') && doc.querySelector('[data-quick-choice]'), 'entrada a la mesa', 12000);

  click(doc, '#profile-card');
  await until(() => win.getComputedStyle(doc.getElementById('profile-modal')).visibility === 'visible', 'perfil dentro de la mesa');
  const nameInput = doc.getElementById('profile-name-input');
  nameInput.value = currentName;
  nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
  doc.getElementById('profile-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));

  await until(() => win.localStorage.getItem('montecristo-name') === currentName, 'nombre nuevo confirmado en localStorage');
  await until(() => JSON.parse(win.sessionStorage.getItem('montecristo-session')).name === currentName,
    'sesión de reingreso actualizada con el nombre nuevo');
  assert.equal(win.localStorage.getItem('montecristo-lobby-name'), currentName,
    'el alias guardado del chat también deja de conservar el nombre anterior');

  const deviceToken = win.localStorage.getItem('montecristo-device');
  const roomPath = win.location.pathname;
  assert.match(roomPath, /^\/room\/[A-Z0-9]{5}$/i, 'la URL contiene la sala activa');
  const localSeed = storageDump(win.localStorage);
  const sessionSeed = storageDump(win.sessionStorage);

  // Defensa adicional: simula una sesión histórica realmente obsoleta. Aunque
  // sessionStorage aún diga el nombre anterior, localStorage (último guardado
  // confirmado) debe ganar al reconstruir el estado después de F5.
  const staleSession = JSON.parse(sessionSeed['montecristo-session']);
  staleSession.name = previousName;
  sessionSeed['montecristo-session'] = JSON.stringify(staleSession);
  dom.window.close();
  await sleep(250);

  dom = await openPage(roomPath, { local: localSeed, session: sessionSeed });
  doc = dom.window.document;
  await until(() => !doc.getElementById('room-app').classList.contains('hidden') && doc.querySelector('[data-quick-choice]'),
    'reingreso automático después de recargar', 12000);
  click(doc, '#profile-card');
  await until(() => dom.window.getComputedStyle(doc.getElementById('profile-modal')).visibility === 'visible', 'perfil visible tras recargar');
  assert.equal(doc.getElementById('profile-name-input').value, currentName,
    'el perfil muestra el nombre actualizado después de recargar');

  const historyResponse = await fetch(`${url}/api/perfil/${encodeURIComponent(deviceToken)}/historial`);
  assert.equal(historyResponse.ok, true, 'el perfil autoritativo sigue disponible');
  const history = await historyResponse.json();
  assert.equal(history.perfil.nombre, currentName,
    'la recarga no revirtió el nombre persistido en el servidor');
  assert.deepEqual(dom.pageErrors, [], `La consola del navegador quedó limpia: ${dom.pageErrors.join(' | ')}`);

  console.log('✅ profile-reload-smoke: nombre y sesión de perfil sobreviven a F5 sin volver al valor anterior OK');
}

main()
  .catch(error => {
    console.error('❌ profile-reload-smoke:', error.stack || error.message);
    if (server?.log) console.error(server.log.slice(-1200));
    process.exitCode = 1;
  })
  .finally(async () => {
    doms.forEach(dom => { try { dom.window.close(); } catch (_) { /* noop */ } });
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => { server.on('exit', resolve); setTimeout(resolve, 1200); });
    }
    try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  });
