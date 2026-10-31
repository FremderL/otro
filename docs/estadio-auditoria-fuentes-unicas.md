# Estadio MonteCristo — auditoría de «una sola fuente» (barrido posterior al incidente)

**31-oct-2026**

Después de dos incidentes con la misma raíz —el marcador de un partido calculado de dos maneras y el
acumulado de un jugador contado dos veces— se hizo un barrido del Estadio buscando **la misma clase de
fallo en cualquier otro sitio**:

> un hecho que mueve fichas o estadísticas se resuelve con **dos fuentes distintas**, o se **aplica
> dos veces**, o se busca en el **ámbito equivocado**; y el desajuste es silencioso.

Encontré tres. Los tres están corregidos con prueba de regresión. Abajo queda también lo que revisé y
salió limpio, para no repetir el barrido desde cero.

---

## 1. El mercado que se vendía no era el que se liquidaba (dinero)

`correct_score` publica **doce marcadores exactos** más la selección `other` («cualquier otro
resultado»). Las doce celdas salen de la matriz de goles del momento, y esa matriz **se mueve con cada
resultado asentado de la liga** (ratings de los clubes y contexto rodante).

Al liquidar, `_correctScoreCells(match)` **volvía a calcular** las celdas y resolvía `other` contra
ellas. Es decir: el boleto decía «fuera de las doce que te mostré» y se pagaba con «fuera de las doce
que la liga tiene hoy».

Reproducido de punta a punta: apuesta a `other` con `0-1` entre las doce publicadas y cuota 5.8 →
la liga se mueve (jornadas asentadas con resultados altos) → el partido termina **0-1**, que ya estaba
ofrecido, así que la apuesta **perdió** por definición… y el sistema la pagó: **145 000 fichas por una
apuesta perdedora**.

**Corrección.** Las celdas publicadas se archivan con la apuesta (`bet.correctScoreCells`) y con cada
pata de la combinada. `_cellsForBet` resuelve `other` contra **esa** lista en las tres rutas de
liquidación (final del partido, reconciliación de arranque y patas de combinada). Un boleto anterior a
este cambio, sin celdas guardadas, cae al recálculo como antes; un campo corrupto **nunca** hace
desaparecer la apuesta: se descarta y se sigue por el camino viejo.

## 2. Un partido en vuelo se quedaba fuera de su temporada (dinero + tabla + premio)

`engine.reconcile` arranca con `store.ensureSeason(hoy)`, que **cierra la temporada del mes anterior**
y crea la nueva, y después recorre solo `store.getMatches()` = **temporada vigente**. Un partido que
seguía sin asentar cuando cambió el mes quedaba huérfano para siempre:

- la tabla del mes cerrado se quedaba en 239 de 240 partidos;
- el Balón de Oro no podía finalizarse (exige todos los partidos regulares asentados);
- sus apuestas se anulaban al buscar el partido en la temporada nueva: `getMatch` devolvía `null` →
  **«partido inexistente»** → reembolso en vez de pago, incluido un boleto ganador.

**Corrección.**

- `engine._settleStaleSeasons(now)`: **antes** de rotar la temporada, congela los insumos y asienta con
  su seed los partidos de temporadas anteriores ya jugados. Mismo orden que el Paso 0 (congelar todos
  y asentar después) para que el primer resultado no mueva los ratings de los demás.
- `store.getMatchAnywhere(matchId)`: busca en todas las temporadas cargadas (la vigente primero). Lo
  usan el reconciliador de escrow y el cash-out; un boleto no se da por inexistente por haber cruzado
  el mes.

## 3. Un asentado sin cronología mezclaba tres fuentes

En `store.settleMatch`, si el asentado llegaba **sin línea de tiempo** (palanca admin, herramienta,
reproceso), el código regeneraba un partido con los ratings **de hoy** solo para el Balón de Oro, y
dejaba `fantasyStats` y `highlights` en `null` porque usaba otra variable. Resultado: el premio sumaba
goles que el resumen del partido no mostraba — el mismo síntoma que reportó el jugador.

