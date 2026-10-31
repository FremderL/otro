'use strict';

// Grada del Estadio — moderación opt-in por votación.
//
// Regla de producto: la charla de la grada se censura como el resto del casino
// (server.js aplica `censorProfanity`). Pero en un partido los espectadores
// pueden PEDIR una votación: si la mayoría de los que están en la grada acepta,
// ese partido entra en "grada picante" y los tacos se publican tal cual, sin
// asteriscos. La autorización es por partido, caduca con el partido y se puede
// cerrar en cualquier momento por mayoría (revocación).
//
// Límites que la votación NO levanta, nunca:
//   · Los insultos dirigidos a grupos protegidos (discriminación, acoso) siguen
//     censurados aunque la grada vote a favor: la votación habilita tacos, no
//     agresiones. Ver HARD_BLOCKED.
//   · El texto sigue limpio de `<`/`>` (nunca HTML), con tope de longitud y sin
//     saltos de línea.
//
// El módulo no conoce Socket.IO: recibe identidad ya resuelta (`profileId`) y el
// instante (`at`), así que se prueba en aislamiento y se cablea en sockets.js.

const DEFAULT_QUORUM = 3;                 // votos a favor mínimos para habilitar
const DEFAULT_WINDOW_MS = 90 * 1000;      // duración de la votación
const DEFAULT_REOPEN_MS = 2 * 60 * 1000;  // espera antes de repetir una votación fallida
const MAX_TEXT = 120;

// Términos que nunca se publican, vote lo que vote la grada. Lista corta y
// conservadora: solo términos de odio/discriminación evidentes, para que la
// "grada picante" no se convierta en una puerta para acosar a nadie.
const HARD_BLOCKED = [
  'sudaca', 'sudacas', 'indio de mierda', 'indios de mierda', 'negro de mierda',
  'maricón de mierda', 'puto de mierda', 'retrasado', 'retrasada', 'mongólico',
  'nazi', 'nazis', 'sidoso', 'silosa', 'muérete', 'matate', 'mátate'
];

const HARD_BLOCKED_PATTERN = new RegExp(
  `(^|[^\\p{L}\\p{N}_])(${HARD_BLOCKED.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^\\p{L}\\p{N}_])`,
  'giu'
);

// ¿El texto pide algo que ni la votación permite?
function hasBlockedSlur(text) {
  HARD_BLOCKED_PATTERN.lastIndex = 0;
  return HARD_BLOCKED_PATTERN.test(String(text || ''));
}

