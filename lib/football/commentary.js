'use strict';

// Fase B — Comentaristas (§9).
//
// Dos voces generadas EN EL SERVIDOR y persistidas en la línea de tiempo, para
// que todos los espectadores lean el mismo relato y el partido sea reproducible
// en auditoría (§3.2):
//   · narrador — play-by-play, exclamativo, presente, frases cortas. Habla en
//     cada evento relevante.
//   · analista — táctica y contexto, sobrio, con datos. Habla en ~35 % de los
//     eventos y SIEMPRE tras gol, expulsión, penal y en el descanso/final.
//
// Reglas de calidad que implementa este módulo (§9):
//   · Memoria anti-repetición: se recuerdan las últimas 3 plantillas usadas por
//     (tipo, voz) y se excluyen de la siguiente elección. Con 5-8 plantillas por
//     tipo, la repetición inmediata es imposible (T-prueba de relato).
//   · Límite de 140 caracteres por mensaje: el panel no se desborda.
//   · Intensidad contextual: los goles después del 80' reciben doble mensaje.
//   · Sin entrada de usuario: las plantillas solo interpolan datos del servidor
//     (clubes y jugadores ficticios).

const { randInt } = require('./prng');

const MAX_LEN = 140;            // límite duro por mensaje (§9)
const MEMORY = 3;               // plantillas recordadas por (tipo, voz)
const ANALIST_BASE_RATE = 0.35; // el analista habla en ~35 % de los eventos (§9)

