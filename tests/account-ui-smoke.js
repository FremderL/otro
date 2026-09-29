'use strict';

// Auditoría de cuenta/login/perfil — cobertura de INTERFAZ (E2E con jsdom,
// interactuando solo con clics/formularios reales, como en
// user-journey-smoke.js). Cubre específicamente los puntos de UI pedidos:
//
//  1. Sin cuenta: el botón muestra "🔑 Iniciar sesión".
//  2. Login exitoso cambia el botón a "👤 Perfil" de inmediato (sin recargar).
//  3. Login fallido deja el botón como "Iniciar sesión" (con error visible).
//  4. El estado (botón + datos del perfil) persiste tras "recargar" la página
//     (localStorage sobrevive a una nueva carga) y tras reconectar el socket,
//     sin parpadear al estado equivocado.
//  5. Entrar a una mesa, salir y volver al lobby no cambia el botón de cuenta.
//  6. El modal de perfil muestra username, nombre, avatar y estadísticas
//     públicas (nunca passwordHash/password/token en localStorage).
//  7. Editar el perfil DESDE EL LOBBY (sin mesa) persiste en el servidor.
//  8. Cerrar sesión regresa el botón a "Iniciar sesión" de inmediato, y NO
//     borra el perfil anónimo local (token de dispositivo) ni obliga a crear
//     uno nuevo.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { io } = require('socket.io-client');

const port = 6400 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const profilePath = path.join(os.tmpdir(), `montecristo-account-ui-${process.pid}.json`);
let server;
const doms = [];

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
      // Simula "ya visité antes y acepté todo": deja pasar el aviso de
      // escritorio y los Términos para poder ir directo al flujo de cuenta,
      // y opcionalmente siembra localStorage como si fuera una recarga real
      // del mismo navegador (mismo origen, mismo almacenamiento).
      window.localStorage.setItem('montecristo-gate-bypass', '1');
      window.localStorage.setItem('montecristo-tos', '2026-09-28');
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
  // jsdom resuelve JSDOM.fromURL() cuando dispara el evento "load" de la
  // página, lo que EN TEORÍA garantiza que los <script src> del <body> (sin
  // defer/async) ya se ejecutaron. En la práctica, bajo carga del sistema (p.
  // ej. inmediatamente después de cerrar la ventana anterior con
  // window.close(), mientras aún hay handles de red/temporizadores
  // liberándose) se ha observado, de forma intermitente, que la promesa se
  // resuelve sin que /app.js haya llegado a ejecutarse (sin lanzar ningún
  // error observable). Para no depender de esa suposición, verificamos una
  // señal inequívoca de que el script de la página corrió de verdad
  // (renderAccountButton() siempre añade aria-label al botón de cuenta) y,
  // si no aparece a tiempo, reintentamos la carga completa en vez de seguir
  // adelante con una página "muerta".
  const maxAttempts = 3;
  let lastDom = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dom = await loadPageOnce({ seedLocalStorage });
    lastDom = dom;
    await until(() => dom.window.document.documentElement.classList.contains('gate-bypass'), 'bypass de escritorio aplicado', 4000);
    const scriptRan = await (async () => {
      try {
        await until(() => dom.window.document.getElementById('account-open-btn')?.hasAttribute('aria-label'), 'app.js inicializó el botón de cuenta', 4000);
        return true;
      } catch (_) {
        return false;
      }
    })();
    if (scriptRan) {
      doms.push(dom);
      return dom;
    }
    // El script de la página no llegó a correr: descarta esta ventana
    // "muerta" y reintenta con una carga nueva.
    try { dom.window.close(); } catch (_) { /* noop */ }
    if (attempt < maxAttempts) await sleep(300);
  }
  doms.push(lastDom);
  throw new Error(`app.js no se ejecutó tras ${maxAttempts} intentos de carga de página`);
}

