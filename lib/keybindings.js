'use strict';

// Catálogo cerrado y normalizador de controles de teclado para las mesas del
// Casino. Se comparte entre la limpieza del perfil (JSON/PostgreSQL) y el
// endpoint `keybindings_update` para que el servidor solo acepte teclas
// seguras y sin colisiones.

const KEYBINDING_CATALOG = Object.freeze([
  { id: 'startGame', group: 'general', defaultKey: ' ', label: 'Empezar juego / Nueva ronda', hint: 'Inicia partida, reparte cartas, lanza la ronda o abre la siguiente' },
  { id: 'focusBetInput', group: 'betting', defaultKey: 'b', label: 'Ingresar cantidad de apuesta', hint: 'Activa el cuadro numérico para teclear la apuesta con 0–9' },
  { id: 'confirmBet', group: 'betting', defaultKey: 'Enter', label: 'Confirmar apuesta', hint: 'Confirma el monto ingresado en Blackjack, juegos rápidos o subida' },
  { id: 'doubleAndConfirm', group: 'betting', defaultKey: 'x', label: 'Duplicar apuesta y confirmar al instante', hint: 'Multiplica ×2 tu apuesta actual o anterior y la confirma enseguida' },
  { id: 'doubleBetOnly', group: 'betting', defaultKey: 'v', label: 'Duplicar monto sin confirmar (×2)', hint: 'Duplica la cifra del cuadro de apuesta sin enviarla aún' },
  { id: 'bjHit', group: 'blackjack', defaultKey: 'h', label: 'Pedir carta', hint: 'Solicita una carta adicional en Blackjack' },
  { id: 'bjStand', group: 'blackjack', defaultKey: 's', label: 'Plantarse', hint: 'Cierra tu mano actual en Blackjack' },
  { id: 'bjDouble', group: 'blackjack', defaultKey: 'd', label: 'Doblar mano', hint: 'Duplica la apuesta y recibe una sola carta en Blackjack' },
  { id: 'bjSplit', group: 'blackjack', defaultKey: 'p', label: 'Dividir par', hint: 'Separa dos cartas de igual valor en dos manos' },
  { id: 'bjInsurance', group: 'blackjack', defaultKey: 'i', label: 'Seguro', hint: 'Toma seguro cuando la casa muestra un As' },
  { id: 'pokerFold', group: 'poker', defaultKey: 'f', label: 'Retirarse (Fold)', hint: 'Abandona la mano actual en Póker' },
  { id: 'pokerCheckCall', group: 'poker', defaultKey: 'c', label: 'Pasar / Igualar', hint: 'Pasa sin apuesta o iguala la apuesta activa en Póker' },
  { id: 'pokerRaiseFocus', group: 'poker', defaultKey: 'r', label: 'Escribir subida', hint: 'Enfoca el cuadro de subida en Póker para usar los números' },
  { id: 'pokerSubmitRaise', group: 'poker', defaultKey: 'u', label: 'Confirmar subida directa', hint: 'Ejecuta la subida con el monto actual en Póker' },
  { id: 'pokerAllIn', group: 'poker', defaultKey: 'a', label: 'All-in', hint: 'Apuesta todas tus fichas disponibles en Póker' },
  { id: 'quickPrevChoice', group: 'quick', defaultKey: 'q', label: 'Opción anterior', hint: 'Recorre hacia atrás las opciones en Ruleta, Dados, Moneda o Rueda' },
  { id: 'quickNextChoice', group: 'quick', defaultKey: 'e', label: 'Opción siguiente', hint: 'Recorre hacia adelante las opciones en Ruleta, Dados, Moneda o Rueda' },
  { id: 'skipAnimation', group: 'general', defaultKey: 'k', label: 'Saltar animación', hint: 'Muestra al instante el giro de Ruleta, Tragamonedas o Rueda' },
  { id: 'focusChat', group: 'general', defaultKey: 't', label: 'Escribir en el chat', hint: 'Enfoca la barra de mensajes de la mesa' }
]);

const KEYBINDING_DEFAULTS = Object.freeze(
  Object.fromEntries(KEYBINDING_CATALOG.map(item => [item.id, item.defaultKey]))
);
const KEYBINDING_IDS = Object.freeze(KEYBINDING_CATALOG.map(item => item.id));
const KEYBINDING_ID_SET = new Set(KEYBINDING_IDS);

const SPECIAL_ALLOWED_KEYS = new Set([
  ' ',
  'Enter',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
]);

const RESERVED_KEYS = new Set([
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  '?'
]);

function normalizeKeyBinding(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length === 0 || rawKey.length > 16) return null;
  if (rawKey === ' ' || rawKey === 'Space' || rawKey === 'Spacebar') return ' ';
  if (rawKey === 'Enter') return 'Enter';
  if (SPECIAL_ALLOWED_KEYS.has(rawKey)) return rawKey;
  if (RESERVED_KEYS.has(rawKey)) return null;
  if (rawKey.length === 1) {
    const ch = rawKey.toLowerCase();
    // Los dígitos 0–9 se reservan para escribir directamente la cantidad de apuesta.
    if (ch >= '0' && ch <= '9') return null;
    if ((ch >= 'a' && ch <= 'z') || '[],.;/-='.includes(ch)) return ch;
  }
  return null;
}

function cleanKeybindings(raw) {
  const out = { ...KEYBINDING_DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of KEYBINDING_IDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const normalized = normalizeKeyBinding(raw[id]);
    if (!normalized) continue;
    const existingOwner = KEYBINDING_IDS.find(otherId => otherId !== id && out[otherId] === normalized);
    if (existingOwner) {
      out[existingOwner] = out[id];
    }
    out[id] = normalized;
  }
  return out;
}

function applyKeybindingChanges(current, changes) {
  if (changes && typeof changes === 'object' && !Array.isArray(changes) && changes.reset === true) {
    return { ...KEYBINDING_DEFAULTS };
  }
  const next = cleanKeybindings(current);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return next;
  for (const id of KEYBINDING_IDS) {
    if (!Object.prototype.hasOwnProperty.call(changes, id)) continue;
    const normalized = normalizeKeyBinding(changes[id]);
    if (!normalized) continue;
    const prevKey = next[id];
    const conflictId = KEYBINDING_IDS.find(otherId => otherId !== id && next[otherId] === normalized);
    if (conflictId) {
      next[conflictId] = prevKey;
    }
    next[id] = normalized;
  }
  return next;
}

function formatKeyLabel(key) {
  if (key === ' ') return 'Espacio';
  if (key === 'Enter') return 'Enter';
  if (key === 'ArrowUp') return '↑';
  if (key === 'ArrowDown') return '↓';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  return String(key || '').toUpperCase();
}

module.exports = {
  KEYBINDING_CATALOG,
  KEYBINDING_DEFAULTS,
  KEYBINDING_IDS,
  KEYBINDING_ID_SET,
  normalizeKeyBinding,
  cleanKeybindings,
  applyKeybindingChanges,
  formatKeyLabel
};
