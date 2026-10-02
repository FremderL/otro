# Fase 4 — Reportes y evidencia

## Entrega 4.1: dominio y esquema (2026-10-01)

Implementado:

- Categorías cerradas: acoso, odio, amenaza, spam, suplantación, trampas, comercio de cuentas y otros.
- Estados `open`, `triaged`, `investigating`, `resolved`, `rejected`.
- Prioridades `low`, `normal`, `high`, `urgent`.
- Descripción obligatoria de 10–1000 caracteres.
- Resolución explicada obligatoriamente.
- Control de concurrencia optimista mediante `version`.
- Store en memoria para pruebas y snapshots inmutables de evidencia.
- Migración `006_reports_and_evidence.sql` con tablas e índices de cola, objetivo y evidencia.

## Entrega 4.2: persistencia y recepción (2026-10-01)

Implementado:

- Store PostgreSQL y factory con cierre ordenado.
- `POST /api/reports` para cuentas autenticadas.
- Origen exacto, CSRF y límite de 3 reportes cada 10 minutos por cuenta.
- Búsqueda del objetivo por username; se impide auto-reporte.
- Referencias opcionales a mensajes: el servidor busca el mensaje real y captura autor, texto y fecha; no acepta evidencia arbitraria del cliente.
- Consultas parametrizadas y actualización con control de versión.

## Entrega 4.3: bandeja administrativa (2026-10-01)

Implementado:

- Lista de reportes por estado y antigüedad.
- Detalle con evidencia persistida.
- Actualización de estado, prioridad, asignación y resolución.
- Conflicto HTTP 409 cuando otro miembro del personal modificó la misma versión.
- Auditoría de cada actualización.
- Bandeja visual en `/admin` para clasificar, investigar, resolver o rechazar.

## Entrega 4.4: seguimiento para usuarios (2026-10-01)

Implementado:

- `GET /api/reports/mine` autenticado y sin caché.
- Lista limitada a los reportes creados por la cuenta actual.
- Solo expone folio, categoría, estado y fechas; nunca resolución interna, moderador ni sanción.
- Sección “Mis reportes” dentro del modal con estados traducidos para el usuario.

## Entrega 4.5: retención y limpieza (2026-10-01)

- Política documentada en `docs/admin/RETENCION_Y_PRIVACIDAD.md`.
- Limpieza PostgreSQL segura, en lotes, con advisory lock, métricas sin datos personales y auditoría de sistema.
- Modo de inspección por defecto; la eliminación exige `--execute`.
- Reportes abiertos quedan fuera de la limpieza y la evidencia se elimina en cascada solo con reportes cerrados vencidos.

## Entrega 4.6: reportes limitados de invitados (2026-10-01)

Disponible únicamente con `REPORT_GUEST_ENABLED=true`:

- Los invitados solo pueden reportar un mensaje visible y atribuible a una cuenta registrada; no pueden crear denuncias generales.
- El identificador UUID local se transforma mediante HMAC-SHA-256 con separación de dominio y nunca se persiste en claro.
- Límite antiabuso simultáneo por hash de dispositivo y hash de IP; mismo origen obligatorio.
- El servidor recupera la evidencia y valida autor, username y mensaje.
- Los invitados reciben folio, pero no acceso a “Mis reportes”; el seguimiento requiere una cuenta.

Fase 4 funcionalmente completa. Antes de habilitar invitados en producción se debe aceptar explícitamente el riesgo residual de que almacenamiento local sea borrado o regenerado.

## Verificación HTTP de cierre (2026-10-01)

La suite de integración cubre ahora creación autenticada, origen exacto, CSRF, evidencia incorrecta, aislamiento y minimización de “Mis reportes”, flujo limitado de invitados, límite antiabuso, lectura administrativa, evidencia, actualización auditada y conflicto optimista 409.
