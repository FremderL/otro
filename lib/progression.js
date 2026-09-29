const { HISTORY_LIMITS } = require('./profile-store-shared');

const AVAILABLE_GAMES = ['poker', 'blackjack', 'roulette', 'dice', 'coinflip', 'slots'];

function gameWins(profile, game) {
  return Number(profile.gameStats?.[game]?.wins) || 0;
}
function maxGameWins(profile) {
  return Object.values(profile.gameStats || {}).reduce((max, entry) => Math.max(max, Number(entry?.wins) || 0), 0);
}
function bestEligibleStreak(profile) {
  // Perfiles antiguos no tienen todavía esta métrica; se conserva su racha
  // histórica como fallback de migración y las nuevas rondas ya quedan filtradas.
  return profile.stats?.eligibleTracking
    ? Number(profile.stats.eligibleBestStreak) || 0
    : Number(profile.stats?.bestStreak) || 0;
}

const DAILY_CHALLENGES = [
  { id: 'daily_rounds', icon: '🎲', name: 'Ronda del día', description: 'Juega 3 rondas hoy.', target: 3, reward: 75, difficulty: 'fácil', value: period => period.rounds },
  { id: 'daily_wins', icon: '⭐', name: 'Victoria del día', description: 'Gana 2 rondas hoy.', target: 2, reward: 100, difficulty: 'medio', value: period => period.wins },
  { id: 'daily_wager', icon: '◆', name: 'Fichas del día', description: 'Apuesta 500 fichas hoy.', target: 500, reward: 125, difficulty: 'medio', value: period => period.wagered },
  { id: 'daily_games', icon: '🧭', name: 'Turista del día', description: 'Prueba 2 juegos hoy.', target: 2, reward: 125, difficulty: 'medio', value: period => period.games.length },
  { id: 'daily_streak', icon: '🔥', name: 'Mini racha', description: 'Consigue 3 victorias seguidas hoy.', target: 3, reward: 150, difficulty: 'difícil', value: period => period.bestStreak }
];
const WEEKLY_CHALLENGES = [
  { id: 'weekly_rounds', icon: '🃏', name: 'Jugador constante', description: 'Juega 10 rondas esta semana.', target: 10, reward: 250, difficulty: 'medio', value: period => period.rounds },
  { id: 'weekly_wins', icon: '🏆', name: 'Cazador semanal', description: 'Gana 5 rondas esta semana.', target: 5, reward: 300, difficulty: 'difícil', value: period => period.wins },
  { id: 'weekly_wager', icon: '💵', name: 'Mesa grande', description: 'Apuesta 2.500 fichas esta semana.', target: 2500, reward: 350, difficulty: 'difícil', value: period => period.wagered },
  { id: 'weekly_games', icon: '♠', name: 'Ruta del casino', description: 'Prueba 4 juegos esta semana.', target: 4, reward: 350, difficulty: 'difícil', value: period => period.games.length },
  { id: 'weekly_streak', icon: '💠', name: 'Escalón de platino', description: 'Consigue una racha de 5 victorias esta semana.', target: 5, reward: 500, difficulty: 'épico', value: period => period.bestStreak }
];

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
function weekKey(date = new Date()) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(value.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((value - firstThursday) / 604800000);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function blankPeriod(key) {
  return { key, rounds: 0, wins: 0, wagered: 0, games: [], currentStreak: 0, bestStreak: 0, completed: false, completedAt: null };
}
function ensureChallengePeriods(profile, now = new Date()) {
  profile.rotatingChallenges = profile.rotatingChallenges || {};
  const daily = dayKey(now);
  const weekly = weekKey(now);
  if (profile.rotatingChallenges.daily?.key !== daily) profile.rotatingChallenges.daily = blankPeriod(daily);
  if (profile.rotatingChallenges.weekly?.key !== weekly) profile.rotatingChallenges.weekly = blankPeriod(weekly);
  return profile.rotatingChallenges;
}
function pickRotatingChallenge(list, key) {
  const hash = [...String(key)].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);
  return list[hash % list.length];
}
function rotatingSpec(profile, kind) {
  const periods = ensureChallengePeriods(profile);
  const period = periods[kind];
  const list = kind === 'daily' ? DAILY_CHALLENGES : WEEKLY_CHALLENGES;
  return { period, spec: pickRotatingChallenge(list, period.key) };
}
function trackPeriod(profile, { rounds = 0, wins = 0, wagered = 0, game = null, outcome = false } = {}) {
  const periods = ensureChallengePeriods(profile);
  for (const period of [periods.daily, periods.weekly]) {
    period.rounds += rounds;
    period.wins += wins;
    period.wagered += wagered;
    if (game && !period.games.includes(game)) period.games.push(game);
    if (rounds) {
      if (outcome) {
        period.currentStreak++;
        period.bestStreak = Math.max(period.bestStreak, period.currentStreak);
      } else period.currentStreak = 0;
    }
  }
}
function publicRotatingChallenge(profile, kind) {
  const { period, spec } = rotatingSpec(profile, kind);
  const value = Math.min(spec.target, Math.max(0, Math.floor(Number(spec.value(period)) || 0)));
  return {
    id: spec.id, icon: spec.icon, name: spec.name, description: spec.description,
    target: spec.target, reward: spec.reward, difficulty: spec.difficulty, value,
    completed: Boolean(period.completed), period: kind, periodKey: period.key,
    periodLabel: kind === 'daily' ? 'HOY' : 'ESTA SEMANA'
  };
}

