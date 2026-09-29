const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

const QUICK_GAMES = {
  roulette: {
    name: 'Ruleta Nova', icon: '◉', description: 'Paño europeo completo: color, paridad, rango, docenas, columnas o pleno.',
    choices: ['red', 'black', 'even', 'odd', 'low', 'high', 'd1', 'd2', 'd3', 'c1', 'c2', 'c3']
  },
  dice: {
    name: 'Dados Cósmicos', icon: '⚄', description: 'Apuesta por bajo, alto o un número exacto.',
    choices: ['low', 'high']
  },
  coinflip: {
    name: 'Cara o Cruz', icon: '◐', description: 'Una decisión, una moneda y un resultado inmediato.',
    choices: ['heads', 'tails']
  }
};

function isQuickGame(game) { return Boolean(QUICK_GAMES[game]); }

function normalizeChoice(game, raw) {
  const value = String(raw || '').toLowerCase().trim();
  if (!isQuickGame(game)) return null;
  if (QUICK_GAMES[game].choices.includes(value)) return value;
  if (game === 'roulette' && /^n:(?:[0-9]|[12][0-9]|3[0-6])$/.test(value)) return value;
  if (game === 'dice' && /^n:[1-6]$/.test(value)) return value;
  return null;
}

function roll(game, random = Math.random) {
  if (game === 'roulette') {
    const number = Math.floor(random() * 37);
    return { value: number, color: number === 0 ? 'green' : RED_NUMBERS.has(number) ? 'red' : 'black' };
  }
  if (game === 'dice') return { value: Math.floor(random() * 6) + 1 };
  if (game === 'coinflip') return { value: random() < .5 ? 'heads' : 'tails' };
  return null;
}

function totalPayoutMultiplier(game, choice, result) {
  if (game === 'roulette') {
    const number = result.value;
    if (choice.startsWith('n:')) return Number(choice.slice(2)) === number ? 36 : 0;
    if (number === 0) return 0;
    if (choice === 'red') return result.color === 'red' ? 2 : 0;
    if (choice === 'black') return result.color === 'black' ? 2 : 0;
    if (choice === 'even') return number % 2 === 0 ? 2 : 0;
    if (choice === 'odd') return number % 2 === 1 ? 2 : 0;
    if (choice === 'low') return number >= 1 && number <= 18 ? 2 : 0;
    if (choice === 'high') return number >= 19 && number <= 36 ? 2 : 0;
    if (choice === 'd1') return number >= 1 && number <= 12 ? 3 : 0;
    if (choice === 'd2') return number >= 13 && number <= 24 ? 3 : 0;
    if (choice === 'd3') return number >= 25 && number <= 36 ? 3 : 0;
    if (choice === 'c1') return number % 3 === 1 ? 3 : 0;
    if (choice === 'c2') return number % 3 === 2 ? 3 : 0;
    if (choice === 'c3') return number % 3 === 0 ? 3 : 0;
  }
  if (game === 'dice') {
    if (choice.startsWith('n:')) return Number(choice.slice(2)) === result.value ? 6 : 0;
    if (choice === 'low') return result.value <= 3 ? 2 : 0;
    if (choice === 'high') return result.value >= 4 ? 2 : 0;
  }
  if (game === 'coinflip') return choice === result.value ? 2 : 0;
  return 0;
}

function choiceLabel(game, choice) {
  const labels = {
    red: 'Rojo', black: 'Negro', even: 'Par', odd: 'Impar', low: game === 'dice' ? 'Bajo · 1–3' : 'Bajo · 1–18',
    high: game === 'dice' ? 'Alto · 4–6' : 'Alto · 19–36', heads: 'Cara', tails: 'Cruz',
    d1: 'Docena 1–12', d2: 'Docena 13–24', d3: 'Docena 25–36',
    c1: 'Columna 1', c2: 'Columna 2', c3: 'Columna 3'
  };
  return choice?.startsWith('n:') ? `Número ${choice.slice(2)}` : (labels[choice] || choice);
}

function resultLabel(game, result) {
  if (!result) return '';
  if (game === 'roulette') return `${result.value} · ${result.color === 'red' ? 'Rojo' : result.color === 'black' ? 'Negro' : 'Verde'}`;
  if (game === 'dice') return `Dado ${result.value}`;
  if (game === 'coinflip') return result.value === 'heads' ? 'Cara' : 'Cruz';
  return String(result.value);
}

module.exports = { QUICK_GAMES, isQuickGame, normalizeChoice, roll, totalPayoutMultiplier, choiceLabel, resultLabel };
