# Identidad cuenta ↔ invitado y economía coordinada

## Problema que resuelve
Antes, al caducar la cookie de sesión el mismo dispositivo volvía a usar el perfil
invitado (`deviceToken`). Esa cartera podía apostar y, al iniciar sesión otra vez,
las fichas/boletos parecían desaparecer porque pertenecían a otro `profileId`.

## Regla única para Casino y Estadio
1. **Cuenta activa:** la cookie `mc_session` verificada manda. El asiento, la
   Lotería, la Rueda, el bono, el gachapón y el Estadio usan el perfil de cuenta.
2. **Dispositivo vinculado sin sesión:** estado explícito `login_required`
   («Sesión caducada»). Solo lecturas públicas; no apuestas, cobros, bonos,
   compras ni inscripción a juegos. El saldo invitado no se muestra como cartera
   utilizable.
3. **Invitado real:** dispositivo sin vínculo, o modo invitado elegido
   explícitamente desde la cuenta (`POST /api/auth/device-mode`). El vínculo
   dispositivo→cuenta persiste en `device-links.json` o
   `montecristo_device_links`; nunca se guarda el token en claro.

## Sesiones
- Renovación deslizante por actividad HTTP y Socket.IO (throttle de 5 min).
- El cliente consulta `/api/auth/session` cada minuto mientras la pestaña está
  visible y avisa cuando quedan menos de 5 minutos.
- El guardián de socket revalida la sesión en cada acción económica; una
  revocación/caducidad en caliente bloquea la siguiente apuesta aunque el socket
  siga conectado.
- Un apagado de varios días no convierte el dispositivo en invitado: el vínculo
  persiste y el regreso exige iniciar sesión.

## Importación invitado → cuenta
- Vista previa: `GET /api/account/guest-import` (cabecera `X-Device-Token`).
- Confirmación: `POST /api/account/guest-import` con CSRF, `confirmed:true`,
  `version` de la vista previa y `operationId` único.
- Suma fichas una sola vez; une logros/inventarios sin volver a pagar recompensas.
- Transfiere apuestas, combinadas, futuros y quinielas conservando id/estado.
- Bloquea conflictos de mercado, quiniela duplicada, operaciones pendientes,
  mesas activas, Lotería/Rueda en curso y torneos sin liquidar.
- Marcador `mergedInto` en el perfil origen y `guestImports` en la cuenta.
- Archivo: diario `importJournal` recuperable al arrancar. Postgres: transacción
  única sobre perfiles, boletos, quiniela y vínculo de dispositivo.

## Recuperación operativa
- Al arrancar, `GuestImportService.recover()` termina importaciones interrumpidas.
- Migración SQL: `migrations/002_identidad_dispositivos.sql`.
- Los perfiles divididos históricos se recuperan iniciando sesión en el dispositivo
  afectado y confirmando la importación; no se fusionan automáticamente.
