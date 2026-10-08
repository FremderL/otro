'use strict';

// Fase A — T17: calendario válido para cualquier mes (§5).
// Cubre meses de 31, 30, febrero común y febrero bisiesto, y verifica cada
// invariante estructural del calendario y de la parrilla diaria.

const test = require('node:test');
const assert = require('node:assert');
const { hash32, mulberry32 } = require('../lib/football/prng');
const { buildSeasonClubs } = require('../lib/football/teams');
const {
  generateCalendar, daysInMonth, doubleRoundRobin, jornadasPorDia, asignarDias,
  zonedTimeToMs, DEFAULT_BLOCKS, WAVE_OFFSET_MIN, JORNADAS
} = require('../lib/football/fixtures');
const { CASINO_TIME_ZONE } = require('../lib/profile-store-shared');

const MESES = ['2026-01', '2026-04', '2026-02', '2024-02', '2026-10', '2026-12', '2026-11'];

function clubsFor(seasonMonth) {
  return buildSeasonClubs(mulberry32(hash32(`${seasonMonth}plantillas`)));
}

function kickoffParts(ms, tz = CASINO_TIME_ZONE) {
  const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { hour: (+p.hour) % 24, minute: +p.minute };
}

test('daysInMonth es correcto, bisiestos incluidos', () => {
  assert.strictEqual(daysInMonth('2026-01'), 31);
  assert.strictEqual(daysInMonth('2026-04'), 30);
  assert.strictEqual(daysInMonth('2026-02'), 28);
  assert.strictEqual(daysInMonth('2024-02'), 29, '2024 es bisiesto');
  assert.strictEqual(daysInMonth('2026-12'), 31);
});

test('el reparto de dobles suma 30 jornadas y no las concentra al final', () => {
  for (const mes of MESES) {
    const dim = daysInMonth(mes);
    const disp = dim - 1;
    const dobles = Math.max(0, JORNADAS - disp);
    const perDay = jornadasPorDia(disp, dobles);
    assert.strictEqual(perDay.reduce((a, b) => a + b, 0), 30, `${mes}: suma 30`);
    assert.strictEqual(perDay.filter(c => c === 2).length, dobles, `${mes}: ${dobles} días dobles`);
    assert.ok(perDay.every(c => c === 1 || c === 2), 'cada día tiene 1 o 2 jornadas');
    if (dobles > 1) {
      const doubleIdx = perDay.map((c, i) => (c === 2 ? i : -1)).filter(i => i >= 0);
      // Ningún par de días dobles consecutivos al final; separación razonable.
      const lastDouble = doubleIdx[doubleIdx.length - 1];
      assert.ok(lastDouble < disp, `${mes}: el último día doble no es el final reservado`);
    }
  }
});

test('asignarDias mapea 30 jornadas a días con su oleada', () => {
  const sched = asignarDias(27, 3); // febrero común
  assert.strictEqual(sched.length, 30);
  const byDay = new Map();
  for (const s of sched) {
    assert.ok(s.day >= 1 && s.day <= 27, 'día dentro de los disponibles');
    byDay.set(s.day, (byDay.get(s.day) || 0) + 1);
  }
  assert.strictEqual([...byDay.values()].filter(c => c === 2).length, 3, 'tres días con doble jornada');
  // En un día doble, las dos jornadas tienen oleada 0 y 1.
  const doubleDay = [...byDay.entries()].find(([, c]) => c === 2)[0];
  const waves = sched.filter(s => s.day === doubleDay).map(s => s.wave).sort();
  assert.deepStrictEqual(waves, [0, 1]);
});

