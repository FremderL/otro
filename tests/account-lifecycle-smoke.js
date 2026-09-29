'use strict';

// Fase 11.4 — Ciclo de vida de cuentas y premios de fin de temporada.
//
// Todo unitario (sin servidor ni red), reutilizando el mismo patrón de
// profile-history-smoke.js: una subclase mínima de BaseProfileStore que no
// toca disco ni Postgres, así se prueba la lógica compartida directamente.
//
// Cubre tres cosas pedidas explícitamente:
//   1. Al cerrar una temporada, los puntos de la gráfica de saldo de la
//      temporada anterior se descartan (no solo se recortan) para ahorrar
//      espacio — la nueva temporada arranca su propia gráfica desde cero.
//      (verificado también, en detalle, en profile-history-smoke.js)
//   2. deleteProfile()/pruneInactiveAccounts(): las cuentas sin actividad por
//      más de ~3 meses se eliminan por completo (y quedan marcadas para que
//      el backend de Postgres también borre su fila, no solo la memoria).
//   3. El banner dorado del ranking se entrega una sola vez en la vida del
//      perfil (ganar otra temporada no da un segundo banner); la medalla de
//      oro sí se acumula, una más por cada temporada ganada.

const assert = require('node:assert/strict');
const { BaseProfileStore } = require('../lib/profile-store-base');
const { cleanProfile, INACTIVITY_LIMIT_MS } = require('../lib/profile-store-shared');

class MemStore extends BaseProfileStore {
  load() {}
  saveNow() {} // en la prueba no nos interesa persistir, solo el estado en memoria
}

function addProfile(store, overrides = {}) {
  const profile = cleanProfile({ id: `p-${Math.random().toString(36).slice(2)}`, ...overrides });
  store.profiles.set(profile.id, profile);
  return profile;
}

function testDeleteProfile() {
  const store = new MemStore();
  const a = addProfile(store, { name: 'A' });
  const b = addProfile(store, { name: 'B' });

  assert.equal(store.deleteProfile('no-existe'), false, 'borrar un id inexistente no hace nada y devuelve false');
  assert.equal(store.deleteProfile(a.id), true, 'borrar un perfil existente devuelve true');
  assert.equal(store.profiles.has(a.id), false, 'el perfil borrado ya no está en memoria');
  assert.equal(store.profiles.has(b.id), true, 'el otro perfil no se toca');
  // Fase 11.4: PgProfileStore._writeSnapshot() usa esto para saber qué DELETE
  // emitir contra Postgres; sin esto, la fila quedaría para siempre en la base.
  assert.ok(store._pendingDeletes.has(a.id), 'el id borrado queda marcado como pendiente de confirmar en el backend persistente');
}

function testPruneInactiveAccounts() {
  const store = new MemStore();
  const now = Date.now();
  const muyInactiva = addProfile(store, { name: 'Fantasma' });
  muyInactiva.updatedAt = now - 200 * 24 * 60 * 60 * 1000; // 200 días sin tocar
  const justoInactiva = addProfile(store, { name: 'Casi olvidada' });
  justoInactiva.updatedAt = now - 91 * 24 * 60 * 60 * 1000; // poquito más de 3 meses
  const activa = addProfile(store, { name: 'Jugadora activa' });
  activa.updatedAt = now - 1 * 24 * 60 * 60 * 1000; // ayer

  const removed = store.pruneInactiveAccounts(INACTIVITY_LIMIT_MS);
  const removedNames = removed.map(entry => entry.name).sort();
  assert.deepEqual(removedNames, ['Casi olvidada', 'Fantasma'], 'se eliminan exactamente las dos cuentas inactivas por más de ~3 meses');
  assert.equal(store.profiles.has(muyInactiva.id), false, 'la cuenta muy inactiva se eliminó');
  assert.equal(store.profiles.has(justoInactiva.id), false, 'la cuenta justo por encima del límite también se eliminó');
  assert.equal(store.profiles.has(activa.id), true, 'la cuenta activa recientemente se conserva');
  assert.equal(store.profiles.size, 1, 'solo queda la cuenta activa');

  // Una segunda pasada no vuelve a "encontrar" nada que borrar.
  const secondPass = store.pruneInactiveAccounts(INACTIVITY_LIMIT_MS);
  assert.equal(secondPass.length, 0, 'una segunda poda no encuentra más cuentas inactivas');
}

function testBannerUnicoYMedallasColeccionables() {
  const store = new MemStore();
  const campeona = addProfile(store, { name: 'Campeona' });
  campeona.chips = 5000;
  addProfile(store, { name: 'Segunda' }).chips = 2000;

  // --- Cierra la primera temporada: Campeona gana su primer banner y medalla ---
  store.seasons.current = '2000-01';
  const closed1 = store.ensureSeason();
  assert.ok(closed1, 'la temporada vieja se cierra');
  assert.equal(closed1.bannerAwarded, true, 'primera vez que alguien queda primero: se anuncia el banner nuevo');
  assert.equal(campeona.championBanner, true, 'la campeona recibe el banner dorado');
  assert.equal(campeona.medals, 1, 'y su primera medalla de oro');
  assert.equal(closed1.podium[0].championBanner, true, 'el podio archivado refleja el banner');
  assert.equal(closed1.podium[0].medals, 1, 'el podio archivado refleja la medalla');

  // --- Campeona vuelve a quedar primera en la temporada siguiente ---
  campeona.chips = 9000; // sigue siendo la líder tras el reinicio a 1000 de todos
  store.seasons.current = '2000-02';
  const closed2 = store.ensureSeason();
  assert.ok(closed2, 'la segunda temporada también se cierra');
  assert.equal(closed2.bannerAwarded, false, 'ya tenía banner: no se entrega ni se anuncia un segundo banner');
  assert.equal(campeona.championBanner, true, 'el banner sigue siendo true (no se quita ni se duplica)');
  assert.equal(campeona.medals, 2, 'pero sí se suma una medalla de oro más (coleccionable)');
}

function main() {
  testDeleteProfile();
  testPruneInactiveAccounts();
  testBannerUnicoYMedallasColeccionables();
  console.log('✅ account-lifecycle-smoke: borrado de cuentas, poda por inactividad (~3 meses), banner dorado único y medallas coleccionables OK');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error('❌ account-lifecycle-smoke falló:', error.message);
  process.exit(1);
}
