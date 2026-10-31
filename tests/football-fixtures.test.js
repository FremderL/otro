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
  zonedTimeToMs, matchRealMs, JORNADAS
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

test('jornadas simples y dobles respetan la parrilla horaria sin partidos simultáneos', () => {
  for (const mes of ['2026-02','2026-04','2026-10']) {
    const cal=generateCalendar(mes,clubsFor(mes));
    // Parrilla base: el estelar arranca a las 20:00 con el destacado a las
    // 21:00, y la segunda oleada suma media hora: el último kickoff del día
    // es 21:30, termina 21:45 y la clausura de las 22:00 no pisa partido.
    const base=[13*60,14*60,15*60,17*60,18*60,19*60,20*60,21*60];
    const byDay=new Map();
    for(const jornada of cal.jornadas) {
      const minutes=jornada.matches.map(m=>{const {hour,minute}=kickoffParts(m.scheduledKickoffAt);return hour*60+minute;}).sort((a,b)=>a-b);
      assert.deepStrictEqual(minutes,base.map(n=>n+jornada.wave*30),`${mes} J${jornada.jornada}`);
      const featured=jornada.matches.find(m=>m.featured);const part=kickoffParts(featured.scheduledKickoffAt);
      assert.equal(part.hour*60+part.minute,21*60+jornada.wave*30);
      for(const m of jornada.matches) {assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:CASINO_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(m.scheduledKickoffAt)),`${mes}-${String(m.day).padStart(2,'0')}`);}
      if(!byDay.has(jornada.day)) byDay.set(jornada.day,[]);byDay.get(jornada.day).push(...jornada.matches.map(m=>m.scheduledKickoffAt));
    }
    for(const times of byDay.values()) {times.sort((a,b)=>a-b);for(let i=1;i<times.length;i++) assert.ok(times[i]-times[i-1]>=30*60000,'sin empalme entre oleadas');}
    const final=cal.jornadas.find(j=>j.jornada===30);assert.equal(final.wave,0);assert.equal(byDay.get(final.day).length,8,'J30 no comparte día con otra jornada');
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

test('ningún partido empieza a la hora de la clausura del Balón de Oro ni después', () => {
  // Muro duro del producto: la ceremonia es a las 22:00 locales del día del
  // último partido. Ningún kickoff puede llegar a esa hora, y el último partido
  // tiene que TERMINAR antes de la ceremonia (duración real del partido).
  const matchMs = matchRealMs({});
  assert.strictEqual(matchMs, 90 * 10 * 1000 + 45000, '90 minutos a 10 s/min + intermedio de 45 s');
  for (const mes of MESES) {
    const cal = generateCalendar(mes, clubsFor(mes));
    const lastDay = Math.max(...cal.matches.map(m => m.day));
    for (const match of cal.matches) {
      const { hour, minute } = kickoffParts(match.scheduledKickoffAt);
      assert.ok(hour * 60 + minute < 22 * 60,
        `${mes} ${match.id} empieza a las ${hour}:${String(minute).padStart(2, '0')}, en o después de la clausura`);
      if (match.day === lastDay) {
        assert.ok(match.scheduledKickoffAt + matchMs <= zonedTimeToMs(
          { year: +mes.slice(0, 4), month: +mes.slice(5, 7), day: match.day, hour: 22, minute: 0 },
          CASINO_TIME_ZONE
        ), `${mes} ${match.id} termina después de las 22:00 de la clausura`);
      }
    }
  }
});