// Los logros se conservan en el perfil de por vida. Las metas de racha usan
// `bestStreak`, de modo que una derrota posterior no borra una hazaña que ya se
// consiguió. Las recompensas más altas están reservadas para hitos realmente
// excepcionales; en especial, 1.000 victorias consecutivas entrega la medalla
// de platino solicitada.
const ACHIEVEMENTS = [
  { id: 'first_win', icon: '🏆', name: 'Primera victoria', description: 'Gana tu primera ronda.', reward: 50, rarity: 'común', test: p => p.stats.wins >= 1 },
  { id: 'hot_streak', icon: '🔥', name: 'En racha', description: 'Consigue 3 victorias seguidas.', reward: 100, rarity: 'bronce', test: p => p.stats.bestStreak >= 3 },
  { id: 'comeback', icon: '🛟', name: 'El regreso', description: 'Gana después de perder dos rondas seguidas.', reward: 100, rarity: 'bronce', test: p => Boolean(p.flags.comeback) },
  { id: 'high_roller', icon: '💎', name: 'Gran jugada', description: 'Gana 500 fichas o más en una ronda.', reward: 150, rarity: 'plata', test: p => p.stats.biggestWin >= 500 },
  { id: 'explorer', icon: '🧭', name: 'Tour del casino', description: 'Prueba todos los juegos disponibles.', reward: 250, rarity: 'plata', test: p => AVAILABLE_GAMES.every(game => p.gamesPlayed.includes(game)) },
  { id: 'rounds_10', icon: '🎯', name: 'Cliente frecuente', description: 'Juega 10 rondas.', reward: 150, rarity: 'bronce', test: p => p.stats.roundsPlayed >= 10 },
  { id: 'rounds_100', icon: '🗺️', name: 'Veterano del casino', description: 'Juega 100 rondas.', reward: 500, rarity: 'oro', test: p => p.stats.roundsPlayed >= 100 },
  { id: 'streak_10', icon: '⚡', name: 'Racha de fuego', description: 'Consigue 10 victorias seguidas.', reward: 300, rarity: 'oro', test: p => p.stats.bestStreak >= 10 },
  { id: 'streak_25', icon: '💎', name: 'Racha de diamante', description: 'Consigue 25 victorias seguidas.', reward: 500, rarity: 'diamante', test: p => p.stats.bestStreak >= 25 },
  { id: 'streak_50', icon: '👑', name: 'Imparable', description: 'Consigue 50 victorias seguidas.', reward: 1000, rarity: 'oro', test: p => p.stats.bestStreak >= 50 },
  { id: 'streak_100', icon: '🏅', name: 'Élite', description: 'Consigue 100 victorias seguidas.', reward: 1500, rarity: 'élite', test: p => p.stats.bestStreak >= 100 },
  { id: 'streak_250', icon: '🌌', name: 'Maestro de la mesa', description: 'Consigue 250 victorias seguidas.', reward: 2500, rarity: 'maestro', test: p => p.stats.bestStreak >= 250 },
  { id: 'streak_500', icon: '🌠', name: 'Leyenda viviente', description: 'Consigue 500 victorias seguidas.', reward: 3500, rarity: 'leyenda', test: p => p.stats.bestStreak >= 500 },
  { id: 'wins_100', icon: '🏛️', name: 'Centurión', description: 'Gana 100 rondas.', reward: 1000, rarity: 'oro', test: p => p.stats.wins >= 100 },
  { id: 'jackpot_win', icon: '💰', name: 'Jackpot', description: 'Gana 1.000 fichas o más en una ronda.', reward: 400, rarity: 'oro', test: p => p.stats.biggestWin >= 1000 },
  { id: 'big_wager', icon: '🎰', name: 'Apostador de leyenda', description: 'Mueve 10.000 fichas en apuestas.', reward: 500, rarity: 'oro', test: p => p.stats.totalWagered >= 10000 },
  { id: 'game_specialist', icon: '🎴', name: 'Especialista', description: 'Gana 25 rondas en un mismo juego.', reward: 400, rarity: 'oro', test: p => maxGameWins(p) >= 25 },
  { id: 'platinum_streak', icon: '💠', name: 'Medalla de platino', description: 'Logra 1.000 victorias seguidas.', reward: 5000, rarity: 'platino', test: p => bestEligibleStreak(p) >= 1000 }
];

