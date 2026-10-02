# Fase 0 — Línea base y preparación

Fecha: 2026-10-01

## Estado encontrado

- Rama inicial: `arena/01a0f5d9-otro`, commit base `e3ecb0823b7899bf753ddc80db7c472af56f49b7`.
- El checkout contiene la aplicación, pero no contiene los directorios `tests/` ni `scripts/` que `package.json` referencia.
- Tampoco contenía configuración ESLint compatible con ESLint 10.
- Primer `npm test`: falló porque aún no estaban instaladas las dependencias (`eslint: not found`).
- Después de `npm ci`, `npm run check`: falló porque no existía `eslint.config.js`; al superar esto, seguirá bloqueado por los archivos ausentes referenciados.
- `npm audit` encontró `GHSA-2gc4-cqfq-p2gv` en `engine.io` (severidad alta, DoS remoto). `npm audit fix` actualizó el lockfile y el resultado pasó a 0 vulnerabilidades conocidas.

## Preparación incorporada

- Plan de ejecución completo en `PLAN_ADMINISTRACION_SEGURA.md`.
- Modelo de amenazas en `docs/admin/MODELO_DE_AMENAZAS.md`.
- Feature flag `ADMIN_FEATURE_ENABLED`, apagado por defecto.
- Validación fail-closed de la futura configuración administrativa.
- Configuración ESLint flat compatible con la versión instalada.

## Resolución de la línea base

Se confirmó que la suite histórica ya no existe. Por ello se reconstruyó una suite de caracterización nueva y se reemplazaron únicamente los comandos que apuntaban a archivos inexistentes. Esta suite no se presenta como recuperación de la anterior.

Cobertura inicial incorporada:

- Configuración administrativa apagada y validación fail-closed.
- Hash y verificación de contraseñas, incluyendo entradas malformadas.
- Alta, autenticación, unicidad, persistencia y bloqueo temporal de cuentas.
- Arranque real del servidor en un proceso aislado.
- Endpoints de salud y entrega de la aplicación.
- Creación de una mesa como invitado con aceptación de términos.
- Registro y login de una cuenta mediante Socket.IO.
- Ausencia de `passwordHash` en la respuesta pública.
- Caracterización explícita del riesgo actual: el login aún devuelve el ID del perfil como token. La Fase 1 deberá cambiar esa aserción.

Resultado registrado el 2026-10-01: **10 pruebas aprobadas, 0 fallidas**. ESLint termina sin errores (4 advertencias preexistentes) y se comprueba la sintaxis de todos los archivos JavaScript presentes.

## Criterios de salida

- [x] Riesgos actuales identificados.
- [x] Administración apagada por defecto.
- [x] Configuración insegura impide activar la función.
- [x] Auditoría de dependencias sin vulnerabilidades conocidas.
- [x] Suite base reconstruida y declarada como nueva.
- [x] `npm test` verde.
- [x] Flujos críticos actuales caracterizados antes de cambiar autenticación.

**Fase 0 cerrada. La Fase 1 puede comenzar detrás del feature flag.**
