'use strict';

// Regresión del cliente del Estadio: estados de juego, mercados y alineación visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.html'), 'utf8');
const STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.css'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.js'), 'utf8');

function team(id, name, short, primary, secondary) {
  return {
    id, name, short,
    colors: { primary, secondary, kit: 'solid' },
    formation: '4-4-2', style: 'balanced'
  };
}

function player(id, teamId, number, active = true) {
  return {
    id, team: teamId, name: `Jugador ${number}`, number,
    pos: number === 1 ? 'GK' : 'MF', role: number === 1 ? 'GK' : 'MF', slotIndex: number - 1,
    x: teamId === 'home' ? .22 : .78, y: .1 + number * .02,
    status: active ? 'active' : 'bench', active
  };
}

function market(key, price) { return { key, price, implied: 1 / price }; }

function createHarness(options = {}) {
  let nowMs = options.now == null ? Date.now() : options.now;
  let perfNow = 1000;
  const intervals = [];
  const teams = {
    home: team('home', 'Home FC', 'HOM', '#1de9b6', '#1f2a30'),
    away: team('away', 'Away FC', 'AWY', '#d32f2f', '#1a1a1a')
  };
  teams.home.style = 'possession';
  teams.away.style = 'pressing';
  const kickoffAt = options.kickoffAt == null
    ? nowMs + (options.kickoffOffsetMs == null ? 60000 : options.kickoffOffsetMs)
    : options.kickoffAt;
  const match = {
    id: 'ui-match', homeId: 'home', awayId: 'away', status: 'scheduled',
    scheduledKickoffAt: kickoffAt, jornada: 1, block: 'matutino'
  };
  const players = [
    ...Array.from({ length: 11 }, (_, i) => player(`h${i + 1}`, 'home', i + 1)),
    player('h12', 'home', 12, false),
    ...Array.from({ length: 11 }, (_, i) => player(`a${i + 1}`, 'away', i + 21))
  ];
  const matchState = {
    match,
    state: {
      minute: 0, displayMinute: 0, half: 1, phase: 'kickoff', score: { home: 0, away: 0 },
      possession: { home: .5, away: .5 }, possessionTeam: 'home', ballCarrierId: null,
      playStopped: true, ball: { x: .5, y: .5 }, players,
      formation: { home: '4-4-2', away: '4-4-2' },
      stats: { xG: { home: 0, away: 0 }, shots: { home: 0, away: 0 }, shotsOnTarget: { home: 0, away: 0 }, corners: { home: 0, away: 0 }, fouls: { home: 0, away: 0 } },
      cards: { home: [], away: [] }, redCards: { home: 0, away: 0 }
    },
    markets: {
      '1x2': [market('home', 2.1), market('draw', 3.2), market('away', 3.5)],
      double_chance: [market('home_draw', 1.3)]
    },
    myBets: [], commentary: []
  };
  const lobby = {
    matches: [match], standings: options.standings || [], nextKickoffAt: null, serverNow: nowMs
  };
  const handlers = {};
  const requests = [];
  let submittedPromotion = null;
  const socket = {
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      if (event !== 'football:subscribe') return;
      if (payload.scope === 'lobby') {
        ack({ ok: true, teams, profile: { chips: 1000 }, lobby });
      } else {
        ack({ ok: true, teams, profile: { chips: 1000 }, matchState });
      }
    }
  };
  let rafCallback = null;
  const drawnText = [];
  const canvasContext = new Proxy({}, {
    get(_target, key) {
      if (key === 'fillText') return value => drawnText.push(String(value));
      return () => {};
    },
    set() { return true; }
  });
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000/estadio',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.Date.now = () => nowMs;
  Object.defineProperty(window.performance, 'now', { configurable: true, value: () => perfNow });
  const mobileGateStyle = window.document.createElement('style');
  mobileGateStyle.textContent = 'body { overflow: hidden; }';
  window.document.head.appendChild(mobileGateStyle);
  const style = window.document.createElement('style');
  style.textContent = STYLES;
  window.document.head.appendChild(style);
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.HTMLCanvasElement.prototype.getContext = () => canvasContext;
  window.requestAnimationFrame = callback => { rafCallback = callback; return 1; };
  window.cancelAnimationFrame = () => {};
  window.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; };
  window.clearInterval = () => {};
  window.setTimeout = () => 1;
  window.clearTimeout = () => {};
  window.fetch = async (url, requestOptions = {}) => {
    const target = String(url);
    requests.push({ url: target, options: requestOptions });
    if (target.includes('/healthz')) {
      return { ok: true, json: async () => ({ football: { enabled: true }, promotionsEnabled: Boolean(options.promotionsEnabled) }) };
    }
    if (target === '/api/auth/session') {
      return {
        ok: true,
        json: async () => options.accountSession || { authenticated: false, account: null, csrfToken: null }
      };
    }
    if (requestOptions.method === 'POST' && target === '/api/estadio/promotions') {
      submittedPromotion = JSON.parse(requestOptions.body);
      return { ok: true, status: 201, json: async () => ({ ok: true, promotion: { status: 'pending' } }) };
    }
    if (target.endsWith('/mine')) {
      return { ok: true, json: async () => ({ promotion: null }) };
    }
    if (target.startsWith('/api/estadio/promotions/')) {
      return { ok: true, json: async () => ({ promotion: null }) };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, teams, tosVersion: '2026-09-28', lobby, profile: { chips: 1000 } })
    };
  };
  window.io = () => socket;
  window.eval(CLIENT);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  return {
    dom, window, socket, handlers, match, matchState, players, drawnText, requests,
    get submittedPromotion() { return submittedPromotion; },
    advanceTime(ms) {
      nowMs += ms;
      perfNow += ms;
      intervals.filter(interval => interval.delay === 1000 || (interval.delay === 15000 && ms >= interval.delay))
        .forEach(interval => interval.callback());
    },
    async connectToMatch() {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof handlers.connect, 'function', 'el cliente conectó el socket');
      handlers.connect();
      window.document.querySelector('#est-match-list li').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    },
    draw() {
      drawnText.length = 0;
      assert.equal(typeof rafCallback, 'function');
      rafCallback(window.performance.now() + 3000);
      return drawnText.slice();
    },
    close() { dom.window.close(); }
  };
}

