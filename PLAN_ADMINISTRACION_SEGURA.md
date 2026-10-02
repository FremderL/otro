# Plan completo: administración, moderación, reportes y recuperación de cuentas

**Proyecto:** Montecristo Social Casino  
**Fecha del plan:** 1 de octubre de 2026  
**Estado:** Propuesta lista para ejecución  
**Prioridad:** Seguridad antes que velocidad de entrega

---

## 1. Objetivo

Incorporar un sistema administrativo que permita:

1. Autenticar cuentas con sesiones seguras.
2. Crear y administrar roles (`user`, `moderator`, `admin`).
3. Suspender y banear cuentas, expulsándolas en tiempo real.
4. Recibir, clasificar, investigar y resolver reportes de usuarios.
5. Restablecer contraseñas sin conocer ni exponer la contraseña anterior.
6. Registrar toda acción sensible en una bitácora de auditoría.
7. Mantener el modo invitado actual sin darle privilegios administrativos.
8. Funcionar con PostgreSQL en producción y conservar un modo local compatible para desarrollo/pruebas.

## 2. Decisiones obligatorias de seguridad

Estas decisiones se consideran parte del alcance y no deberán omitirse para acelerar el lanzamiento:

- El panel administrativo **solo funcionará sobre HTTPS** en producción.
- Ninguna autorización dependerá de ocultar botones en el navegador.
- Cada acción se autorizará nuevamente en el servidor.
- El `profile.id`/token de dispositivo actual no servirá como sesión de cuenta ni como credencial administrativa.
- Las sesiones usarán tokens aleatorios opacos; en la base solo se guardará su hash.
- El token de sesión viajará en cookie `HttpOnly`, `Secure` en producción y `SameSite=Strict` para administración.
- No se guardarán ni mostrarán contraseñas en texto plano.
- Un administrador podrá iniciar un restablecimiento, pero no descubrir la contraseña existente.
- Todo baneo, desbaneo, cambio de rol y restablecimiento quedará auditado.
- Los reportes y la auditoría deberán persistirse en PostgreSQL en producción.
- La primera cuenta administradora se promoverá mediante CLI ejecutada en el servidor, no mediante una ruta web pública ni una variable que contenga una contraseña.
- Nunca se registrarán en logs contraseñas, cookies, tokens completos ni hashes de contraseña.

---

## 3. Diagnóstico del sistema actual

### Fortalezas aprovechables

- `BaseProfileStore` concentra la lógica común de perfiles.
- Existen backends JSON y PostgreSQL.
- Las contraseñas usan `crypto.scrypt` con sal aleatoria.
- `publicProgress()` construye una lista explícita y no entrega `passwordHash`.
- Existe protección básica contra intentos fallidos de login.
- Socket.IO permite expulsar o actualizar usuarios conectados inmediatamente.
- Ya existe logging estructurado y una suite amplia de smoke tests declarada.
- `deleteProfile()` y comentarios del código anticipan un panel administrativo.

### Riesgos que deben resolverse primero

1. El login devuelve el `profile.id` como token y el cliente lo adopta como identificador del dispositivo.
2. Algunos flujos aceptan identificadores aportados por el cliente; eso no es suficiente para autorización sensible.
3. No existe una sesión de cuenta revocable del lado del servidor.
4. No existe segundo factor para administradores.
5. Los mensajes del chat viven principalmente en memoria; la evidencia puede desaparecer.
6. Los perfiles PostgreSQL están guardados como JSONB, pero reportes, sesiones y auditoría requieren entidades propias consultables.
7. El bloqueo de login es por cuenta, lo cual puede permitir que terceros provoquen bloqueo de una víctima. Debe complementarse con límites por IP y no convertirse en bloqueo prolongado de cuenta.

**Regla de ejecución:** no comenzar el panel ni los endpoints de moderación antes de completar la nueva sesión segura.

---

## 4. Arquitectura objetivo

### 4.1 Capas

1. **Identidad de invitado:** token local actual, únicamente para continuidad de un perfil invitado. No concede roles.
2. **Cuenta autenticada:** cookie de sesión opaca validada por el servidor.
3. **Autorización:** permisos calculados desde el rol vigente en base de datos, nunca desde datos del cliente.
4. **Administración HTTP:** API bajo `/api/admin/*`, consumida por `/admin`.
5. **Operaciones en tiempo real:** Socket.IO se usará para expulsiones y actualizaciones, pero la acción administrativa se origina en la API autenticada.
6. **Persistencia:** perfiles existentes más tablas dedicadas para sesiones, reportes, evidencia y auditoría.

