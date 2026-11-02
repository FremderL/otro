# Preferencias del perfil (automatismos del casino)

Cada perfil del casino guarda un bloque `preferences` con interruptores para
desactivar los automatismos que antes eran fijos para todo el mundo. La decisión
se guarda **en el servidor** (no en el navegador) y es el servidor quien la
respeta al operar las mesas: no se trata de ocultar botones.

## Interruptores

| clave | por defecto | qué hace de verdad |
| --- | --- | --- |
| `autoBots` | `true` | Al crear una mesa, completar los asientos libres con bots mientras haya personas sentadas. Con `false`, **la mesa nunca recibe bots**: se juega solo con personas. |
| `botsStay` | `false` | Los bots conservan su asiento entre rondas en lugar de dejarlo libre al terminar cada mano (útil para quien quiere una mesa siempre llena contra bots). |
| `tableInvites` | `true` | Recibir invitaciones a mesas desde la comunidad. Con `false`, el servidor rechaza la invitación en el origen (`friend_invite_send` responde `invites_disabled`) y quien invita recibe un aviso claro. |

Los tres valores por defecto son los históricos del casino, así que un perfil
antiguo se comporta exactamente igual que antes de existir esta pantalla.

## Dónde vive la decisión

1. **Esquema y limpieza** — `lib/profile-store-shared.js`
   - `PREFERENCE_DEFAULTS` / `PREFERENCE_KEYS`: catálogo cerrado (tres claves).
   - `cleanPreferences(raw)`: solo acepta booleanos de esas claves; todo lo demás
     se descarta y se rellena con el valor por defecto.
   - `applyPreferenceChanges(current, changes)`: cambio **parcial** validado.
   - `preferenceEnabled(profile, key)`: lectura con valor por defecto, usada por
     el servidor.
   - `cleanProfile` incluye `preferences`, así el mismo limpiador sirve para el
     backend JSON y para Postgres (sin migración: el bloque es opcional).
2. **Escritura** — `ProfileStore.update(profile, { preferences })`
   (`lib/profile-store-base.js`) mezcla el cambio y marca el perfil como tocado
   para persistirlo. Dos pantallas abiertas no se pisan: solo se aplica lo enviado.
3. **Entrega** — `publicProgress(profile, true)` (`lib/progression.js`) añade
   `preferences` **solo al dueño del perfil**. El perfil público (mesa, ranking,
   comunidad) no las expone.
4. **Efecto en las mesas** — `lib/bots/room-policy.js` es la única traducción de
   la preferencia a reglas de sala:
   - `autoBotsForProfile(profile)`: valor que se congela en la sala al crearla;
   - `roomAllowsAutoBots(room)`: puerta de `autoFillBots` (y de `releaseBotSeats`);
   - `hostPrefersBotsStay(room)`: lee el perfil del anfitrión **actual** (la mesa
     puede cambiar de manos; un bot nunca decide).
   `server.js` usa esas funciones en `createRoom`, `autoFillBots`,
   `releaseBotSeats` y `publicRoom` (que anuncia `autoBots` al cliente).

La preferencia `autoBots` se **congela al crear la sala** (`room.autoBots`):
cambiarla después no reescribe una mesa que ya está jugando ni afecta a las mesas
de otras personas. Las salas antiguas sin el campo siguen admitiendo bots.

## Interfaz

- **Pestaña Preferencias** en el modal de perfil (`public/index.html` →
  `#profile-section-preferences`, acceso en `#profile-tab-preferences`). Cada fila
  explica el efecto real del interruptor; el estado se pinta desde el perfil.
- El guardado usa el evento `preferences_update` (Socket.IO) con resolución de
  identidad idéntica a `profile_update`: el perfil del asiento si se está jugando
  o el de la cuenta autenticada. Nunca se acepta un id de perfil del payload. Si
  el servidor rechaza el cambio, el interruptor **vuelve** a su estado real.
- **Casilla en el formulario de creación de mesa** («Completar asientos con
  bots»): es la misma preferencia y se envía con `create_room`, que la persiste en
  el perfil del anfitrión. Es la vía de quien juega sin cuenta, porque el perfil
  del dispositivo existe desde que se abre la mesa.
- La mesa sin bots se anuncia en la cabecera de la sala con el chip **SIN BOTS** y
  con un mensaje del sistema (`🚫 Mesa sin bots: los asientos libres son solo para
  personas.`). No es un error de la mesa: es una decisión del anfitrión.

## Pruebas

- `tests/profile-preferences.test.js` — catálogo, limpieza, cambios parciales,
  persistencia en disco, entrega privada (nunca pública) y política de bots.
- `tests/preferences-ui.test.js` — los interruptores reflejan el perfil, guardan
  solo la clave cambiada, revierten si falla el servidor y sincronizan la casilla
  del formulario de creación.
- `tests/code-hygiene.test.js` — sigue verificando que todo evento nuevo tenga
  emisor y cliente.

## Notas de producto

- El relleno con bots sigue dependiendo del interruptor de proceso `AUTO_BOTS`:
  si está apagado, ninguna mesa recibe bots, aunque el perfil lo permita. La
  preferencia solo puede **quitar** automatismos, nunca añadirlos por encima de la
  configuración del servidor.
- Desactivar `autoBots` en una mesa de póker implica que hace falta al menos otra
  persona para jugar una mano: es la contrapartida explícita de pedir una mesa
  solo de personas.
