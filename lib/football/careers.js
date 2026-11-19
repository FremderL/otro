'use strict';

// Carreras de jugadores del Estadio: edad derivada, retiros y cantera.
//
// PRINCIPIO: nada se guarda que pueda derivarse. Los 288 jugadores de una
// temporada ya persistida no tienen edad y no se les va a añadir una: la edad
// se calcula a partir del id y de la temporada, así que es la misma en cada
// proceso, en cada reinicio y para siempre, sin migrar un solo registro.
//
// Y el determinismo es de ida y vuelta: la generación de una temporada NO puede
// consumir números del PRNG del calendario. Todo sale de hash32 sobre el id y la
// temporada, de modo que las semillas fijas siguen produciendo exactamente los
// mismos partidos, plantillas y timelines que antes de este módulo.

const { hash32 } = require('./prng');
const { parseSeasonMonth } = require('./fixtures');

// La edad vive en esta banda. Un jugador nunca "nace" fuera de ella.
const MIN_AGE = 19;
const MAX_AGE = 37;
const AGE_SPAN = MAX_AGE - MIN_AGE + 1; // 19

// Solo a partir de aquí se puede uno retirar.
const RETIREMENT_AGE = 35;

// Un retiro por temporada es noticia; dos ya es una transición. Nunca más.
const MAX_RETIREMENTS_PER_SEASON = 2;

// Probabilidad de retirarse por edad (0-100). Se acumula con los años y a los 37
// es del 100 %: así nadie "rejuvenece" al llegar al techo de la banda.
const RETIREMENT_CHANCE = Object.freeze({ 35: 22, 36: 40, 37: 100 });

// Nivel global de un cantero: promesa, no estrella.
const YOUTH_LEVEL = Object.freeze({ min: 34, max: 58 });

// Nivel global de la promesa de la temporada: excepcional, pero sin estar hecho.
const WONDERKID_LEVEL = Object.freeze({ min: 70, max: 84 });
const WONDERKID_AGE = 19;

// Índice lineal de una temporada 'AAAA-MM'. Solo sirve para restar dos fechas:
// su valor absoluto no significa nada.
function seasonIndex(seasonMonth) {
  const { year, month } = parseSeasonMonth(seasonMonth);
  return year * 12 + (month - 1);
}

// Ancla del calendario de carreras: la temporada de lanzamiento del Estadio. Las
// edades se miden DESDE ella, no en valor absoluto (el índice lineal de una
// temporada es enorme y saturaría a todo el plantel en el techo de la banda).
const CAREER_EPOCH = '2026-10';

// Desfase inicial derivado de forma estable del id: reparte al plantel por todas
// las edades de la banda en la temporada ancla, sin tocar el PRNG (ver cabecera).
function debutSeasonIndex(playerId) {
  // Se reparte en toda la banda de edad: el hash es uniforme, así que el plantel
  // del lanzamiento tiene jóvenes, veteranos y gente en su mejor momento.
  return (hash32(`debut|${playerId}`) >>> 0) % AGE_SPAN;
}

// Edad de un jugador en una temporada dada. Determinista y sin estado.
//
// La edad es MONÓTONA: nunca vuelve a bajar. Cuando un jugador llega al techo
// (37) se queda ahí, y a esa edad el retiro es seguro, así que jamás se ve a un
// veterano "rejuvenecer" ni a un jugador de 37 en la temporada siguiente.
function ageOf(player, seasonMonth) {
  const id = typeof player === 'string' ? player : player && player.id;
  if (!id) return MIN_AGE;
  const elapsed = seasonIndex(seasonMonth) - seasonIndex(CAREER_EPOCH) + debutSeasonIndex(id);
  return MIN_AGE + Math.min(Math.max(elapsed, 0), AGE_SPAN - 1);
}

// ¿Se retira este jugador al cerrar `seasonMonth`? La decisión es del jugador,
// no del club, y se deriva del id + temporada para que sea reproducible.
function retirementRoll(player, seasonMonth) {
  const id = typeof player === 'string' ? player : player && player.id;
  if (!id) return { retires: false, age: MIN_AGE, chance: 0 };
  const age = ageOf(id, seasonMonth);
  if (age < RETIREMENT_AGE) return { retires: false, age, chance: 0 };
  const chance = RETIREMENT_CHANCE[age] || RETIREMENT_CHANCE[RETIREMENT_AGE];
  const roll = (hash32(`retiro|${id}|${seasonMonth}`) >>> 0) % 100;
  return { retires: roll < chance, age, chance };
}

// Nombres de cantera: los mismos pools curados que el resto de la liga, pero
// elegidos por hash para no tocar el PRNG de la temporada.
const YOUTH_FIRST = ['Iker', 'Lucas', 'Nico', 'Aitor', 'Bruno', 'Diego', 'Enzo', 'Gael', 'Hugo', 'Ian',
  'Joel', 'Leo', 'Marc', 'Nils', 'Pau', 'Rui', 'Saúl', 'Teo', 'Unai', 'Yago'];
