'use strict';

// Fase B — Pruebas de los comentaristas (§9).
//
// Blindan las reglas de calidad del relato:
//   · Dos voces (narrador play-by-play + analista táctico) generadas en servidor.
//   · El analista SIEMPRE habla tras gol, expulsión, penal, descanso y final.
//   · Los eventos de baja relevancia (SILENT_TYPES) no generan relato.
//   · Memoria anti-repetición: las últimas MEMORY plantillas por (tipo,voz) no
//     vuelven a salir ⇒ sin repetición inmediata.
//   · Límite duro de 140 caracteres por mensaje.
//   · Filtrado por variables disponibles: jamás sale una plantilla con datos
//     ausentes (nada de «Asistencia de :» ni «{marcador}» sin resolver).

const test = require('node:test');
const assert = require('node:assert');
const prng = require('../lib/football/prng');
const {
  POOLS, SILENT_TYPES, ALWAYS_ANALYST, MAX_LEN, MEMORY, ANALIST_BASE_RATE,
  createMemory, generateCommentary, truncate, interpolate, formatScore,
  requiredVars, satisfied
} = require('../lib/football/commentary');

const rnd = (s) => prng.mulberry32(prng.hash32(s));

// Vars completos: ninguna plantilla queda fuera por datos ausentes.
const FULL_VARS = {
  jugador: 'Kenji Kovac', equipo: 'Vantora FC', rival: 'United Vanguard', estadio: 'Arena Boreal',
  minuto: 32, marcador: '1-0', goles: 5, xgFavor: '0.38', xg: '0.38', posesion: '55 %',
  tiros: '12-9', asistencia: 'Santiago Novak', resultado: '¡gol!', marcadorTanda: '3-2',
  equipoRival: 'United Vanguard', puestoRival: 'ST'
};

const ALL_TYPES = Object.keys(POOLS);

function textsOf(lines) { return lines.map(l => l.text); }
function voicesOf(lines) { return lines.map(l => l.voice); }

// --- Estructura de los POOLS ---

test('§9 — cada tipo tiene narrador y los clave tienen analista', () => {
  assert.ok(ALL_TYPES.length >= 20, `cobertura amplia de tipos (${ALL_TYPES.length})`);
  for (const type of ALL_TYPES) {
    assert.ok(Array.isArray(POOLS[type].narrador) && POOLS[type].narrador.length >= 1, `${type} tiene narrador`);
    for (const t of POOLS[type].narrador) assert.ok(typeof t === 'string' && t.length > 0, 'plantilla no vacía');
  }
  for (const type of ALWAYS_ANALYST) {
    assert.ok(POOLS[type], `${type} existe en POOLS`);
    assert.ok(Array.isArray(POOLS[type].analista) && POOLS[type].analista.length >= 1, `${type} tiene analista`);
  }
});

test('§9 — SILENT_TYPES no generan relato', () => {
  const memory = createMemory();
  for (const type of SILENT_TYPES) {
    const lines = generateCommentary(type, FULL_VARS, rnd('sil' + type), memory);
    assert.deepStrictEqual(lines, [], `${type} en silencio`);
  }
});

test('§9 — un tipo desconocido devuelve vacío (no rompe)', () => {
  assert.deepStrictEqual(generateCommentary('invento_raro', FULL_VARS, rnd('x'), createMemory()), []);
});

// --- Dos voces ---

test('§9 — el analista SIEMPRE habla en los eventos clave', () => {
  for (const type of ALWAYS_ANALYST) {
    if (SILENT_TYPES.has(type)) continue;
    for (let k = 0; k < 25; k++) {
      const lines = generateCommentary(type, FULL_VARS, rnd(`aa-${type}-${k}`), createMemory());
      assert.ok(voicesOf(lines).includes('analista'), `${type} siempre con analista (intento ${k})`);
      assert.ok(voicesOf(lines).includes('narrador'), `${type} siempre con narrador (intento ${k})`);
    }
  }
});

test('§9 — el analista de un evento no clave aparece a veces sí y a veces no (~35 %)', () => {
  // yellow_card no es ALWAYS_ANALYST: el analista debe aparecer de forma intermitente.
  let conAnalista = 0;
  const N = 400;
  for (let k = 0; k < N; k++) {
    const lines = generateCommentary('yellow_card', FULL_VARS, rnd('yc' + k), createMemory());
    if (voicesOf(lines).includes('analista')) conAnalista++;
  }
  const tasa = conAnalista / N;
  assert.ok(tasa > 0.1 && tasa < 0.7, `tasa de analista razonable (${tasa.toFixed(2)} ~ ${ANALIST_BASE_RATE})`);
});

