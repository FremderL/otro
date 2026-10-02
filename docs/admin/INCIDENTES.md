# Runbook: incidentes administrativos

**Responsable:** líder de incidente; seguridad, operaciones y privacidad según impacto.

1. Clasifique severidad y abra una línea de tiempo sin datos personales innecesarios.
2. Contenga: apague `ADMIN_FEATURE_ENABLED`, conserve aplicación de sanciones y revoque sesiones comprometidas. No borre tablas.
3. Preserve logs y auditoría con acceso restringido; tome backup cifrado.
4. Rote secretos comprometidos según `ROTAR_SECRETOS.md`; fuerce sesiones nuevas mediante `sessionVersion` cuando corresponda.
5. Ejecute `npm run admin:preflight`, suite completa y pruebas de restauración antes de reactivar.
6. Reactive por etapas y observe errores, denegaciones, resets, baneos y antigüedad de reportes durante 48 horas.

**Rollback:** vuelva al artefacto anterior con flags apagados, conservando migraciones y evidencia. **Escalamiento:** involucre asesoría legal/privacidad para filtración, solicitud de autoridad o posible obligación de notificación en México. Documente causa raíz y acciones correctivas.