const YOUTH_LAST = ['Arriaga', 'Bustos', 'Cano', 'Duarte', 'Escobar', 'Ferrer', 'Guzmán', 'Heredia', 'Ibarra',
  'Jaramillo', 'Keller', 'Lozano', 'Mena', 'Nava', 'Ochoa', 'Peralta', 'Quintero', 'Rivas', 'Segura', 'Tovar'];

function pickByHash(list, seed) {
  return list[(hash32(seed) >>> 0) % list.length];
}

// Atributos deterministas a partir de un NIVEL global (0-100) y la posición: un
// delantero nace con tiro y ritmo cerca de su nivel y defensa muy por debajo, un
// portero con gk alto y gol casi nulo. Es lo que hace creíble al cantero: 50 de
// nivel no significa 50 en todo.
const ATTR_BIAS = {
  GK: { gk: 1.00, def: 0.72, pas: 0.62, pac: 0.52, sho: 0.20, agr: 0.60 },
  DF: { def: 1.00, pac: 0.78, pas: 0.68, agr: 0.82, sho: 0.34, gk: 0.16 },
  MF: { pas: 1.00, pac: 0.84, sho: 0.72, def: 0.72, agr: 0.66, gk: 0.14 },
  FW: { sho: 1.00, pac: 0.96, pas: 0.72, agr: 0.62, def: 0.28, gk: 0.12 }
};

function groupOfPosition(pos) {
  if (pos === 'GK') return 'GK';
  if (/^(CB|LB|RB|LWB|RWB)$/.test(pos)) return 'DF';
  if (/^(CDM|CM|CAM|LM|RM)$/.test(pos)) return 'MF';
  return 'FW';
}

function attrsForLevel(seed, pos, level) {
  const bias = ATTR_BIAS[groupOfPosition(pos)];
  const attrs = {};
  for (const key of Object.keys(bias)) {
    // Jitter de ±8 % para que dos canteros del mismo nivel no sean gemelos.
    const jitter = 0.92 + ((hash32(`cantera|${seed}|${key}`) >>> 0) % 17) / 100;
    attrs[key] = Math.max(1, Math.min(99, Math.round(level * bias[key] * jitter)));
  }
  return attrs;
}

// Nivel global determinista dentro de un rango.
function levelFor(seed, range) {
  return range.min + ((hash32(`nivel|${seed}`) >>> 0) % (range.max - range.min + 1));
}

// Siguiente dorsal libre para un cantero: el del jugador que sale de la
// plantilla, o el primer hueco de 1 a 18. Nadie repite dorsal.
function freeNumber(squad) {
  const used = new Set((squad || []).map(player => player.num));
  for (let num = 1; num <= 18; num++) if (!used.has(num)) return num;
  return 19;
}

// Cantera: un jugador nuevo con identidad propia que ocupa el hueco de un
// jugador que se va. `avoidNames` evita homónimos con el resto de la liga.
function buildYouth({ club, seasonMonth, position, number = null, avoidNames = new Set(), idSuffix }) {
  const clubId = club && club.id ? club.id : 'club';
  const suffix = idSuffix || `${seasonMonth || 'x'}`.replace(/[^0-9]/g, '').slice(-4);
  let candidateId = `${String(clubId).split('_')[0]}_y${suffix}`;
  let n = 0;
  const takenIds = new Set((club && club.squad ? club.squad : []).map(player => player.id));
  while (takenIds.has(candidateId)) candidateId = `${String(clubId).split('_')[0]}_y${suffix}${++n}`;

  let name = '';
  for (let attempt = 0; attempt < 200; attempt++) {
    const seed = `cantera|${candidateId}|${attempt}`;
    const candidate = `${pickByHash(YOUTH_FIRST, seed)} ${pickByHash(YOUTH_LAST, `${seed}|last`)}`;
    if (!avoidNames.has(candidate)) { name = candidate; break; }
  }
  if (!name) name = `${pickByHash(YOUTH_FIRST, candidateId)} ${pickByHash(YOUTH_LAST, candidateId)} ${suffix}`;

  const pos = position || 'CM';
  return {
    id: candidateId,
    num: Number.isInteger(number) && number > 0 ? number : freeNumber(club && club.squad),
    name,
    pos,
    attrs: attrsForLevel(candidateId, pos, levelFor(candidateId, YOUTH_LEVEL)),
    season: { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 }
  };
}

