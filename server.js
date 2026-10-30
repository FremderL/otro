const express = require('express');
const compression = require('compression');
const http = require('http');
const { randomUUID } = require('node:crypto');
const path = require('path');
const { Server } = require('socket.io');
const { AVATARS } = require('./lib/profile-store');
// Fase 10.2: DATABASE_URL activa el backend de Postgres (Neon free); sin ella,
// se mantiene el ProfileStore de archivo JSON de siempre. Ver lib/profile-store-factory.js.
const { createProfileStore } = require('./lib/profile-store-factory');
const {
  HISTORY_LIMITS, INACTIVITY_LIMIT_MS, CASINO_TIME_ZONE, monthKey, normalizeDisplayName
} = require('./lib/profile-store-shared');
const { credit, recordWager, recordOutcome, claimDailyBonus, openCardCapsule, publicProgress } = require('./lib/progression');
const { buildBettingLeaderboard, createBettingLeaderboard } = require('./lib/betting-leaderboard');
const { seatIdentity } = require('./lib/seat-identity');
const { equipPassportCosmetic, publicPassportIdentity } = require('./lib/passport');
const { equipCosmetic, publicCollectionIdentity } = require('./lib/cosmetics');
const { publicFanPin } = require('./lib/football/fan-club-profile');
const { LobbyTournamentManager, placementLabel } = require('./lib/lobby-tournaments');
const { createLobbyTournamentStore } = require('./lib/lobby-tournament-store');
const { QUICK_GAMES, isQuickGame, normalizeChoice, roll, totalPayoutMultiplier, choiceLabel, resultLabel } = require('./lib/quick-games');
const { rollSpecialEvent, bonusFor } = require('./lib/special-events');
const { HAND_NAMES, compareScores, bestPokerScore } = require('./lib/poker-evaluator');
const { DIFFICULTIES, STYLES, createBot, publicBot } = require('./lib/bots/catalog');
const { BotController } = require('./lib/bots/bot-controller');
const {
  MONTE_ASSISTANT_NAME,
  MONTE_ASSISTANT_AVATAR,
  getLobbyAssistantReply,
  canReplyToLobbyAssistant
} = require('./lib/lobby-chat-assistant');
const { TOS_VERSION } = require('./lib/terms');
const { loadAdminConfig } = require('./lib/admin-config');
const { loadPassportConfig } = require('./lib/passport-config');
const { createAccountSessionStore } = require('./lib/account-session-factory');
const { installAccountAuthRoutes, COOKIE_NAME, parseCookies } = require('./lib/account-auth-http');
const { sessionState } = require('./lib/account-sessions');
const { installAdminRoutes, makeAdminGuard } = require('./lib/admin-auth-http');
const { PERMISSIONS, normalizeRole } = require('./lib/permissions');
const { createAuditStore } = require('./lib/audit-store-factory');
const { createModerationStore } = require('./lib/moderation-store-factory');
const { createReportStore } = require('./lib/report-store-factory');
const { installReportRoutes } = require('./lib/report-http');
const { createPasswordResetStore } = require('./lib/password-reset-store-factory');
const { installPasswordResetRoutes } = require('./lib/password-reset-http');
const { sanitizeLogValue, securityHeaders } = require('./lib/security-hardening');
const { createIdempotencyStore } = require('./lib/idempotency-store-factory');
const { createCommunityStore } = require('./lib/community-store');
const { installCommunityRoutes } = require('./lib/community-http');
const { installSeasonalThemeRoutes } = require('./lib/seasonal-theme-http');
const { LoteriaService } = require('./lib/loteria/service');
const { CARDS: LOTERIA_CARDS } = require('./lib/loteria/cards');
const { FortuneLedger } = require('./lib/fortune/ledger');

// Fase administrativa 0: el feature flag permanece apagado por defecto y, si
// se activa, el proceso falla cerrado antes de escuchar tráfico cuando falta
// cualquier secreto o requisito de producción.
const adminConfig = loadAdminConfig();
const passportConfig = loadPassportConfig();
// Gachapón de cartas: activo por defecto; CARD_GACHA_ENABLED=off lo apaga de
// inmediato (el servidor rechaza nuevas cápsulas y la interfaz lo oculta).
const cardGachaEnabled = process.env.CARD_GACHA_ENABLED !== 'off';
// Lotería mexicana: activa por defecto; LOTERIA_ENABLED=off la apaga sin tocar
// el resto del casino (la tarjeta del lobby y la página se ocultan).
const loteriaEnabled = process.env.LOTERIA_ENABLED !== 'off';
// Rueda de la Fortuna: activa por defecto desde que su diario transaccional
// (lib/fortune/ledger.js) permite devolver lo no resuelto al reiniciar.
// FORTUNE_ENABLED=off la apaga; FORTUNE_PREVIEW_UNSAFE ya no hace falta.
const fortuneEnabled = process.env.FORTUNE_ENABLED !== 'off';

// Estadio MonteCristo (Fase E4): feature flag fail-closed, apagado por defecto.
// loadFootballConfig() se invoca aquí, junto a loadAdminConfig y ANTES de la red
// de uncaughtException de más abajo: si la configuración crítica falta cuando el
// flag está activo, el throw mata el proceso en el arranque en vez de dejarlo
// zombi sin server.listen() (decisión A6, §12.7 hallazgo 5, R26).
const { loadFootballConfig } = require('./lib/football-config');
const { createFootballStore } = require('./lib/football-store-factory');
const { FootballEngine } = require('./lib/football/engine');
const { FootballScheduler } = require('./lib/football/scheduler');
const { createBettingService } = require('./lib/football/betting');
const { BallonDorMarketService } = require('./lib/football/ballon-dor-market');
const {
  createBallonDorAudioTelemetry, isPrivateBallonDorBetLog
} = require('./lib/football/rollout-telemetry');
const { footballSeasonResetGate } = require('./lib/football/reset-gate');
const { SimulatedFlow } = require('./lib/football/simulated-flow');
const { registerFootballSockets } = require('./lib/football/sockets');
const { installFootballRoutes, installFootballAdminRoutes, footballHealth, startPromotionMediaSweep } = require('./lib/football/http');
const footballConfig = loadFootballConfig();

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
if (adminConfig.accountSessionsEnabled) app.set('trust proxy', adminConfig.trustProxyHops);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;

// Fase 7: logs estructurados (JSON por línea) para el visor de logs de Render. LOG_JSON=off los desactiva.
const LOG_JSON = process.env.LOG_JSON !== 'off';
function logEvent(event, data = {}) {
  if (!LOG_JSON) return;
  try { console.log(JSON.stringify({ ...sanitizeLogValue(data), time: new Date().toISOString(), event:String(event).slice(0,80) })); } catch (_) { /* un log nunca debe tumbar el servidor */ }
}
const footballAudioTelemetry = createBallonDorAudioTelemetry({ log: logEvent });

// Última red de seguridad a nivel proceso (refuerzo de la auditoría; las
// envolturas específicas están en socket.on, scheduleRoomTask, los barridos
// y el controlador de bots). Razón: las mesas viven en memoria — cuando un
// solo error tumbaba el proceso, se borraban TODAS las partidas en curso del
// casino y todos los jugadores quedaban fuera (ocurrió en producción con un
// ReferenceError). Aquí el servidor se queda vivo, con el error registrado
// con stack completo para revisarlo; perder una mesa rara es mejor que
// perderlas todas.
process.on('uncaughtException', error => {
  console.error('[CRITICO] Excepción no capturada (el servidor sigue vivo):', error);
  logEvent('uncaught_exception', { message: String(error?.message || error) });
});
process.on('unhandledRejection', reason => {
  console.error('[CRITICO] Promesa rechazada sin capturar (el servidor sigue vivo):', reason);
  logEvent('unhandled_rejection', { message: String(reason?.message || reason) });
});

// Fase administrativa 1: API de sesión segura. Las rutas existen detrás de
// ACCOUNT_SESSIONS_ENABLED y resuelven stores cargados por bootstrap().
let accountAuth = null;
let communityStore = null;
accountAuth = installAccountAuthRoutes(app, {
  config: adminConfig,
  getProfiles: () => profiles,
  getSessionStore: () => accountSessionStore,
  getAuditStore: () => auditStore,
  logEvent
});
installAdminRoutes(app, {
  config: adminConfig,
  getProfiles: () => profiles,
  getSessionStore: () => accountSessionStore,
  getAuditStore: () => auditStore,
  getModerationStore: () => moderationStore,
  getReportStore: () => reportStore,
  getPasswordResetStore: () => passwordResetStore,
  getIdempotencyStore: () => idempotencyStore,
  onModerated: async (target, state) => {
    const roomName = `account:${target.id}`;
    io.to(roomName).emit('account_moderated', { status:state.status, until:state.until });
    io.in(roomName).disconnectSockets(true);
  },
  onRoleChanged: async target => {
    io.in(`account:${target.id}`).disconnectSockets(true);
  }
});
installReportRoutes(app, {
  config: adminConfig,
  getProfiles: () => profiles,
  getSessionStore: () => accountSessionStore,
  getReportStore: () => reportStore,
  findEvidence: messageId => {
    const messages = [...lobbyChatMessages, ...[...rooms.values()].flatMap(room => room.messages || [])];
    const message = messages.find(item => item.id === messageId && item.playerId && !item.system);
    return message ? {
      messageId: message.id,
      authorProfileId: String(message.playerId),
      text: message.text,
      time: message.time
    } : null;
  }
});
installPasswordResetRoutes(app,{config:adminConfig,getProfiles:()=>profiles,getSessionStore:()=>accountSessionStore,getPasswordResetStore:()=>passwordResetStore,getAuditStore:()=>auditStore});
installCommunityRoutes(app, {
  config: adminConfig,
  resolveSession: (...args) => accountAuth.resolveSession(...args),
  getProfiles: () => profiles,
  getCommunityStore: () => communityStore,
  canMoveChips: profileId => !roomOfProfile(profiles.getProfile(profileId))
});
installSeasonalThemeRoutes(app, {
  config: adminConfig,
  getProfiles: () => profiles,
  getSessionStore: () => accountSessionStore,
  getCommunityStore: () => communityStore,
  getAuditStore: () => auditStore,
  getIdempotencyStore: () => idempotencyStore,
  onChanged: theme => io.emit('seasonal_theme_updated', theme)
});

// Fase 9: presupuesto de rendimiento — gzip para HTML/CSS/JS y caché larga para las
// imágenes del lobby (tienen nombre estable; si se reemplazan, cambiar el nombre del archivo).
app.use(compression());
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '7d', immutable: false }));
const revalidateAppShell = new Set(['index.html', 'app.js', 'styles.css', 'chat-format.js', 'estadio-banner.js', 'estadio.html', 'estadio.js', 'estadio.css', 'loteria.html', 'loteria.js', 'loteria.css']);
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders(res, filePath) {
    // La shell de la app cambia junto con despliegues; revalidarla evita que el
    // navegador mantenga por cinco minutos una UI desactualizada en perfiles.
    if (revalidateAppShell.has(path.basename(filePath))) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, botTasks: botController?.tasks.size || 0 }));
// Fase 7: health check para deploys sin caída en Render (configurado como healthCheckPath en render.yaml).
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    rooms: rooms.size,
    humanPlayers: [...rooms.values()].reduce((sum, room) => sum + room.players.filter(p => !p.isBot && p.connected).length, 0),
    botTasks: botController?.tasks.size || 0,
    seasonMonth: profiles?.seasons?.current || null,
    casinoTimeZone: CASINO_TIME_ZONE,
    tosVersion: TOS_VERSION,
    accountSessionsEnabled: adminConfig.accountSessionsEnabled,
    passportEnabled: passportConfig.enabled,
    cardGachaEnabled,
    fortuneEnabled: fortuneAvailable(),
    loteria: loteriaEnabled && loteria
      ? {
        enabled: true,
        status: loteria.snapshotFor(null).game?.status || null,
        players: loteria.snapshotFor(null).game?.count || 0
      }
      : { enabled: false },
    promotionsEnabled: footballConfig.enabled && adminConfig.enabled && adminConfig.accountSessionsEnabled,
    // Estadio MonteCristo (§15.8): bloque de salud del motor. Con el flag apagado
    // (o antes de bootstrap) queda reducido a { enabled: false }; footballHealth
    // nunca lanza, así que el health check de Render no puede fallar por el motor.
    football: footballConfig.enabled && footballEngine
      ? footballHealth({
        engine: footballEngine,
        enabled: footballConfig.enabled,
        ballonDorMarket: footballBallonDorMarket,
        audioTelemetry: footballAudioTelemetry
      })
      : { enabled: false }
  });
});
app.get('/terminos', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos.html')));
// Lotería mexicana: página propia (como /estadio), registrada ANTES del
// catch-all para que no la atrape la shell del casino.
app.get('/loteria', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'loteria.html')));
// Fase 11.1: descarga del historial completo (saldo y transacciones) del propio
// perfil. El token es el mismo identificador de dispositivo que ya usa el resto
// de la app (mismo modelo de confianza ya documentado en REVISION_CALIDAD.md:
// quien tiene el token, tiene acceso a ese perfil); no expone nada de otros.
app.get('/api/perfil/:token/historial', (req, res) => {
  const token = String(req.params.token || '').slice(0, 80);
  const profile = profiles?.profiles?.get(token);
  if (!profile) return res.status(404).json({ error: 'No se encontró un perfil con ese identificador.' });
  res.setHeader('Content-Disposition', `attachment; filename="montecristo-historial-${token}.json"`);
  res.json({
    exportadoEl: new Date().toISOString(),
    perfil: { id: profile.id, nombre: profile.name, avatar: profile.avatar, fichas: profile.chips, creadoEl: profile.createdAt },
    estadisticas: profile.stats,
    porJuego: profile.gameStats,
    evolucionDeSaldo: profile.balanceHistory,
    transacciones: profile.transactions
  });
});
// Estadio MonteCristo (Fase E4): rutas públicas de la sección. Se registran ANTES
// del catch-all para que /estadio y /api/estadio/* no queden atrapados por él
// (§14.3, igual que /terminos). Las deps se resuelven en diferido con getters:
// los servicios se crean en bootstrap(), pero las rutas existen desde el arranque
// y devuelven 404 mientras footballConfig.enabled sea false. El parser queda
// limitado a esta API; no amplía el límite JSON del resto del casino.
// El envío de promociones puede incluir una creatividad PNG/JPEG en base64 (≤1 MB).
// Su parser va antes del límite general de /api/estadio, que sigue vigente.
app.post('/api/estadio/promotions', express.json({ limit: '2mb', strict: true }));
app.use('/api/estadio', express.json({ limit: '32kb', strict: true }));
const promotionMediaDeps = {
  get store() { return footballStore; },
  get profiles() { return profiles; },
  promotionMediaDir: process.env.PROMOTION_MEDIA_DIR || undefined,
  now: () => Date.now()
};
installFootballRoutes(app, {
  get store() { return footballStore; },
  get profiles() { return profiles; },
  get betting() { return footballBetting; },
  getBallonDorMarket: () => footballBallonDorMarket,
  audioTelemetry: footballAudioTelemetry,
  get buildLobby() { return footballSockets ? footballSockets.buildLobby : null; },
  get buildMatchState() { return footballSockets ? footballSockets.buildMatchState : null; },
  get config() { return { tosVersion: TOS_VERSION }; },
  get accountConfig() { return adminConfig; },
  getAccountAuth: () => accountAuth,
  verifyTosAcceptance,
  promotionsEnabled: () => footballConfig.enabled && adminConfig.enabled && adminConfig.accountSessionsEnabled,
  now: () => Date.now(),
  log: logEvent,
  onBetPlaced: () => broadcastBetRanking(),
  enabled: () => footballConfig.enabled
});
// Retención de creatividades: borra imágenes rechazadas o de partidos ya iniciados.
startPromotionMediaSweep(promotionMediaDeps, 60 * 1000);

