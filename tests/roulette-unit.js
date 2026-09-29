// Pruebas unitarias de la Fase 5: docenas, columnas y coherencia del motor de ruleta.
const assert = require('assert');
const { QUICK_GAMES, normalizeChoice, totalPayoutMultiplier, choiceLabel, roll } = require('../lib/quick-games');

function result(value) {
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  return { value, color: value === 0 ? 'green' : RED.has(value) ? 'red' : 'black' };
}

function testNormalize() {
  for (const choice of ['d1', 'd2', 'd3', 'c1', 'c2', 'c3']) {
    assert.strictEqual(normalizeChoice('roulette', choice), choice, `normalizeChoice acepta ${choice}`);
    assert.ok(QUICK_GAMES.roulette.choices.includes(choice), `${choice} está en el catálogo`);
  }
  assert.strictEqual(normalizeChoice('roulette', 'd4'), null, 'd4 no existe');
  assert.strictEqual(normalizeChoice('roulette', 'c0'), null, 'c0 no existe');
  assert.strictEqual(normalizeChoice('roulette', 'n:37'), null, 'n:37 fuera de rango');
  assert.strictEqual(normalizeChoice('roulette', 'n:0'), 'n:0', 'pleno al cero válido');
  console.log('✓ normalizeChoice: docenas y columnas válidas, valores inventados rechazados');
}

function testDozens() {
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd1', result(1)), 3);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd1', result(12)), 3);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd1', result(13)), 0);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd2', result(13)), 3);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd2', result(24)), 3);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd2', result(25)), 0);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd3', result(25)), 3);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd3', result(36)), 3);
  assert.strictEqual(totalPayoutMultiplier('roulette', 'd3', result(24)), 0);
  for (const dozen of ['d1', 'd2', 'd3']) assert.strictEqual(totalPayoutMultiplier('roulette', dozen, result(0)), 0, `${dozen} pierde con el 0`);
  console.log('✓ Docenas: pagan x3 en su rango y pierden con el 0');
}

function testColumns() {
  // Columna 1: 1,4,…,34 · Columna 2: 2,5,…,35 · Columna 3: 3,6,…,36
  for (let n = 1; n <= 36; n++) {
    const winner = n % 3 === 1 ? 'c1' : n % 3 === 2 ? 'c2' : 'c3';
    for (const column of ['c1', 'c2', 'c3']) {
      assert.strictEqual(
        totalPayoutMultiplier('roulette', column, result(n)),
        column === winner ? 3 : 0,
        `columna ${column} con el número ${n}`
      );
    }
  }
  for (const column of ['c1', 'c2', 'c3']) assert.strictEqual(totalPayoutMultiplier('roulette', column, result(0)), 0, `${column} pierde con el 0`);
  console.log('✓ Columnas: pagan x3 exactamente en su columna y pierden con el 0');
}

function testLabels() {
  assert.strictEqual(choiceLabel('roulette', 'd1'), 'Docena 1–12');
  assert.strictEqual(choiceLabel('roulette', 'd2'), 'Docena 13–24');
  assert.strictEqual(choiceLabel('roulette', 'd3'), 'Docena 25–36');
  assert.strictEqual(choiceLabel('roulette', 'c1'), 'Columna 1');
  assert.strictEqual(choiceLabel('roulette', 'c3'), 'Columna 3');
  console.log('✓ Etiquetas en español para docenas y columnas');
}

function testRollDomain() {
  // La rueda europea usa un solo 0: el resultado siempre está en 0–36 con el color correcto.
  const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  assert.strictEqual(new Set(WHEEL_ORDER).size, 37, 'la rueda cliente tiene 37 casillas únicas');
  for (let i = 0; i < 500; i++) {
    const out = roll('roulette');
    assert.ok(Number.isInteger(out.value) && out.value >= 0 && out.value <= 36, 'valor 0–36');
    assert.ok(WHEEL_ORDER.includes(out.value), 'todo resultado del servidor existe en la rueda dibujada');
    assert.ok(['red', 'black', 'green'].includes(out.color), 'color válido');
    assert.strictEqual(out.color, result(out.value).color, 'color coherente con el número');
  }
  console.log('✓ roll(): 500 resultados dentro de la rueda europea y con color coherente');
}

testNormalize();
testDozens();
testColumns();
testLabels();
testRollDomain();
console.log('\nTodas las pruebas de ruleta (Fase 5) pasaron.');
