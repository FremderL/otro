'use strict';

const crypto = require('node:crypto');
const { INITIAL_CHIPS } = require('../profile-store');

const DIFFICULTIES = Object.freeze({
  easy: { id: 'easy', label: 'Fácil', minDelay: 2000, maxDelay: 5000, mistakeRate: 0.28, simulations: 35 },
  normal: { id: 'normal', label: 'Normal', minDelay: 1500, maxDelay: 4000, mistakeRate: 0.14, simulations: 90 },
  hard: { id: 'hard', label: 'Difícil', minDelay: 1000, maxDelay: 3000, mistakeRate: 0.06, simulations: 180 },
  expert: { id: 'expert', label: 'Experto', minDelay: 800, maxDelay: 2500, mistakeRate: 0.015, simulations: 320 }
});

const STYLES = Object.freeze({
  conservative: { id: 'conservative', label: 'Conservador', aggression: -0.18, risk: 0.55 },
  aggressive: { id: 'aggressive', label: 'Agresivo', aggression: 0.2, risk: 1.25 },
  balanced: { id: 'balanced', label: 'Equilibrado', aggression: 0, risk: 0.85 },
  risky: { id: 'risky', label: 'Arriesgado', aggression: 0.12, risk: 1.55 },
  unpredictable: { id: 'unpredictable', label: 'Impredecible', aggression: 0.04, risk: 1.1 }
});

const BOT_NAMES = [
  'Nova', 'Menta', 'Atlas', 'Kira', 'Pixel', 'Nébula', 'Roko', 'Luna',
  'Cosmo', 'Bambú', 'Orion', 'Moka', 'Vega', 'Chispa', 'Turing', 'Sombra'
];
const BOT_AVATARS = ['robot', 'alien', 'owl', 'fox', 'tiger', 'panda', 'diamond', 'crown'];

function normalizeDifficulty(value) {
  return DIFFICULTIES[value] ? value : 'normal';
}
function normalizeStyle(value) {
  return STYLES[value] ? value : 'balanced';
}

function createBotProfile(id, name, avatar, chips = INITIAL_CHIPS) {
  const now = Date.now();
  return {
    id, name, avatar, chips,
    stats: { roundsPlayed: 0, wins: 0, losses: 0, biggestWin: 0, totalWagered: 0, currentStreak: 0, bestStreak: 0, eligibleCurrentStreak: 0, eligibleBestStreak: 0, eligibleTracking: true },
    gamesPlayed: [], achievements: [], challenges: {}, rotatingChallenges: { daily: null, weekly: null }, featuredAchievements: [], dailyBonusDate: null,
    transactions: [], flags: { bot: true }, createdAt: now, updatedAt: now
  };
}

function createBot(room, options = {}) {
  const difficulty = normalizeDifficulty(options.difficulty);
  const style = normalizeStyle(options.style);
  const usedNames = new Set(room.players.map(player => player.name));
  const baseName = BOT_NAMES.find(name => !usedNames.has(name)) || `Bot ${room.players.length + 1}`;
  const name = String(options.name || baseName).replace(/[<>]/g, '').trim().slice(0, 18) || baseName;
  const id = `bot:${crypto.randomUUID()}`;
  const avatar = BOT_AVATARS[(room.players.length + Math.floor(Math.random() * BOT_AVATARS.length)) % BOT_AVATARS.length];
  const profile = createBotProfile(id, name, avatar);
  const bot = {
    id, socketId: null, name, avatar, connected: true, isBot: true,
    difficulty, style,
    hand: [], bet: 0, roundBet: 0, totalBet: 0, status: 'waiting',
    folded: false, allIn: false, acted: false, quickChoice: null,
    botState: { roomCode: room.code, game: room.game, inRound: false, isTurn: false, thinking: false, lastAction: null, lastActionAt: null, errors: 0 },
    botStats: { roundsPlayed: 0, wins: 0, losses: 0, pushes: 0, chipsWon: 0, chipsLost: 0, actions: 0, games: [] },
    actionHistory: []
  };
  Object.defineProperty(bot, '_profile', { value: profile, enumerable: false });
  Object.defineProperty(bot, 'chips', {
    enumerable: true,
    get: () => profile.chips,
    set: value => {
      profile.chips = Math.max(0, Math.floor(Number(value) || 0));
      profile.updatedAt = Date.now();
    }
  });
  return bot;
}

function publicBot(bot) {
  if (!bot?.isBot) return null;
  return {
    difficulty: bot.difficulty,
    difficultyLabel: DIFFICULTIES[bot.difficulty].label,
    style: bot.style,
    styleLabel: STYLES[bot.style].label,
    thinking: Boolean(bot.botState?.thinking),
    lastAction: bot.botState?.lastAction || null,
    lastActionAt: bot.botState?.lastActionAt || null,
    state: {
      game: bot.botState?.game,
      inRound: Boolean(bot.botState?.inRound),
      isTurn: Boolean(bot.botState?.isTurn)
    },
    stats: { ...bot.botStats },
    history: (bot.actionHistory || []).slice(-8)
  };
}

module.exports = {
  DIFFICULTIES, STYLES, BOT_NAMES, BOT_AVATARS,
  normalizeDifficulty, normalizeStyle, createBot, publicBot
};
