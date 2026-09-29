'use strict';

// Fase 9 — Recorrido de usuario real (E2E con jsdom):
// una persona abre la página en su navegador y SOLO interactúa con la interfaz
// (clics, teclear, enviar formularios), nunca con el protocolo de sockets:
//   1. Ve el aviso de escritorio y entra con «Entrar de todos modos».
//   2. Acepta los Términos y Condiciones desde el modal obligatorio.
//   3. Abre «Girar con amigos» (ruleta), escribe su nombre y crea la mesa.
//   4. Apuesta 50 al rojo con los controles reales y lanza la ronda como anfitriona.
//   5. Ve el resultado de la ronda en la mesa (y puede saltar la animación).
//   6. Escribe un mensaje en el chat y lo ve publicado.
//   7. Vuelve al lobby y se encuentra en el ranking mensual.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const port = 6100 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-journey-${process.pid}.json`);
let server;
let dom;

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.log = '';
  server.stdout.on('data', chunk => { server.log += chunk; });
  server.stderr.on('data', chunk => { server.log += chunk; });
  await sleep(900);

  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    if (!/Not implemented/i.test(error.message)) pageErrors.push(error.message);
  });
  dom = await JSDOM.fromURL(`${url}/`, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  const doc = window.document;
  window.scrollTo = () => {};
  await sleep(1800); // la página conecta el socket y recibe el lobby

  // 1) Aviso de solo-escritorio: la visitante decide entrar de todos modos.
  const gateButton = doc.querySelector('.gate-bypass-btn');
  assert.ok(gateButton, 'Existe el botón «Entrar de todos modos»');
  gateButton.click();
  assert.ok(doc.documentElement.classList.contains('gate-bypass'), 'El bypass del aviso de escritorio quedó activo');

  // 2) Términos y Condiciones obligatorios: el modal aparece solo y se acepta con un clic.
  const tosModal = doc.getElementById('tos-modal');
  assert.ok(tosModal && !tosModal.classList.contains('hidden'), 'El modal de T&C aparece en la primera visita');
  click(doc, '#tos-accept');
  await until(() => tosModal.classList.contains('hidden') || tosModal.getAttribute('aria-hidden') === 'true', 'que se cierre el modal de T&C', 4000);

  // 3) Crea una mesa de ruleta desde la tarjeta del lobby.
  click(doc, '[data-open-mode="create"][data-game="roulette"]');
  const nameInput = await until(() => doc.getElementById('player-name'), 'el campo de nombre');
  nameInput.value = 'Viajera';
  doc.getElementById('room-name').value = 'Ruta E2E';
  doc.getElementById('join-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  // La mesa está lista cuando aparecen las casillas reales de apuesta.
  await until(() => doc.querySelector('[data-quick-choice="red"]'), 'los controles de apuesta de la ruleta', 12000);
  const roomCodeText = doc.body.textContent;
  assert.match(roomCodeText, /RUTA E2E/i, 'El nombre de la sala aparece en la cabecera');

  // 4) Apuesta 50 fichas al rojo, como lo haría con el mouse y el teclado.
  click(doc, '[data-quick-choice="red"]');
  const amount = doc.getElementById('quick-bet-amount');
  assert.ok(amount, 'Existe el campo de monto');
  amount.value = '50';
  click(doc, '[data-quick-bet]');
  await until(() => /Apuesta confirmada|EN JUEGO|◆ 50/i.test(doc.body.textContent), 'la confirmación de la apuesta', 8000);

  // Como anfitriona, lanza la ronda.
  const launch = await until(() => doc.querySelector('[data-event="quick_resolve"]'), 'el botón «Lanzar ronda»', 8000);
  launch.click();

  // 5) La animación puede saltarse (botón real de la mesa) y llega el resultado.
  await sleep(1600);
  doc.querySelector('[data-roulette-skip]')?.click();
  await until(() => doc.querySelector('.result-strip .result-item'), 'el resultado de la ronda', 25000);
  const resultText = doc.querySelector('.result-strip').textContent;
  assert.match(resultText, /Viajera/, 'El resultado menciona a la jugadora');

  // 6) Chatea desde el formulario real.
  const chatInput = doc.getElementById('chat-input');
  chatInput.value = '¡Qué ronda! ¿otra? <script>alert(1)</script>';
  doc.getElementById('chat-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /¡Qué ronda! ¿otra?/.test(doc.getElementById('chat-list').textContent), 'el mensaje publicado en el chat', 8000);
  assert.equal(doc.querySelector('#chat-list script'), null, 'El chat nunca inyecta HTML (sin XSS)');

  // 7) Vuelve al lobby y se ve en el ranking mensual.
  click(doc, '#leave-room');
  await until(() => {
    const panel = doc.getElementById('season-ranking');
    return panel && !panel.classList.contains('hidden') && /Viajera/.test(panel.textContent);
  }, 'aparecer en el ranking mensual del lobby', 12000);

  assert.deepEqual(pageErrors, [], `La consola del navegador quedó limpia: ${pageErrors.join(' | ')}`);
  console.log('✅ user-journey-smoke: aviso de escritorio, T&C, crear mesa, apostar, resultado, chat sin XSS y ranking del lobby OK');
}

main()
  .then(() => cleanup(0))
  .catch(error => {
    console.error('❌ user-journey-smoke:', error.message);
    if (server?.log) console.error(server.log.slice(-600));
    cleanup(1);
  });

function cleanup(code) {
  try { dom?.window?.close(); } catch (_) { /* noop */ }
  try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  if (server) { try { server.kill('SIGKILL'); } catch (_) { /* noop */ } }
  setTimeout(() => process.exit(code), 400);
}
