'use strict';

// Fase A — Pruebas del núcleo determinista (§3.2).
// Sin reproducibilidad no hay idempotencia, catch-up ni auditoría: estas pruebas
// son la base de R1/R2/R3.

const test = require('node:test');
const assert = require('node:assert');
const { hash32, mulberry32, randInt, randRange, chance, pick, shuffle, sample } = require('../lib/football/prng');

test('hash32 es determinista y devuelve un uint32', () => {
  const a = hash32('m_2026-10_j12_b3_1|12|2026-10');
  const b = hash32('m_2026-10_j12_b3_1|12|2026-10');
  assert.strictEqual(a, b, 'el mismo texto debe dar el mismo hash');
  assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xffffffff, 'debe ser uint32');
  assert.notStrictEqual(hash32('desempate|2026-10|a|b'), hash32('desempate|2026-10|b|a'),
    'el orden de los equipos cambia el seed del desempate');
});

test('hash32 distribuye entradas cercanas en valores distintos', () => {
  const seen = new Set();
  for (let j = 1; j <= 30; j++) seen.add(hash32(`2026-10liga${j}`));
  assert.strictEqual(seen.size, 30, '30 entradas distintas no deben colisionar');
});

test('mulberry32 reproduce la misma sucesión para la misma semilla', () => {
  const r1 = mulberry32(123456);
  const r2 = mulberry32(123456);
  const seq1 = Array.from({ length: 50 }, () => r1());
  const seq2 = Array.from({ length: 50 }, () => r2());
  assert.deepStrictEqual(seq1, seq2);
  for (const v of seq1) assert.ok(v >= 0 && v < 1, 'cada valor en [0,1)');
});

test('mulberry32 da sucesiones distintas para semillas distintas', () => {
  const r1 = mulberry32(1);
  const r2 = mulberry32(2);
  assert.notStrictEqual(r1(), r2());
});

test('randInt es inclusivo en ambos extremos y queda en rango', () => {
  const random = mulberry32(999);
  const counts = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = randInt(random, 1, 6);
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 6);
    counts.add(v);
  }
  assert.strictEqual(counts.size, 6, 'un dado sembrado debe sacar las 6 caras');
});

test('randRange y chance quedan en sus rangos', () => {
  const random = mulberry32(4242);
  for (let i = 0; i < 1000; i++) {
    const v = randRange(random, 0.82, 1.18);
    assert.ok(v >= 0.82 && v < 1.18);
    const c = chance(random, 0.25);
    assert.strictEqual(typeof c, 'boolean');
  }
});

test('pick devuelve un elemento del arreglo', () => {
  const random = mulberry32(7);
  const arr = ['a', 'b', 'c'];
  for (let i = 0; i < 100; i++) assert.ok(arr.includes(pick(random, arr)));
});

test('shuffle no muta el original, es determinista y preserva elementos', () => {
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const frozen = original.slice();
  const a = shuffle(mulberry32(55), original);
  const b = shuffle(mulberry32(55), original);
  assert.deepStrictEqual(original, frozen, 'el arreglo de entrada no debe mutar');
  assert.deepStrictEqual(a, b, 'misma semilla → mismo barajado');
  assert.deepStrictEqual(a.slice().sort((x, y) => x - y), frozen, 'preserva los elementos');
  const c = shuffle(mulberry32(56), original);
  assert.notDeepStrictEqual(a, c, 'semilla distinta → barajado distinto');
});

test('sample extrae count elementos sin repetición', () => {
  const random = mulberry32(31337);
  const arr = Array.from({ length: 16 }, (_, i) => `t${i}`);
  const s = sample(random, arr, 5);
  assert.strictEqual(s.length, 5);
  assert.strictEqual(new Set(s).size, 5, 'sin duplicados');
  for (const x of s) assert.ok(arr.includes(x));
  assert.strictEqual(sample(random, arr, 99).length, 16, 'count mayor que el arreglo devuelve todos');
});
