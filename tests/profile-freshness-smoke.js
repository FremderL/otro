'use strict';

// Auditoría del bug reportado: "terminé de jugar, entré a mi perfil y no se
// actualizó según lo que tenía, sino hasta que volví a guardar; incluso una
// vez me apareció el nombre anterior y los puntos de entonces".
//
// Causa raíz (cliente): fuera de una mesa, el modal de perfil pinta la caché
// de la sesión de cuenta (localStorage), y esa caché solo se refrescaba al
// reconectar el socket, al volver a guardar el perfil o si estaba
// estructuralmente incompleta. Ni el fin de una partida (que actualiza el
// perfil en el servidor: fichas, stats y hasta el nombre con que se entró a
// la mesa) ni la salida de la mesa renovaban la caché.
//
// Este E2E con jsdom reproduce el flujo completo del reporte:
//
//  1. Se crea una cuenta desde el lobby (la caché queda con el nombre y las
//     fichas de ese momento).
//  2. Se entra a una mesa con OTRO nombre y se juega una ronda real (el
//     servidor renombra el perfil y mueve las fichas).
//  3. Se vuelve al lobby y se abre el perfil SIN volver a guardar.
//  4. El modal debe mostrar el nombre y las fichas ACTUALES del servidor
//     (se confirman preguntándole al servidor con un login desde otro
//     socket), no los de la caché vieja.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { io } = require('socket.io-client');
const { TOS_VERSION } = require('../lib/terms');

const port = 5200 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-profile-freshness-${process.pid}.json`);
let server;
const doms = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const formatChips = number => new Intl.NumberFormat('es-MX').format(Math.max(0, Math.floor(Number(number) || 0)));

async function until(fn, description, timeout = 10000, step = 80) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = fn(); if (value) return value; } catch (_) { /* reintento */ }
    await sleep(step);
  }
  throw new Error(`Tiempo agotado esperando: ${description}`);
}

function click(root, selector) {
  const el = root.querySelector(selector);
  assert.ok(el, `No existe el elemento ${selector}`);
  el.click();
  return el;
}

function accountButtonText(doc) {
  return doc.getElementById('account-open-btn')?.textContent.trim().replace(/\s+/g, ' ');
}

async function loadPageOnce({ seedLocalStorage } = {}) {
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    if (!/Not implemented/i.test(error.message)) pageErrors.push(error.message);
  });
  const dom = await JSDOM.fromURL(`${url}/`, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem('montecristo-gate-bypass', '1');
      window.localStorage.setItem('montecristo-tos', TOS_VERSION);
      if (seedLocalStorage) {
        Object.entries(seedLocalStorage).forEach(([key, value]) => window.localStorage.setItem(key, value));
      }
    }
  });
  dom.pageErrors = pageErrors;
  dom.window.scrollTo = () => {};
  return dom;
}

async function openPage({ seedLocalStorage } = {}) {
  // Igual que en account-ui-smoke.js: se verifica una señal inequívoca de que
  // app.js corrió de verdad antes de continuar.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dom = await loadPageOnce({ seedLocalStorage });
    try {
      await until(() => dom.window.document.getElementById('account-open-btn')?.hasAttribute('aria-label'), 'app.js inicializó el botón de cuenta', 5000);
      doms.push(dom);
      return dom;
    } catch (_) {
      try { dom.window.close(); } catch (_) { /* noop */ }
      if (attempt < maxAttempts) await sleep(300);
    }
  }
  throw new Error('app.js no se ejecutó tras varios intentos de carga de página');
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', DATABASE_URL: '', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.log = '';
  child.stdout.on('data', chunk => { child.log += chunk; });
  child.stderr.on('data', chunk => { child.log += chunk; });
  return child;
}
async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`El servidor terminó antes de iniciar.\n${server.log}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (_) { /* aún iniciando */ }
    await sleep(80);
  }
  throw new Error(`El servidor no abrió el puerto.\n${server.log}`);
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 6000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}

