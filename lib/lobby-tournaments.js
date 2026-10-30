'use strict';

const { CASINO_TIME_ZONE } = require('./profile-store-shared');

const REGULAR_PRIZES = Object.freeze({
  8: Object.freeze({ 1: 2400, 2: 1000, 3: 300, 4: 300 }),
  16: Object.freeze({ 1: 5000, 2: 2200, 3: 700, 4: 700, 5: 200, 6: 200, 7: 200, 8: 200 })
});
const WEEKLY_PRIZES = Object.freeze({
  16: Object.freeze({ 1: 10000, 2: 5000, 3: 1600, 4: 1600, 5: 450, 6: 450, 7: 450, 8: 450 })
});
const CAPACITIES = new Set([8, 16]);
const TERMINAL_STATES = new Set(['completed', 'cancelled']);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function zonedParts(value, timeZone = CASINO_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const result = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    year: Number(result.year), month: Number(result.month), day: Number(result.day),
    hour: Number(result.hour), minute: Number(result.minute), weekday: WEEKDAYS.indexOf(result.weekday)
  };
}

// Convierte una hora de pared en una fecha real sin asumir que el servidor está
// en la misma zona que el casino. La iteración también respeta cambios de zona.
function fromZonedWallTime({ year, month, day, hour, minute }, timeZone = CASINO_TIME_ZONE) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = wanted;
  for (let index = 0; index < 4; index++) {
    const local = zonedParts(guess, timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
    const correction = wanted - represented;
    if (!correction) break;
    guess += correction;
  }
  return guess;
}

function nextWeeklyFinal(now, timeZone = CASINO_TIME_ZONE) {
  const local = zonedParts(now, timeZone);
  let days = (7 - local.weekday) % 7;
  let date = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  let startAt = fromZonedWallTime({
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
    day: date.getUTCDate(), hour: 19, minute: 0
  }, timeZone);
  if (startAt <= now) {
    date = new Date(Date.UTC(local.year, local.month - 1, local.day + days + 7));
    startAt = fromZonedWallTime({
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
      day: date.getUTCDate(), hour: 19, minute: 0
    }, timeZone);
  }
  return startAt;
}

function matchRoundLabel(capacity, roundIndex) {
  const entrants = capacity >> roundIndex;
  if (entrants === 2) return 'Final';
  if (entrants === 4) return 'Semifinales';
  if (entrants === 8) return 'Cuartos de final';
  if (entrants === 16) return 'Octavos de final';
  return `Ronda de ${entrants}`;
}

function seedOrder(capacity) {
  return capacity === 8
    ? [1, 8, 4, 5, 2, 7, 3, 6]
    : [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11];
}

function createMatches(entrants, capacity, roundIndex, idPrefix = 'm') {
  const entrantsBySeed = [...entrants].sort((a, b) => a.seed - b.seed);
  // La primera ronda aplica una siembra reproducible; las siguientes respetan
  // el orden del bracket para que los ganadores no vuelvan a sortearse.
  const ordered = roundIndex === 0
    ? seedOrder(capacity).slice(0, entrantsBySeed.length).map(seed => entrantsBySeed.find(entrant => entrant.seed === seed)).filter(Boolean)
    : [...entrants];
  const matches = [];
  for (let index = 0; index < ordered.length; index += 2) {
    matches.push({
      id: `${idPrefix}-r${roundIndex + 1}-m${Math.floor(index / 2) + 1}`,
      roundIndex,
      number: Math.floor(index / 2) + 1,
      participantIds: [ordered[index]?.profileId, ordered[index + 1]?.profileId].filter(Boolean),
      status: 'pending', winnerId: null, loserId: null, roomCode: null,
      resolvedAt: null, forfeit: false
    });
  }
  return matches;
}

function prizeFor(event, place) {
  const table = event.featured ? WEEKLY_PRIZES[event.capacity] : REGULAR_PRIZES[event.capacity];
  return Math.max(0, Number(table?.[place]) || 0);
}

function cleanStoredEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 120) : '';
  const capacity = Number(raw.capacity);
  const statuses = new Set(['registration', 'full', 'in_progress', 'completed', 'cancelled']);
  if (!id || !CAPACITIES.has(capacity) || !statuses.has(raw.status)) return null;
  const registered = [];
  const registeredIds = new Set();
  for (const entrant of Array.isArray(raw.registered) ? raw.registered.slice(0, capacity) : []) {
    const profileId = String(entrant?.profileId || '').slice(0, 80);
    if (!profileId || registeredIds.has(profileId)) continue;
    registeredIds.add(profileId);
    registered.push({
      profileId,
      name: String(entrant.name || 'Jugador').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 18) || 'Jugador',
      avatar: String(entrant.avatar || 'fox').slice(0, 30),
      socketId: null,
      online: false,
      seed: Math.min(capacity, Math.max(1, Math.floor(Number(entrant.seed) || registered.length + 1))),
      joinedAt: Math.max(0, Number(entrant.joinedAt) || 0)
    });
  }
  const validStatuses = new Set(['pending', 'playing', 'completed']);
  const rounds = (Array.isArray(raw.rounds) ? raw.rounds.slice(0, 5) : []).map((round, roundIndex) => ({
    index: roundIndex,
    label: String(round?.label || matchRoundLabel(capacity, roundIndex)).slice(0, 32),
    matches: (Array.isArray(round?.matches) ? round.matches.slice(0, capacity / 2) : []).map((match, matchIndex) => {
      const participantIds = Array.isArray(match?.participantIds)
        ? [...new Set(match.participantIds.map(id => String(id || '').slice(0, 80)).filter(id => registeredIds.has(id)))].slice(0, 2)
        : [];
      let status = validStatuses.has(match?.status) ? match.status : 'pending';
      const winnerId = participantIds.includes(String(match?.winnerId || '')) ? String(match.winnerId) : null;
      const loserId = participantIds.includes(String(match?.loserId || '')) ? String(match.loserId) : null;
      if (status === 'completed' && (!winnerId || !loserId || winnerId === loserId)) status = 'pending';
      return {
        id: String(match?.id || `${id}-r${roundIndex + 1}-m${matchIndex + 1}`).slice(0, 160),
        roundIndex,
        number: Math.max(1, Math.floor(Number(match?.number) || matchIndex + 1)),
        participantIds,
        status,
        winnerId: status === 'completed' ? winnerId : null,
        loserId: status === 'completed' ? loserId : null,
        roomCode: status === 'playing' ? String(match?.roomCode || '').slice(0, 12) : null,
        resolvedAt: Math.max(0, Number(match?.resolvedAt) || 0),
        startedAt: Math.max(0, Number(match?.startedAt) || 0) || null,
        forfeit: Boolean(match?.forfeit)
      };
    }).filter(match => match.participantIds.length === 2)
  }));
  const placements = {};
  if (raw.placements && typeof raw.placements === 'object' && !Array.isArray(raw.placements)) {
    for (const profileId of registeredIds) {
      const value = raw.placements[profileId];
      const place = Math.floor(Number(value?.place) || 0);
      if (place < 1 || place > capacity) continue;
      placements[profileId] = {
        place,
        prize: Math.max(0, Math.floor(Number(value.prize) || 0)),
        eliminatedRound: value.eliminatedRound == null ? null : Math.max(0, Math.floor(Number(value.eliminatedRound) || 0))
      };
    }
  }
  return {
    id,
    startAt: Math.max(0, Number(raw.startAt) || 0),
    capacity,
    featured: Boolean(raw.featured),
    timezone: String(raw.timezone || CASINO_TIME_ZONE).slice(0, 80),
    name: String(raw.name || (capacity === 16 ? 'Copa relámpago · 16' : 'Relámpago · 8')).slice(0, 60),
    status: raw.status,
    registered,
    rounds,
    currentRound: Math.min(rounds.length - 1, Math.max(-1, Math.floor(Number(raw.currentRound) || 0))),
    placements,
    payoutsAwarded: Boolean(raw.payoutsAwarded),
    createdAt: Math.max(0, Number(raw.createdAt) || 0),
    startedAt: Math.max(0, Number(raw.startedAt) || 0) || null,
    completedAt: Math.max(0, Number(raw.completedAt) || 0) || null,
    cancelledAt: Math.max(0, Number(raw.cancelledAt) || 0) || null,
    cancellationReason: typeof raw.cancellationReason === 'string' ? raw.cancellationReason.slice(0, 80) : null
  };
}

