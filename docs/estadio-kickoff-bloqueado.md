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
reinicio sin duplicarse en barridos posteriores. También se comprueban el fallo
persistente (no publicar un resultado sin confirmar) y el aislamiento de un
error de preparación. Estas pruebas se incorporan a `npm run test:unit`.

Esto prueba y corrige el defecto localmente, no establece por sí solo la causa
ni el estado del encuentro real: sigue siendo necesaria la verificación de
producción descrita arriba.
