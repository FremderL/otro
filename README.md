# MonteCristo

Casino social multijugador para jugar con amigos mediante una URL privada. Incluye **Texas Hold’em, Blackjack/21, Ruleta Nova, Dados Cósmicos y Cara o Cruz**.

> Todas las fichas, apuestas, recompensas y jackpots son completamente virtuales. No hay dinero real, depósitos, retiros, pagos ni premios canjeables.

## Funciones principales

- Salas compartibles de hasta 6 jugadores mediante URL o código de 5 caracteres.
- Lobby en vivo con filtros por juego, fase y ocupación.
- Estado autoritativo y sincronizado en tiempo real con Socket.IO.
- Perfil persistente por dispositivo: nombre, avatar, saldo, victorias, rondas, mayor ganancia, rachas y juegos probados.
- Estadísticas ampliadas en el perfil: % de victorias, gráfica de evolución del saldo (últimos 60 movimientos, persistidos entre sesiones) e historial de rendimiento por juego con rondas, victorias y balance neto.
- Clasificación de la sala por saldo y señal visual de cambios de posición.
- Chat libre, mensajes rápidos y reacciones (`🔥`, `👏`, `😂`, `🍀`, `😱`, `💎`).
- Historial reciente de ganadores y celebraciones breves para grandes resultados.
- Retos, logros, recompensas por explorar juegos y bono diario.
- Eventos especiales aleatorios: jackpot virtual, ganancia x2 y ronda bonus.
- Migración de anfitrión, reconexión por dispositivo y reembolso de apuestas rápidas abiertas al salir.
- Torneos sit & go en la mesa de póker: entrada de 200 fichas, stack de torneo de 1000, ciegas que se duplican cada 3 manos, eliminación por lugares y bote completo para el campeón; el saldo real del perfil queda protegido durante el torneo y no hay recompras.
- Blackjack con seguro y split: seguro por la mitad de la apuesta cuando la casa muestra un as (paga 2:1 contra blackjack natural) y división de pares del mismo valor en dos manos independientes, con doblaje por mano.
- Ranking mensual en el lobby: top 10 de puntos de la temporada en curso con el podio del mes anterior. Los puntos se reinician el día 1 de cada mes (todos vuelven a 1000 fichas) y el bono diario de 100 se mantiene.
- Modo espectador: las salas llenas muestran «👁 Ver mesa» en el lobby; hasta 12 espectadores por mesa ven la partida en vivo (con cartas ajenas siempre ocultas), participan en el chat con el prefijo 👁 y pueden tomar asiento cuando se libera un lugar o un bot lo cede.
- Bots autoritativos configurables por el anfitrión, con cuatro dificultades, cinco estilos y decisiones específicas por juego.
- Mesas siempre vivas: los asientos libres se completan automáticamente con bots **expertos** al entrar; los bots ceden su asiento cuando llega una persona real y los desocupan al terminar cada ronda; la autoridad de la mesa migra a una persona real activa tras 1 minuto de inactividad del anfitrión, y las mesas sin personas reales se eliminan.
- Términos y Condiciones con aceptación obligatoria y versionada (página `/terminos`, redactados para México: naturaleza recreativa, 18+, deslinde de responsabilidad y Aviso de Privacidad LFPDPPP). El servidor rechaza crear o unirse a salas sin la aceptación vigente.
- Privacidad de cartas garantizada por el servidor: en póker y blackjack cada quien recibe solo sus cartas; las ajenas viajan boca abajo (`XX`) hasta el showdown o los resultados.
- Atajos de teclado en mesa (`F/C/R/A` en póker, `H/S/D` en blackjack, `Enter` confirma apuestas rápidas, `T` enfoca el chat y `?` muestra la guía) e imágenes originales en las cinco tarjetas del lobby.
- Ruleta europea completa: paño de apuestas con docenas y columnas, fichas visibles sobre el paño y rueda animada en canvas cuya pelota cae siempre en el número autoritativo del servidor.
- Tragamonedas MonteCristo: tres rodillos que se detienen en secuencia con los símbolos que decidió el servidor, tabla de pagos visible y símbolo premium ♠.
- Interfaz exclusiva para computadoras de escritorio y laptops, sin animaciones largas que bloqueen la partida.

