# Rueda de la Fortuna

La Rueda está **abierta para cualquier persona** en el lobby (también en
producción). No es la Ruleta Nova europea: aquí se elige uno de 54 sectores y la
rueda decide. Todas las fichas son virtuales; no hay dinero real.

## Reglas (autoritativas del servidor)

| Sectores | Cantidad | Pago total (incluye la apuesta) |
| ---: | ---: | ---: |
| 1 | 25 | x2 |
| 2 | 15 | x3 |
| 5 | 7 | x6 |
| 10 | 4 | x11 |
| 20 | 2 | x21 |
| 40 | 1 | x41 |

- 54 sectores en total, sorteados con aleatoriedad criptográfica en
  `lib/quick-games.js` (`roll`, `FORTUNE_SECTORS`, `totalPayoutMultiplier`).
- Mesa de 1 a 6 participantes; una apuesta por persona y por ronda, entre 10
  fichas y el saldo disponible, con tope de desbordamiento
  (`amount ≤ ⌊(MAX_SAFE_INTEGER − chips) / 40⌋`).
- No hay eventos especiales ni bonificaciones de la casa: el pago es exactamente
  apuesta × (sector + 1). Las fichas adicionales que pueda recibir un perfil
  vienen de los logros y retos normales del casino, no de la Rueda.
- La animación es ilustrativa; el valor válido es el que entrega el servidor.

## Por qué antes estaba bloqueada y cómo se resolvió

La mesa vive en memoria: al confirmar una apuesta se descuentan fichas y el
premio llega ~1,15 s después, al liquidar la ronda. Un despliegue, un reinicio o
una caída en ese hueco dejaba fichas cobradas sin resultado ni devolución.

`lib/fortune/ledger.js` (`FortuneLedger`) cierra ese hueco con un diario en
disco:

1. **Intención antes de tocar el saldo.** Cada ronda y cada apuesta se anotan en
   el archivo de estado (`FORTUNE_STATE_PATH`) antes de debitar.
2. **Operaciones idempotentes.** Cada movimiento usa un `operationId`
   determinista (`fortune:bet|refund|prize|round:<hash>`) que el perfil guarda en
   `appliedChipOperations`; repetirlo nunca cobra ni paga dos veces, ni siquiera
   después de un reinicio.
3. **Resultado antes del premio.** La ronda se marca `resolved` con su resultado
   en disco y solo después se acredita. Si el proceso cae entre ambos pasos, al
   arrancar se reaplica el pago (idempotente).
4. **Recuperación al arrancar.** `start()` carga, purga (24 h de retención,
   máximo 500 rondas), reembolsa toda apuesta de una ronda `open`
   (`server_restart`) y paga las rondas `resolved`. La decisión es la acordada:
   **devolver lo que no tiene resultado confirmado y pagar lo confirmado**.
5. **Salidas y cierres.** Salir, desconectarse durante las apuestas, destruir la
   mesa o apagar el servidor devuelve la apuesta en el acto
   (`refundBet`/`refundOpenRound`), también de forma idempotente.
6. **Cierre mensual.** Si el reinicio ocurre después del cambio de temporada, el
   saldo ya volvió a 1000 y no se devuelven fichas que el reinicio borró: la
   apuesta se marca devuelta sin acreditar.

El archivo se escribe de forma atómica (`.tmp` + `rename`); si está corrupto se
aparta como `*.corrupt-<marca de tiempo>` y la Rueda arranca vacía en lugar de
impedir el arranque del casino. Está pensado para **un único proceso escritor**,
igual que el resto de la persistencia del casino; no coordina réplicas.

## Interfaz

- La rueda se dibuja sector a sector (54 casillas) en `public/fortune-wheel.js`,
  con un color por franja de premio; el número de cada casilla está siempre
  visible y en tamaño legible, sin amontonarse.
- Una **flecha dorada** baja sobre el aro y marca el sector ganador. Mientras la
  cinta gira, el centro muestra la apuesta (*TU SECTOR · PAGA xN*); al detenerse,
  la casilla ganadora se ilumina y el centro pasa a *SECTOR · PAGA xN* con el
  resultado propio (*Gana +N fichas*). El sector no se revela antes de tiempo.
- El giro da varias vueltas y frena con `transform` de CSS en el ángulo exacto
  (`landingAngle`), así que todos los navegadores aterrizan en la misma casilla;
  hay botón «Ver el resultado ya» y se respeta `prefers-reduced-motion`.
- Los sectores donde alguien apostó quedan realzados, y la leyenda de pagos usa
  los mismos colores que la rueda (sector, pago total y número de casillas).
- Los botones de apuesta llevan el color de su franja para que se elija el
  sector sabiendo cuántas casillas tiene y cuánto paga.
- Todo sigue siendo de escritorio y habla de fichas virtuales; el pago mostrado
  incluye la apuesta.

## Configuración

- `FORTUNE_ENABLED=off`: apaga la Rueda (el lobby deshabilita la tarjeta y el
  servidor rechaza `create_room`). Por defecto está **activa**.
- `FORTUNE_STATE_PATH`: ruta del diario; por defecto
  `data/fortune-ledger.json` (en Render, `/var/data/fortune-ledger.json`).
- `GET /healthz` publica `fortuneEnabled`; la interfaz se guía por ese valor.
- `FORTUNE_PREVIEW_UNSAFE` ya no existe: no hace falta ninguna bandera insegura.

Si el diario no puede iniciarse (por ejemplo, sin permisos de escritura), el
casino abre igual, `fortuneEnabled` queda en `false` y se registra
`fortune_init_failed`; ninguna apuesta se acepta sin diario.

## Pruebas

- `tests/fortune.test.js`: reglas puras (sectores, cuotas, topes, etiquetas).
- `tests/fortune-ledger.test.js`: cobro, pago, devolución, idempotencia,
  recuperación tras caída, cierre mensual, archivo corrupto, retención y topes.
- `tests/fortune-wheel-ui.test.js`: geometría de los 54 sectores, reparto de
  premios, aterrizaje exacto bajo la flecha y la mesa real en jsdom.
- `tests/fortune-sockets.test.js`: servidor real en un proceso aparte — mesa en
  producción, pago del sector, salida antes del resultado y **caída con SIGKILL**
  seguida de arranque que devuelve la apuesta; además `FORTUNE_ENABLED=off`.
- `tests/passport-integration.test.js`: mesa completa con el resultado esperado;
  con `FORTUNE_TEST_DATABASE_URL` comprueba que sigue activa con PostgreSQL.

## Límites conocidos

- Un solo proceso: dos instancias contra el mismo archivo no están coordinadas
  (el resto de la persistencia del casino tiene la misma limitación).
- El archivo de perfiles se guarda con un pequeño retardo; tras una caída
  puede perderse un movimiento muy reciente, que la recuperación vuelve a
  aplicar de forma idempotente al arrancar.
- La Rueda cuenta para los retos de variedad, pero no cambia los seis sellos del
  Pasaporte.
