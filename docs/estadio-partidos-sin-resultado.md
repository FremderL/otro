# Partidos sin acta: la tabla nunca se queda con un cruce de menos

> Incidente que motiva este documento: un partido no pudo iniciarse («Kickoff
> pendiente · esperando señal del partido»). Al día siguiente, el cruce seguía sin
> resultado y la tabla mostraba dos clubes con **0 partidos jugados** mientras el
> resto de la jornada ya sumaba puntos. Nadie lo detectaba: el partido había
> dejado de visitarse y la temporada iba a cerrar con 239 de 240 actas.

## Regla

**Todo partido regular vencido y sin acta se detecta y se intenta asentar**,
aunque la retransmisión nunca arrancara, el servidor estuviera apagado o haya
cambiado el mes. Se conserva el compromiso V2 íntegro y ejecutable; si el compromiso no se puede
verificar o ejecutar, se reembolsan primero las obligaciones aceptadas y se crea
un compromiso nuevo. Una temporada anterior no se considera completa
mientras falte una de sus 240 actas regulares.

La ventana de 30 minutos (`docs/estadio-reprogramacion-automatica.md`) solo decide
si el encuentro se reprograma una vez (dentro de la ventana) o se liquida directo
(fuera de ella). La reprogramación es una cortesía de transmisión, nunca una
forma de perder el acta.

## Los tres agujeros que se corrigieron

1. **El barrido solo veía la temporada vigente.** `engine.operationalMatches()`
   devolvía los partidos del mes en curso más los que tenían boletos abiertos. Un
   cruce colgado sin apuestas desaparecía del barrido en cuanto cambiaba el mes:
   ni se reprogramaba ni se liquidaba, y su temporada se cerraba incompleta.
   Ahora la lista incluye **cualquier** partido no terminal de **cualquier**
   temporada cargada, así que el barrido de kickoff, el de atascados, la
   reconciliación y la reprogramación lo siguen viendo.
2. **La rotación de temporada cerraba el mes con deudas.** `closeSeason` calculaba
   el arrastre de ratings (Elo/prestigio) sobre `league.standings`, que podía
   estar incompleta. Ahora la tabla se **reconstruye desde las actas**
   (`store.rebuildStandings`) antes de cerrar, y `engine.ensureTodayScheduled`
   **aplaza la rotación** mientras haya partidos de meses anteriores sin acta.
   El aplazamiento tiene tope (`ROTATION_DEFER_MS`, 6 h **desde que se detectó la
   deuda**): congelar la liga entera sería peor, así que pasado el tope se rota,
   se registra `football_season_rotation_forced` y la reparación periódica asienta
   el encuentro y recalcula tabla y carryover del mes ya cerrado. El tope se mide
   desde la detección —no desde el kickoff— para que un hueco viejo (el servidor
   estuvo caído) igual tenga su intento de reparación antes de cerrar.
3. **«Todavía no preparado» se confundía con «imposible de derivar».** Un partido
   V2 sin compromiso confirmado hacía fallar la liquidación y, en la
   reconciliación síncrona, se **pospía y reembolsaba** a los 45 minutos: los
   boletos se anulaban y el cruce nunca volvía a la tabla. Ahora
   `engine._awaitsV2Preparation()` lo distingue y lo deja pendiente para el
   barrido (que reintenta con la persistencia ya disponible). Solo se pospone lo
   que de verdad no se puede derivar.

## Reparación periódica, auditoría de actas y recuperación segura de V2

`engine.repairOverdueMatches(now)` recorre **todas** las temporadas, de la más
antigua a la más nueva, y asienta por jornada y en orden cronológico. Además,
`auditSeasonMatchCounts(now)` compara cada calendario con las **240 actas regulares
esperadas**, cuenta las actas registradas y detecta partidos vencidos sin
resultado. La reconciliación registra `football_season_match_count_gap` y vuelve a
intentar liquidarlos en el siguiente barrido; los duplicados no suman porque el
asentado es idempotente.

Si el compromiso V2 no se puede verificar o el simulador demuestra que no puede
crear el partido (por ejemplo, un once inválido), la reparación no reutiliza el
sorteo defectuoso. Si existen obligaciones activas, primero las anula y confirma
los reembolsos de simples, combinadas, futuros y quiniela; solo después genera y
persiste un compromiso nuevo y asienta el partido. Las operaciones de pago usan
claves idempotentes y cada paso pendiente se reintenta: si no se confirma un
reembolso o su persistencia, el partido permanece abierto y no se asienta. El
partido recuperado queda marcado `resultOnly`: en la vista pública solo entrega
el marcador final, sin relato, cronología, highlights, estadísticas ni mercados.
El historial interno conserva la razón y el identificador/hash del compromiso
anterior, sin publicar su clave privada. Los partidos ya asentados y las
posposiciones administrativas tampoco se modifican.