// --- Plantillas por tipo de evento (§9) ---
// Variables: {jugador} {equipo} {rival} {minuto} {marcador} {estadio} {goles}
//            {xgFavor} {xg} {posesion} {tiros} {equipoRival} {puestoRival} {asistencia}
const POOLS = {
  kickoff: {
    narrador: [
      '¡Rueda el balón en el {estadio}! {equipo} recibe a {rival}.',
      '¡Arranca el partido! {equipo} y {rival} ya se miden en el {estadio}.',
      'Comienza el juego en el {estadio}: {equipo} ante {rival}.',
      '¡Pita el árbitro! {equipo} pone la bola en movimiento frente a {rival}.',
      '¡ARRANCA EL PARTIDO! {equipo} y {rival} se juegan la vida en el {estadio}.',
      'Se juega en el {estadio}. {equipo} contra {rival}, en marcha.'
    ],
    analista: [
      '{equipo} llega con {posesion} de posesión media; {rival} apuesta al contragolpe.',
      'Duelo de estilos: {equipo} propone, {rival} espera su momento.',
      'Los primeros minutos definirán el ritmo; {rival} suele crecer con el balón.'
    ]
  },
  goal: {
    narrador: [
      '¡GOOOL de {equipo}! {jugador} la mandó a guardar al {minuto}.',
      '¡{jugador}! ¡{jugador}! Grita el {estadio}: {marcador} al {minuto}.',
      'Definición de {jugador} y {equipo} lo gana {marcador} al {minuto}.',
      '¡Gol, gol, gol! {jugador} castiga a {rival} y pone el {marcador}.',
      'Apareció {jugador}: remate imposible y {equipo} celebra el {marcador}.',
      '¡Qué gol de {jugador}! {equipo} se adelanta {marcador} al {minuto}.',
      'No perdonó {jugador} y {equipo} lo gana {marcador}.',
      'El {estadio} estalla: {jugador} firma el {marcador} al {minuto}.',
      '¡¡GOOOOL de {equipo}!! {jugador} no perdona y el {estadio} explota.',
      '¡Es gol, es gol de {jugador}! {equipo} pone el {marcador} al {minuto}.'
    ],
    analista: [
      '{jugador} vuelve a aparecer: {equipo} lo gana {marcador} y ya es su sello.',
      'El xG decía {xgFavor} para {equipo}; el fútbol no entiende de merecimientos.',
      'Asistencia de {asistencia}: {equipo} convierte la presión en rédito.',
      '{rival} queda tocado con este {marcador}; necesita reaccionar pronto.',
      'El tanto de {jugador} llega tras {posesion} de posesión de {equipo}.',
      '¡Qué definición la de {jugador}! Frío, calculado, y {equipo} celebra.'
    ]
  },
  penalty_awarded: {
    narrador: [
      '¡Penal para {equipo}! El árbitro señala el punto a los {minuto}.',
      'Falta dentro del área: penal clarísimo para {equipo} al {minuto}.',
      'El colegiado no duda y pita penal a favor de {equipo}.',
      '¡Penalti! {jugador} fue derribado en el área al {minuto}.',
      '¡PENAL! El árbitro no tiene dudas: {equipo} va a los once metros.'
    ],
    analista: [
      'El xG del penal ronda {xgFavor}; {rival} concede la ocasión más cara del fútbol.',
      'Decisión trascendental: un penal cambia el {marcador} y el ánimo.',
      '{rival} regaló el espacio; desde los once metros {equipo} no suele fallar.'
    ]
  },
  penalty_scored: {
    narrador: [
      '¡Gol desde el punto penal! {jugador} no falló y pone el {marcador}.',
      'Engañó al portero: {jugador} convierte el penal al {minuto}.',
      'Frío como el hielo, {jugador} anota el penal y {equipo} celebra.',
      '¡Dentro! {jugador} fusila al portero y firma el {marcador}.',
      '¡GOOOL DESDE EL PUNTO! {jugador} no tiembla y pone el {marcador}.'
    ],
    analista: [
      'Conversión limpia de {jugador}; el {marcador} castiga a {rival}.',
      'El penal suma {xgFavor} de xG; {equipo} capitaliza la ocasión clara.',
      '{rival} pagó caro el penal en contra: {marcador} al {minuto}.'
    ]
  },
  penalty_missed: {
    narrador: [
      'El penal de {jugador} {resultado}; sigue {marcador} al {minuto}.',
      '¡Penal fallado! El remate de {jugador} {resultado}.',
      'No cambia el {marcador}: el cobro de {jugador} {resultado}.'
    ],
    analista: [
      '{equipo} mereció más: xG de {xgFavor} pero el penal se fue sin premio.',
      'Ocasión inmejorable desperdiciada; {rival} respira con el {marcador}.',
      'El fallo desde los once metros puede pesar en el tramo final.'
    ]
  },
  yellow_card: {
    narrador: [
      'Amarilla para {jugador}. Llegó tarde y el árbitro no dudó al {minuto}.',
      'El colegiado amonesta a {jugador} por la falta sobre {rival}.',
      'Tarjeta amarilla para {jugador} de {equipo} al {minuto}.',
      'Entrada dura de {jugador}: se gana la amarilla.',
      '¡Ya se encendió el partido! Amarilla para {jugador} tras una entrada pasada de revoluciones.'
    ],
    analista: [
      '{jugador} queda condicionado: muchos minutos por delante con una amarilla.',
      'La amonestación limita la agresividad de {jugador} en la presión.',
      'Falta táctica cortada; {equipo} frena el contragolpe de {rival}.'
    ]
  },
  red_card: {
    narrador: [
      '¡Roja directa! {jugador} se va expulsado al {minuto} y {equipo} queda con diez.',
      'El árbitro expulsa a {jugador}: entrada violenta y {equipo} con uno menos.',
      'Tarjeta roja para {jugador}. {equipo} jugará el resto en inferioridad.',
      'No lo podía creer el {estadio}: {jugador} deja a {equipo} con diez al {minuto}.',
      '¡Expulsado! {jugador} se va al vestuario al {minuto} y el {estadio} no lo cree.'
    ],
    analista: [
      'Inferioridad numérica que castiga a {equipo}: {posesion} con uno menos será duro.',
      'La roja a {jugador} cambia el plan de {equipo} para el tramo final.',
      '{rival} tiene ahora espacio de sobra contra diez de {equipo}.'
    ]
  },
  second_yellow: {
    narrador: [
      'Segunda amarilla para {jugador} y roja automática: {equipo} con diez al {minuto}.',
      'No midió {jugador}: doble amonestación y a la calle.',
      'El árbitro le muestra la segunda amarilla a {jugador} y lo expulsa.'
    ],
    analista: [
      'Expulsión evitable de {jugador}; {equipo} pierde a un titular y el orden.',
      'La doble amarilla deja a {equipo} en inferioridad cuando más apretaba {rival}.'
    ]
  },
  substitution: {
    narrador: [
      'Cambio en {equipo}: {jugador} entra por {sale} al {minuto}.',
      'Mueve el banquillo {equipo}; {jugador} sustituye a {sale}.',
      'Sustitución en {equipo}: sale {sale}, entra {jugador}.'
    ],
    analista: [
      '{equipo} busca frescura con {jugador}; el marcador va {marcador}.',
      'Relevo táctico: {jugador} entra a cambiar el {marcador} contra {rival}.',
      'Con {posesion} de posesión, {equipo} refresca la mediapunta.'
    ]
  },
  shot_on_target: {
    narrador: [
      'Disparo de {jugador} a puerta al {minuto}; el {marcador} sigue igual.',
      'Remate de {jugador} que obliga a la defensa de {rival} a reaccionar.',
      '{jugador} encuentra espacio y prueba al arco al {minuto}.',
      '¡Chispazo de {jugador}! Dispara con fuerza y obliga al arquero de {rival} a estirarse.'
    ],
    analista: [
      '{equipo} acumula {tiros} tiros; el xG de la jugada ronda {xg}.',
      'Buena intención de {jugador}, aunque el xG de ese disparo es bajo.',
      '{rival} concede espacios; {equipo} llega con peligro al {marcador}.'
    ]
  },
  save: {
    narrador: [
      '¡Gran atajada! El portero de {equipo} salva a los {minuto}.',
      'Mano firme del guardameta de {equipo} para negar el gol a {rival}.',
      'Responde el arquero de {equipo} y mantiene el {marcador}.',
      '¡Qué atajada! El arquero de {equipo} vuela y saca el balón al {minuto}.'
    ],
    analista: [
      'Intervención clave que sostiene el {marcador} para {equipo}.',
      'El xG de la ocasión de {rival} era alto; la atajada vale puntos.'
    ]
  },
  corner: {
    narrador: [
      'Córner para {equipo} al {minuto}; suben los centrales.',
      'Saque de esquina a favor de {equipo} tras el despeje de {rival}.',
      'La pelota se va por la línea de fondo: córner para {equipo}.',
      '¡Córner! {equipo} empuja y el área de {rival} se llena de camisetas.'
    ],
    analista: [
      'Balón parado, arma de {equipo} con {posesion} de dominio.',
      '{equipo} genera peligro a balón parado; {rival} debe marcar al hombre.'
    ]
  },
  foul: {
    narrador: [
      'Falta de {jugador} sobre {rival} al {minuto}; tiro libre peligroso.',
      'El árbitro detiene el juego por infracción de {jugador}.',
      'Entrada de {jugador} y falta señalada a favor de {rival}.'
    ]
  },
  offside: {
    narrador: [
      'Fuera de juego de {jugador}; se anula la jugada de {equipo} al {minuto}.',
      'Posición adelantada de {jugador} y el línea levanta la bandera.',
      'Offside de {jugador}: {equipo} pierde una llegada clara.'
    ]
  },
  big_chance: {
    narrador: [
      '¡Ocasión clarísima! {jugador} se planta solo pero {rival} resiste al {minuto}.',
      'Error defensivo y {jugador} roza el gol: perdona {equipo}.',
      'Mano a mano de {jugador} que se marcha rozando el palo.',
      '¡UFFF! {jugador} solo frente al arquero… ¡y la desperdicia!'
    ],
    analista: [
      'xG altísimo en esa acción de {jugador}; no convertir duele con el {marcador}.',
      '{equipo} deja viva una ocasión de {xgFavor} de xG; {rival} sobrevive.'
    ]
  },
  goal_disallowed: {
    narrador: [
      'Gol anulado a {jugador} por fuera de juego; {equipo} lo celebró en vano al {minuto}.',
      'El árbitro invalida el tanto de {jugador} tras revisar la jugada.'
    ],
    analista: [
      'Decisión milimétrica que mantiene el {marcador} para {rival}.',
      'El gol de {jugador} no sube: {equipo} sigue buscando el {marcador}.'
    ]
  },
  injury: {
    narrador: [
      'Queda tendido {jugador}; entran las asistencias de {equipo} al {minuto}.',
      '{jugador} se duele tras la caída; el juego se detiene momentáneamente.'
    ]
  },
  halftime: {
    narrador: [
      'Descanso en el {estadio}: {equipo} y {rival} se van {marcador}.',
      'Final del primer tiempo. {marcador} entre {equipo} y {rival}.',
      'El árbitro pita el intermedio con {marcador} en el {estadio}.',
      '¡Se acaba el primer tiempo! {marcador} en el {estadio}, y la gente no para de cantar.'
    ],
    analista: [
      'Balance al descanso: {posesion} para {equipo}, {tiros} tiros y xG de {xg}.',
      '{rival} fue más incisivo en la primera parte; {marcador} lo refleja a medias.',
      'Con este {marcador}, {equipo} debe ajustar la salida de balón.'
    ]
  },
  second_half: {
    narrador: [
      '¡Se reanuda el juego! {equipo} y {rival} buscan el {marcador}.',
      'Comienza el segundo tiempo en el {estadio}: sigue {marcador}.',
      'Vuelve a rodar la pelota tras el descanso; {marcador} en el {estadio}.'
    ],
    analista: [
      'Quedan 45 minutos; {rival} necesita remontar el {marcador}.',
      'El segundo tiempo arranca con {posesion} a favor de {equipo}.'
    ]
  },
  full_time: {
    narrador: [
      '¡Final del partido! {equipo} {marcador} {rival} en el {estadio}.',
      'Termina el encuentro: {marcador} entre {equipo} y {rival}.',
      'El árbitro señala el final. {equipo} y {rival} firman el {marcador}.',
      'Se acabó en el {estadio}: resultado final {marcador}.',
      '¡SE ACABÓ! {equipo} {marcador} {rival}, y el {estadio} no deja de cantar.'
    ],
    analista: [
      'Cierre con {posesion} de posesión y {tiros} tiros; el {marcador} queda sellado en el {estadio}.',
      'El {marcador} refleja lo visto en el {estadio}: no hubo margen para más.',
      'Resultado definitivo {marcador}: se cierra el telón de este encuentro.'
    ]
  },
  extra_time_start: {
    narrador: [
      '¡A la prórroga! {equipo} y {rival} empatados {marcador} juegan 30 minutos más.',
      'No hay ganador en 90: tiempo extra en el {estadio}, sigue {marcador}.'
    ],
    analista: [
      'El desempate por el título se va a la prórroga: la fatiga pesará con {marcador}.',
      'Treinta minutos extra; quien maneje el cansancio con este {marcador} gana.'
    ]
  },
  extra_time_end: {
    narrador: [
      'Final de la prórroga: {marcador} y, si sigue igual, tanda de penales.',
      'Se cumplen los 120 minutos; {equipo} y {rival} quedan {marcador}.'
    ],
    analista: [
      'La prórroga no deshizo el {marcador}: el campeón puede decidirse desde los once metros.'
    ]
  },
  shootout_start: {
    narrador: [
      '¡Tanda de penales! {equipo} y {rival} se juegan el título desde el punto fatídico.',
      'Todo se define en los penales tras el {marcador}: nervios en el {estadio}.'
    ],
    analista: [
      'Muerte súbita en ciernes: el campeón saldrá de esta tanda, no del sorteo.',
      'Cinco lanzamientos por equipo y, si persiste el empate, muerte súbita.'
    ]
  },
  shootout_kick: {
    narrador: [
      'Lanza {jugador}… ¡{resultado}! {equipo} {marcadorTanda} en la tanda.',
      'Turno de {jugador} desde los once metros: {resultado}.',
      '{jugador} frente al portero… {resultado} para {equipo}.'
    ]
  },
  shootout_end: {
    narrador: [
      '¡{equipo} campeón! Gana la tanda {marcadorTanda} tras el {marcador} en 120 minutos.',
      'Final de la tanda: {equipo} se corona {marcadorTanda} sobre {rival}.',
      'El {estadio} celebra: {equipo} campeón por penales, {marcadorTanda}.'
    ],
    analista: [
      'El título se decidió en la tanda {marcadorTanda}; {rival} cae con honor tras el {marcador}.',
      'Campeón por penales: el desempate en cancha evitó el sorteo y premió a {equipo}.'
    ]
  }
};

