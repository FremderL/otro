// Puerta de escritorio: pantallas menores a 1024 px. Se carga en <head> (sincrónico)
// para aplicar la preferencia antes del primer pintado. Sin scripts inline (CSP).
(function () {
  try {
    if (localStorage.getItem('montecristo-gate-bypass') === '1') document.documentElement.classList.add('gate-bypass');
  } catch (e) { /* almacenamiento bloqueado: la puerta sigue visible */ }
  document.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest && event.target.closest('.gate-bypass-btn');
    if (!btn) return;
    document.documentElement.classList.add('gate-bypass');
    try { localStorage.setItem('montecristo-gate-bypass', '1'); } catch (e) { /* solo esta sesión */ }
  });
})();
