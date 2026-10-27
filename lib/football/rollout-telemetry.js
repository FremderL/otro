'use strict';

// Telemetría operacional mínima del piloto Balón de Oro.
// Solo conserva agregados por pista/resultado; nunca recibe, guarda ni registra
// perfil, token, IP, user-agent, selección, apuesta ni saldo.

const { FixedWindowRateLimiter } = require('../rate-limit');

const AUDIO_TRACKS = Object.freeze([
  'opening_narration',
  'ceremony_music',
  'ceremony_narration'
]);
const AUDIO_OUTCOMES = Object.freeze(['started', 'completed', 'blocked', 'error']);
const PRIVATE_BALLON_DOR_BET_LOG_EVENTS = Object.freeze([
  'football_ballon_dor_bet_placed',
  'football_ballon_dor_bet_persist_failed',
  'football_ballon_dor_bet_settled',
  'football_ballon_dor_bet_refunded',
  'football_ballon_dor_refund_failed'
]);
const SEASON_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function isPrivateBallonDorBetLog(event) {
  return PRIVATE_BALLON_DOR_BET_LOG_EVENTS.includes(event);
}

function normalizeAudioPlaybackEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const seasonMonth = String(value.seasonMonth || '');
  const match = SEASON_MONTH.exec(seasonMonth);
  if (!match || Number(match[1]) < 1) return null;
  if (!AUDIO_TRACKS.includes(value.track) || !AUDIO_OUTCOMES.includes(value.outcome)) return null;
  return { seasonMonth, track: value.track, outcome: value.outcome };
}

function emptyAudioCounts() {
  return Object.fromEntries(AUDIO_TRACKS.map(track => [
    track,
    Object.fromEntries(AUDIO_OUTCOMES.map(outcome => [outcome, 0]))
  ]));
}

function createBallonDorAudioTelemetry({
  log = () => {},
  now = () => Date.now(),
  limit = 1200,
  windowMs = 60_000
} = {}) {
  const counts = emptyAudioCounts();
  const limiter = new FixedWindowRateLimiter({
    limit: Number.isInteger(limit) && limit > 0 ? limit : 1200,
    windowMs: Number.isInteger(windowMs) && windowMs > 0 ? windowMs : 60_000,
    maxKeys: 1,
    now
  });

  function record(value) {
    const event = normalizeAudioPlaybackEvent(value);
    if (!event) return { ok: false, code: 'audio_event_invalid' };
    if (!limiter.consume('all-audio-playback').allowed) {
      return { ok: false, code: 'rate_limit' };
    }

    counts[event.track][event.outcome] = Math.min(
      Number.MAX_SAFE_INTEGER,
      counts[event.track][event.outcome] + 1
    );
    try {
      log('football_ballon_dor_audio_telemetry', event);
    } catch (_) {
      // La telemetría nunca debe interrumpir una escena o una petición.
    }
    return { ok: true };
  }

  function snapshot() {
    return Object.fromEntries(AUDIO_TRACKS.map(track => [track, { ...counts[track] }]));
  }

  return { record, snapshot };
}

module.exports = {
  AUDIO_TRACKS,
  AUDIO_OUTCOMES,
  PRIVATE_BALLON_DOR_BET_LOG_EVENTS,
  isPrivateBallonDorBetLog,
  normalizeAudioPlaybackEvent,
  createBallonDorAudioTelemetry
};