// --- Matices de intensidad (§9) ---
// Cuando la jugada tiene una característica que la hace especial, la narración
// usa un repertorio propio más intenso. La regla se evalúa sobre las variables
// que ya trae cada evento (minuto, resultado, xG, motivo y estilo del equipo),
// así que el motor no necesita eventos nuevos para activarla:
//   · gol_agonico   — gol desde el minuto 85 (el «gol en el último suspiro»).
//   · palo          — remate que pega en el poste/larguero (resultado «…poste»).
//   · atajada_linea — intervención de portero con xG ≥ 0.25 o rechace peligroso.
//   · falta_dura    — expulsión o amarilla por falta grave (motivo serious_foul).
//   · contragolpe   — remate o gol de un equipo de estilo «counter». El motor
//                     no modela transiciones: es una aproximación por estilo.
// El orden de NUANCE_RULES fija la prioridad: gana la primera regla que aplica.
const NUANCE_RULES = [
  { key: 'gol_agonico', types: ['goal', 'penalty_scored'], test: v => Number(v.minuto) >= 85 },
  { key: 'palo', types: ['penalty_missed', 'shot', 'shot_on_target', 'big_chance'], test: v => /poste|palo|larguero/i.test(String(v.resultado || '')) },
  { key: 'atajada_linea', types: ['save', 'shot_on_target'], test: (v, type) => type === 'save' ? Number(v.xg) >= 0.25 : /rechaz/i.test(String(v.resultado || '')) },
  { key: 'falta_dura', types: ['red_card', 'second_yellow', 'yellow_card'], test: (v, type) => type !== 'yellow_card' || v.motivo === 'serious_foul' },
  { key: 'contragolpe', types: ['shot', 'shot_on_target', 'goal', 'big_chance'], test: v => v.estilo === 'counter' }
];

