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
- **Bug conocido:** al salir un usuario de la mesa, a veces sigue apareciendo como presente (jugador "fantasma"). Se corrige en la fase 2.

---

## Fase 1 — Escritorio como única plataforma (fundación) ✅ COMPLETADA

*Objetivo: declarar y aplicar la política "solo computadoras" sin romper nada de lo existente.*

1. **Puerta de entrada por tamaño de pantalla.** Pantalla de bloqueo amable cuando el viewport sea menor a **1024 px de ancho**: logo MonteCristo + mensaje "MonteCristo está diseñado para jugarse en computadora". Sin redirecciones ni detección de user-agent frágil; solo `matchMedia`.
2. **Retirar el CSS móvil.** Eliminar las media queries de `max-width: 520/600/780/900px` de `styles.css` (conservando `prefers-reduced-motion`). Fijar un ancho mínimo de diseño (`min-width: 1024px` en `body`) para que nada colapse.
3. **Simplificar dimensiones táctiles.** Reducir las áreas táctiles sobredimensionadas a tamaños de puntero de escritorio; recuperar densidad de información (más filas visibles en lobby, chat y clasificación).
4. **Documentación.** Actualizar `README.md`: quitar la mención a "interfaz responsive para computadora y celular" y documentar la política de escritorio y la resolución mínima soportada (1024×720; diseño óptimo 1280×800+).
5. **Criterio de aceptación:** `npm test` en verde; la página funciona idéntica en 1280×800 y 1920×1080; en < 1024 px se ve la pantalla de bloqueo.

**Entregable en Render:** deploy normal, sin cambios de configuración.

## Fase 2 — Ciclo de vida de mesas, bots automáticos y presencia real ✅ COMPLETADA

*Objetivo: que las mesas siempre se sientan vivas, que los bots cedan el lugar a personas reales y que la presencia de cada jugador sea 100 % confiable.*

> Implementada con la variable `AUTO_BOTS` (por defecto activada; `off` restaura el modo manual para los smoke tests legados), `HOST_INACTIVITY_MS` (60 s), `RECONNECT_GRACE_MS` (90 s de gracia para reconexión antes de eliminar una mesa sin humanos conectados) y el nuevo smoke test `tests/table-lifecycle-smoke.js`. Extra: cuando una persona real llega a una mesa llena de bots, un bot le cede el asiento.

1. **Autollenado con bots expertos.** Al entrar un usuario a una mesa con asientos libres, el servidor completa automáticamente los asientos vacíos con bots en dificultad **experto**. El anfitrión ya no necesita agregarlos a mano (los controles manuales de bots quedan como ajuste opcional).
2. **Corrección de jugadores "fantasma".** Auditar todo el flujo de salida (botón salir, cierre de pestaña, pérdida de conexión, timeout de reconexión): el asiento debe liberarse y difundirse a todos los clientes de inmediato. Un solo camino de salida en el servidor (`removePlayer`) para evitar estados divergentes.
3. **Validación de presencia al iniciar partida.** Antes de arrancar cada partida/ronda, el servidor valida el estatus real de cada jugador sentado (socket vivo + latido reciente): quien ya salió se retira del asiento antes de repartir. La misma validación aplica al dueño de la mesa.
4. **Migración de autoridad por inactividad.** Si el anfitrión lleva **1 minuto sin actividad** en la mesa (sin acciones, apuestas ni latidos), la autoridad pasa automáticamente a otra **persona real** de la mesa (nunca a un bot). Se anuncia el cambio en el chat de la mesa.
5. **Bots que ceden el asiento.** Al terminar las rondas de la mesa (fase de resultados), los asientos ocupados por bots se **vacían automáticamente** para que queden disponibles para usuarios reales; si al iniciar la siguiente ronda siguen libres, se vuelven a llenar con bots expertos (regla 1).
6. **Eliminación de mesas sin humanos.** Si en una mesa no queda ninguna persona real, la mesa se elimina de inmediato (hoy existe un TTL de 5 minutos para salas solo-bots vía `BOT_ONLY_ROOM_TTL_MS`; se reduce a eliminación inmediata o TTL de segundos).
7. **Criterio de aceptación:** smoke tests nuevos que cubran: entrada → autollenado experto; salida abrupta → asiento liberado en < 5 s en todos los clientes; anfitrión inactivo 60 s → autoridad migrada a humano; fin de ronda → asientos de bots vacíos; última persona sale → mesa eliminada.

**Entregable en Render:** deploy normal. Variable `BOT_ONLY_ROOM_TTL_MS` ajustada en el dashboard o `render.yaml`.

## Fase 3 — Términos y condiciones (cumplimiento legal México) ✅ COMPLETADA

