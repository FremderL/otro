# Auditoría: `Failed to load resource: the server responded with a status of 404`

Fecha: 2026-10-09
Alcance: causa raíz del 404 en la consola del navegador del casino (rama `arena/d0ee83e3-otro`).

## Resumen ejecutivo

- El mensaje es del **navegador**: se imprime para cualquier respuesta HTTP 404,
  aunque el JavaScript la maneje bien. Ningún `try/catch` del frontend puede
  suprimirlo; la única forma de quitarlo es **no generar la petición** o que el
  servidor no responda 404.
- **No falta ningún archivo estático.** Se cruzó cada referencia de recurso del
  frontend (HTML/CSS/JS) contra `public/` y las rutas del backend, y se
  reprodujo el servidor localmente probando cada ruta con `curl`. Todos los
  CSS, JS, imágenes y endpoints que se cargan en la página principal responden
  200.
- El 404 proviene de **endpoints de API que el backend apaga con 404
  fail-closed según feature flags** (`ACCOUNT_SESSIONS_ENABLED` /
  `ADMIN_FEATURE_ENABLED` / `FOOTBALL_ENABLED`). El frontend los llamaba de todos
  modos —automáticamente al cargar la página (con sesión cacheada) o al entrar a
  secciones—, produciendo el 404 en consola en cualquier entorno donde los flags
  están apagados (desarrollo local, previews sin env vars). En Render
  (`ADMIN_FEATURE_ENABLED=true`, `FOOTBALL_ENABLED=true`) esos 404 no ocurren en
  la carga normal; los que pueden verse allí son los de recursos puntuales
  (ver tabla).
- **Fix aplicado (solo frontend):** consultar `GET /healthz` —ya público, expone
  `accountSessionsEnabled` y `football.enabled`— y evitar las peticiones a
  features apagadas. El contrato 404 fail-closed del backend se conserva intacto
  (es diseño intencional, verificado por tests).

## Mapa de 404s posibles (verificado con el servidor corriendo)

| Ruta | Causa del 404 | ¿Cuándo ocurre? | ¿Intencional? |
|---|---|---|---|
| `GET /api/auth/session`, `POST /api/auth/login`, `/logout`, `/change-password`, `/mfa/*` | `requireFeature`: `accountSessionsEnabled` apagado (`lib/account-auth-http.js:69,160,176,200`) | **Automático** al cargar la página si hay sesión cacheada (`socket.on('connect')` → `refreshAccountProfile`); al iniciar sesión, cerrar sesión o cambiar contraseña | Sí (fail-closed, testeado) |
| `GET /api/reports/mine`, `POST /api/reports` | `config.enabled` apagado (`lib/report-http.js:5,6`) | Al abrir el modal de reporte (con sesión) o al enviar un reporte | Sí (fail-closed) |
| `GET /estadio`, `GET /api/estadio/state`, `/standings`, `/matches/:id` | `FOOTBALL_ENABLED` apagado (`lib/football/http.js:51,56,85`) | **Automático** al cargar `/estadio` (`estadio.js` pedía `/api/estadio/state`); al seguir el enlace público `/estadio` del lobby | Sí (fail-closed, testeado) |
| `GET /admin`, `/api/admin/v1/*` | `ADMIN_FEATURE_ENABLED` apagado (`lib/admin-auth-http.js:25,91`) | Al navegar al panel (no lo carga el frontend público) | Sí (oculta la existencia del panel) |
| `GET /reset-password`, `POST /api/auth/reset-password` | `config.enabled` apagado (`lib/password-reset-http.js`) | Al abrir el enlace del correo (en local no hay correos) | Sí (fail-closed) |
| `POST /admin/estadio/*` | admin apagado (`lib/football/http.js:115`) o partido inexistente (`:121`) | Palancas operativas del estadio | Sí |
| `GET /api/perfil/:token/historial` | Perfil no existe en el store (`server.js:156`) | Al descargar el historial de un perfil que ya no está (retención, store distinto) | Sí (recurso inexistente = 404 correcto) |
| `POST /api/reports` | Usuario reportado no encontrado (`lib/report-http.js`) | Caso borde al reportar | Sí |
| Cualquier método **no-GET** a ruta inexistente | Express responde 404 por defecto; el catch-all `app.get('*')` (`server.js:222`) solo atrapa GET | No ocurre desde el frontend actual | — |