// Estadio MonteCristo (Fase E4b): palancas operativas de administración del fútbol
// (/admin/estadio/*): suspender mercados, forzar liquidación, posponer y cerrar un
// mercado por precio incorrecto. Fail-closed en dos capas: el gate de http.js
// devuelve 404 si ADMIN_FEATURE_ENABLED está apagado, y la guardia inyectada exige
// sesión staff con el permiso football:manage (solo rol admin), MFA reciente y
// escritura de confianza (origen + CSRF), exactamente igual que /api/admin. Se monta
// un parser JSON propio bajo /admin/estadio porque los del casino solo cubren
// /api/auth y /api/admin; sin él, req.body llegaría undefined a estas rutas.
app.post('/admin/estadio/promotions/create', express.json({ limit: '2mb', strict: true }));
app.use('/admin/estadio', express.json({ limit: '64kb', strict: true }));
const footballAdminGuard = makeAdminGuard({
  config: adminConfig,
  getProfiles: () => profiles,
  getSessionStore: () => accountSessionStore
});
installFootballAdminRoutes(app, {
  adminConfig,
  promotionMediaDir: process.env.PROMOTION_MEDIA_DIR || undefined,
  guard: footballAdminGuard.fullGuard(PERMISSIONS.FOOTBALL_MANAGE),
  readGuard: (req, res, next) => footballAdminGuard.resolveAdmin(req, res, () =>
    footballAdminGuard.requirePermission(PERMISSIONS.FOOTBALL_MANAGE)(req, res, next)),
  getProfiles: () => profiles,
  getAuditStore: () => auditStore,
  getIdempotencyStore: () => idempotencyStore,
  onPromotionCharged: (profile, promotion) => io.to(`account:${profile.id}`).emit('account_chips_updated', {
    profileId: profile.id, chips: profile.chips, reason: 'promotion_approved',
    promotionId: promotion.id, matchId: promotion.matchId
  }),
  get store() { return footballStore; },
  get betting() { return footballBetting; },
  get engine() { return footballEngine; },
  // Rastro de auditoría normalizado al mismo store que el resto del panel; es
  // best-effort: si el store no está listo o falla, no debe tumbar la palanca.
  audit: (type, data) => {
    try {
      const entry = {
        actorProfileId: data && data.admin ? String(data.admin) : null,
        actorRole: 'admin',
        action: type,
        targetType: 'football',
        targetId: data && (data.match || data.matchId) ? String(data.match || data.matchId) : null,
        beforeData: null,
        afterData: data || null,
        reason: 'Palanca operativa del Estadio'
      };
      Promise.resolve(auditStore && auditStore.append ? auditStore.append(entry) : null).catch(() => {});
    } catch (_) { /* la auditoría no debe romper la operación */ }
  },
  log: logEvent,
  now: () => Date.now()
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const rooms = new Map();
// Insignia pública del chat: solo el staff (administración y moderación) la muestra.
// El patrocinador y el resto de usuarios no llevan insignia; el rol nunca se envía a quien no lo necesita.
const PUBLIC_CHAT_ROLE = Object.freeze({ admin: 'staff', moderator: 'moderator' });
function chatRoleField(profileId) {
  const profile = profiles.profiles.get(profileId);
  const role = PUBLIC_CHAT_ROLE[normalizeRole(profile?.role)];
  return role ? { role } : {};
}

// Chat global del casino: vive en memoria y nunca se mezcla con los mensajes de una mesa.
const lobbyChatMessages = [];
const LOBBY_CHAT_LIMIT = 60;
// Fase 10.2: se crea de forma asíncrona en bootstrap() (más abajo) para poder
// esperar la carga inicial de Postgres cuando DATABASE_URL está definida; con
// el ProfileStore de archivo (caso local y de todos los tests actuales) la
// espera es instantánea, así que el comportamiento no cambia.
let profiles;
let lobbyTournaments = null;
let lobbyTournamentStore = null;
const lobbyTournamentPayoutsPending = new Map();
let lobbyTournamentTimer = null;
// Estadio MonteCristo (Fase E4): servicios creados en bootstrap() SOLO si
// footballConfig.enabled. Nacen en null; las rutas /api/estadio/* y /healthz los
// leen en diferido (getters), igual que el casino lee `profiles`.
let footballStore = null;
let footballEngine = null;
let footballBetting = null;
let footballBallonDorMarket = null;
let footballScheduler = null;
let footballSockets = null;
let accountSessionStore = null;
let auditStore = null;
let moderationStore = null;
let reportStore = null;
let passwordResetStore = null;
let idempotencyStore = null;
let botController = null;
// Lotería mexicana: una sola ronda compartida para todo el casino. Se crea en
// bootstrap() (necesita el almacén de perfiles) y las rutas/sockets la leen en
// diferido, igual que el resto de servicios.
let loteria = null;
// Rueda de la Fortuna: diario de apuestas y pagos (se crea en bootstrap()).
let fortuneLedger = null;
const ROOM_CAPACITY = 6;
const BOT_ONLY_ROOM_TTL_MS = Math.max(100, Number(process.env.BOT_ONLY_ROOM_TTL_MS) || 5 * 60 * 1000);
// Fase 2: ciclo de vida de mesas. AUTO_BOTS=off restaura el comportamiento manual (usado por tests legados).
const AUTO_BOTS = process.env.AUTO_BOTS !== 'off';
const AUTO_BOT_DIFFICULTY = process.env.AUTO_BOT_DIFFICULTY && DIFFICULTIES[process.env.AUTO_BOT_DIFFICULTY] ? process.env.AUTO_BOT_DIFFICULTY : 'expert';
const AUTO_BOT_STYLES = ['balanced', 'conservative', 'aggressive', 'unpredictable'];
const HOST_INACTIVITY_MS = Math.max(200, Number(process.env.HOST_INACTIVITY_MS) || 60 * 1000);
const HOST_INACTIVITY_SWEEP_MS = Math.max(50, Number(process.env.HOST_INACTIVITY_SWEEP_MS) || 10 * 1000);
const RECONNECT_GRACE_MS = Math.max(200, Number(process.env.RECONNECT_GRACE_MS) || 90 * 1000);
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function cleanName(value) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, 18);
}
function cleanRoomName(value) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, 28);
}
const PROFANITY_WORDS = [
  'motherfucker', 'motherfuckers', 'gilipollas', 'chingada', 'chingado', 'chingar',
  'cabrones', 'cabron', 'cabrón', 'cabrona', 'cabronas', 'pendejo', 'pendeja', 'pendejos', 'pendejas',
  'putas', 'putos', 'puta', 'puto', 'hijoputa', 'hijoputas', 'mierda', 'coño', 'joder', 'jodido', 'jodida', 'jodidos', 'jodidas',
  'maricon', 'maricón', 'maricona', 'mariconas', 'bastard', 'bastarda', 'bastardas',
  'fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'dick', 'cunt'
].sort((a, b) => b.length - a.length);
const PROFANITY_PATTERN = new RegExp(
  `(^|[^\\p{L}\\p{N}_])(${PROFANITY_WORDS.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^\\p{L}\\p{N}_])`,
  'giu'
);
function censorProfanity(value) {
  return String(value || '').replace(PROFANITY_PATTERN, (_match, prefix, word) => `${prefix}${'*'.repeat([...word].length)}`);
}
// Variante sin bandera 'g' para CONSULTAR sin el estado de lastIndex que
// arrastran las regex globales con .test().
const PROFANITY_TEST = new RegExp(PROFANITY_PATTERN.source, 'iu');
function cleanMessage(value) {
  const cleaned = String(value || '').replace(/[<>]/g, '').trim().slice(0, 180);
  return censorProfanity(cleaned);
}
// ---- Validación de nombres de personas (mesas, chat del casino, cuentas) ----
// Reglas solicitadas en la auditoría de pulido:
//  1) Sin palabras ofensivas: la misma lista que censura el chat, también
//     tras quitar separadores intercalados ("gil_ipollas", "pen.dejo").
//  2) UNICIDAD GLOBAL: un nombre le pertenece a un solo perfil en todo el
//     casino (ver findProfileByName en lib/profile-store-base.js). Dentro de
//     una mesa se aplica además el chequeo local (jugadores, tribuna y bots
//     sentados ahí) para dar un error más específico y cubrir a los bots,
//     que no viven en el registro de perfiles. La comparación ignora
//     mayúsculas y espacios extra (normalizeDisplayName), igual en ambos
//     niveles, para que las dos reglas nunca discrepen.
function nameHasProfanity(value) {
  const raw = String(value || '');
  if (PROFANITY_TEST.test(raw)) return true;
  const squashed = raw.replace(/[\s._*-]+/g, '');
  return squashed !== raw && PROFANITY_TEST.test(squashed);
}
function displayNameIssue(name) {
  if (nameHasProfanity(name)) return 'Elige un nombre sin palabras ofensivas.';
  return null;
}
function sameDisplayName(a, b) {
  const normalized = normalizeDisplayName(a);
  return Boolean(normalized) && normalized === normalizeDisplayName(b);
}
function roomNameTaken(room, name, exceptId = null) {
  if (!room || !name) return false;
  if (room.players.some(p => p.id !== exceptId && sameDisplayName(p.name, name))) return true;
  return (room.spectators || []).some(s => s.connected && s.id !== exceptId && sameDisplayName(s.name, name));
}
// Validación completa de un nombre de persona: sin groserías, sin duplicar el
// nombre de nadie en la mesa indicada (si hay) y sin duplicar el de NINGÚN
// otro perfil del casino, esté donde esté. `exceptId` es el perfil de quien
// pide el nombre: renombrarse al propio nombre nunca se rechaza.
function nameIssue(name, { room = null, exceptId = null } = {}) {
  const offensive = displayNameIssue(name);
  if (offensive) return offensive;
  if (room && roomNameTaken(room, name, exceptId)) return 'Ese nombre ya está en uso en esta mesa. Elige otro.';
  if (profiles.findProfileByName(name, exceptId)) return 'Ese nombre ya lo usa otra persona en el casino. Elige otro.';
  return null;
}
// Mesa (si hay) donde este perfil está sentado o mirando ahora mismo. Se usa
// para validar renombrados que llegan FUERA de una mesa (editar la cuenta
// desde el lobby, crear cuenta, apodo del chat): el nombre nuevo tampoco
// puede chocar con los de ESA mesa — por ejemplo, un bot sentado en ella,
// que no aparece en el registro global de perfiles.
function roomOfProfile(profile) {
  if (!profile) return null;
  for (const room of rooms.values()) {
    if (room.players.some(p => p._profile === profile)) return room;
    if ((room.spectators || []).some(s => s._profile === profile)) return room;
  }
  return null;
}
function duplicateMessageWithinWindow(socket, channel, text) {
  const now = Date.now();
  socket.data.lastChatMessages = socket.data.lastChatMessages || {};
  const previous = socket.data.lastChatMessages[channel];
  if (previous && previous.text === text && now - previous.time < 8000) return true;
  socket.data.lastChatMessages[channel] = { text, time: now };
  return false;
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function makeDeck(decks = 1) {
  const deck = [];
  for (let n = 0; n < decks; n++) {
    for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function draw(room) {
  if (!room.deck || room.deck.length < 15) room.deck = makeDeck(room.game === 'blackjack' ? 4 : 1);
  return room.deck.pop();
}
function addSystem(room, text) {
  room.messages.push({ id: `${Date.now()}-${Math.random()}`, system: true, text, time: Date.now() });
  room.messages = room.messages.slice(-40);
}
function newPlayer(id, socket, name, avatar) {
  const profile = profiles.getOrCreate(id, name, avatar);
  const player = {
    id: profile.id,
    socketId: socket.id,
    name: profile.name,
    avatar: profile.avatar,
    connected: true,
    lastActiveAt: Date.now(),
    hand: [],
    bet: 0,
    roundBet: 0,
    totalBet: 0,
    status: 'waiting',
    folded: false,
    allIn: false,
    acted: false,
    quickChoice: null
  };
  Object.defineProperty(player, '_profile', { value: profile, enumerable: false });
  Object.defineProperty(player, 'chips', {
    enumerable: true,
    configurable: true, // Fase 8.1: los torneos intercambian temporalmente el saldo real por un stack de torneo.
    get: () => profile.chips,
    set: value => { profile.chips = Math.max(0, Math.floor(Number(value) || 0)); profiles.touch(profile); }
  });
  return player;
}
// La Rueda está disponible cuando su diario transaccional arrancó. Con
// FORTUNE_ENABLED=off (o si el diario no pudo iniciarse) se rechaza en el
// servidor y la interfaz deshabilita la tarjeta con el aviso de healthz.
function fortuneAvailable() {
  return Boolean(fortuneEnabled && fortuneLedger?.ready);
}
// Cierra (con devolución) la ronda de Rueda de una mesa que desaparece: la
// gente pudo apostar y quedarse sin resultado si la mesa se destruye.
function closeFortuneRoom(room, reason = 'room_closed') {
  if (!room || room.game !== 'fortune' || !room.fortuneRoundId || !fortuneLedger) return 0;
  const roundId = room.fortuneRoundId;
  room.fortuneRoundId = null;
  try {
    const result = fortuneLedger.refundOpenRound({ roundId, reason });
    if (result.refunded > 0) logEvent('fortune_round_refunded', { room: room.code, roundId, amount: result.refunded, reason });
    return result.refunded;
  } catch (error) {
    logEvent('fortune_refund_failed', { room: room.code, roundId, message: String(error?.message || error) });
    return 0;
  }
}
function createRoom(game, host, socket, requestedName) {
  const code = makeCode();
  const fallbackNames = {
    poker: `Mesa de ${host.name}`,
    blackjack: `Club 21 de ${host.name}`,
    roulette: `Ruleta de ${host.name}`,
    dice: `Dados de ${host.name}`,
    coinflip: `Duelo de ${host.name}`,
    slots: `Tragamonedas de ${host.name}`,
    fortune: `Rueda de ${host.name}`
  };
  const quick = isQuickGame(game);
  const room = {
    code,
    name: cleanRoomName(requestedName) || fallbackNames[game] || `Mesa de ${host.name}`,
    game,
    hostId: host.id,
    players: [host],
    phase: game === 'blackjack' || quick ? 'betting' : 'waiting',
    deck: [],
    dealerHand: [],
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: 20,
    turnId: null,
    turnDeadline: null,
    turnDuration: game === 'poker' ? 30000 : game === 'blackjack' ? 25000 : null,
    turnNonce: 0,
    dealerIndex: -1,
    roundSessionId: randomUUID(),
    handNumber: 0,
    messages: [],
    results: [],
    quickResult: null,
    recentWinners: [],
    spectators: [], // Fase 8: espectadores (modo observador con chat)
    lobbyTournamentMatch: null, // Torneo relámpago del lobby; no comparte entrada/premio del Sit & Go
    tournament: null, // Fase 8.1: torneo sit & go (solo póker)
    specialEvent: quick && game !== 'fortune' ? rollSpecialEvent() : null,
    // Rueda: identificador de la ronda en el diario transaccional. Cada ronda
    // nueva recibe uno distinto (ver resetQuickRound).
    fortuneRoundId: game === 'fortune' ? randomUUID() : null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  Object.defineProperty(room, '_timers', { value: new Set(), enumerable: false });
  Object.defineProperty(room, '_turnTimer', { value: null, writable: true, enumerable: false });
  Object.defineProperty(room, '_cleanupTimer', { value: null, writable: true, enumerable: false });
  addSystem(room, `${host.name} abrió la mesa.`);
  rooms.set(code, room);
  socket.join(code);
  return room;
}
// Fase 3: la aceptación de Términos y Condiciones es obligatoria para jugar.
// El cliente envía la versión aceptada; se registra en el perfil (con fecha)
// para que la constancia sobreviva a limpiezas de localStorage.
function verifyTosAcceptance(profile, tosVersion) {
  if (String(tosVersion || '') === TOS_VERSION) {
    if (profile.flags.tosVersion !== TOS_VERSION) {
      profile.flags.tosVersion = TOS_VERSION;
      profile.flags.tosAcceptedAt = Date.now();
      profiles.touch(profile);
    }
    return true;
  }
  return profile.flags?.tosVersion === TOS_VERSION;
}
const TOS_REQUIRED_MESSAGE = 'Debes aceptar los Términos y Condiciones vigentes para jugar.';

function playerForSocket(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return {};
  const player = room.players.find(p => p.id === socket.data.playerId);
  if (player) player.lastActiveAt = Date.now();
  return { room, player };
}
// Identidad de asiento. Con sesión de cuenta verificada por cookie (middleware
// io.use), la persona se sienta con el perfil de SU cuenta, sin importar el
// dispositivo: iniciar sesión recupera el mismo perfil y sus fichas (README).
// Sin esa sesión, el asiento sigue siendo el perfil del dispositivo (token).
function seatIdFor(socket, token) {
  return seatIdentity({
    accountSessionsEnabled: adminConfig.accountSessionsEnabled,
    accountProfileId: socket.data.accountProfileId,
    token
  });
}
function syncSocketLobbyIdentity(socket, profile) {
  if (!profile || socket.data.lobbyChat?.id !== profile.id) return;
  socket.data.lobbyChat.name = profile.name;
  socket.data.lobbyChat.avatar = profile.avatar;
}
function isPokerActive(room) {
  return ['preflop', 'flop', 'turn', 'river'].includes(room.phase);
}
function publicRoom(room, viewerId) {
  return {
    code: room.code,
    name: room.name,
    game: room.game,
    hostId: room.hostId,
    viewerId,
    phase: room.phase,
    players: room.players.map((p, index) => ({
      id: p.id,
      seat: index,
      name: p.name,
      avatar: p.avatar || p._profile?.avatar || 'fox',
      passport: passportConfig.enabled && p._profile
        ? publicPassportIdentity(p._profile)
        : { equipped: { frame: null, title: null, badge: null } },
      collection: p._profile ? publicCollectionIdentity(p._profile) : { equipped: { avatar: null, frame: null, chips: null, felt: null, cards: null } },
      fanPin: p._profile ? publicFanPin(p._profile) : null,
      chips: p.chips,
      stats: p._profile ? publicProgress(p._profile).stats : null,
      connected: p.connected,
      isBot: Boolean(p.isBot),
      bot: publicBot(p),
      // Privacidad de cartas (fase 4): cada quien ve solo su mano.
      // Blackjack: las manos ajenas van boca abajo hasta los resultados.
      // Póker: boca abajo hasta el showdown (solo manos vivas se muestran).
      hand: room.game === 'blackjack'
        ? (p.id === viewerId || room.phase === 'results' ? p.hand : p.hand.map(() => 'XX'))
        : (p.id === viewerId || (room.phase === 'showdown' && !p.folded) ? p.hand : p.hand.map(() => 'XX')),
      bet: p.bet,
      roundBet: p.roundBet,
      totalBet: p.totalBet,
      status: p.status,
      folded: p.folded,
      allIn: p.allIn,
      quickChoice: p.id === viewerId || room.phase === 'results' ? p.quickChoice : (p.bet > 0 ? 'locked' : null),
      // Fase 8.4: seguro y mano dividida (la mano ajena viaja boca abajo, como la principal).
      insurance: p.insurance || 0,
      split: p.split ? {
        bet: p.split.bet,
        active: p.split.active,
        mainStatus: p.split.mainStatus,
        status: p.split.status,
        hand: p.id === viewerId || room.phase === 'results' ? p.split.hand : p.split.hand.map(() => 'XX')
      } : null,
      isHost: p.id === room.hostId
    })),
    dealerHand: room.game === 'blackjack' && room.phase === 'playing' && room.dealerHand.length > 1
      ? [room.dealerHand[0], 'XX']
      : room.dealerHand,
    community: room.community,
    pot: room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    turnId: room.turnId,
    turnDeadline: room.turnDeadline,
    turnDuration: room.turnDuration,
    dealerIndex: room.dealerIndex,
    handNumber: room.handNumber,
    messages: room.messages,
    results: room.results,
    quickResult: room.quickResult,
    recentWinners: room.recentWinners || [],
    specialEvent: room.specialEvent || null,
    gameMeta: QUICK_GAMES[room.game] || null,
    viewerProfile: (() => {
      const viewer = room.players.find(player => player.id === viewerId);
      return viewer?._profile ? publicProgress(viewer._profile, true) : null;
    })(),
    // Torneo relámpago originado en el lobby; separado del Sit & Go de mesa.
    lobbyTournamentMatch: room.lobbyTournamentMatch ? {
      tournamentId: room.lobbyTournamentMatch.tournamentId,
      tournamentName: room.lobbyTournamentMatch.tournamentName,
      matchId: room.lobbyTournamentMatch.matchId,
      roundLabel: room.lobbyTournamentMatch.roundLabel,
      roundIndex: room.lobbyTournamentMatch.roundIndex,
      matchNumber: room.lobbyTournamentMatch.matchNumber,
      status: room.lobbyTournamentMatch.status,
      level: room.lobbyTournamentMatch.level,
      handsAtLevel: room.lobbyTournamentMatch.handsAtLevel,
      handsPerLevel: room.lobbyTournamentMatch.handsPerLevel,
      winnerName: room.lobbyTournamentMatch.winnerName || null,
      forfeit: Boolean(room.lobbyTournamentMatch.forfeit)
    } : null,
    // Fase 8.1: estado del torneo sit & go (si existe).
    tournament: room.tournament ? {
      active: room.tournament.active,
      entry: room.tournament.entry,
      prize: room.tournament.prize,
      level: room.tournament.level,
      blinds: tournamentBlinds(room.tournament.level),
      handsAtLevel: room.tournament.handsAtLevel,
      handsPerLevel: room.tournament.handsPerLevel,
      remaining: room.tournament.active ? tournamentAlive(room).length : 0,
      eliminated: room.tournament.eliminated.slice(-6),
      winnerName: room.tournament.winnerName || null
    } : null,
    // Fase 8: tribuna de espectadores. El viewer sabe si está observando; nadie ve cartas ajenas.
    spectators: (room.spectators || []).filter(s => s.connected).map(s => ({
      id: s.id, name: s.name, avatar: s.avatar,
      collection: s._profile ? publicCollectionIdentity(s._profile) : { equipped: { avatar: null, frame: null, chips: null, felt: null, cards: null } }
    })),
    viewerSpectator: (() => {
      const spectator = (room.spectators || []).find(s => s.id === viewerId);
      return spectator ? {
        id: spectator.id, name: spectator.name, avatar: spectator.avatar,
        collection: spectator._profile ? publicCollectionIdentity(spectator._profile) : { equipped: { avatar: null, frame: null, chips: null, felt: null, cards: null } }
      } : null;
    })(),
    avatars: AVATARS,
    botOptions: {
      difficulties: Object.values(DIFFICULTIES).map(({ id, label }) => ({ id, label })),
      styles: Object.values(STYLES).map(({ id, label }) => ({ id, label })),
      capacity: ROOM_CAPACITY
    }
  };
}
function lobbySnapshot() {
  return [...rooms.values()]
    .filter(room => room.players.some(player => player.connected))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(room => ({
      code: room.code,
      name: room.name,
      game: room.game,
      phase: room.phase,
      players: room.players.filter(player => player.connected).length,
      humans: room.players.filter(player => player.connected && !player.isBot).length,
      bots: room.players.filter(player => player.connected && player.isBot).length,
      capacity: ROOM_CAPACITY,
      host: room.players.find(player => player.id === room.hostId)?.name || 'Sin anfitrión',
      handNumber: room.handNumber,
      createdAt: room.createdAt
    }));
}
// Fase 8.6: datos del ranking mensual para el lobby. El historial persistido
// guarda ids internos para poder auditar/reparar una premiación, pero esos ids
// de dispositivo nunca se exponen al navegador.
function publicSeasonRecord(record) {
  if (!record) return null;
  return {
    month: record.month,
    players: record.players,
    closedAt: record.closedAt || null,
    timeZone: record.timeZone || CASINO_TIME_ZONE,
    podium: (record.podium || []).map(({ name, avatar, chips, medals, championBanner }) => ({
      name, avatar, chips, medals: medals || 0, championBanner: Boolean(championBanner)
    }))
  };
}
function seasonSnapshot() {
  return {
    month: profiles.seasons.current,
    timeZone: CASINO_TIME_ZONE,
    ranking: profiles.top(10),
    previous: publicSeasonRecord(profiles.seasons.history[profiles.seasons.history.length - 1])
  };
}
// Presencia real del casino: incluye a quien está explorando el lobby, jugando
// o mirando una mesa. El cálculo anterior sumaba solo humanos sentados en salas,
// por eso el contador decía 0 aunque hubiera varias personas en el lobby y no
// cambiaba hasta que alguien creaba una mesa. El cliente manda su token de
// dispositivo en el handshake para que dos pestañas de la misma persona cuenten
// una sola vez; clientes antiguos/sockets de pruebas tienen un fallback único.
function onlinePlayerCount() {
  const devices = new Set();
  for (const socket of io.of('/').sockets.values()) {
    const token = String(socket.handshake?.auth?.deviceToken || '').trim().slice(0, 80);
    devices.add(token ? `device:${token}` : `socket:${socket.id}`);
  }
  return devices.size;
}
function lobbyStateSnapshot() {
  return { rooms: lobbySnapshot(), playersOnline: onlinePlayerCount(), season: seasonSnapshot() };
}
function broadcastLobby() {
  io.emit('lobby_state', lobbyStateSnapshot());
}
function lobbyTournamentProfileIdForSocket(socket, legacyAccountId = null) {
  const authenticatedId = socket?.data?.accountProfileId;
  if (authenticatedId && profiles?.profiles?.has(authenticatedId)) return authenticatedId;
  const selectedId = socket?.data?.lobbyTournamentProfileId;
  if (selectedId && profiles?.profiles?.has(selectedId)) return selectedId;
  const seatedId = socket?.data?.playerId;
  if (seatedId && profiles?.profiles?.has(seatedId)) return seatedId;
  if (!adminConfig.accountSessionsEnabled && legacyAccountId) {
    const candidateId = String(legacyAccountId).slice(0, 80);
    if (profiles?.profiles?.get(candidateId)?.username) return candidateId;
  }
  return String(socket?.handshake?.auth?.deviceToken || '').trim().slice(0, 80);
}
function betRankingProfileIdForSocket(socket) {
  if (!socket || !profiles?.profiles) return null;
  // Cada contexto conserva la identidad que ya resolvió de forma confiable:
  // asiento/tribuna del casino, suscripción del Estadio o cookie de cuenta.
  // Nunca se aceptan ids enviados en el payload de la clasificación.
  const deviceToken = String(socket.handshake?.auth?.deviceToken || '').trim().slice(0, 80);
  const candidates = [
    socket.data?.playerId,
    socket.data?.spectatorId,
    socket.data?.football?.profileId,
    socket.data?.lobbyTournamentProfileId,
    socket.data?.accountProfileId,
    deviceToken
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate && profiles.profiles.has(candidate)) return candidate;
  }
  return null;
}
function emitBetRanking(socket) {
  if (!profiles?.profiles) return;
  const profileId = betRankingProfileIdForSocket(socket);
  socket.emit('bet_ranking_state', buildBettingLeaderboard({
    profiles: profiles.profiles, footballStore, profileId, limit: 25
  }));
}
function broadcastBetRanking() {
  if (!profiles?.profiles) return;
  const subscribers = [...io.of('/').sockets.values()].filter(socket => socket.data?.betRankingSubscribed);
  if (!subscribers.length) return;
  const leaderboard = createBettingLeaderboard({ profiles: profiles.profiles, footballStore, limit: 25 });
  for (const socket of subscribers) {
    socket.emit('bet_ranking_state', {
      ...leaderboard.snapshot,
      me: leaderboard.personal(betRankingProfileIdForSocket(socket))
    });
  }
}
function broadcastLobbyTournaments() {
  if (!lobbyTournaments) return;
  for (const socket of io.of('/').sockets.values()) {
    const profileId = lobbyTournamentProfileIdForSocket(socket);
    socket.emit('lobby_tournaments_state', lobbyTournaments.snapshotFor(profileId));
  }
}
function gameEvent(room, type, text, playerId = null, meta = {}) {
  const event = { type, text, playerId, time: Date.now(), ...meta };
  if (playerId) {
    const player = room.players.find(item => item.id === playerId);
    if (player?.socketId) io.to(player.socketId).emit('game_event', event);
  } else io.to(room.code).emit('game_event', event);
}
function emitProgress(room, player, events = []) {
  if (!events.length || !player?.socketId) return;
  io.to(player.socketId).emit('profile_event', { events, profile: publicProgress(player._profile, true) });
  for (const event of events) {
    if (event.type === 'achievement') {
      io.to(room.code).emit('social_event', { type: 'achievement', playerId: player.id, name: player.name, icon: event.icon, text: `${player.name} desbloqueó “${event.name}”.` });
    }
  }
}
function trackWager(room, player, amount) {
  const events = recordWager(player._profile, amount);
  if (!player.isBot) profiles.touch(player._profile);
  emitProgress(room, player, events);
  // El ranking se alimenta en el instante en que se confirma cada apuesta, no
  // al liquidarse la ronda. Los bots no forman parte de la clasificación pública.
  if (!player.isBot) broadcastBetRanking();
}
function completePlayerRound(room, player, net) {
  let finalNet = Math.floor(Number(net) || 0);
  const specialBonus = bonusFor(room.specialEvent, finalNet);
  if (specialBonus > 0) {
    player.chips += specialBonus;
    finalNet += specialBonus;
    gameEvent(room, 'special_reward', `${room.specialEvent.label}: +${specialBonus} fichas.`, player.id, { amount: specialBonus, event: room.specialEvent });
  }
  // Solo las rondas con una apuesta válida de una persona real alimentan la
  // racha elegible para la medalla de platino; las estadísticas generales
  // siguen contando también las partidas contra bots.
  const wagered = room.game === 'poker' ? player.totalBet : player.bet;
  const eligibleForPlatinum = !player.isBot && Number(wagered) > 0;
  const roundId = `${room.roundSessionId || room.code}:${room.handNumber}`;
  const events = recordOutcome(player._profile, {
    game: room.game,
    net: finalNet,
    eligible: eligibleForPlatinum,
    roundId,
    passportEligible: passportConfig.enabled && eligibleForPlatinum
  });
  if (!player.isBot) profiles.touch(player._profile);
  if (player.isBot && player.botStats) {
    player.botStats.roundsPlayed++;
    if (finalNet > 0) { player.botStats.wins++; player.botStats.chipsWon += finalNet; }
    else if (finalNet < 0) { player.botStats.losses++; player.botStats.chipsLost += Math.abs(finalNet); }
    else player.botStats.pushes++;
    if (!player.botStats.games.includes(room.game)) player.botStats.games.push(room.game);
  }
  emitProgress(room, player, events);
  if (finalNet >= 500 || room.specialEvent?.type === 'jackpot' && finalNet > 0) {
    io.to(room.code).emit('social_event', { type: 'big_win', playerId: player.id, name: player.name, amount: finalNet, text: `${player.name} logró una gran ganancia de ${finalNet} fichas.` });
  }
  return { net: finalNet, specialBonus };
}
function addRecentWinner(room, player, amount) {
  if (amount <= 0) return;
  room.recentWinners.unshift({ playerId: player.id, name: player.name, avatar: player.avatar, amount, game: room.game, time: Date.now() });
  room.recentWinners = room.recentWinners.slice(0, 8);
}
function beginSpecialEvent(room) {
  // Un bracket del lobby usa stacks y premios fijos; no mezcla jackpots ni
  // bonificaciones aleatorias de las mesas sociales.
  if (room.lobbyTournamentMatch) { room.specialEvent = null; return; }
  room.specialEvent = rollSpecialEvent();
  if (room.specialEvent) gameEvent(room, 'special', `${room.specialEvent.icon} ${room.specialEvent.label}: ${room.specialEvent.description}.`);
}
function publishRoom(room, includeLobby = false) {
  if (!room || !rooms.has(room.code)) return;
  room.updatedAt = Date.now();
  for (const player of room.players) {
    if (player._profile) {
      player.name = player._profile.name;
      player.avatar = player._profile.avatar;
      if (!player.isBot) profiles.touch(player._profile);
    }
    if (player.connected && player.socketId) io.to(player.socketId).emit('room_state', publicRoom(room, player.id));
  }
  for (const spectator of room.spectators || []) {
    if (spectator.connected && spectator.socketId) io.to(spectator.socketId).emit('room_state', publicRoom(room, spectator.id));
  }
  if (includeLobby) broadcastLobby();
}
function broadcast(room) {
  publishRoom(room, true);
  botController?.sync(room);
}
function scheduleRoomTask(room, callback, delay) {
  if (!room?._timers || !rooms.has(room.code)) return null;
  let timer = null;
  timer = setTimeout(() => {
    room._timers.delete(timer);
    // Auditoría (misma clase que el ReferenceError que tumbó el casino): estas
    // tareas ejecutan lógica de juego fuera de cualquier handler de socket
    // (auto-jugadas por tiempo agotado, resolución de rondas rápidas y
    // limpieza de mesas). Sin esta envoltura, cualquier excepción aquí subía
    // directa a uncaughtException y mataba el proceso con TODAS las mesas.
    try {
      callback();
    } catch (error) {
      console.error(`[ROOM_TASK_ERROR] mesa=${room.code} juego=${room.game}:`, error);
      logEvent('room_task_error', { room: room.code, game: room.game, message: String(error?.message || error) });
    }
  }, Math.max(0, delay));
  timer.unref?.();
  room._timers.add(timer);
  return timer;
}
function clearRoomTasks(room) {
  if (!room) return;
  for (const timer of room._timers || []) clearTimeout(timer);
  room._timers?.clear();
  room._turnTimer = null;
  if (room._cleanupTimer) clearTimeout(room._cleanupTimer);
  room._cleanupTimer = null;
  botController?.cancelRoom(room.code);
}
function removeSpectator(room, spectatorId) {
  const spectator = room.spectators?.find(s => s.id === spectatorId);
  if (!spectator) return;
  room.spectators = room.spectators.filter(s => s.id !== spectatorId);
  addSystem(room, `👁 ${spectator.name} dejó de ver la mesa.`);
}
function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return false;
  // Si la mesa se destruye con apuestas de la Rueda sin resultado, se devuelven.
  closeFortuneRoom(room, 'room_closed');
  clearRoomTasks(room);
  rooms.delete(code);
  // Fase 8: avisar a espectadores (y a cualquier socket rezagado) que la mesa cerró.
  io.to(code).emit('room_closed', { code });
  if (room.lobbyTournamentMatch) {
    for (const player of room.players) {
      const socket = player.socketId ? io.of('/').sockets.get(player.socketId) : null;
      if (socket?.data?.roomCode === code) {
        delete socket.data.roomCode;
        delete socket.data.playerId;
        delete socket.data.spectatorId;
        socket.leave(code);
      }
    }
  }
  logEvent('room_destroyed', { room: code, game: room.game, hands: room.handNumber || 0 });
  broadcastLobby();
  if (room.lobbyTournamentMatch) broadcastLobbyTournaments();
  return true;
}
function clearTurn(room) {
  room.turnNonce = (room.turnNonce || 0) + 1;
  room.turnId = null;
  room.turnDeadline = null;
  if (room._turnTimer) {
    clearTimeout(room._turnTimer);
    room._timers?.delete(room._turnTimer);
    room._turnTimer = null;
  }
}
function setTurn(room, playerId) {
  clearTurn(room);
  if (!playerId) return;
  room.turnId = playerId;
  room.turnDuration = room.game === 'poker' ? 30000 : 25000;
  room.turnDeadline = Date.now() + room.turnDuration;
  const nonce = room.turnNonce;
  const player = room.players.find(item => item.id === playerId);
  if (player) gameEvent(room, 'turn', 'Es tu turno. Elige tu jugada.', playerId, { deadline: room.turnDeadline });
  room._turnTimer = scheduleRoomTask(room, () => {
    room._turnTimer = null;
    handleTurnTimeout(room.code, playerId, nonce);
  }, room.turnDuration + 80);
}
function handleTurnTimeout(code, playerId, nonce) {
  const room = rooms.get(code);
  if (!room || room.turnId !== playerId || room.turnNonce !== nonce || Date.now() < room.turnDeadline) return;
  const player = room.players.find(item => item.id === playerId);
  if (!player) return;
  if (room.game === 'poker' && isPokerActive(room)) {
    const canCheck = player.roundBet === room.currentBet;
    executePokerAction(room, player, { action: canCheck ? 'check' : 'fold' });
    addSystem(room, `${player.name} agotó su tiempo: ${canCheck ? 'pasa automáticamente' : 'se retira automáticamente'}.`);
    gameEvent(room, 'timeout', `El tiempo de ${player.name} terminó.`);
  } else if (room.game === 'blackjack' && room.phase === 'playing') {
    executeBlackjackAction(room, player, 'stand');
    addSystem(room, `${player.name} agotó su tiempo y se planta automáticamente.`);
    gameEvent(room, 'timeout', `El tiempo de ${player.name} terminó.`);
  }
  broadcast(room);
}
function actionError(error, code = 'invalid') { return { ok: false, error, code }; }
function actionOk(extra = {}) { return { ok: true, ...extra }; }
function ackResult(ack, result) {
  if (typeof ack === 'function') ack(result);
  return result;
}
function ackError(ack, message) { return ackResult(ack, actionError(message)); }
function ackOk(ack, extra = {}) { return ackResult(ack, actionOk(extra)); }
function nextConnectedHost(room) {
  // La autoridad de la mesa siempre prefiere personas reales conectadas.
  const next = room.players.find(p => p.connected && !p.isBot) || room.players.find(p => p.connected);
  room.hostId = next ? next.id : null;
}

// ---------------- BLACKJACK ----------------
// Fase 8.4: valor individual de una carta de blackjack (para validar splits).
function bjCardValue(card) {
  const rank = String(card).slice(0, -1);
  if (rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(rank)) return 10;
  return Number(rank);
}
// Fase 8.4: mano activa del jugador (principal o dividida).
function bjActiveHandOf(player) {
  if (player.split && player.split.active === 'split') return { hand: player.split.hand, bet: player.split.bet, which: 'split' };
  return { hand: player.hand, bet: player.bet, which: 'main' };
}
// Fase 8.4: cierra una mano y decide si sigue la otra mano del split o el siguiente jugador.
function bjSetHandDone(room, player, which, status) {
  if (!player.split) {
    player.status = status;
    nextBlackjackTurn(room, player.id);
    return;
  }
  if (which === 'main') player.split.mainStatus = status; else player.split.status = status;
  if (player.split.mainStatus === 'playing') {
    player.split.active = 'main';
    setTurn(room, player.id);
    return;
  }
  if (player.split.status === 'playing') {
    if (blackjackScore(player.split.hand).value === 21) player.split.status = 'stand';
    else {
      player.split.active = 'split';
      setTurn(room, player.id);
      return;
    }
  }
  player.status = player.split.mainStatus === 'bust' && player.split.status === 'bust' ? 'bust' : 'stand';
  nextBlackjackTurn(room, player.id);
}
function blackjackScore(hand) {
  let value = 0;
  let aces = 0;
  for (const card of hand) {
    const rank = card.slice(0, -1);
    if (rank === 'A') { value += 11; aces++; }
    else if (['K', 'Q', 'J'].includes(rank)) value += 10;
    else value += Number(rank);
  }
  while (value > 21 && aces > 0) { value -= 10; aces--; }
  return { value, soft: aces > 0 };
}
function nextBlackjackTurn(room, afterId) {
  const start = room.players.findIndex(p => p.id === afterId);
  for (let step = 1; step <= room.players.length; step++) {
    const p = room.players[(start + step) % room.players.length];
    if (p.bet > 0 && p.status === 'playing') {
      setTurn(room, p.id);
      return;
    }
  }
  finishBlackjack(room);
}
function finishBlackjack(room) {
  clearTurn(room);
  let dealer = blackjackScore(room.dealerHand);
  while (dealer.value < 17) {
    room.dealerHand.push(draw(room));
    dealer = blackjackScore(room.dealerHand);
  }
  const dealerNatural = room.dealerHand.length === 2 && dealer.value === 21;
  const outcomes = [];
  for (const p of room.players.filter(p => p.bet > 0)) {
    // Fase 8.4: se evalúa la mano principal y, si existe, la mano dividida.
    const hands = [{ hand: p.hand, bet: p.bet, status: p.split ? p.split.mainStatus : p.status, natural: p.status === 'blackjack' && !p.split }];
    if (p.split) hands.push({ hand: p.split.hand, bet: p.split.bet, status: p.split.status, natural: false });
    let payout = 0;
    let totalBet = 0;
    const labels = [];
    for (const item of hands) {
      totalBet += item.bet;
      const score = blackjackScore(item.hand);
      let handPayout = 0;
      let label;
      if (item.status === 'bust' || score.value > 21) label = 'Pierde';
      else if (item.natural && !dealerNatural) { label = 'Blackjack'; handPayout = item.bet * 2.5; }
      else if (dealer.value > 21 || score.value > dealer.value) { label = 'Gana'; handPayout = item.bet * 2; }
      else if (score.value === dealer.value) { label = 'Empate'; handPayout = item.bet; }
      else label = 'Pierde';
      payout += handPayout;
      labels.push(label);
    }
    // Fase 8.4: liquidación del seguro (paga 2:1 si la casa tiene blackjack natural).
    let insuranceNet = 0;
    if (p.insurance > 0) {
      if (dealerNatural) { p.chips += p.insurance * 3; insuranceNet = p.insurance * 2; }
      else insuranceNet = -p.insurance;
    }
    p.chips += Math.floor(payout);
    const label = p.split ? (labels[0] === labels[1] ? `${labels[0]} ×2` : `${labels[0]} / ${labels[1]}`) : labels[0];
    p.status = Math.floor(payout) + insuranceNet > totalBet ? 'gana' : Math.floor(payout) + insuranceNet === totalBet ? 'empate' : 'pierde';
    const baseAmount = Math.floor(payout) - totalBet + insuranceNet;
    const { net: amount, specialBonus } = completePlayerRound(room, p, baseAmount);
    outcomes.push({ id: p.id, name: p.name, label, amount, specialBonus });
    addRecentWinner(room, p, amount);
    gameEvent(room, amount > 0 ? 'win' : amount < 0 ? 'loss' : 'push', amount > 0 ? `Ganaste ${amount} fichas.` : amount < 0 ? `Perdiste ${Math.abs(amount)} fichas.` : 'Empate: recuperas tu apuesta.', p.id, { amount });
  }
  room.results = outcomes;
  room.phase = 'results';
  const dealerText = dealerNatural ? 'La casa tiene blackjack natural.' : dealer.value > 21 ? `La casa se pasó con ${dealer.value}.` : `La casa terminó con ${dealer.value}.`;
  addSystem(room, dealerText);
  releaseBotSeats(room);
}
function startBlackjack(room) {
  if (room.phase !== 'betting') return actionError('La ronda ya está en curso.');
  purgeDepartedPlayers(room);
  const playing = room.players.filter(p => p.bet > 0 && p.connected);
  if (!playing.length) return actionError('Al menos una persona debe apostar.');
  beginSpecialEvent(room);
  // Gancho de pruebas: un mazo fijo permite verificar seguro y split de forma determinista.
  room.deck = process.env.TEST_BLACKJACK_DECK
    ? JSON.parse(process.env.TEST_BLACKJACK_DECK).slice().reverse()
    : (room.deck.length > 60 ? room.deck : makeDeck(4));
  room.dealerHand = [draw(room), draw(room)];
  room.results = [];
  room.handNumber++;
  for (const p of room.players) {
    p.hand = [];
    p.insurance = 0; // Fase 8.4
    p.split = null; // Fase 8.4
    if (p.bet > 0 && p.connected) {
      p.hand = [draw(room), draw(room)];
      const score = blackjackScore(p.hand).value;
      p.status = score === 21 ? 'blackjack' : 'playing';
    } else p.status = 'waiting';
  }
  // Fase 8.4: si la casa muestra un as, se abre la ventana de seguro.
  if (String(room.dealerHand[0]).slice(0, -1) === 'A') {
    addSystem(room, '🛡 La casa muestra un as: puedes tomar un seguro por la mitad de tu apuesta antes de tu primera jugada.');
  }
  room.phase = 'playing';
  clearTurn(room);
  const first = room.players.find(p => p.bet > 0 && p.status === 'playing');
  if (first) setTurn(room, first.id);
  else finishBlackjack(room);
  addSystem(room, `Ronda ${room.handNumber}: cartas repartidas.`);
  gameEvent(room, 'round', `Comenzó la ronda ${room.handNumber}.`);
  return actionOk();
}
function resetBlackjack(room) {
  room.phase = 'betting';
  clearTurn(room);
  room.dealerHand = [];
  room.results = [];
  room.specialEvent = null;
  for (const p of room.players) {
    p.hand = [];
    p.bet = 0;
    p.insurance = 0; // Fase 8.4
    p.split = null; // Fase 8.4
    p.status = 'waiting';
  }
}

// ---------------- POKER ----------------
function takeChips(room, player, amount) {
  const paid = Math.max(0, Math.min(player.chips, amount));
  player.chips -= paid;
  player.roundBet += paid;
  player.totalBet += paid;
  // El all-in se decide ANTES de acreditar recompensas de retos: trackWager puede
  // sumar fichas de premio al instante y, si se evaluaba después, el jugador
  // quedaba "vivo" con fichas caídas del cielo a media mano (mesa trabada).
  if (player.chips === 0) player.allIn = true;
  if (paid) trackWager(room, player, paid);
  return paid;
}
function nextSeat(room, fromIndex, predicate) {
  for (let step = 1; step <= room.players.length; step++) {
    const index = (fromIndex + step) % room.players.length;
    if (predicate(room.players[index])) return index;
  }
  return -1;
}
function handPlayers(room) {
  return room.players.filter(p => p.hand.length === 2);
}
function livePokerPlayers(room) {
  return handPlayers(room).filter(p => !p.folded);
}
function actablePokerPlayers(room) {
  return livePokerPlayers(room).filter(p => !p.allIn && p.connected);
}
function setNextPokerTurn(room, afterId) {
  const start = room.players.findIndex(p => p.id === afterId);
  const index = nextSeat(room, start, p => p.hand.length === 2 && !p.folded && !p.allIn && p.connected);
  setTurn(room, index >= 0 ? room.players[index].id : null);
}
function pokerRoundComplete(room) {
  const actable = actablePokerPlayers(room);
  if (!actable.length) return true;
  // Frente a un all-in, la última persona con fichas CONSERVA su turno si tiene
  // una apuesta pendiente por responder (igualar, subir o retirarse). Antes la
  // ronda se cerraba aquí y la mano corría sola al showdown disputando solo las
  // ciegas, con el excedente del all-in "devuelto" como si fuera una victoria.
  if (actable.length === 1 && livePokerPlayers(room).some(p => p.allIn)) {
    return actable[0].roundBet >= room.currentBet;
  }
  return actable.every(p => p.acted && p.roundBet === room.currentBet);
}
function awardSinglePokerWinner(room, player) {
  const payout = room.pot;
  player.chips += payout;
  let winnerNet = payout - player.totalBet;
  const progress = new Map();
  for (const participant of handPlayers(room)) {
    const baseNet = participant.id === player.id ? winnerNet : -participant.totalBet;
    progress.set(participant.id, completePlayerRound(room, participant, baseNet));
  }
  const winnerProgress = progress.get(player.id);
  const totalAward = payout + (winnerProgress?.specialBonus || 0);
  winnerNet = winnerProgress?.net || winnerNet;
  room.results = [{ id: player.id, name: player.name, label: 'Gana sin mostrar', amount: totalAward, net: winnerNet }];
  addRecentWinner(room, player, winnerNet);
  addSystem(room, `${player.name} gana ${totalAward} fichas; el resto se retiró.`);
  gameEvent(room, 'win', `Ganaste ${winnerNet} fichas netas.`, player.id, { amount: winnerNet });
  for (const participant of handPlayers(room).filter(item => item.id !== player.id)) gameEvent(room, 'loss', 'Esta vez no ganaste el bote.', participant.id);
  room.pot = 0;
  clearTurn(room);
  room.phase = 'showdown';
  player.status = 'winner';
  tournamentAfterHand(room);
  lobbyTournamentAfterHand(room);
  releaseBotSeats(room);
}
function advancePokerStreet(room) {
  for (const p of handPlayers(room)) {
    p.roundBet = 0;
    p.acted = false;
  }
  room.currentBet = 0;
  const activeBlinds = room.tournament?.active
    ? tournamentBlinds(room.tournament.level)
    : room.lobbyTournamentMatch?.status === 'playing'
      ? tournamentBlinds(room.lobbyTournamentMatch.level)
      : { big: 20 };
  room.minRaise = activeBlinds.big;
  if (room.phase === 'preflop') {
    room.community.push(draw(room), draw(room), draw(room));
    room.phase = 'flop';
  } else if (room.phase === 'flop') {
    room.community.push(draw(room));
    room.phase = 'turn';
  } else if (room.phase === 'turn') {
    room.community.push(draw(room));
    room.phase = 'river';
  } else {
    return showdownPoker(room);
  }
  addSystem(room, room.phase === 'flop' ? 'Sale el flop.' : room.phase === 'turn' ? 'Sale el turn.' : 'Sale el river.');
  if (actablePokerPlayers(room).length <= 1) {
    return advancePokerStreet(room);
  }
  setNextPokerTurn(room, room.players[room.dealerIndex]?.id);
}
function resolvePokerAfterAction(room, actorId) {
  const live = livePokerPlayers(room);
  if (live.length === 1) return awardSinglePokerWinner(room, live[0]);
  if (pokerRoundComplete(room)) return advancePokerStreet(room);
  setNextPokerTurn(room, actorId);
}
// ---------------- Fase 8.1: TORNEOS SIT & GO DE PÓKER ----------------
// Todos los sentados pagan una entrada, reciben un stack fijo y juegan con
// ciegas crecientes hasta que queda un solo jugador, que se lleva el bote.
// Durante el torneo el saldo real del perfil queda protegido (solo se mueve
// la entrada al inicio y el premio al final).
const TOURNAMENT_ENTRY = 200;
const TOURNAMENT_STACK = 1000;
const TOURNAMENT_HANDS_PER_LEVEL = 3;
const LOBBY_MATCH_STACK = 1000;
const LOBBY_MATCH_HANDS_PER_LEVEL = 3;
function tournamentBlinds(level) {
  const small = 10 * Math.pow(2, Math.min(6, Math.max(1, level) - 1));
  return { small, big: small * 2 };
}
// Cambia las fichas del jugador humano por un stack de torneo independiente del perfil.
function detachTournamentChips(player, stack) {
  Object.defineProperty(player, 'chips', { enumerable: true, configurable: true, writable: true, value: stack });
}
// Restaura el enlace fichas ⇄ perfil (el saldo real, ya sin la entrada).
function restoreProfileChips(player) {
  if (player.isBot) return;
  const profile = player._profile;
  Object.defineProperty(player, 'chips', {
    enumerable: true,
    configurable: true,
    get: () => profile.chips,
    set: value => { profile.chips = Math.max(0, Math.floor(Number(value) || 0)); profiles.touch(profile); }
  });
}
function tournamentAlive(room) {
  const t = room.tournament;
  if (!t) return [];
  return room.players.filter(p => t.entrants.includes(p.id) && !t.eliminated.some(e => e.id === p.id));
}
function executeTournamentStart(room, actor) {
  if (!room || room.game !== 'poker') return actionError('Los torneos solo están disponibles en la mesa de póker.');
  if (room.lobbyTournamentMatch) return actionError('Este encuentro pertenece al bracket del lobby y no puede convertirse en un Sit & Go.');
  if (!actor || actor.id !== room.hostId) return actionError('Solo el anfitrión puede iniciar el torneo.');
  if (room.tournament?.active) return actionError('Ya hay un torneo en curso.');
  if (!['waiting', 'showdown'].includes(room.phase)) return actionError('Espera a que termine la mano actual.');
  beginRoundRoster(room);
  const entrants = room.players.filter(p => p.connected);
  if (entrants.length < 2) return actionError('Se necesitan al menos 2 jugadores para el torneo.');
  const poor = entrants.find(p => !p.isBot && p.chips < TOURNAMENT_ENTRY);
  if (poor) return actionError(`${poor.name} no tiene fichas para la entrada (${TOURNAMENT_ENTRY}).`);
  for (const p of entrants) {
    if (p.isBot) p.chips = TOURNAMENT_STACK;
    else { p.chips -= TOURNAMENT_ENTRY; detachTournamentChips(p, TOURNAMENT_STACK); }
    p.status = 'waiting';
  }
  room.tournament = {
    active: true, entry: TOURNAMENT_ENTRY, prize: TOURNAMENT_ENTRY * entrants.length,
    level: 1, handsAtLevel: 0, handsPerLevel: TOURNAMENT_HANDS_PER_LEVEL,
    entrants: entrants.map(p => p.id), eliminated: [], winnerName: null, startedAt: Date.now()
  };
  addSystem(room, `🏆 ¡Comienza el torneo sit & go! Entrada ${TOURNAMENT_ENTRY}, bote ${room.tournament.prize}, stack inicial ${TOURNAMENT_STACK}. Las ciegas suben cada ${TOURNAMENT_HANDS_PER_LEVEL} manos.`);
  gameEvent(room, 'round', `Torneo iniciado: ${entrants.length} jugadores compiten por ${room.tournament.prize} fichas.`);
  logEvent('tournament_started', { room: room.code, entrants: entrants.length, prize: room.tournament.prize });
  return startPoker(room);
}
// Marca a un participante como eliminado (por quedarse sin stack o por abandonar la mesa).
function eliminateEntrant(room, player, viaDeparture = false) {
  const t = room.tournament;
  if (!t?.active || !t.entrants.includes(player.id) || t.eliminated.some(e => e.id === player.id)) return;
  const place = tournamentAlive(room).length;
  t.eliminated.push({ id: player.id, name: player.name, place });
  player.status = 'eliminated';
  if (!player.isBot) restoreProfileChips(player);
  addSystem(room, `🏆 ${player.name} queda fuera del torneo (${place}.º lugar${viaDeparture ? ', abandonó la mesa' : ''}).`);
  gameEvent(room, 'loss', `Quedaste en ${place}.º lugar del torneo.`, player.id);
  if (viaDeparture) {
    const remaining = tournamentAlive(room).filter(p => p.id !== player.id);
    if (remaining.length === 1 && !isPokerActive(room)) finishTournament(room, remaining[0]);
  }
}
function finishTournament(room, winner) {
  const t = room.tournament;
  if (!t?.active) return;
  t.active = false;
  t.winnerName = winner ? winner.name : null;
  t.finishedAt = Date.now();
  for (const p of room.players.filter(item => t.entrants.includes(item.id))) {
    if (!p.isBot) restoreProfileChips(p);
    if (p.status === 'eliminated' || p.status === 'winner') p.status = 'waiting';
  }
  if (winner) {
    if (winner.isBot) winner.chips += t.prize;
    else { credit(winner._profile, t.prize, 'Premio del torneo sit & go'); profiles.touch(winner._profile); }
    addRecentWinner(room, winner, t.prize);
    addSystem(room, `🏆 ${winner.name} gana el torneo y se lleva las ${t.prize} fichas del bote.`);
    gameEvent(room, 'win', `¡Campeón del torneo! +${t.prize} fichas.`, winner.id, { amount: t.prize });
    logEvent('tournament_finished', { room: room.code, winner: winner.name, prize: t.prize, entrants: t.entrants.length });
  } else {
    addSystem(room, '🏆 El torneo terminó sin campeón.');
    logEvent('tournament_finished', { room: room.code, winner: null, prize: t.prize, entrants: t.entrants.length });
  }
  releaseBotSeats(room);
}
// Al terminar cada mano: procesa eliminaciones, sube ciegas y detecta al campeón.
function tournamentAfterHand(room) {
  const t = room.tournament;
  if (!t?.active) return;
  const busted = tournamentAlive(room).filter(p => p.chips <= 0);
  let place = tournamentAlive(room).length;
  for (const player of busted.sort((a, b) => (a.totalBet || 0) - (b.totalBet || 0))) {
    t.eliminated.push({ id: player.id, name: player.name, place });
    player.status = 'eliminated';
    if (!player.isBot) restoreProfileChips(player);
    addSystem(room, `🏆 ${player.name} queda eliminado del torneo (${place}.º lugar).`);
    gameEvent(room, 'loss', `Quedaste en ${place}.º lugar del torneo.`, player.id);
    place--;
  }
  const remaining = tournamentAlive(room);
  if (remaining.length <= 1) return finishTournament(room, remaining[0] || null);
  t.handsAtLevel++;
  if (t.handsAtLevel >= t.handsPerLevel) {
    t.handsAtLevel = 0;
    t.level++;
    const blinds = tournamentBlinds(t.level);
    addSystem(room, `🏆 Torneo: nivel ${t.level}. Las ciegas suben a ${blinds.small}/${blinds.big}.`);
    gameEvent(room, 'round', `Ciegas del torneo: ${blinds.small}/${blinds.big}.`);
  }
}

async function awardLobbyTournamentPrizes(event, payouts) {
  if (!event || event.status !== 'completed' || !Array.isArray(payouts) || event.payoutsAwarded) return false;
  if (lobbyTournamentPayoutsPending.has(event.id)) return lobbyTournamentPayoutsPending.get(event.id);
  const task = (async () => {
    for (const payout of payouts) {
      const profile = profiles.profiles.get(payout.profileId);
      if (!profile || payout.prize <= 0) continue;
      const placeLabel = placementLabel(event, payout) || `${payout.place}.º puesto`;
      profile.lobbyTournamentPayouts = Array.isArray(profile.lobbyTournamentPayouts)
        ? profile.lobbyTournamentPayouts : [];
      if (profile.lobbyTournamentPayouts.includes(event.id)) continue;
      credit(profile, payout.prize, `Premio virtual · ${event.name} · ${placeLabel}`);
      profile.lobbyTournamentPayouts = [...profile.lobbyTournamentPayouts, event.id].slice(-256);
      profiles.touch(profile);
      const entrant = event.registered.find(item => item.profileId === payout.profileId);
      const socket = entrant?.socketId ? io.of('/').sockets.get(entrant.socketId) : null;
      if (socket) socket.emit('profile_event', {
        events: [{
          type: 'lobby_tournament_prize', id: event.id, icon: '🏆',
          name: `Premio de ${event.name}`, place: payout.place, placeLabel, reward: payout.prize
        }],
        profile: publicProgress(profile, true)
      });
    }
    // Primero se confirma el saldo y su clave idempotente en el ProfileStore;
    // solo después se marca el bracket como pagado. Si hay un reinicio entre
    // ambas escrituras, el arranque puede reintentar sin duplicar fichas.
    await profiles.saveNow();
    if (!lobbyTournaments?.markPayoutsAwarded(event.id)) return false;
    await lobbyTournamentStore?.saveNow?.(lobbyTournaments.serialize());
    return true;
  })();
  lobbyTournamentPayoutsPending.set(event.id, task);
  try {
    return await task;
  } catch (error) {
    console.warn(`[TOURNAMENT_PAYOUT_ERROR] torneo=${event.id}:`, error.message);
    logEvent('lobby_tournament_payout_error', { tournament: event.id, message: String(error?.message || error) });
    return false;
  } finally {
    lobbyTournamentPayoutsPending.delete(event.id);
  }
}

function finishLobbyTournamentMatch(room, winnerId, { forfeit = false } = {}) {
  const match = room?.lobbyTournamentMatch;
  if (!match || match.status !== 'playing' || !match.participantIds.includes(String(winnerId))) return null;
  match.status = 'completed';
  match.winnerId = String(winnerId);
  match.winnerName = room.players.find(player => player.id === match.winnerId)?.name || 'Ganador';
  match.forfeit = Boolean(forfeit);
  match.completedAt = Date.now();
  clearTurn(room);
  room.phase = 'showdown';
  for (const timer of Object.values(match.disconnectTimers || {})) {
    clearTimeout(timer);
    room._timers?.delete(timer);
  }
  match.disconnectTimers = Object.create(null);
  for (const player of room.players) {
    if (!player.isBot) restoreProfileChips(player);
  }
  addSystem(room, forfeit
    ? `🏆 ${match.winnerName} gana el encuentro por incomparecencia.`
    : `🏆 ${match.winnerName} gana el encuentro del bracket.`);

  const result = lobbyTournaments?.resolveMatch(match.tournamentId, match.matchId, match.winnerId, { forfeit, now: match.completedAt });
  if (result?.ok && result.code === 'tournament_completed') {
    awardLobbyTournamentPrizes(result.event, result.payouts);
    addSystem(room, `🏆 Terminó ${match.tournamentName}. Los premios virtuales ya fueron abonados a los perfiles.`);
    logEvent('lobby_tournament_completed', { tournament: match.tournamentId, entrants: result.event.capacity, winner: match.winnerId });
  } else if (result?.ok) {
    logEvent('lobby_tournament_match_completed', { tournament: match.tournamentId, match: match.matchId, winner: match.winnerId, forfeit });
  } else {
    console.warn(`[TOURNAMENT] No se pudo resolver ${match.tournamentId}/${match.matchId}: ${result?.error || 'sin gestor'}`);
  }

  for (const player of room.players) {
    if (player.socketId) io.to(player.socketId).emit('lobby_tournament_match_result', {
      tournamentName: match.tournamentName, roundLabel: match.roundLabel,
      winnerName: match.winnerName, isWinner: player.id === match.winnerId, forfeit: match.forfeit
    });
  }
  broadcast(room);
  broadcastLobbyTournaments();
  scheduleRoomTask(room, () => destroyRoom(room.code), 14_000);
  return result;
}

function lobbyTournamentAfterHand(room) {
  const match = room?.lobbyTournamentMatch;
  if (!match || match.status !== 'playing') return;
  if (match.forfeitId) {
    const winnerId = match.participantIds.find(id => id !== match.forfeitId);
    return finishLobbyTournamentMatch(room, winnerId, { forfeit: true });
  }
  const players = room.players.filter(player => match.participantIds.includes(player.id));
  const remaining = players.filter(player => player.chips > 0);
  if (remaining.length === 1) return finishLobbyTournamentMatch(room, remaining[0].id);
  if (!remaining.length) return finishLobbyTournamentMatch(room, match.participantIds[0]);
  match.handsAtLevel++;
  if (match.handsAtLevel >= match.handsPerLevel) {
    match.handsAtLevel = 0;
    match.level++;
    const blinds = tournamentBlinds(match.level);
    addSystem(room, `🏆 Nivel ${match.level} del relámpago: ciegas ${blinds.small}/${blinds.big}.`);
    gameEvent(room, 'round', `Suben las ciegas del encuentro: ${blinds.small}/${blinds.big}.`);
  }
  broadcastLobbyTournaments();
}

function tournamentSocketsAvailable(event) {
  for (const entrant of event.registered) {
    const socket = entrant.socketId ? io.of('/').sockets.get(entrant.socketId) : null;
    if (!socket?.connected) return 'players_offline';
    if (socket.data.roomCode && rooms.has(socket.data.roomCode)) return 'participants_unavailable';
    if (lobbyTournamentProfileIdForSocket(socket) !== entrant.profileId) return 'participants_unavailable';
  }
  return true;
}

function createLobbyTournamentMatch(event, match) {
  if (!lobbyTournaments || match.participantIds.length !== 2) return false;
  const entrants = match.participantIds.map(id => event.registered.find(item => item.profileId === id));
  if (entrants.some(item => !item)) return false;
  const sockets = entrants.map(item => io.of('/').sockets.get(item.socketId));
  if (sockets.some((socket, index) => !socket?.connected || (socket.data.roomCode && rooms.has(socket.data.roomCode)) || lobbyTournamentProfileIdForSocket(socket) !== entrants[index].profileId)) return false;

  const round = event.rounds[event.currentRound];
  const first = newPlayer(entrants[0].profileId, sockets[0], entrants[0].name, entrants[0].avatar);
  const title = `${event.name} · ${round?.label || 'Partida'} ${match.number}`;
  const room = createRoom('poker', first, sockets[0], title);
  room.lobbyTournamentMatch = {
    tournamentId: event.id, tournamentName: event.name, matchId: match.id,
    roundLabel: round?.label || 'Ronda', roundIndex: match.roundIndex,
    matchNumber: match.number, participantIds: [...match.participantIds],
    status: 'playing', level: 1, handsAtLevel: 0,
    handsPerLevel: LOBBY_MATCH_HANDS_PER_LEVEL,
    disconnectTimers: Object.create(null), forfeitId: null,
    winnerId: null, winnerName: null, forfeit: false
  };
  const second = newPlayer(entrants[1].profileId, sockets[1], entrants[1].name, entrants[1].avatar);
  room.players.push(second);
  sockets[1].join(room.code);
  for (let index = 0; index < room.players.length; index++) {
    const player = room.players[index];
    const socket = sockets[index];
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.data.lobbyTournamentProfileId = player.id;
    detachTournamentChips(player, LOBBY_MATCH_STACK);
    const timer = room.lobbyTournamentMatch.disconnectTimers[player.id];
    if (timer) clearTimeout(timer);
  }
  if (!lobbyTournaments.markMatchStarted(event.id, match.id, room.code)) {
    restoreProfileChips(first); restoreProfileChips(second);
    for (const socket of sockets) {
      delete socket.data.roomCode; delete socket.data.playerId;
      socket.leave(room.code);
    }
    destroyRoom(room.code);
    return false;
  }
  addSystem(room, `🏆 ${event.name} · ${round?.label || 'Bracket'}, encuentro ${match.number}. Entrada gratuita, 1.000 fichas virtuales y premios fijos.`);
  const started = startPoker(room);
  if (!started.ok) {
    restoreProfileChips(first); restoreProfileChips(second);
    return finishLobbyTournamentMatch(room, first.id, { forfeit: true });
  }
  broadcast(room);
  broadcastLobbyTournaments();
  return true;
}

function sweepLobbyTournaments() {
  if (!lobbyTournaments) return;
  const statusesBefore = [...lobbyTournaments.events.values()].map(event => `${event.id}:${event.status}:${event.registered.length}`).join('|');
  try {
    const started = lobbyTournaments.startDue(Date.now(), tournamentSocketsAvailable);
    let changed = started.length > 0;
    const statusesAfter = [...lobbyTournaments.events.values()].map(event => `${event.id}:${event.status}:${event.registered.length}`).join('|');
    if (statusesBefore !== statusesAfter) changed = true;
    for (const eventId of started) {
      const event = lobbyTournaments.get(eventId);
      for (const match of lobbyTournaments.pendingMatches(eventId)) createLobbyTournamentMatch(event, match);
    }
    for (const event of lobbyTournaments.events.values()) {
      if (event.status !== 'in_progress') continue;
      for (const match of lobbyTournaments.pendingMatches(event.id)) {
        if (createLobbyTournamentMatch(event, match)) changed = true;
      }
    }
    if (changed) broadcastLobbyTournaments();
  } catch (error) {
    console.error('[TOURNAMENT_SWEEP_ERROR]', error);
    logEvent('lobby_tournament_sweep_error', { message: String(error?.message || error) });
  }
}

function startLobbyTournamentScheduler() {
  if (!lobbyTournaments) return;
  if (lobbyTournamentTimer) clearInterval(lobbyTournamentTimer);
  lobbyTournamentTimer = setInterval(sweepLobbyTournaments, 1000);
  lobbyTournamentTimer.unref?.();
}

function startPoker(room) {
  if (!['waiting', 'showdown'].includes(room.phase)) return actionError('La mano actual todavía no termina.');
  beginRoundRoster(room);
  // Fase 8.1: en torneo juegan solo los participantes vivos y las ciegas dependen del nivel.
  const tourney = room.tournament?.active ? room.tournament : null;
  const lobbyMatch = room.lobbyTournamentMatch?.status === 'playing' ? room.lobbyTournamentMatch : null;
  const blinds = tourney ? tournamentBlinds(tourney.level)
    : lobbyMatch ? tournamentBlinds(lobbyMatch.level)
      : { small: 10, big: 20 };
  const eligible = tourney
    ? tournamentAlive(room).filter(p => p.connected && p.chips > 0)
    : lobbyMatch
      ? room.players.filter(p => lobbyMatch.participantIds.includes(p.id) && p.connected && p.chips > 0)
        : room.players.filter(p => p.connected && p.chips >= 20);
  if (eligible.length < 2) return actionError(tourney ? 'El torneo necesita al menos 2 participantes con fichas.' : 'Se necesitan al menos 2 jugadores con 20 fichas.');
  beginSpecialEvent(room);
  // Mazo fijo opcional para pruebas de showdown; el cliente nunca controla cartas.
  room.deck = process.env.TEST_POKER_DECK
    ? JSON.parse(process.env.TEST_POKER_DECK).slice().reverse()
    : makeDeck(1);
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = blinds.big;
  room.results = [];
  room.handNumber++;
  for (const p of room.players) {
    p.hand = [];
    p.roundBet = 0;
    p.totalBet = 0;
    p.folded = false;
    p.allIn = false;
    p.acted = false;
    p.status = eligible.includes(p) ? 'playing' : 'waiting';
  }
  let nextDealer = room.dealerIndex;
  do { nextDealer = (nextDealer + 1) % room.players.length; }
  while (!eligible.includes(room.players[nextDealer]));
  room.dealerIndex = nextDealer;
  for (let round = 0; round < 2; round++) {
    for (let step = 1; step <= room.players.length; step++) {
      const p = room.players[(room.dealerIndex + step) % room.players.length];
      if (eligible.includes(p)) p.hand.push(draw(room));
    }
  }
  const dealer = room.players[room.dealerIndex];
  const sbIndex = eligible.length === 2
    ? room.dealerIndex
    : nextSeat(room, room.dealerIndex, p => eligible.includes(p));
  const bbIndex = nextSeat(room, sbIndex, p => eligible.includes(p));
  const sb = room.players[sbIndex];
  const bb = room.players[bbIndex];
  room.pot += takeChips(room, sb, blinds.small);
  room.pot += takeChips(room, bb, blinds.big);
  room.currentBet = Math.max(sb.roundBet, bb.roundBet);
  room.phase = 'preflop';
  setNextPokerTurn(room, bb.id);
  addSystem(room, `Mano ${room.handNumber}. ${dealer.name} reparte; ciegas ${blinds.small}/${blinds.big}.${tourney ? ` · 🏆 Torneo nivel ${tourney.level}` : ''}`);
  gameEvent(room, 'round', `Comenzó la mano ${room.handNumber}.`);
  return actionOk();
}
function showdownPoker(room) {
  while (room.community.length < 5) room.community.push(draw(room));
  const live = livePokerPlayers(room);
  const scored = new Map(live.map(p => [p.id, bestPokerScore([...p.hand, ...room.community])]));
  const contributors = handPlayers(room).filter(p => p.totalBet > 0);
  const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a, b) => a - b);
  const awards = new Map();
  const refunds = new Map();
  let previousLevel = 0;

  // Build the main and side pots from each contribution tier. Folded players
  // add chips to a pot, but are never eligible to win it.
  for (const level of levels) {
    const tierContributors = contributors.filter(p => p.totalBet >= level);
    const potAmount = (level - previousLevel) * tierContributors.length;
    previousLevel = level;
    if (!potAmount) continue;
    // Apuesta sin igualar: si en este tramo solo puso fichas UNA persona, nadie
    // lo disputó. Se le devuelve en silencio: no es un bote ganado ni la marca
    // como ganadora (antes esto hacía "ganar" a una mano perdedora su propio dinero).
    if (tierContributors.length === 1) {
      refunds.set(tierContributors[0].id, (refunds.get(tierContributors[0].id) || 0) + potAmount);
      continue;
    }
    const eligible = live.filter(p => p.totalBet >= level);
    if (!eligible.length) continue;
    let best = scored.get(eligible[0].id);
    for (const p of eligible.slice(1)) if (compareScores(scored.get(p.id), best) > 0) best = scored.get(p.id);
    const winners = eligible.filter(p => compareScores(scored.get(p.id), best) === 0);
    const share = Math.floor(potAmount / winners.length);
    let remainder = potAmount - share * winners.length;
    for (const winner of winners) {
      const won = share + (remainder-- > 0 ? 1 : 0);
      awards.set(winner.id, (awards.get(winner.id) || 0) + won);
    }
  }

  // Normally the side-pot total equals room.pot. The fallback keeps every
  // virtual chip accounted for even if a future rule change creates residue.
  const awarded = [...awards.values()].reduce((sum, amount) => sum + amount, 0)
    + [...refunds.values()].reduce((sum, amount) => sum + amount, 0);
  if (awarded < room.pot && live.length) awards.set(live[0].id, (awards.get(live[0].id) || 0) + room.pot - awarded);
  for (const [id, amount] of refunds) {
    const p = handPlayers(room).find(player => player.id === id);
    if (!p || !amount) continue;
    p.chips += amount;
    addSystem(room, `Se devuelven ${amount} fichas sin igualar a ${p.name}.`);
  }
  for (const p of live) {
    const amount = awards.get(p.id) || 0;
    if (amount) { p.chips += amount; p.status = 'winner'; }
  }
  const participants = handPlayers(room);
  const progress = new Map();
  for (const participant of participants) {
    const baseNet = (awards.get(participant.id) || 0) + (refunds.get(participant.id) || 0) - participant.totalBet;
    progress.set(participant.id, completePlayerRound(room, participant, baseNet));
  }
  room.results = [...awards.entries()].map(([id, amount]) => {
    const p = live.find(player => player.id === id);
    const playerProgress = progress.get(id);
    const totalAward = amount + (playerProgress?.specialBonus || 0);
    addRecentWinner(room, p, playerProgress?.net || 0);
    return { id, name: p.name, label: HAND_NAMES[scored.get(id)[0]], amount: totalAward, net: playerProgress?.net || 0 };
  });
  const names = room.results.map(result => result.name);
  addSystem(room, `${names.join(' y ')} ${names.length > 1 ? 'se reparten' : 'gana'} las fichas del bote.`);
  for (const result of room.results) gameEvent(room, 'win', `Resultado neto: ${result.net >= 0 ? '+' : ''}${result.net} con ${result.label}.`, result.id, { amount: result.net });
  for (const player of participants.filter(item => !awards.has(item.id))) gameEvent(room, 'loss', 'Esta vez no ganaste el bote.', player.id);
  room.pot = 0;
  clearTurn(room);
  room.phase = 'showdown';
  tournamentAfterHand(room);
  lobbyTournamentAfterHand(room);
  releaseBotSeats(room);
}

