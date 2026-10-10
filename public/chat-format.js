// Utilidades puras del chat (casino y mesas): formato de texto, menciones, roles
// y scroll inteligente. Sin estado de la app: app.js las usa y las pruebas de
// Node las cargan directamente (module.exports).
//
// Reglas:
//   · Todo texto de usuario se escapa antes de resaltar menciones.
//   · Los roles salen de una lista cerrada: nunca se inyecta una clase libre.
//   · Si el usuario lee historial (lejos del fondo) no se le arrastra al final:
//     se muestra un contador «↓ N nuevos» que lo lleva al último mensaje.
(function (root) {
  'use strict';

  // Distancia al fondo que cuenta como «siguiendo la conversación».
  var STICK_PX = 48;
  var ROLE_LABELS = { staff: 'STAFF', moderator: 'MOD', bot: 'BOT' };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function isNearBottom(list) {
    return list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_PX;
  }

  // Escapa y resalta las menciones (@apodo). Solo se transforma texto ya escapado.
  function formatChatText(text, selfName) {
    var self = String(selfName || '').trim().toLowerCase();
    return escapeHtml(text).replace(/(^|\s)(@[\p{L}\p{N}_](?:[\p{L}\p{N}_.-]{0,23}[\p{L}\p{N}_])?)/gu, function (_, lead, handle) {
      var name = handle.slice(1).toLowerCase();
      var cls = self && name === self ? 'chat-mention is-me' : name === 'monte' ? 'chat-mention is-monte' : 'chat-mention';
      return lead + '<mark class="' + cls + '">' + handle + '</mark>';
    });
  }

  // ¿El texto menciona a `selfName`? Coincide con «@nombre» completo, no con prefijos.
  function chatMentionsName(text, selfName) {
    var self = String(selfName || '').trim().toLowerCase();
    if (!self) return false;
    var escaped = self.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    var re = new RegExp('(^|\\s)@' + escaped + '(?![\\p{L}\\p{N}_]|[.-][\\p{L}\\p{N}_])', 'iu');
    return re.test(String(text || ''));
  }

  // Solo roles de la lista cerrada producen badge.
  function chatRoleBadge(role) {
    var label = Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : null;
    return label ? '<span class="chat-role chat-role-' + role + '">' + label + '</span>' : '';
  }

  // Cuenta los ids que no estaban en la lista anterior (mensajes nuevos).
  function countAdded(ids, previousIds) {
    var seen = {};
    (previousIds || []).forEach(function (id) { seen[id] = true; });
    return ids.filter(function (id) { return !seen[id]; }).length;
  }

  // Enlaza el botón «↓ nuevos» una sola vez por lista.
  function bindJump(list, jump) {
    if (!list || !jump || jump.dataset.bound) return;
    jump.dataset.bound = '1';
    jump.addEventListener('click', function () { list.scrollTop = list.scrollHeight; jump.classList.add('hidden'); });
    list.addEventListener('scroll', function () { if (isNearBottom(list)) jump.classList.add('hidden'); }, { passive: true });
  }

  // Pinta la lista. Un panel oculto (altura 0) se considera «en el fondo» y se
  // sincroniza al abrirse. `force` fuerza el fondo (cambio de sala, apertura).
  function paintList(list, jump, html, added, options) {
    var force = Boolean(options && options.force);
    var stick = force || !list.clientHeight || isNearBottom(list);
    list.innerHTML = html;
    if (stick) {
      list.scrollTop = list.scrollHeight;
      if (jump) jump.classList.add('hidden');
    } else if (added > 0 && jump) {
      jump.textContent = added === 1 ? '↓ 1 mensaje nuevo' : '↓ ' + added + ' mensajes nuevos';
      jump.classList.remove('hidden');
    }
    return stick;
  }

  var api = {
    STICK_PX: STICK_PX, ROLE_LABELS: ROLE_LABELS,
    escapeHtml: escapeHtml, isNearBottom: isNearBottom, formatChatText: formatChatText,
    chatMentionsName: chatMentionsName, chatRoleBadge: chatRoleBadge, countAdded: countAdded,
    bindJump: bindJump, paintList: paintList
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MonteChat = api;
})(typeof window !== 'undefined' ? window : globalThis);