*Objetivo: dejar claro el carácter recreativo del sitio y deslindar responsabilidad por usos indebidos, conforme a la legislación mexicana.*

> Implementada: página `/terminos` (T&C + Aviso de Privacidad LFPDPPP), modal de aceptación obligatoria en la primera visita con versionado (`lib/terms.js` ↔ `TOS_VERSION` en `app.js`), registro de la aceptación con fecha y versión en el perfil del servidor, rechazo de `create_room`/`join_room` sin aceptación vigente, y enlaces permanentes en el pie de página y el modal de perfil. Pendiente: revisión del texto por abogado antes del lanzamiento público.

1. **Documento de Términos y Condiciones** (página `/terminos`) redactado para México, que incluya como mínimo:
   - **Naturaleza recreativa:** MonteCristo es un juego social de entretenimiento; todas las fichas son virtuales, sin valor monetario, sin depósitos, retiros, premios ni canjes. Por no mediar apuesta con dinero real, no constituye juego con apuesta en términos de la **Ley Federal de Juegos y Sorteos** y su Reglamento (no requiere permiso de la Secretaría de Gobernación).
   - **Edad mínima** (18 años) y declaración del usuario de que usa el sitio bajo su propia responsabilidad.
   - **Deslinde de responsabilidad:** el operador no responde por usos maliciosos, ilícitos o no autorizados de la página por parte de terceros o usuarios (fraude entre usuarios, suplantación, uso del chat para fines ilícitos, intentos de monetizar fichas fuera de la plataforma, etc.), conforme a los límites permitidos por el **Código Civil Federal** y la **Ley Federal de Protección al Consumidor**.
   - **Conducta prohibida** y facultad de suspender cuentas/dispositivos que la infrinjan.
   - **Aviso de privacidad** conforme a la **LFPDPPP** (Ley Federal de Protección de Datos Personales en Posesión de los Particulares): qué se guarda (nombre de jugador, avatar, token de dispositivo, estadísticas), finalidad, y medios para ejercer derechos ARCO.
   - Propiedad intelectual, jurisdicción y tribunales competentes (Estados Unidos Mexicanos), y política de modificaciones.
2. **Aceptación obligatoria.** Modal de aceptación en la primera visita (y en cada cambio de versión de los términos): el usuario **no puede crear ni entrar a salas sin aceptar**. La aceptación se guarda con versión y fecha (`montecristo-tos-accepted`) y se refleja también en el perfil del servidor para que sobreviva a limpiezas de `localStorage`.
3. **Enlaces permanentes** a Términos y Aviso de Privacidad en el pie de página y en el modal de perfil.
4. **Criterio de aceptación:** sin aceptación registrada no se puede jugar; el texto es accesible desde cualquier pantalla; el versionado fuerza re-aceptación al actualizar los términos.

> ⚠️ **Nota:** el texto legal debe ser revisado por un abogado mexicano antes de publicarse; el plan cubre la estructura, la implementación técnica y las referencias normativas, no sustituye asesoría legal.

**Entregable en Render:** deploy normal (ruta estática `/terminos` servida por Express).

## Fase 4 — Rediseño profesional, privacidad de cartas y UX de escritorio ✅ COMPLETADA (núcleo)

*Objetivo: un tono visual profesional y serio, con información privada realmente privada.*

> Implementado: privacidad de cartas de blackjack **en el servidor** (manos ajenas viajan como `XX` hasta los resultados; la casa ya ocultaba su segunda carta; póker ya estaba protegido), imágenes de lobby originales para Ruleta Nova, Dados Cósmicos y Cara o Cruz (misma dirección de arte, < 200 KB, locales), atajos de teclado en mesa (`F/C/R/A` póker, `H/S/D` blackjack, `Enter` apuesta rápida, `T` chat, `?` leyenda, `Esc` cerrar) y previsualización de pagos en las apuestas rápidas. Pendiente para iteraciones futuras: menús contextuales con clic derecho y una pasada de sobriedad más profunda del tema visual.

1. **Rediseño visual sobrio.** Refinar la identidad hacia un casino elegante: paleta contenida (grafito profundo, dorado discreto, un solo acento), tipografía seria y jerarquía clara; reducir emojis decorativos, brillos y ruido visual en lobby, tarjetas y mesa; microinteracciones breves y discretas.
2. **Privacidad de cartas en Póker y Blackjack.** Cada usuario ve **únicamente sus propias cartas**; las de los demás se muestran boca abajo hasta el showdown (póker) o el cierre de la ronda (blackjack, salvo la carta visible del crupier).
   - **Estado actual:** en póker el servidor **ya oculta** las cartas ajenas (las envía como `XX` hasta el showdown); en blackjack, en cambio, `server.js` envía todas las manos abiertas a todos los clientes.
   - **Clave técnica:** replicar en blackjack la ocultación **en el servidor** (payload por jugador que nunca incluya cartas ajenas antes del cierre de la ronda), no solo en CSS/cliente, para que sea imposible espiar con las herramientas del navegador.
