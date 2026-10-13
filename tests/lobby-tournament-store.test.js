'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileLobbyTournamentStore, PgLobbyTournamentStore } = require('../lib/lobby-tournament-store');
const { LobbyTournamentManager } = require('../lib/lobby-tournaments');
const { cleanProfile } = require('../lib/profile-store-shared');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobby-tournament-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeEntrants(event, count = event.capacity) {
  return Array.from({ length: count }, (_, index) => ({
    profileId: `${event.id}-profile-${index + 1}`,
    name: `Jugador ${index + 1}`,
    avatar: 'fox',
    socketId: `socket-${index + 1}`
  }));
}

function fill(manager, event) {
  for (const participant of makeEntrants(event)) {
    const response = manager.register(event.id, participant, event.startAt - 1000);
    assert.equal(response.ok, true, response.error);
  }
}

test('JSON atómico conserva el estado del calendario y los brackets', async t => {
  const filePath = path.join(temporaryDirectory(t), 'lobby-tournaments.json');
  const store = new FileLobbyTournamentStore(filePath);
  const state = {
    version: 1,
    timeZone: 'America/Mexico_City',
    events: [{ id: 'flash-1-8', capacity: 8, status: 'registration', registered: [], rounds: [] }]
  };
  await store.save(state);
  await store.close();

  const restored = new FileLobbyTournamentStore(filePath);
  assert.deepEqual(restored.getState(), state);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false, 'el guardado atómico no deja un temporal');
});

class FakeTournamentPool {
  static data = null;
  constructor() { this.ended = false; }
  on() {}
  async query(sql, values = []) {
    const statement = String(sql);
    if (/CREATE TABLE/i.test(statement)) return { rows: [] };
    if (/INSERT INTO montecristo_lobby_tournament_state/i.test(statement)) {
      if (/DO NOTHING/i.test(statement)) {
        if (!FakeTournamentPool.data) FakeTournamentPool.data = JSON.parse(values[0]);
      } else FakeTournamentPool.data = JSON.parse(values[0]);
      return { rows: [] };
    }
    if (/SELECT data FROM montecristo_lobby_tournament_state/i.test(statement)) {
      return { rows: FakeTournamentPool.data ? [{ data: structuredClone(FakeTournamentPool.data) }] : [] };
    }
    throw new Error(`Consulta inesperada: ${statement}`);
  }
  async end() { this.ended = true; }
}

test('Postgres persiste y rehidrata el bracket mediante el store compartido', async () => {
  FakeTournamentPool.data = null;
  const first = new PgLobbyTournamentStore('postgres://fixture', { Pool: FakeTournamentPool });
  await first.ready;
  const state = {
    version: 1,
    timeZone: 'America/Mexico_City',
    events: [{ id: 'flash-2-16', capacity: 16, status: 'full', registered: [], rounds: [] }]
  };
  await first.save(state);
  await first.close();

  const second = new PgLobbyTournamentStore('postgres://fixture', { Pool: FakeTournamentPool });
  await second.ready;
  assert.deepEqual(second.getState(), state);
  await second.close();
});

test('al reiniciar se conservan inscripciones, pero las mesas efímeras se recrean sin sockets antiguos', () => {
  const initialTime = Date.parse('2026-10-12T17:00:00Z');
  const manager = new LobbyTournamentManager({ now: () => initialTime, timeZone: 'America/Mexico_City' });
  const event = [...manager.events.values()].find(item => item.capacity === 8 && !item.featured);
  fill(manager, event);
  manager.startDue(event.startAt);
  const runningMatch = event.rounds[0].matches[0];
  assert.equal(manager.markMatchStarted(event.id, runningMatch.id, 'ABCDE'), true);

  const stored = manager.serialize();
  assert.ok(stored.events.find(item => item.id === event.id).registered.every(item => !item.socketId && !item.online),
    'el snapshot no persiste ids de sockets ni presencia efímera');
  const restored = new LobbyTournamentManager({
    now: () => event.startAt + 1000,
    timeZone: 'America/Mexico_City',
    snapshot: stored
  });
  const resumed = restored.get(event.id);
  assert.equal(resumed.status, 'in_progress');
  assert.equal(resumed.registered.length, 8, 'se conservan las inscripciones');
  assert.ok(resumed.registered.every(item => item.socketId === null && item.online === false));
  assert.equal(resumed.rounds[0].matches[0].status, 'pending');
  assert.equal(resumed.rounds[0].matches[0].roomCode, null);
  assert.equal(restored.pendingMatches(event.id).length, 4, 'el scheduler podrá recrear las cuatro mesas al volver ambas personas');
  assert.equal(restored.recovery.interruptedMatches, 1);
});

test('inscripciones cuyo inicio pasó durante el reinicio se cancelan explícitamente', () => {
  const initialTime = Date.parse('2026-10-12T17:00:00Z');
  const manager = new LobbyTournamentManager({ now: () => initialTime, timeZone: 'America/Mexico_City' });
  const event = [...manager.events.values()].find(item => item.capacity === 16 && !item.featured);
  fill(manager, event);
  const restored = new LobbyTournamentManager({
    now: () => event.startAt + 1,
    timeZone: 'America/Mexico_City',
    snapshot: manager.serialize()
  });
  const cancelled = restored.get(event.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellationReason, 'server_restarted_before_start');
  assert.equal(restored.recovery.cancelledEvents, 1);
});

test('la clave de payout por perfil sobrevive al limpiador de ambos stores', () => {
  const profile = cleanProfile({
    id: 'payout-profile',
    lobbyTournamentPayouts: ['flash-1791832500000-8', 'invalid/id', 'flash-1791833400000-16']
  });
  assert.deepEqual(profile.lobbyTournamentPayouts, ['flash-1791832500000-8', 'flash-1791833400000-16']);
});
