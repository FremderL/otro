'use strict';

// Ficha de una persona sentada en la misma mesa.
//
// Desde la mesa se puede ver quién juega contigo y, si la otra persona tiene
// cuenta, mandar o aceptar una solicitud de amistad sin salir de la partida ni
// copiar el @usuario. La regla de privacidad es la misma del resto del casino:
// solo viajan los datos públicos del asiento —los que ya están en room_state—
// y, entre cuentas, el @usuario que la comunidad ya permite buscar. Nunca se
// entrega el perfil privado (transacciones, retos, seguridad, contraseña).

const Community = require('./community');
const { ACHIEVEMENTS, publicProgress } = require('./progression');

// Cuántos logros desbloqueados caben en la ficha; el resto se resume como +N.
const MAX_SHOWN_ACHIEVEMENTS = 6;

// Relaciones posibles entre quien mira y el asiento:
//   self      → la ficha es la propia
//   bot       → asistente del casino, sin cuenta
//   guest     → persona real que juega sin cuenta
//   friend    → ya son amistades
//   outgoing  → le enviaste una solicitud y sigue pendiente
//   incoming  → te envió una solicitud y sigue pendiente
//   none      → hay cuentas, pero ninguna relación todavía
//   loading   → el cliente aún espera la respuesta del servidor
const RELATIONSHIPS = Object.freeze(['self', 'bot', 'guest', 'friend', 'outgoing', 'incoming', 'none', 'loading']);

function friendshipIdsOf(state, profileId) {
  const id = String(profileId || '');
  const ids = [];
  if (!id) return ids;
  for (const item of state?.friendships || []) {
    if (item.profileA === id) ids.push(item.profileB);
    else if (item.profileB === id) ids.push(item.profileA);
  }
  return ids;
}

function relationshipFor(state, viewerId, targetId) {
  if (!viewerId || !targetId) return { relationship: 'none', requestId: null };
  if (String(viewerId) === String(targetId)) return { relationship: 'self', requestId: null };
  if (!state) return { relationship: 'none', requestId: null };
  if (Community.friendshipExists(state, viewerId, targetId)) return { relationship: 'friend', requestId: null };
  const outgoing = (state.friendRequests || []).find(item => item.fromId === String(viewerId) && item.toId === String(targetId));
  if (outgoing) return { relationship: 'outgoing', requestId: outgoing.id };
  const incoming = (state.friendRequests || []).find(item => item.fromId === String(targetId) && item.toId === String(viewerId));
  if (incoming) return { relationship: 'incoming', requestId: incoming.id };
  return { relationship: 'none', requestId: null };
}

// Amistades en común: se cuentan sin exponer nombres ni ids ajenos.
function mutualFriendCount(state, a, b) {
  if (!state || !a || !b || String(a) === String(b)) return 0;
  const mine = new Set(friendshipIdsOf(state, a));
  if (!mine.size) return 0;
  let total = 0;
  for (const id of friendshipIdsOf(state, b)) if (mine.has(id)) total += 1;
  return total;
}

function publicAchievement(item) {
  return {
    id: item.id,
    icon: item.icon,
    name: item.name,
    description: item.description,
    rarity: item.rarity || null
  };
}

