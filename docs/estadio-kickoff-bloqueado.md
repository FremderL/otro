# Investigación: partidos que permanecen en «Kickoff pendiente»

## Alcance comprobado

Se reprodujeron localmente los cruces de noviembre de West Hamón FC
(`norvela_sporting`) contra `dynamo_kelvar` y Bayern Munchies (`cs_verdania`),
con preparación V2 durable y recarga del almacenamiento. Ambos arrancan con
las plantillas iniciales. Esto **no demuestra** que las plantillas, compromisos
o escrituras de producción estén sanos: esta investigación no tuvo acceso a
la base ni a los logs del servicio desplegado.

Se confirmó un bloqueo general en el scheduler: `kickoffPending` impedía
cualquier nuevo barrido mientras se esperaba tanto la preparación de un solo
partido como la del horizonte completo. Un `await` que no terminaba podía dejar
los siguientes encuentros programados indefinidamente. Además, aun los
compromisos confirmados volvían a pasar por la cola de admisión de temporada.
No se ha establecido que esa fuera la causa de los dos incidentes reportados.

## Corrección preventiva

- Exclusión de arranque por partido, no por todo el calendario.
- Preparación del horizonte independiente, sin duplicarla si sigue pendiente.
- Compromisos íntegros, con precios y persistencia confirmada pueden arrancar
  sin esperar otra escritura de temporada. Se exige política válida/confirmada
  y escritor activo; el motor mantiene la comprobación de obligaciones.
- Al resolver una preparación asíncrona se vuelve a comprobar estado, horario
  y margen de retraso. Una respuesta antigua no inicia un partido reprogramado
  o asentado por el watchdog.
- `football_kickoff_waiting` identifica un arranque pendiente durante más de
  diez segundos (una advertencia por operación). Los errores de kickoff ahora
  incluyen partido, clubes y temporada.

No se cambian semillas, cuotas, resultados ni compromisos existentes. No se
liberan escrituras pendientes por un timeout artificial: eso permitiría que una
operación antigua escribiera después de un reintento. Si la base no confirma una
preparación nueva, ese partido sigue sin poder arrancar de forma segura.

Este cambio es infraestructura de programación/preparación, ya cubierta por
la exención técnica de `scheduler.js` en `NON_CLUB_NEWS_MODULES`. No inventa
anuncios deportivos ni atribuye a West Hamón una incidencia no comprobada.

## Verificación y despliegue

Pruebas en `tests/football-v2-official.test.js`: preparación/horizonte pendientes,
no duplicación de tareas, advertencia acotada, reprogramación durante el await,
los dos cruces tras reinicio y arranque con cola real de temporada ocupada.
Se mantienen las regresiones de persistencia, apuestas y liquidación de vencidos.

Para dar el incidente de producción por resuelto:

1. Desplegar esta revisión por el flujo habitual. Cambiar archivos en la rama
   de trabajo no actualiza por sí solo el servicio de Render.
2. Revisar los encuentros `m_2026-11_j1_b2_2` y `m_2026-11_j2_b1_1`
   (confirmar primero el mes/calendario efectivo del reporte).
3. Correlacionar sus logs `football_kickoff_error`,
   `football_v2_kickoff_not_ready`, `football_v2_prepare_error`,
   `football_kickoff_waiting` y `football_overdue_settle_error`.
4. Verificar concesión del escritor, persistencia y estado/compromiso de los
   encuentros. Un fallo de integridad requiere investigación; no borrar el
   compromiso ni volver a sortear un resultado para forzar el arranque.
5. Comprobar que los vencidos se asientan con el compromiso original y que el
   siguiente partido entra en vivo. No afirmar recuperación de los dos
   encuentros sin comprobar su estado persistido.

## Seguimiento: partido del día anterior sin resultado ni PJ

Se reprodujo un defecto adicional mediante un guardado V2 fallido: el snapshot
existía en memoria con `simulationUnconfirmed`, por lo que ambos reparadores
omitían su preparación (`!match.simulation`), mientras que el liquidador rechazaba
correctamente usarlo sin confirmación. Los barridos de recuperación por sí solos
no salían de ese estado; dependían de que otra ruta confirmara el snapshot.

La recuperación periódica y el barrido de cinco segundos ahora reintentan esa
confirmación sin cambiar el compromiso. La recuperación también aísla los
fallos de preparación por partido y reabre las posposiciones técnicas antes de
prepararlas. Las posposiciones administrativas se siguen respetando.