### 4.2 Roles y permisos

| Capacidad | Invitado | Usuario | Moderador | Admin |
|---|---:|---:|---:|---:|
| Jugar y usar chat | Sí | Sí | Sí | Sí |
| Crear reporte | Sí, limitado | Sí | Sí | Sí |
| Ver reportes asignados | No | No | Sí | Sí |
| Resolver/rechazar reporte | No | No | Sí | Sí |
| Suspender temporalmente | No | No | Sí | Sí |
| Baneo permanente | No | No | No | Sí |
| Restablecer contraseña | No | No | No | Sí |
| Cambiar roles | No | No | No | Sí |
| Ver auditoría completa | No | No | No | Sí |

Los permisos se centralizarán en código (`PERMISSIONS` y `requirePermission`) para evitar condicionales dispersos.

### 4.3 Separación del panel

- Ruta estática: `/admin`.
- API: `/api/admin/v1/...`.
- El HTML puede ser servido públicamente, pero sin sesión no devolverá información y redirigirá al login.
- Aplicar `Cache-Control: no-store` a HTML y respuestas administrativas.
- Política CSP estricta; JavaScript y CSS propios, sin scripts inline ni CDN.
- `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

---

## 5. Modelo de datos

### 5.1 Campos nuevos del perfil

Añadir y sanear en `cleanProfile()`:

```js
role: 'user', // user | moderator | admin
moderation: {
  status: 'active', // active | suspended | banned
  reason: null,
  until: null,
  actionId: null,
  updatedAt: null
},
security: {
  sessionVersion: 1,
  mustChangePassword: false,
  passwordChangedAt: null,
  mfaEnabled: false,
  mfaSecretEncrypted: null,
  recoveryCodeHashes: []
}
```

Compatibilidad: perfiles anteriores reciben valores seguros por defecto. Valores de rol desconocidos se degradan a `user`, nunca a `admin`.

### 5.2 Tablas PostgreSQL nuevas

Crear una migración versionada, no depender solo de `CREATE TABLE IF NOT EXISTS` dentro del arranque.

#### `montecristo_account_sessions`

- `id UUID PRIMARY KEY`
- `profile_id TEXT NOT NULL`
- `token_hash BYTEA UNIQUE NOT NULL`
- `session_version INTEGER NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `last_seen_at TIMESTAMPTZ NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `revoked_at TIMESTAMPTZ NULL`
- `revoke_reason TEXT NULL`
- `ip_hash BYTEA NULL`
- `user_agent_hash BYTEA NULL`

Índices por `profile_id`, `expires_at` y sesiones activas. Nunca guardar token en claro.

#### `montecristo_reports`

- `id UUID PRIMARY KEY`
- `reporter_profile_id TEXT NULL` (invitado puede ser nulo)
- `reporter_device_hash BYTEA NULL`
- `reported_profile_id TEXT NOT NULL`
- `category TEXT NOT NULL`
- `description TEXT NOT NULL`
- `status TEXT NOT NULL`
- `priority TEXT NOT NULL`
- `assigned_to TEXT NULL`
- `resolution TEXT NULL`
- `created_at`, `updated_at`, `resolved_at`
- `version INTEGER NOT NULL DEFAULT 1` para control de concurrencia

Categorías iniciales: `harassment`, `hate`, `threat`, `spam`, `impersonation`, `cheating`, `account_trade`, `other`.

Estados: `open`, `triaged`, `investigating`, `resolved`, `rejected`.

#### `montecristo_report_evidence`

- `id UUID PRIMARY KEY`
- `report_id UUID NOT NULL`
- `type TEXT NOT NULL`
- `snapshot JSONB NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`

La evidencia será una copia inmutable y minimizada del mensaje/evento: ID, autor, texto, sala, fecha y contexto limitado. No guardar información innecesaria.

#### `montecristo_moderation_actions`

- `id UUID PRIMARY KEY`
- `target_profile_id TEXT NOT NULL`
- `actor_profile_id TEXT NOT NULL`
- `report_id UUID NULL`
- `type TEXT NOT NULL`
- `reason TEXT NOT NULL`
- `starts_at TIMESTAMPTZ NOT NULL`
- `ends_at TIMESTAMPTZ NULL`
- `revoked_at TIMESTAMPTZ NULL`
- `revoked_by TEXT NULL`
- `revoke_reason TEXT NULL`
- `metadata JSONB NOT NULL DEFAULT '{}'`

Tipos: `warning`, `suspension`, `ban`, `unban`, `chat_mute` (reservado para futuro).

#### `montecristo_audit_log`

- `id UUID PRIMARY KEY`
- `actor_profile_id TEXT NULL` (`system` mediante campo adicional)
- `actor_role TEXT NOT NULL`
- `action TEXT NOT NULL`
- `target_type TEXT NOT NULL`
- `target_id TEXT NULL`
- `request_id UUID NOT NULL`
- `ip_hash BYTEA NULL`
- `before_data JSONB NULL`
- `after_data JSONB NULL`
- `reason TEXT NULL`
- `created_at TIMESTAMPTZ NOT NULL`

Esta tabla será de solo inserción desde la aplicación. No se expondrá un endpoint para modificar o borrar registros.

#### `montecristo_password_reset_challenges`

- `id UUID PRIMARY KEY`
- `profile_id TEXT NOT NULL`
- `token_hash BYTEA UNIQUE NOT NULL`
- `created_by TEXT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `used_at TIMESTAMPTZ NULL`
- `revoked_at TIMESTAMPTZ NULL`