function makeScheduleEvent({ id, startAt, capacity, featured = false, timezone = CASINO_TIME_ZONE }) {
  return {
    id,
    startAt,
    capacity,
    featured,
    timezone,
    name: featured ? 'Final semanal MonteCristo' : capacity === 16 ? 'Copa relámpago · 16' : 'Relámpago · 8',
    status: 'registration',
    registered: [],
    rounds: [],
    currentRound: -1,
    placements: {},
    payoutsAwarded: false,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null
  };
}

function placementLabel(event, placement) {
  const place = Math.max(0, Math.floor(Number(placement?.place) || 0));
  if (!place) return null;
  const roundIndex = placement.eliminatedRound;
  const round = Number.isInteger(roundIndex) ? event.rounds?.[roundIndex] : null;
  const shared = Boolean(round && round.matches.length > 1);
  return `${place}.º puesto${shared ? ' compartido' : ''}`;
}

function participantPublic(event, profileId) {
  return event.registered.map((entrant, index) => {
    const placement = event.placements[entrant.profileId];
    return {
      name: entrant.name,
      avatar: entrant.avatar,
      seed: entrant.seed || index + 1,
      online: Boolean(entrant.online),
      state: placement
        ? placementLabel(event, placement)
        : event.rounds.some(round => round.matches.some(match => match.status === 'playing' && match.participantIds.includes(entrant.profileId)))
          ? 'En partida'
          : 'Inscrito',
      isYou: entrant.profileId === profileId
    };
  });
}

function publicBracket(event) {
  return event.rounds.map(round => ({
    index: round.index,
    label: round.label,
    matches: round.matches.map(match => {
      const left = event.registered.find(entrant => entrant.profileId === match.participantIds[0]);
      const right = event.registered.find(entrant => entrant.profileId === match.participantIds[1]);
      const winner = event.registered.find(entrant => entrant.profileId === match.winnerId);
      return {
        id: match.id,
        number: match.number,
        status: match.status,
        players: [left, right].filter(Boolean).map(entrant => ({
          name: entrant.name,
          avatar: entrant.avatar,
          winner: match.winnerId === entrant.profileId,
          loser: match.loserId === entrant.profileId,
          // Solo se rotula a quien queda eliminado en ese encuentro: así el
          // puesto compartido no aparece repetido en sus partidas anteriores.
          placeLabel: match.loserId === entrant.profileId
            ? placementLabel(event, event.placements[entrant.profileId])
            : null
        })),
        winnerName: winner?.name || null,
        forfeit: Boolean(match.forfeit)
      };
    })
  }));
}

class LobbyTournamentManager {
  constructor({ timeZone = CASINO_TIME_ZONE, now = () => Date.now(), snapshot = null, onChange = null } = {}) {
    this.timeZone = timeZone;
    this.now = now;
    this.events = new Map();
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.recovery = { interruptedMatches: 0, cancelledEvents: 0 };
    if (snapshot) this.restoreSnapshot(snapshot, this.now());
    this.ensureSchedule(this.now());
  }

  setChangeListener(listener) { this.onChange = typeof listener === 'function' ? listener : null; }

