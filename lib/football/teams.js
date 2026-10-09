'use strict';

// Fase A — Clubes y plantillas (§5.5, decisión B3).
//
// Los 16 clubes son 100 % ficticios con nombre internacional neutro. Cada uno
// fue validado contra clubes reales el 2026-10-07: siete candidatos originales
// colisionaban y fueron reemplazados (la tabla de rechazos vive en §5.5 del
// documento). Los 16 códigos cortos son únicos entre sí.
//
// Este módulo separa dos cosas:
//   · La IDENTIDAD estática del club (nombre, ciudad, estadio, colores, táctica)
//     — fija, no cambia entre temporadas.
//   · El ESTADO de temporada (ratings elo/att/def/gk y plantilla de 18) — se
//     siembra de forma determinista con el seed de la temporada y se reinicia
//     cada mes, arrastrando solo el ajuste por campeón/colista (§5.1).
//
// Nada usa Math.random(): todo sale del `random` sembrado que pasa el llamador,
// así la misma temporada reproduce los mismos clubes, ratings y planteles.

const { randInt, randRange } = require('./prng');

// --- Identidad estática de los 16 clubes (§5.5) ---
// `id` en snake_case sin acentos (coincide con §6.2: vantora_fc, united_vanguard).
// `colors.primary` se reparte entre las familias de la identidad del casino
// (verde menta, grafito, dorado) más acentos diferenciables. La validación de
// contraste WCAG AA entre cada pareja de kits y contra el césped es una prueba
// de la Fase E (canvas); aquí se deja una paleta razonablemente distinta.
const CLUBS = [
  { id: 'vantora_fc',        name: 'Vantora FC',        short: 'VTR', city: 'Vantora',      stadium: 'Arena Boreal',     capacity: 41000, colors: { primary: '#1de9b6', secondary: '#1f2a30', kit: 'stripes' }, tactics: { formation: '4-3-3',   style: 'possession' } },
  { id: 'united_vanguard',   name: 'United Vanguard',   short: 'VNG', city: 'Vanguard City',stadium: 'The Bulwark',      capacity: 48000, colors: { primary: '#d32f2f', secondary: '#1a1a1a', kit: 'solid'   }, tactics: { formation: '4-4-2',   style: 'pressing'   } },
  { id: 'olympique_estevin', name: 'Olympique Estevin', short: 'EST', city: 'Estevin',      stadium: "Stade d'Estevin",  capacity: 39000, colors: { primary: '#303f9f', secondary: '#f5f5f5', kit: 'sash'    }, tactics: { formation: '4-2-3-1', style: 'possession' } },
  { id: 'atletico_solaris',  name: 'Atlético Solaris',  short: 'SOL', city: 'Solaris',      stadium: 'Coliseo Helios',   capacity: 45000, colors: { primary: '#fbc02d', secondary: '#1f2a30', kit: 'hoops'   }, tactics: { formation: '4-3-3',   style: 'direct'     } },
  { id: 'sporting_almar',    name: 'Sporting Almar',    short: 'ALM', city: 'Almara',       stadium: 'Campo Almar',      capacity: 33000, colors: { primary: '#388e3c', secondary: '#ffffff', kit: 'stripes' }, tactics: { formation: '4-4-2',   style: 'balanced'   } },
  { id: 'dynamo_kelvar',     name: 'Dynamo Kelvar',     short: 'KLV', city: 'Kelvar',       stadium: 'Kelvar Park',      capacity: 36000, colors: { primary: '#c2185b', secondary: '#1a1a1a', kit: 'halved'  }, tactics: { formation: '3-5-2',   style: 'pressing'   } },
  { id: 'cs_verdania',       name: 'CS Verdania',       short: 'VRD', city: 'Verdania',     stadium: 'Foro Verde',       capacity: 30000, colors: { primary: '#00796b', secondary: '#f5f5f5', kit: 'solid'   }, tactics: { formation: '4-2-3-1', style: 'counter'    } },
  { id: 'halcyon_bay_fc',    name: 'Halcyon Bay FC',    short: 'HLC', city: 'Halcyon Bay',  stadium: 'The Lighthouse',   capacity: 28000, colors: { primary: '#0288d1', secondary: '#ffffff', kit: 'stripes' }, tactics: { formation: '4-3-3',   style: 'counter'    } },
  { id: 'athletic_ferrata',  name: 'Athletic Ferrata',  short: 'FRR', city: 'Ferrata',      stadium: 'La Forja',         capacity: 34000, colors: { primary: '#e64a19', secondary: '#1f2a30', kit: 'sash'    }, tactics: { formation: '4-4-2',   style: 'direct'     } },
  { id: 'royal_corvane',     name: 'Royal Corvane',     short: 'CRV', city: 'Corvane',      stadium: 'Corona Arena',     capacity: 42000, colors: { primary: '#7b1fa2', secondary: '#f5f5f5', kit: 'solid'   }, tactics: { formation: '4-2-3-1', style: 'possession' } },
  { id: 'sv_talbruck',       name: 'SV Talbruck',       short: 'TLB', city: 'Talbruck',     stadium: 'Talbruck Stadion', capacity: 31000, colors: { primary: '#607d8b', secondary: '#ffffff', kit: 'hoops'   }, tactics: { formation: '3-5-2',   style: 'balanced'   } },
  { id: 'velmar_harbour_fc', name: 'Velmar Harbour FC', short: 'VLM', city: 'Velmar',       stadium: 'The Dockyard',     capacity: 27000, colors: { primary: '#1a237e', secondary: '#f5f5f5', kit: 'stripes' }, tactics: { formation: '4-4-2',   style: 'direct'     } },
  { id: 'norvela_sporting',  name: 'Norvela Sporting',  short: 'NVL', city: 'Norvela',      stadium: 'Estadio Norvela',  capacity: 35000, colors: { primary: '#afb42b', secondary: '#1f2a30', kit: 'halved'  }, tactics: { formation: '4-3-3',   style: 'balanced'   } },
  { id: 'ironvale_fc',       name: 'Ironvale FC',       short: 'IRN', city: 'Ironvale',     stadium: 'The Foundry',      capacity: 38000, colors: { primary: '#5d4037', secondary: '#fbc02d', kit: 'solid'   }, tactics: { formation: '4-4-2',   style: 'pressing'   } },
  { id: 'peregrine_rovers',  name: 'Peregrine Rovers',  short: 'PRG', city: 'Peregrine',    stadium: 'Rovers Park',      capacity: 29000, colors: { primary: '#eceff1', secondary: '#212121', kit: 'sash'    }, tactics: { formation: '4-2-3-1', style: 'counter'    } },
  { id: 'puerto_ambar',      name: 'Puerto Ámbar',      short: 'AMB', city: 'Ámbar',        stadium: 'Estadio Ámbar',    capacity: 32000, colors: { primary: '#ff8f00', secondary: '#1f2a30', kit: 'hoops'   }, tactics: { formation: '4-3-3',   style: 'possession' } }
];