## Experiencia visual y accesibilidad

- Identidad original de casino social futurista basada en grafito, verde menta y acentos dorados; usa imágenes locales y no depende de CDNs.
- Hero con accesos directos a **crear sala**, **entrar con código** y explorar salas abiertas.
- Tarjetas con juego, descripción, cantidad de jugadores, bots, duración y acción principal explícita.
- Salas abiertas con fase, anfitrión, ocupación, asientos libres y barra de capacidad.
- Superficies originales para los juegos rápidos: mesa y rueda de Ruleta Nova, dados en Dados Cósmicos y moneda en Cara o Cruz.
- Asientos con insignia `🤖 BOT`, dificultad, estilo, estado `Pensando…` y última acción, sin llenar la interfaz de avisos repetidos.
- En la mesa se priorizan estado de ronda, turno actual, reloj, fichas, apuesta y siguiente acción.
- Estados visuales para conexión, reconexión, desconexión, carga, foco, selección, deshabilitado, victoria, derrota y recepción de fichas.
- Navegación por teclado, foco visible, regiones en vivo y soporte para `prefers-reduced-motion`.

## Plataforma soportada

MonteCristo es un sitio **solo para computadoras** (escritorio o laptop). No hay soporte para celulares ni tablets: con ventanas menores a **1024 px de ancho** se muestra una pantalla de bloqueo que invita a volver desde una computadora, con un botón «Entrar de todos modos» (persistido en el navegador) para ventanas estrechas en computadoras, como paneles de vista previa; en ese caso la página se desplaza horizontalmente. Resolución mínima soportada: **1024×720**; diseño óptimo a partir de **1280×800**.

## Juegos y mecánicas

### Texas Hold’em

Ciegas virtuales, fold/check/call/raise/all-in, turnos autoritativos de 30 segundos, botes laterales y evaluación completa de manos. Al expirar el turno, el servidor pasa si es posible o retira la mano.

### Blackjack / 21

Apuesta inicial, pedir, plantarse, doblar y pago de Blackjack 3:2. Cada turno dispone de 25 segundos; al expirar, el jugador se planta automáticamente.

### Ruleta Nova

- Paño europeo completo: se apuesta haciendo clic sobre la casilla del paño (números 0–36 y apuestas externas).
- Rojo, negro, par, impar, 1–18 o 19–36: pago total x2 si acierta.
- Docenas (1–12, 13–24, 25–36) y columnas: pago total x3 si acierta.
- Pleno (número exacto de 0 a 36): pago total x36 si acierta.
- El cero es verde y hace perder todas las apuestas externas.
- Rueda europea animada: la pelota desacelera, rebota y cae exactamente en el número decidido por el servidor; se puede saltar la animación y se respeta `prefers-reduced-motion`.

### Dados Cósmicos

- Bajo (1–3) o alto (4–6): pago total x2.
- Número exacto: pago total x6.

### Cara o Cruz

- Cara o cruz: pago total x2.

### Tragamonedas MonteCristo

- Tres rodillos con cinco símbolos ponderados: 🍒 Cereza, 🍀 Trébol, 🔔 Campana, 💎 Diamante y ♠ MonteCristo (premium, el más raro).
- Tres iguales pagan según el símbolo: 🍒 x5 · 🍀 x8 · 🔔 x12 · 💎 x20 · ♠ x40 (pago total sobre la apuesta).
- Dos símbolos iguales devuelven la apuesta (x1); tres distintos pierden.
- Los rodillos giran y se detienen en secuencia (izquierda → centro → derecha) con desaceleración y rebote, mostrando exactamente los símbolos que decidió el servidor; la animación se puede saltar.

En los juegos rápidos, cada participante confirma una sola apuesta por ronda. Solo el anfitrión inicia el lanzamiento, pero **el servidor genera y liquida el resultado**. Las animaciones (incluidas la rueda de la ruleta y los rodillos de la tragamonedas) solo representan el estado autoritativo y nunca deciden el resultado.

## Bots e IA autoritativa

