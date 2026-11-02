'use strict';

// Retraso suficiente para descartar un pequeño desfase del barrido; la nueva
// hora se cuenta desde la detección, no desde la hora que ya quedó atrás.
// Solo se reprograma si aún estamos dentro de los 30 minutos posteriores a la
// hora en que debía comenzar; pasado ese margen el partido se liquida directo.
const GRACE_MS = 2 * 60 * 1000;
const DELAY_MS = 30 * 60 * 1000;
const MAX_RESCHEDULE_WINDOW_MS = 30 * 60 * 1000;

function originalKickoffOf(match) {
  if (!match) return 0;
  return Number.isFinite(match.autoReschedulePreviousKickoffAt) && match.autoReschedulePreviousKickoffAt > 0
    ? match.autoReschedulePreviousKickoffAt
    : match.scheduledKickoffAt;
}

function isUnstartedOverdue(match, store, now, graceMs = GRACE_MS) {
  if (!match || match.status !== 'scheduled' || match.actualKickoffAt != null
      || !Number.isFinite(match.scheduledKickoffAt) || match.scheduledKickoffAt <= 0
      || now - match.scheduledKickoffAt < graceMs) return false;
  // Un estado antiguo puede haberse guardado antes del kickoff: una apuesta en
  // vivo es prueba de que ya se inició y debe seguir la recuperación normal.
  return !(store?.getBets?.({ matchId: match.id }) || []).some(bet => bet.inPlay);
}

function canAutoReschedule(match, store, now, graceMs = GRACE_MS, windowMs = MAX_RESCHEDULE_WINDOW_MS) {
  if (!isUnstartedOverdue(match, store, now, graceMs)) return false;
  const baseKickoff = originalKickoffOf(match);
  return Number.isFinite(baseKickoff) && baseKickoff > 0 && now - baseKickoff <= windowMs;
}

function isOverdueBeyondRescheduleWindow(match, store, now, graceMs = GRACE_MS, windowMs = MAX_RESCHEDULE_WINDOW_MS) {
  if (!isUnstartedOverdue(match, store, now, graceMs)) return false;
  const baseKickoff = originalKickoffOf(match);
  return Number.isFinite(baseKickoff) && baseKickoff > 0 && now - baseKickoff > windowMs;
}

module.exports = {
  GRACE_MS,
  DELAY_MS,
  MAX_RESCHEDULE_WINDOW_MS,
  originalKickoffOf,
  isUnstartedOverdue,
  canAutoReschedule,
  isOverdueBeyondRescheduleWindow
};
