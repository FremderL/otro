'use strict';

// Grada del Estadio: moderación opt-in por votación (producto 2026-10).
// Reglas cubiertas:
//   · por defecto la charla se censura como el resto del casino;
//   · si la mayoría de la grada vota a favor, ESE partido publica los tacos;
//   · un perfil vota una sola vez por votación;
//   · la votación nunca levanta los términos de odio;
//   · la autorización caduca con el partido.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStands, cleanChatText, censorBlockedSlurs, hasBlockedSlur
} = require('../lib/football/stands');

const MATCH = 'm_2099-11_j1_b1_1';
const censor = text => String(text).replace(/mierda/g, '******');

function harness(options = {}) {
  let at = 1_800_000_000_000;
  const logs = [];
  const stands = createStands(null, {
    now: () => at,
    quorum: options.quorum || 3,
    windowMs: options.windowMs || 60_000,
    reopenMs: options.reopenMs == null ? 0 : options.reopenMs,
    log: (event, payload) => logs.push({ event, payload })
  });
  return { stands, logs, tick: ms => { at += ms; }, now: () => at };
}

test('sin votación la grada se censura como todo el casino', () => {
  const { stands } = harness();
  assert.equal(stands.allowsInsults(MATCH), false);
  const out = stands.composeText('eres un mierda', { matchId: MATCH, censored: censor });
  assert.equal(out, 'eres un ******');
});

test('el text se limpia siempre: sin HTML, sin saltos de línea y con tope', () => {
  // El censor quita los signos `<`/`>` (nunca se interpreta HTML), igual que cleanMessage.
  assert.equal(cleanChatText('  <b>hola</b>\n\n mundo  '), 'bhola/b mundo');
  assert.equal(cleanChatText('x'.repeat(400)).length, 120);
  assert.equal(cleanChatText(null), '');
});

test('la mayoría de la grada habilita los insultos en ese partido', () => {
  const h = harness();
  const opened = h.stands.openVote({ matchId: MATCH, profileId: 'p1', expiresAt: h.now() + 600_000 });
  assert.equal(opened.ok, true);
  assert.equal(h.stands.stateFor(MATCH).status, 'open');

  assert.equal(h.stands.castVote({ matchId: MATCH, profileId: 'p1', allow: true }).ok, true);
  assert.equal(h.stands.stateFor(MATCH).status, 'open', 'un voto no basta');
  h.stands.castVote({ matchId: MATCH, profileId: 'p2', allow: true });
  const passed = h.stands.castVote({ matchId: MATCH, profileId: 'p3', allow: true });
  assert.equal(passed.ok, true);
  assert.equal(h.stands.stateFor(MATCH).status, 'allowed');
  assert.equal(h.stands.allowsInsults(MATCH), true);
  assert.ok(h.logs.some(entry => entry.event === 'football_stands_vote_passed'));

  // Con la grada habilitada el taco se publica tal cual…
  assert.equal(
    h.stands.composeText('que mierda de arbitraje', { matchId: MATCH, censored: censor }),
    'que mierda de arbitraje'
  );
  // …pero el texto sigue sin HTML y con el mismo tope.
  assert.equal(h.stands.composeText('<i>mierda</i>', { matchId: MATCH, censored: censor }), 'imierda/i');
});

test('un perfil vota una sola vez por votación', () => {
  const h = harness();
  h.stands.openVote({ matchId: MATCH, profileId: 'p1' });
  assert.equal(h.stands.castVote({ matchId: MATCH, profileId: 'p1', allow: true }).ok, true);
  const again = h.stands.castVote({ matchId: MATCH, profileId: 'p1', allow: false });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'ya_votaste');
  assert.equal(h.stands.stateFor(MATCH).votes.total, 1);
});

test('la mayoría suficiente en contra cierra la votación y mantiene la censura', () => {
  const h = harness();
  h.stands.openVote({ matchId: MATCH, profileId: 'p1' });
  h.stands.castVote({ matchId: MATCH, profileId: 'p1', allow: false });
  h.stands.castVote({ matchId: MATCH, profileId: 'p2', allow: false });
  h.stands.castVote({ matchId: MATCH, profileId: 'p3', allow: false });
  const state = h.stands.stateFor(MATCH);
  assert.equal(state.status, 'rejected');
  assert.equal(h.stands.allowsInsults(MATCH), false);
  assert.equal(h.stands.composeText('mierda', { matchId: MATCH, censored: censor }), '******');
});

test('la votación caduca y hay que volver a pedirla', () => {
  const h = harness({ windowMs: 30_000 });
  h.stands.openVote({ matchId: MATCH, profileId: 'p1' });
  h.tick(30_001);
  assert.equal(h.stands.castVote({ matchId: MATCH, profileId: 'p2', allow: true }).code, 'votacion_cerrada');
  const state = h.stands.sweep(MATCH);
  assert.equal(state.status, 'rejected');
});

test('la autorización dura lo que dura el partido', () => {
  const h = harness();
  const expiresAt = h.now() + 120_000;
  h.stands.openVote({ matchId: MATCH, profileId: 'p1', expiresAt });
  h.stands.castVote({ matchId: MATCH, profileId: 'p1', allow: true });
  h.stands.castVote({ matchId: MATCH, profileId: 'p2', allow: true });
  h.stands.castVote({ matchId: MATCH, profileId: 'p3', allow: true });
  assert.equal(h.stands.allowsInsults(MATCH), true);
  h.tick(120_000);
  assert.equal(h.stands.allowsInsults(MATCH), false, 'al terminar el partido vuelve la censura');
  assert.equal(h.stands.sweep(MATCH).status, 'idle');
});

test('ninguna votación levanta los términos de odio', () => {
  const h = harness();
  h.stands.openVote({ matchId: MATCH, profileId: 'p1' });
  for (const id of ['p1', 'p2', 'p3']) h.stands.castVote({ matchId: MATCH, profileId: id, allow: true });
  assert.equal(h.stands.stateFor(MATCH).status, 'allowed');
  assert.equal(hasBlockedSlur('eres un sudaca'), true);
  const out = h.stands.composeText('eres un sudaca', { matchId: MATCH, censored: censor });
  assert.notEqual(out, 'eres un sudaca');
  assert.equal(out, 'eres un ******');
  assert.equal(censorBlockedSlurs('sudaca de mierda').startsWith('******'), true);
});

test('no se reabre una votación en curso ni se repite sin esperar', () => {
  const h = harness({ reopenMs: 5_000 });
  assert.equal(h.stands.openVote({ matchId: MATCH, profileId: 'p1' }).ok, true);
  const second = h.stands.openVote({ matchId: MATCH, profileId: 'p2' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'votacion_en_curso');
  h.tick(61_000);
  h.stands.sweep(MATCH);
  assert.equal(h.stands.openVote({ matchId: MATCH, profileId: 'p2' }).code, 'espera_para_repetir');
  h.tick(5_000);
  assert.equal(h.stands.openVote({ matchId: MATCH, profileId: 'p2' }).ok, true);
});
