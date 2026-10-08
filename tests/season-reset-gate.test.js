'use strict';

// Fase F (A12) — Gate del reset mensual del casino.
//
// Cuando cambia el mes, ensureSeason() cierra la temporada y reinicia TODOS los
// saldos a INITIAL_CHIPS. Con el Estadio activo eso podría pisar una temporada de
// fútbol con apuestas abiertas (el jugador perdería el saldo con el que apostó y
// luego cobraría sobre fichas ya reiniciadas). El gancho onBeforeSeasonReset permite
// aplazar el cierre mientras queden apuestas abiertas, con un tope de aplazamientos
// para que el casino nunca quede atascado para siempre.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { ProfileStore } = require('../lib/profile-store');
const { INITIAL_CHIPS } = require('../lib/profile-store-shared');

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProfileStore(path.join(dir, 'profiles.json'));
  // Un perfil con saldo distinto del inicial, para comprobar si se reinicia o no.
  const profile = store.getOrCreate({ token: 'tok-gate', name: 'Jugador', deviceToken: 'dev-gate' });
  profile.chips = 4321;
  store.saveNow();
  return { store, profile };
}

// Simula una temporada vieja (enero 2020) frente a "ahora" (mes actual) para forzar
// la detección de cambio de mes en ensureSeason.
function ageSeason(store) { store.seasons.current = '2020-01'; }

test('sin gate: el cambio de mes cierra y reinicia saldos (comportamiento histórico)', (t) => {
  const { store, profile } = makeStore(t);
  ageSeason(store);
  const result = store.ensureSeason(new Date());
  assert.equal(result.type, 'closed', 'cierra la temporada');
  assert.equal(profile.chips, INITIAL_CHIPS, 'saldo reiniciado');
  assert.notEqual(store.seasons.current, '2020-01', 'avanza el mes actual');
});

test('gate que aplaza: NO reinicia saldos ni avanza el mes', (t) => {
  const { store, profile } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = ({ fromMonth }) => ({ type: 'deferred', reason: 'apuestas_de_futbol_abiertas', fromMonth });
  const result = store.ensureSeason(new Date());
  assert.equal(result.type, 'deferred', 'devuelve deferred');
  assert.equal(result.deferrals, 1, 'primer aplazamiento');
  assert.equal(result.reason, 'apuestas_de_futbol_abiertas', 'motivo propagado');
  assert.equal(profile.chips, 4321, 'saldo INTACTO (no se reinició)');
  assert.equal(store.seasons.current, '2020-01', 'el mes NO avanzó');
});

test('gate que permite el cierre (null) cierra con normalidad', (t) => {
  const { store, profile } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = () => null;
  const result = store.ensureSeason(new Date());
  assert.equal(result.type, 'closed', 'cierra');
  assert.equal(profile.chips, INITIAL_CHIPS, 'saldo reiniciado');
});

test('tope de aplazamientos: al agotarse, fuerza el cierre', (t) => {
  const prev = process.env.SEASON_RESET_MAX_DEFERRALS;
  process.env.SEASON_RESET_MAX_DEFERRALS = '3';
  t.after(() => { if (prev == null) delete process.env.SEASON_RESET_MAX_DEFERRALS; else process.env.SEASON_RESET_MAX_DEFERRALS = prev; });

  const { store, profile } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = () => ({ type: 'deferred', reason: 'apuestas_de_futbol_abiertas' });

  // Aplazamientos 1 y 2 (menores que el tope 3): se aplaza.
  const r1 = store.ensureSeason(new Date());
  const r2 = store.ensureSeason(new Date());
  assert.equal(r1.type, 'deferred'); assert.equal(r1.deferrals, 1);
  assert.equal(r2.type, 'deferred'); assert.equal(r2.deferrals, 2);
  assert.equal(profile.chips, 4321, 'seguía intacto tras aplazar');
  assert.equal(store.seasons.current, '2020-01', 'seguía sin avanzar');

  // Tercer intento: deferrals llegaría a 3, que NO es < 3 → se fuerza el cierre.
  const r3 = store.ensureSeason(new Date());
  assert.equal(r3.type, 'closed', 'cierre forzado al agotar el tope');
  assert.equal(profile.chips, INITIAL_CHIPS, 'saldo reiniciado al forzar');
  assert.notEqual(store.seasons.current, '2020-01', 'el mes avanzó');
});

test('el contador de aplazamientos se reinicia tras un cierre real', (t) => {
  const { store } = makeStore(t);
  ageSeason(store);
  store.onBeforeSeasonReset = () => ({ type: 'deferred' });
  store.ensureSeason(new Date());
  store.ensureSeason(new Date());
  assert.equal(store._seasonDeferrals, 2, 'dos aplazamientos acumulados');

  // Ahora el gate permite cerrar.
  store.onBeforeSeasonReset = () => null;
  const closed = store.ensureSeason(new Date());
  assert.equal(closed.type, 'closed', 'cerró');
  assert.equal(store._seasonDeferrals, 0, 'contador reiniciado');
});

test('el gate recibe fromMonth/toMonth para consultar la temporada correcta', (t) => {
  const { store } = makeStore(t);
  ageSeason(store);
  let seen = null;
  store.onBeforeSeasonReset = (arg) => { seen = arg; return { type: 'deferred' }; };
  store.ensureSeason(new Date());
  assert.ok(seen, 'se llamó al gate');
  assert.equal(seen.fromMonth, '2020-01', 'fromMonth es la temporada que iba a cerrar');
  assert.ok(seen.toMonth && seen.toMonth !== '2020-01', 'toMonth es el mes nuevo');
  assert.ok(seen.date instanceof Date, 'recibe la fecha');
});
