'use strict';

// Esta página ejecuta únicamente partidos locales de prueba; no escribe en el
// servidor, no escucha sockets y no calcula ni acepta apuestas.
(() => {
  const engine = window.MonteCristoSimulador;
  const $ = id => document.getElementById(id);
  const fallbackTeams = [
    { id: 'vantora_fc', name: 'Real Mandril', short: 'RMD', formation: '4-3-3' },
    { id: 'united_vanguard', name: 'Farselona FC', short: 'FAR', formation: '4-4-2' }
  ];
  const canvas = $('pitch');
  const ctx = canvas.getContext('2d');
  const homeSelect = $('home-select');
  const awaySelect = $('away-select');
  const goalBanner = $('goal-banner');
  const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ui = { teams: fallbackTeams, simulation: null, visible: null, next: null, pendingEvents: [],
    accumulated: 0, lastFrame: null, speed: 4, playing: !reducedMotion, bannerUntil: 0, lastMinorEvent: -60 };

  function markStandalonePreview() {
    document.body.classList.add('preview-mode');
    document.querySelector('.brand').setAttribute('href', '/');
  }
  if (window.location.pathname === '/') markStandalonePreview();
  if (!engine || !ctx) {
    $('playback-status').textContent = 'No se pudo cargar la simulación.';
    $('setup-feedback').textContent = 'Actualiza la página para volver a intentarlo.';
    $('play-toggle').disabled = true;
    return;
  }

  function seedForDemo() {
    const values = new Uint32Array(1);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') window.crypto.getRandomValues(values);
    else values[0] = Date.now() >>> 0;
    return values[0]; // No es una semilla secreta: el partido no admite apuestas.
  }
  function initialSeed() {
    const value = new URLSearchParams(window.location.search).get('seed');
    // El primer partido de muestra se puede repetir; «Nuevo partido» usa otra
    // semilla. Ninguna semilla de esta demo es apta para apuestas.
    return value !== null && /^\d{1,10}$/.test(value) && Number(value) <= 0xffffffff ? Number(value) : 20261102;
  }
  function teamById(id) { return ui.teams.find(team => team.id === id); }
  function timeText(snapshot) {
    let seconds = Math.max(0, Math.floor(snapshot.time));
    const s1 = (snapshot.clock && snapshot.clock.s1 || 0) * 60;
    let prefix = '';
    if (snapshot.half === 1 && seconds >= 45 * 60) { prefix = '45+'; seconds -= 45 * 60; }
    else if (snapshot.half === 2) {
      seconds -= s1;
      if (seconds >= 90 * 60) { prefix = '90+'; seconds -= 90 * 60; }
    }
    return prefix + `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function minuteText(event) {
    const s1 = (ui.visible.clock && ui.visible.clock.s1 || 0) * 60;
    if (event.half === 1 && event.time >= 45 * 60) return `45+${Math.max(1, Math.ceil((event.time - 45 * 60) / 60))}′`;
    const nominal = event.half === 2 ? event.time - s1 : event.time;
    if (nominal >= 90 * 60) return `90+${Math.max(1, Math.ceil((nominal - 90 * 60) / 60))}′`;
    return `${Math.min(90, Math.floor(nominal / 60) + 1)}′`;
  }
  function applyTeamLabels(snapshot) {
    for (const side of ['home', 'away']) {
      const team = snapshot.teams[side];
      $(`${side}-name`).textContent = team.name;
      $(`${side}-formation`).textContent = team.formation;
      $(`legend-${side}`).textContent = team.short;
      $(`stats-${side}-label`).textContent = team.short;
      // Los nombres de archivo pertenecen al catálogo estático de la aplicación.
      const short = /^[A-Z0-9]{2,5}$/.test(team.short) ? team.short : (side === 'home' ? 'RMD' : 'FAR');
      $(`${side}-badge`).src = `/assets/escudos/${short}.svg`;
    }
  }
  function statPair(name, home, away, suffix = '') {
    $(`${name}-home`).textContent = `${home}${suffix}`;
    $(`${name}-away`).textContent = `${away}${suffix}`;
    const total = home + away;
    $(`${name}-bar`).style.width = `${total ? home / total * 100 : 50}%`;
  }
  function updateHud(snapshot) {
    $('score-home').textContent = snapshot.score.home;
    $('score-away').textContent = snapshot.score.away;
    $('match-clock').textContent = timeText(snapshot);
    let phase = snapshot.ended ? 'FINAL' : snapshot.phase === 'halftime' ? 'DESCANSO' : snapshot.half === 1 ? '1ER TIEMPO' : '2DO TIEMPO';
    $('match-phase').textContent = phase;
    $('stats-status').lastChild.textContent = ` ${snapshot.ended ? 'FINAL' : !ui.playing ? 'PAUSADO' : snapshot.phase === 'halftime' ? 'DESCANSO' : 'EN JUEGO'}`;
    const home = snapshot.stats.home, away = snapshot.stats.away;
    const totalPossession = home.possessionSeconds + away.possessionSeconds;
    const h = totalPossession ? Math.round(home.possessionSeconds / totalPossession * 100) : 50;
    statPair('possession', h, 100 - h, '%');
    statPair('shots', home.shots, away.shots);
    statPair('target', home.shotsOnTarget, away.shotsOnTarget);
    statPair('passes', home.completedPasses, away.completedPasses);
    $('play-toggle').disabled = snapshot.ended;
    $('play-toggle').setAttribute('aria-pressed', String(ui.playing && !snapshot.ended));
    $('play-icon').textContent = ui.playing && !snapshot.ended ? 'Ⅱ' : '▶';
    $('play-label').textContent = snapshot.ended ? 'Partido finalizado' : ui.playing ? 'Pausar partido' : 'Reanudar partido';
    $('playback-status').textContent = snapshot.ended ? 'Final del partido' : ui.playing ? 'Partido en marcha' : 'Partido en pausa';
  }
  function eventText(event) {
    const team = ui.visible.teams[event.team];
    const name = team ? team.name : '';
    switch (event.type) {
      case 'kickoff': return `${name} pone el balón en juego.`;
      case 'goal_restart': return `${name} reanuda el juego desde el centro.`;
      case 'stoppage_start': return `El árbitro añade ${event.minutes} minuto${event.minutes === 1 ? '' : 's'}.`;
      case 'substitution': return `Cambio en ${name}: entra ${event.playerInName} por ${event.playerOutName}.`;
      case 'yellow_card': return `Tarjeta amarilla para ${name}.`;
      case 'red_card': return `¡Tarjeta roja! ${name} queda con un jugador menos.`;
      case 'second_yellow': return `Segunda amarilla y expulsión para ${name}.`;
      case 'second_half': return 'Comienza el segundo tiempo. Los equipos cambian de lado.';
      case 'halftime': return 'Descanso. Termina el primer tiempo.';
      case 'full_time': return `Final del partido. ${ui.visible.score.home}–${ui.visible.score.away}.`;
      case 'goal': return `¡Gol de ${name}! El balón cruza la línea de portería.`;
      case 'shot': return `${name} remata${event.penalty ? ' desde el punto penal' : ' al arco'}.`;
      case 'save': return `¡Atajada! El portero de ${name} alcanza el disparo.`;
      case 'block': return `${name} bloquea un disparo.`;
      case 'corner': return `Córner para ${name}.`;
      case 'penalty_awarded': return `Penal para ${name} por una falta en el área.`;
      case 'foul': return `Falta de ${name}.`;
      case 'interception': return `${name} intercepta el pase.`;
      case 'tackle': return `${name} recupera la posesión en la disputa.`;
      default: return null;
    }
  }
  function addEvents(events) {
    const feed = $('event-feed');
    for (const event of events) {
      if (event.type === 'interception' || event.type === 'tackle') {
        if (event.time - ui.lastMinorEvent < 35) continue;
        ui.lastMinorEvent = event.time;
      }
      const text = eventText(event);
      if (!text) continue;
      const empty = feed.querySelector('.feed-empty');
      if (empty) empty.remove();
      const row = document.createElement('div');
      row.className = `feed-item${event.type === 'goal' ? ' goal' : ''}`;
      const time = document.createElement('time');
      time.textContent = minuteText(event);
      const description = document.createElement('span');
      description.textContent = text;
      row.append(time, description);
      feed.append(row);
      while (feed.children.length > 25) feed.firstElementChild.remove();
      feed.scrollTop = feed.scrollHeight;
      if (event.type === 'goal') ui.bannerUntil = performance.now() + 2200;
    }
  }
  function populateSelects(homeId, awayId) {
    for (const select of [homeSelect, awaySelect]) {
      select.replaceChildren();
      for (const team of ui.teams) {
        const option = document.createElement('option');
        option.value = team.id;
        option.textContent = team.name;
        select.append(option);
      }
    }
    homeSelect.value = teamById(homeId) ? homeId : ui.teams[0].id;
    awaySelect.value = teamById(awayId) && awayId !== homeSelect.value ? awayId : (ui.teams.find(team => team.id !== homeSelect.value) || ui.teams[0]).id;
  }
  function startGame(seed) {
    const home = teamById(homeSelect.value), away = teamById(awaySelect.value);
    if (!home || !away || home.id === away.id) {
      $('setup-feedback').textContent = 'Elige dos clubes diferentes para comenzar.';
      return;
    }
    $('setup-feedback').textContent = '';
    ui.simulation = engine.createMatch({ seed, home, away });
    ui.visible = ui.simulation.snapshot();
    ui.accumulated = 0; ui.lastFrame = null; ui.lastMinorEvent = -60; ui.bannerUntil = 0;
    ui.playing = !reducedMotion;
    $('event-feed').replaceChildren();
    applyTeamLabels(ui.visible);
    addEvents(ui.simulation.eventsAfter(-1));
    ui.next = ui.simulation.step();
    ui.pendingEvents = ui.simulation.eventsAfter(ui.visible.lastEventId);
    updateHud(ui.visible);
    draw(ui.visible, ui.next, 0);
  }
  function validateSelection() {
    $('setup-feedback').textContent = homeSelect.value === awaySelect.value ? 'Elige dos clubes diferentes para comenzar.' : '';
  }
  $('match-form').addEventListener('submit', event => { event.preventDefault(); startGame(seedForDemo()); });
  homeSelect.addEventListener('change', validateSelection);
  awaySelect.addEventListener('change', validateSelection);
  $('play-toggle').addEventListener('click', () => {
    if (!ui.visible || ui.visible.ended) return;
    ui.playing = !ui.playing; ui.lastFrame = null;
    updateHud(ui.visible);
  });
  for (const button of document.querySelectorAll('[data-speed]')) {
    button.addEventListener('click', () => {
      ui.speed = Number(button.dataset.speed);
      for (const option of document.querySelectorAll('[data-speed]')) option.setAttribute('aria-pressed', String(option === button));
    });
  }
  document.addEventListener('visibilitychange', () => { ui.lastFrame = null; });

  // El render interpola el paso anterior y el siguiente. Solo se muestra un
  // evento/marcador cuando el balón ya llegó a la posición correspondiente.
  function animate(now) {
    if (!ui.visible) { window.requestAnimationFrame(animate); return; }
    if (ui.playing && !document.hidden) {
      if (ui.lastFrame !== null) ui.accumulated += Math.min(0.1, Math.max(0, (now - ui.lastFrame) / 1000)) * ui.speed;
      ui.lastFrame = now;
      while (ui.accumulated >= engine.STEP && !ui.visible.ended) {
        ui.accumulated -= engine.STEP;
        ui.visible = ui.next;
        addEvents(ui.pendingEvents);
        if (ui.visible.ended) {
          ui.playing = false; ui.next = ui.visible; ui.pendingEvents = []; ui.accumulated = 0;
        } else {
          ui.next = ui.simulation.step();
          ui.pendingEvents = ui.simulation.eventsAfter(ui.visible.lastEventId);
        }
        updateHud(ui.visible);
      }
    } else ui.lastFrame = null;
    goalBanner.classList.toggle('visible', now < ui.bannerUntil);
    draw(ui.visible, ui.next, Math.min(1, ui.accumulated / engine.STEP));
    window.requestAnimationFrame(animate);
  }

  function draw(before, after, ratio) {
    const W = canvas.width, H = canvas.height;
    const field = { x: 31, y: 25, w: 1058, h: 685 };
    const sx = field.w / engine.FIELD.length, sy = field.h / engine.FIELD.width;
    const px = x => field.x + x * sx, py = y => field.y + y * sy;
    const mix = (a, b) => a + (b - a) * ratio;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#184c3a'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#206449'; ctx.fillRect(field.x, field.y, field.w, field.h);
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(6,43,30,.13)' : 'rgba(209,245,196,.025)';
      ctx.fillRect(field.x + i * field.w / 12, field.y, field.w / 12, field.h);
    }
    const shade = ctx.createLinearGradient(0, field.y, 0, field.y + field.h);
    shade.addColorStop(0, 'rgba(1,24,17,.10)'); shade.addColorStop(0.45, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,18,12,.13)');
    ctx.fillStyle = shade; ctx.fillRect(field.x, field.y, field.w, field.h);
    ctx.strokeStyle = 'rgba(230,246,220,.72)'; ctx.lineWidth = 2;
    ctx.strokeRect(field.x, field.y, field.w, field.h);
    ctx.beginPath(); ctx.moveTo(px(52.5), field.y); ctx.lineTo(px(52.5), field.y + field.h); ctx.stroke();
    ctx.beginPath(); ctx.arc(px(52.5), py(34), 9.15 * sx, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(239,249,229,.86)';
    for (const x of [52.5, 11, 94]) { ctx.beginPath(); ctx.arc(px(x), py(34), 2.3, 0, Math.PI * 2); ctx.fill(); }
    // Áreas grande y chica, arcos y porterías: dimensiones en metros.
    const areaY = py((68 - 40.32) / 2), areaH = 40.32 * sy;
    const smallY = py((68 - 18.32) / 2), smallH = 18.32 * sy;
    ctx.strokeRect(px(0), areaY, 16.5 * sx, areaH); ctx.strokeRect(px(105 - 16.5), areaY, 16.5 * sx, areaH);
    ctx.strokeRect(px(0), smallY, 5.5 * sx, smallH); ctx.strokeRect(px(105 - 5.5), smallY, 5.5 * sx, smallH);
    ctx.beginPath(); ctx.arc(px(11), py(34), 9.15 * sx, -0.9, 0.9); ctx.stroke();
    ctx.beginPath(); ctx.arc(px(94), py(34), 9.15 * sx, Math.PI - 0.9, Math.PI + 0.9); ctx.stroke();
    const goalY = py((68 - engine.FIELD.goalWidth) / 2), goalH = engine.FIELD.goalWidth * sy;
    ctx.strokeStyle = 'rgba(231,245,222,.75)';
    ctx.strokeRect(field.x - 14, goalY, 14, goalH); ctx.strokeRect(field.x + field.w, goalY, 14, goalH);
    ctx.strokeStyle = 'rgba(222,241,218,.24)'; ctx.lineWidth = 1;
    for (let j = 1; j < 5; j++) {
      ctx.beginPath(); ctx.moveTo(field.x - 14, goalY + goalH * j / 5); ctx.lineTo(field.x, goalY + goalH * j / 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(field.x + field.w, goalY + goalH * j / 5); ctx.lineTo(field.x + field.w + 14, goalY + goalH * j / 5); ctx.stroke();
    }
    // En una pantalla estrecha el canvas se reduce; ampliar las fichas mantiene
    // visibles los 22 jugadores sin alterar sus coordenadas ni la simulación.
    const displayedWidth = canvas.getBoundingClientRect().width || W;
    const tokenScale = Math.max(1, Math.min(2.1, 720 / displayedWidth));
    const nextPlayers = new Map(after.players.map(player => [player.id, player]));
    for (const player of before.players) {
      if (player.active === false) continue;
      const nextPlayer = nextPlayers.get(player.id) || player;
      const x = px(mix(player.x, nextPlayer.x)), y = py(mix(player.y, nextPlayer.y));
      const home = player.side === 'home';
      ctx.beginPath(); ctx.ellipse(x + 1, y + 4 * tokenScale, 10.5 * tokenScale, 7.5 * tokenScale, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,20,12,.34)'; ctx.fill();
      if (before.ball.carrierId === player.id) {
        ctx.beginPath(); ctx.arc(x, y, 14.2 * tokenScale, 0, Math.PI * 2); ctx.strokeStyle = home ? 'rgba(182,253,213,.65)' : 'rgba(255,217,150,.75)'; ctx.lineWidth = 1.6 * tokenScale; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(x, y, 9.7 * tokenScale, 0, Math.PI * 2);
      ctx.fillStyle = home ? '#b7f4d6' : '#f6c278'; ctx.fill();
      ctx.lineWidth = (player.role === 'GK' ? 3 : 1.8) * tokenScale; ctx.strokeStyle = home ? '#205e45' : '#734a1b'; ctx.stroke();
      ctx.fillStyle = home ? '#164834' : '#5a3515'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `800 ${(player.number > 9 ? 9 : 10) * tokenScale}px system-ui, sans-serif`; ctx.fillText(String(player.number), x, y + 0.3);
    }
    const bx = px(mix(before.ball.x, after.ball.x)), by = py(mix(before.ball.y, after.ball.y));
    ctx.beginPath(); ctx.ellipse(bx + 1, by + 3, 5.5 * tokenScale, 3 * tokenScale, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, 4.5 * tokenScale, 0, Math.PI * 2); ctx.fillStyle = '#fffdf0'; ctx.fill(); ctx.lineWidth = tokenScale; ctx.strokeStyle = '#314d3e'; ctx.stroke();
    ctx.beginPath(); ctx.arc(bx, by, 1.2 * tokenScale, 0, Math.PI * 2); ctx.fillStyle = '#314d3e'; ctx.fill();
  }

  populateSelects('vantora_fc', 'united_vanguard');
  startGame(initialSeed());
  window.requestAnimationFrame(animate);
  // Solo metadatos públicos de los clubes. No se consulta ni se altera el
  // estado del partido oficial; el prototipo sigue funcionando sin la API.
  window.fetch('/api/estadio/state', { credentials: 'same-origin' }).then(response => response.ok ? response.json() : null).then(data => {
    if (data && data.standalonePreview === true) markStandalonePreview();
    const teams = data && data.teams && Object.values(data.teams).filter(team => team && team.id && team.name);
    if (!teams || teams.length < 2) return;
    const home = homeSelect.value, away = awaySelect.value;
    ui.teams = teams;
    populateSelects(home, away);
  }).catch(() => {});
})();
