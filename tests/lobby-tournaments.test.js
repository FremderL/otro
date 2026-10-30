'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LobbyTournamentManager, nextWeeklyFinal, zonedParts, REGULAR_PRIZES, WEEKLY_PRIZES
} = require('../lib/lobby-tournaments');

function makeClock(timestamp) {
  let now = timestamp;
  return { now: () => now, set: value => { now = value; } };
}
function entrants(count, prefix = 'player') {
  return Array.from({ length: count }, (_, index) => ({
    profileId: `${prefix}-${index + 1}`, name: `Jugador ${index + 1}`,
    avatar: 'fox', socketId: `socket-${index + 1}`
  }));
}
function firstEvent(manager, capacity, { featured = false } = {}) {
  return [...manager.events.values()].find(event => event.capacity === capacity && event.featured === featured && event.status === 'registration');
}
function fill(manager, event, count = event.capacity) {
  for (const entrant of entrants(count, event.id)) {
    const result = manager.register(event.id, entrant, event.startAt - 60_000);
    assert.equal(result.ok, true, result.error);
  }
}
function completeCurrentRound(manager, event, winnerOffset = 0) {
  const matches = event.rounds[event.currentRound].matches;
  for (const match of matches) {
    const winner = match.participantIds[winnerOffset] || match.participantIds[0];
    const result = manager.resolveMatch(event.id, match.id, winner, { now: event.startAt + 1000 + event.currentRound });
    assert.equal(result.ok, true, result.error);
  }
}

test('el calendario publica torneos de 8/16 y una final dominical a las 19:00 del huso del casino', () => {
  const now = Date.parse('2026-10-12T17:00:00Z');
  const manager = new LobbyTournamentManager({ now: () => now, timeZone: 'America/Mexico_City' });
  const snapshot = manager.snapshotFor('me', now);
  assert.ok(snapshot.tournaments.some(event => event.capacity === 8));
  assert.ok(snapshot.tournaments.some(event => event.capacity === 16 && !event.featured));
  assert.ok(snapshot.tournaments.some(event => event.featured), 'la final semanal queda visible junto a los próximos relámpagos');
  const weekly = [...manager.events.values()].find(event => event.featured);
  assert.equal(weekly.capacity, 16);
  assert.equal(zonedParts(nextWeeklyFinal(now, 'America/Mexico_City'), 'America/Mexico_City').hour, 19);
  assert.equal(zonedParts(weekly.startAt, 'America/Mexico_City').weekday, 0);
  assert.deepEqual(Object.keys(REGULAR_PRIZES).map(Number).sort((a, b) => a - b), [8, 16]);
  assert.ok(WEEKLY_PRIZES[16][1] > REGULAR_PRIZES[16][1]);
});

test('inscripción gratuita respeta aforo, evita duplicados/segundo torneo y permite retirarse antes del cierre', () => {
  const clock = makeClock(Date.parse('2026-10-12T17:00:00Z'));
  const manager = new LobbyTournamentManager({ now: clock.now, timeZone: 'America/Mexico_City' });
  const event = firstEvent(manager, 16);
  const other = firstEvent(manager, 8);
  assert.ok(event && other);
  const people = entrants(17, 'enroll');
  assert.equal(manager.register(event.id, people[0], clock.now()).code, 'registered');
  assert.equal(manager.register(event.id, people[0], clock.now()).code, 'already_registered');
  assert.equal(manager.register(other.id, people[0], clock.now()).code, 'already_registered_elsewhere');
  for (const person of people.slice(1, 16)) assert.equal(manager.register(event.id, person, clock.now()).ok, true);
  assert.equal(event.status, 'full');
  assert.equal(manager.register(event.id, people[16], clock.now()).code, 'tournament_full');
  assert.equal(manager.withdraw(event.id, people[2].profileId, clock.now()).ok, true);
  assert.equal(event.status, 'registration');
  assert.equal(event.registered.length, 15);
});

test('solo inicia con 8 personas presentes; un torneo incompleto se cancela sin cobrar entrada', () => {
  const clock = makeClock(Date.parse('2026-10-12T17:00:00Z'));
  const manager = new LobbyTournamentManager({ now: clock.now, timeZone: 'America/Mexico_City' });
  const event = firstEvent(manager, 8);
  fill(manager, event, 7);
  assert.deepEqual(manager.startDue(event.startAt), []);
  assert.equal(event.status, 'cancelled');
  assert.equal(event.cancellationReason, 'not_enough_players');
  const complete = firstEvent(manager, 16);
  fill(manager, complete);
  complete.registered[0].online = false;
  assert.deepEqual(manager.startDue(complete.startAt), []);
  assert.equal(complete.cancellationReason, 'players_offline');
});