El token en claro se muestra una sola vez al admin para entregar por un canal acordado. Vigencia recomendada: 30 minutos. Un solo uso.

### 5.3 Desarrollo local

Implementar repositorios detrás de interfaces (`SessionStore`, `ReportStore`, `AuditStore`). Producción exige PostgreSQL. Para tests/local se usarán stores en memoria; no ampliar `profiles.json` con colecciones de auditoría sensibles.

---

## 6. Autenticación y sesiones

### 6.1 Token de sesión

- Generar 32 bytes con `crypto.randomBytes(32)`.
- Codificar Base64URL.
- Guardar `SHA-256(token + SESSION_PEPPER)` en base.
- Cookie de usuario: `mc_session`.
- Cookie administrativa: puede ser la misma sesión, pero al entrar al panel se exigirá elevación reciente y MFA. Guardar el instante de elevación del lado servidor.
- Rotar token después de login, cambio de contraseña, cambio de rol y verificación MFA.

### 6.2 Cookies

Producción:

```text
HttpOnly
Secure
SameSite=Strict (panel y API admin)
Path=/
Max-Age limitado
```

Para la cuenta general, evaluar `Lax` solo si un flujo real lo necesita. No usar almacenamiento local para sesiones autenticadas.

### 6.3 Duración

- Usuario normal: 7 días de inactividad, 30 días absolutos.
- Admin/moderador: 30 minutos de inactividad, 8 horas absolutas.
- Operaciones críticas: exigir autenticación reciente (máximo 10 minutos) y MFA.
- Actualizar `last_seen_at` como máximo una vez cada 5 minutos para reducir escrituras.

### 6.4 Contraseña

Conservar `scrypt`, pero versionar el formato:

```text
scrypt$v=1$N=...$r=...$p=...$salt$hash
```

- Mínimo recomendado: 12 caracteres para nuevas contraseñas administrativas y 10 para usuarios.
- Máximo: 128 caracteres; no truncar silenciosamente. Si se mantiene límite técnico de 72, rechazar claramente en vez de truncar.
- Permitir gestores de contraseñas y pegar texto.
- Comparación en tiempo constante.
- Rehash automático al iniciar sesión si cambian parámetros.
- Mantener mensajes genéricos para usuario inexistente/contraseña incorrecta.

### 6.5 Limitación de intentos

Aplicar token bucket en dos dimensiones:

- Por IP normalizada/hasheada.
- Por nombre de usuario normalizado.

Límites iniciales:

- Login: 5 intentos/minuto por IP y 5 por cuenta; escalamiento progresivo corto.
- MFA: 5 intentos/10 minutos.
- Reportes: 3/10 minutos por cuenta o dispositivo; 10/día.
- API admin: 60 lecturas/minuto y 20 escrituras/minuto por sesión.

No confiar en `X-Forwarded-For` salvo que Express esté configurado con el número exacto de proxies de Render.

### 6.6 MFA obligatorio para personal

Usar TOTP compatible con aplicaciones autenticadoras:

