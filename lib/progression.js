const { HISTORY_LIMITS } = require('./profile-store-shared');

const AVAILABLE_GAMES = ['poker', 'blackjack', 'roulette', 'dice', 'coinflip', 'slots'];

const ACHIEVEMENTS = [
  { id: 'first_win', icon: '🏆', name: 'Primera victoria', description: 'Gana tu primera ronda.', reward: 50, test: p => p.stats.wins >= 1 },
  { id: 'hot_streak', icon: '🔥', name: 'En racha', description: 'Consigue 3 victorias seguidas.', reward: 100, test: p => p.stats.bestStreak >= 3 },
  { id: 'comeback', icon: '🛟', name: 'El regreso', description: 'Gana después de perder dos rondas seguidas.', reward: 100, test: p => Boolean(p.flags.comeback) },
  { id: 'high_roller', icon: '💎', name: 'Gran jugada', description: 'Gana 500 fichas o más en una ronda.', reward: 150, test: p => p.stats.biggestWin >= 500 },
  { id: 'explorer', icon: '🧭', name: 'Tour del casino', description: 'Prueba todos los juegos disponibles.', reward: 250, test: p => AVAILABLE_GAMES.every(game => p.gamesPlayed.includes(game)) }
];

const CHALLENGES = [
  { id: 'play_three', icon: '🎲', name: 'Calentamiento', description: 'Juega 3 rondas.', target: 3, reward: 75, value: p => p.stats.roundsPlayed },
  { id: 'win_one', icon: '⭐', name: 'Sabor a victoria', description: 'Gana una ronda.', target: 1, reward: 50, value: p => p.stats.wins },
  { id: 'wager_250', icon: '◆', name: 'Fichas en movimiento', description: 'Apuesta 250 fichas virtuales.', target: 250, reward: 75, value: p => p.stats.totalWagered },
  { id: 'try_two', icon: '♠', name: 'Cambio de mesa', description: 'Prueba 2 juegos diferentes.', target: 2, reward: 100, value: p => p.gamesPlayed.length },
  { id: 'try_slots', icon: '🎰', name: 'Tira de la palanca', description: 'Juega una ronda en la Tragamonedas MonteCristo.', target: 1, reward: 75, value: p => p.gamesPlayed.includes('slots') ? 1 : 0 }
];

// Fase 11.1: el techo real vive en HISTORY_LIMITS (lib/profile-store-shared.js).
// Con el archivo JSON queda en 20 (comportamiento histórico); con Postgres,
// server.js lo eleva a un techo generoso al arrancar, así que aquí no cambia nada.
function addTransaction(profile, amount, reason) {
  profile.transactions.push({ amount: Math.floor(amount), reason, time: Date.now() });
  profile.transactions = profile.transactions.slice(-HISTORY_LIMITS.transactions);
}

// Fase 8.2 / 11.1: instantánea del saldo para la gráfica de evolución. El techo
// (60 con archivo, mayor con Postgres) vive en HISTORY_LIMITS.
function snapshotBalance(profile) {
  profile.balanceHistory = profile.balanceHistory || [];
  profile.balanceHistory.push({ t: Date.now(), chips: profile.chips });
  profile.balanceHistory = profile.balanceHistory.slice(-HISTORY_LIMITS.balance);
}

function credit(profile, amount, reason) {
  amount = Math.max(0, Math.floor(Number(amount) || 0));
  if (!amount) return 0;
  profile.chips += amount;
  addTransaction(profile, amount, reason);
  snapshotBalance(profile);
  return amount;
}

function evaluate(profile) {
  const events = [];
  for (const achievement of ACHIEVEMENTS) {
    if (!profile.achievements.includes(achievement.id) && achievement.test(profile)) {
      profile.achievements.push(achievement.id);
      credit(profile, achievement.reward, `Logro: ${achievement.name}`);
      events.push({ type: 'achievement', ...achievement });
    }
  }
  for (const challenge of CHALLENGES) {
    const value = Math.min(challenge.target, Math.max(0, challenge.value(profile)));
    const existing = profile.challenges[challenge.id];
    if (!existing && value >= challenge.target) {
      profile.challenges[challenge.id] = { completedAt: Date.now(), reward: challenge.reward };
      credit(profile, challenge.reward, `Reto: ${challenge.name}`);
      events.push({ type: 'challenge', ...challenge, value, completed: true });
    }
  }
  return events;
}

function recordWager(profile, amount) {
  amount = Math.max(0, Math.floor(Number(amount) || 0));
  profile.stats.totalWagered += amount;
  // La apuesta ya forma parte del resultado neto de la ronda. Registrar aquí
  // otro débito duplicaría el movimiento en el historial, aunque no el saldo.
  return evaluate(profile);
}

