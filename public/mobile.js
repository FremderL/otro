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
     8. INICIALIZACIÓN
     ------------------------------------------------------------------------- */
  function init() {
    initAllSheetDrags();
    applyMobileClass();
    initNavDrawer();
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