## Causa raíz

1. **El backend usa 404 para "feature apagada"** (fail-closed, deliberado y
   cubierto por tests como `tests/football-http.test.js` y
   `tests/football-admin-guard.test.js`). El frontend, además, **usa ese 404 como
   señal** de "rollout apagado" para activar fallbacks legados por socket
   (`refreshAccountProfile`, login y signup en `public/app.js`).
2. **El frontend no sabía qué features están habilitadas** y disparaba las
   peticiones igualmente. El navegador loguea el 404 de red en consola aunque el
   JS lo maneje: de ahí el error recurrente.
3. **Enmascaramiento por el catch-all:** `app.get('*')` responde **200 con
   `index.html`** para cualquier GET inexistente (verificado: `/favicon.ico`,
   `/ruta-inexistente`, `/api/ruta-inexistente` → 200). Por eso un 404 en consola
   **nunca** es un archivo estático mal referenciado en este servidor; descarta
   esa hipótesis.

## Fix aplicado

Solo frontend; el backend y sus tests no cambian.

- `public/app.js`
  - Lee `GET /healthz` una vez al arranque (`serverFlagsReady`) y cachea
    `accountSessionsEnabled`. Si `/healthz` falla, asume "encendido" y conserva
    el comportamiento anterior (cada flujo tolera el 404 como red de seguridad
    por si el flag cambió en vivo).
  - `refreshAccountProfile`, login, logout y cambio de contraseña van directo al
    fallback cuando las sesiones de cuenta están apagadas, **sin pedir
    `/api/auth/*`** y sin generar 404 en consola.
- `public/estadio.js`
  - Consulta `/healthz` antes de pedir `/api/estadio/state`; con
    `football.enabled === false` no hace la petición (y conecta el socket vía
    `gateTosThenConnect()`, antes la página quedaba muerta con el 404).

Verificado: `npm run check` (eslint 0 errores, sintaxis de 93 archivos OK) y
`node --test tests/*.test.js` → **207/207 pasan**.

## Recomendaciones (no aplicadas, a decisión del equipo)

1. **Favicon:** no hay `public/favicon.ico` ni `<link rel="icon">`; el navegador
   pide `/favicon.ico` y recibe 200 con HTML (por el catch-all). No es un 404,
   pero es ruido. Agregar `<link rel="icon" href="data:,">` en los HTML o un
   favicon real.
2. **Catch-all más estricto:** si un GET parece un archivo (extensión
   `.css/.js/.png/.jpg/.ico/.map`…) y no existe, responder 404 real en vez de
   `index.html`; hoy los typos de estáticos quedan enmascarados como 200.
   Mantener `index.html` para rutas sin extensión (la SPA usa `/room/:codigo`).
3. **`npm run test:unit` está roto en este checkout:** referencia tests que no
   existen (`tests/admin-config.test.js`, `tests/account-*.test.js`, etc.). En el
   repo solo existen los tests de `football-*` y `season-reset-gate`. Conviene
   corregir el script o restaurar los tests.
4. **Historial (`/api/perfil/:token/historial`):** el 404 es correcto cuando el
   perfil no existe. Si se quiere evitar el log en consola al descargar, bajar el
   archivo vía `fetch` + blob y mostrar el error como toast (el 404 seguirá
   logueándose; la alternativa es que el servidor devuelva 200 con cuerpo de
   error, que empeora la semántica HTTP).

## Nota sobre el log de Render

- El warning `SECURITY WARNING: The SSL modes 'prefer', 'require'...` es solo un
  aviso de `pg-connection-string` sobre el significado futuro de `sslmode`;
  **no está relacionado con el 404**. No requiere acción urgente.
- La `DATABASE_URL` impresa en `server_listening` llega redactada
  (`postgres://[host/db]`), así que no hay credenciales en logs.
