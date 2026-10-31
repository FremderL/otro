'use strict';

// §34 — Historial de apuestas y pagos acreditados.
//
// Cubre el caso que motiva la función: un jugador apuesta, cierra el navegador y
// vuelve cuando el partido YA terminó. El servidor liquida solo (sin sockets ni
// presencia), las fichas quedan en su perfil persistido y, al entrar, ve todas sus
// apuestas del Estadio con el resultado del partido y el pago acreditado.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { createBettingService } = require('../lib/football/betting');
const { installFootballRoutes } = require('../lib/football/http');
const { monthKey } = require('../lib/football-store-shared');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhist-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const month = monthKey();
  store.generateSeason(month);
  const profilesPath = path.join(dir, 'profiles.json');
  const profiles = new ProfileStore(profilesPath);
  const alice = profiles.getOrCreate('alice', 'Alicia', null);
  alice.chips = 1000;
  const bob = profiles.getOrCreate('bob', 'Beto', null);
  bob.chips = 1000;
  profiles.saveNow();
  const match = store.getMatches(month).find(m => m.status === 'scheduled');
  const betting = createBettingService({ store, profiles, now: () => Math.min(...store.getMatches(month).map(item => item.scheduledKickoffAt)) - 60000, log: () => {} });
  const cleanup = () => {
    try { store.close(); } catch (_) {}
    try { profiles.saveNow(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, profiles, profilesPath, alice, bob, betting, match, month, cleanup };
}

// Simula lo que hace el motor al pitazo final: asienta el partido y liquida.
function finishMatch(h, score) {
  h.store.settleMatch(h.match.id, score, { seasonMonth: h.month, now: 5000 });
  const settled = h.store.getMatch(h.match.id);
  return h.betting.settleMatchBets(settled, score);
}

test('el historial muestra apuestas liquidadas con resultado, pago y resumen', async t => {
  const h = setup(); t.after(h.cleanup);

  const win = await h.betting.placeBet({ profile: h.alice, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  const lose = await h.betting.placeBet({ profile: h.alice, matchId: h.match.id, market: 'btts', selection: 'yes', stake: 100, placedAt: 1100 });
  assert.strictEqual(win.ok, true, win.code);
  assert.strictEqual(lose.ok, true, lose.code);
  assert.strictEqual(h.alice.chips, 800, 'el stake salió al apostar');

  const settled = finishMatch(h, { home: 2, away: 0 });
  assert.ok(settled.settled >= 2, 'el motor liquidó ambas apuestas sin nadie conectado');
  assert.ok(h.alice.chips > 800, 'el premio se acreditó al perfil');

  const history = h.betting.getBetHistory('alice', { limit: 20 });
  assert.strictEqual(history.entries.length, 2);
  const byId = new Map(history.entries.map(e => [e.id, e]));
  const wonEntry = byId.get(win.bet.id);
  const lostEntry = byId.get(lose.bet.id);

  assert.strictEqual(wonEntry.status, 'won');
  assert.ok(wonEntry.payout > 0, 'la apuesta ganadora guarda el pago');
  assert.strictEqual(wonEntry.match.result.home, 2, 'el historial trae el resultado final');
  assert.strictEqual(wonEntry.match.result.away, 0);
  assert.strictEqual(lostEntry.status, 'lost');
  assert.strictEqual(lostEntry.payout, 0);

  assert.strictEqual(history.summary.total, 2);
  assert.strictEqual(history.summary.staked, 200);
  assert.strictEqual(history.summary.returned, wonEntry.payout);
  assert.strictEqual(history.summary.net, wonEntry.payout - 200);
  assert.strictEqual(history.summary.byStatus.won, 1);
  assert.strictEqual(history.summary.byStatus.lost, 1);
  assert.strictEqual(history.summary.open, 0);
});

test('el pago sobrevive a un reinicio: quien entra después encuentra sus fichas', async t => {
  const h = setup(); t.after(h.cleanup);

  await h.betting.placeBet({ profile: h.alice, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  finishMatch(h, { home: 1, away: 0 });
  const chipsAfterSettlement = h.alice.chips;
  assert.ok(chipsAfterSettlement > 900);

  // «Vuelve al sitio otro día»: se relee el perfil desde disco.
  h.profiles.saveNow();
  const reloaded = new ProfileStore(h.profilesPath);
  const alice = reloaded.getProfile('alice');
  assert.strictEqual(alice.chips, chipsAfterSettlement, 'el pago quedó persistido sin sesión activa');

  const history = h.betting.getBetHistory('alice', { limit: 20 });
  assert.strictEqual(history.entries[0].status, 'won');
  assert.ok(history.entries[0].settledAt, 'el historial conserva cuándo se pagó');
});

test('unseen resume lo que se liquidó mientras el jugador no estaba', async t => {
  const h = setup(); t.after(h.cleanup);

  await h.betting.placeBet({ profile: h.alice, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  finishMatch(h, { home: 3, away: 1 });

  // `since` anterior a la liquidación ⇒ aparece como no visto.
  const fresh = h.betting.getBetHistory('alice', { since: 1 });
  assert.ok(fresh.unseen, 'hay pagos nuevos');
  assert.strictEqual(fresh.unseen.count, 1);
  assert.ok(fresh.unseen.credited > 0);
  assert.strictEqual(fresh.unseen.throughAt, fresh.entries[0].settledAt);

  // `since` posterior ⇒ nada nuevo que avisar.
  const later = h.betting.getBetHistory('alice', { since: Date.now() + 60000 });
  assert.strictEqual(later.unseen, null);
  assert.strictEqual(later.entries.length, 1, 'el historial sigue estando completo');
});

test('el historial incluye combinadas y liquida sus patas por separado', async t => {
  const h = setup(); t.after(h.cleanup);
  const matches = h.store.getMatches(h.month).filter(m => m.status === 'scheduled').slice(0, 2);

  const parlay = await h.betting.placeParlay({
    profile: h.alice,
    legs: [
      { matchId: matches[0].id, market: '1x2', selection: 'home' },
      { matchId: matches[1].id, market: '1x2', selection: 'home' }
    ],
    stake: 100,
    placedAt: 1000
  });
  assert.strictEqual(parlay.ok, true, parlay.code);

  h.store.settleMatch(matches[0].id, { home: 2, away: 0 }, { seasonMonth: h.month, now: 5000 });
  h.betting.settleMatchBets(h.store.getMatch(matches[0].id), { home: 2, away: 0 });
  h.store.settleMatch(matches[1].id, { home: 0, away: 1 }, { seasonMonth: h.month, now: 5001 });
  h.betting.settleMatchBets(h.store.getMatch(matches[1].id), { home: 0, away: 1 });

  const history = h.betting.getBetHistory('alice', { limit: 20 });
  const entry = history.entries.find(e => e.kind === 'parlay');
  assert.ok(entry, 'la combinada aparece en el historial');
  assert.strictEqual(entry.status, 'lost');
  assert.strictEqual(entry.legs.length, 2);
  assert.deepStrictEqual(entry.legs.map(l => l.status).sort(), ['lost', 'won']);
  assert.strictEqual(history.summary.staked, 100);
  assert.strictEqual(history.summary.returned, 0);
});

test('el historial está aislado por perfil', async t => {
  const h = setup(); t.after(h.cleanup);
  await h.betting.placeBet({ profile: h.alice, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  const bobHistory = h.betting.getBetHistory('bob');
  assert.strictEqual(bobHistory.entries.length, 0);
  assert.strictEqual(bobHistory.summary.total, 0);
  const anonym = h.betting.getBetHistory(null);
  assert.deepStrictEqual(anonym.entries, []);
});

// --- Ruta HTTP (la usa el cliente al entrar, sin socket) ---

function makeApp(betting, profiles) {
  const routes = {};
  const app = {
    get(p, ...h) { routes['GET ' + p] = h; },
    post(p, ...h) { routes['POST ' + p] = h; },
    run(method, p, { params = {}, query = {} } = {}) {
      const handlers = routes[method + ' ' + p];
      if (!handlers) throw new Error('ruta no registrada: ' + method + ' ' + p);
      const req = { params, query, body: {}, get: () => undefined };
      const res = {
        statusCode: 200, body: null, headers: {}, _done: false,
        status(c) { res.statusCode = c; return res; },
        json(b) { res.body = b; res._done = true; return res; },
        set(k, v) { res.headers[k] = v; return res; }
      };
      let i = 0;
      const next = () => { if (res._done) return; const h = handlers[i++]; if (h) h(req, res, next); };
      next();
      return res;
    }
  };
  installFootballRoutes(app, { store: null, profiles, betting, enabled: () => true, log: () => {} });
  return app;
}

test('GET /api/estadio/my-bets exige identidad y devuelve el historial del perfil', async t => {
  const h = setup(); t.after(h.cleanup);
  await h.betting.placeBet({ profile: h.alice, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  finishMatch(h, { home: 1, away: 0 });

  const app = makeApp(h.betting, h.profiles);

  const anonymous = app.run('GET', '/api/estadio/my-bets');
  assert.strictEqual(anonymous.statusCode, 401);
  assert.strictEqual(anonymous.body.code, 'no_identity');

  const owner = app.run('GET', '/api/estadio/my-bets', { query: { token: 'alice', limit: '10' } });
  assert.strictEqual(owner.statusCode, 200);
  assert.strictEqual(owner.body.ok, true);
  assert.strictEqual(owner.body.history.entries.length, 1);
  assert.strictEqual(owner.body.history.entries[0].status, 'won');
  assert.strictEqual(owner.body.history.entries[0].match.result.home, 1);
  assert.ok(owner.body.profile.chips > 0, 'devuelve el saldo ya actualizado');
  assert.strictEqual(owner.headers['Cache-Control'], 'no-store');

  const stranger = app.run('GET', '/api/estadio/my-bets', { query: { token: 'bob' } });
  assert.strictEqual(stranger.body.history.entries.length, 0, 'nadie ve apuestas ajenas');
  assert.strictEqual(stranger.body.history.summary.total, 0);

  const unknown = app.run('GET', '/api/estadio/my-bets', { query: { token: 'no-existe' } });
  assert.strictEqual(unknown.statusCode, 401, 'un token inventado nunca resuelve identidad');
});

test('GET /api/estadio/my-bets acepta `since` para avisar de pagos nuevos', async t => {
  const h = setup(); t.after(h.cleanup);
  await h.betting.placeBet({ profile: h.alice, matchId: h.match.id, market: '1x2', selection: 'home', stake: 100, placedAt: 1000 });
  finishMatch(h, { home: 2, away: 2 });
  const app = makeApp(h.betting, h.profiles);

  const res = app.run('GET', '/api/estadio/my-bets', { query: { token: 'alice', since: '1' } });
  assert.ok(res.body.history.unseen, 'hay liquidaciones posteriores al instante indicado');
  assert.strictEqual(res.body.history.unseen.count, 1);
  assert.ok(res.body.history.unseen.throughAt > 0);
});
