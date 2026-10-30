'use strict';

// Catálogo de las 54 cartas de la Lotería mexicana. El número es la identidad
// de la carta en el juego (lib/loteria/game.js solo maneja enteros 1..54); el
// nombre y el emoji son presentación y viajan al navegador en la suscripción
// de Socket.IO, así que este archivo es la única fuente de verdad.
const CARDS = Object.freeze([
  { number: 1, name: 'El Gallo', emoji: '🐓' },
  { number: 2, name: 'El Diablito', emoji: '😈' },
  { number: 3, name: 'La Dama', emoji: '👩' },
  { number: 4, name: 'El Catrín', emoji: '🎩' },
  { number: 5, name: 'El Paraguas', emoji: '☂️' },
  { number: 6, name: 'La Sirena', emoji: '🧜' },
  { number: 7, name: 'La Escalera', emoji: '🪜' },
  { number: 8, name: 'La Botella', emoji: '🍾' },
  { number: 9, name: 'El Barril', emoji: '🛢️' },
  { number: 10, name: 'El Árbol', emoji: '🌳' },
  { number: 11, name: 'El Melón', emoji: '🍈' },
  { number: 12, name: 'El Valiente', emoji: '💪' },
  { number: 13, name: 'El Gorrito', emoji: '🧢' },
  { number: 14, name: 'La Muerte', emoji: '💀' },
  { number: 15, name: 'La Pera', emoji: '🍐' },
  { number: 16, name: 'La Bandera', emoji: '🚩' },
  { number: 17, name: 'El Bandolón', emoji: '🪕' },
  { number: 18, name: 'El Violoncello', emoji: '🎻' },
  { number: 19, name: 'La Garza', emoji: '🦩' },
  { number: 20, name: 'El Pájaro', emoji: '🐦' },
  { number: 21, name: 'La Mano', emoji: '✋' },
  { number: 22, name: 'La Bota', emoji: '👢' },
  { number: 23, name: 'La Luna', emoji: '🌙' },
  { number: 24, name: 'El Cotorro', emoji: '🦜' },
  { number: 25, name: 'El Borracho', emoji: '🍻' },
  { number: 26, name: 'El Vaquero', emoji: '🤠' },
  { number: 27, name: 'El Corazón', emoji: '❤️' },
  { number: 28, name: 'La Sandía', emoji: '🍉' },
  { number: 29, name: 'El Tambor', emoji: '🥁' },
  { number: 30, name: 'El Camarón', emoji: '🦐' },
  { number: 31, name: 'Las Jaras', emoji: '🏹' },
  { number: 32, name: 'El Músico', emoji: '🎺' },
  { number: 33, name: 'La Araña', emoji: '🕷️' },
  { number: 34, name: 'El Soldado', emoji: '🪖' },
  { number: 35, name: 'La Estrella', emoji: '⭐' },
  { number: 36, name: 'El Cazo', emoji: '🍳' },
  { number: 37, name: 'El Mundo', emoji: '🌎' },
  { number: 38, name: 'El Apache', emoji: '🪶' },
  { number: 39, name: 'El Nopal', emoji: '🌵' },
  { number: 40, name: 'El Alacrán', emoji: '🦂' },
  { number: 41, name: 'La Rosa', emoji: '🌹' },
  { number: 42, name: 'La Calavera', emoji: '💀' },
  { number: 43, name: 'La Campana', emoji: '🔔' },
  { number: 44, name: 'El Cantarito', emoji: '🏺' },
  { number: 45, name: 'El Venado', emoji: '🦌' },
  { number: 46, name: 'El Sol', emoji: '☀️' },
  { number: 47, name: 'La Corona', emoji: '👑' },
  { number: 48, name: 'La Chalupa', emoji: '🛶' },
  { number: 49, name: 'El Pino', emoji: '🌲' },
  { number: 50, name: 'El Pescado', emoji: '🐟' },
  { number: 51, name: 'La Palma', emoji: '🌴' },
  { number: 52, name: 'La Maceta', emoji: '🪴' },
  { number: 53, name: 'El Arpa', emoji: '🪕' },
  { number: 54, name: 'La Rana', emoji: '🐸' }
]);

const CARD_BY_NUMBER = new Map(CARDS.map(card => [card.number, card]));

function cardInfo(number) {
  return CARD_BY_NUMBER.get(Number(number)) || null;
}

module.exports = { CARDS, CARD_BY_NUMBER, cardInfo };
