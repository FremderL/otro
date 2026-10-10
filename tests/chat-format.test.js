'use strict';

// Utilidades del chat (public/chat-format.js): menciones, roles, escape y scroll
// inteligente. Son puras: se prueban con listas simuladas, sin navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../public/chat-format.js');

const ROOT = path.join(__dirname, '..');

// Lista simulada: altura visible, altura total y posición de scroll.
function fakeList({ scrollHeight = 1000, clientHeight = 300, scrollTop = 0 } = {}) {
  return { scrollHeight, clientHeight, scrollTop, innerHTML: '' };
}
function fakeJump() {
  const classes = new Set(['hidden']);
  return {
    textContent: '',
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c)
    }
  };
}

test('formatChatText escapa HTML antes de resaltar menciones', () => {
  const out = C.formatChatText('<img src=x onerror=alert(1)> hola @Ana', 'Ana');
  assert.ok(!out.includes('<img'), 'el HTML del usuario queda escapado');
  assert.ok(out.includes('&lt;img'));
  assert.match(out, /<mark class="chat-mention is-me">@Ana<\/mark>/);
});

test('formatChatText distingue la mención a @Monte y a otros jugadores', () => {
  assert.match(C.formatChatText('pregunta a @Monte', 'Ana'), /chat-mention is-monte/);
  assert.match(C.formatChatText('hola @Bruno', 'Ana'), /<mark class="chat-mention">@Bruno<\/mark>/);
  assert.doesNotMatch(C.formatChatText('hola @Bruno', 'Ana'), /is-me/);
});

test('formatChatText no resalta correos ni apodos pegados a otra palabra', () => {
  assert.doesNotMatch(C.formatChatText('mi correo es ana@mail.com', 'Ana'), /<mark/);
});

test('formatChatText recorta el punto final fuera de la mención', () => {
  assert.equal(C.formatChatText('gracias @Ana.', 'Ana'), 'gracias <mark class="chat-mention is-me">@Ana</mark>.');
});

test('chatMentionsName exige el apodo completo, con límite de palabra', () => {
  assert.equal(C.chatMentionsName('hey @Ana qué tal', 'Ana'), true);
  assert.equal(C.chatMentionsName('hey @Anabel', 'Ana'), false, 'prefijo de otro apodo');
  assert.equal(C.chatMentionsName('x@Ana', 'Ana'), false, 'sin separación previa');
  assert.equal(C.chatMentionsName('@ana!', 'Ana'), true, 'sin distinguir mayúsculas');
  assert.equal(C.chatMentionsName('@Ana.', 'Ana'), true, 'punto final de frase');
  assert.equal(C.chatMentionsName('@Ana.bob', 'Ana'), false);
  assert.equal(C.chatMentionsName('@Ana', ''), false, 'sin apodo propio no hay mención');
});

test('chatMentionsName escapa caracteres de regex del apodo', () => {
  assert.equal(C.chatMentionsName('hola @a+b', 'a+b'), true);
  assert.equal(C.chatMentionsName('hola @axb', 'a+b'), false);
});

test('chatRoleBadge solo produce badge para roles de la lista cerrada', () => {
  assert.equal(C.chatRoleBadge('staff'), '<span class="chat-role chat-role-staff">STAFF</span>');
  assert.equal(C.chatRoleBadge('moderator'), '<span class="chat-role chat-role-moderator">MOD</span>');
  assert.equal(C.chatRoleBadge('bot'), '<span class="chat-role chat-role-bot">BOT</span>');
  assert.equal(C.chatRoleBadge('user'), '', 'un usuario normal no lleva badge');
  assert.equal(C.chatRoleBadge(undefined), '');
  assert.equal(C.chatRoleBadge('constructor'), '', 'no acepta claves heredadas del objeto');
  assert.equal(C.chatRoleBadge('x" onmouseover="y'), '', 'no inyecta clases libres');
});