test('§9 — solo existen las dos voces canónicas', () => {
  const memory = createMemory();
  const voces = new Set();
  for (const type of ALL_TYPES) {
    for (let k = 0; k < 10; k++) {
      for (const v of voicesOf(generateCommentary(type, FULL_VARS, rnd(`v-${type}-${k}`), memory))) voces.add(v);
    }
  }
  assert.deepStrictEqual([...voces].sort(), ['analista', 'narrador']);
});

// --- Anti-repetición (§9) ---

test('§9 — memoria anti-repetición: sin plantilla repetida en la ventana MEMORY', () => {
  const memory = createMemory();
  const type = 'goal';
  const seq = [];
  for (let k = 0; k < 40; k++) {
    const lines = generateCommentary(type, FULL_VARS, rnd('rep' + k), memory);
    const narr = lines.find(l => l.voice === 'narrador');
    assert.ok(narr, 'siempre hay narrador en un gol');
    seq.push(narr.text);
  }
  // Ningún texto se repite dentro de las últimas MEMORY apariciones del mismo tipo.
  for (let i = 1; i < seq.length; i++) {
    const ventana = seq.slice(Math.max(0, i - MEMORY), i);
    assert.ok(!ventana.includes(seq[i]), `sin repetición inmediata en ${i}: «${seq[i]}»`);
  }
});

test('§9 — la memoria es independiente por (tipo, voz)', () => {
  const memory = createMemory();
  // Alternar dos tipos no debe agotar ni mezclar sus memorias.
  for (let k = 0; k < 30; k++) {
    generateCommentary('goal', FULL_VARS, rnd('mix-g' + k), memory);
    generateCommentary('corner', FULL_VARS, rnd('mix-c' + k), memory);
  }
  // Tras el bucle, ambos siguen produciendo relato válido.
  assert.ok(generateCommentary('goal', FULL_VARS, rnd('mix-gf'), memory).length >= 1);
  assert.ok(generateCommentary('corner', FULL_VARS, rnd('mix-cf'), memory).length >= 1);
});

// --- Límite de 140 caracteres (§9) ---

test('§9 — truncate respeta el límite duro y colapsa espacios', () => {
  assert.strictEqual(truncate('a'.repeat(200)).length, MAX_LEN);
  assert.ok(truncate('a'.repeat(200)).endsWith('…'), 'termina en elipsis al cortar');
  assert.strictEqual(truncate('  hola   mundo  '), 'hola mundo', 'colapsa espacios y recorta bordes');
  assert.strictEqual(truncate('corto'), 'corto', 'no altera textos breves');
  assert.strictEqual(truncate(null), '');
  assert.strictEqual(truncate(undefined), '');
});

test('§9 — ningún mensaje generado supera los 140 caracteres', () => {
  const memory = createMemory();
  for (const type of ALL_TYPES) {
    for (let k = 0; k < 12; k++) {
      for (const line of generateCommentary(type, FULL_VARS, rnd(`len-${type}-${k}`), memory)) {
        assert.ok(line.text.length <= MAX_LEN, `${type} dentro del límite (${line.text.length})`);
        assert.ok(line.text.length > 0, 'texto no vacío');
      }
    }
  }
});

// --- interpolate / requiredVars / satisfied ---

test('interpolate sustituye variables y vacía las ausentes', () => {
  assert.strictEqual(interpolate('Gol de {jugador} al {minuto}', { jugador: 'Ana', minuto: 10 }), 'Gol de Ana al 10');
  assert.strictEqual(interpolate('Gol de {jugador}', {}), 'Gol de ', 'una var ausente se vacía (por eso se filtra antes)');
  assert.strictEqual(interpolate('{a}-{a}', { a: 'x' }), 'x-x', 'sustituye todas las ocurrencias');
});

test('requiredVars y satisfied detectan datos ausentes', () => {
  assert.deepStrictEqual(requiredVars('Gol de {jugador} al {minuto}').sort(), ['jugador', 'minuto']);
  assert.deepStrictEqual(requiredVars('sin variables'), []);
  assert.ok(satisfied('Gol de {jugador}', { jugador: 'Ana' }));
  assert.ok(!satisfied('Gol de {jugador}', {}), 'falta jugador ⇒ no satisfecha');
  assert.ok(!satisfied('Gol de {jugador}', { jugador: '' }), 'vacío ⇒ no satisfecha');
});

test('§9 — el filtrado por variables evita salidas rotas (datos parciales)', () => {
  // Con vars MÍNIMOS, las plantillas que exigen asistencia/xg/etc. no deben salir.
  const minVars = { equipo: 'Vantora FC', rival: 'United Vanguard', estadio: 'Arena Boreal', minuto: 30, marcador: '0-0' };
  const memory = createMemory();
  for (const type of ALL_TYPES) {
    for (let k = 0; k < 15; k++) {
      for (const line of generateCommentary(type, minVars, rnd(`min-${type}-${k}`), memory)) {
        assert.ok(!/\{\w+\}/.test(line.text), `${type}: sin placeholder sin resolver («${line.text}»)`);
        assert.ok(!/\bde :|:\s*[,.;]|  /.test(line.text), `${type}: sin hueco por var ausente («${line.text}»)`);
      }
    }
  }
});

