'use strict';

// Presencia de amistades: solo se calcula para personas que ya son amistades
// (el servidor valida la relación antes de llamar aquí), por eso se puede
// compartir el nombre de la mesa y su código: esa es justamente la utilidad de
// entrar a jugar con alguien de confianza.
function presenceFor(friendIds = [], { online = new Set(), tables = new Map() } = {}) {
  const snapshot = {};
  const isOnline = value => online instanceof Set ? online.has(value) : Boolean(online?.[value]);
  const tableFor = value => tables instanceof Map ? tables.get(value) : tables?.[value];
  for (const raw of friendIds) {
    const id = String(raw || '');
    if (!id || snapshot[id]) continue;
    const table = tableFor(id);
    if (table) {
      snapshot[id] = {
        online: true,
        status: table.spectating ? 'spectating' : 'playing',
        room: {
          code: String(table.code || ''),
          name: String(table.name || ''),
          game: String(table.game || ''),
          players: Math.max(0, Number(table.players) || 0),
          capacity: Math.max(2, Number(table.capacity) || 6)
        }
      };
    } else if (isOnline(id)) {
      snapshot[id] = { online: true, status: 'lobby', room: null };
    } else {
      snapshot[id] = { online: false, status: 'offline', room: null };
    }
  }
  return snapshot;
}

module.exports = { presenceFor };
