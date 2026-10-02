# Retención y privacidad

Política inicial sujeta a revisión legal antes de producción en México:

- Sesiones expiradas o revocadas: 90 días desde su expiración efectiva o revocación más reciente.
- Reportes cerrados (`resolved` o `rejected`) y su evidencia: 365 días desde `resolved_at`.
- Auditoría administrativa: 730 días.
- Reportes abiertos nunca son eliminados por este trabajo.

## Operación

La tarea es deliberadamente *dry-run* por defecto:

```bash
DATABASE_URL=... npm run retention:check
DATABASE_URL=... npm run retention:cleanup
```

Programar `retention:cleanup` una vez al día con un rol PostgreSQL dedicado que pueda borrar estos registros y escribir auditoría. No usar el rol normal de la aplicación para borrar auditoría. La tarea:

- toma un advisory lock para impedir ejecuciones simultáneas;
- elimina en lotes configurables, evitando transacciones largas;
- aprovecha `ON DELETE CASCADE` para eliminar evidencia junto con su reporte;
- emite métricas JSON a stdout y registra un evento `retention.cleanup` de sistema;
- no imprime descripciones, evidencia ni identificadores de personas.

Variables opcionales: `RETENTION_SESSIONS_DAYS`, `RETENTION_REPORTS_DAYS`, `RETENTION_AUDIT_DAYS` y `RETENTION_BATCH_SIZE` (máximo 5000). Reducir plazos requiere aprobación de privacidad y operación. Alertar si el proceso falla, si no corre durante 48 horas o si el volumen elegible crece de forma sostenida.

Antes de activar en producción: realizar respaldo cifrado, probar restauración, validar permisos del rol y documentar excepciones de conservación legal. Una conservación legal debe implementarse explícitamente antes de operar sobre datos sujetos a ella; no se deben ampliar plazos globales como sustituto.