// ---------------- QUICK SOCIAL GAMES ----------------
function resetQuickRound(room, announce = true) {
  // Rueda: la ronda anterior ya está liquidada; antes de abrir apuestas se
  // cierra en el diario (sin apuestas abiertas) y se estrena identificador.
  if (room.game === 'fortune') {
    closeFortuneRoom(room, 'round_closed');
    room.fortuneRoundId = randomUUID();
  }
  room.phase = 'betting';
  room.results = [];
  room.quickResult = null;
  room.specialEvent = room.game === 'fortune' ? null : rollSpecialEvent();
  for (const player of room.players) {
    player.bet = 0;
    player.quickChoice = null;
    player.status = 'waiting';
  }
  if (announce) {
    addSystem(room, `Ronda ${room.handNumber + 1}: apuestas abiertas.`);
    gameEvent(room, 'round', `Apuestas abiertas para la ronda ${room.handNumber + 1}.`);
    if (room.specialEvent) gameEvent(room, 'special', `${room.specialEvent.icon} ${room.specialEvent.label}: ${room.specialEvent.description}.`);
  }
}
// Rueda de la Fortuna: el resultado se confirma en el diario ANTES de mover
// fichas. Todo el movimiento económico (premio, estadísticas, logros) ocurre
// con operaciones idempotentes, así que un reinicio ni paga dos veces ni deja
// apuestas huérfanas.
function resolveFortuneRound(room, result) {
  const roundId = room.fortuneRoundId;
  const bettors = room.players.filter(item => item.bet > 0);
  const rows = bettors.map(player => {
    const payout = Math.floor(player.bet * totalPayoutMultiplier(room.game, player.quickChoice, result));
    return { player, payout, net: payout - player.bet };
  });
  // 1) Resultado y pagos de las personas reales: primero el diario (idempotente).
  let events = [];
  const journaled = Boolean(fortuneLedger && roundId);
  if (journaled) {
    const settled = fortuneLedger.settleRound({
      roundId, roomCode: room.code, result,
      payouts: rows.filter(row => !row.player.isBot).map(row => ({
        profileId: row.player.id, amount: row.payout, net: row.net
      }))
    });
    events = settled.events || [];
  } else {
    // Sin diario no debería existir una mesa de Rueda; si ocurriera, se paga en
    // memoria para no dejar a nadie sin premio y se registra el incidente.
    logEvent('fortune_resolve_without_ledger', { room: room.code, roundId, players: rows.length });
  }
  // 2) Resultados visibles, premios de bots y estado de cada participante.
  room.results = [];
  for (const { player, payout, net } of rows) {
    if (player.isBot) {
      if (payout > 0) player.chips += payout;
      player.bet = 0;
      completePlayerRound(room, player, net);
    } else if (!journaled) {
      if (payout > 0) player.chips += payout;
      player.bet = 0;
    } else {
      // El premio y la progresión ya se aplicaron en el diario; aquí solo se
      // cierra la fila del jugador.
      player.bet = 0;
    }
    const won = net > 0;
    player.status = won ? 'winner' : net < 0 ? 'lost' : 'push';
    room.results.push({
      id: player.id, name: player.name, choice: player.quickChoice,
      choiceLabel: choiceLabel(room.game, player.quickChoice), label: won ? 'Gana' : net < 0 ? 'Pierde' : 'Empate',
      payout, amount: net, specialBonus: 0
    });
    addRecentWinner(room, player, net);
    if (!player.isBot) {
      gameEvent(room, won ? 'win' : net < 0 ? 'loss' : 'push',
        won ? `Ganaste ${net} fichas.` : net < 0 ? `Perdiste ${Math.abs(net)} fichas.` : 'La ronda terminó en empate.',
        player.id, { amount: net });
    }
  }
  for (const item of events) {
    const player = room.players.find(entry => entry.id === item.profileId);
    if (!player) continue;
    emitProgress(room, player, item.events);
  }
  room.phase = 'results';
  addSystem(room, `${resultLabel(room.game, result)}. Ronda resuelta.`);
  gameEvent(room, 'quick_result', `Resultado: ${resultLabel(room.game, result)}.`);
  releaseBotSeats(room);
  broadcast(room);
}