const NUANCE_POOLS = {
  gol_agonico: {
    narrador: [
      '¡GOL EN EL MINUTO {minuto}! {jugador} la manda al fondo de la red y el {estadio} se viene abajo.',
      '¡Sobre la hora, {jugador}! Gol agónico de {equipo} y el {marcador} cambia todo.',
      '¡Golazo en el último suspiro! {jugador} rompe el partido al {minuto}.'
    ],
    analista: [
      'Un gol así en el {minuto} vale oro: {equipo} lo arrancó cuando nadie lo esperaba.',
      '{rival} se queda helado: el tanto agónico de {jugador} castiga cuando más resistía.'
    ]
  },
  palo: {
    narrador: [
      '¡Al palo! El cobro de {jugador} {resultado} y el {estadio} contiene la respiración.',
      '¡Madera otra vez! {jugador} {resultado} y {rival} respira de alivio.',
      '¡Qué susto! {jugador} {resultado} y el {estadio} grita con el alma en vilo.'
    ],
    analista: [
      'La madera le negó el tanto a {equipo}; con el {marcador} el partido sigue abierto.',
      'Un palo que pesa: {equipo} merecía premio y {rival} sigue con vida.'
    ]
  },
  atajada_linea: {
    narrador: [
      '¡Salvada en la línea! El arquero de {equipo} se estira y niega el gol a {rival}.',
      '¡Qué reflejos! La atajada de {equipo} sale como bala y evita el {marcador}.',
      '¡Increíble intervención! El portero de {equipo} lo saca casi sobre la raya.'
    ],
    analista: [
      'Intervención de altísimo nivel: el xG de {rival} era de {xg} y la atajada vale oro.',
      'Rechace peligroso en el área: {equipo} lo despeja como puede con el {marcador} en juego.'
    ]
  },
  falta_dura: {
    narrador: [
      '¡Qué entrada tan dura de {jugador}! El árbitro no tiene opción y saca la tarjeta.',
      '¡Patada a destiempo de {jugador} y el {estadio} protesta a gritos!',
      '¡Falta brutal de {jugador} sobre {rival}! El juego se detiene con tensión.'
    ],
    analista: [
      'La intensidad se pasó de la raya; {equipo} tendrá que replantear su defensa.',
      'La falta de {jugador} cambia el ritmo: {rival} pide justicia y el partido se calienta.'
    ]
  },
  contragolpe: {
    narrador: [
      '¡CONTRAGOLPE FULMINANTE! {equipo} sale como un rayo y {jugador} culmina la transición.',
      '¡Corren a la velocidad de la luz! Transición de {equipo} y {jugador} dispara con todo.',
      '¡Espacio a la espalda de {rival}! {jugador} lanza el contraataque y el {estadio} se pone de pie.'
    ],
    analista: [
      '{equipo} sabe castigar al espacio: transición rápida y {rival} desprotegido.',
      'Velocidad en la salida: {equipo} encontró el hueco que {rival} dejó abierto.'
    ]
  }
};