test('countAdded cuenta solo los ids nuevos, aun con el buffer lleno', () => {
  assert.equal(C.countAdded(['a', 'b', 'c'], ['a', 'b']), 1);
  assert.equal(C.countAdded(['b', 'c', 'd'], ['a', 'b', 'c']), 1, 'buffer desplazado: solo el nuevo');
  assert.equal(C.countAdded(['a'], undefined), 1, 'primera pintura');
  assert.equal(C.countAdded(['a', 'b'], ['a', 'b']), 0);
});

test('paintList sigue el fondo cuando el usuario está al final', () => {
  const list = fakeList({ scrollHeight: 1000, clientHeight: 300, scrollTop: 690 });
  const jump = fakeJump();
  const stuck = C.paintList(list, jump, '<p>nuevo</p>', 2, {});
  assert.equal(stuck, true);
  assert.equal(list.scrollTop, list.scrollHeight, 'baja al último mensaje');
  assert.ok(jump.classList.contains('hidden'));
});

test('paintList NO arrastra al usuario que lee historial y ofrece el contador', () => {
  const list = fakeList({ scrollHeight: 1000, clientHeight: 300, scrollTop: 100 });
  const jump = fakeJump();
  const stuck = C.paintList(list, jump, '<p>nuevo</p>', 3, {});
  assert.equal(stuck, false);
  assert.equal(list.scrollTop, 100, 'la posición de lectura se conserva');
  assert.equal(jump.textContent, '↓ 3 mensajes nuevos');
  assert.ok(!jump.classList.contains('hidden'));
});

test('paintList usa singular en el contador y no muestra nada sin mensajes nuevos', () => {
  const list = fakeList({ scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
  const jump = fakeJump();
  C.paintList(list, jump, '', 1, {});
  assert.equal(jump.textContent, '↓ 1 mensaje nuevo');
  const quiet = fakeJump();
  C.paintList(list, quiet, '', 0, {});
  assert.ok(quiet.classList.contains('hidden'), 'sin novedades no aparece el botón');
});

test('paintList trata un panel oculto (altura 0) como fondo y fuerza el fondo al abrir', () => {
  const hidden = fakeList({ scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
  assert.equal(C.paintList(hidden, fakeJump(), '<p>x</p>', 4, {}), true, 'oculto ⇒ se sincroniza al abrir');
  const reading = fakeList({ scrollHeight: 1000, clientHeight: 300, scrollTop: 50 });
  assert.equal(C.paintList(reading, fakeJump(), '<p>x</p>', 2, { force: true }), true, 'force baja aunque lea historial');
  assert.equal(reading.scrollTop, 1000);
});

test('isNearBottom usa el umbral STICK_PX', () => {
  assert.equal(C.isNearBottom(fakeList({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 - C.STICK_PX })), true);
  assert.equal(C.isNearBottom(fakeList({ scrollHeight: 1000, clientHeight: 300, scrollTop: 600 })), false);
});

test('index.html carga chat-format.js antes de app.js y marca las listas como log accesible', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const iFormat = html.indexOf('src="/chat-format.js"');
  const iApp = html.indexOf('src="/app.js"');
  assert.ok(iFormat > 0 && iApp > iFormat, 'el módulo se carga antes de app.js');
  assert.match(html, /id="chat-list"[^>]*role="log"/);
  assert.match(html, /id="lobby-chat-messages"[^>]*role="log"/);
  assert.match(html, /id="chat-jump"[^>]*hidden/);
  assert.match(html, /id="lobby-chat-jump"[^>]*hidden/);
});

test('styles.css define la capa responsive de mesas (tabletas y móviles)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(css, /@media \(max-width: 1023\.98px\)[^}]*\.room-app/s, 'tabletas: mesa primero, chat abajo');
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.quick-bets-around\s*\{[^}]*position: static/, 'móvil: asientos apilados');
  assert.match(css, /\.action-buttons \.game-btn \{ flex: 1 1 96px; min-height: 44px; \}/, 'botones con área táctil de 44 px');
});