const CLUB_IDS = CLUBS.map(club => club.id);
const CLUB_BY_ID = Object.fromEntries(CLUBS.map(club => [club.id, club]));
const CLUB_BY_SHORT = Object.fromEntries(CLUBS.map(club => [club.short, club]));

// Estilos tácticos válidos (§5.5). Alimentan pequeños sesgos del motor en Fase B.
const STYLES = ['possession', 'counter', 'pressing', 'direct', 'balanced'];
const FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-5-2'];

// --- Plantilla: 18 jugadores, números 1-18 sin repetir ---
// 2 porteros, 6 defensas, 6 mediocampistas, 4 delanteros. El número y la
// posición son fijos; el nombre y los atributos se generan con el seed.
const SQUAD_SLOTS = [
  { num: 1,  pos: 'GK'  }, { num: 2,  pos: 'RB'  }, { num: 3,  pos: 'LB'  },
  { num: 4,  pos: 'CB'  }, { num: 5,  pos: 'CB'  }, { num: 6,  pos: 'CDM' },
  { num: 7,  pos: 'CM'  }, { num: 8,  pos: 'CM'  }, { num: 9,  pos: 'ST'  },
  { num: 10, pos: 'CAM' }, { num: 11, pos: 'LW'  }, { num: 12, pos: 'GK'  },
  { num: 13, pos: 'CB'  }, { num: 14, pos: 'CDM' }, { num: 15, pos: 'RB'  },
  { num: 16, pos: 'RW'  }, { num: 17, pos: 'ST'  }, { num: 18, pos: 'CM'  }
];

// Grupo de atributos por posición. Cada atributo se sortea en su rango, así un
// delantero tiende a tener `sho`/`pac` altos y `def` bajo, un portero `gk` alto,
// etc. Los atributos alimentan (§5.5): probabilidad de ser goleador/asistencia,
// de recibir tarjeta (por `agr`) y el rendimiento de la formación en el render.
const ATTR_PROFILE = {
  GK: { pac: [45, 65], sho: [20, 40], pas: [50, 70], def: [55, 75], gk: [70, 92], agr: [40, 65] },
  DF: { pac: [55, 78], sho: [30, 50], pas: [55, 75], def: [70, 90], gk: [10, 25], agr: [60, 85] },
  MF: { pac: [60, 82], sho: [50, 72], pas: [70, 90], def: [55, 78], gk: [10, 25], agr: [50, 75] },
  FW: { pac: [70, 92], sho: [70, 92], pas: [55, 78], def: [25, 45], gk: [10, 25], agr: [45, 70] }
};
const POS_GROUP = {
  GK: 'GK',
  CB: 'DF', LB: 'DF', RB: 'DF', LWB: 'DF', RWB: 'DF',
  CDM: 'MF', CM: 'MF', CAM: 'MF', LM: 'MF', RM: 'MF',
  LW: 'FW', RW: 'FW', ST: 'FW', CF: 'FW'
};

