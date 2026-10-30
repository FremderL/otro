(() => {
  'use strict';

  // Utilidades puras del chat (public/chat-format.js), disponibles desde el arranque.
  const { formatChatText, chatMentionsName, chatRoleBadge, countAdded, bindJump, paintList } = window.MonteChat;

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
  // Flags públicos del despliegue (GET /healthz), leídos una sola vez. Las
  // sesiones de cuenta conservan su fallback si healthz falla; el Pasaporte,
  // en cambio, queda oculto por seguridad hasta que el servidor confirme que
  // está activado expresamente.
  const serverFlags = { accountSessions: null, passport: null, cardGacha: null };
  const serverFlagsReady = fetch('/healthz', { cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null))
    .then(data => {
      serverFlags.accountSessions = !data || data.accountSessionsEnabled !== false;
      // El Pasaporte usa activación fail-closed: healthz debe confirmarlo de
      // forma explícita para mostrar la sección del perfil.
      serverFlags.passport = data?.passportEnabled === true;
      // Gachapón de cartas: solo se muestra si healthz lo confirma de forma explícita.
      serverFlags.cardGacha = data?.cardGachaEnabled === true;
      setFortuneAvailability(data?.fortuneEnabled !== false);
      document.getElementById('profile-section-album')?.classList.toggle('hidden', !serverFlags.cardGacha);
      document.getElementById('profile-tab-album')?.classList.toggle('hidden', !serverFlags.cardGacha);
      if (!serverFlags.cardGacha && ui.profileSection === 'album') jumpToProfileSection('overview');
      document.getElementById('passport-panel')?.classList.toggle('hidden', !serverFlags.passport);
      document.getElementById('profile-section-passport')?.classList.toggle('hidden', !serverFlags.passport);
      document.getElementById('profile-tab-passport')?.classList.toggle('hidden', !serverFlags.passport);
      if (!serverFlags.passport && ui.profileSection === 'passport') jumpToProfileSection('overview');
      if (ui.room) renderRoom();
      else if (ui.profileOpen) renderProfileModal();
    })
    .catch(() => {
      // Sin datos de salud no se ofrece la Rueda, pero el resto del lobby sigue
      // igual que antes (la Rueda se habilita al recargar con el servidor sano).
      setFortuneAvailability(false);
      serverFlags.accountSessions = true;
      serverFlags.passport = false;
      document.getElementById('passport-panel')?.classList.add('hidden');
      document.getElementById('profile-section-passport')?.classList.add('hidden');
      document.getElementById('profile-tab-passport')?.classList.add('hidden');
      if (ui.profileSection === 'passport') jumpToProfileSection('overview');
      if (ui.room) renderRoom();
      else if (ui.profileOpen) renderProfileModal();
    });
  function setFortuneAvailability(available) {
    // La Rueda está activa salvo que el servidor la apague (FORTUNE_ENABLED=off)
    // o que su diario no haya podido iniciarse; el lobby refleja ese estado.
    document.querySelectorAll('[data-game="fortune"], [data-select-game="fortune"]').forEach(button => {
      button.disabled = !available;
      if (!available) button.setAttribute('title', 'La Rueda no está disponible en este momento.');
      else button.removeAttribute('title');
    });
    const caption = document.querySelector('[data-game="fortune"] span');
    if (caption) caption.textContent = available ? 'Elegir mi sector' : 'Rueda no disponible';
  }
  function accountSessionsAvailable() { return serverFlags.accountSessions !== false; }
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  function bettingSpaceModalIsOpen() {
    return Boolean(document.getElementById('betting-space-modal')?.classList.contains('open'));
  }
  function syncBetRankingSubscription() {
    const shouldSubscribe = bettingSpaceModalIsOpen();
    if (shouldSubscribe && !ui.betRankingSubscribed) {
      ui.betRankingSubscribed = true;
      if (socket.connected) socket.emit('bet_ranking_get');
    } else if (!shouldSubscribe && ui.betRankingSubscribed) {
      ui.betRankingSubscribed = false;
      if (socket.connected) socket.emit('bet_ranking_unsubscribe');
    }
  }
  function setActiveProfileSection(sectionId) {
    const section = document.querySelector(`[data-profile-section="${sectionId}"]`);
    if (!section || section.classList.contains('hidden')) sectionId = 'overview';
    $$('[data-profile-jump]').forEach(button => {
      const active = button.dataset.profileJump === sectionId;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
    document.getElementById('profile-modal')?.setAttribute('data-active-profile-section', sectionId);
    ui.profileSection = sectionId;
    syncBetRankingSubscription();
  }
  function jumpToProfileSection(sectionId, moveFocus = false) {
    const scrollRoot = document.getElementById('profile-content-scroll');
    let target = document.querySelector(`[data-profile-section="${sectionId}"]`);
    if (!scrollRoot) return;
    if (!target || target.classList.contains('hidden')) {
      sectionId = 'overview';
      target = document.querySelector('[data-profile-section="overview"]');
    }
    if (!target) return;
    const rootTop = scrollRoot.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    scrollRoot.scrollTop = Math.max(0, scrollRoot.scrollTop + targetTop - rootTop - 12);
    setActiveProfileSection(sectionId);
    if (moveFocus) (target.querySelector('[tabindex="-1"]') || target).focus({ preventScroll: true });
  }
  function syncProfileSectionFromScroll() {
    const scrollRoot = document.getElementById('profile-content-scroll');
    if (!scrollRoot) return;
    const activationLine = scrollRoot.getBoundingClientRect().top + 42;
    const sections = $$('[data-profile-section]').filter(section => !section.classList.contains('hidden'));
    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= activationLine) active = section;
      else break;
    }
    if (active) setActiveProfileSection(active.dataset.profileSection);
  }

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
    lobbyTournamentList: $('#lobby-tournament-list'), weeklyFinal: $('#lobby-weekly-final'),
    tournamentNameDialog: $('#lobby-tournament-name-dialog'), tournamentNameForm: $('#lobby-tournament-name-form'), tournamentNameInput: $('#lobby-tournament-name-input'),
    notificationsToggle: $('#notifications-toggle'), roomNotificationsToggle: $('#room-notifications-toggle'),
    lobbyChatWidget: $('#lobby-chat-widget'), lobbyChatBubble: $('#lobby-chat-bubble'), lobbyChatPanel: $('#lobby-chat-panel'),
    lobbyChatClose: $('#lobby-chat-close'), lobbyChatUnread: $('#lobby-chat-unread'), lobbyChatProfile: $('#lobby-chat-profile'),
    lobbyChatProfileForm: $('#lobby-chat-profile-form'), lobbyChatName: $('#lobby-chat-name'), lobbyChatTos: $('#lobby-chat-tos'),
    lobbyChatContent: $('#lobby-chat-content'), lobbyChatMessages: $('#lobby-chat-messages'), lobbyChatJump: $('#lobby-chat-jump'), lobbyChatForm: $('#lobby-chat-form'), lobbyChatInput: $('#lobby-chat-input'),
    gameName: $('#game-name'), phaseLabel: $('#phase-label'), roomTitle: $('#room-title'), headerCode: $('#header-code'),
    tournamentBanner: $('#tournament-banner'),
    profileCard: $('#profile-card'), playersList: $('#players-list'), playerCount: $('#player-count'),
    chatList: $('#chat-list'), chatJump: $('#chat-jump'), chatForm: $('#chat-form'), chatInput: $('#chat-input'),
    gameStatus: $('#game-status'), turnClock: $('#turn-clock'), clockValue: $('#clock-value'),
    clockPlayer: $('#clock-player'), tableWrap: $('#table-wrap'), actionPanel: $('#action-panel'),
    toastStack: $('#toast-stack'), roundFlash: $('#round-flash'),
    sidebar: $('.sidebar'), soundToggle: $('#sound-toggle'),
    specialEventBanner: $('#special-event-banner'), winnerTicker: $('#winner-ticker'), reactionStage: $('#reaction-stage'),
    profileModal: $('#profile-modal'), profileForm: $('#profile-form'), profileNameInput: $('#profile-name-input'),
    profileAccountStatus: $('#profile-account-status'), profileDisplayName: $('#profile-display-name'),
    profileAvatarChoice: $('#profile-avatar-choice'), profileBigAvatar: $('#profile-big-avatar'), profileBadges: $('#profile-badges'),
    profileStats: $('#profile-stats'), rotatingChallengeList: $('#rotating-challenge-list'), challengeList: $('#challenge-list'), achievementList: $('#achievement-list'),
    passportSeasonLabel: $('#passport-season-label'), passportSeasonDates: $('#passport-season-dates'),
    passportPoints: $('#passport-points'), passportNextMilestone: $('#passport-next-milestone'), passportStampHint: $('#passport-stamp-hint'),
    passportProgressBar: $('#passport-progress-bar'), passportProgressTrack: $('#passport-progress-track'),
    passportStamps: $('#passport-stamps'), passportRewards: $('#passport-rewards'), passportCollection: $('#passport-collection'),
    featuredAchievements: $('#featured-achievements'),
    collectionCount: $('#collection-count'), collectionItems: $('#collection-items'),
    cardBookCount: $('#card-book-count'), cardBookGrid: $('#card-book-grid'),
    profileSyncNote: $('#profile-sync-note'),
    albumCount: $('#album-count'), albumCost: $('#album-cost'), albumOpenCapsule: $('#album-open-capsule'),
    albumLastPull: $('#album-last-pull'), albumRates: $('#album-rates'), albumGrid: $('#album-grid'),
    balanceChart: $('#balance-chart'), balanceChartNote: $('#balance-chart-note'), gameBreakdown: $('#game-breakdown'),
    historyDownload: $('#history-download'),
    dailyBonusStatus: $('#daily-bonus-status'), dailyBonusCountdown: $('#daily-bonus-countdown'), dailyBonusClaim: $('#daily-bonus-claim'),
    quickChatToggle: $('#quick-chat-toggle'), quickChatMenu: $('#quick-chat-menu'),
    botMenuToggle: $('#bot-menu-toggle'), botControls: $('#bot-controls'), botMenuClose: $('#bot-menu-close'),
    botDifficulty: $('#bot-difficulty'), botStyle: $('#bot-style'), botAdd: $('#bot-add'), botFill: $('#bot-fill'),
    reportOpenBtn: $('#report-open-btn'), reportModal: $('#report-modal'), reportForm: $('#report-form'), reportTitle: $('#report-title'), reportCopy: $('#report-copy'), reportUserField: $('#report-user-field'), reportedUsername: $('#reported-username'), reportCategory: $('#report-category'), reportDescription: $('#report-description'), reportError: $('#report-error'), myReportsList: $('#my-reports-list'), myReportsRefresh: $('#my-reports-refresh'),
    communityOpenBtn: $('#community-open-btn'), communityModal: $('#community-modal'),
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
    fortune: { icon: '✺', name: 'RUEDA DE LA FORTUNA' },
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
  const COSMETIC_AVATAR_ART = new Set([
    '/assets/cosmetics/avatars/phoenix.svg', '/assets/cosmetics/avatars/axolotl.svg',
    '/assets/cosmetics/avatars/nebula.svg'
  ]);
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
    'gameStats', 'balanceHistory', 'medals', 'championBanner', 'dailyBonusClaimed', 'dailyBonusAvailableAt', 'passport', 'collection', 'cardAlbum', 'fanPin'
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
    lastEventKey: '', clockTimer: null, dailyBonusTimer: null, previousRanks: new Map(), previousChips: new Map(), lastMeChips: null,
    profileOpen: false, profileNameDirty: false, profileSection: 'overview', collectionFilter: 'all', albumFilter: 'all', albumLastPullId: null, profileStale: false,
    betRanking: null, betRankingSource: 'total', betRankingSubscribed: false,
    profileRevision: 0, // sube con cada snapshot de perfil aplicado (ver applyProfileSnapshot)
    lobbyTournaments: null, expandedTournamentBrackets: new Set(), pendingTournamentSignup: null,
    communityTab: 'friends', communityData: null,
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
  loadSeasonalTheme();

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
  let seasonalThemeRefreshTimer = null;
  let seasonalThemePayload = null;
  function refreshSeasonalThemeVisibility() {
    const active = seasonalThemePayload?.active === true && !ui.room && !els.landing.classList.contains('hidden');
    const pill = document.getElementById('seasonal-theme-pill');
    const effects = document.getElementById('seasonal-effects');
    if (pill) pill.hidden = !active;
    if (effects) effects.hidden = !active;
  }
  function applySeasonalTheme(payload) {
    if (seasonalThemeRefreshTimer) clearTimeout(seasonalThemeRefreshTimer);
    seasonalThemeRefreshTimer = null;
    seasonalThemePayload = payload;
    const theme = payload?.active === true ? payload.theme : null;
    const pill = document.getElementById('seasonal-theme-pill');
    const effects = document.getElementById('seasonal-effects');
    document.documentElement.dataset.seasonalTheme = theme?.id || 'none';
    document.documentElement.dataset.seasonalAnimation = theme?.animation || 'none';
    if (pill) {
      pill.textContent = theme ? `${theme.symbol} ${theme.label}` : '';
      pill.title = theme?.decoration || '';
      pill.setAttribute('aria-label', theme ? `Decoración activa: ${theme.label}` : '');
    }
    if (effects) {
      effects.dataset.theme = theme?.id || 'none';
      effects.dataset.animation = theme?.animation || 'none';
      effects.dataset.intensity = theme?.intensity || 'subtle';
      effects.replaceChildren();
      if (theme?.animation && theme.animation !== 'none' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (let index = 0; index < 18; index += 1) {
          const particle = document.createElement('span');
          particle.className = 'seasonal-effect-particle';
          particle.textContent = theme.particle || '✦';
          particle.style.setProperty('--effect-x', `${(index * 47 + 9) % 100}%`);
          particle.style.setProperty('--effect-delay', `${-(index * 0.83) % 14}s`);
          particle.style.setProperty('--effect-duration', `${10 + (index % 8) * 1.45}s`);
          particle.style.setProperty('--effect-drift', `${(index % 2 ? 1 : -1) * (24 + index * 2)}px`);
          effects.append(particle);
        }
      }
    }
    refreshSeasonalThemeVisibility();
    const refreshAt = Number(payload?.refreshAt);
    if (Number.isFinite(refreshAt) && refreshAt > Date.now()) {
      seasonalThemeRefreshTimer = setTimeout(loadSeasonalTheme, Math.min(refreshAt - Date.now() + 1500, 2147483647));
    }
  }
  async function loadSeasonalTheme() {
    try {
      const response = await fetch('/api/seasonal-theme', { cache: 'no-store' });
      if (!response.ok) return;
      applySeasonalTheme(await response.json());
    } catch (_) { /* la decoración es opcional; el lobby sigue usable sin este recurso */ }
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
  // ÚNICA vía de escritura del perfil que llega del servidor (ack de cápsula,
  // bono, equipar, edición, profile_event, room_state o refresco). Deja al día,
  // en el mismo paso y con el mismo objeto:
  //  - ui.room.viewerProfile: si la persona está sentada y el perfil es el suyo;
  //  - ui.me.chips: lo que usan los controles de apuesta de la mesa;
  //  - ui.accountSession y localStorage: si el perfil es la cuenta iniciada.
  // El encabezado de la mesa y el modal de perfil leen de ui.room.viewerProfile,
  // así que ambos se ven igual sin recargar. Quien llama pinta lo que le toca.
  // `ambient` = llegó sin que la persona hiciera nada (profile_event): en ese
  // caso solo se toca la cuenta si el id coincide, nunca otra sesión.
  function applyProfileSnapshot(profile, { ambient = false } = {}) {
    if (!profile || typeof profile !== 'object' || !profile.id) return false;
    ui.profileRevision += 1;
    const viewer = ui.room?.viewerProfile || null;
    if (viewer && viewer.id === profile.id) {
      ui.room.viewerProfile = profile;
      if (ui.me) ui.me.chips = Number(profile.chips) || 0;
    }
    if (ui.accountSession && profile.id === ui.accountSession.accountId) saveAccountSession(profile);
    else if (!ambient && !inTable() && profile.username) saveAccountSession(profile);
    return true;
  }
  // Saldo de la cuenta cambiado por una respuesta que solo trae `profileChips`
  // (p. ej. tesorería del club). Mismas fuentes que applyProfileSnapshot.
  function applyAccountChips(profileId, chips) {
    const balance = Number(chips);
    if (!profileId || !Number.isFinite(balance)) return;
    if (ui.room?.viewerProfile?.id === profileId) ui.room.viewerProfile = { ...ui.room.viewerProfile, chips: balance };
    if (ui.me?.id === profileId) ui.me.chips = balance;
    if (ui.accountSession?.accountId === profileId) saveAccountSession({ ...ui.accountSession, chips: balance });
    ui.profileRevision += 1;
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
  // Estado del refresco de la cuenta en el lobby. Si no pudimos confirmar el
  // perfil con el servidor, el modal lo dice (antes mostraba datos viejos sin
  // avisar) y se reintenta en cuanto el socket vuelve a conectarse.
  function setProfileStale(stale) {
    ui.profileStale = Boolean(stale);
    if (ui.profileOpen && !inTable()) renderProfileModal();
  }
  // Un refresco puede terminar DESPUÉS de un ack que ya trajo un saldo más nuevo
  // (cápsula, bono, ronda): con sesión por cookie viaja por HTTP y no hay orden
  // garantizado frente al socket. Si entretanto llegó otro snapshot, la respuesta
  // vieja se descarta para no volver a mostrar el saldo de antes.
  function adoptRefreshedProfile(profile, revisionAtStart) {
    if (ui.profileRevision !== revisionAtStart) return false;
    return applyProfileSnapshot(profile);
  }
  async function refreshAccountProfile() {
    if (!ui.accountSession?.accountId) return;
    const revisionAtStart = ui.profileRevision;
    await serverFlagsReady;
    // Con ACCOUNT_SESSIONS_ENABLED apagado, /api/auth/session responde 404
    // fail-closed; se va directo al fallback por socket para no generar ese
    // 404 en la consola del navegador.
    const secure = accountSessionsAvailable() ? await secureAuthRequest('/api/auth/session') : { status: 404 };
    if (secure.status !== 404) {
      if (secure.ok && secure.profile) {
        ui.csrfToken = secure.csrfToken || null;
        adoptRefreshedProfile(secure.profile, revisionAtStart);
        setProfileStale(false);
        renderAfterProfileChange();
      } else if (secure.status === 401) {
        // localStorage es solo caché visual: una cookie ausente/revocada manda.
        clearAccountSession();
      } else setProfileStale(true);
      return;
    }
    // Compatibilidad temporal mientras ACCOUNT_SESSIONS_ENABLED está apagado.
    if (!socket.connected) { setProfileStale(true); return; }
    const response = await emitAck('account_profile', { accountId: ui.accountSession?.accountId });
    if (response.ok && response.profile) {
      adoptRefreshedProfile(response.profile, revisionAtStart);
      setProfileStale(false);
      renderAfterProfileChange();
    } else setProfileStale(true);
  }
  // Repinta lo que muestra el perfil después de aplicar un snapshot. El
  // encabezado solo existe dentro de una mesa.
  function renderAfterProfileChange() {
    if (ui.room && ui.me) renderProfile();
    if (ui.profileOpen) renderProfileModal();
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
  function passportFrameClasses(passport) {
    if (serverFlags.passport !== true) return '';
    const style = passport?.equipped?.frame?.style;
    const classes = { 'frame-15': 'passport-frame passport-frame-15', 'frame-50': 'passport-frame passport-frame-50' };
    return classes[style] || '';
  }
  function applyPassportFrame(element, passport) {
    if (!element) return;
    element.classList.remove('passport-frame', 'passport-frame-15', 'passport-frame-50');
    const classes = passportFrameClasses(passport).split(' ').filter(Boolean);
    if (classes.length) element.classList.add(...classes);
  }
  function passportBadgeMarkup(passport) {
    if (serverFlags.passport !== true) return '';
    const item = passport?.equipped?.badge;
    if (!item) return '';
    const styles = {
      'badge-season': 'passport-badge-season',
      'badge-emblem': 'passport-badge-emblem',
      'badge-explorer': 'passport-badge-explorer'
    };
    return `<i class="passport-mini-badge ${styles[item.style] || ''}" title="${escapeHtml(item.name)} · ${escapeHtml(item.seasonLabel)}">${escapeHtml(item.icon)}</i>`;
  }
  function passportTitleMarkup(passport) {
    if (serverFlags.passport !== true) return '';
    const item = passport?.equipped?.title;
    if (!item) return '';
    return `<span class="passport-nameplate" title="Título del Pasaporte · ${escapeHtml(item.seasonLabel)}">${escapeHtml(item.icon)} ${escapeHtml(item.name)}</span>`;
  }
  function fanPinMarkup(pin) {
    if (!pin || !/^(FAR|RMD|ATC|MUN|LVP|ARS|BAY|BDO|JUV|PSG|RSU|RDB|WHM|NAB|CDC|BEN)$/.test(pin.abbr || '') || !['club-pin','fan-1','fan-2','fan-3'].includes(pin.pin)) return '';
    return `<img class="fan-pin fan-pin-${pin.pin}" src="/assets/escudos/${pin.abbr}.svg" alt="" title="Pin de ${escapeHtml(pin.clubName || 'afición')}" />`;
  }
  function cosmeticFrameClass(collection) {
    const style = collection?.equipped?.frame?.style;
    return ['obsidian', 'starlight'].includes(style) ? `frame-art-equipped frame-${style}` : '';
  }
  function cosmeticAvatarContents(player) {
    const item = player?.collection?.equipped?.avatar;
    const art = COSMETIC_AVATAR_ART.has(item?.art) ? item.art : null;
    if (!art) return avatarEmoji(player?.avatar);
    const animation = ['float', 'glow', 'orbit'].includes(item.animation) ? ` animate-${item.animation}` : '';
    return `<img class="equipped-avatar-art${animation}" src="${art}" alt="" loading="lazy" decoding="async">`;
  }
  function equippedAvatarMarkup(player, className = 'player-avatar', showOnline = false) {
    const equippedAvatar = COSMETIC_AVATAR_ART.has(player?.collection?.equipped?.avatar?.art);
    const frameClass = cosmeticFrameClass(player?.collection);
    const online = showOnline && player?.connected !== false;
    return `<div class="${className} ${passportFrameClasses(player?.passport)} ${frameClass} ${equippedAvatar ? 'avatar-art-equipped' : ''} ${player?.connected === false ? 'offline' : ''}" style="background:${avatarColor(player?.id)}">${cosmeticAvatarContents(player)}${online ? '<i class="player-online"></i>' : ''}</div>`;
  }
  function avatarMarkup(player, className = 'player-avatar') {
    return equippedAvatarMarkup(player, className, true);
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
        els.profileBigAvatar.classList.remove('avatar-art-equipped');
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
      ui.lobbyChat.stickNext = true; // al abrir, siempre se muestra lo más reciente
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
    const selfName = ui.playerName || '';
    const ids = messages.map(message => message.id);
    const added = countAdded(ids, ui.lobbyChat.lastIds);
    ui.lobbyChat.lastIds = ids;
    const force = Boolean(ui.lobbyChat.stickNext);
    ui.lobbyChat.stickNext = false;
    const html = messages.length
      ? messages.map(message => {
        const botClass = message.bot ? ' lobby-chat-message-bot' : '';
        const botBadge = message.bot ? ' <span class="lobby-chat-bot-badge" aria-label="asistente automático">BOT</span>' : '';
        const mentionsMe = chatMentionsName(message.text, selfName);
        const reportButton = message.playerId && !message.system
          ? `<button type="button" class="chat-report" aria-label="Reportar el mensaje de ${escapeHtml(message.name)}" data-report-message="${escapeHtml(message.id)}">⚑ Reportar</button>`
          : '';
        return `<div class="lobby-chat-message${botClass}${mentionsMe ? ' mentions-me' : ''}"><span class="lobby-chat-avatar" style="background:${avatarColor(message.playerId)}">${avatarEmoji(message.avatar)}</span><div><b>${chatRoleBadge(message.role)}${escapeHtml(message.name)}${botBadge}</b><p>${formatChatText(message.text, selfName)}</p>${reportButton}</div></div>`;
      }).join('')
      : '<div class="lobby-chat-empty">Sé el primero en saludar al casino.</div>';
    bindJump(els.lobbyChatMessages, els.lobbyChatJump);
    paintList(els.lobbyChatMessages, els.lobbyChatJump, html, added, { force });
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
    renderBettingRanking();
    if (ui.betRankingSubscribed && bettingSpaceModalIsOpen()) socket.emit('bet_ranking_get');
    tryAutoJoinLobbyChat();
    requestLobbyTournaments();
    // Si el perfil de cuenta quedó sin confirmar (sin conexión), se pide ahora.
    if (ui.profileStale && ui.accountSession?.accountId) refreshAccountProfile();
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
      const response = await emitAck(ui.spectating ? 'spectate_room' : 'join_room', { name: ui.playerName, code: ui.activeCode, token: deviceToken, avatar: ui.selectedAvatar, accountId: ui.accountSession?.accountId, tos: localStorage.getItem(TOS_KEY) });
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
    renderBettingRanking();
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
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (bettingSpaceModalIsOpen()) { closeBettingSpaceModal(); return; }
    closeCollectionModal(); closeModal(); closeProfileModal(); closeAccountModal(); toggleShortcutHelp(false);
  });
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

  // ---------- Ranking transversal: Casino + Estadio ----------
  socket.on('bet_ranking_state', snapshot => {
    if (!snapshot || !snapshot.ranking) return;
    ui.betRanking = snapshot;
    renderBettingRanking();
  });
  function renderBettingRanking() {
    const list = $('#bet-ranking-list');
    const personal = $('#bet-ranking-personal');
    if (!list || !personal) return;
    const snapshot = ui.betRanking;
    const source = ['total', 'casino', 'stadium'].includes(ui.betRankingSource) ? ui.betRankingSource : 'total';
    const sourceLabels = { total: 'Total', casino: 'Casino', stadium: 'Estadio' };
    const metricFields = {
      total: { rank: 'totalRank', value: 'totalWagered' },
      casino: { rank: 'casinoRank', value: 'casinoWagered' },
      stadium: { rank: 'stadiumRank', value: 'stadiumWagered' }
    };
    $$('[data-bet-ranking-source]').forEach(button => {
      const selected = button.dataset.betRankingSource === source;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const live = $('#bet-ranking-live');
    if (live) {
      const connected = Boolean(socket.connected);
      live.textContent = connected ? '● Actualización en vivo' : '○ Reconectando…';
      live.classList.toggle('disconnected', !connected);
    }
    if (!snapshot) {
      personal.innerHTML = `<div class="bet-ranking-empty">${socket.connected ? 'Conectando con el ranking…' : 'Sin conexión. Se actualizará al reconectar.'}</div>`;
      list.innerHTML = `<div class="bet-ranking-empty">${socket.connected ? 'Solicitando la clasificación combinada…' : 'El ranking requiere conexión.'}</div>`;
      return;
    }
    const me = snapshot.me;
    const metric = metricFields[source];
    if (me) {
      const rank = me[metric.rank];
      const sourceParticipants = snapshot.participantsBySource?.[source] ?? snapshot.participants ?? 0;
      const stadiumDecisions = Number(me.stadiumDecisions) || 0;
      const stadiumWins = Number(me.stadiumWins) || 0;
      const stadiumLosses = Number(me.stadiumLosses) || 0;
      const stadiumHitRate = me.stadiumHitRate == null ? '—' : `${formatChips(me.stadiumHitRate)}%`;
      const stadiumNet = Math.trunc(Number(me.stadiumNet) || 0);
      const stadiumNetLabel = `${stadiumNet > 0 ? '+' : stadiumNet < 0 ? '−' : ''}◆ ${formatChips(Math.abs(stadiumNet))}`;
      const stadiumNetTone = stadiumNet > 0 ? 'positive' : stadiumNet < 0 ? 'negative' : 'neutral';
      personal.innerHTML = `
        <div class="bet-ranking-me-place"><small>TU PUESTO · ${sourceLabels[source].toUpperCase()}</small><b>${rank ? `#${formatChips(rank)}` : '—'}</b><span>${rank ? `de ${formatChips(sourceParticipants)} jugadores` : 'Aún sin apuestas en este ranking'}</span></div>
        <div class="bet-ranking-me-total"><small>VOLUMEN ACUMULADO</small><b>◆ ${formatChips(me.totalWagered)}</b><span>Casino + Estadio</span></div>
        <div class="bet-ranking-me-source"><small>CASINO</small><b>◆ ${formatChips(me.casinoWagered)}</b><span>Fichas apostadas</span></div>
        <div class="bet-ranking-me-source"><small>ESTADIO</small><b>◆ ${formatChips(me.stadiumWagered)}</b><span>${formatChips(me.stadiumBets || 0)} apuestas</span></div>
        <div class="bet-ranking-me-source bet-ranking-me-performance"><small>ACIERTOS · ESTADIO</small><b>${stadiumHitRate}</b><span>${stadiumDecisions ? `${formatChips(stadiumWins)} ganadas · ${formatChips(stadiumLosses)} perdidas` : 'Sin resultados definitivos'}</span></div>
        <div class="bet-ranking-me-source bet-ranking-me-performance"><small>NETO · ESTADIO</small><b class="bet-ranking-net ${stadiumNetTone}">${stadiumNetLabel}</b><span>Balance de ${formatChips(me.stadiumSettledBets || 0)} apuestas liquidadas</span></div>`;
    } else {
      personal.innerHTML = '<div class="bet-ranking-empty">No pudimos asociar el ranking con este perfil. Vuelve a entrar a una mesa o inicia sesión.</div>';
    }
    const updated = $('#bet-ranking-updated');
    if (updated) {
      const time = snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
      updated.textContent = `${formatChips(snapshot.totalWagered || 0)} fichas apostadas en ${formatChips(snapshot.participants || 0)} jugadores${time ? ` · actualizado ${time}` : ''}. Fichas 100% virtuales.`;
    }
    const entries = snapshot.ranking[source] || [];
    if (!entries.length) {
      list.innerHTML = `<div class="bet-ranking-empty">Todavía no hay apuestas registradas en ${sourceLabels[source]}.</div>`;
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    list.innerHTML = entries.map(entry => `
      <div class="bet-ranking-row ${entry.place === 1 ? 'leader' : ''} ${me && entry.name === me.name ? 'self' : ''}" role="row">
        <span class="bet-ranking-place" role="cell">${medals[entry.place - 1] || `#${formatChips(entry.place)}`}</span>
        <span class="bet-ranking-player" role="cell"><i>${avatarEmoji(entry.avatar)}</i><b>${escapeHtml(entry.name)}</b></span>
        <span class="bet-ranking-value primary" role="cell">◆ ${formatChips(entry.totalWagered)}</span>
        <span class="bet-ranking-value" role="cell">◆ ${formatChips(entry.casinoWagered)}</span>
        <span class="bet-ranking-value" role="cell">◆ ${formatChips(entry.stadiumWagered)}</span>
      </div>`).join('');
  }

  // ---------- Live lobby ----------
  socket.on('lobby_state', payload => {
    ui.lobby = Array.isArray(payload?.rooms) ? payload.rooms : [];
    ui.playersOnline = Number(payload?.playersOnline) || 0;
    ui.season = payload?.season || ui.season || null; // Fase 8.6
    renderLobby();
    renderSeasonRanking();
  });
  function requestLobbyTournaments() {
    if (!socket.connected) return;
    emitAck('lobby_tournaments_get', { accountId: ui.accountSession?.accountId }).then(response => {
      if (!response?.ok || !response.snapshot) return;
      ui.lobbyTournaments = response.snapshot;
      renderLobbyTournaments();
    });
  }
  socket.on('lobby_tournaments_state', snapshot => {
    if (!snapshot || !Array.isArray(snapshot.tournaments)) return;
    ui.lobbyTournaments = snapshot;
    renderLobbyTournaments();
  });
  socket.on('lobby_tournament_match_result', result => {
    if (!result) return;
    showToast(result.isWinner ? 'Avanzas en el bracket' : 'Encuentro terminado',
      result.forfeit ? `${result.winnerName} gana por incomparecencia.` : `${result.winnerName} ganó ${result.roundLabel} de ${result.tournamentName}.`,
      result.isWinner ? 'achievement' : 'notice', 5200, result.isWinner ? '🏆' : '♠');
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
    renderLobbyTournaments();
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
  function tournamentStatusLabel(status) {
    return ({ registration: 'Inscripción abierta', full: 'Cupos completos', in_progress: 'En curso', completed: 'Finalizado', cancelled: 'Cancelado' })[status] || 'Programado';
  }
  function tournamentDateLabel(timestamp, timeZone) {
    try {
      return new Intl.DateTimeFormat('es-MX', {
        timeZone: timeZone || 'UTC', weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (_) { return new Date(timestamp).toLocaleString('es-MX'); }
  }
  function groupTournamentPrizes(prizeTable) {
    const sorted = (Array.isArray(prizeTable) ? prizeTable : []).slice().sort((a, b) => a.place - b.place);
    const groups = [];
    sorted.forEach(prize => {
      const previous = groups[groups.length - 1];
      if (prize.place >= 3 && previous && previous.firstPlace >= 3
        && previous.prize === prize.prize && prize.place === previous.lastPlace + 1) {
        previous.lastPlace = prize.place;
        previous.count++;
      } else {
        groups.push({ firstPlace: prize.place, lastPlace: prize.place, count: 1, prize: prize.prize });
      }
    });
    return groups;
  }
  function tournamentPrizeGroupLabel(group) {
    if (group.count === 1) return `${group.firstPlace}.º puesto`;
    const stage = group.firstPlace === 3 ? 'semifinales' : group.firstPlace === 5 ? 'cuartos de final' : 'misma ronda';
    return `${group.firstPlace}.º puesto compartido · ${stage}`;
  }
  function tournamentPlacementNote(capacity) {
    return capacity === 8
      ? 'Puestos compartidos por ronda: 3.º en semifinales y 5.º en cuartos. Cada premio de la tabla es por participante.'
      : 'Puestos compartidos por ronda: 3.º en semifinales, 5.º en cuartos y 9.º en octavos. Cada premio de la tabla es por participante.';
  }
  function renderTournamentBracket(event) {
    if (!ui.expandedTournamentBrackets.has(event.id)) return '';
    if (!event.rounds?.length) return '<div class="tournament-bracket"><div class="tournament-bracket-empty">El bracket se publicará al iniciar el torneo.</div></div>';
    return `<div class="tournament-bracket" role="list" aria-label="Bracket de ${escapeHtml(event.name)}">${event.rounds.map(round => `
      <section class="tournament-bracket-round" role="listitem"><h5>${escapeHtml(round.label)}</h5>
        ${round.matches.map(match => `<div class="tournament-match" aria-label="Encuentro ${match.number}">
          ${(match.players || []).length ? match.players.map(player => `<span class="tournament-match-player ${player.winner ? 'winner' : ''} ${player.you ? 'you' : ''}"><span>${escapeHtml(player.name)}</span>${player.placeLabel ? `<small>${escapeHtml(player.placeLabel)}</small>` : player.winner ? '<small>✓ Avanza</small>' : ''}</span>`).join('') : '<span class="tournament-match-player">Por definir</span>'}
          <small class="tournament-card-note">${match.status === 'playing' ? 'En partida' : match.status === 'completed' ? (match.forfeit ? 'Resuelto por incomparecencia' : 'Finalizado') : 'Pendiente'}</small>
        </div>`).join('')}
      </section>`).join('')}</div>`;
  }
  function renderTournamentCard(event, state) {
    const isFeatured = Boolean(event.featured);
    const registeredElsewhere = Boolean(state.registeredTournamentId && state.registeredTournamentId !== event.id);
    const mayJoin = event.status === 'registration' && !event.isRegistered && !registeredElsewhere;
    const canWithdraw = ['registration', 'full'].includes(event.status) && event.isRegistered;
    const statusClass = `status-${String(event.status || '').replace(/[^a-z_]/g, '')}`;
    const prizeTable = Array.isArray(event.prizeSchedule) ? event.prizeSchedule : [];
    const firstPrize = prizeTable.find(prize => prize.place === 1)?.prize || 0;
    const prizeRows = groupTournamentPrizes(prizeTable).map(group => {
      const medal = group.firstPlace === 1 ? '🥇' : group.firstPlace === 2 ? '🥈' : group.firstPlace === 3 ? '🥉' : '🏅';
      return `<tr><td>${medal} · ${escapeHtml(tournamentPrizeGroupLabel(group))}</td><td>◆ ${formatChips(group.prize)}${group.count > 1 ? ' c/u' : ''}</td></tr>`;
    }).join('');
    const button = mayJoin
      ? `<button type="button" class="tournament-action" data-tournament-join="${escapeHtml(event.id)}">Inscribirme gratis</button>`
      : canWithdraw
        ? `<button type="button" class="tournament-action secondary" data-tournament-withdraw="${escapeHtml(event.id)}">Cancelar inscripción</button>`
        : event.isRegistered && ['full', 'in_progress'].includes(event.status)
          ? '<button type="button" class="tournament-action" disabled>Inscripción confirmada</button>'
          : registeredElsewhere && event.status === 'registration'
            ? '<button type="button" class="tournament-action" disabled>Ya estás en otro torneo</button>'
            : event.status === 'registration' ? '<button type="button" class="tournament-action" disabled>Inscripción no disponible</button>' : '';
    const participants = (event.participants || []).slice(0, 4).map(person => `${person.isYou ? 'Tú' : escapeHtml(person.name)}`).join(' · ');
    const participantLine = participants ? `<p class="tournament-card-note">En la lista: ${participants}${event.registeredCount > 4 ? ` · +${event.registeredCount - 4}` : ''}</p>` : '';
    return `<article class="tournament-card ${isFeatured ? 'is-featured' : ''} ${event.status === 'in_progress' ? 'is-live' : ''}" data-tournament-card="${escapeHtml(event.id)}">
      <div class="tournament-card-top"><span>${isFeatured ? '✦ FINAL SEMANAL DESTACADA' : 'TORNEO RELÁMPAGO'}</span><span class="tournament-status ${statusClass}">${tournamentStatusLabel(event.status)}</span></div>
      <h4>${escapeHtml(event.name)}</h4><time class="tournament-date" datetime="${new Date(event.startAt).toISOString()}">${tournamentDateLabel(event.startAt, state.timeZone)} · hora del casino</time>
      ${isFeatured ? '<p class="tournament-card-note">Final semanal destacada · domingo, 19:00 en la zona horaria del casino.</p>' : ''}
      <div class="tournament-card-stats"><span><b>${event.capacity}</b> participantes</span><span><b>${event.registeredCount}/${event.capacity}</b> inscritos</span><span>◆ <b>${formatChips(firstPrize)}</b> al 1.º</span></div>
      <div class="tournament-prize-line"><b>ENTRADA</b><span>Gratis · stack de torneo virtual independiente del saldo personal.</span></div>
      <details class="tournament-prizes"><summary>Tabla fija de premios virtuales</summary><table class="tournament-prize-table"><tbody>${prizeRows}</tbody></table><small>${tournamentPlacementNote(event.capacity)}</small><small>Se abonan al saldo de fichas virtuales cuando termina el torneo.</small></details>
      ${participantLine}
      <div class="tournament-card-actions">${button}<button type="button" class="tournament-bracket-toggle" data-tournament-bracket-toggle="${escapeHtml(event.id)}" aria-expanded="${ui.expandedTournamentBrackets.has(event.id)}">${ui.expandedTournamentBrackets.has(event.id) ? 'Ocultar bracket' : 'Ver bracket'}</button></div>
      ${event.cancellationReason ? `<p class="tournament-card-note">${event.cancellationReason === 'not_enough_players' ? 'No se llenaron las plazas; se canceló sin cobrar entrada.' : event.cancellationReason === 'players_offline' ? 'Se canceló porque faltaban participantes conectados.' : event.cancellationReason === 'server_restarted_before_start' ? 'El servidor se reinició antes del inicio; se canceló sin cobrar entrada.' : event.cancellationReason === 'stored_bracket_unavailable' ? 'No se pudo recuperar el bracket; el encuentro no se cobró ni se perdió el saldo personal.' : 'No se pudo iniciar porque un participante estaba ocupado en otra mesa.'}</p>` : ''}
      ${event.isRegistered && event.myPlacement ? `<p class="tournament-card-note">Terminaste en el ${escapeHtml(event.myPlacementLabel || `${event.myPlacement}.º puesto`)} · premio ◆ ${formatChips(event.myPrize || 0)}.</p>` : ''}
      ${renderTournamentBracket(event)}
    </article>`;
  }
  function renderLobbyTournaments() {
    if (!els.lobbyTournamentList) return;
    const state = ui.lobbyTournaments;
    if (!state || !Array.isArray(state.tournaments)) {
      els.lobbyTournamentList.innerHTML = '<div class="tournament-loading">Sincronizando calendario con el servidor…</div>';
      if (els.weeklyFinal) els.weeklyFinal.classList.add('hidden');
      return;
    }
    const events = state.tournaments;
    const featured = events.find(event => event.featured);
    if (els.weeklyFinal) {
      if (featured) {
        els.weeklyFinal.classList.remove('hidden');
        els.weeklyFinal.innerHTML = renderTournamentCard(featured, state);
      } else {
        els.weeklyFinal.classList.add('hidden');
        els.weeklyFinal.replaceChildren();
      }
    }
    const regular = events.filter(event => !event.featured);
    els.lobbyTournamentList.innerHTML = regular.length
      ? regular.map(event => renderTournamentCard(event, state)).join('')
      : '<div class="tournament-empty">No hay torneos relámpago en este momento. El siguiente calendario aparecerá aquí.</div>';
    $$('[data-tournament-join]').forEach(button => button.addEventListener('click', () => joinLobbyTournament(button.dataset.tournamentJoin, button)));
    $$('[data-tournament-withdraw]').forEach(button => button.addEventListener('click', () => withdrawLobbyTournament(button.dataset.tournamentWithdraw, button)));
    $$('[data-tournament-bracket-toggle]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.tournamentBracketToggle;
      if (ui.expandedTournamentBrackets.has(id)) ui.expandedTournamentBrackets.delete(id);
      else ui.expandedTournamentBrackets.add(id);
      renderLobbyTournaments();
    }));
  }
  async function joinLobbyTournament(tournamentId, button, chosenName = '') {
    if (!tosAccepted()) { showTosModal(); return; }
    const name = String(chosenName || ui.accountSession?.name || ui.playerName || localStorage.getItem('montecristo-name') || '').trim();
    if (!name) {
      ui.pendingTournamentSignup = tournamentId;
      if (els.tournamentNameInput) els.tournamentNameInput.value = '';
      els.tournamentNameDialog?.showModal?.();
      els.tournamentNameInput?.focus();
      return;
    }
    ui.playerName = name;
    localStorage.setItem('montecristo-name', name);
    const avatar = ui.accountSession?.avatar || ui.selectedAvatar || 'fox';
    const response = await emitAck('lobby_tournament_register', {
      tournamentId, accountId: ui.accountSession?.accountId, name, avatar,
      tos: localStorage.getItem(TOS_KEY)
    }, button);
    if (!response.ok) return showToast('No se pudo inscribir', response.error || 'Intenta de nuevo.', 'error');
    if (response.snapshot) ui.lobbyTournaments = response.snapshot;
    renderLobbyTournaments();
    showToast(response.code === 'already_registered' ? 'Ya estabas inscrito' : 'Inscripción confirmada', 'Entrada gratuita. Tu asiento y tu saldo personal están protegidos.', 'notice', 4200, '🏆');
  }
  async function withdrawLobbyTournament(tournamentId, button) {
    const response = await emitAck('lobby_tournament_withdraw', { tournamentId, accountId: ui.accountSession?.accountId }, button);
    if (!response.ok) return showToast('No se pudo cancelar', response.error || 'Intenta de nuevo.', 'error');
    if (response.snapshot) ui.lobbyTournaments = response.snapshot;
    renderLobbyTournaments();
    showToast('Inscripción cancelada', 'Puedes volver a inscribirte mientras el registro siga abierto.', 'notice', 3500, '↩');
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
    // Cada estado de mesa trae el saldo actual del asiento. Si es la cuenta
    // iniciada, la caché se actualiza aquí y no solo al salir de la mesa: así la
    // caché nunca conserva el saldo de antes de una ronda.
    syncAccountSessionIfSameProfile(room.viewerProfile);
    refreshSeasonalThemeVisibility();
    // Red de seguridad: si llegó el estado de resultados pero esta mesa no
    // está animando el descubrimiento (otro juego, o una reconexión directa
    // en fase de resultados), los avisos retenidos se muestran ya — no hay
    // animación que esperar.
    if (ui.resultQueue.length && !quickResultHold()) flushResultQueue();
    ui.activeCode = room.code;
    ui.me = room.players.find(player => player.id === room.viewerId) || room.players.find(player => player.id === deviceToken) || (room.viewerSpectator ? null : room.players.find(player => player.name === ui.playerName)) || null;
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
    ui.me = room.players.find(player => player.id === room.viewerId) || room.players.find(player => player.id === deviceToken) || ui.me;
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
    els.playerCount.textContent = `${connectedCount} / ${room.lobbyTournamentMatch ? 2 : 6}`;
    els.roomApp.dataset.game = room.game;
    const equippedLooks = room.viewerProfile?.collection?.equipped || ui.me?.collection?.equipped || {};
    els.roomApp.dataset.felt = equippedLooks.felt?.style || '';
    els.roomApp.dataset.chipSkin = equippedLooks.chips?.style || '';
    const cardBackArt = equippedLooks.cards?.style === 'album' && typeof equippedLooks.cards?.art === 'string' && equippedLooks.cards.art.startsWith('/assets/cards/') ? equippedLooks.cards.art : '';
    els.roomApp.dataset.cardBack = cardBackArt ? 'album' : (equippedLooks.cards?.style || '');
    if (cardBackArt) els.roomApp.style.setProperty('--card-back-art', `url("${cardBackArt}")`);
    else els.roomApp.style.removeProperty('--card-back-art');
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
      room.game, room.phase, room.turnId, room.turnDeadline, room.dealerHand, room.community, room.pot, room.tournament, room.lobbyTournamentMatch,
      room.currentBet, room.minRaise, room.dealerIndex, room.handNumber, room.results, room.quickResult, room.specialEvent,
      room.players.map(p => [p.id, p.name, p.avatar, p.passport, p.collection, p.chips, p.hand, p.bet, p.quickChoice, p.roundBet, p.totalBet, p.status, p.folded, p.allIn, p.connected, p.isBot, p.bot?.thinking, p.bot?.lastActionAt])
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
    const match = room.lobbyTournamentMatch;
    if (match) {
      els.tournamentBanner.classList.remove('hidden');
      els.tournamentBanner.classList.add('lobby-flash-banner');
      const smallBlind = 10 * (2 ** Math.min(6, Math.max(1, match.level || 1) - 1));
      const matchCopy = match.status === 'completed'
        ? `Encuentro terminado · ganador: ${escapeHtml(match.winnerName || '—')}`
        : `${escapeHtml(match.roundLabel)} · encuentro ${match.matchNumber} · ciegas ${formatChips(smallBlind)}/${formatChips(smallBlind * 2)}`;
      els.tournamentBanner.innerHTML = `<span class="tb-title">🏆 TORNEO RELÁMPAGO DEL LOBBY</span><span class="tb-item"><b>${escapeHtml(match.tournamentName)}</b> · ${matchCopy}</span><span class="tb-item">Entrada gratuita · stack virtual · premios fijos</span>`;
      return;
    }
    els.tournamentBanner.classList.remove('lobby-flash-banner');
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
    const isHost = Boolean(ui.me?.isHost && !room.lobbyTournamentMatch);
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
        els.profileCard.innerHTML = `${equippedAvatarMarkup(spectator, 'profile-avatar')}
          <div class="profile-info"><small>👁 ESPECTADOR</small><b>${escapeHtml(spectator.name || ui.playerName)}</b><span>Viendo la mesa en vivo</span></div>`;
      } else els.profileCard.innerHTML = '';
      return;
    }
    // El saldo del encabezado sale del mismo perfil que el modal (viewerProfile),
    // no de una copia aparte en ui.me: así no pueden verse distintos.
    const viewer = ui.room?.viewerProfile || ui.me;
    const stats = viewer.stats || ui.me.stats || {};
    const chips = Number(viewer.chips) || 0;
    const previous = ui.lastMeChips;
    const delta = previous == null ? 0 : chips - previous;
    els.profileCard.innerHTML = `${equippedAvatarMarkup(ui.me, 'profile-avatar')}
      <div class="profile-info"><small>TU PERFIL · ${formatChips(stats.wins || 0)} VICTORIAS</small><b>${escapeHtml(ui.me.name)}${passportBadgeMarkup(ui.me.passport)}${fanPinMarkup(ui.me.fanPin)}</b>${passportTitleMarkup(ui.me.passport)}<span><strong>◆</strong> ${formatChips(chips)} fichas ${delta > 0 ? `<em class="chip-delta">+${formatChips(delta)}</em>` : ''}</span></div>`;
    if (delta > 0) {
      els.profileCard.classList.remove('chips-received');
      requestAnimationFrame(() => els.profileCard.classList.add('chips-received'));
    } else els.profileCard.classList.remove('chips-received');
    ui.lastMeChips = chips;
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
        <div class="player-meta"><b>${escapeHtml(player.name)}${passportBadgeMarkup(player.passport)}${fanPinMarkup(player.fanPin)}${botBadge} ${player.id === ui.me?.id ? '<small>(tú)</small>' : ''}</b>${passportTitleMarkup(player.passport)}${botDescriptor}<span>${escapeHtml(status)}</span>${bet ? `<span class="player-bet-mini">◆ ${formatChips(bet)} en juego</span>` : ''}</div>
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
  // ---------- Chat: render con scroll inteligente (utilidades en chat-format.js) ----------
  function chatMessageHtml(message, player, selfName) {
    const mine = Boolean(message.playerId) && ui.me?.id === message.playerId;
    const mentionsMe = !mine && chatMentionsName(message.text, selfName);
    const report = message.playerId && !mine
      ? `<button type="button" class="chat-report" aria-label="Reportar el mensaje de ${escapeHtml(message.name)}" data-report-message="${escapeHtml(message.id)}">⚑ Reportar</button>`
      : '';
    return `<div class="chat-msg${mine ? ' is-mine' : ''}${mentionsMe ? ' mentions-me' : ''}"><div class="chat-avatar" style="background:${avatarColor(message.playerId)}">${avatarEmoji(player?.avatar)}</div><div class="chat-bubble"><b>${chatRoleBadge(message.role)}${escapeHtml(message.name)}</b><p>${formatChatText(message.text, selfName)}</p>${report}</div></div>`;
  }
  function renderChat() {
    const messages = ui.room.messages || [];
    const signature = messages.map(message => message.id).join('|');
    if (signature === ui.lastChatSignature) return;
    ui.lastChatSignature = signature;
    const selfName = ui.me?.name || ui.playerName || '';
    const ids = messages.map(message => message.id);
    const added = countAdded(ids, ui.lastChatIds);
    const roomChanged = ui.lastChatRoom !== ui.room.code;
    ui.lastChatIds = ids;
    ui.lastChatRoom = ui.room.code;
    const html = messages.length
      ? messages.map(message => message.system
        ? `<div class="chat-system">${escapeHtml(message.text)}</div>`
        : chatMessageHtml(message, ui.room.players.find(player => player.id === message.playerId), selfName)).join('')
      : '<div class="chat-system">El chat está listo para la primera jugada.</div>';
    bindJump(els.chatList, els.chatJump);
    paintList(els.chatList, els.chatJump, html, added, { force: roomChanged });
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
      ${equippedAvatarMarkup(player, 'seat-avatar')}
      <div class="seat-info"><b>${escapeHtml(player.name)}${passportBadgeMarkup(player.passport)}${fanPinMarkup(player.fanPin)}${player.isBot ? '<i class="seat-bot-badge">BOT</i>' : ''}</b>${passportTitleMarkup(player.passport)}<span>◆ ${formatChips(player.chips)}</span></div>
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
      ${equippedAvatarMarkup(player, 'seat-avatar')}<div class="seat-info"><b>${escapeHtml(player.name)}${passportBadgeMarkup(player.passport)}${fanPinMarkup(player.fanPin)}${player.isBot ? '<i class="seat-bot-badge">BOT</i>' : ''}${insuranceBadge}</b>${passportTitleMarkup(player.passport)}<span>◆ ${formatChips(player.chips)}</span></div>
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
    if (game === 'fortune') return `Sector ${choice}`;
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
      ${equippedAvatarMarkup(player, 'seat-avatar')}
      <div><b>${escapeHtml(player.name)}${passportBadgeMarkup(player.passport)}${fanPinMarkup(player.fanPin)}${player.isBot ? '<i class="seat-bot-badge">BOT</i>' : ''}</b>${passportTitleMarkup(player.passport)}<span>${player.bot?.thinking ? 'Pensando…' : player.bet ? `◆ ${formatChips(player.bet)} · ${escapeHtml(choice)}` : `${formatChips(player.chips)} fichas`}</span></div>
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
    if (room.game === 'fortune') {
      const value = result && [1,2,5,10,20,40].includes(result.value) ? result.value : null;
      return `<small>RUEDA DE LA FORTUNA · RESULTADO DEL SERVIDOR</small><div class="fortune-wheel ${rolling}" aria-label="Rueda de 54 sectores"><span>${value == null ? '✺' : value}</span></div>${value == null ? '' : `<div class="quick-result-label">Sector ${value}</div>`}<p class="fortune-note">54 sectores: 25 de 1, 15 de 2, 7 de 5, 4 de 10, 2 de 20 y 1 de 40 · Pagos totales x2, x3, x6, x11, x21 y x41</p>`;
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
    const lobbyMatch = room.lobbyTournamentMatch;
    const myTurn = active && room.turnId === me.id;
    if (lobbyMatch?.status === 'completed') {
      els.actionPanel.innerHTML = `<div class="action-bar tournament-match-finished"><div class="waiting-copy"><b>🏆 Encuentro terminado · ${escapeHtml(lobbyMatch.winnerName || '—')}</b><span>${lobbyMatch.forfeit ? 'El resultado se resolvió por incomparecencia.' : 'El bracket del lobby se actualizará con el siguiente cruce. Tus fichas personales no participaron.'}</span></div><button class="game-btn primary" data-tournament-match-exit>Volver al lobby</button></div>`;
      els.actionPanel.querySelector('[data-tournament-match-exit]')?.addEventListener('click', () => leaveToLobby(true));
      return;
    }
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
    const canStart = me.isHost && !active && lobbyMatch?.status !== 'completed';
    const startCopy = lobbyMatch
      ? 'Repartir siguiente mano'
      : room.phase === 'showdown' ? 'Repartir otra mano' : 'Iniciar partida';
    const waitingCopy = lobbyMatch
      ? 'Heads-up de Texas Hold’em · 1.000 fichas virtuales de stack · entrada gratuita; tu saldo personal está protegido.'
      : !active && me.chips < 20 && !room.tournament?.active
        ? 'Te quedaste sin fichas para las ciegas (mínimo 20): puedes reclamar el bono diario de 100 desde tu perfil.'
        : active ? `Esperando a ${escapeHtml(room.players.find(p => p.id === room.turnId)?.name || 'la siguiente jugada')}…`
          : me.isHost ? 'Tú controlas el inicio de la próxima mano.' : 'El anfitrión iniciará cuando todos estén listos.';
    els.actionPanel.innerHTML = `<div class="action-bar"><div class="waiting-copy"><b>${active ? 'La acción está en la mesa' : room.phase === 'showdown' ? 'La mano terminó' : 'La mesa está lista'}</b><span>${waitingCopy}</span></div><div class="action-buttons">
      ${canStart ? `<button class="game-btn primary" data-event="poker_start">${startCopy}</button>` : ''}
      ${canStart && !lobbyMatch && !room.tournament?.active && room.players.filter(p => p.connected).length >= 2 ? '<button class="game-btn tournament-btn" data-event="tournament_start" title="Sit & Go de mesa: entrada 200 fichas y premio para el ganador">🏆 Iniciar Sit & Go</button>' : ''}
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
    if (game === 'fortune') return ['1','2','5','10','20','40'].map(value => `<button class="quick-choice" type="button" data-quick-choice="${value}" title="Pago total x${Number(value)+1} si aciertas">${value} <small>x${Number(value)+1}</small></button>`).join('');
    // La ruleta usa su propio paño completo (rouletteFeltHtml).
    const options = game === 'dice' ? [['low','Bajo · 1–3'],['high','Alto · 4–6']] : [['heads','Cara'],['tails','Cruz']];
    const simplePayout = 'Pago total x2 si aciertas';
    let html = options.map(([value, label]) => `<button class="quick-choice ${value}" type="button" data-quick-choice="${value}" title="${simplePayout}">${label}</button>`).join('');
    if (game === 'dice') html += [1,2,3,4,5,6].map(value => `<button class="quick-choice exact" type="button" data-quick-choice="n:${value}" title="Número exacto: pago total x6">${value}</button>`).join('');
    return html;
  }
  function renderQuickActions(room, me) {
    if (ui.quickGame !== room.game) {
      ui.quickGame = room.game;
      ui.quickChoice = room.game === 'coinflip' ? 'heads' : room.game === 'slots' ? 'spin' : room.game === 'fortune' ? '1' : 'low';
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
    // Fuera de una mesa también llega (p. ej. premio de un torneo del lobby):
    // antes se descartaba y la cuenta del lobby no se enteraba hasta refrescar.
    if (payload?.profile) {
      const seated = ui.room?.viewerProfile?.id === payload.profile.id;
      applyProfileSnapshot(payload.profile, { ambient: true });
      if (ui.room && seated && ui.me) { ui.me.avatar = payload.profile.avatar; ui.me.name = payload.profile.name; }
      if (ui.room) renderProfile();
      if (ui.profileOpen) renderProfileModal();
    }
    (payload?.events || []).forEach(event => {
      // Los premios de la ronda (logros, retos, cosméticos) dependen del resultado:
      // en ruleta y tragamonedas se revelan junto con el descubrimiento, no
      // mientras la rueda o los rodillos siguen girando. El Pasaporte nunca
      // agrega fichas al saldo.
      announceGameResult(() => {
        if (event.type === 'cosmetic_unlock') {
          showToast('Cosmético desbloqueado', `${event.icon || '✦'} ${event.name} · ${event.goal || 'meta de juego completada'} · ya puedes equiparlo en Colección.`, 'achievement', 5800, event.icon || '✦', true);
          playTone('win');
          return;
        }
        if (event.type === 'lobby_tournament_prize') {
          const placeLabel = event.placeLabel || `Puesto ${event.place}`;
          showToast('Premio de torneo relámpago', `${placeLabel} · +${formatChips(event.reward)} fichas virtuales.`, 'reward', 6000, '🏆', true);
          playTone('win');
          return;
        }
        if (event.type === 'passport_unlock') {
          showToast('Recompensa del Pasaporte', `${event.icon || '✦'} ${event.name} · recompensa de la temporada; revisa la sección Pasaporte.`, 'achievement', 5600, event.icon || '✦', true);
          playTone('win');
          return;
        }
        const kind = event.type === 'achievement' ? 'achievement' : event.type === 'challenge' ? 'challenge' : 'reward';
        showToast(event.type === 'challenge' ? 'Reto completado' : event.type === 'achievement' ? 'Logro desbloqueado' : event.name, `${event.name}${event.reward ? ` · +${event.reward} fichas` : ''}`, kind, 6500, event.icon, true);
        playTone('win');
      });
    });
  });
  socket.on('seasonal_theme_updated', applySeasonalTheme);
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
      if (els.dailyBonusClaim) {
        els.dailyBonusClaim.disabled = waiting;
        els.dailyBonusClaim.textContent = waiting ? 'Reclamado' : 'Reclamar +100';
        els.dailyBonusClaim.setAttribute('aria-label', waiting
          ? 'Bono diario reclamado; estará disponible al terminar el contador'
          : 'Reclamar bono diario de 100 fichas');
      }
      if (!waiting) {
        els.dailyBonusStatus.textContent = 'Disponible ahora · pulsa para reclamarlo.';
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
  async function claimDailyBonus(button) {
    if (!button || button.disabled || !currentViewerProfile()) return;
    const wasInTable = inTable();
    const payload = wasInTable ? {} : { accountId: ui.accountSession?.accountId };
    const response = await emitAck('daily_bonus_claim', payload, button);
    if (!response.ok) {
      showToast('No se pudo reclamar el bono', response.error || 'Inténtalo de nuevo.', 'error');
      return;
    }
    if (response.profile) {
      applyProfileSnapshot(response.profile);
      if (ui.room && ui.me) renderProfile();
    }
    renderProfileModal();
    if (response.claimed) {
      showToast('Bono diario reclamado', `+${response.reward || 100} fichas virtuales añadidas a tu saldo.`, 'reward', 4400, '🎁');
    } else {
      showToast('Bono diario ya reclamado', 'Vuelve a reclamarlo cuando se reinicie el contador.', 'notice', 4000, '🎁');
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
    jumpToProfileSection(ui.profileSection || 'overview');
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
  // Aviso dentro de la ventana cuando no hay perfil que pintar (lobby sin
  // cuenta y sin mesa): evita dejar una ventana vacía que parece averiada.
  function renderCollectionEmptyState(message) {
    const note = `<div class="collection-no-items">${escapeHtml(message)}</div>`;
    if (els.collectionItems) els.collectionItems.innerHTML = note;
    if (els.cardBookGrid) els.cardBookGrid.innerHTML = note;
    if (els.albumGrid) els.albumGrid.innerHTML = note;
  }
  // Baja (o sube) la ventana de Colección hasta una de sus dos secciones. Se
  // calcula con rectángulos y no con `offsetTop` porque `offsetTop` se mide
  // contra el ancestro posicionado más cercano (la tarjeta del modal), no
  // contra la caja que realmente se desplaza, y eso dejaba el salto torcido.
  function scrollToCollectionSection(sectionId) {
    const scroll = document.querySelector('#collection-modal .collection-modal-scroll');
    if (!scroll) return;
    const section = document.getElementById(sectionId === 'album' ? 'profile-section-album' : 'profile-section-collection');
    if (!section) { scroll.scrollTop = 0; return; }
    const delta = section.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    scroll.scrollTop = Math.max(0, scroll.scrollTop + delta - 8);
  }
  // Después de filtrar, la cuadrícula se repinta. Si quedó fuera de la vista
  // (p. ej. la persona estaba leyendo el Libro de cartas), se alinea justo
  // debajo de los filtros para que el cambio se vea sin tener que buscarlo.
  function revealCollectionResults() {
    const scroll = document.querySelector('#collection-modal .collection-modal-scroll');
    const filters = document.querySelector('#profile-section-collection .collection-filters');
    const grid = els.collectionItems;
    if (!scroll || !grid) return;
    const viewport = scroll.getBoundingClientRect();
    const edge = (filters || scroll).getBoundingClientRect().bottom;
    const gridTop = grid.getBoundingClientRect().top;
    if (gridTop >= edge - 1 && gridTop <= viewport.bottom - 80) return; // ya está a la vista
    scroll.scrollTop = Math.max(0, scroll.scrollTop + gridTop - edge - 10);
  }
  // Colección: ventana propia (cosméticos, libro de cartas y álbum), separada del perfil.
  // `target` decide a qué parte baja la ventana: 'collection' o 'album'.
  function openCollectionModal(target = 'collection') {
    const modal = document.getElementById('collection-modal');
    if (!modal) return;
    try {
      const profile = currentViewerProfile();
      if (profile) {
        renderCollection(profile);
        renderCardBook(profile);
        renderCardAlbum(profile);
      } else {
        showToast('Colección no disponible', 'Entra a una mesa o inicia sesión para ver tu colección.', 'notice', 4200, '◇');
        // Sin perfil no se pinta nada: se deja el aviso DENTRO de la ventana
        // (no solo en el toast) para que no parezca una ventana rota.
        renderCollectionEmptyState('Entra a una mesa o inicia sesión para ver tu colección.');
      }
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      scrollToCollectionSection(target);
      modal.querySelector('.modal-close')?.focus();
    } catch (error) {
      console.error('No se pudo abrir la colección', error);
      showToast('No se pudo abrir la colección', 'Recarga la página e inténtalo de nuevo.', 'error');
    }
  }
  function closeCollectionModal() {
    const modal = document.getElementById('collection-modal');
    if (!modal || !modal.classList.contains('open')) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    if (!els.modal.classList.contains('open') && !els.profileModal?.classList.contains('open') && !els.accountModal?.classList.contains('open')) {
      document.body.classList.remove('modal-open');
    }
  }
  // Mi espacio tiene ventana propia, independiente del desplazamiento del perfil.
  function openBettingSpaceModal() {
    const modal = document.getElementById('betting-space-modal');
    if (!modal) return;
    renderBettingRanking();
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    syncBetRankingSubscription();
    modal.querySelector('.modal-close')?.focus();
  }
  function closeBettingSpaceModal() {
    const modal = document.getElementById('betting-space-modal');
    if (!modal || !modal.classList.contains('open')) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    syncBetRankingSubscription();
    document.body.classList.toggle('modal-open', Boolean(document.querySelector('.modal.open')));
    if (els.profileModal?.classList.contains('open')) document.getElementById('profile-tab-betting')?.focus();
  }
  function closeProfileModal() {
    ui.profileOpen = false;
    ui.profileNameDirty = false;
    syncBetRankingSubscription();
    stopDailyBonusCountdown();
    els.passwordChangeForm?.reset();
    els.passwordChangeForm?.classList.add('hidden');
    els.passwordChangeError?.classList.add('hidden');
    els.profileModal?.classList.remove('open');
    els.profileModal?.setAttribute('aria-hidden', 'true');
    if (!els.modal.classList.contains('open')) document.body.classList.remove('modal-open');
  }
  // Gachapón de cartas (álbum del perfil). Las tasas y las cartas vienen del
  // servidor; aquí solo se pintan. Las cartas sin copias se muestran como
  // siluetas: su nombre y motivo no se revelan hasta que se obtienen.
  const ALBUM_RARITY_LABELS = { comun: 'Común', 'poco-comun': 'Poco común', raro: 'Raro', epico: 'Épico', legendario: 'Legendario', mitico: 'Mítico' };
  function formatPercent(value) {
    return `${Number(value || 0).toLocaleString('es-MX', { maximumFractionDigits: 4 })}%`;
  }
  function albumCardMarkup(card) {
    const owned = card.count > 0;
    const rarityName = card.rarityName || ALBUM_RARITY_LABELS[card.rarity] || card.rarity;
    const classes = [
      'album-card', `rarity-${card.rarity}`, `suit-${card.suit}`, `motif-${card.motif}`,
      owned ? 'owned' : 'locked', card.id === ui.albumLastPullId ? 'just-pulled' : ''
    ].filter(Boolean).join(' ');
    if (!owned) {
      return `<article class="${classes}" role="listitem" aria-label="Carta sin descubrir · ${escapeHtml(rarityName)}"><div class="album-card-face"><span class="album-card-mystery" aria-hidden="true">?</span></div><div class="album-card-copy"><b>Sin descubrir</b><small>${escapeHtml(rarityName)}</small></div></article>`;
    }
    const copies = card.count > 1 ? ` · ×${card.count}` : '';
    return `<article class="${classes}" role="listitem" aria-label="${escapeHtml(card.name)} · ${escapeHtml(rarityName)}${card.count > 1 ? `, ${card.count} copias` : ''}"><div class="album-card-face">${card.art ? `<img class="ac-photo" src="${escapeHtml(card.art)}" alt="" loading="lazy" decoding="async">` : ''}<span class="ac-corner">${escapeHtml(card.rank)}</span><span class="ac-symbol" aria-hidden="true">${escapeHtml(card.symbol)}</span><span class="ac-corner ac-corner-b">${escapeHtml(card.rank)}</span><span class="ac-art" aria-hidden="true"></span></div><div class="album-card-copy"><b>${escapeHtml(card.name)}</b><small>${escapeHtml(rarityName)}${copies}</small></div></article>`;
  }
  function renderCardAlbum(profile) {
    if (!els.albumGrid) return;
    const album = profile.cardAlbum;
    if (!album || !Array.isArray(album.cards)) {
      els.albumGrid.innerHTML = '<div class="collection-no-items">El álbum aparecerá cuando el servidor sincronice tu perfil.</div>';
      return;
    }
    if (els.albumCount) els.albumCount.textContent = `${album.ownedCount} / ${album.total} cartas · ${album.duplicates} repetidas`;
    if (els.albumCost) els.albumCost.textContent = formatChips(album.cost);
    if (els.albumOpenCapsule) els.albumOpenCapsule.textContent = `Abrir cápsula · ${formatChips(album.cost)} fichas`;
    if (els.albumRates) {
      els.albumRates.innerHTML = (album.rates || []).map(rate => `<div class="album-rate rarity-${escapeHtml(rate.id)}"><span class="album-rate-swatch" aria-hidden="true"></span><b>${escapeHtml(rate.name)}</b><small>${formatPercent(rate.percent)} · ${rate.cards} cartas</small><em>${formatPercent(rate.perCardPercent)} cada una</em></div>`).join('');
    }
    const cards = album.cards.filter(card => ui.albumFilter === 'all' || card.rarity === ui.albumFilter);
    els.albumGrid.innerHTML = cards.map(albumCardMarkup).join('');
  }
  async function openCardCapsule(button) {
    if (!button || button.disabled || !currentViewerProfile()) return;
    const wasInTable = inTable();
    const payload = wasInTable ? {} : { accountId: ui.accountSession?.accountId };
    const response = await emitAck('card_gacha_pull', payload, button);
    if (!response.ok) {
      showToast('No se pudo abrir la cápsula', response.error || 'Inténtalo de nuevo.', 'error');
      return;
    }
    if (response.profile) {
      applyProfileSnapshot(response.profile);
      if (ui.room && ui.me) renderProfile();
    }
    const card = response.card;
    if (!card) return;
    const rarityName = card.rarityName || ALBUM_RARITY_LABELS[card.rarity] || card.rarity;
    // Una repetida no suma al álbum: el servidor abona fichas (refundChips).
    const refund = Number(response.refundChips) || 0;
    const refundText = refund > 0 ? `+${formatChips(refund)} fichas` : '';
    if (els.albumLastPull) {
      els.albumLastPull.className = `album-last-pull rarity-${card.rarity}`;
      els.albumLastPull.innerHTML = `<span class="album-pull-label">${escapeHtml(rarityName)} · ${card.duplicate ? 'repetida' : 'nueva'}${refundText ? ` · ${refundText}` : ''}</span><b>${escapeHtml(card.name)}</b>`;
    }
    // La carta recién obtenida anima su entrada solo en este render: se limpia
    // después para que filtrar o volver a pintar no repita la animación.
    ui.albumLastPullId = card.id;
    renderProfileModal();
    ui.albumLastPullId = null;
    playTone(card.rarity === 'mitico' || card.rarity === 'legendario' ? 'win' : 'notice');
    const toastBody = card.duplicate
      ? `${card.name} · ${rarityName}. Ya la tenías: ${refundText ? `recibiste ${refundText}.` : 'no hubo abono.'}`
      : `${card.name} · ${rarityName}`;
    showToast(card.duplicate ? 'Carta repetida' : 'Carta nueva', toastBody, 'reward', 4200, card.symbol);
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
    if (els.profileDisplayName) {
      els.profileDisplayName.textContent = ui.profileNameDirty
        ? (els.profileNameInput.value.trim() || 'Jugador')
        : (profile.name || ui.playerName || 'Jugador');
    }
    ui.profileAvatar = ui.profileAvatar || profile.avatar;
    const equippedAvatar = profile.collection?.equipped?.avatar;
    const equippedArt = COSMETIC_AVATAR_ART.has(equippedAvatar?.art) ? equippedAvatar.art : null;
    els.profileBigAvatar.classList.toggle('avatar-art-equipped', Boolean(equippedArt));
    els.profileBigAvatar.classList.remove('frame-art-equipped', 'frame-obsidian', 'frame-starlight');
    const equippedFrame = cosmeticFrameClass(profile.collection);
    if (equippedFrame) els.profileBigAvatar.classList.add(...equippedFrame.split(' '));
    if (equippedArt) {
      const animation = ['float', 'glow', 'orbit'].includes(equippedAvatar.animation) ? ` animate-${equippedAvatar.animation}` : '';
      els.profileBigAvatar.innerHTML = `<img class="equipped-avatar-art${animation}" src="${equippedArt}" alt="${escapeHtml(equippedAvatar.name)}" decoding="async">`;
    } else els.profileBigAvatar.textContent = avatarEmoji(ui.profileAvatar);
    applyPassportFrame(els.profileBigAvatar, profile.passport);
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
    if (els.profileSyncNote) {
      els.profileSyncNote.classList.toggle('hidden', !(ui.profileStale && !inTable() && ui.accountSession));
    }
    if (els.accountLogout) els.accountLogout.classList.toggle('hidden', !ui.accountSession);
    if (els.accountPasswordToggle) els.accountPasswordToggle.classList.toggle('hidden', !ui.accountSession);
    if (!ui.accountSession) els.passwordChangeForm?.classList.add('hidden');
    // Fase 11.4: insignias de fin de temporada (banner único + medallas coleccionables).
    if (els.profileBadges) {
      const chips = [];
      const passportEquipped = serverFlags.passport === true ? profile.passport?.equipped || {} : {};
      if (passportEquipped.title) chips.push(`<span class="profile-badge passport-equipped-title" title="Título del Pasaporte · ${escapeHtml(passportEquipped.title.seasonLabel)}">${escapeHtml(passportEquipped.title.icon)} ${escapeHtml(passportEquipped.title.name)}</span>`);
      if (passportEquipped.badge) chips.push(`<span class="profile-badge passport-equipped-badge" title="Insignia del Pasaporte · ${escapeHtml(passportEquipped.badge.seasonLabel)}">${escapeHtml(passportEquipped.badge.icon)} ${escapeHtml(passportEquipped.badge.name)}</span>`);
      if (profile.fanPin) chips.push(fanPinMarkup(profile.fanPin));
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
    renderPassport(profile);
    renderCollection(profile);
    renderCardBook(profile);
    renderCardAlbum(profile);
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
        if (response.profile) applyProfileSnapshot(response.profile);
        renderAfterProfileChange();
      }));
    }
    renderDailyBonusCountdown(profile);
    renderBettingRanking();
  }
  const PASSPORT_REWARD_ART_SLUGS = new Set([
    'season-badge', 'frame-15', 'title-30', 'frame-50', 'emblem-75', 'explorer'
  ]);
  function passportRewardArtwork(item) {
    const slug = PASSPORT_REWARD_ART_SLUGS.has(item?.slug) ? item.slug : null;
    const artwork = slug
      ? `<img class="passport-reward-art" src="/assets/passport/rewards/${slug}.svg" alt="" loading="lazy" decoding="async">`
      : `<span class="passport-reward-art-fallback">${escapeHtml(item?.icon || '✦')}</span>`;
    return `<span class="passport-reward-artbox">${artwork}</span>`;
  }
  const PASSPORT_GAME_ART_IDS = new Set(['poker', 'blackjack', 'roulette', 'dice', 'coinflip', 'slots']);
  function passportGameArtwork(game) {
    const gameId = PASSPORT_GAME_ART_IDS.has(game?.id) ? game.id : null;
    const artwork = gameId
      ? `<img class="passport-game-art" src="/assets/passport/games/${gameId}.svg" alt="" loading="lazy" decoding="async">`
      : `<span class="passport-game-art-fallback">${escapeHtml(game?.icon || '✦')}</span>`;
    return `<span class="passport-game-artbox">${artwork}</span>`;
  }
  const COSMETIC_STYLE_IDS = new Set(['phoenix', 'axolotl', 'nebula', 'obsidian', 'starlight', 'ember', 'tide', 'aurora', 'emerald', 'royal', 'cosmos']);
  function cosmeticPreview(item, profile) {
    const style = COSMETIC_STYLE_IDS.has(item.style) ? item.style : 'default';
    const root = `collection-preview cosmetic-${item.slot} cosmetic-style-${style}`;
    if (item.slot === 'avatar') {
      const art = COSMETIC_AVATAR_ART.has(item.art) ? item.art : null;
      const animation = ['float', 'glow', 'orbit'].includes(item.animation) ? ` animate-${item.animation}` : '';
      return `<div class="${root}">${art ? `<img class="collection-avatar-art${animation}" src="${art}" alt="" loading="lazy" decoding="async">` : `<span>${escapeHtml(item.icon || '✦')}</span>`}</div>`;
    }
    if (item.slot === 'frame') return `<div class="${root}"><span class="collection-frame-sample">${avatarEmoji(profile.avatar)}</span></div>`;
    if (item.slot === 'chips') return `<div class="${root}"><span class="collection-chip-sample">✦</span></div>`;
    if (item.slot === 'felt') return `<div class="${root}"><span class="collection-felt-sample"></span></div>`;
    return `<div class="${root}"><span class="collection-card-sample"></span></div>`;
  }
  // Libro de cartas: las cartas del álbum se pueden usar como dorso en las mesas.
  function renderCardBook(profile) {
    if (!els.cardBookGrid) return;
    const album = profile.cardAlbum;
    if (!album || !Array.isArray(album.cards)) {
      els.cardBookGrid.innerHTML = '<div class="collection-no-items">El libro aparecerá cuando el servidor sincronice tu perfil.</div>';
      return;
    }
    if (els.cardBookCount) els.cardBookCount.textContent = `${album.ownedCount} / ${album.total} cartas`;
    const equippedId = profile.collection?.equipped?.cards?.id || null;
    els.cardBookGrid.innerHTML = album.cards.map(card => {
      const backId = `album:${card.id}`;
      const inUse = equippedId === backId;
      const base = albumCardMarkup(card);
      if (card.count <= 0) return base;
      const action = inUse
        ? `<button class="collection-equip" type="button" data-cosmetic-unequip="cards">En uso · quitar dorso</button>`
        : `<button class="collection-equip" type="button" data-cosmetic-equip="${escapeHtml(backId)}" data-cosmetic-slot="cards">Usar como dorso</button>`;
      return base.replace(/<\/article>$/, `<div class="card-book-action">${action}</div></article>`);
    }).join('');
    $$('#card-book-grid [data-cosmetic-equip]').forEach(button => button.addEventListener('click', () => equipProfileCosmetic(button, button.dataset.cosmeticSlot, button.dataset.cosmeticEquip)));
    $$('#card-book-grid [data-cosmetic-unequip]').forEach(button => button.addEventListener('click', () => equipProfileCosmetic(button, button.dataset.cosmeticUnequip, null)));
  }
  function renderCollection(profile) {
    if (!els.collectionItems) return;
    const inventory = profile.collection;
    const allItems = Array.isArray(inventory?.items) ? inventory.items : [];
    if (els.collectionCount) els.collectionCount.textContent = `${inventory?.unlockedCount || 0} / ${inventory?.total || allItems.length || 11} objetos`;
    const items = allItems.filter(item => ui.collectionFilter === 'all' || item.slot === ui.collectionFilter);
    const slotNames = { avatar: 'Avatar animado', frame: 'Marco', chips: 'Diseño de fichas', felt: 'Tapete', cards: 'Dorso de cartas' };
    els.collectionItems.innerHTML = items.length ? items.map(item => {
      const goal = item.goal || {};
      const target = Math.max(1, Number(goal.target) || 1);
      const value = Math.min(target, Math.max(0, Number(goal.value) || 0));
      const percent = Math.max(0, Math.min(100, Number(goal.percent) || Math.round(value / target * 100)));
      const unlocked = Boolean(item.unlocked);
      const equipped = Boolean(item.equipped);
      const equipAction = !unlocked ? '' : equipped
        ? `<button class="collection-equip" type="button" data-cosmetic-unequip="${escapeHtml(item.slot)}">Equipado · quitar</button>`
        : `<button class="collection-equip" type="button" data-cosmetic-equip="${escapeHtml(item.id)}" data-cosmetic-slot="${escapeHtml(item.slot)}">Equipar</button>`;
      return `<article class="collection-item ${unlocked ? 'is-unlocked' : 'collection-locked'} ${equipped ? 'is-equipped' : ''}" role="listitem">
        ${cosmeticPreview(item, profile)}
        <div class="collection-item-copy"><small>${escapeHtml(slotNames[item.slot] || item.slot)}${equipped ? ' · EN USO' : unlocked ? ' · DESBLOQUEADO' : ' · BLOQUEADO'}</small>
          <h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description)}</p>
          <p class="collection-goal-copy">${escapeHtml(goal.description || 'Juega rondas válidas para descubrir este objeto.')}</p>
          <div class="collection-progress-track" role="progressbar" aria-label="Progreso para ${escapeHtml(item.name)}" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${value}"><span style="width:${unlocked ? 100 : percent}%"></span></div>
          <div class="collection-item-meta"><small>${unlocked ? 'Meta completada' : `${formatChips(value)} / ${formatChips(target)} de progreso`}</small></div>${equipAction}
        </div>
      </article>`;
    }).join('') : '<div class="collection-no-items">La colección aparecerá cuando el servidor sincronice tu perfil.</div>';
    // Ámbito acotado a la cuadrícula de cosméticos: el selector global también
    // alcanzaba los botones del Libro de cartas y les sumaba un segundo
    // listener en cada repintado, lo que disparaba el equipado dos veces.
    $$('#collection-items [data-cosmetic-equip]').forEach(button => button.addEventListener('click', () => equipProfileCosmetic(button, button.dataset.cosmeticSlot, button.dataset.cosmeticEquip)));
    $$('#collection-items [data-cosmetic-unequip]').forEach(button => button.addEventListener('click', () => equipProfileCosmetic(button, button.dataset.cosmeticUnequip, null)));
  }
  async function equipProfileCosmetic(button, slot, itemId) {
    const payload = { slot, itemId };
    if (!inTable()) payload.accountId = ui.accountSession?.accountId;
    const response = await emitAck('cosmetic_equip', payload, button);
    if (!response.ok) return showToast('No se pudo equipar', response.error || 'Intenta de nuevo.', 'error');
    if (response.profile) {
      applyProfileSnapshot(response.profile);
      if (ui.me && ui.room?.viewerProfile?.id === response.profile.id) ui.me.collection = response.profile.collection;
    }
    renderAfterProfileChange();
    showToast(itemId ? 'Cosmético equipado' : 'Cosmético retirado', itemId ? 'Tu apariencia se actualizó en el servidor.' : 'El espacio quedó sin equipar.', 'notice', 3600, itemId ? '✦' : '◇');
  }
  function renderPassport(profile) {
    if (serverFlags.passport !== true) return;
    const passport = profile.passport;
    const season = passport?.season;
    if (!season) {
      if (els.passportStamps) els.passportStamps.innerHTML = '<div class="passport-empty">El Pasaporte estará disponible al actualizar tu perfil.</div>';
      return;
    }
    const points = Math.max(0, Math.floor(Number(season.points) || 0));
    const pointCap = Math.max(1, Math.floor(Number(season.pointCap) || 75));
    const percent = Math.max(0, Math.min(100, Number(season.progressPercent) || 0));
    if (els.passportSeasonLabel) els.passportSeasonLabel.textContent = season.label || 'Temporada actual';
    if (els.passportSeasonDates) {
      els.passportSeasonDates.textContent = `Del ${season.startDate || ''} al ${season.endDate || ''} · ${season.timeZone || 'hora local del casino'}`;
    }
    if (els.passportPoints) els.passportPoints.textContent = formatChips(points);
    if (els.passportNextMilestone) {
      const next = season.nextMilestone;
      els.passportNextMilestone.textContent = next
        ? `Siguiente hito: ${next.threshold} puntos · faltan ${next.remaining} · ${next.rewardName}.`
        : `¡Completaste los hitos de puntos! Llevas ${formatChips(points)} y puedes seguir sumando.`;
    }
    if (els.passportProgressBar) els.passportProgressBar.style.width = `${percent}%`;
    if (els.passportProgressTrack) {
      els.passportProgressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
      els.passportProgressTrack.setAttribute('aria-valuetext', `${formatChips(points)} de ${pointCap} puntos para los hitos de temporada`);
    }
    if (els.passportStampHint) els.passportStampHint.textContent = season.allGamesComplete
      ? '6/6 sellos · ¡Insignia Explorador desbloqueada!'
      : `${season.completedGames || 0}/6 sellos · Juega una ronda válida en cada mesa.`;
    if (els.passportStamps) {
      els.passportStamps.innerHTML = (season.games || []).map(game => `
        <div class="passport-stamp ${game.completed ? 'done' : ''}" role="listitem" aria-label="${escapeHtml(game.completed ? `${game.name}: sello obtenido` : `${game.name}: completa una ronda válida para obtener el sello`)}">
          ${passportGameArtwork(game)}
          <b>${escapeHtml(game.name)}</b>
          <small>${game.completed ? 'Sello obtenido' : 'Juega una ronda válida'}</small>
        </div>`).join('');
    }
    const rewardAction = reward => {
      if (!reward.unlocked) return '<span class="passport-reward-locked">Bloqueado</span>';
      if (reward.equipped) {
        return `<button class="passport-equip-btn equipped" type="button" data-passport-unequip="${escapeHtml(reward.slot)}">Quitar</button>`;
      }
      return `<button class="passport-equip-btn" type="button" data-passport-equip="${escapeHtml(reward.id)}" data-passport-slot="${escapeHtml(reward.slot)}">Equipar</button>`;
    };
    if (els.passportRewards) {
      els.passportRewards.innerHTML = (season.rewards || []).map(reward => `
        <article class="passport-reward ${reward.unlocked ? 'unlocked' : 'locked'} ${reward.equipped ? 'is-equipped' : ''}">
          ${passportRewardArtwork(reward)}
          <div class="passport-reward-copy"><small>${escapeHtml(reward.requirement)}</small><b>${escapeHtml(reward.name)}</b><p>${escapeHtml(reward.description)}</p></div>
          <div class="passport-reward-action">${reward.equipped ? '<span class="passport-equipped-label">Equipado</span>' : ''}${rewardAction(reward)}</div>
        </article>`).join('');
    }
    if (els.passportCollection) {
      const previousItems = (passport.inventory || []).filter(item => item.seasonKey !== season.key);
      els.passportCollection.innerHTML = previousItems.length
        ? previousItems.map(item => `
          <article class="passport-inventory-item">
            ${passportRewardArtwork(item)}
            <div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.seasonLabel)} · ${escapeHtml(item.description)}</small></div>
            ${item.equipped
              ? `<button class="passport-equip-btn equipped" type="button" data-passport-unequip="${escapeHtml(item.slot)}">Quitar</button>`
              : `<button class="passport-equip-btn" type="button" data-passport-equip="${escapeHtml(item.id)}" data-passport-slot="${escapeHtml(item.slot)}">Equipar</button>`}
          </article>`).join('')
        : '<div class="passport-empty">Tus cosméticos de temporadas anteriores se conservarán aquí.</div>';
    }
    $$('[data-passport-equip], [data-passport-unequip]').forEach(button => button.addEventListener('click', async () => {
      const wasInTable = inTable();
      const slot = button.dataset.passportSlot || button.dataset.passportUnequip;
      const itemId = button.hasAttribute('data-passport-unequip') ? null : button.dataset.passportEquip;
      const payload = { slot, itemId };
      if (!wasInTable) payload.accountId = ui.accountSession?.accountId;
      const response = await emitAck('passport_equip', payload, button);
      if (!response.ok) {
        showToast('No se actualizó el Pasaporte', response.error || 'No se pudo guardar el cosmético.', 'error');
        return;
      }
      if (response.profile) {
        applyProfileSnapshot(response.profile);
        if (ui.me && ui.room?.viewerProfile?.id === response.profile.id) ui.me.passport = { equipped: response.profile.passport?.equipped || {} };
      }
      renderProfile();
      renderProfileModal();
      showToast(itemId ? 'Cosmético equipado' : 'Cosmético retirado', itemId
        ? `${button.closest('.passport-reward, .passport-inventory-item')?.querySelector('b')?.textContent || 'Listo'} · visible en tu perfil.`
        : 'El espacio del perfil quedó vacío.', 'notice', 3600, itemId ? '✦' : '○');
    }));
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
  function setCommunityStatus(message = '', type = 'success') {
    const element = document.getElementById('community-status');
    if (!element) return;
    element.textContent = message;
    element.dataset.type = message ? type : '';
  }
  function showCommunityGuestState(unavailable = false) {
    const title = document.querySelector('#community-guest-note b');
    const copy = document.querySelector('#community-guest-note p');
    const login = document.getElementById('community-login');
    if (title) title.textContent = unavailable ? 'Comunidad no habilitada en este entorno' : 'Tu comunidad, con una cuenta segura';
    if (copy) copy.textContent = unavailable
      ? 'El servidor debe activar las sesiones seguras de cuenta para usar amistades y clubes.'
      : 'Inicia sesión o crea tu cuenta para enviar solicitudes, aceptar amistades y unirte a clubes.';
    if (login) login.hidden = unavailable;
  }
  function communityAccountMarkup(profile) {
    if (!profile) return '';
    return `<span class="community-account"><i class="community-avatar" style="background:${avatarColor(profile.id)}">${avatarEmoji(profile.avatar)}</i><span class="community-account-copy"><b>${escapeHtml(profile.name || profile.username)}</b><small>@${escapeHtml(profile.username)}</small></span></span>`;
  }
  function setCommunityTab(tab) {
    ui.communityTab = tab;
    $$('.community-tab').forEach(button => {
      const selected = button.dataset.communityTab === tab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    $$('.community-panel').forEach(panel => panel.classList.toggle('hidden', panel.dataset.communityPanel !== tab));
  }
  function renderCommunitySearchResults(users = []) {
    const container = document.getElementById('community-search-results');
    if (!container) return;
    if (!users.length) {
      container.innerHTML = '<p class="community-empty">Escribe al menos dos letras y busca una cuenta.</p>';
      return;
    }
    container.innerHTML = users.map(user => {
      const action = user.relationship === 'friend'
        ? '<button type="button" class="social-action is-complete" disabled>Ya es amistad</button>'
        : user.relationship === 'outgoing'
          ? '<button type="button" class="social-action is-complete" disabled>Solicitud enviada</button>'
          : user.relationship === 'incoming'
            ? '<button type="button" class="social-action" data-social-action="open-requests">Ver solicitud</button>'
            : `<button type="button" class="social-action" data-social-action="add-friend" data-username="${escapeHtml(user.username)}">＋ Agregar</button>`;
      return `<article class="community-person-row">${communityAccountMarkup(user)}${action}</article>`;
    }).join('');
  }
  function renderCommunityFriends() {
    const data = ui.communityData;
    if (!data) return;
    const friends = document.getElementById('community-friends-list');
    const incoming = document.getElementById('community-incoming-list');
    const outgoing = document.getElementById('community-outgoing-list');
    document.getElementById('community-friend-count').textContent = String(data.friends.length);
    document.getElementById('community-request-count').textContent = String(data.incomingRequests.length + data.outgoingRequests.length);
    document.getElementById('community-friends-subtitle').textContent = `${data.friends.length} ${data.friends.length === 1 ? 'persona' : 'personas'}`;
    friends.innerHTML = data.friends.map(profile => `<article class="community-person-row">${communityAccountMarkup(profile)}<button type="button" class="social-action is-muted" data-social-action="remove-friend" data-profile-id="${escapeHtml(profile.id)}">Quitar</button></article>`).join('')
      || '<div class="community-empty-card"><span>♧</span><b>Tu mesa empieza con una amistad</b><small>Busca su usuario y envíale una solicitud para tenerle a mano.</small></div>';
    incoming.innerHTML = data.incomingRequests.map(request => `<article class="community-person-row">${communityAccountMarkup(request.profile)}<div class="community-row-actions"><button type="button" class="social-action" data-social-action="accept-friend" data-request-id="${escapeHtml(request.id)}">Aceptar</button><button type="button" class="social-action is-muted" data-social-action="cancel-friend" data-request-id="${escapeHtml(request.id)}">Rechazar</button></div></article>`).join('')
      || '<p class="community-empty">No tienes solicitudes nuevas.</p>';
    outgoing.innerHTML = data.outgoingRequests.map(request => `<article class="community-person-row">${communityAccountMarkup(request.profile)}<button type="button" class="social-action is-muted" data-social-action="cancel-friend" data-request-id="${escapeHtml(request.id)}">Retirar</button></article>`).join('')
      || '<p class="community-empty">No hay solicitudes pendientes.</p>';
  }
  function clubTreasuryMarkup(club, ownId) {
    const treasury = club.treasury;
    if (!treasury) return '';
    const balance = Math.max(0, Number(treasury.balance) || 0);
    const available = Math.max(0, Number(ui.communityData.profile?.chips) || 0);
    const isOwner = club.ownerId === ownId;
    const inTable = Boolean(ui.room);
    const members = club.members || [];
    const payoutOptions = members.map(member => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name || member.username)} · @${escapeHtml(member.username)}</option>`).join('');
    const movements = (treasury.movements || []).length
      ? treasury.movements.map(movement => {
        const actor = movement.actor?.name || movement.actor?.username || 'Una persona integrante';
        const target = movement.target?.name || movement.target?.username || 'miembro';
        const isDeposit = movement.type === 'deposit';
        const description = isDeposit ? `${escapeHtml(actor)} aportó` : `${escapeHtml(actor)} distribuyó a ${escapeHtml(target)}`;
        const note = movement.note ? `<small>${escapeHtml(movement.note)}</small>` : '';
        return `<li class="club-ledger-row ${isDeposit ? 'is-deposit' : 'is-transfer'}"><span class="club-ledger-mark">${isDeposit ? '＋' : '↗'}</span><span class="club-ledger-copy"><b>${description}</b><small>${new Date(movement.time).toLocaleString()}</small>${note}</span><strong>${isDeposit ? '+' : '−'}${formatChips(movement.amount)}</strong></li>`;
      }).join('')
      : '<li class="club-ledger-empty">Los movimientos aparecerán aquí cuando alguien aporte o el liderazgo distribuya fichas.</li>';
    return `<section class="club-treasury-panel" aria-label="Tesorería de ${escapeHtml(club.name)}">
      <header class="club-treasury-heading"><div><small>TESORERÍA · ${escapeHtml(treasury.seasonKey || ui.communityData.seasonKey || 'TEMPORADA ACTUAL')}</small><b>◆ ${formatChips(balance)} <span>fichas del club</span></b></div><span class="club-treasury-lock">♜</span></header>
      <p class="club-treasury-rule">Las aportaciones pasan a la tesorería común. Solo el liderazgo puede distribuirlas. El saldo se reinicia junto con las fichas al cambiar la temporada.</p>
      <div class="club-treasury-forms">
        <form class="club-money-form" data-club-money="deposit" data-club-id="${escapeHtml(club.id)}">
          <div class="club-money-form-title"><span>＋</span><div><b>Aportar fichas</b><small>Tu saldo disponible: ◆ ${formatChips(available)}</small></div></div>
          <label>Fichas<input name="amount" type="number" min="1" max="${Math.min(100000, available)}" step="1" required inputmode="numeric" aria-label="Cantidad de fichas para aportar a ${escapeHtml(club.name)}" ${available < 1 || inTable ? 'disabled' : ''} /></label>
          <button class="social-action" type="submit" ${available < 1 || inTable ? 'disabled' : ''}>Aportar al club</button>
          ${inTable ? '<small class="club-money-hint">Sal de la mesa para mover fichas.</small>' : '<small class="club-money-hint">Máximo 100.000 por movimiento. Aportar no es una apuesta.</small>'}
        </form>
        ${isOwner ? `<form class="club-money-form club-distribute-form" data-club-money="transfer" data-club-id="${escapeHtml(club.id)}">
          <div class="club-money-form-title"><span>↗</span><div><b>Distribuir saldo</b><small>Solo para integrantes actuales</small></div></div>
          <label>Destinatario<select name="targetProfileId" required ${balance < 1 || inTable ? 'disabled' : ''}><option value="">Elige a un integrante</option>${payoutOptions}</select></label>
          <label>Fichas<input name="amount" type="number" min="1" max="${Math.min(100000, balance)}" step="1" required inputmode="numeric" aria-label="Cantidad de fichas a distribuir desde ${escapeHtml(club.name)}" ${balance < 1 || inTable ? 'disabled' : ''} /></label>
          <label>Nota <span class="club-optional-label">Opcional</span><input name="note" type="text" maxlength="80" placeholder="Motivo del movimiento" ${balance < 1 || inTable ? 'disabled' : ''} /></label>
          <button class="social-action" type="submit" ${balance < 1 || inTable ? 'disabled' : ''}>Enviar fichas</button>
          ${inTable ? '<small class="club-money-hint">Sal de la mesa para mover fichas.</small>' : '<small class="club-money-hint">El pago se descuenta por completo de la tesorería.</small>'}
        </form>` : ''}
      </div>
      <details class="club-ledger-details"><summary>Actividad de la tesorería <span>${treasury.movements?.length || 0} recientes</span></summary><ol class="club-ledger-list">${movements}</ol></details>
    </section>`;
  }

  function renderCommunityClubs(clubs = ui.communityData?.clubs || []) {
    const container = document.getElementById('community-clubs-list');
    if (!container || !ui.communityData) return;
    const ownId = ui.communityData.profile?.id;
    const ownedClub = (ui.communityData.memberships || []).some(club => club.ownerId === ownId) || clubs.some(club => club.ownerId === ownId);
    const createDetails = document.getElementById('community-create-club-details');
    createDetails?.classList.toggle('hidden', ownedClub);
    if (!clubs.length) {
      container.innerHTML = '<div class="community-empty-card"><span>♜</span><b>Aún no hay clubes por aquí</b><small>Funda uno e invita a tus amistades, o explora los que aparezcan.</small></div>';
      return;
    }
    container.innerHTML = clubs.map(club => {
      const isMember = club.membershipStatus === 'member';
      const isOwner = club.ownerId === ownId;
      const pending = club.membershipStatus === 'pending';
      const balance = Math.max(0, Number(club.treasury?.balance) || 0);
      const action = isOwner
        ? `<button type="button" class="social-action is-muted" data-social-action="disband-club" data-club-id="${escapeHtml(club.id)}" ${balance > 0 ? 'disabled title="Distribuye la tesorería antes de cerrar el club"' : ''}>${balance > 0 ? 'Vaciar para cerrar' : 'Cerrar club'}</button>`
        : isMember
          ? `<button type="button" class="social-action is-muted" data-social-action="leave-club" data-club-id="${escapeHtml(club.id)}">Salir</button>`
          : pending
            ? '<button type="button" class="social-action is-complete" disabled>Solicitud enviada</button>'
            : `<button type="button" class="social-action" data-social-action="join-club" data-club-id="${escapeHtml(club.id)}">${club.visibility === 'private' ? 'Solicitar acceso' : '＋ Unirme'}</button>`;
      const members = isMember && club.members?.length
        ? `<div class="club-member-strip">${club.members.slice(0, 6).map(member => `<span title="${escapeHtml(member.name)} · @${escapeHtml(member.username)}">${avatarEmoji(member.avatar)}</span>`).join('')}${club.memberCount > 6 ? `<small>+${club.memberCount - 6}</small>` : ''}</div>` : '';
      const requests = isOwner && club.requests?.length
        ? `<div class="club-requests"><small>SOLICITUDES PARA ENTRAR · ${club.requests.length}</small>${club.requests.map(request => `<div class="club-request-row">${communityAccountMarkup(request.profile)}<button type="button" class="social-action" data-social-action="accept-club-request" data-club-id="${escapeHtml(club.id)}" data-request-id="${escapeHtml(request.id)}">Aceptar</button><button type="button" class="social-action is-muted" data-social-action="reject-club-request" data-club-id="${escapeHtml(club.id)}" data-request-id="${escapeHtml(request.id)}">Rechazar</button></div>`).join('')}</div>` : '';
      const canManageMembers = isOwner && club.members?.length > 1;
      const memberActions = canManageMembers ? `<details class="club-member-management"><summary>Gestionar miembros</summary>${club.members.filter(member => member.id !== ownId).map(member => `<div>${communityAccountMarkup(member)}<button type="button" class="social-action is-muted" data-social-action="remove-club-member" data-club-id="${escapeHtml(club.id)}" data-profile-id="${escapeHtml(member.id)}">Quitar</button></div>`).join('')}</details>` : '';
      const treasury = isMember ? clubTreasuryMarkup(club, ownId) : '';
      return `<article class="community-club-card" data-club-color="${escapeHtml(club.color)}"><div class="community-club-head"><div class="community-club-emblem">${escapeHtml(club.emblemGlyph)}</div><div class="community-club-title"><h3>${escapeHtml(club.name)}</h3><small>${club.visibility === 'private' ? '◉ PRIVADO' : '✦ PÚBLICO'} · ${club.memberCount}/${club.memberLimit} MIEMBROS</small></div>${action}</div><p class="community-club-description">${escapeHtml(club.description || 'Un círculo para compartir mesa y partidas.')}</p><div class="community-club-foot"><span>Fundado por ${escapeHtml(club.owner?.name || club.owner?.username || 'MonteCristo')}</span>${members}</div>${treasury}${requests}${memberActions}</article>`;
    }).join('');
  }

  function renderCommunityClubRanking(ranking = ui.communityData?.clubRanking || []) {
    const podium = document.getElementById('community-club-ranking-podium');
    const list = document.getElementById('community-club-ranking-list');
    if (!podium || !list || !ui.communityData) return;
    const season = document.getElementById('community-club-ranking-season');
    if (season) season.textContent = ui.communityData.seasonKey ? `Temporada ${ui.communityData.seasonKey}` : 'Temporada actual';
    if (!ranking.length) {
      podium.innerHTML = '<div class="community-empty-card club-ranking-empty"><span>♜</span><b>La tesorería todavía está por estrenarse</b><small>Cuando los clubes públicos aporten fichas, su saldo aparecerá aquí. Los saldos privados solo los ve cada club.</small></div>';
      list.replaceChildren();
      return;
    }
    podium.innerHTML = ranking.slice(0, 3).map(club => `<article class="club-podium-card rank-${club.rank}" data-club-color="${escapeHtml(club.color)}"><span class="club-podium-rank">${club.rank === 1 ? '♛' : `#${club.rank}`}</span><span class="club-podium-emblem">${escapeHtml(club.emblemGlyph)}</span><b>${escapeHtml(club.name)}</b><small>${club.memberCount} ${club.memberCount === 1 ? 'integrante' : 'integrantes'}</small><strong>◆ ${formatChips(club.balance)}</strong><span class="club-podium-caption">TESORERÍA</span></article>`).join('');
    list.innerHTML = ranking.slice(3).map(club => `<article class="club-ranking-row" data-club-color="${escapeHtml(club.color)}"><span class="club-ranking-position">${club.rank}</span><span class="club-ranking-emblem">${escapeHtml(club.emblemGlyph)}</span><span class="club-ranking-copy"><b>${escapeHtml(club.name)}</b><small>${club.memberCount} integrantes · liderazgo de ${escapeHtml(club.owner?.name || club.owner?.username || 'club')}</small></span><strong>◆ ${formatChips(club.balance)}</strong></article>`).join('');
  }
  async function communityRequest(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD') {
      if (!ui.csrfToken) {
        const session = await secureAuthRequest('/api/auth/session');
        if (session.ok) {
          ui.csrfToken = session.csrfToken || null;
          if (session.profile) saveAccountSession(session.profile);
        }
      }
      if (ui.csrfToken) headers['X-CSRF-Token'] = ui.csrfToken;
      if (/\/api\/social\/v1\/clubs\/[^/]+\/(?:deposits|transfers)$/.test(path)) {
        headers['Idempotency-Key'] = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
    }
    return secureAuthRequest(path, { ...options, headers });
  }
  async function loadCommunityOverview() {
    const response = await communityRequest('/api/social/v1/me');
    if (!response.ok) {
      setCommunityStatus(response.error || 'No se cargó tu comunidad.', 'error');
      if (response.status === 401) clearAccountSession();
      if (response.status === 401 || response.status === 404) {
        document.getElementById('community-content').classList.add('hidden');
        document.getElementById('community-guest-note').classList.remove('hidden');
        showCommunityGuestState(response.status === 404);
      }
      return false;
    }
    ui.communityData = { ...response, memberships: response.clubs || [], clubs: [], clubRanking: [] };
    renderCommunityFriends();
    const clubs = await communityRequest('/api/social/v1/clubs');
    if (clubs.ok) ui.communityData.clubs = clubs.clubs;
    renderCommunityClubs();
    const ranking = await communityRequest('/api/social/v1/clubs/ranking');
    if (ranking.ok) {
      ui.communityData.clubRanking = ranking.ranking || [];
      ui.communityData.seasonKey = ranking.seasonKey || ui.communityData.seasonKey;
    }
    renderCommunityClubRanking();
    document.getElementById('community-content').classList.remove('hidden');
    document.getElementById('community-guest-note').classList.add('hidden');
    setCommunityStatus('');
    setCommunityTab(ui.communityTab);
    return true;
  }
  async function openCommunityModal() {
    els.communityModal?.classList.add('open');
    els.communityModal?.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    setCommunityStatus('Cargando tu círculo…');
    const refreshButton = document.getElementById('community-refresh');
    if (refreshButton) refreshButton.disabled = true;
    const session = await secureAuthRequest('/api/auth/session');
    if (!session.ok || !session.profile) {
      if (session.status === 401) clearAccountSession();
      document.getElementById('community-content').classList.add('hidden');
      document.getElementById('community-guest-note').classList.remove('hidden');
      showCommunityGuestState(session.status === 404);
      setCommunityStatus(session.status === 404 ? 'La comunidad requiere una sesión de cuenta segura.' : 'Inicia sesión para abrir tu comunidad.', 'error');
      return;
    }
    if (refreshButton) refreshButton.disabled = false;
    ui.csrfToken = session.csrfToken || null;
    saveAccountSession(session.profile);
    const loaded = await loadCommunityOverview();
    if (loaded) document.querySelector(`.community-tab[data-community-tab="${ui.communityTab}"]`)?.focus();
  }
  function closeCommunityModal() {
    els.communityModal?.classList.remove('open');
    els.communityModal?.setAttribute('aria-hidden', 'true');
    if (!$$('.modal.open').length) document.body.classList.remove('modal-open');
  }
  els.communityOpenBtn?.addEventListener('click', openCommunityModal);
  document.getElementById('community-refresh')?.addEventListener('click', () => loadCommunityOverview());
  $$('[data-close-community]').forEach(element => element.addEventListener('click', closeCommunityModal));
  document.getElementById('community-login')?.addEventListener('click', () => { closeCommunityModal(); openAccountModal(); });
  $$('.community-tab').forEach(button => button.addEventListener('click', () => setCommunityTab(button.dataset.communityTab)));
  document.getElementById('community-search-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const query = document.getElementById('community-search').value.trim();
    if ([...query].length < 2) return renderCommunitySearchResults([]);
    const response = await communityRequest(`/api/social/v1/users?q=${encodeURIComponent(query)}`);
    if (!response.ok) return setCommunityStatus(response.error || 'No se pudo buscar.', 'error');
    renderCommunitySearchResults(response.users);
    setCommunityStatus(`${response.users.length} resultados`, 'success');
  });
  document.getElementById('community-club-search-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const query = document.getElementById('community-club-search').value.trim();
    const response = await communityRequest(`/api/social/v1/clubs${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    if (!response.ok) return setCommunityStatus(response.error || 'No se pudieron buscar clubes.', 'error');
    ui.communityData.clubs = response.clubs;
    renderCommunityClubs();
    setCommunityStatus(`${response.clubs.length} clubes encontrados`, 'success');
  });
  document.getElementById('community-create-club-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const response = await communityRequest('/api/social/v1/clubs', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('community-club-name').value.trim(),
        description: document.getElementById('community-club-description').value.trim(),
        emblem: document.getElementById('community-club-emblem').value,
        color: document.getElementById('community-club-color').value,
        visibility: document.getElementById('community-club-visibility').value
      })
    });
    if (!response.ok) return setCommunityStatus(response.error || 'No se pudo crear el club.', 'error');
    document.getElementById('community-create-club-form').reset();
    document.getElementById('community-create-club-details').open = false;
    setCommunityStatus(response.message || 'Club fundado.', 'success');
    await loadCommunityOverview();
    setCommunityTab('clubs');
  });
  document.getElementById('community-clubs-list')?.addEventListener('submit', async event => {
    const form = event.target.closest('[data-club-money]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.busy === 'true') return;
    if (ui.room) return setCommunityStatus('Sal de la mesa antes de mover fichas del perfil.', 'error');
    form.dataset.busy = 'true';
    form.setAttribute('aria-busy', 'true');
    const action = form.dataset.clubMoney;
    const clubId = form.dataset.clubId;
    const amount = Number(form.elements.namedItem('amount')?.value);
    const targetProfileId = form.elements.namedItem('targetProfileId')?.value;
    const note = form.elements.namedItem('note')?.value?.trim() || '';
    const button = form.querySelector('button[type="submit"]');
    const path = action === 'deposit'
      ? `/api/social/v1/clubs/${encodeURIComponent(clubId)}/deposits`
      : `/api/social/v1/clubs/${encodeURIComponent(clubId)}/transfers`;
    button.disabled = true;
    const response = await communityRequest(path, {
      method: 'POST',
      body: JSON.stringify({ amount, ...(action === 'transfer' ? { targetProfileId, note } : {}) })
    });
    button.disabled = false;
    form.dataset.busy = 'false';
    form.removeAttribute('aria-busy');
    if (!response.ok) return setCommunityStatus(response.error || 'No se pudo completar el movimiento.', 'error');
    if (ui.communityData?.profile) ui.communityData.profile.chips = response.profileChips;
    applyAccountChips(ui.communityData?.profile?.id, response.profileChips);
    renderAfterProfileChange();
    setCommunityStatus(response.message || 'Movimiento registrado.', 'success');
    await loadCommunityOverview();
    setCommunityTab('clubs');
  });
  document.getElementById('community-modal')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-social-action]');
    if (!button) return;
    const { socialAction: action, username, requestId, profileId, clubId } = button.dataset;
    if (action === 'open-requests') return setCommunityTab('requests');
    const routes = {
      'add-friend': { path: '/api/social/v1/friends/requests', method: 'POST', body: { username } },
      'accept-friend': { path: `/api/social/v1/friends/requests/${encodeURIComponent(requestId)}/accept`, method: 'POST' },
      'cancel-friend': { path: `/api/social/v1/friends/requests/${encodeURIComponent(requestId)}`, method: 'DELETE' },
      'remove-friend': { path: `/api/social/v1/friends/${encodeURIComponent(profileId)}`, method: 'DELETE' },
      'join-club': { path: `/api/social/v1/clubs/${encodeURIComponent(clubId)}/join`, method: 'POST' },
      'leave-club': { path: `/api/social/v1/clubs/${encodeURIComponent(clubId)}/membership`, method: 'DELETE' },
      'disband-club': { path: `/api/social/v1/clubs/${encodeURIComponent(clubId)}`, method: 'DELETE' },
      'accept-club-request': { path: `/api/social/v1/clubs/${encodeURIComponent(clubId)}/requests/${encodeURIComponent(requestId)}/accept`, method: 'POST' },
      'reject-club-request': { path: `/api/social/v1/clubs/${encodeURIComponent(clubId)}/requests/${encodeURIComponent(requestId)}`, method: 'DELETE' },
      'remove-club-member': { path: `/api/social/v1/clubs/${encodeURIComponent(clubId)}/members/${encodeURIComponent(profileId)}`, method: 'DELETE' }
    };
    const operation = routes[action];
    if (!operation) return;
    if (['remove-friend', 'leave-club', 'disband-club', 'remove-club-member'].includes(action) && !window.confirm('¿Quieres continuar con esta acción?')) return;
    button.disabled = true;
    const response = await communityRequest(operation.path, {
      method: operation.method,
      ...(operation.body ? { body: JSON.stringify(operation.body) } : {})
    });
    button.disabled = false;
    if (!response.ok) return setCommunityStatus(response.error || 'No se pudo completar la acción.', 'error');
    setCommunityStatus(response.message || 'Cambios guardados.', 'success');
    await loadCommunityOverview();
    if (action.includes('club')) setCommunityTab('clubs');
  });
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
  $$('[data-profile-jump]').forEach(button => {
    button.addEventListener('click', () => jumpToProfileSection(button.dataset.profileJump, true));
  });
  $$('[data-bet-ranking-source]').forEach(button => {
    button.addEventListener('click', () => {
      ui.betRankingSource = button.dataset.betRankingSource || 'total';
      renderBettingRanking();
    });
  });
  els.albumOpenCapsule?.addEventListener('click', () => openCardCapsule(els.albumOpenCapsule));
  $$('[data-album-filter]').forEach(button => {
    button.addEventListener('click', () => {
      ui.albumFilter = button.dataset.albumFilter || 'all';
      $$('[data-album-filter]').forEach(item => {
        const selected = item === button;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', String(selected));
      });
      const profile = currentViewerProfile();
      if (profile) renderCardAlbum(profile);
    });
  });
  $$('[data-collection-filter]').forEach(button => {
    button.addEventListener('click', () => {
      ui.collectionFilter = button.dataset.collectionFilter || 'all';
      $$('[data-collection-filter]').forEach(item => {
        const selected = item === button;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', String(selected));
      });
      const profile = currentViewerProfile();
      if (profile) renderCollection(profile);
      revealCollectionResults();
    });
  });
  els.tournamentNameForm?.addEventListener('submit', event => {
    event.preventDefault();
    const name = String(els.tournamentNameInput?.value || '').trim().slice(0, 18);
    const tournamentId = ui.pendingTournamentSignup;
    if (!name || !tournamentId) return;
    ui.pendingTournamentSignup = null;
    els.tournamentNameDialog?.close?.();
    joinLobbyTournament(tournamentId, null, name);
  });
  document.querySelector('[data-tournament-name-cancel]')?.addEventListener('click', () => {
    ui.pendingTournamentSignup = null;
    els.tournamentNameDialog?.close?.();
  });
  document.getElementById('profile-content-scroll')?.addEventListener('scroll', syncProfileSectionFromScroll, { passive: true });
  $$('[data-close-profile]').forEach(element => element.addEventListener('click', closeProfileModal));
  $$('[data-open-betting-space]').forEach(element => element.addEventListener('click', openBettingSpaceModal));
  $$('[data-close-betting-space]').forEach(element => element.addEventListener('click', closeBettingSpaceModal));
  $$('[data-open-collection]').forEach(element => element.addEventListener('click', () => openCollectionModal(element.dataset.openCollection)));
  $$('[data-close-collection]').forEach(element => element.addEventListener('click', closeCollectionModal));
  els.dailyBonusClaim?.addEventListener('click', event => claimDailyBonus(event.currentTarget));
  // Marca la edición en curso del nombre para que los refrescos en segundo
  // plano no sobrescriban lo que la persona está escribiendo; el encabezado
  // actúa como vista previa de la identidad que quedará al guardar.
  els.profileNameInput.addEventListener('input', () => {
    ui.profileNameDirty = true;
    if (els.profileDisplayName) els.profileDisplayName.textContent = els.profileNameInput.value.trim() || 'Jugador';
  });
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
    if (response.profile) applyProfileSnapshot(response.profile);
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
      refreshSeasonalThemeVisibility();
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
