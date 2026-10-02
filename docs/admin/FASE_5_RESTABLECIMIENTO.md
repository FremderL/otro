# Fase 5 — Restablecimiento seguro de contraseña

## Flujo implementado

1. Un administrador con MFA reciente, permiso `password:reset`, origen exacto y CSRF selecciona una cuenta de menor privilegio.
2. Registra un motivo de 10–500 caracteres y confirma el username.
3. El servidor invalida desafíos pendientes y genera 32 bytes aleatorios. Solo persiste HMAC-SHA-256 con separación de dominio.
4. El enlace usa fragmento URL (`#token=`), por lo que el token no llega en la petición GET, logs HTTP ni encabezado Referer. La página lo retira inmediatamente del historial.
5. El titular establece personalmente una contraseña de 10–128 caracteres. El desafío expira en 15 minutos y se reclama atómicamente una sola vez.
6. El cambio incrementa `sessionVersion`, revoca todas las sesiones y registra consumo en auditoría. El admin nunca conoce la contraseña.

Creación y consumo tienen rate limiting, respuestas `no-store`, CSP, origen exacto y auditoría sin token. Un fallo posterior a reclamar el desafío lo deja inutilizable de forma segura; soporte debe verificar identidad y emitir otro.

## Verificación de identidad

Antes de emitir un enlace, soporte debe usar al menos dos señales previamente registradas y nunca pedir contraseña, código MFA o código de recuperación. Escalar cuentas de personal, disputas o señales de toma de cuenta. El motivo debe describir el procedimiento sin copiar datos personales innecesarios.

La migración `007_password_reset_challenges.sql` conserva creador, objetivo, motivo, expiración y consumo. La entrega del enlace debe ocurrir por un canal previamente verificado; no enviarlo a un contacto recién cambiado sin revisión adicional.
