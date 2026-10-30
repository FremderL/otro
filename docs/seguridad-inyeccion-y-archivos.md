# Seguridad: inyección de scripts y archivos maliciosos

Revisión del código del casino con foco en XSS (inyección de scripts) y archivos maliciosos.
Las pruebas viven en `tests/security-csp.test.js`.

## Qué se revisó y qué queda como está

- **Render de texto de usuario.** Chat, nombres de mesa y de jugador, espectadores, toasts,
  reportes, cuentas del admin y el calendario escapan HTML (`escapeHtml`, `esc`, `formatChatText`,
  `textContent`). Los datos de equipo llegan del servidor y se escapan igual.
- **Dependencias.** `npm audit --omit=dev`: 0 vulnerabilidades.
- **Secretos en el código.** Ninguno detectado.
- **Promociones con enlace.** Solo se admiten rutas internas (`/`, `/estadio`, `/terminos`, `/room/CODIGO`).
  No hay enlaces externos, así que no hay vector de phishing por esa vía.
- **Imágenes de anunciantes.** Solo PNG o JPEG validados por estructura. Se conservan únicamente
  los chunks PNG de una lista blanca (IHDR, PLTE, IDAT, IEND, tRNS), así que nada añadido después
  de IEND sobrevive. Se sirven con `nosniff` y tipo fijo por extensión.

## Cambios de este revisión

1. **Content-Security-Policy en todas las respuestas** (`lib/security-hardening.js`):
   `script-src 'self'` (sin inline ni `eval`), `object-src 'none'`, `base-uri 'self'`,
   `form-action 'self'`, `frame-ancestors 'self'`. Los estilos admiten `'unsafe-inline'`
   porque la interfaz usa atributos `style=` generados.
2. **Sin scripts ni manejadores inline** en las páginas públicas: la puerta de escritorio pasó
   a `public/gate.js` y el banner del Estadio a `public/estadio-banner.js`.
3. **Admin sin `style=` en HTML**: los colores de equipo se asignan desde JavaScript.
4. **Pruebas de regresión** para la CSP, la ausencia de inline en HTML, `eval` y la limpieza
   de imágenes con código añadido.

## Pendiente o a decidir

- `cleanName` y `cleanMessage` solo quitan `<` y `>`. Las comillas se conservan a propósito
  (texto normal en español) y dependen del escape al renderizar.
- `data/profiles.json` está versionado como semilla vacía; las corridas locales lo modifican.
  Conviene no commitear cambios de esa semilla por accidente.
- Las creatividades se guardan en disco local (`PROMOTION_MEDIA_DIR`). Con varias instancias,
  deben compartir almacenamiento (ya señalado antes).


## Identidad y moderación de Estadio

Con sesiones habilitadas, un socket autenticado usa el perfil verificado y no el
ID enviado en el payload. Un invitado no puede ocupar un perfil con nombre de
cuenta mediante su ID; una cuenta suspendida o bloqueada no puede suscribirse
al Estadio y los handlers vuelven a verificar el estado. El modo legado sin
sesiones conserva el riesgo de suplantación por token y multicuentas. No se ha
migrado la identidad por hash, de acuerdo con el alcance de bajo riesgo.

La migración aditiva `001_moderacion_cuentas.sql` se probó en una base PostgreSQL
aislada: sesiones, reporte, evidencia, acción, auditoría y revocación. Para
instalarla en otro entorno debe ejecutarse `npm run migrate:db`; el commit no la
ejecuta ni activa la administración. Activarla requiere su configuración segura
y verificación operativa. Esta prueba no demuestra seguridad entre múltiples
instancias del saldo general.
