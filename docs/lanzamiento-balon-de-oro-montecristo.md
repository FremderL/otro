# Lanzamiento controlado — Balón de Oro MonteCristo

**Estado (27 de octubre de 2026):** lista la preparación de release y pasó el ensayo automatizado local; **no se ha desplegado ni iniciado un piloto productivo**. No activar a todos los jugadores hasta que una edición piloto real termine y la auditoría de pagos/reembolsos esté firmada.

## Configuración versionada y segura

`render.yaml` deja `FOOTBALL_ENABLED=off`. Si la variable no existe, `loadFootballConfig()` también deja el Estadio apagado. Las rutas `/estadio`, `/balon-de-oro` y `/api/estadio/*` responden `404`, no se inicializa el scheduler ni se instala el gate de fútbol en el reset normal.

El blueprint persiste el store de partidos, cuotas y boletos en `FOOTBALL_STORE_PATH=/var/data/football.json`, dentro del disco persistente `/var/data`. **No** compartir ese disco ni `PROFILE_STORE_PATH` entre producción y piloto. Si se selecciona PostgreSQL en el entorno, la migración y una comprobación contra una instancia real son puertas independientes; el pool simulado no las reemplaza.

## Secuencia de activación

1. **Producción en reposo:** desplegar la configuración versionada con `FOOTBALL_ENABLED=off`. Confirmar `GET /healthz` → `football.enabled: false`, `/estadio` → `404` y que las funciones habituales del casino siguen sanas.
2. **Preparar un servicio aislado de staging:** usar el mismo commit, un disco/base de datos y perfiles exclusivos de staging, `CASINO_TIME_ZONE=America/Mexico_City`, rutas persistentes y `FOOTBALL_ENABLED=on`. Nunca habilitar el flag sobre datos de producción para ensayar; el flag global expone el Estadio a todas las personas de ese servicio.
3. **Preflight local reproducible:** `npm run test:football-release`. Este dress rehearsal recorre 30 jornadas/240 partidos, cierra J20, anuncia a las 22:00 locales, liquida, repite el sweep, procesa el reset y abre la siguiente edición; también prueba una cancelación con reembolso.
4. **Piloto real en staging:** mantener el entorno durante una edición mensual completa. Revisar cada día `/healthz` y logs estructurados; probar colocación de boletos, la inauguración y la ceremonia en navegadores reales. Confirmar que la inauguración se presenta una vez y que, al completarse, no hay acceso para repetirla; el replay solo corresponde a la ceremonia final. Las peticiones de audio bloqueadas por autoplay son un resultado esperado si se conserva el fallback visual.
5. **Puerta de promoción a todos:** solo tras el cierre real del piloto, comprobar que no haya boletos `open`/`pending`, pagos pendientes, ni reembolsos sin aplicar. Una edición liquidada debe tener `settlementComplete: true`; una cancelada debe tener todos los boletos en estado terminal y cada stake reembolsado exactamente una vez. Revisar recibos/ledger persistidos, cero errores de sweep y el reset del mes siguiente sin aplazamiento.
6. **Habilitar a todos:** con esa evidencia y aprobación operativa, cambiar manualmente `FOOTBALL_ENABLED` a `on` **solo en producción** y redeplegar. No hay automatismo que promueva el flag. Guardar la fecha, edición, commit y responsable de la aprobación en el reporte de esa edición.
7. **Rollback:** volver a `off` si hay descuadre, error repetido o estado incoherente; conservar intactos los archivos/base persistentes. Apagar el flag detiene el motor mientras esté apagado; al reactivarlo se debe observar su reconciliación antes de comunicar recuperación. No usar el flag como método de anulación o reembolso.

## Observabilidad y umbrales

