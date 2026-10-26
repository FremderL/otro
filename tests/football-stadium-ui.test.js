'use strict';

// Regresión del cliente del Estadio: estados de juego, mercados y alineación visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.html'), 'utf8');
const STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.css'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const ADMIN_CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
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
    myBets: options.myBets || [], commentary: []
  };
  const lobby = {
    matches: [match], standings: options.standings || [], nextKickoffAt: null, serverNow: nowMs
  };
  const handlers = {};
  const requests = [];
  let submittedPromotion = null;
  const activePromotions = Array.isArray(options.activePromotions)
    ? options.activePromotions
    : (options.activePromotion ? [options.activePromotion] : []);
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
  const ballTrace = [];
  const canvasContext = new Proxy({}, {
    get(_target, key) {
      if (key === 'fillText') return value => drawnText.push(String(value));
      // El balón se dibuja con radio BALL_R (6): se registra su posición para medir la trayectoria.
      if (key === 'arc') return (x, y, r) => { if (r === 6) ballTrace.push({ x, y }); };
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
  const reducedMotion = options.reducedMotion !== undefined ? Boolean(options.reducedMotion) : true;
  window.matchMedia = () => ({ matches: reducedMotion, addListener() {}, addEventListener() {} });
  window.HTMLCanvasElement.prototype.getContext = () => canvasContext;
  window.requestAnimationFrame = callback => { rafCallback = callback; return 1; };
  window.cancelAnimationFrame = () => {};
  window.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; };
  window.clearInterval = () => {};
  const timeouts = [];
  window.setTimeout = (callback, delay) => {
    const timer = { callback, at: perfNow + (delay || 0) };
    timeouts.push(timer);
    return timer;
  };
  window.clearTimeout = timer => {
    const idx = timeouts.indexOf(timer);
    if (idx >= 0) timeouts.splice(idx, 1);
  };
  window.fetch = async (url, requestOptions = {}) => {
    const target = String(url);
    requests.push({ url: target, options: requestOptions });
    if (target.startsWith('/assets/')) {
      return { ok: true, blob: async () => new window.Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/jpeg' }) };
    }
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
    if (target.startsWith('/api/estadio/my-bets')) {
      return { ok: true, json: async () => ({ ok: true, history: options.betHistory || null, profile: { id: 'alice', chips: 1000 } }) };
    }
    if (target.endsWith('/mine')) {
      return { ok: true, json: async () => ({ promotion: null }) };
    }
    if (target.startsWith('/api/estadio/promotions/')) {
      return {
        ok: true,
        json: async () => ({ ok: true, promotion: activePromotions[0] || null, promotions: activePromotions })
      };
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
    dom, window, socket, handlers, match, matchState, players, drawnText, requests, ballTrace,
    get submittedPromotion() { return submittedPromotion; },
    advanceTime(ms) {
      nowMs += ms;
      perfNow += ms;
      intervals.filter(interval => interval.delay === 1000 || (interval.delay === 15000 && ms >= interval.delay))
        .forEach(interval => interval.callback());
      const due = timeouts.filter(t => t.at <= perfNow);
      for (const t of due) {
        const idx = timeouts.indexOf(t);
        if (idx >= 0) timeouts.splice(idx, 1);
        t.callback();
      }
    },
    async connectToMatch() {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof handlers.connect, 'function', 'el cliente conectó el socket');
      handlers.connect();
      window.document.querySelector('#est-match-list li').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    },
    draw(offsetMs = 3000) {
      drawnText.length = 0;
      assert.equal(typeof rafCallback, 'function');
      rafCallback(window.performance.now() + offsetMs);
      return drawnText.slice();
    },
    close() { dom.window.close(); }
  };
}

test('las galerías de anuncios del Estadio y de administración solo apuntan a imágenes existentes', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const stadiumDom = new JSDOM(HTML);
  const adminDom = new JSDOM(ADMIN_HTML);
  [
    [stadiumDom.window.document, '.est-preset-btn'],
    [adminDom.window.document, '.admin-preset-btn']
  ].forEach(([document, selector]) => {
    document.querySelectorAll(selector).forEach(button => {
      const preset = button.getAttribute('data-preset');
      const thumbnail = button.querySelector('img')?.getAttribute('src');
      assert.ok(preset && thumbnail, 'cada preset tiene una ruta y una miniatura');
      assert.equal(thumbnail, preset, 'la miniatura coincide con la imagen que se previsualiza');
      assert.ok(fs.existsSync(path.join(publicDir, preset.replace(/^\//, ''))), `${preset} existe en public/`);
    });
  });
  stadiumDom.window.close();
  adminDom.window.close();
});

test('el editor administrativo enseña el fondo elegido y lo guarda en la campaña publicada', async t => {
  const dom = new JSDOM(ADMIN_HTML, {
    url: 'http://localhost:3000/admin',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const posts = [];
  window.crypto.randomUUID = () => 'idempotency-test';
  window.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('/assets/')) {
      return { ok: true, blob: async () => new window.Blob([Uint8Array.from([5, 6, 7, 8])], { type: 'image/jpeg' }) };
    }
    if (options.method === 'POST' && target === '/admin/estadio/promotions/create') {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 201, json: async () => ({ ok: true, promotion: {} }) };
    }
    const response = target === '/api/auth/session'
      ? { ok: true, csrfToken: 'csrf-test', auth: { staff: { id: 'admin', role: 'admin' }, mfaEnrollmentRequired: false, mfaVerified: true } }
      : target === '/api/admin/v1/me'
        ? { ok: true, staff: { name: 'Admin', username: 'admin', role: 'admin' } }
        : target === '/admin/estadio/matches'
          ? { ok: true, teams: {}, matches: [] }
          : target === '/admin/estadio/promotions'
            ? { ok: true, promotions: [], activePromotions: [] }
            : { ok: true, reports: [] };
    return { ok: true, status: 200, json: async () => response };
  };
  window.eval(ADMIN_CLIENT);
  await new Promise(resolve => setTimeout(resolve, 25));

  const selectedPreset = window.document.querySelector('.admin-preset-btn[data-preset="/assets/estadio-tunnel.jpg"]');
  selectedPreset.click();
  assert.equal(window.document.getElementById('admin-studio-preview-img').getAttribute('src'), '/assets/estadio-tunnel.jpg');
  window.document.getElementById('promo-create-profile').value = 'montecristo_oficial';
  window.document.getElementById('promo-create-text').value = 'Una campaña de prueba';
  window.document.getElementById('promo-create-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 35));

  assert.equal(posts.length, 1, 'se publicó la campaña');
  assert.equal(posts[0].text, 'Una campaña de prueba');
  assert.equal(posts[0].image, 'data:image/jpeg;base64,BQYHCA==', 'la creatividad elegida se adjunta para verla al publicar');
});

test('el borrado de campañas envía Idempotency-Key UUID aunque la solicitud POST no tenga cuerpo', async t => {
  const dom = new JSDOM(ADMIN_HTML, {
    url: 'http://localhost:3000/admin',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const key = '2a5f92d7-1fd4-4df0-a8c6-a7729347ea63';
  const deletionRequests = [];
  let activePromotions = [{
    id: 'promo-active-1', profileId: 'profile-1', username: 'patrocinador',
    isPermanent: true, scope: 'all', createdAt: Date.now(), reviewedAt: Date.now(),
    text: 'Campaña de prueba', targetPath: '/estadio'
  }];
  window.crypto.randomUUID = () => key;
  window.confirm = () => true;
  window.fetch = async (url, options = {}) => {
    const target = String(url);
    if (options.method === 'POST' && target.endsWith('/delete')) {
      deletionRequests.push({ url: target, ...options });
      activePromotions = [];
      return { ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) };
    }
    const response = target === '/api/auth/session'
      ? { ok: true, csrfToken: 'csrf-test', auth: { staff: { id: 'admin', role: 'admin' }, mfaEnrollmentRequired: false, mfaVerified: true } }
      : target === '/api/admin/v1/me'
        ? { ok: true, staff: { name: 'Admin', username: 'admin', role: 'admin' } }
        : target === '/admin/estadio/matches'
          ? { ok: true, teams: {}, matches: [] }
          : target === '/admin/estadio/promotions'
            ? { ok: true, promotions: [], activePromotions }
            : { ok: true, reports: [] };
    return { ok: true, status: 200, json: async () => response };
  };
  window.eval(ADMIN_CLIENT);
  await new Promise(resolve => setTimeout(resolve, 35));

  const deleteButton = window.document.querySelector('[data-promotion-delete]');
  assert.ok(deleteButton, 'la campaña activa aparece con su acción para eliminar');
  deleteButton.click();
  await new Promise(resolve => setTimeout(resolve, 45));

  assert.equal(deletionRequests.length, 1);
  assert.equal(deletionRequests[0].url, '/admin/estadio/promotions/profile-1/promo-active-1/delete');
  assert.equal(deletionRequests[0].method, 'POST');
  assert.equal(deletionRequests[0].body, undefined, 'el endpoint no requiere cuerpo');
  assert.equal(deletionRequests[0].headers['Idempotency-Key'], key, 'toda escritura administrativa envía una clave UUID');
  assert.equal(deletionRequests[0].headers['X-CSRF-Token'], 'csrf-test');
});

test('La Previa abre exactamente en T−30, muestra datos de liga y se oculta al kickoff', async t => {
  const baseNow = 1800000000000;
  const standings = [
    { teamId: 'home', played: 5, won: 3, drawn: 1, lost: 1, goalsFor: 9, goalsAgainst: 4, goalDiff: 5, points: 10, form: ['W', 'D', 'W', 'L', 'W'] },
    { teamId: 'away', played: 5, won: 2, drawn: 2, lost: 1, goalsFor: 7, goalsAgainst: 10, points: 8, form: ['D', 'W', 'D', 'L', 'W'] }
  ];
  const h = createHarness({ now: baseNow, kickoffOffsetMs: 30 * 60 * 1000 + 1, standings, reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');

  assert.equal(window.getComputedStyle(window.document.body).overflowY, 'auto', 'Estadio conserva el scroll vertical aunque la hoja global bloquee otras páginas pequeñas');
  assert.equal(panel.hidden, true, 'a T−30:01 todavía no aparece');
  h.advanceTime(1000);
  assert.equal(panel.hidden, false, 'aparece justo al entrar en los 30 minutos');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '30:00');
  assert.equal(window.document.getElementById('est-preshow-promo').hidden, false, 'la promoción propia solo se muestra en la ventana activa');
  const comparison = window.document.getElementById('est-showcase').textContent;
  assert.match(window.document.getElementById('est-compare-home').textContent, /Home FC/);
  assert.match(window.document.getElementById('est-compare-away').textContent, /Away FC/);
  assert.match(comparison, /Posesión/);
  assert.match(comparison, /Presión alta/);
  assert.match(comparison, /Puntos/);
  assert.match(comparison, /9–4/);
  assert.match(comparison, /DG/);
  assert.ok(comparison.includes('+5'));
  assert.match(comparison, /-3/);
  assert.match(comparison, /Forma \(5\)/);
  const showcase = window.document.getElementById('est-showcase');
  const showcaseTrack = window.document.getElementById('est-showcase-track');
  assert.equal(showcaseTrack.querySelectorAll('.est-showcase-promo').length, 4, 'cada anuncio propio tiene su propia ficha');
  assert.equal(showcaseTrack.querySelectorAll('.est-showcase-stat').length, 1, 'todos los indicadores caben juntos en una sola ficha');
  const indicatorCard = showcaseTrack.querySelector('.est-showcase-stat');
  assert.equal(indicatorCard.dataset.indicatorCount, '8', 'la ficha conjunta contiene los ocho datos');
  assert.equal(indicatorCard.querySelectorAll('.est-indicator-row').length, 8, 'ningún indicador se pierde del cuadro');
  assert.equal(showcaseTrack.children.length, 5, 'la cartelera tiene una ficha de datos más todos sus anuncios');
  assert.equal(window.document.getElementById('est-showcase-count').textContent, '1 / 5');
  assert.equal(showcase.dataset.slideType, 'indicator', 'la ficha inicial muestra la comparativa completa');
  const initialShowcasePosition = showcaseTrack.style.transform;
  h.advanceTime(15000);
  assert.equal(showcase.dataset.index, '1', 'el carrusel avanza una ficha a la vez');
  assert.equal(showcase.dataset.slideType, 'promotion', 'después de los datos aparece un anuncio individual');
  assert.equal(window.document.getElementById('est-showcase-count').textContent, '2 / 5');
  assert.notEqual(showcaseTrack.style.transform, initialShowcasePosition, 'cada ficha ocupa la misma ventana y el carrusel se desplaza');
  window.document.querySelector('#est-showcase-dots [data-showcase-index="0"]').click();
  assert.equal(showcase.dataset.index, '0', 'se puede volver a elegir la comparativa completa desde los puntos');

  h.advanceTime(30 * 60 * 1000);
  assert.equal(panel.hidden, false, 'si el estado sigue programado, conserva una espera neutral');
  assert.match(window.document.getElementById('est-preshow-status').textContent, /Kickoff pendiente/);
  assert.equal(window.document.getElementById('est-preshow-promo').hidden, true, 'la promoción se corta al llegar la hora programada');
  handlers['football:status']({ matchId: match.id, code: 'kickoff', minute: 0 });
  assert.equal(panel.hidden, true, 'al confirmarse el kickoff desaparece la previa');
});

test('los indicadores permanecen juntos y cada anuncio ocupa su propia ficha a pantalla completa', async t => {
  const h = createHarness({ now: 1800000000000, kickoffOffsetMs: 20 * 60 * 1000, reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const showcase = window.document.getElementById('est-showcase');
  const track = window.document.getElementById('est-showcase-track');
  assert.equal(track.querySelectorAll('.est-showcase-promo').length, 4);
  assert.equal(track.querySelectorAll('.est-showcase-stat').length, 1);
  assert.equal(track.querySelectorAll('.est-indicator-row').length, 8);
  assert.equal(track.children[0].dataset.showcaseKey, 'indicators');
  assert.equal(track.children[1].dataset.showcaseKey, 'house-0');
  assert.equal(track.children[2].dataset.showcaseKey, 'house-1');

  h.advanceTime(15000);
  assert.equal(showcase.dataset.index, '1');
  assert.equal(showcase.dataset.slideType, 'promotion');
  assert.equal(track.children[1].getAttribute('aria-hidden'), 'false', 'el anuncio activo es accesible y visible');
  assert.equal(track.children[0].getAttribute('aria-hidden'), 'true', 'las otras fichas quedan fuera de lectura');

  h.advanceTime(15000);
  assert.equal(showcase.dataset.index, '2');
  assert.equal(showcase.dataset.slideType, 'promotion');
  assert.match(track.children[2].textContent, /bots del servidor/);
});

test('el formulario promocional requiere cuenta vinculada y publica el texto, enlace e imagen del preset durante T−30', async t => {
  const h = createHarness({
    promotionsEnabled: true,
    kickoffOffsetMs: 15 * 60 * 1000,
    accountSession: { ok: true, profile: { id: 'linked-profile', username: 'aficionado', role: 'sponsor' }, csrfToken: 'csrf-test' }
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
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.deepEqual(h.submittedPromotion, {
    matchId: 'ui-match', text: 'Ven a jugar a MonteCristo', targetPath: '/room/A1B2C',
    image: 'data:image/jpeg;base64,AQIDBA=='
  });
  assert.deepEqual(Object.keys(h.submittedPromotion).sort(), ['image', 'matchId', 'targetPath', 'text']);
  const request = h.requests.find(item => item.url === '/api/estadio/promotions' && item.options.method === 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['X-CSRF-Token'], 'csrf-test');
  assert.match(window.document.getElementById('est-promo-message').textContent, /pendiente de revisión.*No se han cobrado fichas/);
});

test('un anuncio aprobado también ocupa una ficha completa y conserva su enlace y formato', async t => {
  const h = createHarness({
    promotionsEnabled: true,
    kickoffOffsetMs: 20 * 60 * 1000,
    activePromotion: {
      id: 'sponsor-123', label: 'Patrocinador oficial', text: 'Una promoción destacada',
      textPosition: 'middle', textSize: 'large', textAlign: 'center', ctaText: 'Conocer más',
      href: '/estadio', image: '/api/estadio/promotion-media/sponsor-123', isPermanent: true
    }
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const track = window.document.getElementById('est-showcase-track');
  const sponsorSlide = track.querySelector('[data-showcase-key="sponsor-sponsor-123"]');
  assert.ok(sponsorSlide, 'el anuncio aprobado se agrega como una ficha aparte');
  assert.equal(sponsorSlide.classList.contains('est-showcase-promo'), true);
  assert.equal(sponsorSlide.getAttribute('aria-hidden'), 'false', 'el nuevo anuncio entra al carrusel como contenido visible');
  assert.equal(sponsorSlide.dataset.textPosition, 'middle');
  assert.equal(sponsorSlide.dataset.textSize, 'large');
  assert.equal(sponsorSlide.dataset.textAlign, 'center');
  assert.equal(sponsorSlide.querySelector('a').getAttribute('href'), '/estadio');
  assert.equal(track.querySelectorAll('.est-showcase-promo').length, 5, 'no reemplaza ni oculta las promociones propias');
});

test('la cartelera crea una ficha para cada anuncio aprobado sin un cupo visual fijo', async t => {
  const activePromotions = Array.from({ length: 7 }, (_, index) => ({
    id: 'user-ad-' + (index + 1),
    label: 'Anuncio de aficionado ' + (index + 1),
    text: 'Promoción enviada por una persona ' + (index + 1),
    textPosition: 'bottom', textSize: 'medium', textAlign: 'left',
    ctaText: 'Ver más', href: '/estadio', image: '/api/estadio/promotion-media/user-ad-' + (index + 1)
  }));
  const h = createHarness({
    promotionsEnabled: true,
    kickoffOffsetMs: 20 * 60 * 1000,
    activePromotions
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const track = window.document.getElementById('est-showcase-track');
  const showcase = window.document.getElementById('est-showcase');
  assert.equal(track.querySelectorAll('.est-showcase-stat').length, 1, 'los ocho indicadores se agrupan en una ficha');
  assert.equal(track.querySelectorAll('.est-showcase-promo.is-sponsored').length, 7, 'se muestran todos los anuncios recibidos');
  assert.equal(track.querySelectorAll('.est-showcase-promo').length, 11, 'los anuncios de personas se suman a los cuatro propios');
  assert.equal(track.children.length, 12, 'el carrusel crece con cada anuncio, sin slots prefijados');
  activePromotions.forEach(promotion => {
    assert.ok(track.querySelector('[data-showcase-key="sponsor-' + promotion.id + '"]'), 'se creó la ficha ' + promotion.id);
  });
  assert.equal(window.document.querySelectorAll('#est-showcase-dots [data-showcase-index]').length, 12, 'hay navegación para cada ficha aunque exceda el diseño inicial');
  window.document.querySelector('#est-showcase-dots [data-showcase-index="7"]').click();
  assert.equal(showcase.dataset.slideType, 'promotion');
  assert.equal(track.children[7].getAttribute('aria-hidden'), 'false', 'también se puede abrir un anuncio añadido más tarde en la lista');
  assert.match(track.children[7].textContent, /Anuncio de aficionado/);
});

test('Mis apuestas mantiene tarjetas y jerarquía visual propias', async t => {
  const h = createHarness({ myBets: [{
    id: 'bet-1', market: '1x2', selection: 'home', odds: 2.1, stake: 100,
    potentialPayout: 210, status: 'open', inPlay: false
  }] });
  t.after(h.close);
  await h.connectToMatch();

  const { window } = h;
  const panel = window.document.getElementById('est-mybets-panel');
  const list = window.document.getElementById('est-mybets');
  const card = list.querySelector('.est-mybet');
  assert.ok(card, 'la apuesta abierta se presenta como tarjeta');
  assert.equal(window.getComputedStyle(list).display, 'flex');
  assert.equal(window.getComputedStyle(card).display, 'grid');
  assert.equal(window.getComputedStyle(card).borderRadius, '10px');
  assert.equal(window.getComputedStyle(card.querySelector('.est-mybet-pick')).fontWeight, '800');
  assert.notEqual(window.getComputedStyle(panel).borderTopColor, '');
});

test('el historial y los pagos viven en una vista propia, no en las columnas del Estadio', async t => {
  const settledEntry = {
    kind: 'bet', id: 'bet-old', matchId: 'ui-match', market: '1x2', selection: 'home',
    stake: 100, odds: 2.4, potentialPayout: 240, status: 'won', payout: 240,
    inPlay: false, minuteAtPlacement: null, placedAt: 1000, settledAt: 2000,
    match: { id: 'ui-match', homeId: 'home', awayId: 'away', jornada: 1, status: 'settled', result: { home: 2, away: 0 } }
  };
  const h = createHarness({
    betHistory: {
      entries: [settledEntry],
      summary: {
        total: 1, open: 0, byStatus: { won: 1 }, staked: 100, returned: 240, net: 140,
        openStake: 0, openPotentialPayout: 0, latestSettlementAt: 2000
      },
      unseen: { count: 1, credited: 240, staked: 100, net: 140, throughAt: 2000, items: [settledEntry] },
      totalEntries: 1
    }
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const document = window.document;
  const ledger = document.getElementById('est-ledger');
  const panel = document.getElementById('est-mybets-panel');

  // La vista vive FUERA de las columnas del Estadio y nace cerrada.
  assert.ok(ledger, 'existe la vista propia del historial');
  assert.equal(ledger.hidden, true, 'nace cerrada');
  assert.equal(ledger.closest('.estadio-shell'), null, 'no ocupa espacio dentro del Estadio');
  assert.equal(ledger.getAttribute('role'), 'dialog');

  // El panel de la columna queda compacto: solo abiertas + un acceso al historial.
  assert.equal(panel.querySelector('#est-mybets'), panel.querySelector('#est-mybets'), 'las abiertas siguen en su panel');
  assert.equal(panel.querySelectorAll('[role="tab"]').length, 0, 'sin pestañas apretadas dentro de la columna');
  assert.equal(panel.querySelectorAll('.est-bets-summary, #est-bet-history').length, 0, 'el resumen y la lista no se meten en la columna');
  const link = panel.querySelector('#est-ledger-open');
  assert.ok(link, 'el panel tiene una puerta al historial');
  assert.equal(link.getAttribute('aria-controls'), 'est-ledger');

  // El nav muestra el aviso de pagos pendientes de ver.
  const navButton = document.getElementById('est-ledger-open-nav');
  const navBadge = document.getElementById('est-nav-badge');
  assert.ok(navButton, 'acceso desde el nav');
  assert.equal(navBadge.hidden, false, 'la insignia señala pagos nuevos');
  assert.equal(navBadge.textContent, '1');
  assert.match(link.textContent, /1 pago nuevo/);

  // Abrir desde el panel: la vista toma la pantalla y queda enlazada en la URL.
  link.click();
  assert.equal(ledger.hidden, false, 'se abre la vista propia');
  assert.equal(window.location.hash, '#apuestas');
  assert.equal(window.getComputedStyle(ledger).position, 'fixed', 'ocupa la pantalla completa');

  const notice = document.getElementById('est-ledger-unseen');
  assert.equal(notice.hidden, false, 'avisa de los pagos acreditados mientras no estaba');
  assert.match(notice.textContent, /Se liquidaron 1 apuesta/);
  assert.match(notice.textContent, /240/);

  const card = document.querySelector('#est-ledger-list .est-ledger-row');
  assert.ok(card, 'la apuesta liquidada aparece en el historial');
  assert.equal(card.dataset.status, 'won');
  assert.match(card.textContent, /Ganada/);
  assert.match(card.textContent, /\+240/);
  assert.match(card.textContent, /Home FC/);
  assert.match(card.textContent, /2–0/);
  assert.match(card.textContent, /pagado/i);
  assert.match(document.querySelector('.est-ledger-day').textContent, /apuesta/, 'agrupa por día');

  const stats = document.getElementById('est-ledger-stats').textContent;
  ['Apostado', 'Cobrado', 'Neto', 'En juego'].forEach(label => {
    assert.match(stats, new RegExp(label), 'el resumen incluye ' + label);
  });
  assert.match(stats, /140/, 'neto de la apuesta ganadora');

  // Filtros por estado: uno sin resultados muestra un estado vacío claro.
  const lostChip = document.querySelector('[data-ledger-filter="lost"]');
  lostChip.click();
  assert.equal(lostChip.getAttribute('aria-pressed'), 'true');
  assert.match(document.querySelector('#est-ledger-list .est-ledger-state').textContent, /Perdidas: nada por aquí/);
  document.querySelector('[data-ledger-filter="all"]').click();
  assert.ok(document.querySelector('#est-ledger-list .est-ledger-row'), 'al volver a Todas reaparece la apuesta');

  // El foco queda dentro del diálogo: Tab desde el contenedor va al primer control.
  assert.equal(document.activeElement, ledger, 'al abrir, el foco entra en la vista');
  ledger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(document.activeElement.id, 'est-ledger-refresh', 'Tab no escapa a la página de atrás');

  // Esc cierra y limpia el hash, devolviendo el foco al disparador.
  h.handlers.keydown = null;
  const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  document.dispatchEvent(escape);
  assert.equal(ledger.hidden, true, 'Esc cierra la vista');
  assert.notEqual(window.location.hash, '#apuestas');
  assert.ok(document.activeElement === link || document.activeElement === document.body, 'el foco vuelve al disparador');
});

test('la vista del historial se abre también desde el nav y con /estadio#apuestas', async t => {
  const h = createHarness({ betHistory: { entries: [], summary: { total: 0, open: 0, byStatus: {}, staked: 0, returned: 0, net: 0, openStake: 0, openPotentialPayout: 0, latestSettlementAt: null }, unseen: null, totalEntries: 0 } });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  const { window } = h;
  const document = window.document;
  const ledger = document.getElementById('est-ledger');

  document.getElementById('est-ledger-open-nav').click();
  assert.equal(ledger.hidden, false, 'el nav abre la vista');
  document.getElementById('est-ledger-close').click();
  assert.equal(ledger.hidden, true, 'la ✕ la cierra');

  document.getElementById('est-ledger-back').click();
  assert.equal(ledger.hidden, true, 'el botón de volver también cierra');

  // Estado vacío explícito, con salida hacia las cuotas.
  document.getElementById('est-ledger-open-nav').click();
  const empty = document.querySelector('#est-ledger-list .est-ledger-state');
  assert.ok(empty, 'sin apuestas se explica qué hacer');
  assert.match(empty.textContent, /Todavía no tienes apuestas/);
  assert.ok(empty.querySelector('[data-ledger-go-markets]'), 'ofrece ir a las cuotas');
});

test('La Previa también se oculta si el partido se pospone', async t => {
  const h = createHarness({ kickoffOffsetMs: 5 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  assert.equal(h.window.document.getElementById('est-preshow').hidden, false);
  h.handlers['football:status']({ matchId: h.match.id, code: 'postponed' });
  assert.equal(h.window.document.getElementById('est-preshow').hidden, true);
});

test('La Previa se oculta de inmediato al reprogramar fuera de T−30, no aparece al horario anterior y abre en el nuevo T−30', async t => {
  const baseNow = 1800000000000;
  // Comienza a 15 min del kickoff (dentro de T-30)
  const h = createHarness({ now: baseNow, kickoffOffsetMs: 15 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');
  const promo = window.document.getElementById('est-preshow-promo');

  assert.equal(panel.hidden, false, 'inicia visible en T-15');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '15:00');
  assert.equal(promo.hidden, false);

  // Reprogramar el partido a 90 minutos en el futuro (fuera de T-30)
  const newKickoff = baseNow + 90 * 60 * 1000;
  handlers['football:rescheduled']({ matchId: match.id, scheduledKickoffAt: newKickoff });

  assert.equal(panel.hidden, true, 'se oculta de inmediato tras la reprogramación');
  assert.equal(panel.hasAttribute('data-delay'), false, 'no conserva bandera de retraso');

  // Avanza el tiempo al horario que tenía el partido originalmente (T+15m)
  h.advanceTime(15 * 60 * 1000);
  assert.equal(panel.hidden, true, 'no se muestra la previa en el horario anterior');
  assert.notEqual(window.document.getElementById('est-preshow-status').textContent, 'Kickoff pendiente · esperando señal del partido');

  // Avanza hasta T-30 del nuevo horario (faltan 45 min más para llegar a 60 min, que es 30 min antes de 90 min)
  h.advanceTime(45 * 60 * 1000);
  assert.equal(panel.hidden, false, 'abre exactamente en el nuevo T−30');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '30:00');
  assert.equal(promo.hidden, false, 'la promoción vuelve a estar activa');
});

test('La Previa se abre de inmediato si un partido distante se reprograma dentro de T−30', async t => {
  const baseNow = 1800000000000;
  // Kickoff en 90 minutos (fuera de T-30)
  const h = createHarness({ now: baseNow, kickoffOffsetMs: 90 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');

  assert.equal(panel.hidden, true, 'fuera de T-30 permanece oculta');

  // Reprogramar a 20 minutos
  const newKickoff = baseNow + 20 * 60 * 1000;
  handlers['football:rescheduled']({ matchId: match.id, scheduledKickoffAt: newKickoff });

  assert.equal(panel.hidden, false, 'se muestra inmediatamente al entrar a T-30 por reprogramación');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '20:00');
  assert.equal(window.document.getElementById('est-preshow-promo').hidden, false);
});

test('un partido en retraso con espera pendiente se recupera a cuenta regresiva al reprogramarse', async t => {
  const baseNow = 1800000000000;
  // Kickoff hace 5 minutos (retrasado)
  const h = createHarness({ now: baseNow, kickoffOffsetMs: -5 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');
  const promo = window.document.getElementById('est-preshow-promo');

  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.delay, 'true');
  assert.match(window.document.getElementById('est-preshow-status').textContent, /Kickoff pendiente/);
  assert.equal(promo.hidden, true, 'en retraso no muestra promoción');

  // Reprogramar a 15 minutos en el futuro
  const newKickoff = baseNow + 15 * 60 * 1000;
  handlers['football:status']({ matchId: match.id, code: 'rescheduled', scheduledKickoffAt: newKickoff });

  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.delay, 'false', 'cancela estado de demora');
  assert.match(window.document.getElementById('est-preshow-status').textContent, /Kickoff programado/);
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '15:00');
  assert.equal(promo.hidden, false, 'reactiva promoción');
});

test('secuencia de eventos: el balón recorre los destinos con animación fluida y sin saltos bruscos', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { handlers, match, ballTrace } = h;
  const id = match.id;
  handlers['football:status']({ matchId: id, code: 'live', minute: 0 });
  const targets = [.2, .4, .6, .8, .9];
  const norm = px => (px - 18) / (1050 - 36);
  const samples = [];
  let lastX = norm(.5 * 1050 + 18);

  targets.forEach((x, i) => {
    handlers['football:event']({
      matchId: id,
      event: {
        type: 'pass_sequence', team: 'home', minute: 10 + i, phase: 'build_up', playStopped: false,
        ball: { x, y: .5 }, ballFrom: { x: i ? targets[i - 1] : .5, y: .5 }, actorPosition: { x: x - .05, y: .5 },
        playerId: 'h2', receiverId: 'h10', ballCarrierId: null, possessionTeam: 'home'
      }
    });
    for (let ms = 0; ms < 500; ms += 50) {
      ballTrace.length = 0;
      h.draw(0);
      if (ballTrace.length) lastX = norm(ballTrace[ballTrace.length - 1].x);
      samples.push({ x: lastX });
      h.advanceTime(50);
    }
  });

  // El balón avanza progresivamente hacia el destino final (.9)
  assert.ok(samples[samples.length - 1].x >= 0.85, 'al final de la secuencia el balón llega al destino');
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
  const selections = window.document.querySelector('.est-market-group .est-selections');
  assert.equal(window.getComputedStyle(selections).display, 'grid', 'las cuotas se distribuyen en una rejilla que ocupa todo el ancho del panel');
  assert.equal(window.getComputedStyle(selections.querySelector('.est-sel')).width, '100%', 'cada cuota llena su celda');
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
    ball: { x: 1.01, y: .5 }, ballFrom: { x: .86, y: .5 }, actorPosition: { x: .86, y: .5 },
    ballCarrierId: null, possessionTeam: null });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Gol confirmado de Jugador 10: 1-0.' });
  assert.equal(window.document.getElementById('score-home').textContent, '1');
  assert.equal(window.document.getElementById('score-away').textContent, '0');
  assert.match(window.document.getElementById('est-commentary').textContent, /Gol confirmado de Jugador 10: 1-0/);
  assert.ok(marketButtons().every(button => button.disabled), 'el festejo detiene el mercado');

  fireEvent({ type: 'goal_restart', team: 'away', minute: 62, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: 1.01, y: .5 }, actorPosition: { x: .5, y: .5 },
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

test('el relato del gol espera a que termine la animación del balón', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  handlers['football:status']({ matchId: id, code: 'live', minute: 20 });
  handlers['football:event']({
    matchId: id,
    event: {
      type: 'goal', team: 'home', playerId: 'h10', playerName: 'Jugador 10', minute: 21,
      phase: 'goal_celebration', playStopped: true, marcador: '1-0',
      ball: { x: 1.01, y: .5 }, ballFrom: { x: .86, y: .5 }, actorPosition: { x: .86, y: .5 },
      ballCarrierId: null, possessionTeam: null
    }
  });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Gol confirmado de Jugador 10: 1-0.' });
  assert.ok(!window.document.getElementById('est-commentary').textContent.includes('Gol confirmado'), 'el relato espera mientras la animación está en curso');
  // Los jugadores parten de su posición base: el paso del gol puede durar hasta 6 s (tope).
  h.advanceTime(9500);
  assert.match(window.document.getElementById('est-commentary').textContent, /Gol confirmado de Jugador 10: 1-0/, 'el relato aparece al completarse la animación');
});

test('14 escenarios — validación integral de visualización, física y UI del estadio', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  const fireEvent = event => handlers['football:event']({ matchId: id, event });

  // 1. Kickoff inicial: jugadores en sus mitades
  handlers['football:status']({ matchId: id, code: 'live', minute: 0 });
  fireEvent({
    type: 'kickoff', team: 'home', minute: 0, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'h2', possessionTeam: 'home',
    playerId: 'h2', actorPosition: { x: .485, y: .5 }
  });
  h.advanceTime(100);
  let numbers = h.draw();
  assert.ok(numbers.length >= 22, 'todos los jugadores en cancha');

  // 2. Pase, recepción y conducción de balón
  fireEvent({
    type: 'pass_sequence', team: 'home', minute: 5, phase: 'build_up', playStopped: false,
    ball: { x: .65, y: .45 }, ballFrom: { x: .485, y: .5 }, actorPosition: { x: .485, y: .5 },
    playerId: 'h2', receiverId: 'h10', ballCarrierId: 'h10', possessionTeam: 'home'
  });
  h.advanceTime(1000);
  h.draw();

  // 3. Disparo y llegada a meta
  fireEvent({
    type: 'shot', team: 'home', minute: 15, phase: 'attack', playStopped: false,
    ball: { x: 1.0, y: .5 }, ballFrom: { x: .85, y: .5 }, actorPosition: { x: .85, y: .5 },
    playerId: 'h10', keeperId: 'a1', keeperPosition: { x: .96, y: .5 }
  });
  h.advanceTime(500);

  // 4. Atajada del guardameta
  fireEvent({
    type: 'save', team: 'away', minute: 15, phase: 'build_up', playStopped: false,
    ball: { x: .96, y: .5 }, ballFrom: { x: 1.0, y: .5 }, actorPosition: { x: .96, y: .5 },
    playerId: 'a1', keeperId: 'a1', keeperPosition: { x: .96, y: .5 },
    ballCarrierId: 'a1', possessionTeam: 'away'
  });
  h.advanceTime(500);

  // 5. Gol, banner, celebración, y saque de centro del equipo que recibió el gol
  fireEvent({
    type: 'goal', team: 'home', playerId: 'h9', playerName: 'Delantero Local', minute: 28,
    phase: 'goal_celebration', playStopped: true, marcador: '1-0',
    ball: { x: 1.01, y: .5 }, ballFrom: { x: .88, y: .5 }, actorPosition: { x: .88, y: .5 },
    ballCarrierId: null, possessionTeam: null
  });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Golazo de Delantero Local: 1-0.' });
  assert.equal(window.document.getElementById('score-home').textContent, '1');
  assert.equal(window.document.getElementById('score-away').textContent, '0');
  // La celebración espera a que la cola de pasos termine (cada paso alargado por distancia,
  // tope 6 s; los jugadores aún parten de su posición base en esta prueba).
  h.advanceTime(16000);
  assert.match(window.document.getElementById('est-commentary').textContent, /Golazo de Delantero Local/);

  // Saque de centro tras gol: balón a (0.5, 0.5) y saca visitante
  fireEvent({
    type: 'goal_restart', team: 'away', minute: 29, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: 1.01, y: .5 }, actorPosition: { x: .515, y: .5 },
    playerId: 'a9', ballCarrierId: 'a9', possessionTeam: 'away'
  });
  h.advanceTime(500);

  // 6. Falta y detención de juego
  fireEvent({
    type: 'foul', team: 'home', minute: 34, phase: 'set_piece', playStopped: true,
    ball: { x: .40, y: .30 }, ballFrom: { x: .40, y: .30 }, actorPosition: { x: .40, y: .30 },
    ballCarrierId: null, possessionTeam: 'away'
  });
  assert.ok(Array.from(window.document.querySelectorAll('#est-markets .est-sel')).every(b => b.disabled), 'mercados bloqueados en falta');

  // 7. Tarjeta amarilla
  fireEvent({
    type: 'yellow_card', team: 'home', playerId: 'h3', playerName: 'Defensor Local', minute: 35,
    phase: 'set_piece', playStopped: true, ball: { x: .40, y: .30 }
  });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Tarjeta amarilla para Defensor Local.' });
  assert.match(window.document.getElementById('est-commentary').textContent, /Tarjeta amarilla para Defensor Local/);

  // 8. Expulsión (tarjeta roja)
  fireEvent({
    type: 'red_card', team: 'home', playerId: 'h3', playerName: 'Defensor Local', minute: 40,
    phase: 'set_piece', playStopped: true, ball: { x: .40, y: .30 }
  });
  numbers = h.draw();
  assert.ok(!numbers.includes('3'), 'el jugador con tarjeta roja sale de la cancha');

  // 9. Sustitución
  fireEvent({
    type: 'substitution', team: 'home', playerId: 'h12', playerInId: 'h12', playerOutId: 'h9',
    minute: 42, phase: 'set_piece', playStopped: true, ball: { x: .5, y: .01 }
  });
  numbers = h.draw();
  assert.ok(numbers.includes('12'), 'suplente h12 ingresa al campo');
  assert.ok(!numbers.includes('9'), 'titular h9 abandona el campo');

  // 10. Saque de banda
  fireEvent({
    type: 'throw_in', team: 'away', minute: 44, phase: 'set_piece', playStopped: true,
    ball: { x: .60, y: 1.0 }, ballFrom: { x: .60, y: 1.0 }, actorPosition: { x: .60, y: 1.0 },
    playerId: 'a2', ballCarrierId: 'a2', possessionTeam: 'away'
  });

  // 11. Córner y saque de meta
  fireEvent({
    type: 'corner', team: 'away', minute: 45, phase: 'set_piece', playStopped: true,
    ball: { x: 0.0, y: 0.0 }, ballFrom: { x: 0.0, y: 0.0 }, actorPosition: { x: 0.0, y: 0.0 },
    playerId: 'a2', ballCarrierId: 'a2', possessionTeam: 'away'
  });
  fireEvent({
    type: 'goal_kick', team: 'home', minute: 45.5, phase: 'set_piece', playStopped: true,
    ball: { x: 0.045, y: .5 }, ballFrom: { x: 0.045, y: .5 }, actorPosition: { x: 0.045, y: .5 },
    playerId: 'h1', ballCarrierId: 'h1', possessionTeam: 'home'
  });

  // 12. Descanso y segundo tiempo
  fireEvent({
    type: 'halftime', minute: 45, phase: 'halftime', playStopped: true,
    ball: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: null
  });
  handlers['football:status']({ matchId: id, code: 'halftime', minute: 45 });
  assert.match(window.document.getElementById('est-clock').textContent, /Descanso/);

  fireEvent({
    type: 'second_half', team: 'away', minute: 46, phase: 'build_up', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, actorPosition: { x: .515, y: .5 },
    playerId: 'a9', ballCarrierId: 'a9', possessionTeam: 'away'
  });
  handlers['football:status']({ matchId: id, code: 'live', minute: 46 });

  // 13. Pitazo final
  handlers['football:status']({ matchId: id, code: 'full_time', minute: 90 });
  assert.equal(window.document.getElementById('est-clock').textContent, 'Final');
  assert.ok(Array.from(window.document.querySelectorAll('#est-markets .est-sel')).every(b => b.disabled), 'mercados cerrados al terminar el partido');
});

test('QA de usuario: reconexión a mitad de juego, expulsión del portador y limpieza de estela de tiro', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  const fireEvent = event => handlers['football:event']({ matchId: id, event });

  // 1. Portador con el balón recibe tarjeta roja
  handlers['football:status']({ matchId: id, code: 'live', minute: 25 });
  fireEvent({
    type: 'pass_sequence', team: 'home', minute: 25, phase: 'build_up', playStopped: false,
    ball: { x: .55, y: .45 }, ballFrom: { x: .50, y: .50 }, actorPosition: { x: .50, y: .50 },
    playerId: 'h2', receiverId: 'h10', ballCarrierId: 'h10', possessionTeam: 'home'
  });
  h.advanceTime(500);

  // La tarjeta roja se muestra sobre el portador h10
  fireEvent({
    type: 'red_card', team: 'home', playerId: 'h10', playerName: 'Jugador 10', minute: 26,
    phase: 'set_piece', playStopped: true, ball: { x: .55, y: .45 }, ballCarrierId: null
  });
  h.advanceTime(100);
  const numbers = h.draw();
  assert.ok(!numbers.includes('10'), 'el portador expulsado desaparece de la cancha de inmediato');

  // 2. Comprobar que tras el viaje del balón (p >= 1), el render se ejecuta sin fallos
  h.advanceTime(2500);
  assert.doesNotThrow(() => h.draw(), 'el ciclo de dibujo no genera errores con balón detenido y estela concluida');

  // 3. Reconexión: recibir un tick con juego detenido suspende mercados y actualiza el reloj
  handlers['football:tick']({
    matchId: id, minute: 30, displayMinute: 30, phase: 'set_piece', playStopped: true,
    score: { home: 1, away: 0 }, possessionTeam: 'away', ballCarrierId: null,
    ball: { x: .55, y: .45 }
  });
  const marketButtons = Array.from(window.document.querySelectorAll('#est-markets .est-sel'));
  assert.ok(marketButtons.every(b => b.disabled), 'los mercados permanecen bloqueados en tick con juego detenido');
  assert.match(window.document.getElementById('est-clock').textContent, /30' Balón parado/);
});
