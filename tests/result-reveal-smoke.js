'use strict';

// Auditoría del comportamiento de revelado en ruleta y tragamonedas:
// "que la notificación del resultado solo aparezca al terminar la animación,
// ya sea que el usuario la salte o termine sola".
//
// El servidor resuelve la ronda (eventos win/loss/quick_result y premios)
// mientras la rueda o los rodillos siguen girando. Antes de la corrección,
// los toasts de "Ronda resuelta"/"Victoria"/"Fin de la ronda", el destello de
// ronda y las fanfarrias aparecían de inmediato, destripando el suspenso.
//
// Este E2E con jsdom cubre ambos caminos:
//  1. Ruleta — se saltó la animación con el botón: durante el giro no hay
//     ningún aviso del resultado; al saltar, aparecen todos juntos.
//  2. Tragamonedas — la animación termina sola: ídem, los avisos esperan al
//     frenado natural de los rodillos.
// Además verifica que los avisos que NO dependen del resultado (p. ej.
// "Resultado en camino" al lanzar) siguen apareciendo de inmediato.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { TOS_VERSION } = require('../lib/terms');

const port = 5900 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-result-reveal-${process.pid}.json`);
let server;
const doms = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, description, timeout = 12000, step = 80) {
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

function toastTitles(doc) {
  return [...doc.querySelectorAll('#toast-stack .toast-copy b')].map(el => el.textContent.trim());
}

const RESULT_TITLES = ['Ronda resuelta', 'Victoria', 'Fin de la ronda', 'Empate', 'Premio especial'];

async function loadPageOnce() {
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
      window.localStorage.setItem('montecristo-notifications', 'on');
    }
  });
  dom.pageErrors = pageErrors;
  dom.window.scrollTo = () => {};
  return dom;
}

async function openPage() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dom = await loadPageOnce();
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

async function createRoom(doc, win, game, playerName, roomName) {
  click(doc, `[data-open-mode="create"][data-game="${game}"]`);
  await until(() => win.getComputedStyle(doc.getElementById('join-modal')).visibility === 'visible', 'modal de crear sala visible', 5000);
  doc.getElementById('player-name').value = playerName;
  doc.getElementById('room-name').value = roomName;
  doc.getElementById('join-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
}

// Apuesta y lanza la ronda como anfitrión; devuelve cuando el botón de saltar
// está en pantalla (la room_state de resultados ya llegó y la animación corre,
// lo que implica que los eventos del resultado también llegaron antes).
async function betAndLaunch(doc, choiceSelector) {
  if (choiceSelector) click(doc, choiceSelector);
  doc.getElementById('quick-bet-amount').value = '10';
  click(doc, '[data-quick-bet]');
  await until(() => /Apuesta confirmada/.test(doc.body.textContent), 'la confirmación de la apuesta', 8000);
  const launch = await until(() => doc.querySelector('[data-event="quick_resolve"]'), 'el botón «Lanzar ronda»', 8000);
  launch.click();
}

function assertNoResultAnnouncementsYet(doc, phase) {
  const titles = toastTitles(doc);
  const spoiler = titles.filter(title => RESULT_TITLES.includes(title));
  assert.deepEqual(spoiler, [], `${phase}: ningún aviso del resultado mientras gira la animación (había: ${titles.join(', ') || 'ninguno'})`);
  assert.doesNotMatch(doc.getElementById('round-flash').textContent || '', /Resultado:/, `${phase}: el destello de ronda no revela el resultado mientras gira`);
}

async function main() {
  server = startServer();
  await waitForServer();

  // ================= 1) RULETA: revelado al SALTAR la animación =================
  {
    const dom = await openPage();
    const doc = dom.window.document;
    const win = dom.window;
    await sleep(1200);
    await createRoom(doc, win, 'roulette', 'Ruletera', 'Mesa de la ruleta');
    await until(() => doc.querySelector('[data-quick-choice="red"]'), 'la mesa de ruleta cargó', 12000);
    await betAndLaunch(doc, '[data-quick-choice="red"]');

    const skip = await until(() => doc.querySelector('[data-roulette-skip]'), 'el botón «Saltar animación» de la ruleta', 15000);
    // El aviso neutral de lanzamiento sí llegó ya (no revela nada).
    await until(() => toastTitles(doc).includes('Resultado en camino'), 'el aviso de lanzamiento inmediato', 5000);
    await sleep(700); // margen para que cualquier aviso prematura hubiera aparecido
    assertNoResultAnnouncementsYet(doc, 'ruleta girando');

    skip.click();
    await until(() => toastTitles(doc).includes('Ronda resuelta'), 'el toast «Ronda resuelta» tras saltar la animación', 8000);
    await until(() => {
      const titles = toastTitles(doc);
      return titles.includes('Victoria') || titles.includes('Fin de la ronda') || titles.includes('Empate');
    }, 'el toast del propio resultado (victoria/derrota) tras saltar la animación', 8000);
    assert.match(doc.getElementById('round-flash').textContent || '', /Resultado:/, 'el destello de ronda revela el resultado al terminar la animación');
    await until(() => !doc.querySelector('.quick-result-label.spinning'), 'la etiqueta del resultado dejó de girar', 5000);
  }

  // ============ 2) TRAGAMONEDAS: revelado al TERMINAR SOLA la animación ============
  {
    const dom = await openPage();
    const doc = dom.window.document;
    const win = dom.window;
    await sleep(1200);
    await createRoom(doc, win, 'slots', 'Tragamonedista', 'Mesa de la tragamonedas');
    await until(() => doc.getElementById('quick-bet-amount'), 'la mesa de tragamonedas cargó', 12000);
    await betAndLaunch(doc, null);

    await until(() => doc.querySelector('[data-slots-skip]'), 'el botón «Saltar animación» de la tragamonedas', 15000);
    await sleep(700);
    assertNoResultAnnouncementsYet(doc, 'tragamonedas girando');

    // NO se salta: los rodillos se detienen solos (~3,5 s) y ahí aparecen los avisos.
    await until(() => toastTitles(doc).includes('Ronda resuelta'), 'el toast «Ronda resuelta» tras el frenado natural', 12000);
    await until(() => {
      const titles = toastTitles(doc);
      return titles.includes('Victoria') || titles.includes('Fin de la ronda') || titles.includes('Empate');
    }, 'el toast del propio resultado tras el frenado natural', 8000);
    await until(() => !doc.querySelector('.quick-result-label.spinning'), 'la etiqueta del resultado dejó de girar', 5000);
    // El botón de saltar desapareció: la animación terminó de verdad.
    await until(() => !doc.querySelector('[data-slots-skip]'), 'el botón de saltar desaparece al terminar', 5000);
  }

  for (const dom of doms) {
    assert.deepEqual(dom.pageErrors, [], `la consola quedó limpia: ${dom.pageErrors.join(' | ')}`);
  }
  console.log('✅ result-reveal-smoke: la notificación del resultado espera a la animación (saltada o terminada sola) en ruleta y tragamonedas OK');
}

main()
  .catch(error => { console.error('❌ result-reveal-smoke:', error.stack || error.message); process.exitCode = 1; })
  .finally(async () => {
    for (const dom of doms) { try { dom.window.close(); } catch (_) { /* noop */ } }
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => { server.on('exit', resolve); setTimeout(resolve, 1500); });
    }
    try { require('node:fs').unlinkSync(profilePath); } catch (_) { /* noop */ }
  });