function recordOutcome(profile, { game, net = 0 } = {}) {
  net = Math.floor(Number(net) || 0);
  const previousStreak = profile.stats.currentStreak;
  profile.stats.roundsPlayed++;
  if (game && !profile.gamesPlayed.includes(game)) profile.gamesPlayed.push(game);
  if (net > 0) {
    profile.stats.wins++;
    if (previousStreak <= -2) profile.flags.comeback = true;
    profile.stats.currentStreak = previousStreak > 0 ? previousStreak + 1 : 1;
    profile.stats.bestStreak = Math.max(profile.stats.bestStreak, profile.stats.currentStreak);
    profile.stats.biggestWin = Math.max(profile.stats.biggestWin, net);
  } else if (net < 0) {
    profile.stats.losses++;
    profile.stats.currentStreak = previousStreak < 0 ? previousStreak - 1 : -1;
  } else profile.stats.currentStreak = 0;
  // Fase 8.2: historial por juego (rondas, victorias y balance neto).
  if (game) {
    profile.gameStats = profile.gameStats || {};
    const entry = profile.gameStats[game] || (profile.gameStats[game] = { rounds: 0, wins: 0, net: 0 });
    entry.rounds++;
    if (net > 0) entry.wins++;
    entry.net += net;
  }
  addTransaction(profile, net, net > 0 ? `Ganancia en ${game}` : net < 0 ? `Resultado en ${game}` : `Empate en ${game}`);
  snapshotBalance(profile);
  return evaluate(profile);
}

function claimDailyBonus(profile, dateKey = new Date().toISOString().slice(0, 10)) {
  if (profile.dailyBonusDate === dateKey) return [];
  profile.dailyBonusDate = dateKey;
  const reward = 100;
  credit(profile, reward, 'Bono diario');
  return [{ type: 'reward', id: 'daily_bonus', icon: '🎁', name: 'Bono diario', description: 'Gracias por volver a MonteCristo.', reward }];
}

function publicProgress(profile, includePrivate = false) {
  const achievements = ACHIEVEMENTS.map(item => ({
    id: item.id, icon: item.icon, name: item.name, description: item.description, reward: item.reward,
    unlocked: profile.achievements.includes(item.id)
  }));
  const challenges = CHALLENGES.map(item => ({
    id: item.id, icon: item.icon, name: item.name, description: item.description, target: item.target, reward: item.reward,
    value: Math.min(item.target, Math.max(0, item.value(profile))), completed: Boolean(profile.challenges[item.id])
  }));
  const result = {
    id: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips,
    // Fase 11.4: insignias de fin de temporada — el banner es un logro único
    // de por vida; las medallas se acumulan, una por cada temporada ganada.
    championBanner: Boolean(profile.championBanner), medals: profile.medals || 0,
    stats: {
      ...profile.stats,
      differentGames: profile.gamesPlayed.length,
      // Fase 8.2: % de victorias sobre rondas jugadas.
      winRate: profile.stats.roundsPlayed > 0 ? Math.round(profile.stats.wins / profile.stats.roundsPlayed * 100) : 0
    },
    achievements: achievements.filter(item => item.unlocked), gamesPlayed: [...profile.gamesPlayed]
  };
  if (includePrivate) {
    result.allAchievements = achievements;
    result.challenges = challenges;
    result.transactions = profile.transactions.slice(-8).reverse();
    result.dailyBonusClaimed = profile.dailyBonusDate === new Date().toISOString().slice(0, 10);
    // Fase 8.2: datos para el panel de estadísticas ampliadas (solo el dueño del perfil).
    result.gameStats = JSON.parse(JSON.stringify(profile.gameStats || {}));
    // Fase 11.1: la gráfica del perfil muestra todo lo que el backend conserve
    // (60 puntos con archivo JSON; un techo mucho más generoso con Postgres).
    result.balanceHistory = (profile.balanceHistory || []).slice(-HISTORY_LIMITS.balance);
    // Fase 11.2: solo el nombre de usuario (nunca el hash de la contraseña),
    // para que el cliente pueda mostrar "conectado como @usuario" y ofrecer
    // "crear cuenta" solo cuando el perfil todavía no tiene una vinculada.
    result.username = profile.username || null;
  }
  return result;
}

module.exports = {
  AVAILABLE_GAMES, ACHIEVEMENTS, CHALLENGES, credit, recordWager, recordOutcome,
  claimDailyBonus, publicProgress
};