  serialize() {
    return {
      version: 1,
      timeZone: this.timeZone,
      events: [...this.events.values()].map(event => ({
        ...structuredClone(event),
        registered: event.registered.map(entrant => ({ ...entrant, socketId: null, online: false }))
      }))
    };
  }

  _notifyChange() {
    if (!this.onChange) return;
    try {
      const result = this.onChange(this.serialize());
      if (result && typeof result.catch === 'function') result.catch(error => {
        console.warn('No se pudo guardar el estado del torneo del lobby:', error.message);
      });
    } catch (error) {
      console.warn('No se pudo guardar el estado del torneo del lobby:', error.message);
    }
  }

  restoreSnapshot(snapshot, now = this.now()) {
    const source = Array.isArray(snapshot?.events) ? snapshot.events.slice(-256) : [];
    let repaired = false;
    for (const raw of source) {
      const event = cleanStoredEvent(raw);
      if (!event) continue;
      if (event.status === 'in_progress') {
        const currentRound = event.rounds[event.currentRound];
        const expectedMatches = event.capacity >> (event.currentRound + 1);
        if (!currentRound || currentRound.matches.length !== expectedMatches) {
          event.status = 'cancelled';
          event.cancelledAt = now;
          event.cancellationReason = 'stored_bracket_unavailable';
          this.recovery.cancelledEvents++;
          repaired = true;
          this.events.set(event.id, event);
          continue;
        }
        for (const round of event.rounds) for (const match of round.matches) {
          if (match.status !== 'playing') continue;
          // La mano de póker vive en la sala efímera. Tras un reinicio el mismo
          // encuentro vuelve a estar pendiente y arranca con su stack virtual completo.
          match.status = 'pending';
          match.roomCode = null;
          match.startedAt = null;
          this.recovery.interruptedMatches++;
          repaired = true;
        }
      } else if (['registration', 'full'].includes(event.status) && event.startAt <= now) {
        event.status = 'cancelled';
        event.cancelledAt = now;
        event.cancellationReason = 'server_restarted_before_start';
        this.recovery.cancelledEvents++;
        repaired = true;
      }
      this.events.set(event.id, event);
    }
    if (repaired) this._notifyChange();
    return this.recovery;
  }

  ensureSchedule(now = this.now()) {
    let changed = false;
    const quarter = 15 * 60 * 1000;
    const first = Math.floor(now / quarter) * quarter + quarter;
    for (let index = 0; index < 9; index++) {
      const startAt = first + index * quarter;
      const local = zonedParts(startAt, this.timeZone);
      const capacity = local.minute % 30 === 15 ? 16 : 8;
      const id = `flash-${startAt}-${capacity}`;
      if (!this.events.has(id)) {
        this.events.set(id, makeScheduleEvent({ id, startAt, capacity, timezone: this.timeZone }));
        changed = true;
      }
    }

    const weeklyStart = nextWeeklyFinal(now, this.timeZone);
    const week = zonedParts(weeklyStart, this.timeZone);
    const weeklyId = `weekly-${week.year}-${String(week.month).padStart(2, '0')}-${String(week.day).padStart(2, '0')}`;
    if (!this.events.has(weeklyId)) {
      this.events.set(weeklyId, makeScheduleEvent({
        id: weeklyId, startAt: weeklyStart, capacity: 16, featured: true, timezone: this.timeZone
      }));
      changed = true;
    }

    for (const [id, event] of this.events) {
      const awaitingPayout = event.status === 'completed' && !event.payoutsAwarded;
      if (TERMINAL_STATES.has(event.status) && !awaitingPayout
          && Number(event.completedAt || event.cancelledAt || 0) < now - 24 * 60 * 60 * 1000) {
        this.events.delete(id);
        changed = true;
      }
    }
    if (changed) this._notifyChange();
  }

  get(id) { return this.events.get(String(id || '')) || null; }

