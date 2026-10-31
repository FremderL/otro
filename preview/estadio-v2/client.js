'use strict';
/* global window, document, localStorage */

// Este script solo lo sirve el proxy de la demo; no se carga en producción.
(() => {
  // Perfil ficticio y aceptación local exclusivos del origen de la demo. No se
  // toca una cuenta, sesión ni aceptación del sitio de producción.
  try { localStorage.setItem('montecristo-tos', window.__stadiumPreviewTos); } catch (_) { /* sin almacenamiento */ }

  function bootPreview() {
    // En móviles se prioriza la cancha del Estadio; la lista y los mercados
    // siguen disponibles debajo. No se altera el diseño del sitio productivo.
    const style = document.createElement('style');
    style.textContent = '.est-lab-launch{display:none!important}' +
      '@media(max-width:960px){.estadio-shell>.est-col-center{grid-row:1}.estadio-shell>.est-col-left{grid-row:2}.estadio-shell>.est-col-right{grid-row:3}}' +
      '@media(max-width:680px){.estadio-nav-right{min-width:0;width:100%;justify-content:flex-start;overflow-x:auto}.estadio-nav-right>*{flex-shrink:0}}';
    document.head.appendChild(style);
    const banner = document.createElement('div');
    banner.setAttribute('role', 'note');
    banner.id = 'stadium-preview-notice';
    banner.style.cssText = 'padding:10px 16px;text-align:center;background:#16352a;color:#e1f7e8;font:600 13px/1.4 system-ui,sans-serif;border-bottom:1px solid #37614a';
    banner.textContent = 'VISTA DE PRUEBA · Motor ' + window.__stadiumPreviewVersion +
      ' · Partidos, perfiles y fichas ficticios; sin conexión a producción.';
    const nav = document.querySelector('.estadio-nav');
    if (nav) nav.insertAdjacentElement('afterend', banner);

    // Al abrir se selecciona un partido en juego. Tras una elección manual no
    // se vuelve a intervenir: se mantiene la navegación normal del Estadio.
    let attempts = 0;
    const timer = window.setInterval(() => {
      const connection = document.getElementById('est-connection');
      if (document.querySelector('.est-match-item.active')) { window.clearInterval(timer); return; }
      if (connection && connection.classList.contains('connected')) {
        const match = document.querySelector('.est-match-item.live');
        if (match) { match.click(); attempts++; }
      }
      if (attempts > 20) window.clearInterval(timer);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPreview, { once: true });
  else bootPreview();
})();
