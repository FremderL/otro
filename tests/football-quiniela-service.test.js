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

test('refundMatchObligations cancela jornada, reembolsa una vez y puede reintentarse', async (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const profile = ctx.profiles.getOrCreate('p1', 'Ana');
  const balance = profile.chips;
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  const picks = picksFor(ctx.league(), jornada);
  assert.equal((await ctx.service.enter({ league: ctx.league(), jornada, profile, picks })).ok, true);
  assert.equal(profile.chips, balance - ENTRY_COST);
  const match = ctx.store.getMatches(ctx.month).find(item => item.jornada === jornada);

  const persistProfile = ctx.profiles.persistProfile.bind(ctx.profiles);
  ctx.profiles.persistProfile = async () => false;
  const pending = await ctx.service.refundMatchObligations(match, 'compromiso corrupto');
  assert.equal(pending.ok, false, 'no confirma el reembolso si no confirmó la cartera');
  assert.equal(profile.chips, balance);
  assert.equal(ctx.league().quiniela.rounds[jornada].status, 'cancelled');
  assert.equal(ctx.league().quiniela.rounds[jornada].tickets.p1.status, 'refunded');
  assert.equal(ctx.league().quiniela.rounds[jornada].tickets.p1.payout, ENTRY_COST);

  ctx.profiles.persistProfile = persistProfile;
  const retry = await ctx.service.refundMatchObligations(match, 'reintento seguro');
  assert.equal(retry.ok, true);
  assert.equal(profile.chips, balance, 'el mismo operationId no duplica el reembolso');
  ctx.store.close();
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
  // El bote vive en el store, no en la liga: así sobrevive a la rotación de mes.
  assert.equal(ctx.store.quinielaCarry, 50);
});

test('postergación sin resultado reembolsa la entrada y conserva el acumulado', async (t) => {
  const ctx = setup(); t.after(ctx.cleanup);
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  const p = ctx.profiles.getOrCreate('p', 'P');
  const chips = p.chips;
  await ctx.service.enter({ league: ctx.league(), jornada, profile: p, picks: picksFor(ctx.league(), jornada) });
  ctx.store.quinielaCarry = 70;
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
  store2.quinielaCarry = 0;
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
  assert.deepEqual(sweep.settled, [{ season: ctx.month, jornada, status: 'settled' }]);
  assert.equal(p.chips, chips); // 50 entrada + 50 premio (único ganador se lleva el bote)
  const again = await ctx.service.sweep(ctx.now());
  assert.equal(again.settled.length, 0);
  assert.equal(p.chips, chips);
  // notifyMatch sobre un partido ya asentado también liquida (idempotente).
  const m = ctx.league().calendar.jornadas.find(j => j.jornada === jornada).matches[0];
  await ctx.service.notifyMatch({ ...m, seasonMonth: ctx.month });
  assert.equal(p.chips, chips);
});

// --- Bote entre temporadas y liquidación al rotar el mes ---------------------

// Igual que setup(), pero con reloj y mes controlados para cruzar de temporada.
function setupIn(dir, month, at) {
  const storePath = path.join(dir, 'football.json');
  const profilePath = path.join(dir, 'profiles.json');
  const store = new FootballStore(storePath);
  store.generateSeason(month);
  const profiles = new ProfileStore(profilePath);
  let nowVal = at;
  const service = new QuinielaService({ store, profiles, log: () => {}, now: () => nowVal, enabled: true });
  return {
    store, profiles, month, service,
    league: () => store.getLeague(month),
    setNow: v => { nowVal = v; },
    now: () => nowVal
  };
}

test('el bote sin acertantes pasa a la temporada siguiente y sobrevive a la rotación', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fquin-ycarry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const NOV = '2026-11';
  const DEC = '2026-12';
  const nov = setupIn(dir, NOV, Date.UTC(2026, 10, 2, 6));
  const profile = nov.profiles.getOrCreate('sin-aciertos', 'Sin aciertos');
  const jornada = nov.service.snapshot(nov.league(), null, nov.now()).jornada;
  const entry = await nov.service.enter({
    league: nov.league(), jornada, profile,
    picks: picksFor(nov.league(), jornada, 'home')
  });
  assert.equal(entry.ok, true);
  // Los ocho partidos terminan en empate: nadie firma «home».
  for (const m of nov.league().calendar.jornadas.find(j => j.jornada === jornada).matches) {
    m.status = 'settled'; m.result = { home: 0, away: 0, winner: 'draw' };
  }
  assert.equal((await nov.service.settleJornada(nov.league(), jornada)).carry, ENTRY_COST);
  assert.equal(nov.store.quinielaCarry, ENTRY_COST);

  // El mes rota: la temporada nueva debe arrancar con ese bote, no en cero.
  nov.store.generateSeason(DEC);
  nov.setNow(Date.UTC(2026, 11, 2, 6));
  const decLeague = nov.store.getLeague(DEC);
  const decSnap = nov.service.snapshot(decLeague, null, nov.now());
  assert.equal(decSnap.carry, ENTRY_COST, 'el acumulado de noviembre viaja a diciembre');

  // Y el sobrante de una jornada con tres acertantes tampoco se inventa ni se pierde.
  const j2 = decSnap.jornada;
  const players = ['a1', 'a2', 'a3'].map(id => nov.profiles.getOrCreate(id, id));
  const picks = picksFor(decLeague, j2, 'home');
  for (const p of players) assert.equal((await nov.service.enter({ league: decLeague, jornada: j2, profile: p, picks })).ok, true);
  for (const m of decLeague.calendar.jornadas.find(j => j.jornada === j2).matches) {
    m.status = 'settled'; m.result = { home: 3, away: 0, winner: 'home' };
  }
  const out = await nov.service.settleJornada(decLeague, j2);
  assert.equal(out.pot, ENTRY_COST + 3 * ENTRY_COST);
  assert.equal(out.winners, 3);
  assert.equal(out.carry, out.pot - 3 * Math.floor(out.pot / 3));
  assert.equal(nov.store.quinielaCarry, out.carry);
});

