/* =============================================================================
   MonteCristo — Scripts Móviles
   Utilidades para drawers, bottom sheets, gestos táctiles y detección de dispositivo.
   Se carga solo en viewport <= 900 px (ver media query en el HTML).
   ============================================================================= */

(function () {
  'use strict';

  /* -------------------------------------------------------------------------
     0. DETECCIÓN DE DISPOSITIVO
     ------------------------------------------------------------------------- */
  var MonteCristoMobile = window.MonteCristoMobile = {};

  /** ¿Estamos en un viewport móvil? (se evalúa en cada llamada por si rota) */
  MonteCristoMobile.isMobile = function isMobile() {
    return window.innerWidth <= 900;
  };

  /** ¿Es un dispositivo táctil? (no excluye laptops con pantalla táctil) */
  MonteCristoMobile.isTouch = function isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  };

  /** ¿Es iPhone con notch / Dynamic Island? (safe-area soportado) */
  MonteCristoMobile.hasSafeArea = function hasSafeArea() {
    try {
      return window.CSS && window.CSS.supports && window.CSS.supports('padding-top: env(safe-area-inset-top)');
    } catch (e) {
      return false;
    }
  };

  /* -------------------------------------------------------------------------
     0b. COMPONENTES QUE SOLO EXISTEN EN LA VISTA MÓVIL
     `mobile.css` se carga solo con (max-width: 900px). Estos nodos viven en el
     HTML y este archivo les quita `hidden` al inicializarse; si eso pasa en
     escritorio aparecen sin estilo sobre la vista de computadora. Por eso se
     registran aquí y se encienden/apagan según el viewport.
     ------------------------------------------------------------------------- */
  var mobileOnlyNodes = [];

  function registerMobileOnly(node) {
    if (node && mobileOnlyNodes.indexOf(node) < 0) mobileOnlyNodes.push(node);
    return node;
  }

  function syncMobileOnlyVisibility() {
    var mobile = MonteCristoMobile.isMobile();
    for (var i = 0; i < mobileOnlyNodes.length; i++) {
      var node = mobileOnlyNodes[i];
      if (mobile) {
        node.removeAttribute('hidden');
      } else {
        // En escritorio se apagan y se cierran por si quedaron abiertos.
        node.classList.remove('is-open');
        node.setAttribute('hidden', '');
      }
    }
    if (!mobile) document.body.style.overflow = '';
  }

  /* -------------------------------------------------------------------------
     1. CLASE EN <html> PARA SELECTORES CSS
     ------------------------------------------------------------------------- */
  function applyMobileClass() {
    var html = document.documentElement;
    if (MonteCristoMobile.isMobile()) {
      html.classList.add('is-mobile');
      html.classList.remove('is-desktop');
    } else {
      html.classList.remove('is-mobile');
      html.classList.add('is-desktop');
    }
  }
  applyMobileClass();
  window.addEventListener('resize', applyMobileClass);
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', applyMobileClass);
  }

  /* -------------------------------------------------------------------------
     2. DRAWER LATERAL
     API: MonteCristoMobile.openDrawer(id) / .closeDrawer(id) / .toggleDrawer(id)
     El HTML debe tener:
       <div class="mobile-drawer-backdrop" data-drawer-backdrop="id"></div>
       <aside class="mobile-drawer mobile-drawer--left" id="id">...</aside>
     ------------------------------------------------------------------------- */
  function getDrawer(id) {
    var drawer = document.getElementById(id);
    var backdrop = drawer ? document.querySelector('[data-drawer-backdrop="' + id + '"]') : null;
    return { drawer: drawer, backdrop: backdrop };
  }

  MonteCristoMobile.openDrawer = function openDrawer(id) {
    var ref = getDrawer(id);
    if (!ref.drawer) return;
    ref.drawer.classList.add('is-open');
    if (ref.backdrop) ref.backdrop.classList.add('is-open');
    document.body.classList.add('mobile-drawer-open');
    // Enfocar el primer elemento interactivo dentro del drawer
    var focusable = ref.drawer.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
  };

  MonteCristoMobile.closeDrawer = function closeDrawer(id) {
    var ref = getDrawer(id);
    if (!ref.drawer) return;
    ref.drawer.classList.remove('is-open');
    if (ref.backdrop) ref.backdrop.classList.remove('is-open');
    document.body.classList.remove('mobile-drawer-open');
  };

  MonteCristoMobile.toggleDrawer = function toggleDrawer(id) {
    var ref = getDrawer(id);
    if (ref.drawer && ref.drawer.classList.contains('is-open')) {
      MonteCristoMobile.closeDrawer(id);
    } else {
      MonteCristoMobile.openDrawer(id);
    }
  };

  /* -------------------------------------------------------------------------
     3. BOTTOM SHEET
     API: MonteCristoMobile.openSheet(id) / .closeSheet(id) / .toggleSheet(id)
     El HTML debe tener:
       <div class="mobile-sheet-backdrop" data-sheet-backdrop="id"></div>
       <div class="mobile-sheet" id="id">
         <div class="mobile-sheet-handle"></div>
         ...
       </div>
     ------------------------------------------------------------------------- */
  function getSheet(id) {
    var sheet = document.getElementById(id);
    var backdrop = sheet ? document.querySelector('[data-sheet-backdrop="' + id + '"]') : null;
    return { sheet: sheet, backdrop: backdrop };
  }

  MonteCristoMobile.openSheet = function openSheet(id) {
    var ref = getSheet(id);
    if (!ref.sheet) return;
    ref.sheet.classList.add('is-open');
    if (ref.backdrop) ref.backdrop.classList.add('is-open');
    document.body.classList.add('mobile-sheet-open');
    var focusable = ref.sheet.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
  };

  MonteCristoMobile.closeSheet = function closeSheet(id) {
    var ref = getSheet(id);
    if (!ref.sheet) return;
    ref.sheet.classList.remove('is-open');
    if (ref.backdrop) ref.backdrop.classList.remove('is-open');
    document.body.classList.remove('mobile-sheet-open');
  };

  MonteCristoMobile.toggleSheet = function toggleSheet(id) {
    var ref = getSheet(id);
    if (ref.sheet && ref.sheet.classList.contains('is-open')) {
      MonteCristoMobile.closeSheet(id);
    } else {
      MonteCristoMobile.openSheet(id);
    }
  };

  /* -------------------------------------------------------------------------
     4. GESTO SWIPE-DOWN PARA CERRAR BOTTOM SHEETS
     Se engancha automáticamente a todos los .mobile-sheet con data-sheet-drag.
     ------------------------------------------------------------------------- */
  function initSheetDrag(sheet) {
    var handle = sheet.querySelector('.mobile-sheet-handle');
    var target = handle || sheet;
    var startY = 0;
    var currentY = 0;
    var dragging = false;
    var threshold = 80; // px para cerrar

    function onStart(e) {
      if (!MonteCristoMobile.isMobile()) return;
      // Solo desde el handle o los primeros 40px del sheet
      var touch = e.touches ? e.touches[0] : e;
      var rect = sheet.getBoundingClientRect();
      if (handle || touch.clientY - rect.top < 40) {
        dragging = true;
        startY = touch.clientY;
        sheet.style.transition = 'none';
      }
    }

    function onMove(e) {
      if (!dragging) return;
      var touch = e.touches ? e.touches[0] : e;
      currentY = touch.clientY - startY;
      if (currentY < 0) currentY = 0; // no subir más arriba
      sheet.style.transform = 'translateY(' + currentY + 'px)';
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      if (currentY > threshold) {
        MonteCristoMobile.closeSheet(sheet.id);
      } else {
        sheet.style.transform = '';
      }
      currentY = 0;
    }

    target.addEventListener('touchstart', onStart, { passive: true });
    target.addEventListener('touchmove', onMove, { passive: true });
    target.addEventListener('touchend', onEnd);
    target.addEventListener('touchcancel', onEnd);
  }

  function initAllSheetDrags() {
    var sheets = document.querySelectorAll('.mobile-sheet[data-sheet-drag]');
    for (var i = 0; i < sheets.length; i++) {
      initSheetDrag(sheets[i]);
    }
  }

  /* -------------------------------------------------------------------------
     5. EVENTOS GLOBALES
     Cerrar drawers/sheets al tocar el backdrop o presionar Escape.
     ------------------------------------------------------------------------- */
  document.addEventListener('click', function (event) {
    // Backdrop de drawer
    var drawerBackdrop = event.target.closest('[data-drawer-backdrop]');
    if (drawerBackdrop) {
      MonteCristoMobile.closeDrawer(drawerBackdrop.getAttribute('data-drawer-backdrop'));
      return;
    }
    // Backdrop de sheet
    var sheetBackdrop = event.target.closest('[data-sheet-backdrop]');
    if (sheetBackdrop) {
      MonteCristoMobile.closeSheet(sheetBackdrop.getAttribute('data-sheet-backdrop'));
      return;
    }
    // Botón de cerrar genérico dentro de drawer/sheet
    var closeBtn = event.target.closest('.mobile-drawer-close, .mobile-sheet-close');
    if (closeBtn) {
      var drawer = closeBtn.closest('.mobile-drawer');
      var sheet = closeBtn.closest('.mobile-sheet');
      if (drawer && drawer.id) MonteCristoMobile.closeDrawer(drawer.id);
      else if (sheet && sheet.id) MonteCristoMobile.closeSheet(sheet.id);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    // Cerrar el drawer/sheet más alto
    var openDrawers = document.querySelectorAll('.mobile-drawer.is-open');
    var openSheets = document.querySelectorAll('.mobile-sheet.is-open');
    if (openSheets.length > 0) {
      var last = openSheets[openSheets.length - 1];
      if (last.id) MonteCristoMobile.closeSheet(last.id);
    } else if (openDrawers.length > 0) {
      var lastD = openDrawers[openDrawers.length - 1];
      if (lastD.id) MonteCristoMobile.closeDrawer(lastD.id);
    }
  });

  /* -------------------------------------------------------------------------
     6. TECLADO VIRTUAL — Ajustar bottom sheets cuando aparece el teclado
     Usa la Visual Viewport API cuando está disponible.
     ------------------------------------------------------------------------- */
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      var currentHeight = window.visualViewport.height;
      var keyboardHeight = window.innerHeight - currentHeight;

      // Ajustar bottom sheets abiertos
      var openSheets = document.querySelectorAll('.mobile-sheet.is-open');
      for (var i = 0; i < openSheets.length; i++) {
        if (keyboardHeight > 100) {
          // Teclado visible: reducir altura del sheet
          openSheets[i].style.maxHeight = (currentHeight * 0.85) + 'px';
        } else {
          openSheets[i].style.maxHeight = '';
        }
      }
    });
  }

  /* -------------------------------------------------------------------------
     7. DRAWER DE NAVEGACIÓN DEL LOBBY
     Conecta el botón hamburguesa con el drawer, delega clicks a botones
     originales y sincroniza el enlace del Estadio.
     ------------------------------------------------------------------------- */
  function initNavDrawer() {
    var drawer = document.getElementById('mobile-nav-drawer');
    var backdrop = document.getElementById('mobile-nav-backdrop');
    var toggle = document.getElementById('mobile-nav-toggle');
    var closeBtn = document.getElementById('mobile-nav-close');
    if (!drawer || !toggle) return;

    // El drawer solo se enciende en móvil (ver syncMobileOnlyVisibility).
    registerMobileOnly(drawer);
    registerMobileOnly(backdrop);

    function openNav() {
      drawer.classList.add('is-open');
      if (backdrop) backdrop.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
    }

    function closeNav() {
      drawer.classList.remove('is-open');
      if (backdrop) backdrop.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }

    toggle.addEventListener('click', function () {
      if (drawer.classList.contains('is-open')) closeNav();
      else openNav();
    });

    if (closeBtn) closeBtn.addEventListener('click', closeNav);
    if (backdrop) backdrop.addEventListener('click', closeNav);

    // Cerrar al hacer clic en un link del drawer
    var links = drawer.querySelectorAll('[data-mobile-nav-link]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function () {
        closeNav();
      });
    }

    // Cerrar al hacer clic en botones con data-mobile-nav-close
    var closeTriggers = drawer.querySelectorAll('[data-mobile-nav-close]');
    for (var j = 0; j < closeTriggers.length; j++) {
      closeTriggers[j].addEventListener('click', function () {
        closeNav();
      });
    }

    // Delegar clicks de botones del drawer a los botones originales del nav
    var delegationMap = {
      'mobile-community-btn': 'community-open-btn',
      'mobile-notifications-btn': 'notifications-toggle',
      'mobile-report-btn': 'report-open-btn',
      'mobile-account-btn': 'account-open-btn'
    };

    Object.keys(delegationMap).forEach(function (mobileId) {
      var mobileBtn = document.getElementById(mobileId);
      var originalBtn = document.getElementById(delegationMap[mobileId]);
      if (mobileBtn && originalBtn) {
        mobileBtn.addEventListener('click', function () {
          closeNav();
          // Esperar a que la animación del drawer termine antes de abrir modal
          setTimeout(function () { originalBtn.click(); }, 200);
        });
      }
    });

    // Cerrar con Escape
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && drawer.classList.contains('is-open')) {
        closeNav();
      }
    });

    // Sincronizar visibilidad del enlace del Estadio
    var navEstadio = document.getElementById('nav-estadio');
    var mobileEstadio = document.getElementById('mobile-nav-estadio');
    if (navEstadio && mobileEstadio) {
      var syncEstadio = function () {
        if (navEstadio.hidden) mobileEstadio.setAttribute('hidden', '');
        else mobileEstadio.removeAttribute('hidden');
      };
      syncEstadio();
      if (typeof MutationObserver !== 'undefined') {
        var observer = new MutationObserver(syncEstadio);
        observer.observe(navEstadio, { attributes: true, attributeFilter: ['hidden'] });
      }
    }
  }

  /* -------------------------------------------------------------------------
     8. MESA DE JUEGO — SIDEBAR DRAWER Y CHAT BOTTOM SHEET
     ------------------------------------------------------------------------- */
  function initRoomMobile() {
    var roomApp = document.getElementById('room-app');
    if (!roomApp) return;

    var sidebar = roomApp.querySelector('.sidebar');
    var toggle = document.getElementById('mobile-room-toggle');
    var backdrop = document.getElementById('mobile-room-backdrop');
    var chatToggle = document.getElementById('mobile-chat-toggle');
    var chatSheet = document.getElementById('mobile-chat-sheet');
    var chatBackdrop = document.getElementById('mobile-chat-backdrop');
    var chatClose = document.getElementById('mobile-chat-close');
    var chatForm = document.getElementById('mobile-chat-form');
    var chatInput = document.getElementById('mobile-chat-input');
    var chatMessages = document.getElementById('mobile-chat-messages');
    var chatRoomName = document.getElementById('mobile-chat-room-name');

    if (!sidebar || !toggle || !backdrop) return;

    // Los controles solo se encienden en móvil (ver syncMobileOnlyVisibility).
    registerMobileOnly(toggle);
    registerMobileOnly(backdrop);
    registerMobileOnly(chatToggle);
    registerMobileOnly(chatSheet);
    registerMobileOnly(chatBackdrop);

    // --- SIDEBAR DRAWER ---
    function openSidebar() {
      sidebar.classList.add('is-open');
      backdrop.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
    }

    function closeSidebar() {
      sidebar.classList.remove('is-open');
      backdrop.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', function () {
      if (sidebar.classList.contains('is-open')) closeSidebar();
      else openSidebar();
    });

    backdrop.addEventListener('click', closeSidebar);

    // Cerrar sidebar al hacer click en leave-room
    var leaveBtn = sidebar.querySelector('#leave-room');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', function () {
        closeSidebar();
      });
    }

    // --- CHAT BOTTOM SHEET ---
    function openChat() {
      if (!chatSheet) return;
      chatSheet.classList.add('is-open');
      if (chatBackdrop) chatBackdrop.classList.add('is-open');
      if (chatInput) chatInput.focus();
    }

    function closeChat() {
      if (!chatSheet) return;
      chatSheet.classList.remove('is-open');
      if (chatBackdrop) chatBackdrop.classList.remove('is-open');
    }

    if (chatToggle) chatToggle.addEventListener('click', openChat);
    if (chatClose) chatClose.addEventListener('click', closeChat);
    if (chatBackdrop) chatBackdrop.addEventListener('click', closeChat);

    // Sincronizar nombre de la sala
    var roomTitle = document.getElementById('room-title');
    if (roomTitle && chatRoomName) {
      var syncRoomName = function () {
        chatRoomName.textContent = roomTitle.textContent || 'Mesa';
      };
      syncRoomName();
      if (typeof MutationObserver !== 'undefined') {
        var titleObs = new MutationObserver(syncRoomName);
        titleObs.observe(roomTitle, { childList: true, characterData: true, subtree: true });
      }
    }

    // --- DELEGACIÓN DE MENSAJES DEL CHAT ---
    // Cuando el chat original (sidebar .chat-list) recibe mensajes,
    // los clonamos al chat móvil.
    var originalChatList = sidebar.querySelector('#chat-list');
    var originalChatForm = sidebar.querySelector('#chat-form');
    var originalChatInput = sidebar.querySelector('#chat-input');
    var unreadBadge = document.getElementById('mobile-chat-unread');
    var unreadCount = 0;

    function syncMessages() {
      if (!originalChatList || !chatMessages) return;
      chatMessages.innerHTML = originalChatList.innerHTML;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    if (originalChatList && typeof MutationObserver !== 'undefined') {
      var chatObs = new MutationObserver(function () {
        syncMessages();
        // Incrementar no-leídos si el chat móvil está cerrado
        if (chatSheet && !chatSheet.classList.contains('is-open')) {
          unreadCount++;
          if (unreadBadge) {
            unreadBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            unreadBadge.removeAttribute('hidden');
          }
        }
      });
      chatObs.observe(originalChatList, { childList: true, subtree: true });
    }

    // Resetear no-leídos al abrir
    if (chatToggle) {
      chatToggle.addEventListener('click', function () {
        unreadCount = 0;
        if (unreadBadge) unreadBadge.setAttribute('hidden', '');
      });
    }

    // Delegar envío de mensajes: el form móvil dispara el form original
    if (chatForm && originalChatForm && originalChatInput) {
      chatForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = chatInput.value.trim();
        if (!text) return;
        originalChatInput.value = text;
        originalChatForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        chatInput.value = '';
        chatInput.focus();
      });
    }

    // Reacciones rápidas
    var reactionBtns = document.querySelectorAll('[data-mobile-reaction]');
    var originalReactions = sidebar.querySelectorAll('[data-reaction]');
    for (var i = 0; i < reactionBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var emoji = btn.getAttribute('data-mobile-reaction');
          for (var j = 0; j < originalReactions.length; j++) {
            if (originalReactions[j].getAttribute('data-reaction') === emoji) {
              originalReactions[j].click();
              break;
            }
          }
        });
      })(reactionBtns[i]);
    }

    // Escape cierra todo
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (chatSheet && chatSheet.classList.contains('is-open')) closeChat();
      else if (sidebar.classList.contains('is-open')) closeSidebar();
    });
  }

  /* -------------------------------------------------------------------------
     9. ESTADIO — BOTTOM NAV Y BARRA DE PARTIDOS
     Bottom nav reemplaza los tabs. Los partidos se clonan como carrusel
     horizontal dentro de la columna central.
     ------------------------------------------------------------------------- */
  /**
   * Paneles del Estadio trasladados a las vistas móviles (Tabla y Apuestas).
   * Vive fuera de initEstadioTabs para que una segunda llamada —o un cambio de
   * viewport— no pierda la columna original de cada panel.
   */
  var estadioSpaceHomes = [];

  function initEstadioTabs() {
    var bottomNav = document.getElementById('est-bottom-nav');
    var oldTabsBar = document.getElementById('est-mobile-tabs');
    if (!bottomNav) return;
    // Una sola inicialización: evita listeners y traslados duplicados.
    if (bottomNav.dataset.estMobileReady === '1') return;
    bottomNav.dataset.estMobileReady = '1';

    var navBtns = bottomNav.querySelectorAll('.est-bottom-nav-btn[data-est-tab], .est-bottom-nav-btn[data-est-space]');
    var hubBtn = document.getElementById('est-bottom-nav-hub');
    var colLeft = document.querySelector('.est-col-left');
    var colCenter = document.querySelector('.est-col-center');
    var colRight = document.querySelector('.est-col-right');
    // Carrusel de partidos: solo móvil, igual que la barra inferior.
    var matchBar = document.getElementById('est-mobile-match-bar');
    var matchScroll = document.getElementById('est-mobile-match-scroll');

    if (!colLeft || !colCenter || !colRight) return;

    // Mostrar bottom nav y ocultar tabs antiguos
    bottomNav.removeAttribute('hidden');
    if (oldTabsBar) oldTabsBar.setAttribute('hidden', '');

    /* -----------------------------------------------------------------------
       Columnas: en móvil solo la central se recorre. Tabla y Apuestas ya no
       son columnas apiladas: cada una abre su propia vista (más abajo).
       --------------------------------------------------------------------- */
    function clearNavActive() {
      for (var i = 0; i < navBtns.length; i++) {
        navBtns[i].classList.remove('is-active');
        navBtns[i].setAttribute('aria-pressed', 'false');
      }
      if (hubBtn) {
        hubBtn.classList.remove('is-active');
        hubBtn.setAttribute('aria-pressed', 'false');
      }
    }

    function markNavActive(name) {
      for (var i = 0; i < navBtns.length; i++) {
        var btnName = navBtns[i].getAttribute('data-est-space') || navBtns[i].getAttribute('data-est-tab');
        if (btnName !== name) continue;
        navBtns[i].classList.add('is-active');
        navBtns[i].setAttribute('aria-pressed', 'true');
      }
    }

    // Marca «Partido» como vista activa sin mover el scroll.
    function markCenterColumn() {
      clearNavActive();
      colLeft.classList.remove('is-mobile-active');
      colCenter.classList.add('is-mobile-active');
      colRight.classList.remove('is-mobile-active');
      markNavActive('center');
    }

    function activateTab() {
      markCenterColumn();
      // Scroll al inicio del contenido
      var scrollTarget = bottomNav.offsetTop - 48;
      if (window.scrollY > scrollTarget) {
        window.scrollTo({ top: scrollTarget, behavior: 'smooth' });
      }
    }

    /* -----------------------------------------------------------------------
       Espacios propios (Tabla y Apuestas) — igual que la Zona de afición.
       Los paneles reales del Estadio se trasladan a la vista móvil y vuelven
       a su columna al pasar a escritorio: mismos ids, mismos listeners.
       --------------------------------------------------------------------- */
    var spaceMounts = [
      { panel: 'est-lobby-panel', slot: 'est-mobile-table-body' },
      { panel: 'est-standings-panel', slot: 'est-mobile-table-body' },
      { panel: 'est-bet-panel', slot: 'est-mobile-bets-slot' },
      { panel: 'est-mybets-panel', slot: 'est-mobile-mybets-slot' }
    ];
    var homes = estadioSpaceHomes;

    function findHome(panel) {
      for (var i = 0; i < homes.length; i++) if (homes[i].panel === panel) return homes[i];
      return null;
    }

    function mountSpaces() {
      for (var i = 0; i < spaceMounts.length; i++) {
        var panel = document.getElementById(spaceMounts[i].panel);
        var slot = document.getElementById(spaceMounts[i].slot);
        if (!panel || !slot) continue;
        var home = findHome(panel);
        if (!home) {
          home = { panel: panel, parent: panel.parentNode, next: panel.nextSibling };
          homes.push(home);
        }
        if (panel.parentNode !== slot) slot.appendChild(panel);
      }
    }

    function releaseSpaces() {
      while (homes.length) {
        var home = homes.pop();
        if (!home.parent) continue;
        if (!home.parent.isConnected) continue;
        home.parent.insertBefore(home.panel, home.next && home.next.parentNode === home.parent ? home.next : null);
      }
    }

    var spaces = {};
    function registerSpace(name, ids) {
      var root = document.getElementById(ids.root);
      if (!root) return;
      var close = document.getElementById(ids.close);
      var space = {
        root: root,
        close: close,
        button: bottomNav.querySelector('[data-est-space="' + name + '"]')
      };
      spaces[name] = space;
      if (close) close.addEventListener('click', function () { closeSpace(name); });
    }

    var openSpaceName = null;

    function openSpace(name) {
      var space = spaces[name];
      if (!space || !MonteCristoMobile.isMobile()) return;
      if (openSpaceName && openSpaceName !== name) {
        var previous = spaces[openSpaceName];
        if (previous) previous.root.hidden = true;
      }
      mountSpaces();
      space.root.hidden = false;
      openSpaceName = name;
      document.body.classList.add('est-mobile-space-open');
      clearNavActive();
      markNavActive(name);
      space.root.scrollTop = 0;
      if (name === 'bets') { setBetsView('apostar'); syncMatchPicker(); }
      if (space.close) space.close.focus();
    }

    function closeSpace(name) {
      var space = spaces[name];
      if (!space) return;
      space.root.hidden = true;
      if (openSpaceName === name) openSpaceName = null;
      document.body.classList.remove('est-mobile-space-open');
      // Al cerrar se vuelve a «Partido» sin perder el punto de lectura.
      markCenterColumn();
      if (space.button) space.button.focus();
    }

    function closeOpenSpace() {
      if (openSpaceName) closeSpace(openSpaceName);
    }

    function syncSpaces() {
      if (MonteCristoMobile.isMobile()) {
        bottomNav.removeAttribute('hidden');
        if (matchBar) matchBar.removeAttribute('hidden');
        mountSpaces();
      } else {
        closeOpenSpace();
        releaseSpaces();
        // La barra inferior y el carrusel solo existen en móvil (mobile.css).
        bottomNav.setAttribute('hidden', '');
        if (matchBar) matchBar.setAttribute('hidden', '');
      }
    }

    registerSpace('table', { root: 'est-mobile-table', close: 'est-mobile-table-close' });
    registerSpace('bets', { root: 'est-mobile-bets', close: 'est-mobile-bets-close' });

    // Capas que se dibujan por encima de las vistas (historial, Zona, noticiero,
    // Balón de Oro): mientras una esté abierta, el teclado es suyo.
    var higherOverlays = ['est-ledger', 'est-hub', 'est-daily-news', 'est-bdo-ceremony', 'est-bdo-opening'];
    function higherOverlayOpen() {
      for (var i = 0; i < higherOverlays.length; i++) {
        var node = document.getElementById(higherOverlays[i]);
        if (node && !node.hidden) return true;
      }
      return false;
    }

    /* Escape cierra el espacio abierto y Tab queda dentro de la vista. */
    document.addEventListener('keydown', function (event) {
      if (!openSpaceName) return;
      var space = spaces[openSpaceName];
      if (!space || higherOverlayOpen()) return;
      if (event.key === 'Escape') { event.preventDefault(); closeOpenSpace(); return; }
      if (event.key !== 'Tab') return;
      var nodes = space.root.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
      var list = Array.prototype.filter.call(nodes, function (node) { return !node.closest('[hidden]'); });
      if (!list.length) { event.preventDefault(); space.root.focus(); return; }
      var first = list[0];
      var last = list[list.length - 1];
      if (list.indexOf(document.activeElement) < 0) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    /* --- Apuestas: dos sub-vistas (Apostar / Mis apuestas) ----------------- */
    var betsRoot = spaces.bets ? spaces.bets.root : null;

    function setBetsView(view) {
      if (!betsRoot) return;
      Array.prototype.forEach.call(betsRoot.querySelectorAll('[data-mobile-bets-view]'), function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-mobile-bets-view') === view));
      });
      Array.prototype.forEach.call(betsRoot.querySelectorAll('[data-mobile-bets-panel]'), function (panel) {
        panel.hidden = panel.getAttribute('data-mobile-bets-panel') !== view;
      });
      betsRoot.scrollTop = 0;
    }

    if (betsRoot) {
      Array.prototype.forEach.call(betsRoot.querySelectorAll('[data-mobile-bets-view]'), function (button) {
        button.addEventListener('click', function () {
          setBetsView(button.getAttribute('data-mobile-bets-view'));
        });
      });
    }

    // Contador de apuestas abiertas en el acceso «Mis apuestas».
    var myBetsCount = document.getElementById('est-mybets-count');
    var mobileBetsCount = document.getElementById('est-mobile-bets-count');
    if (myBetsCount && mobileBetsCount && typeof MutationObserver !== 'undefined') {
      var syncMyBetsCount = function () {
        var text = (myBetsCount.textContent || '').trim();
        if (myBetsCount.hidden || !text) {
          mobileBetsCount.setAttribute('hidden', '');
        } else {
          mobileBetsCount.textContent = text;
          mobileBetsCount.removeAttribute('hidden');
        }
      };
      syncMyBetsCount();
      new MutationObserver(syncMyBetsCount).observe(myBetsCount, { attributes: true, characterData: true, childList: true, subtree: true });
    }

    /* --- Apuestas: selector del partido a apostar ------------------------- */
    var matchList = document.getElementById('est-match-list');
    var pickerList = document.getElementById('est-mobile-match-picker-list');
    var pickerNote = document.getElementById('est-mobile-match-picker-note');

    function pickerCopy(item) {
      var teams = item.querySelector('.est-match-teams');
      var meta = item.querySelector('.est-match-meta');
      var score = item.querySelector('.est-match-score');
      var status = item.querySelector('.est-match-status');
      var detail = [];
      if (meta && meta.textContent.trim()) detail.push(meta.textContent.trim());
      if (score && score.textContent.trim()) detail.push(score.textContent.trim());
      if (status && status.textContent.trim()) detail.push(status.textContent.trim());
      return {
        teams: teams ? teams.textContent.trim() : item.textContent.trim(),
        detail: detail.join(' · ')
      };
    }

    function pickerSignature(items) {
      var parts = [];
      for (var i = 0; i < items.length; i++) {
        var copy = pickerCopy(items[i]);
        parts.push(items[i].dataset.matchId + '|' + copy.teams + '|' + copy.detail);
      }
      return parts.join('~');
    }

    function pickNewMatch(item) {
      if (!item) return;
      item.click();
      if (pickerNote && item.querySelector('.est-match-teams')) {
        pickerNote.textContent = 'Apostando en ' + item.querySelector('.est-match-teams').textContent.trim() + '.';
      }
      var betPanel = document.getElementById('est-bet-panel');
      if (betPanel && betPanel.scrollIntoView) betPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function buildPicker(items) {
      var focusedIndex = -1;
      var buttons = pickerList.querySelectorAll('.est-mobile-pick-match');
      for (var b = 0; b < buttons.length; b++) {
        if (buttons[b] === document.activeElement) focusedIndex = b;
      }
      pickerList.innerHTML = '';
      if (!items.length) {
        var empty = document.createElement('p');
        empty.className = 'est-mobile-pick-empty';
        empty.textContent = 'No hay partidos programados hoy.';
        pickerList.appendChild(empty);
        return;
      }
      for (var i = 0; i < items.length; i++) {
        (function (item, index) {
          var copy = pickerCopy(item);
          var selected = item.classList.contains('active');
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'est-mobile-pick-match' + (selected ? ' is-selected' : '');
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', selected ? 'true' : 'false');
          button.setAttribute('data-match-id', item.dataset.matchId || '');
          if (selected) button.setAttribute('aria-current', 'true');

          var teams = document.createElement('span');
          teams.className = 'est-mobile-pick-teams';
          teams.textContent = copy.teams;

          var detail = document.createElement('span');
          detail.className = 'est-mobile-pick-meta';
          detail.textContent = copy.detail;

          button.appendChild(teams);
          button.appendChild(detail);
          button.addEventListener('click', function () { pickNewMatch(item); });
          pickerList.appendChild(button);
          if (index === focusedIndex) button.focus();
        })(items[i], i);
      }
    }

    function syncMatchPicker() {
      if (!matchList || !pickerList) return;
      var items = matchList.querySelectorAll('.est-match-item');
      var signature = pickerSignature(items);
      if (pickerList.dataset.signature !== signature) {
        pickerList.dataset.signature = signature;
        buildPicker(items);
      }
      var buttons = pickerList.querySelectorAll('.est-mobile-pick-match');
      var selectedLabel = '';
      for (var i = 0; i < items.length && i < buttons.length; i++) {
        var selected = items[i].classList.contains('active');
        if (selected) {
          buttons[i].classList.add('is-selected');
          buttons[i].setAttribute('aria-selected', 'true');
          if (items[i].querySelector('.est-match-teams')) selectedLabel = items[i].querySelector('.est-match-teams').textContent.trim();
        } else {
          buttons[i].classList.remove('is-selected');
          buttons[i].setAttribute('aria-selected', 'false');
        }
      }
      if (pickerNote) {
        pickerNote.textContent = selectedLabel
          ? 'Apostando en ' + selectedLabel + '.'
          : 'Toca un partido para ver sus cuotas.';
      }
    }

    if (matchList && pickerList && typeof MutationObserver !== 'undefined') {
      syncMatchPicker();
      new MutationObserver(syncMatchPicker).observe(matchList, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    // Al abrir la boleta (tras tocar una cuota) se lleva a la vista: en la
    // vista de Apuestas el boleto vive debajo de los mercados.
    var slip = document.getElementById('est-bet-slip');
    if (slip && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () {
        if (slip.hidden || !MonteCristoMobile.isMobile() || !openSpaceName) return;
        if (slip.scrollIntoView) slip.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }).observe(slip, { attributes: true, attributeFilter: ['hidden'] });
    }

    /* -----------------------------------------------------------------------
       Inicialización y listeners
       --------------------------------------------------------------------- */
    activateTab();
    syncSpaces();

    for (var k = 0; k < navBtns.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var spaceName = btn.getAttribute('data-est-space');
          if (spaceName) { openSpace(spaceName); return; }
          activateTab();
        });
      })(navBtns[k]);
    }

    // Botón Zona → abrir el Hub
    if (hubBtn) {
      hubBtn.addEventListener('click', function () {
        var hubOpenBtn = document.getElementById('est-hub-open');
        if (hubOpenBtn) hubOpenBtn.click();
      });
    }

    // Volver a escritorio: devolver los paneles a su columna.
    var spaceSyncTimer = 0;
    window.addEventListener('resize', function () {
      if (spaceSyncTimer) clearTimeout(spaceSyncTimer);
      spaceSyncTimer = setTimeout(syncSpaces, 150);
    });

    // Sincronizar badge de apuestas
    var navBadge = document.getElementById('est-nav-badge');
    var bottomBadge = document.getElementById('est-bottom-nav-bet-badge');
    if (navBadge && bottomBadge && typeof MutationObserver !== 'undefined') {
      var syncBadge = function () {
        if (navBadge.hidden) {
          bottomBadge.setAttribute('hidden', '');
        } else {
          bottomBadge.textContent = navBadge.textContent;
          bottomBadge.removeAttribute('hidden');
        }
      };
      syncBadge();
      var badgeObs = new MutationObserver(syncBadge);
      badgeObs.observe(navBadge, { attributes: true, characterData: true, subtree: true });
    }

    // --- BARRA DE PARTIDOS MÓVIL ---
    if (matchBar && matchScroll && matchList) {
      if (MonteCristoMobile.isMobile()) matchBar.removeAttribute('hidden');

      function syncMatches() {
        var items = matchList.querySelectorAll('.est-match-item');
        matchScroll.innerHTML = '';
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var mobileItem = document.createElement('div');
          mobileItem.className = 'est-mobile-match-item';
          if (item.classList.contains('is-selected') || item.classList.contains('active')) {
            mobileItem.classList.add('is-selected');
          }
          mobileItem.setAttribute('role', 'option');

          // Extraer datos del item original (equipos, marcador y estado)
          var copy = pickerCopy(item);
          var statusEl = item.querySelector('.est-match-status');
          var isLive = item.classList.contains('live');

          if (isLive) {
            var liveDot = document.createElement('span');
            liveDot.className = 'match-live-dot';
            mobileItem.appendChild(liveDot);
          }
          var teamsSpan = document.createElement('span');
          teamsSpan.className = 'match-teams';
          teamsSpan.textContent = copy.teams;
          mobileItem.appendChild(teamsSpan);
          if (statusEl && statusEl.textContent.trim()) {
            var statusSpan = document.createElement('span');
            statusSpan.className = 'match-time';
            statusSpan.textContent = statusEl.textContent.trim();
            mobileItem.appendChild(statusSpan);
          }

          // Click delega al item original
          (function (originalItem) {
            mobileItem.addEventListener('click', function () {
              originalItem.click();
              // Marcar como seleccionado
              var allItems = matchScroll.querySelectorAll('.est-mobile-match-item');
              for (var j = 0; j < allItems.length; j++) {
                allItems[j].classList.remove('is-selected');
              }
              mobileItem.classList.add('is-selected');
              // Asegurar que estamos en el tab de partido
              if (!colCenter.classList.contains('is-mobile-active')) {
                activateTab();
              }
            });
          })(item);

          matchScroll.appendChild(mobileItem);
        }

        // Scroll al item seleccionado
        var selected = matchScroll.querySelector('.is-selected');
        if (selected) {
          selected.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
      }

      syncMatches();
      if (typeof MutationObserver !== 'undefined') {
        var matchObs = new MutationObserver(syncMatches);
        matchObs.observe(matchList, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      }
    }

    // Auto-cambiar al tab Partido cuando se selecciona un partido
    document.addEventListener('click', function (event) {
      if (!MonteCristoMobile.isMobile()) return;
      if (openSpaceName) return;
      var matchItem = event.target.closest('.est-match-item');
      if (matchItem && !colCenter.classList.contains('is-mobile-active')) {
        setTimeout(activateTab, 100);
      }
    });
  }

  /* -------------------------------------------------------------------------
     10. GESTO SWIPE-TO-DISMISS PARA TOASTS
     Los toasts del sistema se pueden descartar deslizando horizontalmente.
     ------------------------------------------------------------------------- */
  function initToastSwipeDismiss() {
    var stack = document.getElementById('toast-stack');
    if (!stack) return;

    function attachSwipe(toast) {
      if (toast._swipeAttached) return;
      toast._swipeAttached = true;

      var startX = 0;
      var currentX = 0;
      var dragging = false;
      var threshold = 80;

      toast.addEventListener('touchstart', function (e) {
        var touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        dragging = true;
        toast.style.transition = 'none';
      }, { passive: true });

      toast.addEventListener('touchmove', function (e) {
        if (!dragging) return;
        var touch = e.touches ? e.touches[0] : e;
        currentX = touch.clientX - startX;
        toast.style.transform = 'translateX(' + currentX + 'px)';
        toast.style.opacity = String(Math.max(0, 1 - Math.abs(currentX) / 200));
      }, { passive: true });

      toast.addEventListener('touchend', function () {
        if (!dragging) return;
        dragging = false;
        toast.style.transition = '';
        if (Math.abs(currentX) > threshold) {
          // Dismiss
          toast.style.transform = 'translateX(' + (currentX > 0 ? 400 : -400) + 'px)';
          toast.style.opacity = '0';
          setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
          }, 250);
        } else {
          toast.style.transform = '';
          toast.style.opacity = '';
        }
        currentX = 0;
      });
    }

    // Observar toasts nuevos
    if (typeof MutationObserver !== 'undefined') {
      var observer = new MutationObserver(function () {
        var toasts = stack.querySelectorAll('.toast');
        for (var i = 0; i < toasts.length; i++) {
          attachSwipe(toasts[i]);
        }
      });
      observer.observe(stack, { childList: true, subtree: true });
    }

    // Adjuntar a toasts existentes
    var existing = stack.querySelectorAll('.toast');
    for (var i = 0; i < existing.length; i++) {
      attachSwipe(existing[i]);
    }
  }

  /* -------------------------------------------------------------------------
     11. LONG-PRESS EN ASIENTOS PARA VER FICHA DEL JUGADOR
     En escritorio se abre con click; en móvil con long-press (600ms).
     ------------------------------------------------------------------------- */
  function initSeatLongPress() {
    var pressTimer = null;
    var longPressDuration = 600;
    var moved = false;

    document.addEventListener('touchstart', function (e) {
      var seat = e.target.closest('.table-seat, .player-row, .quick-bet-seat');
      if (!seat) return;
      moved = false;
      pressTimer = setTimeout(function () {
        if (!moved) {
          // Simular click en el avatar o el seat-head para abrir la ficha
          var clickable = seat.querySelector('.seat-head, .player-avatar, .seat-avatar');
          if (clickable) clickable.click();
          else seat.click();
        }
      }, longPressDuration);
    }, { passive: true });

    document.addEventListener('touchmove', function () {
      moved = true;
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    }, { passive: true });

    document.addEventListener('touchend', function () {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });

    document.addEventListener('touchcancel', function () {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });
  }

  /* -------------------------------------------------------------------------
     12. INVITE INBOX — SWIPE TO DISMISS
     Las invitaciones flotantes se pueden descartar con swipe lateral.
     ------------------------------------------------------------------------- */
  function initInviteSwipeDismiss() {
    var inbox = document.getElementById('invite-inbox');
    if (!inbox) return;

    if (typeof MutationObserver !== 'undefined') {
      var observer = new MutationObserver(function () {
        var cards = inbox.querySelectorAll('.invite-card, .invite-toast');
        for (var i = 0; i < cards.length; i++) {
          if (cards[i]._swipeAttached) continue;
          cards[i]._swipeAttached = true;
          (function (card) {
            var startX = 0;
            var currentX = 0;
            var dragging = false;
            card.addEventListener('touchstart', function (e) {
              startX = e.touches[0].clientX;
              dragging = true;
              card.style.transition = 'none';
            }, { passive: true });
            card.addEventListener('touchmove', function (e) {
              if (!dragging) return;
              currentX = e.touches[0].clientX - startX;
              card.style.transform = 'translateX(' + currentX + 'px)';
              card.style.opacity = String(Math.max(0, 1 - Math.abs(currentX) / 200));
            }, { passive: true });
            card.addEventListener('touchend', function () {
              if (!dragging) return;
              dragging = false;
              card.style.transition = '';
              if (Math.abs(currentX) > 80) {
                card.style.transform = 'translateX(' + (currentX > 0 ? 400 : -400) + 'px)';
                card.style.opacity = '0';
                setTimeout(function () {
                  if (card.parentNode) card.parentNode.removeChild(card);
                }, 250);
              } else {
                card.style.transform = '';
                card.style.opacity = '';
              }
              currentX = 0;
            });
          })(cards[i]);
        }
      });
      observer.observe(inbox, { childList: true, subtree: true });
    }
  }

  /* -------------------------------------------------------------------------
     13. INICIALIZACIÓN
     ------------------------------------------------------------------------- */
  function init() {
    initAllSheetDrags();
    applyMobileClass();
    initNavDrawer();
    initRoomMobile();
    initEstadioTabs();
    initToastSwipeDismiss();
    initSeatLongPress();
    initInviteSwipeDismiss();
    // Nada de interfaz móvil en la vista de computadora.
    syncMobileOnlyVisibility();
    var mobileOnlyTimer = 0;
    window.addEventListener('resize', function () {
      if (mobileOnlyTimer) clearTimeout(mobileOnlyTimer);
      mobileOnlyTimer = setTimeout(syncMobileOnlyVisibility, 150);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-inicializar cuando el DOM cambia (para sheets/drawers dinámicos)
  if (typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        for (var j = 0; j < mutations[i].addedNodes.length; j++) {
          var node = mutations[i].addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains('mobile-sheet') && node.hasAttribute('data-sheet-drag')) {
            initSheetDrag(node);
          }
          var innerSheets = node.querySelectorAll ? node.querySelectorAll('.mobile-sheet[data-sheet-drag]') : [];
          for (var k = 0; k < innerSheets.length; k++) {
            initSheetDrag(innerSheets[k]);
          }
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  /* -------------------------------------------------------------------------
     8. PREVENIR ZOOM EN DOUBLE-TAP (sin afectar accesibilidad)
     Solo en inputs y elementos del juego, no en texto.
     ------------------------------------------------------------------------- */
  var lastTouchEnd = 0;
  document.addEventListener('touchend', function (event) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300) {
      // Solo prevenir en elementos de juego, no en inputs
      var target = event.target;
      if (target && !target.closest('input, textarea, select, .chat-form input')) {
        event.preventDefault();
      }
    }
    lastTouchEnd = now;
  }, { passive: false });

})();
