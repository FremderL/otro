# Lotería mexicana: partida compartida del lobby

La lotería es **una sola partida para todo el casino**, visible en la sección
«Lotería mexicana» del lobby (sobre los torneos relámpago). No se crean salas:
el ciclo abre y cierra partidas solo, de forma continua.

## Reglas

- Entrada: **50 fichas virtuales** por cartón. Un cartón por persona y partida.
- Inscripción de **60 segundos**, de **2 a 100** cartones.
- Cartón de **16 figuras** (de las 54 clásicas), generado por el servidor y
  **privado**: nadie ve cartones ajenos ni la baraja.
- Canto automático **cada 2 segundos** y **marcado automático**.
- Gana el **cartón completo**. Si hay empate, el bote se reparte en fichas
  enteras iguales y el sobrante (`carry`) pasa a la siguiente partida.
- Si alguien se desconecta **antes del cierre** (sin otro socket de su perfil),
  su entrada se cancela y se reembolsa. **Después del cierre** su cartón sigue
  participando y el premio se abona a su perfil aunque nunca vuelva.
- Si al cierre hay menos de 2 cartones, la partida se cancela, se reembolsan
  las entradas y se conserva el acumulado previo.
- Al liquidarse hay un **intermedio** (12 s por defecto) para ver el resultado
  y enseguida abre la siguiente inscripción.

## Piezas

| Archivo | Rol |
|---|---|
| `lib/loteria/game.js` | Reglas puras: baraja criptográfica, cartones, avance por reloj, cancelación y reparto. No toca saldos. |
| `lib/loteria/store.js` | Diario durable de la partida (archivo JSON atómico o Postgres `montecristo_loteria_service_state`). No toca saldos. |
| `lib/loteria/service.js` | `LoteriaService`: ciclo de vida de la partida y los únicos cobros/pagos, siempre a través del `ProfileStore`. |
| `server.js` | Sockets `loteria_get` / `loteria_join` / `loteria_leave`, difusión por socket suscrito, scheduler de 500 ms, puerta del reset mensual y apagado limpio. |
| `public/index.html`, `public/app.js`, `public/styles.css` | Panel del lobby: bote, cuenta regresiva, carta cantada e historial, cartón 4×4 con marcado, avisos accesibles (`aria-live`). |

## Dinero e idempotencia

Los saldos **solo** se mueven a través del `ProfileStore` en memoria
(`debit`/`credit`/`recordOutcome` de `lib/progression.js`), como en el resto
del casino. El antiguo `lib/loteria/pg-store.js` escribía en SQL por su cuenta
y la instantánea de perfiles en segundo plano podía pisar sus asientos; ese
adaptador experimental se retiró al conectar el juego (su prueba vive en la
historia de Git).

Cada movimiento lleva una clave de operación determinista
(`loteria:<tipo>:<hash de partida+perfil+solicitud>`) que queda marcada en el
propio perfil (`appliedChipOperations`). Cobrar o pagar dos veces la misma
operación es un no-op:

1. **Inscripción**: el cartón se guarda en el diario de la partida con
   `entryApplied: false`; después se cobra con `debit()` y se confirman los
   perfiles (`saveNow`); al final se marca `entryApplied: true`. El cliente
   manda una `requestId` por partida (localStorage) para que doble clic o
   reconexión reintenten la *misma* operación.
2. **Salida/desconexión previa al cierre**: el cartón se retira y el reembolso
   queda asentado en `pendingRefunds` del diario antes de pagarlo con
   `credit()`. La `requestId` reembolsada queda «quemada»: recomprar exige una
   solicitud nueva (la interfaz la regenera sola).
3. **Liquidación/cancelación**: primero se persiste el resultado en el
   diario; después se paga por jugador con su marca (`paymentApplied`), en el
   patrón de las apuestas del Estadio (fichas en crudo + `recordOutcome`, nunca
   `credit()` junto a `recordOutcome`); se confirman perfiles y por último se
   marca `paymentsApplied`.

Si el proceso cae entre pasos, el siguiente `tick()` —que también es la
recuperación de arranque— encuentra el trabajo a medias y lo reintenta sin
duplicar importes. La partida avanza **por reloj** (`advance` de `game.js`):
un reinicio en pleno canto reanuda donde el reloj diga, y una partida cuyo
tiempo ya pasó se liquida sola al volver.

Si el diario aparece dañado, el limpiador de `store.js` descarta la partida y
rescata un reembolso por inscripción legible; el servicio solo lo paga si el
perfil trae la marca del cobro original (nunca se crean fichas de la nada).

## Cierre mensual

`hasOpenStake()` extiende la puerta `onBeforeSeasonReset`: con cartones en
inscripción, canto en curso, pagos o reembolsos pendientes, el reset de
temporada se aplaza (una partida dura menos que el barrido de 5 min). En el
peor caso —tope de aplazamientos exactamente a medianoche— las marcas de
operación sobreviven al reset, así que nadie pierde su premio ni se paga dos
veces; el `carry` vive en el diario de lotería y cruza el mes intacto.

## Operación

- `LOTERIA_ENABLED=off` apaga el juego por completo (sin servicio ni UI; la
  interfaz es fail-closed ante `/healthz`). Por defecto está **encendido**.
- `LOTERIA_STORE_PATH` ubica el diario en modo archivo (producción:
  `/var/data/loteria.json`). Con `DATABASE_URL` usa Postgres, como los torneos.
- `LOTERIA_REGISTRATION_MS` (1 s–10 min), `LOTERIA_CALL_INTERVAL_MS`
  (100 ms–30 s) y `LOTERIA_INTERMISSION_MS` (0–120 s) son palancas acotadas
  para pruebas o eventos; sin ellas rigen 60 s / 2 s / 12 s. Los tiempos de
  cada partida quedan guardados en su propio registro.
- `/healthz` expone `loteriaEnabled`. Los eventos `loteria_*` de los logs
  estructurados cubren inicialización, recuperación, inscripciones,
  liquidaciones, cancelaciones (solo con cartones dentro) y errores.

## Pruebas

- `tests/loteria-game.test.js`: reglas puras (límites, privacidad,
  desconexión, empate y arrastre, tiempos por partida).
- `tests/loteria-service.test.js`: cobro único ante reintentos, reembolsos,
  liquidación, y recuperación simulando la caída entre cada paso del diario
  y de los saldos, incluido un diario dañado.
- `tests/loteria-integration.test.js`: servidor real con dos clientes,
  `SIGKILL` a mitad de la inscripción y liquidación correcta tras el reinicio.
- `tests/loteria-ui.test.js`: catálogo de 54 figuras, apertura fail-closed y
  el flujo comprar → marcar → ganar en el DOM del lobby.
