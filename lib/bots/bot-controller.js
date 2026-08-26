'use strict';

const { DIFFICULTIES } = require('./catalog');
const { decide, fallbackDecision, actionLabel } = require('./decision-engine');

class BotController {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.tasks = new Map();
    this.speedFactor = Math.max(0.001, Number(process.env.BOT_SPEED_FACTOR) || 1);
  }

  taskKey(room, bot, purpose) { return `${room.code}:${bot.id}:${purpose}`; }
  stateToken(room, bot, purpose) {
    return [room.code, room.game, room.phase, room.handNumber, room.turnId || '-', bot.id, purpose, bot.bet, bot.status, bot.chips].join('|');
  }
  reactionDelay(bot, purpose) {
    const difficulty = DIFFICULTIES[bot.difficulty] || DIFFICULTIES.normal;
    let min = difficulty.minDelay;
    let max = difficulty.maxDelay;
    if (purpose.startsWith('host-')) { min += 1200; max += 2200; }
    const delay = min + Math.random() * (max - min);
    return Math.max(10, Math.floor(delay * this.speedFactor));
  }

  sync(room) {
    if (!room || !this.callbacks.roomExists?.(room.code)) return;
    const plans = this.buildPlans(room);
    const expected = new Set(plans.map(plan => this.taskKey(room, plan.bot, plan.purpose)));
    for (const [key, task] of this.tasks) {
      if (task.roomCode === room.code && !expected.has(key)) this.cancelTask(key, false);
    }
    for (const plan of plans) this.schedule(room, plan.bot, plan.purpose);
  }

  buildPlans(room) {
    const plans = [];
    const bots = room.players.filter(player => player.isBot && player.connected);
    for (const bot of bots) {
      bot.botState.roomCode = room.code;
      bot.botState.game = room.game;
      bot.botState.inRound = ['preflop', 'flop', 'turn', 'river', 'playing', 'rolling'].includes(room.phase);
      bot.botState.isTurn = room.turnId === bot.id;
      if (room.game === 'poker' && room.turnId === bot.id && ['preflop', 'flop', 'turn', 'river'].includes(room.phase) && !bot.folded && !bot.allIn) {
        plans.push({ bot, purpose: 'poker-turn' });
      } else if (room.game === 'blackjack') {
        if (room.phase === 'betting' && bot.bet === 0 && bot.chips >= 10) plans.push({ bot, purpose: 'blackjack-bet' });
        if (room.phase === 'playing' && room.turnId === bot.id && bot.status === 'playing') plans.push({ bot, purpose: 'blackjack-turn' });
      } else if (['roulette', 'dice', 'coinflip'].includes(room.game) && room.phase === 'betting' && bot.bet === 0 && bot.chips >= 10) {
        plans.push({ bot, purpose: 'quick-bet' });
      }
    }

    const host = bots.find(bot => bot.id === room.hostId);
    if (!host) return plans;
    if (room.game === 'poker' && ['waiting', 'showdown'].includes(room.phase)) {
      if (room.players.filter(player => player.connected && player.chips >= 20).length >= 2) plans.push({ bot: host, purpose: 'host-poker-start' });
    } else if (room.game === 'blackjack') {
      const eligibleBotsWaiting = bots.some(bot => bot.chips >= 10 && bot.bet === 0);
      if (room.phase === 'betting' && !eligibleBotsWaiting && room.players.some(player => player.connected && player.bet > 0)) plans.push({ bot: host, purpose: 'host-blackjack-start' });
      if (room.phase === 'results') plans.push({ bot: host, purpose: 'host-blackjack-new' });
    } else if (['roulette', 'dice', 'coinflip'].includes(room.game)) {
      const eligibleBotsWaiting = bots.some(bot => bot.chips >= 10 && bot.bet === 0);
      if (room.phase === 'betting' && !eligibleBotsWaiting && room.players.some(player => player.connected && player.bet > 0)) plans.push({ bot: host, purpose: 'host-quick-resolve' });
      if (room.phase === 'results') plans.push({ bot: host, purpose: 'host-quick-new' });
    }
    return plans;
  }

  schedule(room, bot, purpose) {
    const key = this.taskKey(room, bot, purpose);
    if (this.tasks.has(key)) return;
    const token = this.stateToken(room, bot, purpose);
    const isDecision = !purpose.startsWith('host-');
    const task = { key, timer: null, roomCode: room.code, botId: bot.id, purpose, token, isDecision };
    this.tasks.set(key, task);
    if (isDecision) {
      bot.botState.thinking = true;
      this.callbacks.publish?.(room);
    }
    task.timer = setTimeout(() => this.runTask(key), this.reactionDelay(bot, purpose));
    task.timer.unref?.();
  }

  runTask(key) {
    const task = this.tasks.get(key);
    if (!task) return;
    this.tasks.delete(key);
    const room = this.callbacks.getRoom?.(task.roomCode);
    const bot = room?.players.find(player => player.id === task.botId && player.isBot);
    if (!room || !bot) return;
    if (this.stateToken(room, bot, task.purpose) !== task.token) {
      if (task.isDecision) bot.botState.thinking = false;
      this.callbacks.broadcast?.(room);
      return;
    }

    if (task.purpose.startsWith('host-')) {
      const result = this.callbacks.execute?.(room, bot, task.purpose, {});
      if (!result?.ok) this.registerError(room, bot, task.purpose, new Error(result?.error || 'Acción automática de anfitrión rechazada'));
      this.callbacks.broadcast?.(room);
      return;
    }

    const view = this.callbacks.getView?.(room, bot.id);
    let decision;
    let usedFallback = false;
    try {
      decision = decide(view, bot, task.purpose);
    } catch (error) {
      usedFallback = true;
      this.registerError(room, bot, task.purpose, error);
      decision = fallbackDecision(view, bot, task.purpose);
    }

    let result = decision ? this.callbacks.execute?.(room, bot, task.purpose, decision) : { ok: false, error: 'No existe alternativa válida.' };
    if (!result?.ok && !usedFallback) {
      usedFallback = true;
      this.registerError(room, bot, task.purpose, new Error(result?.error || 'La acción elegida fue rechazada'));
      decision = fallbackDecision(view, bot, task.purpose);
      result = decision ? this.callbacks.execute?.(room, bot, task.purpose, decision) : result;
    }
    if (!result?.ok) {
      this.registerError(room, bot, task.purpose, new Error(result?.error || 'El fallback del bot falló'));
      this.callbacks.forceSafeAction?.(room, bot, task.purpose);
      decision = fallbackDecision(view, bot, task.purpose) || { action: 'automatic' };
    }

    bot.botState.thinking = false;
    const label = actionLabel(task.purpose, decision);
    bot.botState.lastAction = label;
    bot.botState.lastActionAt = Date.now();
    bot.botStats.actions++;
    bot.actionHistory.push({ game: room.game, purpose: task.purpose, action: decision.action, amount: decision.amount || 0, fallback: usedFallback, time: Date.now() });
    bot.actionHistory = bot.actionHistory.slice(-30);
    this.callbacks.announce?.(room, bot, label, { fallback: usedFallback });
    this.callbacks.broadcast?.(room);
  }

  registerError(room, bot, purpose, error) {
    bot.botState.errors = (bot.botState.errors || 0) + 1;
    this.callbacks.logError?.({ roomCode: room.code, botId: bot.id, botName: bot.name, game: room.game, purpose, error });
  }

  cancelTask(key, publish = true) {
    const task = this.tasks.get(key);
    if (!task) return;
    clearTimeout(task.timer);
    this.tasks.delete(key);
    const room = this.callbacks.getRoom?.(task.roomCode);
    const bot = room?.players.find(player => player.id === task.botId);
    if (bot && task.isDecision) bot.botState.thinking = false;
    if (publish && room) this.callbacks.broadcast?.(room);
  }

  cancelBot(roomCode, botId) {
    for (const [key, task] of this.tasks) if (task.roomCode === roomCode && task.botId === botId) this.cancelTask(key, false);
  }

  cancelRoom(roomCode) {
    for (const [key, task] of this.tasks) if (task.roomCode === roomCode) this.cancelTask(key, false);
  }

  pendingForRoom(roomCode) {
    return [...this.tasks.values()].filter(task => task.roomCode === roomCode).length;
  }
}

module.exports = { BotController };
