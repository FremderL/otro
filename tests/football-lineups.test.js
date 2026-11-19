'use strict';

// El once titular publicado en La Previa.
//
// Lo que se prueba es la garantía que pidió el usuario: que el once que ve antes
// del partido sea el mismo que el motor va a alinear. Por eso hay dos fuentes y
// las dos se comparan contra la verdad del motor:
//   · con compromiso V2 → el once ES el congelado en `match.simulation.inputs`;
//   · sin compromiso   → el once ES `createTeamLineup` con la pizarra resuelta
//     del DT (la misma precedencia que lib/football/v2/inputs.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { ProfileStore } = require('../lib/profile-store');
const { matchLineups } = require('../lib/football/lineups');
const { createTeamLineup } = require('../lib/football/match-state');
const { resolveClubTactics } = require('../lib/football/managers');
const { makeCommitment } = require('../lib/football/v2/commitment');
const { current: CURRENT_SIMULATOR } = require('../lib/football/v2/versions');
const { buildPregameScript, startersOf } = require('../lib/football/pregame');
const { MAX_LEN } = require('../lib/football/commentary');
const { registerFootballSockets } = require('../lib/football/sockets');
const { createBettingService } = require('../lib/football/betting');

function makeIo() {
  const emitted = [];
  const connectionHandlers = [];
  return {
    emitted,
    on(event, cb) { if (event === 'connection') connectionHandlers.push(cb); },
    to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; },
    connect(socket) { connectionHandlers.forEach(cb => cb(socket)); return socket; }
  };
}

function makeSocket() {
  const handlers = {};
  const socket = {
    id: 'sock_' + Math.random().toString(36).slice(2, 9), data: {}, rooms: new Set(), sent: [],
    on(event, cb) { handlers[event] = cb; },
    join(room) { socket.rooms.add(room); },
    leave(room) { socket.rooms.delete(room); },
    emit(event, payload) { socket.sent.push({ event, payload }); },
    fire(event, payload) {
      let captured;
      handlers[event](payload, res => { captured = res; });
      return captured;
    }
  };
  return socket;
}

// Motor de mentira: la consulta del once no lo usa, pero `registerFootballSockets`
// se suscribe a sus eventos al montar.
function emptyEngine() {
  return { on() {}, off() {}, emit() {}, deriveMatchState() { return null; } };
}

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'once-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  const season = store.getCurrentSeasonMonth();
  store.generateSeason(season);
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { profiles.saveNow(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, profiles, season };
}

test('el once proyectado es el mismo que alinearía el motor: 11 titulares con slot 0..10', t => {
  const { store, season } = temporaryStore(t);
  const match = store.getMatches(season).find(item => item.status === 'scheduled');
  assert.ok(match, 'la temporada sembrada tiene partidos programados');
  const view = matchLineups(store, match, Date.now());
  assert.ok(view, 'el once se resuelve');
  assert.equal(view.source, 'projected', 'sin compromiso preparado el once es una proyección');
  assert.equal(view.matchId, match.id);
  for (const side of ['home', 'away']) {
    const team = view[side];
    assert.equal(team.starters.length, 11, `${side}: once completo`);
    const slots = team.starters.map(player => player.slotIndex).sort((a, b) => a - b);
    assert.deepEqual(slots, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], `${side}: un hueco por slot, sin repetidos`);
    assert.equal(team.starters[0].role, 'GK', `${side}: el slot 0 es el portero`);
    const ids = new Set(team.starters.map(player => player.id));
    assert.equal(ids.size, 11, `${side}: nadie está dos veces`);
    for (const player of team.starters) {
      assert.ok(player.name && player.name.length > 1, `${side}: todo titular tiene nombre`);
      assert.ok(Number.isFinite(player.number), `${side}: todo titular tiene dorsal`);
      assert.ok(player.pos, `${side}: todo titular tiene puesto natural`);
    }
    assert.ok(team.bench.length >= 1, `${side}: el banquillo se publica aparte`);
    for (const player of team.bench) assert.ok(!ids.has(player.id), `${side}: nadie es titular y suplente`);
  }
  // La comprobación que importa: mismos ids que el motor, con su pizarra resuelta.
  const league = store.getLeague(season);
  const club = league.config.find(c => c.id === match.homeId);
  const resolved = resolveClubTactics(club, league, Date.now());
  const engine = createTeamLineup({
    ...club, tactics: { formation: resolved.formation, style: resolved.style }, manager: resolved.manager
  });
  assert.deepEqual(
    view.home.starters.map(p => p.id),
    engine.players.filter(p => p.initialStatus === 'active').sort((a, b) => a.slotIndex - b.slotIndex).map(p => p.id)
  );
  assert.equal(view.home.formation, engine.formation);
});

