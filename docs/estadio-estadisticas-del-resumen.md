# Estadio MonteCristo — goles y asistencias: el resumen del partido y el acumulado del premio

**Corrección de incidente · 31-oct-2026**

## Lo que reportó el jugador

Partido *Benfica de Beneficencia 4–3 Atleti-comedia FC* (J30). En **Destacados del partido**:

- «Goles y asistencias»: siete goles, con **Ravi Kim** marcando el 18′ y asistiendo en el 7′ y el 37′.
- «Figura estadística»: **Ravi Kim · 1 goles · 2 asistencias**.

Y en la **ficha del Balón de Oro** —la del delantero centro del club— el mismo jugador aparecía con
**2 goles y 3 asistencias**. «Los resúmenes se están dando mal».

## Qué estaba pasando

Son **dos números distintos**, y el jugador tenía razón en desconfiar: la app no lo decía en ninguna
parte.

| Panel | Qué cuenta |
| --- | --- |
| Destacados del partido | **Solo ese partido**, desde la línea de tiempo asentada: goles y asistencias del 4–3 |
| Ficha del Balón de Oro | **Acumulado del premio** de toda la temporada del ciclo (jornadas 1–20) |

El resumen del partido era correcto: Ravi Kim hizo 1 gol y 2 asistencias en ese 4–3, y esa es
exactamente la suma de los siete goles listados. La ficha del premio sumaba todas sus jornadas; al no
indicar la ventana, parecía el mismo dato mal calculado.

La ficha pasa a decir **«Acumulado de la temporada, no de este partido»**, y la figura estadística se
rotula como **del partido**, para que los dos números no se lean como contradictorios.

## El defecto real que sí había debajo

Al auditar el acumulado apareció el riesgo serio: **el premio podía contar un partido dos veces**.

`settleMatch` sumaba la contribución del partido al evento del Balón de Oro *antes* de comprobar si el
partido ya estaba asentado. La guarda de idempotencia era `match.status === 'settled'`, y el motor
ponía `status = 'finished'` justo antes de llamar al store (mismo objeto compartido): un segundo
asentamiento —reconciliación de arranque, palanca admin— volvía a sumar goles, asistencias y
apariciones del mismo partido. El acumulado del delantero quedaba inflado y el premio podía coronar al
jugador equivocado.

Esa puerta la cerró la corrección del marcador autoritativo
(`docs/estadio-resultado-autoritativo.md`): la guarda ahora mira `status === 'settled' || settledAt ||
result` y el primer asentamiento es inmodificable. Faltaba poder **comprobarlo y repararlo**.

## La corrección

1. **El archivo por partido guarda todo lo que el premio acumula** (`lib/football/fantasy.js`).
   `match.fantasyStats` añade `minutes` y `yellows` a `goals`, `assists`, `played` y `reds`, así el
   acumulado se puede rehacer partido a partido sin depender de una línea de tiempo que ya no existe
   (§13.2). Los partidos asentados antes de este cambio siguen cargando igual: los campos nuevos son
   opcionales y la auditoría los marca como no verificables.
2. **Auditoría** (`lib/football/ballon-dor-audit.js`). Para cada candidato suma el archivo de todos los
   partidos regulares asentados de su club y lo compara con `candidate.stats`. Goles, asistencias,
   apariciones y rojas son verificables siempre; minutos y amarillas, cuando el archivo los tiene. Sin
   archivo (partido viejo o plantilla incompleta) el candidato queda **sin verificar** y no se toca:
   nunca se inventa un número.
3. **Reparación** (`store.repairBallonDor`). Devuelve el evento corregido con los puntos recalculados
   (`calculateBallonDorPoints`). Solo actúa mientras el premio sigue acumulando; un evento ya `settled`
   o `cancelled` tiene ceremonia, resultado y pagos, y **no se reescribe en silencio**: la auditoría lo
   reporta y la decisión es del dueño.
4. **Arranque** (`server.js`, paso 5b). En cada arranque se audita la temporada actual; si hay
   diferencias se registra `football_ballon_dor_stats_mismatch` con el detalle por jugador
   (acumulado, archivo, delta) y, si el evento sigue abierto, se repara en la misma pasada
   (`football_ballon_dor_stats_repaired`). Corre **antes** del barrido del premio, para que las cuotas
   se calculen con las estadísticas ya corregidas.
5. **Diagnóstico manual**: `npm run football:audit-bdo` (solo lectura) y `-- --apply` para reparar;
   `--season 2026-10` y `--player "ravi"` para acotar. Usa Postgres si hay `DATABASE_URL` y el archivo
   de `FOOTBALL_STORE_PATH` si no.

## Efecto sobre los datos existentes

- Nada se reescribe al desplegar salvo acumulados que **no cuadren con el archivo** y pertenezcan a un
  premio todavía abierto; en ese caso el registro queda en el log con el antes y el después.
- Un premio ya cerrado no se toca: si la auditoría encuentra una diferencia ahí, el log la nombra y el
  dueño decide si se revisa la ceremonia y los pagos.
- El resumen de un partido no cambia: su fuente siempre fue la línea de tiempo asentada.

## Pruebas

`tests/football-ballon-dor-audit.test.js` (incluida en `npm run test:unit`):

- el archivo del partido guarda goles, asistencias, minutos y amarillas del jugador;
- un acumulado limpio cuadra con el archivo y la reparación no propone nada (caso del reporte: 2 goles
  y 3 asistencias en el partido, idénticos en el premio);
- el doble conteo de un partido se detecta por su delta y la reparación devuelve las cifras del
  archivo y recalcula los puntos, de forma idempotente;
- un evento `settled` no se reescribe: se reporta `evento_cerrado`;
- sin archivo de partido el candidato queda sin verificar y no se inventa nada;
- una temporada asentada (24 partidos) cuadra con el archivo, minutos y amarillas incluidos;
- los archivos viejos, sin minutos ni amarillas, siguen cargando.
