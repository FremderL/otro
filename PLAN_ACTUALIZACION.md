# Plan de actualización incremental — MonteCristo

**Enfoque del producto:** MonteCristo es un casino social multijugador **exclusivo para computadoras de escritorio y laptops**. No se dará soporte a celulares ni tablets: en lugar de mantener una interfaz responsive, se aprovechará el espacio, el teclado y el mouse propios del escritorio.

**Entorno de despliegue:** Render (Web Service Node.js, `npm start`, Socket.IO por WebSocket). Cada fase termina en un estado desplegable: se sube a Render, se valida y recién entonces comienza la siguiente fase.

---

## Estado actual (línea base)

- Renombrado a **MonteCristo** completado (marca, `<title>`, meta descripción, paquete, logs y claves de almacenamiento con migración automática desde las claves antiguas de los jugadores existentes).
- Servidor Express + Socket.IO autoritativo, ya compatible con Render: escucha en `0.0.0.0` y respeta `process.env.PORT`.
- 5 juegos (Texas Hold'em, Blackjack, Ruleta Nova, Dados Cósmicos, Cara o Cruz), bots, perfiles persistentes en `data/profiles.json`, retos, logros y eventos especiales.
- CSS con ~11 media queries móviles que serán retiradas (fase 1).
- Suite de smoke tests (`npm test`) en verde.

---

## Fase 1 — Escritorio como única plataforma (fundación)

*Objetivo: declarar y aplicar la política "solo computadoras" sin romper nada de lo existente.*

1. **Puerta de entrada por tamaño de pantalla.** Pantalla de bloqueo amable cuando el viewport sea menor a **1024 px de ancho**: logo MonteCristo + mensaje "MonteCristo está diseñado para jugarse en computadora". Sin redirecciones ni detección de user-agent frágil; solo `matchMedia`.
2. **Retirar el CSS móvil.** Eliminar las media queries de `max-width: 520/600/780/900px` de `styles.css` (conservando `prefers-reduced-motion`). Fijar un ancho mínimo de diseño (`min-width: 1024px` en `body`) para que nada colapse.
3. **Simplificar dimensiones táctiles.** Reducir las áreas táctiles sobredimensionadas a tamaños de puntero de escritorio; recuperar densidad de información (más filas visibles en lobby, chat y clasificación).
4. **Documentación.** Actualizar `README.md`: quitar la mención a "interfaz responsive para computadora y celular" y documentar la política de escritorio y la resolución mínima soportada (1024×720; diseño óptimo 1280×800+).
5. **Criterio de aceptación:** `npm test` en verde; la página funciona idéntica en 1280×800 y 1920×1080; en < 1024 px se ve la pantalla de bloqueo.

**Entregable en Render:** deploy normal, sin cambios de configuración.

## Fase 2 — Experiencia nativa de escritorio

*Objetivo: convertir la restricción en ventaja usando teclado, mouse y espacio.*

1. **Atajos de teclado en mesa:** `F` fold, `C` check/call, `R` foco en raise, `Enter` confirmar apuesta, `T` foco en chat, `Esc` cerrar modales. Leyenda de atajos visible con `?`.
2. **Estados hover ricos:** tooltips en cartas, fichas, insignias de bots y logros; previsualización de pago al pasar el mouse sobre las apuestas de ruleta/dados.
3. **Layout de tres columnas fijo en sala** (clasificación | mesa | chat) sin colapsos: con ≥1280 px todo es visible simultáneamente, sin toggles pensados para móvil.
4. **Menús contextuales** (clic derecho sobre un asiento: ver perfil, reaccionar) y scroll fino en historial de chat/ganadores.
5. **Criterio de aceptación:** una mano completa de póker jugable solo con teclado; ningún panel oculto tras toggles en ≥1280 px.

**Entregable en Render:** deploy normal.

## Fase 3 — Robustez operativa en Render

*Objetivo: que el hosting no borre datos ni degrade la experiencia.*

1. **Persistencia real de perfiles.** El disco de Render es **efímero**: `data/profiles.json` se pierde en cada deploy/reinicio. Acciones:
   - Contratar un **Persistent Disk** de Render montado (p. ej. en `/var/data`) y apuntar `PROFILE_STORE_PATH=/var/data/profiles.json`, **o** migrar el `ProfileStore` a una base gestionada (Render PostgreSQL o Redis) detrás de la misma interfaz.
   - El código ya acepta `PROFILE_STORE_PATH`, así que la opción de disco no requiere cambios de código.
2. **Endpoint de salud** `GET /healthz` (estado, uptime, salas activas) y configurarlo como *Health Check Path* en Render para deploys sin caída (zero-downtime).
3. **Arranque en frío del plan free.** Si se usa plan free, Render suspende el servicio tras inactividad (~15 min) y tarda ~50 s en despertar. Mitigar: mejorar la pantalla de carga ("Despertando la sala…") con reintentos de Socket.IO visibles; a mediano plazo, pasar a plan Starter para eliminar la suspensión.
4. **Apagado limpio (`SIGTERM`).** Render envía SIGTERM en cada deploy: guardar perfiles pendientes, avisar a las salas ("El servidor se reiniciará…") y cerrar sockets con gracia para que la reconexión automática reencuentre la sesión.
5. **Logs estructurados** (JSON por línea: sala, evento, jugador) para aprovechar el visor de logs de Render.
6. **Criterio de aceptación:** un redeploy no pierde perfiles ni expulsa definitivamente a los jugadores conectados (reconexión < 10 s).

**Entregable en Render:** variables `PROFILE_STORE_PATH` y health check configurados; `render.yaml` (Infrastructure as Code) versionado en el repo.

## Fase 4 — Contenido y retención

*Objetivo: crecer el juego sobre la base ya estabilizada.*

1. **Torneos de sala** (sit & go de póker con ciegas crecientes) — el formato brilla en pantallas grandes.
2. **Estadísticas ampliadas de perfil:** gráficas de saldo por sesión, historial por juego, % de victorias; panel lateral que solo cabe en escritorio.
3. **Espectadores:** entrar a una sala llena en modo observador con chat.
4. **Nuevas variantes:** ruleta con apuestas a docenas/columnas, blackjack con seguro y split.
5. **Criterio de aceptación:** cada característica entra por separado con su smoke test correspondiente en `npm test`.

**Entregable en Render:** deploys independientes por característica.

## Fase 5 — Calidad continua

1. **CI en GitHub:** `npm test` en cada push/PR (GitHub Actions) antes del auto-deploy de Render.
2. **Preview environments de Render** por pull request para probar cambios visuales de escritorio.
3. **Presupuesto de rendimiento:** primera carga < 2 s en escritorio, payloads de Socket.IO auditados por ronda.
4. **Revisión trimestral** de dependencias (`express`, `socket.io`) y del tamaño del store de perfiles.

---

## Orden y ritmo sugerido

| Fase | Alcance | Esfuerzo estimado | Riesgo |
|------|---------|-------------------|--------|
| 1 | Política solo-escritorio | Bajo (1 iteración) | Bajo |
| 2 | UX nativa de escritorio | Medio (2–3 iteraciones) | Bajo |
| 3 | Robustez en Render | Medio (1–2 iteraciones) | **Alto impacto**: evita pérdida de datos |
| 4 | Contenido nuevo | Alto (continuo) | Medio |
| 5 | Calidad continua | Bajo (transversal) | Bajo |

> **Nota:** si el servicio ya tiene jugadores reales, conviene adelantar el punto 3.1 (persistencia de perfiles) inmediatamente después de la fase 1, porque hoy cada deploy en Render borra `data/profiles.json`.

## Reglas del proceso incremental

- Una fase = una o más entregas pequeñas; **nunca** se mezclan fases en un mismo deploy.
- Antes de cada deploy: `npm test` en verde y prueba manual en 1280×800 y 1920×1080.
- Todo cambio de configuración de Render queda documentado en `render.yaml` dentro del repo.
- Las fichas siguen siendo 100 % virtuales: ninguna fase introduce pagos ni dinero real.