3. **UX nativa de escritorio:** atajos de teclado en mesa (`F` fold, `C` check/call, `R` foco en raise, `Enter` confirmar, `T` chat, `Esc` cerrar, `?` leyenda de atajos); tooltips y estados hover ricos (previsualización de pagos en apuestas); layout fijo de tres columnas en sala (clasificación | mesa | chat) sin toggles móviles; menús contextuales con clic derecho.
4. **Imágenes de lobby para los juegos rápidos.** Hoy solo Texas Hold'em y Blackjack tienen imagen (`poker-lounge.jpg`, `blackjack-lounge.jpg`); las tarjetas de **Ruleta Nova, Dados Cósmicos y Cara o Cruz** son solo CSS. Crear tres imágenes originales con la misma dirección de arte sobria (rueda de ruleta elegante, dados en ambiente cósmico, moneda dorada al aire), servidas como archivos locales en `public/assets/` (sin CDNs), optimizadas (< 200 KB c/u, mismo encuadre y proporción que las existentes) y con textos `alt` descriptivos.
5. **Criterio de aceptación:** auditoría de payloads confirmando que ningún cliente recibe cartas ajenas antes del showdown; una mano completa de póker jugable solo con teclado; las cinco tarjetas del lobby con imagen propia y estilo homogéneo; revisión visual aprobada en 1280×800 y 1920×1080.

**Entregable en Render:** deploy normal.

## Fase 5 — Ruleta completa con rueda animada ✅ COMPLETADA

*Objetivo: transformar Ruleta Nova en una experiencia de ruleta real, no solo botones.*

> **Estado (2026-09-28):** implementada. Paño europeo completo (0–36, rojo/negro, par/impar, 1–18/19–36, docenas y columnas x3) con fichas visibles: la propia al apostar y las de todos —con casillas ganadoras iluminadas— al revelarse la ronda. Rueda europea en canvas con el orden real de casillas: la pelota gira en sentido contrario, desacelera con rebotes y cae exactamente en el número autoritativo del servidor (~6.4 s, botón «Saltar animación» y respeto a `prefers-reduced-motion`). Quien entra a mitad del giro ve el estado ya resuelto. Bots apuestan también a docenas/columnas. Pruebas: `tests/roulette-unit.js` (nueva suite en `npm test`) y cobertura e2e de docenas/columnas en el smoke multijugador. Extra de esta entrega: botón «Entrar de todos modos» en la puerta de escritorio (persistido en `localStorage`) para ventanas estrechas como la vista previa del workspace.

1. **Paño completo de apuestas.** Mesa de ruleta completa (estilo europeo, un solo 0): cuadrícula de números 0–36 con colores reales, apuestas externas (rojo/negro, par/impar, 1–18/19–36, **docenas y columnas**) y fichas colocadas visualmente sobre el paño donde apuesta cada jugador.
2. **Rueda animada con pelota.** Al lanzar, se muestra la rueda girando y la **pelota recorriéndola con desaceleración realista** (rebotes finales incluidos) hasta detenerse **exactamente en el número que decidió el servidor**. La animación (~6–8 s, con opción de saltar y respeto a `prefers-reduced-motion`) solo **representa** el resultado autoritativo; nunca lo decide el cliente.
3. **Sincronía multijugador.** Todos los presentes ven la misma animación al mismo tiempo (semilla/timestamp del servidor); quien entra a mitad del giro ve el estado ya resuelto.
4. **Pagos y liquidación.** Extender el motor de `quick-games` con los nuevos tipos de apuesta (docenas y columnas pagan x3) y sus pruebas.
5. **Criterio de aceptación:** el número donde cae la pelota coincide siempre con el resultado del servidor; smoke test de los nuevos tipos de apuesta; rendimiento fluido (60 fps en canvas/CSS transform) en un escritorio promedio.

**Entregable en Render:** deploy normal.

## Fase 6 — Tragamonedas MonteCristo ✅ COMPLETADA

*Objetivo: sumar un sexto juego insignia con su propia máquina animada.*