function resolveQuickRound(room) {
  if (!room || !isQuickGame(room.game) || room.phase !== 'rolling') return;
  const result = roll(room.game);
  room.quickResult = result;
  room.results = [];
  if (room.game === 'fortune') {
    resolveFortuneRound(room, result);
    return;
  }
  for (const player of room.players.filter(item => item.bet > 0)) {
    const multiplier = totalPayoutMultiplier(room.game, player.quickChoice, result);
    const payout = Math.floor(player.bet * multiplier);
    if (payout > 0) player.chips += payout;
    const baseNet = payout - player.bet;
    const { net, specialBonus } = completePlayerRound(room, player, baseNet);
    const won = net > 0;
    player.status = won ? 'winner' : net < 0 ? 'lost' : 'push';
    const totalPayout = payout + specialBonus;
    room.results.push({
      id: player.id, name: player.name, choice: player.quickChoice,
      choiceLabel: choiceLabel(room.game, player.quickChoice), label: won ? 'Gana' : net < 0 ? 'Pierde' : 'Empate',
      payout: totalPayout, amount: net, specialBonus
    });
    addRecentWinner(room, player, net);
    gameEvent(room, won ? 'win' : net < 0 ? 'loss' : 'push', won ? `Ganaste ${net} fichas.` : net < 0 ? `Perdiste ${Math.abs(net)} fichas.` : 'La ronda terminó en empate.', player.id, { amount: net });
  }
  room.phase = 'results';
  addSystem(room, `${resultLabel(room.game, result)}. Ronda resuelta.`);
  gameEvent(room, 'quick_result', `Resultado: ${resultLabel(room.game, result)}.`);
  releaseBotSeats(room);
  broadcast(room);
}