test('bracket de 8 avanza por partidas y asigna premios fijos al completar la final', () => {
  const clock = makeClock(Date.parse('2026-10-12T17:00:00Z'));
  const manager = new LobbyTournamentManager({ now: clock.now, timeZone: 'America/Mexico_City' });
  const event = firstEvent(manager, 8);
  fill(manager, event);
  assert.deepEqual(manager.startDue(event.startAt), [event.id]);
  assert.equal(event.rounds.length, 1);
  assert.equal(event.rounds[0].matches.length, 4);
  const firstMatch = event.rounds[0].matches[0];
  assert.deepEqual(firstMatch.participantIds, [`${event.id}-1`, `${event.id}-8`], 'la siembra inicial queda fija y visible');
  completeCurrentRound(manager, event);
  assert.equal(event.rounds.length, 2);
  assert.equal(event.rounds[1].label, 'Semifinales');
  completeCurrentRound(manager, event);
  assert.equal(event.rounds.length, 3);
  assert.equal(event.rounds[2].label, 'Final');
  const finalMatch = event.rounds[2].matches[0];
  const winnerId = finalMatch.participantIds[0];
  const result = manager.resolveMatch(event.id, finalMatch.id, winnerId, { now: event.startAt + 10_000 });
  assert.equal(result.code, 'tournament_completed');
  assert.equal(event.status, 'completed');
  assert.equal(result.payouts.find(payout => payout.profileId === winnerId).place, 1);
  assert.equal(result.payouts.find(payout => payout.profileId === winnerId).prize, 2400);
  assert.equal(result.payouts.filter(payout => payout.place === 3).length, 2);
  const completedSnapshot = manager.snapshotFor(winnerId, event.completedAt).tournaments.find(item => item.id === event.id);
  assert.equal(completedSnapshot.myPlacementLabel, '1.º puesto');
  assert.equal(completedSnapshot.participants.filter(person => person.state === '3.º puesto compartido').length, 2);
  assert.equal(completedSnapshot.participants.filter(person => person.state === '5.º puesto compartido').length, 4);
  assert.equal(completedSnapshot.rounds.flatMap(round => round.matches).flatMap(match => match.players)
    .filter(player => player.placeLabel === '3.º puesto compartido').length, 2);
  assert.equal(manager.markPayoutsAwarded(event.id), true);
  assert.equal(manager.markPayoutsAwarded(event.id), false, 'el crédito queda protegido contra repetición');
});

test('bracket de 16 tiene cuatro rondas, y la final semanal usa premios virtuales destacados', () => {
  const clock = makeClock(Date.parse('2026-10-12T17:00:00Z'));
  const manager = new LobbyTournamentManager({ now: clock.now, timeZone: 'America/Mexico_City' });
  const event = firstEvent(manager, 16);
  fill(manager, event);
  manager.startDue(event.startAt);
  for (let round = 0; round < 3; round++) completeCurrentRound(manager, event);
  assert.equal(event.rounds.length, 4);
  assert.equal(event.rounds.at(-1).label, 'Final');
  const match = event.rounds.at(-1).matches[0];
  const result = manager.resolveMatch(event.id, match.id, match.participantIds[0], { now: event.startAt + 20_000 });
  assert.equal(result.code, 'tournament_completed');
  assert.equal(result.payouts.find(payout => payout.place === 1).prize, 5000);

  const featured = [...manager.events.values()].find(item => item.featured);
  fill(manager, featured, featured.capacity);
  manager.startDue(featured.startAt);
  for (let round = 0; round < 3; round++) completeCurrentRound(manager, featured);
  const final = featured.rounds.at(-1).matches[0];
  const weeklyResult = manager.resolveMatch(featured.id, final.id, final.participantIds[0], { now: featured.startAt + 30_000 });
  assert.equal(weeklyResult.payouts.find(payout => payout.place === 1).prize, 10000);
});

test('reconexión actualiza la silla del participante sin duplicar su inscripción', () => {
  const clock = makeClock(Date.parse('2026-10-12T17:00:00Z'));
  const manager = new LobbyTournamentManager({ now: clock.now, timeZone: 'America/Mexico_City' });
  const event = firstEvent(manager, 8);
  const person = entrants(1, 'reconnect')[0];
  manager.register(event.id, person, event.startAt - 1000);
  manager.markOffline(person.profileId, person.socketId);
  assert.equal(event.registered[0].online, false);
  assert.equal(manager.restoreSocket(person.profileId, 'socket-new'), true);
  assert.equal(event.registered[0].socketId, 'socket-new');
  assert.equal(event.registered[0].online, true);
  assert.equal(event.registered.length, 1);
});
