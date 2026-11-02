# Previa de los comentaristas (charla antes del saque inicial)

En el fútbol real la cabina abre antes del partido: narrador y analista conversan
sobre el encuentro que está por jugarse (cómo llegan los equipos, la tabla, el
mercado, el pronóstico). MonteCristo hace lo mismo **unos minutos antes del
kickoff**, con las dos voces que después relatan el partido, y por el mismo canal
que el relato en vivo.

## Comportamiento

- **Ventana**: la previa empieza cuando faltan **6 minutos** para el kickoff
  (`PREGAME_LEAD_MS`) y se detiene en el saque inicial. Un partido que se
  reprograma cierra su sesión y, si vuelve a entrar en ventana, empieza una nueva.
- **Ritmo de conversación**: una intervención cada pocos segundos. La pausa se
  calcula con la longitud de la línea (`holdFor`: 14 s + 70 ms por carácter, con
  tope de 26 s), así las respuestas cortas se suceden rápido y las explicaciones
  largas dejan respirar. Nunca se emiten dos líneas en la misma vuelta.
- **Formato**: turnos alternados narrador → analista (ida y vuelta), ~12-14
  intervenciones de 140 caracteres como máximo (el mismo `MAX_LEN` del relato).
- **Sin minuto de juego**: cada mensaje viaja con `type: 'pregame'` y
  `minute: null`; el panel lo rotula **PREVIA** en lugar de inventarle un minuto.

## Qué dicen (y con qué datos)

Todo sale de datos ya asentados; la previa **nunca** anuncia un resultado:

1. Bienvenida desde el estadio, equipos y jornada.
2. Tabla: posición y puntos de cada club (si la temporada acaba de arrancar, lo
   dice en vez de inventar posiciones).
3. Forma reciente (últimas cinco letras W/D/L de la tabla) y balance de goles.
4. Mercado 1X2 pre-partido: favorito, probabilidad y cuotas de las tres opciones.
5. Pronóstico de la cabina: el marcador sale del favorito del mercado, no de una
   moneda al aire, así el analista no contradice las cuotas publicadas.
6. Pizarra: formación y estilo resueltos por el DT (`resolveClubTactics`).
7. Banquillos: nombres de los DT cuando el club ya tiene dirección técnica
   resuelta (nunca se inventa un nombre).
8. Jugadores a seguir: goleadores con **2 goles o más** según los acumulados de la
   plantilla (`clubRoster`), solo de partidos asentados.
9. Cierre: hora local del casino, aforo y saque inicial.

Causalidad estricta: la tabla, la forma y los goleadores se derivan de partidos
con resultado asentado; el mercado es el que el público está viendo en la casa de
apuestas. Determinismo: el guion se sortea con
`mulberry32(hash32(seed|previa|matchId))`, así que el mismo partido produce la
misma conversación en cualquier réplica (auditable, como el resto del Estadio).

## Arquitectura

| pieza | archivo | responsabilidad |
| --- | --- | --- |
| Guion | `lib/football/pregame.js` | `buildPregameScript(context)` (puro), `contextFor(match, …)`, helpers (`formText`, `marketSummary`, `forecastOf`, `holdFor`). |
| Emisión | `lib/football/sockets.js` | `createPregameRunner(...)` inyectado con `store`, `betting` y `emit`. Cada línea entra en el **anillo del relato** (`pushCommentary`) y se emite como `football:commentary`, así quien llega a mitad de la previa la sigue leyendo. Expuesto como `pregame` / `tickPregame(at)`. |
| Impulso | `lib/football/scheduler.js` | `runPregameSweep(now)` cada 5 s (`pregameMs`), aislado en su propio try/catch: un fallo de la cabina no afecta a kickoffs, vencidos ni temporada. |
| Cableado | `server.js` | `pregameService: footballSockets?.pregame` al construir `FootballScheduler`. |
| Interfaz | `public/estadio.js`, `public/estadio.css` | Chip **PREVIA** y borde punteado en el panel del relato; el estado vacío anuncia la previa. |

No hay `setTimeout` en cadena: el barrido es idempotente (por partido mantiene su
sesión y su próximo turno), así que un servidor dormido recupera el ritmo en la
siguiente vuelta en lugar de perder la previa.

## MonteCristo News

`lib/football/pregame.js` está declarado en `NON_CLUB_NEWS_MODULES`
(`lib/football/club-news.js`): es una pieza de retransmisión (como
`commentary.js`) que **no crea hechos de club** — no ficha, no despide, no mueve
tesorería ni prestigio. Solo lee datos ya públicos del Estadio. Por eso no emite
anuncios propios en MonteCristo News; los hechos que la previa menciona ya están
cubiertos por los módulos que los producen (traspasos, dirección técnica,
Balón de Oro, tabla).

## Pruebas

- `tests/football-pregame.test.js` — guion (alternancia de voces, límite de 140,
  datos de tabla/forma/mercado, determinismo, ausencia de datos sin inventar),
  ventana de seis minutos, ritmo del runner, cierre al arrancar, tolerancia a
  fallos y barrido del scheduler.
- `tests/football-sockets.test.js` — la previa entra en `football:commentary` y en
  el anillo del partido, `buildMatchState` la entrega y no se repite dentro de la
  misma vuelta.
