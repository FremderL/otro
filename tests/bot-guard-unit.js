'use strict';

// Auditoría — los timers de los bots ejecutan la lógica completa de juegos
// (execute -> póker/blackjack/ruleta), getView, fallbackDecision, announce y
// broadcast. Antes solo `decide()` tenía try/catch: una excepción en cualquier
// otra pieza subía desde un setTimeout a uncaughtException y tumbaba el
// proceso con todas las mesas. Esta prueba siembra tareas DIRECTAMENTE en el
// controlador (sin esperar timers) y le inyecta callbacks que explotan para
// verificar que runTask jamás propaga una excepción y siempre la reporta.

const assert = require('node:assert/strict');
const { BotController } = require('../lib/bots/bot-controller');

function makeRoom(bot, extra = {}) {
  return {
    code: 'GUARD',
    game: 'coinflip',
    phase: 'betting',
    handNumber: 0,
    turnId: null,
    hostId: bot.id,
    players: [bot],
    ...extra
  };
}
function makeBot(overrides = {}) {
  return {
    id: 'bot-guard-1',
    isBot: true,
    connected: true,
    difficulty: 'expert',
    style: 'calculador',
    name: 'Guardián',
    chips: 500,
    bet: 0,
    status: 'playing',
    folded: false,
    allIn: false,
    botState: { thinking: true },
    botStats: { actions: 0 },
    actionHistory: [],
    ...overrides
  };
}
function seedTask(controller, room, bot, purpose) {
  const key = controller.taskKey(room, bot, purpose);
  controller.tasks.set(key, {
    key,
    timer: null,
    roomCode: room.code,
    botId: bot.id,
    purpose,
    token: controller.stateToken(room, bot, purpose),
    isDecision: !purpose.startsWith('host-')
  });
  return key;
}

// === 1) execute() lanza en una tarea de anfitrión: no debe propagarse ===
{
  const bot = makeBot();
  const room = makeRoom(bot);
  const errors = [];
  const controller = new BotController({
    roomExists: () => true,
    getRoom: () => room,
    execute: () => { throw new Error('explosión simulada en la lógica del juego'); },
    broadcast: () => {},
    logError: entry => errors.push(entry)
  });
  const key = seedTask(controller, room, bot, 'host-quick-resolve');
  assert.doesNotThrow(() => controller.runTask(key), 'un execute que lanza jamás debe salir de runTask');
  assert.equal(errors.length, 1, 'el error queda registrado vía logError');
  assert.match(String(errors[0].error.message), /explosión simulada/);
  assert.equal(errors[0].purpose, 'host-quick-resolve');
}

// === 2) decide/fallback/getView en cascada fallan: tampoco debe propagarse ===
{
  const bot = makeBot();
  const room = makeRoom(bot);
  const errors = [];
  const controller = new BotController({
    roomExists: () => true,
    getRoom: () => room,
    getView: () => { throw new Error('vista rota'); }, // decide(view) explota y fallbackDecision también
    execute: () => ({ ok: true }),
    broadcast: () => {},
    logError: entry => errors.push(entry)
  });
  const key = seedTask(controller, room, bot, 'quick-bet');
  assert.doesNotThrow(() => controller.runTask(key), 'una cadena de fallos de decisión no debe salir de runTask');
  assert.equal(bot.botState.thinking, false, 'el bot nunca se queda "pensando" para siempre');
  assert.ok(errors.length >= 1, 'el fallo quedó registrado');
}

// === 3) broadcast lanza al final de una jugada válida: no debe propagarse ===
{
  const bot = makeBot();
  const room = makeRoom(bot);
  const errors = [];
  const announced = [];
  const controller = new BotController({
    roomExists: () => true,
    getRoom: () => room,
    execute: () => ({ ok: true }),
    broadcast: () => { throw new Error('broadcast roto'); },
    announce: (r, b, label) => announced.push(label),
    logError: entry => errors.push(entry)
  });
  const key = seedTask(controller, room, bot, 'host-quick-resolve');
  assert.doesNotThrow(() => controller.runTask(key), 'un broadcast que lanza no debe salir de runTask');
  assert.equal(errors.length, 1, 'el fallo del broadcast queda registrado');
  assert.match(String(errors[0].error.message), /broadcast roto/);
}

// === 4) Camino feliz intacto: execute normal sigue funcionando y anunciando ===
{
  const bot = makeBot();
  const room = makeRoom(bot);
  const announced = [];
  const broadcasts = [];
  const controller = new BotController({
    roomExists: () => true,
    getRoom: () => room,
    execute: () => ({ ok: true }),
    broadcast: () => broadcasts.push(1),
    announce: (r, b, label) => announced.push(label),
    logError: () => { throw new Error('no debió registrarse ningún error en el camino feliz'); }
  });
  const key = seedTask(controller, room, bot, 'host-quick-resolve');
  assert.doesNotThrow(() => controller.runTask(key));
  assert.equal(broadcasts.length, 1, 'el camino feliz sigue emitiendo broadcast');
}

// === 5) Tarea de una mesa que ya no existe: no debe propagarse ===
{
  const bot = makeBot();
  const room = makeRoom(bot);
  const controller = new BotController({
    roomExists: () => false,
    getRoom: () => undefined,
    logError: () => {}
  });
  const key = seedTask(controller, room, bot, 'host-quick-new');
  assert.doesNotThrow(() => controller.runTask(key), 'mesa inexistente se descarta sin ruido');
}

console.log('✔ bot-guard-unit: errores de execute/decide/broadcast dentro de un timer de bot nunca tumban el proceso');
