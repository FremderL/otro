# Fase 2 — Roles, permisos y MFA

## Entrega 2.1: autorización y bootstrap de roles (2026-10-01)

Implementado:

- Roles cerrados: `user`, `moderator`, `admin`; todo valor desconocido degrada a `user`.
- Catálogo central de permisos en `lib/permissions.js`.
- Jerarquía estricta: moderador solo actúa sobre usuarios; admin sobre roles inferiores.
- Nadie puede moderarse a sí mismo.
- Moderador puede atender reportes y suspender, pero no banear, cambiar roles, restablecer contraseñas ni leer auditoría completa.
- Migración de bitácora administrativa append-only.
- CLI transaccional para promover/degradar cuentas existentes.
- Protección contra degradar al último administrador.
- Cada cambio incrementa `sessionVersion`, revoca sesiones y desactiva MFA para exigir un enrolamiento nuevo al personal promovido.
- Auditoría de sistema con snapshots mínimos; nunca contraseña, hash o perfil completo.

## Crear el primer administrador

La aplicación mantiene perfiles en memoria y los vuelca por snapshot. Para impedir que una instancia activa sobrescriba un cambio externo, este procedimiento exige una ventana de mantenimiento:

1. Ejecutar `npm run migrate:db`.
2. Detener completamente el servicio web.
3. Exportar `DATABASE_URL` y `ADMIN_MAINTENANCE_MODE=true` en una consola segura.
4. Ejecutar:

```bash
npm run admin:role -- promote nombre_usuario admin
```

5. Escribir `@nombre_usuario` cuando la herramienta solicite confirmación.
6. Reiniciar el servicio.
7. Verificar que el usuario deba enrolar MFA antes de acceder al panel.

Nunca pasar contraseñas como argumentos. La herramienta las rechaza expresamente.

Para crear un moderador:

```bash
npm run admin:role -- promote nombre_usuario moderator
```

Para degradar a usuario:

```bash
npm run admin:role -- demote nombre_usuario
```

No establecer `ADMIN_MAINTENANCE_MODE` permanentemente en el servicio web.

## Entrega 2.2: TOTP y recuperación (2026-10-01)

Implementado:

- TOTP estándar de 6 dígitos, periodo de 30 segundos y ventana de ±1 periodo.
- URI `otpauth://` y QR generado localmente, sin servicios externos.
- Secreto cifrado con AES-256-GCM y `MFA_ENCRYPTION_KEY`.
- El secreto en claro solo se entrega durante el inicio del enrolamiento.
- Confirmación obligatoria con un TOTP válido antes de activar MFA.
- Diez códigos de recuperación aleatorios, mostrados una sola vez.
- Solo hashes HMAC de códigos de recuperación se persisten.
- Consumo atómico lógico de cada código; no puede reutilizarse.
- `mfa_verified_at` asociado a una sesión concreta, no solo al perfil.
- Las demás sesiones se revocan al completar el enrolamiento.
- Límite de cinco intentos MFA por diez minutos y por perfil.
- Login y consulta de sesión informan si falta enrolar o verificar MFA.
- Endpoints protegidos por sesión, origen y CSRF:
  - `POST /api/auth/mfa/enroll/start`
  - `POST /api/auth/mfa/enroll/confirm`
  - `POST /api/auth/mfa/verify`

## Entrega 2.3: frontera administrativa y primera pantalla (2026-10-01)

Implementado:

- Middleware central que exige sesión vigente, rol de personal y MFA verificado en esa misma sesión.
- `requirePermission(permission)` sobre la matriz central.
- `requireRecentAuth` con un máximo de diez minutos desde la última verificación MFA.
- Primera API protegida: `GET /api/admin/v1/me`.
- Panel `/admin` apagado junto con el feature flag.
- `Cache-Control: no-store`, CSP estricta, bloqueo de iframes, `nosniff` y política sin referrer.
- Pantallas de enrolamiento TOTP, verificación y presentación única de códigos de recuperación.
- Panel inicial identifica al personal y no habilita todavía acciones de moderación.
- Errores distinguibles para sesión, rol, enrolamiento, MFA, permiso y autenticación reciente.

## Entrega 2.4: recuperación MFA y auditoría (2026-10-01)

Implementado:

- Reset de MFA de otro miembro del personal, reservado a administradores.
- Prohibición de auto-reset desde el panel.
- Exigencia de MFA reciente, origen exacto, CSRF y motivo de 10–500 caracteres.
- Limpieza de secreto, enrolamiento pendiente y códigos de recuperación.
- Incremento de `sessionVersion` y revocación de todas las sesiones objetivo.
- Repositorios de auditoría en memoria y PostgreSQL.
- Lista permitida de campos auditables; hashes, tokens y secretos se descartan.
- Fallo cerrado: si no puede escribirse auditoría, el perfil vuelve a su estado anterior.
- CLI de emergencia, únicamente con servicio detenido y confirmación explícita:

```bash
ADMIN_MAINTENANCE_MODE=true npm run admin:mfa-reset -- nombre_usuario
```

La CLI exige escribir `RESET @nombre_usuario`, revoca sesiones y registra actor `system`.

## Estado de Fase 2

Fase 2 completa. Los middlewares de sesión, permiso, MFA y autenticación reciente están listos para proteger las operaciones reales de moderación de Fase 3.
