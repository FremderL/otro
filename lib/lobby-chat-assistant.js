'use strict';

const MONTE_ASSISTANT_NAME = 'Monte';
const MONTE_ASSISTANT_AVATAR = 'robot';
const MONTE_ASSISTANT_COOLDOWN_MS = 8000;
const MAX_COOLDOWN_KEYS = 2000;
const cooldownByProfile = new Map();
const MENTION_PATTERN = /(^|[^\p{L}\p{N}_])@monte(?=$|[^\p{L}\p{N}_])/iu;

function normalizeForSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-MX');
}

function invocationQuery(text) {
  const normalized = normalizeForSearch(text).trim();
  const helpCommand = /^\/ayuda(?:\s|$)/.test(normalized);
  if (!helpCommand && !MENTION_PATTERN.test(normalized)) return null;

  return normalized
    .replace(/^\/ayuda\b/, '')
    .replace(MENTION_PATTERN, '$1 ')
    .replace(/[¿?¡!.,;:()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLobbyAssistantReply(text) {
  const query = invocationQuery(text);
  if (query === null) return null;
  if (!query || /^(hola|buenas?|buenos dias|buenas tardes|buenas noches|que tal|hey|hi)$/.test(query)) {
    return '¡Hola! Soy Monte, asistente automático (BOT). Pregúntame por reglas, juegos, salas, bots, fichas o Estadio. No veo cartas ni datos de perfiles.';
  }

  if (/\b(bot|bots|ia|asistente)\b/.test(query)) {
    return 'El anfitrión puede abrir «+ BOT» para agregar bots o completar la mesa; hay varios niveles y estilos. Los bots del juego están identificados como BOT.';
  }
  if (/\b(poker|hold.?em)\b/.test(query)) {
    return 'En Texas Hold’em, en tu turno puedes retirarte, pasar o igualar, subir o ir all-in. Cada quien ve sus cartas; las fichas son virtuales.';
  }
  if (/\b(blackjack|veintiuno|21)\b/.test(query)) {
    return 'En Blackjack intenta acercarte a 21 sin pasarte. Puedes pedir carta, plantarte, doblar o, cuando corresponda, dividir. Las fichas son virtuales.';
  }
  if (/\b(juegos|juego|casino|ruleta|dados|tragamonedas|moneda|disponibles?)\b/.test(query)) {
    return 'Puedes crear salas de póker, blackjack, ruleta, dados, cara o cruz y tragamonedas. Elige «Crear una sala» y comparte el código de 5 caracteres; las fichas son virtuales.';
  }
  if (/\b(reglas|terminos|condiciones|legal)\b/.test(query)) {
    return 'Las reglas dependen del juego y las condiciones generales están en /terminos. Las fichas son virtuales; puedes preguntarme por póker, blackjack o cómo crear y entrar a una sala.';
  }
  if (/\b(fichas|dinero|real|deposito|retiro|canjear|saldo)\b/.test(query)) {
    return 'Las fichas de MonteCristo son virtuales: no son dinero real ni se pueden canjear. Consulta los Términos en /terminos.';
  }
  if (/\b(estadio|previa|futbol|liga)\b/.test(query)) {
    return 'Abre /estadio para ver la liga. La Previa aparece durante los últimos 30 minutos antes del kickoff.';
  }
  if (/\b(chat|apodo|mensaje)\b/.test(query)) {
    return 'El chat del lobby es compartido y requiere aceptar los Términos. Para ayuda automática, mencióname con @Monte o escribe /ayuda.';
  }
  if (/\b(crear|creo|armar|abrir|abre|nueva|montar)\b/.test(query) && /\b(sala|mesa|partida|juego)\b/.test(query)) {
    return 'Usa «Crear una sala» en la portada, elige juego y apodo; al entrar, comparte el código de 5 caracteres. Las fichas son virtuales.';
  }
  if (/\b(entrar|unir|codigo|clave|acceso|compartir|invitacion)\b/.test(query)) {
    return 'Abre una sala del lobby o usa «Unirte a una sala» con su código de 5 caracteres. También puedes compartir el enlace de la sala.';
  }
  if (/\b(sala|salas|mesa|mesas|partida)\b/.test(query)) {
    return 'Desde la portada puedes crear una sala privada, explorar salas abiertas o unirte con un código de 5 caracteres. Pregúntame «crear sala» o «entrar a sala».';
  }

  return 'Puedo orientar sobre salas, póker, blackjack, bots, fichas virtuales y Estadio. Prueba: «@Monte crear sala», «@Monte bots» o /ayuda.';
}

function canReplyToLobbyAssistant(profileId, now = Date.now()) {
  const key = String(profileId || '').trim();
  if (!key) return false;

  const previous = cooldownByProfile.get(key);
  if (previous != null && now - previous < MONTE_ASSISTANT_COOLDOWN_MS) return false;
  cooldownByProfile.set(key, now);

  if (cooldownByProfile.size > MAX_COOLDOWN_KEYS) {
    for (const [id, repliedAt] of cooldownByProfile) {
      if (now - repliedAt >= MONTE_ASSISTANT_COOLDOWN_MS * 4) cooldownByProfile.delete(id);
      if (cooldownByProfile.size <= MAX_COOLDOWN_KEYS) break;
    }
    while (cooldownByProfile.size > MAX_COOLDOWN_KEYS) {
      cooldownByProfile.delete(cooldownByProfile.keys().next().value);
    }
  }
  return true;
}

module.exports = {
  MONTE_ASSISTANT_NAME,
  MONTE_ASSISTANT_AVATAR,
  MONTE_ASSISTANT_COOLDOWN_MS,
  getLobbyAssistantReply,
  canReplyToLobbyAssistant
};
