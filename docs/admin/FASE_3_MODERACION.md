# Fase 3 — Moderación

## Entrega 3.1: estado y persistencia (2026-10-01)

Implementado:

- Estado normalizado `active`, `suspended` o `banned` en cada perfil.
- Suspensiones permitidas de 1 h, 24 h, 7 d y 30 d.
- Baneos permanentes y desbaneos trazables mediante IDs de acción nuevos.
- Motivo obligatorio de 10–500 caracteres.
- Cada cambio incrementa `sessionVersion` para invalidar sesiones.
- Login verifica primero la contraseña y solo después informa la sanción, evitando filtrar el estado de cuentas a terceros.
- Suspensiones vencidas se reactivan automáticamente al autenticar.
- Migración `005_moderation_actions.sql` con índices de historial y acciones activas.

## Entrega 3.2: operaciones y expulsión (2026-10-01)

Implementado:

- Repositorios de acciones para memoria y PostgreSQL.
- Endpoints protegidos `suspend`, `ban` y `unban`.
- Historial por perfil en `GET /api/admin/v1/users/:id/moderation`.
- Jerarquía obligatoria y prohibición de autoacción.
- MFA reciente, permiso, origen y CSRF en cada escritura.
- Persistencia de acción y auditoría minimizada.
- Revocación de todas las sesiones del objetivo.
- Sala Socket.IO interna por cuenta y expulsión inmediata de todas sus conexiones.
- Notificación `account_moderated` antes de desconectar.
- Cierre ordenado del pool de moderación.

## Entrega 3.3: panel de usuarios (2026-10-01)

Implementado:

- Búsqueda limitada por username o nombre visible.
- Respuestas con lista permitida; nunca hashes, secretos ni datos económicos completos.
- Detalle de cuenta y hasta 100 acciones de moderación.
- Panel visual para suspender, banear y desbanear.
- Selector cerrado de duración y motivo obligatorio.
- Confirmación escribiendo exactamente `@usuario` antes de una sanción.
- Manejo de autenticación MFA reciente y errores de jerarquía.

## Estado de Fase 3

Funcionalidad completa. Antes del despliegue general queda ejecutar la prueba E2E de expulsión dentro de una mesa real con PostgreSQL temporal.
