/* global document */
'use strict';

// Esta vista es independiente: solo usa memoria del navegador y no llama a APIs.
(function () {
  var clubs = [
    ['FAR', 'Farselona FC', '#a94b54'], ['RMD', 'Real Mandril', '#389b83'],
    ['ATC', 'Atleti-comedia FC', '#5868b8'], ['MUN', 'Manchestéreo United', '#b5943a'],
    ['LVP', 'Liverpulpo FC', '#39866d'], ['ARS', 'Arsénico FC', '#a84d77'],
    ['BAY', 'Bayern Munchies', '#238679'], ['BDO', 'Borussia Dormund', '#327fa7'],
    ['JUV', 'Juventus de los Jubilados', '#b76545'], ['PSG', 'París Sin Goles', '#8a60a2'],
    ['RSU', 'Real Suciedad', '#688597'], ['RDB', 'Roma de la Broma', '#5668a5'],
    ['WHM', 'West Hamón FC', '#8a913f'], ['NAB', 'Nabo-li FC', '#98754e'],
    ['CDC', 'Celtic de Cómic', '#6b8e7e'], ['BEN', 'Benfica de Beneficencia', '#b88332']
  ];
  var byId = {};
  clubs.forEach(function (club) { byId[club[0]] = club; });
  function crest(id, extra) {
    return '<img class="crest ' + (extra || '') + '" src="/escudos/' + id + '.svg" alt="" aria-hidden="true">';
  }
  var titles = { once: 'MI ONCE', mercado: 'MERCADO DE TRASPASOS', quiniela: 'QUINIELA · 8 DE 8', aficion: 'MI AFICIÓN', escudos: 'GALERÍA DE ESCUDOS' };
  var buttons = document.querySelectorAll('[data-view]');
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      var selected = button.getAttribute('data-view');
      buttons.forEach(function (item) {
        var active = item === button;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      });
      document.querySelectorAll('[data-panel]').forEach(function (panel) { panel.hidden = panel.getAttribute('data-panel') !== selected; });
      document.getElementById('breadcrumb').textContent = titles[selected];
    });
  });

  var lineup = [
    ['D. Vidal', 'RMD'], ['M. Soriano', 'BDO'], ['L. Costa', 'FAR'], ['A. Ramos', 'LVP'], ['N. Ríos', 'ARS'],
    ['I. Vega', 'BAY'], ['B. Soler', 'FAR'], ['P. Silva', 'MUN'], ['S. Gil', 'BDO'], ['E. Mora', 'LVP'], ['F. León', 'RMD']
  ];
  var alternatives = ['J. Moreno', 'A. Molina', 'N. Vidal', 'P. Lora', 'E. Rey', 'R. Luna', 'C. Gil', 'D. Robles', 'H. Rivas', 'M. Pardo', 'T. Torres'];
  var editing = false;
  var players = document.getElementById('pitch-players');
  var editButton = document.getElementById('lineup-edit');
  function drawLineup() {
    players.innerHTML = lineup.map(function (player, i) {
      return '<button type="button" class="pitch-player p-' + i + '" data-player="' + i + '" ' + (editing ? '' : 'disabled') + ' aria-label="' + (editing ? 'Cambiar ' : '') + player[0] + ', ' + byId[player[1]][1] + '"><span class="shirt"><span>' + (i + 1) + '</span></span><b>' + player[0] + '</b><small>' + player[1] + '</small></button>';
    }).join('');
  }
  drawLineup();
  editButton.addEventListener('click', function () {
    editing = !editing;
    editButton.innerHTML = editing ? 'Terminar edición <span>✓</span>' : 'Editar once <span>↗</span>';
    document.getElementById('lineup-feedback').textContent = editing ? 'Toca un jugador para cambiarlo en esta demostración.' : 'Alineación de ejemplo. No se guardó ningún cambio.';
    drawLineup();
  });
  players.addEventListener('click', function (event) {
    var button = event.target.closest('[data-player]');
    if (!button || !editing) return;
    var i = Number(button.getAttribute('data-player'));
    var old = lineup[i][0]; lineup[i][0] = alternatives[i]; alternatives[i] = old;
    drawLineup();
    players.querySelector('[data-player="' + i + '"]').focus();
    document.getElementById('lineup-feedback').textContent = 'Cambio de ejemplo: ' + lineup[i][0] + '. No se guardan datos.';
  });

  var transfers = [
    ['Bruno Soler', 'FAR', 'LVP', '01'], ['Ivo Vega', 'LVP', 'FAR', '01'],
    ['Paolo Silva', 'MUN', 'BDO', '02'], ['Santi Gil', 'BDO', 'MUN', '02']
  ];
  document.getElementById('transfer-grid').innerHTML = transfers.map(function (move, i) {
    return '<article class="transfer-card"><div class="transfer-top"><span class="transfer-tag">INTERCAMBIO ' + move[3] + '</span><span class="transfer-status">● &nbsp; ANUNCIADO · EJEMPLO</span></div><div class="transfer-person"><span class="player-avatar avatar-' + (i + 1) + '">' + move[0].split(' ').map(function (n) { return n[0]; }).join('') + '</span><div><h4>' + move[0] + '</h4><p>MEDIOCAMPISTA · CM</p></div><span class="transfer-arrow">↗</span></div><div class="transfer-route"><div>' + crest(move[1]) + '<span><small>DESDE</small><b>' + byId[move[1]][1] + '</b></span></div><span class="route-arrow">→</span><div>' + crest(move[2]) + '<span><small>HACIA</small><b>' + byId[move[2]][1] + '</b></span></div></div><div class="transfer-bottom">EFECTIVO EN LA SIGUIENTE TEMPORADA <span>↗</span></div></article>';
  }).join('');

  var fixtures = [ ['FAR','RMD'], ['LVP','BDO'], ['MUN','ARS'], ['BAY','PSG'], ['ATC','RDB'], ['JUV','NAB'], ['WHM','CDC'], ['BEN','RSU'] ];
  var matches = document.getElementById('prediction-matches');
  matches.innerHTML = fixtures.map(function (fixture, i) {
    return '<fieldset class="match-row"><legend class="sr-only">Partido ' + (i + 1) + ': ' + byId[fixture[0]][1] + ' contra ' + byId[fixture[1]][1] + '</legend><div class="match-number">' + String(i + 1).padStart(2, '0') + '</div><div class="match-clubs"><span>' + crest(fixture[0]) + '<b>' + byId[fixture[0]][1] + '</b></span><small>VS</small><span>' + crest(fixture[1]) + '<b>' + byId[fixture[1]][1] + '</b></span></div><div class="pick-options">' + ['L','E','V'].map(function (choice) { var label = { L:'Local', E:'Empate', V:'Visita' }[choice]; return '<label><input type="radio" name="match-' + i + '" value="' + choice + '" aria-label="' + label + '"><span>' + choice + '</span></label>'; }).join('') + '</div></fieldset>';
  }).join('');
  matches.addEventListener('change', function () {
    var count = matches.querySelectorAll('input:checked').length;
    document.getElementById('prediction-count').textContent = count;
    document.getElementById('ticket-count').textContent = count;
    document.getElementById('prediction-submit').disabled = count !== 8;
    document.getElementById('prediction-feedback').textContent = count === 8 ? 'Tu boleto de ejemplo está completo. No se realizará ningún cobro.' : 'Selecciona los 8 resultados para continuar.';
  });
  document.getElementById('prediction-submit').addEventListener('click', function () {
    if (matches.querySelectorAll('input:checked').length !== 8) return;
    document.getElementById('prediction-feedback').textContent = 'Entrada simulada: no se registró ningún boleto ni se cobraron fichas.';
  });

  var grid = document.getElementById('club-grid');
  var selectedClub = 'FAR';
  var pendingClub = null;
  var confirmBox = document.getElementById('club-confirm');
  function drawClubs() {
    grid.innerHTML = clubs.map(function (club) {
      return '<button type="button" class="club-option" data-club="' + club[0] + '" aria-pressed="' + String(club[0] === selectedClub) + '">' + crest(club[0]) + '<span>' + club[1] + '</span></button>';
    }).join('');
  }
  function cancelClubChange() {
    var previous = pendingClub;
    pendingClub = null;
    confirmBox.hidden = true;
    if (previous) {
      var button = grid.querySelector('[data-club="' + previous + '"]');
      if (button) button.focus();
    }
  }
  drawClubs();
  document.getElementById('change-club').addEventListener('click', function () {
    var picker = document.getElementById('club-picker');
    picker.hidden = !picker.hidden;
    this.setAttribute('aria-expanded', String(!picker.hidden));
    if (picker.hidden) { pendingClub = null; confirmBox.hidden = true; }
  });
  grid.addEventListener('click', function (event) {
    var button = event.target.closest('[data-club]'); if (!button) return;
    var choice = button.getAttribute('data-club');
    if (choice === selectedClub) {
      pendingClub = null;
      confirmBox.hidden = true;
      document.getElementById('club-feedback').textContent = 'Ya elegiste este club en la demostración; no se ha perdido nada.';
      return;
    }
    pendingClub = choice;
    document.getElementById('club-confirm-text').textContent = 'Vas a dejar ' + byId[selectedClub][1] + ' para apoyar a ' + byId[choice][1] + '.';
    confirmBox.hidden = false;
    document.getElementById('confirm-club').focus();
  });
  document.getElementById('cancel-club').addEventListener('click', cancelClubChange);
  document.getElementById('confirm-club').addEventListener('click', function () {
    if (!pendingClub) return;
    var previous = selectedClub;
    selectedClub = pendingClub;
    pendingClub = null;
    document.getElementById('chosen-club').textContent = byId[selectedClub][1];
    document.getElementById('chosen-crest').setAttribute('src', '/escudos/' + selectedClub + '.svg');
    document.getElementById('fan-level').innerHTML = 'Inicio <small>· NIVEL 0</small>';
    document.getElementById('fan-wins').innerHTML = '0 <small>desde tu adhesión</small>';
    document.querySelectorAll('#fan-progress span').forEach(function (dot, i) { dot.classList.toggle('on', i === 0); });
    document.querySelector('#fan-progress i').style.width = '0';
    document.getElementById('fan-next').textContent = 'PRÓXIMO NIVEL · 1 VICTORIA';
    document.querySelectorAll('#fan-rewards > div').forEach(function (reward) {
      reward.classList.add('locked');
      reward.querySelector('small').textContent = 'BLOQUEADO';
    });
    document.getElementById('fan-opt').checked = false;
    drawClubs();
    confirmBox.hidden = true;
    document.getElementById('club-feedback').textContent = 'Cambio simulado: se retiraron el progreso y las recompensas de ' + byId[previous][1] + '. ' + byId[selectedClub][1] + ' comienza desde cero. No se modificó tu perfil real.';
    grid.querySelector('[data-club="' + selectedClub + '"]').focus();
  });

})();
