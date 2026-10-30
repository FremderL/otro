# Lotería mexicana

Estado: **jugable** en la sala común del casino (`/loteria`). Entrada de 50
fichas virtuales, inscripción de 60 segundos, dos a cien personas, cartón de 16
cartas, canto cada dos segundos y victoria con cartón completo. Si hay empate,
las fichas se reparten en partes enteras iguales y el sobrante se acumula para
la siguiente ronda. El marcado es automático.

## Cómo se juega

1. Entra a `/loteria` desde la tarjeta del lobby o el enlace «Lotería» del nav.
2. Pulsa **Entrar por 50 fichas**. La primera vez se pide un apodo y la
   aceptación vigente de los Términos y Condiciones (misma regla que en las
   mesas).
3. El servidor recibe el pago y entrega un cartón de 16 cartas distinto por
   persona. Solo su dueño lo ve.
4. Al cerrar la inscripción empieza el canto automático: una carta cada dos
   segundos, en el orden aleatorio que decidió el servidor.
5. Gana el primer cartón con sus 16 cartas cantadas. El premio se acredita en
   el perfil en el mismo paso de la liquidación.

## Reglas acordadas

- Entrada: 50 fichas por ronda. Sin recompras, sin apuestas adicionales.
- Inscripción: 60 segundos (configurable para pruebas).
- Capacidad: de 2 a 100 cartones. Si al cierre hay menos de dos, se devuelven
  las entradas y el acumulado previo se conserva.
- Salir durante la inscripción cancela la entrada y reembolsa las 50 fichas. Si
  la ronda ya empezó, el cartón sigue participando y conserva su derecho al
  premio (regla pedida por el usuario).
- Desconectarse de la página durante la inscripción equivale a salir: si no hay
  otra pestaña del mismo perfil en la lotería, se reembolsa la entrada.
- Empate: reparto en fichas enteras iguales; el sobrante (`pot mod n`) queda
  como acumulado (`carry`) de la siguiente ronda.
- El premio se calcula con el bote de la ronda: `carry + 50 × cartones`.

## Arquitectura

| Archivo | Responsabilidad |
| --- | --- |
| `lib/loteria/game.js` | Reglas puras: baraja criptográfica, cartones, reloj de canto, cancelación y reparto. No toca saldos. |
| `lib/loteria/cards.js` | Catálogo único de las 54 cartas (número, nombre y emoji). Viaja al navegador en la suscripción. |
| `lib/loteria/service.js` | Servicio único del casino: cola serializada, cobros, reembolsos, premios, estadísticas, estado persistido y recuperación. |
| `lib/loteria/pg-store.js` | Adaptador PostgreSQL **experimental**, no conectado al servidor. Se conserva como referencia; el servicio en producción usa el archivo JSON del disco persistente. |
| `public/loteria.html` / `loteria.css` / `loteria.js` | Pantalla completa de la sala (diseño solo escritorio, sin scripts inline). |

El servicio vive en `server.js` (variable `loteria`) y se crea en `bootstrap()`
antes de abrir el puerto. Los sockets del casino lo leen en diferido.

## Dinero, idempotencia y recuperación

- Cada movimiento de fichas tiene un `operationId` determinista
  (`loteria:<kind>:<sha256 de partida+perfil+intento>`). `lib/progression.js`
  guarda ese identificador dentro del propio perfil
  (`appliedChipOperations`), en el mismo guardado que el saldo: repetir un
  movimiento nunca duplica el cobro ni el pago, aunque el proceso caiga entre
  la operación y el guardado.
- Orden de cada transición:
  1. se persiste el estado de la ronda (jugador inscrito o resultado) en
     `LOTERIA_STATE_PATH`;
  2. se aplica el movimiento sobre el saldo en memoria;
  3. se confirma el perfil con `persistProfile`;
  4. solo entonces se retira el movimiento de la lista `pending`.
- Al arrancar, `recover()` aplica lo que quedó pendiente: cobros de entradas a
  medias, premios no confirmados y devoluciones. Un perfil borrado no impide
  pagar al resto de la ronda.