- MFA obligatorio antes de ejercer permisos `moderator` o `admin`.
- Secreto cifrado en reposo con AES-256-GCM y una clave `MFA_ENCRYPTION_KEY` externa a la base.
- Mostrar QR una sola vez durante enrolamiento.
- Generar 10 códigos de recuperación, guardar únicamente hashes y consumirlos una vez.
- Cambio de rol a personal deja la cuenta en estado “pendiente de enrolamiento”; no concede acceso administrativo hasta completar MFA.
- Restablecer MFA requiere otro admin y auditoría. Si solo existe un admin, usar procedimiento CLI de emergencia.

---

## 7. Autorización

Crear middleware reutilizable:

```js
requireSession
requireActiveAccount
requireRole(...roles)
requirePermission(permission)
requireRecentAuth
requireMfa
```

Orden recomendado:

1. Resolver sesión desde cookie.
2. Verificar hash, expiración, revocación y `sessionVersion`.
3. Cargar perfil vigente.
4. Verificar estado de moderación.
5. Calcular permisos desde el rol guardado.
6. Exigir autenticación reciente/MFA cuando corresponda.
7. Ejecutar acción y auditoría en la misma transacción.

Reglas especiales:

- Un moderador no actúa sobre administradores ni otros moderadores.
- Un admin no puede banearse, degradarse ni revocarse su propio MFA desde el panel.
- Nunca puede quedar cero administradores activos.
- Cambiar roles, banear permanentemente, resetear MFA y emitir un reset de contraseña requieren motivo.
- Para acciones irreversibles o de alto impacto, pedir confirmación escribiendo el nombre de usuario.

---

## 8. API propuesta

Todas las respuestas usarán JSON, IDs opacos, `requestId` y errores sin datos internos.

### 8.1 Cuenta y sesión