> **Estado (2026-09-28):** implementada. Sexto juego rápido `slots` en el motor autoritativo: 5 símbolos con pesos (🍒30 🍀25 🔔20 💎15 ♠10), pagos por tres iguales (x5/x8/x12/x20/x40), par x1 y EV teórico ≈ 0.97. Máquina con gabinete, ventana de tres rodillos que giran y se detienen en secuencia (~0.9 s entre cada uno) con desaceleración, rebote y desenfoque de movimiento, tabla de pagos visible, botón «Saltar animación» y `prefers-reduced-motion`. Tarjeta de lobby con imagen original (misma dirección de arte), opción en el modal de crear, filtro del lobby, bots expertos, reto «Tira de la palanca» y logro de explorador ampliado. Pruebas: `tests/slots-unit.js` (catálogo, pesos, dominio, paytable, EV) + e2e en el smoke multijugador. Corrección incluida: al terminar las animaciones de ruleta/tragamonedas se fuerza el repintado (la firma de estado no cambia) — verificado de extremo a extremo con navegador simulado.

1. **Nuevo juego rápido "Tragamonedas".** Integrado al motor de `quick-games` como los demás: cada participante confirma una apuesta por ronda, el **servidor genera y liquida el resultado** (símbolos por rodillo con pesos definidos), y la animación solo representa ese resultado autoritativo.
2. **Máquina con tres tiras giratorias.** Diseño visual completo de la máquina (gabinete, ventana de premios, palanca/botón de giro) acorde a la identidad sobria de la fase 4. Las **tres tiras giran y se detienen en secuencia** (izquierda → centro → derecha, ~1 s entre cada una) con desaceleración y un pequeño rebote al frenar, mostrando exactamente los símbolos que decidió el servidor. Respeto a `prefers-reduced-motion` y opción de saltar la animación.
3. **Tabla de pagos.** Paytable visible en la propia máquina (p. ej. tres iguales: pagos por símbolo; dos iguales: pago menor; símbolo comodín/premium con el pago máximo). Los multiplicadores exactos se calibran para mantener la economía de fichas virtuales alineada con los demás juegos rápidos.
4. **Integración completa:** tarjeta de lobby con su imagen original (misma dirección de arte de la fase 4.4), soporte de bots expertos y ciclo de vida de mesa (reglas de la fase 2), retos/logros del juego nuevo, y sincronía multijugador (todos ven el mismo giro al mismo tiempo).
5. **Criterio de aceptación:** los símbolos donde se detienen las tiras coinciden siempre con el resultado del servidor; smoke test del nuevo juego en `npm test` (apuesta, resolución, pagos, reembolsos al salir); animación fluida a 60 fps en un escritorio promedio.

**Entregable en Render:** deploy normal.

## Fase 7 — Robustez operativa en Render ✅ COMPLETADA

*Objetivo: que el hosting no borre datos ni degrade la experiencia.*

> **Estado (2026-09-28):** implementada. `render.yaml` versionado (disco persistente en `/var/data`, `PROFILE_STORE_PATH`, health check y plan starter, con nota para free); `GET /healthz` con uptime/salas/jugadores/versión de T&C; apagado limpio con `SIGTERM` (guardado de perfiles, aviso «El servidor se está actualizando…» a todas las mesas y cierre con gracia, con salida forzada a los 2.5 s como red de seguridad); pantalla de carga con «Despertando la sala…» y reintentos visibles para el arranque en frío del plan free; logs estructurados JSON por línea (`LOG_JSON=off` para desactivarlos). Nueva suite `tests/ops-smoke.js` en `npm test`: verifica `/healthz`, el aviso a mesas, la salida ordenada, los logs JSON y que dos arranques con el mismo disco conservan los perfiles. Acción manual en Render: aplicar el blueprint (o crear el disco y la variable a mano) — las salas siguen siendo en memoria por diseño.

1. **Persistencia real de perfiles.** El disco de Render es **efímero**: `data/profiles.json` se pierde en cada deploy/reinicio. Acciones:
   - Contratar un **Persistent Disk** de Render montado (p. ej. en `/var/data`) y apuntar `PROFILE_STORE_PATH=/var/data/profiles.json`, **o** migrar el `ProfileStore` a una base gestionada (Render PostgreSQL o Redis) detrás de la misma interfaz.
   - El código ya acepta `PROFILE_STORE_PATH`, así que la opción de disco no requiere cambios de código.
2. **Endpoint de salud** `GET /healthz` (estado, uptime, salas activas) y configurarlo como *Health Check Path* en Render para deploys sin caída (zero-downtime).
3. **Arranque en frío del plan free.** Si se usa plan free, Render suspende el servicio tras inactividad (~15 min) y tarda ~50 s en despertar. Mitigar: mejorar la pantalla de carga ("Despertando la sala…") con reintentos de Socket.IO visibles; a mediano plazo, pasar a plan Starter para eliminar la suspensión.
4. **Apagado limpio (`SIGTERM`).** Render envía SIGTERM en cada deploy: guardar perfiles pendientes, avisar a las salas ("El servidor se reiniciará…") y cerrar sockets con gracia para que la reconexión automática reencuentre la sesión.
5. **Logs estructurados** (JSON por línea: sala, evento, jugador) para aprovechar el visor de logs de Render.
6. **Criterio de aceptación:** un redeploy no pierde perfiles ni expulsa definitivamente a los jugadores conectados (reconexión < 10 s).

