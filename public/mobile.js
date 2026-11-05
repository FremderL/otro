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

    // Mostrar el drawer (está oculto con hidden por defecto)
    drawer.removeAttribute('hidden');
    if (backdrop) backdrop.removeAttribute('hidden');

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

    // Mostrar los controles móviles
    toggle.removeAttribute('hidden');
    if (chatToggle) chatToggle.removeAttribute('hidden');
    if (chatSheet) chatSheet.removeAttribute('hidden');
    if (chatBackdrop) chatBackdrop.removeAttribute('hidden');
    if (backdrop) backdrop.removeAttribute('hidden');

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
     9. ESTADIO — SISTEMA DE TABS PARA COLUMNAS
     Muestra una columna a la vez en móvil según el tab seleccionado.
     ------------------------------------------------------------------------- */
  function initEstadioTabs() {
    var tabsBar = document.getElementById('est-mobile-tabs');
    if (!tabsBar) return;

    var tabs = tabsBar.querySelectorAll('.est-mobile-tab');
    var colLeft = document.querySelector('.est-col-left');
    var colCenter = document.querySelector('.est-col-center');
    var colRight = document.querySelector('.est-col-right');

    if (!colLeft || !colCenter || !colRight) return;

    // Mostrar tabs
    tabsBar.removeAttribute('hidden');

    // Marcar columna por defecto (center = Partido)
    function activateTab(tabName) {
      // Quitar activas
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.remove('is-active');
        tabs[i].setAttribute('aria-pressed', 'false');
      }
      colLeft.classList.remove('is-mobile-active');
      colCenter.classList.remove('is-mobile-active');
      colRight.classList.remove('is-mobile-active');

      // Activar la columna correspondiente
      if (tabName === 'left') {
        colLeft.classList.add('is-mobile-active');
      } else if (tabName === 'right') {
        colRight.classList.add('is-mobile-active');
      } else {
        colCenter.classList.add('is-mobile-active');
      }

      // Activar el tab
      for (var j = 0; j < tabs.length; j++) {
        if (tabs[j].getAttribute('data-est-tab') === tabName) {
          tabs[j].classList.add('is-active');
          tabs[j].setAttribute('aria-pressed', 'true');
        }
      }

      // Scroll al inicio del contenido
      window.scrollTo({ top: tabsBar.offsetTop + tabsBar.offsetHeight, behavior: 'smooth' });
    }

    // Inicializar con la columna central activa
    activateTab('center');

    // Listeners
    for (var k = 0; k < tabs.length; k++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          var tabName = tab.getAttribute('data-est-tab');
          activateTab(tabName);
        });
      })(tabs[k]);
    }

    // Auto-cambiar al tab "Partido" cuando se selecciona un partido
    // Observamos el click en .est-match-item para volver al tab de partido
    document.addEventListener('click', function (event) {
      if (!MonteCristoMobile.isMobile()) return;
      var matchItem = event.target.closest('.est-match-item');
      if (matchItem && !colCenter.classList.contains('is-mobile-active')) {
        setTimeout(function () { activateTab('center'); }, 100);
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