const CHALLENGES = [
  { id: 'play_three', icon: '🎲', name: 'Calentamiento', description: 'Juega 3 rondas.', target: 3, reward: 75, difficulty: 'fácil', value: p => p.stats.roundsPlayed },
  { id: 'win_one', icon: '⭐', name: 'Sabor a victoria', description: 'Gana una ronda.', target: 1, reward: 50, difficulty: 'fácil', value: p => p.stats.wins },
  { id: 'wager_250', icon: '◆', name: 'Fichas en movimiento', description: 'Apuesta 250 fichas virtuales.', target: 250, reward: 75, difficulty: 'fácil', value: p => p.stats.totalWagered },
  { id: 'try_two', icon: '♠', name: 'Cambio de mesa', description: 'Prueba 2 juegos diferentes.', target: 2, reward: 100, difficulty: 'fácil', value: p => p.gamesPlayed.length },
  { id: 'try_slots', icon: '🎰', name: 'Tira de la palanca', description: 'Juega una ronda en la Tragamonedas MonteCristo.', target: 1, reward: 75, difficulty: 'fácil', value: p => p.gamesPlayed.includes('slots') ? 1 : 0 },
  { id: 'play_ten', icon: '🃏', name: 'Mesa habitual', description: 'Juega 10 rondas.', target: 10, reward: 150, difficulty: 'medio', value: p => p.stats.roundsPlayed },
  { id: 'win_five', icon: '🌟', name: 'Mano caliente', description: 'Gana 5 rondas.', target: 5, reward: 150, difficulty: 'medio', value: p => p.stats.wins },
  { id: 'wager_1000', icon: '💵', name: 'Fichas a la mesa', description: 'Apuesta 1.000 fichas virtuales.', target: 1000, reward: 200, difficulty: 'medio', value: p => p.stats.totalWagered },
  { id: 'streak_five', icon: '🔥', name: 'Cinco al hilo', description: 'Alcanza una racha de 5 victorias.', target: 5, reward: 250, difficulty: 'difícil', value: p => p.stats.bestStreak },
  { id: 'try_four', icon: '🧭', name: 'Pasaporte del casino', description: 'Prueba 4 juegos diferentes.', target: 4, reward: 250, difficulty: 'medio', value: p => p.gamesPlayed.length },
  { id: 'specialist_ten', icon: '🎴', name: 'Juego favorito', description: 'Gana 10 rondas en un mismo juego.', target: 10, reward: 300, difficulty: 'difícil', value: p => maxGameWins(p) },
  { id: 'big_win_1000', icon: '💎', name: 'Golpe de suerte', description: 'Gana 1.000 fichas en una sola ronda.', target: 1000, reward: 350, difficulty: 'difícil', value: p => p.stats.biggestWin },
  { id: 'win_25', icon: '🏆', name: 'Cazador de victorias', description: 'Gana 25 rondas.', target: 25, reward: 450, difficulty: 'difícil', value: p => p.stats.wins },
  { id: 'blackjack_five', icon: '♣️', name: 'Veintiuno perfecto', description: 'Gana 5 rondas de Blackjack.', target: 5, reward: 350, difficulty: 'difícil', value: p => gameWins(p, 'blackjack') },
  { id: 'platinum_preview', icon: '💠', name: 'Camino al platino', description: 'Consigue una racha de 25 victorias.', target: 25, reward: 750, difficulty: 'épico', value: p => p.stats.bestStreak }
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
  profile.achievements = profile.achievements || [];
  profile.challenges = profile.challenges || {};
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
  for (const kind of ['daily', 'weekly']) {
    const { period, spec } = rotatingSpec(profile, kind);
    const value = Math.min(spec.target, Math.max(0, Math.floor(Number(spec.value(period)) || 0)));
    if (!period.completed && value >= spec.target) {
      period.completed = true;
      period.completedAt = Date.now();
      credit(profile, spec.reward, `Reto ${kind === 'daily' ? 'diario' : 'semanal'}: ${spec.name}`);
      events.push({ type: 'challenge', ...spec, value, completed: true, period: kind, periodKey: period.key });
    }
  }
  return events;
}

