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
  var PRESHOW_WINDOW_MS = 30 * 60 * 1000;
  var PROMOTION_ROTATION_MS = 15 * 1000;
  var SHOWCASE_ROTATION_MS = PROMOTION_ROTATION_MS;
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
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
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
    preshowDataMatchId: null, preshowDataStandings: null, teamIndicators: [],
    showcaseItems: [], showcaseIndex: 0, showcaseRotationId: null, sponsoredPromotions: [],
    promotionsEnabled: false, promoSessionChecked: false, promoProfile: null, promoCsrfToken: null,
    promoWindowOpen: false, promoMatchId: null, promoPollId: null, promoRequestSeq: 0,
    currentMatchId: null, match: null, markets: {}, movement: {}, myBets: [],
    betHistory: null, betHistoryFetchedAt: 0, betsUnseen: null, betsLoading: false, betsError: null,
    betsOnlyMatch: false, betsRequestSeq: 0, ledgerFilter: 'all', ledgerTrigger: null,
    slip: null, muted: false, soundOn: localStorage.getItem('montecristo-notifications') !== 'off', musicOn: localStorage.getItem('montecristo-music') === 'on',
    players: [], authoritativePlayers: [], possessionTeam: 'home', ballCarrierId: null, playStopped: true,
    ball: { x: .5, y: .5 }, ballStart: { x: .5, y: .5 }, ballDest: { x: .5, y: .5 },
    ballT0: 0, ballDur: 800, playerT0: 0, playerDur: 1900,
    serverMinute: 0, minuteReceivedAt: 0,
    minute: 0, phase: 'pre', score: { home: 0, away: 0 }, possession: { home: .5, away: .5 },
    goalFlashUntil: 0, goalAnimUntil: 0, homeKit: '#52e0ae', awayKit: '#ff667c', rafId: null, pitchCache: null, submitting: false
  };

  var el = {};
  function cacheEls() {
    ['est-connection', 'est-chips', 'est-sound', 'est-music', 'est-ads', 'est-ads-open', 'est-countdown', 'est-match-list', 'est-standings',
      'est-preshow', 'est-preshow-status', 'est-preshow-timer', 'est-showcase', 'est-showcase-track',
      'est-compare-home', 'est-compare-away', 'est-showcase-count', 'est-showcase-prev', 'est-showcase-next', 'est-showcase-dots', 'est-preshow-promo', 'est-promo-image', 'est-promo-label', 'est-promo-text', 'est-promo-link',
      'est-promo-compose', 'est-promo-auth', 'est-promo-login', 'est-promo-refresh', 'est-promo-form',
      'est-studio-card-preview', 'est-studio-preview-img', 'est-studio-preview-size', 'est-studio-preview-label', 'est-studio-preview-text', 'est-studio-preview-btn',
      'est-promo-char-count', 'est-promo-text-pos', 'est-promo-text-size', 'est-promo-text-align', 'est-promo-theme-color', 'est-promo-cta-input',
      'est-upload-dropzone', 'est-dropzone-file-name', 'est-dropzone-clear-btn', 'est-studio-text-fields', 'est-studio-presets-row',
      'est-promo-copy-input', 'est-promo-image-input', 'est-promo-target', 'est-promo-room-field', 'est-promo-room-code',
      'est-promo-submit', 'est-promo-message',
      'est-scoreboard', 'crest-home', 'crest-away', 'name-home', 'name-away', 'score-home', 'score-away',
      'est-clock', 'est-pitch', 'est-goal-banner', 'est-commentary', 'est-text-state', 'est-market-phase',
      'est-markets', 'est-bet-slip', 'est-slip-pick', 'est-slip-clear', 'est-slip-odds', 'est-slip-implied',
      'est-stake', 'est-denoms', 'est-slip-range', 'est-place-bet', 'est-bet-msg', 'est-mybets',
      'est-mybets-count', 'est-bets-link-note', 'est-bets-link-dot',
      'est-nav-badge', 'est-ledger', 'est-ledger-title', 'est-ledger-unseen', 'est-ledger-stats', 'est-ledger-chips',
      'est-ledger-list', 'est-ledger-only-match', 'est-ledger-refresh', 'est-ledger-close', 'est-ledger-back',
      'est-help',
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

  // Publicidad: visible siempre para explicar el proceso; el formulario solo se abre
  // para un patrocinador (o admin) con un partido dentro de su ventana de 30 minutos.
  function updatePromotionComposer() {
    var section = el['est-ads'], details = el['est-promo-compose'];
    if (!section || !details) return;
    section.hidden = !S.promotionsEnabled;
    if (el['est-ads-open']) el['est-ads-open'].hidden = !S.promotionsEnabled;
    if (!S.promotionsEnabled) return;
    var linked = Boolean(S.promoProfile && S.promoProfile.username);
    var canSubmit = linked && (S.promoProfile.role === 'sponsor' || S.promoProfile.role === 'admin');
    var open = canSubmit && Boolean(S.promoWindowOpen);
    var message;
    if (!S.promoSessionChecked) message = 'Comprobando tu sesión de cuenta…';
    else if (!linked) message = 'Inicia sesión con tu cuenta vinculada para solicitar publicidad.';
    else if (!canSubmit) message = 'Tu cuenta @' + S.promoProfile.username + ' aún no tiene el rol Patrocinador. Pídelo al equipo de administración.';
    else if (!open) message = 'Eres patrocinador. Elige en la lista un partido que empiece en menos de 30 minutos para abrir su publicidad.';
    else message = 'Patrocinador @' + S.promoProfile.username + ': envía tu creatividad para este partido.';
    el['est-promo-auth'].textContent = message;
    el['est-promo-auth'].dataset.state = open ? 'ready' : '';
    el['est-promo-login'].hidden = linked;
    el['est-promo-refresh'].hidden = linked;
    details.hidden = !open;
    el['est-promo-form'].hidden = !open;
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
      // Al entrar (también si el partido ya terminó) se trae el historial y pagos.
      loadBetHistory();
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
      if (ledgerOpen()) renderLedger();
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
    if (!S.match || !el['est-showcase'] || !el['est-showcase-track']) return;
    var homeId = S.match.homeId, awayId = S.match.awayId;
    var homeColor = preshowTeamColor(homeId), awayColor = preshowTeamColor(awayId);
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
    S.teamIndicators = rows.map(function (row, index) {
      return { key: 'indicator-' + index, label: row[0], home: row[1], away: row[2], index: index };
    });
    var preferredKey = S.preshowDataMatchId === S.match.id
      ? null
      : (S.sponsoredPromotions.length ? S.sponsoredPromotions[0].key : 'indicators');
    renderShowcase(homeColor, awayColor, preferredKey);
  }

  function housePromotionCreative(index) {
    var promotion = HOUSE_PROMOTIONS[index];
    var matchCard = (index === 3 && S.match) ? matchExclusivePromotion() : null;
    return {
      key: 'house-' + index,
      label: 'Promoción de MonteCristo',
      text: matchCard ? matchCard.text : promotion.text,
      textPosition: 'bottom',
      textSize: 'medium',
      textAlign: 'left',
      ctaText: matchCard ? matchCard.action : promotion.action,
      href: matchCard ? matchCard.href : promotion.href,
      image: matchCard ? matchCard.image : promotion.image
    };
  }

  function showcasePromotionSlides() {
    var promotions = (S.sponsoredPromotions || []).slice();
    HOUSE_PROMOTIONS.forEach(function (_promotion, index) {
      promotions.push(housePromotionCreative(index));
    });
    return promotions;
  }

  function promotionSlideMarkup(promotion, index) {
    var key = promotion.key || ('promotion-' + index);
    var textPosition = ['top', 'middle', 'hidden', 'badge', 'overlay'].indexOf(promotion.textPosition) >= 0
      ? promotion.textPosition : 'bottom';
    var textSize = ['small', 'medium', 'large'].indexOf(promotion.textSize) >= 0 ? promotion.textSize : 'medium';
    var textAlign = ['left', 'center', 'right'].indexOf(promotion.textAlign) >= 0 ? promotion.textAlign : 'left';
    var themeColor = /^#[0-9a-f]{3,8}$/i.test(String(promotion.themeColor || '')) ? promotion.themeColor : '';
    var hasText = Boolean(promotion.text && String(promotion.text).trim() && textPosition !== 'hidden');
    var isFirstPromotion = index === 0;
    var stageId = isFirstPromotion ? ' id="est-preshow-promo"' : '';
    var imageId = isFirstPromotion ? ' id="est-promo-image"' : '';
    var labelId = isFirstPromotion ? ' id="est-promo-label"' : '';
    var textId = isFirstPromotion ? ' id="est-promo-text"' : '';
    var linkId = isFirstPromotion ? ' id="est-promo-link"' : '';
    var sponsorClass = promotion.isSponsored ? ' is-sponsored' : '';
    var labelStyle = themeColor ? ' style="--promo-theme:' + themeColor + '"' : '';
    var image = promotion.image || PROMO_FALLBACK_IMAGE;
    var href = promotion.href || '/';
    var ctaText = promotion.ctaText || promotion.action || 'Ver más';
    var label = promotion.label || 'Promoción';
    return '<article' + stageId + ' class="est-preshow-promo est-showcase-slide est-showcase-promo' + sponsorClass + '" data-showcase-key="' + esc(key) + '" data-text-position="' + textPosition + '" data-text-size="' + textSize + '" data-text-align="' + textAlign + '" aria-label="Anuncio: ' + esc(label) + '">' +
      '<img' + imageId + ' class="est-promo-image" src="' + esc(image) + '" alt="" decoding="async">' +
      '<div class="est-promo-content">' +
        '<span' + labelId + ' class="est-promo-label"' + labelStyle + '>' + esc(label) + '</span>' +
        '<p' + textId + (hasText ? '' : ' class="is-empty"') + '>' + esc(promotion.text || '') + '</p>' +
      '</div>' +
      '<a' + linkId + ' class="btn btn-ghost btn-small est-showcase-cta" href="' + esc(href) + '"' + labelStyle + '>' + esc(ctaText) + '</a>' +
    '</article>';
  }

  function indicatorSlideMarkup(indicators, homeColor, awayColor) {
    var homeId = ' id="est-compare-home"';
    var awayId = ' id="est-compare-away"';
    var rows = indicators.map(function (indicator, index) {
      var homeValue = indicator.label === 'Forma (5)' ? indicator.home : esc(indicator.home);
      var awayValue = indicator.label === 'Forma (5)' ? indicator.away : esc(indicator.away);
      return '<tr class="est-indicator-row" data-indicator-index="' + index + '">' +
        '<th scope="row" class="est-indicator-name">' + esc(indicator.label) + '</th>' +
        '<td class="est-indicator-value home">' + homeValue + '</td>' +
        '<td class="est-indicator-value away">' + awayValue + '</td>' +
      '</tr>';
    }).join('');
    return '<article class="est-showcase-slide est-showcase-stat" data-showcase-key="indicators" data-indicator-count="' + indicators.length + '" aria-label="Todos los indicadores del partido: ' + esc(teamFull(S.match.homeId)) + ' contra ' + esc(teamFull(S.match.awayId)) + '">' +
      '<div class="est-showcase-stat-head"><div><p class="est-compare-kicker">Cara a cara</p><h3>Indicadores del partido</h3></div><span class="est-showcase-kind">Comparativa completa · ' + indicators.length + ' datos</span></div>' +
      '<div class="est-compare-teams" aria-label="Equipos comparados">' +
        '<div' + homeId + ' class="est-compare-club est-compare-club-home"><i class="est-compare-dot" aria-hidden="true" style="background-color:' + homeColor + ';color:' + homeColor + '"></i><span>' + esc(teamFull(S.match.homeId)) + '</span></div>' +
        '<span class="est-compare-versus" aria-hidden="true">VS</span>' +
        '<div' + awayId + ' class="est-compare-club est-compare-club-away"><i class="est-compare-dot" aria-hidden="true" style="background-color:' + awayColor + ';color:' + awayColor + '"></i><span>' + esc(teamFull(S.match.awayId)) + '</span></div>' +
      '</div>' +
      '<div class="est-showcase-stat-body"><table class="est-indicator-table" aria-label="Comparativa completa de indicadores"><thead><tr><th scope="col">Indicador</th><th scope="col">Local</th><th scope="col">Visitante</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '</article>';
  }

  function renderShowcase(homeColor, awayColor, preferredKey) {
    var track = el['est-showcase-track'];
    if (!track) return;
    var activeItem = S.showcaseItems[S.showcaseIndex];
    var activeKey = preferredKey || (activeItem && activeItem.key);
    var promotions = showcasePromotionSlides();
    var indicators = S.teamIndicators || [];
    var items = [];
    if (indicators.length) {
      items.push({ type: 'indicator', key: 'indicators', label: 'Indicadores del partido', indicators: indicators });
    }
    promotions.forEach(function (promotion) {
      items.push({ type: 'promotion', key: promotion.key, label: promotion.label || 'Promoción', creative: promotion });
    });
    if (!items.length) return;

    var promotionIndex = 0;
    track.innerHTML = items.map(function (item) {
      if (item.type === 'promotion') return promotionSlideMarkup(item.creative, promotionIndex++);
      return indicatorSlideMarkup(item.indicators, homeColor || preshowTeamColor(S.match.homeId), awayColor || preshowTeamColor(S.match.awayId));
    }).join('');
    if (el['est-showcase-dots']) {
      el['est-showcase-dots'].innerHTML = items.map(function (item, index) {
        var itemType = item.type === 'indicator' ? 'todos los indicadores' : 'anuncio';
        return '<button class="est-compare-dot-button" type="button" data-showcase-index="' + index + '" aria-label="Ver ' + itemType + ': ' + esc(item.label) + '" aria-pressed="false" title="' + itemType + ': ' + esc(item.label) + '"><span></span></button>';
      }).join('');
      el['est-showcase-dots'].querySelectorAll('[data-showcase-index]').forEach(function (button) {
        button.addEventListener('click', function () {
          setShowcaseIndex(Number(button.getAttribute('data-showcase-index')));
          restartShowcaseRotation();
        });
      });
    }
    track.style.width = (items.length * 100) + '%';
    Array.prototype.forEach.call(track.children, function (slide) {
      slide.style.flex = '0 0 ' + (100 / items.length) + '%';
      slide.setAttribute('aria-hidden', 'true');
      slide.setAttribute('inert', '');
    });

    S.showcaseItems = items;
    var nextIndex = activeKey ? items.findIndex(function (item) { return item.key === activeKey; }) : -1;
    if (nextIndex < 0) nextIndex = Math.min(S.showcaseIndex, items.length - 1);
    setShowcaseIndex(nextIndex);

    // Mantiene los selectores históricos accesibles para el primer anuncio y el bloque completo de indicadores.
    el['est-preshow-promo'] = $('est-preshow-promo');
    el['est-promo-image'] = $('est-promo-image');
    el['est-promo-label'] = $('est-promo-label');
    el['est-promo-text'] = $('est-promo-text');
    el['est-promo-link'] = $('est-promo-link');
    el['est-compare-home'] = $('est-compare-home');
    el['est-compare-away'] = $('est-compare-away');
  }

  function setShowcaseIndex(index) {
    var total = S.showcaseItems.length;
    if (!total) return;
    S.showcaseIndex = ((index % total) + total) % total;
    var current = S.showcaseIndex;
    var item = S.showcaseItems[current];
    var viewport = el['est-showcase'];
    var track = el['est-showcase-track'];
    if (track) track.style.transform = 'translate3d(-' + (current * 100 / total) + '%, 0, 0)';
    if (viewport) {
      viewport.setAttribute('data-index', String(current));
      viewport.setAttribute('data-slide-type', item ? item.type : '');
      viewport.setAttribute('aria-label', item && item.type === 'indicator'
        ? 'Cara a cara: ' + item.label + ' entre ' + teamFull(S.match.homeId) + ' y ' + teamFull(S.match.awayId)
        : 'Anuncio de La Previa');
    }
    if (el['est-showcase-count']) el['est-showcase-count'].textContent = (current + 1) + ' / ' + total;
    if (track) {
      Array.prototype.forEach.call(track.children, function (slide, slideIndex) {
        var active = slideIndex === current;
        slide.setAttribute('aria-hidden', String(!active));
        if (active) slide.removeAttribute('inert');
        else slide.setAttribute('inert', '');
      });
    }
    if (el['est-showcase-dots']) {
      el['est-showcase-dots'].querySelectorAll('[data-showcase-index]').forEach(function (button, buttonIndex) {
        var active = buttonIndex === current;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
  }

  function startShowcaseRotation() {
    if (S.showcaseRotationId || reduced.matches || S.showcaseItems.length < 2) return;
    S.showcaseRotationId = window.setInterval(function () {
      setShowcaseIndex(S.showcaseIndex + 1);
    }, SHOWCASE_ROTATION_MS);
  }

  function stopShowcaseRotation() {
    if (S.showcaseRotationId) window.clearInterval(S.showcaseRotationId);
    S.showcaseRotationId = null;
  }

  function restartShowcaseRotation() {
    if (!S.showcaseRotationId) return;
    stopShowcaseRotation();
    startShowcaseRotation();
  }

  function setShowcaseVisible(visible) {
    var viewport = el['est-showcase'];
    if (viewport) viewport.hidden = !visible;
    if (!visible) {
      var promoSlides = viewport ? viewport.querySelectorAll('.est-preshow-promo') : [];
      Array.prototype.forEach.call(promoSlides, function (slide) { slide.hidden = true; });
    } else if (viewport) {
      viewport.querySelectorAll('.est-preshow-promo').forEach(function (slide) { slide.hidden = false; });
    }
  }

  function formatPreshowCountdown(ms) {
    var seconds = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }

  function matchExclusivePromotion() {
    if (!S.match) return null;
    var homeId = S.match.homeId, awayId = S.match.awayId;
    var homeName = teamFull(homeId);
    var awayName = teamFull(awayId);
    var homeTactic = tacticSummary(homeId);
    var awayTactic = tacticSummary(awayId);
    var homePos = (S.standings || []).findIndex(function (row) { return (row.teamId || row.id) === homeId; });
    var awayPos = (S.standings || []).findIndex(function (row) { return (row.teamId || row.id) === awayId; });
    var posText = (homePos >= 0 ? '#' + (homePos + 1) : '') + (homePos >= 0 && awayPos >= 0 ? ' vs ' : '') + (awayPos >= 0 ? '#' + (awayPos + 1) : '');
    var copy = '⚔️ ' + homeName + ' (' + homeTactic + ') vs ' + awayName + ' (' + awayTactic + ')' + (posText ? ' · Posiciones: ' + posText : '') + ' · ¡Duelo estelar en vivo!';
    return {
      label: 'Promoción de MonteCristo',
      text: copy,
      textPosition: 'bottom',
      textSize: 'medium',
      href: '/estadio',
      action: 'Ver ficha y comparativa',
      image: '/assets/estadio-tunnel.jpg'
    };
  }

  // Las creatividades comparten una sola cartelera con las fichas cara a cara.
  // El anuncio patrocinado se agrega al carrusel sin reemplazar las promociones propias.
  var PROMO_FALLBACK_IMAGE = '/assets/casino-hero.jpg';
  function rerenderShowcase(preferredKey) {
    if (!S.match) return;
    renderShowcase(preshowTeamColor(S.match.homeId), preshowTeamColor(S.match.awayId), preferredKey);
  }

  function defaultPromotion() {
    if (!S.sponsoredPromotions.length) return;
    S.sponsoredPromotions = [];
    rerenderShowcase();
  }

  function promotionCreative(promotion) {
    var href = promotion && promotion.href;
    var allowed = href === '/' || href === '/estadio' || href === '/terminos' || /^\/room\/[A-Z0-9]{5}$/.test(String(href || ''));
    if (!promotion || !allowed) return null;
    // La imagen solo puede venir de la ruta interna de creatividades del servidor.
    var image = typeof promotion.image === 'string' && promotion.image.indexOf('/api/estadio/promotion-media/') === 0 ? promotion.image : null;
    return {
      key: 'sponsor-' + String(promotion.id || 'active'),
      isSponsored: true,
      label: promotion.label || (promotion.isPermanent ? 'Patrocinador Oficial' : 'Promoción pagada'),
      text: typeof promotion.text === 'string' ? promotion.text : '',
      textPosition: promotion.textPosition || (promotion.text ? 'bottom' : 'hidden'),
      textSize: promotion.textSize || 'medium',
      textAlign: promotion.textAlign || 'left',
      ctaText: promotion.ctaText || 'Ver promoción',
      themeColor: promotion.themeColor || null,
      href: href,
      image: image || PROMO_FALLBACK_IMAGE
    };
  }

  function renderPromotions(promotions) {
    var byKey = new Map();
    (Array.isArray(promotions) ? promotions : []).forEach(function (promotion) {
      var creative = promotionCreative(promotion);
      if (creative) byKey.set(creative.key, creative);
    });
    var next = Array.from(byKey.values());
    var previous = S.sponsoredPromotions;
    var unchanged = previous.length === next.length && previous.every(function (creative, index) {
      var candidate = next[index];
      return candidate && Object.keys(creative).every(function (key) { return creative[key] === candidate[key]; });
    });
    if (unchanged) return;
    var previousKeys = new Set(previous.map(function (creative) { return creative.key; }));
    var newlyAdded = next.find(function (creative) { return !previousKeys.has(creative.key); });
    S.sponsoredPromotions = next;
    rerenderShowcase(newlyAdded ? newlyAdded.key : null);
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
        renderPromotions(data && data.ok ? (Array.isArray(data.promotions) ? data.promotions : (data.promotion ? [data.promotion] : [])) : []);
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
      stopShowcaseRotation();
      setShowcaseVisible(false);
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
      stopShowcaseRotation();
      setShowcaseVisible(false);
      return;
    }
    panel.hidden = false;
    panel.dataset.delay = String(delayed);
    S.promoWindowOpen = !delayed;
    updatePromotionComposer();
    if (delayed) {
      stopPromotionRotation();
      stopShowcaseRotation();
      setShowcaseVisible(false);
    } else {
      startPromotionRotation(match.id);
    }
    var statusText = delayed
      ? 'Kickoff pendiente · esperando señal del partido'
      : 'Kickoff programado · ' + kickoffTime(match.scheduledKickoffAt);
    if (el['est-preshow-status'].textContent !== statusText) el['est-preshow-status'].textContent = statusText;
    el['est-preshow-timer'].textContent = delayed ? '' : formatPreshowCountdown(remaining);
    if (S.preshowDataMatchId !== match.id || S.preshowDataStandings !== S.standings) {
      renderTeamComparison();
      S.preshowDataMatchId = match.id;
      S.preshowDataStandings = S.standings;
    }
    setShowcaseVisible(!delayed);
    if (!delayed) startShowcaseRotation();
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
    var rawMin = ms.state ? (ms.state.displayMinute != null ? ms.state.displayMinute : ms.state.minute) : 0;
    S.serverMinute = Number(rawMin || 0);
    S.minuteReceivedAt = performance.now();
    S.minute = Math.round(S.serverMinute);
    S.phase = ms.state ? ms.state.phase : 'pre';
    S.score = ms.state ? ms.state.score : { home: 0, away: 0 };
    S.possession = ms.state && ms.state.possession ? ms.state.possession : { home: .5, away: .5 };
    S.possessionTeam = ms.state && ms.state.possessionTeam ? ms.state.possessionTeam : 'home';
    S.ballCarrierId = ms.state ? ms.state.ballCarrierId : null;
    S.playStopped = ms.state ? Boolean(ms.state.playStopped) : true;
    S.goalAnimUntil = 0;
    S.authoritativePlayers = ms.state && Array.isArray(ms.state.players) ? ms.state.players : [];
    var ball = ms.state && ms.state.ball ? ms.state.ball : { x: .5, y: .5 };
    S.ball = { x: ball.x, y: ball.y }; S.ballStart = { x: ball.x, y: ball.y }; S.ballDest = { x: ball.x, y: ball.y };
    S.ballT0 = performance.now();
    S.ballDur = 800;
    resolveKits();
    initPlayers();
    S.playerT0 = performance.now();
    S.playerDur = 1900;
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

  function movePlayerTo(id, point, dur) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return;
    var player = S.players.find(function (p) { return p.id === id; });
    if (!player) return;
    player.startX = player.renderX;
    player.startY = player.renderY;
    var targetX = clamp(Number(point.x), .01, .99);
    var targetY = clamp(Number(point.y), .02, .98);
    var moveDist = Math.hypot(targetX - player.renderX, targetY - player.renderY);
    player.destX = targetX;
    player.destY = targetY;
    player.t0 = performance.now();
    player.dur = dur ? Math.max(dur, moveDist * 1600) : Math.max(600, moveDist * 1400);
  }

  // ===== Ciclo de render (tweening 60 fps) =====
  function frame(now) {
    S.rafId = requestAnimationFrame(frame);

    // Balón
    var bDur = S.ballDur || 800;
    var bp = clamp((now - (S.ballT0 || now)) / bDur, 0, 1);
    var be = reduced.matches ? 1 : easeOutCubic(bp);
    S.ball.x = lerp(S.ballStart.x, S.ballDest.x, be);
    S.ball.y = lerp(S.ballStart.y, S.ballDest.y, be);

    // Portador del balón
    var carrier = null;
    if (S.ballCarrierId != null) {
      carrier = S.players.find(function (p) { return p.id === S.ballCarrierId; });
    }

    // Jugadores
    var pDur = S.playerDur || TICK_MS;
    var pGlobal = clamp((now - (S.playerT0 || now)) / pDur, 0, 1);
    var eGlobal = reduced.matches ? 1 : easeOutCubic(pGlobal);

    for (var i = 0; i < S.players.length; i++) {
      var pl = S.players[i];
      var pe = eGlobal;
      if (pl.dur) {
        var pIndiv = clamp((now - (pl.t0 || now)) / pl.dur, 0, 1);
        pe = reduced.matches ? 1 : easeOutCubic(pIndiv);
      }
      pl.baseX = lerp(pl.startX, pl.destX, pe);
      pl.baseY = lerp(pl.startY, pl.destY, pe);
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
      if (bp >= 0.8 || (Math.hypot(S.ballDest.x - S.ballStart.x, S.ballDest.y - S.ballStart.y) < 0.06)) {
        var dir = carrier.team === 'home' ? 1 : -1;
        S.ball.x = clamp(carrier.renderX + dir * 0.012, -0.01, 1.01);
        S.ball.y = carrier.renderY;
        S.ballStart.x = S.ball.x; S.ballStart.y = S.ball.y;
        S.ballDest.x = S.ball.x; S.ballDest.y = S.ball.y;
      }
    }

    // Avance suave del reloj en vivo
    if (S.match && ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0) {
      if (!S.playStopped && Number.isFinite(S.serverMinute) && Number.isFinite(S.minuteReceivedAt)) {
        var elapsedSec = (now - S.minuteReceivedAt) / 1000;
        var currentSimMin = Math.min(90, Math.max(1, Math.floor(S.serverMinute + elapsedSec / 10)));
        if (currentSimMin !== S.minute) {
          S.minute = currentSimMin;
          renderScoreboard();
        }
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
    // Sombra proyectada del jugador
    ctx.beginPath(); ctx.ellipse(cx, cy + r * .55, r * .95, r * .42, 0, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.32)'; ctx.fill();

    // Cuerpo / camiseta
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    ctx.fillStyle = pl.kitBase; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    drawKit(pl, cx, cy, r);
    ctx.restore();

    // Contorno (resaltado dorado para el poseedor del balón)
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.lineWidth = inPoss ? 2.6 : 1.4;
    ctx.strokeStyle = inPoss ? '#ffe3a5' : 'rgba(0,0,0,.55)'; ctx.stroke();

    // Mirada y orientación táctica dinámica
    var defaultDir = pl.team === 'home' ? 1 : -1;
    var ballDx = nx(S.ball.x) - cx, ballDy = ny(S.ball.y) - cy;
    var ballDist = Math.hypot(ballDx, ballDy);

    var lookAngle;
    if (inPoss) {
      // El portador orienta la mirada hacia el arco rival
      var goalX = pl.team === 'home' ? nx(1) : nx(0);
      var goalY = ny(0.5);
      lookAngle = Math.atan2(goalY - cy, goalX - cx);
    } else if (ballDist > 6 && ballDist < 380) {
      // Los jugadores sin balón orientan la mirada hacia el juego activo
      lookAngle = Math.atan2(ballDy, ballDx);
    } else {
      // Orientación por defecto del equipo
      lookAngle = defaultDir > 0 ? 0 : Math.PI;
    }

    var dotX = cx + Math.cos(lookAngle) * (r * 0.78);
    var dotY = cy + Math.sin(lookAngle) * (r * 0.78);

    ctx.beginPath(); ctx.arc(dotX, dotY, inPoss ? 2.8 : 2.2, 0, TAU);
    ctx.fillStyle = inPoss ? '#ffe3a5' : 'rgba(255,255,255,.85)'; ctx.fill();
    if (inPoss) {
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke();
    }

    // Número dorsal
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
    var bDur = S.ballDur || 800;
    var p = clamp((now - (S.ballT0 || now)) / bDur, 0, 1);
    var dist = Math.hypot(S.ballDest.x - S.ballStart.x, S.ballDest.y - S.ballStart.y);

    // Elevación parabólica 2.5D para pases y tiros largos (puro renderizado en canvas):
    var arcHeight = (!reduced.matches && !S.playStopped && dist > 0.08)
      ? Math.sin(p * Math.PI) * Math.min(22, dist * 55)
      : 0;

    // Estela de tiro o pase largo:
    if (!reduced.matches && !S.playStopped && p < 1 && dist > 0.05) {
      ctx.beginPath();
      ctx.moveTo(nx(S.ballStart.x), ny(S.ballStart.y));
      ctx.quadraticCurveTo(
        (nx(S.ballStart.x) + bx) / 2,
        (ny(S.ballStart.y) + by) / 2 - arcHeight * 0.8,
        bx,
        by - arcHeight
      );
      ctx.strokeStyle = 'rgba(229,189,114,' + (0.22 * (1 - p)) + ')';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Sombra sobre el césped (permanece en el suelo y se atenúa con la altura):
    var shadowR = Math.max(2, BALL_R * (1 - arcHeight * 0.025));
    var shadowAlpha = Math.max(0.12, 0.35 * (1 - arcHeight * 0.03));
    ctx.beginPath();
    ctx.ellipse(bx, by + 1, shadowR + 2, shadowR * 0.65, 0, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,' + shadowAlpha + ')';
    ctx.fill();

    // Balón elevado:
    var visualY = by - arcHeight;
    var visualR = BALL_R + (arcHeight * 0.08);

    ctx.beginPath(); ctx.arc(bx, visualY, visualR, 0, TAU); ctx.fillStyle = '#ffe3a5'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#0a5a45'; ctx.stroke();

    if (!reduced.matches) {
      ctx.save();
      ctx.translate(bx, visualY);
      ctx.rotate(now / 300);
      ctx.beginPath(); ctx.moveTo(-visualR, 0); ctx.lineTo(visualR, 0);
      ctx.strokeStyle = 'rgba(10,90,69,.6)'; ctx.stroke();
      ctx.restore();
    }
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
    var delay = (!reduced.matches && S.goalAnimUntil && S.goalAnimUntil > performance.now())
      ? Math.max(0, S.goalAnimUntil - performance.now())
      : 0;
    if (delay > 0) {
      setTimeout(function () {
        if (data.matchId !== S.currentMatchId) return;
        appendCommentary({ voice: data.voice, text: data.text });
      }, delay);
    } else {
      appendCommentary({ voice: data.voice, text: data.text });
    }
  }

  // ===== Eventos del motor =====
  function onTick(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    var wasStopped = S.playStopped;
    var rawMin = data.minute != null ? data.minute : (data.displayMinute != null ? data.displayMinute : (data.state && data.state.minute));
    if (rawMin != null && Number.isFinite(Number(rawMin))) {
      S.serverMinute = Number(rawMin);
      S.minuteReceivedAt = performance.now();
      S.minute = Math.round(S.serverMinute);
    }
    var st = data.state || data;
    if (st.phase) S.phase = st.phase;
    if (st.score) S.score = st.score;
    if (st.possession) S.possession = st.possession;
    if (Object.prototype.hasOwnProperty.call(st, 'possessionTeam')) S.possessionTeam = st.possessionTeam;
    if (Object.prototype.hasOwnProperty.call(st, 'ballCarrierId')) S.ballCarrierId = st.ballCarrierId;
    if (Object.prototype.hasOwnProperty.call(st, 'playStopped')) S.playStopped = Boolean(st.playStopped);

    var ball = st.ball;
    if (ball && (!S.ballCarrierId || S.playStopped)) {
      var bx = clamp(ball.x, -0.01, 1.01);
      var by = clamp(ball.y, 0, 1);
      if (Math.hypot(bx - S.ball.x, by - S.ball.y) > 0.015) {
        S.ballStart = { x: S.ball.x, y: S.ball.y };
        S.ballDest = { x: bx, y: by };
        S.ballT0 = performance.now();
        S.ballDur = 1800;
      }
    }

    var serverPlayers = data.players || (data.state && data.state.players);
    if (Array.isArray(serverPlayers) && serverPlayers.length) {
      syncAuthoritativePlayers(serverPlayers, true);
    } else {
      recomputeTargets(S.ballDest.x, S.ballDest.y);
    }
    S.playerT0 = performance.now();
    S.playerDur = 1900;

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
    if (ev.minute != null && Number.isFinite(Number(ev.minute))) {
      S.serverMinute = Number(ev.minute);
      S.minuteReceivedAt = performance.now();
      S.minute = Math.round(ev.minute);
    }
    applyRosterEvent(ev);

    // Balón: cinemática balística fluida
    if (ev.ball && Number.isFinite(ev.ball.x) && Number.isFinite(ev.ball.y)) {
      S.ballStart = { x: S.ball.x, y: S.ball.y };
      S.ballDest = { x: clamp(ev.ball.x, -0.01, 1.01), y: clamp(ev.ball.y, 0, 1) };
      var dist = Math.hypot(S.ballDest.x - S.ballStart.x, S.ballDest.y - S.ballStart.y);
      var isShot = ev.type === 'shot' || ev.type === 'shot_on_target' || ev.type === 'goal' || ev.type === 'penalty_scored';
      S.ballDur = isShot ? Math.max(320, Math.min(720, dist * 1000)) : Math.max(360, Math.min(850, dist * 1200));
      S.ballT0 = performance.now();
    }

    // Jugadores
    S.playerT0 = performance.now();
    S.playerDur = 800;
    S.players.forEach(function (player) {
      player.startX = player.renderX;
      player.startY = player.renderY;
      player.dur = null;
    });

    if (ev.playerId != null && ev.actorPosition) movePlayerTo(ev.playerId, ev.actorPosition, 500);
    if (ev.receiverId != null) movePlayerTo(ev.receiverId, ev.ball || S.ballDest, 700);
    if (ev.keeperId != null && ev.keeperPosition) movePlayerTo(ev.keeperId, ev.keeperPosition, 400);

    if (ev.type === 'kickoff' || ev.type === 'goal_restart') {
      S.players.forEach(function (pl) {
        if (pl.team === 'home') pl.destX = Math.min(pl.destX, 0.485);
        else if (pl.team === 'away') pl.destX = Math.max(pl.destX, 0.515);
      });
      if (ev.playerId != null) movePlayerTo(ev.playerId, { x: 0.5, y: 0.5 }, 500);
    }

    if (ev.ball && !S.playStopped && S.possessionTeam && ['goal_celebration', 'halftime', 'ended'].indexOf(ev.phase) < 0) {
      var defSide = S.possessionTeam === 'home' ? 'away' : 'home';
      var nearestDef = null, minDist = Infinity;
      S.players.forEach(function (pl) {
        if (pl.team === defSide && pl.role !== 'GK' && pl.id !== ev.playerId) {
          var d = Math.hypot(pl.renderX - S.ballDest.x, pl.renderY - S.ballDest.y);
          if (d < minDist) { minDist = d; nearestDef = pl; }
        }
      });
      if (nearestDef) {
        nearestDef.destX = clamp(nearestDef.destX + (S.ballDest.x - nearestDef.destX) * 0.35, 0.02, 0.98);
        nearestDef.destY = clamp(nearestDef.destY + (S.ballDest.y - nearestDef.destY) * 0.35, 0.02, 0.98);
        nearestDef.dur = 700;
      }
    }

    if (ev.type === 'goal' || ev.type === 'penalty_scored') {
      S.goalFlashUntil = performance.now() + 1400;
      S.goalAnimUntil = performance.now() + (reduced.matches ? 0 : 700);
      showGoalBanner();
      if (ev.marcador) {
        var parts = String(ev.marcador).split('-');
        if (parts.length === 2) {
          S.score = { home: Number(parts[0]) || 0, away: Number(parts[1]) || 0 };
        }
      }
      playSfx('goal');
    } else {
      S.goalAnimUntil = 0;
      if (WHISTLE_EVENTS[ev.type]) {
        playSfx(WHISTLE_EVENTS[ev.type]);
      } else if (ev.type === 'red_card' || ev.type === 'second_yellow') {
        bell('card');
      }
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
    if (b.min > 0) {
      var minBtn = document.createElement('button'); minBtn.type = 'button'; minBtn.className = 'est-denom'; minBtn.textContent = 'Mín';
      minBtn.addEventListener('click', function () { el['est-stake'].value = b.min; });
      box.appendChild(minBtn);
    }
    DENOMS.filter(function (d) { return d >= b.min && d <= b.max; }).forEach(function (d) {
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'est-denom'; btn.textContent = '+' + fmt(d);
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
      loadBetHistory();
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
    if (!open.length) {
      var ended = S.match && ['settled', 'finished', 'postponed'].indexOf(S.match.status) >= 0;
      box.innerHTML = '<li class="est-muted">Sin apuestas abiertas.' +
        (ended ? ' Este partido ya terminó: revisa «Historial y pagos» para ver el resultado y lo acreditado.' : '') + '</li>';
      renderLedgerBadges();
      return;
    }
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
    renderLedgerBadges();
  }

  // ===== Historial de apuestas y pagos (vista propia) =====
  //
  // La liquidación ocurre en el servidor aunque el jugador esté desconectado, así
  // que las fichas ya están acreditadas cuando vuelve. Esta vista las hace visibles
  // en su propio espacio a pantalla completa —no dentro de las columnas del
  // Estadio— y se abre desde el nav, desde el panel «Mis apuestas» o con
  // /estadio#apuestas. Solo necesita HTTP: funciona sin socket y con el partido ya
  // jugado.
  var BETS_SEEN_KEY = 'mc-estadio-bets-seen';
  var LEDGER_HASH = '#apuestas';
  var LEDGER_STALE_MS = 20000;   // al abrir, si el historial es más viejo, se refresca

  function betsSeenId() { return 'p:' + ((S.profile && S.profile.id) || S.token || 'anon'); }
  function betsSeenAt() {
    try {
      var map = JSON.parse(localStorage.getItem(BETS_SEEN_KEY) || '{}') || {};
      return Number(map[betsSeenId()]) || 0;
    } catch (e) { return 0; }
  }
  function markBetsSeen(ts) {
    try {
      var map = {};
      try { map = JSON.parse(localStorage.getItem(BETS_SEEN_KEY) || '{}') || {}; } catch (e2) { map = {}; }
      map[betsSeenId()] = Math.max(Number(map[betsSeenId()]) || 0, Math.floor(Number(ts) || Date.now()));
      localStorage.setItem(BETS_SEEN_KEY, JSON.stringify(map));
    } catch (e) { /* sin storage: el aviso se recalcula al volver a entrar */ }
  }

  // --- Apertura y cierre de la vista ---
  function ledgerOpen() { return Boolean(el['est-ledger']) && !el['est-ledger'].hidden; }

  function openLedger(trigger) {
    var root = el['est-ledger'];
    if (!root || ledgerOpen()) return;
    S.ledgerTrigger = trigger || document.activeElement || null;
    root.hidden = false;
    if (document.body.classList) document.body.classList.add('est-ledger-open');
    try { if (location.hash !== LEDGER_HASH) history.replaceState(null, '', LEDGER_HASH); } catch (e) { /* sin history */ }
    renderLedger();
    renderLedgerBadges();
    // Si el historial es viejo se pide fresco al abrir (el jugador viene a ver
    // pagos recientes); si acaba de cargarse, se reutiliza sin otra petición.
    var stale = !S.betHistoryFetchedAt || (Date.now() - S.betHistoryFetchedAt) > LEDGER_STALE_MS;
    loadBetHistory({ force: stale }).then(function () {
      if (!ledgerOpen() || !S.betsUnseen) return;
      // Ya lo está viendo: el aviso queda visible en esta visita y la marca se
      // mueve para que no vuelva a aparecer en la siguiente.
      markBetsSeen(S.betsUnseen.throughAt || Date.now());
    });
    if (root.focus) { try { root.focus(); } catch (e) { /* sin foco */ } }
  }

  function closeLedger() {
    var root = el['est-ledger'];
    if (!root || root.hidden) return;
    root.hidden = true;
    if (document.body.classList) document.body.classList.remove('est-ledger-open');
    try { if (location.hash === LEDGER_HASH) history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sin history */ }
    // El aviso de pagos nuevos se consume al cerrar el historial.
    S.betsUnseen = null;
    renderLedgerBadges();
    var trigger = S.ledgerTrigger;
    S.ledgerTrigger = null;
    if (trigger && trigger.focus) { try { trigger.focus(); } catch (e) { /* sin foco */ } }
  }

  // Foco contenido dentro del diálogo mientras está abierto (Tab / Shift+Tab).
  function trapLedgerFocus(e) {
    if (!ledgerOpen() || e.key !== 'Tab') return;
    var root = el['est-ledger'];
    var focusables = root.querySelectorAll('button:not([disabled]):not([hidden]), [href], [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    // Se descartan los controles dentro de secciones ocultas (el filtro de partido
    // solo existe cuando hay partido seleccionado).
    var list = Array.prototype.filter.call(focusables, function (node) { return !node.closest('[hidden]'); });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    var active = document.activeElement;
    if (active === root || list.indexOf(active) < 0) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  // --- Datos ---
  function loadBetHistory(options) {
    var force = Boolean(options && options.force);
    if (!S.token) return Promise.resolve(null);
    if (!force && S.betHistory && S.betHistoryFetchedAt && (Date.now() - S.betHistoryFetchedAt) < 4000) return Promise.resolve(S.betHistory);
    var seen = betsSeenAt();
    var url = '/api/estadio/my-bets?token=' + encodeURIComponent(S.token) + '&limit=100';
    if (seen > 0) url += '&since=' + Math.floor(seen);
    var seq = ++S.betsRequestSeq;
    S.betsLoading = true;
    S.betsError = null;
    if (ledgerOpen()) renderLedger();
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (data) {
        if (seq !== S.betsRequestSeq) return null;
        S.betsLoading = false;
        if (!data || !data.ok || !data.history) {
          S.betsError = 'load';
          if (ledgerOpen()) renderLedger();
          return null;
        }
        S.betHistory = data.history;
        S.betHistoryFetchedAt = Date.now();
        if (data.profile) {
          if (data.profile.id) { S.profile = S.profile || {}; S.profile.id = data.profile.id; }
          if (data.profile.chips != null) { S.chips = Number(data.profile.chips) || 0; updateChips(); }
        }
        if (data.history.unseen && data.history.unseen.count) {
          S.betsUnseen = data.history.unseen;
        } else if (!seen) {
          // Primera visita: se fija la base sin avisar de pagos antiguos.
          markBetsSeen(Date.now());
        }
        renderLedgerBadges();
        if (ledgerOpen()) renderLedger();
        return data.history;
      })
      .catch(function () {
        if (seq !== S.betsRequestSeq) return null;
        S.betsLoading = false;
        S.betsError = 'load';
        if (ledgerOpen()) renderLedger();
        return null;
      });
  }

  // --- Etiquetas ---
  function betStatusLabel(status) {
    return ({ open: 'Abierta', pending: 'En proceso', won: 'Ganada', lost: 'Perdida', void: 'Anulada', cashed: 'Cobrada' })[status] || status || '';
  }
  function betStatusGlyph(status) {
    return ({ open: '⌛', pending: '⌛', won: '✓', cashed: '💰', lost: '✕', void: '↩' })[status] || '•';
  }
  function whenLabel(ms, withYear) {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleString('es-MX', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        year: withYear ? 'numeric' : undefined, timeZone: CASINO_TIME_ZONE
      });
    } catch (e) { return ''; }
  }
  function dayStamp(ms) {
    try {
      var parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: CASINO_TIME_ZONE }).format(new Date(ms));
      return parts;
    } catch (e) { return ''; }
  }
  var DAY_FMT = null;
  function dayLabel(ms) {
    var stamp = dayStamp(ms);
    var today = dayStamp(Date.now());
    var yesterday = dayStamp(Date.now() - 86400000);
    if (stamp && stamp === today) return 'Hoy';
    if (stamp && stamp === yesterday) return 'Ayer';
    try {
      if (!DAY_FMT) DAY_FMT = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: CASINO_TIME_ZONE });
      var text = DAY_FMT.format(new Date(ms));
      return text.charAt(0).toUpperCase() + text.slice(1);
    } catch (e) { return whenLabel(ms, true); }
  }
  function entryMatchLabel(entry) {
    var m = entry && entry.match;
    if (!m) {
      if (entry && entry.kind === 'future' && entry.seasonMonth) return 'Temporada ' + entry.seasonMonth;
      return 'Partido no disponible';
    }
    return teamFull(m.homeId) + ' vs ' + teamFull(m.awayId);
  }
  function entryScoreLine(entry) {
    var m = entry && entry.match;
    if (!m || !m.result) return '';
    return '<span class="est-ledger-crest" style="background:' + teamColor(m.homeId) + '"></span>' +
      '<span class="est-ledger-team">' + esc(teamFull(m.homeId)) + '</span>' +
      '<b class="est-ledger-score">' + Number(m.result.home) + '–' + Number(m.result.away) + '</b>' +
      '<span class="est-ledger-team">' + esc(teamFull(m.awayId)) + '</span>' +
      '<span class="est-ledger-crest" style="background:' + teamColor(m.awayId) + '"></span>';
  }
  function entryPickLabel(entry) {
    if (entry.kind === 'parlay') return 'Combinada de ' + ((entry.legs || []).length) + ' selecciones';
    if (entry.kind === 'future') {
      var what = entry.market === 'champion' ? 'campeón de liga' : entry.market === 'top4' ? 'top 4' : entry.market === 'golden_boot' ? 'bota de oro' : entry.market;
      return 'Futuro · ' + what + ': ' + teamName(entry.selection);
    }
    return selLabel(entry.market, entry.selection);
  }
  function entryMarketLabel(entry) {
    if (entry.kind === 'parlay') return 'Varias selecciones';
    if (entry.kind === 'future') return 'Apuesta a futuro';
    return MARKET_LABEL[entry.market] || entry.market;
  }
  function entryMoney(entry) {
    var payout = Number(entry.payout) || 0;
    if (entry.status === 'won') return { value: '+' + fmt(payout), note: 'pagado', tone: 'up' };
    if (entry.status === 'cashed') return { value: '+' + fmt(payout), note: 'cash-out', tone: 'up' };
    if (entry.status === 'void') return { value: '+' + fmt(payout || entry.stake), note: 'reembolso', tone: 'void' };
    if (entry.status === 'lost') return { value: '−' + fmt(entry.stake), note: 'sin pago', tone: 'down' };
    return { value: fmt(entry.potentialPayout || 0), note: 'potencial', tone: 'pending' };
  }

  // --- Render ---
  function renderLedgerBadges() {
    var unseenCount = S.betsUnseen && S.betsUnseen.count ? S.betsUnseen.count : 0;
    var openCount = (S.myBets || []).filter(function (b) { return b.status === 'open'; }).length;
    var navBadge = $('est-nav-badge');
    if (navBadge) {
      var n = unseenCount || openCount;
      navBadge.hidden = !n;
      navBadge.textContent = n > 9 ? '9+' : String(n);
      navBadge.dataset.tone = unseenCount ? 'payout' : 'open';
      navBadge.setAttribute('aria-label', unseenCount
        ? (unseenCount + (unseenCount === 1 ? ' pago nuevo' : ' pagos nuevos'))
        : (openCount + ' apuestas abiertas'));
    }
    var dot = el['est-bets-link-dot'];
    if (dot) dot.hidden = !unseenCount;
    var note = el['est-bets-link-note'];
    if (note) {
      note.textContent = unseenCount
        ? (unseenCount + (unseenCount === 1 ? ' pago nuevo' : ' pagos nuevos') + ' · +' + fmt(S.betsUnseen.credited) + ' fichas')
        : 'Ver todas tus apuestas y pagos';
      note.dataset.tone = unseenCount ? 'payout' : '';
    }
    var ledgerChips = el['est-ledger-chips'];
    if (ledgerChips) ledgerChips.textContent = fmt(S.chips) + ' fichas';
    var count = $('est-mybets-count');
    if (count) {
      count.hidden = !openCount;
      count.textContent = openCount + (openCount === 1 ? ' abierta' : ' abiertas');
    }
  }

  function renderLedgerStats(summary) {
    var box = el['est-ledger-stats'];
    if (!box) return;
    var s = summary || {};
    var staked = Number(s.staked) || 0, returned = Number(s.returned) || 0, net = Number(s.net) || 0;
    var byStatus = s.byStatus || {};
    var settled = Number(byStatus.won || 0) + Number(byStatus.lost || 0) + Number(byStatus.void || 0) + Number(byStatus.cashed || 0);
    var hits = Number(byStatus.won || 0) + Number(byStatus.cashed || 0);
    var hitRate = settled ? Math.round(hits / settled * 100) : 0;
    function card(label, value, note, tone, extra) {
      return '<div class="est-ledger-stat' + (tone ? ' ' + tone : '') + '">' +
        '<span class="est-ledger-stat-label">' + esc(label) + '</span>' +
        '<b class="est-ledger-stat-value">' + esc(value) + '</b>' +
        '<span class="est-ledger-stat-note">' + esc(note) + '</span>' +
        (extra ? '<span class="est-ledger-stat-extra">' + esc(extra) + '</span>' : '') +
        '</div>';
    }
    box.innerHTML =
      card('Apostado', fmt(staked), settled + (settled === 1 ? ' apuesta resuelta' : ' apuestas resueltas'), '') +
      card('Cobrado', fmt(returned), hits + (hits === 1 ? ' con pago' : ' con pago'), 'up') +
      card('Neto', (net > 0 ? '+' : net < 0 ? '−' : '') + fmt(Math.abs(net)), settled ? hitRate + ' % de acierto' : 'sin apuestas resueltas', net > 0 ? 'up' : net < 0 ? 'down' : '') +
      card('En juego', fmt(Number(s.openStake) || 0), (Number(s.open) || 0) + ((Number(s.open) || 0) === 1 ? ' apuesta abierta' : ' apuestas abiertas'), 'pending',
        Number(s.open) ? 'paga hasta ' + fmt(Number(s.openPotentialPayout) || 0) : '');
  }

  function renderLedgerUnseen() {
    var box = el['est-ledger-unseen'];
    if (!box) return;
    var unseen = S.betsUnseen;
    if (!unseen || !unseen.count) { box.hidden = true; box.innerHTML = ''; return; }
    var net = Number(unseen.net) || 0;
    box.hidden = false;
    box.innerHTML = '<span class="est-ledger-unseen-icon" aria-hidden="true">💸</span>' +
      '<div class="est-ledger-unseen-copy">' +
      '<b>Se liquidaron ' + unseen.count + (unseen.count === 1 ? ' apuesta' : ' apuestas') + ' mientras no estabas</b>' +
      '<span>' + (Number(unseen.credited) > 0
        ? '+' + fmt(unseen.credited) + ' fichas acreditadas a tu saldo'
        : 'Sin pagos en esas apuestas') +
      ' · neto ' + (net > 0 ? '+' : net < 0 ? '−' : '') + fmt(Math.abs(net)) + '</span></div>';
  }

  function ledgerFilterLabel(filter) {
    return ({ all: 'Todas', open: 'Abiertas', won: 'Ganadas', lost: 'Perdidas', void: 'Anuladas' })[filter] || 'Todas';
  }
  function ledgerEmptyMessage(filter) {
    if (S.betsOnlyMatch && S.currentMatchId) return 'No tienes apuestas en este partido.';
    if (filter === 'open') return 'No tienes apuestas abiertas. Tus apuestas del próximo partido aparecerán aquí.';
    if (filter === 'won') return 'Todavía no tienes apuestas ganadas. Cuando aciertes verás aquí el pago acreditado.';
    if (filter === 'lost') return 'No hay apuestas perdidas en tu historial.';
    if (filter === 'void') return 'No hay apuestas anuladas ni reembolsadas.';
    return 'Todavía no tienes apuestas en el Estadio. Elige una cuota, apuesta tus fichas y aquí verás cómo termina todo, con el pago acreditado aunque no estés conectado.';
  }

  function renderLedger() {
    var list = el['est-ledger-list'];
    if (!list) return;
    renderLedgerUnseen();
    var history = S.betHistory;
    renderLedgerStats(history && history.summary);

    // Chips de estado + filtro por partido.
    var chips = document.querySelectorAll('[data-ledger-filter]');
    Array.prototype.forEach.call(chips, function (chip) {
      var active = chip.getAttribute('data-ledger-filter') === S.ledgerFilter;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    var onlyMatch = el['est-ledger-only-match'];
    if (onlyMatch) {
      onlyMatch.hidden = !S.currentMatchId;
      if (!S.currentMatchId) S.betsOnlyMatch = false;
      onlyMatch.classList.toggle('active', Boolean(S.betsOnlyMatch));
      onlyMatch.setAttribute('aria-pressed', String(Boolean(S.betsOnlyMatch)));
      var current = S.currentMatchId && S.match ? teamName(S.match.homeId) + ' vs ' + teamName(S.match.awayId) : '';
      onlyMatch.textContent = current ? 'Solo ' + current : 'Solo este partido';
    }

    if (S.betsError) {
      list.innerHTML = '<div class="est-ledger-state"><span class="est-ledger-state-icon" aria-hidden="true">⚠️</span>' +
        '<b>No se pudo cargar el historial</b>' +
        '<p>Revisa tu conexión e inténtalo de nuevo. Tus fichas y pagos no se pierden: la liquidación ocurre en el servidor.</p>' +
        '<button type="button" class="est-ledger-retry" data-ledger-retry>Reintentar</button></div>';
      var retry = list.querySelector('[data-ledger-retry]');
      if (retry) retry.addEventListener('click', function () { loadBetHistory({ force: true }); });
      return;
    }
    if (!history) {
      list.innerHTML = '<div class="est-ledger-skeleton" aria-hidden="true">' +
        '<span class="est-ledger-skeleton-row"></span><span class="est-ledger-skeleton-row"></span><span class="est-ledger-skeleton-row"></span></div>' +
        '<p class="est-ledger-state-text">Cargando historial y pagos…</p>';
      return;
    }

    var entries = (history.entries || []).slice();
    if (S.betsOnlyMatch && S.currentMatchId) {
      var matchId = S.currentMatchId;
      entries = entries.filter(function (entry) {
        if (entry.matchId === matchId) return true;
        return (entry.legs || []).some(function (leg) { return leg.matchId === matchId; });
      });
    }
    if (S.ledgerFilter === 'open') {
      entries = entries.filter(function (e) { return e.status === 'open' || e.status === 'pending'; });
    } else if (S.ledgerFilter !== 'all') {
      entries = entries.filter(function (e) { return e.status === S.ledgerFilter || (S.ledgerFilter === 'won' && e.status === 'cashed'); });
    }

    if (!entries.length) {
      list.innerHTML = '<div class="est-ledger-state"><span class="est-ledger-state-icon" aria-hidden="true">🎟️</span>' +
        '<b>' + esc(ledgerFilterLabel(S.ledgerFilter)) + ': nada por aquí</b>' +
        '<p>' + esc(ledgerEmptyMessage(S.ledgerFilter)) + '</p>' +
        '<button type="button" class="est-ledger-retry" data-ledger-go-markets>Ver cuotas del partido</button></div>';
      var go = list.querySelector('[data-ledger-go-markets]');
      if (go) go.addEventListener('click', function () {
        closeLedger();
        if (el['est-markets'] && el['est-markets'].scrollIntoView) el['est-markets'].scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }

    var html = '';
    var currentDay = null;
    var dayEntries = [];
    function flushDay() {
      if (!dayEntries.length) return;
      var credited = dayEntries.reduce(function (sum, e) { return sum + (Number(e.payout) || 0); }, 0);
      var staked = dayEntries.reduce(function (sum, e) { return sum + (Number(e.stake) || 0); }, 0);
      var openInDay = dayEntries.filter(function (e) { return e.status === 'open' || e.status === 'pending'; }).length;
      html += '<h2 class="est-ledger-day"><span>' + esc(dayLabel(dayEntries[0]._at)) + '</span>' +
        '<small>' + dayEntries.length + (dayEntries.length === 1 ? ' apuesta' : ' apuestas') +
        (staked ? ' · ' + fmt(staked) + ' apostadas' : '') +
        (credited ? ' · ' + fmt(credited) + ' cobradas' : '') +
        (openInDay ? ' · ' + openInDay + ' en juego' : '') +
        '</small></h2>';
      dayEntries = [];
    }
    entries.forEach(function (entry) {
      entry._at = entry.settledAt || entry.placedAt || 0;
      var day = dayStamp(entry._at);
      if (day !== currentDay) { flushDay(); currentDay = day; }
      dayEntries.push(entry);
      html += ledgerRow(entry);
    });
    flushDay();

    if (history.totalEntries && Number(history.totalEntries) > (history.entries || []).length) {
      html += '<p class="est-ledger-foot-note">Mostrando las ' + (history.entries || []).length + ' apuestas más recientes de ' + history.totalEntries + '. Las anteriores se conservan en tu perfil.</p>';
    }

    list.innerHTML = html;
    Array.prototype.forEach.call(list.querySelectorAll('[data-ledger-refresh]'), function (button) {
      button.addEventListener('click', function () { loadBetHistory({ force: true }); });
    });
  }

  function ledgerRow(entry) {
    var status = entry.status || 'open';
    var money = entryMoney(entry);
    var meta = fmt(entry.stake) + ' fichas · cuota ' + Number(entry.odds || 1).toFixed(2) +
      (entry.inPlay ? " · en vivo " + entry.minuteAtPlacement + "'" : '') +
      (entry._at ? ' · ' + whenLabel(entry._at) : '');
    var score = entryScoreLine(entry);
    var legs = '';
    if (entry.legs && entry.legs.length) {
      legs = '<ul class="est-ledger-legs">' + entry.legs.map(function (leg) {
        var legMatch = leg.match ? teamFull(leg.match.homeId) + ' vs ' + teamFull(leg.match.awayId) : 'Partido';
        return '<li data-leg="' + esc(leg.status || '') + '">' +
          '<span class="est-ledger-leg-mark" aria-hidden="true">' + esc(betStatusGlyph(leg.status)) + '</span>' +
          '<span class="est-ledger-leg-copy"><b>' + esc(selLabel(leg.market, leg.selection)) + '</b> · ' + esc(MARKET_LABEL[leg.market] || leg.market) +
          ' <small>' + esc(legMatch) + ' · ' + esc(betStatusLabel(leg.status)) + '</small></span>' +
          '<span class="est-ledger-leg-odds">' + Number(leg.odds || 1).toFixed(2) + '</span>' +
          '</li>';
      }).join('') + '</ul>';
    }
    return '<article class="est-ledger-row" data-status="' + esc(status) + '" data-kind="' + esc(entry.kind || 'bet') + '">' +
      '<span class="est-ledger-glyph" aria-hidden="true">' + esc(betStatusGlyph(status)) + '</span>' +
      '<div class="est-ledger-row-main">' +
      '<div class="est-ledger-row-head">' +
      '<span class="est-ledger-pick">' + esc(entryPickLabel(entry)) + '</span>' +
      '<span class="est-ledger-market">' + esc(entryMarketLabel(entry)) + '</span>' +
      '</div>' +
      '<p class="est-ledger-row-match">' +
      (score
        ? score + '<span class="est-ledger-jornada">J' + esc(entry.match.jornada) + '</span>'
        : '<span class="est-ledger-team">' + esc(entryMatchLabel(entry)) + '</span>') +
      '</p>' +
      '<p class="est-ledger-row-meta">' + esc(meta) + '</p>' +
      legs +
      '</div>' +
      '<div class="est-ledger-row-money">' +
      '<span class="est-ledger-status" data-status="' + esc(status) + '">' + esc(betStatusLabel(status)) + '</span>' +
      '<b class="est-ledger-payout" data-tone="' + esc(money.tone) + '">' + esc(money.value) + '</b>' +
      '<span class="est-ledger-payout-note">' + esc(money.note) + '</span>' +
      '</div>' +
      '</article>';
  }

  function setLedgerFilter(filter) {
    S.ledgerFilter = filter || 'all';
    renderLedger();
  }
  function cashout(betId, btn) {
    if (S.playStopped) { toast('Cash-out suspendido durante la pausa del juego.', ''); return; }
    btn.disabled = true; btn.textContent = 'Cobrando…';
    S.socket.emit('football:cashout', { betId: betId }, function (res) {
      if (!res || !res.ok) { btn.disabled = false; btn.textContent = 'Cobrar ahora (cash-out)'; toast(humanCashoutError(res && res.code), 'lose'); return; }
      S.chips = res.chips; updateChips();
      S.myBets = S.myBets.filter(function (b) { return b.id !== betId; });
      renderMyBets();
      loadBetHistory();
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
    // El historial se refresca aquí para que el pago quede registrado aunque el
    // jugador cierre la pestaña justo después de ver el aviso.
    loadBetHistory();
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

  var studioState = {
    mode: 'full',
    presetUrl: '/assets/casino-hero.jpg',
    customDataUrl: null,
    fileName: null
  };

  function updateStudioPreview() {
    var card = el['est-studio-card-preview'];
    var img = el['est-studio-preview-img'];
    var textEl = el['est-studio-preview-text'];
    var labelEl = el['est-studio-preview-label'];
    var btn = el['est-studio-preview-btn'];
    var countEl = el['est-promo-char-count'];
    if (!card || !img || !textEl || !labelEl || !btn) return;

    var copy = (el['est-promo-copy-input'] ? el['est-promo-copy-input'].value : '') || '';
    var textPos = (el['est-promo-text-pos'] ? el['est-promo-text-pos'].value : 'bottom') || 'bottom';
    var textSize = (el['est-promo-text-size'] ? el['est-promo-text-size'].value : 'medium') || 'medium';
    var textAlign = (el['est-promo-text-align'] ? el['est-promo-text-align'].value : 'left') || 'left';
    var themeColor = (el['est-promo-theme-color'] ? el['est-promo-theme-color'].value : '#e5bd72') || '#e5bd72';
    var ctaText = (el['est-promo-cta-input'] ? el['est-promo-cta-input'].value.trim() : '') || 'Ver más';

    card.setAttribute('data-text-position', textPos);
    card.setAttribute('data-text-size', textSize);
    card.setAttribute('data-text-align', textAlign);

    if (countEl) {
      countEl.textContent = copy.length + ' / 140';
      if (copy.length >= 120) countEl.classList.add('warn');
      else countEl.classList.remove('warn');
    }

    var hasText = copy.trim().length > 0 && textPos !== 'hidden';
    textEl.textContent = hasText ? copy : (textPos === 'hidden' ? '' : 'Escribe el mensaje publicitario...');

    labelEl.style.borderColor = themeColor;
    labelEl.style.color = themeColor;
    btn.textContent = ctaText;
    btn.style.borderColor = themeColor;

    img.src = studioState.customDataUrl || studioState.presetUrl || '/assets/casino-hero.jpg';
    updateStudioPreviewSize();
  }

  function updateStudioPreviewSize() {
    var card = el['est-studio-card-preview'];
    var meta = el['est-studio-preview-size'];
    if (!card || !meta) return;
    var rect = card.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      meta.textContent = 'Vista del editor: ' + Math.round(rect.width) + ' × ' + Math.round(rect.height) + ' px · publicación a ancho completo';
    } else {
      meta.textContent = 'Publicación: ancho completo · alto dinámico (mín. 140 px; móvil 150 px)';
    }
  }

  function setupStudioControls() {
    var copyInput = el['est-promo-copy-input'];
    var posSelect = el['est-promo-text-pos'];
    var sizeSelect = el['est-promo-text-size'];
    var alignSelect = el['est-promo-text-align'];
    var colorSelect = el['est-promo-theme-color'];
    var ctaInput = el['est-promo-cta-input'];
    var fileInput = el['est-promo-image-input'];
    var clearFileBtn = el['est-dropzone-clear-btn'];

    if (copyInput) copyInput.addEventListener('input', updateStudioPreview);
    if (posSelect) posSelect.addEventListener('change', updateStudioPreview);
    if (sizeSelect) sizeSelect.addEventListener('change', updateStudioPreview);
    if (alignSelect) alignSelect.addEventListener('change', updateStudioPreview);
    if (colorSelect) colorSelect.addEventListener('change', updateStudioPreview);
    if (ctaInput) ctaInput.addEventListener('input', updateStudioPreview);

    // Mode pills
    document.querySelectorAll('.est-mode-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        document.querySelectorAll('.est-mode-pill').forEach(function (p) { p.classList.remove('active'); });
        pill.classList.add('active');
        var mode = pill.getAttribute('data-mode');
        studioState.mode = mode;
        var textFields = el['est-studio-text-fields'];
        var presetsRow = el['est-studio-presets-row'];

        if (mode === 'image_only') {
          if (posSelect) posSelect.value = 'hidden';
          if (textFields) textFields.hidden = true;
          if (presetsRow) presetsRow.hidden = true;
          if (fileInput) fileInput.focus();
        } else if (mode === 'text_focus') {
          if (posSelect && posSelect.value === 'hidden') posSelect.value = 'bottom';
          if (textFields) textFields.hidden = false;
          if (presetsRow) presetsRow.hidden = false;
          if (copyInput) copyInput.focus();
        } else {
          // full
          if (posSelect && posSelect.value === 'hidden') posSelect.value = 'bottom';
          if (textFields) textFields.hidden = false;
          if (presetsRow) presetsRow.hidden = false;
        }
        updateStudioPreview();
      });
    });

    // Preset thumbnails
    document.querySelectorAll('.est-preset-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.est-preset-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        studioState.presetUrl = btn.getAttribute('data-preset');
        studioState.customDataUrl = null;
        studioState.fileName = null;
        if (fileInput) fileInput.value = '';
        if (el['est-dropzone-file-name']) el['est-dropzone-file-name'].textContent = 'O arrastra el archivo aquí';
        if (clearFileBtn) clearFileBtn.hidden = true;
        updateStudioPreview();
      });
    });

    // Custom File upload & Drag/Drop
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (file.size > PROMO_IMAGE_MAX_BYTES || !/^image\/(png|jpeg)$/.test(file.type)) {
          setPromoMessage('La imagen debe ser PNG o JPEG de máximo 1 MB.', 'error');
          return;
        }
        readFileAsDataUrl(file).then(function (dataUrl) {
          studioState.customDataUrl = dataUrl;
          studioState.fileName = file.name;
          document.querySelectorAll('.est-preset-btn').forEach(function (b) { b.classList.remove('active'); });
          if (el['est-dropzone-file-name']) el['est-dropzone-file-name'].textContent = '✓ ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
          if (clearFileBtn) clearFileBtn.hidden = false;
          updateStudioPreview();
        });
      });
    }

    if (clearFileBtn) {
      clearFileBtn.addEventListener('click', function () {
        studioState.customDataUrl = null;
        studioState.fileName = null;
        if (fileInput) fileInput.value = '';
        if (el['est-dropzone-file-name']) el['est-dropzone-file-name'].textContent = 'O arrastra el archivo aquí';
        clearFileBtn.hidden = true;
        var firstPreset = document.querySelector('.est-preset-btn');
        if (firstPreset) firstPreset.click();
        else updateStudioPreview();
      });
    }

    updateStudioPreview();
    if (typeof window.ResizeObserver === 'function' && el['est-studio-card-preview']) {
      new window.ResizeObserver(updateStudioPreviewSize).observe(el['est-studio-card-preview']);
    }
  }

  function updatePromotionRoomField() {
    var useRoom = el['est-promo-target'].value === '/room';
    el['est-promo-room-field'].hidden = !useRoom;
    el['est-promo-room-code'].required = useRoom;
  }
  var PROMO_IMAGE_MAX_BYTES = 1024 * 1024;
  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }
  function readImageAssetAsDataUrl(url) {
    return fetch(url, { cache: 'force-cache', credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('No se pudo cargar el fondo seleccionado.');
      return response.blob();
    }).then(readFileAsDataUrl);
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
      setPromoMessage('La imagen debe ser PNG o JPEG de máximo 1 MB.', 'error');
      return;
    }
    var copyVal = (el['est-promo-copy-input'].value || '').trim();
    var hasImage = Boolean(imageFile || studioState.customDataUrl || studioState.presetUrl);
    if (!hasImage && copyVal.length < 3) {
      setPromoMessage('Escribe un texto de al menos 3 caracteres o adjunta una imagen.', 'error');
      return;
    }
    var button = el['est-promo-submit'];
    button.disabled = true;
    setPromoMessage('Enviando a revisión; no se cobran fichas al enviar…', '');
    var payload = { matchId: S.currentMatchId, text: copyVal, targetPath: targetPath };
    var textPos = el['est-promo-text-pos'] ? el['est-promo-text-pos'].value : '';
    var textSize = el['est-promo-text-size'] ? el['est-promo-text-size'].value : '';
    var textAlign = el['est-promo-text-align'] ? el['est-promo-text-align'].value : '';
    var themeColor = el['est-promo-theme-color'] ? el['est-promo-theme-color'].value : '';
    var ctaText = el['est-promo-cta-input'] ? el['est-promo-cta-input'].value.trim() : '';

    if (textPos && textPos !== 'bottom') payload.textPosition = textPos;
    if (textSize && textSize !== 'medium') payload.textSize = textSize;
    if (textAlign && textAlign !== 'left') payload.textAlign = textAlign;
    if (themeColor && themeColor !== '#e5bd72') payload.themeColor = themeColor;
    if (ctaText && ctaText !== 'Ver más') payload.ctaText = ctaText;

    var imageReady = studioState.customDataUrl
      ? Promise.resolve(studioState.customDataUrl)
      : (imageFile
        ? readFileAsDataUrl(imageFile)
        : (studioState.presetUrl ? readImageAssetAsDataUrl(studioState.presetUrl) : Promise.resolve(null)));

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
      if (el['est-promo-image-input']) el['est-promo-image-input'].value = '';
      studioState.customDataUrl = null;
      studioState.fileName = null;
      if (el['est-dropzone-clear-btn']) el['est-dropzone-clear-btn'].hidden = true;
      if (el['est-dropzone-file-name']) el['est-dropzone-file-name'].textContent = 'O arrastra el archivo aquí';
      updateStudioPreview();
      setPromoMessage('Enviada y pendiente de revisión. No se han cobrado fichas.', 'success');
      loadOwnPromotion(S.currentMatchId);
    }).catch(function (error) {
      button.disabled = false;
      var imageError = error && error.message === 'No se pudo cargar el fondo seleccionado.';
      setPromoMessage(imageError ? error.message : 'No se pudo contactar al servidor. Inténtalo de nuevo.', 'error');
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
    setupStudioControls();
    el['est-showcase-prev'].addEventListener('click', function () {
      setShowcaseIndex(S.showcaseIndex - 1);
      restartShowcaseRotation();
    });
    el['est-showcase-next'].addEventListener('click', function () {
      setShowcaseIndex(S.showcaseIndex + 1);
      restartShowcaseRotation();
    });
    el['est-slip-clear'].addEventListener('click', closeSlip);
    el['est-place-bet'].addEventListener('click', placeBet);
    // Historial y pagos: vista propia (diálogo a pantalla completa).
    var ledgerNav = $('est-ledger-open-nav'), ledgerPanel = $('est-ledger-open');
    if (ledgerNav) ledgerNav.addEventListener('click', function (e) { openLedger(e.currentTarget); });
    if (ledgerPanel) ledgerPanel.addEventListener('click', function (e) { openLedger(e.currentTarget); });
    if (el['est-ledger-close']) el['est-ledger-close'].addEventListener('click', closeLedger);
    if (el['est-ledger-back']) el['est-ledger-back'].addEventListener('click', closeLedger);
    if (el['est-ledger-refresh']) el['est-ledger-refresh'].addEventListener('click', function () {
      loadBetHistory({ force: true }).then(function () { toast('Historial y pagos actualizados.', ''); });
    });
    if (el['est-ledger-only-match']) el['est-ledger-only-match'].addEventListener('click', function () {
      S.betsOnlyMatch = !S.betsOnlyMatch;
      renderLedger();
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-ledger-filter]'), function (chip) {
      chip.addEventListener('click', function () { setLedgerFilter(chip.getAttribute('data-ledger-filter')); });
    });
    if (el['est-ledger']) {
      // Clic en el fondo cierra; el contenido no propaga.
      el['est-ledger'].addEventListener('click', function (e) { if (e.target === el['est-ledger']) closeLedger(); });
      el['est-ledger'].addEventListener('keydown', trapLedgerFocus);
    }
    // Enlace directo /estadio#apuestas (y botón atrás del navegador).
    if (location.hash === LEDGER_HASH) openLedger(null);
    window.addEventListener('hashchange', function () {
      if (location.hash === LEDGER_HASH) openLedger(null);
      else if (ledgerOpen()) closeLedger();
    });
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
    el['est-ads-open'].addEventListener('click', function () {
      el['est-ads'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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
    // Con el historial abierto, el teclado pertenece al diálogo (solo Esc actúa).
    if (ledgerOpen()) {
      if (k === 'escape') { e.preventDefault(); closeLedger(); }
      return;
    }
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
