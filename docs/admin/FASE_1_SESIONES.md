# Fase 1 — Sesiones seguras

## Entrega 1.1: fundamentos (2026-10-01)

Implementado:

- Token opaco de 32 bytes generado con `crypto.randomBytes`.
- Hash SHA-256 del token más pepper; el token en claro solo se devuelve al emitirlo.
- Identificador UUID independiente del perfil.
- Expiración inactiva y absoluta diferenciada para usuarios y personal.
- Validación de revocación, expiración y `sessionVersion`.
- Escrituras de actividad limitadas a una cada cinco minutos.
- Revocación individual y global por perfil.
- Store en memoria para pruebas/local y store PostgreSQL para producción.
- Migración versionada `001_account_sessions.sql`.
- Runner de migraciones con checksum, transacción y advisory lock.
- `ACCOUNT_SESSIONS_ENABLED` apagado por defecto y validación fail-closed.

## Entrega 1.2: API HTTP y perfil seguro (2026-10-01)

Implementado:

- Defaults persistentes `role: user` y `security.sessionVersion: 1`.
- Roles desconocidos degradan siempre a `user` al cargar.
- `security.mustChangePassword`, `passwordChangedAt` y estado MFA preparados.
- Factory de sesión: PostgreSQL en producción y memoria solo para pruebas explícitas.
- `POST /api/auth/login`: emite cookie opaca y ya no devuelve token en JSON.
- `GET /api/auth/session`: valida hash, expiración, revocación y versión.
- `POST /api/auth/logout`: revoca la sesión actual.
- `POST /api/auth/logout-all`: revoca todas las sesiones del perfil.
- Cookie `mc_session` con `HttpOnly`, `Secure`, `SameSite=Strict` y `Path=/`.
- Validación exacta de `Origin` en operaciones de escritura.
- `Cache-Control: no-store` en respuestas de autenticación.
- Cierre ordenado del pool de sesiones.

## Entrega 1.3: navegador y Socket.IO (2026-10-01)

Implementado:

- Middleware Socket.IO que resuelve la cookie durante el handshake.
- La ausencia o invalidez de cookie conserva el modo invitado, pero no concede identidad de cuenta.
- `profile_update` y `account_profile` ignoran `accountId` del cliente cuando las sesiones seguras están activas.
- El evento legado `account_login` queda bloqueado cuando el rollout seguro está activo.
- El navegador usa HTTP para login, validación y logout.
- El navegador reconecta Socket.IO después de crear o revocar una cookie.
- El registro crea inmediatamente la sesión HTTP segura.
- `localStorage` queda solo como caché visual; una respuesta 401 lo limpia.
- Compatibilidad temporal automática: únicamente un 404 del feature flag permite usar el flujo legado.
- `/healthz` informa si las sesiones están habilitadas.

## Entrega 1.4: contraseña, CSRF y fuerza bruta (2026-10-01)

Implementado:

- `POST /api/auth/change-password` exige contraseña actual, sesión y CSRF.
- Contraseñas nuevas de 10 a 128 caracteres, sin truncado silencioso.
- Rechazo de reutilización inmediata de la contraseña actual.
- Cambio incrementa `sessionVersion`, registra fecha y limpia bloqueos.
- Todas las sesiones anteriores se revocan y se emite una cookie rotada.
- Token CSRF derivado por HMAC y asociado al ID de sesión.
- Token CSRF vive solo en memoria del navegador, nunca en `localStorage`.
- Logout, logout global y cambio de contraseña exigen CSRF y origen exacto.
- Login limitado a 5 intentos/minuto tanto por IP como por cuenta.
- Respuesta 429 incluye `Retry-After`.
- Mapa del limitador acotado para impedir crecimiento de memoria por claves falsas.
- `trust proxy` se configura únicamente con el número validado de saltos.

## Entrega 1.5: interfaz y store PostgreSQL (2026-10-01)

Implementado:

- Formulario de cambio de contraseña dentro del perfil autenticado.
- Confirmación local, errores accesibles y autocompletado correcto.
- Rotación transparente de cookie/CSRF y reconexión de Socket.IO al terminar.
- Aviso explícito de cierre de las demás sesiones.
- Pruebas del store PostgreSQL: emisión, hash, consulta, mapeo, actividad y revocaciones.
- Segunda migración que elimina la FK de sesión/perfil para evitar una carrera con el guardado por snapshot; la existencia del perfil sigue validándose al resolver cada sesión.

Pendiente antes de cerrar Fase 1:

- E2E completo contra una instancia PostgreSQL de prueba durante el despliegue.
- Retirar definitivamente el código legado después de observar el despliegue gradual.

El desarrollo de Fase 1 queda funcionalmente completo; los dos puntos restantes son controles de despliegue y transición, no deben simularse contra producción.

## Activación

No activar todavía en producción. Cuando se integre el servicio serán obligatorios:

```text
ACCOUNT_SESSIONS_ENABLED=true
DATABASE_URL=...
APP_ORIGIN=https://dominio-real
SESSION_PEPPER=<mínimo 32 bytes Base64>
```

Generar el pepper con `openssl rand -base64 32`. No guardarlo en Git.