test('doubleRoundRobin produce 30 jornadas de 8 parejas, cada una dos veces con cancha invertida', () => {
  const ids = clubsFor('2026-10').map(c => c.id);
  const rounds = doubleRoundRobin(ids);
  assert.strictEqual(rounds.length, 30);
  const unordered = new Map();
  const ordered = new Set();
  for (const round of rounds) {
    assert.strictEqual(round.length, 8);
    const teamsInRound = new Set();
    for (const { home, away } of round) {
      assert.notStrictEqual(home, away, 'nadie juega contra sí mismo');
      teamsInRound.add(home); teamsInRound.add(away);
      const key = [home, away].sort().join('|');
      unordered.set(key, (unordered.get(key) || 0) + 1);
      ordered.add(`${home}>${away}`);
    }
    assert.strictEqual(teamsInRound.size, 16, 'los 16 juegan exactamente una vez por jornada');
  }
  assert.strictEqual(unordered.size, 120, '120 parejas distintas (16·15/2)');
  for (const [, count] of unordered) assert.strictEqual(count, 2, 'cada pareja se enfrenta dos veces');
  assert.strictEqual(ordered.size, 240, 'cada orden local/visitante aparece una sola vez');
});

test('T17: generateCalendar es válido para todos los meses probados', () => {
  for (const mes of MESES) {
    const clubs = clubsFor(mes);
    const cal = generateCalendar(mes, clubs);
    const clubIds = new Set(clubs.map(c => c.id));

    assert.strictEqual(cal.matches.length, 240, `${mes}: 240 partidos`);
    assert.strictEqual(cal.jornadas.length, 30, `${mes}: 30 jornadas`);
    assert.strictEqual(new Set(cal.matches.map(m => m.id)).size, 240, `${mes}: ids únicos`);

    const expectedDobles = Math.max(0, JORNADAS - (cal.daysInMonth - 1));
    assert.strictEqual(cal.dobles, expectedDobles, `${mes}: dobles`);

    for (const j of cal.jornadas) {
      assert.strictEqual(j.matches.length, 8, `${mes} j${j.jornada}: 8 partidos`);
      // Cada equipo una vez por jornada.
      const seen = new Set();
      for (const m of j.matches) {
        assert.ok(clubIds.has(m.homeId) && clubIds.has(m.awayId));
        assert.ok(!seen.has(m.homeId) && !seen.has(m.awayId), `${mes} j${j.jornada}: equipo repetido`);
        seen.add(m.homeId); seen.add(m.awayId);
        assert.strictEqual(m.jornada, j.jornada);
        assert.strictEqual(m.day, j.day);
        assert.strictEqual(m.wave, j.wave);
        assert.ok(Number.isInteger(m.seed) && m.seed >= 0);
        assert.strictEqual(m.status, 'scheduled');
      }
      assert.strictEqual(seen.size, 16);
      // Tamaños de bloque: matutino 3, vespertino 3, estelar 2.
      const byBlock = {};
      for (const m of j.matches) byBlock[m.block] = (byBlock[m.block] || 0) + 1;
      assert.strictEqual(byBlock.matutino, 3);
      assert.strictEqual(byBlock.vespertino, 3);
      assert.strictEqual(byBlock.estelar, 2);
      // Exactamente un destacado, en el bloque estelar.
      const featured = j.matches.filter(m => m.featured);
      assert.strictEqual(featured.length, 1, `${mes} j${j.jornada}: un destacado`);
      assert.strictEqual(featured[0].block, 'estelar');
    }

    // Cada pareja dos veces, una en cada cancha.
    const unordered = new Map();
    const ordered = new Set();
    for (const m of cal.matches) {
      const key = [m.homeId, m.awayId].sort().join('|');
      unordered.set(key, (unordered.get(key) || 0) + 1);
      ordered.add(`${m.homeId}>${m.awayId}`);
    }
    for (const [, c] of unordered) assert.strictEqual(c, 2, `${mes}: pareja dos veces`);
    assert.strictEqual(ordered.size, 240, `${mes}: canchas invertidas`);
  }
});

