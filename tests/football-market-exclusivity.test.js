'use strict';

// Estadio MonteCristo — una sola selección por categoría (mercado) y partido.
// Un perfil no puede apostar dos opciones del mismo mercado en un partido, ni como
// apuestas individuales ni repartidas entre una apuesta individual y una combinada.
// El reintento idempotente de la MISMA apuesta sigue devolviendo la original.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { monthKey } = require('../lib/football-store-shared');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fexcl-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const month = monthKey();
  store.generateSeason(month);
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const profile = profiles.getOrCreate('p1', 'Jugador', null);
  profile.chips = 1000;
  profiles.saveNow();
  const betting = createBettingService({ store, profiles, simulatedFlow: null, log: () => {} });
  const matches = store.getMatches(month).filter(m => m.status === 'scheduled');
  const cleanup = () => { try { store.close(); } catch (_) {} try { profiles.saveNow(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); };
  return { store, profiles, profile, betting, match: matches[0], match2: matches[1], cleanup };
}

const bet = (h, over = {}) => h.betting.placeBet({
  profile: h.profile, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000, ...over
});

test('no se puede elegir otra selección del mismo mercado en el mismo partido', async () => {
  const h = setup();
  try {
    const r1 = await bet(h, { placedAt: 1000 });
    assert.strictEqual(r1.ok, true, r1.code);
    const r2 = await bet(h, { selection: 'away', placedAt: 90000 });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.code, 'mercado_ya_apostado');
    const r3 = await bet(h, { selection: 'draw', placedAt: 180000 });
    assert.strictEqual(r3.code, 'mercado_ya_apostado');
    assert.strictEqual(h.store.getBets({ profileId: 'p1' }).length, 1, 'solo una apuesta');
    assert.strictEqual(h.profile.chips, 900, 'solo se debitó la primera');
  } finally { h.cleanup(); }
});

test('la misma selección dos veces también se bloquea (no hay doble apuesta en la categoría)', async () => {
  const h = setup();
  try {
    assert.strictEqual((await bet(h, { placedAt: 1000 })).ok, true);
    const again = await bet(h, { placedAt: 90000 });
    assert.strictEqual(again.code, 'mercado_ya_apostado');
  } finally { h.cleanup(); }
});

test('reintento idempotente de la misma apuesta devuelve la original, sin error', async () => {
  const h = setup();
  try {
    const r1 = await bet(h, { placedAt: 1000 });
    const r2 = await bet(h, { placedAt: 1000 });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.replayed, true);
    assert.strictEqual(r2.bet.id, r1.bet.id);
    assert.strictEqual(h.profile.chips, 900);
  } finally { h.cleanup(); }
});

test('otra categoría del mismo partido sigue disponible', async () => {
  const h = setup();
  try {
    assert.strictEqual((await bet(h, { market: '1x2', selection: 'home' })).ok, true);
    const other = await bet(h, { market: 'btts', selection: 'yes', placedAt: 90000 });
    assert.strictEqual(other.ok, true, other.code);
  } finally { h.cleanup(); }
});

test('la misma categoría en otro partido sigue disponible', async () => {
  const h = setup();
  try {
    assert.strictEqual((await bet(h, { placedAt: 1000 })).ok, true);
    const other = await bet(h, { match: null, matchId: h.match2.id, placedAt: 90000 });
    assert.strictEqual(other.ok, true, other.code);
  } finally { h.cleanup(); }
});

test('apuestas simultáneas en la misma categoría: solo una entra', async () => {
  const h = setup();
  try {
    const results = await Promise.all([
      bet(h, { selection: 'home', placedAt: 1000 }),
      bet(h, { selection: 'away', placedAt: 1000 }),
      bet(h, { selection: 'draw', placedAt: 1000 })
    ]);
    const ok = results.filter(r => r.ok && !r.replayed);
    assert.strictEqual(ok.length, 1);
    assert.strictEqual(h.store.getBets({ profileId: 'p1' }).length, 1);
  } finally { h.cleanup(); }
});

test('una apuesta cobrada en cash-out también bloquea la categoría (no se puede cubrir)', async () => {
  const h = setup();
  try {
    const r1 = await bet(h, { placedAt: 1000 });
    assert.strictEqual(r1.ok, true);
    h.store.settleBet(r1.bet.id, { status: 'cashed', payout: 40 });
    const again = await bet(h, { selection: 'away', placedAt: 90000 });
    assert.strictEqual(again.code, 'mercado_ya_apostado');
  } finally { h.cleanup(); }
});

test('una apuesta anulada que nunca se debitó no bloquea la categoría', async () => {
  const h = setup();
  try {
    const r1 = await bet(h, { placedAt: 1000 });
    assert.strictEqual(r1.ok, true);
    h.store.voidBet(r1.bet.id);
    h.store.getBet(r1.bet.id).debited = false;
    const again = await bet(h, { selection: 'away', placedAt: 90000 });
    assert.strictEqual(again.ok, true, again.code);
  } finally { h.cleanup(); }
});

test('combinada: no puede repetir un mercado ya apostado en ese partido', async () => {
  const h = setup();
  try {
    assert.strictEqual((await bet(h, { market: '1x2', selection: 'home' })).ok, true);
    const parlay = await h.betting.placeParlay({
      profile: h.profile, stake: 100, placedAt: 5000,
      legs: [
        { matchId: h.match.id, market: '1x2', selection: 'away' },
        { matchId: h.match2.id, market: '1x2', selection: 'home' }
      ]
    });
    assert.strictEqual(parlay.ok, false);
    assert.strictEqual(parlay.code, 'mercado_ya_apostado');
  } finally { h.cleanup(); }
});

test('apuesta individual: no puede repetir un mercado que ya está en una combinada', async () => {
  const h = setup();
  try {
    const parlay = await h.betting.placeParlay({
      profile: h.profile, stake: 100, placedAt: 5000,
      legs: [
        { matchId: h.match.id, market: '1x2', selection: 'home' },
        { matchId: h.match2.id, market: '1x2', selection: 'home' }
      ]
    });
    assert.strictEqual(parlay.ok, true, parlay.code);
    const single = await bet(h, { selection: 'away', placedAt: 90000 });
    assert.strictEqual(single.code, 'mercado_ya_apostado');
  } finally { h.cleanup(); }
});
