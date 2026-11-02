'use strict';

// Previa de los comentaristas (§9): «unos minutos antes del partido».
//
// En el fútbol real la cabina abre antes del saque inicial: narrador y analista
// conversan —ida y vuelta— sobre el partido que se va a jugar (cómo llegan los
// equipos, la tabla, el mercado y el pronóstico). Este módulo produce esa
// conversación con los MISMOS datos autoritativos que después alimentan el
// relato del partido:
//   · la temporada persistida (tabla y calendario), solo hechos YA asentados;
//   · las plantillas y la pizarra resuelta del DT (goles, formación, estilo);
//   · el mercado 1X2 pre-partido que ve el público en la casa de apuestas.
//
// Reglas que respeta:
//   · Causalidad estricta: nunca anuncia un resultado ni usa un partido que aún
//     no se ha asentado (`settledAt <= ahora`).
//   · Determinismo: el guion se sortea con `mulberry32(hash32(seed|previa))`, no
//     con Math.random, así el mismo partido genera la misma previa en cualquier
//     réplica (auditable, como el resto del Estadio).
//   · Límite de 140 caracteres por intervención (MAX_LEN del relato).
//   · Dos voces alternadas: cada bloque es un ida y vuelta narrador → analista.
//
// La emisión la hace `createPregameRunner`: una intervención cada pocos segundos
// durante la ventana previa, reutilizando la tubería de `football:commentary`
// (y el anillo del relato), así quien entra tarde a la previa la sigue leyendo.

const { mulberry32, hash32 } = require('./prng');
const { truncate } = require('./commentary');
const { resolveClubTactics } = require('./managers');
const { clubRoster } = require('./roster');
const { CLUB_BY_ID } = require('./teams');
const { CASINO_TIME_ZONE } = require('../football-store-shared');

const PREGAME_LEAD_MS = 6 * 60 * 1000;   // la previa arranca 6 minutos antes
const PREGAME_STEP_MS = 14 * 1000;       // pausa mínima entre intervenciones
const PREGAME_MAX_HOLD_MS = 26000;       // pausa máxima (líneas largas)

const STYLE_LABEL = {
  possession: 'posesión',
  pressing: 'presión alta',
  direct: 'juego directo',
  counter: 'contragolpe',
  balanced: 'juego equilibrado'
};
const FORM_LETTER = { W: 'victoria', D: 'empate', L: 'derrota' };

function styleLabel(style) {
  return STYLE_LABEL[style] || 'juego equilibrado';
}

// «2 victorias, 1 empate y 2 derrotas» — el resumen legible de la forma reciente
// (la tabla guarda las últimas cinco letras W/D/L).
function formText(form) {
  const letters = (Array.isArray(form) ? form : []).filter(letter => FORM_LETTER[letter]);
  if (!letters.length) return '';
  const counts = { W: 0, D: 0, L: 0 };
  for (const letter of letters) counts[letter] += 1;
  const part = (n, singular, plural) => (n === 1 ? `1 ${singular}` : `${n} ${plural}`);
  const pieces = [];
  if (counts.W) pieces.push(part(counts.W, FORM_LETTER.W, 'victorias'));
  if (counts.D) pieces.push(part(counts.D, FORM_LETTER.D, 'empates'));
  if (counts.L) pieces.push(part(counts.L, FORM_LETTER.L, 'derrotas'));
  if (pieces.length === 1) return pieces[0];
  return `${pieces.slice(0, -1).join(', ')} y ${pieces[pieces.length - 1]}`;
}

// Posición en la tabla con el sufijo correcto en español (1.º, 4.º, 12.º).
function ordinal(position) {
  return Number.isFinite(position) && position > 0 ? `${position}.º` : '';
}

function zoneText(position) {
  if (!Number.isFinite(position)) return '';
  if (position <= 2) return 'pelea por el liderato';
  if (position <= 4) return 'se mantiene en la zona alta';
  if (position <= 8) return 'marcha en la zona media';
  return 'necesita sumar para no despegarse';
}

// Hora local del casino (el Estadio no usa la hora del servidor en pantalla).
function kickoffClock(kickoffAt) {
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: CASINO_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(kickoffAt));
  } catch (_) {
    return '';
  }
}

function greetingFor(kickoffAt) {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: CASINO_TIME_ZONE, hour: '2-digit', hour12: false
    }).format(new Date(kickoffAt)));
    if (hour >= 6 && hour < 12) return 'Buenos días';
    if (hour >= 12 && hour < 20) return 'Buenas tardes';
    return 'Buenas noches';
  } catch (_) {
    return 'Bienvenidos';
  }
}

