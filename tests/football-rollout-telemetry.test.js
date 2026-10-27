'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUDIO_TRACKS,
  AUDIO_OUTCOMES,
  PRIVATE_BALLON_DOR_BET_LOG_EVENTS,
  isPrivateBallonDorBetLog,
  normalizeAudioPlaybackEvent,
  createBallonDorAudioTelemetry
} = require('../lib/football/rollout-telemetry');

test('audio telemetry accepts only the three tracks, four outcomes and a valid season month', () => {
  assert.deepEqual(normalizeAudioPlaybackEvent({
    track: 'opening_narration', outcome: 'started', seasonMonth: '2026-11',
    profileId: 'not-captured', token: 'not-captured', ip: 'not-captured'
  }), { track: 'opening_narration', outcome: 'started', seasonMonth: '2026-11' });
  assert.equal(normalizeAudioPlaybackEvent({ track: 'opening_narration', outcome: 'started', seasonMonth: '2026-13' }), null);
  assert.equal(normalizeAudioPlaybackEvent({ track: 'unknown', outcome: 'started', seasonMonth: '2026-11' }), null);
  assert.equal(normalizeAudioPlaybackEvent({ track: 'ceremony_music', outcome: 'paused', seasonMonth: '2026-11' }), null);
  assert.equal(normalizeAudioPlaybackEvent(null), null);
  assert.equal(AUDIO_TRACKS.length, 3);
  assert.deepEqual(AUDIO_OUTCOMES, ['started', 'completed', 'blocked', 'error']);
});

test('el logger de producción excluye eventos de boletos individuales y conserva métricas agregadas', () => {
  for (const event of PRIVATE_BALLON_DOR_BET_LOG_EVENTS) {
    assert.equal(isPrivateBallonDorBetLog(event), true, `${event} no debe persistirse en logs`);
  }
  assert.equal(isPrivateBallonDorBetLog('football_ballon_dor_sweep_completed'), false);
  assert.equal(isPrivateBallonDorBetLog('football_ballon_dor_audio_telemetry'), false);
});

test('audio telemetry keeps aggregate counters and logs no identity or wager fields', () => {
  const events = [];
  const telemetry = createBallonDorAudioTelemetry({ log: (...args) => events.push(args), limit: 10 });
  assert.deepEqual(telemetry.record({
    track: 'ceremony_narration', outcome: 'started', seasonMonth: '2026-11',
    profileId: 'private-profile', token: 'private-token', selection: 'private-selection', stake: 500
  }), { ok: true });
  assert.deepEqual(telemetry.record({ track: 'ceremony_narration', outcome: 'completed', seasonMonth: '2026-11' }), { ok: true });
  assert.deepEqual(telemetry.snapshot().ceremony_narration, {
    started: 1, completed: 1, blocked: 0, error: 0
  });
  assert.doesNotMatch(JSON.stringify(events), /private-profile|private-token|private-selection|stake/);
  assert.deepEqual(events.map(([eventName]) => eventName), [
    'football_ballon_dor_audio_telemetry', 'football_ballon_dor_audio_telemetry'
  ]);
});

test('audio telemetry applies a global fixed-window cap and the counters recover in the next window', () => {
  let now = 10;
  const telemetry = createBallonDorAudioTelemetry({ now: () => now, limit: 2, windowMs: 100 });
  const event = { track: 'opening_narration', outcome: 'started', seasonMonth: '2026-11' };
  assert.equal(telemetry.record(event).ok, true);
  assert.equal(telemetry.record(event).ok, true);
  assert.deepEqual(telemetry.record(event), { ok: false, code: 'rate_limit' });
  assert.equal(telemetry.snapshot().opening_narration.started, 2);
  now = 111;
  assert.equal(telemetry.record(event).ok, true);
  assert.equal(telemetry.snapshot().opening_narration.started, 3);
});