test('con compromiso V2 el once es el congelado y no cambia aunque cambie el plantel', t => {
  const { store, season } = temporaryStore(t);
  const match = store.getMatches(season).find(item => item.status === 'scheduled');
  const league = store.getLeague(season);
  const home = league.config.find(c => c.id === match.homeId);
  const away = league.config.find(c => c.id === match.awayId);
  const homeLineup = createTeamLineup({ ...home, tactics: home.tactics, manager: home.manager });
  const awayLineup = createTeamLineup({ ...away, tactics: away.tactics, manager: away.manager });
  match.simulation = makeCommitment({
    version: CURRENT_SIMULATOR.VERSION, seed: 'a'.repeat(64), asOf: Date.now(),
    home: { id: home.id, lineup: homeLineup }, away: { id: away.id, lineup: awayLineup },
    source: { currentSeason: season }
  }, 'b'.repeat(64), Date.now());

  const before = matchLineups(store, match, Date.now());
  assert.equal(before.source, 'commitment');
  const frozen = match.simulation.inputs.home.lineup.players
    .filter(p => p.initialStatus === 'active').sort((a, b) => a.slotIndex - b.slotIndex).map(p => p.id);
  assert.deepEqual(before.home.starters.map(p => p.id), frozen, 'el once publicado es el del compromiso');

  // Un fichaje posterior (plantel distinto) no puede alterar la previa.
  home.squad = home.squad.slice(0, 12);
  const after = matchLineups(store, match, Date.now());
  assert.deepEqual(after.home.starters.map(p => p.id), frozen, 'el compromiso congela el once');
});

test('un compromiso dañado no se publica como si fuera la previa del partido', t => {
  const { store, season } = temporaryStore(t);
  const match = store.getMatches(season).find(item => item.status === 'scheduled');
  const league = store.getLeague(season);
  const home = league.config.find(c => c.id === match.homeId);
  const away = league.config.find(c => c.id === match.awayId);
  match.simulation = makeCommitment({
    version: CURRENT_SIMULATOR.VERSION, seed: 'a'.repeat(64), asOf: Date.now(),
    home: { id: home.id, lineup: createTeamLineup(home) },
    away: { id: away.id, lineup: createTeamLineup(away) },
    source: { currentSeason: season }
  }, 'c'.repeat(64), Date.now());
  match.simulation.inputsHash = 'f'.repeat(64); // huella rota
  const view = matchLineups(store, match, Date.now());
  assert.equal(view.source, 'projected', 'sin compromiso válido se cae a la proyección del DT');
});

test('sin liga o sin clubes no hay once: nunca se inventa una alineación', t => {
  const { store, season } = temporaryStore(t);
  const match = store.getMatches(season).find(item => item.status === 'scheduled');
  assert.equal(matchLineups({ getLeague: () => null }, match, Date.now()), null);
  assert.equal(matchLineups(store, { ...match, homeId: 'club_inexistente' }, Date.now()), null);
  assert.equal(matchLineups(store, null, Date.now()), null);
});

test('la cabina nombra a titulares reales y respeta los 140 caracteres', t => {
  const { store, season } = temporaryStore(t);
  const match = store.getMatches(season).find(item => item.status === 'scheduled');
  const league = store.getLeague(season);
  const home = league.config.find(c => c.id === match.homeId);
  const away = league.config.find(c => c.id === match.awayId);
  const lines = buildPregameScript({
    match, league, home, away, homeRow: null, awayRow: null,
    homePosition: null, awayPosition: null, market: null, asOf: Date.now()
  });
  const xi = startersOf(home, league, Date.now());
  assert.ok(xi && xi.starters.length === 11);
  const mention = lines.find(line => line.text.startsWith('El once de'));
  assert.ok(lines.some(line => line.text.startsWith('También juega')), 'la cabina nombra también al visitante');
  assert.ok(mention, 'la cabina habla del once');
  assert.ok(mention.text.length <= MAX_LEN, 'la línea cabe en el límite del relato');
  assert.ok(mention.text.includes(xi.starters[0].name), 'cita al portero de verdad');
  assert.ok(mention.text.includes(xi.formation), 'cita la formación que se va a jugar');
  // El nombre completo que entra nunca queda cortado a mitad.
  for (const player of xi.starters) {
    const index = mention.text.indexOf(player.name);
    if (index < 0) continue;
    const following = mention.text[index + player.name.length];
    assert.ok(following == null || following === ' ' || following === ',', `nombre completo: ${player.name}`);
  }
});

test('football:lineups_get exige identidad y devuelve el once del partido pedido', t => {
  const { store, profiles, season } = temporaryStore(t);
  const io = makeIo();
  const betting = createBettingService({ store, profiles, now: () => Date.now(), log: () => {} });
  const sockets = registerFootballSockets(io, {
    store, profiles, betting, engine: emptyEngine(),
    config: { matchCapacity: 40, lobbyCapacity: 200 },
    log: () => {}, now: () => Date.now(),
    verifyTosAcceptance: () => true,
    nameIssue: () => null
  });
  t.after(() => { try { sockets.stop(); } catch (_) {} });
  const socket = io.connect(makeSocket());

  const anonymous = socket.fire('football:lineups_get', { matchId: store.getMatches(season)[0].id });
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.code, 'no_identity');

  const match = store.getMatches(season).find(item => item.status === 'scheduled');
  const identity = socket.fire('football:subscribe', { scope: 'match', matchId: match.id, token: 'token-once', tos: 'v1' });
  assert.equal(identity.ok, true, 'la suscripción resuelve identidad');

  const res = socket.fire('football:lineups_get', { matchId: match.id });
  assert.equal(res.ok, true);
  assert.equal(res.lineups.matchId, match.id);
  assert.equal(res.lineups.home.starters.length, 11);
  assert.equal(res.lineups.away.starters.length, 11);
  assert.equal(res.lineups.home.clubId, match.homeId);
  assert.equal(res.lineups.away.clubId, match.awayId);

  const missing = socket.fire('football:lineups_get', { matchId: '' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'match_required');
  const unknown = socket.fire('football:lineups_get', { matchId: 'm_inexistente' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'no_match');
});
