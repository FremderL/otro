'use strict';

// Servicio operativo de la Quiniela (lib/football/quiniela-service.js): diario
// persistente en la liga, cartera real idempotente por operationId, liquidación
// derive-not-accumulate y recuperación ante crash entre diario y cartera.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { QuinielaService, ENTRY_COST } = require('../lib/football/quiniela-service');
const { monthKey } = require('../lib/football-store-shared');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fquin-'));
  const storePath = path.join(dir, 'football.json');
  const profilePath = path.join(dir, 'profiles.json');
  const store = new FootballStore(storePath);
  const month = monthKey();
  store.generateSeason(month);
  const profiles = new ProfileStore(profilePath);
  const firstKickoff = Math.min(...store.getMatches(month).map(m => m.scheduledKickoffAt));
  let nowVal = firstKickoff - 60000;
  const now = () => nowVal;
  const service = new QuinielaService({ store, profiles, log: () => {}, now, enabled: true });
  const league = () => store.getLeague(month);
  const cleanup = () => { clearTimeout(profiles.saveTimer); };
  return { dir, store, storePath, profilePath, profiles, month, service, league, now, setNow: v => { nowVal = v; }, firstKickoff, cleanup };
}

function picksFor(league, jornada, pick = 'home') {
  const ms = league.calendar.jornadas.find(j => j.jornada === jornada).matches;
  return ms.map(m => ({ matchId: m.id, pick }));
}

function settleJornada(ctx, jornada, winner = 'home') {
  for (const m of ctx.league().calendar.jornadas.find(j => j.jornada === jornada).matches) {
    m.status = 'settled';
    m.result = winner === 'home' ? { home: 2, away: 1, winner: 'home' } : { home: 0, away: 0, winner: 'draw' };
  }
}

test('snapshot: jornada abierta disponible con 8 partidos y entrada de 50', (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const snap = ctx.service.snapshot(ctx.league(), null, ctx.now());
  assert.equal(snap.available, true);
  assert.equal(snap.entryCost, ENTRY_COST);
  assert.equal(snap.carry, 0);
  assert.equal(snap.matches.length, 8);
  assert.ok(snap.matches.every(m => m.id && m.homeId && m.awayId && m.scheduledKickoffAt));
  // Tras el primer saque la inscripción pasa a la siguiente jornada abierta…
  ctx.setNow(ctx.firstKickoff + 1);
  const afterFirst = ctx.service.snapshot(ctx.league(), null, ctx.now());
  assert.equal(afterFirst.available, true);
  assert.ok(afterFirst.jornada > snap.jornada || afterFirst.closesAt > ctx.firstKickoff);
  // …y tras el último saque de la temporada ya no hay inscripción.
  const lastKickoff = Math.max(...ctx.store.getMatches(ctx.month).map(m => m.scheduledKickoffAt));
  ctx.setNow(lastKickoff + 1);
  assert.equal(ctx.service.snapshot(ctx.league(), null, ctx.now()).available, false);
});

test('enter: descuenta 50 fichas, persiste el diario y reintenta idempotente', async (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const profile = ctx.profiles.getOrCreate('p1', 'Ana');
  const before = profile.chips;
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  const picks = picksFor(ctx.league(), jornada);
  const res = await ctx.service.enter({ league: ctx.league(), jornada, profile, picks });
  assert.equal(res.ok, true);
  assert.equal(profile.chips, before - 50);
  const round = ctx.league().quiniela.rounds[jornada];
  assert.equal(round.status, 'open');
  assert.equal(round.tickets.p1.status, 'open');
  assert.equal(round.matchIds.length, 8);
  // Reintento con los mismos picks: replay sin cobrar otra vez.
  const replay = await ctx.service.enter({ league: ctx.league(), jornada, profile, picks });
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true);
  assert.equal(profile.chips, before - 50);
  // Picks distintos: ya entró.
  const other = picks.map(p => ({ ...p, pick: 'away' }));
  assert.equal((await ctx.service.enter({ league: ctx.league(), jornada, profile, picks: other })).code, 'already_entered');
  // El diario sobrevive a un reload del store (archivo).
  const reloaded = new FootballStore(ctx.storePath);
  const rLeague = reloaded.getLeague(ctx.month);
  assert.equal(rLeague.quiniela.rounds[jornada].tickets.p1.status, 'open');
  assert.equal(rLeague.quiniela.rounds[jornada].tickets.p1.picks.length, 8);
  // Validaciones fail-closed.
  assert.equal((await ctx.service.enter({ league: ctx.league(), jornada, profile: ctx.profiles.getOrCreate('p2', 'Bo'), picks: picks.slice(1) })).code, 'invalid_picks');
  const poor = ctx.profiles.getOrCreate('p3', 'Cata'); poor.chips = 10; ctx.profiles.persistProfile(poor);
  assert.equal((await ctx.service.enter({ league: ctx.league(), jornada, profile: poor, picks })).code, 'saldo_insuficiente');
  assert.equal(poor.chips, 10);
  // Cerrada tras el saque.
  ctx.setNow(ctx.firstKickoff + 1);
  assert.equal((await ctx.service.enter({ league: ctx.league(), jornada, profile: ctx.profiles.getOrCreate('p4', 'Dani'), picks })).code, 'closed');
});

