# Fase 7 — despliegue gradual

## Puerta de salida

El entorno local puede no disponer de `DATABASE_URL`. El workflow `Admin security` levanta PostgreSQL 16 efímero y ejecuta migraciones, preflight y una transacción real reporte–auditoría–idempotencia. Esto valida integración técnica en CI, pero no sustituye backup/restauración, E2E ni observación del staging/producción real.

1. Backup cifrado y restauración ensayada.
2. `npm run migrate:db` con el artefacto exacto.
3. `npm run admin:preflight`; resultado `ok: true` obligatorio. Comprueba checksums, tablas, índices, admin inicial, MFA de todo el personal, idempotencia cifrada y reclamaciones estancadas. Durante el bootstrap inicial controlado se tolera únicamente `admins: 0` hasta crear el primer admin; después debe repetirse y aprobar por completo.
4. Despliegue con `ADMIN_FEATURE_ENABLED=false`; habilite sesiones y valide usuarios/invitados.
5. Cree dos admins según `CREAR_ADMIN.md`, enrole MFA y revise auditoría.
6. Habilite panel a operadores; luego moderación, reportes, invitados opcionales y finalmente resets.
7. Ejecute recorridos E2E del plan y limpieza en dry-run.
8. Observe 48 horas antes de ampliar acceso.

## Rollback

Apague el flag; no revierta migraciones destructivamente ni borre auditoría/evidencia. Las sanciones siguen aplicándose. Restaure el artefacto anterior compatible y siga `INCIDENTES.md`.

## Métricas de 48 horas

Errores/latencias admin, fallos MFA, denegaciones, resets y baneos por actor, reportes abiertos y antigüedad, sesiones revocadas, fallos de auditoría/transacción, idempotencia en proceso y resultado diario de retención.
