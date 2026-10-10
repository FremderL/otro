// Banner del Estadio en la portada: revela el acceso solo si la sección está activa.
// Archivo externo (sin inline) para cumplir la Content-Security-Policy.
(function () {
  var LIVE = { live: 1, halftime: 1, extra_time: 1, shootout: 1 };
  function el(id) { return document.getElementById(id); }
  function txt(id, v) { var e = el(id); if (e && v != null) e.textContent = v; }
  function show(id, on) { var e = el(id); if (e) e.hidden = !on; }
  function fmtCountdown(ms) {
    if (ms == null || !(ms >= 0)) return null;
    var min = Math.floor(ms / 60000), h = Math.floor(min / 60), m = min % 60;
    if (h > 0) return 'Empieza en ' + h + ' h' + (m > 0 ? ' ' + m + ' min' : '');
    if (m > 0) return 'Empieza en ' + m + ' min';
    return 'Empieza en breve';
  }
  try {
    fetch('/api/estadio/state').then(function (r) { return r && r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.ok) return;
      show('nav-estadio', true);
      show('estadio-access', true);
      var lobby = j.lobby || {}, teams = j.teams || {}, matches = lobby.matches || [];
      function name(id) { return (teams[id] && teams[id].name) || id; }
      var liveList = matches.filter(function (m) { return LIVE[m.status]; });
      var jor = (liveList[0] || matches[0] || {}).jornada;
      if (jor) txt('est-banner-jornada', 'Jornada ' + jor);
      txt('est-banner-live-count', String(liveList.length));
      show('est-banner-live', liveList.length > 0);
      if (matches.length) { txt('est-banner-today', matches.length + ' partidos hoy'); show('est-banner-today', true); }
      var feat = liveList[0] || matches.filter(function (m) { return m.id === lobby.featured; })[0] || matches[0];
      if (!feat) return;
      show('est-banner-feature', true);
      var isLive = !!LIVE[feat.status], isFinal = feat.status === 'settled';
      txt('est-feature-label', isLive ? 'EN VIVO' : (isFinal ? 'FINAL' : 'PRÓXIMO'));
      var lbl = el('est-feature-label'); if (lbl) lbl.classList.toggle('is-live', isLive);
      txt('est-feature-home', name(feat.homeId));
      txt('est-feature-away', name(feat.awayId));
      var mid = el('est-feature-mid');
      if (mid) mid.textContent = (isFinal && feat.result) ? (feat.result.home + '–' + feat.result.away) : (isLive ? Math.floor(feat.minute || 0) + "'" : 'vs');
      txt('est-feature-sub', isLive ? ('Minuto ' + Math.floor(feat.minute || 0) + ' · bloque ' + (feat.block || '—'))
        : isFinal ? ('Jornada ' + (feat.jornada || '—') + ' · bloque ' + (feat.block || '—'))
        : (fmtCountdown(lobby.countdownMs) || ('Bloque ' + (feat.block || '—'))));
    }).catch(function () {});
  } catch (e) {}
})();
