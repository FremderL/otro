# Quiniela · 8 de 8

Jornada de ocho partidos: se elige **1, X o 2** en cada uno. La entrada cuesta
**50 fichas**, la inscripción cierra en el primer saque y solo los boletos con
ocho aciertos se reparten el bote. Si nadie acierta, el bote se acumula.

Disponible en **Estadio → Quiniela**, y gobernada por `FOOTBALL_ENABLED` y
`FOOTBALL_QUINIELA_ENABLED` (por defecto encendida cuando el Estadio lo está).

## Piezas

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Reglas puras | `lib/football/quiniela.js` | Validación de la jornada y las ocho selecciones, y reparto del bote. No toca saldo ni perfiles. |
| Servicio | `lib/football/quiniela-service.js` | Inscribe, cobra, liquida, reembolsa y recupera. Es el que usa el servidor. |
| Diario | `league.quiniela` | Rondas y boletos, dentro de la liga: viaja con ella en archivo y en la columna `data` de PostgreSQL. |
| Bote | `store.quinielaCarry` | Acumulado de la liga; singleton `football_quiniela_bank` en PostgreSQL. |
| Sockets | `lib/football/sockets.js` | `football:quiniela_get`, `football:quiniela_enter` y el aviso `football:quiniela_updated` al lobby. |
| Panel | `public/estadio.js` | Formulario de las ocho selecciones, boleto propio y último resultado. |
| Adaptador PG con tabla propia | `lib/football/quiniela-pg.js` | **Sin conectar.** Escribe su propio diario en tablas dedicadas; no lo usa el servidor. |

## Dinero: journal primero, cartera después

1. El boleto se persiste como `pending_debit` y se confirma con `saveStrict()`.
2. Se debita la entrada con `debit()` y `operationId` fijo
   (`quiniela:${season}:${jornada}:${perfil}:entry`).
3. Se confirma el perfil. Si algo falla en el medio, `recover()` reaplica con el
   mismo `operationId`: `appliedChipOperations` y las transacciones del perfil
   deduplican, así que nunca se cobra ni se paga dos veces.

El crédito del premio o del reembolso usa el mismo esquema
(`…:prize`, `…:refund`).

## Liquidación

`sweep()` (barrido del scheduler) y `notifyMatch()` (hook del motor al asentarse
un partido) liquidan una jornada cuando sus ocho partidos ya tienen resultado.
Un pospuesto sin resultado cancela la jornada y reembolsa. `settleJornada()`
deriva, no acumula: un round ya asentado devuelve su resultado guardado sin pagar
otra vez.

## Dos fallos corregidos

### El bote se perdía al cambiar de temporada

El acumulado vivía en `league.quiniela.bank.carry`, es decir, dentro del `data`
de **una** temporada. Al rotar el mes, la liga nueva arrancaba con 0 y el
sobrante de las jornadas sin acertantes desaparecía en silencio: eran fichas
apostadas que nadie podía volver a ganar.

Ahora el bote es de la **liga** y vive en el store:

- archivo: campo `quinielaCarry` del JSON del store;
- PostgreSQL: tabla singleton `football_quiniela_bank` (una fila, `CHECK (carry >= 0)`),
  creada con el resto del esquema y escrita en la misma transacción del volcado.

`recover()` al arrancar **adopta** el bote que las versiones anteriores dejaban
dentro de las ligas: suma `league.quiniela.bank.carry` de todas las temporadas al
valor del store, deja los diarios en cero y lo registra como
`football_quiniela_carry_adopted`. Es idempotente.

### Una jornada abierta al rotar el mes se quedaba congelada

`sweep()` y `recover()` solo miraban la temporada vigente. Si la rotación caía
entre el asentado del último partido y el barrido de la quiniela (corre cada
minuto), esa jornada se quedaba en `open` para siempre: el boleto del jugador
seguía `open`, el bote no se repartía y la entrada de 50 fichas no volvía ni
pagaba.

Ahora el barrido recorre la temporada vigente **y** las cerradas que tengan
rondas abiertas (`pendingSeasons()`), cobra por separado cada temporada y las
liquida con las mismas reglas. El resultado del barrido incluye la temporada de
cada jornada liquidada.

## Consumo: lo que se midió y lo que cambió

La Quiniela difunde por socket y barre cada **10 s**, así que su coste se
multiplica. Medido antes y después:

| Qué | Antes | Después |
| --- | --- | --- |
| Aviso `football:quiniela_updated` al lobby | **1055 B** (snapshot con los 8 partidos, por cada boleto y cada liquidación) | **67 B** (−94 %, señal: temporada, jornada, cierre, bote) |
| Peticiones del panel al recibir un aviso | 1 por aviso, aunque repitiera lo mismo | solo si la señal **cambió** y el panel está abierto |
| Guardados por barrido sin trabajo | **1 por vuelta** (reescribe la liga completa, ~650 KB) | **0** |
| Guardados al liquidar una jornada pendiente | los mismos, en cada vuelta | **1** (solo cuando deja de haber deuda) |
| Coste en CPU de un barrido vacío | — | **0,18 ms** con 40 boletos |

El aviso es una señal porque el estado completo ya se puede pedir con
`football:quiniela_get`. El cliente guarda la última señal recibida
(`lastQuinielaSignal`) y descarta las repeticiones: un evento con cien boletos
ya no provoca cien refrescos del panel.

Las dos regresiones quedan cubiertas: `el barrido no reescribe la liga cuando no
hay nada que liquidar` (servicio) y la comprobación de que el aviso difundido no
lleva `matches` ni `myTicket` (sockets).

## Lo que sigue pendiente

- **Un solo proceso escritor.** El diario viaja dentro de la liga, así que no
  hay coordinación entre réplicas (el diseño es single-instance por la concesión
  de escritor del Estadio).
- **Dos adaptadores para lo mismo.** `lib/football/quiniela-pg.js` mantiene un
  diario propio en tablas dedicadas con bloqueo de asesoría, sin conectar. Sirve
  como referencia si algún día el diario sale de la liga, pero hoy duplica el
  trabajo: hay que elegir uno y borrar el otro.
- **Reparto con muchos boletos.** El bote se reparte en enteros y el sobrante
  pasa al acumulado; falta medir con cientos de boletos por jornada.