**Entregable en Render:** variables `PROFILE_STORE_PATH` y health check configurados; `render.yaml` (Infrastructure as Code) versionado en el repo.

## Fase 8 — Contenido y retención

*Objetivo: crecer el juego sobre la base ya estabilizada.*

1. ✅ **Torneos de sala** (sit & go de póker con ciegas crecientes) — el formato brilla en pantallas grandes. *(2026-09-28: el anfitrión inicia el torneo desde la mesa de póker; todos los sentados —humanos y bots— pagan 200 de entrada, reciben un stack de 1000 y juegan con ciegas que se duplican cada 3 manos (10/20 → 20/40 → …). El saldo real del perfil queda protegido durante el torneo; los eliminados quedan clasificados por lugar y el campeón se lleva el bote completo como transacción en su perfil. Sin recompras ni cambios de asientos durante el torneo. Smoke test: `tests/tournament-smoke.js`.)*
2. ✅ **Estadísticas ampliadas de perfil:** gráficas de saldo por sesión, historial por juego, % de victorias; panel lateral que solo cabe en escritorio. *(2026-09-28: el modal de perfil suma «% DE VICTORIAS», una gráfica SVG con la evolución del saldo —últimos 60 movimientos, persistidos en disco— y una tabla de rendimiento por juego con rondas, victorias, % y balance neto. Smoke test: `tests/profile-stats-smoke.js`.)*
3. ✅ **Espectadores:** entrar a una sala llena en modo observador con chat. *(2026-09-28: tribuna con hasta 12 espectadores por mesa, botón «👁 Ver mesa» en el lobby para salas llenas, chat con prefijo 👁, privacidad intacta —cartas ajenas ocultas y elecciones «locked»—, botón «Tomar asiento» que convierte al espectador en jugador, y limpieza automática al desconectarse. Smoke test: `tests/spectators-smoke.js`.)*
4. ✅ **Nuevas variantes:** blackjack con seguro y split. *(2026-09-28: seguro por la mitad de la apuesta cuando la casa muestra un as —paga 2:1 contra blackjack natural, disponible solo antes de la primera jugada— y split de pares del mismo valor en dos manos independientes con apuestas iguales, doblaje por mano, visualización de ambas manos en la mesa y liquidación combinada. Smoke test determinista con mazos fijos: `tests/blackjack-variants-smoke.js`.)*
5. **Criterio de aceptación:** cada característica entra por separado con su smoke test correspondiente en `npm test`. ✅ Cumplido: 12 suites verdes.

**Ampliación solicitada (2026-09-28):**

6. ✅ **Ranking mensual:** tabla de clasificación con las personas con mayor cantidad de puntos (fichas) del mes en curso, visible desde el lobby y actualizada en vivo. *(2026-09-28: panel «🏅 Ranking del mes» bajo las salas abiertas con el top 10 —medallas, victorias y puntos—, el podio de la temporada anterior y la nota del reinicio mensual. Smoke test: `tests/season-smoke.js`.)*
7. ✅ **Reinicio mensual de puntos:** al inicio de cada mes todos los perfiles vuelven a 1000 fichas (con anuncio del cierre de temporada y del podio del mes anterior); el bono diario reclamable de 100 fichas se mantiene como está. *(2026-09-28: el almacén de perfiles guarda temporadas mensuales —formato retrocompatible con el archivo anterior—, archiva el podio al cerrar el mes, reinicia los saldos a 1000 y lo anuncia en todas las mesas; verificación al cargar, en cada acceso a perfiles y con un barrido cada 5 minutos. Smoke test: `tests/season-smoke.js`.)*

**Estado (2026-09-28): FASE 8 COMPLETA** — torneos, estadísticas ampliadas, espectadores, blackjack con seguro/split, ranking mensual y reinicio de temporada, cada uno con su smoke test en `npm test`.

**Entregable en Render:** deploys independientes por característica.

## Fase 9 — Calidad continua

