'use strict';

const HAND_NAMES = ['Carta alta', 'Pareja', 'Doble pareja', 'Trío', 'Escalera', 'Color', 'Full house', 'Póker', 'Escalera de color'];

function cardRank(card) {
  const rank = String(card).slice(0, -1);
  return ({ J: 11, Q: 12, K: 13, A: 14 })[rank] || Number(rank);
}

function compareScores(a, b) {
  for (let index = 0; index < Math.max(a?.length || 0, b?.length || 0); index++) {
    const difference = (a?.[index] || 0) - (b?.[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function scoreFive(cards) {
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const suits = cards.map(card => card.slice(-1));
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5 && unique[0] - unique[4] === 4) straightHigh = unique[0];
  else if (unique.join(',') === '14,5,4,3,2') straightHigh = 5;
  const flush = suits.every(suit => suit === suits[0]);
  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.filter(group => group[1] === 1).map(group => group[0]).sort((a, b) => b - a)];
  const pairs = groups.filter(group => group[1] === 2).map(group => group[0]).sort((a, b) => b - a);
  if (pairs.length === 2) return [2, pairs[0], pairs[1], groups.find(group => group[1] === 1)[0]];
  if (pairs.length === 1) return [1, pairs[0], ...groups.filter(group => group[1] === 1).map(group => group[0]).sort((a, b) => b - a)];
  return [0, ...ranks];
}

function bestPokerScore(cards) {
  if (!Array.isArray(cards) || cards.length < 5) return null;
  let best = null;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const score = scoreFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScores(score, best) > 0) best = score;
          }
  return best;
}

module.exports = { HAND_NAMES, cardRank, compareScores, scoreFive, bestPokerScore };