function recordWager(profile, amount) {
  amount = Math.max(0, Math.floor(Number(amount) || 0));
  profile.stats.totalWagered += amount;
  trackPeriod(profile, { wagered: amount });
  // La apuesta ya forma parte del resultado neto de la ronda. Registrar aquí
  // otro débito duplicaría el movimiento en el historial, aunque no el saldo.
  return evaluate(profile);
}

function recordOutcome(profile, { game, net = 0, eligible = true } = {}) {
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
  // La racha elegible para la medalla de platino solo cuenta rondas con una
  // apuesta válida de una persona real. Los perfiles antiguos conservan el
  // fallback de `bestStreak`, pero las nuevas partidas quedan protegidas.
  profile.stats.eligibleTracking = true;
  profile.stats.eligibleCurrentStreak = Number(profile.stats.eligibleCurrentStreak) || 0;
  profile.stats.eligibleBestStreak = Number(profile.stats.eligibleBestStreak) || 0;
  if (eligible && net > 0) {
    profile.stats.eligibleCurrentStreak++;
    profile.stats.eligibleBestStreak = Math.max(profile.stats.eligibleBestStreak, profile.stats.eligibleCurrentStreak);
  } else profile.stats.eligibleCurrentStreak = 0;
  trackPeriod(profile, { rounds: 1, wins: net > 0 ? 1 : 0, game, outcome: net > 0 });
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
    rarity: item.rarity || null, unlocked: profile.achievements.includes(item.id)
  }));
  const challenges = CHALLENGES.map(item => ({
    id: item.id, icon: item.icon, name: item.name, description: item.description, target: item.target, reward: item.reward,
    difficulty: item.difficulty || 'medio', value: Math.min(item.target, Math.max(0, item.value(profile))), completed: Boolean(profile.challenges[item.id])
  }));
  const result = {
    id: profile.id, name: profile.name, avatar: profile.avatar, chips: profile.chips,
    // Fase 11.4: insignias de fin de temporada — el banner es un logro único
    // de por vida; las medallas se acumulan, una por cada temporada ganada.
    championBanner: Boolean(profile.championBanner), medals: profile.medals || 0,
    featuredAchievements: Array.isArray(profile.featuredAchievements) ? [...profile.featuredAchievements] : [],
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
    result.dailyChallenges = [publicRotatingChallenge(profile, 'daily')];
    result.weeklyChallenges = [publicRotatingChallenge(profile, 'weekly')];
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
  AVAILABLE_GAMES, ACHIEVEMENTS, CHALLENGES, DAILY_CHALLENGES, WEEKLY_CHALLENGES,
  credit, recordWager, recordOutcome,
  claimDailyBonus, publicProgress
};