// Datos del mercado 1X2 pre-partido, ya resueltos a tres cuotas y probabilidades.
function marketSummary(market) {
  if (!market || !Array.isArray(market.selections)) return null;
  const pick = key => market.selections.find(item => item && item.key === key) || null;
  const home = pick('home');
  const draw = pick('draw');
  const away = pick('away');
  if (!home || !draw || !away) return null;
  const price = item => (Number.isFinite(Number(item.price)) ? Number(item.price).toFixed(2) : '');
  // El mercado publica `prob` (probabilidad del modelo) e `implied` (la que
  // descuenta la cuota con margen). Se prefiere la del modelo y se cae a la
  // implícita si algún mercado solo trae esa.
  const prob = item => {
    if (Number.isFinite(Number(item.prob))) return Math.round(Number(item.prob) * 100);
    if (Number.isFinite(Number(item.implied))) return Math.round(Number(item.implied) * 100);
    return null;
  };
  return {
    home: { price: price(home), prob: prob(home) },
    draw: { price: price(draw), prob: prob(draw) },
    away: { price: price(away), prob: prob(away) }
  };
}

// Pronóstico de la cabina: sale del mercado (no de una moneda al aire) para que
// el analista no contradiga las cuotas que el público está viendo, y el marcador
// exacto se sortea de forma determinista dentro de la lógica del favorito.
function forecastOf(market, random) {
  if (!market) return '';
  const candidates = [
    { key: 'home', prob: market.home.prob || 0 },
    { key: 'draw', prob: market.draw.prob || 0 },
    { key: 'away', prob: market.away.prob || 0 }
  ].sort((a, b) => b.prob - a.prob);
  const favorite = candidates[0];
  if (!favorite.prob) return '';
  if (favorite.key === 'draw') return '1-1';
  const scores = ['1-0', '2-0', '2-1', '3-1'];
  return favorite.key === 'home' ? scores[Math.floor(random() * scores.length)] : scores[Math.floor(random() * scores.length)].split('-').reverse().join('-');
}

// Goleador del club según los acumulados ya asentados (nunca la plantilla
// futura). Se exige cierta evidencia: 2 goles o más y que el reparto esté
// completo (clubRoster descarta partidos con datos incompletos).
function topScorer(league, clubId) {
  let roster = null;
  try { roster = clubRoster(league, clubId); } catch (_) { return null; }
  if (!roster || !Array.isArray(roster.players)) return null;
  const best = roster.players
    .filter(player => player.stats && player.stats.goals >= 2)
    .sort((a, b) => (b.stats.goals - a.stats.goals) || String(a.name).localeCompare(String(b.name)))[0];
  return best ? { name: best.name, goals: best.stats.goals } : null;
}

function tacticsOf(club, league, asOf) {
  try { return resolveClubTactics(club, league, asOf); } catch (_) { return null; }
}

