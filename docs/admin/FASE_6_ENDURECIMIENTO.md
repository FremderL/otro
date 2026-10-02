# Fase 6 — Auditoría y endurecimiento

## Entrega 6.1

- Todas las respuestas `/api/` son `no-store`; se eliminó `X-Powered-By`.
- Cabeceras globales `nosniff`, `no-referrer`, `Permissions-Policy` restrictiva y protección de frames.
- La pantalla de restablecimiento ya no necesita estilos inline y conserva CSP estricta.
- El logger estructurado redacta contraseñas, tokens, cookies, autorización, secretos, MFA, códigos de recuperación y evidencia, incluso anidados; limita profundidad, campos, arreglos y tamaño de strings.
- Login exitoso y fallido de cuentas de personal se registra en auditoría con IP hasheada y sin credenciales. Los intentos sobre usernames inexistentes no generan escrituras ni filtran existencia.
- Cada lectura administrativa de evidencia genera `report.evidence_read`, con folio y cantidad, nunca contenido.
- La lista permitida de auditoría incorpora únicamente metadatos seguros de desafíos y conteos.

## Entrega 6.2 — idempotencia administrativa

- `Idempotency-Key` UUID obligatorio en escrituras administrativas sensibles.
- Registro PostgreSQL vinculado a actor, operación y hash del payload durante 24 horas.
- Un reintento idéntico reproduce código y cuerpo con `Idempotency-Replayed: true`; una clave con otro payload o una operación en curso devuelve 409.
- Sanciones, reset MFA, desafíos de contraseña y cambios de reportes quedan protegidos contra doble clic y reintentos de red.
- El cliente administrativo genera claves y la limpieza de retención elimina registros vencidos.
- Un procesamiento abandonado puede reclamarse después de una concesión de dos minutos.

## Entrega 6.3 — transacción de moderación

En PostgreSQL, una sanción ahora ejecuta en una sola transacción:

1. inserción de la acción de moderación;
2. persistencia del snapshot actualizado del perfil y `sessionVersion`;
3. inserción append-only de auditoría;
4. revocación global de sesiones.

Cualquier fallo provoca `ROLLBACK`; la expulsión Socket.IO ocurre solo después de `COMMIT`. El backend en memoria conserva el flujo compensatorio usado por pruebas y desarrollo.

## Entrega 6.4 — transacción de consumo de contraseña

En PostgreSQL, el consumo del desafío ejecuta bajo bloqueo y en una sola transacción: reclamar token vigente, bloquear/cargar perfil, generar hash scrypt nuevo, incrementar `sessionVersion`, limpiar bloqueos, persistir perfil, revocar sesiones e insertar auditoría. Un token inválido no modifica datos y cualquier fallo posterior ejecuta `ROLLBACK`, incluido un fallo de auditoría. Tras `COMMIT`, el snapshot en memoria se sincroniza con el perfil persistido.

## Entrega 6.5 — transacción de reportes

Las actualizaciones administrativas PostgreSQL bloquean el reporte con `FOR UPDATE`, comprueban `version`, aplican y validan la transición, actualizan la fila e insertan `report.updated` en una sola transacción. Un conflicto optimista o fallo de auditoría ejecuta `ROLLBACK`; nunca queda una resolución sin trazabilidad.

## Entrega 6.6 — commit idempotente coordinado

Las transacciones PostgreSQL de moderación y actualización de reportes escriben ahora el código y cuerpo de la respuesta idempotente antes del mismo `COMMIT` que confirma el efecto y su auditoría. Si el proceso cae después del commit pero antes de responder, el reintento reproduce el resultado; si falla la finalización idempotente, toda la operación ejecuta `ROLLBACK`. El middleware detecta que el dominio ya completó la reclamación y no realiza una segunda escritura.

## Entrega 6.7 — desafíos y reset MFA coordinados

La creación de desafíos confirma en una transacción la invalidación anterior, el nuevo hash, auditoría y respuesta idempotente. El reset MFA confirma conjuntamente perfil, revocación, auditoría e idempotencia. Además, todas las respuestas idempotentes PostgreSQL se cifran con AES-256-GCM antes de almacenarse; esto evita que enlaces de restablecimiento, que incluyen un token de un uso, queden legibles en la tabla. La lectura verifica autenticidad antes de reproducir la respuesta.

## Entrega 6.8 — persistencia incremental de perfiles

`PgProfileStore` dejó de reescribir todos los perfiles en cada debounce. Mantiene un conjunto de perfiles sucios, captura su `updatedAt` y solo los retira después de un commit que corresponda a la misma versión. Si cambian durante la escritura permanecen pendientes. El UPSERT compara `data.updatedAt` y rechaza snapshots más viejos, por lo que un lote retrasado no puede sobrescribir una mutación administrativa más reciente. Las eliminaciones y temporadas conservan su coordinación transaccional.

## Pendiente de Fase 6

- Revisar y migrar cualquier respuesta idempotente histórica en texto claro antes de habilitar esta versión sobre una instalación previa.
- Validar estas garantías contra PostgreSQL real durante el control previo al despliegue.
- Pruebas de recuperación ante fallos parciales y una revisión de cabeceras sobre el despliegue real.
