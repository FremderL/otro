'use strict';

// Identidad de asiento: qué perfil ocupa la persona en una mesa.
//
// - Con sesión de cuenta verificada por cookie (ACCOUNT_SESSIONS_ENABLED), el
//   asiento es el perfil de SU cuenta, sin importar el dispositivo: iniciar
//   sesión recupera el mismo perfil y sus fichas (README). Así, el saldo que
//   se juega, el que muestra la mesa y el del lobby son el mismo.
// - Sin esa sesión, el asiento sigue siendo el perfil del dispositivo (token).
//   El `accountId` que envía el navegador NO basta para sentar a nadie: no
//   hay prueba de identidad, y permitiría jugar con las fichas de otra persona.

function seatIdentity({ accountSessionsEnabled = false, accountProfileId = null, token = '' } = {}) {
  if (accountSessionsEnabled && accountProfileId) return String(accountProfileId).slice(0, 80);
  return String(token || '').slice(0, 80);
}

// El chat admite también el login legado con contraseña, solo durante la
// conexión que lo verificó. Un id enviado en el payload no es autenticación.
function lobbyChatIdentity({ accountSessionsEnabled = false, accountProfileId = null, legacyChatProfileId = null, token = '' } = {}) {
  if (accountSessionsEnabled && accountProfileId) return { id: String(accountProfileId).slice(0, 80), authenticated: true };
  if (!accountSessionsEnabled && legacyChatProfileId) return { id: String(legacyChatProfileId).slice(0, 80), authenticated: true };
  return { id: String(token || '').slice(0, 80), authenticated: false };
}

module.exports = { seatIdentity, lobbyChatIdentity };
