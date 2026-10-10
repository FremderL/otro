(() => {
  'use strict';

  // La presencia del lobby se cuenta por dispositivo, no por pestaña. La
  // migración debe ocurrir antes de abrir Socket.IO para que quienes vienen de
  // la versión anterior conserven también su identidad de presencia.
  migrateLegacyStorage();
  const deviceToken = getDeviceToken();
  const socket = io({
    auth: { deviceToken },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4000
  });
  // Flags públicos del despliegue (GET /healthz), leídos una sola vez. El
  // backend responde 404 fail-closed cuando una función está apagada (diseño
  // intencional, cubierto por tests); el navegador loguea todo 404 de red en
  // consola aunque el JS lo maneje, así que con el flag a la mano el cliente va
  // directo al fallback sin generar la petición. Si /healthz no responde se
  // asume "encendido" y se conserva el comportamiento anterior (cada flujo
  // tolera el 404 como red de seguridad por si el flag cambió en vivo).
  const serverFlags = { accountSessions: null };
  const serverFlagsReady = fetch('/healthz', { cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null))
    .then(data => { serverFlags.accountSessions = !data || data.accountSessionsEnabled !== false; })
    .catch(() => { serverFlags.accountSessions = true; });
  function accountSessionsAvailable() { return serverFlags.accountSessions !== false; }
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  const els = {
    landing: $('#landing'), roomApp: $('#room-app'), modal: $('#join-modal'), form: $('#join-form'),
    playerName: $('#player-name'), roomName: $('#room-name'), roomNameField: $('#room-name-field'),
    roomCode: $('#room-code'), codeField: $('#code-field'), gameChoice: $('#game-choice'),
    modalKicker: $('#modal-kicker'), modalTitle: $('#modal-title'), modalSubtitle: $('#modal-subtitle'), modalSymbol: $('.modal-symbol'),
    setupPreviewSymbol: $('#setup-preview-symbol'), setupPreviewTitle: $('#setup-preview-title'), setupPreviewDetail: $('#setup-preview-detail'), setupPreviewAvatar: $('#setup-preview-avatar'),
    modalSubmit: $('#modal-submit'), overlay: $('#connection-overlay'), loadingMessage: $('#loading-message'),
    navConnection: $('#nav-connection'), headerConnection: $('#header-connection'), connectionStatus: $('#connection-status'),
    liveRooms: $('#live-rooms'), liveRoomCount: $('#live-room-count'), onlinePlayerCount: $('#online-player-count'),
    heroOnlineCount: $('#hero-online-count'), lobbyRefresh: $('#lobby-refresh'),
    notificationsToggle: $('#notifications-toggle'), roomNotificationsToggle: $('#room-notifications-toggle'),
    lobbyChatWidget: $('#lobby-chat-widget'), lobbyChatBubble: $('#lobby-chat-bubble'), lobbyChatPanel: $('#lobby-chat-panel'),
    lobbyChatClose: $('#lobby-chat-close'), lobbyChatUnread: $('#lobby-chat-unread'), lobbyChatProfile: $('#lobby-chat-profile'),
    lobbyChatProfileForm: $('#lobby-chat-profile-form'), lobbyChatName: $('#lobby-chat-name'), lobbyChatTos: $('#lobby-chat-tos'),
    lobbyChatContent: $('#lobby-chat-content'), lobbyChatMessages: $('#lobby-chat-messages'), lobbyChatForm: $('#lobby-chat-form'), lobbyChatInput: $('#lobby-chat-input'),
    gameName: $('#game-name'), phaseLabel: $('#phase-label'), roomTitle: $('#room-title'), headerCode: $('#header-code'),
    tournamentBanner: $('#tournament-banner'),
    profileCard: $('#profile-card'), playersList: $('#players-list'), playerCount: $('#player-count'),
    chatList: $('#chat-list'), chatForm: $('#chat-form'), chatInput: $('#chat-input'),
    gameStatus: $('#game-status'), turnClock: $('#turn-clock'), clockValue: $('#clock-value'),
    clockPlayer: $('#clock-player'), tableWrap: $('#table-wrap'), actionPanel: $('#action-panel'),
    toastStack: $('#toast-stack'), roundFlash: $('#round-flash'),
    sidebar: $('.sidebar'), soundToggle: $('#sound-toggle'),
    specialEventBanner: $('#special-event-banner'), winnerTicker: $('#winner-ticker'), reactionStage: $('#reaction-stage'),
    profileModal: $('#profile-modal'), profileForm: $('#profile-form'), profileNameInput: $('#profile-name-input'),
    profileAccountStatus: $('#profile-account-status'),
    profileAvatarChoice: $('#profile-avatar-choice'), profileBigAvatar: $('#profile-big-avatar'), profileBadges: $('#profile-badges'),
    profileStats: $('#profile-stats'), rotatingChallengeList: $('#rotating-challenge-list'), challengeList: $('#challenge-list'), achievementList: $('#achievement-list'),
    featuredAchievements: $('#featured-achievements'),
    balanceChart: $('#balance-chart'), balanceChartNote: $('#balance-chart-note'), gameBreakdown: $('#game-breakdown'),
    historyDownload: $('#history-download'),
    dailyBonusStatus: $('#daily-bonus-status'), dailyBonusCountdown: $('#daily-bonus-countdown'),
    quickChatToggle: $('#quick-chat-toggle'), quickChatMenu: $('#quick-chat-menu'),
    botMenuToggle: $('#bot-menu-toggle'), botControls: $('#bot-controls'), botMenuClose: $('#bot-menu-close'),
    botDifficulty: $('#bot-difficulty'), botStyle: $('#bot-style'), botAdd: $('#bot-add'), botFill: $('#bot-fill'),
    reportOpenBtn: $('#report-open-btn'), reportModal: $('#report-modal'), reportForm: $('#report-form'), reportTitle: $('#report-title'), reportCopy: $('#report-copy'), reportUserField: $('#report-user-field'), reportedUsername: $('#reported-username'), reportCategory: $('#report-category'), reportDescription: $('#report-description'), reportError: $('#report-error'), myReportsList: $('#my-reports-list'), myReportsRefresh: $('#my-reports-refresh'),
    accountOpenBtn: $('#account-open-btn'), accountModal: $('#account-modal'), accountForm: $('#account-form'),
    accountModalTitle: $('#account-modal-title'), accountModalCopy: $('#account-modal-copy'),
    accountUsername: $('#account-username'), accountPassword: $('#account-password'), accountError: $('#account-error'),
    accountSubmit: $('#account-submit'), accountSwitch: $('#account-switch'), accountLogout: $('#account-logout'),
    accountPasswordToggle: $('#account-password-toggle'), passwordChangeForm: $('#password-change-form'),
    currentPassword: $('#current-password'), newPassword: $('#new-password'), confirmPassword: $('#confirm-password'),
    passwordChangeError: $('#password-change-error'), passwordChangeSubmit: $('#password-change-submit'), passwordChangeCancel: $('#password-change-cancel')
  };

  const PHASES = {
    waiting: 'Sala de espera', betting: 'Ronda de apuestas', playing: 'Ronda en curso', rolling: 'Resultado en camino',
    preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River',
    showdown: 'Resultados', results: 'Resultados'
  };
  const GAME_META = {
    poker: { icon: '♠', name: 'TEXAS HOLD’EM' }, blackjack: { icon: '◆', name: 'BLACKJACK' },
    roulette: { icon: '◉', name: 'RULETA NOVA' }, dice: { icon: '⚄', name: 'DADOS CÓSMICOS' },
    coinflip: { icon: '◐', name: 'CARA O CRUZ' }, slots: { icon: '🎰', name: 'TRAGAMONEDAS' },
    // Estadio MonteCristo (Fase E4, §16 fila 14): solo meta de visualización para
    // el panel «Historial por juego» y el icono del modal. NO agrega fútbol a los
    // juegos jugables ni a los retos (AVAILABLE_GAMES/CHALLENGE_GAMES lo excluyen, C6).
    football: { icon: '🏟', name: 'ESTADIO' }
  };
  const AVATARS = [
    { id: 'fox', emoji: '🦊', label: 'Zorro' }, { id: 'tiger', emoji: '🐯', label: 'Tigre' },
    { id: 'panda', emoji: '🐼', label: 'Panda' }, { id: 'owl', emoji: '🦉', label: 'Búho' },
    { id: 'alien', emoji: '👽', label: 'Alien' }, { id: 'robot', emoji: '🤖', label: 'Robot' },
    { id: 'crown', emoji: '👑', label: 'Corona' }, { id: 'diamond', emoji: '💎', label: 'Diamante' }
  ];
  const SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  // Debe coincidir con TOS_VERSION en lib/terms.js; al cambiar, se pide aceptar de nuevo.
  const TOS_VERSION = '2026-09-28';
  const TOS_KEY = 'montecristo-tos';
  const routeCode = getRouteCode();
  const savedSession = readSession();

  // ---------- Términos y condiciones (aceptación obligatoria) ----------
  function tosAccepted() { return localStorage.getItem(TOS_KEY) === TOS_VERSION; }
  function showTosModal() {
    const modal = document.getElementById('tos-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('open'); // sin 'open', la regla base .modal lo deja invisible
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    modal.querySelector('#tos-accept')?.focus();
  }
  function hideTosModal() {
    const modal = document.getElementById('tos-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }
  if (!tosAccepted()) showTosModal();
  document.getElementById('tos-accept')?.addEventListener('click', () => {
    localStorage.setItem(TOS_KEY, TOS_VERSION);
    hideTosModal();
  });

  // OJO de scope: estas dos constantes deben quedar declaradas ANTES de
  // `const ui = {...}` (más abajo), porque su inicialización llama a
  // readAccountSession() ya mismo, de forma síncrona. Si quedaran después,
  // seguirían siendo válidas por hoisting de las funciones, pero al ser
  // `const` caerían en zona muerta temporal (TDZ) en el momento de la
  // llamada — y como readAccountSession() atrapa cualquier excepción para
  // nunca romper el arranque, ese error quedaría silenciado y la sesión
  // parecería simplemente "vacía" en cada carga. Ya pasó una vez: por eso
  // el comentario.
  const ACCOUNT_SESSION_KEY = 'montecristo-account-session';
  // Campos públicos permitidos en la sesión de cuenta guardada en localStorage.
  // OJO: `accountId` es el id del PERFIL de la cuenta (para poder pedir su
  // perfil público o editarlo desde el lobby); NO es ni reemplaza el token de
  // dispositivo (`montecristo-device`, usado para jugar sin cuenta) y nunca se
  // usa como tal en este archivo.
  const ACCOUNT_SESSION_FIELDS = [
    'accountId', 'username', 'name', 'avatar', 'chips', 'stats', 'achievements', 'gamesPlayed',
    'featuredAchievements', 'allAchievements', 'challenges', 'dailyChallenges', 'weeklyChallenges',
    'gameStats', 'balanceHistory', 'medals', 'championBanner', 'dailyBonusClaimed', 'dailyBonusAvailableAt'
  ];
  const ui = {
    accountMode: 'login',
    accountSession: readAccountSession(),
    csrfToken: null, // solo memoria; nunca localStorage
    modalMode: 'create', selectedGame: 'poker', roomFilter: 'all', lobby: [], playersOnline: 0,
    room: null, me: null, activeCode: null, playerName: localStorage.getItem('montecristo-name') || '',
    selectedAvatar: localStorage.getItem('montecristo-avatar') || 'fox', profileAvatar: localStorage.getItem('montecristo-avatar') || 'fox',
    connection: 'connecting', sound: localStorage.getItem('montecristo-sound') !== 'off', notifications: localStorage.getItem('montecristo-notifications') !== 'off',
    lobbyChat: { joined: false, joining: false, open: false, messages: [], unread: 0 },
    lastGameSignature: '', lastChatSignature: '', shouldResume: false, joining: false,
    lastEventKey: '', clockTimer: null, dailyBonusTimer: null, previousRanks: new Map(), previousChips: new Map(), lastMeChips: null, profileOpen: false, profileNameDirty: false,
    rouletteAngle: 0, rouletteSpin: null, rouletteRaf: null, slotsSpin: null, slotsRaf: null, resultQueue: [],
    spectating: false
  };

  if (savedSession && routeCode && savedSession.code === routeCode) {
    ui.activeCode = routeCode;
    // localStorage contiene la última edición confirmada del perfil. La sesión
    // de la mesa puede ser anterior (se creó al entrar) y nunca debe ganar sobre
    // ese valor al recargar: hacerlo reenviaba el nombre viejo al servidor y
    // deshacía el cambio. El nombre de sessionStorage queda solo como fallback
    // para sesiones históricas que todavía no tienen la clave persistente.
    ui.playerName = ui.playerName || savedSession.name || '';
    ui.selectedAvatar = localStorage.getItem('montecristo-avatar') || savedSession.avatar || ui.selectedAvatar;
    ui.spectating = Boolean(savedSession.spectate);
    ui.shouldResume = Boolean(ui.playerName);
  }
  els.playerName.value = ui.playerName;
  updateSoundButton();
  updateNotificationButtons();
  renderAccountButton();
  renderAvatarChoices();
  initScrollReveal();

  // ---------- Utilities ----------
  function migrateLegacyStorage() {
    // Migración "Mesa Amiga" -> "MonteCristo": conserva perfil, nombre, avatar y sonido de usuarios existentes.
    try {
      ['device', 'name', 'avatar', 'sound'].forEach(key => {
        const legacy = localStorage.getItem(`mesa-amiga-${key}`);
        if (legacy !== null && localStorage.getItem(`montecristo-${key}`) === null) {
          localStorage.setItem(`montecristo-${key}`, legacy);
        }
        if (legacy !== null) localStorage.removeItem(`mesa-amiga-${key}`);
      });
      const legacySession = sessionStorage.getItem('mesa-amiga-session');
      if (legacySession !== null && sessionStorage.getItem('montecristo-session') === null) {
        sessionStorage.setItem('montecristo-session', legacySession);
      }
      if (legacySession !== null) sessionStorage.removeItem('mesa-amiga-session');
    } catch { /* almacenamiento no disponible: continuar sin migrar */ }
  }
  function initScrollReveal() {
    if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }), { threshold: .12, rootMargin: '0px 0px -45px' });
    $$('.game-card, .quick-game-card, .step').forEach((element, index) => {
      element.classList.add('reveal-item');
      element.style.setProperty('--reveal-delay', `${Math.min(index % 3, 2) * 70}ms`);
      observer.observe(element);
    });
    ui.revealObserver = observer;
  }
  function observeLobbyCards() {
    if (!ui.revealObserver) return;
    $$('.live-room').forEach(element => { element.classList.add('reveal-item'); ui.revealObserver.observe(element); });
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }
  function getDeviceToken() {
    let token = localStorage.getItem('montecristo-device');
    if (!token) {
      token = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('montecristo-device', token);
    }
    return token;
  }
  // Sanitización explícita: a partir del perfil que manda el servidor, arma un
  // objeto SOLO con campos públicos, listos para persistir en localStorage.
  // Nunca deja pasar password, passwordHash, tokens ni ningún dato interno,
  // aunque el backend llegara a agregarlos algún día (lista blanca + borrado
  // explícito de los campos sensibles conocidos, por defensa en profundidad).
  function sanitizeProfileForSession(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const safe = {};
    ACCOUNT_SESSION_FIELDS.forEach(key => { if (profile[key] !== undefined) safe[key] = profile[key]; });
    if (typeof profile.id === 'string' && profile.id) safe.accountId = profile.id;
    delete safe.password; delete safe.passwordHash; delete safe.token; delete safe.deviceToken; delete safe.transactions;
    if (!safe.username) return null; // sin username no hay cuenta que recordar
    return safe;
  }
  function readAccountSession() {
    try {
      const raw = JSON.parse(localStorage.getItem(ACCOUNT_SESSION_KEY));
      // Revalida lo leído por la misma sanitización: si alguna versión vieja
      // del cliente guardó algo sensible, se limpia solo al recargar.
      return sanitizeProfileForSession(raw);
    } catch { return null; }
  }
  function renderAccountButton() {
    if (!els.accountOpenBtn) return;
    const loggedIn = Boolean(ui.accountSession?.username);
    els.accountOpenBtn.innerHTML = `<span class="btn-icon">${loggedIn ? '👤' : '🔑'}</span> ${loggedIn ? 'Perfil' : 'Iniciar sesión'}`;
    els.accountOpenBtn.setAttribute('aria-label', loggedIn ? 'Abrir perfil de cuenta' : 'Iniciar sesión');
  }
  // Persiste (o borra) la sesión de cuenta a partir de un perfil público que
  // vino del servidor. Es la ÚNICA vía para escribir en ACCOUNT_SESSION_KEY,
  // así toda la sesión pasa siempre por sanitizeProfileForSession().
  function saveAccountSession(profile) {
    const safe = sanitizeProfileForSession(profile);
    if (!safe) return false;
    ui.accountSession = safe;
    localStorage.setItem(ACCOUNT_SESSION_KEY, JSON.stringify(safe));
    renderAccountButton();
    return true;
  }
  // Cierra SOLO la sesión de cuenta: el perfil anónimo local (nombre, avatar,
  // fichas) vive en el servidor bajo el token de dispositivo y ese token nunca
  // se toca aquí, así que seguir jugando sin cuenta no pierde nada.
  function clearAccountSession() {
    localStorage.removeItem(ACCOUNT_SESSION_KEY);
    ui.accountSession = null;
    ui.csrfToken = null;
    renderAccountButton();
  }
  // ¿La persona está sentada en una mesa (o en la tribuna) ahora mismo? Si es
  // así, el modal de perfil muestra/edita el perfil de ESA mesa; si no, muestra
  // la cuenta (si hay sesión iniciada).
  function inTable() { return Boolean(ui.room?.viewerProfile); }
  // Perfil que corresponde mostrar en el modal: el de la mesa si hay una, si
  // no el de la cuenta iniciada. Nunca se sustituye por un objeto de mesa
  // fabricado a mano: fuera de una mesa, `ui.room` se deja intacto (null).
  function currentViewerProfile() { return ui.room?.viewerProfile || ui.accountSession || null; }
  // La sesión de cuenta cacheada en localStorage es una INSTANTÁNEA: puede
  // quedar vieja si el perfil cambió después (rondas jugadas en esta u otra
  // computadora, renombrado al entrar a una mesa, bonos…). Por eso el modal
  // del lobby la pinta para responder al instante pero SIEMPRE pide después
  // el perfil público actualizado al servidor (ver openProfileModal).
  // Al editar desde una mesa, el perfil editado es el del JUGADOR de esa mesa
  // (identificado por el token de dispositivo), que puede ser un perfil
  // anónimo totalmente distinto del de la cuenta con la que se inició sesión.
  // Solo se refresca la caché de la sesión de cuenta si de verdad se trata del
  // MISMO perfil (mismo id) — nunca se pisa la cuenta con datos de otro perfil.
  function syncAccountSessionIfSameProfile(profile) {
    if (profile && ui.accountSession && profile.id && profile.id === ui.accountSession.accountId) {
      saveAccountSession(profile);
    }
  }
  async function secureAuthRequest(path, options = {}) {
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, ok: response.ok, ...body };
    } catch (_) {
      return { status: 0, ok: false, error: 'No se pudo contactar al servidor.' };
    }
  }
  async function refreshAccountProfile() {
    if (!ui.accountSession?.accountId) return;
    await serverFlagsReady;
    // Con ACCOUNT_SESSIONS_ENABLED apagado, /api/auth/session responde 404
    // fail-closed; se va directo al fallback por socket para no generar ese
    // 404 en la consola del navegador.
    const secure = accountSessionsAvailable() ? await secureAuthRequest('/api/auth/session') : { status: 404 };
    if (secure.status !== 404) {
      if (secure.ok && secure.profile) {
        ui.csrfToken = secure.csrfToken || null;
        saveAccountSession(secure.profile);
        if (ui.profileOpen && !inTable()) renderProfileModal();
      } else if (secure.status === 401) {
        // localStorage es solo caché visual: una cookie ausente/revocada manda.
        clearAccountSession();
      }
      return;
    }
    // Compatibilidad temporal mientras ACCOUNT_SESSIONS_ENABLED está apagado.
    if (!socket.connected) return;
    const response = await emitAck('account_profile', { accountId: ui.accountSession.accountId });
    if (response.ok && response.profile) {
      saveAccountSession(response.profile);
      if (ui.profileOpen && !inTable()) renderProfileModal();
    }
  }
  function getRouteCode() {
    const match = location.pathname.match(/^\/room\/([A-Z0-9]{5})/i);
    return match ? match[1].toUpperCase() : '';
  }
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem('montecristo-session')); } catch { return null; }
  }
  function saveSession() {
    if (!ui.activeCode || !ui.playerName) return;
    sessionStorage.setItem('montecristo-session', JSON.stringify({ code: ui.activeCode, name: ui.playerName, avatar: ui.selectedAvatar, spectate: ui.spectating }));
  }
  function clearSession() { sessionStorage.removeItem('montecristo-session'); }
  function initials(name) {
    const chunks = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return (chunks[0]?.[0] || '?') + (chunks.length > 1 ? chunks[chunks.length - 1][0] : '');
  }
  function avatarEmoji(id) { return AVATARS.find(item => item.id === id)?.emoji || '🦊'; }
  function avatarMarkup(player, className = 'player-avatar') {
    return `<div class="${className} ${player.connected === false ? 'offline' : ''}" style="background:${avatarColor(player.id)}">${avatarEmoji(player.avatar)}${player.connected === false ? '' : '<i class="player-online"></i>'}</div>`;
  }
  function renderAvatarChoices() {
    $$('[data-select-avatar]').forEach(button => {
      const selected = button.dataset.selectAvatar === ui.selectedAvatar;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (els.profileAvatarChoice) {
      els.profileAvatarChoice.innerHTML = AVATARS.map(item => `<button type="button" data-profile-avatar="${item.id}" class="${item.id === ui.profileAvatar ? 'active' : ''}" aria-label="${item.label}" aria-pressed="${item.id === ui.profileAvatar}">${item.emoji}</button>`).join('');
      $$('[data-profile-avatar]').forEach(button => button.addEventListener('click', () => {
        ui.profileAvatar = button.dataset.profileAvatar;
        $$('[data-profile-avatar]').forEach(item => {
          const selected = item === button;
          item.classList.toggle('active', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
        els.profileBigAvatar.textContent = avatarEmoji(ui.profileAvatar);
      }));
    }
  }
  function avatarColor(value) {
    const palette = [
      ['#315f57', '#193a34'], ['#6d4b65', '#382535'], ['#3e5f7e', '#213749'],
      ['#785645', '#422d24'], ['#5c517d', '#312b46'], ['#387066', '#1e403a']
    ];
    const hash = [...String(value || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const pair = palette[hash % palette.length];
    return `linear-gradient(145deg,${pair[0]},${pair[1]})`;
  }
  function formatChips(number) { return new Intl.NumberFormat('es-MX').format(Math.max(0, Number(number) || 0)); }
  function formatDelta(number) { return new Intl.NumberFormat('es-MX').format(Number(number) || 0); }
  function phaseText(phase) { return PHASES[phase] || String(phase || 'Esperando'); }
  function isPokerActive(room = ui.room) { return room && ['preflop', 'flop', 'turn', 'river'].includes(room.phase); }
  function blackjackValue(hand = []) {
    let value = 0, aces = 0;
    hand.filter(card => card && card !== 'XX').forEach(card => {
      const rank = card.slice(0, -1);
      if (rank === 'A') { value += 11; aces++; }
      else if (['K', 'Q', 'J'].includes(rank)) value += 10;
      else value += Number(rank);
    });
    while (value > 21 && aces) { value -= 10; aces--; }
    return value;
  }
  function setButtonLoading(button, loading) {
    if (!button) return;
    button.classList.toggle('is-loading', loading);
    button.disabled = loading;
    button.setAttribute('aria-busy', String(loading));
  }
  function emitAck(event, payload = {}, button = null) {
    if (!socket.connected) {
      showToast('Sin conexión con el servidor', 'La mesa no responde. Si estás en una vista previa, es posible que el servidor esté apagado: pide reactivarlo y recarga la página.', 'error', 6000);
      return Promise.resolve({ ok: false, error: 'Sin conexión con el servidor.' });
    }
    if (button) setButtonLoading(button, true);
    return new Promise(resolve => {
      // Auditoría: al agotarse la espera, el botón también debe rehabilitarse.
      // Antes solo se rehabilitaba dentro del callback del ack, así que si el
      // servidor nunca respondía (exactamente lo que pasaba cuando el proceso
      // moría por un error), "Guardar" se quedaba deshabilitado para siempre.
      const timer = setTimeout(() => {
        if (button) setButtonLoading(button, false);
        resolve({ ok: false, error: 'La mesa tardó demasiado en responder.' });
      }, 9000);
      socket.emit(event, payload, response => {
        clearTimeout(timer);
        if (button) setButtonLoading(button, false);
        resolve(response || { ok: false, error: 'No hubo respuesta del servidor.' });
      });
    });
  }
  function setOverlay(active, message = 'CONECTANDO AL CASINO') {
    els.loadingMessage.textContent = message;
    els.overlay.classList.toggle('ready', !active);
    els.overlay.setAttribute('aria-hidden', String(!active));
  }
  function updateHistory(code) {
    const path = code ? `/room/${code}` : '/';
    if (location.pathname !== path) history.pushState({}, '', path);
  }
  function playTone(kind = 'notice') {
    if (!ui.sound) return;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      const ctx = playTone.ctx || (playTone.ctx = new Context());
      const notes = kind === 'win' ? [523, 659, 784] : kind === 'turn' ? [440, 660] : kind === 'loss' ? [280, 220] : [430];
      notes.forEach((frequency, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = frequency;
        gain.gain.setValueAtTime(.0001, ctx.currentTime + index * .1);
        gain.gain.exponentialRampToValueAtTime(.045, ctx.currentTime + index * .1 + .015);
        gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + index * .1 + .18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + index * .1); osc.stop(ctx.currentTime + index * .1 + .2);
      });
    } catch (_) { /* Sound is an enhancement; game never depends on it. */ }
  }

  function updateNotificationButtons() {
    const buttons = [els.notificationsToggle, els.roomNotificationsToggle].filter(Boolean);
    buttons.forEach(button => {
      button.textContent = ui.notifications ? '🔔' : '🔕';
      button.classList.toggle('off', !ui.notifications);
      button.title = ui.notifications ? 'Silenciar notificaciones' : 'Activar notificaciones';
      button.setAttribute('aria-label', ui.notifications ? 'Silenciar notificaciones' : 'Activar notificaciones');
      button.setAttribute('aria-pressed', String(!ui.notifications));
    });
  }

  function setLobbyChatOpen(open) {
    ui.lobbyChat.open = Boolean(open);
    els.lobbyChatPanel?.classList.toggle('hidden', !ui.lobbyChat.open);
    els.lobbyChatPanel?.setAttribute('aria-hidden', String(!ui.lobbyChat.open));
    els.lobbyChatBubble?.setAttribute('aria-expanded', String(ui.lobbyChat.open));
    if (ui.lobbyChat.open) {
      ui.lobbyChat.unread = 0;
      renderLobbyChat();
      if (!ui.lobbyChat.joined) {
        els.lobbyChatProfile?.classList.remove('hidden');
        els.lobbyChatContent?.classList.add('hidden');
        els.lobbyChatTos.checked = tosAccepted();
        els.lobbyChatName.value = ui.playerName || localStorage.getItem('montecristo-lobby-name') || '';
        setTimeout(() => els.lobbyChatName?.focus(), 0);
      } else els.lobbyChatInput?.focus();
    }
    renderLobbyChat();
  }

  function renderLobbyChat() {
    if (!els.lobbyChatMessages) return;
    const messages = ui.lobbyChat.messages || [];
    els.lobbyChatMessages.innerHTML = messages.length
      ? messages.map(message => {
        const botClass = message.bot ? ' lobby-chat-message-bot' : '';
        const botBadge = message.bot ? ' <span class="lobby-chat-bot-badge" aria-label="asistente automático">BOT</span>' : '';
        const reportButton = message.playerId && !message.system
          ? `<button type="button" class="chat-report" aria-label="Reportar el mensaje de ${escapeHtml(message.name)}" data-report-message="${escapeHtml(message.id)}">⚑ Reportar</button>`
          : '';
        return `<div class="lobby-chat-message${botClass}"><span class="lobby-chat-avatar" style="background:${avatarColor(message.playerId)}">${avatarEmoji(message.avatar)}</span><div><b>${escapeHtml(message.name)}${botBadge}</b><p>${escapeHtml(message.text)}</p>${reportButton}</div></div>`;
      }).join('')
      : '<div class="lobby-chat-empty">Sé el primero en saludar al casino.</div>';
    els.lobbyChatMessages.scrollTop = els.lobbyChatMessages.scrollHeight;
    const unread = Number(ui.lobbyChat.unread) || 0;
    els.lobbyChatUnread?.classList.toggle('hidden', unread < 1);
    if (els.lobbyChatUnread) els.lobbyChatUnread.textContent = unread > 99 ? '99+' : String(unread);
    els.lobbyChatProfile?.classList.toggle('hidden', ui.lobbyChat.joined || !ui.lobbyChat.open);
    els.lobbyChatContent?.classList.toggle('hidden', !ui.lobbyChat.joined);
  }

  async function joinLobbyChat(name, accepted = true, silent = false) {
    name = String(name || '').trim();
    if (!name) {
      if (!silent) setLobbyChatOpen(true);
      return { ok: false, error: 'Elige un apodo para entrar al chat del casino.' };
    }
    if (!tosAccepted() || !accepted) {
      if (!silent) showTosModal();
      return { ok: false, error: 'Debes aceptar los Términos y Condiciones vigentes.' };
    }
    if (ui.lobbyChat.joining) return { ok: false, error: 'Conectando al chat…' };
    ui.lobbyChat.joining = true;
    const response = await emitAck('lobby_chat_join', { token: deviceToken, name, tos: localStorage.getItem(TOS_KEY) });
    ui.lobbyChat.joining = false;
    if (!response.ok) {
      if (!silent) showToast('No se pudo entrar al chat', response.error, 'error');
      return response;
    }
    ui.lobbyChat.joined = true;
    ui.lobbyChat.messages = Array.isArray(response.messages) ? response.messages : [];
    ui.lobbyChat.unread = 0;
    const canonicalName = response.name || name;
    localStorage.setItem('montecristo-lobby-name', canonicalName);
    localStorage.setItem('montecristo-name', canonicalName);
    ui.playerName = canonicalName;
    els.playerName.value = canonicalName;
    els.lobbyChatName.value = canonicalName;
    saveSession();
    renderLobbyChat();
    return response;
  }

  function tryAutoJoinLobbyChat() {
    // `montecristo-name` es la identidad canónica y se actualiza al guardar el
    // perfil. La clave histórica del chat puede contener un apodo anterior;
    // usarla primero hacía que el autoingreso renombrara el perfil hacia atrás.
    const savedName = ui.playerName || localStorage.getItem('montecristo-lobby-name');
    if (!savedName || !tosAccepted() || ui.room || routeCode) return;
    joinLobbyChat(savedName, true, true);
  }

  // ---------- Connection ----------
  function setConnection(status) {
    ui.connection = status;
    const copy = {
      connected: ['Conectado', 'En vivo'], reconnecting: ['Reconectando', 'Reconectando'],
      disconnected: ['Desconectado', 'Sin conexión'], connecting: ['Conectando', 'Conectando']
    }[status] || ['Conectando', 'Conectando'];
    [els.navConnection, els.headerConnection, els.connectionStatus].forEach(element => {
      if (!element) return;
      element.classList.remove('connected', 'reconnecting', 'disconnected', 'connecting');
      element.classList.add(status);
      const span = element.querySelector('span');
      if (span) span.textContent = element === els.navConnection ? copy[0] : copy[1];
      else element.innerHTML = `<i></i> ${copy[0]}`;
    });
  }

  // Fase 7: arranque en frío de Render — el plan free suspende el servicio tras ~15 min
  // de inactividad y despertar tarda ~50 s. La pantalla de carga lo explica con reintentos visibles.
  const loaderHelper = document.querySelector('.loader-helper');
  const defaultLoaderHelp = loaderHelper ? loaderHelper.innerHTML : '';
  function setColdStartHint(active, attempt = 0) {
    if (!loaderHelper) return;
    loaderHelper.innerHTML = active
      ? `<span></span> El hosting puede tardar hasta un minuto en despertar tras un rato sin visitas.${attempt > 1 ? ` Reintento ${attempt}…` : ' Gracias por la paciencia.'}`
      : defaultLoaderHelp;
  }
  setTimeout(() => {
    if (!socket.connected) { setOverlay(true, 'DESPERTANDO LA SALA…'); setColdStartHint(true); }
  }, 8000);

  socket.on('connect', async () => {
    setConnection('connected');
    setColdStartHint(false);
    tryAutoJoinLobbyChat();
    setTimeout(() => { if (!ui.joining) setOverlay(false); }, 350);
    // Reconectar (o la primera conexión) nunca cambia el botón de cuenta por su
    // cuenta: si hay sesión cacheada se sigue mostrando "Perfil" de inmediato
    // (ya ocurrió en el arranque, vía renderAccountButton()); esto solo intenta
    // refrescar los datos públicos en segundo plano, sin tocar el estado visual
    // si falla.
    if (ui.accountSession) refreshAccountProfile();
    if (ui.shouldResume && ui.activeCode && ui.playerName) {
      ui.shouldResume = false;
      ui.joining = true;
      setOverlay(true, ui.spectating ? 'VOLVIENDO A LA TRIBUNA' : 'RECUPERANDO TU ASIENTO');
      const response = await emitAck(ui.spectating ? 'spectate_room' : 'join_room', { name: ui.playerName, code: ui.activeCode, token: deviceToken, avatar: ui.selectedAvatar, tos: localStorage.getItem(TOS_KEY) });
      ui.joining = false;
      if (!response.ok) {
        // La mesa ya no existe en el servidor (p. ej. el servicio se reinició
        // mientras dormía la conexión). Antes solo se borraba la sesión guardada
        // pero NO ui.room: quedaba una "mesa fantasma" en pantalla desde la que
        // se podía abrir el perfil, y cualquier edición (nombre o vitrina de
        // logros) respondía "Perfil no disponible." porque el servidor ya no
        // tiene a nadie sentado ahí. Se sale a la landing como leaveToLobby.
        leaveToLobby(false);
        setOverlay(false);
        showToast('No pudimos recuperar la mesa', response.error, 'error');
        openModal('join', { code: routeCode });
      }
    } else if (routeCode && !ui.room && !els.modal.classList.contains('open')) {
      setTimeout(() => openModal('join', { code: routeCode }), 450);
    }
  });
  socket.on('disconnect', () => {
    setConnection('disconnected');
    if (ui.room) showToast('Conexión interrumpida', 'Intentaremos devolverte a la mesa automáticamente.', 'error', 5000);
  });
  socket.io.on('reconnect_attempt', attempt => {
    setConnection('reconnecting');
    if (ui.room || ui.activeCode) {
      ui.shouldResume = true;
      setOverlay(true, attempt > 1 ? 'DESPERTANDO LA SALA…' : 'RECONECTANDO CON LA MESA');
      if (attempt > 1) setColdStartHint(true, attempt);
    } else if (attempt > 1) {
      setOverlay(true, 'DESPERTANDO LA SALA…');
      setColdStartHint(true, attempt);
    }
  });
  socket.io.on('reconnect_failed', () => { setConnection('disconnected'); setOverlay(false); });
  socket.on('connect_error', () => { setConnection('reconnecting'); });

  // ---------- Modal and landing ----------
  function updateTableSetupPreview() {
    const selected = $$('[data-select-game]').find(button => button.dataset.selectGame === ui.selectedGame);
    if (els.setupPreviewSymbol) els.setupPreviewSymbol.textContent = selected?.querySelector('span')?.textContent.trim() || GAME_META[ui.selectedGame]?.icon || '♠';
    if (els.setupPreviewTitle) els.setupPreviewTitle.textContent = selected?.querySelector('b')?.textContent.trim() || GAME_META[ui.selectedGame]?.name || 'Mesa MonteCristo';
    if (els.setupPreviewDetail) els.setupPreviewDetail.textContent = selected?.querySelector('small')?.textContent.trim() || 'Juega con tu grupo';
    if (els.setupPreviewAvatar) els.setupPreviewAvatar.textContent = avatarEmoji(ui.selectedAvatar);
  }
  function openModal(mode = 'create', options = {}) {
    ui.modalMode = mode;
    ui.selectedGame = options.game === 'blackjack' ? 'blackjack' : (options.game || ui.selectedGame || 'poker');
    els.playerName.value = ui.playerName || localStorage.getItem('montecristo-name') || '';
    els.roomCode.value = options.code || '';
    els.roomName.value = options.roomName || '';
    const spectating = mode === 'spectate'; // Fase 8: entrar como espectador
    const joining = mode === 'join' || spectating;
    els.modal.dataset.mode = spectating ? 'spectate' : joining ? 'join' : 'create';
    els.modalKicker.textContent = spectating ? 'VER UNA MESA' : joining ? 'UNIRSE A UNA MESA' : 'NUEVA SALA';
    els.modalTitle.textContent = spectating ? 'Entra a la tribuna' : joining ? 'Toma tu asiento' : 'Prepara la mesa';
    els.modalSubtitle.textContent = spectating
      ? 'Verás la partida en vivo sin ocupar asiento, con el chat abierto. Nadie ve cartas ajenas.'
      : joining
        ? 'Escribe tu nombre y el código para entrar a la partida en vivo.'
        : 'Configura tu partida. Podrás invitar a tus amigos cuando entres.';
    if (els.modalSymbol) els.modalSymbol.textContent = spectating ? '👁' : joining ? '⌁' : (GAME_META[ui.selectedGame]?.icon || '♠');
    els.roomNameField.classList.toggle('hidden', joining);
    els.gameChoice.classList.toggle('hidden', joining);
    els.codeField.classList.toggle('hidden', !joining);
    els.modalSubmit.querySelector('.btn-label').textContent = spectating ? 'Ver la mesa' : joining ? 'Entrar a la sala' : 'Crear sala';
    $$('[data-select-game]').forEach(button => {
      const selected = button.dataset.selectGame === ui.selectedGame;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    $$('[data-select-avatar]').forEach(button => {
      const selected = button.dataset.selectAvatar === ui.selectedAvatar;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    updateTableSetupPreview();
    els.modal.classList.add('open');
    els.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    setTimeout(() => (els.playerName.value ? (joining ? els.roomCode : els.roomName) : els.playerName).focus(), 80);
  }
  function closeModal() {
    els.modal.classList.remove('open');
    els.modal.setAttribute('aria-hidden', 'true');
    if (!ui.profileOpen) document.body.classList.remove('modal-open');
    setButtonLoading(els.modalSubmit, false);
  }
  $$('[data-open-mode]').forEach(button => button.addEventListener('click', () => openModal(button.dataset.openMode, { game: button.dataset.game })));
  $$('[data-close-modal]').forEach(element => element.addEventListener('click', closeModal));
  $$('[data-select-game]').forEach(button => button.addEventListener('click', () => {
    ui.selectedGame = button.dataset.selectGame;
    if (els.modalSymbol) els.modalSymbol.textContent = GAME_META[ui.selectedGame]?.icon || '♠';
    $$('[data-select-game]').forEach(item => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    updateTableSetupPreview();
  }));
  $$('[data-select-avatar]').forEach(button => button.addEventListener('click', () => {
    ui.selectedAvatar = button.dataset.selectAvatar;
    localStorage.setItem('montecristo-avatar', ui.selectedAvatar);
    $$('[data-select-avatar]').forEach(item => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    updateTableSetupPreview();
  }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); closeProfileModal(); closeAccountModal(); toggleShortcutHelp(false); } });
  // Fases 5 y 6: saltar animaciones (botones presentes en mesa o panel de acciones)
  document.addEventListener('click', event => {
    if (!event.target.closest) return;
    if (event.target.closest('[data-roulette-skip]') && ui.rouletteSpin) ui.rouletteSpin.skip = true;
    if (event.target.closest('[data-slots-skip]') && ui.slotsSpin) ui.slotsSpin.skip = true;
  });

  // ---------- Atajos de teclado en mesa (fase 4) ----------
  function toggleShortcutHelp(force) {
    const panel = document.getElementById('shortcut-help');
    if (!panel) return;
    const show = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !show);
  }
  function pressButton(selector) {
    const element = document.querySelector(selector);
    if (element && !element.disabled) { element.click(); return true; }
    return false;
  }
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target && target.id === 'raise-amount' && event.key === 'Enter') { event.preventDefault(); pressButton('[data-poker-action="raise"]'); return; }
    if (target && target.id === 'quick-bet-amount' && event.key === 'Enter') { event.preventDefault(); pressButton('[data-quick-bet]'); return; }
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (event.key === '?') { event.preventDefault(); toggleShortcutHelp(); return; }
    if (!ui.room) return;
    const key = event.key.toLowerCase();
    if (key === 'f') pressButton('[data-poker-action="fold"]');
    else if (key === 'c') { if (!pressButton('[data-poker-action="check"]')) pressButton('[data-poker-action="call"]'); }
    else if (key === 'r') { const input = document.getElementById('raise-amount'); if (input) { event.preventDefault(); input.focus(); input.select?.(); } }
    else if (key === 'a') pressButton('[data-poker-action="allin"]');
    else if (key === 'h') pressButton('[data-event="blackjack_hit"]');
    else if (key === 's') pressButton('[data-event="blackjack_stand"]');
    else if (key === 'd') pressButton('[data-event="blackjack_double"]');
    else if (key === 'enter') pressButton('[data-quick-bet]');
    else if (key === 't') { if (els.chatInput) { event.preventDefault(); els.chatInput.focus(); } }
  });

  els.form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = els.playerName.value.trim();
    if (!name) { showToast('Falta tu nombre', 'Dinos cómo aparecerás en la mesa.', 'error'); els.playerName.focus(); return; }
    ui.playerName = name;
    localStorage.setItem('montecristo-name', name);
    if (!tosAccepted()) {
      showToast('Falta un paso', 'Acepta los Términos y Condiciones para entrar a la mesa.', 'error', 5000);
      showTosModal();
      return;
    }
    setButtonLoading(els.modalSubmit, true);
    ui.joining = true;
    const spectating = ui.modalMode === 'spectate';
    const joining = ui.modalMode === 'join' || spectating;
    const code = els.roomCode.value.trim().toUpperCase();
    if (joining && !/^[A-Z0-9]{5}$/.test(code)) {
      setButtonLoading(els.modalSubmit, false); ui.joining = false;
      showToast('Código incompleto', 'Los códigos de sala tienen cinco caracteres.', 'error'); return;
    }
    setOverlay(true, spectating ? 'ENTRANDO A LA TRIBUNA' : joining ? 'BUSCANDO TU ASIENTO' : 'ABRIENDO UNA NUEVA MESA');
    const response = joining
      ? await emitAck(spectating ? 'spectate_room' : 'join_room', { name, code, token: deviceToken, avatar: ui.selectedAvatar, tos: localStorage.getItem(TOS_KEY) })
      : await emitAck('create_room', { name, roomName: els.roomName.value.trim(), game: ui.selectedGame, token: deviceToken, avatar: ui.selectedAvatar, tos: localStorage.getItem(TOS_KEY) });
    setButtonLoading(els.modalSubmit, false); ui.joining = false;
    if (!response.ok) {
      setOverlay(false); showToast('No se pudo entrar', response.error || 'Intenta de nuevo.', 'error'); return;
    }
    ui.spectating = spectating;
    ui.activeCode = response.code;
    saveSession(); updateHistory(response.code); closeModal();
    // room_state completes the visual transition.
    setTimeout(() => { if (ui.room) setOverlay(false); }, 450);
  });

  // ---------- Live lobby ----------
  socket.on('lobby_state', payload => {
    ui.lobby = Array.isArray(payload?.rooms) ? payload.rooms : [];
    ui.playersOnline = Number(payload?.playersOnline) || 0;
    ui.season = payload?.season || ui.season || null; // Fase 8.6
    renderLobby();
    renderSeasonRanking();
  });

  // Fase 8.6: ranking mensual en el lobby (los puntos se reinician cada mes).
  function renderSeasonRanking() {
    const panel = $('#season-ranking');
    if (!panel) return;
    const season = ui.season;
    if (!season || !Array.isArray(season.ranking) || !season.ranking.length) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    const [year, month] = String(season.month || '').split('-');
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const monthName = monthNames[Number(month) - 1] || season.month;
    $('#ranking-title').textContent = `Temporada de ${monthName} ${year || ''}`.trim();
    const posIcons = ['🥇', '🥈', '🥉'];
    // Fase 11.4: junto al nombre, el banner dorado (único, de por vida) y las
    // medallas de oro (una por cada temporada ganada, se coleccionan).
    const badgesFor = entry => `${entry.championBanner ? '<span class="ranking-champion-flag" title="Banner dorado de por vida: fue líder de una temporada">🎖️</span>' : ''}${entry.medals ? `<span class="ranking-medals" title="${entry.medals} temporada${entry.medals === 1 ? '' : 's'} ganada${entry.medals === 1 ? '' : 's'}">🥇×${entry.medals}</span>` : ''}`;
    const leader = season.ranking[0];
    const feature = $('#ranking-feature');
    feature.innerHTML = leader ? `
      <div class="ranking-feature-top"><span>LÍDER DE TEMPORADA</span><i>♛</i></div>
      <div class="ranking-feature-player"><span class="ranking-feature-avatar">${avatarEmoji(leader.avatar)}</span><div><small>PRIMER LUGAR</small><b>${escapeHtml(leader.name)}${badgesFor(leader)}</b></div></div>
      <div class="ranking-feature-balance"><b>◆ ${formatChips(leader.chips)}</b><small>FICHAS EN TEMPORADA</small></div>
      <div class="ranking-feature-footer"><span>Victorias</span><b>${formatChips(leader.wins || 0)}</b></div>` : '';
    $('#ranking-list').innerHTML = season.ranking.map((entry, index) => `
      <div class="ranking-row ${index === 0 ? 'leader' : ''}" role="row">
        <span class="ranking-pos" role="cell">${posIcons[index] || `#${index + 1}`}</span>
        <span class="ranking-player" role="cell"><span class="ranking-avatar">${avatarEmoji(entry.avatar)}</span><span class="ranking-name">${escapeHtml(entry.name)}${badgesFor(entry)}</span></span>
        <span class="ranking-wins" role="cell"><b>${formatChips(entry.wins || 0)}</b><small>${entry.wins === 1 ? 'victoria' : 'victorias'}</small></span>
        <span class="ranking-chips" role="cell"><b>◆ ${formatChips(entry.chips)}</b><small>fichas</small></span>
      </div>`).join('');
    const previousBox = $('#ranking-previous');
    if (season.previous?.podium?.length) {
      const previousMonth = escapeHtml(season.previous.month || 'la temporada anterior');
      previousBox.classList.remove('hidden');
      previousBox.innerHTML = `
        <div class="previous-podium-heading"><div><span class="kicker">PODIO ANTERIOR</span><b>${previousMonth}</b></div><small>Clasificación final · fichas virtuales</small></div>
        <div class="previous-podium-grid" role="list" aria-label="Podio de ${previousMonth}">
          ${season.previous.podium.map((entry, index) => `
            <div class="previous-podium-place place-${index + 1}" role="listitem">
              <span class="previous-podium-rank">${posIcons[index] || `#${index + 1}`}</span>
              <span class="previous-podium-avatar">${avatarEmoji(entry.avatar)}</span>
              <div class="previous-podium-info"><b>${escapeHtml(entry.name)}${badgesFor(entry)}</b><span>◆ ${formatChips(entry.chips)} <small>FICHAS</small></span></div>
            </div>`).join('')}
        </div>`;
    } else previousBox.classList.add('hidden');
  }

  function renderLobby() {
    els.liveRoomCount.textContent = ui.lobby.length;
    els.onlinePlayerCount.textContent = ui.playersOnline;
    els.heroOnlineCount.textContent = ui.playersOnline;
    const rooms = ui.lobby.filter(room => ui.roomFilter === 'all' || room.game === ui.roomFilter);
    if (!rooms.length) {
      els.liveRooms.innerHTML = `<div class="rooms-empty"><b>No hay mesas ${ui.roomFilter === 'all' ? 'abiertas todavía' : 'de este juego'}</b><span>Sé quien inaugure el lobby.</span><button class="btn btn-primary" data-empty-create>Crear la primera sala</button></div>`;
      els.liveRooms.querySelector('[data-empty-create]')?.addEventListener('click', () => openModal('create', { game: GAME_META[ui.roomFilter] ? ui.roomFilter : 'poker' }));
      return;
    }
    els.liveRooms.innerHTML = rooms.map((room, index) => {
      const playerTotal = Math.max(0, Number(room.players) || 0);
      const capacity = Math.max(1, Number(room.capacity) || 6);
      const full = playerTotal >= capacity;
      const freeSeats = Math.max(0, capacity - playerTotal);
      const avatars = Array.from({ length: Math.min(playerTotal, 3) }, () => '<i></i>').join('');
      const meta = GAME_META[room.game] || GAME_META.poker;
      const occupancy = Math.round(Math.min(1, playerTotal / capacity) * 100);
      return `<article class="live-room ${room.game}" data-suit="${meta.icon}" style="--occupancy:${occupancy}%;animation-delay:${index * 35}ms">
        <div class="live-room-top"><span class="room-game-tag">${meta.icon} ${meta.name}</span><span class="room-phase"><i></i>${escapeHtml(phaseText(room.phase).toUpperCase())}</span></div>
        <h3>${escapeHtml(room.name || 'Mesa sin nombre')}</h3><span class="live-room-host">Anfitrión: ${escapeHtml(room.host || '—')}</span>
        <div class="room-capacity-bar" aria-label="Ocupación ${playerTotal} de ${capacity}"><i></i></div>
        <div class="live-room-bottom"><div class="room-occupancy"><div class="room-avatar-stack">${avatars}</div><div><b>${playerTotal} de ${capacity}</b><small>${full ? 'Mesa completa' : `${freeSeats} asiento${freeSeats === 1 ? '' : 's'} libre${freeSeats === 1 ? '' : 's'}`}${room.bots ? ` · 🤖 ${room.bots}` : ''}</small></div></div>
        <button class="join-live-room${full ? ' spectate-room' : ''}" data-live-code="${escapeHtml(room.code)}" data-live-full="${full ? '1' : ''}" aria-label="${full ? `Ver ${escapeHtml(room.name || 'la mesa')} como espectador` : `Entrar a ${escapeHtml(room.name || 'la mesa')}`}">${full ? '👁 Ver mesa' : 'Tomar asiento →'}</button></div>
      </article>`;
    }).join('');
    observeLobbyCards();
    $$('[data-live-code]').forEach(button => button.addEventListener('click', () => openModal(button.dataset.liveFull ? 'spectate' : 'join', { code: button.dataset.liveCode })));
  }
  $$('[data-room-filter]').forEach(button => {
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(button.classList.contains('active')));
    button.addEventListener('click', () => {
      ui.roomFilter = button.dataset.roomFilter;
      $$('[data-room-filter]').forEach(item => {
        const selected = item === button;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', String(selected));
      });
      renderLobby();
    });
  });

  // ---------- Chat común del lobby ----------
  socket.on('lobby_chat', payload => {
    if (Array.isArray(payload?.messages)) {
      ui.lobbyChat.messages = payload.messages;
      ui.lobbyChat.joined = true;
      renderLobbyChat();
    }
  });
  socket.on('lobby_chat_message', message => {
    if (!message?.id) return;
    if (!ui.lobbyChat.messages.some(item => item.id === message.id)) ui.lobbyChat.messages.push(message);
    ui.lobbyChat.messages = ui.lobbyChat.messages.slice(-60);
    if (!ui.lobbyChat.open && message.playerId !== deviceToken) {
      ui.lobbyChat.unread += 1;
      if (!ui.room) showToast('Nuevo mensaje en el lobby', `${message.name}: ${message.text}`, 'notice', 4200, '💬', true);
    }
    renderLobbyChat();
  });

  // ---------- Room state ----------
  socket.on('room_state', room => {
    const wasOutside = !ui.room;
    const previous = ui.room;
    // Fases 5 y 6: al pasar de 'rolling' a 'results', la animación representa el resultado autoritativo.
    if (previous && previous.code === room.code && previous.phase === 'rolling' && room.phase === 'results' && room.quickResult) {
      if (room.game === 'roulette' && !ui.rouletteSpin) startRouletteSpin(room.quickResult.value);
      if (room.game === 'slots' && !ui.slotsSpin) startSlotsSpin(room.quickResult.reels);
    }
    ui.room = room;
    // Red de seguridad: si llegó el estado de resultados pero esta mesa no
    // está animando el descubrimiento (otro juego, o una reconexión directa
    // en fase de resultados), los avisos retenidos se muestran ya — no hay
    // animación que esperar.
    if (ui.resultQueue.length && !quickResultHold()) flushResultQueue();
    ui.activeCode = room.code;
    ui.me = room.players.find(player => player.id === deviceToken) || (room.viewerSpectator ? null : room.players.find(player => player.name === ui.playerName)) || null;
    ui.spectating = Boolean(room.viewerSpectator) && !ui.me; // Fase 8: modo espectador
    if (ui.me) {
      ui.playerName = ui.me.name;
      ui.selectedAvatar = ui.me.avatar || ui.selectedAvatar;
      localStorage.setItem('montecristo-name', ui.playerName);
      localStorage.setItem('montecristo-lobby-name', ui.playerName);
      localStorage.setItem('montecristo-avatar', ui.selectedAvatar);
    }
    saveSession();
    if (wasOutside) enterRoom();
    renderRoom();
    setOverlay(false);
  });

  // Fase 8: la mesa fue cerrada por el servidor (sin jugadores humanos); regresar a la portada.
  socket.on('room_closed', ({ code } = {}) => {
    if (!ui.activeCode || ui.activeCode !== code) return;
    showToast('Mesa cerrada', 'La mesa quedó sin jugadores y fue cerrada.', 'error', 4200);
    leaveToLobby(false);
  });

  function enterRoom() {
    closeModal();
    setLobbyChatOpen(false);
    els.lobbyChatWidget?.classList.add('in-room');
    els.landing.classList.add('leaving');
    setTimeout(() => {
      els.landing.classList.add('hidden');
      els.landing.classList.remove('leaving');
      els.roomApp.classList.remove('hidden');
      window.scrollTo(0, 0);
    }, 250);
  }
  function renderRoom() {
    const room = ui.room;
    if (!room) return;
    ui.me = room.players.find(player => player.id === deviceToken) || ui.me;
    if (room.viewerProfile) {
      ui.selectedAvatar = room.viewerProfile.avatar || ui.selectedAvatar;
      ui.profileAvatar = ui.selectedAvatar;
      localStorage.setItem('montecristo-avatar', ui.selectedAvatar);
    }
    const gameMeta = GAME_META[room.game] || GAME_META.poker;
    els.gameName.textContent = `${gameMeta.icon} ${gameMeta.name}`;
    els.phaseLabel.textContent = phaseText(room.phase).toUpperCase();
    els.roomTitle.textContent = room.name || `Sala ${room.code}`;
    els.headerCode.textContent = room.code;
    const connectedCount = room.players.filter(player => player.connected).length;
    els.playerCount.textContent = `${connectedCount} / 6`;
    els.roomApp.dataset.game = room.game;
    els.roomApp.classList.toggle('my-turn', room.turnId === ui.me?.id);
    renderBotControls();
    renderProfile();
    renderPlayers();
    renderChat();
    renderStatus();
    renderSocialMeta();
    renderTournamentBanner(room);
    if (ui.profileOpen) renderProfileModal();
    const gameSignature = JSON.stringify([
      room.game, room.phase, room.turnId, room.turnDeadline, room.dealerHand, room.community, room.pot, room.tournament,
      room.currentBet, room.minRaise, room.dealerIndex, room.handNumber, room.results, room.quickResult, room.specialEvent,
      room.players.map(p => [p.id, p.name, p.avatar, p.chips, p.hand, p.bet, p.quickChoice, p.roundBet, p.totalBet, p.status, p.folded, p.allIn, p.connected, p.isBot, p.bot?.thinking, p.bot?.lastActionAt])
    ]);
    if (gameSignature !== ui.lastGameSignature) {
      ui.lastGameSignature = gameSignature;
      renderTable(); renderActions();
    }
    updateClock();
  }
  // Fase 8.1: banner del torneo sit & go sobre la mesa.
  function renderTournamentBanner(room) {
    if (!els.tournamentBanner) return;
    const t = room.tournament;
    if (!t || (!t.active && !t.winnerName)) {
      els.tournamentBanner.classList.add('hidden');
      els.tournamentBanner.innerHTML = '';
      return;
    }
    els.tournamentBanner.classList.remove('hidden');
    if (t.active) {
      const handsLeft = Math.max(1, t.handsPerLevel - t.handsAtLevel);
      els.tournamentBanner.innerHTML = `
        <span class="tb-title">🏆 TORNEO SIT &amp; GO</span>
        <span class="tb-item">Nivel <b>${t.level}</b> · Ciegas <b>${formatChips(t.blinds.small)}/${formatChips(t.blinds.big)}</b></span>
        <span class="tb-item">Bote <b class="tb-gold">◆ ${formatChips(t.prize)}</b></span>
        <span class="tb-item"><b>${t.remaining}</b> en juego</span>
        <span class="tb-item">Ciegas suben en <b>${handsLeft}</b> ${handsLeft === 1 ? 'mano' : 'manos'}</span>`;
    } else {
      els.tournamentBanner.innerHTML = `
        <span class="tb-title">🏆 TORNEO TERMINADO</span>
        <span class="tb-item">Campeón: <b>${escapeHtml(t.winnerName)}</b> · Se llevó <b class="tb-gold">◆ ${formatChips(t.prize)}</b></span>`;
    }
  }
  function renderBotControls() {
    const room = ui.room;
    const isHost = Boolean(ui.me?.isHost);
    const locked = isPokerActive(room) || room.phase === 'playing' || room.phase === 'rolling';
    const full = room.players.length >= (room.botOptions?.capacity || 6);
    els.botMenuToggle?.classList.toggle('hidden', !isHost);
    if (!isHost) {
      els.botControls?.classList.add('hidden');
      els.botMenuToggle?.setAttribute('aria-expanded', 'false');
    }
    if (els.botAdd) { els.botAdd.disabled = locked || full; els.botAdd.title = locked ? 'Disponible al terminar la ronda' : full ? 'La mesa está llena' : ''; }
    if (els.botFill) { els.botFill.disabled = locked || full; els.botFill.title = locked ? 'Disponible al terminar la ronda' : full ? 'La mesa está llena' : ''; }
  }
  function renderProfile() {
    if (!ui.me) {
      // Fase 8: tarjeta reducida para espectadores.
      if (ui.spectating && ui.room?.viewerSpectator) {
        const spectator = ui.room.viewerSpectator;
        els.profileCard.innerHTML = `<div class="profile-avatar" style="background:${avatarColor(spectator.id)}">${avatarEmoji(spectator.avatar)}</div>
          <div class="profile-info"><small>👁 ESPECTADOR</small><b>${escapeHtml(spectator.name || ui.playerName)}</b><span>Viendo la mesa en vivo</span></div>`;
      } else els.profileCard.innerHTML = '';
      return;
    }
    const stats = ui.room?.viewerProfile?.stats || ui.me.stats || {};
    const previous = ui.lastMeChips;
    const delta = previous == null ? 0 : Number(ui.me.chips) - previous;
    els.profileCard.innerHTML = `<div class="profile-avatar" style="background:${avatarColor(ui.me.id)}">${avatarEmoji(ui.me.avatar)}</div>
      <div class="profile-info"><small>TU PERFIL · ${formatChips(stats.wins || 0)} VICTORIAS</small><b>${escapeHtml(ui.me.name)}</b><span><strong>◆</strong> ${formatChips(ui.me.chips)} fichas ${delta > 0 ? `<em class="chip-delta">+${formatChips(delta)}</em>` : ''}</span></div>`;
    if (delta > 0) {
      els.profileCard.classList.remove('chips-received');
      requestAnimationFrame(() => els.profileCard.classList.add('chips-received'));
    } else els.profileCard.classList.remove('chips-received');
    ui.lastMeChips = Number(ui.me.chips);
  }
  function renderPlayers() {
    const room = ui.room;
    const ranked = [...room.players].sort((a, b) => b.chips - a.chips || a.seat - b.seat);
    const nextRanks = new Map(ranked.map((player, index) => [player.id, index + 1]));
    els.playersList.innerHTML = ranked.map((player, index) => {
      const rank = index + 1;
      const oldRank = ui.previousRanks.get(player.id);
      const rankClass = oldRank && oldRank > rank ? 'up' : oldRank && oldRank < rank ? 'down' : '';
      const rankCopy = rankClass === 'up' ? '▲' : rankClass === 'down' ? '▼' : '—';
      const isTurn = player.id === room.turnId;
      const botThinking = Boolean(player.isBot && player.bot?.thinking);
      const recentBotAction = player.isBot && player.bot?.lastAction && Date.now() - Number(player.bot.lastActionAt || 0) < 4500;
      const bet = room.game === 'poker' ? player.roundBet : player.bet;
      const status = !player.connected ? 'Desconectado' : player.status === 'eliminated' ? '🏆 Eliminado del torneo' : botThinking ? 'Pensando…' : recentBotAction ? player.bot.lastAction : isTurn ? 'Pensando…' : player.status === 'winner' ? 'Ganador' : player.status === 'lost' ? 'Ronda perdida' : player.status === 'folded' ? 'Se retiró' : player.allIn ? 'All-in' : `${formatChips(player.chips)} fichas`;
      const oldChips = ui.previousChips.get(player.id);
      const chipsClass = oldChips != null && player.chips > oldChips ? 'chips-up' : oldChips != null && player.chips < oldChips ? 'chips-down' : '';
      const botBadge = player.isBot ? '<span class="bot-badge">🤖 BOT</span>' : '';
      const botDescriptor = player.isBot ? `<span class="bot-descriptor">${escapeHtml(player.bot?.difficultyLabel || 'Normal')} · ${escapeHtml(player.bot?.styleLabel || 'Equilibrado')}</span>` : '';
      const removeControl = ui.me?.isHost && player.id !== ui.me.id
        ? player.isBot ? `<button class="kick-btn remove-bot-btn" data-remove-bot="${escapeHtml(player.id)}" title="Retirar bot">×</button>` : `<button class="kick-btn" data-kick="${escapeHtml(player.id)}" title="Retirar jugador">×</button>`
        : '';
      return `<div class="player-row ${player.isBot ? 'bot-player' : ''} ${isTurn ? 'turn' : ''} ${botThinking ? 'bot-thinking' : ''} ${rank === 1 ? 'rank-leader' : ''} ${chipsClass}">
        <span class="player-rank ${rank === 1 ? 'top' : ''}">${rank === 1 ? '♛' : '#' + rank}</span>
        ${avatarMarkup(player)}
        <div class="player-meta"><b>${escapeHtml(player.name)}${botBadge} ${player.id === ui.me?.id ? '<small>(tú)</small>' : ''}</b>${botDescriptor}<span>${escapeHtml(status)}</span>${bet ? `<span class="player-bet-mini">◆ ${formatChips(bet)} en juego</span>` : ''}</div>
        <span class="rank-change ${rankClass}">${rankCopy}</span>
        ${player.isHost ? '<span class="host-crown" title="Anfitrión">♛</span>' : ''}${removeControl}
      </div>`;
    }).join('');
    // Fase 8: tribuna de espectadores conectados.
    const spectators = room.spectators || [];
    if (spectators.length) {
      const names = spectators.map(spectator => escapeHtml(spectator.name)).join(', ');
      els.playersList.insertAdjacentHTML('beforeend', `<div class="spectators-row" title="Espectadores conectados">👁 Tribuna (${spectators.length}): ${names}</div>`);
    }
    ui.previousRanks = nextRanks;
    ui.previousChips = new Map(room.players.map(player => [player.id, Number(player.chips)]));
    $$('[data-kick]').forEach(button => button.addEventListener('click', async () => {
      const response = await emitAck('kick_player', { playerId: button.dataset.kick }, button);
      if (!response.ok) showToast('No se pudo retirar', response.error, 'error');
    }));
    $$('[data-remove-bot]').forEach(button => button.addEventListener('click', async () => {
      const response = await emitAck('bot_remove', { botId: button.dataset.removeBot }, button);
      if (!response.ok) showToast('No se pudo retirar el bot', response.error, 'error');
    }));
  }
  function renderChat() {
    const messages = ui.room.messages || [];
    const signature = messages.map(message => message.id).join('|');
    if (signature === ui.lastChatSignature) return;
    ui.lastChatSignature = signature;
    els.chatList.innerHTML = messages.length ? messages.map(message => message.system
      ? `<div class="chat-system">${escapeHtml(message.text)}</div>`
      : `<div class="chat-msg"><div class="chat-avatar" style="background:${avatarColor(message.playerId)}">${avatarEmoji(ui.room.players.find(player => player.id === message.playerId)?.avatar)}</div><div class="chat-bubble"><b>${escapeHtml(message.name)}</b><p>${escapeHtml(message.text)}</p>${message.playerId ? `<button type="button" class="chat-report" aria-label="Reportar el mensaje de ${escapeHtml(message.name)}" data-report-message="${escapeHtml(message.id)}">⚑ Reportar</button>` : ''}</div></div>`).join('')
      : '<div class="chat-system">El chat está listo para la primera jugada.</div>';
    els.chatList.scrollTop = els.chatList.scrollHeight;
  }
  function renderStatus() {
    const room = ui.room;
    const current = room.players.find(player => player.id === room.turnId);
    let copy = '';
    if (room.phase === 'waiting') copy = 'Esperando a que el anfitrión inicie la mano';
    else if (room.phase === 'betting') copy = 'Elige tus fichas y confirma tu apuesta';
    else if (room.phase === 'rolling') copy = '<strong>Resultado en camino…</strong> el servidor está resolviendo la ronda';
    else if (room.phase === 'results' || room.phase === 'showdown') copy = `Ronda ${room.handNumber} completada`;
    else if (current) copy = current.id === ui.me?.id ? '<strong>Tu turno:</strong> elige una jugada' : `Turno de <strong>${escapeHtml(current.name)}</strong>`;
    else copy = `${phaseText(room.phase)} en curso`;
    els.gameStatus.innerHTML = `<span class="status-pill"><i></i>${copy}</span>`;
  }

  function renderSocialMeta() {
    const room = ui.room;
    if (!room) return;
    if (room.specialEvent) {
      els.specialEventBanner.classList.remove('hidden');
      els.specialEventBanner.innerHTML = `<span>${escapeHtml(room.specialEvent.icon)}</span><b>${escapeHtml(room.specialEvent.label)}</b><span>· ${escapeHtml(room.specialEvent.description)}</span>`;
    } else els.specialEventBanner.classList.add('hidden');
    const recent = (room.recentWinners || []).slice(0, 4);
    if (recent.length) {
      els.winnerTicker.classList.remove('hidden');
      els.winnerTicker.innerHTML = `ÚLTIMOS GANADORES · ${recent.map(item => `<b>${avatarEmoji(item.avatar)} ${escapeHtml(item.name)}</b> +${formatChips(item.amount)}<i>◆</i>`).join('')}`;
    } else els.winnerTicker.classList.add('hidden');
  }

  // ---------- Cards and tables ----------
  function cardHtml(card, compact = false) {
    if (!card || card === 'XX') return '<div class="play-card back" aria-label="Carta oculta"></div>';
    const suitCode = card.slice(-1), rank = card.slice(0, -1), suit = SUITS[suitCode] || '';
    const red = suitCode === 'H' || suitCode === 'D';
    return `<div class="play-card ${red ? 'red-suit' : ''} ${compact ? 'compact' : ''}" aria-label="${escapeHtml(rank + ' de ' + suit)}"><span class="card-rank">${escapeHtml(rank)}</span><span class="card-suit">${suit}</span><span class="card-big-suit">${suit}</span></div>`;
  }
  function emptySeatHtml(index, blackjack = false) {
    return `<div class="empty-seat ${blackjack ? 'blackjack-seat' : ''} seat-${index}"><i>+</i>LIBRE</div>`;
  }
  function seatStatus(player, room) {
    if (player.id === room.turnId) return 'TU TURNO'.replace('TU', player.id === ui.me?.id ? 'TU' : 'EN');
    if (player.status === 'winner') return 'GANADOR';
    if (player.allIn) return 'ALL-IN';
    if (player.folded) return 'FUERA';
    return '';
  }
  function pokerSeat(player, index) {
    const room = ui.room;
    const classes = [player.id === room.turnId ? 'current' : '', player.folded ? 'folded' : '', player.status === 'winner' ? 'winner' : '', player.bot?.thinking ? 'bot-thinking' : ''].join(' ');
    const cards = player.hand?.length ? player.hand.map(card => cardHtml(card, true)).join('') : '';
    const bet = player.roundBet > 0 ? `<div class="seat-bet"><i></i>${formatChips(player.roundBet)}</div>` : '';
    const status = seatStatus(player, room);
    return `<div class="table-seat seat-${index} ${classes}"><div class="seat-cards">${cards}</div><div class="seat-head">
      <div class="seat-avatar" style="background:${avatarColor(player.id)}">${avatarEmoji(player.avatar)}</div>
      <div class="seat-info"><b>${escapeHtml(player.name)}${player.isBot ? '<i class="seat-bot-badge">BOT</i>' : ''}</b><span>◆ ${formatChips(player.chips)}</span></div>
      ${index === room.dealerIndex ? '<i class="dealer-button">D</i>' : ''}${status ? `<span class="seat-status">${escapeHtml(status)}</span>` : ''}
      </div>${bet}</div>`;
  }
  function renderPokerTable() {
    const room = ui.room;
    const community = Array.from({ length: 5 }, (_, index) => room.community[index] ? cardHtml(room.community[index]) : '<div class="card-placeholder"></div>').join('');
    const seats = Array.from({ length: 6 }, (_, index) => room.players[index] ? pokerSeat(room.players[index], index) : emptySeatHtml(index)).join('');
    els.tableWrap.innerHTML = `<div class="casino-table poker-table"><div class="table-center"><div class="community-cards">${community}</div><span class="table-label">BOTE TOTAL</span><div class="pot-display"><i class="pot-chip"></i>${formatChips(room.pot)} FICHAS</div></div><div class="seats-layer">${seats}</div></div>`;
  }
  function blackjackSeat(player, index) {
    const room = ui.room;
    const result = room.results?.find(item => item.id === player.id);
    const winner = result?.amount > 0;
    const classes = [player.id === room.turnId ? 'current' : '', winner ? 'winner' : '', player.status === 'bust' || result?.amount < 0 ? 'folded' : '', player.bot?.thinking ? 'bot-thinking' : ''].join(' ');
    const mainActive = player.id === room.turnId && (!player.split || player.split.active === 'main');
    const cards = player.hand?.map(card => cardHtml(card, true)).join('') || '';
    const score = player.hand?.length && !player.hand.includes('XX') ? blackjackValue(player.hand) : '';
    // Fase 8.4: segunda mano del split y distintivo del seguro.
    const splitScore = player.split && !player.split.hand.includes('XX') ? blackjackValue(player.split.hand) : '';
    const splitRow = player.split
      ? `<div class="seat-cards split-cards ${player.id === room.turnId && player.split.active === 'split' ? 'active-hand' : ''}">${player.split.hand.map(card => cardHtml(card, true)).join('')}${splitScore !== '' ? `<i class="hand-total split-total">${splitScore}</i>` : ''}</div>`
      : '';
    const totalBet = (player.bet || 0) + (player.split?.bet || 0);
    const bet = totalBet > 0 ? `<div class="seat-bet"><i></i>${formatChips(totalBet)}</div>` : '';
    const insuranceBadge = player.insurance ? '<i class="insurance-badge" title="Seguro tomado">🛡</i>' : '';
    const status = player.id === room.turnId
      ? `${player.id === ui.me?.id ? 'TU TURNO' : 'EN TURNO'}${player.split ? ` · MANO ${player.split.active === 'split' ? '2' : '1'}` : ''}`
      : result?.label || (player.status === 'blackjack' ? 'BLACKJACK' : '');
    return `<div class="table-seat blackjack-seat seat-${index} ${classes}"><div class="seat-cards ${player.split && mainActive ? 'active-hand' : ''}">${cards}</div>${splitRow}<div class="seat-head">
      <div class="seat-avatar" style="background:${avatarColor(player.id)}">${avatarEmoji(player.avatar)}</div><div class="seat-info"><b>${escapeHtml(player.name)}${player.isBot ? '<i class="seat-bot-badge">BOT</i>' : ''}${insuranceBadge}</b><span>◆ ${formatChips(player.chips)}</span></div>
      ${score !== '' ? `<i class="hand-total">${score}</i>` : ''}${status ? `<span class="seat-status">${escapeHtml(status)}</span>` : ''}
      </div>${bet}</div>`;
  }
  function renderBlackjackTable() {
    const room = ui.room;
    const dealerCards = room.dealerHand?.length ? room.dealerHand.map(card => cardHtml(card)).join('') : '<div class="card-placeholder"></div><div class="card-placeholder"></div>';
    const dealerKnown = blackjackValue(room.dealerHand || []);
    const seats = Array.from({ length: 6 }, (_, index) => room.players[index] ? blackjackSeat(room.players[index], index) : emptySeatHtml(index, true)).join('');
    els.tableWrap.innerHTML = `<div class="casino-table blackjack-table"><div class="dealer-area"><span class="dealer-name">LA CASA</span><div class="community-cards">${dealerCards}</div>${room.dealerHand?.length ? `<div class="dealer-score">VALOR ${dealerKnown}${room.dealerHand.includes('XX') ? '+' : ''}</div>` : ''}</div>
      <div class="table-center"><span class="table-label">RONDA</span><div class="pot-display">${room.handNumber || '—'}</div></div><div class="seats-layer">${seats}</div></div>`;
  }
  function quickChoiceLabel(game, choice) {
    if (!choice) return '';
    const labels = {
      red: 'Rojo', black: 'Negro', even: 'Par', odd: 'Impar',
      low: game === 'dice' ? 'Bajo 1–3' : 'Bajo 1–18', high: game === 'dice' ? 'Alto 4–6' : 'Alto 19–36',
      heads: 'Cara', tails: 'Cruz', locked: 'Apuesta oculta',
      d1: 'Docena 1–12', d2: 'Docena 13–24', d3: 'Docena 25–36',
      c1: 'Columna 1', c2: 'Columna 2', c3: 'Columna 3', spin: 'Giro'
    };
    return choice.startsWith?.('n:') ? `Número ${choice.slice(2)}` : (labels[choice] || choice);
  }
  // ---------- Fase 5: ruleta europea (rueda animada + paño completo) ----------
  // Orden real de la rueda europea de un solo cero; el resultado siempre lo decide el servidor.
  const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const WHEEL_STEP = Math.PI * 2 / 37;
  const RED_SET = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const WHEEL_BALL_TRACK = 134, WHEEL_BALL_POCKET = 110;

  function drawRouletteWheel(canvas, wheelAngle, ball, hubValue, hubColor) {
    const dpr = window.devicePixelRatio || 1;
    const size = 290;
    if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2;
    const rOuter = 141, rPocketOut = 128, rPocketIn = 92, rHub = 58;
    ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.fillStyle = '#101c1e'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(229,189,114,.55)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rPocketOut + 4, 0, Math.PI * 2);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(229,189,114,.22)'; ctx.stroke();
    for (let i = 0; i < 37; i++) {
      const number = WHEEL_ORDER[i];
      const start = wheelAngle + i * WHEEL_STEP - WHEEL_STEP / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rPocketOut, start, start + WHEEL_STEP);
      ctx.arc(cx, cy, rPocketIn, start + WHEEL_STEP, start, true);
      ctx.closePath();
      ctx.fillStyle = number === 0 ? '#0a6b52' : RED_SET.has(number) ? '#a73e4d' : '#152226';
      ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(229,189,114,.32)'; ctx.stroke();
      const mid = start + WHEEL_STEP / 2;
      ctx.save();
      ctx.translate(cx + Math.cos(mid) * (rPocketOut - 12), cy + Math.sin(mid) * (rPocketOut - 12));
      ctx.rotate(mid + Math.PI / 2);
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(number), 0, 0);
      ctx.restore();
    }
    const hubGradient = ctx.createRadialGradient(cx, cy, 8, cx, cy, rHub);
    hubGradient.addColorStop(0, '#152a2d'); hubGradient.addColorStop(1, '#0a1315');
    ctx.beginPath(); ctx.arc(cx, cy, rHub, 0, Math.PI * 2);
    ctx.fillStyle = hubGradient; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(229,189,114,.5)'; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (hubValue != null) {
      ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2);
      ctx.fillStyle = hubColor === 'red' ? '#a73e4d' : hubColor === 'black' ? '#152226' : '#0a6b52';
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#d5bc83'; ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.font = '800 22px "Playfair Display", Georgia, serif';
      ctx.fillText(String(hubValue), cx, cy + 1);
    } else {
      ctx.fillStyle = 'rgba(229,189,114,.75)'; ctx.font = '16px serif';
      ctx.fillText('◆', cx, cy + 1);
    }
    if (ball) {
      const bx = cx + Math.cos(ball.angle) * ball.radius;
      const by = cy + Math.sin(ball.angle) * ball.radius;
      ctx.beginPath(); ctx.arc(bx, by, 5.5, 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 6;
      ctx.fillStyle = '#f4f1e6'; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(bx - 1.5, by - 1.5, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill();
    }
  }
  function startRouletteSpin(value) {
    const index = WHEEL_ORDER.indexOf(Number(value));
    if (index < 0) return;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = ui.rouletteAngle || 0;
    // Determinista a partir del número del servidor: todos los presentes ven el mismo giro.
    const wheelEnd = from - Math.PI * 2 * (3 + value % 3) - ((value * 0.37) % 1) * Math.PI * 2;
    const ballEnd = wheelEnd + index * WHEEL_STEP;
    const ballStart = ballEnd - Math.PI * 2 * 8;
    ui.rouletteSpin = { start: performance.now(), duration: reduceMotion ? 0 : 6400, from, wheelEnd, ballStart, ballEnd, value, skip: false };
    ensureRouletteLoop();
  }
  function rouletteSpinFrame(canvas, spin, now) {
    const progress = spin.skip || spin.duration <= 0 ? 1 : Math.min(1, (now - spin.start) / spin.duration);
    const easeWheel = 1 - Math.pow(1 - progress, 3);
    const easeBall = 1 - Math.pow(1 - progress, 2.6);
    const wheelAngle = spin.from + (spin.wheelEnd - spin.from) * easeWheel;
    // Rebotes finales: la sacudida se amortigua y desaparece exactamente al aterrizar.
    const jitter = Math.sin(progress * 30) * Math.pow(1 - progress, 3) * WHEEL_STEP * 1.6;
    const ballAngle = spin.ballStart + (spin.ballEnd - spin.ballStart) * easeBall + jitter;
    const dropRaw = Math.min(1, Math.max(0, (progress - 0.62) / 0.3));
    const drop = dropRaw * dropRaw * (3 - 2 * dropRaw);
    const hop = Math.abs(Math.sin(progress * 26)) * Math.pow(1 - progress, 2) * 10;
    const radius = WHEEL_BALL_TRACK - (WHEEL_BALL_TRACK - WHEEL_BALL_POCKET) * drop + (dropRaw > 0 ? hop : 0);
    drawRouletteWheel(canvas, wheelAngle, { angle: ballAngle, radius }, null);
    return progress >= 1;
  }
  function finishRouletteSpin() {
    const spin = ui.rouletteSpin;
    if (!spin) return;
    ui.rouletteAngle = spin.wheelEnd;
    ui.rouletteSpin = null;
    ui.lastGameSignature = ''; // el estado del servidor no cambió: forzamos el repintado del resultado
    playTone('notice');
    renderRoom();
    // Momento del descubrimiento: los avisos retenidos (resultado, victoria,
    // premios) se muestran ahora que la pelota ya cayó.
    flushResultQueue();
  }
  function ensureRouletteLoop() {
    if (ui.rouletteRaf) return;
    const step = now => {
      ui.rouletteRaf = null;
      const room = ui.room;
      if (!room || room.game !== 'roulette') { ui.rouletteSpin = null; return; }
      const canvas = document.getElementById('roulette-canvas');
      const spin = ui.rouletteSpin;
      let keep = false;
      if (!canvas) {
        keep = Boolean(spin); // la mesa se re-renderizó: esperamos al nuevo canvas
      } else if (spin) {
        if (rouletteSpinFrame(canvas, spin, now)) finishRouletteSpin();
        else keep = true;
      } else if (room.phase === 'rolling') {
        ui.rouletteAngle = (ui.rouletteAngle || 0) - 0.012;
        drawRouletteWheel(canvas, ui.rouletteAngle, { angle: now / 240, radius: WHEEL_BALL_TRACK }, null);
        keep = true;
      } else {
        const result = room.quickResult;
        const index = result ? WHEEL_ORDER.indexOf(result.value) : -1;
        const restingBall = index >= 0 ? { angle: (ui.rouletteAngle || 0) + index * WHEEL_STEP, radius: WHEEL_BALL_POCKET } : null;
        drawRouletteWheel(canvas, ui.rouletteAngle || 0, restingBall, result ? result.value : null, result?.color);
      }
      if (keep) ui.rouletteRaf = requestAnimationFrame(step);
    };
    ui.rouletteRaf = requestAnimationFrame(step);
  }
  function winningCells(result) {
    const cells = new Set([`n:${result.value}`]);
    const number = result.value;
    if (number >= 1) {
      cells.add(number % 2 === 0 ? 'even' : 'odd');
      cells.add(result.color === 'red' ? 'red' : 'black');
      cells.add(number <= 18 ? 'low' : 'high');
      cells.add(number <= 12 ? 'd1' : number <= 24 ? 'd2' : 'd3');
      cells.add(number % 3 === 1 ? 'c1' : number % 3 === 2 ? 'c2' : 'c3');
    }
    return cells;
  }
  function rouletteFeltHtml({ interactive = false, chips = null, highlight = null } = {}) {
    const chipHtml = key => (chips && chips[key] ? chips[key].map(player => `<i class="felt-chip" style="background:${avatarColor(player.id)}" title="${escapeHtml(player.name)}"></i>`).join('') : '');
    const cell = (key, label, cls, style, title) => {
      const classes = `felt-cell ${cls}${highlight && highlight.has(key) ? ' hit' : ''}`;
      return interactive
        ? `<button type="button" class="${classes}" style="${style}" data-quick-choice="${key}" title="${title}">${label}${chipHtml(key)}</button>`
        : `<span class="${classes}" style="${style}" title="${title}">${label}${chipHtml(key)}</span>`;
    };
    let html = `<div class="roulette-felt${interactive ? '' : ' readonly'}" role="group" aria-label="Paño de apuestas de ruleta europea">`;
    html += cell('n:0', '0', 'green', 'grid-column:1;grid-row:1/span 3', 'Pleno al 0: pago total x36');
    for (let number = 1; number <= 36; number++) {
      const column = 2 + Math.floor((number - 1) / 3);
      const row = number % 3 === 0 ? 1 : number % 3 === 2 ? 2 : 3;
      html += cell(`n:${number}`, String(number), RED_SET.has(number) ? 'red' : 'black', `grid-column:${column};grid-row:${row}`, `Pleno al ${number}: pago total x36`);
    }
    html += cell('c3', '2:1', 'outside', 'grid-column:14;grid-row:1', 'Columna 3 (3, 6 … 36): pago total x3');
    html += cell('c2', '2:1', 'outside', 'grid-column:14;grid-row:2', 'Columna 2 (2, 5 … 35): pago total x3');
    html += cell('c1', '2:1', 'outside', 'grid-column:14;grid-row:3', 'Columna 1 (1, 4 … 34): pago total x3');
    html += cell('d1', '1.ª 12', 'outside', 'grid-column:2/span 4;grid-row:4', 'Docena 1–12: pago total x3');
    html += cell('d2', '2.ª 12', 'outside', 'grid-column:6/span 4;grid-row:4', 'Docena 13–24: pago total x3');
    html += cell('d3', '3.ª 12', 'outside', 'grid-column:10/span 4;grid-row:4', 'Docena 25–36: pago total x3');
    html += cell('low', '1–18', 'outside', 'grid-column:2/span 2;grid-row:5', 'Bajo 1–18: pago total x2');
    html += cell('even', 'PAR', 'outside', 'grid-column:4/span 2;grid-row:5', 'Par: pago total x2');
    html += cell('red', '◆ ROJO', 'outside red-mark', 'grid-column:6/span 2;grid-row:5', 'Rojo: pago total x2');
    html += cell('black', '◆ NEGRO', 'outside black-mark', 'grid-column:8/span 2;grid-row:5', 'Negro: pago total x2');
    html += cell('odd', 'IMPAR', 'outside', 'grid-column:10/span 2;grid-row:5', 'Impar: pago total x2');
    html += cell('high', '19–36', 'outside', 'grid-column:12/span 2;grid-row:5', 'Alto 19–36: pago total x2');
    return html + '</div>';
  }

  // ---------- Fase 6: Tragamonedas MonteCristo (3 rodillos animados) ----------
  // El servidor decide los símbolos; la animación solo los representa.
  const SLOT_META = {
    cherry: { glyph: '🍒', label: 'Cereza', pay: 5 }, clover: { glyph: '🍀', label: 'Trébol', pay: 8 },
    bell: { glyph: '🔔', label: 'Campana', pay: 12 }, gem: { glyph: '💎', label: 'Diamante', pay: 20 },
    monte: { glyph: '♠', label: 'MonteCristo', pay: 40 }
  };
  const SLOT_STRIP_SEQ = ['cherry', 'bell', 'clover', 'gem', 'cherry', 'monte', 'clover', 'bell', 'cherry', 'gem', 'clover', 'monte', 'bell', 'cherry', 'clover', 'gem', 'bell', 'monte', 'cherry', 'clover'];
  const SLOT_CELL = 64, SLOT_REPEATS = 10;
  function slotStripHtml() {
    let cells = '';
    for (let repeat = 0; repeat < SLOT_REPEATS; repeat++) {
      for (const id of SLOT_STRIP_SEQ) cells += `<div class="slot-cell ${id === 'monte' ? 'premium' : ''}">${SLOT_META[id].glyph}</div>`;
    }
    return cells;
  }
  function slotOffsetFor(id) {
    const index = Math.max(0, SLOT_STRIP_SEQ.indexOf(id));
    return ((SLOT_REPEATS - 2) * SLOT_STRIP_SEQ.length + index) * SLOT_CELL;
  }
  function startSlotsSpin(reels) {
    if (!Array.isArray(reels) || reels.length !== 3) return;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Paradas en secuencia izquierda → centro → derecha, ~0.9 s entre cada una.
    ui.slotsSpin = { start: performance.now(), reels, stops: reduceMotion ? [0, 0, 0] : [1700, 2600, 3500], skip: false };
    ensureSlotsLoop();
  }
  function slotsSpinFrame(strips, spin, now) {
    const elapsed = now - spin.start;
    let allDone = true;
    for (let i = 0; i < 3; i++) {
      const duration = spin.stops[i];
      const x = spin.skip || duration <= 0 ? 1 : Math.min(1, elapsed / duration);
      if (x < 1) allDone = false;
      const target = slotOffsetFor(spin.reels[i]);
      const ease = 1 - Math.pow(1 - x, 3);
      const bounce = Math.sin(x * 24) * Math.pow(1 - x, 2) * 26; // rebote amortiguado: 0 exacto al frenar
      strips[i].style.transform = `translateY(${-(target * ease + bounce)}px)`;
      strips[i].classList.toggle('blur', x < 0.8);
    }
    return allDone;
  }
  function finishSlotsSpin() {
    if (!ui.slotsSpin) return;
    ui.slotsSpin = null;
    ui.lastGameSignature = ''; // el estado del servidor no cambió: forzamos el repintado del resultado
    playTone('notice');
    renderRoom();
    // Momento del descubrimiento: los avisos retenidos se muestran ahora que
    // los rodillos se detuvieron.
    flushResultQueue();
  }
  function ensureSlotsLoop() {
    if (ui.slotsRaf) return;
    const step = now => {
      ui.slotsRaf = null;
      const room = ui.room;
      if (!room || room.game !== 'slots') { ui.slotsSpin = null; return; }
      const strips = [0, 1, 2].map(i => document.getElementById(`slot-strip-${i}`));
      const spin = ui.slotsSpin;
      let keep = false;
      if (strips.some(strip => !strip)) {
        keep = Boolean(spin); // la mesa se re-renderizó: esperamos a las nuevas tiras
      } else if (spin) {
        if (slotsSpinFrame(strips, spin, now)) finishSlotsSpin();
        else keep = true;
      } else if (room.phase === 'rolling') {
        const loopPx = SLOT_STRIP_SEQ.length * SLOT_CELL * (SLOT_REPEATS - 2);
        strips.forEach((strip, i) => {
          strip.classList.add('blur');
          strip.style.transform = `translateY(${-((now * (0.9 + i * 0.15)) % loopPx)}px)`;
        });
        keep = true;
      } else {
        const reels = room.quickResult?.reels || ['monte', 'gem', 'cherry'];
        strips.forEach((strip, i) => {
          strip.classList.remove('blur');
          strip.style.transform = `translateY(${-slotOffsetFor(reels[i])}px)`;
        });
      }
      if (keep) ui.slotsRaf = requestAnimationFrame(step);
    };
    ui.slotsRaf = requestAnimationFrame(step);
  }

  function quickSeat(player, index) {
    const room = ui.room;
    const result = room.results?.find(item => item.id === player.id);
    const choice = quickChoiceLabel(room.game, player.quickChoice);
    const suspense = (room.game === 'roulette' && ui.rouletteSpin) || (room.game === 'slots' && ui.slotsSpin); // sin brillo de ganador hasta que termine la animación
    return `<div class="quick-bet-seat ${player.bot?.thinking ? 'bot-thinking' : ''} ${!suspense && result?.amount > 0 ? 'winner' : ''}" style="--seat:${index}">
      <div class="seat-avatar" style="background:${avatarColor(player.id)}">${avatarEmoji(player.avatar)}</div>
      <div><b>${escapeHtml(player.name)}${player.isBot ? '<i class="seat-bot-badge">BOT</i>' : ''}</b><span>${player.bot?.thinking ? 'Pensando…' : player.bet ? `◆ ${formatChips(player.bet)} · ${escapeHtml(choice)}` : `${formatChips(player.chips)} fichas`}</span></div>
    </div>`;
  }
  function quickCore(room) {
    const result = room.quickResult;
    const rolling = room.phase === 'rolling' ? 'rolling' : '';
    if (room.game === 'roulette') {
      const color = result?.color || '';
      const spinning = Boolean(ui.rouletteSpin);
      const label = spinning
        ? '<div class="quick-result-label spinning">La pelota está girando…</div>'
        : result ? `<div class="quick-result-label">${result.value} · ${color === 'red' ? 'Rojo' : color === 'black' ? 'Negro' : 'Verde'}</div>` : '';
      return `<small>RULETA EUROPEA · RESULTADO AUTORITATIVO</small><div class="roulette-stage"><canvas id="roulette-canvas" width="290" height="290" aria-label="Rueda de ruleta europea"></canvas>${spinning ? '<button type="button" class="game-btn roulette-skip" data-roulette-skip>Saltar animación</button>' : ''}</div>${label}`;
    }
    if (room.game === 'slots') {
      const spinning = Boolean(ui.slotsSpin);
      const reels = result?.reels;
      const label = spinning
        ? '<div class="quick-result-label spinning">Los rodillos giran…</div>'
        : reels ? `<div class="quick-result-label">${reels.map(id => SLOT_META[id]?.label || id).join(' · ')}</div>` : '';
      const paytable = `<div class="slot-paytable" aria-label="Tabla de pagos">${['monte','gem','bell','clover','cherry'].map(id => `<span title="Tres ${SLOT_META[id].label}: pago total x${SLOT_META[id].pay}">${SLOT_META[id].glyph}×3 <b>x${SLOT_META[id].pay}</b></span>`).join('')}<span title="Dos símbolos iguales: recuperas tu apuesta">Par <b>x1</b></span></div>`;
      return `<small>TRAGAMONEDAS MONTECRISTO · RESULTADO AUTORITATIVO</small><div class="slot-machine"><div class="slot-window">${[0,1,2].map(i => `<div class="slot-reel"><div class="slot-strip" id="slot-strip-${i}">${slotStripHtml()}</div></div>`).join('')}</div>${paytable}</div>${spinning ? '<button type="button" class="game-btn slots-skip" data-slots-skip>Saltar animación</button>' : ''}${label}`;
    }
    if (room.game === 'dice') {
      const face = result ? ['⚀','⚁','⚂','⚃','⚄','⚅'][result.value - 1] : '⚄';
      return `<small>DADOS CÓSMICOS · RESULTADO AUTORITATIVO</small><div class="dice-stage"><div class="big-die ${rolling}">${face}</div></div>${result ? `<div class="quick-result-label">Dado ${result.value}</div>` : ''}`;
    }
    const value = result?.value;
    return `<small>CARA O CRUZ · RESULTADO AUTORITATIVO</small><div class="coin-stage"><div class="big-coin ${rolling}">${value === 'heads' ? 'CARA' : value === 'tails' ? 'CRUZ' : 'MESA'}</div></div>${result ? `<div class="quick-result-label">${value === 'heads' ? 'Cara' : 'Cruz'}</div>` : ''}`;
  }
  function renderQuickTable() {
    const room = ui.room;
    const seats = room.players.map(quickSeat).join('');
    els.tableWrap.innerHTML = `<div class="quick-table-shell ${room.game}"><div class="quick-game-core">${quickCore(room)}</div><div class="quick-bets-around">${seats}</div></div>`;
    if (room.game === 'roulette') ensureRouletteLoop();
    if (room.game === 'slots') ensureSlotsLoop();
  }
  function renderTable() {
    if (ui.room.game === 'poker') renderPokerTable();
    else if (ui.room.game === 'blackjack') renderBlackjackTable();
    else renderQuickTable();
  }

  // ---------- Game actions ----------
  function renderActions() {
    const room = ui.room, me = ui.me;
    if (!me) {
      if (ui.spectating) renderSpectatorActions(room);
      else els.actionPanel.innerHTML = '';
      return;
    }
    if (room.game === 'poker') renderPokerActions(room, me);
    else if (room.game === 'blackjack') renderBlackjackActions(room, me);
    else renderQuickActions(room, me);
    bindActionButtons();
  }
  // Fase 8: banner del modo espectador con opción de tomar asiento.
  function renderSpectatorActions(room) {
    const capacity = room.botOptions?.capacity || 6;
    const humanSeats = room.players.filter(player => !player.isBot).length;
    const canSeat = room.players.length < capacity || room.players.some(player => player.isBot);
    els.actionPanel.innerHTML = `
      <div class="action-bar spectator-bar">
        <div class="waiting-copy"><b>👁 Modo espectador</b><span>Estás viendo la mesa en vivo sin ocupar asiento. Las cartas ajenas permanecen ocultas y puedes usar el chat.</span></div>
        <div class="action-buttons">
          ${canSeat
            ? '<button class="game-btn primary" data-take-seat>Tomar asiento</button>'
            : `<span class="waiting-copy"><span>La mesa está llena (${humanSeats} jugadores). Se liberará un asiento cuando alguien salga.</span></span>`}
        </div>
      </div>`;
    const seatButton = els.actionPanel.querySelector('[data-take-seat]');
    if (seatButton) seatButton.addEventListener('click', async () => {
      setButtonLoading(seatButton, true);
      const response = await emitAck('join_room', { name: ui.playerName, code: room.code, token: deviceToken, avatar: ui.selectedAvatar, tos: localStorage.getItem(TOS_KEY) });
      setButtonLoading(seatButton, false);
      if (!response.ok) { showToast('Sin asiento disponible', response.error || 'Intenta de nuevo.', 'error'); return; }
      ui.spectating = false;
      saveSession();
      showToast('¡A jugar!', 'Dejaste la tribuna y tomaste un asiento en la mesa.', 'success');
    });
  }
  function renderPokerActions(room, me) {
    const active = isPokerActive(room);
    const myTurn = active && room.turnId === me.id;
    if (myTurn) {
      const toCall = Math.max(0, room.currentBet - me.roundBet);
      const minRaise = Math.max(1, room.minRaise || 20);
      els.actionPanel.innerHTML = `<div class="action-bar"><div class="action-info"><small>DECISIÓN ACTUAL</small><b>${toCall ? `IGUALAR <span>${formatChips(toCall)}</span>` : 'PUEDES PASAR'}</b></div><div class="action-buttons">
        <button class="game-btn danger" data-poker-action="fold">Retirarse</button>
        <button class="game-btn green" data-poker-action="${toCall ? 'call' : 'check'}">${toCall ? `Igualar ${formatChips(toCall)}` : 'Pasar'}</button>
        <div class="raise-box"><input id="raise-amount" type="number" min="${minRaise}" step="${minRaise}" value="${minRaise}" aria-label="Cantidad para subir"/><button class="game-btn primary" data-poker-action="raise">Subir</button></div>
        <button class="game-btn" data-poker-action="allin">All-in</button></div></div>`;
      return;
    }
    const canStart = me.isHost && !active;
    const startCopy = room.phase === 'showdown' ? 'Repartir otra mano' : 'Iniciar partida';
    els.actionPanel.innerHTML = `<div class="action-bar"><div class="waiting-copy"><b>${active ? 'La acción está en la mesa' : room.phase === 'showdown' ? 'La mano terminó' : 'La mesa está lista'}</b><span>${!active && me.chips < 20 && !room.tournament?.active ? 'Te quedaste sin fichas para las ciegas (mínimo 20): mañana recibes tu bono diario de 100 al entrar.' : active ? `Esperando a ${escapeHtml(room.players.find(p => p.id === room.turnId)?.name || 'la siguiente jugada')}…` : me.isHost ? 'Tú controlas el inicio de la próxima mano.' : 'El anfitrión iniciará cuando todos estén listos.'}</span></div><div class="action-buttons">
      ${canStart ? `<button class="game-btn primary" data-event="poker_start">${startCopy}</button>` : ''}
      ${canStart && !room.tournament?.active && room.players.filter(p => p.connected).length >= 2 ? '<button class="game-btn tournament-btn" data-event="tournament_start" title="Entrada 200 fichas · stack 1000 · las ciegas suben cada 3 manos · el ganador se lleva todo">🏆 Iniciar torneo</button>' : ''}
      ${room.results?.length ? `<div class="result-strip">${room.results.map(result => `<span class="result-item ${result.amount > 0 ? 'win' : ''}">${escapeHtml(result.name)} <b>${result.amount > 0 ? '+' : ''}${formatDelta(result.amount)}</b></span>`).join('')}</div>` : ''}
      </div></div>`;
  }
  function renderBlackjackActions(room, me) {
    if (room.phase === 'betting') {
      if (me.bet > 0) {
        els.actionPanel.innerHTML = `<div class="action-bar"><div class="waiting-copy"><b>Apuesta confirmada: <span>${formatChips(me.bet)}</span></b><span>Esperando a que el anfitrión reparta.</span></div><div class="action-buttons">${me.isHost ? '<button class="game-btn primary" data-event="blackjack_start">Repartir cartas</button>' : ''}</div></div>`;
      } else {
        const bets = [10, 25, 50, 100].filter(amount => amount <= me.chips);
        els.actionPanel.innerHTML = `<div class="action-bar"><div class="action-info"><small>ELIGE TU APUESTA</small><b>◆ <span>${formatChips(me.chips)}</span> DISPONIBLES</b></div><div class="bet-options">${bets.map(amount => `<button class="chip-button" data-blackjack-bet="${amount}">${amount}</button>`).join('')}</div><div class="action-buttons">${me.isHost ? '<button class="game-btn" data-event="blackjack_start">Repartir</button>' : ''}</div></div>`;
      }
      return;
    }
    if (room.phase === 'playing' && room.turnId === me.id) {
      // Fase 8.4: las jugadas aplican a la mano activa; se ofrecen split y seguro cuando corresponde.
      const onSplitHand = me.split && me.split.active === 'split';
      const activeHand = onSplitHand ? me.split.hand : me.hand;
      const activeBet = onSplitHand ? me.split.bet : me.bet;
      const canDouble = activeHand.length === 2 && me.chips >= activeBet;
      const canSplit = !me.split && me.hand.length === 2 && bjCardValue(me.hand[0]) === bjCardValue(me.hand[1]) && me.chips >= me.bet;
      const handLabel = me.split ? (onSplitHand ? 'MANO 2 DE 2' : 'MANO 1 DE 2') : 'TU MANO';
      els.actionPanel.innerHTML = `<div class="action-bar"><div class="action-info"><small>${handLabel}</small><b>VALOR <span>${blackjackValue(activeHand)}</span></b></div><div class="action-buttons"><button class="game-btn primary" data-event="blackjack_hit">Pedir carta</button><button class="game-btn green" data-event="blackjack_stand">Plantarse</button><button class="game-btn" data-event="blackjack_double" ${canDouble ? '' : 'disabled'}>Doblar</button>${canSplit ? '<button class="game-btn" data-event="blackjack_split" title="Divide tu par en dos manos con apuestas iguales">Dividir</button>' : ''}${insuranceButton(room, me)}</div></div>`;
      return;
    }
    if (room.phase === 'results') {
      els.actionPanel.innerHTML = `<div class="action-bar"><div class="result-strip">${room.results.map(result => `<span class="result-item ${result.amount > 0 ? 'win' : ''}">${escapeHtml(result.name)} <b>${result.amount > 0 ? '+' : ''}${formatDelta(result.amount)}</b></span>`).join('')}</div><div class="action-buttons">${me.isHost ? '<button class="game-btn primary" data-event="blackjack_new">Nueva ronda</button>' : '<span class="waiting-copy"><span>Esperando al anfitrión…</span></span>'}</div></div>`;
      return;
    }
    const current = room.players.find(player => player.id === room.turnId);
    els.actionPanel.innerHTML = `<div class="action-bar"><div class="waiting-copy"><b>La casa está en juego</b><span>${current ? `Turno de ${escapeHtml(current.name)}.` : 'Resolviendo la ronda…'}</span></div>${insuranceButton(room, me) ? `<div class="action-buttons">${insuranceButton(room, me)}</div>` : ''}</div>`;
  }
  // Fase 8.4: valor de una carta y botón de seguro (cuando la casa muestra un as).
  function bjCardValue(card) {
    const rank = String(card || '').slice(0, -1);
    if (rank === 'A') return 11;
    if (['K', 'Q', 'J'].includes(rank)) return 10;
    return Number(rank);
  }
  function insuranceButton(room, me) {
    const upcard = String(room.dealerHand?.[0] || '');
    const eligible = room.phase === 'playing' && upcard.slice(0, -1) === 'A' && me.bet > 0 && !me.insurance
      && me.hand?.length === 2 && !me.split && me.chips >= Math.ceil(me.bet / 2);
    return eligible ? `<button class="game-btn insurance-btn" data-event="blackjack_insurance" title="Cuesta la mitad de tu apuesta y paga 2:1 si la casa tiene blackjack">🛡 Seguro (${formatChips(Math.ceil(me.bet / 2))})</button>` : '';
  }
  function quickChoiceButtons(game) {
    // La ruleta usa su propio paño completo (rouletteFeltHtml); aquí solo dados y moneda.
    const options = game === 'dice' ? [['low','Bajo · 1–3'],['high','Alto · 4–6']] : [['heads','Cara'],['tails','Cruz']];
    const simplePayout = 'Pago total x2 si aciertas';
    let html = options.map(([value, label]) => `<button class="quick-choice ${value}" type="button" data-quick-choice="${value}" title="${simplePayout}">${label}</button>`).join('');
    if (game === 'dice') html += [1,2,3,4,5,6].map(value => `<button class="quick-choice exact" type="button" data-quick-choice="n:${value}" title="Número exacto: pago total x6">${value}</button>`).join('');
    return html;
  }
  function renderQuickActions(room, me) {
    if (ui.quickGame !== room.game) {
      ui.quickGame = room.game;
      ui.quickChoice = room.game === 'coinflip' ? 'heads' : room.game === 'slots' ? 'spin' : 'low';
    }
    if (room.phase === 'betting') {
      const hostLaunch = me.isHost ? '<button class="game-btn primary" data-event="quick_resolve">Lanzar ronda</button>' : '';
      if (me.bet > 0) {
        const myChipFelt = room.game === 'roulette' && me.quickChoice ? `<div class="felt-wrap">${rouletteFeltHtml({ chips: { [me.quickChoice]: [me] } })}</div>` : '';
        els.actionPanel.innerHTML = `<div class="action-bar ${myChipFelt ? 'roulette-bar' : ''}"><div class="waiting-copy"><b>Apuesta confirmada: <span>${formatChips(me.bet)}</span> · ${escapeHtml(quickChoiceLabel(room.game, me.quickChoice))}</b><span>La elección queda bloqueada hasta el resultado.</span></div>${myChipFelt}<div class="action-buttons">${hostLaunch || '<span class="waiting-copy"><span>Esperando al anfitrión…</span></span>'}</div></div>`;
      } else if (me.chips < 10) {
        els.actionPanel.innerHTML = `<div class="action-bar"><div class="waiting-copy"><b>Necesitas al menos 10 fichas</b><span>Prueba otro juego o espera una recompensa.</span></div><div class="action-buttons">${hostLaunch}</div></div>`;
      } else {
        const suggested = Math.min(50, me.chips);
        const chooser = room.game === 'roulette'
          ? `<div class="felt-wrap">${rouletteFeltHtml({ interactive: true })}</div>`
          : room.game === 'slots'
            ? '<div class="waiting-copy"><b>🎰 Un giro por ronda</b><span>Confirma tu apuesta virtual y tira de la palanca: la tabla de pagos está en la máquina.</span></div>'
            : `<div><div class="quick-choice-grid">${quickChoiceButtons(room.game)}</div></div>`;
        els.actionPanel.innerHTML = `<div class="action-bar ${room.game === 'roulette' ? 'roulette-bar' : ''}">${chooser}<div class="quick-bet-controls"><input id="quick-bet-amount" type="number" min="10" max="${me.chips}" value="${suggested}" aria-label="Apuesta virtual"><button class="game-btn green" data-quick-bet>Confirmar apuesta</button>${hostLaunch}</div></div>`;
      }
      return;
    }
    if (room.phase === 'rolling') {
      els.actionPanel.innerHTML = '<div class="action-bar"><div class="waiting-copy"><b>El azar ya está en movimiento</b><span>El servidor publicará el resultado en un instante.</span></div></div>';
      return;
    }
    if (room.game === 'roulette' && ui.rouletteSpin) {
      els.actionPanel.innerHTML = '<div class="action-bar"><div class="waiting-copy"><b>La pelota está girando</b><span>El resultado se revelará cuando caiga en su casilla.</span></div><div class="action-buttons"><button type="button" class="game-btn" data-roulette-skip>Saltar animación</button></div></div>';
      return;
    }
    if (room.game === 'slots' && ui.slotsSpin) {
      els.actionPanel.innerHTML = '<div class="action-bar"><div class="waiting-copy"><b>Los rodillos giran</b><span>Se detendrán uno a uno con los símbolos que decidió el servidor.</span></div><div class="action-buttons"><button type="button" class="game-btn" data-slots-skip>Saltar animación</button></div></div>';
      return;
    }
    const resultCopy = room.results?.length ? room.results.map(result => `<span class="result-item ${result.amount > 0 ? 'win' : ''}">${escapeHtml(result.name)} <b>${result.amount > 0 ? '+' : ''}${formatDelta(result.amount)}</b></span>`).join('') : '<span class="result-item">Sin apuestas en esta ronda</span>';
    let resultsFelt = '';
    if (room.game === 'roulette' && room.quickResult) {
      const chips = {};
      room.players.forEach(player => {
        if (player.quickChoice && player.quickChoice !== 'locked') (chips[player.quickChoice] = chips[player.quickChoice] || []).push(player);
      });
      resultsFelt = `<div class="felt-wrap">${rouletteFeltHtml({ chips, highlight: winningCells(room.quickResult) })}</div>`;
    }
    els.actionPanel.innerHTML = `<div class="action-bar ${resultsFelt ? 'roulette-bar' : ''}"><div class="result-strip">${resultCopy}</div>${resultsFelt}<div class="action-buttons">${me.isHost ? '<button class="game-btn primary" data-event="quick_new">Abrir nueva ronda</button>' : '<span class="waiting-copy"><span>Esperando al anfitrión…</span></span>'}</div></div>`;
  }
  function bindActionButtons() {
    $$('[data-event]').forEach(button => button.addEventListener('click', async () => {
      const response = await emitAck(button.dataset.event, {}, button);
      if (!response.ok) showToast('Jugada no disponible', response.error, 'error');
    }));
    $$('[data-blackjack-bet]').forEach(button => button.addEventListener('click', async () => {
      const response = await emitAck('blackjack_bet', { amount: Number(button.dataset.blackjackBet) }, button);
      if (!response.ok) showToast('Apuesta no válida', response.error, 'error'); else playTone('notice');
    }));
    $$('[data-poker-action]').forEach(button => button.addEventListener('click', async () => {
      const action = button.dataset.pokerAction;
      const amount = action === 'raise' ? Number($('#raise-amount')?.value) : undefined;
      const response = await emitAck('poker_action', { action, amount }, button);
      if (!response.ok) showToast('Jugada no válida', response.error, 'error'); else playTone('notice');
    }));
    $$('[data-quick-choice]').forEach(button => {
      const initiallySelected = button.dataset.quickChoice === ui.quickChoice;
      button.classList.toggle('active', initiallySelected);
      button.setAttribute('aria-pressed', String(initiallySelected));
      button.addEventListener('click', () => {
        ui.quickChoice = button.dataset.quickChoice;
        $$('[data-quick-choice]').forEach(item => {
          const selected = item === button;
          item.classList.toggle('active', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
        const exact = $('#quick-exact-number'); if (exact) exact.value = '';
      });
    });
    $('#quick-exact-number')?.addEventListener('input', event => {
      const value = Math.floor(Number(event.target.value));
      if (value >= 0 && value <= 36) {
        ui.quickChoice = `n:${value}`;
        $$('[data-quick-choice]').forEach(item => { item.classList.remove('active'); item.setAttribute('aria-pressed', 'false'); });
      }
    });
    $('[data-quick-bet]')?.addEventListener('click', async event => {
      const amount = Number($('#quick-bet-amount')?.value);
      const button = event.currentTarget;
      const response = await emitAck('quick_bet', { amount, choice: ui.quickChoice }, button);
      if (!response.ok) showToast('Apuesta no válida', response.error, 'error'); else playTone('notice');
    });
  }

  // ---------- Timer ----------
  function updateClock() {
    clearInterval(ui.clockTimer);
    const tick = () => {
      const room = ui.room;
      if (!room?.turnId || !room.turnDeadline) { els.turnClock.classList.add('hidden'); return; }
      const current = room.players.find(player => player.id === room.turnId);
      const remainingMs = Math.max(0, room.turnDeadline - Date.now());
      const seconds = Math.ceil(remainingMs / 1000);
      const duration = room.turnDuration || (room.game === 'poker' ? 30000 : 25000);
      const progress = Math.max(0, Math.min(100, remainingMs / duration * 100));
      els.turnClock.classList.remove('hidden');
      els.turnClock.classList.toggle('urgent', seconds <= 7);
      els.clockValue.textContent = seconds;
      els.clockPlayer.textContent = current?.id === ui.me?.id ? 'Tu decisión' : (current?.name || 'Esperando');
      els.turnClock.querySelector('.clock-ring')?.style.setProperty('--progress', progress);
    };
    tick(); ui.clockTimer = setInterval(tick, 250);
  }

  // ---------- Events, toasts and effects ----------
  socket.on('game_event', event => {
    if (!event?.type || !event.text) return;
    const key = `${event.type}-${event.time}-${event.playerId || ''}`;
    if (key === ui.lastEventKey) return;
    ui.lastEventKey = key;
    if (event.type === 'bot_action' && !event.fallback) return;
    const present = () => {
      const map = {
        joined: ['Nuevo jugador', '◎', 'notice'], left: ['Jugador desconectado', '←', 'notice'],
        round: ['Nueva ronda', '♠', 'round'], turn: ['Es tu turno', '◷', 'turn'],
        timeout: ['Tiempo agotado', '!', 'error'], win: ['Victoria', '◆', 'win'],
        loss: ['Fin de la ronda', '×', 'loss'], push: ['Empate', '=', 'notice'],
        roll: ['Resultado en camino', '◉', 'round'], quick_result: ['Ronda resuelta', '✦', 'notice'],
        bot_joined: ['Bot en la mesa', '🤖', 'notice'], bot_action: ['Jugada del bot', '🤖', 'notice'],
        special: ['Evento especial', '✦', 'achievement'], special_reward: ['Premio especial', '💎', 'reward']
      };
      const [title, icon, kind] = map[event.type] || ['Mesa actualizada', '•', 'notice'];
      showToast(title, event.text, kind, ['turn', 'win', 'loss', 'special'].includes(event.type) ? 5500 : 3500, icon, ['achievement', 'reward'].includes(kind));
      playTone(kind === 'achievement' || kind === 'reward' ? 'win' : kind);
      if (event.type === 'round') showRoundFlash(event.text);
      if (event.type === 'turn') showRoundFlash('Tu turno');
      if (event.type === 'roll') showRoundFlash('¡En juego!');
      if (event.type === 'quick_result') showRoundFlash(event.text);
      if (event.type === 'win') celebrate();
      if (event.type === 'loss') lossEffect();
    };
    // Ruleta y tragamonedas: la ronda ya se resolvió en el servidor pero la
    // animación del resultado sigue en curso; el aviso espera al
    // descubrimiento (fin natural de la animación o «Saltar animación»).
    if (['win', 'loss', 'push', 'quick_result', 'special_reward'].includes(event.type)) announceGameResult(present);
    else present();
  });
  socket.on('profile_event', payload => {
    if (payload?.profile && ui.room) {
      ui.room.viewerProfile = payload.profile;
      // La caché de la sesión de cuenta también adopta los cambios (fichas de
      // recompensas, renombrado…), para que el perfil del lobby no muestre
      // datos de antes al salir de la mesa. syncAccountSessionIfSameProfile
      // solo actúa si es el MISMO perfil de la cuenta.
      syncAccountSessionIfSameProfile(payload.profile);
      if (ui.me) { ui.me.chips = payload.profile.chips; ui.me.avatar = payload.profile.avatar; ui.me.name = payload.profile.name; }
      renderProfile();
      if (ui.profileOpen) renderProfileModal();
    }
    (payload?.events || []).forEach(event => {
      // Los premios de la ronda (logros, retos, bonos) dependen del resultado:
      // en ruleta y tragamonedas se revelan junto con el descubrimiento, no
      // mientras la rueda o los rodillos siguen girando.
      announceGameResult(() => {
        const kind = event.type === 'achievement' ? 'achievement' : event.type === 'challenge' ? 'challenge' : 'reward';
        showToast(event.type === 'challenge' ? 'Reto completado' : event.type === 'achievement' ? 'Logro desbloqueado' : event.name, `${event.name}${event.reward ? ` · +${event.reward} fichas` : ''}`, kind, 6500, event.icon, true);
        playTone('win');
      });
    });
  });
  socket.on('social_event', event => {
    if (!event?.text) return;
    if (event.type === 'big_win') {
      // La gran ganancia también es parte del descubrimiento en ruleta y
      // tragamonedas: espera a que termine la animación.
      announceGameResult(() => {
        showToast('¡Gran resultado!', event.text, 'reward', 5600, event.icon || '✦', true);
        celebrate();
        showRoundFlash(`+${formatChips(event.amount)} fichas`);
      });
      return;
    }
    showToast('Celebración en la mesa', event.text, 'achievement', 5600, event.icon || '✦', true);
  });
  socket.on('reaction', event => showFloatingReaction(event));
  socket.on('removed', payload => {
    showToast('Saliste de la mesa', payload?.message || 'Tu asiento ya no está disponible.', 'error', 5000);
    leaveToLobby(false);
  });

  function showToast(title, text, kind = 'notice', duration = 3600, icon = null, notification = false) {
    if (notification && !ui.notifications) return;
    const symbols = { error: '!', win: '◆', loss: '×', turn: '◷', notice: '•', round: '♠' };
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.innerHTML = `<div class="toast-icon">${escapeHtml(icon || symbols[kind] || '•')}</div><div class="toast-copy"><b>${escapeHtml(title)}</b><span>${escapeHtml(text)}</span></div><button class="toast-close" aria-label="Cerrar">×</button>`;
    els.toastStack.appendChild(toast);
    const remove = () => { toast.style.opacity = '0'; toast.style.transform = 'translateX(20px)'; setTimeout(() => toast.remove(), 220); };
    toast.querySelector('.toast-close').addEventListener('click', remove);
    setTimeout(remove, duration);
  }
  function showRoundFlash(text) {
    els.roundFlash.textContent = text;
    els.roundFlash.classList.remove('show'); void els.roundFlash.offsetWidth; els.roundFlash.classList.add('show');
  }
  function showFloatingReaction(event) {
    if (!els.reactionStage || !event?.emoji) return;
    const bubble = document.createElement('div');
    bubble.className = 'floating-reaction';
    bubble.style.setProperty('--x', `${12 + Math.random() * 70}%`);
    bubble.innerHTML = `<b>${escapeHtml(event.emoji)}</b><span>${escapeHtml(event.name || 'Jugador')}</span>`;
    els.reactionStage.appendChild(bubble);
    setTimeout(() => bubble.remove(), 2700);
  }
  function celebrate() {
    els.roomApp.classList.add('celebrate');
    for (let index = 0; index < 18; index++) {
      const chip = document.createElement('i'); chip.className = 'chip-particle';
      chip.style.left = `${8 + Math.random() * 84}vw`; chip.style.top = `${-5 - Math.random() * 30}px`;
      chip.style.animationDelay = `${Math.random() * .45}s`; chip.style.background = ['#e5bd72', '#52e0ae', '#d14d5f', '#485d86'][index % 4];
      document.body.appendChild(chip); setTimeout(() => chip.remove(), 2300);
    }
    setTimeout(() => els.roomApp.classList.remove('celebrate'), 1900);
  }
  function lossEffect() {
    els.roomApp.classList.add('loss'); setTimeout(() => els.roomApp.classList.remove('loss'), 700);
  }

  // ---------- Avisos de resultado diferidos (ruleta y tragamonedas) ----------
  // El servidor resuelve la ronda mientras la rueda o los rodillos siguen
  // girando. Para no revelar el resultado antes de tiempo, los avisos que
  // dependen de él (toasts de victoria/derrota/ronda resuelta, premios,
  // destello de ronda y fanfarrias) se RETIENEN hasta que la animación
  // termine — de forma natural o con el botón «Saltar animación» — y se
  // muestran todos juntos en el momento del descubrimiento. En los demás
  // juegos (y fuera de estas dos mesas) se muestran de inmediato, como siempre.
  function quickResultHold() {
    const room = ui.room;
    if (!room || (room.game !== 'roulette' && room.game !== 'slots')) return false;
    // Fase 'rolling': los eventos de resultado llegan justo ANTES de la
    // room_state que arranca la animación, así que la retención ya aplica.
    return Boolean(ui.rouletteSpin || ui.slotsSpin) || room.phase === 'rolling';
  }
  function announceGameResult(announce) {
    if (typeof announce !== 'function') return;
    if (quickResultHold()) ui.resultQueue.push(announce);
    else announce();
  }
  function flushResultQueue() {
    const queue = ui.resultQueue.splice(0, ui.resultQueue.length);
    for (const announce of queue) announce();
  }

  // ---------- Profile, social controls and general room controls ----------
  function stopDailyBonusCountdown() {
    clearInterval(ui.dailyBonusTimer);
    ui.dailyBonusTimer = null;
  }
  function formatDailyBonusCountdown(milliseconds) {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = seconds % 60;
    return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
  }
  function renderDailyBonusCountdown(profile) {
    if (!els.dailyBonusStatus || !els.dailyBonusCountdown) return;
    stopDailyBonusCountdown();
    const availableAt = Number(profile.dailyBonusAvailableAt);
    const tick = () => {
      const remaining = availableAt - Date.now();
      const waiting = Boolean(profile.dailyBonusClaimed) && Number.isFinite(availableAt) && remaining > 0;
      els.dailyBonusCountdown.classList.toggle('available', !waiting);
      if (!waiting) {
        els.dailyBonusStatus.textContent = 'Disponible ahora · entra a una mesa para recibirlo.';
        els.dailyBonusCountdown.textContent = 'DISPONIBLE';
        els.dailyBonusCountdown.removeAttribute('datetime');
        els.dailyBonusCountdown.setAttribute('aria-label', 'Bono diario disponible ahora');
        stopDailyBonusCountdown();
        return;
      }
      const countdown = formatDailyBonusCountdown(remaining);
      els.dailyBonusStatus.textContent = 'Bono de hoy recibido · próximo bono en:';
      els.dailyBonusCountdown.textContent = countdown;
      els.dailyBonusCountdown.setAttribute('datetime', new Date(availableAt).toISOString());
      els.dailyBonusCountdown.setAttribute('aria-label', `Próximo bono diario en ${countdown}`);
    };
    tick();
    if (ui.dailyBonusTimer === null && profile.dailyBonusClaimed && availableAt > Date.now()) {
      ui.dailyBonusTimer = setInterval(tick, 1000);
    }
  }
  // El modal de perfil muestra el perfil de la mesa si hay una, o el de la
  // cuenta iniciada si no (ver currentViewerProfile). Nunca se fabrica un
  // objeto de mesa falso como sustituto de la sesión de cuenta: fuera de una
  // mesa, `ui.room` sigue siendo exactamente lo que el servidor mandó (o null).
  function openProfileModal() {
    const profile = currentViewerProfile();
    if (!profile) return;
    ui.profileOpen = true;
    ui.profileNameDirty = false;
    ui.profileAvatar = profile.avatar || 'fox';
    renderProfileModal();
    els.profileModal.classList.add('open');
    els.profileModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    // Fuera de una mesa, la caché de localStorage puede haber quedado vieja
    // (rondas jugadas aquí o desde otro dispositivo, nombre cambiado al entrar
    // a una mesa, bono diario…). Se pide SIEMPRE el perfil público actualizado
    // al servidor: el modal pinta la caché al instante y, si el servidor trae
    // algo distinto, se vuelve a renderizar con los datos frescos (sin pisar
    // una edición en curso — ver el guard de profileNameDirty en
    // renderProfileModal). Antes solo se refrescaba si faltaban campos, y el
    // perfil del lobby se quedaba con el nombre y los puntos de antes hasta
    // que la persona volvía a guardar.
    if (!inTable()) refreshAccountProfile();
  }
  function closeProfileModal() {
    ui.profileOpen = false;
    ui.profileNameDirty = false;
    stopDailyBonusCountdown();
    els.passwordChangeForm?.reset();
    els.passwordChangeForm?.classList.add('hidden');
    els.passwordChangeError?.classList.add('hidden');
    els.profileModal?.classList.remove('open');
    els.profileModal?.setAttribute('aria-hidden', 'true');
    if (!els.modal.classList.contains('open')) document.body.classList.remove('modal-open');
  }
  function renderProfileModal() {
    const profile = currentViewerProfile();
    if (!profile) return;
    const stats = profile.stats || {};
    // Un refresco en segundo plano (refreshAccountProfile o un profile_event
    // de la mesa) puede llegar mientras la persona ya escribió un nombre
    // nuevo: nunca se pisa su edición en curso. El guardado sigue siendo
    // explícito, con el botón del formulario.
    if (!ui.profileNameDirty) els.profileNameInput.value = profile.name || ui.playerName;
    ui.profileAvatar = ui.profileAvatar || profile.avatar;
    els.profileBigAvatar.textContent = avatarEmoji(ui.profileAvatar);
    renderAvatarChoices();
    // Cuenta: username (si hay) + recordatorio de que jugar sin cuenta sigue
    // funcionando igual. `profile.username` es un campo público del servidor,
    // presente tanto en el perfil de mesa como en el de la sesión de cuenta.
    if (els.profileAccountStatus) {
      els.profileAccountStatus.textContent = profile.username
        ? `Cuenta vinculada: @${profile.username}`
        : 'Sin cuenta vinculada (modo invitado) · la cuenta es opcional.';
    }
    // "Cerrar sesión" solo tiene sentido si hay una sesión de cuenta activa.
    if (els.accountLogout) els.accountLogout.classList.toggle('hidden', !ui.accountSession);
    if (els.accountPasswordToggle) els.accountPasswordToggle.classList.toggle('hidden', !ui.accountSession);
    if (!ui.accountSession) els.passwordChangeForm?.classList.add('hidden');
    // Fase 11.4: insignias de fin de temporada (banner único + medallas coleccionables).
    if (els.profileBadges) {
      const chips = [];
      if (profile.championBanner) chips.push('<span class="profile-badge badge-champion" title="Banner dorado de por vida: fue líder de una temporada">🎖️ Banner dorado</span>');
      if (profile.medals) chips.push(`<span class="profile-badge badge-medals" title="${profile.medals} temporada${profile.medals === 1 ? '' : 's'} ganada${profile.medals === 1 ? '' : 's'}">🥇 ×${profile.medals}</span>`);
      els.profileBadges.innerHTML = chips.join('');
      els.profileBadges.classList.toggle('hidden', !chips.length);
    }
    const unlockedAchievements = (profile.achievements || []).length;
    const totalAchievements = (profile.allAchievements || []).length || unlockedAchievements;
    els.profileStats.innerHTML = [
      ['FICHAS', formatChips(profile.chips), 'gold'], ['VICTORIAS', formatChips(stats.wins), ''],
      ['% DE VICTORIAS', `${stats.winRate ?? 0}%`, stats.winRate >= 50 ? 'gold' : ''],
      ['RONDAS', formatChips(stats.roundsPlayed), ''], ['MAYOR GANANCIA', `+${formatChips(stats.biggestWin)}`, 'gold'],
      ['APOSTADO', formatChips(stats.totalWagered), ''], ['MEJOR RACHA', formatChips(stats.bestStreak), ''],
      ['RACHA VÁLIDA', formatChips(stats.eligibleBestStreak ?? stats.bestStreak), 'gold'],
      ['JUEGOS PROBADOS', `${formatChips(stats.differentGames)} / 6`, ''], ['DERROTAS', formatChips(stats.losses), ''],
      ['LOGROS DESBLOQUEADOS', `${unlockedAchievements}/${totalAchievements}`, unlockedAchievements ? 'gold' : '']
    ].map(([label,value,kind]) => `<div class="profile-stat"><small>${label}</small><b class="${kind}">${value}</b></div>`).join('');
    renderBalanceChart(profile);
    // Fase 11.1: descarga del historial completo (no solo lo que cabe en la gráfica).
    // Usa el id del perfil que se está mostrando (mesa o cuenta), no siempre el
    // token de este dispositivo: si se ve el perfil de una cuenta desde el
    // lobby, el historial descargable debe ser el de esa cuenta.
    if (els.historyDownload) {
      const historyId = profile.id || profile.accountId || getDeviceToken();
      els.historyDownload.href = `/api/perfil/${encodeURIComponent(historyId)}/historial`;
    }
    renderGameBreakdown(profile);
    const activeChallenges = [...(profile.dailyChallenges || []), ...(profile.weeklyChallenges || [])];
    if (els.rotatingChallengeList) {
      els.rotatingChallengeList.innerHTML = activeChallenges.map(item => {
        const percent = Math.min(100, Math.round((item.value || 0) / item.target * 100));
        return `<div class="rotating-challenge ${item.completed ? 'done' : ''}"><div class="rotating-challenge-head"><span>${escapeHtml(item.periodLabel)}</span><b>${escapeHtml(item.name)}</b><em>${item.completed ? '✓' : item.value + '/' + item.target}</em></div><small>${escapeHtml(item.description)} · ${escapeHtml(item.difficulty)}</small><div class="progress-track"><i style="width:${percent}%"></i></div></div>`;
      }).join('') || '<div class="chat-system">Los retos activos aparecerán al comenzar una ronda.</div>';
    }
    els.challengeList.innerHTML = (profile.challenges || []).map(item => {
      const percent = Math.min(100, Math.round((item.value || 0) / item.target * 100));
      const difficulty = item.difficulty ? `<span class="progress-difficulty">${escapeHtml(item.difficulty)}</span>` : '';
      return `<div class="progress-item ${item.completed ? 'done' : ''}"><span class="progress-icon">${escapeHtml(item.icon)}</span><div class="progress-copy"><b>${escapeHtml(item.name)} ${difficulty}</b><small>${escapeHtml(item.description)} · ${item.value}/${item.target}</small><div class="progress-track"><i style="width:${percent}%"></i></div></div><span class="progress-reward">${item.completed ? '✓' : '+' + item.reward}</span></div>`;
    }).join('') || '<div class="chat-system">Los retos aparecerán al jugar.</div>';
    els.achievementList.innerHTML = (profile.allAchievements || []).map(item => {
      const rarity = item.rarity ? `<span class="progress-rarity ${escapeHtml(item.rarity)}">${escapeHtml(item.rarity)}</span>` : '';
      return `<div class="progress-item ${item.unlocked ? 'done' : 'locked'}"><span class="progress-icon">${escapeHtml(item.unlocked ? item.icon : '◇')}</span><div class="progress-copy"><b>${escapeHtml(item.name)} ${rarity}</b><small>${escapeHtml(item.description)}</small></div><span class="progress-reward">${item.unlocked ? '✓' : '+' + item.reward}</span></div>`;
    }).join('') || '<div class="chat-system">Aún no hay logros.</div>';
    if (els.featuredAchievements) {
      const selected = new Set(profile.featuredAchievements || []);
      const unlocked = (profile.allAchievements || []).filter(item => item.unlocked);
      els.featuredAchievements.innerHTML = unlocked.length
        ? unlocked.map(item => `<button type="button" class="featured-achievement ${selected.has(item.id) ? 'selected' : ''}" data-feature-achievement="${escapeHtml(item.id)}" title="${selected.has(item.id) ? 'Quitar de la vitrina' : 'Mostrar en la vitrina'}"><span>${escapeHtml(item.icon)}</span><b>${escapeHtml(item.name)}</b></button>`).join('')
        : '<small class="featured-empty">Desbloquea un logro para comenzar tu colección.</small>';
      $$('.featured-achievement').forEach(button => button.addEventListener('click', async () => {
        const id = button.dataset.featureAchievement;
        const next = new Set(profile.featuredAchievements || []);
        if (next.has(id)) next.delete(id);
        else if (next.size >= 3) return showToast('Vitrina completa', 'Puedes destacar hasta 3 logros.', 'notice');
        else next.add(id);
        const payload = { name: profile.name, avatar: profile.avatar, featuredAchievements: [...next] };
        if (!inTable()) payload.accountId = ui.accountSession?.accountId;
        const response = await emitAck('profile_update', payload, button);
        if (!response.ok) {
          // Falla la actualización: se conservan los datos anteriores (no se
          // toca ui.room ni ui.accountSession) y se avisa con un error claro.
          return showToast('No se actualizó la vitrina', response.error || 'No se pudo guardar en el servidor. Se conservó tu vitrina anterior.', 'error');
        }
        if (response.profile) {
          if (ui.room) ui.room.viewerProfile = response.profile;
          if (!inTable()) saveAccountSession(response.profile);
          else syncAccountSessionIfSameProfile(response.profile);
        }
        renderProfileModal();
      }));
    }
    renderDailyBonusCountdown(profile);
  }
  // Fase 8.2: gráfica SVG de evolución del saldo (últimos 60 movimientos).
  function renderBalanceChart(profile) {
    if (!els.balanceChart) return;
    const history = profile.balanceHistory || [];
    if (history.length < 2) {
      els.balanceChart.innerHTML = '<div class="chart-empty">Juega algunas rondas y aquí verás cómo evoluciona tu saldo.</div>';
      if (els.balanceChartNote) els.balanceChartNote.textContent = 'Tus últimos movimientos';
      return;
    }
    const values = history.map(point => point.chips);
    const min = Math.min(...values), max = Math.max(...values);
    const span = Math.max(1, max - min);
    const w = 520, h = 130, pad = 8;
    const step = (w - pad * 2) / (values.length - 1);
    const points = values.map((value, index) => [pad + index * step, pad + (h - pad * 2) * (1 - (value - min) / span)]);
    const line = points.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
    const area = `${pad},${h - pad} ${line} ${(pad + (values.length - 1) * step).toFixed(1)},${h - pad}`;
    const rising = values[values.length - 1] >= values[0];
    const last = points[points.length - 1];
    els.balanceChart.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${area}" class="spark-fill ${rising ? 'up' : 'down'}"></polygon>
        <polyline points="${line}" class="spark-line ${rising ? 'up' : 'down'}"></polyline>
        <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.4" class="spark-dot ${rising ? 'up' : 'down'}"></circle>
      </svg>
      <div class="chart-legend"><span>MÍN ◆ ${formatChips(min)}</span><span class="${rising ? 'trend-up' : 'trend-down'}">${rising ? '▲' : '▼'} ${formatChips(Math.abs(values[values.length - 1] - values[0]))} en la sesión</span><span>MÁX ◆ ${formatChips(max)}</span></div>`;
    if (els.balanceChartNote) els.balanceChartNote.textContent = `Últimos ${history.length} movimientos`;
  }
  // Fase 8.2: tabla de rendimiento por juego.
  function renderGameBreakdown(profile) {
    if (!els.gameBreakdown) return;
    const gameStats = profile.gameStats || {};
    const rows = Object.keys(GAME_META)
      .filter(game => gameStats[game]?.rounds > 0)
      .map(game => {
        const entry = gameStats[game];
        const meta = GAME_META[game];
        const rate = entry.rounds > 0 ? Math.round(entry.wins / entry.rounds * 100) : 0;
        const netClass = entry.net > 0 ? 'net-up' : entry.net < 0 ? 'net-down' : '';
        return `<div class="game-breakdown-row">
          <span class="gb-game">${meta.icon} ${escapeHtml(meta.name)}</span>
          <span class="gb-cell">${formatChips(entry.rounds)} ${entry.rounds === 1 ? 'ronda' : 'rondas'}</span>
          <span class="gb-cell">${formatChips(entry.wins)} ${entry.wins === 1 ? 'victoria' : 'victorias'} · ${rate}%</span>
          <span class="gb-net ${netClass}">${entry.net > 0 ? '+' : ''}${formatChips(entry.net)}</span>
        </div>`;
      });
    els.gameBreakdown.innerHTML = rows.join('') || '<div class="chart-empty">Prueba los juegos del casino y compara aquí tu rendimiento.</div>';
  }
  // ---------- Fase 11.2: login opcional (usuario + contraseña) ----------
  function renderAccountMode() {
    const isLogin = ui.accountMode === 'login';
    els.accountModalTitle.textContent = isLogin ? 'Iniciar sesión' : 'Crear cuenta';
    els.accountModalCopy.textContent = isLogin
      ? 'Jugar sin cuenta sigue funcionando igual que siempre. Si ya vinculaste un usuario y contraseña a tu perfil, inicia sesión aquí para recuperar tus fichas, logros e historial en esta computadora.'
      : 'Esto vincula un usuario y contraseña a TU perfil actual de esta computadora (mismas fichas, logros e historial) para que puedas recuperarlo iniciando sesión desde cualquier otra.';
    els.accountSubmit.innerHTML = `<span class="btn-label">${isLogin ? 'Iniciar sesión' : 'Crear cuenta'}</span>`;
    els.accountSwitch.textContent = isLogin ? '¿No tienes cuenta todavía? Crear una con mi perfil actual' : '¿Ya tienes cuenta? Iniciar sesión';
    els.accountPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
    els.accountError.classList.add('hidden');
    els.accountError.textContent = '';
  }
  function openAccountModal() {
    if (ui.accountSession?.username) { openProfileModal(); return; }
    ui.accountMode = 'login';
    renderAccountMode();
    els.accountForm.reset();
    els.accountModal.classList.add('open');
    els.accountModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    els.accountUsername.focus();
  }
  function closeAccountModal() {
    els.accountModal?.classList.remove('open');
    els.accountModal?.setAttribute('aria-hidden', 'true');
    if (!els.modal.classList.contains('open') && !els.profileModal.classList.contains('open')) {
      document.body.classList.remove('modal-open');
    }
  }
  async function loadMyReports(){const response=await secureAuthRequest('/api/reports/mine');if(!response.ok){els.myReportsList.textContent=response.error||'No se pudieron cargar.';return;}const labels={open:'Recibido',triaged:'Clasificado',investigating:'En revisión',resolved:'Resuelto',rejected:'Cerrado'};els.myReportsList.innerHTML=response.reports.map(report=>`<div class="my-report"><b>${escapeHtml(report.category)}</b><span>${escapeHtml(labels[report.status]||report.status)}</span><small>${new Date(report.createdAt).toLocaleDateString()} · ${escapeHtml(report.id.slice(0,8))}</small></div>`).join('')||'<small>No has enviado reportes.</small>';}
  async function openReportModal(username = '', messageId = null) {
    const isMessageReport = Boolean(messageId);
    if (!ui.accountSession && !isMessageReport) return showToast('Inicia sesión', 'Los invitados solo pueden reportar mensajes visibles.', 'notice');
    ui.reportMessageId = messageId || null;
    els.reportedUsername.value = username;
    els.reportedUsername.readOnly = Boolean(username);
    els.reportedUsername.required = !isMessageReport;
    els.reportUserField?.classList.toggle('hidden', isMessageReport);
    els.reportTitle.textContent = isMessageReport ? 'Reportar mensaje' : 'Reportar un usuario';
    els.reportCopy.textContent = isMessageReport
      ? 'El mensaje se adjuntará como evidencia y el autor se identificará de forma segura.'
      : 'Describe lo ocurrido. Los reportes falsos o abusivos también pueden revisarse.';
    els.reportModal.classList.add('open');
    els.reportModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    if (ui.accountSession) {
      if (!ui.csrfToken) {
        const current = await secureAuthRequest('/api/auth/session');
        if (current.ok) ui.csrfToken = current.csrfToken;
      }
      await loadMyReports();
    } else {
      els.myReportsList.textContent = 'El seguimiento requiere una cuenta.';
    }
    (isMessageReport ? els.reportCategory : els.reportedUsername).focus();
  }
  function closeReportModal() {
    els.reportModal.classList.remove('open');
    els.reportModal.setAttribute('aria-hidden', 'true');
    els.reportedUsername.readOnly = false;
    els.reportedUsername.required = true;
    els.reportUserField?.classList.remove('hidden');
    els.reportTitle.textContent = 'Reportar un usuario';
    els.reportCopy.textContent = 'Describe lo ocurrido. Los reportes falsos o abusivos también pueden revisarse.';
    ui.reportMessageId = null;
    document.body.classList.remove('modal-open');
  }
  els.reportOpenBtn?.addEventListener('click', () => openReportModal());
  els.myReportsRefresh?.addEventListener('click', loadMyReports);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-report-message]');
    if (button) openReportModal('', button.dataset.reportMessage);
  });
  $$('[data-close-report]').forEach(element => element.addEventListener('click', closeReportModal));
  els.reportForm?.addEventListener('submit', async event => {
    event.preventDefault();
    els.reportError.classList.add('hidden');
    const payload = {
      category: els.reportCategory.value,
      description: els.reportDescription.value,
      ...(ui.reportMessageId
        ? { messageId: ui.reportMessageId }
        : { reportedUsername: els.reportedUsername.value.trim() })
    };
    const response = await secureAuthRequest('/api/reports', {
      method: 'POST',
      headers: ui.accountSession
        ? (ui.csrfToken ? { 'X-CSRF-Token': ui.csrfToken } : {})
        : { 'X-Device-Token': deviceToken },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      els.reportError.textContent = response.error || 'No se pudo enviar el reporte.';
      els.reportError.classList.remove('hidden');
      return;
    }
    els.reportForm.reset();
    closeReportModal();
    showToast('Reporte recibido', `Folio ${response.reportId}`, 'notice', 5000, '🛡️');
  });
  els.accountOpenBtn?.addEventListener('click', openAccountModal);
  $$('[data-close-account]').forEach(element => element.addEventListener('click', closeAccountModal));
  els.accountPasswordToggle?.addEventListener('click', () => {
    els.passwordChangeForm?.classList.toggle('hidden');
    els.passwordChangeError?.classList.add('hidden');
    if (!els.passwordChangeForm?.classList.contains('hidden')) els.currentPassword?.focus();
  });
  els.passwordChangeCancel?.addEventListener('click', () => {
    els.passwordChangeForm?.reset();
    els.passwordChangeForm?.classList.add('hidden');
    els.passwordChangeError?.classList.add('hidden');
  });
  els.passwordChangeForm?.addEventListener('submit', async event => {
    event.preventDefault();
    els.passwordChangeError.classList.add('hidden');
    if (els.newPassword.value !== els.confirmPassword.value) {
      els.passwordChangeError.textContent = 'Las contraseñas nuevas no coinciden.';
      els.passwordChangeError.classList.remove('hidden');
      return;
    }
    await serverFlagsReady;
    if (!accountSessionsAvailable()) {
      // El endpoint respondería 404 fail-closed; se evita la petición para no
      // generar el 404 en la consola del navegador.
      els.passwordChangeError.textContent = 'Activa primero las sesiones seguras para cambiar la contraseña.';
      els.passwordChangeError.classList.remove('hidden');
      return;
    }
    if (!ui.csrfToken) {
      const current = await secureAuthRequest('/api/auth/session');
      if (current.ok) ui.csrfToken = current.csrfToken || null;
    }
    els.passwordChangeSubmit.disabled = true;
    const response = await secureAuthRequest('/api/auth/change-password', {
      method: 'POST',
      headers: ui.csrfToken ? { 'X-CSRF-Token': ui.csrfToken } : {},
      body: JSON.stringify({ currentPassword: els.currentPassword.value, newPassword: els.newPassword.value })
    });
    els.passwordChangeSubmit.disabled = false;
    if (!response.ok) {
      els.passwordChangeError.textContent = response.status === 404
        ? 'Activa primero las sesiones seguras para cambiar la contraseña.'
        : response.error || 'No se pudo actualizar la contraseña.';
      els.passwordChangeError.classList.remove('hidden');
      return;
    }
    ui.csrfToken = response.csrfToken || null;
    if (response.profile) saveAccountSession(response.profile);
    els.passwordChangeForm.reset();
    els.passwordChangeForm.classList.add('hidden');
    if (socket.connected) socket.disconnect().connect();
    showToast('Contraseña actualizada', 'Las demás sesiones fueron cerradas y esta sesión se renovó.', 'notice', 4200, '🔒');
  });
  els.accountLogout?.addEventListener('click', async () => {
    // Intenta revocar la cookie segura. Con el rollout apagado (flag leído de
    // /healthz) no se generan las peticiones: el backend respondería 404
    // fail-closed y el navegador lo loguearía en consola; solo se aplica la
    // limpieza local del flujo legado.
    await serverFlagsReady;
    if (accountSessionsAvailable()) {
      if (!ui.csrfToken) {
        const current = await secureAuthRequest('/api/auth/session');
        if (current.ok) ui.csrfToken = current.csrfToken || null;
      }
      await secureAuthRequest('/api/auth/logout', {
        method: 'POST', headers: ui.csrfToken ? { 'X-CSRF-Token': ui.csrfToken } : {}
      });
    }
    clearAccountSession();
    if (socket.connected) socket.disconnect().connect();
    closeProfileModal();
    showToast('Sesión cerrada', 'Tu perfil y fichas de este dispositivo siguen intactos. Puedes seguir jugando sin cuenta.', 'notice', 3600, '🔑');
  });
  els.accountSwitch?.addEventListener('click', () => {
    ui.accountMode = ui.accountMode === 'login' ? 'signup' : 'login';
    renderAccountMode();
  });
  els.accountForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const username = els.accountUsername.value.trim();
    const password = els.accountPassword.value;
    els.accountError.classList.add('hidden');
    if (ui.accountMode === 'login') {
      els.accountSubmit.disabled = true;
      await serverFlagsReady;
      // Mientras el rollout está apagado, el endpoint responde 404 y se
      // conserva temporalmente el login legado. El flag se lee de /healthz
      // para no generar ese 404 en la consola del navegador; si el despliegue
      // cambió en vivo, el 404 sigue activando el fallback. Con la función
      // encendida no existe fallback: credenciales/sesiones inválidas fallan
      // cerrado.
      let response = accountSessionsAvailable()
        ? await secureAuthRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
        : { status: 404 };
      const secureLogin = response.status !== 404;
      if (!secureLogin) response = await emitAck('account_login', { username, password });
      els.accountSubmit.disabled = false;
      if (!response.ok || !response.profile) {
        els.accountError.textContent = response.error || 'No se pudo iniciar sesión.';
        els.accountError.classList.remove('hidden');
        return;
      }
      // Importante: NO se guarda response.token como token de dispositivo.
      // Ese token es el id del PERFIL DE LA CUENTA (puede ser el de otra
      // computadora); guardarlo como `montecristo-device` mezclaría la
      // identidad de la cuenta con la del dispositivo y, al cerrar sesión,
      // dejaría este dispositivo "convertido" en la cuenta ajena en vez de
      // volver a su perfil anónimo. Solo se guardan los campos públicos del
      // perfil (sanitizeProfileForSession), bajo su propia clave de sesión.
      if (!saveAccountSession(response.profile)) {
        els.accountError.textContent = 'No se pudo iniciar sesión.';
        els.accountError.classList.remove('hidden');
        return;
      }
      // Socket.IO leyó cookies durante su handshake anterior; reconectar hace
      // que adopte la nueva sesión sin enviar token alguno desde JavaScript.
      if (secureLogin) ui.csrfToken = response.csrfToken || null;
      if (secureLogin && socket.connected) socket.disconnect().connect();
      showToast('Sesión iniciada', `Bienvenido de nuevo, ${response.profile.name || username}. Tus datos públicos están disponibles en Perfil.`, 'notice', 3800, '👤');
      closeAccountModal();
      els.accountPassword.value = '';
    } else {
      const response = await emitAck('account_signup', {
        token: deviceToken, name: ui.playerName, avatar: ui.selectedAvatar, username, password, tos: TOS_VERSION
      }, els.accountSubmit);
      if (!response.ok || !response.profile) {
        els.accountError.textContent = response.error || 'No se pudo crear la cuenta.';
        els.accountError.classList.remove('hidden');
        return;
      }
      // Si las sesiones seguras están activas, el alta se completa creando la
      // cookie por HTTP. Con rollout apagado (flag leído de /healthz, con el
      // 404 como red de seguridad) se conserva el comportamiento anterior sin
      // mezclar el id de perfil con una credencial.
      await serverFlagsReady;
      const secureSignupLogin = accountSessionsAvailable()
        ? await secureAuthRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
        : { status: 404 };
      if (secureSignupLogin.status !== 404 && (!secureSignupLogin.ok || !secureSignupLogin.profile)) {
        els.accountError.textContent = secureSignupLogin.error || 'La cuenta fue creada, pero no se pudo iniciar la sesión segura.';
        els.accountError.classList.remove('hidden');
        return;
      }
      const activeProfile = secureSignupLogin.profile || response.profile;
      if (secureSignupLogin.status !== 404) ui.csrfToken = secureSignupLogin.csrfToken || null;
      saveAccountSession(activeProfile);
      if (secureSignupLogin.status !== 404 && socket.connected) socket.disconnect().connect();
      showToast('Cuenta creada', `Ya puedes iniciar sesión como @${activeProfile.username || username} desde cualquier otra computadora.`, 'notice', 4200, '👤');
      closeAccountModal();
      els.accountPassword.value = '';
    }
  });

  els.profileCard.addEventListener('click', openProfileModal);
  els.profileCard.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProfileModal(); } });
  $$('[data-close-profile]').forEach(element => element.addEventListener('click', closeProfileModal));
  // Marca la edición en curso del nombre para que los refrescos en segundo
  // plano no sobrescriban lo que la persona está escribiendo.
  els.profileNameInput.addEventListener('input', () => { ui.profileNameDirty = true; });
  els.profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const name = els.profileNameInput.value.trim();
    const avatar = ui.profileAvatar;
    const payload = { name, avatar };
    // Fuera de una mesa, el servidor necesita saber a qué cuenta pertenece la
    // edición (no hay jugador de mesa que identifique el perfil).
    if (!inTable()) payload.accountId = ui.accountSession?.accountId;
    const response = await emitAck('profile_update', payload, button);
    if (!response.ok) {
      // Se conservan los datos anteriores (no se toca ui.room/ui.accountSession
      // ni localStorage) y se muestra un error claro.
      return showToast('No se guardó el perfil', response.error || 'No se pudo actualizar tu perfil en el servidor. Se conservaron tus datos anteriores.', 'error');
    }
    if (response.profile) {
      if (ui.room) ui.room.viewerProfile = response.profile;
      if (!inTable()) saveAccountSession(response.profile);
      else syncAccountSessionIfSameProfile(response.profile);
    }
    ui.playerName = response.profile?.name || name;
    ui.selectedAvatar = response.profile?.avatar || avatar;
    ui.profileNameDirty = false; // lo guardado ya es el estado actual: se puede volver a pintar desde el perfil
    localStorage.setItem('montecristo-name', ui.playerName);
    localStorage.setItem('montecristo-lobby-name', ui.playerName);
    localStorage.setItem('montecristo-avatar', ui.selectedAvatar);
    // La sesión de reingreso debe quedar al día en el mismo tick del ack. Si la
    // página se recarga antes del siguiente room_state, ya no puede revivir el
    // nombre/avatar con los que se entró originalmente a la mesa.
    saveSession();
    showToast('Perfil actualizado', inTable() ? 'Tu nombre y avatar ya están visibles en la mesa.' : 'Tu perfil se guardó en el servidor.', 'notice', 3600, avatarEmoji(ui.selectedAvatar));
    renderProfileModal();
  });
  $$('[data-reaction]').forEach(button => button.addEventListener('click', async () => {
    const response = await emitAck('reaction', { emoji: button.dataset.reaction });
    if (!response.ok) showToast('Reacción no enviada', response.error, 'error');
  }));
  els.quickChatToggle.addEventListener('click', () => els.quickChatMenu.classList.toggle('hidden'));
  $$('[data-quick-chat]').forEach(button => button.addEventListener('click', async () => {
    els.quickChatMenu.classList.add('hidden');
    const response = await emitAck('quick_chat', { message: button.dataset.quickChat });
    if (!response.ok) showToast('Mensaje no enviado', response.error, 'error');
  }));
  function closeBotControls() {
    els.botControls?.classList.add('hidden');
    els.botMenuToggle?.setAttribute('aria-expanded', 'false');
  }
  els.botMenuToggle?.addEventListener('click', () => {
    const opening = els.botControls.classList.contains('hidden');
    els.botControls.classList.toggle('hidden', !opening);
    els.botMenuToggle.setAttribute('aria-expanded', String(opening));
  });
  els.botMenuClose?.addEventListener('click', closeBotControls);
  async function configureBots(eventName, button) {
    const payload = { difficulty: els.botDifficulty.value, style: els.botStyle.value };
    const response = await emitAck(eventName, payload, button);
    renderBotControls();
    if (!response.ok) return showToast('No se pudo configurar', response.error, 'error');
    showToast(eventName === 'bot_fill' ? 'Mesa completada' : 'Bot agregado', 'La IA ya ocupa un asiento y jugará con reglas autoritativas.', 'notice', 3600, '🤖');
    if (eventName === 'bot_fill') closeBotControls();
  }
  els.botAdd?.addEventListener('click', event => configureBots('bot_add', event.currentTarget));
  els.botFill?.addEventListener('click', event => configureBots('bot_fill', event.currentTarget));

  els.chatForm.addEventListener('submit', async event => {
    event.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    els.chatInput.value = '';
    const response = await emitAck('chat', { text });
    if (!response.ok) { els.chatInput.value = text; showToast('No se envió el mensaje', response.error, 'error'); }
  });
  $('#copy-link').addEventListener('click', async event => {
    const button = event.currentTarget;
    const url = `${location.origin}/room/${ui.activeCode || ui.room?.code || ''}`;
    try { await navigator.clipboard.writeText(url); }
    catch {
      const input = document.createElement('input'); input.value = url; document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
    }
    const original = button.innerHTML; button.innerHTML = '<span>✓</span><b>Copiado</b>'; playTone('notice');
    showToast('Enlace copiado', 'Compártelo para llenar la mesa.', 'notice');
    setTimeout(() => { button.innerHTML = original; }, 1600);
  });
  $('#leave-room').addEventListener('click', () => leaveToLobby(true));
  $('#room-logo').addEventListener('click', event => { event.preventDefault(); leaveToLobby(true); });
  async function leaveToLobby(notifyServer = true) {
    closeProfileModal(); closeBotControls();
    // Al salir de la mesa, la caché de la sesión de cuenta adopta el último
    // estado conocido del perfil (si es el mismo de la cuenta): nombre y
    // fichas tal como quedaron tras jugar. Sin esto, el perfil del lobby
    // seguía mostrando los datos de cuando se inició sesión hasta volver a
    // guardar (bug reportado: "entré a mi perfil y no se actualizó").
    syncAccountSessionIfSameProfile(ui.room?.viewerProfile);
    if (notifyServer && ui.room) await emitAck('leave_room');
    clearInterval(ui.clockTimer); clearSession(); ui.room = null; ui.me = null; ui.activeCode = null; ui.spectating = false;
    ui.rouletteSpin = null; ui.rouletteAngle = 0; ui.slotsSpin = null; ui.resultQueue = [];
    ui.lastGameSignature = ''; ui.lastChatSignature = ''; ui.previousRanks = new Map(); ui.previousChips = new Map(); ui.lastMeChips = null;
    els.roomApp.classList.add('exiting');
    setTimeout(() => {
      els.roomApp.classList.add('hidden'); els.roomApp.classList.remove('exiting'); els.landing.classList.remove('hidden');
      els.lobbyChatWidget?.classList.remove('in-room');
      updateHistory(''); window.scrollTo(0, 0);
      tryAutoJoinLobbyChat();
    }, 280);
  }

  [els.notificationsToggle, els.roomNotificationsToggle].filter(Boolean).forEach(button => button.addEventListener('click', () => {
    ui.notifications = !ui.notifications;
    localStorage.setItem('montecristo-notifications', ui.notifications ? 'on' : 'off');
    updateNotificationButtons();
  }));
  els.lobbyChatBubble?.addEventListener('click', () => setLobbyChatOpen(!ui.lobbyChat.open));
  els.lobbyChatClose?.addEventListener('click', () => setLobbyChatOpen(false));
  els.lobbyChatProfileForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const response = await joinLobbyChat(els.lobbyChatName.value, els.lobbyChatTos.checked);
    if (response.ok) setLobbyChatOpen(true);
  });
  els.lobbyChatForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const text = els.lobbyChatInput.value.trim();
    if (!text) return;
    els.lobbyChatInput.value = '';
    const response = await emitAck('lobby_chat', { text });
    if (!response.ok) {
      els.lobbyChatInput.value = text;
      showToast('No se envió el mensaje', response.error, 'error');
    }
  });
  els.soundToggle.addEventListener('click', () => {
    ui.sound = !ui.sound; localStorage.setItem('montecristo-sound', ui.sound ? 'on' : 'off'); updateSoundButton(); if (ui.sound) playTone('notice');
  });
  function updateSoundButton() { els.soundToggle.classList.toggle('off', !ui.sound); els.soundToggle.textContent = ui.sound ? '♪' : '×'; els.soundToggle.title = ui.sound ? 'Desactivar sonido' : 'Activar sonido'; }
  window.addEventListener('popstate', () => { if (!getRouteCode() && ui.room) leaveToLobby(true); });
})();