1. ✅ **CI en GitHub:** `npm test` en cada push/PR (GitHub Actions) antes del auto-deploy de Render. *(2026-09-28: `.github/workflows/ci.yml` con Node 22, caché de npm y las 15 suites; activar «Wait for CI» en Render para que el deploy espere el verde.)*
2. ✅ **Preview environments de Render** por pull request para probar cambios visuales de escritorio. *(2026-09-28: bloque `previews: generation: automatic` en `render.yaml`, con expiración a 3 días y disco nuevo por preview.)*
3. ✅ **Presupuesto de rendimiento:** primera carga < 2 s en escritorio, payloads de Socket.IO auditados por ronda. *(2026-09-28: gzip + caché de estáticos en el servidor, imágenes del lobby con `loading="lazy"`; `tests/performance-smoke.js` vigila los techos —primera carga 96 KB gzip contra un presupuesto de 300 KB; `lobby_state`/`room_state` < 30 KB—.)*
4. ✅ **Revisión trimestral** de dependencias (`express`, `socket.io`) y del tamaño del store de perfiles. *(2026-09-28: primera revisión hecha —express 4.22.3, socket.io 4.8.4, `npm audit` en 0— y rutina documentada en `MANTENIMIENTO.md`.)*

**Extras de la fase (pedidos el 2026-09-28):** prueba E2E desde el punto de vista de una usuaria real (`tests/user-journey-smoke.js`), revisión de diseño profesional y auditoría QA adversarial con endurecimiento del chat (`tests/qa-hardening-smoke.js`). Hallazgos y decisiones en `REVISION_CALIDAD.md`.

**Estado (2026-09-28): FASE 9 COMPLETA — plan de actualización terminado (fases 1-9).**

## Fase 10 — Persistencia gratuita sin tarjeta (Postgres opcional) ✅ COMPLETADA

*Objetivo: poder desplegar en el plan FREE de Render (sin blueprint, sin disco, sin tarjeta) sin que los perfiles vuelvan a ser efímeros.*

> **Estado (2026-09-29):** implementada. Nuevo backend de perfiles respaldado en Postgres (`lib/profile-store-pg.js`), pensado para el free tier de Neon (sin tarjeta). Selección automática por variable de entorno: si existe `DATABASE_URL` el servidor usa Postgres; si no, sigue usando `data/profiles.json` exactamente como hasta la fase 9 (cero cambios en local ni en los 16 tests preexistentes). La lógica común a ambos backends (limpieza de perfiles, ranking, alta/edición, reinicio de temporada mensual, bono diario) se extrajo a `lib/profile-store-shared.js` y `lib/profile-store-base.js`, así que Postgres y archivo JSON se comportan de forma idéntica detrás de la misma interfaz (`getOrCreate`, `update`, `top`, `touch`, `seasons`, `ensureSeason`, `saveNow`). El arranque del servidor (`server.js`) ahora espera a que el store esté listo (`await createProfileStore(...)`) antes de abrir el puerto, y el apagado limpio por `SIGTERM` espera el guardado (en disco o en Postgres) antes de cerrar.

1. **`ProfileStore` alternativo en Postgres**, misma interfaz que el de archivo: guarda una foto completa del estado en memoria (perfiles + temporadas) cada vez que hay cambios, igual que hace hoy el archivo JSON, pero en dos tablas (`montecristo_profiles`, `montecristo_seasons`) que el propio servidor crea la primera vez que arranca (sin SQL manual).
2. **Selección por `DATABASE_URL`**: con la variable definida, usa Postgres y **falla rápido y con un error claro** si la conexión no funciona (no cae en silencio al archivo JSON, para no perder datos sin darse cuenta); sin la variable, todo sigue igual que siempre.
3. **Script de migración** (`scripts/migrate-profiles-to-postgres.js`, también disponible como `npm run migrate:profiles`) que importa un `data/profiles.json` existente a Postgres, con modo `--dry-run` para previsualizar sin escribir.
4. **Smoke test nuevo** (`tests/profile-store-pg-smoke.js`, integrado a `npm test`): ejercita el store de Postgres real (mismo código SQL) contra un Postgres simulado en memoria — alta/edición, ranking, persistencia entre "reinicios", reinicio de temporada, compatibilidad con perfiles en formato legado y selección correcta según `DATABASE_URL` — sin necesitar ninguna base de datos. Si además se define `DATABASE_URL_TEST` (una base Postgres/Neon desechable), corre también una ronda real contra esa base y limpia sus propias filas; sin esa variable, esa parte se omite y las 17 suites siguen en verde.
5. **Guía de despliegue 100% gratis** documentada en `DESPLIEGUE_RENDER.md` («Opción C»): web service Free de Render creado a mano (sin blueprint, sin disco) + base de datos Postgres gratuita de Neon (sin tarjeta), paso a paso, incluyendo dónde pegar `DATABASE_URL` en Render y cómo comprobar que quedó activo.
6. **Limpieza pre-publicación:** `data/profiles.json` se vació de los perfiles de prueba (queda un archivo válido con `profiles: []`) para no publicar cuentas de desarrollo.
7. **Criterio de aceptación:** `npm test` (17 suites) en verde sin ninguna base de datos configurada; con `DATABASE_URL` apuntando a un host inválido, el servidor falla al arrancar con un mensaje claro en vez de perder datos en silencio.