test('los kickoff caen en la hora del bloque, en la zona del casino, con +35 min en la segunda oleada', () => {
  const mes = '2026-02'; // tiene días dobles
  const cal = generateCalendar(mes, clubsFor(mes));
  const blockTime = Object.fromEntries(DEFAULT_BLOCKS.map(b => [b.id, b.time.split(':').map(Number)]));
  for (const m of cal.matches) {
    const [bh, bm] = blockTime[m.block];
    const expectedMin = bh * 60 + bm + m.wave * WAVE_OFFSET_MIN;
    const { hour, minute } = kickoffParts(m.scheduledKickoffAt);
    assert.strictEqual(hour * 60 + minute, expectedMin,
      `${m.id} (${m.block}, oleada ${m.wave}): ${hour}:${String(minute).padStart(2, '0')} esperado`);
    // El día local del kickoff coincide con el día asignado.
    const dayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: CASINO_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(m.scheduledKickoffAt));
    assert.strictEqual(dayLocal, `${mes}-${String(m.day).padStart(2, '0')}`);
  }
});

test('en un día doble las dos oleadas van +35 min por bloque y no se solapan', () => {
  const mes = '2026-02';
  const cal = generateCalendar(mes, clubsFor(mes));
  const MATCH_DURATION_MS = 17 * 60000; // ~17 min reales por partido (§5.4)
  const byDay = new Map();
  for (const j of cal.jornadas) {
    if (!byDay.has(j.day)) byDay.set(j.day, []);
    byDay.get(j.day).push(j);
  }
  const doubleDays = [...byDay.values()].filter(list => list.length === 2);
  assert.ok(doubleDays.length >= 1, 'febrero tiene días dobles');
  for (const list of doubleDays) {
    const [a, b] = list.sort((x, y) => x.wave - y.wave);
    assert.strictEqual(a.wave, 0); assert.strictEqual(b.wave, 1);
    // Las dos jornadas son oleadas PARALELAS: mismos bloques, la segunda +35 min.
    // Dentro de un bloque todos los partidos arrancan simultáneos (§5.3), así que
    // lo que no debe solaparse es la oleada 1 de un bloque con la oleada 0 del
    // mismo bloque (35 min > ~17 min de partido).
    for (const blockId of ['matutino', 'vespertino', 'estelar']) {
      const ka = a.matches.filter(m => m.block === blockId).map(m => m.scheduledKickoffAt);
      const kb = b.matches.filter(m => m.block === blockId).map(m => m.scheduledKickoffAt);
      assert.strictEqual(new Set(ka).size, 1, `${blockId} oleada 0: kickoff simultáneo`);
      assert.strictEqual(new Set(kb).size, 1, `${blockId} oleada 1: kickoff simultáneo`);
      const offset = kb[0] - ka[0];
      assert.strictEqual(offset, WAVE_OFFSET_MIN * 60000, `${blockId}: desfase exacto de +35 min`);
      assert.ok(offset >= MATCH_DURATION_MS, `${blockId}: el desfase excede la duración del partido`);
    }
  }
});

test('generateCalendar es determinista y rechaza bloques que no cuadran', () => {
  const mes = '2026-10';
  const clubs = clubsFor(mes);
  const a = generateCalendar(mes, clubs);
  const b = generateCalendar(mes, clubs);
  assert.strictEqual(a.seed, b.seed);
  assert.deepStrictEqual(a.matches.map(m => m.id), b.matches.map(m => m.id));
  assert.deepStrictEqual(a.matches.map(m => [m.homeId, m.awayId, m.scheduledKickoffAt]),
    b.matches.map(m => [m.homeId, m.awayId, m.scheduledKickoffAt]));

  assert.throws(() => generateCalendar(mes, clubs, { blocks: [{ id: 'x', num: 1, time: '12:00', matches: 4 }] }),
    /no cuadran/, 'bloques que no suman 8 por jornada deben rechazarse');
  assert.throws(() => generateCalendar('2026-13', clubs), /fuera de rango|inválido/);
});

test('zonedTimeToMs convierte hora de pared a epoch en la zona del casino', () => {
  const ms = zonedTimeToMs({ year: 2026, month: 10, day: 15, hour: 13, minute: 0 }, CASINO_TIME_ZONE);
  const { hour, minute } = kickoffParts(ms);
  assert.strictEqual(hour, 13);
  assert.strictEqual(minute, 0);
});