- `POST /api/auth/login`
- `POST /api/auth/mfa/verify`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`
- `GET /api/auth/session`
- `POST /api/auth/change-password`
- `POST /api/auth/reset/complete`

### 8.2 Reportes de usuario

- `POST /api/reports`
- `GET /api/reports/mine` (solo cuentas autenticadas)

Payload de creación limitado a categoría, usuario reportado, descripción y referencia validable a mensaje/evento. El servidor obtiene la evidencia real; no confiar en una “captura” JSON enviada por el cliente.

### 8.3 Administración

- `GET /api/admin/v1/me`
- `GET /api/admin/v1/users?query=&status=&role=&cursor=`
- `GET /api/admin/v1/users/:id`
- `GET /api/admin/v1/users/:id/moderation`
- `POST /api/admin/v1/users/:id/suspend`
- `POST /api/admin/v1/users/:id/ban`
- `POST /api/admin/v1/users/:id/unban`
- `POST /api/admin/v1/users/:id/password-reset`
- `POST /api/admin/v1/users/:id/revoke-sessions`
- `POST /api/admin/v1/users/:id/role`
- `GET /api/admin/v1/reports?...`
- `GET /api/admin/v1/reports/:id`
- `PATCH /api/admin/v1/reports/:id`
- `POST /api/admin/v1/reports/:id/resolve`
- `GET /api/admin/v1/audit?...`

Usar paginación por cursor, límites máximos y listas permitidas de orden/filtros. Evitar búsquedas que devuelvan todos los perfiles.

### 8.4 CSRF y origen

Aunque `SameSite` ayuda, las escrituras deberán verificar:

- `Origin` exactamente igual al origen configurado.
- Token CSRF asociado a sesión para formularios administrativos.
- Método y `Content-Type: application/json`.

No habilitar CORS abierto para `/api/admin`. Socket.IO actual puede mantener su configuración para juego solo después de revisar orígenes; administración no viajará por eventos públicos sin protección.

---

## 9. Flujos funcionales

### 9.1 Crear el primer administrador

Implementar:

```bash
npm run admin:promote -- --username nombre
```

Condiciones:

1. Requiere acceso al entorno del servidor y `DATABASE_URL`.
2. La cuenta ya debe existir y tener contraseña.
3. Solicita confirmación interactiva.
4. Cambia rol, incrementa `sessionVersion`, revoca sesiones y crea auditoría de sistema.
5. En el siguiente login obliga a enrolar MFA.
6. Nunca acepta una contraseña como argumento de línea de comandos.

Agregar también `admin:demote`, con protección de último administrador.

### 9.2 Suspensión temporal

1. Moderador abre usuario.
2. Selecciona duración permitida: 1 h, 24 h, 7 d, 30 d o fecha limitada.
3. Escribe motivo interno obligatorio y opcionalmente mensaje visible.
4. Servidor bloquea acción si el objetivo tiene igual/mayor jerarquía.
5. En transacción: crea acción, actualiza estado, incrementa versión de sesión, revoca sesiones y audita.
6. Socket.IO localiza todas las conexiones del perfil, envía `account_suspended` y desconecta.
7. En siguiente acceso se informa estado y fecha de término sin revelar notas internas.
8. Un barrido periódico reactiva suspensiones expiradas o la comprobación se hace al autenticar; la fuente de verdad es `until`.

### 9.3 Baneo permanente

Mismo flujo, reservado a admin, sin `ends_at`. No borrar datos automáticamente. La eliminación por privacidad/retención es un proceso separado.

### 9.4 Desbaneo

Crear una nueva acción de revocación; no eliminar ni editar la acción original. Exigir motivo y auditar antes/después.

### 9.5 Reportar usuario o mensaje

1. Botón “Reportar” en perfil/mensaje.
2. Modal con categoría, descripción y aviso contra abuso.
3. Cliente manda referencia del mensaje, no evidencia arbitraria.
4. Servidor valida que el mensaje/evento existe en un buffer de evidencia y captura snapshot.
5. Deduplicar el mismo reportante/objetivo/mensaje en una ventana corta.
6. Acusar recibo con ID sin compartir sanciones privadas posteriores.
7. Administrador clasifica, asigna, investiga y resuelve.
8. Resolver un reporte y sancionar son acciones relacionadas pero distintas; ambas quedan auditadas.

### 9.6 Restablecimiento de contraseña por admin

Recomendación principal: **enlace/token de un solo uso**, no contraseña temporal elegida por el admin.

1. Admin confirma identidad del solicitante por el procedimiento operativo definido fuera del sistema.
2. Admin solicita reset e introduce motivo/ticket.
3. Servidor genera token aleatorio de 32 bytes, guarda hash y expiración de 30 minutos.
4. Revoca desafíos anteriores, incrementa `sessionVersion` y revoca sesiones activas.
5. El token en claro aparece una sola vez para entrega por canal seguro.
6. Usuario abre `/restablecer?token=...`, establece contraseña nueva y se consume el desafío atómicamente.
7. Se revocan nuevamente las demás sesiones y se registra auditoría sin guardar la contraseña ni el token.
8. La página no carga analítica, recursos externos ni guarda referrer.

Hasta disponer de correo verificado, el equipo debe documentar cómo comprueba la propiedad de una cuenta. Un admin no debe resetear cuentas únicamente porque alguien conozca el nombre visible.

### 9.7 Cambio voluntario de contraseña

- Exige sesión activa, contraseña actual y, para personal, MFA.
- Cambia hash, incrementa `sessionVersion` y revoca todas las demás sesiones.
- Mantiene únicamente una sesión rotada del dispositivo actual.
- Envía confirmación dentro de la aplicación; cuando exista correo verificado, también por correo.

---

## 10. Panel administrativo

### Vistas mínimas

1. **Inicio:** reportes abiertos, suspensiones activas, actividad reciente.
2. **Usuarios:** búsqueda exacta/parcial por username y filtros por estado/rol.
3. **Detalle de usuario:** identidad pública, estado, historial de moderación, sesiones (solo metadatos), reportes asociados y acciones permitidas.
4. **Reportes:** bandeja, asignación, prioridad, evidencia y resolución.
5. **Auditoría:** filtros por actor, acción, objetivo y fecha.
6. **Seguridad propia:** MFA, sesiones activas, códigos de recuperación y cambio de contraseña.

### Reglas de interfaz

- Mostrar siempre el usuario objetivo y la acción en el diálogo de confirmación.
- Motivo obligatorio con 10–500 caracteres para sanciones/reset/roles.
- No incluir hashes, tokens, dirección IP completa ni secretos.
- Fechas absolutas y relativas, mostrando zona horaria.
- Estados accesibles por texto e icono, no solo color.
- Deshabilitar doble envío y usar claves de idempotencia en acciones críticas.
- No hacer actualizaciones optimistas para sanciones: esperar confirmación del servidor.

---

## 11. Integración con Socket.IO

Al conectar:

1. Leer la sesión desde cookies del handshake.
2. Asociar `socket.data.accountProfileId` tras validación del servidor.
3. El token de dispositivo puede identificar invitados, pero no sustituye la sesión.
4. Antes de cada evento que modifique juego/chat/perfil, comprobar que la cuenta no está suspendida o baneada.
5. Unirse a una sala interna `account:<profileId>` para expulsar todas las conexiones.
6. Tras sanción: emitir evento informativo, retirar de salas aplicando las reglas de juego existentes y desconectar.

Crear un middleware Socket.IO central para evitar repetir autorización en decenas de handlers. Mantener comprobaciones específicas en operaciones económicas.

---

## 12. Auditoría, privacidad y retención

### Eventos auditables mínimos

- Login administrativo exitoso/fallido (sin contraseña).
- Enrolamiento, uso y reset de MFA.
- Promoción/degradación de rol.
- Suspensión, baneo, desbaneo y expulsión.
- Lectura de evidencia sensible.
- Creación y consumo de reset de contraseña.
- Revocación de sesiones.
- Exportaciones administrativas.

### Minimización

- Hash de IP con `AUDIT_IP_PEPPER` rotatable; no IP completa salvo necesidad legal explícita.
- User-Agent reducido o hasheado.
- En `before_data`/`after_data`, lista permitida de campos; jamás serializar el perfil completo.
- Escapar cualquier contenido generado por usuarios al renderizar.

### Retención inicial recomendada

- Sesiones revocadas/expiradas: 90 días.
- Reportes y evidencia: 12 meses desde resolución.
- Auditoría administrativa: 24 meses.
- Mensajes no reportados en buffer: 7 días o menos.
- Revisar estas cifras con asesoría legal y política de privacidad aplicable en México antes de producción.

Crear trabajos de limpieza con métricas y auditoría de sistema. Un baneo no equivale a consentimiento para conservar datos indefinidamente.

---

## 13. Dependencias y configuración

### Dependencias sugeridas

Preferir biblioteca pequeña y mantenida para:

- TOTP y generación QR.
- Cookies (si Express no se maneja directamente).
- Validación de esquemas de entrada.

Antes de agregar paquetes: revisar mantenimiento, vulnerabilidades, tamaño y licencia. La criptografía de sesión, hash y cifrado puede usar `node:crypto`; no implementar primitivas propias.

### Variables de entorno

- `SESSION_PEPPER` (mínimo 32 bytes aleatorios)
- `MFA_ENCRYPTION_KEY` (32 bytes)
- `AUDIT_IP_PEPPER`
- `APP_ORIGIN=https://dominio-real`
- `TRUST_PROXY_HOPS=1` (confirmar topología de Render)
- `ADMIN_FEATURE_ENABLED=false` durante despliegue inicial