En cada vuelta el proceso:
1. prepara o confirma los compromisos V2 que faltan (sin persistencia confirmada
   no asienta; se reintenta en la siguiente vuelta);
2. ante compromiso no verificable o snapshot no ejecutable, anula las obligaciones
   activas, confirma cada reembolso y solo entonces persiste un compromiso nuevo;
3. congela los insumos de generación de **todos** los partidos de la jornada antes
   del primer asentado, para que un resultado no mueva los ratings del siguiente;
4. liquida con `settleOverdueMatch` y, si hubo asentados, reconstruye la tabla y
   recalcula el `carryover` cuando la temporada ya estaba cerrada;
5. persiste por jornada; si falla, deja el resto pendiente para la próxima vuelta.
   Nunca duplica ni reescribe un resultado ya asentado.

Corre en:
- `reconcileBoot` (arranque o despertar tras inactividad), después de preparar V2
  y antes de aceptar tráfico;
- `FootballScheduler.runSeasonSweep` (cada minuto), **antes** de intentar la
  rotación de temporada;
- el propio cierre de temporada, gracias a `rebuildStandings`.

## Posposiciones: origen y recuperación

`engine.quarantine(match, reason, { by })` guarda `match.postponed = { at,
reason, by }`, que se persiste (`cleanMatch`):

- `by: 'engine'` — fallo técnico del motor. El barrido de vencidos lo **recupera**
  (vuelve a `scheduled` y se asienta con su seed). Los boletos reembolsados al
  posponer siguen `void`, así que nadie cobra dos veces.
- `by: 'admin'` — decisión editorial (`POST /admin/estadio/matches/:id/postpone`
  la marca así). Se respeta para siempre: no se convierte en partido jugado.

Para posposiciones antiguas (sin origen guardado) o para forzar la revisión de
una decisión editorial existe `POST /admin/estadio/matches/:id/reopen`: devuelve
el partido al ciclo sin resultado y el barrido lo asienta en el siguiente minuto.

## Lo que ve el aficionado

El lobby publica `standingsPending` (cuenta, pospuestos y hasta seis cruces) y la
tabla muestra una nota debajo:

- «**1 partido en liquidación**: Puerto Ámbar vs Olympique Estevin · el resultado
  se asienta automáticamente y la tabla se actualiza.»
- «**1 partido sin acta**: … · pospuesto sin resultado. La tabla cuenta solo lo
  jugado.»

Así una diferencia de PJ tiene explicación visible en lugar de parecer un error de
la tabla, y la nota desaparece sola cuando el acta entra.

## Eventos de observabilidad

| Evento | Cuándo |
| --- | --- |
| `football_overdue_settled` | Se asentó un vencido (incluye `delayMs` desde el kickoff original). |
| `football_overdue_repair` | Resumen por vuelta: temporadas, liquidados, pendientes, recuperados. |
| `football_overdue_repair_pending` | Un partido sigue pendiente (se reintenta; nunca se anula). |
| `football_overdue_commitment_recovered` | Snapshot V2 corrupto/no ejecutable reemplazado; incluye el identificador anterior y si hubo reembolsos confirmados. |
| `football_overdue_recommit_blocked` | Reembolso pendiente o recuperación no elegible; el partido sigue sin asentarse. |
| `football_match_obligations_refunded` | Reembolso idempotente de boletos simples, combinadas y futuros completado. |
| `football_quiniela_refunded` | Entradas de la quiniela reembolsadas y jornada cancelada. |
| `football_season_match_count_gap` | Auditoría: calendario/actas esperadas, registrados y vencidos sin resultado. |
| `football_overdue_recovered` | Un pospuesto por el motor volvió al ciclo y se asentó. |
| `football_season_rotation_deferred` | La rotación espera a que el mes que sale quede completo. |
| `football_season_rotation_forced` | Se agotó el aplazamiento (6 h) y se rotó con deuda pendiente. |
| `football_match_reopened` | Un admin (o la recuperación) devolvió un pospuesto al ciclo. |

Pruebas: `tests/football-overdue-repair.test.js` (cruce de mes, rotación
aplazada, reparación de una temporada ya cerrada, V2 no preparado que no se
pospone, posposición con origen y recuperación) y la nota de la tabla en
`tests/football-stadium-ui.test.js`.
