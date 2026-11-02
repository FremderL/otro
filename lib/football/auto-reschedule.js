'use strict';

// Retraso suficiente para descartar un pequeño desfase del barrido; la nueva
// hora se cuenta desde la detección, no desde la hora que ya quedó atrás.
const GRACE_MS = 2 * 60 * 1000;
const DELAY_MS = 30 * 60 * 1000;

function isUnstartedOverdue(match, store, now, graceMs = GRACE_MS) {
  if (!match || match.status !== 'scheduled' || match.actualKickoffAt != null
      || !Number.isFinite(match.scheduledKickoffAt) || match.scheduledKickoffAt <= 0
      || now - match.scheduledKickoffAt < graceMs) return false;
  // Un estado antiguo puede haberse guardado antes del kickoff: una apuesta en
  // vivo es prueba de que ya se inició y debe seguir la recuperación normal.
  return !(store?.getBets?.({ matchId: match.id }) || []).some(bet => bet.inPlay);
}

module.exports = { GRACE_MS, DELAY_MS, isUnstartedOverdue };
