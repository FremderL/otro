// Pruebas unitarias de la Fase 6: tragamonedas (símbolos, pesos, tabla de pagos y economía).
const assert = require('assert');
const { QUICK_GAMES, SLOT_SYMBOLS, SLOT_PAIR_PAY, normalizeChoice, totalPayoutMultiplier, roll, resultLabel } = require('../lib/quick-games');

function testCatalog() {
  assert.ok(QUICK_GAMES.slots, 'slots está en el catálogo de juegos rápidos');
  assert.deepStrictEqual(QUICK_GAMES.slots.choices, ['spin']);
  assert.strictEqual(normalizeChoice('slots', 'spin'), 'spin');
  assert.strictEqual(normalizeChoice('slots', 'SPIN'), 'spin', 'normaliza mayúsculas');
  assert.strictEqual(normalizeChoice('slots', 'red'), null, 'no acepta elecciones de otros juegos');
  assert.strictEqual(normalizeChoice('slots', 'n:3'), null, 'no acepta números exactos');
  console.log('✓ Catálogo: slots existe y solo acepta la elección "spin"');
}

function testWeights() {
  const total = SLOT_SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
  assert.strictEqual(total, 100, 'los pesos suman 100');
  assert.strictEqual(SLOT_SYMBOLS.length, 5, 'cinco símbolos');
  const premium = SLOT_SYMBOLS.reduce((best, symbol) => (symbol.pay > best.pay ? symbol : best));
  assert.strictEqual(premium.id, 'monte', 'el símbolo premium (pago máximo) es MonteCristo');
  assert.strictEqual(Math.min(...SLOT_SYMBOLS.map(symbol => symbol.weight)), premium.weight, 'el premium es el más raro');
  console.log('✓ Pesos: suman 100 y el símbolo premium es el más raro y el que más paga');
}

function testRollDomain() {
  const ids = new Set(SLOT_SYMBOLS.map(symbol => symbol.id));
  for (let i = 0; i < 500; i++) {
    const out = roll('slots');
    assert.ok(Array.isArray(out.reels) && out.reels.length === 3, 'tres rodillos');
    for (const id of out.reels) assert.ok(ids.has(id), `símbolo válido: ${id}`);
  }
  // Determinismo del generador con pesos: random fijo cae siempre en el mismo símbolo.
  assert.deepStrictEqual(roll('slots', () => 0).reels, ['cherry', 'cherry', 'cherry']);
  assert.deepStrictEqual(roll('slots', () => 0.999).reels, ['monte', 'monte', 'monte']);
  console.log('✓ roll(): 500 giros con símbolos válidos y pesos deterministas en los extremos');
}

function testPaytable() {
  for (const symbol of SLOT_SYMBOLS) {
    const triple = { reels: [symbol.id, symbol.id, symbol.id] };
    assert.strictEqual(totalPayoutMultiplier('slots', 'spin', triple), symbol.pay, `tres ${symbol.id} pagan x${symbol.pay}`);
  }
  assert.strictEqual(totalPayoutMultiplier('slots', 'spin', { reels: ['cherry', 'cherry', 'bell'] }), SLOT_PAIR_PAY, 'par al inicio');
  assert.strictEqual(totalPayoutMultiplier('slots', 'spin', { reels: ['bell', 'cherry', 'cherry'] }), SLOT_PAIR_PAY, 'par al final');
  assert.strictEqual(totalPayoutMultiplier('slots', 'spin', { reels: ['cherry', 'bell', 'cherry'] }), SLOT_PAIR_PAY, 'par en los extremos');
  assert.strictEqual(totalPayoutMultiplier('slots', 'spin', { reels: ['cherry', 'bell', 'gem'] }), 0, 'tres distintos pierden');
  console.log('✓ Tabla de pagos: triples por símbolo, par x1 y pérdida con tres distintos');
}

function testEconomy() {
  // EV teórico = Σ p(triple_i)·pago_i + p(exactamente un par)·SLOT_PAIR_PAY; debe rondar ~0.95 (≤ 1).
  const probabilities = SLOT_SYMBOLS.map(symbol => symbol.weight / 100);
  const tripleEv = SLOT_SYMBOLS.reduce((sum, symbol, i) => sum + Math.pow(probabilities[i], 3) * symbol.pay, 0);
  const allSame = probabilities.reduce((sum, p) => sum + Math.pow(p, 3), 0);
  let allDistinct = 0;
  for (let i = 0; i < probabilities.length; i++) {
    for (let j = 0; j < probabilities.length; j++) {
      for (let k = 0; k < probabilities.length; k++) {
        if (i !== j && j !== k && i !== k) allDistinct += probabilities[i] * probabilities[j] * probabilities[k];
      }
    }
  }
  const pairProbability = 1 - allSame - allDistinct;
  const ev = tripleEv + pairProbability * SLOT_PAIR_PAY;
  assert.ok(ev > 0.85 && ev <= 1, `EV=${ev.toFixed(4)} debe quedar entre 0.85 y 1 para cuidar la economía de fichas`);
  console.log(`✓ Economía: EV teórico ${ev.toFixed(4)} (la casa conserva una ligera ventaja)`);
}

function testLabels() {
  assert.strictEqual(resultLabel('slots', { reels: ['monte', 'gem', 'cherry'] }), 'MonteCristo · Diamante · Cereza');
  console.log('✓ Etiquetas de resultado en español');
}

testCatalog();
testWeights();
testRollDomain();
testPaytable();
testEconomy();
testLabels();
console.log('\nTodas las pruebas de tragamonedas (Fase 6) pasaron.');
