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

## Fase 5 — Ruleta completa con rueda animada

*Objetivo: transformar Ruleta Nova en una experiencia de ruleta real, no solo botones.*

1. **Paño completo de apuestas.** Mesa de ruleta completa (estilo europeo, un solo 0): cuadrícula de números 0–36 con colores reales, apuestas externas (rojo/negro, par/impar, 1–18/19–36, **docenas y columnas**) y fichas colocadas visualmente sobre el paño donde apuesta cada jugador.
2. **Rueda animada con pelota.** Al lanzar, se muestra la rueda girando y la **pelota recorriéndola con desaceleración realista** (rebotes finales incluidos) hasta detenerse **exactamente en el número que decidió el servidor**. La animación (~6–8 s, con opción de saltar y respeto a `prefers-reduced-motion`) solo **representa** el resultado autoritativo; nunca lo decide el cliente.
3. **Sincronía multijugador.** Todos los presentes ven la misma animación al mismo tiempo (semilla/timestamp del servidor); quien entra a mitad del giro ve el estado ya resuelto.
4. **Pagos y liquidación.** Extender el motor de `quick-games` con los nuevos tipos de apuesta (docenas y columnas pagan x3) y sus pruebas.
5. **Criterio de aceptación:** el número donde cae la pelota coincide siempre con el resultado del servidor; smoke test de los nuevos tipos de apuesta; rendimiento fluido (60 fps en canvas/CSS transform) en un escritorio promedio.

**Entregable en Render:** deploy normal.

## Fase 6 — Tragamonedas MonteCristo

*Objetivo: sumar un sexto juego insignia con su propia máquina animada.*

1. **Nuevo juego rápido "Tragamonedas".** Integrado al motor de `quick-games` como los demás: cada participante confirma una apuesta por ronda, el **servidor genera y liquida el resultado** (símbolos por rodillo con pesos definidos), y la animación solo representa ese resultado autoritativo.
2. **Máquina con tres tiras giratorias.** Diseño visual completo de la máquina (gabinete, ventana de premios, palanca/botón de giro) acorde a la identidad sobria de la fase 4. Las **tres tiras giran y se detienen en secuencia** (izquierda → centro → derecha, ~1 s entre cada una) con desaceleración y un pequeño rebote al frenar, mostrando exactamente los símbolos que decidió el servidor. Respeto a `prefers-reduced-motion` y opción de saltar la animación.
3. **Tabla de pagos.** Paytable visible en la propia máquina (p. ej. tres iguales: pagos por símbolo; dos iguales: pago menor; símbolo comodín/premium con el pago máximo). Los multiplicadores exactos se calibran para mantener la economía de fichas virtuales alineada con los demás juegos rápidos.
4. **Integración completa:** tarjeta de lobby con su imagen original (misma dirección de arte de la fase 4.4), soporte de bots expertos y ciclo de vida de mesa (reglas de la fase 2), retos/logros del juego nuevo, y sincronía multijugador (todos ven el mismo giro al mismo tiempo).
5. **Criterio de aceptación:** los símbolos donde se detienen las tiras coinciden siempre con el resultado del servidor; smoke test del nuevo juego en `npm test` (apuesta, resolución, pagos, reembolsos al salir); animación fluida a 60 fps en un escritorio promedio.

**Entregable en Render:** deploy normal.

## Fase 7 — Robustez operativa en Render

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

## Fase 8 — Contenido y retención

*Objetivo: crecer el juego sobre la base ya estabilizada.*

1. **Torneos de sala** (sit & go de póker con ciegas crecientes) — el formato brilla en pantallas grandes.
2. **Estadísticas ampliadas de perfil:** gráficas de saldo por sesión, historial por juego, % de victorias; panel lateral que solo cabe en escritorio.
3. **Espectadores:** entrar a una sala llena en modo observador con chat.
4. **Nuevas variantes:** blackjack con seguro y split.
5. **Criterio de aceptación:** cada característica entra por separado con su smoke test correspondiente en `npm test`.

**Entregable en Render:** deploys independientes por característica.

## Fase 9 — Calidad continua

1. **CI en GitHub:** `npm test` en cada push/PR (GitHub Actions) antes del auto-deploy de Render.
2. **Preview environments de Render** por pull request para probar cambios visuales de escritorio.
3. **Presupuesto de rendimiento:** primera carga < 2 s en escritorio, payloads de Socket.IO auditados por ronda.
4. **Revisión trimestral** de dependencias (`express`, `socket.io`) y del tamaño del store de perfiles.

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

> **Notas de prioridad:**
> - Si el servicio ya tiene jugadores reales, conviene adelantar el punto 7.1 (persistencia de perfiles) inmediatamente después de la fase 1, porque hoy cada deploy en Render borra `data/profiles.json`.
> - La corrección de jugadores fantasma (fase 2.2) y la aceptación de términos (fase 3.2) pueden entregarse como parches independientes si se necesitan antes de completar su fase.
> - El punto 4.2 (privacidad de cartas de blackjack en el servidor) debe hacerse **antes** de cualquier campaña de difusión: mientras las manos de blackjack viajen abiertas en el payload, un usuario técnico puede verlas.

## Reglas del proceso incremental

- Una fase = una o más entregas pequeñas; **nunca** se mezclan fases en un mismo deploy.
- Antes de cada deploy: `npm test` en verde y prueba manual en 1280×800 y 1920×1080.
- Todo cambio de configuración de Render queda documentado en `render.yaml` dentro del repo.
- Las fichas siguen siendo 100 % virtuales: ninguna fase introduce pagos ni dinero real; los Términos y Condiciones de la fase 3 lo declaran expresamente.
