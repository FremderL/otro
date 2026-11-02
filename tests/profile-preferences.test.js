'use strict';

// Preferencias del perfil (pestaña Preferencias): interruptores de los
// automatismos del casino. Lo que se prueba aquí es la parte que decide de
// verdad, no la interfaz:
//   · el catálogo cerrado de claves y su limpieza compartida JSON/Postgres;
//   · que `update` solo cambie lo enviado y valide los booleanos;
//   · que viajen al dueño del perfil (publicProgress privado) y nunca al público;
//   · que la política de bots de la mesa respete «sin autocompletar» y
//     «los bots se quedan entre rondas».

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  cleanProfile, cleanPreferences, applyPreferenceChanges, preferenceEnabled, PREFERENCE_DEFAULTS, PREFERENCE_KEYS
} = require('../lib/profile-store-shared');
const { ProfileStore } = require('../lib/profile-store');
const { publicProgress } = require('../lib/progression');
const {
  autoBotsForProfile, roomAllowsAutoBots, hostProfileOf, hostPrefersBotsStay
} = require('../lib/bots/room-policy');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  const store = new ProfileStore(path.join(dir, 'profiles.json'));
  t.after(() => { try { store.saveNow(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('las preferencias tienen valores por defecto históricos y un catálogo cerrado', () => {
  assert.deepEqual({ ...PREFERENCE_DEFAULTS }, { autoBots: true, botsStay: false, tableInvites: true });
  assert.deepEqual([...PREFERENCE_KEYS], ['autoBots', 'botsStay', 'tableInvites']);
  // Un perfil nuevo (o viejo, sin el bloque) arranca con los valores por defecto.
  assert.deepEqual(cleanProfile({ id: 'p1', name: 'Ana' }).preferences, { ...PREFERENCE_DEFAULTS });
  assert.deepEqual(cleanProfile({ id: 'p1', preferences: null }).preferences, { ...PREFERENCE_DEFAULTS });
});

test('cleanPreferences descarta claves desconocidas y valores que no son booleanos', () => {
  const cleaned = cleanPreferences({
    autoBots: false, botsStay: 'sí', tableInvites: 1, hack: true, __proto__: { autoBots: false }
  });
  assert.deepEqual(cleaned, { autoBots: false, botsStay: false, tableInvites: true });
  // Un arreglo o un valor raro no rompe: se vuelve a los valores por defecto.
  assert.deepEqual(cleanPreferences(['autoBots']), { ...PREFERENCE_DEFAULTS });
  assert.deepEqual(cleanPreferences('autoBots'), { ...PREFERENCE_DEFAULTS });
});

test('applyPreferenceChanges mezcla solo lo enviado (dos pantallas no se pisan)', () => {
  const base = { autoBots: true, botsStay: false, tableInvites: true };
  assert.deepEqual(applyPreferenceChanges(base, { autoBots: false }), { autoBots: false, botsStay: false, tableInvites: true });
  assert.deepEqual(applyPreferenceChanges({ autoBots: false, botsStay: true, tableInvites: true }, { tableInvites: false }),
    { autoBots: false, botsStay: true, tableInvites: false });
  // Sin cambios válidos devuelve una copia limpia, nunca undefined.
  assert.deepEqual(applyPreferenceChanges(base, { autoBots: 'no' }), base);
});

test('profiles.update guarda preferencias parciales y las persiste en disco', t => {
  const store = tempStore(t);
  const profile = store.getOrCreate('dev-1', 'Ana');
  store.update(profile, { preferences: { autoBots: false } });
  assert.equal(profile.preferences.autoBots, false);
  assert.equal(profile.preferences.botsStay, false, 'lo no enviado conserva su valor');
  store.update(profile, { preferences: { botsStay: true, basura: 9 } });
  assert.equal(profile.preferences.autoBots, false, 'el segundo cambio no revierte el primero');
  assert.equal(profile.preferences.botsStay, true);
  assert.equal(profile.preferences.basura, undefined);
  store.saveNow();
  // Releer del archivo: el limpiador compartido conserva el bloque.
  const reloaded = new ProfileStore(store.filePath);
  t.after(() => { try { reloaded.saveNow(); } catch (_) {} });
  const again = reloaded.getProfile('dev-1');
  assert.deepEqual(again.preferences, { autoBots: false, botsStay: true, tableInvites: true });
});

test('las preferencias viajan solo al dueño del perfil', t => {
  const store = tempStore(t);
  const profile = store.getOrCreate('dev-2', 'Bea');
  store.update(profile, { preferences: { autoBots: false } });
  const priv = publicProgress(profile, true);
  assert.deepEqual(priv.preferences, { autoBots: false, botsStay: false, tableInvites: true });
  // El perfil público (mesa, ranking, comunidad) no expone los interruptores.
  assert.equal(publicProgress(profile).preferences, undefined);
});

test('preferenceEnabled lee el valor del perfil o el del catálogo', () => {
  assert.equal(preferenceEnabled({ preferences: { tableInvites: false } }, 'tableInvites'), false);
  assert.equal(preferenceEnabled({ preferences: { tableInvites: true } }, 'tableInvites'), true);
  assert.equal(preferenceEnabled({}, 'tableInvites'), true, 'sin bloque se usa el valor histórico');
  assert.equal(preferenceEnabled(null, 'botsStay'), false, 'los bots no se quedan si no se pidió');
  assert.equal(preferenceEnabled({ preferences: { tableInvites: false } }, 'claveInexistente'), true);
});

test('política de bots: una mesa creada sin autocompletado nunca los recibe', () => {
  assert.equal(autoBotsForProfile({ preferences: { autoBots: false } }), false);
  assert.equal(autoBotsForProfile({ preferences: { autoBots: true } }), true);
  assert.equal(autoBotsForProfile(null), true, 'sin perfil se mantiene el comportamiento histórico');

  assert.equal(roomAllowsAutoBots({ autoBots: false }), false);
  assert.equal(roomAllowsAutoBots({ autoBots: true }), true);
  assert.equal(roomAllowsAutoBots({}), true, 'una sala antigua sin el campo sigue admitiendo bots');
  assert.equal(roomAllowsAutoBots(null), false);
});

test('política de bots: el anfitrión que pide mantener bots se lee de su perfil', () => {
  const host = { id: 'h1', _profile: { preferences: { botsStay: true } } };
  const other = { id: 'p2', _profile: { preferences: { botsStay: false } } };
  const room = { hostId: 'h1', players: [host, other] };
  assert.equal(hostProfileOf(room), host._profile);
  assert.equal(hostPrefersBotsStay(room), true);
  // Si el asiento de anfitrión lo ocupa un bot, no hay preferencias que valgan.
  const bot = { id: 'b1', isBot: true, _profile: { preferences: { botsStay: true } } };
  assert.equal(hostPrefersBotsStay({ hostId: 'b1', players: [bot, host] }), false);
  assert.equal(hostPrefersBotsStay({ hostId: 'nadie', players: [host] }), false);
  assert.equal(hostPrefersBotsStay(null), false);
});
