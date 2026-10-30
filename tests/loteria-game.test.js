'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/loteria/game');
const rand = n => n - 1;

test('inscripción, privacidad, límite de cartones y cierre', () => {
  const game = L.newGame({ id:'uno', openedAt:100, random:rand });
  const one = L.join(game,'uno',100,rand);
  assert.equal(one.debit,50); assert.equal(new Set(one.board).size,16);
  assert.equal(L.join(game,'uno',101,rand).reason,'duplicate');
  assert.equal(L.publicState(game,'otro').board,null);
  assert.equal('deck' in L.publicState(game,'uno'),false);
  for (let i=1;i<100;i++) assert.equal(L.join(game,`p${i}`,102,rand).ok,true);
  assert.equal(L.join(game,'extra',102,rand).reason,'full');
  assert.equal(L.join(game,'tarde',game.closesAt,rand).reason,'closed');
});

test('desconexión previa reembolsa, cancelación reembolsa y conserva acumulado', () => {
  const game = L.newGame({ id:'dos', openedAt:100, carry:3, random:rand });
  L.join(game,'a',101,rand); L.join(game,'b',102,rand);
  assert.equal(L.disconnect(game,'b',game.closesAt-1).refund,50);
  const events = L.advance(game,game.closesAt);
  assert.equal(game.status,'cancelled'); assert.deepEqual(events[0].refunds,[{profileId:'a',amount:50}]);
  assert.equal(events[0].carry,3); assert.deepEqual(L.advance(game,game.closesAt+1000),[]);
});

test('canto automático cada dos segundos, empate y arrastre, sin doble liquidación', () => {
  const game = L.newGame({id:'tres',openedAt:0,carry:1,random:rand});
  for (const id of ['a','b','c']) L.join(game,id,0,rand);
  assert.deepEqual(L.advance(game,game.closesAt),[{type:'started'}]);
  assert.equal(L.disconnect(game,'a',game.closesAt).reason,'already_started');
  assert.deepEqual(L.advance(game,game.closesAt+1999),[]);
  assert.equal(L.advance(game,game.closesAt+2000)[0].card,1);
  const events = L.advance(game,game.closesAt+L.CALL_INTERVAL_MS*54);
  assert.equal(game.called.length,16); assert.equal(events.at(-1).type,'settled');
  assert.equal(game.result.pot,151); assert.equal(game.result.carry,1);
  assert.deepEqual(game.result.winners.map(w => w.amount),[50,50,50]);
  assert.deepEqual(L.advance(game,game.closesAt+200000),[]);
  assert.ok(!JSON.stringify(L.publicState(game,'a')).includes('profileId'));
  assert.equal(L.publicState(game,'a').result.myPayout,50);
  assert.equal(L.publicState(game,'observer').result.myPayout,0);
});

test('aleatoriedad inyectada inválida se rechaza', () => {
  assert.throws(() => L.newGame({id:'x',openedAt:1,random:()=>-1}),RangeError);
  assert.throws(() => L.newGame({id:'x',openedAt:1,random:n=>n}),RangeError);
});


test('rechaza tiempos inválidos y bote que podría desbordarse', () => {
  assert.throws(() => L.newGame({id:'x', openedAt:0, carry:Number.MAX_SAFE_INTEGER}),TypeError);
  const game = L.newGame({id:'x', openedAt:100, random:rand});
  assert.equal(L.join(game, 'a', NaN, rand).reason,'closed');
  assert.equal(L.disconnect(game, 'a', 1).reason,'already_started');
});
