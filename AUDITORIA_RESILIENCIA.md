# Auditoría de resiliencia — 2026-09-29

Auditoría completa del código motivada por el reporte de una usuaria: al
cambiar su nombre en el perfil o al destacar un logro en la vitrina aparecía
**«Perfil no disponible.»**. La causa raíz resultó ser un `ReferenceError` que
tumbaba el proceso entero del servidor; esta auditoría buscó **otros errores
de la misma naturaleza** (una sola excepción capaz de tumbar el casino
completo y borrar todas las mesas, que viven en memoria) y los caminos sin
cobertura de pruebas que los ocultaban.

## Cadena del incidente original (verificada con reproducción)

1. `join_room` referenciaba `featuredAchievements`, una variable que ese evento
   nunca recibe → `ReferenceError` cada vez que una jugadora **ya sentada**
   volvía a entrar con su mismo token (recarga de página o reconexión
   automática). Ningún test reingresaba con un token en uso: cobertura cero.
2. Sin `process.on('uncaughtException')`, una excepción en un handler mataba el
   proceso → en Render el servicio reiniciaba y **todas las mesas en memoria
   desaparecían** para todos los visitantes.
3. El cliente reintentaba recuperar la mesa, fallaba con "Esa sala no existe",
   pero **conservaba `ui.room` obsoleto** ("mesa fantasma").
4. Desde esa mesa fantasma, editar el perfil enviaba `profile_update` sin
   contexto válido → **«Perfil no disponible.»** en nombre y vitrina (mismo
   handler). Además, el botón de guardar quedaba deshabilitado para siempre
   si el servidor no respondía.

## Hallazgos de la auditoría (misma clase de riesgo)

| # | Ubicación | Riesgo | Estado |
|---|---|---|---|
| 1 | `join_room` (`server.js`) | `ReferenceError` → muerte del proceso en cada reingreso | **Corregido** |
| 2 | Handlers de socket (`server.js`) | Cualquier excepción en los 29 eventos mataba el proceso | **Corregido** (envoltura por evento con ack de error) |
| 3 | `scheduleRoomTask` (`server.js`) | Timeouts de turno (auto-fold/stand), resolución de ruleta/dados/coinflip y limpieza de mesas corrían sin try/catch | **Corregido** |
| 4 | `BotController.runTask` (`lib/bots`) | Los timers de bots ejecutan toda la lógica de juegos; solo `decide()` estaba protegida. `execute`, `fallbackDecision`, `getView`, `announce` y `broadcast` podían matar el proceso | **Corregido** |
| 5 | `hostInactivitySweep` (`server.js`) | `setInterval` de migración de anfitrión sin try/catch | **Corregido** (por mesa) |
| 6 | `seasonSweep` (`server.js`) | `setInterval` de cierre de temporada y poda de cuentas sin try/catch | **Corregido** |
| 7 | `io.on('connection')` (`server.js`) | El snapshot inicial del lobby no estaba cubierto por la envoltura de handlers | **Corregido** |
| 8 | `public/app.js` (`emitAck`) | Si el servidor no respondía, el botón quedaba deshabilitado para siempre | **Corregido** |
| 9 | `public/app.js` (recuperación de mesa) | `ui.room` obsoleto permitía editar un "perfil fantasma" → «Perfil no disponible.» | **Corregido** (se sale a la landing) |
| 10 | Proceso completo | No existía red de último nivel | **Corregido** (`uncaughtException`/`unhandledRejection` registran y mantienen el servicio vivo) |

## Verificado como correcto (sin cambios)

- **Variables no definidas en todo el repo**: análisis estático con ESLint
  (`no-undef`) sobre `server.js`, `lib/`, `scripts/`, `tests/` y
  `public/app.js` → **0 errores** (el `ReferenceError` original era el único).
  Verificado además con una sonda que sí fue detectada.
- **Almacenamiento Postgres** (`lib/profile-store-pg.js`): consultas con
  reintentos, guardado en segundo plano ante fallos de Neon, `saveNow` que
  nunca propaga, transacciones con `ROLLBACK` y cierre tolerante a errores.
- **Arranque**: `bootstrap()` espera a que el store esté listo antes de abrir
  el puerto; si Postgres no responde, el proceso falla al arrancar (correcto:
  Render lo reintenta) en vez de servir con memoria vacía.
- **Rutas HTTP de Express**: todas síncronas y simples; Express 4 captura sus
  excepciones.
- **`gracefulShutdown`**: guardado con margen de tiempo, aviso a las mesas y
  salida forzada acotada, todo con try/catch.
- **Cliente**: sesiones de `localStorage`/`sessionStorage` con try/catch y
  sanitización por lista blanca.

## Protecciones permanentes agregadas

- `npm run lint` (ESLint con `no-undef`) integrado a `npm run check`: ninguna
  variable inexistente vuelve a llegar a producción sin que el CI la rechace.
- `tests/rejoin-smoke.js` (regresión del incidente): reingresar a una mesa con
  el mismo token conserva el asiento, el proceso sobrevive y el perfil se
  puede editar.
- `tests/bot-guard-unit.js`: siembra tareas de bot con callbacks que explotan
  (`execute`, `getView`, `broadcast`) y verifica que nunca se propaga una
  excepción, que el error queda registrado y que el bot no se queda
  "pensando" para siempre.

## Filosofía aplicada

Todas las envolturas siguen el mismo criterio documentado en el código:
**perder UNA jugada, UN barrido o UNA mesa con error registrado siempre es
mejor que perder TODAS las mesas de TODOS los visitantes.** Los errores no se
tragan en silencio: quedan en el log con stack (`console.error`) y en el log
estructurado (`logEvent`) para poder encontrarlos y arreglarlos.
