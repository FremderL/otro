'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FORTUNE_SECTORS, normalizeChoice, roll, totalPayoutMultiplier, choiceLabel, resultLabel } = require('../lib/quick-games');

test('rueda usa 54 sectores equiprobables y conserva los pagos acordados', () => {
  const counts = {1:25,2:15,5:7,10:4,20:2,40:1};
  assert.equal(FORTUNE_SECTORS.length,54);
  for (const [key,n] of Object.entries(counts)) {
    assert.equal(FORTUNE_SECTORS.filter(x=>x===Number(key)).length,n);
    assert.equal(normalizeChoice('fortune',key),key);
    assert.equal(totalPayoutMultiplier('fortune',key,{value:Number(key)}),Number(key)+1);
    assert.equal(totalPayoutMultiplier('fortune',key,{value:-1}),0);
    assert.match(choiceLabel('fortune',key),new RegExp(key));
  }
  for (let i=0;i<54;i++) assert.equal(roll('fortune',()=>(i+.5)/54).value,FORTUNE_SECTORS[i]);
  assert.equal(normalizeChoice('fortune','41'),null);
  assert.equal(totalPayoutMultiplier('fortune','41',{value:41}),0);
  assert.equal(resultLabel('fortune',{value:40}),'Sector 40');
});

test('el sorteo por defecto produce solo sectores válidos y rechaza índices inválidos inyectados', () => {
  for (let i = 0; i < 1000; i++) assert.ok(FORTUNE_SECTORS.includes(roll('fortune').value));
  for (const value of [-1, 1, NaN, Infinity]) assert.throws(() => roll('fortune', () => value), RangeError);
});