Solo el anfitrión puede abrir el panel de bots, agregar uno, completar los asientos libres o retirar bots. La capacidad total sigue siendo de seis participantes y el roster no puede alterarse durante una mano o lanzamiento activo.

Cada bot mantiene un ID propio, nombre, avatar, saldo virtual, dificultad, personalidad, estado de sala/ronda/turno, últimas acciones y estadísticas efímeras de partidas, victorias, derrotas, empates, fichas ganadas/perdidas y juegos probados. Estos datos viven con la sala y no contaminan los perfiles persistentes de personas.

### Dificultades y tiempos de reacción

| Dificultad | Reacción aproximada | Comportamiento |
| --- | ---: | --- |
| Fácil | 2–5 s | Mayor margen de error y análisis ligero |
| Normal | 1,5–4 s | Decisiones equilibradas |
| Difícil | 1–3 s | Menos errores y más simulaciones legales |
| Experto | 0,8–2,5 s | Evaluación más consistente, sin información privilegiada |

Los estilos **Conservador, Agresivo, Equilibrado, Arriesgado e Impredecible** modifican riesgo, tamaños y frecuencia de acciones; nunca cambian cartas, resultados ni reglas. La dificultad tampoco permite ver manos rivales, la carta oculta de la casa o resultados futuros.

### Comportamiento por juego

- **Poker:** puede retirarse, pasar, igualar, subir o ir all-in. Evalúa únicamente sus dos cartas, las comunitarias públicas, el bote, apuestas y estados permitidos. Las simulaciones generan cartas desconocidas, no consultan el mazo real de la sala.
- **Blackjack:** realiza una apuesta válida y elige pedir, plantarse o doblar según su mano visible y la carta pública de la casa. `split` no se ofrece porque el juego actual no implementa esa regla.
- **Ruleta, Dados y Cara o Cruz:** elige opción e importe antes del lanzamiento, espera la liquidación autoritativa y vuelve a apostar en rondas posteriores. No recibe el resultado antes de apostar.

La IA solo propone una intención. Humanos, bots y acciones automáticas por tiempo agotado pasan por los mismos ejecutores del servidor, que vuelven a validar turno, fase, capacidad, importe y saldo. Las decisiones se programan con temporizadores no bloqueantes y se revalidan al ejecutarse. Si una estrategia falla, el controlador registra el error, intenta una alternativa válida y finalmente usa una acción segura para que la sala continúe.

Al retirarse un bot se cancelan sus tareas. Al destruirse una sala se cancelan tareas de IA, turnos, lanzamientos y limpieza. Si ya no quedan personas, un bot conectado puede asumir temporalmente el rol de anfitrión y automatizar rondas; la sala se elimina después del TTL para evitar mesas huérfanas.

## Economía virtual y progresión

- Saldo inicial: **1.000 fichas virtuales**.
- Bono diario: **100 fichas**, una vez por día al entrar.
- Apuesta mínima en Blackjack y juegos rápidos: **10 fichas**.
- Las fichas apostadas se descuentan en el servidor y los pagos se acreditan tras resolver la ronda.
- Los perfiles se guardan en `data/profiles.json` mediante escritura diferida y atómica, o en Postgres (`DATABASE_URL`) si está definida — ver «Persistencia de perfiles» más abajo.

### Retos

- Jugar 3 rondas: +75.
- Ganar una ronda: +50.
- Apostar 250 fichas: +75.
- Probar 2 juegos: +100.

### Logros

- Primera victoria: +50.
- Racha de 3: +100.
- Recuperarse después de dos derrotas: +100.
- Ganar 500 fichas o más en una ronda: +150.
- Probar los 5 juegos: +250.

### Eventos especiales

Se sortean al abrir rondas. Solo entregan fichas cuando existe una ganancia positiva:

- **Jackpot virtual:** +500 fichas al ganador.
- **Ganancia x2:** duplica la ganancia neta positiva.
- **Ronda bonus:** +75 fichas al ganador.

## Ejecutar

Requiere Node.js 18 o posterior.

```bash
npm install
npm start
```