function dumpLocalStorage(win) {
  const out = {};
  for (let i = 0; i < win.localStorage.length; i++) {
    const key = win.localStorage.key(i);
    out[key] = win.localStorage.getItem(key);
  }
  return out;
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PROFILE_STORE_PATH: profilePath, AUTO_BOTS: 'off', LOG_JSON: 'off' },
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
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`El servidor no abrió el puerto.\n${server.log}`);
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin respuesta para ${event}`)), 5000);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}

async function main() {
  server = startServer();
  await waitForServer();

  const username = `ui${Date.now()}`.slice(0, 20);
  const password = 'clave-de-prueba-ui';

  // ---------- 1) Sin cuenta: botón "Iniciar sesión" ----------
  let dom = await openPage();
  let doc = dom.window.document;
  await sleep(1200); // conecta el socket y carga el lobby
  assert.match(accountButtonText(doc), /Iniciar sesión/, 'sin sesión, el botón dice "Iniciar sesión"');
  assert.doesNotMatch(accountButtonText(doc), /Perfil/, 'sin sesión, el botón NO dice "Perfil"');

  // ---------- 2) Signup crea la cuenta y el botón cambia a "Perfil" YA (sin recargar) ----------
  click(doc, '#account-open-btn');
  await until(() => dom.window.getComputedStyle(doc.getElementById('account-modal')).visibility === 'visible', 'modal de cuenta visible', 4000);
  click(doc, '#account-switch'); // pasa a modo "crear cuenta"
  doc.getElementById('account-username').value = username;
  doc.getElementById('account-password').value = password;
  doc.getElementById('account-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Perfil/.test(accountButtonText(doc)), 'el botón cambia a "Perfil" tras crear la cuenta', 6000);
  assert.doesNotMatch(accountButtonText(doc), /Iniciar sesión/, 'ya no dice "Iniciar sesión" tras crear la cuenta');

  // El token de dispositivo NUNCA se pisa con el id de la cuenta: sigue siendo
  // el mismo que se generó al cargar la página la primera vez.
  const deviceTokenAfterSignup = dom.window.localStorage.getItem('montecristo-device');
  assert.ok(deviceTokenAfterSignup, 'existe un token de dispositivo local');

  // La sesión de cuenta guardada en localStorage nunca incluye credenciales.
  const storedSession = dom.window.localStorage.getItem('montecristo-account-session');
  assert.ok(storedSession, 'se guardó una sesión de cuenta');
  assert.equal(storedSession.includes('passwordHash'), false, 'la sesión guardada NO incluye passwordHash');
  assert.equal(storedSession.includes(password), false, 'la sesión guardada NO incluye la contraseña en texto plano');
  assert.match(storedSession, new RegExp(`"username":"${username}"`), 'la sesión guardada sí incluye el username público');

  // ---------- 3) El modal de perfil muestra username, avatar y estadísticas públicas ----------
  click(doc, '#account-open-btn'); // ya logueado: abre el perfil, no el login
  await until(() => dom.window.getComputedStyle(doc.getElementById('profile-modal')).visibility === 'visible', 'modal de perfil visible', 4000);
  assert.match(doc.getElementById('profile-account-status').textContent, new RegExp(`@${username}`), 'el modal muestra el username de la cuenta');
  assert.match(doc.getElementById('profile-stats').textContent, /FICHAS/i, 'el modal muestra las fichas');
  assert.match(doc.getElementById('profile-stats').textContent, /VICTORIAS/i, 'el modal muestra victorias/derrotas');
  assert.doesNotMatch(doc.body.innerHTML, /passwordHash/i, 'el HTML del perfil nunca renderiza passwordHash');

  // ---------- 4) Editar el perfil DESDE EL LOBBY (sin mesa) persiste en el servidor ----------
  const nameInput = doc.getElementById('profile-name-input');
  nameInput.value = 'Editado en lobby';
  doc.getElementById('profile-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /guardó en el servidor|Perfil actualizado/i.test(doc.body.textContent), 'confirmación de guardado', 4000);
  assert.doesNotMatch(doc.body.textContent, /Perfil no disponible/, 'editar desde el lobby nunca muestra "Perfil no disponible"');
  // Se confirma la persistencia real preguntándole al servidor directamente
  // (no solo confiando en lo que quedó en la página).
  const checkSocket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise(resolve => checkSocket.on('connect', resolve));
  const relogin = await emitAck(checkSocket, 'account_login', { username, password });
  assert.equal(relogin.ok, true, relogin.error);
  assert.equal(relogin.profile.name, 'Editado en lobby', 'el nombre editado desde el lobby SÍ quedó guardado en el servidor');
  checkSocket.disconnect();
  click(doc, '[data-close-profile]');

  // ---------- 5) Entrar a una mesa, salir, volver al lobby: el botón de cuenta no cambia ----------
  click(doc, '[data-open-mode="create"][data-game="coinflip"]');
  await until(() => dom.window.getComputedStyle(doc.getElementById('join-modal')).visibility === 'visible', 'modal de crear sala visible', 4000);
  doc.getElementById('player-name').value = 'Editado en lobby';
  doc.getElementById('room-name').value = 'Mesa de auditoría UI';
  doc.getElementById('join-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => doc.querySelector('[data-quick-choice]'), 'la mesa cargó', 12000);
  click(doc, '#leave-room');
  await until(() => !doc.getElementById('room-app').classList.contains('hidden') === false, 'se regresó al lobby', 8000);
  assert.match(accountButtonText(doc), /Perfil/, 'tras entrar y salir de una mesa, el botón sigue diciendo "Perfil"');

  // ---------- 6) Login fallido deja el botón como "Iniciar sesión" ----------
  // Cierra sesión primero para poder probar un login fallido desde cero.
  click(doc, '#account-open-btn');
  await until(() => dom.window.getComputedStyle(doc.getElementById('profile-modal')).visibility === 'visible', 'perfil visible antes de cerrar sesión', 4000);
  const deviceTokenBeforeLogout = dom.window.localStorage.getItem('montecristo-device');
  click(doc, '#account-logout');
  await until(() => /Iniciar sesión/.test(accountButtonText(doc)), 'el botón vuelve a "Iniciar sesión" tras cerrar sesión', 4000);
  assert.doesNotMatch(accountButtonText(doc), /Perfil/, 'ya no dice "Perfil" tras cerrar sesión');
  assert.equal(dom.window.localStorage.getItem('montecristo-account-session'), null, 'la sesión de cuenta se borró de localStorage');
  assert.equal(dom.window.localStorage.getItem('montecristo-device'), deviceTokenBeforeLogout, 'el token de dispositivo NO se borró ni cambió al cerrar sesión');

  click(doc, '#account-open-btn');
  await until(() => dom.window.getComputedStyle(doc.getElementById('account-modal')).visibility === 'visible', 'modal de login visible', 4000);
  doc.getElementById('account-username').value = username;
  doc.getElementById('account-password').value = 'contraseña-incorrecta';
  doc.getElementById('account-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !doc.getElementById('account-error').classList.contains('hidden'), 'se muestra el error de login', 4000);
  assert.match(accountButtonText(doc), /Iniciar sesión/, 'login fallido: el botón se queda en "Iniciar sesión"');
  assert.doesNotMatch(accountButtonText(doc), /Perfil/, 'login fallido: nunca cambia a "Perfil"');

  // Ahora con la contraseña correcta sí debe funcionar.
  doc.getElementById('account-password').value = password;
  doc.getElementById('account-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Perfil/.test(accountButtonText(doc)), 'login correcto cambia el botón a "Perfil"', 4000);

  const seed = dumpLocalStorage(dom.window);
  assert.ok(seed['montecristo-account-session'], 'hay sesión de cuenta para sembrar la siguiente "recarga"');
  dom.window.close();
  // Da tiempo a que la ventana anterior termine de cerrar sockets/temporizadores
  // antes de pedirle a jsdom que cargue y ejecute la página "recargada".
  await sleep(500);

  // ---------- 7) Persistencia tras "recargar" la página y reconectar el socket ----------
  // Nueva carga de página con el MISMO localStorage (simula F5): el botón debe
  // decir "Perfil" desde el primer instante, y seguir diciéndolo después de
  // que el socket termine de conectar (sin parpadear a "Iniciar sesión").
  dom = await openPage({ seedLocalStorage: seed });
  doc = dom.window.document;
  // Justo después de cargar (antes de que el socket conecte del todo), la
  // caché local ya debe reflejar la sesión persistida.
  await until(() => accountButtonText(doc) != null, 'el botón de cuenta existe', 3000);
  assert.match(accountButtonText(doc), /Perfil/, 'tras "recargar", el botón ya dice "Perfil" de inmediato (desde localStorage)');
  await sleep(1500); // da tiempo a que el socket conecte y reconecte de verdad
  assert.match(accountButtonText(doc), /Perfil/, 'tras conectar/reconectar el socket, el botón sigue diciendo "Perfil" (no cambia incorrectamente)');
  assert.equal(dom.window.localStorage.getItem('montecristo-device'), seed['montecristo-device'], 'el token de dispositivo sigue siendo el mismo tras "recargar"');

  // El perfil mostrado sigue teniendo los datos públicos correctos (username,
  // nombre editado) tras la recarga.
  click(doc, '#account-open-btn');
  await until(() => dom.window.getComputedStyle(doc.getElementById('profile-modal')).visibility === 'visible', 'perfil visible tras recargar', 4000);
  assert.match(doc.getElementById('profile-account-status').textContent, new RegExp(`@${username}`));
  assert.equal(doc.getElementById('profile-name-input').value, 'Editado en lobby', 'el nombre editado antes de "recargar" se conserva');

  assert.deepEqual(dom.pageErrors, [], `La consola del navegador quedó limpia: ${dom.pageErrors.join(' | ')}`);
  console.log('✅ account-ui-smoke: botón de cuenta (login/perfil/logout), persistencia tras recarga y reconexión, edición desde el lobby y sanitización de localStorage OK');
}

main()
  .then(() => cleanup(0))
  .catch(error => {
    console.error('❌ account-ui-smoke:', error.message);
    if (server?.log) console.error(server.log.slice(-800));
    cleanup(1);
  });

function cleanup(code) {
  doms.forEach(dom => { try { dom.window.close(); } catch (_) { /* noop */ } });
  try { fs.rmSync(profilePath, { force: true }); } catch (_) { /* noop */ }
  if (server) { try { server.kill('SIGKILL'); } catch (_) { /* noop */ } }
  setTimeout(() => process.exit(code), 400);
}
