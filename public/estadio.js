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
  function font() { if (FONT === null) { try { FONT = font() || 'sans-serif'; } catch (e) { FONT = 'sans-serif'; } } return FONT; }
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
    lobby: null, standings: [], countdownTo: null,
    currentMatchId: null, match: null, markets: {}, movement: {}, myBets: [],
    slip: null, muted: false, soundOn: localStorage.getItem('montecristo-notifications') !== 'off',
    players: [], ball: { x: .5, y: .5 }, ballStart: { x: .5, y: .5 }, ballDest: { x: .5, y: .5 },
    tweenT0: 0, minute: 0, phase: 'pre', score: { home: 0, away: 0 }, possession: { home: .5, away: .5 },
    goalFlashUntil: 0, homeKit: '#52e0ae', awayKit: '#ff667c', rafId: null, pitchCache: null, submitting: false
  };

  var el = {};
  function cacheEls() {
    ['est-connection', 'est-chips', 'est-sound', 'est-countdown', 'est-match-list', 'est-standings',
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
    S.socket.on('football:goal', onGoalEvent);
    S.socket.on('football:odds', onOdds);
    S.socket.on('football:settlement', onSettlement);
    S.socket.on('football:status', onStatus);
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

  var STATUS_LABEL = { scheduled: 'Programado', live: 'EN VIVO', halftime: 'Descanso', extra_time: 'Prórroga', shootout: 'Penales', finished: 'Final', settled: 'Final', postponed: 'Pospuesto' };
  function renderLobby(lobby) {
    if (!lobby) return;
    S.lobby = lobby; S.standings = lobby.standings || []; S.countdownTo = lobby.nextKickoffAt;
    var list = el['est-match-list']; list.innerHTML = '';
    var matches = lobby.matches || [];
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
  }
  function blockLabel(b) { return ({ matutino: 'Matutino', vespertino: 'Vespertino', estelar: 'Estelar' })[b] || b; }
  function kickoffTime(ms) { if (!ms) return ''; try { return new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
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
    if (!S.countdownTo) { el['est-countdown'].textContent = 'Sin próximo kickoff programado.'; return; }
    var ms = S.countdownTo - Date.now();
    if (ms <= 0) { el['est-countdown'].innerHTML = 'Próximo kickoff: <b>en juego</b>'; return; }
    var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
    el['est-countdown'].innerHTML = 'Próximo kickoff en <b>' + (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's</b>';
  }

  // ===== Estado del partido =====
  function applyMatchState(ms) {
    if (!ms) return;
    S.match = ms.match; S.markets = ms.markets || {}; S.movement = {};
    S.myBets = (ms.myBets || []).slice();
    S.minute = ms.state ? ms.state.minute : 0;
    S.phase = ms.state ? ms.state.phase : 'pre';
    S.score = ms.state ? ms.state.score : { home: 0, away: 0 };
    S.possession = ms.state && ms.state.possession ? ms.state.possession : { home: .5, away: .5 };
    var ball = ms.state && ms.state.ball ? ms.state.ball : { x: .5, y: .5 };
    S.ball = { x: ball.x, y: ball.y }; S.ballStart = { x: ball.x, y: ball.y }; S.ballDest = { x: ball.x, y: ball.y };
    resolveKits();
    initPlayers();
    S.tweenT0 = performance.now();
    renderScoreboard();
    renderMarkets();
    renderMyBets();
    renderCommentary(ms.commentary || []);
    updateTextFallback();
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
    var hf = S.teams[S.match.homeId] ? S.teams[S.match.homeId].formation : '4-4-2';
    var af = S.teams[S.match.awayId] ? S.teams[S.match.awayId].formation : '4-4-2';
    buildTeam('home', hf, false, S.homeKit, S.homeSec, S.homePattern);
    buildTeam('away', af, true, S.awayKit, S.awaySec, S.awayPattern);
    recomputeTargets(S.ballDest.x, S.ballDest.y);
    S.players.forEach(function (p) { p.baseX = p.destX; p.baseY = p.destY; p.startX = p.destX; p.startY = p.destY; p.renderX = p.destX; p.renderY = p.destY; });
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
    S.players.forEach(function (p) {
      var t = targetFor(p.slot, p.mirror, bx, by);
      p.startX = p.baseX; p.startY = p.baseY; p.destX = t.x; p.destY = t.y;
    });
  }

  // ===== Ciclo de render (tweening 60 fps) =====
  function frame(now) {
    S.rafId = requestAnimationFrame(frame);
    var p = clamp((now - S.tweenT0) / TICK_MS, 0, 1);
    var e = reduced.matches ? 1 : easeOutCubic(p);
    S.ball.x = lerp(S.ballStart.x, S.ballDest.x, e);
    S.ball.y = lerp(S.ballStart.y, S.ballDest.y, e);
    for (var i = 0; i < S.players.length; i++) {
      var pl = S.players[i];
      pl.baseX = lerp(pl.startX, pl.destX, e);
      pl.baseY = lerp(pl.startY, pl.destY, e);
      if (reduced.matches) { pl.renderX = pl.baseX; pl.renderY = pl.baseY; }
      else {
        pl.renderX = clamp(pl.baseX + Math.sin(now / 700 + pl.seed) * 0.006, .01, .99);
        pl.renderY = clamp(pl.baseY + Math.cos(now / 830 + pl.seed * 1.3) * 0.006, .02, .98);
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
    var homeHas = S.possession.home >= S.possession.away;
    S.players.forEach(function (pl) { drawPlayer(pl, pl.team === 'home' ? homeHas : !homeHas); });
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
    if (!reduced.matches) { ctx.beginPath(); ctx.moveTo(nx(S.ballStart.x), ny(S.ballStart.y)); ctx.lineTo(bx, by); ctx.strokeStyle = 'rgba(229,189,114,.18)'; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(bx, by, BALL_R + 2, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, BALL_R, 0, TAU); ctx.fillStyle = '#ffe3a5'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#0a5a45'; ctx.stroke();
    if (!reduced.matches) { ctx.save(); ctx.translate(bx, by); ctx.rotate(now / 300); ctx.beginPath(); ctx.moveTo(-BALL_R, 0); ctx.lineTo(BALL_R, 0); ctx.strokeStyle = 'rgba(10,90,69,.6)'; ctx.stroke(); ctx.restore(); }
  }

  // ===== Marcador / reloj =====
  function phaseLabel(ph) {
    return ({ kickoff: 'Inicio', first_half: '1T', halftime: 'Descanso', second_half: '2T', extra_time: 'Prórroga', shootout: 'Penales', ended: 'Final', pre: '—' })[ph] || ph;
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
    appendCommentary({ voice: data.voice, text: data.text });
  }

  // ===== Eventos del motor =====
  function onTick(data) {
    if (!data || data.matchId !== S.currentMatchId) return;
    S.ballStart = { x: S.ball.x, y: S.ball.y };
    S.ballDest = data.ball ? { x: clamp(data.ball.x, 0, 1), y: clamp(data.ball.y, 0, 1) } : S.ballDest;
    S.minute = data.minute != null ? data.minute : S.minute;
    S.phase = data.phase || S.phase;
    if (data.score) S.score = data.score;
    if (data.possession) S.possession = data.possession;
    recomputeTargets(S.ballDest.x, S.ballDest.y);
    S.tweenT0 = performance.now();
    renderScoreboard();
    updateTextFallback();
  }
  function onEvent(data) {
    if (!data || data.matchId !== S.currentMatchId || !data.event) return;
    var ev = data.event;
    if (ev.type === 'goal' || ev.type === 'penalty_scored') {
      S.goalFlashUntil = performance.now() + 1400;
      showGoalBanner();
      if (ev.marcador) { var parts = String(ev.marcador).split('-'); if (parts.length === 2) { S.score = { home: Number(parts[0]) || 0, away: Number(parts[1]) || 0 }; renderScoreboard(); } }
      bell('goal');
    } else if (ev.type === 'red_card' || ev.type === 'second_yellow') {
      bell('card');
    }
  }
  function onGoalEvent(data) { if (data && data.matchId === S.currentMatchId) { S.goalFlashUntil = performance.now() + 1400; showGoalBanner(); } }
  function showGoalBanner() {
    var b = el['est-goal-banner']; b.classList.add('show'); b.setAttribute('aria-hidden', 'false');
    setTimeout(function () { b.classList.remove('show'); b.setAttribute('aria-hidden', 'true'); }, 2200);
  }
  function onStatus(data) {
    if (!data) return;
    if (data.matchId === S.currentMatchId) {
      if (data.code === 'postponed') { toast('Partido pospuesto. Tus apuestas fueron reembolsadas.', 'lose'); if (S.match) S.match.status = 'postponed'; renderScoreboard(); }
      else if (data.code === 'match_started') { if (S.match) S.match.status = 'live'; renderScoreboard(); }
      else if (data.code === 'settled' || data.code === 'finished') { if (S.match) S.match.status = 'settled'; renderScoreboard(); renderMarkets(); }
    }
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
    if (!keys.length) { box.innerHTML = '<p class="est-muted">' + (ended ? 'Partido finalizado: mercados cerrados.' : 'Sin mercados disponibles todavía.') + '</p>'; return; }
    box.innerHTML = '';
    keys.forEach(function (mk) {
      var sels = S.markets[mk] || []; if (!sels.length) return;
      var group = document.createElement('div'); group.className = 'est-market-group';
      var head = document.createElement('div'); head.className = 'est-market-name'; head.textContent = MARKET_LABEL[mk] || mk; group.appendChild(head);
      var row = document.createElement('div'); row.className = 'est-selections';
      sels.forEach(function (s) {
        var mv = S.movement[mk + ':' + s.key];
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'est-sel' + (S.slip && S.slip.market === mk && S.slip.selection === s.key ? ' selected' : '');
        btn.disabled = ended;
        var arrow = mv && mv.dir === 'up' ? '<span class="est-sel-move up">▲</span>' : mv && mv.dir === 'down' ? '<span class="est-sel-move down">▼</span>' : '';
        btn.innerHTML = '<span class="est-sel-key">' + esc(selLabel(mk, s.key)) + '</span>' +
          '<span class="est-sel-odds">' + Number(s.price).toFixed(2) + arrow + '</span>' +
          '<span class="est-sel-implied">impl. ' + pct(s.implied) + '</span>';
        btn.setAttribute('aria-label', (MARKET_LABEL[mk] || mk) + ' ' + selLabel(mk, s.key) + ', cuota ' + Number(s.price).toFixed(2) + ', probabilidad implícita ' + pct(s.implied));
        btn.addEventListener('click', function () { if (!ended) openSlip(mk, s); });
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
    var stake = Math.floor(Number(el['est-stake'].value || 0));
    var b = stakeBounds();
    if (stake < b.min || stake > b.max) { betMsg('Monto fuera de rango (' + fmt(b.min) + '–' + fmt(b.max) + ').', false); return; }
    S.submitting = true; el['est-place-bet'].disabled = true; betMsg('Enviando…', true);
    S.socket.emit('football:bet', { matchId: S.currentMatchId, market: S.slip.market, selection: S.slip.selection, stake: stake }, function (res) {
      S.submitting = false; el['est-place-bet'].disabled = false;
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
      window_cerrada: 'Fuera de la ventana de apuestas.', no_match: 'Partido no encontrado.'
    })[code] || ('No se pudo apostar (' + (code || 'error') + ').');
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
      if (b.status === 'open' && S.match && ['live', 'halftime', 'extra_time', 'shootout'].indexOf(S.match.status) >= 0) {
        var co = document.createElement('button'); co.type = 'button'; co.className = 'est-cashout'; co.textContent = 'Cobrar ahora (cash-out)';
        co.addEventListener('click', function () { cashout(b.id, co); });
        li.appendChild(co);
      }
      box.appendChild(li);
    });
  }
  function cashout(betId, btn) {
    btn.disabled = true; btn.textContent = 'Cobrando…';
    S.socket.emit('football:cashout', { betId: betId }, function (res) {
      if (!res || !res.ok) { btn.disabled = false; btn.textContent = 'Cobrar ahora (cash-out)'; toast(humanError(res && res.code), 'lose'); return; }
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

  // ===== UI: enlaces, atajos, TOS =====
  function bindUI() {
    el['est-tos-accept'].addEventListener('click', function () {
      localStorage.setItem(TOS_KEY, S.tosVersion); el['est-tos'].hidden = true; connect();
    });
    el['est-slip-clear'].addEventListener('click', closeSlip);
    el['est-place-bet'].addEventListener('click', placeBet);
    el['est-stake'].addEventListener('keydown', function (e) { if (e.key === 'Enter') placeBet(); });
    el['est-sound'].addEventListener('click', function () {
      S.soundOn = !S.soundOn; el['est-sound'].setAttribute('aria-pressed', String(!S.soundOn));
      localStorage.setItem('montecristo-notifications', S.soundOn ? 'on' : 'off');
      toast(S.soundOn ? 'Campana activada.' : 'Campana silenciada.', '');
    });
    el['est-sound'].setAttribute('aria-pressed', String(!S.soundOn));
    el['est-help-close'].addEventListener('click', function () { el['est-help'].hidden = true; });
    document.addEventListener('keydown', onKey);
    setInterval(tickCountdown, 1000); tickCountdown();
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