// Every human and bot action reaches these authoritative executors. The AI
// proposes decisions, but never mutates cards, chips, turns or outcomes itself.
function executeQuickBet(room, player, { amount, choice } = {}) {
  amount = Math.floor(Number(amount));
  if (!room || !player || !isQuickGame(room.game) || room.phase !== 'betting') return actionError('Las apuestas rápidas no están abiertas.');
  choice = normalizeChoice(room.game, choice);
  if (!choice) return actionError('Elige una opción válida.');
  if (player.bet > 0) return actionError('Ya confirmaste tu apuesta para esta ronda.');
  if (!Number.isSafeInteger(amount) || amount < 10 || amount > player.chips || (room.game === 'fortune' && (!Number.isSafeInteger(player.chips) || amount > Math.floor((Number.MAX_SAFE_INTEGER - player.chips) / 40)))) return actionError('Apuesta entre 10 y tus fichas disponibles, dentro del límite permitido.');
  if (room.game === 'fortune') {
    // La Rueda cobra a través de su diario transaccional (idempotente y con
    // devolución garantizada si el resultado no llega a confirmarse).
    if (!fortuneAvailable()) return actionError('La Rueda no está disponible en este momento.');
    if (!player.isBot) {
      if (!room.fortuneRoundId) room.fortuneRoundId = randomUUID();
      const placed = fortuneLedger.placeBet({
        roundId: room.fortuneRoundId, roomCode: room.code, profileId: player.id,
        name: player.name, amount, choice
      });
      if (!placed.ok) return actionError(placed.error || 'No se pudo confirmar la apuesta.');
      player.bet = amount;
      player.quickChoice = choice;
      player.status = 'ready';
      trackWager(room, player, amount);
      addSystem(room, `${player.name} confirmó una apuesta de ${amount} fichas.`);
      return actionOk();
    }
  }
  player.chips -= amount;
  player.bet = amount;
  player.quickChoice = choice;
  player.status = 'ready';
  trackWager(room, player, amount);
  addSystem(room, `${player.name} confirmó una apuesta de ${amount} fichas.`);
  return actionOk();
}
function executeQuickResolve(room, actor) {
  if (!room || !actor || !isQuickGame(room.game) || actor.id !== room.hostId) return actionError('Solo el anfitrión puede lanzar la ronda.');
  if (room.phase !== 'betting') return actionError('La ronda no está lista.');
  purgeDepartedPlayers(room);
  if (!room.players.some(item => item.bet > 0 && item.connected)) return actionError('Al menos una persona debe apostar.');
  room.handNumber++;
  room.phase = 'rolling';
  addSystem(room, `Ronda ${room.handNumber}: resultado en camino…`);
  gameEvent(room, 'roll', `${QUICK_GAMES[room.game].name}: lanzando resultado.`);
  scheduleRoomTask(room, () => resolveQuickRound(room), 1150);
  return actionOk();
}
function executeQuickNew(room, actor) {
  if (!room || !actor || !isQuickGame(room.game) || actor.id !== room.hostId || room.phase !== 'results') return actionError('No se puede abrir otra ronda todavía.');
  resetQuickRound(room);
  beginRoundRoster(room);
  return actionOk();
}
function executeBlackjackBet(room, player, { amount } = {}) {
  amount = Math.floor(Number(amount));
  if (!room || !player || room.game !== 'blackjack' || room.phase !== 'betting') return actionError('Ahora no se puede apostar.');
  if (player.bet > 0) return actionError('Ya hiciste tu apuesta.');
  if (!Number.isFinite(amount) || amount < 10 || amount > player.chips) return actionError('Apuesta entre 10 y tus fichas disponibles.');
  player.chips -= amount;
  player.bet = amount;
  trackWager(room, player, amount);
  player.status = 'ready';
  return actionOk();
}
function executeBlackjackStart(room, actor) {
  if (!room || !actor || room.game !== 'blackjack' || actor.id !== room.hostId) return actionError('Solo el anfitrión puede repartir.');
  return startBlackjack(room);
}
function executeBlackjackAction(room, player, action) {
  if (!room || !player || room.game !== 'blackjack' || room.phase !== 'playing') return actionError('La ronda de blackjack no está activa.', 'stale');
  if (room.turnId !== player.id) return actionError('Aún no es tu turno.', 'stale');
  // Fase 8.4: con split, las jugadas aplican a la mano activa (principal primero).
  const current = bjActiveHandOf(player);
  if (action === 'hit') {
    current.hand.push(draw(room));
    const value = blackjackScore(current.hand).value;
    if (value > 21) bjSetHandDone(room, player, current.which, 'bust');
    else if (value === 21) bjSetHandDone(room, player, current.which, 'stand');
    else setTurn(room, player.id);
  } else if (action === 'stand') {
    bjSetHandDone(room, player, current.which, 'stand');
  } else if (action === 'double') {
    if (current.hand.length !== 2 || player.chips < current.bet) return actionError('No puedes doblar esta mano.');
    const extraBet = current.bet;
    player.chips -= extraBet;
    if (current.which === 'split') player.split.bet *= 2; else player.bet *= 2;
    trackWager(room, player, extraBet);
    current.hand.push(draw(room));
    bjSetHandDone(room, player, current.which, blackjackScore(current.hand).value > 21 ? 'bust' : 'stand');
  } else if (action === 'split') {
    // Fase 8.4: dividir dos cartas del mismo valor en dos manos independientes.
    if (player.split) return actionError('Solo puedes dividir una vez por ronda.');
    if (player.hand.length !== 2 || bjCardValue(player.hand[0]) !== bjCardValue(player.hand[1])) return actionError('Solo puedes dividir dos cartas del mismo valor.');
    if (player.chips < player.bet) return actionError('Necesitas fichas para igualar tu apuesta en la segunda mano.');
    player.chips -= player.bet;
    trackWager(room, player, player.bet);
    player.split = { bet: player.bet, hand: [player.hand.pop()], active: 'main', mainStatus: 'playing', status: 'playing' };
    player.hand.push(draw(room));
    player.split.hand.push(draw(room));
    addSystem(room, `${player.name} divide su mano en dos apuestas de ${player.bet}.`);
    if (blackjackScore(player.hand).value === 21) bjSetHandDone(room, player, 'main', 'stand');
    else setTurn(room, player.id);
  } else return actionError('Jugada no válida.');
  return actionOk();
}
// Fase 8.4: seguro por la mitad de la apuesta cuando la casa muestra un as (paga 2:1).
function executeBlackjackInsurance(room, player) {
  if (!room || !player || room.game !== 'blackjack' || room.phase !== 'playing') return actionError('El seguro solo se ofrece durante la ronda.');
  const upcard = room.dealerHand?.[0];
  if (!upcard || String(upcard).slice(0, -1) !== 'A') return actionError('El seguro solo se ofrece cuando la casa muestra un as.');
  if (!(player.bet > 0)) return actionError('Necesitas una apuesta activa para asegurar.');
  if (player.insurance > 0) return actionError('Ya tomaste el seguro en esta ronda.');
  if (player.hand.length !== 2 || player.split) return actionError('El seguro solo está disponible antes de tu primera jugada.');
  const cost = Math.ceil(player.bet / 2);
  if (player.chips < cost) return actionError('No tienes fichas suficientes para el seguro.');
  player.chips -= cost;
  player.insurance = cost;
  trackWager(room, player, cost);
  addSystem(room, `${player.name} toma un seguro de ${cost} fichas.`);
  return actionOk();
}
function executeBlackjackNew(room, actor) {
  if (!room || !actor || room.game !== 'blackjack' || actor.id !== room.hostId || room.phase !== 'results') return actionError('No se puede iniciar otra ronda.');
  resetBlackjack(room);
  beginRoundRoster(room);
  return actionOk();
}
function executePokerStart(room, actor) {
  if (!room || !actor || room.game !== 'poker' || actor.id !== room.hostId) return actionError('Solo el anfitrión puede iniciar la mano.');
  if (room.lobbyTournamentMatch && room.lobbyTournamentMatch.status !== 'playing') return actionError('Ese encuentro del bracket ya terminó.');
  return startPoker(room);
}
function executePokerAction(room, player, { action, amount } = {}) {
  if (!room || !player || !isPokerActive(room)) return actionError('La mano de póker no está activa.', 'stale');
  if (room.turnId !== player.id) return actionError('Aún no es tu turno.', 'stale');
  if (player.folded || player.allIn) return actionError('No puedes hacer esa jugada.');
  const toCall = Math.max(0, room.currentBet - player.roundBet);
  if (action === 'fold') {
    player.folded = true; player.acted = true; player.status = 'folded';
  } else if (action === 'check') {
    if (toCall !== 0) return actionError('Debes igualar, subir o retirarte.');
    player.acted = true;
  } else if (action === 'call') {
    if (toCall === 0) return actionError('Puedes pasar.');
    room.pot += takeChips(room, player, toCall);
    player.acted = true;
  } else if (action === 'raise') {
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount < room.minRaise) return actionError(`La subida mínima es ${room.minRaise}.`);
    const target = room.currentBet + amount;
    const payment = target - player.roundBet;
    if (payment > player.chips) return actionError('No tienes fichas suficientes para esa subida.');
    room.pot += takeChips(room, player, payment);
    room.currentBet = target;
    room.minRaise = amount;
    for (const other of handPlayers(room)) if (other.id !== player.id && !other.folded && !other.allIn) other.acted = false;
    player.acted = true;
  } else if (action === 'allin') {
    const oldBet = room.currentBet;
    const paid = takeChips(room, player, player.chips);
    room.pot += paid;
    if (player.roundBet > oldBet) {
      const raiseSize = player.roundBet - oldBet;
      room.currentBet = player.roundBet;
      if (raiseSize >= room.minRaise) {
        room.minRaise = raiseSize;
        for (const other of handPlayers(room)) if (other.id !== player.id && !other.folded && !other.allIn) other.acted = false;
      }
    }
    player.acted = true;
  } else return actionError('Jugada no válida.');
  resolvePokerAfterAction(room, player.id);
  return actionOk();
}
function executeBotPurpose(room, bot, purpose, decision) {
  if (purpose === 'poker-turn') return executePokerAction(room, bot, decision);
  if (purpose === 'blackjack-turn') return executeBlackjackAction(room, bot, decision.action);
  if (purpose === 'blackjack-bet') return executeBlackjackBet(room, bot, decision);
  if (purpose === 'quick-bet') return executeQuickBet(room, bot, decision);
  if (purpose === 'host-poker-start') return executePokerStart(room, bot);
  if (purpose === 'host-blackjack-start') return executeBlackjackStart(room, bot);
  if (purpose === 'host-blackjack-new') return executeBlackjackNew(room, bot);
  if (purpose === 'host-quick-resolve') return executeQuickResolve(room, bot);
  if (purpose === 'host-quick-new') return executeQuickNew(room, bot);
  return actionError('Acción de bot desconocida.');
}
function forceSafeBotAction(room, bot, purpose) {
  if (purpose === 'poker-turn' && room.turnId === bot.id) {
    const action = bot.roundBet === room.currentBet ? 'check' : 'fold';
    return executePokerAction(room, bot, { action });
  }
  if (purpose === 'blackjack-turn' && room.turnId === bot.id) return executeBlackjackAction(room, bot, 'stand');
  return actionError('No se necesitó una acción automática.');
}
function rosterLocked(room) {
  return isPokerActive(room) || room.phase === 'playing' || room.phase === 'rolling';
}
function addBotToRoom(room, options = {}) {
  if (room?.lobbyTournamentMatch) return actionError('Los torneos relámpago del lobby no admiten bots.');
  if (rosterLocked(room)) return actionError('Espera a que termine la ronda para cambiar bots.');
  if (room.players.length >= ROOM_CAPACITY) return actionError(`La mesa está llena (máximo ${ROOM_CAPACITY}).`);
  const bot = createBot(room, options);
  room.players.push(bot);
  addSystem(room, `🤖 ${bot.name} se sentó · ${DIFFICULTIES[bot.difficulty].label} · ${STYLES[bot.style].label}.`);
  gameEvent(room, 'bot_joined', `${bot.name} se unió como bot.`, null, { botId: bot.id });
  return actionOk({ botId: bot.id });
}
function removeBotFromRoom(room, bot) {
  if (!bot?.isBot) return actionError('Bot no encontrado.');
  if (rosterLocked(room)) return actionError('Espera a que termine la ronda para retirar bots.');
  eliminateEntrant(room, bot, true); // Fase 8.1: retirar a un bot participante lo elimina del torneo.
  botController?.cancelBot(room.code, bot.id);
  if ((room.game === 'blackjack' || isQuickGame(room.game)) && room.phase === 'betting' && bot.bet > 0) bot.chips += bot.bet;
  room.players = room.players.filter(player => player.id !== bot.id);
  if (room.hostId === bot.id) nextConnectedHost(room);
  addSystem(room, `🤖 ${bot.name} dejó su asiento.`);
  return actionOk();
}
function scheduleRoomCleanup(room) {
  if (!room || room.players.some(player => player.connected && !player.isBot)) {
    if (room?._cleanupTimer) {
      clearTimeout(room._cleanupTimer);
      room._timers?.delete(room._cleanupTimer);
      room._cleanupTimer = null;
    }
    return;
  }
  if (room._cleanupTimer) return;
  // Personas desconectadas conservan su asiento un periodo de gracia (reconexión);
  // sin ninguna persona real sentada, la mesa se elimina de inmediato (o al TTL legado si AUTO_BOTS está apagado).
  const humanSeated = room.players.some(player => !player.isBot);
  const botsSeated = room.players.some(player => player.isBot && player.connected);
  const delay = humanSeated ? RECONNECT_GRACE_MS : (botsSeated && !AUTO_BOTS ? BOT_ONLY_ROOM_TTL_MS : 0);
  room._cleanupTimer = scheduleRoomTask(room, () => {
    room._cleanupTimer = null;
    const latest = rooms.get(room.code);
    if (latest && !latest.players.some(player => player.connected && !player.isBot)) destroyRoom(room.code);
  }, delay);
}

// ---------------- CICLO DE VIDA DE MESA (fase 2) ----------------
// Completa los asientos libres con bots expertos mientras haya personas reales en la mesa.
function autoFillBots(room) {
  if (!AUTO_BOTS || !room || rosterLocked(room)) return false;
  if (room.tournament?.active || room.lobbyTournamentMatch) return false; // Los brackets del lobby no admiten bots ni asientos externos.
  if (!room.players.some(p => !p.isBot && p.connected)) return false;
  let added = false;
  while (room.players.length < ROOM_CAPACITY) {
    const style = AUTO_BOT_STYLES[Math.floor(Math.random() * AUTO_BOT_STYLES.length)];
    const result = addBotToRoom(room, { difficulty: AUTO_BOT_DIFFICULTY, style });
    if (!result.ok) break;
    added = true;
  }
  return added;
}
// Al terminar la ronda, los bots desocupan sus asientos para que los tomen personas reales.
function releaseBotSeats(room) {
  if (!AUTO_BOTS || !room) return false;
  if (room.tournament?.active) return false; // Fase 8.1: los bots participantes se quedan hasta el final del torneo.
  const bots = room.players.filter(p => p.isBot);
  if (!bots.length) return false;
  for (const bot of bots) botController?.cancelBot(room.code, bot.id);
  room.players = room.players.filter(p => !p.isBot);
  if (bots.some(bot => bot.id === room.hostId)) nextConnectedHost(room);
  addSystem(room, '🤖 Los bots dejaron sus asientos libres para nuevos jugadores.');
  scheduleRoomCleanup(room);
  return true;
}
// Cuando llega una persona real y la mesa está llena de bots, un bot cede el asiento.
function makeSeatForHuman(room) {
  if (!AUTO_BOTS || !room || rosterLocked(room)) return false;
  if (room.tournament?.active) return false; // Fase 8.1: nadie desplaza a un participante del torneo.
  const bot = [...room.players].reverse().find(p => p.isBot);
  if (!bot) return false;
  botController?.cancelBot(room.code, bot.id);
  if ((room.game === 'blackjack' || isQuickGame(room.game)) && room.phase === 'betting' && bot.bet > 0) bot.chips += bot.bet;
  room.players = room.players.filter(p => p.id !== bot.id);
  if (room.hostId === bot.id) nextConnectedHost(room);
  addSystem(room, `🤖 ${bot.name} cedió su asiento a una persona real.`);
  return true;
}
// Retira de la mesa a quienes ya no están presentes de verdad (jugadores "fantasma").
function purgeDepartedPlayers(room) {
  if (!room) return false;
  const departed = room.players.filter(p => !p.isBot && !p.connected);
  if (!departed.length) return false;
  for (const player of departed) {
    if (room.game === 'fortune' && player.bet > 0 && room.phase === 'betting' && fortuneLedger && room.fortuneRoundId) {
      // Rueda: la apuesta vive en el diario; se devuelve allí (idempotente).
      fortuneLedger.refundBet({ roundId: room.fortuneRoundId, profileId: player.id, reason: 'left_before_result' });
      player.bet = 0;
      player.quickChoice = null;
      player.status = 'waiting';
      continue;
    }
    if ((room.game === 'blackjack' || isQuickGame(room.game)) && room.phase === 'betting' && player.bet > 0) {
      player.chips += player.bet;
      player.bet = 0;
    }
    eliminateEntrant(room, player, true); // Fase 8.1: los ausentes salen también del torneo.
    addSystem(room, `${player.name} dejó su asiento libre.`);
  }
  room.players = room.players.filter(p => p.isBot || p.connected);
  if (departed.some(p => p.id === room.hostId)) nextConnectedHost(room);
  scheduleRoomCleanup(room);
  return true;
}
// Antes de arrancar cualquier ronda: valida presencia real, valida al anfitrión y completa la mesa.
function beginRoundRoster(room) {
  purgeDepartedPlayers(room);
  const host = room.players.find(p => p.id === room.hostId);
  if (!host || !host.connected || (host.isBot && room.players.some(p => !p.isBot && p.connected))) nextConnectedHost(room);
  autoFillBots(room);
}

function removeOrDisconnectPlayer(room, player, leave = false) { 
  const lobbyMatch = room.lobbyTournamentMatch;
  if (leave && lobbyMatch?.status === 'playing') lobbyMatch.forfeitId = player.id;
  player.connected = false;
  if (room.game === 'fortune' && room.phase === 'betting' && player.bet > 0) {
    // Rueda: devolución desde el diario (idempotente; si ya se liquidó, no toca nada).
    if (!player.isBot && fortuneLedger && room.fortuneRoundId) {
      fortuneLedger.refundBet({ roundId: room.fortuneRoundId, profileId: player.id, reason: leave ? 'left_before_result' : 'disconnected_before_result' });
    }
    player.bet = 0;
    player.quickChoice = null;
    player.status = 'waiting';
  } else if ((room.game === 'blackjack' || isQuickGame(room.game)) && room.phase === 'betting' && player.bet > 0) {
    player.chips += player.bet;
    player.bet = 0;
    player.quickChoice = null;
    player.status = 'waiting';
  }
  if (isPokerActive(room) && player.hand.length && !player.folded && !player.allIn) {
    player.folded = true;
    player.status = 'folded';
    resolvePokerAfterAction(room, player.id);
  }
  if (room.game === 'blackjack' && room.phase === 'playing' && room.turnId === player.id) {
    player.status = 'stand';
    nextBlackjackTurn(room, player.id);
  }
  // Fase 8.1: quien abandona la mesa durante un torneo queda eliminado de él.
  if (leave) eliminateEntrant(room, player, true);
  if (leave && lobbyMatch?.status === 'playing') {
    const winnerId = lobbyMatch.participantIds.find(id => id !== player.id);
    finishLobbyTournamentMatch(room, winnerId, { forfeit: true });
  } else if (!leave && lobbyMatch?.status === 'playing') {
    const timer = scheduleRoomTask(room, () => {
      if (!player.connected && lobbyMatch.status === 'playing') {
        lobbyMatch.forfeitId = player.id;
        const winnerId = lobbyMatch.participantIds.find(id => id !== player.id);
        finishLobbyTournamentMatch(room, winnerId, { forfeit: true });
      }
    }, RECONNECT_GRACE_MS);
    if (timer) lobbyMatch.disconnectTimers[player.id] = timer;
    if (lobbyTournaments?.markOffline(player.id, player.socketId)) broadcastLobbyTournaments();
  }
  if (leave && !isPokerActive(room) && room.phase !== 'playing' && room.phase !== 'rolling') {
    room.players = room.players.filter(p => p.id !== player.id);
  }
  if (room.hostId === player.id) nextConnectedHost(room);
  addSystem(room, `${player.name} salió de la mesa.`);
  gameEvent(room, 'left', `${player.name} abandonó la sala.`);
  scheduleRoomCleanup(room);
}

botController = new BotController({
  roomExists: code => rooms.has(code),
  getRoom: code => rooms.get(code),
  getView: (room, botId) => publicRoom(room, botId),
  publish: room => publishRoom(room, false),
  broadcast,
  execute: executeBotPurpose,
  forceSafeAction: forceSafeBotAction,
  announce: (room, bot, label, meta) => gameEvent(room, 'bot_action', `🤖 ${bot.name}: ${label}.`, null, { botId: bot.id, fallback: Boolean(meta?.fallback) }),
  logError: ({ roomCode, botId, botName, game, purpose, error }) => console.warn(`[BOT_FALLBACK] room=${roomCode} bot=${botId} name=${botName} game=${game} task=${purpose}: ${error.message}`)
});