Validarlas al arranque. En producción, faltar una clave debe impedir habilitar administración; no usar valores predeterminados inseguros. Documentar rotación y recuperación.

---

## 14. Estrategia de implementación por fases

### Fase 0 — Preparación y pruebas base (0.5–1 día)

- Verificar que todos los archivos de pruebas declarados en `package.json` estén presentes en el checkout.
- Ejecutar y registrar `npm test` antes de cambios.
- Documentar flujos actuales de login, invitado y reconexión.
- Añadir feature flag y formato de migraciones.
- Crear modelo de amenazas breve y checklist de revisión.

**Salida:** línea base verde y plan de rollback.

### Fase 1 — Sesiones seguras de cuenta (2–3 días)

- Implementar store y tabla de sesiones.
- Migrar login/logout/cambio de contraseña a cookie opaca.
- Separar identidad invitada de cuenta autenticada.
- Añadir middleware HTTP y Socket.IO.
- Revocación, rotación, expiración y límites de login.
- Mantener compatibilidad temporal con clientes previos solo para juego invitado, nunca para administración.

**Criterio de salida:** conocer un `profile.id` no permite adoptar una cuenta ni obtener privilegios.

### Fase 2 — Roles, permisos, MFA y bootstrap (2–3 días)

- Campos de rol/security.
- Matriz central de permisos.
- CLI de promoción/degradación.
- TOTP, recuperación y autenticación reciente.
- Protecciones de último admin y autoacción.
- Tests de escalamiento horizontal/vertical de privilegios.

**Criterio de salida:** solo personal con sesión, rol vigente y MFA puede acceder a API admin.

### Fase 3 — Moderación y expulsión en tiempo real (2–3 días)

- Tablas y repositorio de acciones.
- Suspensión, baneo y desbaneo transaccionales.
- Revocación de sesiones y desconexión Socket.IO.
- Mensajes seguros para cuentas sancionadas.
- Vista de búsqueda/detalle de usuario.

