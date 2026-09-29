# MonteCristo

Casino social multijugador para jugar con amigos mediante una URL privada. Incluye **Texas Hold’em, Blackjack/21, Ruleta Nova, Dados Cósmicos y Cara o Cruz**.

> Todas las fichas, apuestas, recompensas y jackpots son completamente virtuales. No hay dinero real, depósitos, retiros, pagos ni premios canjeables.

## Funciones principales

- Salas compartibles de hasta 6 jugadores mediante URL o código de 5 caracteres.
- Lobby en vivo con filtros por juego, fase y ocupación.
- Estado autoritativo y sincronizado en tiempo real con Socket.IO.
- Perfil persistente por dispositivo: nombre, avatar, saldo, victorias, rondas, mayor ganancia, rachas y juegos probados.
- Clasificación de la sala por saldo y señal visual de cambios de posición.
- Chat libre, mensajes rápidos y reacciones (`🔥`, `👏`, `😂`, `🍀`, `😱`, `💎`).
- Historial reciente de ganadores y celebraciones breves para grandes resultados.
- Retos, logros, recompensas por explorar juegos y bono diario.
- Eventos especiales aleatorios: jackpot virtual, ganancia x2 y ronda bonus.
- Migración de anfitrión, reconexión por dispositivo y reembolso de apuestas rápidas abiertas al salir.
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
- Los perfiles se guardan en `data/profiles.json` mediante escritura diferida y atómica.

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
# o ejecutar toda la validación:
npm test
```

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