// Construye el guion de la previa (array de { voice, text }) a partir de los
// datos ya resueltos. Es puro: mismas entradas + misma seed ⇒ mismo guion.
function buildPregameScript(context = {}) {
  const { match, league, home, away, homeRow, awayRow, homePosition, awayPosition, market, asOf = 0 } = context;
  if (!match || !home || !away) return [];
  const random = mulberry32(hash32(`${match.seed}|previa|${match.id}`));
  const lines = [];
  const say = (voice, text) => {
    const clean = truncate(text);
    if (clean) lines.push({ voice, text: clean });
  };
  const clock = kickoffClock(match.scheduledKickoffAt);
  const greeting = greetingFor(match.scheduledKickoffAt);
  const homeName = home.name || CLUB_BY_ID[match.homeId]?.name || 'el local';
  const awayName = away.name || CLUB_BY_ID[match.awayId]?.name || 'la visita';
  const stadium = home.stadium || CLUB_BY_ID[match.homeId]?.stadium || 'el estadio';
  const homeTactics = tacticsOf(home, league, asOf);
  const awayTactics = tacticsOf(away, league, asOf);
  const quotes = marketSummary(market);
  const prediction = forecastOf(quotes, random);
  const homeScorer = topScorer(league, match.homeId);
  const awayScorer = topScorer(league, match.awayId);
  const attendance = Number(home.capacity) > 0 ? `${Number(home.capacity).toLocaleString('es-MX')} localidades` : '';

  // 1) Bienvenida y tabla.
  const jornada = Number.isFinite(match.jornada) ? ` por la jornada ${match.jornada}` : '';
  say('narrador', `${greeting} desde ${stadium}. En unos minutos, ${homeName} recibe a ${awayName}${jornada}.`);
  // La tabla solo se cita cuando hay partidos jugados: al arrancar la temporada
  // todas las posiciones se deciden por desempate y decir «10.º con 0 puntos»
  // sería un dato vacío (o directamente confuso).
  const tableReady = Number.isFinite(homePosition) && Number.isFinite(awayPosition)
    && Number(homeRow?.played) > 0 && Number(awayRow?.played) > 0;
  say('analista', tableReady
    ? `En la tabla, ${homeName} es ${ordinal(homePosition)} con ${homeRow.points} puntos y ${awayName}, ${ordinal(awayPosition)} con ${awayRow.points}.`
    : `La temporada está por jugarse: ${homeName} y ${awayName} abren hoy su camino en la tabla.`);

  // 2) Cómo llegan: forma reciente y balance de goles.
  const homeForm = formText(homeRow?.form);
  const awayForm = formText(awayRow?.form);
  say('narrador', homeForm && awayForm
    ? `¿Cómo llegan? ${homeName} suma ${homeForm} en sus últimos partidos; ${awayName}, ${awayForm}.`
    : `Ambos llegan con la temporada recién arrancada: poco rodaje y todo por definir.`);
  say('analista', homeRow && awayRow && homeRow.played > 0
    ? `${homeName} lleva ${homeRow.goalsFor} goles a favor y ${homeRow.goalsAgainst} en contra en ${homeRow.played} partidos; ${awayName}, ${awayRow.goalsFor} y ${awayRow.goalsAgainst} en ${awayRow.played}.`
    : `Sin partidos previos no hay goles que analizar: la temporada empieza aquí mismo.`);

  // 3) Mercado y pronóstico.
  if (quotes) {
    const entries = [
      { name: homeName, ...quotes.home },
      { name: 'el empate', ...quotes.draw },
      { name: awayName, ...quotes.away }
    ].sort((a, b) => (b.prob || 0) - (a.prob || 0));
    const favourite = entries[0];
    say('narrador', `En el mercado, ${favourite.name} manda: ${favourite.prob}% de probabilidad y cuota ${favourite.price}.`);
    say('analista', `El empate paga ${quotes.draw.price} y ${awayName} está a ${quotes.away.price}. ¿Te animas con un pronóstico?`);
  }
  if (prediction) {
    const homeStyle = styleLabel(homeTactics?.style || home.tactics?.style);
    say('narrador', `Me la juego por un ${prediction}: ${homeName} con ${homeTactics?.formation || home.tactics?.formation || 'su once'} y ${homeStyle}.`);
    say('analista', `${awayName} responde con ${awayTactics?.formation || away.tactics?.formation || 'su dibujo'} y ${styleLabel(awayTactics?.style || away.tactics?.style)}; ahí se decide el partido.`);
  } else {
    say('narrador', `${homeName} se para con ${homeTactics?.formation || home.tactics?.formation || 'su once'} y ${styleLabel(homeTactics?.style || home.tactics?.style)}.`);
    say('analista', `${awayName} responde con ${awayTactics?.formation || away.tactics?.formation || 'su dibujo'} y ${styleLabel(awayTactics?.style || away.tactics?.style)}.`);
  }

  // 4) Duelo táctico de los banquillos.
  // `managerOfClub` devuelve un DT genérico («Dirección Técnica») cuando el club
  // todavía no tiene banquillo resuelto: en ese caso no se inventa un nombre.
  const named = name => Boolean(name) && name !== 'Dirección Técnica';
  const homeCoach = homeTactics?.manager?.name;
  const awayCoach = awayTactics?.manager?.name;
  if (named(homeCoach) && named(awayCoach)) {
    say('narrador', `En los banquillos, ${homeCoach} contra ${awayCoach}. ${zoneText(homePosition) ? `${homeName} ${zoneText(homePosition)}.` : ''}`.trim());
    say('analista', `${awayCoach} suele ajustar después del descanso; ${awayName} ${zoneText(awayPosition) || 'quiere puntos'} y no va a regalar la salida.`);
  }

  // 5) Jugadores a seguir (solo con goles ya asentados).
  if (homeScorer || awayScorer) {
    say('narrador', homeScorer
      ? `Atención a ${homeScorer.name}: ${homeScorer.goals} goles con ${homeName} en lo que va de temporada.`
      : `${stadium} quiere ver a los suyos: ${homeName} aún no tiene un goleador consolidado.`);
    say('analista', awayScorer
      ? `Y del otro lado, ${awayScorer.name} lleva ${awayScorer.goals} con ${awayName}; la defensa local no puede perderlo.`
      : `${awayName} reparte el gol entre varios; la marca tiene que ser colectiva.`);
  }

  // 6) Cierre: hora, estadio y saque inicial.
  if (clock) say('narrador', `Todo listo: ${homeName}–${awayName}, ${clock} en ${stadium}${attendance ? `, con ${attendance}` : ''}.`);
  say('analista', quotes
    ? `Las cuotas siguen abiertas hasta el saque inicial. Mi lectura: ${prediction ? `un ${prediction} para ${homeName}` : 'partido cerrado, de detalles'}.`
    : `Falta muy poco para el saque inicial. Mi lectura: ${prediction ? `un ${prediction} para ${homeName}` : 'partido cerrado, de detalles'}.`);
  say('narrador', `¡Nos vamos al saque inicial en ${stadium}!`);
  say('analista', 'Que ruede el balón.');
  return lines;
}

