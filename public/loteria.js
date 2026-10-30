// Lotería mexicana MonteCristo — cliente de la sala común.
// El servidor es la única autoridad: aquí solo se dibuja el estado que llega
// por Socket.IO y se envían las dos acciones posibles (entrar y salir).
// Sin scripts ni manejadores inline (CSP: script-src 'self').
(function () {
  'use strict';

  var TOS_KEY = 'montecristo-tos';
  var NAME_KEY = 'montecristo-name';
  var AVATAR_KEY = 'montecristo-avatar';
  var TOS_FALLBACK = '2026-09-28';
  var AVATAR_EMOJI = { fox: '🦊', tiger: '🐯', panda: '🐼', owl: '🦉', alien: '👽', robot: '🤖', crown: '👑', diamond: '💎' };
  var REFRESH_MS = 250;

  var els = {
    connection: document.getElementById('loteria-connection'),
    balance: document.getElementById('loteria-balance'),
    phase: document.getElementById('loteria-phase'),
    clock: document.getElementById('loteria-clock'),
    pot: document.getElementById('loteria-pot'),
    carry: document.getElementById('loteria-carry'),
    entry: document.getElementById('loteria-entry'),
    count: document.getElementById('loteria-count'),
    calledProgress: document.getElementById('loteria-called-progress'),
    join: document.getElementById('loteria-join'),
    leave: document.getElementById('loteria-leave'),
    help: document.getElementById('loteria-help'),
    invite: document.getElementById('loteria-invite'),
    identity: document.getElementById('loteria-identity'),
    name: document.getElementById('loteria-name'),
    avatar: document.getElementById('loteria-avatar'),
    tos: document.getElementById('loteria-tos'),
    identitySave: document.getElementById('loteria-identity-save'),
    identityCancel: document.getElementById('loteria-identity-cancel'),
    boardTitle: document.getElementById('loteria-board-title'),
    boardProgress: document.getElementById('loteria-board-progress'),
    board: document.getElementById('loteria-board'),
    called: document.getElementById('loteria-called'),
    calledCount: document.getElementById('loteria-called-count'),
    players: document.getElementById('loteria-players'),
    playersCount: document.getElementById('loteria-players-count'),
    result: document.getElementById('loteria-result'),
    toast: document.getElementById('loteria-toast')
  };

  var state = {
    cards: new Map(),
    snapshot: null,
    view: null,
    you: null,
    tosVersion: TOS_FALLBACK,
    skew: 0,
    connected: false,
    busy: false,
    lastCallCount: 0,
    freshNumber: null,
    freshUntil: 0,
    resultKey: null,
    helpText: '',
    helpWarn: false
  };

  var socket = null;
  var toastTimer = null;
  var clockTimer = null;

  function deviceToken() {
    try {
      var saved = localStorage.getItem('montecristo-device');
      if (saved) return saved;
      var created = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem('montecristo-device', created);
      return created;
    } catch (error) {
      return Date.now() + '-' + Math.random().toString(36).slice(2);
    }
  }

  function stored(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (error) { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* almacenamiento bloqueado */ }
  }

  var token = deviceToken();

  function serverNow() { return Date.now() + state.skew; }

  function formatChips(value) {
    var amount = Math.max(0, Math.floor(Number(value) || 0));
    return amount.toLocaleString('es-MX');
  }

  function formatClock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes > 0 ? minutes + ':' + String(seconds).padStart(2, '0') : '0:' + String(seconds).padStart(2, '0');
  }

  function setConnection(mode, label) {
    state.connected = mode === 'connected';
    els.connection.className = 'connection-badge ' + mode;
    els.connection.innerHTML = '<i></i><span>' + label + '</span>';
  }

  function help(message, warn) {
    state.helpText = message || '';
    state.helpWarn = Boolean(warn);
    els.help.textContent = state.helpText;
    els.help.classList.toggle('is-warn', state.helpWarn);
  }

  function toast(message) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 6000);
  }

  function cardInfo(number) {
    return state.cards.get(Number(number)) || { number: Number(number), name: 'Carta ' + number, emoji: '🃏' };
  }

  // ---------- Render ----------
  function render() {
    var view = state.view;
    var you = state.you;
    var snapshot = state.snapshot;

    els.balance.textContent = you
      ? '◆ ' + formatChips(you.chips) + ' fichas'
      : '◆ — fichas';
    els.entry.textContent = formatChips(snapshot ? snapshot.entryCost : 50);
    els.count.textContent = formatChips(view ? view.count : 0);
    els.pot.textContent = formatChips(view ? view.pot : 0);
    els.carry.textContent = 'Acumulado previo: ' + formatChips(view ? view.carry : 0);
    els.calledProgress.textContent = (view ? view.called.length : 0) + '/' + (snapshot ? snapshot.cardCount : 54);

    renderPhase(view);
    renderBoard(view);
    renderCalled(view);
    renderPlayers(view);
    renderResult(view);
    renderActions(view, snapshot);
    renderClock();
  }

  function renderPhase(view) {
    var label = 'Preparando la ronda';
    var modifier = '';
    if (!state.snapshot || state.snapshot.enabled === false) {
      label = 'Lotería no disponible';
      modifier = 'is-off';
    } else if (!view) {
      label = 'Conectando con la sala';
    } else if (view.status === 'registration') {
      label = view.joined ? 'Estás dentro · inscripción abierta' : 'Inscripción abierta';
      modifier = 'is-live';
    } else if (view.status === 'calling') {
      label = 'Cantando cartas';
      modifier = 'is-live';
    } else if (view.status === 'settled') {
      label = 'Ronda resuelta';
      modifier = 'is-done';
    } else if (view.status === 'cancelled') {
      label = 'Ronda cancelada';
      modifier = 'is-off';
    }
    els.phase.className = 'loteria-phase' + (modifier ? ' ' + modifier : '');
    els.phase.textContent = label;
  }

  function boardNumbers() {
    if (state.you && Array.isArray(state.you.board)) return state.you.board;
    if (state.view && Array.isArray(state.view.board)) return state.view.board;
    return null;
  }

  function renderBoard(view) {
    var numbers = boardNumbers();
    var called = new Set(view ? view.called : []);
    var isFresh = state.freshNumber && Date.now() < state.freshUntil;
    els.board.textContent = '';
    els.board.setAttribute('aria-rowcount', '4');
    els.board.setAttribute('aria-colcount', '4');

    if (!numbers) {
      els.boardTitle.textContent = view && view.status === 'calling' ? 'No entraste a esta ronda' : 'Sin cartón en esta ronda';
      els.boardProgress.textContent = '0/16';
      for (var placeholder = 0; placeholder < 16; placeholder++) {
        var empty = document.createElement('div');
        empty.className = 'loteria-cell is-empty';
        empty.setAttribute('role', 'gridcell');
        empty.innerHTML = '<span class="loteria-cell-emoji">🃏</span><span class="loteria-cell-name">—</span><span class="loteria-cell-number">LIBRE</span>';
        els.board.appendChild(empty);
      }
      return;
    }

    var marked = 0;
    numbers.forEach(function (number, index) {
      var card = cardInfo(number);
      var isCalled = called.has(Number(number));
      if (isCalled) marked++;
      var cell = document.createElement('div');
      cell.className = 'loteria-cell' + (isCalled ? ' is-called' : '') + (isFresh && Number(number) === state.freshNumber ? ' is-fresh' : '');
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', card.name + ', carta ' + card.number + (isCalled ? ', cantada' : ', pendiente'));
      cell.setAttribute('aria-rowindex', String(Math.floor(index / 4) + 1));
      cell.setAttribute('aria-colindex', String((index % 4) + 1));
      var emoji = document.createElement('span');
      emoji.className = 'loteria-cell-emoji';
      emoji.textContent = isCalled ? card.emoji : '🂠';
      var name = document.createElement('span');
      name.className = 'loteria-cell-name';
      name.textContent = card.name;
      var label = document.createElement('span');
      label.className = 'loteria-cell-number';
      label.textContent = isCalled ? 'N.º ' + card.number : 'PENDIENTE';
      cell.append(emoji, name, label);
      els.board.appendChild(cell);
    });

    var won = view && view.status === 'settled' && view.result && view.result.won;
    if (won) {
      Array.prototype.forEach.call(els.board.children, function (child) { child.classList.add('is-win'); });
    }
    els.boardTitle.textContent = won ? '¡Cartón completo!' : (view && view.status === 'calling' ? 'Tu cartón en juego' : 'Tu cartón');
    els.boardProgress.textContent = marked + '/16';
  }

  function renderCalled(view) {
    var called = view ? view.called : [];
    els.calledCount.textContent = String(called.length);
    els.called.textContent = '';
    if (!called.length) {
      var empty = document.createElement('p');
      empty.className = 'loteria-called-empty';
      empty.textContent = view && view.status === 'registration'
        ? 'El canto empieza cuando cierre la inscripción.'
        : 'Todavía no se ha cantado ninguna carta.';
      els.called.appendChild(empty);
      return;
    }
    var board = new Set(boardNumbers() || []);
    called.slice(-12).reverse().forEach(function (number, index) {
      var card = cardInfo(number);
      var item = document.createElement('div');
      item.className = 'loteria-called-item';
      var emoji = document.createElement('span');
      emoji.className = 'loteria-called-emoji';
      emoji.textContent = card.emoji;
      var name = document.createElement('span');
      name.className = 'loteria-called-name';
      name.textContent = card.name;
      var meta = document.createElement('span');
      meta.className = 'loteria-called-number';
      meta.textContent = index === 0 && board.has(Number(number)) ? 'EN TU CARTÓN' : 'N.º ' + card.number;
      if (index === 0 && board.has(Number(number))) meta.className = 'loteria-called-on';
      item.append(emoji, name, meta);
      els.called.appendChild(item);
    });
  }

  function renderPlayers(view) {
    var players = view ? view.players : [];
    els.playersCount.textContent = String(players.length);
    els.players.textContent = '';
    if (!players.length) {
      var empty = document.createElement('li');
      empty.className = 'loteria-players-empty';
      empty.textContent = 'Nadie ha entrado todavía. Sé la primera persona en esta ronda.';
      els.players.appendChild(empty);
      return;
    }
    var mine = state.you && state.you.joined ? state.you.name : null;
    players.slice(0, 20).forEach(function (player) {
      var item = document.createElement('li');
      if (mine && player.name === mine) item.className = 'is-you';
      var avatar = document.createElement('span');
      avatar.className = 'loteria-player-avatar';
      avatar.textContent = AVATAR_EMOJI[player.avatar] || '🦊';
      var name = document.createElement('span');
      name.textContent = player.name + (mine && player.name === mine ? ' · tú' : '');
      item.append(avatar, name);
      els.players.appendChild(item);
    });
    if (players.length > 20) {
      var rest = document.createElement('li');
      rest.className = 'loteria-players-empty';
      rest.textContent = '+' + (players.length - 20) + ' cartones más';
      els.players.appendChild(rest);
    }
  }

  function renderActions(view, snapshot) {
    var open = Boolean(view && view.status === 'registration');
    var joined = Boolean(state.you && state.you.joined);
    var full = Boolean(view && view.count >= (snapshot ? snapshot.maxPlayers : 100));
    var disabledRoom = !state.snapshot || state.snapshot.enabled === false;

    els.join.hidden = joined && open;
    els.leave.hidden = !(joined && open);
    els.join.disabled = state.busy || !state.connected || disabledRoom || joined || !open || full;
    els.leave.disabled = state.busy || !state.connected;

    if (state.busy) els.join.textContent = 'Confirmando…';
    else if (joined) els.join.textContent = 'Tu cartón sigue en juego';
    else if (full) els.join.textContent = 'Ronda llena';
    else els.join.textContent = 'Entrar por ' + formatChips(snapshot ? snapshot.entryCost : 50) + ' fichas →';

    if (state.helpText) return;
    if (disabledRoom) help('La Lotería no está disponible en este momento.', true);
    else if (!state.connected) help('Sin conexión con la sala. Reintentando…', true);
    else if (joined && open) help('Estás inscrito. Puedes salir antes del cierre y recuperar tu entrada.');
    else if (joined) help('Tu cartón sigue jugando hasta el final de la ronda.');
    else if (open) {
      var minimum = snapshot ? snapshot.minPlayers : 2;
      help(view.count < minimum
        ? 'Inscripción abierta (' + formatClock(view.closesAt - serverNow()) + '). Se necesitan al menos ' + minimum + ' cartones: comparte el enlace para que alguien más entre.'
        : 'Inscripción abierta: quedan ' + formatClock(view.closesAt - serverNow()) + '.');
    }
    else if (view && view.status === 'calling') help('La ronda ya empezó. Espera la siguiente para entrar.');
    else help('La siguiente ronda abre en unos segundos.');
  }

  function renderClock() {
    var view = state.view;
    if (!view) { els.clock.textContent = '—'; return; }
    var snapshot = state.snapshot || {};
    if (view.status === 'registration') {
      els.clock.textContent = 'Cierra en ' + formatClock(view.closesAt - serverNow());
      return;
    }
    if (view.status === 'calling') {
      var interval = Number(snapshot.callIntervalMs) || 2000;
      var next = view.closesAt + interval * (view.called.length + 1);
      els.clock.textContent = 'Siguiente carta en ' + formatClock(next - serverNow());
      return;
    }
    if (snapshot.nextOpensAt) {
      els.clock.textContent = 'Nueva ronda en ' + formatClock(snapshot.nextOpensAt - serverNow());
      return;
    }
    els.clock.textContent = 'Nueva ronda en breve';
  }

  function renderResult(view) {
    if (!view || (view.status !== 'settled' && view.status !== 'cancelled')) {
      els.result.hidden = true;
      els.result.textContent = '';
      state.resultKey = null;
      return;
    }
    var key = view.id + ':' + view.status;
    var changed = key !== state.resultKey;
    state.resultKey = key;
    els.result.hidden = false;
    els.result.textContent = '';
    els.result.className = 'loteria-result';

    var title = document.createElement('h2');
    title.id = 'loteria-result-title';
    var body = document.createElement('p');
    var meta = document.createElement('div');
    meta.className = 'loteria-result-meta';

    if (view.status === 'cancelled') {
      els.result.classList.add('is-cancelled');
      title.textContent = 'Ronda cancelada';
      body.textContent = 'No hubo dos cartones al cierre, así que las entradas se devolvieron y el acumulado de ' + formatChips(view.result ? view.result.carry : 0) + ' fichas sigue guardado para la siguiente ronda.';
      meta.append(chip('Acumulado', formatChips(view.result ? view.result.carry : 0)));
    } else {
      var result = view.result || {};
      var winners = Array.isArray(result.winners) ? result.winners : [];
      var iWon = Boolean(result.won);
      els.result.classList.add(iWon ? 'is-win' : 'is-loss');
      title.textContent = iWon ? '¡Completaste tu cartón!' : 'La ronda tiene ganador';
      if (iWon) {
        body.textContent = 'Ganaste ' + formatChips(result.myPayout) + ' fichas. El premio ya está en tu saldo.';
      } else if (winners.length) {
        body.textContent = winners.length === 1
          ? winners[0].name + ' completó el cartón y se lleva ' + formatChips(winners[0].amount) + ' fichas.'
          : winners.length + ' cartones se completaron a la vez y se repartieron el bote.';
      } else {
        body.textContent = 'La ronda terminó sin un cartón completo.';
      }
      var list = document.createElement('ul');
      list.className = 'loteria-result-winners';
      winners.forEach(function (winner) {
        var item = document.createElement('li');
        item.textContent = '🏆 ' + winner.name + ' · ◆ ' + formatChips(winner.amount);
        list.appendChild(item);
      });
      if (winners.length) els.result.appendChild(list);
      meta.append(
        chip('Bote', formatChips(result.pot)),
        chip('Ganadores', String(result.winnerCount || winners.length)),
        chip('Premio por cartón', formatChips(result.payoutPerWinner)),
        chip('Acumulado siguiente', formatChips(result.carry))
      );
    }

    els.result.append(title, body, meta);
    if (changed && view.status === 'settled' && view.result && view.result.won) {
      toast('🏆 ¡Ganaste ' + formatChips(view.result.myPayout) + ' fichas en la Lotería!');
    }
  }

  function chip(label, value) {
    var span = document.createElement('span');
    span.textContent = label + ': ' + value;
    return span;
  }

  // ---------- Acciones ----------
  function showIdentity(open) {
    els.identity.hidden = !open;
    if (open) {
      els.name.value = stored(NAME_KEY, '');
      els.avatar.value = stored(AVATAR_KEY, 'fox');
      els.tos.checked = stored(TOS_KEY, '') === state.tosVersion;
      els.name.focus();
    }
  }

  function submitJoin(name, avatar) {
    if (state.busy) return;
    state.busy = true;
    help('Confirmando tu entrada…');
    renderActions(state.view, state.snapshot);
    socket.emit('loteria_join', { name: name, avatar: avatar, tos: state.tosVersion }, function (response) {
      state.busy = false;
      if (!response || !response.ok) {
        help((response && response.error) || 'No pudimos inscribirte. Inténtalo de nuevo.', true);
        renderActions(state.view, state.snapshot);
        return;
      }
      if (response.state) applySnapshot(response.state);
      if (response.you) applyYou(response.you);
      showIdentity(false);
      state.helpText = '';
      help('Estás dentro de la ronda. Tu cartón está listo.');
      render();
    });
  }

  function requestJoin() {
    var name = stored(NAME_KEY, '').trim();
    var accepted = stored(TOS_KEY, '') === state.tosVersion;
    if (!name || !accepted) {
      showIdentity(true);
      help('Confirma tu apodo y la aceptación de los Términos para entrar.', true);
      return;
    }
    submitJoin(name, stored(AVATAR_KEY, 'fox'));
  }

  function requestLeave() {
    if (state.busy) return;
    state.busy = true;
    help('Cancelando tu entrada…');
    renderActions(state.view, state.snapshot);
    socket.emit('loteria_leave', {}, function (response) {
      state.busy = false;
      if (!response || !response.ok) {
        help((response && response.error) || 'No pudimos cancelar tu entrada.', true);
        renderActions(state.view, state.snapshot);
        return;
      }
      if (response.state) applySnapshot(response.state);
      if (response.you) applyYou(response.you);
      help(response.refunded ? 'Saliste a tiempo: tus 50 fichas volvieron a tu saldo.' : 'Saliste de la ronda.');
      render();
    });
  }

  function applySnapshot(snapshot) {
    state.snapshot = snapshot || null;
    state.view = snapshot && snapshot.game ? snapshot.game : null;
    if (snapshot && Number.isFinite(Number(snapshot.serverNow))) {
      state.skew = Number(snapshot.serverNow) - Date.now();
    }
    var called = state.view ? state.view.called : [];
    if (called.length > state.lastCallCount) {
      // La carta recién cantada se resalta un segundo; el anuncio accesible ya
      // lo hace la lista de cantadas (aria-live), sin avisos flotantes de más.
      state.freshNumber = called[called.length - 1];
      state.freshUntil = Date.now() + 1000;
    }
    state.lastCallCount = called.length;
  }

  function applyYou(you) {
    state.you = you || null;
    if (you && you.name) {
      // El perfil del servidor manda: si había otro nombre guardado, se alinea.
      store(NAME_KEY, you.name);
      if (you.avatar) store(AVATAR_KEY, you.avatar);
    }
  }

  // ---------- Socket ----------
  function subscribe() {
    socket.emit('loteria_subscribe', {}, function (response) {
      if (!response || !response.ok) {
        help((response && response.error) || 'No pudimos entrar a la sala de Lotería.', true);
        return;
      }
      if (Array.isArray(response.cards)) {
        state.cards = new Map(response.cards.map(function (card) { return [Number(card.number), card]; }));
      }
      if (response.tosVersion) state.tosVersion = String(response.tosVersion);
      if (response.state) applySnapshot(response.state);
      applyYou(response.you || null);
      if (state.snapshot && state.snapshot.enabled === false) {
        help('La Lotería no está disponible en este momento.', true);
      }
      render();
    });
  }

  function connect() {
    socket = window.io({ auth: { deviceToken: token } });

    socket.on('connect', function () {
      setConnection('connected', 'Conectado');
      state.helpText = '';
      subscribe();
    });
    socket.on('disconnect', function () {
      setConnection('disconnected', 'Reconectando');
      help('Se perdió la conexión con la sala. Reintentando…', true);
      renderActions(state.view, state.snapshot);
    });
    socket.on('connect_error', function () {
      setConnection('disconnected', 'Sin conexión');
      help('No pudimos conectar con la sala. Reintentando…', true);
    });

    socket.on('loteria_state', function (snapshot) {
      applySnapshot(snapshot);
      render();
    });
    socket.on('loteria_you', function (you) {
      applyYou(you);
      render();
    });
    socket.on('profile_event', function (payload) {
      applyYou(payload && payload.profile ? {
        name: payload.profile.name,
        avatar: payload.profile.avatar,
        chips: payload.profile.chips,
        joined: state.you ? state.you.joined : false,
        board: state.you ? state.you.board : null
      } : state.you);
      (payload && payload.events ? payload.events : []).forEach(function (event) {
        if (event.type === 'achievement' || event.type === 'challenge' || event.type === 'passport_unlock') {
          toast((event.icon || '✨') + ' ' + (event.name || 'Nuevo logro') + (event.reward ? ' · +' + formatChips(event.reward) + ' fichas' : ''));
        }
      });
      render();
    });
  }

  // ---------- Eventos de interfaz ----------
  els.join.addEventListener('click', requestJoin);
  els.invite.addEventListener('click', function () {
    var url = String(window.location.href || '').split('#')[0];
    function fallback() { toast('Comparte este enlace: ' + url); }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(url).then(function () {
        toast('Enlace copiado. Compártelo para jugar acompañado.');
      }, fallback);
      return;
    }
    fallback();
  });
  els.leave.addEventListener('click', requestLeave);
  els.identityCancel.addEventListener('click', function () { showIdentity(false); help(''); });
  els.identity.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = String(els.name.value || '').replace(/[<>]/g, '').trim().slice(0, 18);
    if (!name) {
      help('Escribe un apodo para entrar.', true);
      els.name.focus();
      return;
    }
    if (!els.tos.checked) {
      help('Debes aceptar los Términos y Condiciones para jugar.', true);
      els.tos.focus();
      return;
    }
    store(NAME_KEY, name);
    store(AVATAR_KEY, els.avatar.value || 'fox');
    store(TOS_KEY, state.tosVersion);
    submitJoin(name, els.avatar.value || 'fox');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !els.identity.hidden && !state.busy) {
      showIdentity(false);
      help('');
    }
  });

  window.addEventListener('beforeunload', function () {
    if (socket) socket.disconnect();
  });

  // Primera pintura con placeholders: evita un salto de diseño antes del socket.
  function boot() {
    render();
    clockTimer = setInterval(function () { renderClock(); }, REFRESH_MS);
    // Refresca la animación de la última carta cantada sin repintar todo.
    setInterval(function () {
      if (state.freshNumber && Date.now() >= state.freshUntil) {
        state.freshNumber = null;
        renderBoard(state.view);
      }
    }, 1000);
    connect();
  }

  boot();
  window.addEventListener('pagehide', function () { if (clockTimer) clearInterval(clockTimer); });
})();