- Decisión de recuperación: **se reembolsa mientras el resultado no está
  confirmado y se paga el resultado ya confirmado**.
- Si el guardado del perfil falla, el movimiento se queda en `pending` y se
  reintenta en el siguiente ciclo; nunca se cobra dos veces.
- El archivo de estado se escribe de forma atómica (`.tmp` + `rename`). Si el
  JSON está corrupto, se descarta y se abre una ronda nueva sin tumbar el
  servicio.

## Protocolo Socket.IO

| Evento | Dirección | Uso |
| --- | --- | --- |
| `loteria_subscribe` | cliente → servidor (ack) | Devuelve catálogo de cartas, versión de Términos, estado público e identidad/saldo del suscriptor. |
| `loteria_join` | cliente → servidor (ack) | Verifica Términos, cobra la entrada y entrega el cartón privado. |
| `loteria_leave` | cliente → servidor (ack) | Cancela y reembolsa solo durante la inscripción. |
| `loteria_state` | servidor → todos | Estado público de la ronda: fase, bote, cartones, cartas cantadas, nombres y resultado. Nunca incluye cartones ajenos ni identificadores de perfil. |
| `loteria_you` | servidor → cada suscriptor | Saldo, cartón propio y si está inscrito. |
| `profile_event` | servidor → el perfil | Logros, retos y cosméticos ganados con la ronda. |

La identidad sigue la misma regla que las mesas (`lib/seat-identity.js`): con
sesión de cuenta verificada se usa el perfil de la cuenta; sin ella, el perfil
del dispositivo. Nunca se acepta un identificador enviado en el payload.

## Configuración

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `LOTERIA_ENABLED` | activa | `off` apaga la sala (la tarjeta del lobby sigue visible como enlace, la página informa que no está disponible). |
| `LOTERIA_STATE_PATH` | `data/loteria.json` | Archivo de estado de la ronda. En Render, el disco persistente (`/var/data/loteria.json`). |
| `LOTERIA_REGISTRATION_MS` | `60000` | Duración de la inscripción (3 s – 10 min). |
| `LOTERIA_CALL_INTERVAL_MS` | `2000` | Intervalo entre cantos (20 ms – 60 s). |
| `LOTERIA_BREAK_MS` | `12000` | Descanso con el resultado en pantalla antes de abrir otra ronda. |

## Pruebas

- `tests/loteria-game.test.js`: reglas puras (límites, privacidad, cierre,
  empate, acumulado, doble liquidación).
- `tests/loteria-service.test.js`: cobro, saldo insuficiente, salida y
  reembolso, cancelación con menos de dos cartones, reparto, persistencia de
  estadísticas sin logros, reintento tras un guardado fallido, recuperación
  tras reinicio y archivo corrupto.
- `tests/loteria-ui.test.js`: la página real en jsdom (cartón, cantadas,
  botones, identidad y Términos, pantalla de resultado y CSP).
- `tests/loteria-sockets.test.js`: servidor real en un proceso aparte con tres
  dispositivos; cobro, reembolso, canto, privacidad, reparto exacto y apertura
  de la siguiente ronda.
- `tests/loteria-pg.test.js`: adaptador PostgreSQL experimental aislado (solo
  corre con `LOTERIA_TEST_DATABASE_URL`).

## Límites conocidos

- Pensada para **una instancia** del servidor: la ronda es única y el archivo
  de estado no coordina varias réplicas. Para escalar horizontalmente haría
  falta el adaptador PostgreSQL con transacciones y bloqueo compartido.
- No hay bots ni relleno automático: se necesitan **dos personas reales** para
  que la ronda no se cancele.
- El cierre mensual de temporada puede ocurrir a mitad de ronda (el casino
  reinicia saldos al cambiar el mes). La ronda termina y paga con el saldo
  nuevo; no se han hecho pruebas de caída justo en ese instante.
- El cartón es de una sola ronda: no se reutiliza ni se conserva entre rondas.
- La pantalla no tiene animación de baraja ni sonido; el marcado es instantáneo
  y el resultado se anuncia con texto accesible.
