function rollSpecialEvent(random = Math.random) {
  const chance = random();
  if (chance < .04) return { type: 'jackpot', icon: '💎', label: 'Jackpot virtual', description: '+500 fichas para cada ganador', fixedBonus: 500 };
  if (chance < .11) return { type: 'multiplier', icon: '✦', label: 'Ganancia x2', description: 'La ganancia neta de esta ronda se duplica', multiplier: 2 };
  if (chance < .19) return { type: 'bonus', icon: '🎁', label: 'Ronda bonus', description: '+75 fichas para cada ganador', fixedBonus: 75 };
  return null;
}

function bonusFor(event, positiveNet) {
  if (!event || positiveNet <= 0) return 0;
  if (event.fixedBonus) return event.fixedBonus;
  if (event.multiplier > 1) return Math.floor(positiveNet * (event.multiplier - 1));
  return 0;
}

module.exports = { rollSpecialEvent, bonusFor };