// Devuelve la clave del matiz que aplica a la jugada, o null si es normal.
function nuanceOf(type, vars) {
  if (!vars) return null;
  for (const rule of NUANCE_RULES) {
    if (rule.types.includes(type) && rule.test(vars, type)) return rule.key;
  }
  return null;
}

// Tipos para los que el relato NO genera línea propia (se cubren por el tick
// posicional o por un evento padre): evita ruido en el panel (§7.2, §9).
const SILENT_TYPES = new Set([
  'pass_sequence', 'possession_change', 'shot', 'throw_in', 'goal_kick',
  'formation_change', 'tactic_change', 'momentum_shift', 'stoppage_start'
]);

// El analista SIEMPRE habla tras estos eventos, sin importar el dado (§9).
const ALWAYS_ANALYST = new Set([
  'goal', 'red_card', 'second_yellow', 'penalty_scored', 'penalty_missed',
  'penalty_awarded', 'halftime', 'full_time', 'shootout_end'
]);

function truncate(text) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_LEN ? `${clean.slice(0, MAX_LEN - 1).trimEnd()}…` : clean;
}

function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

// Memoria anti-repetición por (tipo|voz): guarda las últimas plantillas usadas.
function createMemory() {
  return new Map();
}

// Variables que requiere una plantilla ({nombre}).
const VAR_RE = /\{(\w+)\}/g;
function requiredVars(template) {
  const out = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(template)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// Una plantilla solo es utilizable si TODAS sus variables están presentes y no
// vacías. Esto evita salidas rotas como «Asistencia de :» cuando falta el dato:
// si un gol no tuvo asistencia, simplemente se elige otra plantilla de gol.
function satisfied(template, vars) {
  return requiredVars(template).every(name => vars[name] !== undefined && vars[name] !== null && vars[name] !== '');
}

function pickTemplate(random, pool, memory, key, vars) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  // 1) Filtra a las plantillas cuyos datos están disponibles.
  let usable = vars ? pool.filter(t => satisfied(t, vars)) : pool.slice();
  // 2) Si ninguna pasa el filtro, recurre a las que no exigen variables.
  if (usable.length === 0) usable = pool.filter(t => requiredVars(t).length === 0);
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    const only = usable[0];
    memory.set(key, [only]);
    return only;
  }
  const recent = memory.get(key) || [];
  // 3) Excluye las usadas recientemente (memoria por texto, estable al filtrar).
  let candidates = usable.filter(t => !recent.includes(t));
  if (candidates.length === 0) {
    const last = recent[recent.length - 1];
    candidates = usable.filter(t => t !== last);
    if (candidates.length === 0) candidates = usable;
  }
  const chosen = candidates[randInt(random, 0, candidates.length - 1)];
  memory.set(key, [...recent, chosen].slice(-MEMORY));
  return chosen;
}

