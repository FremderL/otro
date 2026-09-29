'use strict';

const { DIFFICULTIES, STYLES } = require('./catalog');
const { bestPokerScore, compareScores, cardRank } = require('../poker-evaluator');

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const FULL_DECK = SUITS.flatMap(suit => RANKS.map(rank => rank + suit));

function randomBetween(min, max) { return min + Math.random() * (max - min); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function pick(items) { return items[Math.floor(Math.random() * items.length)]; }

function blackjackScore(hand = []) {
  let value = 0;
  let aces = 0;
  for (const card of hand.filter(card => card && card !== 'XX')) {
    const rank = card.slice(0, -1);
    if (rank === 'A') { value += 11; aces++; }
    else if (['K', 'Q', 'J'].includes(rank)) value += 10;
    else value += Number(rank);
  }
  while (value > 21 && aces > 0) { value -= 10; aces--; }
  return { value, soft: aces > 0 };
}

function dealerValue(card) {
  const rank = String(card || '').slice(0, -1);
  if (rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(rank)) return 10;
  return Number(rank) || 10;
}

function sampleCards(source, count) {
  const cards = source.slice();
  for (let index = 0; index < count; index++) {
    const swap = index + Math.floor(Math.random() * (cards.length - index));
    [cards[index], cards[swap]] = [cards[swap], cards[index]];
  }
  return cards.slice(0, count);
}

function preflopEstimate(hand) {
  const [first, second] = hand;
  const high = Math.max(cardRank(first), cardRank(second));
  const low = Math.min(cardRank(first), cardRank(second));
  const pair = high === low;
  const suited = first.slice(-1) === second.slice(-1);
  const gap = high - low;
  let strength = (high + low - 4) / 24 * 0.48;
  if (pair) strength += 0.24 + high / 70;
  if (suited) strength += 0.05;
  if (gap <= 1) strength += 0.055;
  if (high === 14) strength += 0.08;
  return clamp(strength, 0.12, 0.92);
}

function estimatePokerEquity(view, bot, simulations) {
  const me = view.players.find(player => player.id === bot.id);
  const hand = (me?.hand || []).filter(card => card !== 'XX');
  const community = (view.community || []).filter(card => card !== 'XX');
  if (hand.length !== 2) return 0;
  const opponents = Math.max(1, view.players.filter(player => player.id !== bot.id && player.hand?.length === 2 && !player.folded).length);
  if (!community.length && simulations < 70) return clamp(preflopEstimate(hand) ** Math.max(1, opponents * 0.55), 0.04, 0.94);
  const visible = new Set([...hand, ...community]);
  const unknownDeck = FULL_DECK.filter(card => !visible.has(card));
  const missingCommunity = 5 - community.length;
  const cardsNeeded = missingCommunity + opponents * 2;
  let points = 0;
  for (let run = 0; run < simulations; run++) {
    const sampled = sampleCards(unknownDeck, cardsNeeded);
    const board = community.concat(sampled.slice(0, missingCommunity));
    const ownScore = bestPokerScore([...hand, ...board]);
    let tied = 1;
    let beaten = false;
    for (let opponent = 0; opponent < opponents; opponent++) {
      const offset = missingCommunity + opponent * 2;
      const opponentScore = bestPokerScore([sampled[offset], sampled[offset + 1], ...board]);
      const comparison = compareScores(ownScore, opponentScore);
      if (comparison < 0) { beaten = true; break; }
      if (comparison === 0) tied++;
    }
    if (!beaten) points += 1 / tied;
  }
  return points / simulations;
}

function legalPokerActions(view, me) {
  const toCall = Math.max(0, view.currentBet - me.roundBet);
  const actions = [];
  if (toCall > 0) actions.push('fold', 'call');
  else actions.push('check');
  if (me.chips > 0) actions.push('allin');
  if (me.chips - toCall >= view.minRaise) actions.push('raise');
  return { actions, toCall, maxRaise: Math.max(0, me.chips - toCall) };
}

function pokerDecision(view, bot) {
  const me = view.players.find(player => player.id === bot.id);
  if (!me) throw new Error('El bot no aparece en su vista legal de póker.');
  const difficulty = DIFFICULTIES[bot.difficulty];
  const style = STYLES[bot.style];
  const legal = legalPokerActions(view, me);
  const potOdds = legal.toCall / Math.max(1, view.pot + legal.toCall);
  let equity = estimatePokerEquity(view, bot, difficulty.simulations);
  const noise = { easy: 0.18, normal: 0.1, hard: 0.045, expert: 0.02 }[bot.difficulty];
  equity = clamp(equity + randomBetween(-noise, noise), 0, 1);
  const unpredictable = bot.style === 'unpredictable' ? randomBetween(-0.12, 0.12) : 0;
  const aggression = style.aggression + unpredictable;

  if (Math.random() < difficulty.mistakeRate) {
    const safe = legal.actions.filter(action => action !== 'allin' || Math.random() < 0.14);
    const action = pick(safe.length ? safe : legal.actions);
    return action === 'raise' ? { action, amount: Math.min(legal.maxRaise, Math.max(view.minRaise, view.minRaise * (1 + Math.floor(Math.random() * 2)))), insight: { equity, potOdds } } : { action, insight: { equity, potOdds } };
  }

  if (legal.toCall > 0 && equity + aggression < potOdds + 0.08) return { action: 'fold', insight: { equity, potOdds } };
  if (me.chips <= legal.toCall) return { action: 'allin', insight: { equity, potOdds } };

  const raiseThreshold = clamp(0.69 - aggression, 0.43, 0.82);
  if (equity >= raiseThreshold && legal.actions.includes('raise')) {
    const potRaise = Math.max(view.minRaise, Math.floor((view.pot + legal.toCall) * (0.38 + style.risk * 0.28) / view.minRaise) * view.minRaise);
    const amount = clamp(potRaise, view.minRaise, legal.maxRaise);
    if (amount >= view.minRaise) return { action: 'raise', amount, insight: { equity, potOdds } };
  }
  if (equity > 0.88 && legal.actions.includes('allin') && (me.chips < view.pot * 0.65 || bot.style === 'risky')) return { action: 'allin', insight: { equity, potOdds } };
  return { action: legal.toCall > 0 ? 'call' : 'check', insight: { equity, potOdds } };
}

function optimalBlackjackAction(hand, dealerCard, canDouble) {
  const score = blackjackScore(hand);
  const dealer = dealerValue(dealerCard);
  if (score.value >= 21) return 'stand';
  if (score.soft) {
    if (score.value <= 17) {
      if (canDouble && score.value >= 13 && score.value <= 17 && dealer >= 4 && dealer <= 6) return 'double';
      return 'hit';
    }
    if (score.value === 18) {
      if (canDouble && dealer >= 3 && dealer <= 6) return 'double';
      return dealer >= 9 || dealer === 11 ? 'hit' : 'stand';
    }
    return 'stand';
  }
  if (score.value <= 8) return 'hit';
  if (score.value === 9) return canDouble && dealer >= 3 && dealer <= 6 ? 'double' : 'hit';
  if (score.value === 10) return canDouble && dealer <= 9 ? 'double' : 'hit';
  if (score.value === 11) return canDouble && dealer <= 10 ? 'double' : 'hit';
  if (score.value === 12) return dealer >= 4 && dealer <= 6 ? 'stand' : 'hit';
  if (score.value <= 16) return dealer >= 2 && dealer <= 6 ? 'stand' : 'hit';
  return 'stand';
}

function blackjackDecision(view, bot) {
  const me = view.players.find(player => player.id === bot.id);
  if (!me) throw new Error('El bot no aparece en su vista legal de blackjack.');
  const canDouble = me.hand.length === 2 && me.chips >= me.bet;
  let action = optimalBlackjackAction(me.hand, view.dealerHand?.[0], canDouble);
  const difficulty = DIFFICULTIES[bot.difficulty];
  if (Math.random() < difficulty.mistakeRate) {
    const alternatives = ['hit', 'stand', ...(canDouble ? ['double'] : [])].filter(candidate => candidate !== action);
    action = pick(alternatives);
  }
  if (bot.style === 'conservative' && blackjackScore(me.hand).value >= 15 && Math.random() < 0.32) action = 'stand';
  if (['aggressive', 'risky'].includes(bot.style) && blackjackScore(me.hand).value <= 16 && Math.random() < 0.22) action = 'hit';
  return { action };
}

function wagerAmount(chips, bot, game) {
  const style = STYLES[bot.style];
  const difficultyFactor = { easy: 1.15, normal: 1, hard: 0.9, expert: 0.8 }[bot.difficulty];
  const gameFactor = game === 'blackjack' ? 0.85 : 1;
  const rate = randomBetween(0.035, 0.075) * style.risk * difficultyFactor * gameFactor;
  const raw = Math.floor(chips * rate / 5) * 5;
  return clamp(Math.max(10, raw), 10, chips);
}

function blackjackBetDecision(_view, bot) {
  return { action: 'bet', amount: wagerAmount(bot.chips, bot, 'blackjack') };
}

function quickDecision(view, bot) {
  let choices;
  if (view.game === 'roulette') {
    const stable = ['red', 'black', 'even', 'odd', 'low', 'high', 'd1', 'd2', 'd3', 'c1', 'c2', 'c3'];
    if (['risky', 'unpredictable'].includes(bot.style) && Math.random() < 0.35) choices = [`n:${Math.floor(Math.random() * 37)}`];
    else choices = stable;
  } else if (view.game === 'dice') {
    choices = ['low', 'high'];
    if (['risky', 'unpredictable'].includes(bot.style) && Math.random() < 0.36) choices = [`n:${1 + Math.floor(Math.random() * 6)}`];
  } else if (view.game === 'slots') choices = ['spin'];
  else choices = ['heads', 'tails'];
  return { action: 'bet', amount: wagerAmount(bot.chips, bot, view.game), choice: pick(choices) };
}

function decide(view, bot, purpose) {
  if (process.env.BOT_FORCE_DECISION_ERROR === '1') throw new Error('Fallo de decisión simulado.');
  if (purpose === 'poker-turn') return pokerDecision(view, bot);
  if (purpose === 'blackjack-turn') return blackjackDecision(view, bot);
  if (purpose === 'blackjack-bet') return blackjackBetDecision(view, bot);
  if (purpose === 'quick-bet') return quickDecision(view, bot);
  throw new Error(`No existe estrategia para ${purpose}.`);
}

function fallbackDecision(view, bot, purpose) {
  const me = view.players.find(player => player.id === bot.id);
  if (purpose === 'poker-turn') {
    const toCall = Math.max(0, view.currentBet - (me?.roundBet || 0));
    return { action: toCall === 0 ? 'check' : 'fold' };
  }
  if (purpose === 'blackjack-turn') return { action: 'stand' };
  if (purpose === 'blackjack-bet' && bot.chips >= 10) return { action: 'bet', amount: 10 };
  if (purpose === 'quick-bet' && bot.chips >= 10) return { action: 'bet', amount: 10, choice: view.game === 'coinflip' ? 'heads' : view.game === 'slots' ? 'spin' : 'low' };
  return null;
}

function actionLabel(purpose, decision = {}) {
  if (purpose === 'poker-turn') return ({ fold: 'Se retiró', check: 'Pasó', call: 'Igualó', raise: `Subió ${decision.amount || ''}`.trim(), allin: 'Fue all-in' })[decision.action] || 'Actuó';
  if (purpose === 'blackjack-turn') return ({ hit: 'Pidió carta', stand: 'Se plantó', double: 'Dobló' })[decision.action] || 'Actuó';
  return `Apostó ${decision.amount || 0} fichas`;
}

module.exports = {
  blackjackScore, estimatePokerEquity, legalPokerActions,
  decide, fallbackDecision, actionLabel
};