**Entregable en Render:** sin cambios para quien ya usa disco persistente (Opción A/B, sin tocar nada); para quien use el plan Free, seguir la Opción C de `DESPLIEGUE_RENDER.md` (variable `DATABASE_URL` apuntando a Neon).

---

## Fase 11 — Aprovechar la base de datos real (planificada, pendiente de implementar)

*Objetivo: con `DATABASE_URL` ya activa en producción (Fase 10), los perfiles dejaron de ser el cuello de botella — ahora se puede construir sobre una base de datos de verdad en vez de un archivo. Cada punto es una entrega independiente, con su propio smoke test, en el orden de prioridad decidido el 2026-09-29.*

1. **Historial y estadísticas sin límite artificial** *(prioridad 1)* ✅ **COMPLETADA (2026-09-29).** Antes, `balanceHistory` se recortaba a los últimos 60 puntos y `transactions` a los últimos 20 en los tres lugares donde se aplicaba el recorte (`cleanProfile`, `ensureSeason` y `credit`/`recordOutcome`). Implementación real (más simple que mover el historial a tablas propias, con el mismo resultado práctico): el techo vive en un solo objeto compartido por referencia, `HISTORY_LIMITS` (`lib/profile-store-shared.js`), que los tres sitios leen en vez de tener el número `20`/`60` repetido. `server.js` lo eleva a un techo generoso (500 transacciones, 2000 puntos de saldo) al arrancar **solo si el backend activo es Postgres** (`profiles.backend === 'postgres'`); con el archivo JSON se queda exactamente igual que siempre, sin ningún cambio de comportamiento.
   - La gráfica de saldo del modal de perfil ya soportaba cualquier cantidad de puntos sin cambios (su SVG escala solo); ahora sencillamente recibe más historial cuando el backend lo conserva.
   - Nuevo endpoint `GET /api/perfil/:token/historial` — descarga en JSON de la evolución de saldo, transacciones, estadísticas y desglose por juego completos (mismo modelo de confianza que ya usa el resto de la app: el token es el identificador, igual que para crear o unirse a una sala). Enlace «⬇ Descargar mi historial completo» en el modal de perfil.
   - **Criterio de aceptación cumplido:** `tests/profile-history-smoke.js` (18ª suite) verifica que el techo compartido se respeta en los tres sitios con el valor por defecto y con uno elevado, que `ensureSeason` también lo respeta, que el endpoint de descarga responde 200 con el historial correcto y 404 para un token desconocido, y que el log de arranque reporta `profileBackend` y `historyLimits` — sin ninguna base de datos configurada y sin regresión en las 17 suites previas.
2. **Login opcional (usuario + contraseña) para portabilidad de perfil** *(prioridad 2, ampliada el 2026-09-29 de "código de recuperación" a una cuenta completa)*. Hoy la identidad de cada jugador vive únicamente en un token guardado en `localStorage`: aunque el servidor ya no pierde datos (Fase 10), la persona sí pierde el acceso a los suyos si borra el navegador, cambia de computadora o de perfil del sistema operativo. Decisión de producto (2026-09-29): el login es **opcional** — se conserva el acceso instantáneo sin cuenta (pilar del producto) y quien quiera puede vincular usuario+contraseña a su perfil actual para recuperarlo en otra computadora. Sin correo ni verificación (no hay proveedor de envío de correo configurado en este entorno).
   - Desde el modal de perfil, crear una cuenta (usuario + contraseña) que se vincula al perfil actual del dispositivo (mismas fichas, logros e historial — no se crea uno nuevo).
   - Contraseña guardada **con hash** (`scrypt` + sal aleatoria, nunca en texto plano), en el mismo perfil, funciona igual con archivo JSON o Postgres.
   - Pantalla de "Iniciar sesión": el jugador introduce usuario y contraseña desde cualquier computadora; si son correctos, el cliente adopta el `id` de ese perfil como su token de dispositivo — recupera exactamente sus fichas, logros e historial ahí mismo, sin recargar la página.
   - Protección básica contra fuerza bruta: tras varios intentos fallidos seguidos contra el mismo usuario, un bloqueo temporal persistido en el propio perfil (sobrevive a reinicios).
   - **Criterio de aceptación:** smoke test que crea una cuenta, "pierde" el token original (como si se cambiara de navegador) e inicia sesión desde uno nuevo recuperando el mismo perfil; usuario repetido y contraseña incorrecta se rechazan con mensajes genéricos (sin filtrar cuál de los dos falló); el bloqueo tras intentos fallidos se prueba y se libera pasado el tiempo de espera.