async function main() {
  server = startServer();
  await waitForServer();

  const username = `fresh${Date.now()}`.slice(0, 20);
  const password = 'clave-de-prueba-freshness';
  const cachedName = 'NombreCache';   // nombre que queda en la caché al crear la cuenta
  const tabletName = 'NombreMesa';    // nombre con el que se entra a jugar

  // ---------- 1) Signup: la caché de la cuenta queda con el estado de AHORA ----------
  const dom = await openPage({ seedLocalStorage: { 'montecristo-name': cachedName } });
  const doc = dom.window.document;
  const win = dom.window;
  await sleep(1200); // conecta el socket y carga el lobby

  click(doc, '#account-open-btn');
  await until(() => win.getComputedStyle(doc.getElementById('account-modal')).visibility === 'visible', 'modal de cuenta visible', 5000);
  click(doc, '#account-switch'); // pasa a modo "crear cuenta"
  doc.getElementById('account-username').value = username;
  doc.getElementById('account-password').value = password;
  doc.getElementById('account-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Perfil/.test(accountButtonText(doc)), 'el botón cambia a "Perfil" tras crear la cuenta', 6000);

  const storedSession = JSON.parse(win.localStorage.getItem('montecristo-account-session'));
  assert.equal(storedSession.name, cachedName, 'la caché de la sesión arranca con el nombre del signup');
  assert.equal(storedSession.chips, 1000, 'la caché de la sesión arranca con las fichas iniciales');

  // ---------- 2) Entra a una mesa con OTRO nombre y juega una ronda real ----------
  click(doc, '[data-open-mode="create"][data-game="coinflip"]');
  await until(() => win.getComputedStyle(doc.getElementById('join-modal')).visibility === 'visible', 'modal de crear sala visible', 5000);
  doc.getElementById('player-name').value = tabletName;
  doc.getElementById('room-name').value = 'Mesa fresh';
  doc.getElementById('join-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => doc.querySelector('[data-quick-choice="heads"]'), 'la mesa de coinflip cargó', 12000);

  click(doc, '[data-quick-choice="heads"]');
  doc.getElementById('quick-bet-amount').value = '50';
  click(doc, '[data-quick-bet]');
  await until(() => /Apuesta confirmada/.test(doc.body.textContent), 'la confirmación de la apuesta', 8000);
  const launch = await until(() => doc.querySelector('[data-event="quick_resolve"]'), 'el botón «Lanzar ronda»', 8000);
  launch.click();
  await until(() => doc.querySelector('.result-strip .result-item'), 'el resultado de la ronda', 20000);

  // ---------- 3) Vuelve al lobby (sin recargar la página ni volver a guardar) ----------
  click(doc, '#leave-room');
  await until(() => doc.getElementById('room-app').classList.contains('hidden') === true, 'se regresó al lobby', 8000);
  await sleep(400); // deja cerrar el modal/perfil y asentar los handlers

  // Estado AUTORITATIVO del servidor, consultado con otro socket (login).
  const checkSocket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise(resolve => checkSocket.on('connect', resolve));
  const relogin = await emitAck(checkSocket, 'account_login', { username, password });
  assert.equal(relogin.ok, true, relogin.error);
  const serverProfile = relogin.profile;
  checkSocket.disconnect();
  assert.equal(serverProfile.name, tabletName, 'el servidor renombró el perfil al entrar a la mesa');
  assert.ok(serverProfile.stats.roundsPlayed >= 1, 'el servidor registró la ronda jugada');
  assert.notEqual(serverProfile.chips, storedSession.chips, 'las fichas del servidor difieren de la caché (bono diario + ronda)');

  // ---------- 4) Abre el perfil desde el lobby SIN volver a guardar ----------
  click(doc, '#account-open-btn'); // hay sesión: abre el perfil directamente
  await until(() => win.getComputedStyle(doc.getElementById('profile-modal')).visibility === 'visible', 'modal de perfil visible', 5000);

  // El modal debe converger al estado real del servidor (puede pintar la caché
  // un instante y refrescarse en segundo plano, pero nunca quedarse viejo).
  await until(() => doc.getElementById('profile-name-input').value === serverProfile.name,
    `el perfil del lobby muestra el nombre actual (${serverProfile.name}) y no el anterior (${cachedName})`, 8000);
  await until(() => {
    const chipsCell = doc.querySelector('#profile-stats .profile-stat b');
    return chipsCell && chipsCell.textContent === formatChips(serverProfile.chips);
  }, `el perfil del lobby muestra las fichas actuales (${formatChips(serverProfile.chips)}) y no las de entonces (${formatChips(storedSession.chips)})`, 8000);

  // La caché de la sesión también quedó renovada (sin esperar una recarga).
  const refreshedSession = JSON.parse(win.localStorage.getItem('montecristo-account-session'));
  assert.equal(refreshedSession.name, serverProfile.name, 'la caché de la sesión se renovó con el nombre actual');
  assert.equal(refreshedSession.chips, serverProfile.chips, 'la caché de la sesión se renovó con las fichas actuales');
  assert.equal(refreshedSession.stats.roundsPlayed, serverProfile.stats.roundsPlayed, 'la caché de la sesión se renovó con las rondas jugadas');

  // Mientras se escribe un nombre nuevo, un refresco en segundo plano no pisa
  // la edición en curso (el guardado sigue siendo explícito).
  const nameInput = doc.getElementById('profile-name-input');
  nameInput.value = 'Edición en curso';
  nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(150);
  doc.getElementById('profile-name-input').dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(300);
  assert.equal(doc.getElementById('profile-name-input').value, 'Edición en curso', 'un refresco en segundo plano no sobrescribe la edición del nombre');

  console.log('✅ profile-freshness-smoke: el perfil del lobby refleja nombre, fichas y rondas tras jugar (sin volver a guardar) OK');
}

main()
  .catch(error => { console.error('❌ profile-freshness-smoke:', error.stack || error.message); process.exitCode = 1; })
  .finally(async () => {
    for (const dom of doms) { try { dom.window.close(); } catch (_) { /* noop */ } }
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => { server.on('exit', resolve); setTimeout(resolve, 1500); });
    }
    try { require('node:fs').unlinkSync(profilePath); } catch (_) { /* noop */ }
  });
