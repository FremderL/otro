'use strict';

// Fase A — Pruebas de clubes y plantillas (§5.5, decisión B3).

const test = require('node:test');
const assert = require('node:assert');
const { hash32, mulberry32 } = require('../lib/football/prng');
const {
  CLUBS, CLUB_IDS, buildSeasonClubs, generateSquad, seedRatings,
  applySeasonCarryover, validateClubs, SQUAD_SLOTS, RATING_RANGE
} = require('../lib/football/teams');

const clubsFor = (seedText) => buildSeasonClubs(mulberry32(hash32(seedText)));

test('hay exactamente 16 clubes válidos con ids y cortos únicos', () => {
  const { ok, errors } = validateClubs(CLUBS);
  assert.ok(ok, `validación de clubes falló: ${errors.join('; ')}`);
  assert.strictEqual(CLUBS.length, 16);
  assert.strictEqual(new Set(CLUB_IDS).size, 16, 'ids únicos');
  assert.strictEqual(new Set(CLUBS.map(c => c.short)).size, 16, 'códigos cortos únicos');
  assert.strictEqual(new Set(CLUBS.map(c => c.name)).size, 16, 'nombres únicos');
});

test('los 16 códigos cortos coinciden con la tabla validada de §5.5', () => {
  const esperados = ['VTR', 'VNG', 'EST', 'SOL', 'ALM', 'KLV', 'VRD', 'HLC', 'FRR', 'CRV', 'TLB', 'VLM', 'NVL', 'IRN', 'PRG', 'AMB'];
  assert.deepStrictEqual(CLUBS.map(c => c.short), esperados);
});

test('buildSeasonClubs es determinista a partir del seed', () => {
  const a = clubsFor('2026-10plantillas');
  const b = clubsFor('2026-10plantillas');
  assert.deepStrictEqual(a, b, 'mismo seed → mismos clubes, ratings y planteles');
  const c = clubsFor('2026-11plantillas');
  assert.notDeepStrictEqual(a.map(x => x.ratings), c.map(x => x.ratings), 'otro mes → otros ratings');
});

test('cada club tiene 18 jugadores con números 1-18 e ids únicos', () => {
  const clubs = clubsFor('2026-10plantillas');
  for (const club of clubs) {
    assert.strictEqual(club.squad.length, 18, `${club.id}: 18 jugadores`);
    const nums = club.squad.map(p => p.num).sort((x, y) => x - y);
    assert.deepStrictEqual(nums, Array.from({ length: 18 }, (_, i) => i + 1), `${club.id}: números 1-18`);
    const ids = club.squad.map(p => p.id);
    assert.strictEqual(new Set(ids).size, 18, `${club.id}: ids de jugador únicos`);
    assert.strictEqual(SQUAD_SLOTS.length, 18);
  }
});

test('los nombres de jugador no se repiten en toda la liga (288)', () => {
  const clubs = clubsFor('2026-10plantillas');
  const names = clubs.flatMap(c => c.squad.map(p => p.name));
  assert.strictEqual(names.length, 288);
  assert.strictEqual(new Set(names).size, 288, 'ningún homónimo en la liga');
});

test('los ratings iniciales quedan dentro de la dispersión controlada (§5.5)', () => {
  const clubs = clubsFor('2026-10plantillas');
  for (const club of clubs) {
    const r = club.ratings;
    assert.ok(r.elo >= RATING_RANGE.elo[0] && r.elo <= RATING_RANGE.elo[1], `${club.id} elo ${r.elo}`);
    for (const key of ['att', 'def', 'gk']) {
      assert.ok(r[key] >= RATING_RANGE[key][0] && r[key] <= RATING_RANGE[key][1], `${club.id} ${key} ${r[key]}`);
    }
  }
});

test('los atributos de cada jugador respetan el rango de su posición', () => {
  const random = mulberry32(hash32('attrs'));
  const club = CLUBS[0];
  const squad = generateSquad(club, random, new Set());
  // Validación conductual sobre la API pública: un portero tiene gk alto y sho
  // bajo; un delantero tiene sho alto y def bajo (§5.5).
  const gk = squad.find(p => p.pos === 'GK');
  const fw = squad.find(p => p.pos === 'ST');
  assert.ok(gk.attrs.gk >= 70, 'portero con gk alto');
  assert.ok(gk.attrs.sho <= 40, 'portero con sho bajo');
  assert.ok(fw.attrs.sho >= 70, 'delantero con sho alto');
  assert.ok(fw.attrs.def <= 45, 'delantero con def bajo');
  for (const p of squad) {
    for (const v of Object.values(p.attrs)) assert.ok(v >= 10 && v <= 92, 'atributos en rango sano');
    assert.deepStrictEqual(Object.keys(p.season).sort(), ['assists', 'goals', 'minutes', 'red', 'yellow']);
  }
});

test('applySeasonCarryover ajusta el elo y lo acota a ±40', () => {
  const clubs = clubsFor('2026-10plantillas');
  const before = Object.fromEntries(clubs.map(c => [c.id, c.ratings.elo]));
  applySeasonCarryover(clubs, { [clubs[0].id]: 25, [clubs[15].id]: -25, [clubs[1].id]: 9999 });
  assert.strictEqual(clubs[0].ratings.elo, before[clubs[0].id] + 25, 'campeón sube 25');
  assert.strictEqual(clubs[15].ratings.elo, before[clubs[15].id] - 25, 'colista baja 25');
  assert.strictEqual(clubs[1].ratings.elo, before[clubs[1].id] + 40, 'delta enorme se acota a +40');
});

test('seedRatings devuelve valores en rango y reproducibles', () => {
  const a = seedRatings(mulberry32(123));
  const b = seedRatings(mulberry32(123));
  assert.deepStrictEqual(a, b);
  assert.ok(a.elo >= 1380 && a.elo <= 1620);
});