test('§9 — sin artefactos con vars completos en todos los tipos', () => {
  const memory = createMemory();
  for (const type of ALL_TYPES) {
    for (let k = 0; k < 15; k++) {
      for (const text of textsOf(generateCommentary(type, FULL_VARS, rnd(`full-${type}-${k}`), memory))) {
        assert.ok(!/\{\w+\}/.test(text), `${type}: «${text}»`);
        assert.ok(!/  /.test(text), `${type} sin dobles espacios: «${text}»`);
        assert.ok(!/\bde :/.test(text), `${type} sin «de :»: «${text}»`);
      }
    }
  }
});

// --- formatScore ---

test('formatScore formatea «H-A» y cae a 0-0 con entrada inválida', () => {
  assert.strictEqual(formatScore({ home: 2, away: 1 }), '2-1');
  assert.strictEqual(formatScore({ home: 0, away: 0 }), '0-0');
  assert.strictEqual(formatScore(null), '0-0');
  assert.strictEqual(formatScore({ home: NaN, away: 1 }), '0-0');
});

// --- Matices de intensidad (palo, atajada en la línea, contragolpe, gol agónico, falta dura) ---

const { NUANCE_RULES, NUANCE_POOLS, nuanceOf } = require('../lib/football/commentary');

test('matices — cada regla detecta su jugada y las normales no se marcan', () => {
  assert.strictEqual(nuanceOf('goal', { minuto: 88 }), 'gol_agonico', 'gol desde el 85 es agónico');
  assert.strictEqual(nuanceOf('goal', { minuto: 30 }), null, 'gol temprano es normal');
  assert.strictEqual(nuanceOf('penalty_missed', { resultado: 'pegó en el poste' }), 'palo');
  assert.strictEqual(nuanceOf('save', { xg: '0.31' }), 'atajada_linea', 'atajada de xG alto');
  assert.strictEqual(nuanceOf('save', { xg: '0.05' }), null, 'atajada rutinaria es normal');
  assert.strictEqual(nuanceOf('red_card', { motivo: 'serious_foul' }), 'falta_dura');
  assert.strictEqual(nuanceOf('yellow_card', { motivo: 'foul' }), null, 'amarilla común no es dura');
  assert.strictEqual(nuanceOf('shot', { estilo: 'counter' }), 'contragolpe');
  assert.strictEqual(nuanceOf('shot', { estilo: 'possession' }), null);
  assert.strictEqual(nuanceOf('corner', { estilo: 'counter' }), null, 'un córner no es contragolpe');
  assert.strictEqual(nuanceOf('goal', null), null);
});

test('matices — cada repertorio tiene narrador y analista, y todas las plantillas caben en 140', () => {
  for (const rule of NUANCE_RULES) {
    const pool = NUANCE_POOLS[rule.key];
    assert.ok(pool, `${rule.key} tiene repertorio`);
    assert.ok(pool.narrador.length >= 3, `${rule.key}: suficientes narradores (anti-repetición)`);
    assert.ok(pool.analista.length >= 2, `${rule.key}: analistas variados`);
    for (const t of [...pool.narrador, ...pool.analista]) {
      assert.ok(t.length <= MAX_LEN, `${rule.key} dentro del límite: «${t}»`);
    }
  }
});

test('matices — el gol agónico usa su repertorio con datos completos y sin placeholders', () => {
  const memory = createMemory();
  const vars = { ...FULL_VARS, minuto: 89 };
  let usedNuance = false;
  for (let k = 0; k < 20; k++) {
    for (const line of generateCommentary('goal', vars, rnd(`ago-${k}`), memory)) {
      assert.ok(!/\{\w+\}/.test(line.text), `sin placeholder («${line.text}»)`);
      assert.ok(line.text.length <= MAX_LEN);
      if (/EN EL MINUTO|Sobre la hora|último suspiro|vale oro|tanto agónico/.test(line.text)) usedNuance = true;
    }
  }
  assert.ok(usedNuance, 'el gol del 89 recibe el repertorio agónico');
});

test('matices — con datos mínimos el matiz cae al repertorio base (nunca sale una plantilla rota)', () => {
  const minVars = { equipo: 'Vantora FC', rival: 'United Vanguard', estadio: 'Arena Boreal', minuto: 88, marcador: '0-0' };
  const memory = createMemory();
  for (let k = 0; k < 15; k++) {
    for (const line of generateCommentary('goal', minVars, rnd(`agm-${k}`), memory)) {
      assert.ok(!/\{\w+\}/.test(line.text), `sin placeholder («${line.text}»)`);
      assert.ok(!/\bde :|:\s*[,.;]|  /.test(line.text), `sin hueco («${line.text}»)`);
    }
  }
});
