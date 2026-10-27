# Informe de release — Balón de Oro MonteCristo, Fase 9

**Corte:** 27 de octubre de 2026

**Resultado:** preparación técnica y ensayo local completados. **No es informe de piloto real:** no se desplegó ni se habilitó el Estadio a jugadores, y la puerta de promoción global permanece cerrada.

## 1. Cambios entregados

- `render.yaml` fija `FOOTBALL_ENABLED=off` y almacena el estado del Estadio en `/var/data/football.json`, bajo el disco persistente `/var/data`.
- El snapshot de salud agrega estado y conteos de boletos, errores y latencias de sweeps (p95 sobre hasta 100 muestras) en `/healthz`. En producción se excluyen de logs los eventos individuales de boletos y se omiten importes de refund/payout; las notificaciones de cierre siguen llegando únicamente al perfil correspondiente, y el store privado conserva el ledger.
- La telemetría de audio solo acepta pista, resultado y mes del ciclo; usa endpoint same-origin, contadores agregados en memoria y límite global de 1.200 eventos/minuto. No recibe identidad, credenciales, selección, apuesta ni saldo.
- `tests/football-ballon-dor-release.test.js` prueba cierre J20, fin de J30, hora de anuncio, pago único, cancelación/reembolso idempotente y reset/apertura de siguiente mes. `npm run test:football-release` reúne estas, la UI de Estadio y las pruebas de configuración, telemetría y HTTP.
- Se añadieron un runbook con borrador de anuncio, esta plantilla reutilizable y el reporte de ensayo.

## 2. Ensayo determinista local

- Edición sintética: **2099-11**, reloj `America/Mexico_City`; no corresponde a una edición jugada por personas.
- **240/240** partidos regulares en 30 jornadas; el mercado queda bloqueado después de completar J20.
- **16** boletos sintéticos, uno por candidato; resultados determinados por el orden de clubes para asegurar un campeón único y un ganador.
- **33 sweeps**, sin errores; en la validación completa final el p95 fue **192,356 ms** y el máximo **280,037 ms**. Son mediciones puntuales de este runner local, no un SLO garantizado de producción.
- Anuncio exactamente a las **22:00 de `America/Mexico_City`**, posterior al último partido en el escenario. Se acreditó un pago una vez; un sweep repetido no generó otro crédito.
- En la rama de cancelación, el boleto quedó `void` y el stake de 100 fichas se devolvió una vez. La investigación encontró que cada sweep repetido volvía a emitir `football_ballon_dor_bet_refunded`, aunque la operación contable fuera idempotente. Se corrigió `refundBallonDorBets()` para registrar ese evento solo cuando efectivamente se aplica el reembolso; la regresión comprueba un solo log y un solo ID de operación tras dos sweeps.
- El reset cerró noviembre, abrió diciembre y activó la siguiente edición sin retrasar el reset del perfil.

El ensayo usa `FootballStore`/`ProfileStore` locales con escrituras del store de fixtures neutralizadas para evitar 240 escrituras síncronas. Las suites separadas del store cubren persistencia JSON y PostgreSQL con pool simulado. Esto **no** valida un disco persistente de hosting, una base PostgreSQL real, concurrencia distribuida entre varias réplicas ni latencias de red.

## 3. Verificaciones de producto y observabilidad

La cobertura comprueba el flag apagado por defecto, la ruta de persistencia del blueprint, telemetría HTTP same-origin, lista permitida de pista/resultado, rate limit y agregación sin campos personales. El harness UI intercepta las peticiones de telemetría antes de cargar assets y cubre inicio, finalización, bloqueo/error, ausencia de identidad y same-origin. La suite UI también comprueba que, tras completar la apertura, desaparecen el inicio/replay y no se reinicia con controles ocultos; el replay de la ceremonia final sigue separado. Para la ceremonia, valida los 16 avatares reutilizables, seis cues WAV, 16 clips de nombre asociados por `playerId`, el tema instrumental en bucle, el reveal en el comienzo del clip y la continuación con subtítulos si el audio falla. La suite UI dirigida pasó **42/42** pruebas. La vista de revisión local `/balon-de-oro?seasonMonth=2026-09&demo=1` muestra avisos explícitos de datos sintéticos en la página y las dos ceremonias; el resultado ficticio está aislado en `/tmp` y no se presenta como una edición real. `render.yaml` conserva `FOOTBALL_ENABLED=off`.

La validación final ejecutó `npm run test:football-release` (**77/77**, incluyendo UI), `npm run check` (0 errores; 5 warnings preexistentes; sintaxis válida en 169 archivos) y `npm test` (**357/357 unitarias y 174/174 de integración**, 0 fallos). La suite UI dirigida pasó **42/42**; `git diff --check` pasó. Los warnings restantes están en `public/app.js`, `server.js` y `tests/football-admin-guard.test.js`; el código agregado de Fase 9 no añade warnings.

La telemetría de audio informa reproducciones observadas, no personas únicas; se reinicia al reiniciar el proceso. El fallback visual, captions/transcripción y movimiento reducido siguen siendo los requisitos de accesibilidad aunque el audio esté bloqueado.

## 4. Estado del rollout y decisión

| Puerta | Estado | Evidencia / bloqueo |
| --- | --- | --- |
| Flag productivo apagado por defecto y store con ruta persistente | **Lista en código/configuración** | `render.yaml`; falta observar el despliegue real. |
| Ensayo completo y cancelación/reembolso | **Ensayo local** | Prueba determinista, no ciclo de staging. |
| Seguimiento durante una edición real | **Pendiente** | No hay staging productivo configurado/disponible en este workspace. |
| Conciliación del ledger tras cierre/cancelación real | **Pendiente** | Requiere una edición de staging y store persistente real. |
| Publicación de fecha y aviso al público | **Pendiente** | Copy listo en el runbook; no fijar fecha hasta autorizar un piloto desplegable. |
| Promoción para todos | **Bloqueada intencionalmente** | Mantener `FOOTBALL_ENABLED=off` hasta cerrar las puertas anteriores. |

No se ha configurado el servicio de hosting desde este workspace ni se dispone de `DATABASE_URL`, `psql` o un servidor PostgreSQL real. No se cambió una variable de producción, no se envió un despliegue y no se anuncia un piloto real. El flag apagado es la decisión segura.

## 5. Mejoras y pasos para cerrar la puerta real

1. Crear/confirmar un servicio de staging con almacenamiento persistente aislado y respaldo, perfilado de memoria y acceso operativo controlado.
2. Ejecutar las suites de release y UI, `npm run check` y suites completas en el commit candidato; si staging usa PostgreSQL, ejecutar migraciones y prueba de persistencia contra una instancia real.
3. Mantener staging activo durante un ciclo de calendario mensual completo. Revisar diariamente p95/máximo, errores, estados agregados de boletos y logs operativos; probar audio/accesibilidad en navegadores reales.
4. Conciliar apuestas, pagos y reembolsos contra el ledger persistido al terminar. Confirmar que cada operación tenga un único efecto, que no quede pago pendiente y que reset/apertura del mes siguiente ocurra en hora.
5. Registrar resultados en `docs/plantilla-edicion-balon-de-oro.md`, aprobar y publicar fecha/reglas/duración, y solo entonces valorar activar globalmente el flag mediante un cambio manual separado.

El ensayo prueba la propiedad técnica solicitada —un ciclo local completo se cierra/liquida una vez y no aplaza el siguiente reset—, pero **no autoriza el despliegue general** ni sustituye la observación de la primera temporada real.