3. **Panel de operación / métricas agregadas** *(prioridad 3)*. Con Postgres, las consultas agregadas (jugadores activos por día, fichas totales en circulación, juegos más jugados, perfiles nuevos por semana) son triviales; sobre el archivo JSON eran incómodas de calcular sin cargar todo a memoria y recorrerlo a mano.
   - Endpoint protegido (p. ej. `/admin/metrics`, con un token compartido en variable de entorno `ADMIN_TOKEN`, nunca expuesto al cliente del juego) con esas métricas en JSON.
   - Sin panel visual por ahora (fuera de alcance de "solo escritorio para jugar"); el propio operador puede consultarlo con `curl` o pegarlo en una hoja de cálculo.
   - **Criterio de aceptación:** smoke test que confirma que el endpoint exige el token correcto y devuelve números consistentes con perfiles de prueba conocidos.
4. **Antiabuso ligado a la base de datos** *(prioridad 4)*. Hoy cualquier límite de creación de salas o perfiles vive en memoria y se reinicia con cada deploy. Con persistencia real, se puede:
   - Registrar intentos de alta de perfiles por IP/dispositivo en una ventana de tiempo, persistente entre reinicios.
   - Mantener una lista de dispositivos suspendidos que sobrevive a redeploys.
   - **Criterio de aceptación:** smoke test que simula creación rápida de perfiles desde el mismo origen y confirma que el límite persiste incluso "reiniciando" el store (como en `tests/profile-store-pg-smoke.js`).

**Entregable en Render:** cada punto se despliega por separado, como manda la regla de una fase = varias entregas pequeñas; ninguno requiere cambios de infraestructura adicionales a los ya hechos en la Fase 10 (`DATABASE_URL` ya activa).

---

## Orden y ritmo sugerido

| Fase | Alcance | Esfuerzo estimado | Riesgo |
|------|---------|-------------------|--------|
| 1 | Política solo-escritorio | Bajo (1 iteración) | Bajo |
| 2 | Mesas, bots expertos y presencia real | Medio (2 iteraciones) | **Alto impacto**: corrige el bug de jugadores fantasma |
| 3 | Términos y condiciones (México) | Bajo–medio (1 iteración + revisión legal) | **Alto impacto**: cobertura legal |
| 4 | Rediseño profesional + privacidad de cartas + imágenes de lobby | Medio–alto (2–3 iteraciones) | Medio: la privacidad exige cambios de protocolo |
| 5 | Ruleta completa animada | Medio (2 iteraciones) | Bajo |
| 6 | Tragamonedas con máquina animada | Medio (2 iteraciones) | Bajo: reutiliza el motor de juegos rápidos |
| 7 | Robustez en Render | Medio (1–2 iteraciones) | **Alto impacto**: evita pérdida de datos |
| 8 | Contenido nuevo | Alto (continuo) | Medio |
| 9 | Calidad continua | Bajo (transversal) | Bajo |
| 10 | Persistencia gratuita sin tarjeta (Postgres opcional) | Bajo–medio (1 iteración) | **Alto impacto**: evita perder perfiles al usar el plan Free sin disco |
| 11 | Aprovechar la base de datos real (historial completo, recuperación de perfil, métricas, antiabuso) | Medio (4 iteraciones independientes) | Bajo–medio: cada punto es una entrega aislada, sin tocar infraestructura nueva |

> **Notas de prioridad:**
> - Si el servicio ya tiene jugadores reales, conviene adelantar el punto 7.1 (persistencia de perfiles) inmediatamente después de la fase 1, porque hoy cada deploy en Render borra `data/profiles.json`.
> - La corrección de jugadores fantasma (fase 2.2) y la aceptación de términos (fase 3.2) pueden entregarse como parches independientes si se necesitan antes de completar su fase.
> - El punto 4.2 (privacidad de cartas de blackjack en el servidor) debe hacerse **antes** de cualquier campaña de difusión: mientras las manos de blackjack viajen abiertas en el payload, un usuario técnico puede verlas.

## Reglas del proceso incremental

- Una fase = una o más entregas pequeñas; **nunca** se mezclan fases en un mismo deploy.
- Antes de cada deploy: `npm test` en verde y prueba manual en 1280×800 y 1920×1080.
- Todo cambio de configuración de Render queda documentado en `render.yaml` dentro del repo.
- Las fichas siguen siendo 100 % virtuales: ninguna fase introduce pagos ni dinero real; los Términos y Condiciones de la fase 3 lo declaran expresamente.
