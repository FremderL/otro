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
  // Inauguración del Balón de Oro. Antes duraba 45 s y cada candidato aparecía
  // 2 s: se sentía apurada. Ahora se reparte en actos y son ~1:48, con casi 5 s
  // por jugador. La narración (≈49,5 s) cubre el primer bloque; el tema instrumental
  // del Balón de Oro acompaña el segundo, así que el tiempo extra no es silencio.
  var BALLON_DOR_OPENING_SECONDS = 108;
  // Reparto por actos (fracciones de la duración total): apertura, alineación de
  // los 16 clubes y cierre. Las 16 presentaciones se llevan el resto.
  var BALLON_DOR_OPENING_ACTS = { intro: 0.065, lineup: 0.09, final: 0.14 };
  var BALLON_DOR_OPENING_MIN_REVEAL = 3;   // segundos mínimos por candidato
  var BALLON_DOR_OPENING_BED_VOLUME = 0.35; // el tema acompaña, no tapa
  var BALLON_DOR_CEREMONY_CUE_BASE = '/assets/ballon-dor-ceremony/cues/';
  var BALLON_DOR_CEREMONY_NAME_BASE = '/assets/ballon-dor-ceremony/names/';
  var BALLON_DOR_OPENING_KEY = 'montecristo-bdo-opening-v2:';
  var BALLON_DOR_CEREMONY_AUDIO_KEY = 'montecristo-bdo-ceremony-audio-v1';
  var IS_BDO_DEDICATED_PAGE = String(location.pathname || '').replace(/\/+$/, '') === '/balon-de-oro';
  var IS_BDO_DEMO_PREVIEW = false;
  try { IS_BDO_DEMO_PREVIEW = IS_BDO_DEDICATED_PAGE && new URLSearchParams(location.search || '').get('demo') === '1'; }
  catch (_) { IS_BDO_DEMO_PREVIEW = false; }
  var BALLON_DOR_OPENING_SCRIPT = 'La Liga MonteCristo presenta una nueva carrera por el Balón de Oro. Dieciséis clubes. Dieciséis delanteros. Un solo ganador. Cada gol, cada asistencia y cada aparición suman. Las tarjetas restan; el rendimiento del equipo también puede inclinar la balanza. La regularidad, la disciplina y el trabajo colectivo también importan. El camino empieza hoy. En cada jornada, el fútbol escribe un capítulo. Tus predicciones se juegan solo con fichas virtuales y cierran al terminar la jornada veinte. Observa a los candidatos. Revisa sus estadísticas. Elige tu pronóstico. Al final de la temporada, las cifras coronarán a quien haya rendido mejor. Que comience la temporada MonteCristo.';
  function requestedBallonDorSeasonMonth() {
    try {
      var month = new URLSearchParams(location.search || '').get('seasonMonth');
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')) ? month : null;
    } catch (_) { return null; }
  }
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
  function reportBallonDorAudio(track, outcome, seasonMonth) {
    var month = String(seasonMonth || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !window.fetch) return;
    try {
      var request = window.fetch('/api/estadio/telemetry/audio', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: track, outcome: outcome, seasonMonth: month })
      });
      if (request && typeof request.catch === 'function') request.catch(function () {});
    } catch (_) {
      // Métrica opcional: una falla de red nunca detiene la narración ni la escena.
    }
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
    fantasy: null, fantasyDraft: [], fantasyDirty: false, fantasySeq: 0, fantasyBusy: false,
    fan: null, fanBusy: false, fanSeq: 0,
    lobby: null, standings: [], countdownTo: null, lobbyServerNow: null, lobbyReceivedAt: null,
    preshowDataMatchId: null, preshowDataStandings: null, teamIndicators: [],
    showcaseItems: [], showcaseIndex: 0, showcaseRotationId: null, sponsoredPromotions: [],
    promotionsEnabled: false, promoSessionChecked: false, promoProfile: null, promoCsrfToken: null,
    promoWindowOpen: false, promoMatchId: null, promoPollId: null, promoRequestSeq: 0,
    currentMatchId: null, match: null, markets: {}, movement: {}, myBets: [],
    ballonDorMarket: null, ballonDorLoading: true, ballonDorError: false, ballonDorRequestSeq: 0,
    ballonDorRequestedSeasonMonth: requestedBallonDorSeasonMonth(),
    ballonDorArchive: [], ballonDorArchiveLoading: true, ballonDorArchiveError: false, ballonDorArchiveRequestSeq: 0,
    ballonDorPollingId: null, ballonDorSelection: '', ballonDorReview: null,
    ballonDorCeremonyFocus: null, ballonDorCeremonyTimer: null, ballonDorCeremonyUnlockTimer: null,
    ballonDorCeremonyDelayTimer: null, ballonDorCeremonyDelayKind: null, ballonDorCeremonyDelayDueAt: 0,
    ballonDorCeremonyDelayDuration: 0, ballonDorCeremonyDelayRemaining: 0,
    ballonDorCeremonyUnlockAt: 0, ballonDorCeremonyElapsed: 0, ballonDorCeremonyStartedAt: 0,
    ballonDorCeremonySession: 0, ballonDorCeremonyPaused: false, ballonDorCeremonyComplete: false,
    ballonDorCeremonyScene: null, ballonDorCeremonyRows: [], ballonDorCeremonyMonth: null,
    ballonDorCeremonySequence: [], ballonDorCeremonyStepIndex: 0, ballonDorCeremonyFallbackMode: false,
    ballonDorCeremonyRevealedRanks: Object.create(null), ballonDorCeremonyNarrationReported: false,
    ballonDorCeremonyMusicReported: false,
    ballonDorCeremonyMusicMuted: false, ballonDorCeremonyNarrationMuted: false, ballonDorCeremonyAudioBlocked: false,
    ballonDorIdempotencyKey: null, ballonDorSubmitting: false, ballonDorReceipt: null,
    ballonDorOpeningFocus: null, ballonDorOpeningTimer: null, ballonDorOpeningElapsed: 0,
    ballonDorOpeningStartedAt: 0, ballonDorOpeningDuration: BALLON_DOR_OPENING_SECONDS,
    ballonDorOpeningMode: 'audio', ballonDorOpeningPaused: false, ballonDorOpeningSession: 0,
    ballonDorOpeningScene: null, ballonDorOpeningComplete: false, ballonDorOpeningMandatory: false,
    ballonDorOpeningAudioBlocked: false, ballonDorOpeningAutoShown: Object.create(null),
    ballonDorOpeningCandidates: [], ballonDorOpeningMonth: null, ballonDorOpeningMuted: false,
    betHistory: null, betHistoryFetchedAt: 0, betsUnseen: null, betsLoading: false, betsError: null,
    betRanking: null, betRankingSource: 'total', betRankingSubscribed: false, ledgerView: 'history',
    betsOnlyMatch: false, betsRequestSeq: 0, ledgerFilter: 'all', ledgerTrigger: null,
    slip: null, muted: false, commentaryVoiceOn: false,
    soundOn: localStorage.getItem('montecristo-notifications') !== 'off', musicOn: localStorage.getItem('montecristo-music') === 'on',
    players: [], authoritativePlayers: [], possessionTeam: 'home', ballCarrierId: null, playStopped: true,
    ball: { x: .5, y: .5 }, ballStart: { x: .5, y: .5 }, ballDest: { x: .5, y: .5 },
    ballT0: 0, ballDur: 800, playerT0: 0, playerDur: 1900,
    serverMinute: 0, minuteReceivedAt: 0,
    stoppage: null, // { half, added }: minutos que el árbitro añadió en la mitad en curso
    minute: 0, phase: 'pre', score: { home: 0, away: 0 }, possession: { home: .5, away: .5 },
    goalFlashUntil: 0, goalAnimUntil: 0, goalCueAt: 0, homeKit: '#52e0ae', awayKit: '#ff667c', rafId: null, pitchCache: null, submitting: false,
    crowdLastSentAt: 0,
    // Grada: votación de moderación y autorización de insultos del partido.
    stands: null
  };

  var el = {};
  function cacheEls() {
    ['est-fantasy-summary', 'est-fantasy-form', 'est-fantasy-players', 'est-fantasy-save', 'est-fantasy-feedback', 'est-fantasy-opt', 'est-fantasy-challenges', 'est-fantasy-ranking',
      'est-connection', 'est-chips', 'est-sound', 'est-music', 'est-ads', 'est-ads-open', 'est-countdown', 'est-match-list', 'est-standings',
      'est-preshow', 'est-preshow-status', 'est-preshow-timer', 'est-showcase', 'est-showcase-track',
      'est-compare-home', 'est-compare-away', 'est-showcase-count', 'est-showcase-prev', 'est-showcase-next', 'est-showcase-dots', 'est-preshow-promo', 'est-promo-image', 'est-promo-label', 'est-promo-text', 'est-promo-link',
      'est-promo-compose', 'est-promo-auth', 'est-promo-login', 'est-promo-refresh', 'est-promo-form',
      'est-studio-card-preview', 'est-studio-preview-img', 'est-studio-preview-size', 'est-studio-preview-label', 'est-studio-preview-text', 'est-studio-preview-btn',
      'est-promo-char-count', 'est-promo-text-pos', 'est-promo-text-size', 'est-promo-text-align', 'est-promo-theme-color', 'est-promo-cta-input',
      'est-upload-dropzone', 'est-dropzone-file-name', 'est-dropzone-clear-btn', 'est-studio-text-fields', 'est-studio-presets-row',
      'est-promo-copy-input', 'est-promo-image-input', 'est-promo-target', 'est-promo-room-field', 'est-promo-room-code',
      'est-promo-submit', 'est-promo-message',
      'est-scoreboard', 'crest-home', 'crest-away', 'name-home', 'name-away', 'score-home', 'score-away',
      'est-clock', 'est-pitch', 'est-goal-banner', 'est-commentary', 'est-commentary-voice', 'est-text-state', 'est-market-phase',
      'est-crowd-feed', 'est-crowd-form', 'est-crowd-input', 'est-crowd-send', 'est-crowd-message', 'est-crowd-reactions',
      'est-countdown-season', 'est-countdown-season-note', 'est-countdown-bdo', 'est-countdown-bdo-note',
      'est-danmaku', 'est-stands-vote', 'est-stands-status', 'est-stands-open', 'est-stands-yes',
      'est-stands-no', 'est-stands-tally',
      'est-markets', 'est-bet-slip', 'est-slip-pick', 'est-slip-clear', 'est-slip-odds', 'est-slip-implied',
      'est-stake', 'est-denoms', 'est-slip-range', 'est-place-bet', 'est-bet-msg', 'est-mybets',
      'est-mybets-count', 'est-bets-link-note', 'est-bets-link-dot',
      'est-bdo-status', 'est-bdo-feed', 'est-bdo-summary', 'est-bdo-feedback', 'est-bdo-retry',
      'est-bdo-finalization-message', 'est-bdo-finalization-date',
      'est-bdo-ceremony-panel', 'est-bdo-ceremony-panel-status', 'est-bdo-ceremony-start',
      'est-bdo-archive', 'est-bdo-archive-status', 'est-bdo-archive-list',
      'est-bdo-ceremony', 'est-bdo-ceremony-dialog', 'est-bdo-ceremony-status', 'est-bdo-ceremony-stage',
      'est-bdo-ceremony-kicker', 'est-bdo-ceremony-title', 'est-bdo-ceremony-description',
      'est-bdo-ceremony-nominees', 'est-bdo-ceremony-podium', 'est-bdo-ceremony-breakdown', 'est-bdo-ceremony-payout', 'est-bdo-ceremony-caption',
      'est-bdo-ceremony-progress', 'est-bdo-ceremony-progress-bar', 'est-bdo-ceremony-time',
      'est-bdo-ceremony-play', 'est-bdo-ceremony-music', 'est-bdo-ceremony-narration',
      'est-bdo-ceremony-replay', 'est-bdo-ceremony-close', 'est-bdo-ceremony-music-audio',
      'est-bdo-ceremony-narration-audio', 'est-bdo-ceremony-transcript-copy',
      'est-bdo-table-wrap', 'est-bdo-candidates', 'est-bdo-bet-area', 'est-bdo-slip', 'est-bdo-bounds',
      'est-bdo-selection', 'est-bdo-stake', 'est-bdo-quote', 'est-bdo-review', 'est-bdo-confirmation',
      'est-bdo-confirmation-copy', 'est-bdo-confirm', 'est-bdo-edit', 'est-bdo-message',
      'est-bdo-receipt', 'est-bdo-receipt-body', 'est-bdo-opening-start', 'est-bdo-opening', 'est-bdo-opening-dialog', 'est-bdo-opening-status',
      'est-bdo-opening-stage', 'est-bdo-opening-kicker', 'est-bdo-opening-title', 'est-bdo-opening-description', 'est-bdo-opening-cta',
      'est-bdo-opening-clubs', 'est-bdo-opening-cards', 'est-bdo-opening-caption',
      'est-bdo-opening-progress', 'est-bdo-opening-progress-bar', 'est-bdo-opening-time', 'est-bdo-opening-play',
      'est-bdo-opening-mute', 'est-bdo-opening-enable-audio', 'est-bdo-opening-skip', 'est-bdo-opening-close', 'est-bdo-opening-audio', 'est-bdo-opening-bed', 'est-bdo-opening-transcript-copy',
      'est-nav-badge', 'est-ledger', 'est-ledger-title', 'est-ledger-sub', 'est-ledger-unseen', 'est-ledger-stats', 'est-ledger-chips',
      'est-ledger-history-view', 'est-ledger-ranking-view', 'est-ledger-tab-history', 'est-ledger-tab-ranking', 'est-ledger-ranking-back',
      'est-bet-ranking-live', 'est-bet-ranking-personal', 'est-bet-ranking-updated', 'est-bet-ranking-list',
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
    if (IS_BDO_DEDICATED_PAGE || !shouldPlayEntry()) return;
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

  function configureBallonDorPage() {
    document.body.classList.toggle('est-bdo-dedicated', IS_BDO_DEDICATED_PAGE);
    if (!IS_BDO_DEDICATED_PAGE) return;
    var demoMonth = IS_BDO_DEMO_PREVIEW ? (requestedBallonDorSeasonMonth() || '2026-09') : null;
    document.title = IS_BDO_DEMO_PREVIEW
      ? 'Demo sintética · ' + demoMonth + ' · Balón de Oro MonteCristo'
      : 'Balón de Oro MonteCristo — Evento mensual';
    var description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', IS_BDO_DEMO_PREVIEW
      ? 'Demo local sintética del Balón de Oro MonteCristo; los resultados son ficticios y no representan una edición real.'
      : 'Espacio oficial del evento Balón de Oro MonteCristo: presentación de los 16 delanteros, estadísticas, predicciones virtuales y anuncio final.');
    if (IS_BDO_DEMO_PREVIEW) {
      ['est-bdo-demo-notice', 'est-bdo-opening-demo-notice', 'est-bdo-ceremony-demo-notice'].forEach(function (id) {
        var notice = document.getElementById(id);
        if (!notice) return;
        notice.hidden = false;
        var label = notice.querySelector('strong');
        if (label) label.textContent = 'DEMO · EDICIÓN ' + demoMonth + ' · DATOS SINTÉTICOS.';
      });
    }
    var skipLink = document.querySelector('.skip-link');
    if (skipLink) skipLink.textContent = 'Ir al evento Balón de Oro';
    var launchKicker = document.querySelector('.est-bdo-opening-launch-kicker');
    if (launchKicker) launchKicker.textContent = IS_BDO_DEMO_PREVIEW
      ? 'Demo sintética · inauguración de 1:48'
      : 'Inauguración oficial · 1:48';
    var launchCopy = document.querySelector('.est-bdo-opening-launch-copy');
    if (launchCopy) launchCopy.textContent = 'En la primera visita se abre una presentación individual de los 16 candidatos. La fecha de llegada no importa: puedes conocer el evento aunque entres avanzado el ciclo.';
  }

  function boot() {
    configureBallonDorPage();
    maybePlayEntry();
    cacheEls();
    S.token = deviceToken();
    S.name = localStorage.getItem('montecristo-name') || ('Aficionado ' + S.token.slice(-4).toUpperCase());
    S.avatar = localStorage.getItem('montecristo-avatar') || 'fox';
    bindUI();
    bindCrowdControls();
    initPitchCanvas();
    loadBallonDorMarket(); // primera pintura por HTTP; funciona aunque Socket.IO no cargue
    if (IS_BDO_DEDICATED_PAGE) loadBallonDorArchive();
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
        return fetch('/api/estadio/state?token=' + encodeURIComponent(S.token), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || !data.ok) return;
            S.teams = data.teams || {};
            S.tosVersion = data.tosVersion || TOS_FALLBACK;
            if (data.profile) {
              S.profile = data.profile; S.chips = data.profile.chips; updateChips();
              if (data.profile.id) loadBetHistory({ force: true });
              renderBallonDorMarket();
            }
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
    if (typeof window.io !== 'function') {
      setConn('error');
      startBallonDorPolling();
      return;
    }
    try { S.socket = window.io({ auth: { deviceToken: S.token } }); }
    catch (_) {
      S.socket = null;
      setConn('error');
      startBallonDorPolling();
      return;
    }
    S.socket.on('connect', function () {
      setConn('connected');
      stopBallonDorPolling();
      updateCrowdAvailability();
      subscribeLobby();
      requestBallonDorMarket();
      if (S.betRankingSubscribed && ledgerOpen() && S.ledgerView === 'ranking') S.socket.emit('bet_ranking_get');
      renderBetRanking();
    });
    S.socket.on('disconnect', function () { S.fantasySeq++; S.fantasyBusy = false; S.fanSeq++; S.fanBusy = false; setConn('error'); startBallonDorPolling(); renderBetRanking(); updateCrowdAvailability(); });
    S.socket.on('connect_error', function () { setConn('error'); startBallonDorPolling(); });
    S.socket.on('football:lobby', function (lobby) { renderLobby(lobby); });
    S.socket.on('football:ballon_dor_market', function (payload) {
      S.ballonDorRequestSeq++;
      setBallonDorFeed('socket', 'En vivo · Socket.IO');
      var market = payload && Object.prototype.hasOwnProperty.call(payload, 'market') ? payload.market : payload;
      applyBallonDorMarket(market || null);
    });
    S.socket.on('football:tick', onTick);
    S.socket.on('football:event', onEvent);
    S.socket.on('football:goal', onGoalCue);
    S.socket.on('football:chat', onCrowdChat);
    S.socket.on('football:stands_state', onStandsState);
    S.socket.on('football:reaction', onCrowdReaction);
    S.socket.on('football:commentary', onCommentary);
    S.socket.on('football:odds', onOdds);
    S.socket.on('football:settlement', onSettlement);
    S.socket.on('bet_ranking_state', function (snapshot) {
      if (!snapshot || !snapshot.ranking) return;
      S.betRanking = snapshot;
      if (ledgerOpen() && S.ledgerView === 'ranking') renderBetRanking();
    });
    S.socket.on('football:status', onStatus);
    S.socket.on('football:rescheduled', onRescheduled);
    // Cuenta moderada: el servidor avisa 250 ms antes de cerrar la sesión. La
    // publicidad exige cuenta, así que el formulario vuelve a modo invitado.
    S.socket.on('account_moderated', function (data) {
      S.promoProfile = null;
      S.promoCsrfToken = null;
      updatePromotionComposer();
      toast(data && data.status === 'banned'
        ? 'Tu cuenta fue bloqueada. Puedes seguir como invitado.'
        : 'Tu cuenta fue suspendida. Puedes seguir como invitado.', 'lose');
    });
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
      refreshFantasy();
      refreshFan();
      renderBallonDorMarket();
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

  // ===== Balón de Oro: lectura viva, fallback HTTP, predicción y recibo =====
  var BALLON_DOR_MARKET = 'balon_de_oro';
  var BALLON_DOR_POLL_MS = 15000;

  function setBallonDorFeed(state, text) {
    if (!el['est-bdo-feed']) return;
    el['est-bdo-feed'].textContent = text;
    el['est-bdo-feed'].dataset.state = state;
  }

  function setBallonDorMessage(text, state) {
    if (!el['est-bdo-message']) return;
    el['est-bdo-message'].textContent = text || '';
    if (state) el['est-bdo-message'].dataset.state = state;
    else delete el['est-bdo-message'].dataset.state;
  }

  function startBallonDorPolling() {
    setBallonDorFeed('http', 'Respaldo HTTP · actualización cada 15 s');
    if (S.ballonDorPollingId != null) return;
    S.ballonDorPollingId = window.setInterval(loadBallonDorMarket, BALLON_DOR_POLL_MS);
  }

  function stopBallonDorPolling() {
    if (S.ballonDorPollingId == null) return;
    window.clearInterval(S.ballonDorPollingId);
    S.ballonDorPollingId = null;
  }

  function loadBallonDorMarket() {
    var seq = ++S.ballonDorRequestSeq;
    if (!S.ballonDorMarket) S.ballonDorLoading = true;
    renderBallonDorMarket();
    var query = S.ballonDorRequestedSeasonMonth
      ? '?seasonMonth=' + encodeURIComponent(S.ballonDorRequestedSeasonMonth) : '';
    return fetch('/api/estadio/ballon-dor' + query, { cache: 'no-store' })
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          return { ok: response.ok !== false, data: data };
        });
      })
      .then(function (result) {
        if (seq !== S.ballonDorRequestSeq) return null;
        if (!result.ok || !result.data || !result.data.ok) throw new Error('mercado_no_disponible');
        S.ballonDorError = false;
        S.ballonDorLoading = false;
        applyBallonDorMarket(result.data.market || null);
        if (S.socket && S.socket.connected) setBallonDorFeed('socket', 'En vivo · Socket.IO');
        else setBallonDorFeed('http', 'Respaldo HTTP · actualización cada 15 s');
        return result.data.market || null;
      })
      .catch(function () {
        if (seq !== S.ballonDorRequestSeq) return null;
        S.ballonDorLoading = false;
        S.ballonDorError = true;
        setBallonDorFeed('error', 'Sin actualización del servidor');
        if (!S.ballonDorMarket) {
          setBallonDorFeedback('No pudimos cargar el mercado. Revisa tu conexión e inténtalo de nuevo.', 'error');
        } else {
          setBallonDorFeedback('No se pudo actualizar; se conserva la última información recibida.', 'error');
        }
        renderBallonDorMarket();
        return null;
      });
  }

  function requestBallonDorMarket() {
    if (!S.socket || !S.socket.connected) return;
    S.socket.emit('football:ballon_dor_market', {
      seasonMonth: S.ballonDorRequestedSeasonMonth || undefined
    }, function (result) {
      if (result && result.ok) {
        S.ballonDorRequestSeq++;
        setBallonDorFeed('socket', 'En vivo · Socket.IO');
        applyBallonDorMarket(result.market || null);
      }
    });
  }

  function applyBallonDorMarket(market) {
    if (market && S.ballonDorRequestedSeasonMonth
        && String(market.seasonMonth || '') !== S.ballonDorRequestedSeasonMonth) return;
    var previous = S.ballonDorMarket;
    if (market && previous) {
      if (String(market.seasonMonth || '') < String(previous.seasonMonth || '')) return;
      if (market.seasonMonth === previous.seasonMonth
          && Number(market.updatedAt || 0) < Number(previous.updatedAt || 0)) return;
    }
    if (!market) {
      S.ballonDorMarket = null;
      S.ballonDorSelection = '';
      S.ballonDorReview = null;
      S.ballonDorIdempotencyKey = null;
      S.ballonDorError = false;
      S.ballonDorLoading = false;
      renderBallonDorMarket();
      return;
    }
    if (S.ballonDorReview && previous && previous.seasonMonth === market.seasonMonth) {
      var priorQuote = (previous.candidates || []).find(function (candidate) {
        return candidate.id === S.ballonDorReview.selection;
      });
      var nextQuote = (market.candidates || []).find(function (candidate) {
        return candidate.id === S.ballonDorReview.selection;
      });
      if (!priorQuote || !nextQuote || Number(priorQuote.odds) !== Number(nextQuote.odds)
          || market.status !== 'active') {
        S.ballonDorReview = null;
        S.ballonDorIdempotencyKey = null;
        setBallonDorMessage('El mercado cambió mientras revisabas. Confirma de nuevo con la cuota vigente.', 'error');
      }
    }
    S.ballonDorMarket = market;
    S.ballonDorError = false;
    S.ballonDorLoading = false;
    if (S.ballonDorSelection && !(market.candidates || []).some(function (candidate) {
      return candidate.id === S.ballonDorSelection;
    })) S.ballonDorSelection = '';
    renderBallonDorMarket();
    if (!previous) renderBallonDorArchive();
    maybeAutoOpenBallonDorOpening();
    if (IS_BDO_DEDICATED_PAGE && market.status === 'settled'
        && (!previous || previous.status !== 'settled' || (!previous.result && market.result))) loadBallonDorArchive();
  }

  function setBallonDorFeedback(text, state) {
    var box = el['est-bdo-feedback'];
    if (!box) return;
    box.textContent = text || '';
    if (state) box.dataset.state = state;
    else delete box.dataset.state;
  }

  function ballonDorMonthLabel(seasonMonth) {
    var match = /^(\d{4})-(\d{2})$/.exec(String(seasonMonth || ''));
    if (!match) return String(seasonMonth || 'esta temporada');
    try {
      return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString('es-MX', {
        month: 'long', year: 'numeric', timeZone: 'UTC'
      });
    } catch (_) { return String(seasonMonth); }
  }

  function ballonDorOfficialRows(market) {
    if (!market || market.status !== 'settled' || !market.result || !market.ceremony
        || market.ceremony.verified !== true || market.ceremony.eventId !== market.eventId
        || market.ceremony.seasonMonth !== market.seasonMonth
        || Number(market.ceremony.finalizedAt) !== Number(market.result.finalizedAt)
        || !Array.isArray(market.candidates) || market.candidates.length !== 16
        || !Array.isArray(market.result.ranking) || market.result.ranking.length !== 16) return null;
    var byId = new Map(market.candidates.map(function (candidate) { return [candidate.id, candidate]; }));
    var ranking = market.result.ranking.slice().sort(function (a, b) { return Number(a.rank) - Number(b.rank); });
    var seen = Object.create(null);
    var rows = [];
    for (var i = 0; i < ranking.length; i++) {
      var row = ranking[i];
      var candidate = row && byId.get(row.candidateId);
      if (!candidate || seen[row.candidateId] || Number(row.rank) !== i + 1
          || !Number.isSafeInteger(Number(row.score))
          || Number(candidate.points && candidate.points.total) !== Number(row.score)) return null;
      seen[row.candidateId] = true;
      rows.push({ rank: i + 1, score: Number(row.score), candidate: candidate });
    }
    if (rows[0].candidate.id !== market.result.winnerCandidateId
        || rows[0].score !== Number(market.result.winnerScore)) return null;
    return rows;
  }

  function loadBallonDorArchive() {
    if (!IS_BDO_DEDICATED_PAGE) return Promise.resolve(null);
    var seq = ++S.ballonDorArchiveRequestSeq;
    S.ballonDorArchiveLoading = true;
    S.ballonDorArchiveError = false;
    renderBallonDorArchive();
    return fetch('/api/estadio/ballon-dor/archive', { cache: 'no-store' })
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          return { ok: response.ok !== false, data: data };
        });
      })
      .then(function (result) {
        if (seq !== S.ballonDorArchiveRequestSeq) return null;
        if (!result.ok || !result.data || !result.data.ok || !Array.isArray(result.data.cycles)) {
          throw new Error('archive_unavailable');
        }
        S.ballonDorArchive = result.data.cycles;
        S.ballonDorArchiveError = false;
        S.ballonDorArchiveLoading = false;
        renderBallonDorArchive();
        return S.ballonDorArchive;
      })
      .catch(function () {
        if (seq !== S.ballonDorArchiveRequestSeq) return null;
        S.ballonDorArchiveError = true;
        S.ballonDorArchiveLoading = false;
        renderBallonDorArchive();
        return null;
      });
  }

  function renderBallonDorArchive() {
    var nav = el['est-bdo-archive'];
    var list = el['est-bdo-archive-list'];
    var status = el['est-bdo-archive-status'];
    if (!nav || !list || !status) return;
    nav.hidden = !IS_BDO_DEDICATED_PAGE;
    list.textContent = '';
    if (S.ballonDorArchiveLoading) {
      status.textContent = 'Consultando ediciones guardadas…';
      return;
    }
    if (S.ballonDorArchiveError) {
      status.textContent = 'No se pudo cargar el archivo. El resultado abierto sigue disponible.';
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'text-button';
      retry.textContent = 'Reintentar';
      retry.addEventListener('click', loadBallonDorArchive);
      list.appendChild(retry);
      return;
    }
    var cycles = Array.isArray(S.ballonDorArchive) ? S.ballonDorArchive : [];
    status.textContent = cycles.length ? 'Cada enlace vuelve a leer la edición persistida; repetir no vuelve a liquidar.' : 'Todavía no hay ediciones guardadas.';
    if (!cycles.length) {
      var empty = document.createElement('p');
      empty.className = 'est-bdo-archive-empty';
      empty.textContent = 'Las ceremonias y resultados oficiales aparecerán aquí después del cierre de cada temporada.';
      list.appendChild(empty);
      return;
    }
    var currentMonth = S.ballonDorRequestedSeasonMonth || (S.ballonDorMarket && S.ballonDorMarket.seasonMonth);
    cycles.forEach(function (cycle) {
      if (!cycle || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(cycle.seasonMonth || ''))) return;
      var link = document.createElement('a');
      link.className = 'est-bdo-archive-link';
      link.href = '/balon-de-oro?seasonMonth=' + encodeURIComponent(cycle.seasonMonth)
        + (IS_BDO_DEMO_PREVIEW ? '&demo=1' : '');
      if (cycle.seasonMonth === currentMonth) link.setAttribute('aria-current', 'page');
      var month = document.createElement('span');
      month.className = 'est-bdo-archive-month';
      month.textContent = ballonDorMonthLabel(cycle.seasonMonth);
      var result = document.createElement('span');
      result.className = 'est-bdo-archive-result';
      if (cycle.winner && cycle.status === 'settled') {
        result.innerHTML = '🏆 ' + esc(cycle.winner.playerName) + ' · ' + clubCrestMarkup(cycle.winner.clubId, 'est-inline-crest') + esc(cycle.winner.clubName) + ' · ' + fmt(cycle.winner.score) + ' puntos';
      } else if (cycle.status === 'cancelled') result.textContent = 'Edición cancelada · no se liquidó un ganador.';
      else result.textContent = 'Edición ' + (cycle.status || 'sin estado') + ' · consulta la clasificación oficial.';
      var state = document.createElement('span');
      state.className = 'est-bdo-archive-state';
      state.textContent = cycle.status === 'settled' && cycle.ceremony && cycle.ceremony.verified
        ? 'Resultado verificado · repetir ceremonia' : 'Abrir edición';
      link.appendChild(month);
      link.appendChild(result);
      link.appendChild(state);
      list.appendChild(link);
    });
  }

  function ceremonyEligibleAt(market) {
    var finalizedAt = Number(market && market.result && market.result.finalizedAt) || 0;
    var scheduledAt = Number(market && market.finalization && market.finalization.scheduledAt) || 0;
    var announcementAt = Number(market && market.resultAnnouncementAt) || 0;
    return Math.max(finalizedAt, scheduledAt, announcementAt);
  }

  function scheduleBallonDorCeremonyUnlock(market) {
    var unlockAt = ceremonyEligibleAt(market);
    var waitingForPublicAnnouncement = Boolean(market && market.status === 'settled'
      && !market.result && unlockAt > Date.now());
    var rows = ballonDorOfficialRows(market);
    if (!waitingForPublicAnnouncement && !rows) {
      if (S.ballonDorCeremonyUnlockTimer != null) window.clearTimeout(S.ballonDorCeremonyUnlockTimer);
      S.ballonDorCeremonyUnlockTimer = null;
      S.ballonDorCeremonyUnlockAt = 0;
      return;
    }
    if (!Number.isFinite(unlockAt) || unlockAt <= Date.now()) {
      if (S.ballonDorCeremonyUnlockTimer != null) window.clearTimeout(S.ballonDorCeremonyUnlockTimer);
      S.ballonDorCeremonyUnlockTimer = null;
      S.ballonDorCeremonyUnlockAt = unlockAt;
      return;
    }
    if (S.ballonDorCeremonyUnlockAt === unlockAt && S.ballonDorCeremonyUnlockTimer != null) return;
    if (S.ballonDorCeremonyUnlockTimer != null) window.clearTimeout(S.ballonDorCeremonyUnlockTimer);
    S.ballonDorCeremonyUnlockAt = unlockAt;
    S.ballonDorCeremonyUnlockTimer = window.setTimeout(function () {
      S.ballonDorCeremonyUnlockTimer = null;
      if (waitingForPublicAnnouncement) loadBallonDorMarket();
      else renderBallonDorMarket();
    }, Math.min(unlockAt - Date.now() + 25, 2147480000));
  }

  function renderBallonDorCeremonyPanel(market) {
    var panel = el['est-bdo-ceremony-panel'];
    var status = el['est-bdo-ceremony-panel-status'];
    var button = el['est-bdo-ceremony-start'];
    if (!panel || !status || !button) return;
    var settled = Boolean(market && market.status === 'settled');
    panel.hidden = !settled;
    if (!settled) {
      button.disabled = true;
      scheduleBallonDorCeremonyUnlock(null);
      return;
    }
    var rows = ballonDorOfficialRows(market);
    var verified = Boolean(rows);
    var eligibleAt = ceremonyEligibleAt(market);
    var waitingForAnnouncement = !market.result && eligibleAt > Date.now();
    var available = verified && eligibleAt > 0 && Date.now() >= eligibleAt;
    button.disabled = !available;
    button.textContent = S.ballonDorRequestedSeasonMonth ? 'Repetir ceremonia del archivo' : 'Ver ceremonia final';
    if (waitingForAnnouncement) {
      status.textContent = 'El cierre oficial ya está guardado. La identidad del podio se publicará en la ceremonia de las 10:00 p. m., después del último partido.';
    } else if (!verified) {
      status.textContent = 'No se puede validar el resultado persistido; la ceremonia queda bloqueada.';
    } else if (!available) {
      var date = formatBallonDorScheduleDate(eligibleAt, market.finalization?.timeZone || 'America/Mexico_City');
      status.textContent = 'Resultado persistido y verificado. La ceremonia se habilita a las 10:00 p. m., después del último partido.' + (date ? ' Horario: ' + date + '.' : '');
    } else if (market.ceremony && market.ceremony.settlementComplete) {
      status.textContent = 'Resultado oficial verificado. Las predicciones acertadas ya se liquidaron en fichas virtuales; puedes reproducir el evento sin repetir pagos.';
    } else {
      var pending = Number(market.ceremony && market.ceremony.pendingPayoutCount) || 0;
      status.textContent = 'Resultado oficial verificado. La conciliación de ' + pending + ' predicción(es) sigue pendiente; el replay no modifica la liquidación.';
    }
    scheduleBallonDorCeremonyUnlock(market);
  }

  function ballonDorCancelReason(reason) {
    return ({
      temporada_truncada: 'La temporada se truncó antes de poder cerrar el premio.',
      apertura_no_realizada_dia_1: 'El ciclo no pudo abrirse el día 1.',
      calendario_invalido: 'El calendario no cumplió las condiciones para abrir el mercado.',
      temporada_no_cerrada_antes_reset: 'La temporada no se completó válidamente antes del reset mensual.',
      desempate_no_resuelto_antes_reset: 'El desempate oficial no pudo resolverse antes del reset mensual.',
      desempate_no_cabe_en_ventana_de_cierre: 'No quedó tiempo suficiente para resolver el desempate oficial.'
    })[reason] || 'El ciclo se canceló (' + String(reason || 'motivo no disponible').replace(/[_<>]/g, ' ') + ').';
  }

  function currentBallonDorTicket() {
    var market = S.ballonDorMarket;
    var month = market && market.seasonMonth;
    var entries = S.betHistory && Array.isArray(S.betHistory.entries) ? S.betHistory.entries : [];
    var entry = entries.find(function (item) {
      return item.kind === 'future' && item.market === BALLON_DOR_MARKET
        && (!month || item.seasonMonth === month);
    });
    if (entry) return entry;
    if (S.ballonDorReceipt && S.ballonDorReceipt.market === BALLON_DOR_MARKET
        && (!month || S.ballonDorReceipt.seasonMonth === month)) return S.ballonDorReceipt;
    return null;
  }

  function ballonDorStakeBounds() {
    var chips = Math.max(0, Math.floor(Number(S.chips) || 0));
    var max = Math.min(Math.floor(chips * STAKE_MAX_FRAC), STAKE_ABS_MAX);
    var min = Math.min(Math.max(1, Math.floor(chips * STAKE_MIN_FRAC)), chips);
    if (min > max) min = max;
    return { min: Math.max(0, min), max: Math.max(0, max) };
  }

  function ballonDorQuote(candidate) {
    if (!candidate || !Number.isFinite(Number(candidate.odds))) return null;
    return Number(candidate.odds);
  }

  function ballonDorCandidateName(market, candidateId) {
    var candidate = (market && market.candidates || []).find(function (item) { return item.id === candidateId; });
    return candidate ? candidate.playerName + ' · ' + candidate.clubName : String(candidateId || 'candidato');
  }

  // El playerId es estable entre ediciones; el id del candidato incluye el mes y
  // no debe utilizarse para direccionar un avatar reutilizable.
  function ballonDorAvatarUrl(candidate) {
    var playerId = String(candidate && candidate.playerId || '');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(playerId)) playerId = 'default';
    return '/assets/ballon-dor-avatars/' + encodeURIComponent(playerId) + '.svg';
  }

  function ballonDorNameAudioUrl(candidate) {
    var playerId = String(candidate && candidate.playerId || '');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(playerId)) return null;
    return BALLON_DOR_CEREMONY_NAME_BASE + encodeURIComponent(playerId) + '.wav';
  }

  function formatBallonDorScheduleDate(timestamp, timeZone) {
    try {
      return new Intl.DateTimeFormat('es-MX', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: timeZone || 'America/Mexico_City'
      }).format(new Date(timestamp));
    } catch (_) { return ''; }
  }

  function renderBallonDorFinalization(market) {
    var message = el['est-bdo-finalization-message'];
    var date = el['est-bdo-finalization-date'];
    if (!message || !date) return;
    var schedule = market && market.finalization;
    var at = schedule && Number(schedule.scheduledAt);
    if (!Number.isFinite(at) || at <= 0) {
      date.hidden = true;
      date.textContent = '';
      message.innerHTML = 'Después del último partido · <strong>10:00 p. m.</strong> · hora de Ciudad de México.';
      return;
    }
    var afterMatch = schedule.afterMatch || {};
    var afterText = afterMatch.desempate
      ? 'después del partido de desempate oficial'
      : (Number(afterMatch.jornada) === 30 ? 'después del último partido de J30' : 'después del último partido del ciclo');
    var displayAt = market.status === 'settled'
      ? (Number(market.resultAnnouncementAt) || Math.max(at, Number(schedule.actualAt) || 0)) : at;
    var dateLabel = formatBallonDorScheduleDate(displayAt, schedule.timeZone || 'America/Mexico_City');
    date.textContent = dateLabel ? 'Fecha prevista: ' + dateLabel + '.' : '';
    date.hidden = !dateLabel;
    date.dateTime = new Date(displayAt).toISOString();
    if (market.status === 'cancelled') {
      message.innerHTML = 'Horario previsto: <strong>10:00 p. m.</strong>, ' + afterText + ' (hora de Ciudad de México). Este ciclo fue cancelado y no tendrá ceremonia.';
      return;
    }
    if (market.status === 'settled') {
      var announcementAt = displayAt;
      var announcedDate = formatBallonDorScheduleDate(announcementAt, schedule.timeZone || 'America/Mexico_City');
      var actual = formatBallonDorScheduleDate(schedule.actualAt, schedule.timeZone || 'America/Mexico_City');
      if (announcementAt > Date.now()) {
        message.innerHTML = 'El resultado oficial quedó cerrado y resguardado. El anuncio público será a las <strong>10:00 p. m.</strong>, ' + afterText + ' (hora de Ciudad de México).';
        date.textContent = (actual ? 'Cierre oficial completado: ' + actual + '. ' : '')
          + (announcedDate ? 'Anuncio previsto: ' + announcedDate + '.' : '');
      } else {
        message.innerHTML = market.result
          ? 'Resultado oficial publicado y ceremonia disponible. Horario de anuncio: <strong>10:00 p. m.</strong>, ' + afterText + ' (hora de Ciudad de México).'
          : 'Cierre oficial completado; el resultado no está disponible para publicación. La ceremonia queda bloqueada.';
        date.textContent = announcedDate ? 'Anuncio oficial: ' + announcedDate + '.' : '';
      }
      return;
    }
    var delayed = at < Date.now();
    message.innerHTML = delayed
      ? 'La hora prevista de <strong>10:00 p. m.</strong> ya pasó; el anuncio llegará al terminar el último partido, en hora de Ciudad de México.'
      : 'El cierre y anuncio final será a las <strong>10:00 p. m.</strong>, ' + afterText + ' · hora de Ciudad de México.';
  }

  function ballonDorStatusMessage(market) {
    var month = ballonDorMonthLabel(market.seasonMonth);
    var after = market.oddsSnapshot && Number(market.oddsSnapshot.afterJornada);
    var quoteDate = after > 0 ? 'Cuotas actualizadas tras J' + after + '.' : 'Cuotas iniciales del ciclo.';
    if (market.status === 'scheduled') return 'Ciclo de ' + month + ' programado. El mercado abre el día 1 de ' + month + ' (hora de Ciudad de México).';
    if (market.status === 'active') return 'Predicciones abiertas para ' + month + '. El mercado cierra automáticamente cuando se asienten los ocho partidos de J20. ' + quoteDate;
    if (market.status === 'locked') return 'Mercado cerrado tras asentarse los ocho partidos de J20. No se aceptan nuevas predicciones; la liga continúa hasta J30.';
    if (market.status === 'settled') {
      if (!market.result && Number(market.resultAnnouncementAt) > Date.now()) {
        return 'La liquidación oficial está cerrada y persistida. El podio se anunciará en la ceremonia de las 10:00 p. m., después del último partido.';
      }
      var winner = market.result && market.result.winnerCandidateId;
      return 'Ciclo liquidado. Ganador: ' + (winner ? ballonDorCandidateName(market, winner) : 'resultado oficial pendiente de verificación') + '.';
    }
    if (market.status === 'cancelled') return 'Mercado cancelado: ' + ballonDorCancelReason(market.cancellationReason) + ' Los boletos se reembolsan por el stake exacto.';
    return 'Estado del ciclo no disponible.';
  }

  function renderBallonDorMarket() {
    var market = S.ballonDorMarket;
    renderBallonDorOpeningButton();
    renderBallonDorFinalization(market);
    renderBallonDorCeremonyPanel(market);
    if (!el['est-bdo-status']) return;
    if (!market) {
      el['est-bdo-status'].textContent = S.ballonDorLoading ? 'Cargando ciclo' : (S.ballonDorError ? 'Sin conexión' : 'Sin ciclo activo');
      el['est-bdo-status'].dataset.state = S.ballonDorError ? 'cancelled' : 'scheduled';
      if (!S.ballonDorError) {
        setBallonDorFeedback(S.ballonDorLoading
          ? 'Consultando el calendario y los 16 candidatos…'
          : 'Todavía no hay un ciclo de Balón de Oro disponible.', S.ballonDorLoading ? '' : '');
      }
      if (el['est-bdo-table-wrap']) el['est-bdo-table-wrap'].hidden = true;
      if (el['est-bdo-bet-area']) el['est-bdo-bet-area'].hidden = true;
      if (el['est-bdo-retry']) el['est-bdo-retry'].hidden = !S.ballonDorError;
      return;
    }

    var stateLabels = { scheduled: 'Programado', active: 'Predicciones abiertas', locked: 'Mercado cerrado', settled: 'Liquidado', cancelled: 'Cancelado' };
    el['est-bdo-status'].textContent = stateLabels[market.status] || 'Estado no disponible';
    el['est-bdo-status'].dataset.state = market.status || '';
    el['est-bdo-summary'].textContent = ballonDorStatusMessage(market);
    var summaryWinner = market.status === 'settled' && market.result && (market.candidates || []).find(function (c) { return c.id === market.result.winnerCandidateId; });
    if (summaryWinner) {
      el['est-bdo-summary'].textContent = 'Ciclo liquidado. Ganador: ' + summaryWinner.playerName + ' · ';
      el['est-bdo-summary'].insertAdjacentHTML('beforeend', clubCrestMarkup(summaryWinner.clubId, 'est-inline-crest'));
      el['est-bdo-summary'].appendChild(document.createTextNode(summaryWinner.clubName + '.'));
    }
    if (!S.ballonDorError) {
      var progress = market.oddsSnapshot && Number(market.oddsSnapshot.afterJornada);
      if (market.status === 'settled' && !market.result && Number(market.resultAnnouncementAt) > Date.now()) {
        setBallonDorFeedback('La liquidación oficial está guardada. La tabla final y el podio se publicarán en la ceremonia de las 10:00 p. m.', '');
      } else {
        setBallonDorFeedback(progress > 0
          ? 'Probabilidades y cuotas calculadas en el servidor con 2,000 simulaciones reproducibles; última actualización al completar J' + progress + '.'
          : (market.status === 'active'
            ? 'Cuotas y probabilidades del servidor · margen objetivo 10 % · cuota máxima 51.0.'
            : 'El ciclo conserva un delantero ST existente por club; las estadísticas solo cuentan J1–J30.'), '');
      }
    }
    if (el['est-bdo-retry']) el['est-bdo-retry'].hidden = !S.ballonDorError;
    if (el['est-bdo-table-wrap']) el['est-bdo-table-wrap'].hidden = market.status === 'settled' && !market.result;

    var candidates = (market.candidates || []).slice();
    var marketIncomplete = candidates.length !== 16;
    var officialRank = new Map();
    if (market.result && Array.isArray(market.result.ranking)) {
      market.result.ranking.forEach(function (row) { officialRank.set(row.candidateId, row.rank); });
    }
    candidates.sort(function (a, b) {
      if (officialRank.size) return (officialRank.get(a.id) || 99) - (officialRank.get(b.id) || 99);
      var ap = Number(a.points && a.points.total) || 0, bp = Number(b.points && b.points.total) || 0;
      var as = a.stats || {}, bs = b.stats || {};
      return bp - ap || (Number(bs.goals) || 0) - (Number(as.goals) || 0)
        || (Number(bs.assists) || 0) - (Number(as.assists) || 0)
        || ((Number(as.yellowCards) || 0) + 3 * (Number(as.redCards) || 0))
          - ((Number(bs.yellowCards) || 0) + 3 * (Number(bs.redCards) || 0))
        || String(a.clubId || '').localeCompare(String(b.clubId || ''))
        || (Number(a.playerNumber) || 0) - (Number(b.playerNumber) || 0);
    });

    var select = el['est-bdo-selection'];
    var selectedId = S.ballonDorSelection || (select && select.value) || '';
    var termsAccepted = tosAccepted();
    if (select) {
      var options = '<option value="">Selecciona una fila o un candidato</option>';
      candidates.forEach(function (candidate) {
        options += '<option value="' + esc(candidate.id) + '">' + esc(candidate.playerName) + ' · ' + esc(candidate.clubName) + '</option>';
      });
      select.innerHTML = options;
      if (candidates.some(function (candidate) { return candidate.id === selectedId; })) select.value = selectedId;
      else { select.value = ''; S.ballonDorSelection = ''; }
    }

    var ticket = currentBallonDorTicket();
    var canChoose = market.status === 'active' && !ticket && termsAccepted && candidates.length === 16
      && !S.ballonDorReview && !S.ballonDorSubmitting;
    var body = el['est-bdo-candidates'];
    body.innerHTML = '';
    if (!candidates.length) {
      var emptyRow = document.createElement('tr');
      emptyRow.innerHTML = '<td colspan="11">El servidor aún no ha publicado candidatos para este ciclo.</td>';
      body.appendChild(emptyRow);
    }
    if (candidates.length !== 16) {
      setBallonDorFeedback('El ciclo está incompleto: deben publicarse exactamente 16 candidatos. Las predicciones quedan deshabilitadas hasta que el servidor lo corrija.', 'error');
    }
    candidates.forEach(function (candidate, index) {
      var stats = candidate.stats || {};
      var odds = ballonDorQuote(candidate);
      var implied = odds
        ? (Number.isFinite(Number(candidate.impliedProbability)) && candidate.impliedProbability != null
          ? (Number(candidate.impliedProbability) * 100).toFixed(2) + '%'
          : ((1 / odds) * 100).toFixed(2) + '%')
        : '—';
      var buttonLabel = candidate.id === selectedId ? 'Elegido' : 'Elegir';
      var action = canChoose && odds
        ? '<button class="est-bdo-select" type="button" data-bdo-select="' + esc(candidate.id) + '" aria-label="Elegir a ' + esc(candidate.playerName) + ' de ' + esc(candidate.clubName) + '"' + (candidate.id === selectedId ? ' aria-pressed="true"' : '') + '>' + buttonLabel + '</button>'
        : '<span aria-label="' + (ticket ? 'Ya hay un boleto este ciclo' : 'Predicciones cerradas') + '">—</span>';
      var rank = officialRank.get(candidate.id) || index + 1;
      var row = document.createElement('tr');
      row.innerHTML = '<td>' + rank + '</td>' +
        '<td><span class="est-bdo-candidate"><img class="est-bdo-candidate-avatar" src="' + esc(ballonDorAvatarUrl(candidate)) + '" alt="" aria-hidden="true" loading="lazy" decoding="async" width="40" height="40"><span class="est-bdo-candidate-copy"><b>' + esc(candidate.playerName) + ' · #' + fmt(candidate.playerNumber) + '</b><small>' + clubCrestMarkup(candidate.clubId, 'est-bdo-club-crest') + esc(candidate.clubName) + '</small></span></span></td>' +
        '<td class="est-bdo-points">' + fmt(candidate.points && candidate.points.total) + '</td>' +
        '<td>' + fmt(stats.goals) + '</td><td>' + fmt(stats.assists) + '</td><td>' + fmt(stats.appearances) + '</td>' +
        '<td>' + fmt(stats.yellowCards) + '</td><td>' + fmt(stats.redCards) + '</td>' +
        '<td class="est-bdo-odds">' + (odds ? odds.toFixed(2) : '—') + '</td><td>' + implied + '</td><td>' + action + '</td>';
      body.appendChild(row);
      var button = row.querySelector('[data-bdo-select]');
      if (button) button.addEventListener('click', function () { chooseBallonDorCandidate(candidate.id); });
    });

    var betArea = el['est-bdo-bet-area'];
    if (betArea) betArea.hidden = !(market.status === 'active' || ticket);
    renderBallonDorSlip(market, ticket);
    renderBallonDorReceipt(market, ticket);
    if (el['est-bdo-retry']) el['est-bdo-retry'].hidden = !(S.ballonDorError || marketIncomplete);
  }

  function formatBallonDorCeremonyBreakdown(candidate) {
    var points = candidate && candidate.points || {};
    var stats = candidate && candidate.stats || {};
    return 'Desglose de puntos: goles ' + fmt(points.goals) + ' · asistencias ' + fmt(points.assists)
      + ' · apariciones ' + fmt(points.appearances) + ' · disciplina ' + fmt((Number(points.yellowCards) || 0) + (Number(points.redCards) || 0))
      + ' · bonus de club ' + fmt(points.teamBonus) + ' · total ' + fmt(points.total)
      + '. Estadísticas: ' + fmt(stats.goals) + ' goles, ' + fmt(stats.assists) + ' asistencias, '
      + fmt(stats.appearances) + ' apariciones, ' + fmt(stats.minutes) + ' minutos, '
      + fmt(stats.yellowCards) + ' amarillas y ' + fmt(stats.redCards) + ' rojas.';
  }

  function ballonDorCeremonyPayoutText(market) {
    var ceremony = market && market.ceremony;
    if (!ceremony || ceremony.verified !== true) return 'Los pagos no se muestran hasta verificar el resultado oficial.';
    if (!ceremony.settlementComplete) {
      return 'Liquidación de predicciones en curso: ' + fmt(ceremony.settledPredictionCount) + ' de '
        + fmt(ceremony.predictionCount) + ' boletos cerrados; ' + fmt(ceremony.pendingPayoutCount)
        + ' acreditación(es) pendiente(s). La ceremonia no ejecuta pagos.';
    }
    if (!Number(ceremony.predictionCount)) return 'No hubo predicciones en esta edición; no se generaron pagos. Todas las fichas son virtuales.';
    return 'Predicciones liquidadas: ' + fmt(ceremony.predictionCount) + ' · acertadas: '
      + fmt(ceremony.winningPredictionCount) + ' · acreditado: ' + fmt(ceremony.paidVirtualChips)
      + ' fichas virtuales. Repetir la ceremonia no vuelve a pagar.';
  }

  function renderBallonDorCeremonyPodium() {
    var podium = el['est-bdo-ceremony-podium'];
    if (!podium) return;
    podium.textContent = '';
    [1, 2, 3].forEach(function (rank) {
      var card = document.createElement('li');
      card.className = 'est-bdo-ceremony-card';
      card.dataset.place = String(rank);
      card.setAttribute('aria-label', ['Primer', 'Segundo', 'Tercer'][rank - 1] + ' lugar, por revelar');
      var place = document.createElement('span');
      place.className = 'est-bdo-ceremony-place';
      place.textContent = ['1 · CAMPEÓN', '2 · PLATA', '3 · BRONCE'][rank - 1];
      var avatar = document.createElement('img');
      avatar.className = 'est-bdo-ceremony-avatar';
      avatar.alt = '';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.setAttribute('decoding', 'async');
      avatar.setAttribute('width', '72');
      avatar.setAttribute('height', '72');
      avatar.hidden = true;
      var silhouette = document.createElement('span');
      silhouette.className = 'est-bdo-ceremony-avatar-placeholder';
      silhouette.textContent = '?';
      silhouette.setAttribute('aria-hidden', 'true');
      var player = document.createElement('b');
      player.className = 'est-bdo-ceremony-player';
      player.textContent = 'Por revelar';
      var club = document.createElement('span');
      club.className = 'est-bdo-ceremony-club';
      club.textContent = 'Club por revelar';
      var score = document.createElement('span');
      score.className = 'est-bdo-ceremony-score';
      score.textContent = '— puntos';
      card.appendChild(place);
      card.appendChild(avatar);
      card.appendChild(silhouette);
      card.appendChild(player);
      card.appendChild(club);
      card.appendChild(score);
      podium.appendChild(card);
    });
  }

  function renderBallonDorCeremonyNominees() {
    var list = el['est-bdo-ceremony-nominees'];
    var market = S.ballonDorMarket;
    if (!list) return;
    list.textContent = '';
    var candidates = market && Array.isArray(market.candidates) ? market.candidates.slice() : [];
    candidates.sort(function (a, b) {
      var nameOrder = String(a && a.playerName || '').localeCompare(String(b && b.playerName || ''), 'es-MX');
      return nameOrder || String(a && a.clubName || '').localeCompare(String(b && b.clubName || ''), 'es-MX');
    });
    candidates.forEach(function (candidate) {
      var card = document.createElement('li');
      card.className = 'est-bdo-ceremony-nominee';
      card.setAttribute('aria-label', (candidate.playerName || 'Delantero') + ', ' + (candidate.clubName || 'club por confirmar'));
      var avatar = document.createElement('img');
      avatar.src = ballonDorAvatarUrl(candidate);
      avatar.alt = '';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.setAttribute('decoding', 'async');
      avatar.setAttribute('width', '42');
      avatar.setAttribute('height', '42');
      var copy = document.createElement('span');
      copy.className = 'est-bdo-ceremony-nominee-copy';
      var name = document.createElement('b');
      name.textContent = candidate.playerName || 'Delantero';
      var club = document.createElement('span');
      setClubLabel(club, candidate.clubId, candidate.clubName || 'Club por confirmar');
      copy.appendChild(name);
      copy.appendChild(club);
      card.appendChild(avatar);
      card.appendChild(copy);
      list.appendChild(card);
    });
    list.setAttribute('aria-label', 'Los ' + candidates.length + ' candidatos nominados, en orden alfabético y sin clasificación');
  }

  function revealBallonDorCeremonyPlace(rank, reveal, winner) {
    var podium = el['est-bdo-ceremony-podium'];
    var row = S.ballonDorCeremonyRows[rank - 1];
    if (!podium || !row) return;
    var card = podium.querySelector('[data-place="' + rank + '"]');
    if (!card) return;
    var avatar = card.querySelector('.est-bdo-ceremony-avatar');
    var silhouette = card.querySelector('.est-bdo-ceremony-avatar-placeholder');
    var player = card.querySelector('.est-bdo-ceremony-player');
    var club = card.querySelector('.est-bdo-ceremony-club');
    var score = card.querySelector('.est-bdo-ceremony-score');
    card.classList.toggle('is-revealed', Boolean(reveal));
    card.classList.toggle('is-winner', Boolean(reveal && winner));
    if (reveal) {
      player.textContent = row.candidate.playerName || 'Delantero';
      setClubLabel(club, row.candidate.clubId, row.candidate.clubName || 'Club MonteCristo');
      score.textContent = fmt(row.score) + ' puntos · ' + fmt(row.candidate.stats && row.candidate.stats.goals) + ' goles';
      card.setAttribute('aria-label', ['Primer', 'Segundo', 'Tercer'][rank - 1] + ' lugar: '
        + row.candidate.playerName + ', ' + row.candidate.clubName + ', ' + fmt(row.score) + ' puntos');
      if (avatar) {
        avatar.src = ballonDorAvatarUrl(row.candidate);
        avatar.hidden = false;
      }
      if (silhouette) silhouette.hidden = true;
    } else {
      player.textContent = 'Por revelar';
      club.textContent = 'Club por revelar';
      score.textContent = '— puntos';
      card.setAttribute('aria-label', ['Primer', 'Segundo', 'Tercer'][rank - 1] + ' lugar, por revelar');
      if (avatar) {
        avatar.hidden = true;
        avatar.removeAttribute('src');
      }
      if (silhouette) silhouette.hidden = false;
    }
  }

  function renderBallonDorCeremonyStep(step, revealName) {
    var stage = el['est-bdo-ceremony-stage'];
    if (!stage || !step || !S.ballonDorCeremonyRows.length || step.type === 'hold') return;
    var rows = S.ballonDorCeremonyRows;
    var winner = rows[0].candidate;
    var scene = 'verification', kicker = 'RESULTADO OFICIAL · VERIFICADO';
    var title = 'La temporada ya tiene podio.';
    var description = 'La clasificación persistida y las estadísticas oficiales están cerradas. El replay es de solo lectura.';
    var caption = 'El resultado oficial está verificado.';

    if (step.type === 'name') {
      var row = rows[step.rank - 1];
      if (!row) return;
      if (revealName) S.ballonDorCeremonyRevealedRanks[step.rank] = true;
      if (step.rank === 3) {
        scene = 'third-place';
        kicker = 'EL PODIO · TERCER LUGAR';
        title = revealName ? row.candidate.playerName + ' · ' + row.candidate.clubName : 'La constancia también deja huella.';
        description = revealName ? 'Tercer lugar · ' + fmt(row.score) + ' puntos oficiales.' : 'El tercer lugar se revela al escuchar el nombre.';
        caption = revealName
          ? 'En tercer lugar: ' + row.candidate.playerName + ', de ' + row.candidate.clubName + '.'
          : 'En tercer lugar.';
      } else if (step.rank === 2) {
        scene = 'second-place';
        kicker = 'EL PODIO · SEGUNDO LUGAR';
        title = revealName ? row.candidate.playerName + ' · ' + row.candidate.clubName : 'Una temporada brillante, hasta la última jornada.';
        description = revealName ? 'Segundo lugar · ' + fmt(row.score) + ' puntos oficiales.' : 'El segundo lugar se revela al escuchar el nombre.';
        caption = revealName
          ? 'En segundo lugar: ' + row.candidate.playerName + ', de ' + row.candidate.clubName + '.'
          : 'En segundo lugar.';
      } else {
        scene = 'winner-reveal';
        kicker = 'Y EL BALÓN DE ORO MONTECRISTO ES PARA…';
        title = revealName ? row.candidate.playerName + ' · ' + row.candidate.clubName : 'El Balón de Oro MonteCristo es para…';
        description = revealName
          ? fmt(row.score) + ' puntos oficiales. La temporada queda registrada para siempre.'
          : 'La identidad del campeón se revela al escuchar su nombre.';
        caption = revealName
          ? '¡' + row.candidate.playerName + ', del ' + row.candidate.clubName + ', gana el Balón de Oro MonteCristo!'
          : 'Y el Balón de Oro MonteCristo es para…';
      }
    } else if (step.key === 'verification') {
      scene = 'nominees';
      kicker = 'PREVIA · NOMINADOS OFICIALES';
      title = 'Dieciséis aspirantes. Un solo Balón de Oro.';
      description = 'La clasificación oficial está verificada. Los nominados aparecen en orden alfabético; ningún puesto se revela antes de su anuncio.';
      caption = 'Dieciséis nominados. El podio y la identidad del ganador siguen ocultos.';
    } else if (step.key === 'third-place') {
      scene = 'third-place';
      kicker = 'EL PODIO · TERCER LUGAR';
      title = 'La constancia también deja huella.';
      description = 'Una gran campaña merece su lugar en el podio.';
      caption = 'En tercer lugar.';
    } else if (step.key === 'second-place') {
      scene = 'second-place';
      kicker = 'EL PODIO · SEGUNDO LUGAR';
      title = 'Una temporada brillante, hasta la última jornada.';
      description = 'El segundo puesto se confirma con las estadísticas oficiales.';
      caption = 'En segundo lugar.';
    } else if (step.key === 'finalists') {
      scene = 'finalists';
      kicker = 'TRES FINALISTAS · UNA CORONA';
      title = 'La clasificación ya está escrita.';
      description = 'El podio oficial no cambia al volver a reproducir la ceremonia.';
      caption = 'Tercer y segundo lugar confirmados. Solo queda una persona.';
    } else if (step.key === 'winner-intro') {
      scene = 'winner-reveal';
      kicker = 'EL MOMENTO FINAL';
      title = 'Y el Balón de Oro MonteCristo es para…';
      description = 'La identidad del ganador se revelará con su nombre.';
      caption = 'Y el Balón de Oro MonteCristo es para…';
    } else if (step.key === 'winner-congratulations') {
      scene = 'final';
      kicker = 'CAMPEÓN · RESULTADO OFICIAL';
      title = winner.playerName + ' gana el Balón de Oro.';
      description = winner.clubName + ' · ' + fmt(rows[0].score) + ' puntos · ' + ballonDorMonthLabel(S.ballonDorCeremonyMonth) + '.';
      caption = 'Podio verificado. Las estadísticas y la liquidación permanecen sin cambios.';
    }

    S.ballonDorCeremonyScene = scene;
    stage.dataset.scene = scene;
    stage.dataset.motion = reduced.matches ? 'reduced' : 'full';
    var nominees = el['est-bdo-ceremony-nominees'];
    var podium = el['est-bdo-ceremony-podium'];
    if (nominees) nominees.hidden = scene !== 'nominees';
    if (podium) podium.hidden = scene === 'nominees';
    if (el['est-bdo-ceremony-breakdown']) el['est-bdo-ceremony-breakdown'].hidden = scene === 'nominees';
    if (el['est-bdo-ceremony-payout']) el['est-bdo-ceremony-payout'].hidden = scene === 'nominees';
    el['est-bdo-ceremony-kicker'].textContent = kicker;
    el['est-bdo-ceremony-title'].textContent = title;
    el['est-bdo-ceremony-description'].textContent = description;
    var revealedCandidate = step.type === 'name' && revealName && rows[step.rank - 1] ? rows[step.rank - 1].candidate : null;
    if (revealedCandidate) {
      el['est-bdo-ceremony-title'].textContent = revealedCandidate.playerName + ' · ';
      el['est-bdo-ceremony-title'].insertAdjacentHTML('beforeend', clubCrestMarkup(revealedCandidate.clubId, 'est-inline-crest'));
      el['est-bdo-ceremony-title'].appendChild(document.createTextNode(revealedCandidate.clubName));
    }
    if (step.key === 'winner-congratulations') {
      el['est-bdo-ceremony-description'].innerHTML = clubCrestMarkup(winner.clubId, 'est-inline-crest') + esc(description);
    }
    el['est-bdo-ceremony-caption'].textContent = caption;
    [1, 2, 3].forEach(function (rank) {
      var revealed = Boolean(S.ballonDorCeremonyRevealedRanks[rank]);
      revealBallonDorCeremonyPlace(rank, revealed, rank === 1);
    });
    el['est-bdo-ceremony-breakdown'].textContent = S.ballonDorCeremonyRevealedRanks[1]
      ? formatBallonDorCeremonyBreakdown(winner)
      : 'El desglose oficial aparecerá al revelarse el ganador.';
    el['est-bdo-ceremony-payout'].textContent = ballonDorCeremonyPayoutText(S.ballonDorMarket);
    updateBallonDorCeremonyTranscript();
  }

  function updateBallonDorCeremonyTranscript() {
    var copy = el['est-bdo-ceremony-transcript-copy'];
    if (!copy || !S.ballonDorCeremonyRows.length) return;
    var rows = S.ballonDorCeremonyRows;
    var revealed = S.ballonDorCeremonyRevealedRanks || Object.create(null);
    var text = 'Ceremonia final de ' + ballonDorMonthLabel(S.ballonDorCeremonyMonth)
      + '. La clasificación está verificada. La previa presenta a los dieciséis nominados sin orden de puntuación.';
    if (revealed[3]) {
      text += ' Tercer lugar: ' + rows[2].candidate.playerName + ', de ' + rows[2].candidate.clubName
        + ', con ' + fmt(rows[2].score) + ' puntos.';
    } else {
      text += ' El tercer lugar se revelará primero, al anunciar el nombre.';
    }
    if (revealed[2]) {
      text += ' Segundo lugar: ' + rows[1].candidate.playerName + ', de ' + rows[1].candidate.clubName
        + ', con ' + fmt(rows[1].score) + ' puntos.';
    } else {
      text += ' El segundo lugar permanece oculto hasta su anuncio.';
    }
    if (revealed[1]) {
      text += ' Balón de Oro MonteCristo: ' + rows[0].candidate.playerName + ', de ' + rows[0].candidate.clubName
        + ', con ' + fmt(rows[0].score) + ' puntos. ' + formatBallonDorCeremonyBreakdown(rows[0].candidate)
        + ' ' + ballonDorCeremonyPayoutText(S.ballonDorMarket);
    } else {
      text += ' El ganador se anunciará al final de la ceremonia.';
    }
    text += ' Puedes repetir esta ceremonia desde el archivo; el resultado oficial no cambia y los pagos no se vuelven a ejecutar.';
    copy.textContent = text;
  }

  function formatBallonDorCeremonyTime(seconds) {
    var safe = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
  }

  function clearBallonDorCeremonyTimer() {
    if (S.ballonDorCeremonyTimer != null) {
      window.clearInterval(S.ballonDorCeremonyTimer);
      S.ballonDorCeremonyTimer = null;
    }
  }

  function clearBallonDorCeremonyDelay(reset) {
    if (S.ballonDorCeremonyDelayTimer != null) {
      window.clearTimeout(S.ballonDorCeremonyDelayTimer);
      S.ballonDorCeremonyDelayTimer = null;
    }
    if (reset) {
      S.ballonDorCeremonyDelayKind = null;
      S.ballonDorCeremonyDelayDueAt = 0;
      S.ballonDorCeremonyDelayDuration = 0;
      S.ballonDorCeremonyDelayRemaining = 0;
    }
  }

  function updateBallonDorCeremonyControls() {
    var paused = S.ballonDorCeremonyPaused || S.ballonDorCeremonyComplete;
    var play = el['est-bdo-ceremony-play'];
    if (play) {
      play.innerHTML = paused ? '▶ <span>Reanudar</span>' : 'Ⅱ <span>Pausar</span>';
      play.setAttribute('aria-label', paused ? 'Reanudar ceremonia final' : 'Pausar ceremonia final');
    }
    var music = el['est-bdo-ceremony-music'];
    if (music) {
      music.innerHTML = S.ballonDorCeremonyMusicMuted ? '♫ <span>Activar música</span>' : '♫ <span>Silenciar música</span>';
      music.setAttribute('aria-label', S.ballonDorCeremonyMusicMuted ? 'Activar música' : 'Silenciar música');
      music.setAttribute('aria-pressed', String(S.ballonDorCeremonyMusicMuted));
    }
    var narration = el['est-bdo-ceremony-narration'];
    if (narration) {
      narration.innerHTML = S.ballonDorCeremonyNarrationMuted ? '◖ <span>Activar narración</span>' : '◖ <span>Silenciar narración</span>';
      narration.setAttribute('aria-label', S.ballonDorCeremonyNarrationMuted ? 'Activar narración' : 'Silenciar narración');
      narration.setAttribute('aria-pressed', String(S.ballonDorCeremonyNarrationMuted));
    }
  }

  function ceremonyStepProgressFraction() {
    if (S.ballonDorCeremonyDelayKind && S.ballonDorCeremonyDelayDuration > 0) {
      var delayLeft = Math.max(0, S.ballonDorCeremonyDelayDueAt - Date.now());
      return clamp(1 - delayLeft / S.ballonDorCeremonyDelayDuration, 0, 1);
    }
    var audio = el['est-bdo-ceremony-narration-audio'];
    var duration = Number(audio && audio.duration);
    var current = Number(audio && audio.currentTime);
    return Number.isFinite(duration) && duration > 0 && Number.isFinite(current)
      ? clamp(current / duration, 0, 1) : 0;
  }

  function startBallonDorCeremonyClock(session) {
    clearBallonDorCeremonyTimer();
    S.ballonDorCeremonyStartedAt = Date.now() - S.ballonDorCeremonyElapsed * 1000;
    S.ballonDorCeremonyTimer = window.setInterval(function () {
      if (session !== S.ballonDorCeremonySession || S.ballonDorCeremonyPaused) return;
      S.ballonDorCeremonyElapsed = Math.max(0, (Date.now() - S.ballonDorCeremonyStartedAt) / 1000);
      var total = Math.max(1, S.ballonDorCeremonySequence.length);
      var progress = Math.round((S.ballonDorCeremonyStepIndex + ceremonyStepProgressFraction()) / total * 100);
      progress = clamp(progress, 0, 99);
      el['est-bdo-ceremony-progress'].setAttribute('aria-valuenow', String(progress));
      el['est-bdo-ceremony-progress-bar'].style.width = progress + '%';
      el['est-bdo-ceremony-time'].textContent = formatBallonDorCeremonyTime(S.ballonDorCeremonyElapsed)
        + ' · ' + Math.min(S.ballonDorCeremonyStepIndex + 1, total) + '/' + total;
    }, 250);
  }

  function markBallonDorCeremonyNarrationStarted(session) {
    if (session !== S.ballonDorCeremonySession || S.ballonDorCeremonyNarrationReported) return;
    S.ballonDorCeremonyNarrationReported = true;
    reportBallonDorAudio('ceremony_narration', 'started', S.ballonDorCeremonyMonth);
  }

  function scheduleBallonDorCeremonyDelay(session, durationMs, kind) {
    clearBallonDorCeremonyDelay(true);
    S.ballonDorCeremonyDelayKind = kind;
    S.ballonDorCeremonyDelayDuration = Math.max(0, Number(durationMs) || 0);
    S.ballonDorCeremonyDelayRemaining = S.ballonDorCeremonyDelayDuration;
    S.ballonDorCeremonyDelayDueAt = Date.now() + S.ballonDorCeremonyDelayDuration;
    S.ballonDorCeremonyDelayTimer = window.setTimeout(function () {
      if (session !== S.ballonDorCeremonySession || S.ballonDorCeremonyPaused) return;
      clearBallonDorCeremonyDelay(true);
      S.ballonDorCeremonyStepIndex++;
      playBallonDorCeremonyStep(session);
    }, S.ballonDorCeremonyDelayDuration);
  }

  function playBallonDorCeremonyMusic(session) {
    var audio = el['est-bdo-ceremony-music-audio'];
    if (!audio || session !== S.ballonDorCeremonySession) return;
    try {
      audio.muted = S.ballonDorCeremonyMusicMuted;
      audio.volume = 0.12;
      audio.loop = true;
      var played = audio.play();
      if (played && typeof played.then === 'function') {
        played.then(function () {
          if (session !== S.ballonDorCeremonySession || S.ballonDorCeremonyMusicReported) return;
          S.ballonDorCeremonyMusicReported = true;
          reportBallonDorAudio('ceremony_music', 'started', S.ballonDorCeremonyMonth);
        }, function () { ceremonyAudioFailed(session, 'ceremony_music', 'blocked'); });
      } else if (!S.ballonDorCeremonyMusicReported) {
        S.ballonDorCeremonyMusicReported = true;
        reportBallonDorAudio('ceremony_music', 'started', S.ballonDorCeremonyMonth);
      }
    } catch (_) { ceremonyAudioFailed(session, 'ceremony_music', 'error'); }
  }

  function ballonDorCeremonySequence() {
    return [
      { type: 'cue', key: 'verification', fallbackMs: 2400 },
      { type: 'hold', durationMs: 12000 },
      { type: 'cue', key: 'third-place', fallbackMs: 1500 },
      { type: 'name', rank: 3, fallbackMs: 1700 },
      { type: 'hold', durationMs: 2200 },
      { type: 'cue', key: 'second-place', fallbackMs: 1500 },
      { type: 'name', rank: 2, fallbackMs: 1700 },
      { type: 'hold', durationMs: 2200 },
      { type: 'cue', key: 'finalists', fallbackMs: 1800 },
      { type: 'cue', key: 'winner-intro', fallbackMs: 2700 },
      { type: 'hold', durationMs: 2500 },
      { type: 'name', rank: 1, fallbackMs: 1800 },
      { type: 'cue', key: 'winner-congratulations', fallbackMs: 2200 },
      { type: 'hold', durationMs: 3500 }
    ];
  }

  function advanceBallonDorCeremonyStep(session) {
    if (session !== S.ballonDorCeremonySession || S.ballonDorCeremonyPaused) return;
    clearBallonDorCeremonyDelay(true);
    S.ballonDorCeremonyStepIndex++;
    playBallonDorCeremonyStep(session);
  }

  function playBallonDorCeremonyStep(session) {
    if (session !== S.ballonDorCeremonySession || S.ballonDorCeremonyPaused) return;
    if (S.ballonDorCeremonyStepIndex >= S.ballonDorCeremonySequence.length) {
      finishBallonDorCeremony();
      return;
    }
    var stepIndex = S.ballonDorCeremonyStepIndex;
    var step = S.ballonDorCeremonySequence[stepIndex];
    var audio = el['est-bdo-ceremony-narration-audio'];
    if (step.type === 'hold') {
      scheduleBallonDorCeremonyDelay(session, step.durationMs, 'hold');
      return;
    }
    renderBallonDorCeremonyStep(step, false);
    if (S.ballonDorCeremonyFallbackMode) {
      if (step.type === 'name') renderBallonDorCeremonyStep(step, true);
      scheduleBallonDorCeremonyDelay(session, step.fallbackMs, 'fallback');
      return;
    }
    var source = step.type === 'cue'
      ? BALLON_DOR_CEREMONY_CUE_BASE + encodeURIComponent(step.key) + '.wav'
      : ballonDorNameAudioUrl(S.ballonDorCeremonyRows[step.rank - 1].candidate);
    if (!source || !audio) {
      ceremonyAudioFailed(session, 'ceremony_narration', 'missing_clip');
      return;
    }
    audio.onended = function () {
      if (session !== S.ballonDorCeremonySession || stepIndex !== S.ballonDorCeremonyStepIndex || S.ballonDorCeremonyPaused) return;
      audio.onended = null;
      audio.onerror = null;
      audio.onplay = null;
      advanceBallonDorCeremonyStep(session);
    };
    audio.onerror = function () {
      if (stepIndex !== S.ballonDorCeremonyStepIndex) return;
      ceremonyAudioFailed(session, 'ceremony_narration', 'error');
    };
    audio.onplay = function () {
      if (session !== S.ballonDorCeremonySession || stepIndex !== S.ballonDorCeremonyStepIndex || S.ballonDorCeremonyPaused) return;
      markBallonDorCeremonyNarrationStarted(session);
      if (step.type === 'name') renderBallonDorCeremonyStep(step, true);
    };
    try {
      audio.muted = S.ballonDorCeremonyNarrationMuted;
      audio.volume = 1;
      audio.src = source;
      audio.load();
      var played = audio.play();
      if (played && typeof played.then === 'function') {
        played.then(function () {
          if (session !== S.ballonDorCeremonySession || stepIndex !== S.ballonDorCeremonyStepIndex || S.ballonDorCeremonyPaused) return;
          markBallonDorCeremonyNarrationStarted(session);
          if (step.type === 'name') renderBallonDorCeremonyStep(step, true);
        }, function () {
          if (stepIndex === S.ballonDorCeremonyStepIndex) ceremonyAudioFailed(session, 'ceremony_narration', 'blocked');
        });
      } else {
        markBallonDorCeremonyNarrationStarted(session);
        if (step.type === 'name') renderBallonDorCeremonyStep(step, true);
      }
    } catch (_) { ceremonyAudioFailed(session, 'ceremony_narration', 'error'); }
  }

  function ceremonyAudioFailed(session, track, outcome) {
    if (session !== S.ballonDorCeremonySession) return;
    reportBallonDorAudio(track, outcome || 'blocked', S.ballonDorCeremonyMonth);
    S.ballonDorCeremonyAudioBlocked = true;
    var status = el['est-bdo-ceremony-status'];
    if (track === 'ceremony_music') {
      if (status) status.textContent = 'La música no está disponible; la narración y las escenas siguen sincronizadas.';
      return;
    }
    if (S.ballonDorCeremonyFallbackMode) return;
    S.ballonDorCeremonyFallbackMode = true;
    if (status) status.textContent = 'Audio no disponible; la ceremonia continúa con subtítulos, nombres y avatares.';
    var audio = el['est-bdo-ceremony-narration-audio'];
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.onplay = null;
      try { audio.pause(); } catch (_) { /* audio opcional */ }
    }
    var step = S.ballonDorCeremonySequence[S.ballonDorCeremonyStepIndex];
    if (step && step.type === 'name') renderBallonDorCeremonyStep(step, true);
    if (step) scheduleBallonDorCeremonyDelay(session, step.fallbackMs || 1800, 'fallback');
  }

  function finishBallonDorCeremony() {
    clearBallonDorCeremonyTimer();
    clearBallonDorCeremonyDelay(true);
    S.ballonDorCeremonyComplete = true;
    S.ballonDorCeremonyPaused = true;
    S.ballonDorCeremonyStepIndex = S.ballonDorCeremonySequence.length;
    var finalStep = { type: 'cue', key: 'winner-congratulations' };
    renderBallonDorCeremonyStep(finalStep, false);
    var elapsed = Math.max(0, (Date.now() - S.ballonDorCeremonyStartedAt) / 1000);
    S.ballonDorCeremonyElapsed = elapsed;
    el['est-bdo-ceremony-progress'].setAttribute('aria-valuenow', '100');
    el['est-bdo-ceremony-progress-bar'].style.width = '100%';
    el['est-bdo-ceremony-time'].textContent = formatBallonDorCeremonyTime(elapsed)
      + ' · ' + S.ballonDorCeremonySequence.length + '/' + S.ballonDorCeremonySequence.length;
    [el['est-bdo-ceremony-music-audio'], el['est-bdo-ceremony-narration-audio']].forEach(function (audio) {
      if (!audio) return;
      audio.onended = null;
      audio.onerror = null;
      audio.onplay = null;
      try { audio.pause(); audio.currentTime = 0; } catch (_) { /* audio opcional */ }
    });
    updateBallonDorCeremonyControls();
  }

  function openBallonDorCeremony() {
    var market = S.ballonDorMarket;
    var rows = ballonDorOfficialRows(market);
    if (!rows || Date.now() < ceremonyEligibleAt(market)) return;
    var overlay = el['est-bdo-ceremony'];
    if (!overlay) return;
    S.ballonDorCeremonySession++;
    S.ballonDorCeremonyFocus = document.activeElement;
    S.ballonDorCeremonyRows = rows.slice(0, 3);
    S.ballonDorCeremonyMonth = market.seasonMonth;
    S.ballonDorCeremonyElapsed = 0;
    S.ballonDorCeremonyScene = null;
    S.ballonDorCeremonyComplete = false;
    S.ballonDorCeremonyPaused = false;
    S.ballonDorCeremonyAudioBlocked = false;
    S.ballonDorCeremonyFallbackMode = false;
    S.ballonDorCeremonyNarrationReported = false;
    S.ballonDorCeremonyMusicReported = false;
    S.ballonDorCeremonySequence = ballonDorCeremonySequence();
    S.ballonDorCeremonyStepIndex = 0;
    S.ballonDorCeremonyRevealedRanks = Object.create(null);
    clearBallonDorCeremonyDelay(true);
    try { S.ballonDorCeremonyMusicMuted = localStorage.getItem(BALLON_DOR_CEREMONY_AUDIO_KEY + ':music') === 'off'; } catch (_) {}
    try { S.ballonDorCeremonyNarrationMuted = localStorage.getItem(BALLON_DOR_CEREMONY_AUDIO_KEY + ':narration') === 'off'; } catch (_) {}
    renderBallonDorCeremonyPodium();
    renderBallonDorCeremonyNominees();
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.dataset.seasonMonth = market.seasonMonth || '';
    document.body.classList.add('est-bdo-ceremony-open');
    el['est-bdo-ceremony-progress'].setAttribute('aria-valuenow', '0');
    el['est-bdo-ceremony-progress-bar'].style.width = '0%';
    el['est-bdo-ceremony-time'].textContent = '0:00 · 1/' + S.ballonDorCeremonySequence.length;
    el['est-bdo-ceremony-status'].textContent = 'Resultado oficial verificado · ceremonia de solo lectura.';
    [el['est-bdo-ceremony-music-audio'], el['est-bdo-ceremony-narration-audio']].forEach(function (audio) {
      if (!audio) return;
      audio.onended = null;
      audio.onerror = null;
      audio.onplay = null;
      try { audio.pause(); audio.currentTime = 0; } catch (_) { /* audio opcional */ }
    });
    updateBallonDorCeremonyControls();
    playBallonDorCeremonyMusic(S.ballonDorCeremonySession);
    startBallonDorCeremonyClock(S.ballonDorCeremonySession);
    playBallonDorCeremonyStep(S.ballonDorCeremonySession);
    el['est-bdo-ceremony-dialog'].focus();
  }

  function closeBallonDorCeremony() {
    var overlay = el['est-bdo-ceremony'];
    if (!overlay || overlay.hidden) return;
    S.ballonDorCeremonySession++;
    clearBallonDorCeremonyTimer();
    clearBallonDorCeremonyDelay(true);
    [el['est-bdo-ceremony-music-audio'], el['est-bdo-ceremony-narration-audio']].forEach(function (audio) {
      if (!audio) return;
      audio.onended = null;
      audio.onerror = null;
      audio.onplay = null;
      try { audio.pause(); audio.currentTime = 0; } catch (_) { /* audio opcional */ }
    });
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('est-bdo-ceremony-open');
    var focus = S.ballonDorCeremonyFocus;
    S.ballonDorCeremonyFocus = null;
    if (focus && typeof focus.focus === 'function') focus.focus();
    else if (el['est-bdo-ceremony-start']) el['est-bdo-ceremony-start'].focus();
  }

  function toggleBallonDorCeremonyPlayback() {
    if (S.ballonDorCeremonyComplete) { openBallonDorCeremony(); return; }
    if (!S.ballonDorCeremonyPaused) {
      S.ballonDorCeremonyElapsed = Math.max(0, (Date.now() - S.ballonDorCeremonyStartedAt) / 1000);
      S.ballonDorCeremonyPaused = true;
      clearBallonDorCeremonyTimer();
      if (S.ballonDorCeremonyDelayTimer != null) {
        S.ballonDorCeremonyDelayRemaining = Math.max(0, S.ballonDorCeremonyDelayDueAt - Date.now());
        window.clearTimeout(S.ballonDorCeremonyDelayTimer);
        S.ballonDorCeremonyDelayTimer = null;
        S.ballonDorCeremonyDelayDueAt = 0;
      }
      [el['est-bdo-ceremony-music-audio'], el['est-bdo-ceremony-narration-audio']].forEach(function (audio) {
        try { audio.pause(); } catch (_) { /* audio opcional */ }
      });
      updateBallonDorCeremonyControls();
      return;
    }
    S.ballonDorCeremonyPaused = false;
    var session = S.ballonDorCeremonySession;
    S.ballonDorCeremonyStartedAt = Date.now() - S.ballonDorCeremonyElapsed * 1000;
    if (S.ballonDorCeremonyDelayKind) {
      scheduleBallonDorCeremonyDelay(session, S.ballonDorCeremonyDelayRemaining, S.ballonDorCeremonyDelayKind);
    } else {
      if (!S.ballonDorCeremonyFallbackMode) {
        var narrationAudio = el['est-bdo-ceremony-narration-audio'];
        if (narrationAudio) {
          var resumed = narrationAudio.play();
          if (resumed && typeof resumed.then === 'function') {
            resumed.then(function () {
              markBallonDorCeremonyNarrationStarted(session);
              var step = S.ballonDorCeremonySequence[S.ballonDorCeremonyStepIndex];
              if (step && step.type === 'name') renderBallonDorCeremonyStep(step, true);
            }, function () { ceremonyAudioFailed(session, 'ceremony_narration', 'blocked'); });
          }
        }
      }
      var musicAudio = el['est-bdo-ceremony-music-audio'];
      if (musicAudio && musicAudio.paused) playBallonDorCeremonyMusic(session);
    }
    startBallonDorCeremonyClock(session);
    updateBallonDorCeremonyControls();
  }

  function toggleBallonDorCeremonyMusic() {
    S.ballonDorCeremonyMusicMuted = !S.ballonDorCeremonyMusicMuted;
    var audio = el['est-bdo-ceremony-music-audio'];
    if (audio) audio.muted = S.ballonDorCeremonyMusicMuted;
    try { localStorage.setItem(BALLON_DOR_CEREMONY_AUDIO_KEY + ':music', S.ballonDorCeremonyMusicMuted ? 'off' : 'on'); } catch (_) {}
    if (!S.ballonDorCeremonyMusicMuted && !S.ballonDorCeremonyPaused && audio && audio.paused) {
      playBallonDorCeremonyMusic(S.ballonDorCeremonySession);
    }
    updateBallonDorCeremonyControls();
  }

  function toggleBallonDorCeremonyNarration() {
    S.ballonDorCeremonyNarrationMuted = !S.ballonDorCeremonyNarrationMuted;
    var audio = el['est-bdo-ceremony-narration-audio'];
    if (audio) audio.muted = S.ballonDorCeremonyNarrationMuted;
    try { localStorage.setItem(BALLON_DOR_CEREMONY_AUDIO_KEY + ':narration', S.ballonDorCeremonyNarrationMuted ? 'off' : 'on'); } catch (_) {}
    updateBallonDorCeremonyControls();
  }

  function replayBallonDorCeremony() { openBallonDorCeremony(); }

  function onBallonDorCeremonyKeydown(event) {
    if (!el['est-bdo-ceremony'] || el['est-bdo-ceremony'].hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeBallonDorCeremony(); return; }
    if (event.key !== 'Tab') return;
    var focusable = Array.prototype.slice.call(el['est-bdo-ceremony-dialog'].querySelectorAll('button:not([disabled]),summary'));
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function hasCompletedBallonDorOpening(seasonMonth) {
    if (!seasonMonth) return false;
    if (S.ballonDorOpeningComplete && S.ballonDorOpeningMonth === seasonMonth) return true;
    var key = BALLON_DOR_OPENING_KEY + seasonMonth;
    try { if (localStorage.getItem(key) === 'completed') return true; } catch (_) {}
    try { if (sessionStorage.getItem(key) === 'completed') return true; } catch (_) {}
    return false;
  }

  function renderBallonDorOpeningButton() {
    var button = el['est-bdo-opening-start'];
    if (!button) return;
    var market = S.ballonDorMarket;
    var available = Boolean(market && Array.isArray(market.candidates) && market.candidates.length === 16);
    var completed = available && hasCompletedBallonDorOpening(market.seasonMonth);
    var open = Boolean(el['est-bdo-opening'] && !el['est-bdo-opening'].hidden);
    button.hidden = !available || completed || open;
    button.disabled = !available || completed || open;
    if (button.hidden) return;
    button.textContent = 'Ver inauguración';
    button.setAttribute('aria-label', 'Ver la inauguración narrada del Balón de Oro');
  }

  function maybeAutoOpenBallonDorOpening() {
    var market = S.ballonDorMarket;
    if (!IS_BDO_DEDICATED_PAGE || !market || !Array.isArray(market.candidates)
        || market.candidates.length !== 16 || S.ballonDorOpeningAutoShown[market.seasonMonth]) return;
    if (hasCompletedBallonDorOpening(market.seasonMonth)) return;
    S.ballonDorOpeningAutoShown[market.seasonMonth] = true;
    openBallonDorOpening({ mandatory: true });
  }

  function renderBallonDorOpeningClubDots() {
    var container = el['est-bdo-opening-clubs'];
    if (!container) return;
    container.textContent = '';
    S.ballonDorOpeningCandidates.forEach(function (candidate) {
      var color = candidate.clubColors && /^#[0-9a-f]{6}$/i.test(candidate.clubColors.primary || '')
        ? candidate.clubColors.primary : '#7d8b88';
      var badge = document.createElement('span');
      badge.className = 'est-bdo-opening-club';
      badge.style.setProperty('--club-color', color);
      badge.innerHTML = clubCrestMarkup(candidate.clubId, 'est-opening-club-crest') + '<span>' + esc(candidate.clubShort || String(candidate.clubName || 'Club').slice(0, 3).toUpperCase()) + '</span>';
      badge.setAttribute('aria-label', candidate.clubName || 'Club candidato');
      badge.title = candidate.clubName || 'Club candidato';
      container.appendChild(badge);
    });
  }

  function ballonDorPlayerSignature(candidate) {
    var stats = candidate.stats || {};
    var attributes = candidate.attributes || {};
    var goals = Number(stats.goals) || 0;
    var assists = Number(stats.assists) || 0;
    var appearances = Number(stats.appearances) || 0;
    var shooting = Number(attributes.shooting) || 0;
    var pace = Number(attributes.pace) || 0;
    if (goals >= 8) return 'El goleador que marca el pulso';
    if (assists >= 5) return 'El socio que enciende el ataque';
    if (appearances >= 20) return 'Presencia constante en la campaña';
    if (shooting >= pace + 8) return 'Instinto de definición en el área';
    if (pace >= shooting + 8) return 'Explosividad para romper líneas';
    if (shooting >= 82 && pace >= 82) return 'Amenaza completa en cada avance';
    return 'Técnica, lectura y ambición';
  }

  function renderBallonDorOpeningCards(candidateIndex) {
    var container = el['est-bdo-opening-cards'];
    if (!container) return;
    container.textContent = '';
    var candidate = S.ballonDorOpeningCandidates[candidateIndex];
    if (!candidate) return;
    var color = candidate.clubColors && /^#[0-9a-f]{6}$/i.test(candidate.clubColors.primary || '')
      ? candidate.clubColors.primary : '#7d8b88';
    var attributes = candidate.attributes || {};
    var stats = candidate.stats || {};
    var resultWithheld = Boolean(S.ballonDorMarket && S.ballonDorMarket.status === 'settled'
      && !S.ballonDorMarket.result);
    var indexLabel = String(candidateIndex + 1).padStart(2, '0');
    var card = document.createElement('article');
    card.className = 'est-bdo-opening-card';
    card.dataset.candidateId = String(candidate.id || '');
    card.dataset.candidateIndex = String(candidateIndex);
    card.style.setProperty('--club-color', color);
    card.style.setProperty('--club-ink', bestText(color));
    card.setAttribute('aria-label', (candidate.playerName || 'Delantero') + ', ' + (candidate.clubName || 'club candidato'));

    var aside = document.createElement('div');
    aside.className = 'est-bdo-opening-card-aside';
    var monogram = document.createElement('span');
    monogram.className = 'est-bdo-opening-card-monogram';
    monogram.innerHTML = clubCrestMarkup(candidate.clubId, 'est-opening-monogram-crest') + '<span>' + esc(candidate.clubShort || String(candidate.clubName || 'MC').slice(0, 3).toUpperCase()) + '</span>';
    monogram.setAttribute('aria-hidden', 'true');
    var number = document.createElement('b');
    number.className = 'est-bdo-opening-card-number';
    number.textContent = '#' + fmt(candidate.playerNumber);
    var roster = document.createElement('span');
    roster.className = 'est-bdo-opening-card-roster';
    roster.textContent = 'JUGADOR ' + indexLabel + ' / 16';
    aside.appendChild(monogram);
    aside.appendChild(number);
    aside.appendChild(roster);

    var content = document.createElement('div');
    content.className = 'est-bdo-opening-card-content';
    var club = document.createElement('span');
    club.className = 'est-bdo-opening-card-club';
    setClubLabel(club, candidate.clubId, candidate.clubName || 'Club MonteCristo');
    var player = document.createElement('h3');
    player.className = 'est-bdo-opening-card-player';
    player.textContent = candidate.playerName || 'Delantero';
    var role = document.createElement('p');
    role.className = 'est-bdo-opening-card-role';
    role.textContent = (candidate.position || 'ST') + ' · Delantero centro';
    var signature = document.createElement('p');
    signature.className = 'est-bdo-opening-card-signature';
    signature.textContent = resultWithheld
      ? 'Las estadísticas oficiales se revelarán en la ceremonia.'
      : ballonDorPlayerSignature(candidate);
    content.appendChild(club);
    content.appendChild(player);
    content.appendChild(role);
    content.appendChild(signature);

    if (!resultWithheld) {
      var facts = document.createElement('dl');
      facts.className = 'est-bdo-opening-card-facts';
      [
        ['Goles', stats.goals], ['Asistencias', stats.assists],
        ['Apariciones', stats.appearances], ['Puntos', candidate.points && candidate.points.total]
      ].forEach(function (fact) {
        var item = document.createElement('div');
        var label = document.createElement('dt');
        label.textContent = fact[0];
        var value = document.createElement('dd');
        value.textContent = fmt(fact[1]);
        item.appendChild(label);
        item.appendChild(value);
        facts.appendChild(item);
      });
      content.appendChild(facts);
      // La ficha es el acumulado de la temporada del premio, no lo que el
      // jugador hizo en este partido: sin la aclaración, el acumulado (2 goles)
      // parece contradecir al resumen del partido (1 gol).
      var factsWindow = document.createElement('p');
      factsWindow.className = 'est-bdo-opening-card-window';
      factsWindow.textContent = 'Acumulado de la temporada, no de este partido.';
      content.appendChild(factsWindow);
    }

    var skillSet = document.createElement('div');
    skillSet.className = 'est-bdo-opening-card-skills';
    [['Tiro', attributes.shooting], ['Ritmo', attributes.pace]].forEach(function (skill) {
      var row = document.createElement('div');
      row.className = 'est-bdo-opening-card-skill';
      var label = document.createElement('span');
      label.textContent = skill[0];
      var meter = document.createElement('span');
      meter.className = 'est-bdo-opening-card-meter';
      meter.setAttribute('role', 'meter');
      meter.setAttribute('aria-label', skill[0]);
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      meter.setAttribute('aria-valuenow', String(clamp(Number(skill[1]) || 0, 0, 100)));
      var fill = document.createElement('i');
      fill.style.width = clamp(Number(skill[1]) || 0, 0, 100) + '%';
      meter.appendChild(fill);
      var value = document.createElement('b');
      value.textContent = fmt(skill[1]);
      row.appendChild(label);
      row.appendChild(meter);
      row.appendChild(value);
      skillSet.appendChild(row);
    });
    content.appendChild(skillSet);
    card.appendChild(aside);
    card.appendChild(content);
    container.appendChild(card);
    container.setAttribute('aria-label', 'Presentación individual, jugador ' + (candidateIndex + 1) + ' de 16');
  }

  // Reparto del tiempo de la inauguración en actos. Todo se deriva de la
  // duración total, así que alargar o acortar la presentación no obliga a tocar
  // los umbrales de cada escena (el error clásico: 16 candidatos en 32 s).
  function ballonDorOpeningPlan(total) {
    var seconds = Number(total);
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = BALLON_DOR_OPENING_SECONDS;
    var introEnd = Math.max(4, seconds * BALLON_DOR_OPENING_ACTS.intro);
    var lineupEnd = introEnd + Math.max(6, seconds * BALLON_DOR_OPENING_ACTS.lineup);
    var finalLength = Math.max(8, seconds * BALLON_DOR_OPENING_ACTS.final);
    var revealEach = Math.max(BALLON_DOR_OPENING_MIN_REVEAL,
      (seconds - lineupEnd - finalLength) / 16);
    return {
      total: seconds,
      introEnd: introEnd,
      lineupEnd: lineupEnd,
      revealEach: revealEach,
      finalStart: lineupEnd + revealEach * 16
    };
  }

  function renderBallonDorOpeningScene(seconds) {
    var stage = el['est-bdo-opening-stage'];
    if (!stage) return;
    var scene, playerIndex = -1, kicker, title, description, caption;
    var month = ballonDorMonthLabel(S.ballonDorOpeningMonth);
    var plan = ballonDorOpeningPlan(BALLON_DOR_OPENING_SECONDS);
    if (seconds < plan.introEnd) {
      scene = 'opening';
      kicker = 'INICIO DE TEMPORADA · ' + month;
      title = 'Una carrera. Una corona.';
      description = 'La Liga MonteCristo presenta el premio individual más esperado de la temporada.';
      caption = 'La Liga MonteCristo presenta una nueva carrera por el Balón de Oro.';
    } else if (seconds < plan.lineupEnd) {
      scene = 'lineup';
      kicker = '16 CLUBES · 16 DELANTEROS';
      title = 'Un representante por club';
      description = 'La inauguración presenta a cada candidato del ciclo, uno por uno.';
      caption = 'Dieciséis clubes. Dieciséis delanteros. Un solo ganador.';
    } else if (seconds < plan.finalStart) {
      playerIndex = Math.max(0, Math.min(15, Math.floor((seconds - plan.lineupEnd) / plan.revealEach)));
      var candidate = S.ballonDorOpeningCandidates[playerIndex] || {};
      scene = 'reveal-' + (playerIndex + 1);
      kicker = 'PRESENTACIÓN ' + String(playerIndex + 1).padStart(2, '0') + ' DE 16 · ' + (candidate.clubName || 'MONTECRISTO');
      title = candidate.playerName || 'Delantero';
      description = (candidate.clubName || 'Su club') + ' presenta a su delantero centro para el ciclo ' + month + '.';
      caption = 'Conoce a ' + (candidate.playerName || 'este candidato') + ', de ' + (candidate.clubName || 'su club') + '. Sus estadísticas seguirán creciendo en la cancha.';
    } else {
      scene = 'final';
      kicker = 'BALÓN DE ORO MONTECRISTO';
      var status = S.ballonDorMarket && S.ballonDorMarket.status;
      if (status === 'active') {
        title = 'Observa. Elige. Vive la temporada.';
        description = 'Predicciones con fichas virtuales · mercado hasta J20 · anuncio final al cierre del ciclo. La conferencia de prensa del Estadio presenta los traspasos y el valor de cada jugador.';
        caption = 'Revisa las estadísticas de cada candidato, elige tu pronóstico y acompaña la carrera hasta el anuncio final. La conferencia de prensa del mercado, en la pestaña Mercado, muestra los traspasos y la valoración de los jugadores.';
        el['est-bdo-opening-cta'].textContent = 'Ver candidatos y hacer mi predicción ›';
      } else if (status === 'locked') {
        title = 'La temporada sigue en juego.';
        description = 'El mercado está cerrado; la liga continúa hacia el resultado oficial.';
        caption = 'Sigue las estadísticas de los candidatos hasta que se defina el Balón de Oro.';
        el['est-bdo-opening-cta'].textContent = 'Ver candidatos y clasificación ›';
      } else if (status === 'settled' && S.ballonDorMarket && !S.ballonDorMarket.result
          && Number(S.ballonDorMarket.resultAnnouncementAt) > Date.now()) {
        title = 'El podio se prepara.';
        description = 'La liquidación está guardada; la ceremonia revelará el resultado después del último partido, a las 10:00 p. m.';
        caption = 'La clasificación oficial se anunciará a las 10:00 p. m., hora de Ciudad de México. La inauguración se presenta una sola vez por ciclo.';
        el['est-bdo-opening-cta'].textContent = 'Ver horario del anuncio ›';
      } else if (status === 'settled') {
        title = 'El resultado ya es oficial.';
        description = 'Consulta la clasificación final de los 16 candidatos del ciclo.';
        caption = 'El Balón de Oro está decidido. Revisa el resultado oficial y las estadísticas de la temporada.';
        el['est-bdo-opening-cta'].textContent = 'Ver resultado oficial ›';
      } else if (status === 'cancelled') {
        title = 'Ciclo cancelado.';
        description = 'Esta edición no admite predicciones; puedes consultar los candidatos publicados.';
        caption = 'La lista oficial de candidatos permanece disponible, aunque este ciclo no tendrá liquidación.';
        el['est-bdo-opening-cta'].textContent = 'Ver candidatos del ciclo ›';
      } else {
        title = 'Observa. Elige. Vive la temporada.';
        description = 'Conoce a los 16 delanteros y sigue su campaña en la Liga MonteCristo.';
        caption = 'Revisa las estadísticas de cada candidato y acompaña la carrera hasta el anuncio final.';
        el['est-bdo-opening-cta'].textContent = 'Ver candidatos ›';
      }
    }
    if (S.ballonDorOpeningScene === scene) return;
    S.ballonDorOpeningScene = scene;
    stage.dataset.scene = scene;
    stage.dataset.motion = reduced.matches ? 'reduced' : 'full';
    el['est-bdo-opening-kicker'].textContent = kicker;
    el['est-bdo-opening-title'].textContent = title;
    el['est-bdo-opening-description'].textContent = description;
    if (playerIndex >= 0 && S.ballonDorOpeningCandidates[playerIndex]) {
      var openingCandidate = S.ballonDorOpeningCandidates[playerIndex];
      el['est-bdo-opening-kicker'].innerHTML = 'PRESENTACIÓN ' + String(playerIndex + 1).padStart(2, '0') + ' DE 16 · ' + clubCrestMarkup(openingCandidate.clubId, 'est-inline-crest') + esc(openingCandidate.clubName || 'MONTECRISTO');
      el['est-bdo-opening-description'].innerHTML = clubCrestMarkup(openingCandidate.clubId, 'est-inline-crest') + esc(description);
    }
    el['est-bdo-opening-caption'].textContent = caption;
    el['est-bdo-opening-clubs'].hidden = scene !== 'lineup';
    el['est-bdo-opening-cards'].hidden = playerIndex < 0;
    el['est-bdo-opening-cta'].hidden = scene !== 'final';
    if (scene === 'lineup') renderBallonDorOpeningClubDots();
    if (playerIndex >= 0) renderBallonDorOpeningCards(playerIndex);
    updateBallonDorOpeningControls();
  }

  function formatBallonDorOpeningTime(seconds) {
    var safe = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
  }

  function clearBallonDorOpeningTimer() {
    if (S.ballonDorOpeningTimer != null) {
      window.clearInterval(S.ballonDorOpeningTimer);
      S.ballonDorOpeningTimer = null;
    }
  }

  function updateBallonDorOpeningControls() {
    var locked = S.ballonDorOpeningMandatory && !S.ballonDorOpeningComplete;
    var play = el['est-bdo-opening-play'];
    if (play) {
      play.hidden = S.ballonDorOpeningComplete;
      var shouldResume = S.ballonDorOpeningPaused;
      play.textContent = shouldResume ? '▶ Reanudar' : 'Ⅱ Pausar';
      play.setAttribute('aria-label', shouldResume ? 'Reanudar inauguración' : 'Pausar inauguración');
    }
    var enableAudio = el['est-bdo-opening-enable-audio'];
    if (enableAudio) enableAudio.hidden = !S.ballonDorOpeningAudioBlocked || S.ballonDorOpeningComplete;
    var close = el['est-bdo-opening-close'];
    if (close) close.hidden = locked;
    var skip = el['est-bdo-opening-skip'];
    if (skip) skip.hidden = locked || S.ballonDorOpeningComplete;
    var cta = el['est-bdo-opening-cta'];
    if (cta) cta.disabled = locked;
    var mute = el['est-bdo-opening-mute'];
    if (mute) {
      mute.textContent = S.ballonDorOpeningMuted ? '◖ Activar sonido' : '◖ Silenciar';
      mute.setAttribute('aria-label', S.ballonDorOpeningMuted ? 'Activar sonido de la narración' : 'Silenciar narración');
      mute.setAttribute('aria-pressed', String(S.ballonDorOpeningMuted));
    }
  }

  function finishBallonDorOpening() {
    clearBallonDorOpeningTimer();
    S.ballonDorOpeningElapsed = BALLON_DOR_OPENING_SECONDS;
    S.ballonDorOpeningComplete = true;
    S.ballonDorOpeningPaused = true;
    S.ballonDorOpeningMandatory = false;
    stopBallonDorOpeningAudio();
    if (el['est-bdo-opening']) el['est-bdo-opening'].classList.remove('is-mandatory');
    var completionKey = BALLON_DOR_OPENING_KEY + S.ballonDorOpeningMonth;
    try { localStorage.setItem(completionKey, 'completed'); }
    catch (_) {
      try { sessionStorage.setItem(completionKey, 'completed'); }
      catch (_) { /* el estado de la sesión sigue bloqueando repeticiones */ }
    }
    renderBallonDorOpeningButton();
    renderBallonDorOpeningScene(BALLON_DOR_OPENING_SECONDS);
    el['est-bdo-opening-progress'].setAttribute('aria-valuenow', '100');
    el['est-bdo-opening-progress-bar'].style.width = '100%';
    var total = formatBallonDorOpeningTime(BALLON_DOR_OPENING_SECONDS);
    el['est-bdo-opening-time'].textContent = total + ' / ' + total;
    el['est-bdo-opening-status'].textContent = 'Inauguración completada · no se repite durante este ciclo.';
    updateBallonDorOpeningControls();
  }

  function updateBallonDorOpeningFrame(elapsed, duration) {
    if (!el['est-bdo-opening'] || el['est-bdo-opening'].hidden || S.ballonDorOpeningPaused) return;
    var total = Number(duration);
    if (!Number.isFinite(total) || total <= 0) total = BALLON_DOR_OPENING_SECONDS;
    var current = Math.max(0, Math.min(total, Number(elapsed) || 0));
    S.ballonDorOpeningElapsed = current;
    renderBallonDorOpeningScene(current);
    var progress = clamp(current / total, 0, 1);
    var percent = Math.round(progress * 100);
    el['est-bdo-opening-progress'].setAttribute('aria-valuenow', String(percent));
    el['est-bdo-opening-progress-bar'].style.width = percent + '%';
    el['est-bdo-opening-time'].textContent = formatBallonDorOpeningTime(current) + ' / ' + formatBallonDorOpeningTime(total);
    if (progress >= 1) finishBallonDorOpening();
  }

  // El reloj de la inauguración es de pared, no el del audio: la narración dura
  // ~49,5 s y la presentación 1:48. Antes el avance se desprendía de currentTime,
  // lo que ataba la duración total al MP3 y aceleraba las escenas.
  function startBallonDorOpeningClock(session) {
    clearBallonDorOpeningTimer();
    S.ballonDorOpeningStartedAt = Date.now() - S.ballonDorOpeningElapsed * 1000;
    S.ballonDorOpeningTimer = window.setInterval(function () {
      if (session !== S.ballonDorOpeningSession || S.ballonDorOpeningPaused) return;
      var elapsed = Math.max(0, (Date.now() - S.ballonDorOpeningStartedAt) / 1000);
      updateBallonDorOpeningFrame(elapsed, BALLON_DOR_OPENING_SECONDS);
    }, 100);
  }

  function stopBallonDorOpeningAudio() {
    ['est-bdo-opening-audio', 'est-bdo-opening-bed'].forEach(function (id) {
      var audio = el[id];
      if (!audio) return;
      try { audio.pause(); } catch (_) { /* el navegador puede no exponer media */ }
    });
  }

  // Segunda mitad: el tema instrumental del Balón de Oro (el mismo de la
  // ceremonia) entra cuando termina la narración y se repite hasta el cierre.
  function startBallonDorOpeningBed() {
    var bed = el['est-bdo-opening-bed'];
    if (!bed || S.ballonDorOpeningPaused || S.ballonDorOpeningComplete) return;
    if (S.ballonDorOpeningMuted) { S.ballonDorOpeningMode = 'visual'; return; }
    S.ballonDorOpeningMode = 'bed';
    el['est-bdo-opening-status'].textContent = 'Tema instrumental · segunda mitad de la presentación.';
    try {
      bed.volume = BALLON_DOR_OPENING_BED_VOLUME;
      bed.muted = false;
      bed.currentTime = 0;
      var playback = bed.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch(function () { S.ballonDorOpeningMode = 'visual'; });
      }
    } catch (_) { S.ballonDorOpeningMode = 'visual'; }
  }

  function onBallonDorOpeningNarrationEnded() {
    reportBallonDorAudio('opening_narration', 'completed', S.ballonDorOpeningMonth);
    // La narración termina a mitad de la presentación: sigue el tema, no el cierre.
    if (!S.ballonDorOpeningComplete) startBallonDorOpeningBed();
  }

  function startBallonDorOpeningFallback(session, statusText, audioBlocked) {
    if (session !== S.ballonDorOpeningSession || !el['est-bdo-opening'] || el['est-bdo-opening'].hidden) return;
    if (audioBlocked !== false) reportBallonDorAudio('opening_narration', 'blocked', S.ballonDorOpeningMonth);
    stopBallonDorOpeningAudio();
    S.ballonDorOpeningMode = 'visual';
    S.ballonDorOpeningAudioBlocked = audioBlocked !== false;
    S.ballonDorOpeningDuration = BALLON_DOR_OPENING_SECONDS;
    if (el['est-bdo-opening-status']) el['est-bdo-opening-status'].textContent = statusText || 'Narración no disponible · escenas y guion en pantalla.';
    el['est-bdo-opening-stage'].classList.remove('is-paused');
    startBallonDorOpeningClock(session);
    updateBallonDorOpeningFrame(S.ballonDorOpeningElapsed, BALLON_DOR_OPENING_SECONDS);
    updateBallonDorOpeningControls();
  }

  function playBallonDorOpeningNarration(session, seekTo) {
    var audio = el['est-bdo-opening-audio'];
    S.ballonDorOpeningMode = 'narration';
    S.ballonDorOpeningAudioBlocked = false;
    el['est-bdo-opening-stage'].classList.remove('is-paused');
    el['est-bdo-opening-status'].textContent = 'Narración · bloque 1 de 2 (español de México).';
    updateBallonDorOpeningControls();
    try { audio.currentTime = Math.max(0, Number(seekTo) || 0); } catch (_) { /* metadata aún no cargada */ }
    try {
      var playback = audio.play();
      if (playback && typeof playback.then === 'function') {
        playback.then(function () {
          if (session !== S.ballonDorOpeningSession || el['est-bdo-opening'].hidden) return;
          reportBallonDorAudio('opening_narration', 'started', S.ballonDorOpeningMonth);
        }, function () {
          startBallonDorOpeningFallback(session,
            'Audio no disponible automáticamente · activa la narración si la quieres escuchar. La presentación continúa con texto.', true);
        });
      } else {
        reportBallonDorAudio('opening_narration', 'started', S.ballonDorOpeningMonth);
      }
    } catch (_) {
      startBallonDorOpeningFallback(session,
        'Audio no disponible automáticamente · activa la narración si la quieres escuchar. La presentación continúa con texto.', true);
    }
  }

  function openBallonDorOpening(options) {
    var market = S.ballonDorMarket;
    if (!market || !Array.isArray(market.candidates) || market.candidates.length !== 16) return;
    var overlay = el['est-bdo-opening'];
    var audio = el['est-bdo-opening-audio'];
    if (!overlay || !audio || !overlay.hidden || hasCompletedBallonDorOpening(market.seasonMonth)) return;
    var settings = options || {};
    S.ballonDorOpeningSession++;
    S.ballonDorOpeningFocus = document.activeElement;
    S.ballonDorOpeningCandidates = market.candidates.slice();
    S.ballonDorOpeningMonth = market.seasonMonth;
    S.ballonDorOpeningElapsed = 0;
    S.ballonDorOpeningDuration = BALLON_DOR_OPENING_SECONDS;
    S.ballonDorOpeningScene = null;
    S.ballonDorOpeningComplete = false;
    S.ballonDorOpeningMandatory = Boolean(settings.mandatory);
    S.ballonDorOpeningAudioBlocked = false;
    S.ballonDorOpeningPaused = false;
    S.ballonDorOpeningMode = 'narration';
    S.ballonDorOpeningAutoShown[market.seasonMonth] = true;
    clearBallonDorOpeningTimer();
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.dataset.seasonMonth = market.seasonMonth || '';
    overlay.classList.toggle('is-mandatory', S.ballonDorOpeningMandatory);
    document.body.classList.add('est-bdo-opening-open');
    try {
      var key = BALLON_DOR_OPENING_KEY + market.seasonMonth;
      if (localStorage.getItem(key) !== 'completed') localStorage.setItem(key, 'started');
    } catch (_) { /* la presentación funciona aunque no se pueda persistir */ }
    renderBallonDorOpeningButton();
    audio.muted = S.ballonDorOpeningMuted;
    if (el['est-bdo-opening-bed']) el['est-bdo-opening-bed'].muted = S.ballonDorOpeningMuted;
    renderBallonDorOpeningScene(0);
    el['est-bdo-opening-progress'].setAttribute('aria-valuenow', '0');
    el['est-bdo-opening-progress-bar'].style.width = '0%';
    el['est-bdo-opening-time'].textContent = '0:00 / ' + formatBallonDorOpeningTime(BALLON_DOR_OPENING_SECONDS);
    el['est-bdo-opening-transcript-copy'].textContent = BALLON_DOR_OPENING_SCRIPT;
    updateBallonDorOpeningControls();
    startBallonDorOpeningClock(S.ballonDorOpeningSession);
    playBallonDorOpeningNarration(S.ballonDorOpeningSession, 0);
    if (S.ballonDorOpeningMandatory) el['est-bdo-opening-play'].focus();
    else el['est-bdo-opening-close'].focus();
  }

  // Un gesto del usuario puede desbloquear el audio del navegador. Se reanuda en
  // el punto de la presentación en que esté: si la narración ya terminó, entra el
  // tema instrumental en vez de repetir la voz desde el principio.
  function activateBallonDorOpeningAudio() {
    if (!S.ballonDorOpeningAudioBlocked || S.ballonDorOpeningComplete) return;
    var audio = el['est-bdo-opening-audio'];
    S.ballonDorOpeningPaused = false;
    var narrationEnd = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
    if (narrationEnd != null && S.ballonDorOpeningElapsed >= narrationEnd) {
      startBallonDorOpeningBed();
      startBallonDorOpeningClock(S.ballonDorOpeningSession);
      return;
    }
    playBallonDorOpeningNarration(S.ballonDorOpeningSession, S.ballonDorOpeningElapsed);
    startBallonDorOpeningClock(S.ballonDorOpeningSession);
  }

  function toggleBallonDorOpeningPlayback() {
    if (S.ballonDorOpeningComplete) return;
    var bed = el['est-bdo-opening-bed'];
    if (!S.ballonDorOpeningPaused) {
      stopBallonDorOpeningAudio();
      S.ballonDorOpeningElapsed = Math.min(BALLON_DOR_OPENING_SECONDS,
        Math.max(0, (Date.now() - S.ballonDorOpeningStartedAt) / 1000));
      clearBallonDorOpeningTimer();
      S.ballonDorOpeningPaused = true;
      el['est-bdo-opening-stage'].classList.add('is-paused');
      el['est-bdo-opening-status'].textContent = 'Inauguración en pausa.';
    } else {
      S.ballonDorOpeningPaused = false;
      startBallonDorOpeningClock(S.ballonDorOpeningSession);
      if (S.ballonDorOpeningMode === 'narration' && !S.ballonDorOpeningAudioBlocked) {
        playBallonDorOpeningNarration(S.ballonDorOpeningSession, S.ballonDorOpeningElapsed);
      } else if (S.ballonDorOpeningMode === 'bed') {
        try { bed.play(); } catch (_) { /* audio opcional */ }
        el['est-bdo-opening-stage'].classList.remove('is-paused');
      } else if (S.ballonDorOpeningAudioBlocked) {
        el['est-bdo-opening-stage'].classList.remove('is-paused');
        el['est-bdo-opening-status'].textContent = 'Audio no disponible · escenas y guion en pantalla. Activa la narración si la quieres escuchar.';
      } else {
        el['est-bdo-opening-stage'].classList.remove('is-paused');
      }
    }
    updateBallonDorOpeningControls();
  }

  function muteBallonDorOpening() {
    S.ballonDorOpeningMuted = !S.ballonDorOpeningMuted;
    if (el['est-bdo-opening-audio']) el['est-bdo-opening-audio'].muted = S.ballonDorOpeningMuted;
    if (el['est-bdo-opening-bed']) el['est-bdo-opening-bed'].muted = S.ballonDorOpeningMuted;
    updateBallonDorOpeningControls();
  }

  function closeBallonDorOpening() {
    var overlay = el['est-bdo-opening'];
    if (!overlay || overlay.hidden || (S.ballonDorOpeningMandatory && !S.ballonDorOpeningComplete)) return;
    S.ballonDorOpeningSession++;
    clearBallonDorOpeningTimer();
    stopBallonDorOpeningAudio();
    try {
      el['est-bdo-opening-audio'].currentTime = 0;
      if (el['est-bdo-opening-bed']) el['est-bdo-opening-bed'].currentTime = 0;
    } catch (_) { /* audio opcional */ }
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('est-bdo-opening-open');
    el['est-bdo-opening-stage'].classList.remove('is-paused');
    S.ballonDorOpeningScene = null;
    S.ballonDorOpeningPaused = false;
    S.ballonDorOpeningMandatory = false;
    S.ballonDorOpeningAudioBlocked = false;
    overlay.classList.remove('is-mandatory');
    renderBallonDorOpeningButton();
    var focus = S.ballonDorOpeningFocus;
    S.ballonDorOpeningFocus = null;
    if (focus && focus.isConnected && typeof focus.focus === 'function') focus.focus();
    else if (el['est-bdo-opening-start'] && !el['est-bdo-opening-start'].hidden) el['est-bdo-opening-start'].focus();
  }

  function onBallonDorOpeningKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!(S.ballonDorOpeningMandatory && !S.ballonDorOpeningComplete)) closeBallonDorOpening();
      return;
    }
    if (event.key === 'Tab') {
      var focusable = Array.prototype.slice.call(el['est-bdo-opening'].querySelectorAll('button:not([disabled]):not([hidden]), summary'));
      if (focusable.length) {
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    event.stopPropagation();
  }

  function chooseBallonDorCandidate(candidateId) {
    S.ballonDorSelection = candidateId;
    S.ballonDorReview = null;
    S.ballonDorIdempotencyKey = null;
    S.ballonDorReceipt = null;
    setBallonDorMessage('', '');
    renderBallonDorMarket();
    if (el['est-bdo-selection']) el['est-bdo-selection'].value = candidateId;
    if (el['est-bdo-stake']) el['est-bdo-stake'].focus();
  }

  function renderBallonDorSlip(market, ticket) {
    var slip = el['est-bdo-slip'];
    if (!slip) return;
    var active = market.status === 'active' && !ticket;
    slip.hidden = !active;
    if (!active) return;
    var candidate = (market.candidates || []).find(function (item) { return item.id === S.ballonDorSelection; });
    var quote = ballonDorQuote(candidate);
    var selectedClub = $('est-bdo-selected-club');
    if (selectedClub) { if (candidate) setClubLabel(selectedClub, candidate.clubId, candidate.clubName); else selectedClub.textContent = ''; }
    var hasProfile = Boolean(S.profile && S.profile.id);
    var termsAccepted = tosAccepted();
    var bounds = ballonDorStakeBounds();
    el['est-bdo-bounds'].textContent = hasProfile
      ? 'Saldo: ' + fmt(S.chips) + ' · Mínimo: ' + fmt(bounds.min) + ' · Máximo: ' + fmt(bounds.max) + ' fichas (máx. absoluto 25,000).'
      : 'Saldo no disponible. Entra al Estadio para asociar tu perfil; la consulta del mercado sigue disponible por HTTP.';
    el['est-bdo-stake'].min = bounds.min || 1;
    el['est-bdo-stake'].max = bounds.max || 1;
    el['est-bdo-stake'].disabled = !hasProfile || !termsAccepted || !quote || bounds.max <= 0 || Boolean(S.ballonDorReview || S.ballonDorSubmitting);
    el['est-bdo-selection'].disabled = !hasProfile || !termsAccepted || !candidatesAreSelectable(market)
      || Boolean(S.ballonDorReview || S.ballonDorSubmitting);
    el['est-bdo-selection'].value = S.ballonDorSelection || '';
    el['est-bdo-quote'].textContent = candidate && quote
      ? 'Cuota vigente: ' + quote.toFixed(2) + ' · Probabilidad implícita: ' + pct(candidate.impliedProbability || (1 / quote)) +
        ' · Pago potencial al stake actual: ' + fmt(Math.min(500000, Math.floor((Number(el['est-bdo-stake'].value) || 0) * quote))) + ' fichas.'
      : 'Elige un candidato con cuota publicada para preparar tu predicción.';
    var stake = Math.floor(Number(el['est-bdo-stake'].value) || 0);
    var canReview = hasProfile && termsAccepted && Boolean(candidate && quote) && stake >= bounds.min && stake <= bounds.max
      && !S.ballonDorSubmitting && !S.ballonDorReview;
    el['est-bdo-review'].disabled = !canReview;
    if (!hasProfile) setBallonDorMessage('Para apostar necesitas un perfil de Estadio. Conéctate al menos una vez; la tabla pública sigue disponible.', '');
    else if (!termsAccepted) setBallonDorMessage('Acepta los Términos de Uso vigentes para habilitar las predicciones.', '');
    else if (ticket) setBallonDorMessage('Ya tienes un boleto en este ciclo; no puedes cambiarlo ni hacer cash-out.', '');
    if (S.ballonDorReview) {
      el['est-bdo-confirmation'].hidden = false;
      var reviewCandidate = (market.candidates || []).find(function (c) { return c.id === S.ballonDorReview.selection; });
      var reviewName = reviewCandidate ? esc(reviewCandidate.playerName) + ' · ' + clubCrestMarkup(reviewCandidate.clubId, 'est-inline-crest') + esc(reviewCandidate.clubName) : esc(ballonDorCandidateName(market, S.ballonDorReview.selection));
      el['est-bdo-confirmation-copy'].innerHTML = 'Predicción: ' + reviewName
        + '. Stake: ' + fmt(S.ballonDorReview.stake) + ' fichas. Cuota revisada: ' + Number(S.ballonDorReview.odds).toFixed(2)
        + '. Pago potencial estimado: ' + fmt(S.ballonDorReview.potentialPayout) + ' fichas.';
      el['est-bdo-confirm'].disabled = Boolean(S.ballonDorSubmitting);
      el['est-bdo-confirm'].textContent = S.ballonDorSubmitting ? 'Enviando…' : 'Confirmar y descontar';
      el['est-bdo-review'].hidden = true;
    } else {
      el['est-bdo-confirmation'].hidden = true;
      el['est-bdo-confirm'].disabled = false;
      el['est-bdo-confirm'].textContent = 'Confirmar y descontar';
      el['est-bdo-review'].hidden = false;
      el['est-bdo-review'].textContent = S.ballonDorIdempotencyKey ? 'Revisar y reintentar' : 'Revisar predicción';
    }
  }

  function candidatesAreSelectable(market) {
    return market.status === 'active' && Array.isArray(market.candidates) && market.candidates.length === 16
      && !(currentBallonDorTicket());
  }

  function renderBallonDorReceipt(market, ticket) {
    var box = el['est-bdo-receipt'];
    if (!box) return;
    box.hidden = !ticket;
    if (!ticket) return;
    var receiptCandidate = (market.candidates || []).find(function (c) { return c.id === ticket.selection; });
    var name = receiptCandidate ? esc(receiptCandidate.playerName) + ' · ' + clubCrestMarkup(receiptCandidate.clubId, 'est-inline-crest') + esc(receiptCandidate.clubName) : esc(ballonDorCandidateName(market, ticket.selection));
    var statusLabels = {
      pending: 'Confirmación pendiente de persistencia', open: 'Activa · cuota congelada',
      won: 'Ganada · premio acreditado', lost: 'No acertada', void: 'Anulada · stake reembolsado'
    };
    var payout = Math.max(0, Number(ticket.payout) || 0);
    var status = statusLabels[ticket.status] || 'Estado: ' + String(ticket.status || 'no disponible');
    var payoutLine = ticket.status === 'void'
      ? 'Reembolso exacto: ' + fmt(payout) + ' fichas.'
      : ticket.status === 'won'
        ? 'Pago acreditado: ' + fmt(payout) + ' fichas (neto ' + fmt(payout - Number(ticket.stake || 0)) + ').'
        : ticket.status === 'lost' ? 'Pago: 0 fichas.'
          : 'Pago potencial: ' + fmt(ticket.potentialPayout) + ' fichas.';
    el['est-bdo-receipt-body'].innerHTML =
      '<div class="est-bdo-receipt-row"><span>Selección</span><b>' + name + '</b></div>' +
      '<div class="est-bdo-receipt-row"><span>Stake</span><b>' + fmt(ticket.stake) + ' fichas</b></div>' +
      '<div class="est-bdo-receipt-row"><span>Cuota congelada</span><b>' + Number(ticket.odds || 1).toFixed(2) + '</b></div>' +
      '<div class="est-bdo-receipt-row"><span>Estado</span><b>' + esc(status) + '</b></div>' +
      '<div class="est-bdo-receipt-row"><span>Liquidación</span><b>' + esc(payoutLine) + '</b></div>' +
      '<div class="est-bdo-receipt-row"><span>Temporada</span><b>' + esc(ticket.seasonMonth || market.seasonMonth) + '</b></div>';
  }

  function bdoErrorText(code) {
    return ({
      no_identity: 'No se encontró tu perfil. Vuelve a entrar al Estadio e inténtalo otra vez.',
      tos_required: 'Acepta los Términos de Uso vigentes antes de confirmar.',
      temporada_no_actual: 'Tu perfil aún no está sincronizado con este mes. Espera un momento y reintenta.',
      evento_no_disponible: 'No hay un ciclo disponible para recibir esta predicción.',
      mercado_cerrado: 'Mercado cerrado: las predicciones terminan al asentarse los ocho partidos de J20.',
      seleccion_invalida: 'Ese candidato no pertenece al ciclo actual.',
      cuota_no_disponible: 'La cuota de esa selección todavía no está disponible.',
      boleto_ya_colocado: 'Ya colocaste un boleto en este ciclo. No se puede cambiar ni retirar.',
      boleto_anulado: 'El intento anterior fue anulado; actualiza tu historial antes de volver a intentarlo.',
      stake_bajo_minimo: 'El monto está por debajo del mínimo común (10 % de tu saldo, ajustado para saldos bajos).',
      stake_sobre_maximo: 'El monto supera el máximo común (50 % de tu saldo o 25,000 fichas).',
      saldo_insuficiente: 'El saldo cambió y ya no alcanza para ese stake. Revisa el monto.',
      rate_limit: 'Demasiados intentos seguidos. Espera un momento y reintenta.',
      idempotency_key_invalida: 'No pudimos validar la clave del intento. Revisa de nuevo la predicción.',
      persistencia_pendiente: 'La confirmación está pendiente de guardado. Puedes reintentar sin un segundo débito.',
      origin_denied: 'La solicitud no pasó la validación de origen. Recarga el Estadio.',
      network_error: 'No llegó una respuesta del servidor. Reintenta con el mismo boleto; la clave idempotente evita un segundo débito.',
      market_unavailable: 'El mercado no está disponible ahora. Actualiza el Estadio antes de volver a intentar.',
      internal: 'Ocurrió un error del servidor. Tu saldo se conserva; consulta el historial antes de reintentar.'
    })[code] || 'No se pudo confirmar la predicción (' + String(code || 'error') + ').';
  }

  function newBallonDorIdempotencyKey() {
    try { return 'bdo-' + crypto.randomUUID(); }
    catch (_) { return 'bdo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14); }
  }

  function reviewBallonDorBet() {
    if (S.ballonDorSubmitting || !S.ballonDorMarket || S.ballonDorMarket.status !== 'active') return;
    if (!Array.isArray(S.ballonDorMarket.candidates) || S.ballonDorMarket.candidates.length !== 16) {
      setBallonDorMessage('El ciclo no está completo: se requieren 16 candidatos publicados por el servidor.', 'error');
      return;
    }
    var candidate = (S.ballonDorMarket.candidates || []).find(function (item) { return item.id === S.ballonDorSelection; });
    var quote = ballonDorQuote(candidate);
    var bounds = ballonDorStakeBounds();
    var stake = Math.floor(Number(el['est-bdo-stake'].value) || 0);
    if (!tosAccepted()) { setBallonDorMessage('Acepta los Términos de Uso vigentes antes de apostar.', 'error'); return; }
    if (!S.profile || !S.profile.id) { setBallonDorMessage('Entra al Estadio para asociar un perfil antes de apostar.', 'error'); return; }
    if (!candidate || !quote) { setBallonDorMessage('Selecciona un candidato con cuota disponible.', 'error'); return; }
    if (stake < bounds.min || stake > bounds.max) {
      setBallonDorMessage('Monto fuera del rango permitido: ' + fmt(bounds.min) + '–' + fmt(bounds.max) + ' fichas.', 'error');
      el['est-bdo-stake'].focus();
      return;
    }
    if (currentBallonDorTicket()) { setBallonDorMessage('Ya existe un boleto para este perfil y ciclo.', 'error'); renderBallonDorMarket(); return; }
    if (!S.ballonDorIdempotencyKey) S.ballonDorIdempotencyKey = newBallonDorIdempotencyKey();
    S.ballonDorReview = {
      selection: candidate.id, stake: stake, odds: quote,
      potentialPayout: Math.min(500000, Math.floor(stake * quote))
    };
    setBallonDorMessage('', '');
    renderBallonDorMarket();
    el['est-bdo-confirm'].focus();
  }

  function confirmBallonDorBet() {
    if (!S.ballonDorReview || S.ballonDorSubmitting) return;
    if (!tosAccepted()) { setBallonDorMessage('Acepta los Términos de Uso vigentes antes de confirmar.', 'error'); return; }
    var market = S.ballonDorMarket;
    if (!market || market.status !== 'active') {
      setBallonDorMessage('Mercado cerrado. Actualizamos el estado antes de intentar otra vez.', 'error');
      S.ballonDorReview = null;
      loadBallonDorMarket();
      return;
    }
    var current = (market.candidates || []).find(function (candidate) { return candidate.id === S.ballonDorReview.selection; });
    var quote = ballonDorQuote(current);
    if (!quote || quote !== Number(S.ballonDorReview.odds)) {
      S.ballonDorReview = null;
      S.ballonDorIdempotencyKey = null;
      setBallonDorMessage('La cuota cambió. Revisa de nuevo antes de confirmar.', 'error');
      renderBallonDorMarket();
      return;
    }
    var payload = {
      selection: S.ballonDorReview.selection,
      stake: S.ballonDorReview.stake,
      idempotencyKey: S.ballonDorIdempotencyKey || newBallonDorIdempotencyKey()
    };
    S.ballonDorIdempotencyKey = payload.idempotencyKey;
    S.ballonDorSubmitting = true;
    renderBallonDorMarket();
    setBallonDorMessage('Enviando la predicción con la cuota del servidor…', '');

    var complete = false;
    var timeout = window.setTimeout(function () {
      if (complete) return;
      complete = true;
      S.ballonDorSubmitting = false;
      setBallonDorMessage('No llegó la confirmación a tiempo. Reintenta con la misma clave idempotente; no se duplicará el débito.', 'error');
      renderBallonDorMarket();
    }, 10000);
    function finish(result) {
      if (complete) return;
      complete = true;
      window.clearTimeout(timeout);
      S.ballonDorSubmitting = false;
      if (!result || !result.ok || !result.future) {
        if (result && result.code === 'tos_required') {
          S.ballonDorReview = null;
          S.ballonDorIdempotencyKey = null;
          el['est-tos'].hidden = false;
        }
        setBallonDorMessage(bdoErrorText(result && result.code), 'error');
        if (result && ['mercado_cerrado', 'boleto_ya_colocado', 'persistencia_pendiente'].indexOf(result.code) >= 0) {
          loadBallonDorMarket();
          loadBetHistory({ force: true });
        }
        renderBallonDorMarket();
        return;
      }
      S.chips = Number(result.chips != null ? result.chips : (S.chips - payload.stake));
      if (!Number.isFinite(S.chips)) S.chips = 0;
      updateChips();
      S.ballonDorReceipt = result.future;
      S.ballonDorReview = null;
      S.ballonDorIdempotencyKey = null;
      S.ballonDorSelection = result.future.selection || payload.selection;
      setBallonDorMessage(result.replayed
        ? 'Reintento reconocido: se recuperó tu boleto original sin volver a descontar fichas.'
        : 'Predicción confirmada. La cuota y el stake quedaron congelados en el recibo.', 'success');
      renderBallonDorMarket();
      loadBetHistory({ force: true });
      if (!result.replayed) bell('bet');
    }

    if (S.socket && S.socket.connected) {
      try {
        S.socket.emit('football:ballon_dor_bet', payload, finish);
      } catch (_) { finish({ ok: false, code: 'network_error' }); }
      return;
    }
    fetch('/api/estadio/ballon-dor/bet', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': payload.idempotencyKey },
      body: JSON.stringify({ token: S.token, selection: payload.selection, stake: payload.stake, idempotencyKey: payload.idempotencyKey, tos: S.tosVersion })
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        return { ok: response.ok, data: data };
      });
    }).then(function (response) { finish(response.data); })
      .catch(function () { finish({ ok: false, code: 'network_error' }); });
  }

  function editBallonDorBet() {
    if (S.ballonDorSubmitting) return;
    S.ballonDorReview = null;
    S.ballonDorIdempotencyKey = null;
    setBallonDorMessage('', '');
    renderBallonDorMarket();
    if (el['est-bdo-selection']) el['est-bdo-selection'].focus();
  }

  function selectMatch(matchId) {
    if (!S.socket || !matchId) return;
    if (S.currentMatchId && S.currentMatchId !== matchId) S.socket.emit('football:unsubscribe', { scope: 'match', matchId: S.currentMatchId });
    S.socket.emit('football:subscribe', { scope: 'match', matchId: matchId, token: S.token, tos: S.tosVersion }, function (res) {
      if (!res || !res.ok) return onSubError(res);
      if (S.currentMatchId !== matchId) {
        S.currentMatchId = matchId;
        resetCrowdFeed();
        setCrowdMessage('', '');
      }
      S.teams = res.teams || S.teams;
      if (res.profile) { S.chips = res.profile.chips; updateChips(); }
      applyMatchState(res.matchState);
      updateCrowdAvailability();
      if (ledgerOpen()) renderLedger();
      highlightActive();
    });
  }

  // ===== Lobby =====
  // Las rutas son un catálogo cerrado: no se incorpora ningún id externo a la URL.
  var CLUB_CRESTS = {
    vantora_fc:'RMD', united_vanguard:'FAR', olympique_estevin:'ATC', atletico_solaris:'MUN',
    sporting_almar:'LVP', dynamo_kelvar:'ARS', cs_verdania:'BAY', halcyon_bay_fc:'BDO',
    athletic_ferrata:'JUV', royal_corvane:'PSG', sv_talbruck:'RSU', velmar_harbour_fc:'RDB',
    norvela_sporting:'WHM', ironvale_fc:'NAB', peregrine_rovers:'CDC', puerto_ambar:'BEN'
  };
  function clubCrestMarkup(id, extraClass) {
    var code = Object.prototype.hasOwnProperty.call(CLUB_CRESTS, id) ? CLUB_CRESTS[id] : null;
    if (!code) return '<span class="est-club-crest est-club-crest-fallback ' + (extraClass || '') + '" aria-hidden="true"></span>';
    return '<img class="est-club-crest ' + (extraClass || '') + '" src="/assets/escudos/' + code + '.svg" alt="" aria-hidden="true" decoding="async">';
  }
  function setClubLabel(node, teamId, name) {
    node.innerHTML = clubCrestMarkup(teamId, 'est-inline-crest');
    node.appendChild(document.createTextNode(name));
  }
  function setScoreboardCrest(id, teamId, color) {
    var node = el[id];
    if (node.dataset.teamId === String(teamId)) return;
    node.dataset.teamId = String(teamId);
    node.innerHTML = clubCrestMarkup(teamId, 'est-score-crest-img');
    node.style.color = color;
  }
  function teamName(id) { var t = S.teams[id]; return t ? t.name || t.short : String(id || '?').slice(0, 3).toUpperCase(); }
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
      image: matchCard ? matchCard.image : promotion.image,
      matchTextMarkup: matchCard ? matchCard.textMarkup : null
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
        '<p' + textId + (hasText ? '' : ' class="is-empty"') + '>' + (promotion.matchTextMarkup || esc(promotion.text || '')) + '</p>' +
      '</div>' +
      '<a' + linkId + ' class="btn btn-ghost btn-small est-showcase-cta" href="' + esc(href) + '"' + labelStyle + '>' + esc(ctaText) + '</a>' +
    '</article>';
  }

  function indicatorSlideMarkup(indicators, _homeColor, _awayColor) {
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
        '<div' + homeId + ' class="est-compare-club est-compare-club-home">' + clubCrestMarkup(S.match.homeId, 'est-compare-dot') + '<span>' + esc(teamFull(S.match.homeId)) + '</span></div>' +
        '<span class="est-compare-versus" aria-hidden="true">VS</span>' +
        '<div' + awayId + ' class="est-compare-club est-compare-club-away">' + clubCrestMarkup(S.match.awayId, 'est-compare-dot') + '<span>' + esc(teamFull(S.match.awayId)) + '</span></div>' +
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
      textMarkup: '⚔️ ' + clubCrestMarkup(homeId, 'est-inline-crest') + esc(homeName) + ' (' + esc(homeTactic) + ') vs ' + clubCrestMarkup(awayId, 'est-inline-crest') + esc(awayName) + ' (' + esc(awayTactic) + ')' + (posText ? ' · Posiciones: ' + esc(posText) : '') + ' · ¡Duelo estelar en vivo!',
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
      // El marcador final sale del resultado ASENTADO del partido (home/away), que
      // es el mismo que pinta la ficha, la tabla y el boleto. Antes solo se leía
      // m.result.score, una forma que el servidor no envía, así que los partidos
      // cerrados aparecían sin marcador en la lista.
      var finalScore = m.result && (m.result.score || (m.result.home != null && m.result.away != null))
        ? (m.result.score
          ? Number(m.result.score.home) + '–' + Number(m.result.score.away)
          : Number(m.result.home) + '–' + Number(m.result.away))
        : '';
      var score = finalScore || (m.minute != null ? '' : kickoffTime(m.scheduledKickoffAt));
      li.innerHTML =
        '<div><div class="est-match-teams">' + clubCrestMarkup(m.homeId, 'est-match-crest') + '<span style="color:' + preshowTeamColor(m.homeId) + '">' + esc(teamName(m.homeId)) + '</span> vs ' + clubCrestMarkup(m.awayId, 'est-match-crest') + '<span style="color:' + preshowTeamColor(m.awayId) + '">' + esc(teamName(m.awayId)) + '</span>' + (m.featured ? ' ★' : '') + '</div>' +
        '<div class="est-match-meta">' + esc(blockLabel(m.block)) + ' · J' + m.jornada + '</div></div>' +
        '<div><div class="est-match-score">' + esc(score) + '</div><div class="est-match-status ' + (live ? 'live' : 'scheduled') + '">' + esc(STATUS_LABEL[m.status] || m.status) + (m.minute != null && live ? ' ' + m.minute + "'" : '') + '</div></div>';
      li.addEventListener('click', function () { selectMatch(m.id); });
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMatch(m.id); } });
      list.appendChild(li);
    });
    renderStandings();
    renderPreshow(currentServerTime());
  }
  // La zona conserva el formulario montado: cambiar de vista o cerrar no borra el borrador.
  var hubTrigger = null;
  function hubOpen() { var hub = $('est-hub'); return Boolean(hub && !hub.hidden); }
  function setHubView(view) {
    var hub = $('est-hub');
    if (!hub) return;
    Array.prototype.forEach.call(hub.querySelectorAll('[data-hub-view]'), function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-hub-view') === view));
    });
    Array.prototype.forEach.call(hub.querySelectorAll('[data-hub-panel]'), function (panel) {
      panel.hidden = panel.getAttribute('data-hub-panel') !== view;
    });
  }
  function openHub(trigger) {
    var hub = $('est-hub');
    if (!hub || hubOpen()) return;
    hubTrigger = trigger || document.activeElement;
    setHubView('once');
    hub.hidden = false;
    document.body.classList.add('est-hub-open');
    $('est-hub-close').focus();
    refreshFantasy();
  }
  function closeHub() {
    var hub = $('est-hub');
    if (!hubOpen()) return;
    hub.hidden = true;
    document.body.classList.remove('est-hub-open');
    if (hubTrigger && hubTrigger.isConnected) hubTrigger.focus();
    hubTrigger = null;
  }
  function trapHubFocus(event) {
    if (event.key !== 'Tab') return;
    var nodes = $('est-hub').querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
    var list = Array.prototype.filter.call(nodes, function (node) { return !node.closest('[hidden]'); });
    if (!list.length) { event.preventDefault(); $('est-hub').focus(); return; }
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (list.indexOf(active) < 0) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }
  function refreshQuiniela() {
    var list = $('est-quiniela-list');
    if (!list || !S.socket || !S.socket.connected) { if (list) list.textContent = 'Conéctate para consultar la jornada.'; return; }
    list.textContent = 'Consultando la próxima jornada…';
    S.socket.emit('football:quiniela_get', {}, function (res) {
      if (!res || !res.ok || !res.quiniela) { list.textContent = res && res.error || 'No se pudo consultar la jornada.'; return; }
      var data = res.quiniela;
      if (!data.matches || !data.matches.length) { list.textContent = 'No hay otra jornada programada en esta temporada.'; return; }
      list.innerHTML = '<p>Jornada ' + Number(data.jornada) + ' · La inscripción no está disponible.</p><ul class="est-transfer-list">' + data.matches.map(function (match) {
        return '<li><span>' + clubCrestMarkup(match.homeId, 'est-inline-crest') + esc(teamName(match.homeId)) + ' vs ' + clubCrestMarkup(match.awayId, 'est-inline-crest') + esc(teamName(match.awayId)) + '</span></li>';
      }).join('') + '</ul>';
    });
  }
  // Conferencia de prensa del mercado: los acuerdos de la temporada con el valor
  // de cada jugador. La valoración viene del servidor (atributos del jugador), no
  // se calcula aquí: dos fórmulas distintas acabarían mostrando dos precios.
  function transferValueLabel(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return n.toFixed(1).replace('.', ',') + ' M';
  }
  function refreshTransfers() {
    var list = $('est-transfers-list');
    if (!list || !S.socket || !S.socket.connected) { if (list) list.textContent = 'Conéctate para consultar el mercado.'; return; }
    list.textContent = 'Consultando el mercado…';
    S.socket.emit('football:transfers_get', {}, function (res) {
      if (!res || !res.ok || !res.transfers) { list.textContent = res && res.error || 'No se pudo consultar el mercado.'; return; }
      var market = res.transfers;
      if (market.status === 'scheduled') { list.textContent = 'Los traspasos se anunciarán el día 15 de este mes.'; return; }
      if (!Array.isArray(market.moves) || !market.moves.length) { list.textContent = 'No hay acuerdos disponibles para esta temporada.'; return; }
      var stage = market.status === 'effective'
        ? 'Acuerdos en vigor desde la temporada ' + market.effectiveSeason + '.'
        : 'Acuerdos anunciados; se hacen efectivos en la temporada ' + market.effectiveSeason + '.';
      list.innerHTML = '<p>' + esc(stage) + '</p><ul class="est-transfer-list">' + market.moves.map(function (move) {
        var position = move.position ? ' · ' + esc(move.position) : '';
        return '<li><b>' + esc(move.playerName) + '</b>' + position +
          '<span>' + clubCrestMarkup(move.fromId, 'est-inline-crest') + esc(teamName(move.fromId)) + ' → ' +
          clubCrestMarkup(move.toId, 'est-inline-crest') + esc(teamName(move.toId)) + '</span>' +
          '<span class="est-transfer-value">Valoración ' + esc(transferValueLabel(move.playerValue)) + '</span></li>';
      }).join('') + '</ul>';
    });
  }
  function refreshFan() {
    if (!$('est-fan-club') || !S.socket || !S.socket.connected || S.fanBusy) return;
    var seq = ++S.fanSeq;
    S.socket.emit('football:fan_get', {}, function (res) {
      if (seq !== S.fanSeq) return;
      if (!res || !res.ok || !res.fan) { $('est-fan-summary').textContent = res && res.error || 'Mi afición no está disponible.'; return; }
      S.fan = res.fan; renderFan();
    });
  }
  function renderFan() {
    var data = S.fan; if (!data) return;
    var select = $('est-fan-club'), previous = select.value;
    select.innerHTML = '<option value="">Elige un club…</option>' + Object.keys(S.teams).sort(function (a,b) { return teamName(a).localeCompare(teamName(b), 'es-MX'); }).map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(teamName(id)) + '</option>';
    }).join('');
    select.value = previous || data.clubId || '';
    select.disabled = S.fanBusy;
    $('est-fan-choose').disabled = S.fanBusy || !select.value;
    if ($('est-fan-selected-club')) { if (select.value) setClubLabel($('est-fan-selected-club'), select.value, teamName(select.value)); else $('est-fan-selected-club').textContent = ''; }
    $('est-fan-choose').textContent = data.clubId ? 'Cambiar club →' : 'Elegir club →';
    $('est-fan-summary').textContent = data.clubId ? data.wins + ' victorias desde tu adhesión · Nivel ' + data.level + '.' : 'Elige un club para comenzar.';
    var current = $('est-fan-current');
    if (data.clubId) setClubLabel(current, data.clubId, teamName(data.clubId)); else current.textContent = 'Aún no has elegido un club.';
    $('est-fan-rewards').innerHTML = (data.rewards || []).map(function (reward) {
      var progress = reward.target ? ' · ' + Number(reward.progress) + '/' + Number(reward.target) + ' victorias' : '';
      var button = reward.unlocked ? '<button type="button" data-fan-pin="' + esc(reward.id) + '" ' + (S.fanBusy ? 'disabled' : '') + '>' + (reward.equipped ? 'Quitar' : 'Equipar') + '</button>' : '';
      return '<li>' + (reward.unlocked ? '✦ ' : '○ ') + esc(reward.title) + progress + (reward.equipped ? ' · En uso ' : ' ') + button + '</li>';
    }).join('') || '<li>Elige un club para comenzar.</li>';
    Array.prototype.forEach.call($('est-fan-rewards').querySelectorAll('[data-fan-pin]'), function (button) {
      button.addEventListener('click', function () { equipFanPin(button.getAttribute('data-fan-pin')); });
    });
    var pin = $('est-active-fan-pin');
    if (pin) { pin.hidden = !data.clubId || !data.equippedPin; pin.innerHTML = pin.hidden ? '' : clubCrestMarkup(data.clubId, 'est-inline-crest') + esc(teamName(data.clubId)); }
    $('est-fan-opt').disabled = S.fanBusy || !data.clubId;
    $('est-fan-opt').checked = Boolean(data.rankingOptIn);
    $('est-fan-ranking').innerHTML = (data.ranking || []).map(function (row) {
      return '<li value="' + Number(row.rank) + '">' + clubCrestMarkup(row.clubId, 'est-inline-crest') + esc(teamName(row.clubId)) + ' · ' + Number(row.wins) + ' victorias · ' + Number(row.participants) + ' participantes</li>';
    }).join('') || '<li>Aún no hay participantes.</li>';
  }
  function equipFanPin(pin) {
    if (!S.fan || S.fanBusy || !S.socket || !S.socket.connected) return;
    S.fanBusy = true; var seq = ++S.fanSeq; renderFan();
    $('est-fan-feedback').textContent = 'Guardando pin…';
    S.socket.emit('football:fan_equip', { currentClubId:S.fan.clubId, pin:S.fan.equippedPin === pin ? null : pin }, function (res) {
      if (seq !== S.fanSeq) return;
      S.fanBusy = false;
      if (res && res.ok && res.fan) { S.fan = res.fan; renderFan(); $('est-fan-feedback').textContent = 'Tu pin quedó actualizado.'; }
      else { renderFan(); $('est-fan-feedback').textContent = res && res.error || 'No se pudo guardar el pin.'; }
    });
  }
  function selectFanClub(confirmed) {
    if (!S.fan || S.fanBusy || !S.socket || !S.socket.connected) return;
    var clubId = $('est-fan-club').value;
    if (!clubId) return;
    S.fanBusy = true; var seq = ++S.fanSeq; renderFan();
    $('est-fan-feedback').textContent = 'Guardando…';
    S.socket.emit('football:fan_select', { clubId:clubId, currentClubId:S.fan.clubId, confirmed:confirmed, tos:S.tosVersion }, function (res) {
      if (seq !== S.fanSeq) return;
      S.fanBusy = false;
      if (res && res.ok && res.fan) { S.fan = res.fan; $('est-fan-confirm').hidden = true; renderFan(); $('est-fan-feedback').textContent = 'Tu club quedó guardado.'; }
      else { renderFan(); $('est-fan-feedback').textContent = res && res.error || 'No se pudo confirmar. Consulta de nuevo.'; }
    });
  }
  function optFan() {
    if (!S.fan || S.fanBusy || !S.socket || !S.socket.connected) return;
    var enabled = $('est-fan-opt').checked;
    S.fanBusy = true; var seq = ++S.fanSeq; renderFan();
    S.socket.emit('football:fan_ranking_opt', { enabled:enabled, currentClubId:S.fan.clubId }, function (res) {
      if (seq !== S.fanSeq) return;
      S.fanBusy = false;
      if (res && res.ok && res.fan) { S.fan = res.fan; renderFan(); $('est-fan-feedback').textContent = enabled ? 'Participas en el ranking por clubes.' : 'Ya no participas en el ranking.'; }
      else { renderFan(); $('est-fan-feedback').textContent = res && res.error || 'No se pudo guardar la preferencia.'; }
    });
  }
  var FANTASY_SLOTS = ['GK','DF','DF','DF','DF','MF','MF','MF','MF','FW','FW'];
  var FANTASY_LABELS = { GK:'Portero', DF:'Defensa', MF:'Medio', FW:'Delantero' };
  function refreshFantasy() {
    if (!el['est-fantasy-form'] || !S.socket || !S.socket.connected || S.fantasyBusy) return;
    var seq = ++S.fantasySeq;
    S.socket.emit('football:fantasy_get', {}, function (res) {
      if (seq !== S.fantasySeq) return;
      if (!res || !res.ok || !res.fantasy) { el['est-fantasy-summary'].textContent = res && res.error || 'Mi Once no está disponible.'; return; }
      applyFantasy(res.fantasy, false);
    });
  }
  function applyFantasy(data, resetDraft) {
    var seasonChanged = !S.fantasy || S.fantasy.season !== data.season;
    S.fantasy = data;
    if (resetDraft || seasonChanged || !S.fantasyDirty) {
      var counts = { GK:0, DF:0, MF:0, FW:0 };
      S.fantasyDraft = FANTASY_SLOTS.map(function (group) {
        var picks = (data.selected || []).filter(function (id) { return (data.players || []).some(function (p) { return p.id === id && p.group === group; }); });
        return picks[counts[group]++] || '';
      });
      S.fantasyDirty = false;
    }
    renderFantasy();
  }
  function renderFantasy() {
    var data = S.fantasy; if (!data) return;
    var next = data.next ? 'Los cambios empiezan en la jornada ' + data.next.jornada + '.' : 'No hay una jornada abierta para cambios.';
    el['est-fantasy-summary'].textContent = fmt(data.points) + ' puntos · ' + next + (data.missingMatches ? ' Sin datos para ' + data.missingMatches + ' partidos anteriores.' : '') + (data.rank ? ' Tu puesto anónimo: ' + data.rank + '.' : '');
    el['est-fantasy-players'].innerHTML = FANTASY_SLOTS.map(function (group, i) {
      var options = (data.players || []).filter(function (p) { return p.group === group; }).map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (S.fantasyDraft[i] === p.id ? ' selected' : '') + '>' + esc(p.name) + ' · ' + esc(p.clubName) + ' (' + esc(p.position) + ')</option>';
      }).join('');
      var positionNumber = FANTASY_SLOTS.slice(0, i + 1).filter(function (slot) { return slot === group; }).length;
      var selectedPlayer = (data.players || []).find(function (player) { return player.id === S.fantasyDraft[i]; });
      var clubLabel = selectedPlayer ? clubCrestMarkup(selectedPlayer.clubId, 'est-fantasy-club-crest') + esc(selectedPlayer.clubName) : '';
      return '<label><span class="est-fantasy-slot-title"><span class="est-fantasy-slot-badge" aria-hidden="true">' + group + '</span>' + FANTASY_LABELS[group] + ' ' + positionNumber + '</span><select data-fantasy-slot="' + i + '" required' + (!data.next || S.fantasyBusy ? ' disabled' : '') + '><option value="">Elegir…</option>' + options + '</select><span class="est-fantasy-selected-club">' + clubLabel + '</span></label>';
    }).join('');
    el['est-fantasy-save'].disabled = !data.next || S.fantasyBusy;
    el['est-fantasy-opt'].disabled = S.fantasyBusy;
    el['est-fantasy-opt'].checked = Boolean(data.rankingOptIn);
    el['est-fantasy-challenges'].innerHTML = (data.challenges || []).map(function (c) { return '<li>' + (c.completed ? esc(c.icon) + ' Pin desbloqueado · ' : '') + '<strong>' + esc(c.title) + '</strong>: ' + esc(c.description) + ' (' + c.progress + '/' + c.target + ')</li>'; }).join('') || '<li>Arma tu once para empezar.</li>';
    el['est-fantasy-ranking'].innerHTML = (data.ranking || []).map(function (row) { return '<li value="' + Number(row.rank) + '">Once anónimo · ' + Number(row.points) + ' puntos</li>'; }).join('') || '<li>Aún no hay participantes.</li>';
  }
  function saveFantasy(event) {
    event.preventDefault(); var data = S.fantasy;
    if (!data || !data.next || S.fantasyBusy || !S.socket || !S.socket.connected) return;
    if (S.fantasyDraft.length !== 11 || S.fantasyDraft.some(function (id) { return !id; }) || new Set(S.fantasyDraft).size !== 11) { el['est-fantasy-feedback'].textContent = 'Elige 11 jugadores distintos.'; return; }
    S.fantasyBusy = true; var seq = ++S.fantasySeq; renderFantasy();
    el['est-fantasy-feedback'].textContent = 'Guardando…';
    S.socket.emit('football:fantasy_save', { season:data.season, players:S.fantasyDraft.slice(), tos:S.tosVersion }, function (res) {
      if (seq !== S.fantasySeq) return;
      S.fantasyBusy = false;
      if (res && res.ok && res.fantasy) { applyFantasy(res.fantasy, true); el['est-fantasy-feedback'].textContent = 'Guardado desde la jornada ' + res.appliedJornada + '.'; }
      else { el['est-fantasy-feedback'].textContent = res && res.error || 'No se pudo confirmar. Consulta de nuevo.'; renderFantasy(); }
    });
  }
  function optFantasy() {
    if (!S.fantasy || S.fantasyBusy || !S.socket || !S.socket.connected) return;
    var enabled = el['est-fantasy-opt'].checked;
    S.fantasyBusy = true; var seq = ++S.fantasySeq; renderFantasy();
    S.socket.emit('football:fantasy_ranking_opt', { enabled:enabled }, function (res) {
      if (seq !== S.fantasySeq) return;
      S.fantasyBusy = false;
      if (res && res.ok && res.fantasy) { applyFantasy(res.fantasy, false); el['est-fantasy-feedback'].textContent = enabled ? 'Participas en el ranking anónimo.' : 'Ya no participas en el ranking.'; }
      else { renderFantasy(); el['est-fantasy-feedback'].textContent = res && res.error || 'No se pudo guardar la preferencia.'; }
    });
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
        '<td>' + clubCrestMarkup(id, 'est-standing-crest') + esc(teamName(id)) + '</td>' +
        '<td>' + (row.played != null ? row.played : (row.pj != null ? row.pj : '')) + '</td>' +
        '<td>' + (row.goalDiff != null ? (row.goalDiff > 0 ? '+' : '') + row.goalDiff : (row.dg != null ? row.dg : '')) + '</td>' +
        '<td class="pts">' + (row.points != null ? row.points : (row.pts != null ? row.pts : '')) + '</td>';
      tb.appendChild(tr);
    });
  }
  // ===== Cuentas regresivas largas (DD:HH:MM:SS) =====
  // Dos relojes independientes, alimentados por instantes absolutos del
  // servidor (S.lobby.countdowns): el final de la temporada del casino (con el
  // reinicio de fichas) y el ciclo del Balón de Oro (cierre de apuestas de la
  // J20 y ceremonia de las 22:00 posteriores al último partido).
  function pad2(n) { return Number(n) < 10 ? '0' + Number(n) : String(n); }
  function formatDdhhmmss(ms) {
    var total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var d = Math.floor(total / 86400);
    var h = Math.floor((total % 86400) / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return pad2(d) + ':' + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }
  function shortMoment(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '';
    try {
      return new Date(Number(ms)).toLocaleString('es-MX', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
    } catch (_) { return ''; }
  }
  function tickSeasonCountdowns(nowMs) {
    var counts = S.lobby && S.lobby.countdowns ? S.lobby.countdowns : null;
    var seasonClock = el['est-countdown-season'];
    var seasonNote = el['est-countdown-season-note'];
    var bdoClock = el['est-countdown-bdo'];
    var bdoNote = el['est-countdown-bdo-note'];
    if (!counts) {
      if (seasonClock) seasonClock.textContent = '--:--:--:--';
      if (seasonNote) seasonNote.textContent = 'Sin fecha de cierre publicada.';
      if (bdoClock) bdoClock.textContent = '--:--:--:--';
      if (bdoNote) bdoNote.textContent = 'Sin ciclo publicado.';
      return;
    }
    var casino = counts.casino || {};
    var endsAt = Number(casino.endsAt || casino.chipsResetAt || 0);
    if (seasonClock) seasonClock.textContent = endsAt ? formatDdhhmmss(endsAt - nowMs) : '--:--:--:--';
    if (seasonNote) {
      if (casino.resetDeferred) seasonNote.textContent = 'El reinicio espera apuestas de fútbol abiertas.';
      else if (endsAt) seasonNote.textContent = 'Fichas nuevas el ' + shortMoment(endsAt) + '.';
      else seasonNote.textContent = '';
    }

    var bdo = counts.ballonDor || null;
    if (!bdo) {
      if (bdoClock) bdoClock.textContent = '--:--:--:--';
      if (bdoNote) bdoNote.textContent = 'Sin ciclo del Balón de Oro.';
      return;
    }
    var ceremonyAt = Number(bdo.ceremonyAt || 0);
    var betsCloseAt = Number(bdo.betsCloseAt || 0);
    if (bdo.status === 'settled') {
      if (bdoClock) bdoClock.textContent = '00:00:00:00';
      if (bdoNote) bdoNote.textContent = 'Ceremonia celebrada: resultado y premios publicados.';
      return;
    }
    if (bdo.status === 'cancelled') {
      if (bdoClock) bdoClock.textContent = '--:--:--:--';
      if (bdoNote) bdoNote.textContent = 'Ciclo cancelado.';
      return;
    }
    if (bdoClock) bdoClock.textContent = ceremonyAt ? formatDdhhmmss(ceremonyAt - nowMs) : '--:--:--:--';
    if (bdoNote) {
      if (bdo.status === 'scheduled') bdoNote.textContent = 'El ciclo abre el día 1 del mes.';
      else if (bdo.status === 'locked') bdoNote.textContent = 'Cuotas cerradas: la ceremonia espera el último partido.';
      else if (betsCloseAt && betsCloseAt > nowMs) bdoNote.textContent = 'Apuestas abiertas · cierran en ' + formatDdhhmmss(betsCloseAt - nowMs) + '.';
      else if (ceremonyAt) bdoNote.textContent = 'Ceremonia a las 22:00 del último partido · ' + shortMoment(ceremonyAt) + '.';
      else bdoNote.textContent = '';
    }
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
    tickSeasonCountdowns(nowMs);
    renderPreshow(nowMs);
  }

  // ===== Estado del partido =====
  function renderHighlights(data) {
    var box=$('est-highlights'); if (!box) return;
    box.hidden=!data || !S.match;
    if (box.hidden) return;
    var labels={goal:'Gol',penalty_scored:'Gol de penal',shot_on_target:'Tiro a puerta',big_chance:'Gran oportunidad',red_card:'Tarjeta roja',second_yellow:'Segunda amarilla'};
    function sideId(side) { return side === 'home' ? S.match.homeId : S.match.awayId; }
    function line(item) {
      var team=sideId(item.side);
      return '<li><b>' + Number(item.minute) + "′ · " + esc(labels[item.type] || 'Jugada') + '</b> · ' + clubCrestMarkup(team,'est-inline-crest') + esc(teamName(team)) + (item.player ? ' · ' + esc(item.player) : '') + (item.assist ? ' · Asistencia: ' + esc(item.assist) : '') + '</li>';
    }
    $('est-highlights-score').innerHTML=clubCrestMarkup(S.match.homeId,'est-inline-crest') + esc(teamName(S.match.homeId)) + ' ' + Number(S.match.result && S.match.result.home != null ? S.match.result.home : S.score.home) + '–' + Number(S.match.result && S.match.result.away != null ? S.match.result.away : S.score.away) + ' ' + clubCrestMarkup(S.match.awayId,'est-inline-crest') + esc(teamName(S.match.awayId));
    $('est-highlights-goals').innerHTML=(data.goals || []).map(line).join('') || '<li>No hubo goles.</li>';
    $('est-highlights-moments').innerHTML=(data.moments || []).map(line).join('') || '<li>No hubo jugadas destacadas registradas.</li>';
    var star=data.star, club=star && sideId(star.side);
    $('est-highlights-star').innerHTML=star ? '<b>Figura estadística del partido:</b> ' + esc(star.name) + ' · ' + clubCrestMarkup(club,'est-inline-crest') + esc(teamName(club)) + ' · ' + Number(star.goals) + ' goles · ' + Number(star.assists) + ' asistencias' : 'Figura estadística no disponible.';
  }

  function applyMatchState(ms) {
    if (!ms) return;
    if (ms.stands !== undefined) renderStands(ms.stands);
    if (S.match && ms.match && S.match.id !== ms.match.id) cancelCommentarySpeech();
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
    renderHighlights(ms.match && ms.match.status === 'settled' ? ms.match.highlights : null);
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
  // Reloj: si el árbitro ya anunció el agregado de esta mitad, se muestra como
  // «45+4'» / «90+3'»; si no, el minuto en juego de siempre.
  function clockMinuteLabel() {
    if (S.stoppage && S.stoppage.added) {
      var base = S.stoppage.half === 1 ? 45 : 90;
      return base + '+' + S.stoppage.added + "'";
    }
    return S.minute + "'";
  }
  function renderScoreboard() {
    if (!S.match) return;
    setScoreboardCrest('crest-home', S.match.homeId, S.homeKit);
    setScoreboardCrest('crest-away', S.match.awayId, S.awayKit);
    el['name-home'].textContent = teamFull(S.match.homeId); el['name-away'].textContent = teamFull(S.match.awayId);
    el['score-home'].textContent = S.score.home; el['score-away'].textContent = S.score.away;
    var live = ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0;
    el['est-clock'].textContent = live ? clockMinuteLabel() + ' ' + phaseLabel(S.phase) : (STATUS_LABEL[S.match.status] || '—');
    el['est-market-phase'].textContent = live ? 'En vivo' : 'Pre-partido';
    el['est-pitch'].setAttribute('aria-label', 'Cancha cenital. ' + teamFull(S.match.homeId) + ' ' + S.score.home + ' – ' + S.score.away + ' ' + teamFull(S.match.awayId) + '. Minuto ' + (S.stoppage && S.stoppage.added ? clockMinuteLabel() : S.minute) + ', ' + phaseLabel(S.phase) + '.');
  }

  // ===== Relato hablado =====
  // La voz es opt-in: los navegadores pueden bloquear el audio automático y el
  // oyente decide cuándo activarlo. Las intervenciones usan una cola propia para
  // mantener los turnos (narrador -> analista), nunca se lanzan en paralelo.
  var COMMENTARY_SPEECH_QUEUE_LIMIT = 8;
  var commentarySpeech = {
    queue: [], active: null, activeCard: null, timer: null, token: 0, lastVoice: null,
    voices: { narrador: null, analista: null }, listenersBound: false, buttonBound: false
  };
  function commentarySpeechSupported() {
    return Boolean(window.speechSynthesis && typeof window.speechSynthesis.speak === 'function' &&
      typeof window.SpeechSynthesisUtterance === 'function');
  }
  // La Web Speech API no expone el género de la voz, así que se infiere del
  // nombre. La mesa de comentaristas de MonteCristo es masculina: si el navegador
  // ofrece voces masculinas en español se eligen esas; si solo hay femeninas o
  // sin nombre reconocible, se conserva la voz y se baja el tono como respaldo.
  // Este criterio es SOLO del relato del partido: la inauguración del Balón de Oro
  // y la ceremonia final usan sus pistas pregrabadas en voz femenina y no pasan
  // por aquí.
  var COMMENTARY_MALE_NAMES = ['jorge', 'raul', 'diego', 'pablo', 'miguel', 'carlos', 'juan', 'andres',
    'alex', 'enrique', 'santiago', 'gonzalo', 'javier', 'manuel', 'pedro', 'ricardo', 'fernando',
    'alvaro', 'david', 'daniel', 'jose', 'mario', 'hugo', 'gerardo', 'arturo', 'roberto', 'eduardo',
    'marco', 'antonio', 'francisco', 'sergio', 'ivan', 'rodrigo', 'emilio', 'tomas', 'julio', 'oscar',
    'ruben', 'alfonso', 'armando', 'bruno', 'cesar', 'esteban', 'felipe', 'gabriel', 'hector', 'ignacio',
    'joaquin', 'leonardo', 'lorenzo', 'mauricio', 'nicolas', 'ramon', 'sabino', 'salvador', 'victor'];
  var COMMENTARY_FEMALE_NAMES = ['sabina', 'paulina', 'monica', 'marisol', 'esperanza', 'salome',
    'helena', 'laura', 'lupe', 'penelope', 'camila', 'sofia', 'isabela', 'ximena', 'valentina',
    'renata', 'dalia', 'elena', 'lucia', 'carmen', 'beatriz', 'clara', 'estrella', 'irene', 'nuria',
    'pilar', 'rocio', 'triana', 'vera', 'yolanda', 'zira', 'linda', 'heather', 'samantha', 'victoria',
    'karen', 'moira', 'tessa', 'fiona', 'milena', 'daria', 'katya', 'alva', 'klara', 'sara', 'hanna',
    'maria', 'ana', 'andrea', 'angelica', 'carla', 'cecilia', 'daniela', 'fabiola', 'gabriela', 'ines',
    'jimena', 'lorena', 'magdalena', 'nadia', 'olga', 'patricia', 'regina', 'silvia', 'teresa',
    'veronica', 'mexicana', 'femenina', 'mujer'];
  function normalizeVoiceWord(word) {
    var text = String(word || '');
    if (text.normalize) text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return text.toLowerCase();
  }
  // 'm' masculina, 'f' femenina, '' desconocida (nombre neutro o genérico).
  function commentaryVoiceGender(voice) {
    var words = normalizeVoiceWord(voice && voice.name).split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some(function (w) { return COMMENTARY_MALE_NAMES.indexOf(w) >= 0; })) return 'm';
    if (words.some(function (w) { return COMMENTARY_FEMALE_NAMES.indexOf(w) >= 0; })) return 'f';
    return '';
  }
  // Orden: masculina > desconocida > femenina; a igualdad, es-MX antes que otro
  // español, y el orden del navegador como último desempate.
  function rankCommentaryVoices(list) {
    return list.map(function (voice, index) {
      var gender = commentaryVoiceGender(voice);
      var genderRank = gender === 'm' ? 0 : (gender === 'f' ? 2 : 1);
      var mexican = /^es[-_]MX$/i.test(voice.lang || '') ? 0 : 1;
      return { voice: voice, index: index, key: genderRank * 2 + mexican };
    }).sort(function (a, b) { return a.key - b.key || a.index - b.index; }).map(function (entry) { return entry.voice; });
  }
  function refreshCommentaryVoices() {
    var api = window.speechSynthesis;
    if (!api || typeof api.getVoices !== 'function') return;
    var voices = [];
    try { voices = api.getVoices() || []; } catch (_) {}
    var spanish = voices.filter(function (voice) { return /^es(?:[-_]|$)/i.test(voice.lang || ''); });
    if (!spanish.length) { commentarySpeech.voices.narrador = null; commentarySpeech.voices.analista = null; return; }
    var ranked = rankCommentaryVoices(spanish);
    var first = ranked[0] || null;
    commentarySpeech.voices.narrador = first;
    commentarySpeech.voices.analista = ranked.filter(function (voice) { return voice !== first; })[0] || first;
  }
  // Tono: una voz masculina se usa tal cual; si la voz es femenina o no se puede
  // identificar, se baja el tono para acercarla a la mesa masculina.
  function commentaryVoicePitch(role, voice) {
    var masculine = commentaryVoiceGender(voice) === 'm';
    if (masculine) return role === 'narrador' ? 1 : .94;
    return role === 'narrador' ? .88 : .8;
  }
  function updateCommentaryVoiceButton() {
    var button = el['est-commentary-voice'];
    if (!button) return;
    var label = button.querySelector('.est-commentary-voice-label');
    var icon = button.querySelector('.est-commentary-voice-icon');
    var supported = commentarySpeechSupported();
    button.disabled = !supported;
    button.setAttribute('aria-pressed', String(Boolean(S.commentaryVoiceOn)));
    button.setAttribute('aria-label', supported
      ? (S.commentaryVoiceOn ? 'Silenciar voces del relato' : 'Activar voces del relato')
      : 'Voces no disponibles en este navegador');
    button.title = supported
      ? (S.commentaryVoiceOn ? 'Silenciar la narración hablada' : 'Activar narración hablada en español')
      : 'Este navegador no ofrece síntesis de voz.';
    if (label) label.textContent = supported ? (S.commentaryVoiceOn ? 'Silenciar voces' : 'Activar voces') : 'Voz no disponible';
    if (icon) icon.textContent = S.commentaryVoiceOn ? '◖' : '◗';
  }
  function setupCommentarySpeech() {
    updateCommentaryVoiceButton();
    var api = window.speechSynthesis;
    if (!api || commentarySpeech.listenersBound) return;
    commentarySpeech.listenersBound = true;
    refreshCommentaryVoices();
    if (typeof api.addEventListener === 'function') api.addEventListener('voiceschanged', refreshCommentaryVoices);
    else api.onvoiceschanged = refreshCommentaryVoices;
  }
  function updateCommentaryMuteStyles() {
    if (!el['est-commentary']) return;
    Array.prototype.forEach.call(el['est-commentary'].querySelectorAll('.est-cmt'), function (node) {
      node.classList.toggle('muted-all', S.muted);
    });
  }
  function cancelCommentarySpeech() {
    commentarySpeech.token++;
    commentarySpeech.queue.length = 0;
    if (commentarySpeech.timer) clearTimeout(commentarySpeech.timer);
    commentarySpeech.timer = null;
    commentarySpeech.lastVoice = null;
    if (commentarySpeech.activeCard) commentarySpeech.activeCard.classList.remove('is-speaking');
    commentarySpeech.active = null;
    commentarySpeech.activeCard = null;
    setCommentaryMusicDuck(false);
    var api = window.speechSynthesis;
    if (api && typeof api.cancel === 'function') {
      try { api.cancel(); } catch (_) {}
    }
  }
  function setCommentaryVoiceEnabled(enabled, notify) {
    if (enabled && !commentarySpeechSupported()) {
      updateCommentaryVoiceButton();
      if (notify !== false) toast('La narración por voz no está disponible en este navegador.', '');
      return false;
    }
    S.commentaryVoiceOn = Boolean(enabled);
    S.muted = !S.commentaryVoiceOn;
    updateCommentaryMuteStyles();
    updateCommentaryVoiceButton();
    if (S.commentaryVoiceOn) {
      refreshCommentaryVoices();
      try { window.speechSynthesis.resume(); } catch (_) {}
      if (notify !== false) toast('Voces activadas. Narrador y analista hablarán por turnos.', '');
    } else {
      cancelCommentarySpeech();
      if (notify !== false) toast('Voces silenciadas.', '');
    }
    return true;
  }
  function queueCommentarySpeech(message, card) {
    if (!S.commentaryVoiceOn || S.muted || !commentarySpeechSupported()) return;
    var text = String(message && message.text || '').trim();
    if (!text) return;
    var item = {
      matchId: S.currentMatchId,
      voice: message.voice === 'analista' ? 'analista' : 'narrador',
      text: text,
      card: card || null
    };
    if (commentarySpeech.queue.length >= COMMENTARY_SPEECH_QUEUE_LIMIT) {
      var analystIndex = commentarySpeech.queue.findIndex(function (queued) { return queued.voice === 'analista'; });
      commentarySpeech.queue.splice(analystIndex >= 0 ? analystIndex : 0, 1);
    }
    commentarySpeech.queue.push(item);
    runNextCommentaryTurn();
  }
  function runNextCommentaryTurn() {
    var api = window.speechSynthesis;
    if (!S.commentaryVoiceOn || S.muted || !commentarySpeechSupported() || commentarySpeech.active || commentarySpeech.timer) return;
    while (commentarySpeech.queue.length && commentarySpeech.queue[0].matchId !== S.currentMatchId) commentarySpeech.queue.shift();
    if (!commentarySpeech.queue.length) return;
    var item = commentarySpeech.queue.shift();
    var voice = commentarySpeech.voices[item.voice];
    var utterance;
    try { utterance = new window.SpeechSynthesisUtterance(item.text); }
    catch (_) { return; }
    utterance.lang = voice && voice.lang || 'es-MX';
    utterance.rate = item.voice === 'narrador' ? 1.03 : .97;
    utterance.pitch = commentaryVoicePitch(item.voice, voice);
    utterance.volume = 1;
    if (voice) utterance.voice = voice;
    var token = ++commentarySpeech.token;
    var previousVoice = commentarySpeech.lastVoice;
    var settled = false;
    commentarySpeech.active = utterance;
    commentarySpeech.activeCard = item.card;
    if (item.card && item.card.isConnected) item.card.classList.add('is-speaking');
    setCommentaryMusicDuck(true);
    function finishTurn() {
      if (settled) return;
      settled = true;
      if (token !== commentarySpeech.token) return;
      if (commentarySpeech.activeCard) commentarySpeech.activeCard.classList.remove('is-speaking');
      commentarySpeech.active = null;
      commentarySpeech.activeCard = null;
      commentarySpeech.lastVoice = item.voice;
      setCommentaryMusicDuck(false);
      var pause = previousVoice && previousVoice !== item.voice ? 380 : 170;
      commentarySpeech.timer = setTimeout(function () {
        commentarySpeech.timer = null;
        runNextCommentaryTurn();
      }, pause);
    }
    utterance.onend = finishTurn;
    utterance.onerror = function (event) {
      if (token !== commentarySpeech.token) return;
      if (event && event.error === 'not-allowed') {
        S.commentaryVoiceOn = false;
        S.muted = false;
        cancelCommentarySpeech();
        updateCommentaryMuteStyles();
        updateCommentaryVoiceButton();
        toast('El navegador bloqueó la voz. Pulsa «Activar voces» para intentarlo otra vez.', '');
        return;
      }
      finishTurn();
    };
    try { api.speak(utterance); }
    catch (_) { finishTurn(); }
  }

  // ===== Relato =====
  function renderCommentary(list) {
    var box = el['est-commentary']; box.innerHTML = '';
    if (!list || !list.length) { box.innerHTML = '<p class="est-commentary-empty">El relato aparecerá aquí cuando comience el partido.</p>'; return; }
    list.forEach(function (m) { appendCommentary(m, true); });
    var latest = box.lastElementChild;
    if (latest && latest.classList.contains('est-cmt')) latest.classList.add('is-latest');
    box.scrollTop = box.scrollHeight;
  }
  function appendCommentary(m, silentScroll) {
    var box = el['est-commentary'];
    var empty = box.querySelector('.est-commentary-empty'); if (empty) empty.remove();
    if (!silentScroll) {
      var previousLatest = box.querySelector('.est-cmt.is-latest');
      if (previousLatest) previousLatest.classList.remove('is-latest');
    }
    var voice = m.voice === 'analista' ? 'analista' : 'narrador';
    var voiceLabel = voice === 'narrador' ? 'NARRADOR' : 'ANALISTA';
    var voiceMark = voice === 'narrador' ? 'N' : 'A';
    var div = document.createElement('div');
    div.className = 'est-cmt ' + voice + (S.muted ? ' muted-all' : '') + (silentScroll ? '' : ' is-latest is-entering');
    div.innerHTML = '<span class="est-cmt-speaker"><span class="est-cmt-mark" aria-hidden="true">' + voiceMark + '</span><span class="est-cmt-voice">' + voiceLabel + '</span></span><span class="est-cmt-text">' + esc(m.text) + '</span>';
    box.appendChild(div);
    while (box.children.length > 40) box.removeChild(box.firstChild);
    if (!silentScroll) box.scrollTop = box.scrollHeight;
    return div;
  }
  function appendLiveCommentary(data) {
    var message = { voice: data.voice, text: data.text };
    var card = appendCommentary(message);
    queueCommentarySpeech(message, card);
  }
  function onCommentary(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    var delay = (!reduced.matches && S.goalAnimUntil && S.goalAnimUntil > performance.now())
      ? Math.max(0, S.goalAnimUntil - performance.now())
      : 0;
    if (delay > 0) {
      setTimeout(function () {
        if (data.matchId !== S.currentMatchId) return;
        appendLiveCommentary(data);
      }, delay);
    } else {
      appendLiveCommentary(data);
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
    // Agregado del árbitro: el mismo dato que dicen los comentaristas se refleja
    // en el reloj («45+4'»). Al cambiar de mitad o al final se limpia.
    if (ev.type === 'stoppage_start' && ev.added != null && Number(ev.added) > 0) {
      S.stoppage = { half: ev.half === 2 ? 2 : 1, added: Number(ev.added) };
      renderScoreboard();
    } else if (ev.type === 'halftime' || ev.type === 'second_half' || ev.type === 'full_time') {
      if (S.stoppage) { S.stoppage = null; renderScoreboard(); }
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
      // El evento genérico ya pinta el cartel: football:goal (que llega en el
      // mismo tick) solo lo repite si este cliente se perdió el evento.
      S.goalCueAt = performance.now();
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

  // Cartel de gol de respaldo: el servidor emite football:goal justo después de
  // football:event, así que solo se usa cuando el evento genérico no llegó
  // (catch-up perdido o reconexión). Evita cartel y sonido duplicados.
  function onGoalCue(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    if (performance.now() - S.goalCueAt < 2000) return;
    S.goalCueAt = performance.now();
    S.goalFlashUntil = S.goalCueAt + 1400;
    S.goalAnimUntil = reduced.matches ? 0 : S.goalCueAt + 700;
    showGoalBanner();
    playSfx('goal');
  }

  // ===== Grada: reacciones y charla del partido =====
  // El servidor difunde football:reaction y football:chat a la sala del partido
  // (lib/football/sockets.js). Aquí se pintan y se envían; todo texto ajeno se
  // inserta con textContent para que nunca se interprete como HTML.
  var CROWD_MAX_LINES = 40;
  var CROWD_COOLDOWN_MS = 1500;
  var crowdHintShown = '';
  function crowdHint() {
    return S.socket && S.socket.connected
      ? 'Elige un partido para participar en la grada.'
      : 'Sin conexión con el partido.';
  }

  function setCrowdMessage(text, state) {
    var node = el['est-crowd-message'];
    if (!node) return;
    node.textContent = text || '';
    node.className = 'est-crowd-message' + (state ? ' is-' + state : '');
  }

  function resetCrowdFeed() {
    var feed = el['est-crowd-feed'];
    if (!feed) return;
    feed.innerHTML = '';
    var empty = document.createElement('li');
    empty.className = 'est-crowd-empty';
    empty.textContent = 'Sin mensajes todavía. Aquí aparece lo que comparten los aficionados del partido.';
    feed.appendChild(empty);
  }

  function pushCrowdLine(kind, who, what) {
    var feed = el['est-crowd-feed'];
    if (!feed) return;
    var placeholder = feed.querySelector('.est-crowd-empty');
    if (placeholder && placeholder.parentNode === feed) feed.removeChild(placeholder);
    var line = document.createElement('li');
    line.className = 'est-crowd-line' + (kind === 'reaction' ? ' is-react' : '');
    var tag = document.createElement('span');
    tag.className = 'est-crowd-who';
    tag.textContent = String(who || '').slice(0, 40);
    var body = document.createElement('span');
    body.className = 'est-crowd-what';
    body.textContent = String(what || '').slice(0, 240);
    line.appendChild(tag);
    line.appendChild(body);
    feed.appendChild(line);
    while (feed.children.length > CROWD_MAX_LINES) feed.removeChild(feed.firstElementChild);
    feed.scrollTop = feed.scrollHeight;
  }

  // Solo se participa con identidad resuelta: el servidor exige suscripción con
  // token y TOS para aceptar football:chat / football:reaction.
  function crowdReady() {
    return Boolean(S.socket && S.socket.connected && S.currentMatchId);
  }

  function updateCrowdAvailability() {
    var ready = crowdReady();
    if (el['est-crowd-input']) {
      el['est-crowd-input'].disabled = !ready;
      el['est-crowd-input'].placeholder = ready ? 'Escribe algo para el partido…' : 'Elige un partido para participar';
    }
    if (el['est-crowd-send']) el['est-crowd-send'].disabled = !ready;
    var box = el['est-crowd-reactions'];
    var buttons = box ? box.querySelectorAll('[data-crowd-reaction]') : [];
    Array.prototype.forEach.call(buttons, function (button) { button.disabled = !ready; });
    var message = el['est-crowd-message'];
    if (!message) return;
    if (!ready) {
      crowdHintShown = crowdHint();
      setCrowdMessage(crowdHintShown, 'error');
    } else if (crowdHintShown && message.textContent === crowdHintShown) {
      crowdHintShown = '';
      setCrowdMessage('', '');
    }
  }

  function sendCrowdReaction(emoji) {
    if (!crowdReady()) { setCrowdMessage('Elige un partido para participar.', 'error'); return; }
    if (!emoji) return;
    try { S.socket.emit('football:reaction', { matchId: S.currentMatchId, emoji: String(emoji).slice(0, 8) }); }
    catch (_) { setCrowdMessage('No se pudo enviar la reacción.', 'error'); }
  }

  function sendCrowdChat(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!crowdReady()) { setCrowdMessage('Elige un partido para participar.', 'error'); return; }
    var input = el['est-crowd-input'];
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { setCrowdMessage('Escribe un mensaje antes de enviarlo.', 'error'); return; }
    var now = Date.now();
    if (now - S.crowdLastSentAt < CROWD_COOLDOWN_MS) {
      setCrowdMessage('Espera un momento antes de enviar otro mensaje.', 'error');
      return;
    }
    S.crowdLastSentAt = now;
    if (el['est-crowd-send']) el['est-crowd-send'].disabled = true;
    setCrowdMessage('Enviando…', '');
    try {
      S.socket.emit('football:chat', { matchId: S.currentMatchId, text: text.slice(0, 120) }, function (res) {
        updateCrowdAvailability();
        if (input) input.disabled = !crowdReady();
        if (!res || !res.ok) {
          setCrowdMessage(res && res.code === 'empty'
            ? 'El mensaje quedó vacío.'
            : 'No se pudo enviar el mensaje. Inicia sesión en el Estadio para charlar.', 'error');
          return;
        }
        if (input) input.value = '';
        setCrowdMessage('', '');
        if (input) input.focus();
      });
    } catch (_) {
      updateCrowdAvailability();
      setCrowdMessage('No se pudo enviar el mensaje.', 'error');
    }
  }

  function onCrowdChat(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    var who = data.name || 'Aficionado';
    var mine = Boolean(S.profile && data.name && data.name === S.profile.name);
    pushCrowdLine('chat', mine ? 'Tú' : who, data.text);
    // El mismo mensaje cruza el campo como comentario bala (§ producto).
    pushDanmaku(mine ? 'Tú' : who, data.text, { soft: Boolean(data.soft) });
    if (mine && el['est-crowd-message'] && el['est-crowd-message'].textContent === 'Enviando…') setCrowdMessage('', '');
  }

  function onCrowdReaction(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    pushCrowdLine('reaction', data.from || 'Aficionado', data.emoji);
  }

  // ===== Comentarios bala sobre la cancha =====
  // Cada mensaje de la grada cruza el campo una vez y se va. Cada comentario
  // trae SU propio botón ✕: se quita ese comentario, no todos (no hay
  // interruptor global). El contenido se inserta con textContent.
  var DANMAKU_MAX = 6;
  var danmakuSeq = 0;
  function removeDanmaku(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }
  function pushDanmaku(who, text, opts) {
    var layer = el['est-danmaku'];
    if (!layer) return;
    var item = document.createElement('div');
    item.className = 'est-danmaku-item' + (opts && opts.soft ? ' is-soft' : '');
    item.style.top = (6 + ((danmakuSeq++ * 17) % 58)) + '%';
    var body = document.createElement('span');
    body.className = 'est-danmaku-text';
    body.textContent = String(who || 'Aficionado').slice(0, 40) + ': ' + String(text || '').slice(0, 120);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'est-danmaku-close';
    close.textContent = '×';
    close.title = 'Quitar este comentario del campo';
    close.setAttribute('aria-label', 'Quitar este comentario del campo');
    close.addEventListener('click', function () { removeDanmaku(item); });
    item.appendChild(body);
    item.appendChild(close);
    layer.appendChild(item);
    while (layer.children.length > DANMAKU_MAX) removeDanmaku(layer.firstElementChild);
    if (typeof item.addEventListener === 'function') {
      item.addEventListener('animationend', function () { removeDanmaku(item); });
    }
    // Red de seguridad: si la animación no dispara (pestaña en segundo plano),
    // el comentario no se queda pegado a la cancha para siempre.
    setTimeout(function () { removeDanmaku(item); }, 16000);
  }

  // ===== Votación de la grada (moderación opt-in) =====
  function standsLive() {
    return Boolean(S.currentMatchId && S.match
      && ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0);
  }
  function renderStands(state) {
    var box = el['est-stands-vote'];
    if (!box) return;
    S.stands = state || null;
    var st = state || {};
    box.hidden = !S.currentMatchId;
    if (box.hidden) return;
    var status = el['est-stands-status'];
    var tally = el['est-stands-tally'];
    var openBtn = el['est-stands-open'];
    var yes = el['est-stands-yes'];
    var no = el['est-stands-no'];
    var votes = st.votes || { yes: 0, no: 0, total: 0 };
    var quorum = Number(st.quorum || 3);
    var isOpen = st.status === 'open';
    var voted = st.yourVote != null;
    if (status) {
      if (st.allowsInsults) {
        status.textContent = 'Grada picante: la mayoría aceptó y en este partido se puede insultar sin censura.';
        status.className = 'est-stands-status is-allowed';
      } else if (isOpen) {
        var missing = Math.max(0, quorum - Number(votes.yes || 0));
        status.textContent = 'Votación en curso para permitir insultos en la grada.'
          + (missing ? ' Faltan ' + missing + ' voto(s) a favor.' : '');
        status.className = 'est-stands-status is-open';
      } else if (st.status === 'rejected') {
        status.textContent = 'La grada decidió mantener la censura en este partido.';
        status.className = 'est-stands-status is-rejected';
      } else {
        status.textContent = 'La grada está censurada. Si la mayoría acepta, este partido permite insultos.';
        status.className = 'est-stands-status';
      }
    }
    if (openBtn) {
      openBtn.hidden = Boolean(st.allowsInsults);
      openBtn.textContent = isOpen ? 'Votación en curso…' : 'Pedir votación';
      openBtn.disabled = isOpen || !standsLive();
      openBtn.title = standsLive() ? 'Abre una votación para permitir insultos en este partido' : 'La votación se abre con el partido en juego';
    }
    if (yes) { yes.hidden = !isOpen || voted; yes.disabled = !isOpen || voted; }
    if (no) { no.hidden = !isOpen || voted; no.disabled = !isOpen || voted; }
    if (tally) {
      tally.textContent = votes.total
        ? 'A favor ' + Number(votes.yes || 0) + ' · En contra ' + Number(votes.no || 0) + ' · Quórum ' + quorum
        : 'Quórum: ' + quorum + ' votos a favor para habilitar los insultos.';
    }
  }
  function onStandsState(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    renderStands(data.stands || null);
  }
  function emitStands(event, allow) {
    if (!crowdReady()) { setCrowdMessage('Elige un partido para participar.', 'error'); return; }
    try {
      S.socket.emit(event, { matchId: S.currentMatchId, allow: allow !== false }, function (res) {
        if (!res || !res.ok) {
          var code = res && res.code;
          setCrowdMessage(code === 'not_live'
            ? 'La votación de la grada se abre con el partido en juego.'
            : code === 'ya_votaste' ? 'Ya votaste en esta votación.'
            : code === 'espera_para_repetir' ? 'Espera un momento antes de repetir la votación.'
            : 'No se pudo registrar el voto.', 'error');
          if (res && res.stands) renderStands(res.stands);
          return;
        }
        if (res.stands) renderStands(res.stands);
        setCrowdMessage('', '');
      });
    } catch (_) { setCrowdMessage('No se pudo registrar el voto.', 'error'); }
  }
  function openStandsVote() { emitStands('football:stands_open', true); }
  function castStandsVote(allow) { emitStands('football:stands_vote', allow); }

  function bindCrowdControls() {
    var form = el['est-crowd-form'];
    if (form) form.addEventListener('submit', sendCrowdChat);
    var box = el['est-crowd-reactions'];
    if (box) {
      box.addEventListener('click', function (event) {
        var target = event.target;
        var button = target && typeof target.closest === 'function' ? target.closest('[data-crowd-reaction]') : null;
        if (!button) return;
        sendCrowdReaction(button.getAttribute('data-crowd-reaction'));
      });
    }
    var standsBox = el['est-stands-vote'];
    if (standsBox) {
      standsBox.addEventListener('click', function (event) {
        var target = event.target;
        var button = target && typeof target.closest === 'function' ? target.closest('button') : null;
        if (!button) return;
        if (button.id === 'est-stands-open') return openStandsVote();
        var vote = button.getAttribute('data-stands-vote');
        if (vote) castStandsVote(vote === 'si');
      });
    }
    renderStands(S.stands);
    resetCrowdFeed();
    updateCrowdAvailability();
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
      if (data.result) { S.match.result = data.result; S.score = {home:Number(data.result.home) || 0, away:Number(data.result.away) || 0}; }
      renderHighlights(data.highlights || null);
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
    'team_total_away_0.5': 'Goles visita 0.5', 'team_total_away_1.5': 'Goles visita 1.5',
    'ht_ft': 'Descanso / final', 'first_scorer': 'Primer goleador'
  };
  // Hándicap asiático: la línea vive en la clave del mercado («minus0.75» → −0,75)
  // porque la escalera se calcula por partido. Cuarto de línea = empuje parcial.
  function asianLineLabel(market) {
    var m = /^asian_handicap_home_(minus|plus)(\d+(?:\.\d+)?)$/.exec(String(market || ''));
    if (!m) return null;
    var line = (m[1] === 'minus' ? '−' : '+') + String(m[2]).replace('.', ',');
    var devuelve = /\.[257]5$/.test(m[2]) || m[2].indexOf('.25') >= 0 || m[2].indexOf('.75') >= 0;
    return 'Hándicap asiático ' + line + (devuelve ? ' (empuje)' : '');
  }
  function selLabel(market, key, selection) {
    // El servidor manda el nombre cuando el mercado no se puede leer de la clave
    // (primer goleador: la selección es el id del jugador).
    if (selection && selection.label) return selection.label;
    var map = { home: 'Local', draw: 'Empate', away: 'Visita', over: 'Más', under: 'Menos', yes: 'Sí', no: 'No', other: 'Otro jugador' };
    if (key === 'none') return 'Sin goles (0-0)';
    if (market === 'asian_handicap_home' || market.indexOf('asian_handicap_home_') === 0) {
      return ({ home: 'Local', away: 'Visita' })[key] || map[key] || key;
    }
    if (map[key]) return map[key];
    if (market === 'double_chance') return ({ home_draw: 'Local o Empate', home_away: 'Local o Visita', draw_away: 'Empate o Visita' })[key] || key;
    if (market === 'ht_ft') {
      var names = { home: 'Local', draw: 'Empate', away: 'Visita' };
      var parts = String(key).split('_');
      return (names[parts[0]] || parts[0]) + ' / ' + (names[parts[1]] || parts[1]);
    }
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
      var head = document.createElement('div'); head.className = 'est-market-name'; head.textContent = MARKET_LABEL[mk] || asianLineLabel(mk) || mk; group.appendChild(head);
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
        btn.innerHTML = '<span class="est-sel-key">' + esc(selLabel(mk, s.key, s)) + '</span>' +
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
  var BET_RANKING_AVATARS = { fox: '🦊', tiger: '🐯', panda: '🐼', owl: '🦉', alien: '👽', robot: '🤖', crown: '👑', diamond: '💎' };

  function setBetRankingSubscription(active) {
    S.betRankingSubscribed = Boolean(active);
    if (!S.socket || !S.socket.connected) return;
    S.socket.emit(active ? 'bet_ranking_get' : 'bet_ranking_unsubscribe');
  }

  function setLedgerView(view) {
    S.ledgerView = view === 'ranking' ? 'ranking' : 'history';
    var ranking = S.ledgerView === 'ranking';
    if (el['est-ledger-history-view']) el['est-ledger-history-view'].hidden = ranking;
    if (el['est-ledger-ranking-view']) el['est-ledger-ranking-view'].hidden = !ranking;
    if (el['est-ledger-tab-history']) el['est-ledger-tab-history'].setAttribute('aria-pressed', String(!ranking));
    if (el['est-ledger-tab-ranking']) el['est-ledger-tab-ranking'].setAttribute('aria-pressed', String(ranking));
    if (el['est-ledger-title']) el['est-ledger-title'].textContent = ranking ? 'Ranking global de apuestas' : 'Historial de apuestas y pagos';
    if (el['est-ledger-sub']) el['est-ledger-sub'].textContent = ranking
      ? 'Tu espacio personal en vivo: volumen acumulado del Casino y el Estadio, medido en fichas virtuales.'
      : 'Todas tus apuestas del Estadio, cómo terminó cada partido y lo que se acreditó a tu saldo.';
    setBetRankingSubscription(ranking);
    if (ranking) renderBetRanking();
  }

  function renderBetRanking() {
    var list = el['est-bet-ranking-list'];
    var personal = el['est-bet-ranking-personal'];
    if (!list || !personal) return;
    var snapshot = S.betRanking;
    var source = ['total', 'casino', 'stadium'].indexOf(S.betRankingSource) >= 0 ? S.betRankingSource : 'total';
    var labels = { total: 'Total', casino: 'Casino', stadium: 'Estadio' };
    var fields = {
      total: { rank: 'totalRank', amount: 'totalWagered' },
      casino: { rank: 'casinoRank', amount: 'casinoWagered' },
      stadium: { rank: 'stadiumRank', amount: 'stadiumWagered' }
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-bet-ranking-source]'), function (button) {
      var selected = button.getAttribute('data-bet-ranking-source') === source;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    var connected = Boolean(S.socket && S.socket.connected);
    if (el['est-bet-ranking-live']) {
      el['est-bet-ranking-live'].textContent = connected ? '● EN VIVO' : '○ Reconectando…';
      el['est-bet-ranking-live'].classList.toggle('disconnected', !connected);
    }
    if (!snapshot) {
      personal.innerHTML = '<div class="est-bet-ranking-empty">' + (connected ? 'Conectando con el ranking…' : 'Sin conexión. Se actualizará al reconectar.') + '</div>';
      list.innerHTML = '<div class="est-bet-ranking-empty">' + (connected ? 'Solicitando la clasificación combinada…' : 'El ranking requiere conexión.') + '</div>';
      return;
    }
    var me = snapshot.me;
    var metric = fields[source];
    if (me) {
      var rank = me[metric.rank];
      var sourceParticipants = snapshot.participantsBySource && snapshot.participantsBySource[source] != null
        ? snapshot.participantsBySource[source] : (snapshot.participants || 0);
      var stadiumDecisions = Number(me.stadiumDecisions) || 0;
      var stadiumWins = Number(me.stadiumWins) || 0;
      var stadiumLosses = Number(me.stadiumLosses) || 0;
      var stadiumHitRate = me.stadiumHitRate == null ? '—' : fmt(me.stadiumHitRate) + '%';
      var stadiumNet = Math.trunc(Number(me.stadiumNet) || 0);
      var stadiumNetLabel = (stadiumNet > 0 ? '+' : stadiumNet < 0 ? '−' : '') + '◆ ' + fmt(Math.abs(stadiumNet));
      var stadiumNetTone = stadiumNet > 0 ? 'positive' : stadiumNet < 0 ? 'negative' : 'neutral';
      personal.innerHTML = '<div class="est-bet-ranking-me-place"><small>TU PUESTO · ' + labels[source].toUpperCase() + '</small><b>' + (rank ? '#' + fmt(rank) : '—') + '</b><span>' + (rank ? 'de ' + fmt(sourceParticipants) + ' jugadores' : 'Aún sin apuestas en este ranking') + '</span></div>' +
        '<div class="est-bet-ranking-me-total"><small>VOLUMEN ACUMULADO</small><b>◆ ' + fmt(me.totalWagered) + '</b><span>Casino + Estadio</span></div>' +
        '<div class="est-bet-ranking-me-source"><small>CASINO</small><b>◆ ' + fmt(me.casinoWagered) + '</b><span>Fichas apostadas</span></div>' +
        '<div class="est-bet-ranking-me-source"><small>ESTADIO</small><b>◆ ' + fmt(me.stadiumWagered) + '</b><span>' + fmt(me.stadiumBets || 0) + ' apuestas</span></div>' +
        '<div class="est-bet-ranking-me-source est-bet-ranking-me-performance"><small>ACIERTOS · ESTADIO</small><b>' + stadiumHitRate + '</b><span>' + (stadiumDecisions ? fmt(stadiumWins) + ' ganadas · ' + fmt(stadiumLosses) + ' perdidas' : 'Sin resultados definitivos') + '</span></div>' +
        '<div class="est-bet-ranking-me-source est-bet-ranking-me-performance"><small>NETO · ESTADIO</small><b class="est-bet-ranking-net ' + stadiumNetTone + '">' + stadiumNetLabel + '</b><span>Balance de ' + fmt(me.stadiumSettledBets || 0) + ' apuestas liquidadas</span></div>';
    } else {
      personal.innerHTML = '<div class="est-bet-ranking-empty">No pudimos asociar esta conexión con un perfil del ranking.</div>';
    }
    if (el['est-bet-ranking-updated']) {
      var time = snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
      el['est-bet-ranking-updated'].textContent = fmt(snapshot.totalWagered || 0) + ' fichas apostadas en ' + fmt(snapshot.participants || 0) + ' jugadores' + (time ? ' · actualizado ' + time : '') + '. Fichas 100% virtuales.';
    }
    var entries = snapshot.ranking[source] || [];
    if (!entries.length) {
      list.innerHTML = '<div class="est-bet-ranking-empty">Todavía no hay apuestas registradas en ' + labels[source] + '.</div>';
      return;
    }
    var medals = ['🥇', '🥈', '🥉'];
    list.innerHTML = entries.map(function (entry) {
      var own = Boolean(me && me.name === entry.name);
      return '<div class="est-bet-ranking-row ' + (entry.place === 1 ? 'leader ' : '') + (own ? 'self' : '') + '" role="row">' +
        '<span class="est-bet-ranking-place" role="cell">' + (medals[entry.place - 1] || '#' + fmt(entry.place)) + '</span>' +
        '<span class="est-bet-ranking-player" role="cell"><i>' + (BET_RANKING_AVATARS[entry.avatar] || '🦊') + '</i><b>' + esc(entry.name) + '</b></span>' +
        '<span class="est-bet-ranking-value primary" role="cell">◆ ' + fmt(entry.totalWagered) + '</span>' +
        '<span class="est-bet-ranking-value" role="cell">◆ ' + fmt(entry.casinoWagered) + '</span>' +
        '<span class="est-bet-ranking-value" role="cell">◆ ' + fmt(entry.stadiumWagered) + '</span>' +
        '</div>';
    }).join('');
  }

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
    setLedgerView('history');
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
    setBetRankingSubscription(false);
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
          renderBallonDorMarket();
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
        renderBallonDorMarket();
        return data.history;
      })
      .catch(function () {
        if (seq !== S.betsRequestSeq) return null;
        S.betsLoading = false;
        S.betsError = 'load';
        if (ledgerOpen()) renderLedger();
        renderBallonDorMarket();
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
  function matchupMarkup(match) {
    if (!match) return '';
    return clubCrestMarkup(match.homeId, 'est-ledger-crest') + '<span class="est-ledger-team">' + esc(teamFull(match.homeId)) + '</span> vs ' + clubCrestMarkup(match.awayId, 'est-ledger-crest') + '<span class="est-ledger-team">' + esc(teamFull(match.awayId)) + '</span>';
  }
  function entryScoreLine(entry) {
    var m = entry && entry.match;
    if (!m || !m.result) return '';
    return clubCrestMarkup(m.homeId, 'est-ledger-crest') +
      '<span class="est-ledger-team">' + esc(teamFull(m.homeId)) + '</span>' +
      '<b class="est-ledger-score">' + Number(m.result.home) + '–' + Number(m.result.away) + '</b>' +
      '<span class="est-ledger-team">' + esc(teamFull(m.awayId)) + '</span>' +
      clubCrestMarkup(m.awayId, 'est-ledger-crest');
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
    var won = Number(byStatus.won || 0), lost = Number(byStatus.lost || 0);
    var settled = won + lost + Number(byStatus.void || 0) + Number(byStatus.cashed || 0);
    var hits = won + Number(byStatus.cashed || 0);
    var decisions = won + lost;
    var hitRate = decisions ? Math.round(won / decisions * 100) : null;
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
      card('Neto', (net > 0 ? '+' : net < 0 ? '−' : '') + fmt(Math.abs(net)), decisions ? hitRate + ' % de acierto' : 'sin decisiones definitivas', net > 0 ? 'up' : net < 0 ? 'down' : '') +
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
      onlyMatch.innerHTML = current ? 'Solo ' + matchupMarkup(S.match) : 'Solo este partido';
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

  // Datos de la apuesta en fichas independientes: una fila de etiqueta + valor se
  // lee de un vistazo, mientras que un párrafo con separadores «·» obliga a
  // descifrarlo.
  function entryFacts(entry) {
    var facts = [{ label: 'Monto', value: fmt(entry.stake) + ' fichas' }];
    facts.push({ label: entry.kind === 'parlay' ? 'Cuota total' : 'Cuota', value: Number(entry.odds || 1).toFixed(2) });
    if (entry.inPlay && entry.minuteAtPlacement != null) {
      facts.push({ label: 'En vivo', value: entry.minuteAtPlacement + "'" });
    }
    if (entry.kind === 'future' && entry.seasonMonth) {
      facts.push({ label: 'Temporada', value: entry.seasonMonth });
    }
    if (entry._at) {
      facts.push({ label: entry.status === 'open' || entry.status === 'pending' ? 'Apostada' : 'Liquidada', value: whenLabel(entry._at) });
    }
    return facts;
  }

  function ledgerRow(entry) {
    var status = entry.status || 'open';
    var money = entryMoney(entry);
    var score = entryScoreLine(entry);
    var legs = '';
    if (entry.legs && entry.legs.length) {
      legs = '<ul class="est-ledger-legs">' + entry.legs.map(function (leg) {
        var legMatch = leg.match ? matchupMarkup(leg.match) : 'Partido';
        return '<li data-leg="' + esc(leg.status || '') + '">' +
          '<span class="est-ledger-leg-mark" aria-hidden="true">' + esc(betStatusGlyph(leg.status)) + '</span>' +
          '<span class="est-ledger-leg-copy"><b>' + esc(selLabel(leg.market, leg.selection)) + '</b>' +
          '<span class="est-ledger-leg-market">' + esc(MARKET_LABEL[leg.market] || leg.market) + '</span>' +
          '<small>' + legMatch + ' · ' + esc(betStatusLabel(leg.status)) + '</small></span>' +
          '<span class="est-ledger-leg-odds" title="Cuota">' + Number(leg.odds || 1).toFixed(2) + '</span>' +
          '</li>';
      }).join('') + '</ul>';
    }
    var facts = '<ul class="est-ledger-facts">' + entryFacts(entry).map(function (fact) {
      return '<li><span>' + esc(fact.label) + '</span><b>' + esc(fact.value) + '</b></li>';
    }).join('') + '</ul>';
    return '<article class="est-ledger-row" data-status="' + esc(status) + '" data-kind="' + esc(entry.kind || 'bet') + '">' +
      '<span class="est-ledger-glyph" aria-hidden="true">' + esc(betStatusGlyph(status)) + '</span>' +
      '<div class="est-ledger-row-main">' +
      '<div class="est-ledger-row-head">' +
      '<span class="est-ledger-pick">' + (entry.kind === 'future' && S.teams[entry.selection] ? clubCrestMarkup(entry.selection, 'est-inline-crest') : '') + esc(entryPickLabel(entry)) + '</span>' +
      '<span class="est-ledger-market">' + esc(entryMarketLabel(entry)) + '</span>' +
      '</div>' +
      '<p class="est-ledger-row-match">' +
      (score
        ? score + '<span class="est-ledger-jornada">J' + esc(entry.match.jornada) + '</span>'
        : (entry.match ? matchupMarkup(entry.match) : '<span class="est-ledger-team">' + esc(entryMatchLabel(entry)) + '</span>')) +
      '</p>' +
      facts +
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
    if (S.ballonDorReceipt && S.ballonDorReceipt.id === data.betId) {
      S.ballonDorReceipt.status = data.status;
      S.ballonDorReceipt.payout = Number(data.payout) || 0;
      S.ballonDorReceipt.settledAt = Date.now();
      S.ballonDorReceipt.reason = data.reason || null;
    }
    if (S.betHistory && Array.isArray(S.betHistory.entries)) {
      S.betHistory.entries.forEach(function (entry) {
        if (entry.kind === 'future' && entry.id === data.betId) {
          entry.status = data.status;
          entry.payout = Number(data.payout) || 0;
          entry.settledAt = Date.now();
        }
      });
    }
    S.myBets = S.myBets.filter(function (b) { return b.id !== data.betId; });
    renderMyBets();
    if (won) { S.chips += Number(data.payout || 0); toast('¡Apuesta ganada! +' + fmt(data.payout) + ' fichas.', 'win'); bell('win'); }
    else if (data.status === 'lost') { toast('Apuesta perdida' + (data.reason ? ': ' + data.reason : '') + '.', 'lose'); }
    else {
      if (data.status === 'void' && Number(data.payout) > 0) S.chips += Number(data.payout);
      toast('Apuesta ' + (data.status === 'void' ? 'anulada (reembolso)' : data.status) + '.', '');
    }
    updateChips();
    // El historial refresca el saldo autoritativo y muestra la liquidación BDO.
    loadBetHistory({ force: true });
    loadBallonDorMarket();
    renderBallonDorMarket();
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
    if ($('est-highlights-audio')) $('est-highlights-audio').addEventListener('click', function () {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) { toast('La narración no está disponible en este navegador.', 'info'); return; }
      var voices=window.speechSynthesis.getVoices(), voice=voices.find(function (v) { return /^es[-_]mx$/i.test(v.lang || ''); });
      if (!voice) { toast('No hay una voz de español de México disponible en este dispositivo.', 'info'); return; }
      cancelCommentarySpeech();
      var text=$('est-highlights-score').textContent + '. Goles y asistencias. ' + $('est-highlights-goals').textContent + '. Momentos destacados. ' + $('est-highlights-moments').textContent + '. ' + $('est-highlights-star').textContent;
      var utterance=new window.SpeechSynthesisUtterance(text); utterance.lang='es-MX'; utterance.voice=voice; window.speechSynthesis.speak(utterance);
    });
    if ($('est-hub')) {
      $('est-hub-open').addEventListener('click', function (event) { openHub(event.currentTarget); });
      $('est-hub-close').addEventListener('click', closeHub);
      $('est-hub').addEventListener('keydown', trapHubFocus);
      Array.prototype.forEach.call($('est-hub').querySelectorAll('[data-hub-view]'), function (button) {
        button.addEventListener('click', function () { var view = button.getAttribute('data-hub-view'); setHubView(view); if (view === 'aficion') refreshFan(); if (view === 'mercado') refreshTransfers(); if (view === 'quiniela') refreshQuiniela(); });
      });
    }
    if ($('est-fan-club')) {
      $('est-fan-club').addEventListener('change', function () { $('est-fan-choose').disabled = S.fanBusy || !this.value; $('est-fan-confirm').hidden = true; if (this.value) setClubLabel($('est-fan-selected-club'), this.value, teamName(this.value)); else $('est-fan-selected-club').textContent = ''; });
      $('est-fan-choose').addEventListener('click', function () {
        if (!S.fan || !this || !$('est-fan-club').value) return;
        var next = $('est-fan-club').value;
        if (S.fan.clubId && S.fan.clubId !== next) {
          $('est-fan-confirm-copy').innerHTML = 'Vas a dejar ' + clubCrestMarkup(S.fan.clubId, 'est-inline-crest') + esc(teamName(S.fan.clubId)) + ' para apoyar a ' + clubCrestMarkup(next, 'est-inline-crest') + esc(teamName(next)) + '.';
          $('est-fan-confirm').hidden = false; $('est-fan-confirm-yes').focus();
        } else selectFanClub(false);
      });
      $('est-fan-confirm-yes').addEventListener('click', function () { selectFanClub(true); });
      $('est-fan-confirm-no').addEventListener('click', function () { $('est-fan-confirm').hidden = true; $('est-fan-choose').focus(); });
      $('est-fan-opt').addEventListener('change', optFan);
    }
    if (el['est-fantasy-form']) {
      el['est-fantasy-form'].addEventListener('submit', saveFantasy);
      el['est-fantasy-players'].addEventListener('change', function (event) {
        if (event.target && event.target.dataset.fantasySlot != null) {
          S.fantasyDraft[Number(event.target.dataset.fantasySlot)] = event.target.value; S.fantasyDirty = true;
          var player = S.fantasy && (S.fantasy.players || []).find(function (item) { return item.id === event.target.value; });
          var club = event.target.parentNode.querySelector('.est-fantasy-selected-club');
          if (club) { if (player) setClubLabel(club, player.clubId, player.clubName); else club.textContent = ''; }
        }
      });
      el['est-fantasy-opt'].addEventListener('change', optFantasy);
    }

    el['est-tos-accept'].addEventListener('click', function () {
      localStorage.setItem(TOS_KEY, S.tosVersion); el['est-tos'].hidden = true;
      renderBallonDorMarket();
      connect();
    });
    el['est-promo-refresh'].addEventListener('click', refreshPromotionSession);
    el['est-promo-form'].addEventListener('submit', submitPromotion);
    el['est-promo-target'].addEventListener('change', updatePromotionRoomField);
    updatePromotionRoomField();
    setupStudioControls();
    setupCommentarySpeech();
    if (!commentarySpeech.buttonBound) {
      commentarySpeech.buttonBound = true;
      el['est-commentary-voice'].addEventListener('click', function () {
        setCommentaryVoiceEnabled(!S.commentaryVoiceOn);
      });
    }
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
    el['est-bdo-retry'].addEventListener('click', loadBallonDorMarket);
    el['est-bdo-selection'].addEventListener('change', function () {
      S.ballonDorSelection = el['est-bdo-selection'].value || '';
      S.ballonDorReview = null;
      S.ballonDorIdempotencyKey = null;
      setBallonDorMessage('', '');
      renderBallonDorMarket();
    });
    el['est-bdo-stake'].addEventListener('input', function () {
      if (!S.ballonDorReview) renderBallonDorMarket();
    });
    el['est-bdo-review'].addEventListener('click', reviewBallonDorBet);
    el['est-bdo-confirm'].addEventListener('click', confirmBallonDorBet);
    el['est-bdo-edit'].addEventListener('click', editBallonDorBet);
    el['est-bdo-opening-start'].addEventListener('click', function () {
      openBallonDorOpening({ mandatory: true });
    });
    el['est-bdo-ceremony-start'].addEventListener('click', openBallonDorCeremony);
    el['est-bdo-ceremony-play'].addEventListener('click', toggleBallonDorCeremonyPlayback);
    el['est-bdo-ceremony-music'].addEventListener('click', toggleBallonDorCeremonyMusic);
    el['est-bdo-ceremony-narration'].addEventListener('click', toggleBallonDorCeremonyNarration);
    el['est-bdo-ceremony-replay'].addEventListener('click', replayBallonDorCeremony);
    el['est-bdo-ceremony-close'].addEventListener('click', closeBallonDorCeremony);
    el['est-bdo-ceremony'].addEventListener('keydown', onBallonDorCeremonyKeydown);
    el['est-bdo-ceremony'].addEventListener('click', function (event) {
      if (event.target.classList.contains('est-bdo-ceremony-scrim')) closeBallonDorCeremony();
    });
    el['est-bdo-opening-play'].addEventListener('click', toggleBallonDorOpeningPlayback);
    el['est-bdo-opening-enable-audio'].addEventListener('click', activateBallonDorOpeningAudio);
    el['est-bdo-opening-mute'].addEventListener('click', muteBallonDorOpening);
    el['est-bdo-opening-skip'].addEventListener('click', closeBallonDorOpening);
    el['est-bdo-opening-close'].addEventListener('click', closeBallonDorOpening);
    el['est-bdo-opening-cta'].addEventListener('click', function () {
      var market = S.ballonDorMarket;
      var target = market && market.status === 'active'
        ? el['est-bdo-bet-area']
        : (market && market.status === 'settled' && !market.result
          ? el['est-bdo-finalization'] : el['est-bdo-table-wrap']);
      if (!target || target.hidden) target = el['est-bdo-table-wrap'];
      closeBallonDorOpening();
      if (target && typeof target.scrollIntoView === 'function') {
        try { target.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'center' }); }
        catch (_) { target.scrollIntoView(); }
      }
    });
    el['est-bdo-opening'].addEventListener('keydown', onBallonDorOpeningKeydown);
    el['est-bdo-opening'].addEventListener('click', function (event) {
      if (event.target.classList.contains('est-bdo-opening-scrim')) closeBallonDorOpening();
    });
    // La narración ya no marca el final de la presentación: al terminar entra el
    // tema instrumental y la inauguración sigue hasta su propio cierre.
    el['est-bdo-opening-audio'].addEventListener('ended', onBallonDorOpeningNarrationEnded);
    if (el['est-bdo-opening-bed']) {
      el['est-bdo-opening-bed'].addEventListener('error', function () {
        S.ballonDorOpeningMode = 'visual';
      });
    }
    el['est-bdo-opening-audio'].addEventListener('error', function () {
      reportBallonDorAudio('opening_narration', 'error', S.ballonDorOpeningMonth);
      startBallonDorOpeningFallback(S.ballonDorOpeningSession, 'Audio no disponible · las escenas y el guion siguen disponibles.');
    });
    ['music', 'narration'].forEach(function (kind) {
      var audio = el['est-bdo-ceremony-' + kind + '-audio'];
      var track = kind === 'music' ? 'ceremony_music' : 'ceremony_narration';
      if (!audio) return;
      audio.addEventListener('ended', function () {
        reportBallonDorAudio(track, 'completed', S.ballonDorCeremonyMonth);
      });
      audio.addEventListener('error', function () {
        ceremonyAudioFailed(S.ballonDorCeremonySession, track, 'error');
      });
    });
    // Historial y pagos: vista propia (diálogo a pantalla completa).
    var ledgerNav = $('est-ledger-open-nav'), ledgerPanel = $('est-ledger-open');
    if (ledgerNav) ledgerNav.addEventListener('click', function (e) { openLedger(e.currentTarget); });
    if (ledgerPanel) ledgerPanel.addEventListener('click', function (e) { openLedger(e.currentTarget); });
    if (el['est-ledger-close']) el['est-ledger-close'].addEventListener('click', closeLedger);
    if (el['est-ledger-back']) el['est-ledger-back'].addEventListener('click', closeLedger);
    if (el['est-ledger-ranking-back']) el['est-ledger-ranking-back'].addEventListener('click', closeLedger);
    if (el['est-ledger-tab-history']) el['est-ledger-tab-history'].addEventListener('click', function () { setLedgerView('history'); });
    if (el['est-ledger-tab-ranking']) el['est-ledger-tab-ranking'].addEventListener('click', function () { setLedgerView('ranking'); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bet-ranking-source]'), function (button) {
      button.addEventListener('click', function () {
        S.betRankingSource = button.getAttribute('data-bet-ranking-source') || 'total';
        renderBetRanking();
      });
    });
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
    setInterval(refreshFantasy, 30000);
  }
  // Música de ambiente de estadio: un solo bucle, solo con el sonido activado por el usuario.
  var music = null;
  function setCommentaryMusicDuck(active) {
    if (music) music.volume = active && S.musicOn ? 0.14 : 0.32;
  }
  function syncMusic() {
    if (!music) {
      music = new Audio('/assets/match-ambience.mp3');
      music.loop = true; music.preload = 'auto'; music.volume = commentarySpeech.active && S.musicOn ? 0.14 : 0.32;
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
    if (hubOpen()) {
      if (e.key.toLowerCase() === 'escape') { e.preventDefault(); closeHub(); }
      return;
    }
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
    if (commentarySpeechSupported()) {
      setCommentaryVoiceEnabled(!S.commentaryVoiceOn);
      return;
    }
    S.muted = !S.muted;
    updateCommentaryMuteStyles();
    toast(S.muted ? 'Relato silenciado.' : 'Relato activado.', '');
  }
  function highlightActive() {
    // renderLobby marca el partido activo (m.id === S.currentMatchId) de forma fiable.
    if (S.lobby) renderLobby(S.lobby);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
})();