test('settle: 8/8 reparte el bote con enteros, acumula sobrante y es idempotente', async (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  const picks = picksFor(ctx.league(), jornada);
  const a = ctx.profiles.getOrCreate('a', 'A'); const b = ctx.profiles.getOrCreate('b', 'B'); const c = ctx.profiles.getOrCreate('c', 'C');
  const chipsA = a.chips, chipsB = b.chips, chipsC = c.chips;
  await ctx.service.enter({ league: ctx.league(), jornada, profile: a, picks });
  await ctx.service.enter({ league: ctx.league(), jornada, profile: b, picks });
  await ctx.service.enter({ league: ctx.league(), jornada, profile: c, picks: picks.map((p, i) => i === 7 ? { ...p, pick: 'draw' } : p) });
  settleJornada(ctx, jornada, 'home');
  const out = await ctx.service.settleJornada(ctx.league(), jornada);
  assert.equal(out.status, 'settled');
  assert.equal(out.pot, 150); assert.equal(out.winners, 2); assert.equal(out.carry, 0); assert.equal(out.entries, 3);
  assert.equal(a.chips, chipsA - 50 + 75); // 150 / 2 = 75 exactos
  assert.equal(b.chips, chipsB - 50 + 75);
  assert.equal(c.chips, chipsC - 50);
  const round = ctx.league().quiniela.rounds[jornada];
  assert.equal(round.tickets.a.status, 'won'); assert.equal(round.tickets.a.payout, 75);
  assert.equal(round.tickets.c.status, 'lost');
  assert.ok(!JSON.stringify(round.result).includes('"a"') || !round.result.winners || typeof round.result.winners === 'number');
  // Idempotente: segunda llamada no paga de nuevo.
  const again = await ctx.service.settleJornada(ctx.league(), jornada);
  assert.equal(again.alreadySettled, true);
  assert.equal(a.chips, chipsA - 50 + 75);
  // Sin ganadores: el bote pasa al acumulado.
  const j2 = ctx.league().calendar.jornadas.map(j => j.jornada).filter(j => j !== jornada).sort((x, y) => x - y)[0];
  const d = ctx.profiles.getOrCreate('d', 'D');
  const chipsD = d.chips;
  await ctx.service.enter({ league: ctx.league(), jornada: j2, profile: d, picks: picksFor(ctx.league(), j2, 'away') });
  settleJornada(ctx, j2, 'home'); // todos fallan
  const out2 = await ctx.service.settleJornada(ctx.league(), j2);
  assert.equal(out2.status, 'settled'); assert.equal(out2.winners, 0); assert.equal(out2.carry, 50); // bote sin ganador pasa al acumulado
  assert.equal(d.chips, chipsD - 50);
  assert.equal(ctx.league().quiniela.bank.carry, 50);
});

test('postergación sin resultado reembolsa la entrada y conserva el acumulado', async (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  const p = ctx.profiles.getOrCreate('p', 'P');
  const chips = p.chips;
  await ctx.service.enter({ league: ctx.league(), jornada, profile: p, picks: picksFor(ctx.league(), jornada) });
  ctx.league().quiniela.bank.carry = 70;
  const ms = ctx.league().calendar.jornadas.find(j => j.jornada === jornada).matches;
  for (const m of ms) m.status = 'settled', m.result = { home: 1, away: 0, winner: 'home' };
  ms[2].status = 'postponed'; ms[2].result = null;
  const out = await ctx.service.settleJornada(ctx.league(), jornada);
  assert.equal(out.status, 'cancelled');
  assert.equal(out.carry, 70);
  assert.equal(p.chips, chips); // 50 de entrada de vuelta
  assert.equal(ctx.league().quiniela.rounds[jornada].tickets.p.status, 'refunded');
  assert.equal(ctx.league().quiniela.rounds[jornada].tickets.p.payout, 50);
});