// Genera el array de comentario (0-2 líneas) para un evento. `vars` trae los
// datos del servidor ya resueltos (nombres, marcador, xG, estadio…). Devuelve
// líneas de 140 caracteres como máximo, con el analista presente según §9.
function generateCommentary(type, vars, random, memory) {
  if (SILENT_TYPES.has(type)) return [];
  const pool = POOLS[type];
  if (!pool) return [];
  const out = [];
  // Si el evento tiene un matiz (gol agónico, palo, atajada en la línea…) y sus
  // plantillas son utilizables con los datos disponibles, se usa su repertorio.
  const nuance = nuanceOf(type, vars);
  const np = nuance ? NUANCE_POOLS[nuance] : null;
  const usesNuance = (list) => Array.isArray(list) && list.length > 0 && vars && list.some(t => satisfied(t, vars));
  const narrList = np && usesNuance(np.narrador) ? np.narrador : pool.narrador;
  const anaList = np && usesNuance(np.analista) ? np.analista : pool.analista;
  const tag = nuance && narrList !== pool.narrador ? `|${nuance}` : '';

  const narrTemplate = pickTemplate(random, narrList, memory, `${type}${tag}|narrador`, vars);
  if (narrTemplate) out.push({ voice: 'narrador', text: truncate(interpolate(narrTemplate, vars)) });

  const analystForced = ALWAYS_ANALYST.has(type);
  const analystRoll = random();
  if ((analystForced || analystRoll < ANALIST_BASE_RATE) && Array.isArray(anaList) && anaList.length) {
    const anTemplate = pickTemplate(random, anaList, memory, `${type}${anaList !== pool.analista ? `|${nuance}` : ''}|analista`, vars);
    if (anTemplate) out.push({ voice: 'analista', text: truncate(interpolate(anTemplate, vars)) });
  }

  return out;
}

// Formatea el marcador «H-A» a partir de un objeto {home, away}.
function formatScore(score) {
  if (!score || !Number.isFinite(score.home) || !Number.isFinite(score.away)) return '0-0';
  return `${score.home}-${score.away}`;
}

module.exports = {
  POOLS,
  NUANCE_RULES,
  NUANCE_POOLS,
  nuanceOf,
  SILENT_TYPES,
  ALWAYS_ANALYST,
  MAX_LEN,
  MEMORY,
  ANALIST_BASE_RATE,
  createMemory,
  generateCommentary,
  truncate,
  interpolate,
  formatScore,
  requiredVars,
  satisfied
};