test('una jornada que queda abierta cuando rota el mes se liquida igual (no se congela)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fquin-rotate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const JAN = '2027-01';
  const FEB = '2027-02';
  const ctx = setupIn(dir, JAN, Date.UTC(2027, 0, 2, 6));
  const profile = ctx.profiles.getOrCreate('colgado', 'Colgado');
  const chipsBefore = profile.chips;
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  assert.equal((await ctx.service.enter({
    league: ctx.league(), jornada, profile, picks: picksFor(ctx.league(), jornada, 'home')
  })).ok, true);
  for (const m of ctx.league().calendar.jornadas.find(j => j.jornada === jornada).matches) {
    m.status = 'settled'; m.result = { home: 1, away: 0, winner: 'home' };
  }
  // La rotación llega antes de que el barrido alcance a liquidar la jornada.
  ctx.store.generateSeason(FEB);
  ctx.store.closeSeason(JAN);

  const sweep = await ctx.service.sweep(Date.UTC(2027, 1, 2, 6));
  assert.deepEqual(sweep.settled, [{ season: JAN, jornada, status: 'settled' }]);
  const round = ctx.league().quiniela.rounds[jornada];
  assert.equal(round.status, 'settled');
  assert.equal(round.tickets[profile.id].status, 'won');
  // Único acertante: recupera la entrada y se lleva el bote.
  assert.equal(profile.chips, chipsBefore);
  // Segunda vuelta: nada que repetir.
  assert.deepEqual((await ctx.service.sweep(Date.UTC(2027, 1, 2, 7))).settled, []);
});

test('arranque: adopta el bote que versiones anteriores guardaban dentro de la liga', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fquin-adopt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const month = '2026-12';
  const ctx = setupIn(dir, month, Date.UTC(2026, 11, 2, 6));
  // Diario con formato viejo: el bote viajaba dentro de la temporada.
  const league = ctx.league();
  league.quiniela = { bank: { carry: 120 }, rounds: {} };
  ctx.store.quinielaCarry = 30;
  await ctx.store.saveStrict();

  const recovered = await ctx.service.recover();
  assert.equal(recovered.adoptedCarry, 150, 'suma el bote del store y el heredado de la liga');
  assert.equal(ctx.store.quinielaCarry, 150);
  assert.equal(ctx.league().quiniela.bank.carry, 0, 'el diario deja de ser la fuente');
  // Idempotente: un segundo arranque no vuelve a sumar.
  assert.equal((await ctx.service.recover()).adoptedCarry, 0);
  assert.equal(ctx.store.quinielaCarry, 150);
});

test('coste: el barrido no reescribe la liga cuando no hay nada que liquidar', async (t) => {
  // Regresión de consumo: cada vuelta programaba un guardado aunque no hubiera
  // cambios, y el store reescribe la liga completa (~650 KB en un mes con su
  // calendario). Con el barrido cada minuto eso era disco y CPU tirados; en
  // PostgreSQL, además, reescribir las 240 filas de partidos sin motivo.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fquin-coste-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const NOV = '2026-11';
  const ctx = setupIn(dir, NOV, Date.UTC(2026, 10, 2, 6));

  // Sin rondas abiertas: nada que hacer.
  let writes = 0;
  const serialize = ctx.store._serializeLeague.bind(ctx.store);
  ctx.store._serializeLeague = league => { writes += 1; return serialize(league); };
  for (let i = 0; i < 5; i += 1) await ctx.service.sweep(Date.UTC(2026, 10, 2, 7 + i));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(writes, 0, 'un barrido sin trabajo no toca el disco');

  // Con una jornada pendiente en un mes ya cerrado: liquida y guarda una vez.
  const profile = ctx.profiles.getOrCreate('pendiente', 'Pendiente');
  const jornada = ctx.service.snapshot(ctx.league(), null, ctx.now()).jornada;
  await ctx.service.enter({ league: ctx.league(), jornada, profile, picks: picksFor(ctx.league(), jornada) });
  ctx.store.generateSeason('2026-12');
  ctx.store.closeSeason(NOV);
  for (const m of ctx.league().calendar.jornadas.find(j => j.jornada === jornada).matches) {
    m.status = 'settled'; m.result = { home: 2, away: 0, winner: 'home' };
  }
  writes = 0;
  const first = await ctx.service.sweep(Date.UTC(2026, 11, 2, 6));
  assert.equal(first.settled.length, 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  const afterSettle = writes;
  assert.ok(afterSettle >= 1, 'la liquidación sí se persiste');
  // Y una vez liquidada, las vueltas siguientes vuelven a costar cero.
  writes = 0;
  for (let i = 0; i < 3; i += 1) await ctx.service.sweep(Date.UTC(2026, 11, 2, 7 + i));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(writes, 0, 'liquidada la deuda, el barrido deja de escribir');
});