Abre `http://localhost:3000`. El servidor escucha en `0.0.0.0` y respeta la variable `PORT`.

## Validación

```bash
npm run check
npm run test:multiplayer
npm run test:bots
npm run test:bots:fallback
# o ejecutar toda la validación (21 suites):
npm test
```

Desde la fase 9, GitHub Actions ejecuta `npm test` en cada push y pull request (`.github/workflows/ci.yml`), la suite incluye un presupuesto de rendimiento (`tests/performance-smoke.js`), un endurecimiento contra entradas maliciosas (`tests/qa-hardening-smoke.js`) y un recorrido de usuario real con navegador simulado (`tests/user-journey-smoke.js`). Desde la fase 10 también incluye `tests/profile-store-pg-smoke.js`, que valida el backend de Postgres contra una base simulada (ninguna de las 21 suites necesita una base de datos real para pasar). Los hallazgos y decisiones de la revisión de diseño y QA viven en `REVISION_CALIDAD.md`, y la rutina trimestral de dependencias en `MANTENIMIENTO.md`.

Las pruebas levantan servidores aislados con perfiles temporales. La regresión multicliente valida:

- resolución y contabilidad de Ruleta, Dados y Cara o Cruz;
- restricción de resolución al anfitrión;
- chat rápido, reacciones y actualización de perfil;
- reembolso de apuestas rápidas abiertas;
- regresiones básicas de reparto, bote y turnos en Póker y Blackjack.

La prueba de bots cubre permisos del anfitrión, capacidad, cuatro dificultades, cinco estilos, humano + bot, varios bots, mesa completa, falta de fichas, ocultación de información, rondas consecutivas, Poker, Blackjack, juegos rápidos, retirada durante pensamiento, abandono, migración de anfitrión, cambio de sala/juego, automatización sin personas y cancelación al cerrar. La prueba de fallback se ejecuta por separado con un fallo de decisión forzado y confirma registro, economía autoritativa, alternativa segura, continuidad entre rondas y limpieza.

Variables útiles para pruebas y despliegue:

- `BOT_SPEED_FACTOR`: multiplica las latencias de reacción; usar valores menores que `1` solo en pruebas.
- `BOT_ONLY_ROOM_TTL_MS`: tiempo antes de eliminar una sala sin personas; por defecto, 5 minutos cuando contiene bots.
- `BOT_FORCE_DECISION_ERROR=1`: fuerza errores de estrategia para validar el fallback; no debe activarse normalmente.
- `PROFILE_STORE_PATH`: ruta del archivo de perfiles (en Render, apúntalo al disco persistente, p. ej. `/var/data/profiles.json`). Se ignora si `DATABASE_URL` está definida.
- `DATABASE_URL`: cadena de conexión Postgres (Fase 10). Si está definida, los perfiles se guardan en Postgres en vez de en el archivo JSON — pensado para el free tier de Neon, que no requiere tarjeta. Ver «Persistencia de perfiles» abajo.
- `SHUTDOWN_GRACE_MS`: milisegundos que espera el apagado ordenado a que termine el guardado final antes de forzar la salida (Fase 11.3). Por defecto 10000 con Postgres y 2500 con el archivo local; súbelo si tu plan de hosting da poco tiempo de gracia y Neon suele tardar más en responder.
- `LOG_JSON=off`: desactiva los logs estructurados JSON por línea (activados por defecto).

## Persistencia de perfiles (archivo o Postgres)

MonteCristo soporta dos backends de perfiles detrás de la misma interfaz (`lib/profile-store-factory.js` elige uno según el entorno):