// La promesa de la temporada: un juvenil excepcional. Entra al fondo de
// agentes libres, no a un club; lo ficha quien pueda pagarlo (§ CASA).
function buildWonderkid({ seasonMonth, avoidNames = new Set() }) {
  const seed = `promesa|${seasonMonth}`;
  const positions = ['ST', 'LW', 'RW', 'CAM', 'CM'];
  const pos = positions[(hash32(`${seed}|pos`) >>> 0) % positions.length];
  const id = `pro_${String(seasonMonth).replace(/[^0-9]/g, '')}`;
  let name = '';
  for (let attempt = 0; attempt < 200; attempt++) {
    const s = `${seed}|${attempt}`;
    const candidate = `${pickByHash(YOUTH_FIRST, s)} ${pickByHash(YOUTH_LAST, `${s}|l`)}`;
    if (!avoidNames.has(candidate)) { name = candidate; break; }
  }
  if (!name) name = `Promesa ${seasonMonth}`;
  return {
    id,
    num: null,
    name,
    pos,
    age: WONDERKID_AGE,
    attrs: attrsForLevel(id, pos, levelFor(id, WONDERKID_LEVEL)),
    season: { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 },
    wonderkid: true
  };
}

// ¿Esta temporada hay promesa? Aproximadamente una de cada dos: el evento es
// noticia justamente porque no ocurre siempre.
function hasWonderkid(seasonMonth) {
  return ((hash32(`promesa?|${seasonMonth}`) >>> 0) % 100) < 55;
}

// Retiros de la temporada. Devuelve como máximo MAX_RETIREMENTS_PER_SEASON,
// ordenados por edad y luego por id para que el resultado no dependa del orden
// en que se recorran los clubes.
// No todas las temporadas hay retiros: es un evento, no una nómina. En las que
// toca, uno o —raramente— dos.
function retirementQuota(seasonMonth) {
  const roll = (hash32(`retiros?|${seasonMonth}`) >>> 0) % 100;
  if (roll >= 62) return 0;
  return roll < 14 ? 2 : 1;
}

function planRetirements(clubs, seasonMonth) {
  const candidates = [];
  for (const club of Array.isArray(clubs) ? clubs : []) {
    for (const player of Array.isArray(club.squad) ? club.squad : []) {
      const roll = retirementRoll(player, seasonMonth);
      if (!roll.retires) continue;
      candidates.push({ clubId: club.id, clubName: club.name, player, age: roll.age });
    }
  }
  // Un club no se queda sin portero por un retiro: se protege al único GK.
  const keepersByClub = new Map();
  for (const club of Array.isArray(clubs) ? clubs : []) {
    keepersByClub.set(club.id, (club.squad || []).filter(p => p.pos === 'GK').length);
  }
  const safe = candidates.filter(entry => {
    if (entry.player.pos !== 'GK') return true;
    return (keepersByClub.get(entry.clubId) || 0) > 1;
  });
  // Sorteo ponderado por edad, con hash estable: los veteranos tienen más
  // papeletas, pero no es un turno rígido por edad —de otro modo cada temporada
  // se retirarían siempre los mismos dos jugadores más viejos de la liga.
  const pool = safe.slice();
  const picked = [];
  const quota = retirementQuota(seasonMonth);
  for (let slot = 0; slot < quota && pool.length; slot++) {
    const weights = pool.map(entry => Math.max(1, entry.age - 33));
    const total = weights.reduce((sum, w) => sum + w, 0);
    let draw = (hash32(`sorteo|${seasonMonth}|${slot}`) >>> 0) % total;
    let index = weights.length - 1;
    for (let i = 0; i < weights.length; i++) {
      if (draw < weights[i]) { index = i; break; }
      draw -= weights[i];
    }
    picked.push(pool[index]);
    pool.splice(index, 1);
  }
  return picked.sort((a, b) => b.age - a.age || String(a.player.id).localeCompare(String(b.player.id)));
}

// Resumen legible de una carrera para la noticia: solo datos verificables.
// `totals` viene de clubRoster (partidos, goles, asistencias asentados).
function careerSummary(player, totals, age) {
  const stats = totals || { appearances: 0, goals: 0, assists: 0, minutes: 0 };
  return {
    age,
    appearances: Math.max(0, Number(stats.appearances) || 0),
    goals: Math.max(0, Number(stats.goals) || 0),
    assists: Math.max(0, Number(stats.assists) || 0),
    minutes: Math.max(0, Number(stats.minutes) || 0)
  };
}

module.exports = {
  MIN_AGE,
  MAX_AGE,
  CAREER_EPOCH,
  RETIREMENT_AGE,
  MAX_RETIREMENTS_PER_SEASON,
  WONDERKID_AGE,
  seasonIndex,
  ageOf,
  retirementRoll,
  planRetirements,
  retirementQuota,
  buildYouth,
  buildWonderkid,
  hasWonderkid,
  freeNumber,
  careerSummary,
  YOUTH_LEVEL,
  WONDERKID_LEVEL,
  attrsForLevel,
  levelFor
};