// Reúne del store todo lo que el guion necesita, sin inventar nada: solo la
// temporada en curso, sus clubes, la tabla ya calculada y el mercado publicado.
function contextFor(match, { store, getMarket, asOf }) {
  let league = null;
  try { league = store?.getLeague?.(match.seasonMonth) || store?.getLeague?.() || null; } catch (_) { return null; }
  if (!league) return null;
  const clubFor = id => (league.config || []).find(club => club && club.id === id) || null;
  const home = clubFor(match.homeId);
  const away = clubFor(match.awayId);
  if (!home || !away) return null;
  const rows = Array.isArray(league.standings) ? league.standings : [];
  const positionFor = id => {
    const index = rows.findIndex(row => row && row.teamId === id);
    return index >= 0 ? index + 1 : null;
  };
  let market = null;
  try { market = getMarket ? getMarket(match) : null; } catch (_) { market = null; }
  return {
    match, league, home, away,
    homeRow: rows.find(row => row && row.teamId === match.homeId) || null,
    awayRow: rows.find(row => row && row.teamId === match.awayId) || null,
    homePosition: positionFor(match.homeId),
    awayPosition: positionFor(match.awayId),
    market, asOf
  };
}

// Pausa entre intervenciones: proporcional a lo que tarda en leerse una línea
// (las cortas se suceden rápido; las largas dejan respirar la cabina).
function holdFor(line) {
  const length = String(line?.text || '').length;
  return Math.min(PREGAME_MAX_HOLD_MS, PREGAME_STEP_MS + length * 70);
}

// Runner de la previa. Mantiene una sesión por partido (sin timers propios: la
// llama el barrido del scheduler) y entrega cada intervención por `emit`.
//   · emit(match, line, at)  — publica una línea en la sala del partido.
//   · getMarket(match)       — mercado 1X2 pre-partido (puede faltar).
function createPregameRunner({ store, getMarket = () => null, emit = () => {}, now = () => Date.now(), log = () => {} } = {}) {
  const sessions = new Map(); // matchId → { lines, index, nextAt, kickoffAt }

  function candidates(at) {
    let league = null;
    try { league = store?.getLeague?.() || null; } catch (_) { return []; }
    const matches = league?.calendar?.matches || [];
    return matches.filter(match => match && match.status === 'scheduled'
      && Number.isFinite(match.scheduledKickoffAt)
      && match.scheduledKickoffAt > at
      && match.scheduledKickoffAt - at <= PREGAME_LEAD_MS
      && !match.autoReschedulePending);
  }

  function tick(at = now()) {
    const matches = candidates(at);
    const active = new Set(matches.map(match => match.id));
    // Un partido que arrancó, se reprogramó o desapareció cierra su sesión: si
    // vuelve a entrar en ventana (reprogramación) empezará una previa nueva.
    for (const matchId of [...sessions.keys()]) if (!active.has(matchId)) sessions.delete(matchId);

    for (const match of matches) {
      let session = sessions.get(match.id);
      if (!session) {
        const context = contextFor(match, { store, getMarket, asOf: at });
        const lines = context ? buildPregameScript(context) : [];
        if (!lines.length) continue;
        session = { lines, index: 0, nextAt: at, kickoffAt: match.scheduledKickoffAt };
        sessions.set(match.id, session);
      }
      // Una sola intervención por vuelta como máximo: la conversación no se
      // atropella aunque el proceso haya estado dormido varios minutos.
      if (session.index >= session.lines.length || at < session.nextAt) continue;
      const line = session.lines[session.index];
      session.index += 1;
      session.nextAt = at + holdFor(line);
      try {
        emit(match, line, at);
      } catch (error) {
        log('football_pregame_emit_error', { match: match.id, message: String(error?.message || error) });
      }
    }
    return { matches: matches.length, sessions: sessions.size };
  }

  return {
    tick,
    forget(matchId) { sessions.delete(matchId); },
    sessions,
    activeFor(matchId) { return sessions.get(matchId) || null; }
  };
}

module.exports = {
  PREGAME_LEAD_MS,
  PREGAME_STEP_MS,
  PREGAME_MAX_HOLD_MS,
  STYLE_LABEL,
  styleLabel,
  formText,
  ordinal,
  kickoffClock,
  marketSummary,
  forecastOf,
  buildPregameScript,
  contextFor,
  createPregameRunner,
  holdFor
};
