// Fase E3 — Cliente de la sección «Estadio MonteCristo».
// Canvas 2D cenital con tweening a 60 fps (§8), relato de dos voces, boleta de
// apuesta con probabilidad implícita y límites del 10 %–50 % del saldo visibles, tabla de posiciones.
// Reusa la identidad del casino (mismo deviceToken, nombre, avatar y TOS_KEY en
// localStorage). La primera pintura viene de /api/estadio/state (sin socket); el
// socket aporta el vivo. Accesible con teclado y con prefers-reduced-motion.
(function () {
  'use strict';

  // ===== Constantes =====
  var TOS_KEY = 'montecristo-tos';
  var TOS_FALLBACK = '2026-09-28';
  var TICK_MS = 2000;              // cadencia del tick del servidor (§8.1)
  var EVENT_STEP_MS = 700;         // duración fija de cada paso de evento: ritmo visual constante
  var MAX_MOTION_BACKLOG = 8;      // pasos de movimiento en cola antes de descartar los menos relevantes
  var IMPORTANT_EVENTS = {         // eventos que nunca se descartan de la cola de movimiento
    goal: true, penalty_scored: true, penalty_awarded: true, red_card: true, second_yellow: true,
    kickoff: true, goal_restart: true, halftime: true, second_half: true, substitution: true,
    extra_time_start: true, extra_time_end: true, shootout_start: true, shootout_end: true, full_time: true
  };
  var PRESHOW_WINDOW_MS = 30 * 60 * 1000;
  var PROMOTION_ROTATION_MS = 15 * 1000;
  var HOUSE_PROMOTIONS = [
    { text: 'Póker, blackjack y más juegos: encuentra tu próxima mesa en MonteCristo.', href: '/', action: 'Explorar juegos', image: '/assets/poker-lounge.jpg' },
    { text: '¿Faltan rivales? Completa tu mesa de póker o blackjack con bots del servidor.', href: '/', action: 'Ver mesas', image: '/assets/blackjack-lounge.jpg' },
    { text: 'Reúne a tus amigos: crea una sala privada y comparte el código para jugar.', href: '/', action: 'Crear una sala', image: '/assets/coin-lounge.jpg' },
    { text: 'Sigue la liga de Estadio MonteCristo, con relato en vivo y fichas virtuales.', href: '/estadio', action: 'Entrar al Estadio', image: '/assets/estadio-tunnel.jpg' }
  ];
  var W = 1050, H = 680, PAD = 18; // canvas 105×68 m a 10 px/m
  var FIELD_W = W - PAD * 2, FIELD_H = H - PAD * 2;
  var PLAYER_R = 13, BALL_R = 6, TAU = Math.PI * 2;
  var DENOMS = [10, 25, 50, 100, 250, 500, 1000];
  // Ronda 9: la apuesta debe ser material respecto al saldo — mínimo 10 % y máximo
  // 50 % de las fichas actuales (espejo exacto de lib/football/betting.js LIMITS).
  var STAKE_MIN_FRAC = 0.10, STAKE_MAX_FRAC = 0.50, STAKE_ABS_MAX = 25000;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ===== Utilidades =====
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function nx(x) { return PAD + x * FIELD_W; }
  function ny(y) { return PAD + y * FIELD_H; }
  function fmt(n) { return Number(n || 0).toLocaleString('es-MX'); }
  function pct(p) { return (Number(p || 0) * 100).toFixed(0) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function hexToRgb(hex) { hex = String(hex || '#888').replace('#', ''); if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join(''); var n = parseInt(hex, 16) || 0; return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  function relLum(hex) { var c = hexToRgb(hex); var a = [c.r, c.g, c.b].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; }
  function contrast(a, b) { var l1 = relLum(a), l2 = relLum(b); var hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
  function bestText(bg) { return contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111'; }
  var FONT = null;
  function font() {
    if (FONT === null) {
      try { FONT = window.getComputedStyle(document.body).fontFamily || 'sans-serif'; }
      catch (e) { FONT = 'sans-serif'; }
    }
    return FONT;
  }
  function deviceToken() {
    var t = localStorage.getItem('montecristo-device');
    if (!t) { t = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)); localStorage.setItem('montecristo-device', t); }
    return t;
  }

  // ===== Formaciones: 11 slots normalizados (x desde la portería propia, y lateral) =====
  var FORMATIONS = {
    '4-4-2': [{ x: .04, y: .5, gk: 1 }, { x: .2, y: .18 }, { x: .2, y: .39 }, { x: .2, y: .61 }, { x: .2, y: .82 }, { x: .46, y: .15 }, { x: .46, y: .38 }, { x: .46, y: .62 }, { x: .46, y: .85 }, { x: .72, y: .4 }, { x: .72, y: .6 }],
    '4-3-3': [{ x: .04, y: .5, gk: 1 }, { x: .2, y: .18 }, { x: .2, y: .39 }, { x: .2, y: .61 }, { x: .2, y: .82 }, { x: .46, y: .3 }, { x: .46, y: .5 }, { x: .46, y: .7 }, { x: .72, y: .2 }, { x: .72, y: .5 }, { x: .72, y: .8 }],
    '3-5-2': [{ x: .04, y: .5, gk: 1 }, { x: .2, y: .3 }, { x: .2, y: .5 }, { x: .2, y: .7 }, { x: .46, y: .12 }, { x: .46, y: .31 }, { x: .46, y: .5 }, { x: .46, y: .69 }, { x: .46, y: .88 }, { x: .72, y: .4 }, { x: .72, y: .6 }],
    '4-2-3-1': [{ x: .04, y: .5, gk: 1 }, { x: .2, y: .18 }, { x: .2, y: .39 }, { x: .2, y: .61 }, { x: .2, y: .82 }, { x: .4, y: .4 }, { x: .4, y: .6 }, { x: .56, y: .22 }, { x: .56, y: .5 }, { x: .56, y: .78 }, { x: .76, y: .5 }]
  };
  function slots(formation) { return FORMATIONS[formation] || FORMATIONS['4-4-2']; }

  // Destino de un slot dado el balón: el bloque se comprime hacia el balón.
  function targetFor(slot, mirror, ballX, ballY) {
    var baseX = mirror ? 1 - slot.x : slot.x;
    var baseY = mirror ? 1 - slot.y : slot.y;
    var ax = slot.gk ? 0.03 : 0.22, ay = slot.gk ? 0.02 : 0.14;
    return { x: clamp(baseX + (ballX - baseX) * ax, .02, .98), y: clamp(baseY + (ballY - baseY) * ay, .04, .96) };
  }

  // ===== Estado =====
  var S = {
    socket: null, token: null, name: null, avatar: null, tosVersion: TOS_FALLBACK,
    teams: {}, profile: null, chips: 0,
    lobby: null, standings: [], countdownTo: null, lobbyServerNow: null, lobbyReceivedAt: null,
    preshowDataMatchId: null, preshowDataStandings: null,
    promotionsEnabled: false, promoSessionChecked: false, promoProfile: null, promoCsrfToken: null,
    promoWindowOpen: false, promoMatchId: null, promoPollId: null, promoRequestSeq: 0,
    currentMatchId: null, match: null, markets: {}, movement: {}, myBets: [],
    slip: null, muted: false, soundOn: localStorage.getItem('montecristo-notifications') !== 'off', musicOn: localStorage.getItem('montecristo-music') === 'on',
    players: [], authoritativePlayers: [], possessionTeam: 'home', ballCarrierId: null, playStopped: true,
    ball: { x: .5, y: .5 }, ballDest: { x: .5, y: .5 }, motion: null, queue: [], stepTimer: null, busyUntil: 0, plan: null,
    minute: 0, phase: 'pre', score: { home: 0, away: 0 }, possession: { home: .5, away: .5 },
    goalFlashUntil: 0, homeKit: '#52e0ae', awayKit: '#ff667c', rafId: null, pitchCache: null, submitting: false
  };

  var el = {};
  function cacheEls() {
    ['est-connection', 'est-chips', 'est-sound', 'est-music', 'est-countdown', 'est-match-list', 'est-standings',
      'est-preshow', 'est-preshow-status', 'est-preshow-timer', 'est-team-comparison',
      'est-compare-home', 'est-compare-away', 'est-preshow-promo', 'est-promo-image', 'est-promo-label', 'est-promo-text', 'est-promo-link',
      'est-promo-compose', 'est-promo-auth', 'est-promo-login', 'est-promo-refresh', 'est-promo-form',
      'est-promo-copy-input', 'est-promo-image-input', 'est-promo-target', 'est-promo-room-field', 'est-promo-room-code',
      'est-promo-submit', 'est-promo-message',
      'est-scoreboard', 'crest-home', 'crest-away', 'name-home', 'name-away', 'score-home', 'score-away',
      'est-clock', 'est-pitch', 'est-goal-banner', 'est-commentary', 'est-text-state', 'est-market-phase',
      'est-markets', 'est-bet-slip', 'est-slip-pick', 'est-slip-clear', 'est-slip-odds', 'est-slip-implied',
      'est-stake', 'est-denoms', 'est-slip-range', 'est-place-bet', 'est-bet-msg', 'est-mybets', 'est-help',
      'est-help-close', 'est-tos', 'est-tos-accept', 'est-toast', 'est-canvas-wrap'].forEach(function (id) { el[id] = $(id); });
  }

  // ===== Arranque =====
  // ===== Animación de entrada (casino → Estadio) =====
  // Se reproduce UNA sola vez por acceso desde el casino. El disparo es la URL
  // (?from=casino, que añaden el banner y el nav del casino) o, como respaldo, un
  // referrer del mismo origen que no sea el propio Estadio. Para que un refresco
  // (F5) NO la repita, se consume el parámetro con history.replaceState en cuanto se
  // reproduce; además una bandera de sessionStorage la limita a una vez por sesión.
  // El overlay se retira del DOM al terminar (o al saltarlo), de modo que ningún tick
  // de socket, re-render ni navegación interna puede volver a mostrarlo (sin bucles).
  var ENTER_FLAG = 'mc-estadio-entered';

  function shouldPlayEntry() {
    if (reduced.matches) return false; // accesibilidad: sin intro con movimiento reducido
    try { if (sessionStorage.getItem(ENTER_FLAG)) return false; } catch (e) { /* sin storage */ }
    try {
      if (new URLSearchParams(location.search).get('from') === 'casino') return true;
    } catch (e) { /* URLSearchParams no disponible */ }
    try {
      var ref = new URL(document.referrer || '', location.href);
      // Vino del casino: mismo origen y una ruta distinta de la del Estadio.
      if (ref.origin === location.origin && ref.pathname !== '/estadio') return true;
    } catch (e) { /* referrer inválido */ }
    return false;
  }

  function maybePlayEntry() {
    if (!shouldPlayEntry()) return;
    var overlay = $('est-enter');
    if (!overlay) return;
    try { sessionStorage.setItem(ENTER_FLAG, String(Date.now())); } catch (e) { /* sin storage */ }
    // Consume ?from=casino para que un refresco no vuelva a dispararla.
    try {
      var clean = new URL(location.href);
      clean.searchParams.delete('from');
      history.replaceState(null, '', clean.toString());
    } catch (e) { /* sin history API */ }

    overlay.hidden = false;
    var finished = false;
    function onKey(ev) {
      // Se traga la tecla para que no active atajos del Estadio durante la intro.
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    }
    function finish(instant) {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKey, true);
      if (instant) { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); return; }
      overlay.classList.add('est-enter-out');
      setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 320);
    }
    // Fin natural: al terminar el ciclo de vida el overlay ya está en opacidad 0.
    overlay.addEventListener('animationend', function (ev) {
      if (ev.target === overlay && ev.animationName === 'est-enter-lifecycle') finish(true);
    });
    // Red de seguridad por si animationend no llegara (pestaña en segundo plano, etc.).
    setTimeout(function () { finish(true); }, 3400);
    // Saltar con clic en cualquier parte o con cualquier tecla.
    overlay.addEventListener('click', function () { finish(false); });
    window.addEventListener('keydown', onKey, true);
    var skip = $('est-enter-skip');
    if (skip) skip.addEventListener('click', function (ev) { ev.stopPropagation(); finish(false); });
  }

  function boot() {
    maybePlayEntry();
    cacheEls();
    S.token = deviceToken();
    S.name = localStorage.getItem('montecristo-name') || ('Aficionado ' + S.token.slice(-4).toUpperCase());
    S.avatar = localStorage.getItem('montecristo-avatar') || 'fox';
    bindUI();
    initPitchCanvas();
    // Con FOOTBALL_ENABLED apagado el backend responde 404 fail-closed (diseño
    // intencional); el flag público de /healthz evita la petición — el
    // navegador loguea todo 404 de red en consola aunque el JS lo maneje.
    fetch('/healthz', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (health) {
        S.promotionsEnabled = Boolean(health && health.promotionsEnabled);
        updatePromotionComposer();
        if (S.promotionsEnabled) refreshPromotionSession();
        if (health && health.football && health.football.enabled === false) return gateTosThenConnect();
        return fetch('/api/estadio/state')
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || !data.ok) return;
            S.teams = data.teams || {};
            S.tosVersion = data.tosVersion || TOS_FALLBACK;
            if (data.profile) { S.profile = data.profile; S.chips = data.profile.chips; updateChips(); }
            renderLobby(data.lobby);
            gateTosThenConnect();
          })
          .catch(function () { gateTosThenConnect(); });
      })
      .catch(function () { gateTosThenConnect(); });
  }

  function gateTosThenConnect() {
    if (localStorage.getItem(TOS_KEY) === S.tosVersion) connect();
    else el['est-tos'].hidden = false;
  }
  function tosAccepted() { return localStorage.getItem(TOS_KEY) === S.tosVersion; }

  function setPromoMessage(text, state) {
    if (!el['est-promo-message']) return;
    el['est-promo-message'].textContent = text || '';
    if (state) el['est-promo-message'].dataset.state = state;
    else delete el['est-promo-message'].dataset.state;
  }

  function updatePromotionComposer() {
    var details = el['est-promo-compose'];
    if (!details) return;
    details.hidden = !S.promotionsEnabled || !S.promoWindowOpen;
    if (!S.promotionsEnabled || !S.promoWindowOpen) return;
    var linked = Boolean(S.promoProfile && S.promoProfile.username);
    el['est-promo-auth'].textContent = linked
      ? 'Sesión vinculada: @' + S.promoProfile.username
      : (S.promoSessionChecked ? 'Para enviar, inicia sesión con una cuenta vinculada del casino.' : 'Comprueba tu sesión de cuenta vinculada.');
    el['est-promo-auth'].dataset.state = linked ? 'ready' : '';
    el['est-promo-login'].hidden = linked;
    el['est-promo-refresh'].hidden = linked;
    el['est-promo-form'].hidden = !linked;
  }

  function refreshPromotionSession() {
    if (!S.promotionsEnabled) return Promise.resolve(null);
    return fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.json().catch(function () { return {}; }); })
      .then(function (data) {
        S.promoSessionChecked = true;
        if (data && data.ok && data.profile && data.profile.username) {
          S.promoProfile = data.profile;
          S.promoCsrfToken = data.csrfToken || null;
        } else {
          S.promoProfile = null;
          S.promoCsrfToken = null;
        }
        updatePromotionComposer();
        if (S.promoProfile && S.promoMatchId) loadOwnPromotion(S.promoMatchId);
        return S.promoProfile;
      })
      .catch(function () {
        S.promoSessionChecked = true;
        S.promoProfile = null;
        S.promoCsrfToken = null;
        updatePromotionComposer();
        return null;
      });
  }

  function loadOwnPromotion(matchId) {
    if (!S.promoProfile || !matchId) return Promise.resolve(null);
    return fetch('/api/estadio/promotions/' + encodeURIComponent(matchId) + '/mine', {
      cache: 'no-store', credentials: 'same-origin'
    }).then(function (response) { return response.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (S.promoMatchId !== matchId || !data || !data.ok) return null;
        var promotion = data.promotion;
        if (!promotion) { setPromoMessage('', ''); return null; }
        if (promotion.status === 'pending') {
          setPromoMessage('En revisión administrativa. No se han cobrado fichas.', 'success');
        } else if (promotion.status === 'approved') {
          setPromoMessage('Aprobada: se cobraron ' + fmt(promotion.chargedAmount || 250) + ' fichas.', 'success');
        } else if (promotion.status === 'rejected') {
          setPromoMessage('No aprobada. Sin cobro.' + (promotion.reviewReason ? ' ' + promotion.reviewReason : ''), 'error');
        }
        return promotion;
      }).catch(function () { return null; });
  }

  // ===== Socket =====
  function setConn(state) {
    var b = el['est-connection'];
    b.className = 'connection-badge ' + state;
    b.lastElementChild.textContent = state === 'connected' ? 'Conectado' : state === 'connecting' ? 'Conectando' : 'Sin conexión';
  }
  function connect() {
    if (S.socket) return;
    S.socket = io({ auth: { deviceToken: S.token } });
    S.socket.on('connect', function () { setConn('connected'); subscribeLobby(); });
    S.socket.on('disconnect', function () { setConn('error'); });
    S.socket.on('connect_error', function () { setConn('error'); });
    S.socket.on('football:lobby', function (lobby) { renderLobby(lobby); });
    S.socket.on('football:tick', onTick);
    S.socket.on('football:event', onEvent);
    S.socket.on('football:commentary', onCommentary);
    S.socket.on('football:odds', onOdds);
    S.socket.on('football:settlement', onSettlement);
    S.socket.on('football:status', onStatus);
    S.socket.on('football:rescheduled', onRescheduled);
    S.socket.on('account_chips_updated', function (data) {
      if (!data || !S.promoProfile || data.profileId !== S.promoProfile.id) return;
      S.promoProfile.chips = Number(data.chips) || 0;
      if (S.profile && S.profile.id === data.profileId) {
        S.profile.chips = S.promoProfile.chips;
        S.chips = S.promoProfile.chips;
        updateChips();
      }
      if (data.matchId === S.promoMatchId) loadOwnPromotion(data.matchId);
    });
  }
  function subscribeLobby() {
    S.socket.emit('football:subscribe', { scope: 'lobby', token: S.token, name: S.name, avatar: S.avatar, tos: S.tosVersion }, function (res) {
      if (!res || !res.ok) return onSubError(res);
      S.teams = res.teams || S.teams;
      if (res.profile) { S.profile = res.profile; S.chips = res.profile.chips; updateChips(); }
      renderLobby(res.lobby);
    });
  }
  function onSubError(res) {
    var code = res && res.code;
    if (code === 'tos_required') { el['est-tos'].hidden = false; return; }
    if (code === 'name_taken') { toast('Ese nombre ya está en uso. Cambia tu apodo en el casino.', 'lose'); return; }
    if (code === 'room_full') { toast('La sala está llena; intenta con otro partido.', 'lose'); return; }
    toast((res && res.error) || 'No se pudo entrar al Estadio.', 'lose');
  }

  function selectMatch(matchId) {
    if (!S.socket || !matchId) return;
    if (S.currentMatchId && S.currentMatchId !== matchId) S.socket.emit('football:unsubscribe', { scope: 'match', matchId: S.currentMatchId });
    S.socket.emit('football:subscribe', { scope: 'match', matchId: matchId, token: S.token, tos: S.tosVersion }, function (res) {
      if (!res || !res.ok) return onSubError(res);
      S.currentMatchId = matchId;
      S.teams = res.teams || S.teams;
      if (res.profile) { S.chips = res.profile.chips; updateChips(); }
      applyMatchState(res.matchState);
      highlightActive();
    });
  }

  // ===== Lobby =====
  function teamName(id) { var t = S.teams[id]; return t ? t.short || t.name : String(id || '?').slice(0, 3).toUpperCase(); }
  function teamFull(id) { var t = S.teams[id]; return t ? t.name : id; }
  function teamColor(id) { var t = S.teams[id]; return t ? t.colors.primary : '#888'; }
  function currentServerTime() {
    if (Number.isFinite(S.lobbyServerNow) && Number.isFinite(S.lobbyReceivedAt)) {
      return S.lobbyServerNow + Math.max(0, performance.now() - S.lobbyReceivedAt);
    }
    return Date.now();
  }
  function preshowTeamColor(id) {
    var color = teamColor(id);
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#888';
  }
  function tacticSummary(teamId) {
    var team = S.teams[teamId] || {};
    var styleLabels = { possession: 'Posesión', pressing: 'Presión alta', counter: 'Contraataque', direct: 'Juego directo', balanced: 'Equilibrado' };
    return [team.formation, styleLabels[team.style]].filter(Boolean).join(' · ') || '—';
  }
  function standingFor(teamId) {
    return (S.standings || []).find(function (row) { return (row.teamId || row.id) === teamId; }) || null;
  }
  function standingValue(row, key) {
    return row && row[key] != null ? fmt(row[key]) : '—';
  }
  function formMarkup(row) {
    var labels = { W: { short: 'G', full: 'Ganó', cls: 'win' }, D: { short: 'E', full: 'Empató', cls: 'draw' }, L: { short: 'P', full: 'Perdió', cls: 'loss' } };
    var form = row && Array.isArray(row.form) ? row.form.slice(-5).filter(function (result) { return Boolean(labels[result]); }) : [];
    if (!form.length) return '<span class="est-comparison-empty">Sin resultados</span>';
    var accessible = form.map(function (result) { return labels[result].full; }).join(', ');
    return '<span class="est-form-results" aria-label="Forma reciente: ' + esc(accessible) + '">' + form.map(function (result) {
      var label = labels[result];
      return '<span class="est-form-result ' + label.cls + '" title="' + label.full + '">' + label.short + '</span>';
    }).join('') + '</span>';
  }
  function renderTeamComparison() {
    if (!S.match || !el['est-team-comparison']) return;
    var homeId = S.match.homeId, awayId = S.match.awayId;
    var homeColor = preshowTeamColor(homeId), awayColor = preshowTeamColor(awayId);
    el['est-compare-home'].innerHTML = '<span class="est-compare-club"><i class="est-compare-dot" aria-hidden="true" style="background-color:' + homeColor + ';color:' + homeColor + '"></i>' + esc(teamFull(homeId)) + '</span>';
    el['est-compare-away'].innerHTML = '<span class="est-compare-club"><i class="est-compare-dot" aria-hidden="true" style="background-color:' + awayColor + ';color:' + awayColor + '"></i>' + esc(teamFull(awayId)) + '</span>';
    var home = standingFor(homeId), away = standingFor(awayId);
    var homePos = (S.standings || []).findIndex(function (row) { return (row.teamId || row.id) === homeId; });
    var awayPos = (S.standings || []).findIndex(function (row) { return (row.teamId || row.id) === awayId; });
    var position = function (index) { return index >= 0 ? '#' + (index + 1) : '—'; };
    var record = function (row) {
      return row ? [standingValue(row, 'won'), standingValue(row, 'drawn'), standingValue(row, 'lost')].join('–') : '—';
    };
    var goals = function (row) {
      return row ? standingValue(row, 'goalsFor') + '–' + standingValue(row, 'goalsAgainst') : '—';
    };
    var goalDifference = function (row) {
      if (!row) return '—';
      var difference = row.goalDiff != null
        ? Number(row.goalDiff)
        : Number(row.goalsFor) - Number(row.goalsAgainst);
      if (!Number.isFinite(difference)) return '—';
      return (difference > 0 ? '+' : '') + fmt(difference);
    };
    var rows = [
      ['Formación / estilo', tacticSummary(homeId), tacticSummary(awayId)],
      ['Posición', position(homePos), position(awayPos)],
      ['PJ', standingValue(home, 'played'), standingValue(away, 'played')],
      ['G–E–P', record(home), record(away)],
      ['Puntos', standingValue(home, 'points'), standingValue(away, 'points')],
      ['GF–GC', goals(home), goals(away)],
      ['DG', goalDifference(home), goalDifference(away)],
      ['Forma (5)', formMarkup(home), formMarkup(away)]
    ];
    el['est-team-comparison'].querySelector('tbody').innerHTML = rows.map(function (row) {
      return '<tr><th scope="row">' + esc(row[0]) + '</th><td>' + (row[0] === 'Forma (5)' ? row[1] : esc(row[1])) + '</td><td>' + (row[0] === 'Forma (5)' ? row[2] : esc(row[2])) + '</td></tr>';
    }).join('');
  }
  function formatPreshowCountdown(ms) {
    var seconds = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }
  // Pinta el anuncio a pantalla completa de La Previa. Si el texto o la imagen
  // cambian, el contenido entra desde la derecha y se desplaza hacia la izquierda.
  var PROMO_FALLBACK_IMAGE = '/assets/casino-hero.jpg';
  function setPromoCreative(c) {
    var stage = el['est-preshow-promo'];
    var image = el['est-promo-image'];
    var changed = el['est-promo-text'].textContent !== c.text || image.getAttribute('src') !== (c.image || PROMO_FALLBACK_IMAGE);
    el['est-promo-label'].textContent = c.label;
    el['est-promo-text'].textContent = c.text;
    el['est-promo-link'].href = c.href;
    el['est-promo-link'].textContent = c.action;
    image.src = c.image || PROMO_FALLBACK_IMAGE;
    image.alt = '';
    if (changed && stage && el['est-preshow'] && !el['est-preshow'].hidden) {
      stage.classList.remove('is-sliding');
      void stage.offsetWidth; // reinicia la animación
      stage.classList.add('is-sliding');
    }
  }
  function defaultPromotion() {
    var slot = Math.floor(Date.now() / PROMOTION_ROTATION_MS);
    var index = ((slot % HOUSE_PROMOTIONS.length) + HOUSE_PROMOTIONS.length) % HOUSE_PROMOTIONS.length;
    var promotion = HOUSE_PROMOTIONS[index];
    setPromoCreative({ label: 'Promoción de MonteCristo', text: promotion.text, href: promotion.href, action: promotion.action, image: promotion.image });
  }
  function renderPromotion(promotion) {
    var href = promotion && promotion.href;
    var allowed = href === '/' || href === '/estadio' || href === '/terminos' || /^\/room\/[A-Z0-9]{5}$/.test(String(href || ''));
    if (!promotion || !allowed || typeof promotion.text !== 'string') {
      defaultPromotion();
      return;
    }
    // La imagen solo puede venir de la ruta interna de creatividades del servidor.
    var image = typeof promotion.image === 'string' && promotion.image.indexOf('/api/estadio/promotion-media/') === 0 ? promotion.image : null;
    setPromoCreative({ label: 'Promoción pagada', text: promotion.text, href: href, action: 'Ver promoción', image: image });
  }
  function stopPromotionRotation() {
    if (S.promoPollId) clearInterval(S.promoPollId);
    S.promoPollId = null;
    S.promoMatchId = null;
    S.promoRequestSeq++;
    defaultPromotion();
  }
  function loadPromotion(matchId) {
    if (!matchId) return;
    var requestSeq = ++S.promoRequestSeq;
    fetch('/api/estadio/promotions/' + encodeURIComponent(matchId), { cache: 'no-store' })
      .then(function (response) { return response.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (requestSeq !== S.promoRequestSeq || S.promoMatchId !== matchId) return;
        renderPromotion(data && data.ok ? data.promotion : null);
      })
      .catch(function () {
        if (requestSeq === S.promoRequestSeq && S.promoMatchId === matchId) defaultPromotion();
      });
  }
  function startPromotionRotation(matchId) {
    if (S.promoMatchId === matchId) return;
    stopPromotionRotation();
    S.promoMatchId = matchId;
    loadPromotion(matchId);
    if (S.promoProfile) loadOwnPromotion(matchId);
    S.promoPollId = setInterval(function () { loadPromotion(matchId); }, PROMOTION_ROTATION_MS);
  }
  function renderPreshow(nowMs) {
    var panel = el['est-preshow'];
    if (!panel) return;
    var match = S.match;
    if (!match || match.status !== 'scheduled' || match.scheduledKickoffAt == null || !Number.isFinite(Number(match.scheduledKickoffAt))) {
      panel.hidden = true;
      panel.removeAttribute('data-delay');
      S.promoWindowOpen = false;
      updatePromotionComposer();
      stopPromotionRotation();
      return;
    }
    var remaining = Number(match.scheduledKickoffAt) - (Number.isFinite(nowMs) ? nowMs : currentServerTime());
    var delayed = remaining <= 0;
    if (!delayed && remaining > PRESHOW_WINDOW_MS) {
      panel.hidden = true;
      panel.removeAttribute('data-delay');
      S.promoWindowOpen = false;
      updatePromotionComposer();
      stopPromotionRotation();
      return;
    }
    panel.hidden = false;
    panel.dataset.delay = String(delayed);
    S.promoWindowOpen = !delayed;
    updatePromotionComposer();
    if (delayed) stopPromotionRotation();
    else startPromotionRotation(match.id);
    var statusText = delayed
      ? 'Kickoff pendiente · esperando señal del partido'
      : 'Kickoff programado · ' + kickoffTime(match.scheduledKickoffAt);
    if (el['est-preshow-status'].textContent !== statusText) el['est-preshow-status'].textContent = statusText;
    el['est-preshow-timer'].textContent = delayed ? '' : formatPreshowCountdown(remaining);
    el['est-preshow-promo'].hidden = delayed;
    if (S.preshowDataMatchId !== match.id || S.preshowDataStandings !== S.standings) {
      renderTeamComparison();
      S.preshowDataMatchId = match.id;
      S.preshowDataStandings = S.standings;
    }
  }

  function updateLobbyMatchKickoff(matchId, kickoffAt, day, block) {
    if (!S.lobby || !Array.isArray(S.lobby.matches)) return;
    var found = S.lobby.matches.find(function (m) { return m.id === matchId; });
    if (found) {
      if (kickoffAt != null && Number.isFinite(Number(kickoffAt))) found.scheduledKickoffAt = Number(kickoffAt);
      if (day != null) found.day = day;
      if (block != null) found.block = block;
    }
    var next = S.lobby.matches
      .filter(function (m) { return m.status === 'scheduled'; })
      .sort(function (a, b) { return a.scheduledKickoffAt - b.scheduledKickoffAt; })[0] || null;
    S.lobby.nextKickoffAt = next ? next.scheduledKickoffAt : null;
    S.countdownTo = S.lobby.nextKickoffAt;
  }

  var STATUS_LABEL = { scheduled: 'Programado', live: 'EN VIVO', halftime: 'Descanso', extra_time: 'Prórroga', shootout: 'Penales', finished: 'Final', settled: 'Final', postponed: 'Pospuesto' };
  function renderLobby(lobby) {
    if (!lobby) return;
    S.lobby = lobby; S.standings = lobby.standings || []; S.countdownTo = lobby.nextKickoffAt;
    if (lobby.serverNow != null && Number.isFinite(Number(lobby.serverNow))) {
      S.lobbyServerNow = Number(lobby.serverNow);
      S.lobbyReceivedAt = performance.now();
    }
    var list = el['est-match-list']; list.innerHTML = '';
    var matches = lobby.matches || [];
    var selectedMatch = S.currentMatchId && matches.find(function (match) { return match.id === S.currentMatchId; });
    if (selectedMatch && S.match) {
      S.match.status = selectedMatch.status;
      S.match.scheduledKickoffAt = selectedMatch.scheduledKickoffAt;
      if (selectedMatch.day != null) S.match.day = selectedMatch.day;
      if (selectedMatch.block != null) S.match.block = selectedMatch.block;
    }
    if (!matches.length) { list.innerHTML = '<li class="est-muted">No hay partidos programados hoy.</li>'; }
    matches.forEach(function (m) {
      var li = document.createElement('li');
      var live = ['live', 'halftime', 'extra_time', 'shootout'].indexOf(m.status) >= 0;
      li.className = 'est-match-item' + (live ? ' live' : '') + (m.id === S.currentMatchId ? ' active' : '');
      li.tabIndex = 0; li.setAttribute('role', 'button');
      li.setAttribute('aria-label', teamFull(m.homeId) + ' contra ' + teamFull(m.awayId) + ', ' + (STATUS_LABEL[m.status] || m.status));
      var score = (m.status === 'settled' || m.status === 'finished' || live) && m.result ? (m.result.score ? m.result.score.home + '–' + m.result.score.away : '') : (m.minute != null ? '' : kickoffTime(m.scheduledKickoffAt));
      li.innerHTML =
        '<div><div class="est-match-teams"><span style="color:' + teamColor(m.homeId) + '">' + esc(teamName(m.homeId)) + '</span> vs <span style="color:' + teamColor(m.awayId) + '">' + esc(teamName(m.awayId)) + '</span>' + (m.featured ? ' ★' : '') + '</div>' +
        '<div class="est-match-meta">' + esc(blockLabel(m.block)) + ' · J' + m.jornada + '</div></div>' +
        '<div><div class="est-match-score">' + esc(score) + '</div><div class="est-match-status ' + (live ? 'live' : 'scheduled') + '">' + esc(STATUS_LABEL[m.status] || m.status) + (m.minute != null && live ? ' ' + m.minute + "'" : '') + '</div></div>';
      li.addEventListener('click', function () { selectMatch(m.id); });
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMatch(m.id); } });
      list.appendChild(li);
    });
    renderStandings();
    renderPreshow(currentServerTime());
  }
  function blockLabel(b) { return ({ matutino: 'Matutino', vespertino: 'Vespertino', estelar: 'Estelar' })[b] || b; }
  // Los horarios de partido son de la zona del casino (America/Mexico_City), no
  // de la del navegador: un aficionado en otra zona debe ver la misma hora.
  var CASINO_TIME_ZONE = 'America/Mexico_City';
  function kickoffTime(ms) { if (!ms) return ''; try { return new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: CASINO_TIME_ZONE }); } catch (e) { return ''; } }
  function renderStandings() {
    var tb = el['est-standings'].querySelector('tbody'); tb.innerHTML = '';
    (S.standings || []).slice(0, 16).forEach(function (row, i) {
      var tr = document.createElement('tr');
      var id = row.teamId || row.id;
      tr.innerHTML = '<td class="' + (i === 0 ? 'pos-1' : '') + '">' + (i + 1) + '</td>' +
        '<td><span class="est-crest-dot" style="background:' + teamColor(id) + '"></span>' + esc(teamName(id)) + '</td>' +
        '<td>' + (row.played != null ? row.played : (row.pj != null ? row.pj : '')) + '</td>' +
        '<td>' + (row.goalDiff != null ? (row.goalDiff > 0 ? '+' : '') + row.goalDiff : (row.dg != null ? row.dg : '')) + '</td>' +
        '<td class="pts">' + (row.points != null ? row.points : (row.pts != null ? row.pts : '')) + '</td>';
      tb.appendChild(tr);
    });
  }
  function tickCountdown() {
    var nowMs = currentServerTime();
    if (!S.countdownTo) {
      el['est-countdown'].textContent = 'Sin próximo kickoff programado.';
    } else {
      var ms = S.countdownTo - nowMs;
      if (ms <= 0) el['est-countdown'].innerHTML = 'Próximo kickoff: <b>en juego</b>';
      else {
        var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
        el['est-countdown'].innerHTML = 'Próximo kickoff en <b>' + (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's</b>';
      }
    }
    renderPreshow(nowMs);
  }

  // ===== Estado del partido =====
  function applyMatchState(ms) {
    if (!ms) return;
    S.match = ms.match; S.markets = ms.markets || {}; S.movement = {};
    S.myBets = (ms.myBets || []).slice();
    S.minute = ms.state ? Math.round(ms.state.displayMinute != null ? ms.state.displayMinute : ms.state.minute) : 0;
    S.phase = ms.state ? ms.state.phase : 'pre';
    S.score = ms.state ? ms.state.score : { home: 0, away: 0 };
    S.possession = ms.state && ms.state.possession ? ms.state.possession : { home: .5, away: .5 };
    S.possessionTeam = ms.state && ms.state.possessionTeam ? ms.state.possessionTeam : 'home';
    S.ballCarrierId = ms.state ? ms.state.ballCarrierId : null;
    S.playStopped = ms.state ? Boolean(ms.state.playStopped) : true;
    clearMotion();
    S.authoritativePlayers = ms.state && Array.isArray(ms.state.players) ? ms.state.players : [];
    var ball = ms.state && ms.state.ball ? ms.state.ball : { x: .5, y: .5 };
    S.ball = { x: ball.x, y: ball.y }; S.ballDest = { x: ball.x, y: ball.y };
    resolveKits();
    initPlayers();
    renderScoreboard();
    renderMarkets();
    renderMyBets();
    renderCommentary(ms.commentary || []);
    updateTextFallback();
    renderPreshow(currentServerTime());
    if (!S.rafId) S.rafId = requestAnimationFrame(frame);
  }

  function resolveKits() {
    var home = S.teams[S.match.homeId], away = S.teams[S.match.awayId];
    var hb = home ? home.colors.primary : '#52e0ae';
    var ab = away ? away.colors.primary : '#ff667c';
    // Contraste de kits validado: si ambos primarios se confunden, la visita usa
    // su secundario; si aun así chocan, se fuerza un blanco/neutro distinguishable.
    if (contrast(hb, ab) < 1.6) {
      var alt = away ? away.colors.secondary : '#f5f5f5';
      ab = contrast(hb, alt) >= 1.6 ? alt : (relLum(hb) > 0.4 ? '#1a1a1a' : '#f5f5f5');
    }
    S.homeKit = hb; S.awayKit = ab;
    S.homeSec = home ? home.colors.secondary : '#111';
    S.awaySec = away ? away.colors.secondary : '#111';
    S.homePattern = home ? home.colors.kit : 'solid';
    S.awayPattern = away ? away.colors.kit : 'solid';
  }

  function initPlayers() {
    S.players = [];
    if (Array.isArray(S.authoritativePlayers) && S.authoritativePlayers.length) {
      syncAuthoritativePlayers(S.authoritativePlayers, false);
      return;
    }
    var hf = S.teams[S.match.homeId] ? S.teams[S.match.homeId].formation : '4-4-2';
    var af = S.teams[S.match.awayId] ? S.teams[S.match.awayId].formation : '4-4-2';
    buildTeam('home', hf, false, S.homeKit, S.homeSec, S.homePattern);
    buildTeam('away', af, true, S.awayKit, S.awaySec, S.awayPattern);
    recomputeTargets(S.ballDest.x, S.ballDest.y);
    S.players.forEach(function (p) { p.baseX = p.destX; p.baseY = p.destY; p.startX = p.destX; p.startY = p.destY; p.renderX = p.destX; p.renderY = p.destY; });
  }
  function syncAuthoritativePlayers(serverPlayers, animate) {
    var previous = {};
    S.players.forEach(function (p) { if (p.id != null) previous[p.id] = p; });
    S.authoritativePlayers = Array.isArray(serverPlayers) ? serverPlayers : [];
    S.players = S.authoritativePlayers.filter(function (p) { return p && p.active && (p.team === 'home' || p.team === 'away'); }).map(function (p, index) {
      var old = previous[p.id];
      var team = p.team;
      var x = Number.isFinite(Number(p.x)) ? clamp(Number(p.x), .01, .99) : .5;
      var y = Number.isFinite(Number(p.y)) ? clamp(Number(p.y), .02, .98) : .5;
      var kitBase = team === 'home' ? S.homeKit : S.awayKit;
      var kitSec = team === 'home' ? S.homeSec : S.awaySec;
      var kitPattern = team === 'home' ? S.homePattern : S.awayPattern;
      var fromX = animate && old ? old.renderX : x;
      var fromY = animate && old ? old.renderY : y;
      return {
        id: p.id, name: p.name, pos: p.pos, role: p.role, team: team, active: true,
        number: p.number, speed: p.speed, stamina: p.stamina, status: p.status,
        seed: index * 7.3 + (team === 'home' ? 100 : 200),
        kitBase: kitBase, kitSec: kitSec, kitPattern: kitPattern, dorsalColor: bestText(kitBase),
        startX: fromX, startY: fromY, baseX: fromX, baseY: fromY,
        destX: x, destY: y, renderX: fromX, renderY: fromY
      };
    });
  }
  function buildTeam(team, formation, mirror, base, sec, pattern) {
    slots(formation).forEach(function (slot, i) {
      S.players.push({
        team: team, mirror: mirror, slot: slot, number: i + 1, seed: (team === 'home' ? 1 : 2) * 100 + i * 7.3,
        kitBase: base, kitSec: sec, kitPattern: pattern, dorsalColor: bestText(base),
        baseX: .5, baseY: .5, startX: .5, startY: .5, destX: .5, destY: .5, renderX: .5, renderY: .5
      });
    });
  }
  function recomputeTargets(bx, by) {
    if (Array.isArray(S.authoritativePlayers) && S.authoritativePlayers.length) {
      var byId = {};
      S.authoritativePlayers.forEach(function (p) { if (p && p.id != null) byId[p.id] = p; });
      S.players.forEach(function (p) {
        var authoritative = byId[p.id];
        if (!authoritative || !authoritative.active) return;
        p.startX = p.renderX; p.startY = p.renderY;
        p.destX = clamp(Number(authoritative.x), .01, .99);
        p.destY = clamp(Number(authoritative.y), .02, .98);
      });
      return;
    }
    S.players.forEach(function (p) {
      var t = targetFor(p.slot, p.mirror, bx, by);
      p.startX = p.baseX; p.startY = p.baseY; p.destX = t.x; p.destY = t.y;
    });
  }
  // ===== Reproducción de movimiento: cola de pasos (60 fps) =====
  // Los mensajes del servidor llegan a ráfagas (eventos revelados en lote tras un
  // corte de red o de pestaña) y los ticks cada 2 s. Aplicarlos al instante
  // reiniciaba el tween: el balón y los jugadores se congelaban y luego saltaban.
  // Ahora cada mensaje de movimiento se planifica como un «paso» de duración fija;
  // los pasos se reproducen en orden con interpolación lineal desde la pose que se
  // ve en pantalla hasta el destino del paso. Marcador, mercados y plantilla siguen
  // actualizándose al instante; solo el movimiento y el relato esperan su turno.
  function motionP(now) {
    var m = S.motion;
    if (!m || !(m.ms > 0)) return 1;
    return clamp((now - m.t0) / m.ms, 0, 1);
  }
  function poseOf(pl, p) {
    var m = S.motion;
    var f = m && m.from[pl.id], t = m && m.to[pl.id];
    if (!f || !t) return { x: pl.baseX, y: pl.baseY };
    return { x: lerp(f.x, t.x, p), y: lerp(f.y, t.y, p) };
  }
  function ballAt(p) {
    var m = S.motion;
    if (!m) return { x: S.ball.x, y: S.ball.y };
    return { x: lerp(m.ballFrom.x, m.ballTo.x, p), y: lerp(m.ballFrom.y, m.ballTo.y, p) };
  }
  function isMotion(step) { return !step.commentary; }
  function snapshotRender() {
    var players = {};
    S.players.forEach(function (pl) { players[pl.id] = { x: pl.renderX, y: pl.renderY }; });
    return { players: players, ball: { x: S.ball.x, y: S.ball.y } };
  }
  // El plan es el destino acumulado de los pasos pendientes. Sin pasos pendientes
  // parte de lo que se ve en pantalla, para no arrastrar desfases antiguos.
  function planBase() {
    if (!S.plan || (!S.stepTimer && S.queue.length === 0)) S.plan = snapshotRender();
    return S.plan;
  }
  function plannedAt(plan, pl) { return plan.players[pl.id] || { x: pl.renderX, y: pl.renderY }; }
  function placeInPlan(plan, id, point) {
    if (id == null || !point) return;
    var x = Number(point.x), y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    plan.players[id] = { x: clamp(x, .01, .99), y: clamp(y, .02, .98) };
  }
  function planEventStep(ev, plan) {
    var step = { kind: 'event', ms: reduced.matches ? 0 : EVENT_STEP_MS, ball: null, players: {}, important: Boolean(IMPORTANT_EVENTS[ev.type]) };
    var changed = {};
    function move(id, point) { placeInPlan(plan, id, point); if (id != null) changed[id] = true; }
    if (ev.ball) plan.ball = { x: clamp(ev.ball.x, -0.01, 1.01), y: clamp(ev.ball.y, 0, 1) };
    if (ev.playerId != null && ev.actorPosition) move(ev.playerId, ev.actorPosition);
    if (ev.receiverId != null) move(ev.receiverId, ev.ball || plan.ball);
    if (ev.keeperId != null && ev.keeperPosition) move(ev.keeperId, ev.keeperPosition);
    if (ev.type === 'kickoff' || ev.type === 'goal_restart') {
      S.players.forEach(function (pl) {
        var c = plannedAt(plan, pl);
        if (pl.team === 'home' && c.x > 0.485) move(pl.id, { x: 0.485, y: c.y });
        else if (pl.team === 'away' && c.x < 0.515) move(pl.id, { x: 0.515, y: c.y });
      });
      if (ev.playerId != null) move(ev.playerId, { x: 0.5, y: 0.5 });
    }
    // El defensor más cercano al balón se acerca (presión) si hay posesión rival.
    if (ev.ball && !S.playStopped && S.possessionTeam && ['goal_celebration', 'halftime', 'ended'].indexOf(ev.phase) < 0) {
      var defSide = S.possessionTeam === 'home' ? 'away' : 'home';
      var nearest = null, minDist = Infinity;
      S.players.forEach(function (pl) {
        if (pl.team !== defSide || pl.role === 'GK' || pl.id === ev.playerId) return;
        var c = plannedAt(plan, pl);
        var d = Math.hypot(c.x - plan.ball.x, c.y - plan.ball.y);
        if (d < minDist) { minDist = d; nearest = pl; }
      });
      if (nearest) {
        var from = plannedAt(plan, nearest);
        move(nearest.id, { x: from.x + (plan.ball.x - from.x) * 0.35, y: from.y + (plan.ball.y - from.y) * 0.35 });
      }
    }
    Object.keys(changed).forEach(function (id) { step.players[id] = plan.players[id]; });
    step.ball = { x: plan.ball.x, y: plan.ball.y };
    return step;
  }
  function planTickStep(data, plan) {
    var step = { kind: 'tick', ms: reduced.matches ? 0 : TICK_MS, ball: null, players: {}, important: false };
    if (data.ball) plan.ball = { x: clamp(data.ball.x, -0.01, 1.01), y: clamp(data.ball.y, 0, 1) };
    if (Array.isArray(data.players)) {
      data.players.forEach(function (p) {
        if (!p || !p.active || (p.team !== 'home' && p.team !== 'away')) return;
        placeInPlan(plan, p.id, { x: p.x, y: p.y });
        if (plan.players[p.id]) step.players[p.id] = plan.players[p.id];
      });
    } else if (Array.isArray(S.authoritativePlayers) && S.authoritativePlayers.length) {
      // Sin posiciones en este tick: se mantienen las últimas autoritativas conocidas.
      S.authoritativePlayers.forEach(function (p) {
        if (!p || !p.active) return;
        placeInPlan(plan, p.id, { x: p.x, y: p.y });
        if (plan.players[p.id]) step.players[p.id] = plan.players[p.id];
      });
    } else {
      // Sin posiciones del servidor: formación alrededor del balón.
      S.players.forEach(function (pl) {
        if (!pl.slot) return;
        var t = targetFor(pl.slot, pl.mirror, plan.ball.x, plan.ball.y);
        placeInPlan(plan, pl.id, { x: t.x, y: t.y });
        step.players[pl.id] = plan.players[pl.id];
      });
    }
    step.ball = { x: plan.ball.x, y: plan.ball.y };
    return step;
  }
  // Un solo paso de movimiento en vuelo a la vez. Si se acumulan demasiados pasos
  // (pestaña oculta, red lenta), se descartan los de poca relevancia: el siguiente
  // tick reubica a todos. Nunca se acelera la reproducción.
  function enqueueStep(step) {
    if (step.kind === 'tick') S.queue = S.queue.filter(function (s) { return s.kind !== 'tick'; });
    step.queued = Boolean(S.stepTimer) || S.queue.length > 0;
    S.queue.push(step);
    trimMotionBacklog();
    pump();
  }
  function trimMotionBacklog() {
    var motion = S.queue.filter(isMotion).length;
    for (var i = 0; motion > MAX_MOTION_BACKLOG && i < S.queue.length; i++) {
      var s = S.queue[i];
      if (isMotion(s) && !s.important && s.kind !== 'tick') { S.queue.splice(i, 1); i--; motion--; }
    }
  }
  function pump() {
    if (S.stepTimer) return; // un paso está en vuelo; su temporizador vuelve a llamar a pump
    var now = performance.now();
    while (S.queue.length) {
      var step = S.queue.shift();
      if (!isMotion(step)) { appendCommentary(step.commentary); continue; }
      var start = step.queued ? S.busyUntil : now;
      var end = start + step.ms;
      applyMotion(step, start);
      S.busyUntil = end;
      if (end > now) {
        S.stepTimer = setTimeout(function () { S.stepTimer = null; pump(); }, end - now);
        return;
      }
      // Paso ya vencido (pestaña en segundo plano): se aplica su destino y se sigue.
    }
  }
  function applyMotion(step, t0) {
    var now = performance.now();
    var p = motionP(now);
    var from = {}, to = {};
    S.players.forEach(function (pl) {
      var pose = poseOf(pl, p);
      from[pl.id] = pose;
      to[pl.id] = step.players[pl.id] || pose;
    });
    var ballFrom = ballAt(p);
    S.motion = {
      t0: t0, ms: step.ms, from: from, to: to,
      ballFrom: ballFrom, ballTo: step.ball ? { x: step.ball.x, y: step.ball.y } : ballFrom
    };
  }
  function clearMotion() {
    if (S.stepTimer) clearTimeout(S.stepTimer);
    S.stepTimer = null; S.queue = []; S.motion = null; S.plan = null; S.busyUntil = 0;
  }

  // ===== Ciclo de render (60 fps, lineal) =====
  function frame(now) {
    S.rafId = requestAnimationFrame(frame);
    var m = S.motion;
    var p = motionP(now);
    S.ball = ballAt(p);

    var carrier = null;
    if (S.ballCarrierId != null) {
      carrier = S.players.find(function (q) { return q.id === S.ballCarrierId; });
    }

    for (var i = 0; i < S.players.length; i++) {
      var pl = S.players[i];
      var pose = poseOf(pl, p);
      pl.baseX = pose.x; pl.baseY = pose.y;
      if (reduced.matches || S.playStopped) {
        pl.renderX = pl.baseX; pl.renderY = pl.baseY;
      } else if (carrier && pl.id === carrier.id) {
        pl.renderX = pl.baseX; pl.renderY = pl.baseY;
      } else {
        pl.renderX = clamp(pl.baseX + Math.sin(now / 900 + pl.seed) * 0.002, .01, .99);
        pl.renderY = clamp(pl.baseY + Math.cos(now / 1000 + pl.seed * 1.3) * 0.002, .02, .98);
      }
    }

    if (carrier && !S.playStopped) {
      var travel = m ? Math.hypot(m.ballTo.x - m.ballFrom.x, m.ballTo.y - m.ballFrom.y) : 0;
      if (p >= 0.8 || travel < 0.06) {
        var dir = carrier.team === 'home' ? 1 : -1;
        S.ball.x = clamp(carrier.renderX + dir * 0.012, -0.01, 1.01);
        S.ball.y = carrier.renderY;
      }
    }

    draw(now);
  }

  var ctx = null, pitchCanvas = null;
  function initPitchCanvas() {
    var c = el['est-pitch'];
    if (!c || !c.getContext) { el['est-canvas-wrap'].innerHTML = '<p class="est-muted" style="padding:20px">Tu navegador no admite canvas. Usa el texto alternativo del partido más abajo.</p>'; return; }
    ctx = c.getContext('2d');
    pitchCanvas = document.createElement('canvas'); pitchCanvas.width = W; pitchCanvas.height = H;
    drawPitch(pitchCanvas.getContext('2d'));
    S.pitchCache = pitchCanvas;
    if (!S.rafId) S.rafId = requestAnimationFrame(frame);
    drawPlaceholder();
  }
  function drawPlaceholder() {
    if (!ctx) return;
    ctx.drawImage(pitchCanvas, 0, 0);
    ctx.fillStyle = 'rgba(5,9,11,.55)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e5bd72'; ctx.font = '700 30px ' + font();
    ctx.textAlign = 'center'; ctx.fillText('Elige un partido para ver la cancha', W / 2, H / 2);
    ctx.font = '400 16px ' + font(); ctx.fillStyle = '#91a29f';
    ctx.fillText('Liga Estadio MonteCristo · 16 clubes · 30 jornadas', W / 2, H / 2 + 30);
  }

  function drawPitch(g) {
    // Césped con franjas alternas.
    g.fillStyle = '#0a5a45'; g.fillRect(0, 0, W, H);
    var bands = 10;
    for (var i = 0; i < bands; i++) {
      if (i % 2 === 0) continue;
      g.fillStyle = 'rgba(255,255,255,.035)';
      g.fillRect(nx(i / bands), ny(0), nx((i + 1) / bands) - nx(i / bands), FIELD_H);
    }
    g.strokeStyle = 'rgba(153,245,213,.55)'; g.lineWidth = 2;
    // Perímetro.
    g.strokeRect(nx(0), ny(0), FIELD_W, FIELD_H);
    // Mitad de cancha.
    line(g, nx(.5), ny(0), nx(.5), ny(1));
    // Círculo central (9.15 m).
    ellipse(g, nx(.5), ny(.5), 9.15 / 105 * FIELD_W, 9.15 / 68 * FIELD_H);
    dot(g, nx(.5), ny(.5), 3);
    // Áreas y metas en ambos extremos.
    [0, 1].forEach(function (side) {
      var dir = side === 0 ? 1 : -1, gx = side === 0 ? 0 : 1;
      // Área grande 16.5 m × 40.32 m.
      var boxD = 16.5 / 105, boxW = 40.32 / 68;
      var x0 = side === 0 ? nx(0) : nx(1 - boxD), y0 = ny(.5 - boxW / 2);
      g.strokeRect(x0, y0, nx(boxD) - nx(0), ny(.5 + boxW / 2) - y0);
      // Área chica 5.5 m × 18.32 m.
      var sD = 5.5 / 105, sW = 18.32 / 68;
      var sx0 = side === 0 ? nx(0) : nx(1 - sD);
      g.strokeRect(sx0, ny(.5 - sW / 2), nx(sD) - nx(0), ny(.5 + sW / 2) - ny(.5 - sW / 2));
      // Punto penal (11 m).
      dot(g, nx(gx + dir * 11 / 105), ny(.5), 3);
      // Semicírculo del área (9.15 m desde el punto penal).
      g.beginPath();
      var cxp = nx(gx + dir * 11 / 105), rx = 9.15 / 105 * FIELD_W, ry = 9.15 / 68 * FIELD_H;
      g.ellipse(cxp, ny(.5), rx, ry, 0, side === 0 ? -Math.PI / 2.6 : Math.PI - Math.PI / 2.6, side === 0 ? Math.PI / 2.6 : Math.PI + Math.PI / 2.6);
      g.stroke();
      // Meta (7.32 m de ancho).
      var goalW = 7.32 / 68;
      g.fillStyle = 'rgba(229,189,114,.85)';
      var gxx = side === 0 ? nx(0) - 6 : nx(1);
      g.fillRect(gxx, ny(.5 - goalW / 2), 6, ny(.5 + goalW / 2) - ny(.5 - goalW / 2));
      // Arcos de esquina.
      [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(function () {});
    });
    // Arcos de esquina (1 m).
    cornerArc(g, nx(0), ny(0), 0, Math.PI / 2); cornerArc(g, nx(1), ny(0), Math.PI / 2, Math.PI);
    cornerArc(g, nx(1), ny(1), Math.PI, Math.PI * 1.5); cornerArc(g, nx(0), ny(1), Math.PI * 1.5, TAU);
  }
  function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
  function ellipse(g, cx, cy, rx, ry) { g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); g.stroke(); }
  function dot(g, cx, cy, r) { g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fillStyle = 'rgba(153,245,213,.6)'; g.fill(); }
  function cornerArc(g, cx, cy, a0, a1) { g.beginPath(); g.arc(cx, cy, 1 / 105 * FIELD_W, a0, a1); g.stroke(); }

  function draw(now) {
    if (!ctx) return;
    ctx.drawImage(pitchCanvas, 0, 0);
    if (!S.match) { drawPlaceholder(); return; }
    // Destello de gol.
    if (now < S.goalFlashUntil) { ctx.fillStyle = 'rgba(229,189,114,' + (0.18 * (S.goalFlashUntil - now) / 1400) + ')'; ctx.fillRect(0, 0, W, H); }
    // Jugadores (posesión contorneada).
    S.players.forEach(function (pl) {
      var inPoss = S.ballCarrierId != null ? pl.id === S.ballCarrierId : pl.team === S.possessionTeam;
      drawPlayer(pl, inPoss);
    });
    drawBall(now);
  }
  function drawPlayer(pl, inPoss) {
    var cx = nx(pl.renderX), cy = ny(pl.renderY), r = PLAYER_R;
    ctx.beginPath(); ctx.ellipse(cx, cy + r * .55, r * .95, r * .42, 0, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    ctx.fillStyle = pl.kitBase; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    drawKit(pl, cx, cy, r);
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.lineWidth = inPoss ? 2.6 : 1.4;
    ctx.strokeStyle = inPoss ? 'rgba(255,255,255,.95)' : 'rgba(0,0,0,.55)'; ctx.stroke();
    var dir = pl.team === 'home' ? 1 : -1;
    ctx.beginPath(); ctx.arc(cx + dir * (r * 0.72), cy, 2, 0, TAU);
    ctx.fillStyle = inPoss ? '#ffe3a5' : 'rgba(255,255,255,.55)'; ctx.fill();
    ctx.fillStyle = pl.dorsalColor; ctx.font = '700 ' + Math.round(r * .95) + 'px ' + font();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(pl.number), cx, cy + .5);
  }
  function drawKit(pl, cx, cy, r) {
    var s = pl.kitSec; ctx.fillStyle = s;
    if (pl.kitPattern === 'stripes') { for (var i = -2; i <= 2; i++) if (i % 2 !== 0) ctx.fillRect(cx + i * (r / 2.5) - r / 5, cy - r, r / 2.6, r * 2); }
    else if (pl.kitPattern === 'hoops') { for (var j = -1; j <= 1; j += 2) ctx.fillRect(cx - r, cy + j * (r / 2.4) - r / 5, r * 2, r / 2.6); }
    else if (pl.kitPattern === 'sash') { ctx.save(); ctx.translate(cx, cy); ctx.rotate(-Math.PI / 4); ctx.fillRect(-r * .3, -r * 1.5, r * .6, r * 3); ctx.restore(); }
    else if (pl.kitPattern === 'halved') { ctx.fillRect(cx, cy - r, r, r * 2); }
  }
  function drawBall(now) {
    var bx = nx(S.ball.x), by = ny(S.ball.y);
    var m = S.motion;
    var p = motionP(now);
    var dist = m ? Math.hypot(m.ballTo.x - m.ballFrom.x, m.ballTo.y - m.ballFrom.y) : 0;
    if (!reduced.matches && !S.playStopped && m && p < 1 && dist > 0.05) {
      ctx.beginPath();
      ctx.moveTo(nx(m.ballFrom.x), ny(m.ballFrom.y));
      ctx.lineTo(bx, by);
      ctx.strokeStyle = 'rgba(229,189,114,' + (0.18 * (1 - p)) + ')';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(bx, by, BALL_R + 2, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, BALL_R, 0, TAU); ctx.fillStyle = '#ffe3a5'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#0a5a45'; ctx.stroke();
    if (!reduced.matches) { ctx.save(); ctx.translate(bx, by); ctx.rotate(now / 300); ctx.beginPath(); ctx.moveTo(-BALL_R, 0); ctx.lineTo(BALL_R, 0); ctx.strokeStyle = 'rgba(10,90,69,.6)'; ctx.stroke(); ctx.restore(); }
  }

  // ===== Marcador / reloj =====
  function phaseLabel(ph) {
    return ({
      kickoff: 'Inicio', first_half: '1T', halftime: 'Descanso', second_half: '2T',
      build_up: 'En juego', attack: 'Ataque', danger: 'Peligro', set_piece: 'Balón parado',
      goal_celebration: 'Gol', extra_time: 'Prórroga', shootout: 'Penales', ended: 'Final', pre: '—'
    })[ph] || ph;
  }
  function renderScoreboard() {
    if (!S.match) return;
    el['crest-home'].style.background = S.homeKit; el['crest-away'].style.background = S.awayKit;
    el['name-home'].textContent = teamFull(S.match.homeId); el['name-away'].textContent = teamFull(S.match.awayId);
    el['score-home'].textContent = S.score.home; el['score-away'].textContent = S.score.away;
    var live = ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0;
    el['est-clock'].textContent = live ? S.minute + "' " + phaseLabel(S.phase) : (STATUS_LABEL[S.match.status] || '—');
    el['est-market-phase'].textContent = live ? 'En vivo' : 'Pre-partido';
    el['est-pitch'].setAttribute('aria-label', 'Cancha cenital. ' + teamFull(S.match.homeId) + ' ' + S.score.home + ' – ' + S.score.away + ' ' + teamFull(S.match.awayId) + '. Minuto ' + S.minute + ', ' + phaseLabel(S.phase) + '.');
  }

  // ===== Relato =====
  function renderCommentary(list) {
    var box = el['est-commentary']; box.innerHTML = '';
    if (!list || !list.length) { box.innerHTML = '<p class="est-commentary-empty">El relato comenzará cuando arranque el partido…</p>'; return; }
    list.forEach(function (m) { appendCommentary(m, true); });
    box.scrollTop = box.scrollHeight;
  }
  function appendCommentary(m, silentScroll) {
    var box = el['est-commentary'];
    var empty = box.querySelector('.est-commentary-empty'); if (empty) empty.remove();
    var voice = m.voice === 'analista' ? 'analista' : 'narrador';
    var div = document.createElement('div');
    div.className = 'est-cmt ' + voice + (S.muted ? ' muted-all' : '');
    div.innerHTML = '<span class="est-cmt-voice">' + (voice === 'narrador' ? 'Relato' : 'Análisis') + '</span><span class="est-cmt-text">' + esc(m.text) + '</span>';
    box.appendChild(div);
    while (box.children.length > 40) box.removeChild(box.firstChild);
    if (!silentScroll) box.scrollTop = box.scrollHeight;
  }
  function onCommentary(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    var item = { voice: data.voice, text: data.text };
    // El relato de un gol espera a que termine su animación (en la cola, tras el
    // paso del gol); el resto del relato aparece de inmediato, como antes.
    if (S.lastEventGoal && (S.stepTimer || S.queue.length)) enqueueStep({ commentary: item });
    else appendCommentary(item);
  }

  // ===== Eventos del motor =====
  function onTick(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    var wasStopped = S.playStopped;
    S.minute = Math.round(data.displayMinute != null ? data.displayMinute : (data.minute != null ? data.minute : S.minute));
    S.phase = data.phase || S.phase;
    if (data.score) S.score = data.score;
    if (data.possession) S.possession = data.possession;
    if (Object.prototype.hasOwnProperty.call(data, 'possessionTeam')) S.possessionTeam = data.possessionTeam;
    if (Object.prototype.hasOwnProperty.call(data, 'ballCarrierId')) S.ballCarrierId = data.ballCarrierId;
    if (Object.prototype.hasOwnProperty.call(data, 'playStopped')) S.playStopped = Boolean(data.playStopped);
    if (Array.isArray(data.players)) syncAuthoritativePlayers(data.players, true);
    enqueueStep(planTickStep(data, planBase()));
    renderScoreboard();
    updateTextFallback();
    if (wasStopped !== S.playStopped) {
      renderMarkets();
      renderMyBets();
    }
  }
  function applyRosterEvent(ev) {
    if (!Array.isArray(S.authoritativePlayers)) return;
    var outgoing = ev.playerOutId && S.authoritativePlayers.find(function (p) { return p.id === ev.playerOutId; });
    if ((ev.type === 'red_card' || ev.type === 'second_yellow') && ev.playerId) {
      var dismissed = S.authoritativePlayers.find(function (p) { return p.id === ev.playerId; });
      if (dismissed) { dismissed.active = false; dismissed.status = 'sent_off'; }
      if (S.ballCarrierId === ev.playerId) S.ballCarrierId = null;
    } else if (ev.type === 'substitution') {
      var incomingId = ev.playerInId || ev.playerId;
      var incoming = incomingId && S.authoritativePlayers.find(function (p) { return p.id === incomingId; });
      var visibleOutgoing = outgoing && S.players.find(function (p) { return p.id === outgoing.id; });
      if (outgoing) {
        outgoing.active = false; outgoing.status = 'substituted';
        if (S.ballCarrierId === outgoing.id) S.ballCarrierId = null;
      }
      if (incoming) {
        incoming.active = true; incoming.status = 'active';
        incoming.slotIndex = outgoing ? outgoing.slotIndex : incoming.slotIndex;
        incoming.role = outgoing ? outgoing.role : incoming.role;
        if (visibleOutgoing) { incoming.x = visibleOutgoing.renderX; incoming.y = visibleOutgoing.renderY; }
        else if (outgoing) { incoming.x = outgoing.x; incoming.y = outgoing.y; }
      }
    } else return;
    syncAuthoritativePlayers(S.authoritativePlayers, true);
  }

  function onEvent(data) {
    if (!data || data.matchId !== S.currentMatchId || !data.event) return;
    var ev = data.event;
    var wasStopped = S.playStopped;
    if (Object.prototype.hasOwnProperty.call(ev, 'possessionTeam')) S.possessionTeam = ev.possessionTeam;
    if (Object.prototype.hasOwnProperty.call(ev, 'ballCarrierId')) S.ballCarrierId = ev.ballCarrierId;
    if (Object.prototype.hasOwnProperty.call(ev, 'playStopped')) S.playStopped = Boolean(ev.playStopped);
    if (ev.phase) S.phase = ev.phase;
    if (ev.minute != null) S.minute = ev.minute;
    applyRosterEvent(ev);
    S.lastEventGoal = ev.type === 'goal' || ev.type === 'penalty_scored';
    enqueueStep(planEventStep(ev, planBase()));
    if (S.lastEventGoal) {
      S.goalFlashUntil = performance.now() + 1400;
      showGoalBanner();
      if (ev.marcador) { var parts = String(ev.marcador).split('-'); if (parts.length === 2) { S.score = { home: Number(parts[0]) || 0, away: Number(parts[1]) || 0 }; } }
      playSfx('goal');
    } else if (WHISTLE_EVENTS[ev.type]) {
      playSfx(WHISTLE_EVENTS[ev.type]);
    } else if (ev.type === 'red_card' || ev.type === 'second_yellow') {
      bell('card');
    }
    renderScoreboard();
    updateTextFallback();
    if (wasStopped !== S.playStopped) {
      renderMarkets();
      renderMyBets();
    }
  }
  function showGoalBanner() {
    var b = el['est-goal-banner']; b.classList.add('show'); b.setAttribute('aria-hidden', 'false');
    setTimeout(function () { b.classList.remove('show'); b.setAttribute('aria-hidden', 'true'); }, 2200);
  }
  function onStatus(data) {
    if (!data || data.matchId !== S.currentMatchId || !S.match) return;
    var code = data.code;
    if (code === 'postponed') {
      toast('Partido pospuesto. Tus apuestas fueron reembolsadas.', 'lose');
      S.match.status = 'postponed';
      S.playStopped = true;
    } else if (code === 'kickoff' || code === 'late_kickoff' || code === 'match_started' || code === 'live') {
      S.match.status = 'live';
      if (code === 'live' || code === 'match_started') S.playStopped = false;
      var liveMarket = S.markets['1x2'];
      S.markets = liveMarket ? { '1x2': liveMarket } : {};
      if (S.slip && S.slip.market !== '1x2') {
        S.slip = null;
        el['est-bet-slip'].hidden = true;
        betMsg('La boleta pre-partido se cerró al iniciar el juego.', false);
      }
    } else if (code === 'halftime' || code === 'extra_time' || code === 'shootout') {
      S.match.status = code;
      S.playStopped = code === 'halftime' || code === 'shootout';
      var currentLiveMarket = S.markets['1x2'];
      S.markets = currentLiveMarket ? { '1x2': currentLiveMarket } : {};
    } else if (code === 'full_time' || code === 'settled' || code === 'finished') {
      S.match.status = 'finished';
      S.playStopped = true;
      S.ballCarrierId = null;
    } else if (code === 'rescheduled') {
      if (data.scheduledKickoffAt != null && Number.isFinite(Number(data.scheduledKickoffAt))) {
        S.match.scheduledKickoffAt = Number(data.scheduledKickoffAt);
      }
      if (data.day != null) S.match.day = data.day;
      if (data.block != null) S.match.block = data.block;
      updateLobbyMatchKickoff(data.matchId, data.scheduledKickoffAt, data.day, data.block);
      toast('Horario del partido reprogramado.', 'info');
    }
    renderScoreboard();
    renderMarkets();
    renderMyBets();
    updateTextFallback();
    renderPreshow(currentServerTime());
  }

  function onRescheduled(data) {
    if (!data) return;
    updateLobbyMatchKickoff(data.matchId, data.scheduledKickoffAt, data.day, data.block);
    if (S.currentMatchId === data.matchId && S.match) {
      if (data.scheduledKickoffAt != null && Number.isFinite(Number(data.scheduledKickoffAt))) {
        S.match.scheduledKickoffAt = Number(data.scheduledKickoffAt);
      }
      if (data.day != null) S.match.day = data.day;
      if (data.block != null) S.match.block = data.block;
    }
    if (S.lobby) renderLobby(S.lobby);
    else renderPreshow(currentServerTime());
  }

  // ===== Cuotas =====
  var MARKET_LABEL = {
    '1x2': 'Resultado (1X2)', 'double_chance': 'Doble oportunidad', 'handicap_home_minus1': 'Hándicap local −1',
    'handicap_home_plus1': 'Hándicap local +1', 'over_under_1.5': 'Goles 1.5', 'over_under_2.5': 'Goles 2.5',
    'over_under_3.5': 'Goles 3.5', 'btts': 'Ambos anotan', 'correct_score': 'Marcador exacto',
    'win_to_nil_home': 'Local gana a cero', 'win_to_nil_away': 'Visita gana a cero',
    'team_total_home_0.5': 'Goles local 0.5', 'team_total_home_1.5': 'Goles local 1.5',
    'team_total_away_0.5': 'Goles visita 0.5', 'team_total_away_1.5': 'Goles visita 1.5'
  };
  function selLabel(market, key) {
    var map = { home: 'Local', draw: 'Empate', away: 'Visita', over: 'Más', under: 'Menos', yes: 'Sí', no: 'No', other: 'Otro' };
    if (map[key]) return map[key];
    if (market === 'double_chance') return ({ home_draw: 'Local o Empate', home_away: 'Local o Visita', draw_away: 'Empate o Visita' })[key] || key;
    if (market.indexOf('handicap') === 0) return ({ home: 'Local −1', draw: 'Empate hándicap', away: 'Visita +1' })[key] || key;
    return key;
  }
  function onOdds(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    S.markets[data.market] = data.selections || [];
    (data.selections || []).forEach(function (s) {
      var mk = data.market + ':' + s.key;
      var prev = S.movement[mk] && S.movement[mk].price;
      S.movement[mk] = { price: s.price, dir: prev == null ? 'flat' : (s.price > prev ? 'up' : s.price < prev ? 'down' : 'flat') };
    });
    renderMarkets();
  }
  function renderMarkets() {
    var box = el['est-markets'];
    var keys = Object.keys(S.markets || {});
    var ended = S.match && ['settled', 'finished', 'postponed'].indexOf(S.match.status) >= 0;
    var live = S.match && ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0;
    var suspended = Boolean(live && S.playStopped);
    if (el['est-place-bet']) el['est-place-bet'].disabled = Boolean(S.submitting || ended || suspended || !S.slip);
    if (!keys.length) { box.innerHTML = '<p class="est-muted">' + (ended ? 'Partido finalizado: mercados cerrados.' : 'Sin mercados disponibles todavía.') + '</p>'; return; }
    box.innerHTML = '';
    if (suspended) {
      var notice = document.createElement('p'); notice.className = 'est-muted';
      notice.textContent = 'Mercado suspendido mientras el juego está detenido.';
      box.appendChild(notice);
    }
    // Una sola selección por categoría: los mercados donde ya hay una apuesta abierta
    // quedan bloqueados (el servidor también lo valida; esto solo evita el clic).
    var taken = {};
    (S.myBets || []).forEach(function (b) { if (b.status === 'open') taken[b.market] = b.selection; });
    keys.forEach(function (mk) {
      var sels = S.markets[mk] || []; if (!sels.length) return;
      var lockedBy = taken[mk];
      var group = document.createElement('div'); group.className = 'est-market-group';
      var head = document.createElement('div'); head.className = 'est-market-name'; head.textContent = MARKET_LABEL[mk] || mk; group.appendChild(head);
      var row = document.createElement('div'); row.className = 'est-selections';
      sels.forEach(function (s) {
        var mv = S.movement[mk + ':' + s.key];
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'est-sel' + (S.slip && S.slip.market === mk && S.slip.selection === s.key ? ' selected' : '');
        var locked = lockedBy !== undefined && lockedBy !== s.key;
        btn.disabled = ended || suspended || locked;
        if (suspended) btn.title = 'Mercado suspendido durante la pausa del juego.';
        else if (locked) btn.title = 'Ya apostaste en esta categoría. Solo se permite una selección por mercado.';
        var arrow = mv && mv.dir === 'up' ? '<span class="est-sel-move up">▲</span>' : mv && mv.dir === 'down' ? '<span class="est-sel-move down">▼</span>' : '';
        btn.innerHTML = '<span class="est-sel-key">' + esc(selLabel(mk, s.key)) + '</span>' +
          '<span class="est-sel-odds">' + Number(s.price).toFixed(2) + arrow + '</span>' +
          '<span class="est-sel-implied">impl. ' + pct(s.implied) + '</span>';
        btn.setAttribute('aria-label', (MARKET_LABEL[mk] || mk) + ' ' + selLabel(mk, s.key) + ', cuota ' + Number(s.price).toFixed(2) + ', probabilidad implícita ' + pct(s.implied));
        btn.addEventListener('click', function () { if (!ended && !suspended && !locked) openSlip(mk, s); });
        row.appendChild(btn);
      });
      group.appendChild(row); box.appendChild(group);
    });
  }

  // ===== Boleta =====
  function stakeBounds() {
    var chips = Math.floor(S.chips || 0);
    var max = Math.min(Math.floor(chips * STAKE_MAX_FRAC), STAKE_ABS_MAX);
    var min = Math.min(Math.max(1, Math.floor(chips * STAKE_MIN_FRAC)), chips);
    if (min > max) { min = max; }
    return { min: Math.max(0, Math.floor(min)), max: Math.max(0, Math.floor(max)) };
  }
  function openSlip(market, sel) {
    S.slip = { market: market, selection: sel.key, price: sel.price, implied: sel.implied };
    el['est-bet-slip'].hidden = false;
    el['est-slip-pick'].textContent = (MARKET_LABEL[market] || market) + ' · ' + selLabel(market, sel.key);
    el['est-slip-odds'].textContent = Number(sel.price).toFixed(2);
    el['est-slip-implied'].textContent = pct(sel.implied);
    var b = stakeBounds();
    el['est-stake'].min = b.min || 1; el['est-stake'].max = b.max || 1;
    el['est-slip-range'].textContent = 'Mín ' + fmt(b.min) + ' · Máx ' + fmt(b.max) + ' (10 %–50 % de tu saldo)';
    el['est-stake'].value = '';
    renderDenoms(b);
    renderMarkets();
    el['est-stake'].focus();
  }
  function renderDenoms(b) {
    var box = el['est-denoms']; box.innerHTML = '';
    DENOMS.filter(function (d) { return d >= b.min && d <= b.max; }).forEach(function (d) {
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'est-denom'; btn.textContent = fmt(d);
      btn.addEventListener('click', function () {
        var cur = Number(el['est-stake'].value || 0);
        el['est-stake'].value = Math.min(b.max, cur + d);
      });
      box.appendChild(btn);
    });
    if (b.max > 0) {
      var maxBtn = document.createElement('button'); maxBtn.type = 'button'; maxBtn.className = 'est-denom'; maxBtn.textContent = 'Máx';
      maxBtn.addEventListener('click', function () { el['est-stake'].value = b.max; });
      box.appendChild(maxBtn);
    }
  }
  function closeSlip() { S.slip = null; el['est-bet-slip'].hidden = true; renderMarkets(); }
  function placeBet() {
    if (!S.slip || S.submitting) return;
    if (S.match && ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0 && S.playStopped) {
      betMsg('Mercado suspendido mientras el juego está detenido.', false);
      return;
    }
    var stake = Math.floor(Number(el['est-stake'].value || 0));
    var b = stakeBounds();
    if (stake < b.min || stake > b.max) { betMsg('Monto fuera de rango (' + fmt(b.min) + '–' + fmt(b.max) + ').', false); return; }
    S.submitting = true; el['est-place-bet'].disabled = true; betMsg('Enviando…', true);
    S.socket.emit('football:bet', { matchId: S.currentMatchId, market: S.slip.market, selection: S.slip.selection, stake: stake }, function (res) {
      S.submitting = false;
      renderMarkets();
      if (!res || !res.ok) { betMsg(humanError(res && res.code), false); return; }
      S.chips = res.chips; updateChips();
      if (res.bet) S.myBets.push(res.bet);
      renderMyBets();
      betMsg('¡Apuesta colocada! ' + fmt(stake) + ' fichas a ' + Number(res.bet.odds).toFixed(2) + '.', true);
      bell('bet');
      closeSlip();
    });
  }
  function betMsg(text, ok) { el['est-bet-msg'].textContent = text; el['est-bet-msg'].className = 'est-bet-msg ' + (ok ? 'ok' : 'err'); }
  function humanError(code) {
    return ({
      no_identity: 'Vuelve a entrar al Estadio (sesión no resuelta).', insufficient_chips: 'Saldo insuficiente.',
      stake_bajo_minimo: 'Monto por debajo del mínimo (10 % de tu saldo).', stake_sobre_maximo: 'Monto sobre el tope (50 % del saldo o 25 000).',
      market_suspended: 'Mercado suspendido momentáneamente.', selection_closed: 'Mercado cerrado.',
      match_ended: 'El partido ya terminó.', rate_limit: 'Demasiadas apuestas seguidas; espera un momento.',
      window_cerrada: 'Fuera de la ventana de apuestas.', no_match: 'Partido no encontrado.',
      mercado_ya_apostado: 'Ya apostaste en esta categoría: solo se permite una selección por mercado.'
    })[code] || ('No se pudo apostar (' + (code || 'error') + ').');
  }

  function humanCashoutError(code) {
    return ({
      market_not_cashable: 'Este mercado no admite cash-out en vivo (solo 1X2).',
      price_unavailable: 'Precio no disponible en este momento; intenta de nuevo en unos segundos.',
      market_suspended: 'Cash-out suspendido momentáneamente.', match_ended: 'El partido ya terminó.',
      not_open: 'Esta apuesta ya no está abierta.', not_your_bet: 'Apuesta no encontrada.',
      no_identity: 'Vuelve a entrar al Estadio (sesión no resuelta).', rate_limit: 'Demasiadas acciones seguidas; espera un momento.'
    })[code] || ('No se pudo cobrar la apuesta (' + (code || 'error') + ').');
  }

  // ===== Mis apuestas + liquidación =====
  function renderMyBets() {
    var box = el['est-mybets']; box.innerHTML = '';
    var open = (S.myBets || []).filter(function (b) { return b.status === 'open'; });
    if (!open.length) { box.innerHTML = '<li class="est-muted">Sin apuestas abiertas.</li>'; return; }
    open.forEach(function (b) {
      var li = document.createElement('li'); li.className = 'est-mybet';
      li.innerHTML = '<span class="est-mybet-pick">' + esc(selLabel(b.market, b.selection)) + '</span>' +
        '<span class="est-mybet-odds">' + Number(b.odds).toFixed(2) + '</span>' +
        '<span class="est-mybet-meta">' + esc(MARKET_LABEL[b.market] || b.market) + ' · ' + fmt(b.stake) + ' fichas' + (b.inPlay ? ' · en vivo ' + b.minuteAtPlacement + "'" : '') + '</span>' +
        '<span class="est-mybet-meta">Paga ' + fmt(b.potentialPayout) + '</span>';
      var inPlayNow = S.match && ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0;
      if (b.status === 'open' && inPlayNow && b.market !== '1x2') {
        var note = document.createElement('span'); note.className = 'est-mybet-meta';
        note.textContent = 'Cash-out no disponible en vivo para este mercado (solo 1X2).';
        li.appendChild(note);
      } else if (b.status === 'open' && inPlayNow) {
        var co = document.createElement('button'); co.type = 'button'; co.className = 'est-cashout'; co.textContent = 'Cobrar ahora (cash-out)';
        co.disabled = Boolean(S.playStopped);
        if (S.playStopped) co.title = 'Cash-out suspendido durante la pausa del juego.';
        co.addEventListener('click', function () { cashout(b.id, co); });
        li.appendChild(co);
      }
      box.appendChild(li);
    });
  }
  function cashout(betId, btn) {
    if (S.playStopped) { toast('Cash-out suspendido durante la pausa del juego.', ''); return; }
    btn.disabled = true; btn.textContent = 'Cobrando…';
    S.socket.emit('football:cashout', { betId: betId }, function (res) {
      if (!res || !res.ok) { btn.disabled = false; btn.textContent = 'Cobrar ahora (cash-out)'; toast(humanCashoutError(res && res.code), 'lose'); return; }
      S.chips = res.chips; updateChips();
      S.myBets = S.myBets.filter(function (b) { return b.id !== betId; });
      renderMyBets();
      toast('Cash-out: +' + fmt(res.cashout) + ' fichas.', 'win'); bell('win');
    });
  }
  function onSettlement(data) {
    if (!data) return;
    var won = data.status === 'won';
    S.myBets = S.myBets.filter(function (b) { return b.id !== data.betId; });
    renderMyBets();
    if (won) { S.chips += Number(data.payout || 0); toast('¡Apuesta ganada! +' + fmt(data.payout) + ' fichas.', 'win'); bell('win'); }
    else if (data.status === 'lost') { toast('Apuesta perdida' + (data.reason ? ': ' + data.reason : '') + '.', 'lose'); }
    else { toast('Apuesta ' + (data.status === 'void' ? 'anulada (reembolso)' : data.status) + '.', ''); }
    updateChips();
    // Refresca saldo autoritario del servidor en la siguiente pintura de lobby.
  }
  function updateChips() { el['est-chips'].textContent = fmt(S.chips) + ' fichas'; }

  // ===== Accesibilidad: texto alternativo =====
  function updateTextFallback() {
    if (!S.match) { el['est-text-state'].textContent = 'Sin partido seleccionado.'; return; }
    el['est-text-state'].textContent = teamFull(S.match.homeId) + ' ' + S.score.home + ' – ' + S.score.away + ' ' + teamFull(S.match.awayId) +
      '. Minuto ' + S.minute + ' (' + phaseLabel(S.phase) + '). Posesión ' + pct(S.possession.home) + ' local. Estado: ' + (STATUS_LABEL[S.match.status] || S.match.status) + '.';
  }

  // ===== Toast + campana =====
  var toastTimer = null;
  function toast(text, kind) {
    var t = el['est-toast']; t.textContent = text; t.className = 'est-toast ' + (kind || ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4200);
  }
  var actx = null;
  // Efectos sintetizados con Web Audio (sin archivos ni licencias).
  // Silbato: tono agudo con vibrato leve y armónicos + aliento de ruido.
  // Público: ruido rosado filtrado con envolvente lenta, más un acorde de subida.
  var noiseBuffer = null;
  function audioCtx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended' && actx.resume) actx.resume();
    return actx;
  }
  function getNoise(ctx) {
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    var len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0; // filtro de ruido rosado (Paul Kellet)
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179; b1 = 0.99332 * b1 + white * 0.0750759; b2 = 0.969 * b2 + white * 0.153852;
      data[i] = (b0 + b1 + b2 + white * 0.5362) * 0.11;
    }
    noiseBuffer = buf; return buf;
  }
  function whistle(ctx, t0, dur, gain) {
    var base = ctx.createOscillator(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain(), g = ctx.createGain();
    var h2 = ctx.createOscillator(), h2g = ctx.createGain();
    base.type = 'sine'; base.frequency.setValueAtTime(2550, t0); base.frequency.linearRampToValueAtTime(2700, t0 + dur * 0.4);
    base.frequency.linearRampToValueAtTime(2620, t0 + dur);
    lfo.type = 'sine'; lfo.frequency.value = 36; lfoGain.gain.value = 55; lfo.connect(lfoGain); lfoGain.connect(base.frequency);
    h2.type = 'sine'; h2.frequency.value = 5100; h2g.gain.value = 0.22; h2.connect(h2g); h2g.connect(g);
    base.connect(g); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.03); g.gain.setValueAtTime(gain, t0 + dur - 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(ctx.destination);
    var breath = ctx.createBufferSource(), bf = ctx.createBiquadFilter(), bg = ctx.createGain();
    breath.buffer = getNoise(ctx); bf.type = 'bandpass'; bf.frequency.value = 3200; bf.Q.value = 6;
    bg.gain.setValueAtTime(0.0001, t0); bg.gain.exponentialRampToValueAtTime(gain * 0.3, t0 + 0.04); bg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    breath.connect(bf); bf.connect(bg); bg.connect(ctx.destination);
    [base, lfo, h2].forEach(function (o) { o.start(t0); o.stop(t0 + dur + 0.05); });
    breath.start(t0); breath.stop(t0 + dur + 0.05);
  }
  function crowdRoar(ctx, t0) {
    var src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = getNoise(ctx); src.loop = true;
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.25);
    g.gain.setValueAtTime(0.5, t0 + 1.1); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.4);
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(t0); src.stop(t0 + 2.5);
    [523.25, 659.25, 783.99].forEach(function (f, i) {
      var o = ctx.createOscillator(), og = ctx.createGain(), start = t0 + 0.15 + i * 0.09;
      o.type = 'triangle'; o.frequency.value = f; og.gain.setValueAtTime(0.0001, start);
      og.gain.exponentialRampToValueAtTime(0.07, start + 0.04); og.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
      o.connect(og); og.connect(ctx.destination); o.start(start); o.stop(start + 1);
    });
  }
  function playSfx(kind) {
    if (!S.soundOn) return;
    try {
      var ctx = audioCtx(), t0 = ctx.currentTime + 0.01;
      if (kind === 'whistle') whistle(ctx, t0, 0.55, 0.16);
      else if (kind === 'final_whistle') { whistle(ctx, t0, 0.5, 0.16); whistle(ctx, t0 + 0.65, 0.5, 0.16); whistle(ctx, t0 + 1.3, 0.9, 0.16); }
      else if (kind === 'goal') { crowdRoar(ctx, t0); whistle(ctx, t0, 0.35, 0.12); }
    } catch (e) { /* audio no disponible */ }
  }
  var WHISTLE_EVENTS = { kickoff: 'whistle', goal_restart: 'whistle', halftime: 'whistle', second_half: 'whistle', full_time: 'final_whistle' };

  function bell(kind) {
    if (!S.soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      var freq = kind === 'goal' ? 880 : kind === 'win' ? 1046 : 660;
      o.type = 'sine'; o.frequency.value = freq; g.gain.value = 0.0001;
      o.connect(g); g.connect(actx.destination); var t = actx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.start(t); o.stop(t + 0.52);
    } catch (e) { /* audio no disponible */ }
  }

  function updatePromotionRoomField() {
    var useRoom = el['est-promo-target'].value === '/room';
    el['est-promo-room-field'].hidden = !useRoom;
    el['est-promo-room-code'].required = useRoom;
  }
  var PROMO_IMAGE_MAX_BYTES = 350 * 1024;
  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }
  function submitPromotion(event) {
    event.preventDefault();
    if (!S.promoProfile || !S.promoProfile.username || !S.promoCsrfToken) {
      setPromoMessage('Inicia sesión con una cuenta vinculada y vuelve a verificar la sesión.', 'error');
      return;
    }
    if (!S.currentMatchId || !S.promoWindowOpen) {
      setPromoMessage('El envío solo está disponible durante los últimos 30 minutos antes del kickoff.', 'error');
      return;
    }
    var targetPath = el['est-promo-target'].value;
    if (targetPath === '/room') {
      var code = el['est-promo-room-code'].value.trim().toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code)) {
        setPromoMessage('Escribe un código de sala de cinco caracteres.', 'error');
        el['est-promo-room-code'].focus();
        return;
      }
      targetPath = '/room/' + code;
    }
    var imageFile = el['est-promo-image-input'] && el['est-promo-image-input'].files && el['est-promo-image-input'].files[0];
    if (imageFile && (imageFile.size > PROMO_IMAGE_MAX_BYTES || !/^image\/(png|jpeg)$/.test(imageFile.type))) {
      setPromoMessage('La imagen debe ser PNG o JPEG de máximo 350 KB.', 'error');
      return;
    }
    var button = el['est-promo-submit'];
    button.disabled = true;
    setPromoMessage('Enviando a revisión; no se cobran fichas al enviar…', '');
    var payload = { matchId: S.currentMatchId, text: el['est-promo-copy-input'].value, targetPath: targetPath };
    var imageReady = imageFile ? readFileAsDataUrl(imageFile) : Promise.resolve(null);
    imageReady.then(function (dataUrl) {
      if (dataUrl) payload.image = dataUrl;
      return fetch('/api/estadio/promotions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': S.promoCsrfToken },
        body: JSON.stringify(payload)
      });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { ok: response.ok, data: data };
      });
    }).then(function (result) {
      button.disabled = false;
      if (!result.ok) {
        setPromoMessage(result.data.error || 'No se pudo enviar la promoción.', 'error');
        if (result.data.code === 'account_session_required') refreshPromotionSession();
        return;
      }
      el['est-promo-copy-input'].value = '';
      setPromoMessage('Enviada y pendiente de revisión. No se han cobrado fichas.', 'success');
      loadOwnPromotion(S.currentMatchId);
    }).catch(function () {
      button.disabled = false;
      setPromoMessage('No se pudo contactar al servidor. Inténtalo de nuevo.', 'error');
    });
  }

  // ===== UI: enlaces, atajos, TOS =====
  function bindUI() {
    el['est-tos-accept'].addEventListener('click', function () {
      localStorage.setItem(TOS_KEY, S.tosVersion); el['est-tos'].hidden = true; connect();
    });
    el['est-promo-refresh'].addEventListener('click', refreshPromotionSession);
    el['est-promo-form'].addEventListener('submit', submitPromotion);
    el['est-promo-target'].addEventListener('change', updatePromotionRoomField);
    updatePromotionRoomField();
    el['est-slip-clear'].addEventListener('click', closeSlip);
    el['est-place-bet'].addEventListener('click', placeBet);
    el['est-stake'].addEventListener('keydown', function (e) { if (e.key === 'Enter') placeBet(); });
    el['est-sound'].addEventListener('click', function () {
      S.soundOn = !S.soundOn; el['est-sound'].setAttribute('aria-pressed', String(!S.soundOn));
      localStorage.setItem('montecristo-notifications', S.soundOn ? 'on' : 'off');
      toast(S.soundOn ? 'Campana activada.' : 'Campana silenciada.', '');
    });
    el['est-music'].addEventListener('click', function () {
      S.musicOn = !S.musicOn;
      localStorage.setItem('montecristo-music', S.musicOn ? 'on' : 'off');
      syncMusic();
      toast(S.musicOn ? 'Música de ambiente activada.' : 'Música de ambiente apagada.', '');
    });
    el['est-music'].setAttribute('aria-pressed', String(S.musicOn));
    el['est-music'].setAttribute('aria-label', S.musicOn ? 'Apagar música de ambiente' : 'Activar música de ambiente');
    // Si la música ya estaba activada al cargar, arranca con el primer gesto del usuario.
    document.addEventListener('pointerdown', function firstGesture() {
      document.removeEventListener('pointerdown', firstGesture);
      if (S.musicOn) syncMusic();
    });
    el['est-sound'].setAttribute('aria-pressed', String(!S.soundOn));
    el['est-help-close'].addEventListener('click', function () { el['est-help'].hidden = true; });
    document.addEventListener('keydown', onKey);
    setInterval(tickCountdown, 1000); tickCountdown();
  }
  // Música de ambiente de estadio: un solo bucle, solo con el sonido activado por el usuario.
  var music = null;
  function syncMusic() {
    if (!music) {
      music = new Audio('/assets/match-ambience.mp3');
      music.loop = true; music.preload = 'auto'; music.volume = 0.32;
    }
    if (S.musicOn) {
      var p = music.play();
      if (p && typeof p.catch === 'function') p.catch(function () { /* sin gesto aún: se reintenta en el siguiente */ });
    } else {
      music.pause();
    }
    if (el['est-music']) {
      el['est-music'].setAttribute('aria-pressed', String(S.musicOn));
      el['est-music'].setAttribute('aria-label', S.musicOn ? 'Apagar música de ambiente' : 'Activar música de ambiente');
    }
  }
  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    var k = e.key.toLowerCase();
    if (k === 'm') { toggleMute(); }
    else if (k === 'o') { e.preventDefault(); el['est-markets'].focus && el['est-markets'].focus(); var first = el['est-markets'].querySelector('.est-sel'); if (first) first.focus(); }
    else if (k === 'b') { e.preventDefault(); if (!el['est-bet-slip'].hidden) el['est-stake'].focus(); else toast('Elige una cuota para abrir la boleta.', ''); }
    else if (k === '?' || (e.shiftKey && k === '/')) { e.preventDefault(); el['est-help'].hidden = false; }
    else if (k === 'escape') { el['est-help'].hidden = true; if (!el['est-tos'].hidden && tosAccepted()) el['est-tos'].hidden = true; }
  }
  function toggleMute() {
    S.muted = !S.muted;
    Array.prototype.forEach.call(el['est-commentary'].querySelectorAll('.est-cmt'), function (n) { n.classList.toggle('muted-all', S.muted); });
    toast(S.muted ? 'Relato silenciado.' : 'Relato activado.', '');
  }
  function highlightActive() {
    // renderLobby marca el partido activo (m.id === S.currentMatchId) de forma fiable.
    if (S.lobby) renderLobby(S.lobby);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
