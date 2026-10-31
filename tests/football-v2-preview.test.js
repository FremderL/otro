'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { current } = require('../lib/football/v2/versions');

async function startPreview() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'preview/estadio-v2/server.js')], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`vista previa no inició: ${log}`)); }, 30000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`salió ${code}: ${log}`)); });
    child.stdout.on('data', chunk => {
      log += chunk;
      const match = /Vista Estadio V2 lista en el puerto (\d+)/.exec(log);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
  });
  return { child, port };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}

test('vista aislada ejecuta el Estadio real con V2 y entrega frames por websocket', { timeout: 45000 }, async t => {
  const { child, port } = await startPreview();
  t.after(() => stop(child));
  const base = `http://127.0.0.1:${port}`;
  const root = await fetch(base, { redirect: 'manual' });
  assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/estadio');
  const oldDemo = await fetch(`${base}/estadio-simulador`, { redirect: 'manual' });
  assert.equal(oldDemo.status, 302); assert.equal(oldDemo.headers.get('location'), '/estadio');
  const oldPage = await fetch(`${base}/estadio-simulador.html`, { redirect: 'manual' });
  assert.equal(oldPage.status, 302); assert.equal(oldPage.headers.get('location'), '/estadio');
  const page = await fetch(`${base}/estadio`), html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="est-pitch"/);
  assert.match(html, /__stadium_preview\.js/);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors \*/);
  const helper = await (await fetch(`${base}/__stadium_preview.js`)).text();
  assert.ok(helper.includes(current.VERSION));
  assert.match(helper, /Partidos, perfiles y fichas ficticios/);

  const lobby = await (await fetch(`${base}/api/estadio/state`)).json();
  assert.equal(lobby.lobby.seasonMonth, '2026-11');
  const match = lobby.lobby.matches.find(item => item.status === 'live');
  assert.ok(match, 'el partido ya debe estar en juego al abrir');
  assert.ok(Number.isInteger(match.minute), 'el minuto del lobby no muestra decimales');
  const publicState = await (await fetch(`${base}/api/estadio/matches/${match.id}`)).json();
  assert.equal(publicState.matchState.match.engine, 'v2');
  assert.ok(publicState.matchState.state.players.length >= 22);
  assert.ok(publicState.matchState.markets['1x2']);
  assert.doesNotMatch(JSON.stringify(publicState), /privateSeed|rootSeed|matchEnd/);

  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 5000 });
  t.after(() => socket.close());
  await once(socket, 'connect');
  const subscribe = payload => new Promise(resolve => socket.emit('football:subscribe', payload, resolve));
  const identity = { token: 'preview_test_12345678', name: 'Prueba V2', tos: lobby.tosVersion };
  assert.equal((await subscribe({ ...identity, scope: 'lobby' })).ok, true);
  const joined = await subscribe({ ...identity, scope: 'match', matchId: match.id });
  assert.equal(joined.ok, true); assert.equal(joined.matchState.match.engine, 'v2');
  const [tick] = await Promise.race([once(socket, 'football:tick'), new Promise((_, reject) =>
    setTimeout(() => reject(new Error('no llegó un tick del partido')), 6000).unref())]);
  assert.equal(tick.matchId, match.id);
  assert.ok(Array.isArray(tick.players) && tick.players.length >= 22);
});


test('la vista identifica el entorno ficticio y selecciona el vivo sin cambiar una elección manual', () => {
  const dom = new JSDOM('<!doctype html><head></head><body><nav class="estadio-nav"></nav>' +
    '<div id="est-connection" class="connected"></div><ul><li class="est-match-item live">Partido</li></ul></body>',
  { url: 'http://preview.test/estadio', runScripts: 'outside-only' });
  try {
    const { window } = dom, { document } = window;
    window.__stadiumPreviewTos = 'solo-demo'; window.__stadiumPreviewVersion = current.VERSION;
    let callback, cleared = false, clicks = 0;
    window.setInterval = fn => { callback = fn; return 1; };
    window.clearInterval = () => { cleared = true; };
    const live = document.querySelector('.est-match-item');
    live.addEventListener('click', () => { clicks++; live.classList.add('active'); });
    window.eval(fs.readFileSync(path.join(__dirname, '../preview/estadio-v2/client.js'), 'utf8'));
    if (!callback) document.dispatchEvent(new window.Event('DOMContentLoaded'));
    assert.equal(window.localStorage.getItem('montecristo-tos'), 'solo-demo');
    assert.match(document.getElementById('stadium-preview-notice').textContent, /ficticios.*sin conexión a producción/);
    callback(); callback();
    assert.equal(clicks, 1);
    assert.equal(cleared, true);
    assert.match(document.head.textContent, /est-col-center/);
  } finally { dom.window.close(); }
});