// ---------------- LOTERÍA MEXICANA (transporte) ----------------
// Identidad de la lotería: la misma regla que en las mesas. Con sesión de
// cuenta verificada por cookie se usa el perfil de la cuenta; sin ella, el
// perfil del dispositivo. Nunca se acepta un id enviado por el navegador.
function loteriaTokenForSocket(socket) {
  return String(socket.handshake?.auth?.deviceToken || '').trim().slice(0, 80);
}
function loteriaProfileIdForSocket(socket) {
  const token = loteriaTokenForSocket(socket);
  if (!token && !socket.data.accountProfileId) return null;
  return seatIdFor(socket, token) || null;
}
function loteriaSnapshotView(profileId = null) {
  if (!loteria || !loteriaEnabled) {
    return { enabled: false, serverNow: Date.now(), game: null };
  }
  return loteria.snapshotFor(profileId);
}
function broadcastLoteriaState() {
  if (!loteria || !loteriaEnabled) return;
  try {
    io.emit('loteria_state', loteria.snapshotFor(null));
    for (const client of io.sockets.sockets.values()) {
      const profileId = client.data?.loteriaProfileId;
      if (!profileId) continue;
      const you = loteria.youFor(profileId);
      if (you) client.emit('loteria_you', you);
    }
  } catch (error) {
    console.warn('No se pudo difundir el estado de la Lotería:', error.message);
  }
}
// Logros, retos y cosméticos ganados con la Lotería llegan tanto a la pestaña
// de la lotería como al lobby abierto en otra pestaña del mismo perfil.
function emitLoteriaProgress(profileId, events = []) {
  if (!events.length) return;
  const profile = profiles?.getProfile(profileId);
  if (!profile) return;
  const payload = { events, profile: publicProgress(profile, true) };
  for (const client of io.sockets.sockets.values()) {
    const sameAccount = client.data?.accountProfileId === profileId;
    const sameDevice = loteriaTokenForSocket(client) === profileId;
    const sameLoteria = client.data?.loteriaProfileId === profileId;
    if (sameAccount || sameDevice || sameLoteria) client.emit('profile_event', payload);
  }
}
function loteriaSocketsFor(profileId) {
  let total = 0;
  for (const client of io.sockets.sockets.values()) {
    if (client.data?.loteriaProfileId === profileId) total++;
  }
  return total;
}

// Fase 1: una cookie válida vincula la conexión con una cuenta autenticada.
// Una cookie ausente o vencida no bloquea el modo invitado; simplemente no
// concede identidad de cuenta. Ningún id enviado en payload sustituye esto.
io.use(async (socket, next) => {
  try {
    socket.data.accountProfileId = null;
    if (!adminConfig.accountSessionsEnabled || !accountSessionStore) return next();
    const token = parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME];
    if (!token) return next();
    const session = await accountSessionStore.findByToken(token);
    const profile = session && profiles.profiles.get(session.profileId);
    const state = profile && sessionState(session, { sessionVersion: profile.security?.sessionVersion || 1 });
    if (!profile?.username || !state?.valid) return next();
    socket.data.accountProfileId = profile.id;
    socket.data.accountSessionId = session.id;
    socket.data.accountRole = profile.role || 'user';
    socket.join(`account:${profile.id}`);
    await accountSessionStore.touch(session.id, { role: profile.role || 'user' });
    return next();
  } catch (error) {
    console.warn('No se pudo resolver la sesión del socket:', error.message);
    return next(); // fail-closed para cuenta; el juego invitado sigue disponible
  }
});