// Nombres generados con un pool internacional coherente con el tono neutro de
// los clubes (§5.5). Al venir de un pool curado de nombres reales-plausibles,
// ninguna combinación puede producir algo ofensivo; la validación completa
// contra displayNameIssue/nameHasProfanity se cablea en la integración. La
// unicidad dentro de la liga se garantiza con un Set en generateSquads().
const FIRST_NAMES = [
  'Iker', 'Milan', 'Luka', 'Noah', 'Elias', 'Jonas', 'Rafael', 'Mateo', 'Thiago', 'Andrei',
  'Viktor', 'Nikolai', 'Dmitri', 'Karim', 'Samir', 'Omar', 'Youssef', 'Diego', 'Marco', 'Luca',
  'Paolo', 'Sven', 'Erik', 'Lars', 'Kasper', 'Tomas', 'Pavel', 'Ivan', 'Boris', 'Alexei',
  'Hugo', 'Leo', 'Nico', 'Ravi', 'Kenji', 'Hiro', 'Junseo', 'Kwame', 'Amadou', 'Femi',
  'Santiago', 'Joaquín', 'Emil', 'Aron', 'Filip', 'Marek', 'Jakub', 'Ondrej', 'Dragan', 'Zoran'
];
const LAST_NAMES = [
  'Valdés', 'Moreno', 'Kovac', 'Novak', 'Horvat', 'Petrov', 'Ivanov', 'Sokolov', 'Larsen', 'Jensen',
  'Nielsen', 'Andersen', 'Müller', 'Schmidt', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Rossi', 'Ferrari',
  'Bianchi', 'Romano', 'Colombo', 'Ricci', 'García', 'Martínez', 'López', 'Hernández', 'Silva', 'Santos',
  'Oliveira', 'Costa', 'Fernández', 'Dembélé', 'Traoré', 'Diop', 'Mensah', 'Okafor', 'Adeyemi', 'Yamamoto',
  'Tanaka', 'Sato', 'Suzuki', 'Kim', 'Park', 'Nguyen', 'Rahimi', 'Azizi', 'Bergström', 'Salvatore'
];

// Ratings iniciales con dispersión controlada (§5.5): elo ∈ [1380, 1620],
// att/def/gk ∈ [0.82, 1.18]. Se reinician cada temporada; solo se arrastra el
// ajuste por campeón/colista vía applySeasonCarryover().
const RATING_RANGE = { elo: [1380, 1620], att: [0.82, 1.18], def: [0.82, 1.18], gk: [0.82, 1.18] };

function emptySeasonStats() {
  return { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 };
}

// Genera un nombre completo único dentro de la liga. `used` es un Set compartido
// por los 16 clubes para que no haya dos jugadores homónimos en toda la temporada.
function uniquePlayerName(random, used) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const first = FIRST_NAMES[randInt(random, 0, FIRST_NAMES.length - 1)];
    const last = LAST_NAMES[randInt(random, 0, LAST_NAMES.length - 1)];
    const full = `${first} ${last}`;
    if (!used.has(full)) {
      used.add(full);
      return full;
    }
  }
  // Agotado el pool (no debería pasar con 50×50 = 2500 combinaciones y 288
  // jugadores): se añade un sufijo numérico para preservar la unicidad.
  const first = FIRST_NAMES[randInt(random, 0, FIRST_NAMES.length - 1)];
  const last = LAST_NAMES[randInt(random, 0, LAST_NAMES.length - 1)];
  const full = `${first} ${last} ${used.size + 1}`;
  used.add(full);
  return full;
}

function rollAttrs(random, pos) {
  const profile = ATTR_PROFILE[POS_GROUP[pos] || 'MF'];
  const attrs = {};
  for (const key of Object.keys(profile)) {
    const [lo, hi] = profile[key];
    attrs[key] = randInt(random, lo, hi);
  }
  return attrs;
}

// Plantilla de 18 jugadores para un club. `idShort` es el código corto en
// minúsculas (p. ej. 'vtr'); el id de jugador queda `vtr_09` (§5.5).
function generateSquad(club, random, usedNames) {
  const idShort = club.short.toLowerCase();
  return SQUAD_SLOTS.map(slot => ({
    id: `${idShort}_${String(slot.num).padStart(2, '0')}`,
    num: slot.num,
    name: uniquePlayerName(random, usedNames),
    pos: slot.pos,
    attrs: rollAttrs(random, slot.pos),
    season: emptySeasonStats()
  }));
}

