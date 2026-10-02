# Estado del plan administrativo

Fecha de corte: 2026-10-01.

| Fase | Estado | Resultado |
|---|---|---|
| 0. Preparación y pruebas base | Completa | Línea base, scripts, lint y pruebas reconstruidos. |
| 1. Sesiones seguras | Completa | Cookies opacas, hash, expiración, revocación y versión. |
| 2. Roles, permisos y MFA | Completa | RBAC, bootstrap, TOTP, recuperación y MFA reciente. |
| 3. Moderación | Completa en código | Sanciones persistentes, transacción, revocación y expulsión. |
| 4. Reportes y evidencia | Completa | Recepción, evidencia servidor, cola, seguimiento y retención. |
| 5. Restablecimiento | Completa | Desafíos de un uso, 15 minutos, revocación y auditoría. |
| 6. Endurecimiento | Completa en código | Auditoría, cabeceras, redacción, idempotencia y transacciones. |
| 7. Despliegue gradual | Preparada, no ejecutada | Runbooks y preflight listos; falta staging/producción real. |

**Conteo por fases:** 7 de 8 completadas (87.5%); 1 de 8 pendiente de ejecución (12.5%).

La integración con PostgreSQL 16 efímero queda automatizada en CI. La fase restante no consiste en añadir funciones de negocio: requiere staging/producción, backup/restauración, recorridos E2E, activación por flags y observación durante 48 horas. Sin completar esos controles no debe marcarse como terminada.
