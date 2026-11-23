'use strict';

// Escritura atómica de archivos JSON con fsync.
//
// El patrón tmp + rename protege frente a caídas del proceso, pero sin fsync
// una pérdida de energía puede dejar el archivo nuevo sin sus datos en disco
// (o el directorio sin la entrada del rename). Aquí se hace fsync del archivo
// temporal y del directorio contenedor antes de dar por bueno el guardado.
//
// Además serializa escrituras concurrentes al mismo destino con una cola
// por ruta: dos saveNow() solapados ya no pueden intercalarse a mitad de
// JSON.stringify/write/rename.

const fs = require('node:fs');
const path = require('node:path');

const queues = new Map();

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (_) {
    // Algunos sistemas de archivos no permiten fsync de directorios; el
    // rename ya es atómico y el fsync del archivo cubre el caso común.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
    }
  }
}

function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${filePath}.tmp`;
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  fsyncDir(dir);
}

// Serializa fn() por ruta: las llamadas concurrentes se encolan y nunca se
// solapan. Devuelve una promesa que resuelve/rechaza con el resultado de fn.
function withFileLock(filePath, fn) {
  const key = String(filePath);
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(() => fn(), () => fn());
  // La cola nunca debe quedar rechazada: el siguiente espera al anterior
  // aunque falle.
  queues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

module.exports = { atomicWriteFileSync, withFileLock, fsyncDir };