- `GET /healthz` mantiene su respuesta rápida y agrega `football.ballonDor.current`, `lastCompleted` y `sweep`: estado, agregados de boletos, errores, última duración, p95/máximo de los últimos 100 sweeps. Los agregados no exponen perfiles, selecciones ni importes de pagos. Contadores de duración se reinician al reiniciar el proceso; el estado del evento y los boletos siguen en el store persistente.
- Para el piloto: `sweep.errors = 0`; `p95DurationMs < 30.000`; `maxDurationMs < 60.000` (intervalo del sweep); motor no degradado; ningún error de lifecycle/recovery sin resolver.
- Filtrar logs operativos por `football_ballon_dor_sweep_completed`, `football_ballon_dor_lifecycle_error`, `football_ballon_dor_sweep_error`, `football_ballon_dor_odds_error`, `football_ballon_dor_tiebreak_error`, `football_ballon_dor_finalize_error`, `football_ballon_dor_cancelled`, `football_ballon_dor_payouts_updated`, `football_ballon_dor_pre_reset_error`, `football_ballon_dor_post_reset_recovery` y `football_ballon_dor_post_reset_error`. El logger de producción excluye deliberadamente los eventos por boleto (`bet_placed`, `bet_settled`, `bet_refunded`, errores de persistencia/reembolso); los detalles necesarios para el ledger permanecen en el store privado y las notificaciones de liquidación se enrutan solo al perfil correspondiente. Para observar volumen/estado de apuestas usa los conteos agregados de `/healthz`; no exportes ni registres IDs, selecciones, stakes o pagos individuales.
- La reproducción envía únicamente `seasonMonth`, pista y resultado (`started`, `completed`, `blocked`, `error`) al endpoint same-origin `/api/estadio/telemetry/audio`. No se manda token, perfil, IP, agente de usuario, selección ni boleto. Hay un límite global de 1.200 eventos por minuto y no se guarda telemetría en base: el log operativo y el snapshot agregado de `/healthz` son las fuentes del piloto. `started`/`completed` cuentan reproducciones, no personas únicas.
- Validar manualmente el MP3 de inauguración, el tema WAV, los seis cues y los 16 clips de nombres por `playerId`; comprobar la sincronización del podio, el fondo instrumental sutil, los subtítulos/transcripción sin sonido y `prefers-reduced-motion`. No usar el porcentaje de bloqueos como puerta de fallo si el fallback permanece funcional.

## Aviso público listo para completar

**Borrador: no publicar hasta aprobar el piloto y fijar una fecha productiva.** Completar `[MES AAAA]` y `[FECHA/HORA LOCAL DE APERTURA]`; la edición abre el día 1 de ese mes en `America/Mexico_City`.

> **Balón de Oro MonteCristo · edición [MES AAAA]**
> La Liga MonteCristo presenta una carrera de 30 jornadas entre 16 delanteros ST, uno por club. Goles, asistencias, apariciones, disciplina y posición final del club determinan el resultado según el reglamento publicado. Puedes hacer una sola predicción por perfil, con fichas 100 % virtuales; no hay dinero real, depósitos ni retiros. Las predicciones cierran al liquidarse J20. La temporada se anuncia y liquida a las 10:00 p. m. de Ciudad de México después del último partido; si este termina a las 10:00 p. m. o más tarde, el anuncio será a las 10:00 p. m. del siguiente día local. Si la temporada no puede completarse, el boleto se cancela y se reembolsa el stake. La inauguración dura aproximadamente 45 segundos; la ceremonia final es una secuencia dinámica de unos 20–21 segundos según los nombres que se pronuncien. Ambas incluyen texto/subtítulos y se entienden sin audio.

Las reglas detalladas y la fórmula permanecen en `docs/plan-balon-de-oro-montecristo.md`. La página `/balon-de-oro` muestra candidatos, estado del mercado, fecha de anuncio y el resultado oficial; repetir la ceremonia no cambia apuestas ni pagos.

## Criterio de cierre

El ensayo local demuestra el comportamiento técnico e idempotente; **no equivale a un piloto con personas ni a un lanzamiento productivo**. El gate de promoción a todos solo puede cerrarse con el reporte de una edición mensual real de staging y evidencia del store persistente. En este checkout no hay configuración/acceso al servicio de hosting ni una instancia PostgreSQL real, así que el flag queda apagado y la fecha pública no se anuncia todavía.
