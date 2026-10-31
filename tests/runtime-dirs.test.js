'use strict';

// Arranque a prueba de carpetas faltantes: el despliegue parte de un árbol limpio
// (solo lo versionado), así que toda ruta de estado configurada debe existir
// ANTES de abrir el puerto, y un disco de solo lectura debe fallar al arrancar
// con un mensaje que nombre la ruta, no a mitad de un guardado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureRuntimeDirs } = require('../lib/runtime-dirs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dirs-'));
const rm = dir => fs.rmSync(dir, { recursive: true, force: true });

test('crea las carpetas de archivos de estado y de medios que aún no existen', () => {
  const root = tmp();
  try {
    const { created } = ensureRuntimeDirs([
      path.join(root, 'a', 'b', 'profiles.json'),
      path.join(root, 'c', 'loteria.json'),
      path.join(root, 'media')
    ]);
    assert.equal(created.length, 3);
    for (const dir of [path.join(root, 'a', 'b'), path.join(root, 'c'), path.join(root, 'media')]) {
      assert.equal(fs.statSync(dir).isDirectory(), true, dir);
    }
  } finally { rm(root); }
});

test('es idempotente y soporta rutas nulas (configuración opcional sin definir)', () => {
  const root = tmp();
  try {
    const target = path.join(root, 'x', 'football.json');
    ensureRuntimeDirs([target, null, undefined, '']);
    const second = ensureRuntimeDirs([target]);
    assert.equal(second.created.length, 0, 'la segunda pasada no crea nada');
  } finally { rm(root); }
});

test('falla cerrado y nombra la ruta cuando la carpeta no se puede crear', () => {
  const root = tmp();
  try {
    // Un archivo donde debería ir una carpeta: mkdir recursivo no puede.
    const blocker = path.join(root, 'bloqueo');
    fs.writeFileSync(blocker, 'no soy una carpeta');
    assert.throws(
      () => ensureRuntimeDirs([path.join(blocker, 'sub', 'profiles.json')], { label: 'estado' }),
      error => /No se pudo preparar la carpeta de estado/.test(error.message)
        && error.message.includes(path.join(blocker, 'sub', 'profiles.json'))
    );
    assert.throws(
      () => ensureRuntimeDirs([blocker]),
      error => /no es una carpeta/.test(error.message)
    );
  } finally { rm(root); }
});