**Criterio de salida:** la sanción se aplica a todas las conexiones y sobrevive reinicios.

### Fase 4 — Reportes y evidencia (3–4 días)

- Entidades, API y límites antiabuso.
- Buffer persistente mínimo de mensajes/eventos referenciables.
- Flujo de reporte en cliente.
- Bandeja, asignación, estados, resolución y concurrencia optimista.
- Política de retención y limpieza.

**Criterio de salida:** un reporte conserva evidencia auténtica y tiene trazabilidad completa.

### Fase 5 — Restablecimiento de contraseña (1–2 días)

- Desafíos de un uso.
- Pantalla pública segura para establecer nueva contraseña.
- Revocación global de sesiones.
- Operación administrativa con autenticación reciente y MFA.
- Runbook de verificación de identidad.

**Criterio de salida:** el admin no conoce la contraseña y un token usado/expirado no funciona.

### Fase 6 — Auditoría y endurecimiento (2–3 días)

- Bitácora append-only para todas las acciones.
- CSP, cabeceras, CSRF, validación y redacción de logs.
- Idempotencia y transacciones.
- Limpieza de datos y métricas.
- Pruebas de abuso, concurrencia y recuperación.

### Fase 7 — Despliegue gradual (1–2 días)

1. Ejecutar migraciones con backup.
2. Desplegar código con feature flag apagado.
3. Probar sesiones de usuarios en producción.
4. Crear/promover primer admin por CLI.
5. Enrolar MFA y comprobar auditoría.
6. Habilitar panel solo para admin inicial.
7. Activar moderación; después reportes; finalmente resets.
8. Vigilar métricas y logs durante 48 horas.

**Estimación total:** 13–20 días de ingeniería, incluyendo pruebas y documentación. No incluye revisión legal externa ni integración de correo.

---

## 15. Plan de pruebas

### Unitarias

- Normalización segura de roles y estados.
- Hash/verificación de tokens.
- Expiración y revocación.
- Matriz de permisos.
- Cálculo de suspensión activa/expirada.
- Generación/consumo único de desafíos.
- Redacción de auditoría.

### Integración

- Login crea cookie y la base solo recibe hash.
- Logout y cambio de contraseña invalidan sesiones.
- Cambiar rol invalida permisos inmediatamente.
- Moderador no puede banear admin/moderador.
- Admin no puede eliminar último admin ni actuar sobre sí mismo en operaciones bloqueadas.
- Sanción y auditoría se confirman o revierten juntas.
- Dos admins editando el mismo reporte reciben conflicto `409` por versión.
- Reset concurrente solo consume un token una vez.
- Fallo de Postgres no deja sanción en memoria sin persistencia confirmada.

### Seguridad

- IDOR: cambiar IDs no revela ni modifica otro recurso.
- CSRF con origen externo falla.
- XSS almacenado en reportes, motivos, nombres y mensajes queda escapado.
- Inyección SQL bloqueada por parámetros.
- Sesión falsificada, expirada, revocada o con versión antigua falla.
- Reutilización/fijación de sesión falla tras login y elevación.
- Escalamiento enviando `role: admin` en payload no funciona.
- Enumeración de usuarios por login no produce diferencias útiles.
- Rate limits funcionan detrás del proxy configurado.
- Cookies no son legibles desde JavaScript.
- Datos administrativos no quedan en caché.

### End-to-end

1. Usuario reporta mensaje → moderador investiga → suspende → usuario es expulsado → admin revierte.
2. Admin genera reset → usuario cambia contraseña → sesiones viejas fallan → nueva sesión funciona.
3. Admin pierde MFA → recuperación controlada → códigos anteriores quedan inválidos.
4. Reinicio de servidor conserva sanciones, reportes, sesiones y auditoría.
5. Modo invitado continúa funcionando sin acceso a endpoints de cuenta/admin.

### Rendimiento

- Listas siempre paginadas.
- Índices comprobados con `EXPLAIN ANALYZE`.
- 100 sesiones concurrentes y ráfaga de reportes sin bloquear el loop de Node.
- La verificación de sesión no reescribe base en cada evento Socket.IO.

---

## 16. Observabilidad

Métricas mínimas, sin datos personales:

- Logins exitosos/fallidos y bloqueados.
- Sesiones activas/revocadas.
- Reportes abiertos y antigüedad del más antiguo.
- Sanciones por tipo.
- Fallos de API admin por código.
- Latencia p50/p95/p99 de API admin.
- Errores de persistencia y expulsión Socket.IO.
- Intentos de autorización denegados.