test('La Previa abre exactamente en T−30, muestra datos de liga y se oculta al kickoff', async t => {
  const baseNow = 1800000000000;
  const standings = [
    { teamId: 'home', played: 5, won: 3, drawn: 1, lost: 1, goalsFor: 9, goalsAgainst: 4, goalDiff: 5, points: 10, form: ['W', 'D', 'W', 'L', 'W'] },
    { teamId: 'away', played: 5, won: 2, drawn: 2, lost: 1, goalsFor: 7, goalsAgainst: 10, points: 8, form: ['D', 'W', 'D', 'L', 'W'] }
  ];
  const h = createHarness({ now: baseNow, kickoffOffsetMs: 30 * 60 * 1000 + 1, standings });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');
  const promo = window.document.getElementById('est-preshow-promo');

  assert.equal(window.getComputedStyle(window.document.body).overflowY, 'auto', 'Estadio conserva el scroll vertical aunque la hoja global bloquee otras páginas pequeñas');
  assert.equal(panel.hidden, true, 'a T−30:01 todavía no aparece');
  h.advanceTime(1000);
  assert.equal(panel.hidden, false, 'aparece justo al entrar en los 30 minutos');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '30:00');
  assert.equal(promo.hidden, false, 'la promoción propia solo se muestra en la ventana activa');
  const comparison = window.document.getElementById('est-team-comparison').textContent;
  assert.match(comparison, /Home FC/);
  assert.match(comparison, /Away FC/);
  assert.match(comparison, /Posesión/);
  assert.match(comparison, /Presión alta/);
  assert.match(comparison, /Puntos/);
  assert.match(comparison, /9–4/);
  assert.match(comparison, /DG/);
  assert.ok(comparison.includes('+5'));
  assert.match(comparison, /-3/);
  assert.match(comparison, /Forma \(5\)/);

  h.advanceTime(30 * 60 * 1000);
  assert.equal(panel.hidden, false, 'si el estado sigue programado, conserva una espera neutral');
  assert.match(window.document.getElementById('est-preshow-status').textContent, /Kickoff pendiente/);
  assert.equal(promo.hidden, true, 'la promoción se corta al llegar la hora programada');
  handlers['football:status']({ matchId: match.id, code: 'kickoff', minute: 0 });
  assert.equal(panel.hidden, true, 'al confirmarse el kickoff desaparece la previa');
});