io.on('connection', socket => {
  // Red de seguridad: un error dentro de CUALQUIER handler de eventos no debe
  // tumbar el proceso completo. Las salas viven en memoria, así que una sola
  // excepción no capturada (ya pasó con un ReferenceError en join_room al
  // referenciar una variable inexistente) borraba todas las mesas en curso y
  // desconectaba a todo el casino. Con esta envoltura, el handler que falla
  // queda registrado en el log y su cliente recibe un ack de error claro en
  // vez de una espera eterna; el resto de la partida sigue funcionando.
  const onRaw = socket.on.bind(socket);
  const reportHandlerError = (event, error, ack) => {
    console.warn(`[HANDLER_ERROR] evento=${event}:`, error);
    if (typeof ack === 'function') ackError(ack, 'Ocurrió un error inesperado. Intenta de nuevo.');
  };
  socket.on = (event, handler) => onRaw(event, function (...args) {
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      const result = handler.apply(this, args);
      if (result && typeof result.catch === 'function') result.catch(error => reportHandlerError(event, error, ack));
      return result;
    } catch (error) {
      reportHandlerError(event, error, ack);
      return undefined;
    }
  });

  socket.on('bet_ranking_get', (_payload = {}, ack) => {
    socket.data.betRankingSubscribed = true;
    emitBetRanking(socket);
    ackOk(ack);
  });
  socket.on('bet_ranking_unsubscribe', (_payload = {}, ack) => {
    socket.data.betRankingSubscribed = false;
    ackOk(ack);
  });

  // ---- Lotería mexicana ----
  // Una sola ronda para todo el casino: el servidor es la autoridad del canto,
  // del cartón de cada quien y del reparto. El cliente solo dibuja.
  socket.on('loteria_subscribe', (_payload = {}, ack) => {
    if (!loteriaEnabled || !loteria) return ackError(ack, 'La Lotería todavía no está disponible.');
    const profileId = loteriaProfileIdForSocket(socket);
    const profile = profileId ? profiles.getProfile(profileId) : null;
    if (profile) socket.data.loteriaProfileId = profile.id;
    ackOk(ack, {
      cards: LOTERIA_CARDS,
      tosVersion: TOS_VERSION,
      state: loteriaSnapshotView(profile ? profile.id : null),
      you: profile ? loteria.youFor(profile.id) : null
    });
  });

  socket.on('loteria_join', async (payload = {}, ack) => {
    if (!loteriaEnabled || !loteria) return ackError(ack, 'La Lotería todavía no está disponible.');
    const token = loteriaTokenForSocket(socket);
    const seatId = loteriaProfileIdForSocket(socket);
    let profile = seatId ? profiles.getProfile(seatId) : null;
    if (!profile) {
      const name = cleanName(payload.name);
      if (!token) return ackError(ack, 'No pudimos identificar este dispositivo. Recarga la página.');
      if (!name) return ackError(ack, 'Escribe tu nombre para jugar.');
      if (String(payload.tos || '') !== TOS_VERSION) return ackError(ack, TOS_REQUIRED_MESSAGE);
      const issue = nameIssue(name, { exceptId: token });
      if (issue) return ackError(ack, issue);
      profile = profiles.getOrCreate(token, name, payload.avatar);
    }
    if (!verifyTosAcceptance(profile, payload.tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
    socket.data.loteriaProfileId = profile.id;
    const result = await loteria.join(profile.id, { name: profile.name, avatar: profile.avatar });
    if (!result.ok) {
      broadcastLoteriaState();
      return ackResult(ack, actionError(result.error, result.code));
    }
    ackOk(ack, { board: result.board, state: result.state, you: loteria.youFor(profile.id) });
    broadcastLoteriaState();
    logEvent('loteria_joined', {
      profileId: profile.id, gameId: result.state?.game?.id || null,
      players: result.state?.game?.count || 0
    });
  });

  socket.on('loteria_leave', async (_payload = {}, ack) => {
    if (!loteriaEnabled || !loteria) return ackError(ack, 'La Lotería todavía no está disponible.');
    const profileId = socket.data.loteriaProfileId || loteriaProfileIdForSocket(socket);
    const profile = profileId ? profiles.getProfile(profileId) : null;
    if (!profile) return ackError(ack, 'No encontramos tu perfil.');
    const result = await loteria.leave(profile.id);
    if (!result.ok) return ackResult(ack, actionError(result.error, result.code));
    ackOk(ack, { refunded: Boolean(result.refunded), state: result.state, you: loteria.youFor(profile.id) });
    broadcastLoteriaState();
  });

  // Regla acordada: quien se va antes del cierre recupera su entrada. Cuando la
  // ronda ya empezó, el cartón sigue participando y conserva su premio; el
  // servicio rechaza el reembolso y aquí solo se ignora. Si el mismo perfil
  // tiene otra pestaña abierta en la lotería, no se cancela nada.
  socket.on('disconnect', () => {
    const profileId = socket.data.loteriaProfileId;
    if (!profileId || !loteria || !loteriaEnabled) return;
    // Gracia breve: al recargar la página el socket nuevo vuelve a suscribirse
    // con el mismo perfil y no debe perder su cartón. Solo se cancela si de
    // verdad no queda ninguna pestaña de la Lotería para esa persona.
    const grace = setTimeout(() => {
      if (loteriaSocketsFor(profileId) > 0) return;
      loteria.leave(profileId)
        .then(result => { if (result.ok) broadcastLoteriaState(); })
        .catch(error => console.warn('No se pudo cancelar la entrada de la Lotería al desconectarse:', error.message));
    }, 2000);
    grace.unref?.();
  });

  // El callback de conexión en sí tampoco está cubierto por la envoltura de
  // socket.on (que protege lo que se registra después): si armar el snapshot
  // fallara, la excepción subiría a uncaughtException. Mismo tratamiento.
  try {
    // El socket ya pertenece al namespace en este punto. Se publica a TODOS:
    // quien acaba de entrar recibe su snapshot y quienes ya estaban conectados
    // ven subir el contador inmediatamente, aun cuando nadie esté en una mesa.
    broadcastLobby();
  } catch (error) {
    console.error('[HANDLER_ERROR] evento=connection (snapshot inicial):', error);
  }
  const initialTournamentProfileId = lobbyTournamentProfileIdForSocket(socket);
  if (initialTournamentProfileId && lobbyTournaments?.restoreSocket(initialTournamentProfileId, socket.id)) broadcastLobbyTournaments();

  socket.on('lobby_tournaments_get', (payload = {}, ack) => {
    if (!lobbyTournaments) return ackError(ack, 'El calendario de torneos todavía no está listo.');
    const profileId = lobbyTournamentProfileIdForSocket(socket, payload.accountId);
    if (profileId && profiles.profiles.has(profileId)) socket.data.lobbyTournamentProfileId = profileId;
    const snapshot = lobbyTournaments.snapshotFor(profileId);
    socket.emit('lobby_tournaments_state', snapshot);
    ackOk(ack, { snapshot });
  });

  socket.on('lobby_tournament_register', (payload = {}, ack) => {
    if (!lobbyTournaments) return ackError(ack, 'El calendario de torneos todavía no está listo.');
    if (socket.data.roomCode && rooms.has(socket.data.roomCode)) return ackError(ack, 'Vuelve al lobby antes de inscribirte.');
    let profileId = lobbyTournamentProfileIdForSocket(socket, payload.accountId);
    let profile = profileId ? profiles.profiles.get(profileId) : null;
    if (!profile) {
      const token = String(socket.handshake?.auth?.deviceToken || '').trim().slice(0, 80);
      const name = cleanName(payload.name);
      if (!token || !name) return ackError(ack, 'No pudimos confirmar tu identidad. Escribe tu nombre en el lobby y vuelve a intentarlo.');
      if (String(payload.tos || '') !== TOS_VERSION) return ackError(ack, TOS_REQUIRED_MESSAGE);
      const issue = nameIssue(name, { exceptId: token });
      if (issue) return ackError(ack, issue);
      profile = profiles.getOrCreate(token, name, payload.avatar);
      profileId = profile.id;
    }
    if (!verifyTosAcceptance(profile, payload.tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
    const result = lobbyTournaments.register(payload.tournamentId, {
      profileId: profile.id, name: profile.name, avatar: profile.avatar, socketId: socket.id
    });
    if (!result.ok) return ackResult(ack, result);
    socket.data.lobbyTournamentProfileId = profile.id;
    profiles.touch(profile);
    const snapshot = lobbyTournaments.snapshotFor(profile.id);
    ackOk(ack, { code: result.code, snapshot });
    broadcastLobbyTournaments();
  });

  socket.on('lobby_tournament_withdraw', (payload = {}, ack) => {
    if (!lobbyTournaments) return ackError(ack, 'El calendario de torneos todavía no está listo.');
    const profileId = lobbyTournamentProfileIdForSocket(socket, payload.accountId);
    const profile = profileId ? profiles.profiles.get(profileId) : null;
    if (!profile) return ackError(ack, 'No pudimos encontrar tu perfil.');
    const result = lobbyTournaments.withdraw(payload.tournamentId, profile.id);
    if (!result.ok) return ackResult(ack, result);
    socket.data.lobbyTournamentProfileId = profile.id;
    const snapshot = lobbyTournaments.snapshotFor(profile.id);
    ackOk(ack, { code: result.code, snapshot });
    broadcastLobbyTournaments();
  });

  socket.on('create_room', ({ name, roomName, game, token, avatar, tos } = {}, ack) => {
    name = cleanName(name);
    game = ['poker', 'blackjack', ...Object.keys(QUICK_GAMES)].includes(game) ? game : 'poker';
    if (game === 'fortune' && !fortuneAvailable()) return ackError(ack, 'La Rueda no está disponible en este momento.');
    if (!name) return ackError(ack, 'Escribe tu nombre.');
    if (!token) return ackError(ack, 'No se pudo identificar este dispositivo.');
    const seatId = seatIdFor(socket, token);
    // Unicidad global del nombre (excepto el perfil propio con el que se sienta).
    const createIssue = nameIssue(name, { exceptId: seatId });
    if (createIssue) return ackError(ack, createIssue);
    const player = newPlayer(seatId, socket, name, avatar);
    if (!verifyTosAcceptance(player._profile, tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
    syncSocketLobbyIdentity(socket, player._profile);
    const room = createRoom(game, player, socket, roomName);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    autoFillBots(room);
    ackOk(ack, { code: room.code });
    logEvent('room_created', { room: room.code, game: room.game, host: player.name });
    gameEvent(room, 'joined', `${player.name} creó ${room.name}.`);
    broadcast(room);
  });

  socket.on('join_room', ({ name, code, token, avatar, tos, accountId } = {}, ack) => {
    name = cleanName(name);
    if (!token) return ackError(ack, 'No se pudo identificar este dispositivo.');
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const room = rooms.get(code);
    if (!room) return ackError(ack, 'Esa sala no existe o ya cerró.');
    const seatId = seatIdFor(socket, token);
    let player = room.players.find(p => !p.isBot && p.id === seatId);
    const tournamentAccountId = socket.data.accountProfileId
      || (!adminConfig.accountSessionsEnabled ? String(accountId || '').slice(0, 80) : null);
    if (!player && room.lobbyTournamentMatch && tournamentAccountId) {
      player = room.players.find(p => !p.isBot && p.id === tournamentAccountId);
    }
    if (player) {
      if (!verifyTosAcceptance(player._profile, tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
      // Reingreso: el nombre se valida solo si trae uno nuevo (sin nombre
      // conserva el que ya tenía). Nunca puede robarle el nombre a otra
      // persona: ni en esta mesa ni en todo el casino.
      if (name) {
        const rejoinIssue = nameIssue(name, { room, exceptId: player.id });
        if (rejoinIssue) return ackError(ack, rejoinIssue);
      }
      player.socketId = socket.id;
      player.connected = true;
      player.lastActiveAt = Date.now();
      // OJO: aquí solo se actualizan nombre/avatar. Este evento nunca recibe
      // featuredAchievements; referenciarla igual era un ReferenceError que
      // tumbaba TODO el proceso (sin handler de uncaughtException) cada vez
      // que un jugador ya sentado volvía a entrar con su mismo token
      // (recarga de página o reconexión automática), borrando de memoria
      // todas las mesas y dejando a todos con "Perfil no disponible.".
      profiles.update(player._profile, { name, avatar });
      player.name = player._profile.name;
      player.avatar = player._profile.avatar;
      if (room.lobbyTournamentMatch) {
        socket.data.lobbyTournamentProfileId = player.id;
        const timer = room.lobbyTournamentMatch.disconnectTimers?.[player.id];
        if (timer) { clearTimeout(timer); room._timers?.delete(timer); delete room.lobbyTournamentMatch.disconnectTimers[player.id]; }
        lobbyTournaments?.restoreSocket(player.id, socket.id);
      }
      addSystem(room, `${player.name} volvió a la mesa.`);
    } else {
      if (room.lobbyTournamentMatch) return ackError(ack, 'Ese encuentro del bracket está reservado para las dos personas inscritas.');
      if (!name) return ackError(ack, 'Escribe tu nombre.');
      // exceptId = su propio token: quien viene de la tribuna a tomar asiento
      // conserva su nombre sin chocar con su propia entrada de espectadora,
      // y el nombre debe estar libre en el casino entero, no solo en la mesa.
      const seatIssue = nameIssue(name, { room, exceptId: seatId });
      if (seatIssue) return ackError(ack, seatIssue);
      player = newPlayer(seatId, socket, name, avatar);
      if (!verifyTosAcceptance(player._profile, tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
      // Si la mesa está llena pero hay bots, un bot cede su asiento a la persona real.
      if (room.players.length >= ROOM_CAPACITY) makeSeatForHuman(room);
      if (room.players.length >= ROOM_CAPACITY) return ackError(ack, `La mesa está llena (máximo ${ROOM_CAPACITY}).`);
      room.players.push(player);
      addSystem(room, `${player.name} se sentó en la mesa.`);
    }
    syncSocketLobbyIdentity(socket, player._profile);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    // Si estaba en la tribuna, deja de ser espectador al sentarse.
    if (room.spectators?.some(s => s.id === player.id)) {
      room.spectators = room.spectators.filter(s => s.id !== player.id);
      addSystem(room, `👁 ${player.name} pasó de la tribuna a la mesa.`);
    }
    delete socket.data.spectatorId;
    if (!room.hostId || room.players.find(item => item.id === room.hostId)?.isBot) room.hostId = player.id;
    scheduleRoomCleanup(room);
    autoFillBots(room);
    ackOk(ack, { code, game: room.game });
    logEvent('player_joined', { room: code, game: room.game, player: player.name });
    gameEvent(room, 'joined', `${player.name} se unió a la sala.`);
    broadcast(room);
  });

  // Fase 8: modo espectador. Cualquiera puede ver una mesa (incluso llena) sin ocupar asiento.
  // Recibe el mismo estado que un jugador sin identidad en la mesa: todas las manos viajan boca abajo.
  socket.on('spectate_room', ({ name, code, token, avatar, tos } = {}, ack) => {
    name = cleanName(name);
    if (!token) return ackError(ack, 'No se pudo identificar este dispositivo.');
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const room = rooms.get(code);
    if (!room) return ackError(ack, 'Esa sala no existe o ya cerró.');
    const id = seatIdFor(socket, token);
    if (room.players.some(p => !p.isBot && p.id === id)) return ackError(ack, 'Ya tienes asiento en esta mesa: entra como jugador.');
    if (!name) return ackError(ack, 'Escribe tu nombre.');
    // La tribuna comparte el chat y los avisos de la mesa: el apodo tampoco
    // puede duplicar el de nadie en esta mesa (jugadores u otros espectadores)
    // ni el de ningún otro perfil del casino.
    const spectateNameIssue = nameIssue(name, { room, exceptId: id });
    if (spectateNameIssue) return ackError(ack, spectateNameIssue);
    const profile = profiles.getOrCreate(id, name, avatar);
    if (!verifyTosAcceptance(profile, tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
    syncSocketLobbyIdentity(socket, profile);
    room.spectators = room.spectators || [];
    const existing = room.spectators.find(s => s.id === id);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      existing.name = profile.name;
      existing.avatar = profile.avatar;
    } else {
      if (room.spectators.filter(s => s.connected).length >= 12) return ackError(ack, 'La tribuna de esta mesa está llena.');
      room.spectators.push({ id, name: profile.name, avatar: profile.avatar, socketId: socket.id, connected: true, joinedAt: Date.now(), _profile: profile });
      addSystem(room, `👁 ${profile.name} está viendo la mesa.`);
    }
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.spectatorId = id;
    delete socket.data.playerId;
    ackOk(ack, { code, game: room.game });
    logEvent('spectator_joined', { room: code, game: room.game, spectator: profile.name });
    broadcast(room);
  });

  // Fase 9 (QA): límite de frecuencia para mensajes y reacciones — máximo 6 cada 4 s
  // por conexión, para que nadie pueda inundar la sala con broadcasts.
  function tooChatty(channel = 'table') {
    const now = Date.now();
    socket.data.chatTimes = socket.data.chatTimes || {};
    socket.data.chatTimes[channel] = (socket.data.chatTimes[channel] || []).filter(time => now - time < 4000);
    if (socket.data.chatTimes[channel].length >= 6) return true;
    socket.data.chatTimes[channel].push(now);
    return false;
  }

  socket.on('chat', ({ text } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    if (tooChatty('table')) return ackError(ack, 'Vas muy rápido: espera un momento para volver a escribir.');
    text = cleanMessage(text);
    // Fase 8: los espectadores también chatean (se distinguen con el prefijo 👁).
    const spectator = !player && room ? room.spectators?.find(s => s.id === socket.data.spectatorId && s.connected) : null;
    if (!room || (!player && !spectator) || !text) return ackError(ack, 'No se pudo enviar.');
    if (duplicateMessageWithinWindow(socket, 'table', text)) return ackError(ack, 'Ese mensaje ya fue enviado hace un momento.');
    const author = player || spectator;
    room.messages.push({ id: `${Date.now()}-${Math.random()}`, playerId: author.id, username: author._profile?.username || null, name: spectator ? `👁 ${author.name}` : author.name, text, time: Date.now(), ...(spectator ? {} : chatRoleField(author.id)) });
    room.messages = room.messages.slice(-40);
    ackOk(ack);
    broadcast(room);
  });

  // Chat único del casino. Solo recibe mensajes quien se identificó explícitamente
  // con el token de dispositivo y aceptó los mismos Términos vigentes que las mesas.
  socket.on('lobby_chat_join', ({ token, name, tos } = {}, ack) => {
    const id = String(token || '').slice(0, 80);
    name = cleanName(name);
    if (!id) return ackError(ack, 'No se pudo identificar este dispositivo.');
    if (!name) return ackError(ack, 'Elige un apodo para entrar al chat del casino.');
    // El apodo del chat es la identidad de quien habla: ni ofensivo ni igual
    // al de otra persona del casino (la unicidad global cubre a todas las
    // personas conectadas al chat: todas tienen perfil). Renombrar el perfil
    // también se valida contra la mesa donde esté sentado, si hay una.
    if (sameDisplayName(name, MONTE_ASSISTANT_NAME)) {
      return ackError(ack, 'Ese apodo está reservado para el asistente BOT del servidor.');
    }
    const chatProfile = profiles.profiles.get(id);
    const lobbyIssue = nameIssue(name, { room: roomOfProfile(chatProfile), exceptId: id });
    if (lobbyIssue) return ackError(ack, lobbyIssue);
    const profile = profiles.getOrCreate(id, name);
    if (!verifyTosAcceptance(profile, tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
    profiles.update(profile, { name });
    socket.data.lobbyChat = { id: profile.id, name: profile.name, avatar: profile.avatar, username: profile.username || null };
    const history = lobbyChatMessages.slice();
    ackOk(ack, { name: profile.name, avatar: profile.avatar, messages: history, history });
    socket.emit('lobby_chat', { messages: history });
  });

  socket.on('lobby_chat', ({ text } = {}, ack) => {
    const author = socket.data.lobbyChat;
    if (!author) return ackError(ack, 'Primero elige un apodo y acepta los Términos para entrar al chat.');
    if (tooChatty('lobby')) return ackError(ack, 'Vas muy rápido: espera un momento para volver a escribir.');
    text = cleanMessage(text);
    if (!text) return ackError(ack, 'No se pudo enviar.');
    if (duplicateMessageWithinWindow(socket, 'lobby', text)) return ackError(ack, 'Ese mensaje ya fue enviado hace un momento.');
    const message = { id: `${Date.now()}-${Math.random()}`, playerId: author.id, username: author.username, name: author.name, avatar: author.avatar, text, time: Date.now(), ...chatRoleField(author.id) };
    lobbyChatMessages.push(message);
    while (lobbyChatMessages.length > LOBBY_CHAT_LIMIT) lobbyChatMessages.shift();
    for (const client of io.sockets.sockets.values()) {
      if (client.data.lobbyChat) client.emit('lobby_chat_message', message);
    }

    // Monte es una FAQ determinista: solo recibe el texto invocado, nunca el
    // estado de una mesa, cartas, perfil ni historial privado. La pausa se aplica
    // por perfil para evitar que varias conexiones conviertan una mención en spam.
    const assistantReply = getLobbyAssistantReply(text);
    if (assistantReply && canReplyToLobbyAssistant(author.id)) {
      const assistantTime = Date.now();
      const assistantMessage = {
        id: `monte:${assistantTime}:${Math.random().toString(36).slice(2, 8)}`,
        playerId: null,
        username: null,
        name: MONTE_ASSISTANT_NAME,
        avatar: MONTE_ASSISTANT_AVATAR,
        text: assistantReply,
        time: assistantTime,
        system: true,
        bot: true
      };
      lobbyChatMessages.push(assistantMessage);
      while (lobbyChatMessages.length > LOBBY_CHAT_LIMIT) lobbyChatMessages.shift();
      for (const client of io.sockets.sockets.values()) {
        if (client.data.lobbyChat) client.emit('lobby_chat_message', assistantMessage);
      }
    }
    ackOk(ack, { message });
  });

  socket.on('reaction', ({ emoji } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    const allowed = ['🔥', '👏', '😂', '🍀', '😱', '💎'];
    if (!room || !player || !allowed.includes(emoji)) return ackError(ack, 'Reacción no válida.');
    if (tooChatty('table')) return ackError(ack, 'Vas muy rápido: espera un momento.');
    io.to(room.code).emit('reaction', { playerId: player.id, name: player.name, avatar: player.avatar, emoji, time: Date.now() });
    ackOk(ack);
  });

  socket.on('quick_chat', ({ message } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    const allowed = ['¡Bien jugado!', '¡Voy con todo!', 'La suerte está de mi lado', 'Otra ronda', 'Esto se pone bueno'];
    if (!room || !player || !allowed.includes(message)) return ackError(ack, 'Mensaje rápido no válido.');
    if (tooChatty('table')) return ackError(ack, 'Vas muy rápido: espera un momento.');
    message = cleanMessage(message);
    if (duplicateMessageWithinWindow(socket, 'table', message)) return ackError(ack, 'Ese mensaje ya fue enviado hace un momento.');
    room.messages.push({ id: `${Date.now()}-${Math.random()}`, playerId: player.id, name: player.name, text: message, quick: true, time: Date.now() });
    room.messages = room.messages.slice(-40);
    ackOk(ack);
    broadcast(room);
  });

  // Edita nombre/avatar/logros destacados del perfil. Funciona en dos contextos:
  //  - Sentado en una mesa: edita el perfil del jugador de esa mesa (como siempre).
  //  - Desde el lobby, sin mesa: solo si el socket manda `accountId` (el id del
  //    perfil vinculado a la cuenta con la que se inició sesión) Y ese perfil
  //    tiene una cuenta real (username) vinculada — así no se puede editar un
  //    perfil anónimo ajeno adivinando su id de dispositivo. Sin uno de los dos
  //    contextos, no hay perfil que editar.
  socket.on('profile_update', ({ name, avatar, featuredAchievements, accountId } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    let targetProfile = player ? player._profile : null;
    if (!targetProfile) {
      // Con sesiones seguras el único perfil de cuenta editable es el que el
      // middleware autenticó desde la cookie. `accountId` se ignora.
      const id = adminConfig.accountSessionsEnabled
        ? socket.data.accountProfileId
        : String(accountId || '').slice(0, 80); // compatibilidad temporal con rollout apagado
      const candidate = id ? profiles.profiles.get(id) : null;
      if (candidate?.username) targetProfile = candidate;
    }
    if (!targetProfile) return ackError(ack, 'Perfil no disponible.');
    name = cleanName(name) || targetProfile.name;
    // El nombre elegido se valida siempre: sin palabras ofensivas, libre en
    // el casino entero y, si el perfil está sentado en una mesa (desde esta
    // conexión o desde otra), sin duplicar el nombre de nadie en ESA mesa
    // (por ejemplo, un bot sentado en ella).
    const targetRoom = room && player ? room : roomOfProfile(targetProfile);
    const renameIssue = nameIssue(name, { room: targetRoom, exceptId: targetProfile.id });
    if (renameIssue) return ackError(ack, renameIssue);
    // Fase de auditoría de cuentas: featuredAchievements se aceptaba en el payload
    // pero nunca se pasaba a profiles.update(), así que la vitrina de logros no
    // se guardaba de verdad. Se corrige aquí.
    profiles.update(targetProfile, { name, avatar, featuredAchievements });
    syncSocketLobbyIdentity(socket, targetProfile);
    if (player) {
      player.name = player._profile.name;
      player.avatar = player._profile.avatar;
    }
    ackOk(ack, { profile: publicProgress(targetProfile, true) });
    if (room) broadcast(room);
    broadcastBetRanking();
  });

  // Refresca el perfil público de una cuenta ya vinculada (username presente).
  // Pensado para que el cliente renueve su caché local de sesión de cuenta
  // (p. ej. tras reconectar o si el perfil cacheado quedó incompleto/obsoleto)
  // sin tener que volver a pedir la contraseña. Solo expone campos públicos
  // (los mismos que devuelve publicProgress): nunca passwordHash.
  socket.on('account_profile', ({ accountId } = {}, ack) => {
    const id = adminConfig.accountSessionsEnabled
      ? socket.data.accountProfileId
      : String(accountId || '').slice(0, 80);
    const profile = id ? profiles.profiles.get(id) : null;
    if (!profile?.username) return ackError(ack, 'No hay una sesión de cuenta válida.');
    ackOk(ack, { profile: publicProgress(profile, true) });
  });

  // El navegador solo puede equipar o quitar un objeto del catálogo que ya
  // pertenece a este perfil. No existe una acción cliente para sumar puntos,
  // sellos ni recompensas del Pasaporte.
  socket.on('passport_equip', (payload = {}, ack) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return ackError(ack, 'Solicitud de equipamiento no válida.');
    }
    if (!passportConfig.enabled) return ackError(ack, 'El Pasaporte no está activo en este momento.');
    const { slot, itemId, accountId } = payload;
    if (!Object.prototype.hasOwnProperty.call(payload, 'itemId')) {
      return ackError(ack, 'Elige un cosmético o quita uno del espacio seleccionado.');
    }
    const { room, player } = playerForSocket(socket);
    let targetProfile = player?._profile || null;
    if (!targetProfile) {
      const id = adminConfig.accountSessionsEnabled
        ? socket.data.accountProfileId
        : String(accountId || '').slice(0, 80);
      const candidate = id ? profiles.profiles.get(id) : null;
      if (candidate?.username) targetProfile = candidate;
    }
    if (!targetProfile) return ackError(ack, 'Perfil no disponible. Inicia sesión o abre tu perfil desde una mesa.');

    const result = equipPassportCosmetic(targetProfile, { slot, itemId });
    if (!result.ok) return ackError(ack, result.error);
    if (result.changed) profiles.touch(targetProfile);
    ackOk(ack, { profile: publicProgress(targetProfile, true) });
    if (room) broadcast(room);
  });

  // La colección nueva no forma parte del Pasaporte: solo equipa ids del catálogo
  // determinista ganados por ese mismo perfil. El cliente no puede fabricar un
  // unlock ni editar el progreso; todo se valida en este handler y en cosmetics.js.
  socket.on('cosmetic_equip', (payload = {}, ack) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return ackError(ack, 'Solicitud de equipamiento no válida.');
    }
    const { slot, itemId, accountId } = payload;
    if (!Object.prototype.hasOwnProperty.call(payload, 'itemId')) return ackError(ack, 'Elige un objeto del catálogo o quítalo del espacio.');
    const { room, player } = playerForSocket(socket);
    let targetProfile = player?._profile || null;
    if (!targetProfile) {
      const id = adminConfig.accountSessionsEnabled
        ? socket.data.accountProfileId
        : String(accountId || '').slice(0, 80);
      const candidate = id ? profiles.profiles.get(id) : null;
      if (candidate?.username) targetProfile = candidate;
    }
    if (!targetProfile) return ackError(ack, 'Perfil no disponible. Inicia sesión o abre tu perfil desde una mesa.');

    const result = equipCosmetic(targetProfile, { slot, itemId });
    if (!result.ok) return ackError(ack, result.error);
    if (result.changed) profiles.touch(targetProfile);
    ackOk(ack, { profile: publicProgress(targetProfile, true), equipped: result.item || null, changed: result.changed });
    if (room) broadcast(room);
  });

  // El bono diario se reclama explícitamente desde el perfil (una vez por día
  // UTC). En una mesa se usa el perfil del asiento; desde el lobby solo se
  // admite la cuenta autenticada por la cookie de Socket.IO. El `accountId` del
  // payload se conserva únicamente para el rollout legado con sesiones seguras
  // apagadas, igual que en profile_update/account_profile.
  socket.on('daily_bonus_claim', ({ accountId } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    let targetProfile = player?._profile || null;
    if (!targetProfile) {
      const id = adminConfig.accountSessionsEnabled
        ? socket.data.accountProfileId
        : String(accountId || '').slice(0, 80);
      const candidate = id ? profiles.profiles.get(id) : null;
      if (candidate?.username) targetProfile = candidate;
    }
    if (!targetProfile) return ackError(ack, 'Perfil no disponible. Inicia sesión o abre tu perfil desde una mesa.');

    const events = claimDailyBonus(targetProfile);
    if (events.length) {
      profiles.touch(targetProfile);
      logEvent('daily_bonus_claimed', { profileId: targetProfile.id, reward: events[0].reward });
      if (room && player) broadcast(room);
    }
    return ackOk(ack, {
      claimed: Boolean(events.length),
      reward: events[0]?.reward || 0,
      profile: publicProgress(targetProfile, true)
    });
  });

  // Fase 11.2: login opcional (usuario + contraseña) para recuperar el mismo
  // perfil desde otra computadora. No reemplaza el modo sin cuenta: solo
  // vincula credenciales al perfil que ya tiene este dispositivo (mismas
  // fichas, logros e historial) para poder volver a entrar a él después.
  // Gachapón de cartas: cobra CARD_GACHA_COST fichas (5.000) y suma una carta al álbum; si es repetida, abona CARD_DUPLICATE_CHIPS.
  // Mismo criterio de perfil que el bono diario: la mesa del jugador o la
  // cuenta autenticada; nunca un perfil ajeno enviado por el navegador.
  socket.on('card_gacha_pull', ({ accountId } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    let targetProfile = player?._profile || null;
    if (!targetProfile) {
      const id = adminConfig.accountSessionsEnabled
        ? socket.data.accountProfileId
        : String(accountId || '').slice(0, 80);
      const candidate = id ? profiles.profiles.get(id) : null;
      if (candidate?.username) targetProfile = candidate;
    }
    if (!targetProfile) return ackError(ack, 'Perfil no disponible. Inicia sesión o abre tu perfil desde una mesa.');

    const result = openCardCapsule(targetProfile, { enabled: cardGachaEnabled });
    if (!result.ok) return ackError(ack, result.error);
    profiles.touch(targetProfile);
    logEvent('card_capsule_opened', { profileId: targetProfile.id, rarity: result.card.rarity });
    if (room && player) broadcast(room);
    return ackOk(ack, {
      card: result.card,
      duplicate: result.duplicate,
      refundChips: result.refundChips,
      cost: result.cost,
      profile: publicProgress(targetProfile, true)
    });
  });

  socket.on('account_signup', ({ token, name, avatar, username, password, tos } = {}, ack) => {
    if (!token) return ackError(ack, 'No se pudo identificar este dispositivo.');
    const id = String(token).slice(0, 80);
    // El nombre con el que se crea la cuenta también se revisa (es el que se
    // mostrará en mesas y rankings): sin groserías y libre en el casino. Si
    // el perfil ya está sentado en una mesa, tampoco puede chocar con los
    // nombres de esa mesa (p. ej. un bot).
    const candidateName = cleanName(name);
    if (candidateName) {
      const existing = profiles.profiles.get(id);
      const signupIssue = nameIssue(candidateName, { room: roomOfProfile(existing), exceptId: id });
      if (signupIssue) return ackError(ack, signupIssue);
    }
    // Si el perfil ya existe (lo normal: ya jugó antes) no se le pisa el
    // nombre con un valor por defecto; getOrCreate solo lo usa si es nuevo.
    const profile = profiles.getOrCreate(id, candidateName || undefined, avatar);
    if (!verifyTosAcceptance(profile, tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
    const result = profiles.registerAccount(profile, username, password);
    if (!result.ok) return ackError(ack, result.error);
    logEvent('account_created', { profileId: profile.id, username: profile.username });
    ackOk(ack, { profile: publicProgress(profile, true) });
  });

  socket.on('account_login', ({ username, password } = {}, ack) => {
    if (adminConfig.accountSessionsEnabled) {
      return ackError(ack, 'Actualiza la página para usar el inicio de sesión seguro.');
    }
    const result = profiles.authenticate(username, password);
    if (!result.ok) return ackError(ack, result.error);
    logEvent('account_login', { profileId: result.profile.id, username: result.profile.username });
    ackOk(ack, { token: result.profile.id, profile: publicProgress(result.profile, true) });
  });

  socket.on('quick_bet', (data = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeQuickBet(room, player, data);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });

  socket.on('quick_resolve', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeQuickResolve(room, player);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });

  socket.on('quick_new', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeQuickNew(room, player);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });

  socket.on('blackjack_bet', (data = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeBlackjackBet(room, player, data);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });
  socket.on('blackjack_start', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeBlackjackStart(room, player);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });
  // Fase 8.4: seguro cuando la casa muestra un as (no requiere turno propio).
  socket.on('blackjack_insurance', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeBlackjackInsurance(room, player);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });
  for (const [event, action] of [['blackjack_hit', 'hit'], ['blackjack_stand', 'stand'], ['blackjack_double', 'double'], ['blackjack_split', 'split']]) {
    socket.on(event, (_data, ack) => {
      const { room, player } = playerForSocket(socket);
      const result = executeBlackjackAction(room, player, action);
      ackResult(ack, result);
      if (result.ok) broadcast(room);
    });
  }
  socket.on('blackjack_new', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeBlackjackNew(room, player);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });

  socket.on('poker_start', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executePokerStart(room, player);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });
  // Fase 8.1: el anfitrión arranca un torneo sit & go en la mesa de póker.
  socket.on('tournament_start', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executeTournamentStart(room, player);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });
  socket.on('poker_action', (data = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    const result = executePokerAction(room, player, data);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });

  socket.on('bot_add', ({ difficulty, style } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.id !== room.hostId) return ackError(ack, 'Solo el anfitrión puede configurar bots.');
    if (!DIFFICULTIES[difficulty] || !STYLES[style]) return ackError(ack, 'Elige dificultad y estilo válidos.');
    const result = addBotToRoom(room, { difficulty, style });
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });

  socket.on('bot_fill', ({ difficulty, style } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.id !== room.hostId) return ackError(ack, 'Solo el anfitrión puede completar la mesa.');
    if (!DIFFICULTIES[difficulty] || !STYLES[style]) return ackError(ack, 'Elige dificultad y estilo válidos.');
    if (rosterLocked(room)) return ackError(ack, 'Espera a que termine la ronda para cambiar bots.');
    const available = ROOM_CAPACITY - room.players.length;
    if (available <= 0) return ackError(ack, 'La mesa ya está llena.');
    const botIds = [];
    for (let index = 0; index < available; index++) {
      const result = addBotToRoom(room, { difficulty, style });
      if (!result.ok) break;
      botIds.push(result.botId);
    }
    ackOk(ack, { botIds });
    broadcast(room);
  });

  socket.on('bot_remove', ({ botId } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.id !== room.hostId) return ackError(ack, 'Solo el anfitrión puede retirar bots.');
    const target = room.players.find(item => item.id === botId && item.isBot);
    const result = removeBotFromRoom(room, target);
    ackResult(ack, result);
    if (result.ok) broadcast(room);
  });

  // La recarga de fichas ('rebuy') se eliminó a pedido: las fichas solo entran por
  // el bono diario, los logros/retos y el reinicio mensual de temporada. Así el
  // ranking del mes no se puede inflar reponiendo fichas a voluntad.

  socket.on('kick_player', ({ playerId } = {}, ack) => {
    const { room, player } = playerForSocket(socket);
    if (!room || player.id !== room.hostId) return ackError(ack, 'Solo el anfitrión puede retirar jugadores.');
    if (isPokerActive(room) || room.phase === 'playing') return ackError(ack, 'Espera a que termine la mano.');
    const target = room.players.find(p => p.id === playerId && p.id !== player.id);
    if (!target) return ackError(ack, 'Jugador no encontrado.');
    if (target.isBot) {
      const result = removeBotFromRoom(room, target);
      ackResult(ack, result);
      if (result.ok) broadcast(room);
      return;
    }
    room.players = room.players.filter(p => p.id !== target.id);
    if (target.socketId) io.to(target.socketId).emit('removed', { message: 'El anfitrión te retiró de la mesa.' });
    addSystem(room, `${target.name} dejó su asiento.`);
    ackOk(ack);
    broadcast(room);
  });
  socket.on('leave_room', (_data, ack) => {
    const { room, player } = playerForSocket(socket);
    if (room && player) {
      removeOrDisconnectPlayer(room, player, true);
      socket.leave(room.code);
      delete socket.data.roomCode;
      delete socket.data.playerId;
      broadcast(room);
    } else if (room && socket.data.spectatorId) {
      removeSpectator(room, socket.data.spectatorId);
      socket.leave(room.code);
      delete socket.data.roomCode;
      delete socket.data.spectatorId;
      broadcast(room);
    }
    ackOk(ack);
  });

  socket.on('disconnect', () => {
    const { room, player } = playerForSocket(socket);
    if (room && !player && socket.data.spectatorId) {
      const spectator = room.spectators?.find(s => s.id === socket.data.spectatorId);
      if (spectator && spectator.socketId === socket.id) {
        removeSpectator(room, spectator.id);
        broadcast(room);
      }
    } else if (room && player && player.socketId === socket.id) {
      removeOrDisconnectPlayer(room, player, false);
      broadcast(room);
    }
    const tournamentProfileId = lobbyTournamentProfileIdForSocket(socket);
    if (lobbyTournaments?.markOffline(tournamentProfileId, socket.id)) broadcastLobbyTournaments();
    // `disconnect` ocurre también para visitantes que nunca entraron a una
    // mesa. Se difiere un tick para contar cuando el namespace ya retiró por
    // completo el socket y publicar el descenso a quienes siguen conectados.
    setImmediate(() => {
      try { broadcastLobby(); }
      catch (error) { console.error('[HANDLER_ERROR] evento=disconnect (presencia):', error); }
    });
  });
});

// Fase 2: si el anfitrión lleva HOST_INACTIVITY_MS sin actividad (o se desconectó),
// la autoridad de la mesa pasa a otra persona real activa. Nunca a un bot.
const hostInactivitySweep = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // Auditoría: este barrido corre en un setInterval, fuera de cualquier
    // envoltura: una excepción aquí (p. ej. dentro de broadcast) subía a
    // uncaughtException y tumbaba el casino completo. El try/catch es por
    // mesa: una mesa que falla no frena la migración de las demás ni el
    // siguiente barrido.
    try {
      const humans = room.players.filter(p => !p.isBot && p.connected);
      if (!humans.length) continue;
      const host = room.players.find(p => p.id === room.hostId);
      const hostValid = host && !host.isBot && host.connected;
      if (hostValid && now - host.lastActiveAt <= HOST_INACTIVITY_MS) continue;
      const candidates = humans
        .filter(p => p.id !== room.hostId)
        .filter(p => !hostValid || now - p.lastActiveAt <= HOST_INACTIVITY_MS)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      if (!candidates.length) continue;
      const next = candidates[0];
      const previousName = host?.name || 'el anfitrión anterior';
      room.hostId = next.id;
      addSystem(room, `👑 ${next.name} ahora dirige la mesa por inactividad de ${previousName}.`);
      broadcast(room);
    } catch (error) {
      console.error(`[SWEEP_ERROR] migracion-anfitrion mesa=${room.code}:`, error);
      logEvent('host_sweep_error', { room: room.code, game: room.game, message: String(error?.message || error) });
    }
  }
}, HOST_INACTIVITY_SWEEP_MS);
hostInactivitySweep.unref?.();