  getParticipant(event, profileId) {
    return event?.registered.find(entrant => entrant.profileId === String(profileId)) || null;
  }

  register(eventId, participant, now = this.now()) {
    this.ensureSchedule(now);
    const event = this.get(eventId);
    const profileId = String(participant?.profileId || '').slice(0, 80);
    const name = String(participant?.name || '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 18);
    if (!event) return { ok: false, code: 'tournament_not_found', error: 'Ese torneo ya no está en el calendario.' };
    if (!profileId || !name || !participant?.socketId) return { ok: false, code: 'participant_invalid', error: 'No pudimos confirmar tu identidad en el lobby.' };
    if (!['registration', 'full'].includes(event.status) || now >= event.startAt) {
      return { ok: false, code: 'registration_closed', error: 'Las inscripciones de este torneo ya cerraron.' };
    }
    const existing = this.getParticipant(event, profileId);
    if (existing) {
      existing.name = name;
      existing.avatar = String(participant.avatar || 'fox').slice(0, 30);
      existing.socketId = String(participant.socketId).slice(0, 100);
      existing.online = true;
      this._notifyChange();
      return { ok: true, code: 'already_registered', event };
    }
    const activeElsewhere = [...this.events.values()].find(item =>
      item.id !== event.id && ['registration', 'full', 'in_progress'].includes(item.status)
      && this.getParticipant(item, profileId)
    );
    if (activeElsewhere) return { ok: false, code: 'already_registered_elsewhere', error: `Ya estás inscrito en «${activeElsewhere.name}».` };
    if (event.registered.length >= event.capacity) return { ok: false, code: 'tournament_full', error: 'Este torneo ya completó sus lugares.' };

    event.registered.push({
      profileId, name, avatar: String(participant.avatar || 'fox').slice(0, 30),
      socketId: String(participant.socketId).slice(0, 100), online: true,
      seed: event.registered.length + 1, joinedAt: now
    });
    event.status = event.registered.length === event.capacity ? 'full' : 'registration';
    this._notifyChange();
    return { ok: true, code: 'registered', event };
  }

  withdraw(eventId, profileId, now = this.now()) {
    this.ensureSchedule(now);
    const event = this.get(eventId);
    if (!event) return { ok: false, code: 'tournament_not_found', error: 'Ese torneo ya no está en el calendario.' };
    if (!['registration', 'full'].includes(event.status) || now >= event.startAt) {
      return { ok: false, code: 'registration_closed', error: 'Ya no puedes cancelar esta inscripción.' };
    }
    const index = event.registered.findIndex(entrant => entrant.profileId === String(profileId));
    if (index < 0) return { ok: false, code: 'not_registered', error: 'No estás inscrito en ese torneo.' };
    event.registered.splice(index, 1);
    event.registered.forEach((entrant, entrantIndex) => { entrant.seed = entrantIndex + 1; });
    event.status = event.registered.length === event.capacity ? 'full' : 'registration';
    this._notifyChange();
    return { ok: true, code: 'withdrawn', event };
  }

  restoreSocket(profileId, socketId) {
    const id = String(profileId || '');
    let changed = false;
    for (const event of this.events.values()) {
      const entrant = this.getParticipant(event, id);
      if (!entrant || TERMINAL_STATES.has(event.status)) continue;
      const nextSocketId = String(socketId || '').slice(0, 100);
      if (entrant.socketId !== nextSocketId || !entrant.online) changed = true;
      entrant.socketId = nextSocketId;
      entrant.online = true;
    }
    if (changed) this._notifyChange();
    return changed;
  }

  markOffline(profileId, socketId) {
    const id = String(profileId || '');
    let changed = false;
    for (const event of this.events.values()) {
      const entrant = this.getParticipant(event, id);
      if (!entrant || entrant.socketId !== String(socketId || '') || !entrant.online) continue;
      entrant.online = false;
      changed = true;
    }
    if (changed) this._notifyChange();
    return changed;
  }

  startDue(now = this.now(), canStart = () => true) {
    this.ensureSchedule(now);
    const started = [];
    let changed = false;
    for (const event of this.events.values()) {
      if (!['registration', 'full'].includes(event.status) || event.startAt > now) continue;
      let cancellationReason = null;
      if (event.registered.length !== event.capacity) cancellationReason = 'not_enough_players';
      else if (event.registered.some(entrant => !entrant.online)) cancellationReason = 'players_offline';
      else {
        const availability = canStart(event);
        if (availability === false) cancellationReason = 'participants_unavailable';
        else if (typeof availability === 'string' && availability) cancellationReason = availability;
      }
      if (cancellationReason) {
        event.status = 'cancelled';
        event.cancelledAt = now;
        event.cancellationReason = cancellationReason;
        changed = true;
        continue;
      }
      const firstMatches = createMatches(event.registered, event.capacity, 0, event.id);
      event.rounds = [{ index: 0, label: matchRoundLabel(event.capacity, 0), matches: firstMatches }];
      event.currentRound = 0;
      event.status = 'in_progress';
      event.startedAt = now;
      started.push(event.id);
      changed = true;
    }
    if (changed) this._notifyChange();
    return started;
  }

  pendingMatches(eventId) {
    const event = this.get(eventId);
    if (!event || event.status !== 'in_progress' || event.currentRound < 0) return [];
    const round = event.rounds[event.currentRound];
    return round ? round.matches.filter(match => match.status === 'pending').map(match => ({ ...match })) : [];
  }

  markMatchStarted(eventId, matchId, roomCode) {
    const event = this.get(eventId);
    const match = event?.rounds?.[event.currentRound]?.matches.find(item => item.id === String(matchId));
    if (!event || event.status !== 'in_progress' || !match || match.status !== 'pending') return false;
    match.status = 'playing';
    match.roomCode = String(roomCode || '').slice(0, 12);
    match.startedAt = this.now();
    this._notifyChange();
    return true;
  }

  resolveMatch(eventId, matchId, winnerId, { forfeit = false, now = this.now() } = {}) {
    const event = this.get(eventId);
    const match = event?.rounds?.[event.currentRound]?.matches.find(item => item.id === String(matchId));
    const winner = String(winnerId || '');
    if (!event || event.status !== 'in_progress' || !match || !['pending', 'playing'].includes(match.status)) {
      return { ok: false, code: 'match_unavailable', error: 'Ese encuentro ya no está disponible.' };
    }
    if (!match.participantIds.includes(winner)) return { ok: false, code: 'winner_invalid', error: 'La persona ganadora no pertenece a este encuentro.' };
    const loserId = match.participantIds.find(id => id !== winner);
    if (!loserId) return { ok: false, code: 'match_invalid', error: 'El encuentro no tiene dos participantes.' };
    match.status = 'completed';
    match.winnerId = winner;
    match.loserId = loserId;
    match.forfeit = Boolean(forfeit);
    match.resolvedAt = now;
    event.placements[loserId] = {
      place: (event.capacity >> (match.roundIndex + 1)) + 1,
      prize: prizeFor(event, (event.capacity >> (match.roundIndex + 1)) + 1),
      eliminatedRound: match.roundIndex
    };

    const currentRound = event.rounds[event.currentRound];
    if (currentRound.matches.some(item => item.status !== 'completed')) {
      this._notifyChange();
      return { ok: true, code: 'match_completed', completed: false, event, match };
    }

    const winners = currentRound.matches.map(item => event.registered.find(entrant => entrant.profileId === item.winnerId)).filter(Boolean);
    if (winners.length === 1) {
      const champion = winners[0];
      event.placements[champion.profileId] = { place: 1, prize: prizeFor(event, 1), eliminatedRound: null };
      const finalist = event.registered.find(entrant => entrant.profileId === event.rounds.at(-1)?.matches?.[0]?.loserId);
      if (finalist && finalist.profileId !== champion.profileId) {
        event.placements[finalist.profileId] = { place: 2, prize: prizeFor(event, 2), eliminatedRound: event.rounds.length - 1 };
      }
      event.status = 'completed';
      event.completedAt = now;
      const payouts = event.registered.map(entrant => ({
        profileId: entrant.profileId,
        name: entrant.name,
        ...event.placements[entrant.profileId]
      })).sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
      this._notifyChange();
      return { ok: true, code: 'tournament_completed', completed: true, event, match, payouts };
    }

    const roundIndex = event.currentRound + 1;
    const matches = createMatches(winners, event.capacity, roundIndex, event.id);
    event.rounds.push({ index: roundIndex, label: matchRoundLabel(event.capacity, roundIndex), matches });
    event.currentRound = roundIndex;
    this._notifyChange();
    return { ok: true, code: 'round_advanced', completed: false, advanced: true, event, match, nextRound: event.rounds[roundIndex] };
  }

  markPayoutsAwarded(eventId) {
    const event = this.get(eventId);
    if (!event || event.status !== 'completed' || event.payoutsAwarded) return false;
    event.payoutsAwarded = true;
    this._notifyChange();
    return true;
  }

  snapshotFor(profileId = null, now = this.now()) {
    this.ensureSchedule(now);
    const id = String(profileId || '');
    const all = [...this.events.values()];
    const active = all.filter(event => ['registration', 'full', 'in_progress'].includes(event.status));
    const future = active.filter(event => event.status !== 'in_progress' && event.startAt > now).sort((a, b) => a.startAt - b.startAt);
    const running = active.filter(event => event.status === 'in_progress').sort((a, b) => a.startAt - b.startAt);
    const regularFuture = future.filter(event => !event.featured).slice(0, 8);
    const featuredFuture = future.filter(event => event.featured).slice(0, 1);
    const recent = all.filter(event => TERMINAL_STATES.has(event.status)).sort((a, b) => (b.completedAt || b.cancelledAt || 0) - (a.completedAt || a.cancelledAt || 0)).slice(0, 2);
    const chosen = [...running, ...regularFuture, ...featuredFuture, ...recent].sort((a, b) => a.startAt - b.startAt);
    const registrations = all.filter(event => ['registration', 'full', 'in_progress'].includes(event.status) && this.getParticipant(event, id));
    return {
      timeZone: this.timeZone,
      serverNow: now,
      registeredTournamentId: registrations[0]?.id || null,
      tournaments: chosen.map(event => {
        const me = this.getParticipant(event, id);
        const prizeTable = event.featured ? WEEKLY_PRIZES[event.capacity] : REGULAR_PRIZES[event.capacity];
        return {
          id: event.id,
          name: event.name,
          featured: event.featured,
          capacity: event.capacity,
          startAt: event.startAt,
          status: event.status,
          registeredCount: event.registered.length,
          seatsRemaining: Math.max(0, event.capacity - event.registered.length),
          isRegistered: Boolean(me),
          myPlacement: me ? event.placements[id]?.place || null : null,
          myPlacementLabel: me ? placementLabel(event, event.placements[id]) : null,
          myPrize: me ? event.placements[id]?.prize || 0 : null,
          cancellationReason: event.cancellationReason,
          participants: participantPublic(event, id),
          prizeSchedule: Object.entries(prizeTable || {}).map(([place, prize]) => ({ place: Number(place), prize })),
          rounds: publicBracket(event)
        };
      })
    };
  }
}

module.exports = {
  REGULAR_PRIZES,
  WEEKLY_PRIZES,
  CAPACITIES,
  zonedParts,
  fromZonedWallTime,
  nextWeeklyFinal,
  matchRoundLabel,
  seedOrder,
  prizeFor,
  placementLabel,
  LobbyTournamentManager
};
