# Runbook: crear el primer administrador

**Responsable:** dos operadores autorizados. **Precondiciones:** backup cifrado y restauración probada; servicio detenido; `ADMIN_MAINTENANCE_MODE=true`; migraciones aplicadas.

1. Ejecute `npm run admin:preflight`; antes del primer admin se permite únicamente el fallo `admins: 0`.
2. Promueva una cuenta existente con `npm run admin:role` siguiendo la entrada interactiva; nunca pase contraseñas por argumentos o entorno.
3. Arranque con `ADMIN_FEATURE_ENABLED=true` solo para el operador y complete MFA inmediatamente.
4. Cierre sesión, inicie de nuevo, verifique `/api/admin/v1/me` y confirme eventos de rol/login/MFA en auditoría.
5. Cree un segundo admin de emergencia con otro custodio; confirme que degradar al último admin falla.

**Rollback:** con servicio detenido, degrade mediante la CLI solo si queda otro admin; revoque sesiones. No borre auditoría. **Escalamiento:** si la auditoría, MFA o preflight falla, desactive el flag y no continúe.
