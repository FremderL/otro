# Modelo de amenazas — administración

Fecha: 2026-10-01. Alcance inicial: identidad, panel administrativo, moderación, reportes y recuperación de cuentas.

## Activos

- Cuentas, hashes de contraseña y sesiones.
- Roles y permisos administrativos.
- Fichas, historial y estadísticas.
- Reportes, evidencia y notas internas.
- Secretos MFA y códigos de recuperación.
- Bitácora de auditoría y disponibilidad del casino.

## Actores

- Invitado legítimo o abusivo.
- Usuario autenticado legítimo o con cuenta comprometida.
- Moderador o administrador legítimo.
- Personal malicioso o con sesión robada.
- Atacante remoto sin cuenta.
- Operador con acceso al entorno/base de datos.

## Fronteras de confianza

1. Navegador → Express/Socket.IO: toda entrada es hostil.
2. Express/Socket.IO → PostgreSQL: consultas parametrizadas y transacciones.
3. Servidor → proveedor de despliegue: secretos solo en el entorno.
4. Panel → API admin: cookie HttpOnly, origen/CSRF, MFA y autorización en servidor.
5. Identidad invitada → cuenta: el token de dispositivo no prueba autenticación.

## Amenazas principales y controles exigidos

| Amenaza | Riesgo | Control obligatorio |
|---|---|---|
| Adoptar una cuenta con `profile.id` | Crítico | Sesiones opacas independientes, hash en DB y revocación |
| Escalar rol desde payload/cliente | Crítico | Rol leído en servidor y matriz central de permisos |
| Robo/fijación de sesión admin | Crítico | HTTPS, HttpOnly, Secure, Strict, rotación, expiración corta y MFA |
| CSRF en sanciones/reset | Alto | SameSite, Origin exacto y token CSRF |
| IDOR al cambiar un ID | Alto | Autorización por recurso en cada endpoint |
| XSS almacenado en reportes/chat | Alto | Escape contextual y CSP sin inline scripts |
| Admin interno abusivo | Alto | Menor privilegio, jerarquía, motivos y auditoría append-only |
| Borrar evidencia | Alto | Evidencia inmutable, retención y backups |
| Reset por suplantación | Crítico | Procedimiento de identidad, token de un uso, MFA admin y auditoría |
| Fuerza bruta / enumeración | Alto | Mensaje genérico y límites por IP y cuenta |
| Bloqueo provocado de víctimas | Medio | Backoff corto y rate limit por IP; evitar bloqueo largo por cuenta |
| Replay/doble envío | Alto | Idempotencia, token de un uso y transacciones |
| Carrera entre administradores | Alto | Versión optimista y respuesta 409 |
| Caída de DB durante sanción | Alto | Fallar cerrado; no aplicar cambios sensibles solo en memoria |
| Fuga en logs | Alto | Redacción y lista permitida; nunca tokens, cookies o contraseñas |
| DoS de Socket.IO/dependencias | Alto | Actualizaciones, límites y monitoreo |

## Suposiciones explícitas

- Producción utilizará PostgreSQL y HTTPS.
- El proveedor protege acceso al entorno y a `DATABASE_URL`.
- El panel no se habilitará hasta completar sesiones, permisos y MFA.
- La seguridad física del dispositivo del admin queda fuera de la aplicación, pero se mitiga con expiración y MFA.
- Verificar identidad sin correo/teléfono requiere un runbook humano y seguirá siendo un riesgo residual.

## Riesgos residuales a aceptar o resolver

- El modo invitado conserva una identidad débil; no tendrá facultades administrativas.
- Un operador con acceso simultáneo a DB y secretos del entorno puede comprometer el sistema.
- Hasta persistir evidencia, mensajes en memoria pueden desaparecer.
- Sin un canal de contacto verificado, la recuperación depende de verificación manual.

Este documento debe actualizarse al cerrar cada fase y antes de habilitar `ADMIN_FEATURE_ENABLED`.
