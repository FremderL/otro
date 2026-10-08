'use strict';

// Fase A — Núcleo determinista (§3.2).
//
// Todo el Estadio se construye sobre dos primitivas reproducibles:
//   · hash32(texto)  → un uint32 estable y bien distribuido (xmur3).
//   · mulberry32(seed) → un generador pseudoaleatorio de 32 bits.
//
// Con ellas el calendario de una temporada, las plantillas, el marcador de un
// partido y hasta la tanda de penales de un desempate se pueden regenerar byte
// a byte a partir de su seed, que es lo que hace que el sistema sea idempotente,
// auditable e inmune a reinicios (§3.2). Nada de esto usa Math.random(): si lo
// hiciera, la reproducibilidad —y con ella R1/R2/R3— se rompería.
//
// Estas funciones son puras y no tienen dependencias, así que las consume todo
// el módulo de fútbol (teams, fixtures, ratings, match-engine, odds).

// xmur3: hash de cadena a uint32 con buena distribución (avalancha razonable).
// Es aritmética entera pura, idéntica en cualquier plataforma/V8, así que el
// mismo texto produce el mismo seed hoy y dentro de un año, en Render o en
// local. Se usa para derivar seeds de identificadores compuestos, p. ej.
//   hash32(`${matchId}|${jornada}|${seasonMonth}`)        (§3.2)
//   hash32(`desempate|${mes}|${eq1}|${eq2}`)              (§7.5, A14)
//   hash32(`${seasonMonth}liga`)                          (§5.2, calendario)
function hash32(str) {
  const text = String(str == null ? '' : str);
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// mulberry32: PRNG de 32 bits. Devuelve una función que produce el siguiente
// número en [0, 1) en cada llamada. El estado vive en el cierre, así que una
// misma semilla recorrida en el mismo orden da exactamente la misma sucesión.
// Es el generador que §3.2 nombra explícitamente.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Utilidades de muestreo sobre un random() ya sembrado ---
// Todas consumen la función `random` (no la semilla) para que el llamador
// controle el orden de consumo y la reproducibilidad del flujo completo.

// Entero uniforme en [min, max] (ambos inclusivos).
function randInt(random, min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi < lo) return lo;
  return lo + Math.floor(random() * (hi - lo + 1));
}

// Flotante uniforme en [min, max).
function randRange(random, min, max) {
  return min + random() * (max - min);
}

// `true` con probabilidad `p` (0..1).
function chance(random, p) {
  return random() < p;
}

// Elemento al azar de un arreglo (sin mutarlo).
function pick(random, array) {
  if (!Array.isArray(array) || array.length === 0) return undefined;
  return array[Math.floor(random() * array.length) % array.length];
}

// Fisher-Yates sembrado: devuelve una COPIA barajada, nunca muta el original.
// El orden depende solo del estado de `random`, así que es reproducible.
function shuffle(random, array) {
  const copy = Array.isArray(array) ? array.slice() : [];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

// Elije `count` elementos distintos de un arreglo (sin repetición), preservando
// el orden en que se extraen. Si `count` >= longitud, devuelve todos barajados.
function sample(random, array, count) {
  const pool = shuffle(random, array);
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}

module.exports = {
  hash32,
  mulberry32,
  randInt,
  randRange,
  chance,
  pick,
  shuffle,
  sample
};