// Ratings iniciales de un club, sembrados con dispersión controlada.
function seedRatings(random) {
  return {
    elo: randInt(random, RATING_RANGE.elo[0], RATING_RANGE.elo[1]),
    att: Number(randRange(random, RATING_RANGE.att[0], RATING_RANGE.att[1]).toFixed(3)),
    def: Number(randRange(random, RATING_RANGE.def[0], RATING_RANGE.def[1]).toFixed(3)),
    gk: Number(randRange(random, RATING_RANGE.gk[0], RATING_RANGE.gk[1]).toFixed(3))
  };
}

// Copia profunda de la identidad estática, para no mutar nunca el arreglo CLUBS.
function cloneIdentity(club) {
  return {
    id: club.id,
    name: club.name,
    short: club.short,
    city: club.city,
    stadium: club.stadium,
    capacity: club.capacity,
    colors: { primary: club.colors.primary, secondary: club.colors.secondary, kit: club.colors.kit },
    tactics: { formation: club.tactics.formation, style: club.tactics.style },
    ratings: { elo: club.ratings ? club.ratings.elo : 1500, att: 1, def: 1, gk: 1 },
    form: [],
    squad: []
  };
}

// Construye los 16 clubes completos de una temporada: identidad + ratings
// sembrados + plantilla de 18. Determinista a partir de `random`. El orden de
// consumo del PRNG es fijo (club por club, ratings luego plantilla) para que la
// misma temporada reproduzca exactamente los mismos datos.
function buildSeasonClubs(random) {
  const usedNames = new Set();
  return CLUBS.map(identity => {
    const club = cloneIdentity(identity);
    club.ratings = seedRatings(random);
    club.squad = generateSquad(club, random, usedNames);
    return club;
  });
}

// Ajuste de continuidad entre meses (§5.1): el campeón y el podio mejoran su
// rating inicial de la temporada siguiente; las dos últimas posiciones lo
// penalizan. `carryover` es un mapa { teamId: deltaElo } que produce el store al
// cerrar una temporada. No toca att/def/gk, solo elo. El delta se acota a ±40 y
// el resultado a una banda simétrica alrededor de la dispersión base
// ([1380−40, 1620+40]) para que ningún club se escape de forma permanente —la
// liga nunca se vuelve predecible— pero una penalización sí pueda bajar del piso
// base cuando el club ya arrancó en él.
function applySeasonCarryover(clubs, carryover) {
  if (!carryover || typeof carryover !== 'object') return clubs;
  const floor = RATING_RANGE.elo[0] - 40;
  const ceiling = RATING_RANGE.elo[1] + 40;
  for (const club of clubs) {
    const delta = Number(carryover[club.id]) || 0;
    const bounded = Math.max(-40, Math.min(40, Math.round(delta)));
    club.ratings.elo = Math.max(floor, Math.min(ceiling, club.ratings.elo + bounded));
  }
  return clubs;
}

// Validación estructural (la usa T-teams y el arranque): 16 clubes, ids y cortos
// únicos, colores y táctica presentes. Devuelve { ok, errors }.
function validateClubs(clubs = CLUBS) {
  const errors = [];
  if (clubs.length !== 16) errors.push(`Se esperan 16 clubes, hay ${clubs.length}`);
  const ids = new Set();
  const shorts = new Set();
  for (const club of clubs) {
    if (ids.has(club.id)) errors.push(`id duplicado: ${club.id}`);
    ids.add(club.id);
    if (shorts.has(club.short)) errors.push(`código corto duplicado: ${club.short}`);
    shorts.add(club.short);
    if (!club.name || !club.city || !club.stadium) errors.push(`${club.id}: faltan nombre/ciudad/estadio`);
    if (!/^#[0-9a-f]{6}$/i.test(club.colors && club.colors.primary)) errors.push(`${club.id}: color primario inválido`);
    if (!/^#[0-9a-f]{6}$/i.test(club.colors && club.colors.secondary)) errors.push(`${club.id}: color secundario inválido`);
    if (!FORMATIONS.includes(club.tactics && club.tactics.formation)) errors.push(`${club.id}: formación inválida`);
    if (!STYLES.includes(club.tactics && club.tactics.style)) errors.push(`${club.id}: estilo inválido`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  CLUBS,
  CLUB_IDS,
  CLUB_BY_ID,
  CLUB_BY_SHORT,
  STYLES,
  FORMATIONS,
  SQUAD_SLOTS,
  RATING_RANGE,
  buildSeasonClubs,
  generateSquad,
  seedRatings,
  applySeasonCarryover,
  cloneIdentity,
  validateClubs,
  emptySeasonStats
};