// Fase 8.7: vigila el cambio de mes con el servidor encendido. Al cerrar la
// temporada, todos los perfiles vuelven a 1000 fichas y se anuncia el podio.
let seasonSweepRunning = false;
const seasonSweep = setInterval(async () => {
  if (!profiles || seasonSweepRunning) return; // no solapar una escritura lenta de Postgres
  seasonSweepRunning = true;
  try {
    // Antes del reset, dar al ciclo BDO una oportunidad completa de cerrar y
    // liquidar. El hook síncrono de ensureSeason queda como red de seguridad.
    const now = new Date();
    const localMonth = monthKey(now, CASINO_TIME_ZONE);
    if (footballBallonDorMarket && profiles.seasons?.current < localMonth) {
      try {
        await footballBallonDorMarket.beforeSeasonReset(profiles.seasons.current, now.getTime());
      } catch (error) {
        logEvent('football_ballon_dor_pre_reset_error', { message: String(error?.message || error) });
      }
    }
    // Auditoría: igual que el barrido de anfitriones, un error aquí mataba el
    // proceso entero (setInterval sin envoltura). Se prefiere perder UN barrido
    // y reintentar en 5 minutos a tumbar el casino en plena temporada.
    try {
    // Fase 11.4: junto con el cambio de mes, se aprovecha el mismo barrido de 5
    // min para borrar cuentas sin actividad desde hace ~3 meses (ahorra espacio,
    // sobre todo en Postgres). No afecta a nadie conectado: si alguien reconecta
    // después de tanto tiempo sin tocar su perfil, empieza uno nuevo, igual que
    // un jugador que entra por primera vez.
    const prunedAccounts = profiles.pruneInactiveAccounts(INACTIVITY_LIMIT_MS);
    if (prunedAccounts.length) {
      logEvent('accounts_pruned', { count: prunedAccounts.length, names: prunedAccounts.slice(0, 20).map(entry => entry.name) });
    }
    const closed = profiles.ensureSeason();
    if (!closed) return;
    if (closed.type === 'deferred') {
      // Fase F (A12): el reset del casino se aplazó porque aún quedan apuestas de
      // fútbol abiertas en la temporada que iba a cerrar. No se reinician saldos ni
      // se anuncia nada; el próximo barrido (5 min) lo reintenta. Si se agota el
      // tope de aplazamientos, ensureSeason fuerza el cierre y ya no llega aquí.
      logEvent('season_reset_deferred', {
        month: closed.month, toMonth: closed.toMonth, reason: closed.reason,
        deferrals: closed.deferrals, maxDeferrals: closed.maxDeferrals
      });
      return;
    }
    if (closed.type === 'repair') {
      logEvent('season_calendar_repaired', closed);
      for (const room of rooms.values()) {
        addSystem(room, `📅 Calendario corregido: la temporada ${closed.toMonth} continúa hasta la medianoche de ${CASINO_TIME_ZONE}.`);
        broadcast(room);
      }
      broadcastLobby();
      return;
    }
    const publicClosed = publicSeasonRecord(closed);
    logEvent('season_reset', { closedMonth: closed.month, players: closed.players, podium: publicClosed.podium, bannerAwarded: closed.bannerAwarded, timeZone: closed.timeZone });
    const podiumText = publicClosed.podium.length
      ? ` Podio de ${closed.month}: ${publicClosed.podium.map((entry, index) => `${['🥇', '🥈', '🥉'][index]} ${entry.name} (${entry.chips})`).join(' · ')}.`
      : '';
    // Fase 11.4: el banner dorado solo se anuncia la primera vez que alguien lo
    // gana (closed.bannerAwarded ya viene en false si esa persona ya lo tenía
    // de una temporada anterior).
    const bannerText = closed.bannerAwarded && publicClosed.podium[0]
      ? ` 🎖️ ¡${publicClosed.podium[0].name} se ganó su banner dorado de por vida por terminar en 1er lugar!`
      : '';
    for (const room of rooms.values()) {
      addSystem(room, `📅 ¡Nueva temporada mensual! Todos los saldos se reiniciaron a 1000 fichas.${podiumText}${bannerText}`);
      broadcast(room);
    }
    broadcastLobby();
    } catch (error) {
      console.error('[SWEEP_ERROR] cierre-de-temporada:', error);
      logEvent('season_sweep_error', { message: String(error?.message || error) });
    }
  } finally {
    seasonSweepRunning = false;
  }
}, 5 * 60 * 1000);
seasonSweep.unref?.();

// Fase 7: apagado limpio. Render envía SIGTERM en cada deploy: guardamos perfiles,
// avisamos a las mesas y cerramos sockets con gracia para que la reconexión automática
// del cliente reencuentre la sesión en la nueva instancia.
let shuttingDown = false;
// Fase 10.2: async porque guardar en Postgres es una operación de red (en el
// backend de archivo, `await profiles.saveNow()` resuelve de inmediato, igual
// que antes). El temporizador de salida forzada sigue siendo la red de
// seguridad si la base de datos no responde a tiempo.
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (lobbyTournamentTimer) clearInterval(lobbyTournamentTimer);
  // La Lotería guarda su estado en cada transición; aquí solo se detiene el
  // reloj para que no abra ni liquide una ronda nueva durante el apagado.
  try { loteria?.stop(); } catch (_) { /* el guardado de perfiles es lo crítico */ }
  logEvent('shutdown_start', { signal, rooms: rooms.size });
  if (!profiles) {
    // Señal recibida antes de terminar de arrancar (bootstrap() aún esperando
    // a Postgres/el archivo): no hay nada que guardar todavía.
    process.exit(0);
    return;
  }
  try {
    for (const room of rooms.values()) {
      // Rueda: una apuesta sin resultado no puede sobrevivir a la mesa; se
      // devuelve ahora y el guardado final ya la deja en el saldo.
      closeFortuneRoom(room, 'server_restart');
      addSystem(room, '🔄 El servidor se está actualizando y se reiniciará en unos segundos. Tus fichas ya están guardadas; conserva esta pestaña para volver a tu asiento.');
      broadcast(room);
    }
  } catch (_) { /* avisar es cortesía; el guardado es lo crítico */ }
  // Fase 11.3: con Postgres, saveNow() es una llamada de red que puede tardar
  // unos segundos si la base tuvo que "despertar" justo ahora (p. ej. Neon
  // escalando desde cero) y además reintenta sola ante fallos transitorios;
  // le damos más margen que al backend de archivo (donde guardar es
  // instantáneo). Configurable con SHUTDOWN_GRACE_MS por si algún plan de
  // hosting necesita ajustarlo.
  const defaultGraceMs = profiles.backend === 'postgres' ? 10000 : 2500;
  const envGraceMs = Number(process.env.SHUTDOWN_GRACE_MS);
  const graceMs = Number.isFinite(envGraceMs) && envGraceMs > 0 ? envGraceMs : defaultGraceMs;
  const forceExit = setTimeout(() => { logEvent('shutdown_forced', { graceMs }); process.exit(0); }, graceMs);
  forceExit.unref?.();
  try { await profiles.saveNow(); } catch (_) { /* saveNow ya reporta sus propios errores */ }
  try { await accountSessionStore?.close?.(); } catch (error) {
    console.warn('No se pudo cerrar el store de sesiones:', error.message);
  }
  try { await auditStore?.close?.(); } catch (error) {
    console.warn('No se pudo cerrar el store de auditoría:', error.message);
  }
  try { await moderationStore?.close?.(); } catch (error) {
    console.warn('No se pudo cerrar el store de moderación:', error.message);
  }
  try { await reportStore?.close?.(); } catch (error) {
    console.warn('No se pudo cerrar el store de reportes:', error.message);
  }
  try { await passwordResetStore?.close?.(); } catch (error) {
    console.warn('No se pudo cerrar el store de restablecimientos:', error.message);
  }
  try { await idempotencyStore?.close?.(); } catch (error) {
    console.warn('No se pudo cerrar el store de idempotencia:', error.message);
  }
  try { await communityStore?.close?.(); } catch (error) {
    console.warn('No se pudo cerrar el store de comunidad:', error.message);
  }
  // Estadio MonteCristo (Fase E4): detener el motor y persistir su store. El orden
  // importa: primero se paran los sweeps y los listeners del motor (no más writes),
  // luego se guarda y cierra el store de fútbol.
  try { footballScheduler?.stop(); } catch (_) { /* parar el scheduler es lo primero */ }
  try { footballSockets?.stop(); } catch (_) { /* desregistrar listeners del motor */ }
  try { await footballStore?.saveNow?.(); } catch (error) { console.warn('No se pudo guardar el store de fútbol:', error.message); }
  try { await footballStore?.close?.(); } catch (error) { console.warn('No se pudo cerrar el store de fútbol:', error.message); }
  io.close(async () => {
    // io.close dispara los disconnect handlers. Guardamos el último estado
    // sanitizado después de retirarse los sockets y antes de cerrar el store.
    try { await lobbyTournamentStore?.saveNow?.(lobbyTournaments?.serialize()); } catch (error) {
      console.warn('No se pudo guardar el estado de torneos del lobby:', error.message);
    }
    try { await lobbyTournamentStore?.close?.(); } catch (error) {
      console.warn('No se pudo cerrar el store de torneos del lobby:', error.message);
    }
    server.close(() => {
      logEvent('shutdown_complete', {});
      process.exit(0);
    });
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Estadio MonteCristo (Fase E4): inicializa la sección completa. Se invoca desde
// bootstrap() SOLO con footballConfig.enabled, y siempre ANTES de server.listen()
// para no aceptar tráfico sobre un estado sin reconciliar (§15.6). Si algo crítico
// falla, el throw sube al catch de bootstrap() que hace process.exit(1) (A6).
async function initFootball() {
  // 1. Store (fábrica: archivo JSON o Postgres/Neon). La fábrica falla cerrada si
  //    DATABASE_URL está definida antes de la Fase F (backend PG del Estadio).
  footballStore = await createFootballStore(footballConfig.storePath, process.env.DATABASE_URL);
  footballStore.ensureSeason(new Date());

  // 2. Log estructurado que ADEMÁS reenvía cada liquidación al socket del perfil
  //    (football:settlement). El log de betting no trae profileId, así que se
  //    resuelve del betId con una lectura estricta del store.
  const footballLog = (event, data) => {
    // Los eventos por boleto se mantienen en el store/ledger y se enrutan al perfil
    // dueño por Socket.IO, pero nunca se persisten como telemetría de producción.
    // /healthz conserva solo conteos agregados, sin IDs, selecciones ni importes.
    if (!isPrivateBallonDorBetLog(event)) logEvent(event, data);
    if (event === 'football_bet_settled' && data && data.betId && footballSockets && footballStore) {
      const bet = footballStore.getBet(data.betId);
      if (bet) footballSockets.broadcastSettlement({ profileId: bet.profileId, betId: bet.id, status: data.status, payout: data.payout, reason: data.reason });
    }
    if (event === 'football_ballon_dor_bet_settled' || event === 'football_ballon_dor_bet_refunded') {
      const future = data?.futureId && footballStore?.getFuture(data.futureId);
      if (future && footballSockets) {
        footballSockets.broadcastSettlement({
          profileId: future.profileId, betId: future.id, status: future.status,
          payout: future.payout, reason: event === 'football_ballon_dor_bet_refunded' ? 'balon_de_oro_cancelado' : null
        });
      }
      broadcastBetRanking();
    }
    if (['football_ballon_dor_odds_updated', 'football_ballon_dor_cancelled', 'football_ballon_dor_settled',
      'football_ballon_dor_announcement_available', 'football_ballon_dor_payouts_updated'].includes(event)) {
      footballSockets?.broadcastBallonDorMarket?.(data?.seasonMonth);
    }
  };

  // 3. Flujo de apostadores simulados (invisible, §11.6) + servicio de apuestas.
  const simulatedFlow = new SimulatedFlow({ log: footballLog });
  footballBetting = createBettingService({
    store: footballStore, profiles, simulatedFlow, log: footballLog, now: () => Date.now()
  });
  footballBallonDorMarket = new BallonDorMarketService({
    store: footballStore, betting: footballBetting, now: () => Date.now(), log: footballLog
  });

  // 4. Motor determinista con los hooks de apuestas cableados (Fase D) y el gate de
  //    temporada (A7). El motor emite eventos que la capa de socket difunde.
  footballEngine = new FootballEngine(footballStore, {
    logEvent: footballLog,
    settleBets: (match, score) => footballBetting.settleMatchBets(match, score),
    refundBets: (match, reason) => footballBetting.refundMatchBets(match, reason),
    cancelPendingBets: () => footballBetting.cancelPendingBets(),
    reconcileEscrow: () => footballBetting.reconcileEscrow(),
    hasOpenBets: (month) => footballBetting.hasOpenBets(month),
    countOpenBets: () => footballBetting.countOpenBets(),
    countEscrow: () => footballBetting.countEscrow()
  });

  // 5. Reconciliación de arranque (§15.6): reconstruye el estado de los partidos no
  //    terminales desde (seed, now) y cuadra el escrow. ANTES de aceptar tráfico.
  footballEngine.reconcile(Date.now());
  // Recupera/transiciona ciclos BDO antes de aceptar tráfico y antes del reset
  // mensual de perfiles. Un fallo del premio se registra, pero nunca impide casino.
  try {
    const bdoSummary = await footballBallonDorMarket.sweep(Date.now());
    const operationalSummary = { ...bdoSummary };
    delete operationalSummary.refunded;
    logEvent('football_ballon_dor_boot_sweep', operationalSummary);
  } catch (error) {
    logEvent('football_ballon_dor_boot_sweep_error', { message: String(error?.message || error) });
  }

  // 6. Capa de protocolo Socket.IO (§14). Añade su propio io.on('connection'),
  //    independiente del handler de mesas del casino. Helpers del casino inyectados:
  //    ackOk/ackError (con code), cleanMessage, nameIssue (unicidad global de
  //    nombres) y verifyTosAcceptance. La identidad se resuelve SOLO en subscribe.
  footballSockets = registerFootballSockets(io, {
    betting: footballBetting, engine: footballEngine, store: footballStore, profiles,
    onFanChanged: profile => {
      for (const room of rooms.values()) if (room.players.some(player => player._profile === profile)) broadcast(room);
      io.to(`account:${profile.id}`).emit('profile_event', { events:[], profile:publicProgress(profile, true) });
    },
    ballonDorMarket: footballBallonDorMarket, accountSessionsEnabled: adminConfig.accountSessionsEnabled,
    config: footballConfig.sockets, log: footballLog, now: () => Date.now(),
    ackOk,
    ackError: (ack, message, code) => ackResult(ack, actionError(message, code || 'invalid')),
    cleanMessage, nameIssue, verifyTosAcceptance,
    onBetPlaced: () => broadcastBetRanking()
  });

  // 7. Scheduler: sweeps de kickoff, avance, partidos atascados y temporada (§15).
  footballScheduler = new FootballScheduler(footballEngine, {
    ballonDorService: footballBallonDorMarket, logEvent: footballLog
  });
  footballScheduler.start();

  logEvent('football_initialized', {
    storePath: footballConfig.storePath,
    backend: footballStore.backend || 'file',
    seasonMonth: footballStore.getCurrentSeasonMonth()
  });
}

// Fase 10.2: se crea el ProfileStore (archivo o Postgres, según DATABASE_URL)
// y solo cuando está listo se abre el puerto; así ningún socket puede llegar
// antes de que los perfiles existan en memoria.
async function bootstrap() {
  // Fase F (A12): deferSeasonCheck pospone la comprobación de temporada del casino.
  // Sin esto, createProfileStore cerraría el mes y reiniciaría TODOS los saldos dentro
  // de su constructor (archivo) o de _init (Postgres), antes de que exista el store de
  // fútbol y antes de poder consultar si quedan apuestas abiertas. El cierre efectivo
  // se hace más abajo con profiles.ensureSeason(), ya con el gate cableado.
  profiles = await createProfileStore(process.env.PROFILE_STORE_PATH, process.env.DATABASE_URL, { deferSeasonCheck: true });
  accountSessionStore = createAccountSessionStore(adminConfig);
  auditStore = createAuditStore(adminConfig);
  moderationStore = createModerationStore(adminConfig);
  reportStore = createReportStore(adminConfig);
  passwordResetStore = createPasswordResetStore(adminConfig);
  idempotencyStore = createIdempotencyStore(adminConfig);
  communityStore = createCommunityStore(process.env.COMMUNITY_STORE_PATH, process.env.DATABASE_URL);
  if (communityStore.ready) await communityStore.ready;
  // NOTA (Fase F, A12): el aviso de lastSeasonRepair se emite más abajo, después de
  // profiles.ensureSeason(), que es quien de verdad puede disparar la reparación.
  // Fase 11.1: con Postgres, guardar más historial no infla un archivo local
  // que se reescribe entero en cada guardado (ver nota en profile-store-shared.js),
  // así que se eleva el techo de puntos de saldo y transacciones conservados.
  // Con el archivo JSON el techo se queda como siempre (60 / 20).
  if (profiles.backend === 'postgres') {
    HISTORY_LIMITS.balance = 2000;
    HISTORY_LIMITS.transactions = 500;
  }
  // Estadio MonteCristo (Fase E4): motor, apuestas, sockets y scheduler listos y
  // reconciliados ANTES de abrir el puerto. Detrás del flag fail-closed: con
  // FOOTBALL_ENABLED=off (por defecto) no se crea nada y la sección es invisible.
  if (footballConfig.enabled) {
    await initFootball();
    // Fase F (A12): con el store de fútbol ya reconciliado, se cablea el gate del
    // reset mensual. ensureSeason() del casino lo consulta ANTES de cerrar la
    // temporada: si la temporada que va a cerrar aún tiene apuestas, combinadas o
    // futuros abiertos, devuelve {type:'deferred'} y no se reinician los saldos.
    // Fallo abierto: si la consulta falla, se permite el cierre — el casino no puede
    // quedar atascado por un error del gate (y ensureSeason lleva su propio tope de
    // aplazamientos, SEASON_RESET_MAX_DEFERRALS).
    profiles.onBeforeSeasonReset = ({ fromMonth, date }) => {
      // Intenta cerrar/resolver el ciclo que termina. El gancho existente es
      // síncrono; la promesa queda aislada para que un fallo del premio jamás
      // detenga el reset del casino. El recovery posterior al reset aplica los
      // pagos terminales que deban esperar a que se reinicie el saldo mensual.
      if (footballBallonDorMarket) {
        Promise.resolve(footballBallonDorMarket.beforeSeasonReset(
          fromMonth, date instanceof Date ? date.getTime() : Date.now()
        )).catch(error => logEvent('football_ballon_dor_pre_reset_error', {
          seasonMonth: fromMonth, message: String(error?.message || error)
        }));
      }
      try {
        return footballSeasonResetGate(footballStore, fromMonth);
      } catch (error) {
        console.warn('Gate de reset de temporada: no se pudo consultar el fútbol; se permite el cierre:', error.message);
      }
      return null;
    };
    profiles.onAfterSeasonReset = ({ fromMonth, toMonth }) => {
      if (!footballBallonDorMarket) return;
      Promise.resolve(footballBallonDorMarket.sweep(Date.now()))
        .then(summary => {
          const operationalSummary = { ...summary };
          delete operationalSummary.refunded;
          logEvent('football_ballon_dor_post_reset_recovery', {
            fromMonth, toMonth, summary: operationalSummary
          });
        })
        .catch(error => logEvent('football_ballon_dor_post_reset_error', {
          fromMonth, toMonth, message: String(error?.message || error)
        }));
    };
  }
  // Fase F (A12): comprobación/cierre de la temporada del casino, AHORA con el gate
  // cableado. Puede devolver 'closed', 'repair', 'deferred' o null.
  const seasonResult = profiles.ensureSeason();
  if (profiles.lastSeasonRepair) {
    console.warn(`Calendario de temporada corregido: ${profiles.lastSeasonRepair.fromMonth} → ${profiles.lastSeasonRepair.toMonth} (${CASINO_TIME_ZONE}).`);
    logEvent('season_calendar_repaired', profiles.lastSeasonRepair);
  }
  if (seasonResult && seasonResult.type === 'deferred') {
    console.warn(`Reset del casino aplazado: la temporada ${seasonResult.month} aún tiene apuestas de fútbol abiertas (aplazamiento ${seasonResult.deferrals}/${seasonResult.maxDeferrals}).`);
    logEvent('season_reset_deferred', { month: seasonResult.month, toMonth: seasonResult.toMonth, reason: seasonResult.reason, deferrals: seasonResult.deferrals, maxDeferrals: seasonResult.maxDeferrals });
  }
  lobbyTournamentStore = await createLobbyTournamentStore(
    process.env.LOBBY_TOURNAMENT_STORE_PATH, process.env.DATABASE_URL
  );
  lobbyTournaments = new LobbyTournamentManager({
    timeZone: CASINO_TIME_ZONE,
    snapshot: lobbyTournamentStore.getState()
  });
  lobbyTournaments.setChangeListener(snapshot => lobbyTournamentStore.save(snapshot));
  // Normaliza el calendario rehidratado y guarda de inmediato las reparaciones:
  // las mesas que se perdieron con el proceso vuelven a pendiente, y ninguna
  // inscripción vencida se inicia con sockets de la instancia anterior.
  await lobbyTournamentStore.saveNow(lobbyTournaments.serialize());
  let recoveredPayouts = 0;
  for (const event of lobbyTournaments.events.values()) {
    if (event.status !== 'completed' || event.payoutsAwarded) continue;
    const payouts = event.registered.map(entrant => ({
      profileId: entrant.profileId,
      name: entrant.name,
      ...(event.placements[entrant.profileId] || { place: event.capacity, prize: 0 })
    }));
    if (await awardLobbyTournamentPrizes(event, payouts)) recoveredPayouts++;
  }
  startLobbyTournamentScheduler();
  // Rueda de la Fortuna: el diario se abre y se recupera ANTES de aceptar
  // tráfico, para que ninguna apuesta interrumpida por un despliegue quede sin
  // devolución ni ningún premio confirmado sin pagar. Si algo falla, la Rueda
  // se apaga sola (fortuneAvailable() queda en false) y el casino abre igual.
  if (fortuneEnabled) {
    try {
      fortuneLedger = new FortuneLedger({
        profiles,
        statePath: process.env.FORTUNE_STATE_PATH || path.join(__dirname, 'data', 'fortune-ledger.json'),
        log: logEvent,
        now: () => Date.now()
      });
      const recovered = fortuneLedger.start();
      logEvent('fortune_initialized', {
        statePath: process.env.FORTUNE_STATE_PATH || path.join(__dirname, 'data', 'fortune-ledger.json'),
        pendingRounds: fortuneLedger.pendingRounds(),
        ...recovered
      });
    } catch (error) {
      fortuneLedger = null;
      console.warn('No se pudo iniciar el diario de la Rueda:', error.message);
      logEvent('fortune_init_failed', { message: String(error?.message || error) });
    }
  }
  // Lotería mexicana: el servicio se arranca ANTES de abrir el puerto para que
  // una ronda interrumpida por un despliegue se recupere (reembolsos y premios
  // pendientes incluidos) y para que nadie entre a un estado a medio liquidar.
  if (loteriaEnabled) {
    const clampInt = (raw, fallback, min, max) => {
      const value = Math.floor(Number(raw));
      return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    };
    try {
      loteria = new LoteriaService({
        profiles,
        statePath: process.env.LOTERIA_STATE_PATH || path.join(__dirname, 'data', 'loteria.json'),
        log: logEvent,
        onProgress: (profileId, events) => emitLoteriaProgress(profileId, events),
        onStateChange: () => broadcastLoteriaState(),
        registrationMs: clampInt(process.env.LOTERIA_REGISTRATION_MS, 60 * 1000, 3000, 10 * 60 * 1000),
        callIntervalMs: clampInt(process.env.LOTERIA_CALL_INTERVAL_MS, 2000, 20, 60 * 1000),
        breakMs: clampInt(process.env.LOTERIA_BREAK_MS, 12000, 1000, 5 * 60 * 1000),
        tickMs: 500
      });
      await loteria.start();
      const health = loteria.snapshotFor(null);
      logEvent('loteria_initialized', {
        statePath: process.env.LOTERIA_STATE_PATH || path.join(__dirname, 'data', 'loteria.json'),
        gameId: health.game?.id || null,
        status: health.game?.status || null,
        players: health.game?.count || 0
      });
    } catch (error) {
      // La lotería nunca debe impedir que el casino abra: se apaga y se registra.
      loteria = null;
      console.warn('No se pudo iniciar la Lotería:', error.message);
      logEvent('loteria_init_failed', { message: String(error?.message || error) });
    }
  }
  logEvent('lobby_tournaments_initialized', {
    timeZone: CASINO_TIME_ZONE, events: lobbyTournaments.events.size,
    interruptedMatches: lobbyTournaments.recovery.interruptedMatches,
    cancelledEvents: lobbyTournaments.recovery.cancelledEvents,
    recoveredPayouts
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MonteCristo lista en http://0.0.0.0:${PORT}`);
    logEvent('server_listening', {
      port: Number(PORT),
      node: process.version,
      profileStore: profiles.filePath,
      profileBackend: profiles.backend,
      casinoTimeZone: CASINO_TIME_ZONE,
      historyLimits: { ...HISTORY_LIMITS },
      adminFeatureEnabled: adminConfig.enabled
    });
  });
}
bootstrap().catch(error => {
  console.error('No se pudo iniciar MonteCristo:', error);
  process.exit(1);
});
