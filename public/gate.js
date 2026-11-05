// Puerta de escritorio: pantallas menores a 1024 px. Se carga en <head> (sincrónico)
// para aplicar la preferencia antes del primer pintado. Sin scripts inline (CSP).
//
// Fase 0 móvil: si el viewport es <= 900 px, se aplica automáticamente gate-bypass
// para que la experiencia móvil tome el control (mobile.css desactiva la puerta).
// En escritorio con ventana estrecha se conserva el comportamiento histórico:
// se muestra la puerta a menos que el usuario pulse «Entrar de todos modos».
(function () {
  try {
    var stored = localStorage.getItem('montecristo-gate-bypass') === '1';
    var isMobile = window.innerWidth <= 900;
    if (stored || isMobile) {
      document.documentElement.classList.add('gate-bypass');
    }
    // Marcar móvil para CSS y JS posteriores (antes del primer pintado)
    if (isMobile) {
      document.documentElement.classList.add('is-mobile');
    } else {
      document.documentElement.classList.add('is-desktop');
    }
  } catch (e) { /* almacenamiento bloqueado: la puerta sigue visible */ }
  document.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest && event.target.closest('.gate-bypass-btn');
    if (!btn) return;
    document.documentElement.classList.add('gate-bypass');
    try { localStorage.setItem('montecristo-gate-bypass', '1'); } catch (e) { /* solo esta sesión */ }
  });
})();
