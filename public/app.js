(() => {
  'use strict';

  const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 700, reconnectionDelayMax: 4000 });
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  const els = {
    landing: $('#landing'), roomApp: $('#room-app'), modal: $('#join-modal'), form: $('#join-form'),
    playerName: $('#player-name'), roomName: $('#room-name'), roomNameField: $('#room-name-field'),
    roomCode: $('#room-code'), codeField: $('#code-field'), gameChoice: $('#game-choice'),
    modalKicker: $('#modal-kicker'), modalTitle: $('#modal-title'), modalSubtitle: $('#modal-subtitle'), modalSymbol: $('.modal-symbol'),
    modalSubmit: $('#modal-submit'), overlay: $('#connection-overlay'), loadingMessage: $('#loading-message'),
    navConnection: $('#nav-connection'), headerConnection: $('#header-connection'), connectionStatus: $('#connection-status'),
    liveRooms: $('#live-rooms'), liveRoomCount: $('#live-room-count'), onlinePlayerCount: $('#online-player-count'),
    heroOnlineCount: $('#hero-online-count'), lobbyRefresh: $('#lobby-refresh'),
    gameName: $('#game-name'), phaseLabel: $('#phase-label'), roomTitle: $('#room-title'), headerCode: $('#header-code'),
    profileCard: $('#profile-card'), playersList: $('#players-list'), playerCount: $('#player-count'),
    chatList: $('#chat-list'), chatForm: $('#chat-form'), chatInput: $('#chat-input'),
    gameStatus: $('#game-status'), turnClock: $('#turn-clock'), clockValue: $('#clock-value'),
    clockPlayer: $('#clock-player'), tableWrap: $('#table-wrap'), actionPanel: $('#action-panel'),
    toastStack: $('#toast-stack'), roundFlash: $('#round-flash'),
    sidebar: $('.sidebar'), soundToggle: $('#sound-toggle'),
    specialEventBanner: $('#special-event-banner'), winnerTicker: $('#winner-ticker'), reactionStage: $('#reaction-stage'),
    profileModal: $('#profile-modal'), profileForm: $('#profile-form'), profileNameInput: $('#profile-name-input'),
    profileAvatarChoice: $('#profile-avatar-choice'), profileBigAvatar: $('#profile-big-avatar'),
    profileStats: $('#profile-stats'), challengeList: $('#challenge-list'), achievementList: $('#achievement-list'),
    dailyBonusStatus: $('#daily-bonus-status'), quickChatToggle: $('#quick-chat-toggle'), quickChatMenu: $('#quick-chat-menu'),
    botMenuToggle: $('#bot-menu-toggle'), botControls: $('#bot-controls'), botMenuClose: $('#bot-menu-close'),
    botDifficulty: $('#bot-difficulty'), botStyle: $('#bot-style'), botAdd: $('#bot-add'), botFill: $('#bot-fill')
  };

  const PHASES = {
    waiting: 'Sala de espera', betting: 'Ronda de apuestas', playing: 'Ronda en curso', rolling: 'Resultado en camino',
    preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River',
    showdown: 'Resultados', results: 'Resultados'
  };
  const GAME_META = {
    poker: { icon: '♠', name: 'TEXAS HOLD’EM' }, blackjack: { icon: '◆', name: 'BLACKJACK' },
    roulette: { icon: '◉', name: 'RULETA NOVA' }, dice: { icon: '⚄', name: 'DADOS CÓSMICOS' },
    coinflip: { icon: '◐', name: 'CARA O CRUZ' }, slots: { icon: '🎰', name: 'TRAGAMONEDAS' }
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
  migrateLegacyStorage();
  const deviceToken = getDeviceToken();
  const routeCode = getRouteCode();
  const savedSession = readSession();

  // ---------- Términos y condiciones (aceptación obligatoria) ----------
  function tosAccepted() { return localStorage.getItem(TOS_KEY) === TOS_VERSION; }
  function showTosModal() {
    const modal = document.getElementById('tos-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    modal.querySelector('#tos-accept')?.focus();
  }
  function hideTosModal() {
    const modal = document.getElementById('tos-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }
  if (!tosAccepted()) showTosModal();
  document.getElementById('tos-accept')?.addEventListener('click', () => {
    localStorage.setItem(TOS_KEY, TOS_VERSION);
    hideTosModal();
  });

  const ui = {
    modalMode: 'create', selectedGame: 'poker', roomFilter: 'all', lobby: [], playersOnline: 0,
    room: null, me: null, activeCode: null, playerName: localStorage.getItem('montecristo-name') || '',
    selectedAvatar: localStorage.getItem('montecristo-avatar') || 'fox', profileAvatar: localStorage.getItem('montecristo-avatar') || 'fox',
    connection: 'connecting', sound: localStorage.getItem('montecristo-sound') !== 'off',
    lastGameSignature: '', lastChatSignature: '', shouldResume: false, joining: false,
    lastEventKey: '', clockTimer: null, previousRanks: new Map(), previousChips: new Map(), lastMeChips: null, profileOpen: false,
    rouletteAngle: 0, rouletteSpin: null, rouletteRaf: null, slotsSpin: null, slotsRaf: null
  };

  if (savedSession && routeCode && savedSession.code === routeCode) {
    ui.activeCode = routeCode;
    ui.playerName = savedSession.name || ui.playerName;
    ui.selectedAvatar = savedSession.avatar || ui.selectedAvatar;
    ui.shouldResume = Boolean(ui.playerName);
  }
  els.playerName.value = ui.playerName;
  updateSoundButton();
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
  function getRouteCode() {
    const match = location.pathname.match(/^\/room\/([A-Z0-9]{5})/i);
    return match ? match[1].toUpperCase() : '';
  }
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem('montecristo-session')); } catch { return null; }
  }
  function saveSession() {
    if (!ui.activeCode || !ui.playerName) return;
    sessionStorage.setItem('montecristo-session', JSON.stringify({ code: ui.activeCode, name: ui.playerName, avatar: ui.selectedAvatar }));
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
      const timer = setTimeout(() => resolve({ ok: false, error: 'La mesa tardó demasiado en responder.' }), 9000);
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

  socket.on('connect', async () => {
    setConnection('connected');
    setTimeout(() => { if (!ui.joining) setOverlay(false); }, 350);
    if (ui.shouldResume && ui.activeCode && ui.playerName) {
      ui.shouldResume = false;
      ui.joining = true;
      setOverlay(true, 'RECUPERANDO TU ASIENTO');
      const response = await emitAck('join_room', { name: ui.playerName, code: ui.activeCode, token: deviceToken, avatar: ui.selectedAvatar, tos: localStorage.getItem(TOS_KEY) });
      ui.joining = false;
      if (!response.ok) {
        clearSession(); ui.activeCode = null; setOverlay(false);
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
  socket.io.on('reconnect_attempt', () => {
    setConnection('reconnecting');
    if (ui.room || ui.activeCode) { ui.shouldResume = true; setOverlay(true, 'RECONECTANDO CON LA MESA'); }
  });
  socket.io.on('reconnect_failed', () => { setConnection('disconnected'); setOverlay(false); });
  socket.on('connect_error', () => { setConnection('reconnecting'); });

  // ---------- Modal and landing ----------
  function openModal(mode = 'create', options = {}) {
    ui.modalMode = mode;
    ui.selectedGame = options.game === 'blackjack' ? 'blackjack' : (options.game || ui.selectedGame || 'poker');
    els.playerName.value = ui.playerName || localStorage.getItem('montecristo-name') || '';
    els.roomCode.value = options.code || '';
    els.roomName.value = options.roomName || '';
    const joining = mode === 'join';
    els.modalKicker.textContent = joining ? 'UNIRSE A UNA MESA' : 'NUEVA SALA';
    els.modalTitle.textContent = joining ? 'Toma tu asiento' : 'Prepara la mesa';
    els.modalSubtitle.textContent = joining
      ? 'Escribe tu nombre y el código para entrar a la partida en vivo.'
      : 'Configura tu partida. Podrás invitar a tus amigos cuando entres.';
    if (els.modalSymbol) els.modalSymbol.textContent = joining ? '⌁' : (GAME_META[ui.selectedGame]?.icon || '♠');
    els.roomNameField.classList.toggle('hidden', joining);
    els.gameChoice.classList.toggle('hidden', joining);
    els.codeField.classList.toggle('hidden', !joining);
    els.modalSubmit.querySelector('.btn-label').textContent = joining ? 'Entrar a la sala' : 'Crear sala';
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
  }));
  $$('[data-select-avatar]').forEach(button => button.addEventListener('click', () => {
    ui.selectedAvatar = button.dataset.selectAvatar;
    localStorage.setItem('montecristo-avatar', ui.selectedAvatar);
    $$('[data-select-avatar]').forEach(item => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
  }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); closeProfileModal(); toggleShortcutHelp(false); } });
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
    if (!tosAccepted()) { showTosModal(); return; }
    setButtonLoading(els.modalSubmit, true);
    ui.joining = true;
    const joining = ui.modalMode === 'join';
    const code = els.roomCode.value.trim().toUpperCase();
    if (joining && !/^[A-Z0-9]{5}$/.test(code)) {
      setButtonLoading(els.modalSubmit, false); ui.joining = false;
      showToast('Código incompleto', 'Los códigos de sala tienen cinco caracteres.', 'error'); return;
    }
    setOverlay(true, joining ? 'BUSCANDO TU ASIENTO' : 'ABRIENDO UNA NUEVA MESA');
    const response = joining
      ? await emitAck('join_room', { name, code, token: deviceToken, avatar: ui.selectedAvatar, tos: localStorage.getItem(TOS_KEY) })
      : await emitAck('create_room', { name, roomName: els.roomName.value.trim(), game: ui.selectedGame, token: deviceToken, avatar: ui.selectedAvatar, tos: localStorage.getItem(TOS_KEY) });
    setButtonLoading(els.modalSubmit, false); ui.joining = false;
    if (!response.ok) {
      setOverlay(false); showToast('No se pudo entrar', response.error || 'Intenta de nuevo.', 'error'); return;
    }
    ui.activeCode = response.code;
    saveSession(); updateHistory(response.code); closeModal();
    // room_state completes the visual transition.
    setTimeout(() => { if (ui.room) setOverlay(false); }, 450);
  });

  // ---------- Live lobby ----------
  socket.on('lobby_state', payload => {
    ui.lobby = Array.isArray(payload?.rooms) ? payload.rooms : [];
    ui.playersOnline = Number(payload?.playersOnline) || 0;
    renderLobby();
  });

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
        <button class="join-live-room" data-live-code="${escapeHtml(room.code)}" aria-label="${full ? 'Sala llena' : `Entrar a ${escapeHtml(room.name || 'la mesa')}`}" ${full ? 'disabled' : ''}>${full ? 'LLENA' : 'Tomar asiento →'}</button></div>
      </article>`;
    }).join('');
    observeLobbyCards();
    $$('[data-live-code]').forEach(button => button.addEventListener('click', () => openModal('join', { code: button.dataset.liveCode })));
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
    ui.activeCode = room.code;
    ui.me = room.players.find(player => player.id === deviceToken) || room.players.find(player => player.name === ui.playerName) || null;
    if (ui.me) {
      ui.playerName = ui.me.name;
      ui.selectedAvatar = ui.me.avatar || ui.selectedAvatar;
      localStorage.setItem('montecristo-name', ui.playerName);
      localStorage.setItem('montecristo-avatar', ui.selectedAvatar);
    }
    saveSession();
    if (wasOutside) enterRoom();
    renderRoom();
    setOverlay(false);
  });

  function enterRoom() {
    closeModal();
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
    if (ui.profileOpen) renderProfileModal();
    const gameSignature = JSON.stringify([
      room.game, room.phase, room.turnId, room.turnDeadline, room.dealerHand, room.community, room.pot,
      room.currentBet, room.minRaise, room.dealerIndex, room.handNumber, room.results, room.quickResult, room.specialEvent,
      room.players.map(p => [p.id, p.name, p.avatar, p.chips, p.hand, p.bet, p.quickChoice, p.roundBet, p.totalBet, p.status, p.folded, p.allIn, p.connected, p.isBot, p.bot?.thinking, p.bot?.lastActionAt])
    ]);
    if (gameSignature !== ui.lastGameSignature) {
      ui.lastGameSignature = gameSignature;
      renderTable(); renderActions();
    }
    updateClock();
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
    if (!ui.me) { els.profileCard.innerHTML = ''; return; }
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
      const status = !player.connected ? 'Desconectado' : botThinking ? 'Pensando…' : recentBotAction ? player.bot.lastAction : isTurn ? 'Pensando…' : player.status === 'winner' ? 'Ganador' : player.status === 'lost' ? 'Ronda perdida' : player.status === 'folded' ? 'Se retiró' : player.allIn ? 'All-in' : `${formatChips(player.chips)} fichas`;
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
      : `<div class="chat-msg"><div class="chat-avatar" style="background:${avatarColor(message.playerId)}">${avatarEmoji(ui.room.players.find(player => player.id === message.playerId)?.avatar)}</div><div class="chat-bubble"><b>${escapeHtml(message.name)}</b><p>${escapeHtml(message.text)}</p></div></div>`).join('')
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
    const cards = player.hand?.map(card => cardHtml(card, true)).join('') || '';
    const score = player.hand?.length && !player.hand.includes('XX') ? blackjackValue(player.hand) : '';
    const bet = player.bet > 0 ? `<div class="seat-bet"><i></i>${formatChips(player.bet)}</div>` : '';
    const status = player.id === room.turnId ? (player.id === ui.me?.id ? 'TU TURNO' : 'EN TURNO') : result?.label || (player.status === 'blackjack' ? 'BLACKJACK' : '');
    return `<div class="table-seat blackjack-seat seat-${index} ${classes}"><div class="seat-cards">${cards}</div><div class="seat-head">
      <div class="seat-avatar" style="background:${avatarColor(player.id)}">${avatarEmoji(player.avatar)}</div><div class="seat-info"><b>${escapeHtml(player.name)}${player.isBot ? '<i class="seat-bot-badge">BOT</i>' : ''}</b><span>◆ ${formatChips(player.chips)}</span></div>
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
    if (!me) { els.actionPanel.innerHTML = ''; return; }
    if (room.game === 'poker') renderPokerActions(room, me);
    else if (room.game === 'blackjack') renderBlackjackActions(room, me);
    else renderQuickActions(room, me);
    bindActionButtons();
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
    els.actionPanel.innerHTML = `<div class="action-bar"><div class="waiting-copy"><b>${active ? 'La acción está en la mesa' : room.phase === 'showdown' ? 'La mano terminó' : 'La mesa está lista'}</b><span>${active ? `Esperando a ${escapeHtml(room.players.find(p => p.id === room.turnId)?.name || 'la siguiente jugada')}…` : me.isHost ? 'Tú controlas el inicio de la próxima mano.' : 'El anfitrión iniciará cuando todos estén listos.'}</span></div><div class="action-buttons">
      ${canStart ? `<button class="game-btn primary" data-event="poker_start">${startCopy}</button>` : ''}
      ${me.chips < 200 && !active ? '<button class="game-btn" data-event="rebuy">Recargar fichas</button>' : ''}
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
      const canDouble = me.hand.length === 2 && me.chips >= me.bet;
      els.actionPanel.innerHTML = `<div class="action-bar"><div class="action-info"><small>TU MANO</small><b>VALOR <span>${blackjackValue(me.hand)}</span></b></div><div class="action-buttons"><button class="game-btn primary" data-event="blackjack_hit">Pedir carta</button><button class="game-btn green" data-event="blackjack_stand">Plantarse</button><button class="game-btn" data-event="blackjack_double" ${canDouble ? '' : 'disabled'}>Doblar</button></div></div>`;
      return;
    }
    if (room.phase === 'results') {
      els.actionPanel.innerHTML = `<div class="action-bar"><div class="result-strip">${room.results.map(result => `<span class="result-item ${result.amount > 0 ? 'win' : ''}">${escapeHtml(result.name)} <b>${result.amount > 0 ? '+' : ''}${formatDelta(result.amount)}</b></span>`).join('')}</div><div class="action-buttons">${me.isHost ? '<button class="game-btn primary" data-event="blackjack_new">Nueva ronda</button>' : '<span class="waiting-copy"><span>Esperando al anfitrión…</span></span>'}</div></div>`;
      return;
    }
    const current = room.players.find(player => player.id === room.turnId);
    els.actionPanel.innerHTML = `<div class="action-bar"><div class="waiting-copy"><b>La casa está en juego</b><span>${current ? `Turno de ${escapeHtml(current.name)}.` : 'Resolviendo la ronda…'}</span></div></div>`;
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
    showToast(title, event.text, kind, ['turn', 'win', 'loss', 'special'].includes(event.type) ? 5500 : 3500, icon);
    playTone(kind === 'achievement' || kind === 'reward' ? 'win' : kind);
    if (event.type === 'round') showRoundFlash(event.text);
    if (event.type === 'turn') showRoundFlash('Tu turno');
    if (event.type === 'roll') showRoundFlash('¡En juego!');
    if (event.type === 'quick_result') showRoundFlash(event.text);
    if (event.type === 'win') celebrate();
    if (event.type === 'loss') lossEffect();
  });
  socket.on('profile_event', payload => {
    if (payload?.profile && ui.room) {
      ui.room.viewerProfile = payload.profile;
      if (ui.me) { ui.me.chips = payload.profile.chips; ui.me.avatar = payload.profile.avatar; ui.me.name = payload.profile.name; }
      renderProfile();
      if (ui.profileOpen) renderProfileModal();
    }
    (payload?.events || []).forEach(event => {
      const kind = event.type === 'achievement' ? 'achievement' : event.type === 'challenge' ? 'challenge' : 'reward';
      showToast(event.type === 'challenge' ? 'Reto completado' : event.type === 'achievement' ? 'Logro desbloqueado' : event.name, `${event.name}${event.reward ? ` · +${event.reward} fichas` : ''}`, kind, 6500, event.icon);
      playTone('win');
    });
  });
  socket.on('social_event', event => {
    if (!event?.text) return;
    showToast(event.type === 'big_win' ? '¡Gran resultado!' : 'Celebración en la mesa', event.text, event.type === 'big_win' ? 'reward' : 'achievement', 5600, event.icon || '✦');
    if (event.type === 'big_win') { celebrate(); showRoundFlash(`+${formatChips(event.amount)} fichas`); }
  });
  socket.on('reaction', event => showFloatingReaction(event));
  socket.on('removed', payload => {
    showToast('Saliste de la mesa', payload?.message || 'Tu asiento ya no está disponible.', 'error', 5000);
    leaveToLobby(false);
  });

  function showToast(title, text, kind = 'notice', duration = 3600, icon = null) {
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

  // ---------- Profile, social controls and general room controls ----------
  function openProfileModal() {
    if (!ui.room?.viewerProfile) return;
    ui.profileOpen = true;
    ui.profileAvatar = ui.room.viewerProfile.avatar || 'fox';
    renderProfileModal();
    els.profileModal.classList.add('open');
    els.profileModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }
  function closeProfileModal() {
    ui.profileOpen = false;
    els.profileModal?.classList.remove('open');
    els.profileModal?.setAttribute('aria-hidden', 'true');
    if (!els.modal.classList.contains('open')) document.body.classList.remove('modal-open');
  }
  function renderProfileModal() {
    const profile = ui.room?.viewerProfile;
    if (!profile) return;
    const stats = profile.stats || {};
    els.profileNameInput.value = profile.name || ui.playerName;
    ui.profileAvatar = ui.profileAvatar || profile.avatar;
    els.profileBigAvatar.textContent = avatarEmoji(ui.profileAvatar);
    renderAvatarChoices();
    els.profileStats.innerHTML = [
      ['FICHAS', formatChips(profile.chips), 'gold'], ['VICTORIAS', formatChips(stats.wins), ''],
      ['RONDAS', formatChips(stats.roundsPlayed), ''], ['MAYOR GANANCIA', `+${formatChips(stats.biggestWin)}`, 'gold'],
      ['APOSTADO', formatChips(stats.totalWagered), ''], ['MEJOR RACHA', formatChips(stats.bestStreak), ''],
      ['JUEGOS PROBADOS', `${formatChips(stats.differentGames)} / 5`, ''], ['DERROTAS', formatChips(stats.losses), '']
    ].map(([label,value,kind]) => `<div class="profile-stat"><small>${label}</small><b class="${kind}">${value}</b></div>`).join('');
    els.challengeList.innerHTML = (profile.challenges || []).map(item => {
      const percent = Math.min(100, Math.round((item.value || 0) / item.target * 100));
      return `<div class="progress-item ${item.completed ? 'done' : ''}"><span class="progress-icon">${escapeHtml(item.icon)}</span><div class="progress-copy"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description)} · ${item.value}/${item.target}</small><div class="progress-track"><i style="width:${percent}%"></i></div></div><span class="progress-reward">${item.completed ? '✓' : '+' + item.reward}</span></div>`;
    }).join('') || '<div class="chat-system">Los retos aparecerán al jugar.</div>';
    els.achievementList.innerHTML = (profile.allAchievements || []).map(item => `<div class="progress-item ${item.unlocked ? 'done' : 'locked'}"><span class="progress-icon">${escapeHtml(item.unlocked ? item.icon : '◇')}</span><div class="progress-copy"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description)}</small></div><span class="progress-reward">${item.unlocked ? '✓' : '+' + item.reward}</span></div>`).join('') || '<div class="chat-system">Aún no hay logros.</div>';
    els.dailyBonusStatus.textContent = profile.dailyBonusClaimed ? 'Bono de hoy recibido · vuelve mañana.' : 'Se entrega una vez al día al entrar.';
  }
  els.profileCard.addEventListener('click', openProfileModal);
  els.profileCard.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProfileModal(); } });
  $$('[data-close-profile]').forEach(element => element.addEventListener('click', closeProfileModal));
  els.profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const name = els.profileNameInput.value.trim();
    const response = await emitAck('profile_update', { name, avatar: ui.profileAvatar }, button);
    if (!response.ok) return showToast('No se guardó el perfil', response.error, 'error');
    if (response.profile && ui.room) ui.room.viewerProfile = response.profile;
    ui.playerName = response.profile?.name || name;
    ui.selectedAvatar = response.profile?.avatar || ui.profileAvatar;
    localStorage.setItem('montecristo-name', ui.playerName);
    localStorage.setItem('montecristo-avatar', ui.selectedAvatar);
    showToast('Perfil actualizado', 'Tu nombre y avatar ya están visibles en la mesa.', 'notice', 3600, avatarEmoji(ui.selectedAvatar));
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
    if (notifyServer && ui.room) await emitAck('leave_room');
    clearInterval(ui.clockTimer); clearSession(); ui.room = null; ui.me = null; ui.activeCode = null;
    ui.rouletteSpin = null; ui.rouletteAngle = 0; ui.slotsSpin = null;
    ui.lastGameSignature = ''; ui.lastChatSignature = ''; ui.previousRanks = new Map(); ui.previousChips = new Map(); ui.lastMeChips = null;
    els.roomApp.classList.add('exiting');
    setTimeout(() => {
      els.roomApp.classList.add('hidden'); els.roomApp.classList.remove('exiting'); els.landing.classList.remove('hidden');
      updateHistory(''); window.scrollTo(0, 0);
    }, 280);
  }

  els.soundToggle.addEventListener('click', () => {
    ui.sound = !ui.sound; localStorage.setItem('montecristo-sound', ui.sound ? 'on' : 'off'); updateSoundButton(); if (ui.sound) playTone('notice');
  });
  function updateSoundButton() { els.soundToggle.classList.toggle('off', !ui.sound); els.soundToggle.textContent = ui.sound ? '♪' : '×'; els.soundToggle.title = ui.sound ? 'Desactivar sonido' : 'Activar sonido'; }
  window.addEventListener('popstate', () => { if (!getRouteCode() && ui.room) leaveToLobby(true); });
})();