**Corrección.** Una sola cronología por asentado:

1. manda la que reveló el motor;
2. si no vino, se reconstruye **solo** desde la foto de insumos del partido (`generationInputs`), que
   reproduce exactamente el partido revelado (mismo seed + mismos insumos + mismo marcador);
3. sin foto no hay cronología verificada y **no se acredita nada**: el marcador se asienta y las
   estadísticas quedan vacías. Se mantiene la regla de diseño que ya tenían Mi Once y los destacados
   («no se inventan hechos de partidos manuales o históricos») y ahora el premio la cumple también.

Cuando la cronología existe, premio, archivo de Mi Once y destacados salen de la misma lista de
eventos, y la auditoría del acumulado puede rehacerlo exactamente.

---

## Lo que revisé y está bien (para no repetir el barrido)

| Área | Por qué queda tranquila |
| --- | --- |
| Pago de apuestas simples | `store.settleBet` exige `status === 'open'`; el pago sale **después** del cambio de estado; reintentos devuelven `alreadySettled` sin pagar |
| Combinadas | `settleParlay`/`settleParlayLeg` con la misma guarda; la evaluación es idempotente sobre las patas |
| Futuros y Balón de Oro | `settleFuture` con guarda; los pagos del premio llevan `payoutApplied` y `reconcileBallonDorPayouts` los recupera una sola vez |
| Cash-out | Guardado por `status === 'open'` del boleto y por el partido sin terminar |
| Escrow / colocación | WAL: `pending` + `debited` es durable antes de mover fichas; `cancelPendingBets` reembolsa lo marcado |
| Quiniela | Transacción con `FOR UPDATE` de la ronda, `status !== 'open'` devuelve el resultado guardado y los movimientos tienen PK única: no hay doble pago |
| Promociones de La Previa | Revisión solo desde `pending` (409 si ya se revisó) + cobro/reembolso en la misma transacción |
| Tabla de posiciones | Se **reconstruye** desde todos los asentados; nunca se acumula |
| Ratings Elo y contexto | Se aplican una vez por asentado (dentro de la guarda de idempotencia); el carryover de temporada se aplica al crear la temporada, que se crea una sola vez |
| Cuotas del premio | `updateBallonDorOdds` es monótono en timestamp y en jornada: una foto vieja no pisa a una nueva |
| Estado en vivo para apostar | `liveStateFor(match)` se deriva en el servidor; el cliente no manda minuto ni marcador |
| Anillo de auditoría de cuotas | Acotado a 2000 entradas en memoria y en disco |
| Barridos del scheduler | «Derivar, no acumular»: cada caso es idempotente y corre con anti-reentrancia |

## Límites conocidos (documentados, no corregidos)

- **Celdas de boletos viejos**: las apuestas de `correct_score` colocadas antes de este cambio no
  tienen celdas archivadas; se resuelven con el recálculo, como hasta ahora. Desaparece en cuanto
  pasen los boletos abiertos.
- **Dedupe del club de afición**: `wonMatchIds` se recorta a las últimas 4096 victorias. Con ~12–15
  victorias al mes son ~28 años de juego antes de que un partido pudiera volver a contarse; se deja
  anotado por si el premio se alarga.

## Pruebas

- `tests/football-bet-market-freeze.test.js` (5): el boleto archiva y rehidrata las celdas; `other` se
  resuelve contra lo vendido aunque la matriz se haya movido; la liquidación de arranque usa las mismas
  celdas; cada pata de la combinada guarda las suyas; un campo corrupto no anula la apuesta.
- `tests/football-season-boundary.test.js` (3): el partido colgado de la temporada anterior se asienta
  antes de rotar y la tabla cierra en 480 apariciones; su apuesta se paga en vez de anularse; un
  asentado sin línea de tiempo archiva lo mismo que el premio y los destacados.

Ambas están en `npm run test:unit` (449 pruebas) y la integración sigue en 206 pass / 7 skip / 0 fail.