// Limpieza común a todos los mensajes de la grada: sin HTML, sin saltos de
// línea, sin espacios repetidos y con tope de longitud.
function cleanChatText(value) {
  return String(value == null ? '' : value)
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

// Sustituye por asteriscos los términos bloqueados (misma longitud que la
// palabra encontrada, igual que hace el censor del casino).
function censorBlockedSlurs(text) {
  return String(text || '').replace(HARD_BLOCKED_PATTERN, (match, prefix, word) => `${prefix}${'*'.repeat([...word].length)}`);
}

function createStands(store, options = {}) {
  void store;
  const now = options.now || (() => Date.now());
  const quorum = Math.max(1, Number(options.quorum) || DEFAULT_QUORUM);
  const windowMs = Math.max(1000, Number(options.windowMs) || DEFAULT_WINDOW_MS);
  const reopenMs = Math.max(0, Number(options.reopenMs == null ? DEFAULT_REOPEN_MS : options.reopenMs));
  const log = options.log || (() => {});

  const rooms = new Map(); // matchId → estado interno

  function blank(matchId) {
    return {
      matchId,
      status: 'idle',            // idle | open | allowed | rejected
      votes: new Map(),          // profileId → true (permite) | false (no permite)
      openedAt: null,
      closesAt: null,
      closesVotesAt: null,
      allowedAt: null,
      expiresAt: null,
      rejectedAt: null,
      openedBy: null
    };
  }

  function room(matchId) {
    const key = String(matchId || '');
    if (!key) return null;
    let current = rooms.get(key);
    if (!current) { current = blank(key); rooms.set(key, current); }
    return current;
  }

  function tally(current) {
    let yes = 0;
    let no = 0;
    for (const value of current.votes.values()) { if (value) yes++; else no++; }
    return { yes, no, total: yes + no };
  }

  function publicState(current, profileId = null) {
    if (!current) return null;
    const counts = tally(current);
    const vote = profileId == null ? null : current.votes.get(String(profileId));
    return {
      matchId: current.matchId,
      status: current.status,
      quorum,
      windowMs,
      allowsInsults: current.status === 'allowed',
      votes: { yes: counts.yes, no: counts.no, total: counts.total },
      yourVote: vote === true ? 'si' : vote === false ? 'no' : null,
      openedAt: current.openedAt,
      closesAt: current.closesAt,
      approvedAt: current.allowedAt,
      expiresAt: current.expiresAt,
      rejectedAt: current.rejectedAt
    };
  }

  function allowsInsults(matchId, atMs = now()) {
    const current = rooms.get(String(matchId || ''));
    if (!current || current.status !== 'allowed') return false;
    if (current.expiresAt != null && atMs >= current.expiresAt) return false;
    return true;
  }

  // Abre una votación. Solo mientras el partido está en juego (`expiresAt` lo
  // fija quien llama con el final del partido) y sin votación vigente.
  function openVote({ matchId, profileId, expiresAt = null, atMs = now() }) {
    const current = room(matchId);
    if (!current) return { ok: false, code: 'match_requerido' };
    if (current.status === 'allowed') return { ok: false, code: 'ya_permitido' };
    if (current.status === 'open' && atMs < current.closesAt) return { ok: false, code: 'votacion_en_curso' };
    if (current.rejectedAt != null && atMs - current.rejectedAt < reopenMs) {
      return { ok: false, code: 'espera_para_repetir' };
    }
    current.status = 'open';
    current.votes = new Map();
    current.openedAt = atMs;
    current.closesAt = atMs + windowMs;
    current.allowedAt = null;
    current.rejectedAt = null;
    current.expiresAt = expiresAt;
    current.openedBy = profileId == null ? null : String(profileId);
    log('football_stands_vote_open', { matchId: current.matchId, quorum, windowMs });
    return { ok: true, state: current };
  }

  function castVote({ matchId, profileId, allow, atMs = now() }) {
    const current = rooms.get(String(matchId || ''));
    if (!current || current.status !== 'open') return { ok: false, code: 'sin_votacion' };
    if (atMs >= current.closesAt) {
      current.status = 'rejected';
      current.rejectedAt = atMs;
      return { ok: false, code: 'votacion_cerrada', state: current };
    }
    const key = String(profileId || '');
    if (!key) return { ok: false, code: 'no_identity' };
    if (current.votes.has(key)) return { ok: false, code: 'ya_votaste', state: current };
    current.votes.set(key, Boolean(allow));
    const counts = tally(current);
    if (counts.yes >= quorum && counts.yes > counts.no) {
      current.status = 'allowed';
      current.allowedAt = atMs;
      current.closesAt = atMs;
      log('football_stands_vote_passed', { matchId: current.matchId, yes: counts.yes, no: counts.no });
    } else if (counts.no >= quorum && counts.no > counts.yes) {
      // Mayoría suficiente en contra: se cierra en el acto, sin esperar la ventana.
      current.status = 'rejected';
      current.rejectedAt = atMs;
      current.closesAt = atMs;
      log('football_stands_vote_rejected', { matchId: current.matchId, yes: counts.yes, no: counts.no });
    }
    return { ok: true, state: current };
  }

  // Cierra por tiempo la votación vencida (la llama el barrido del partido).
  function sweep(matchId, atMs = now()) {
    const current = rooms.get(String(matchId || ''));
    if (!current) return null;
    if (current.status === 'open' && atMs >= current.closesAt) {
      current.status = 'rejected';
      current.rejectedAt = atMs;
      log('football_stands_vote_expired', { matchId: current.matchId, ...tally(current) });
    }
    if (current.status === 'allowed' && current.expiresAt != null && atMs >= current.expiresAt) {
      current.status = 'idle';
      current.allowedAt = null;
      current.votes = new Map();
    }
    return current;
  }

  function forget(matchId) { rooms.delete(String(matchId || '')); }

  // Texto listo para publicar. `censored` es el limpiador del casino (con
  // `censorProfanity`); si la grada habilitó los insultos se usa el texto limpio
  // y solo se censuran los términos que la votación nunca levanta.
  function composeText(raw, { matchId, atMs = now(), censored }) {
    const clean = cleanChatText(raw);
    if (!clean) return '';
    if (allowsInsults(matchId, atMs) && !hasBlockedSlur(clean)) return clean;
    const safe = censorBlockedSlurs(clean);
    return typeof censored === 'function' ? censored(safe) : safe;
  }

  return {
    quorum, windowMs,
    stateFor: (matchId, profileId = null) => publicState(rooms.get(String(matchId || '')), profileId),
    openVote, castVote, sweep, forget, allowsInsults, composeText,
    publicState
  };
}

module.exports = {
  createStands,
  cleanChatText,
  censorBlockedSlurs,
  hasBlockedSlur,
  DEFAULT_QUORUM,
  DEFAULT_WINDOW_MS
};
