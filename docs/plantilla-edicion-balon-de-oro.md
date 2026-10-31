# Plantilla reutilizable — edición Balón de Oro MonteCristo

Duplica esta plantilla **una vez por edición**. Rellena los campos entre corchetes; no edites la fórmula congelada ni inventes un candidato. Los 16 candidatos se derivan de los `ST` existentes, uno por club. El premio y las fichas son 100 % virtuales.

## 1. Ficha de edición

- **Edición / mes:** `[AAAA-MM]`
- **Commit desplegado:** `[SHA]`
- **Entorno:** `[staging / producción]`
- **Fecha/hora de apertura publicada (America/Mexico_City):** `[fecha y hora]`
- **Responsable operativo:** `[nombre o equipo; conservar en el reporte interno, nunca en telemetría pública]`
- **Fecha/hora del aviso aprobado:** `[fecha y hora / no publicado]`
- **Duración comunicada:** inauguración `1:48` (≈49,5 s de narración + tema instrumental hasta el cierre); ceremonia final `20–21 s` aprox. (dinámica según los clips de nombre).
- **Fichas:** virtuales; sin depósitos, dinero real ni retiros.

## 2. Lista previa al ciclo

- [ ] `FOOTBALL_ENABLED=off` sigue siendo el default del blueprint; staging está aislado de datos/perfiles productivos.
- [ ] Persistencia de staging montada y probada; `FOOTBALL_STORE_PATH` sobre disco persistente. No compartir disco/perfiles con otro entorno.
- [ ] `CASINO_TIME_ZONE=America/Mexico_City`; `/healthz` responde y muestra el estado esperado.
- [ ] `npm run check` y `npm run test:football-release` pasan en el commit que se va a desplegar.
- [ ] Hay 16 clubes, 16 `ST` existentes (uno por club), ciclo en día 1, candidatos y cuotas visibles; no se creó un jugador 19.
- [ ] Reglas, fecha aprobada y texto público revisados. Una predicción por perfil, cierre después de liquidarse J20, fichas virtuales y cancelación/reembolso descritos sin ambigüedad.
- [ ] Inicio tardío de la página prueba una sola inauguración por ciclo; una vez completada, no hay botón para repetirla. El replay solo aplica a la ceremonia final. Las 16 tarjetas son datos dinámicos, sin nuevos retratos por temporada.
- [ ] El audio de inauguración, tema instrumental WAV, seis cues y 16 clips de nombres es-MX por `playerId` responden; las tarjetas del 3.º, 2.º y 1.º puesto aparecen al comenzar el nombre correspondiente. Probar narración, captions/transcripción, fallback sin audio y movimiento reducido en móvil y escritorio.

## 3. Seguimiento durante el ciclo

Registrar aquí valores **agregados**, no nombres, IDs de perfil, IP, user-agent, selecciones ni saldos:

| Fecha local | Edición | Sweeps acumulados | Errores acumulados | Último ms | p95 ms | Máximo ms | Apuestas abiertas/pending/terminal | Notas / acción |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `[AAAA-MM-DD]` | `[AAAA-MM]` | `[…]` | `[…]` | `[…]` | `[…]` | `[…]` | `[…/…/…]` | `[…]` |

Observaciones de audio agregadas desde `football.ballonDor.audioTelemetry`:

| Pista | started | completed | blocked | error | Observación accesible sin audio |
| --- | ---: | ---: | ---: | ---: | --- |
| `opening_narration` | `[…]` | `[…]` | `[…]` | `[…]` | `[…]` |
| `ceremony_music` | `[…]` | `[…]` | `[…]` | `[…]` | `[…]` |
| `ceremony_narration` | `[…]` | `[…]` | `[…]` | `[…]` | `[…]` |

Bloqueos por autoplay no son por sí mismos un fallo si texto, subtítulos y escenas siguen completos. No calcular usuarios únicos con estos contadores.

## 4. Cierre, pagos y siguiente edición

- **Último partido/desempate finalizado (hora local):** `[…]`
- **Hora oficial del anuncio:** `22:00, America/Mexico_City`, después de la finalización del último partido. Si termina a las 22:00 o más tarde, la hora oficial pasa a las 22:00 del siguiente día local.
- **Estado del evento:** `[settled / cancelled]`
- **Boletos:** total `[…]`, abiertos `0`, pendientes `0`, terminales `[…]`.
- **Pagos pendientes:** `0`.
- **Resultado liquidado:** `[sí/no]`; `settlementComplete: [true/false]`.
- **Cancelación y devolución:** `[no aplicó / boletos anulados y cada stake reembolsado exactamente una vez, verificado contra el ledger]`.
- **Idempotencia:** `[reintento del sweep no duplicó crédito ni reembolso; referencia del chequeo interno]`.
- **Reset mensual:** `[hora del reset]`; el siguiente ciclo abrió `[fecha/hora]`, sin retraso; `[sí/no]`.
- **Puerta de promoción a todos:** `[no aprobada / aprobada]`; evidencia y aprobación adjuntas al reporte interno: `[…]`.

No usar solo logs repetidos para contar créditos: la operación contable idempotente/ledger es la fuente de verdad. Revisar de forma interna los importes y estados del store persistente; el endpoint agregado de salud no expone importes ni datos de identidad.

## 5. Reporte post-evento y mejoras

- **Resultados de operación (sweeps, errores y latencias):** `[…]`
- **Predicciones y liquidación (solo agregado; consistencia del ledger revisada):** `[…]`
- **Audio/accesibilidad:** `[…]`
- **Incidentes y resolución:** `[…]`
- **Comentarios recibidos, resumidos sin identidad:** `[…]`
- **Qué funcionó:** `[…]`
- **Qué mejorar en la siguiente edición:** `[…]`
- **Responsable, prioridad y edición objetivo de cada mejora:** `[…]`
- **Fecha de cierre del reporte:** `[…]`

## 6. Copia del aviso de la próxima edición

> **Balón de Oro MonteCristo · edición [MES AAAA].** Una temporada de 30 jornadas, 16 delanteros `ST` (uno por club) y una predicción por perfil con fichas 100 % virtuales. El resultado se determina por las estadísticas de juego y la posición final del club. Las predicciones cierran al liquidarse J20. Después del último partido, el resultado oficial y la liquidación se anuncian a las 10:00 p. m. de Ciudad de México; si el último partido termina a esa hora o después, se anuncian a las 10:00 p. m. del siguiente día local. Si la edición debe cancelarse antes de completarse, el stake se reembolsa. La inauguración dura aproximadamente 1 minuto 48 segundos; la ceremonia final dura unos 20–21 segundos según los nombres pronunciados. Ambas son comprensibles sin audio.

**Fecha aprobada para publicar:** `[FECHA]` · **Canales/página:** `[URL/ruta]` · **Aprobación:** `[referencia interna]`.