- **Archivo JSON** (por defecto): `data/profiles.json`, con escritura diferida y atómica. Es efímero en el plan free de Render (sin disco).
- **Postgres** (`lib/profile-store-pg.js`): se activa solo si existe `DATABASE_URL`. Crea sus propias tablas al arrancar (sin SQL manual) y guarda una foto completa del estado (perfiles + temporadas) con la misma cadencia que el archivo. Pensado para el free tier de [Neon](https://neon.tech) (Postgres gratis, sin tarjeta). Si `DATABASE_URL` apunta a algo inválido, el servidor **falla al arrancar con un error claro** en vez de usar el archivo en silencio.

### Resiliencia ante "dormir y despertar" (Fase 11.3)

Tanto Render free (suspende el servicio tras ~15 min sin visitas) como Neon free (escala la base a cero tras inactividad) pueden hacer que el servidor arranque justo cuando Postgres todavía está despertando. Para que eso nunca se traduzca en pérdida o sobrescritura de datos:

- **Al arrancar**, cargar los perfiles reintenta unas cuantas veces con espera creciente si Postgres tarda en responder. Si aun así no logra conectar, el proceso **falla al arrancar** en vez de continuar con la memoria vacía — así Render lo reinicia en vez de arriesgarse a que el próximo guardado sobrescriba perfiles reales con perfiles en blanco.
- **Cada guardado** (`saveNow()`) reintenta solo ante un fallo transitorio; si Postgres sigue sin responder después de esos reintentos rápidos, el cambio no se descarta: queda programado un reintento en segundo plano que se repite hasta que la base vuelve a estar disponible.
- **Al apagar** (Render envía `SIGTERM` en cada deploy), el servidor espera el guardado final a Postgres con más margen que con el archivo local (10 s por defecto, configurable con `SHUTDOWN_GRACE_MS`), ya que guardar en Postgres es una llamada de red que puede tardar si la base recién despertó.

La prueba `npm run test:profile-store-pg` simula estos escenarios (fallo transitorio que se recupera solo, y fallo permanente que debe rechazar el arranque) con un Postgres simulado, sin necesitar una base real.

Migrar un `data/profiles.json` existente a Postgres:

```bash
DATABASE_URL="postgres://usuario:clave@host/db?sslmode=require" node scripts/migrate-profiles-to-postgres.js
# --dry-run para previsualizar sin escribir
```

## Historial completo y cuenta opcional (Fase 11)

- **Historial sin límite artificial:** el techo de puntos de saldo/transacciones conservados vive en `HISTORY_LIMITS` (`lib/profile-store-shared.js`). Con el archivo JSON se mantiene en 60/20 como siempre; con Postgres activo, `server.js` lo eleva a 2000/500 al arrancar. `GET /api/perfil/:token/historial` descarga en JSON el historial completo (saldo, transacciones, estadísticas, desglose por juego) del propio perfil — enlace disponible en el modal de perfil.
- **Login opcional (usuario + contraseña):** el modo instantáneo sin cuenta sigue funcionando exactamente igual. Desde el lobby, cualquiera puede vincular un usuario y contraseña a su perfil actual («Iniciar sesión» → «Crear una con mi perfil actual») y luego recuperarlo completo (fichas, logros, historial) desde cualquier otra computadora iniciando sesión. Sin correo ni verificación por correo (no hay proveedor SMTP en este entorno); la contraseña se guarda con `scrypt` + sal aleatoria (nunca en texto plano), y hay un bloqueo temporal tras varios intentos fallidos seguidos. La recuperación de contraseña olvidada queda fuera de alcance por ahora.
- **Limpieza de espacio al cerrar la temporada (Fase 11.4):** al cambiar el mes, los puntos de la gráfica de saldo (`balanceHistory`) de la temporada que cierra se descartan por completo — no solo se recortan al techo — y la nueva temporada arranca su propia gráfica desde el saldo reiniciado. El resto del historial (transacciones, estadísticas, logros) no se toca.
- **Eliminación de cuentas inactivas (Fase 11.4):** cada 5 minutos, junto con la vigilancia del cambio de mes, el servidor borra por completo cualquier perfil sin ninguna actividad desde hace más de ~3 meses (`INACTIVITY_LIMIT_MS` en `lib/profile-store-shared.js`), incluida su fila en Postgres si ese es el backend activo — no solo la copia en memoria. Si esa persona vuelve más adelante, empieza una cuenta nueva, igual que un jugador de primera vez.
- **Banner dorado y medallas de fin de temporada (Fase 11.4):** quien termina en 1er lugar del ranking mensual recibe un 🎖️ *banner dorado* — un logro único de por vida, no se entrega una segunda vez aunque vuelva a ser líder — y una 🥇 *medalla de oro*, que sí se colecciona (una más por cada temporada ganada). Ambos se muestran junto al nombre en el ranking del lobby y en el perfil propio.

## Operación en Render

- `render.yaml` versiona la infraestructura: disco persistente en `/var/data` (los perfiles sobreviven deploys), `PROFILE_STORE_PATH` y health check. Pensado para planes de pago (el free de Render no admite discos).
- `GET /healthz` expone estado, uptime, salas, jugadores humanos y versión de T&C; configurado como *Health Check Path* para deploys sin caída.
- En cada deploy, Render envía `SIGTERM`: el servidor guarda los perfiles (en disco o en Postgres, según el backend activo), avisa a las mesas («El servidor se está actualizando…») y cierra los sockets con gracia; la reconexión automática del cliente reencuentra la sesión.
- Con el plan free (sin disco y con suspensión tras ~15 min), la pantalla de carga muestra «Despertando la sala…» con los reintentos visibles mientras el servicio despierta (~50 s).
- Los eventos operativos (arranque, salas creadas/destruidas, jugadores, apagado) se registran como JSON por línea para el visor de logs de Render.
- **Guía de despliegue paso a paso:** [`DESPLIEGUE_RENDER.md`](DESPLIEGUE_RENDER.md) explica cómo aplicar el blueprint `render.yaml` (opción A), configurar el disco y las variables a mano en el dashboard (opción B), o desplegar **100% gratis sin tarjeta** con Render Free + Neon Free (opción C, Fase 10).
- La prueba `npm run test:ops` verifica el criterio de la fase 7: dos arranques con el mismo disco no pierden perfiles y `SIGTERM` produce una salida ordenada. La prueba `npm run test:profile-store-pg` (fase 10) hace lo equivalente para el backend de Postgres, con una base simulada.

## Arquitectura

```text
server.js                         Express, Socket.IO, salas y ejecutores autoritativos
lib/poker-evaluator.js             Evaluación de manos reutilizada por juego e IA
lib/bots/catalog.js                Perfiles, dificultades, estilos y serialización de bots
lib/bots/decision-engine.js        Estrategias independientes y fallbacks por juego
lib/bots/bot-controller.js         Planificación, revalidación, cancelación y recuperación
lib/profile-store.js              Perfiles persistentes y catálogo de avatares
lib/progression.js                Transacciones, estadísticas, retos, logros y bono diario
lib/quick-games.js                Registro, reglas, cuotas y resultados de minijuegos
lib/special-events.js             Eventos temporales y bonificaciones
public/index.html                 Lobby, mesas, panel de bots y componentes sociales
public/styles.css                 Identidad visual y juegos temáticos (diseño solo escritorio)
public/app.js                     Cliente Socket.IO y renderizado de todos los juegos
public/assets/                     Imágenes locales del lobby
tests/multiplayer-smoke.js        Regresión autoritativa con varios clientes
tests/bots-smoke.js               Integración normal, ciclo de vida y carreras de bots
tests/bots-fallback-smoke.js      Fallo forzado, alternativa segura y continuidad
```

Los nuevos minijuegos comparten un protocolo genérico (`quick_bet`, `quick_resolve`, `quick_new`). Para agregar otro, se registra su definición y resolución en `lib/quick-games.js` y se incorpora su presentación en el cliente, sin mezclar sus reglas con Poker o Blackjack.

## Consideraciones para producción

Los perfiles sobreviven reinicios en un archivo JSON, pero las salas, bots y estadísticas de bots activos viven en memoria. Para escalar a varias instancias conviene mover salas y perfiles a una base de datos, incorporar Redis con el adaptador de Socket.IO, usar una cola distribuida para tareas de IA, configurar HTTPS y desplegar en infraestructura compatible con WebSockets. Las semillas reproducibles para simulaciones y métricas agregadas de fallback serían extensiones recomendables antes de un despliegue de alta concurrencia.

## Uso responsable

MonteCristo está diseñado exclusivamente para entretenimiento social con fichas sin valor monetario. No incorpora apuestas con dinero real ni mecanismos de pago.
