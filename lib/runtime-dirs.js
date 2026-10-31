'use strict';

// Arranque a prueba de carpetas faltantes (§ despliegue).
//
// En Render el disco persistente se monta en /var/data y casi todo lo demás de
// la app vive en un checkout limpio: NO existe ningún directorio que no esté
// versionado. Los stores ya crean la carpeta de su archivo al primer guardado y
// el servicio de medios al primer guardado de una creatividad, pero eso deja dos
// agujeros: (1) una ruta mal configurada o un disco de solo lectura solo se
// descubre cuando alguien intenta guardar (un pago, una foto), no al arrancar; y
// (2) cualquier carpeta auxiliar que aún no cree nadie aparece como ENOENT a
// mitad de una transacción. Este preflight las crea todas de golpe, antes de
// abrir el puerto, y falla cerrado con un mensaje que dice QUÉ ruta y POR QUÉ.
const fs = require('node:fs');
const path = require('node:path');

// Recibe las rutas de *archivo* o de *carpeta* que la configuración declara.
// Devuelve { created, ok } para el log de arranque.
function ensureRuntimeDirs(paths, { label = 'datos' } = {}) {
  const created = [];
  for (const entry of paths) {
    if (!entry) continue;
    try {
      const dir = entry.endsWith(path.sep) || !path.extname(entry) ? entry : path.dirname(entry);
      if (dir === '.' || dir === '') continue;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(dir);
      } else if (!fs.statSync(dir).isDirectory()) {
        throw new Error('existe pero no es una carpeta');
      }
    } catch (error) {
      throw new Error(
        `No se pudo preparar la carpeta de ${label} "${entry}": ${error.message}. ` +
        'Revisa la ruta o los permisos del disco persistente (en Render: mount path /var/data).'
      );
    }
  }
  return { created };
}

module.exports = { ensureRuntimeDirs };