La regresión usa West Hamón–Arcenico de J1, al día siguiente: falla el guardado,
se restaura, se liquida, ambos clubes suman un PJ, y marcador/PJ sobreviven al
reinicio sin duplicarse en barridos posteriores. También valida que el snapshot
recuperado incluye el once titular de West Hamón con exactamente 11 jugadores
únicos. En la reproducción local el once no está roto; el bloqueo era que el
snapshot V2 quedaba marcado como no confirmado y el reparador no lo reintentaba.
Esto identifica y corrige el fallo de código reproducible, pero no permite
confirmar el contenido de la plantilla ni los logs del encuentro en producción.
También se comprueban el fallo persistente (no publicar un resultado sin
confirmar) y el aislamiento de un error de preparación. Estas pruebas se
incorporan a `npm run test:unit`.

Esto prueba y corrige el defecto localmente, no establece por sí solo la causa
ni el estado del encuentro real: sigue siendo necesaria la verificación de
producción descrita arriba.

## Investigación adicional: errores aislados dentro de la preparación V2

Se reprodujo otro fallo de código, sin acceso a datos ni logs de producción: el
preparador del horizonte trataba todos los partidos como un solo lote. Si uno
fallaba (por ejemplo, un compromiso inválido o una plantilla incompleta), el
bucle se detenía antes de guardar los compromisos anteriores y no preparaba los
posteriores. Además, ese error podía abortar la reconciliación de arranque. No
hay evidencia suficiente para atribuirle los encuentros reportados.

Ahora se procesan por separado, se registran temporada e ID del fallo, se
confirman los snapshots sanos únicamente después de un guardado exitoso y se
conserva el fallo de ese encuentro para diagnóstico. El arranque solo tolera
este error localizado: un fallo de política o de persistencia sigue siendo
crítico. Un V2 inválido nunca se sustituye por V1 ni se vuelve a sortear; se
conservan sus datos originales en una envoltura inválida para investigación,
sin exponerlos al cliente. Esto no restaura datos que se hubieran perdido antes
del despliegue; en ese caso se necesita un respaldo verificable.

El watchdog también aísla errores por partido, y una reparación en espera vuelve
a verificar si el encuentro sigue vencido antes de asentarlo. Los compromisos
V2 inválidos o sin confirmar no provocan reembolsos automáticos por tres errores.

Verificar tras desplegar: `football_v2_prepare_error` con ID de partido,
`football_v2_commitment_blocked`, `football_stuck_match_error`,
`football_overdue_repair_pending`, errores de persistencia y concesión de
escritor. Comparar el compromiso persistido y las obligaciones antes de cualquier
intervención manual. El resultado y los PJ reales solo pueden confirmarse en la
base del servicio; las pruebas locales no modifican producción.

## Retiro operativo de V1

El servidor del Estadio activa `onlyV2` y prohíbe generar o liquidar cronologías
V1. Los compromisos V2 confirmados siguen usando su versión y semilla original;
un V2 dañado permanece bloqueado, no se reemplaza. Los resultados históricos
asentados y sus estadísticas se conservan y la interfaz muestra el marcador
oficial, pero ya no regenera una retransmisión histórica V1. Se conservan los
módulos V1 fuera del flujo oficial para pruebas y compatibilidad de datos; las
funciones matemáticas compartidas no ejecutan el simulador V1.

Antes de preparar V2 se retiran y reembolsan las apuestas V1 abiertas vinculadas
a partidos sin acta, las combinadas completas con una pata V1 pendiente y los
futuros V1 que cubren partidos sin acta (incluido Balón de Oro). Se persiste la
anulación antes del crédito; las operaciones por boleto se reintentan con ID
idempotente y no se habilita la conversión mientras el reembolso correspondiente
no se confirme. No se modifican boletos ya liquidados ni apuestas V2 válidas.
Un V1 en vivo sin acta vuelve a programado después de los reembolsos y la
reparación lo prepara con V2. Si falta un perfil o persiste un fallo de escritura,
la conversión queda pendiente: `football_v1_retirement_pending` indica el motivo.
Un V2 ya confirmado que no tiene obligaciones incompatibles ni reembolsos
pendientes propios puede arrancar sin esperar el reembolso de otro partido.

Los partidos no asentados de temporadas anteriores a noviembre de 2026 no se
convierten automáticamente: se conservan pendientes para revisión, sin ejecutar
V1 ni inventar insumos históricos. Una deuda antigua o una obligación sin datos
válidos puede necesitar intervención. Las fechas de inicio, la política de
reprogramación y los compromisos V2 ya existentes no se modifican por el retiro.

La regresión de arranque real recrea los cruces de West Hamón de las jornadas 1
contra Arsénico y 2 contra Bayern, a las 15:01 del 2 de noviembre: reembolsa un
boleto V1, genera ambos resultados con V2, incluye actas/estadísticas y suma los
PJ una sola vez. Es una prueba local, no una lectura de los datos de producción.
