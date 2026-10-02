# Runbook: rotar secretos

**Responsable:** dos custodios con acceso al gestor de secretos. Nunca copie valores a tickets, chat o logs.

- `SESSION_PEPPER`: rotarlo invalida la búsqueda de tokens existentes. Programe cierre global de sesiones y despliegue coordinado.
- `MFA_ENCRYPTION_KEY`: descifra secretos MFA y respuestas idempotentes. Una rotación requiere migración cifrada de datos; no reemplace directamente o el personal perderá acceso. En emergencia, fuerce recuperación MFA controlada y elimine idempotencia vencida.
- `AUDIT_IP_PEPPER`: la rotación rompe correlación histórica deliberadamente; registre fecha y versión, no el valor.
- `DATABASE_URL`: cree credencial nueva con mínimo privilegio, despliegue, verifique y revoque la anterior.

Después de cada rotación ejecute preflight, login/MFA de prueba, una operación auditada y verificación de rollback. **Rollback:** restaure la versión anterior únicamente desde el gestor y solo durante la ventana aprobada. **Escalamiento:** ante exposición real, siga `INCIDENTES.md` y no espere una ventana normal.