// Construye la ficha que recibe el navegador. `target` es el perfil del
// asiento (los bots también tienen perfil interno), `viewer` solo existe si la
// conexión tiene una sesión de cuenta verificada por cookie.
function tableProfileCard({ viewer = null, target, state = null, seat = {}, bot = null } = {}) {
  if (!target?.id) return null;
  const publicProfile = publicProgress(target); // incluye solo campos públicos
  const viewerAccount = Boolean(viewer?.username);
  const isBot = Boolean(bot);
  const isSelf = Boolean(viewer?.id && String(viewer.id) === String(target.id));
  let relationship = 'none';
  let requestId = null;
  if (isBot) relationship = 'bot';
  else if (isSelf) relationship = 'self';
  else if (!target.username) relationship = 'guest';
  else if (viewerAccount) ({ relationship, requestId } = relationshipFor(state, viewer.id, target.id));

  const unlocked = (publicProfile.achievements || []).map(publicAchievement);
  return {
    viewerAccount,
    profile: {
      id: target.id,
      name: publicProfile.name || 'Jugador',
      avatar: publicProfile.avatar || 'fox',
      account: Boolean(target.username),
      username: viewerAccount ? target.username || null : null,
      isBot,
      bot: isBot ? {
        difficultyLabel: bot.difficultyLabel,
        styleLabel: bot.styleLabel,
        lastAction: bot.lastAction || null,
        thinking: Boolean(bot.thinking)
      } : null,
      seat: {
        index: Number.isInteger(seat.index) ? seat.index : null,
        isHost: Boolean(seat.isHost),
        isSpectator: Boolean(seat.isSpectator)
      },
      chips: Math.max(0, Math.floor(Number(seat.chips ?? publicProfile.chips) || 0)),
      stats: publicProfile.stats || {},
      achievementCount: unlocked.length,
      achievementTotal: ACHIEVEMENTS.length,
      achievements: unlocked.slice(0, MAX_SHOWN_ACHIEVEMENTS),
      passport: publicProfile.passport || null,
      collection: publicProfile.collection || null,
      fanPin: publicProfile.fanPin || null,
      medals: Number(publicProfile.medals) || 0,
      championBanner: Boolean(publicProfile.championBanner),
      relationship,
      requestId,
      mutualFriends: viewerAccount && target.username ? mutualFriendCount(state, viewer.id, target.id) : 0
    }
  };
}

// Mutación de comunidad que hace el botón «Mandar solicitud» de la ficha.
// Se ejecuta dentro de la transacción del store; devuelve la forma que espera
// el socket (ok/code/error más la relación resultante). Una solicitud cruzada
// —la otra persona ya te había escrito— se acepta en el acto: pedir amistad a
// quien ya te la pidió debe cerrar el círculo, no abrir un segundo pendiente.
function requestFriendshipFromTable({ viewer, target, state, profiles, now } = {}) {
  if (!viewer?.id || !viewer.username) {
    return { ok: false, code: 'account_required', error: 'Inicia sesión con tu cuenta para mandar solicitudes desde la mesa.' };
  }
  if (!target?.id) return { ok: false, code: 'player_not_found', error: 'Esa persona ya no está en la mesa.' };
  if (!target.username) {
    return { ok: false, code: 'account_target_required', error: 'Esa persona juega sin cuenta: la amistad necesita una cuenta.' };
  }
  const result = Community.requestFriend(state, viewer, target, { ...(now ? { now } : {}) });
  if (result.code === 'already_friends' || result.code === 'duplicate_request') {
    // La ficha pudo quedar vieja en pantalla (otra pestaña ya la mandó, o la
    // amistad ya existía): el botón nunca debe fallar por pedir lo que ya está.
    const relationship = result.code === 'already_friends' ? 'friend' : 'outgoing';
    return { ...result, ok: true, relationship, mutual: false };
  }
  if (result.code === 'incoming_request') {
    const incoming = (state.friendRequests || []).find(item => item.fromId === String(target.id) && item.toId === String(viewer.id));
    if (!incoming) return { ...result, relationship: 'incoming' };
    const accepted = Community.acceptFriendRequest(state, viewer.id, incoming.id, profiles, { ...(now ? { now } : {}) });
    if (!accepted.ok) return { ...accepted, relationship: 'incoming' };
    return { ...accepted, code: 'friend_added', mutual: true, relationship: 'friend' };
  }
  if (!result.ok) return { ...result, relationship: relationshipFor(state, viewer.id, target.id).relationship };
  return { ...result, relationship: 'outgoing', mutual: false };
}

module.exports = {
  MAX_SHOWN_ACHIEVEMENTS,
  RELATIONSHIPS,
  friendshipIdsOf,
  relationshipFor,
  mutualFriendCount,
  tableProfileCard,
  requestFriendshipFromTable
};