Alertas:

- Múltiples fallos MFA para personal.
- Elevado número de resets o baneos por un mismo admin.
- Cualquier cambio que deje un solo admin activo.
- Fallo de auditoría o transacción.
- Crecimiento anormal de reportes/spam.

Si no se puede escribir auditoría, las acciones administrativas críticas deben fallar cerradas (`503`), no ejecutarse sin registro.

---

## 17. Migración y compatibilidad

1. Añadir campos con defaults seguros mediante `cleanProfile()`.
2. Migrar esquema antes de activar nuevas rutas.
3. No convertir automáticamente ningún usuario en admin.
4. Las sesiones antiguas basadas en token de dispositivo siguen identificando invitados durante una ventana de transición, pero no autentican cuentas.
5. Pedir nuevo login a cuentas existentes al desplegar sesiones seguras.
6. Incrementar `sessionVersion` al migrar cuentas para invalidar supuestas sesiones previas.
7. Crear backup y probar restauración antes de activar moderación.
8. Mantener migraciones “forward fix”; evitar rollback destructivo de tablas con evidencia/auditoría.

---

## 18. Rollback

- El feature flag desactiva UI y rutas administrativas, excepto acceso de emergencia/health interno.
- Desactivar panel no revierte sanciones ya persistidas; la aplicación debe seguir respetándolas.
- Si falla la expulsión en tiempo real, la validación en cada evento impide continuar operando.
- Si falla PostgreSQL, negar acciones administrativas; no acumular cambios sensibles solo en memoria.
- Conservar tablas nuevas durante rollback para no perder auditoría.
- Tener scripts CLI auditados para desbanear, revocar sesiones y recuperar MFA en emergencia.

---

## 19. Documentación operativa obligatoria

Crear antes de producción:

- `docs/admin/CREAR_ADMIN.md`
- `docs/admin/RESPONDER_REPORTES.md`
- `docs/admin/RECUPERAR_CUENTA.md`
- `docs/admin/INCIDENTES.md`
- `docs/admin/ROTAR_SECRETOS.md`
- `docs/admin/RETENCION_Y_PRIVACIDAD.md`

Cada runbook debe incluir responsable, precondiciones, pasos, validación, rollback y escalamiento.

---

## 20. Definición de terminado

La funcionalidad no se considerará terminada hasta que:

- [ ] El token de dispositivo no pueda autenticar privilegios.
- [ ] Sesiones opacas, revocables y hasheadas estén en producción.
- [ ] MFA sea obligatorio para personal.
- [ ] Todas las rutas administrativas tengan autorización del servidor.
- [ ] Baneos/suspensiones sobrevivan reinicios y expulsen conexiones.
- [ ] Reportes conserven evidencia validada por servidor.
- [ ] Resets sean de un uso y no revelen contraseñas.
- [ ] Acciones críticas sean transaccionales y auditadas.
- [ ] Existan protecciones de último admin y jerarquía.
- [ ] CSRF, XSS, IDOR, rate limiting y concurrencia estén probados.
- [ ] No haya secretos ni tokens en logs o respuestas.
- [ ] Backup y restauración hayan sido ensayados.
- [ ] Runbooks y política de retención estén aprobados.
- [ ] La suite completa y las pruebas nuevas estén verdes.
- [ ] El despliegue gradual haya pasado 48 horas de observación.

---

## 21. Orden exacto recomendado

1. Congelar el contrato actual y obtener línea base de pruebas.
2. Introducir migraciones y repositorios.
3. Reemplazar autenticación por sesiones seguras.
4. Conectar sesiones a Socket.IO.
5. Añadir roles y permisos centralizados.
6. Añadir MFA y CLI del primer admin.
7. Implementar auditoría transaccional.
8. Implementar suspensiones/baneos y expulsión.
9. Construir las vistas administrativas de usuarios.
10. Persistir evidencia y habilitar reportes.
11. Construir bandeja de reportes.
12. Implementar reset de contraseña de un uso.
13. Endurecer cabeceras, CSRF, límites y privacidad.
14. Ejecutar revisión de seguridad y pruebas E2E.
15. Crear runbooks, backup y simulacro de restauración.
16. Desplegar por feature flags y observar.

**No alterar este orden omitiendo los pasos 3, 5, 6 o 7: son la frontera de seguridad del sistema administrativo.**