test('cuando no hay campañas aprobadas, el único espacio rota anuncios propios internos cada 15 segundos', async t => {
  const h = createHarness({ now: 1800000000000, kickoffOffsetMs: 20 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const slot = window.document.querySelectorAll('#est-preshow-promo');
  const label = window.document.getElementById('est-promo-label');
  const copy = window.document.getElementById('est-promo-text');
  const link = window.document.getElementById('est-promo-link');
  assert.equal(slot.length, 1, 'los anuncios propios comparten el espacio único de La Previa');
  assert.equal(label.textContent, 'Promoción de MonteCristo');
  const firstCopy = copy.textContent;
  assert.ok(firstCopy.length > 0);
  assert.ok(['/','/estadio'].includes(link.getAttribute('href')), 'el destino es una ruta interna permitida');

  h.advanceTime(15000);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(copy.textContent, firstCopy, 'el anuncio propio cambia al siguiente turno de 15 segundos');
  assert.ok(['/','/estadio'].includes(link.getAttribute('href')));
});

test('el formulario promocional requiere cuenta vinculada y envía solo texto y enlace durante T−30', async t => {
  const h = createHarness({
    promotionsEnabled: true,
    kickoffOffsetMs: 15 * 60 * 1000,
    accountSession: { ok: true, profile: { id: 'linked-profile', username: 'aficionado' }, csrfToken: 'csrf-test' }
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const composer = window.document.getElementById('est-promo-compose');
  const form = window.document.getElementById('est-promo-form');
  assert.equal(composer.hidden, false, 'el formulario solo aparece cuando el feature está activo y el partido está en T−30');
  assert.equal(form.hidden, false, 'una cuenta vinculada puede enviar');
  assert.match(window.document.getElementById('est-promo-auth').textContent, /@aficionado/);

  window.document.getElementById('est-promo-copy-input').value = 'Ven a jugar a MonteCristo';
  window.document.getElementById('est-promo-target').value = '/room';
  window.document.getElementById('est-promo-room-code').value = 'a1b2c';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(h.submittedPromotion, {
    matchId: 'ui-match', text: 'Ven a jugar a MonteCristo', targetPath: '/room/A1B2C'
  });
  assert.deepEqual(Object.keys(h.submittedPromotion).sort(), ['matchId', 'targetPath', 'text']);
  const request = h.requests.find(item => item.url === '/api/estadio/promotions' && item.options.method === 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['X-CSRF-Token'], 'csrf-test');
  assert.match(window.document.getElementById('est-promo-message').textContent, /pendiente de revisión.*No se han cobrado fichas/);
});

test('La Previa también se oculta si el partido se pospone', async t => {
  const h = createHarness({ kickoffOffsetMs: 5 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  assert.equal(h.window.document.getElementById('est-preshow').hidden, false);
  h.handlers['football:status']({ matchId: h.match.id, code: 'postponed' });
  assert.equal(h.window.document.getElementById('est-preshow').hidden, true);
});

test('la UI sigue el estado del motor: kickoff, pausas, gol, sustitución y final', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  const marketButtons = () => Array.from(window.document.querySelectorAll('#est-markets .est-sel'));
  const fireEvent = event => handlers['football:event']({ matchId: id, event });

  assert.equal(window.document.querySelectorAll('.est-market-group').length, 2, 'antes del kickoff hay mercados pre-partido');
  assert.equal(window.getComputedStyle(window.document.getElementById('est-bet-slip')).display, 'none', 'la boleta oculta no ocupa ni aparece visualmente al entrar');
  window.document.querySelectorAll('.est-market-group')[1].querySelector('.est-sel').click();
  assert.equal(window.document.getElementById('est-bet-slip').hidden, false);
  assert.equal(window.getComputedStyle(window.document.getElementById('est-bet-slip')).display, 'flex', 'la boleta se muestra al elegir una cuota');

  handlers['football:status']({ matchId: id, code: 'kickoff', minute: 0 });
  assert.equal(window.document.getElementById('est-bet-slip').hidden, true, 'cierra una boleta incompatible con el mercado en vivo');
  assert.equal(window.getComputedStyle(window.document.getElementById('est-bet-slip')).display, 'none', 'una regla visual respeta el atributo hidden aunque la boleta use flex');
  assert.equal(window.document.querySelectorAll('.est-market-group').length, 1, 'en vivo solo deja el mercado 1X2');
  assert.ok(marketButtons().every(button => button.disabled), 'sigue bloqueado hasta el saque inicial confirmado');

  fireEvent({ type: 'kickoff', team: 'home', minute: 0, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'h2', possessionTeam: 'home' });
  assert.ok(marketButtons().every(button => !button.disabled), 'el saque inicial reabre el mercado');
  marketButtons()[0].click();
  assert.equal(window.document.getElementById('est-bet-slip').hidden, false);

  fireEvent({ type: 'halftime', team: null, minute: 45, phase: 'halftime', playStopped: true,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: null });
  handlers['football:status']({ matchId: id, code: 'halftime', minute: 45 });
  assert.ok(marketButtons().every(button => button.disabled), 'descanso suspende las selecciones');
  assert.match(window.document.getElementById('est-markets').textContent, /Mercado suspendido/);

  fireEvent({ type: 'second_half', team: 'away', minute: 46, phase: 'build_up', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'a2', possessionTeam: 'away' });
  handlers['football:status']({ matchId: id, code: 'live', minute: 46 });
  assert.ok(marketButtons().every(button => !button.disabled), 'el segundo tiempo reabre el mercado');

  fireEvent({ type: 'goal', team: 'home', playerId: 'h10', playerName: 'Jugador 10', minute: 61,
    phase: 'goal_celebration', playStopped: true, marcador: '1-0',
    ball: { x: 1, y: .5 }, ballFrom: { x: .86, y: .5 }, actorPosition: { x: .86, y: .5 },
    ballCarrierId: null, possessionTeam: null });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Gol confirmado de Jugador 10: 1-0.' });
  assert.equal(window.document.getElementById('score-home').textContent, '1');
  assert.equal(window.document.getElementById('score-away').textContent, '0');
  assert.match(window.document.getElementById('est-commentary').textContent, /Gol confirmado de Jugador 10: 1-0/);
  assert.ok(marketButtons().every(button => button.disabled), 'el festejo detiene el mercado');

  fireEvent({ type: 'goal_restart', team: 'away', minute: 62, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: 1, y: .5 }, actorPosition: { x: .5, y: .5 },
    ballCarrierId: 'a2', possessionTeam: 'away' });
  assert.ok(marketButtons().every(button => !button.disabled), 'el saque desde el centro reanuda el mercado');

  fireEvent({ type: 'red_card', team: 'home', playerId: 'h2', minute: 70, phase: 'set_piece', playStopped: true,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: 'away' });
  fireEvent({ type: 'substitution', team: 'home', playerId: 'h12', playerInId: 'h12', playerOutId: 'h10',
    minute: 72, phase: 'set_piece', playStopped: true, ball: { x: .5, y: .5 },
    ballFrom: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: 'home' });
  const visibleNumbers = h.draw();
  assert.ok(visibleNumbers.includes('12'), 'el suplente aparece en la cancha');
  assert.ok(!visibleNumbers.includes('10'), 'el sustituido sale de la cancha');
  assert.ok(!visibleNumbers.includes('2'), 'el expulsado deja de aparecer');

  handlers['football:status']({ matchId: id, code: 'full_time', minute: 94 });
  assert.equal(window.document.getElementById('est-clock').textContent, 'Final');
  assert.ok(marketButtons().every(button => button.disabled), 'el final cierra el mercado');
});
