'use strict';

// Política de bots de una mesa, derivada de las PREFERENCIAS DE PERFIL.
//
// El casino rellenaba los asientos libres con bots de forma automática y sin
// consultar a nadie. Desde la pestaña Preferencias del perfil, cada persona
// decide tres cosas, y este módulo es la única traducción de esa decisión a
// reglas de mesa (lo consultan autoFillBots, releaseBotSeats y publicRoom en
// server.js):
//
//   · autoBots   — ¿puede esta mesa completar asientos con bots?
//   · botsStay   — ¿los bots conservan su asiento entre rondas?
//
// `tableInvites` no es una regla de mesa (filtra invitaciones entrantes) y se
// aplica en el handler friend_invite_send.
//
// La preferencia se congela en la sala al crearla (`room.autoBots`): cambiar de
// opinión no reescribe mesas que ya están jugando ni afecta a las mesas de otras
// personas. `botsStay` sí se lee del anfitrión actual, porque la mesa puede
// cambiar de manos.

// Valor de la preferencia para un perfil (por defecto, bots habilitados).
function autoBotsForProfile(profile) {
  return profile?.preferences?.autoBots !== false;
}

// ¿La mesa puede completar sus asientos con bots? Una sala creada con la
// preferencia apagada nunca los recibe, aunque el proceso tenga AUTO_BOTS
// encendido: es una decisión explícita de quien abrió la mesa.
function roomAllowsAutoBots(room) {
  return Boolean(room) && room.autoBots !== false;
}

// El anfitrión de una mesa tiene que ser una persona: si el asiento de host lo
// ocupa un bot, sus «preferencias» no existen y no puede decidir nada.
function hostProfileOf(room) {
  if (!room || !Array.isArray(room.players)) return null;
  const host = room.players.find(player => player && player.id === room.hostId && !player.isBot);
  return host?._profile || null;
}

// ¿El anfitrión pidió que los bots se queden sentados entre rondas?
function hostPrefersBotsStay(room) {
  const profile = hostProfileOf(room);
  return profile?.preferences?.botsStay === true;
}

module.exports = {
  autoBotsForProfile,
  roomAllowsAutoBots,
  hostProfileOf,
  hostPrefersBotsStay
};