test('recover: un crash entre diario y cartera se repara sin pagar dos veces', async (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  const picks = picksFor(ctx.league(), jornada);
  // Congela el archivo de perfiles ANTES de entrar (simula crash tras guardar el
  // diario pero antes de debitar/persistir el perfil).
  const p = ctx.profiles.getOrCreate('p', 'P');
  await ctx.profiles.persistProfile(p);
  const frozenProfiles = fs.readFileSync(ctx.profilePath, 'utf8');
  const chipsBefore = p.chips;
  // Entra "a mano": boleto pendiente en el diario + save, sin tocar el perfil.
  const round = ctx.service._openRound(ctx.league(), jornada);
  round.tickets.p = { profileId: 'p', picks, placedAt: ctx.now(), status: 'pending_debit', payout: 0 };
  await ctx.store.saveStrict();
  // Recarga ambos stores desde disco: el perfil vuelve al estado congelado.
  const store2 = new FootballStore(ctx.storePath);
  const profiles2 = new ProfileStore(ctx.profilePath);
  t.after(() => clearTimeout(profiles2.saveTimer));
  const league2 = store2.getLeague(ctx.month);
  const p2 = profiles2.getProfile('p');
  assert.equal(p2.chips, chipsBefore);
  const service2 = new QuinielaService({ store: store2, profiles: profiles2, log: () => {}, now: ctx.now, enabled: true });
  const recovered = await service2.recoverWallet(league2);
  assert.equal(recovered, 1);
  assert.equal(p2.chips, chipsBefore - 50);
  assert.equal(league2.quiniela.rounds[jornada].tickets.p.status, 'open');
  // Segunda pasada: nada que recuperar (idempotente por operationId).
  const recovered2 = await service2.recoverWallet(league2);
  assert.equal(recovered2, 0);
  assert.equal(p2.chips, chipsBefore - 50);
  // Premio pendiente de cobrar tras crash: boleto asentado como ganador pero el
  // crédito nunca llegó al perfil.
  settleJornada({ league: () => league2 }, jornada, 'home');
  const round2 = league2.quiniela.rounds[jornada];
  round2.tickets.p.status = 'won'; round2.tickets.p.payout = 50;
  league2.quiniela.bank.carry = 0;
  round2.status = 'settled'; round2.result = { status: 'settled', pot: 50, winners: 1, carry: 0, entries: 1, settledAt: ctx.now() };
  await store2.saveStrict();
  fs.writeFileSync(ctx.profilePath, frozenProfiles); // perfil sin el premio
  const profiles3 = new ProfileStore(ctx.profilePath);
  t.after(() => clearTimeout(profiles3.saveTimer));
  const service3 = new QuinielaService({ store: store2, profiles: profiles3, log: () => {}, now: ctx.now, enabled: true });
  const p3 = profiles3.getProfile('p');
  const before3 = p3.chips;
  assert.equal(await service3.recoverWallet(league2), 1);
  assert.equal(p3.chips, before3 + 50);
  assert.equal(await service3.recoverWallet(league2), 0);
  assert.equal(p3.chips, before3 + 50);
});

test('sweep: liquida la jornada completa y no repite; notifyMatch liquida al asentarse', async (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  const p = ctx.profiles.getOrCreate('p', 'P');
  const chips = p.chips;
  await ctx.service.enter({ league: ctx.league(), jornada, profile: p, picks: picksFor(ctx.league(), jornada) });
  // Aún no está completa: sweep no liquida.
  let sweep = await ctx.service.sweep(ctx.now());
  assert.equal(sweep.settled.length, 0);
  settleJornada(ctx, jornada, 'home');
  sweep = await ctx.service.sweep(ctx.now());
  assert.deepEqual(sweep.settled, [{ jornada, status: 'settled' }]);
  assert.equal(p.chips, chips); // 50 entrada + 50 premio (único ganador se lleva el bote)
  const again = await ctx.service.sweep(ctx.now());
  assert.equal(again.settled.length, 0);
  assert.equal(p.chips, chips);
  // notifyMatch sobre un partido ya asentado también liquida (idempotente).
  const m = ctx.league().calendar.jornadas.find(j => j.jornada === jornada).matches[0];
  await ctx.service.notifyMatch({ ...m, seasonMonth: ctx.month });
  assert.equal(p.chips, chips);
});
