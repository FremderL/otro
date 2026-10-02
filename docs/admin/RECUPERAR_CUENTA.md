# Runbook: recuperar una cuenta

**Responsable:** soporte autorizado; un admin emite el desafío. **Precondiciones:** verificar al menos dos señales registradas previamente y revisar cambios recientes.

1. Nunca solicite contraseña, TOTP ni código de recuperación.
2. Confirme identidad por un canal previamente registrado; escale cuentas de personal y señales de toma de cuenta.
3. En el panel registre un motivo minimizado y genere el enlace de 15 minutos.
4. Entregue el enlace una sola vez por el canal verificado. El titular define la nueva contraseña.
5. Confirme `password_reset.created` y `password_reset.consumed`; todas las sesiones anteriores deben quedar revocadas.
6. Para pérdida MFA de personal, otro admin ejecuta reset MFA; auto-reset está prohibido y después se exige enrolamiento nuevo.

**Rollback:** un enlace incorrecto se invalida generando otro para la cuenta correcta; notifique al responsable de seguridad. **Escalamiento:** suspenda temporalmente ante disputa de identidad o actividad activa del atacante.
