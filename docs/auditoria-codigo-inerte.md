# Auditoría de código inerte

Revisión del código que **existe pero no hace nada**: declaraciones que nadie
llama, eventos que nadie escucha, estilos que no pueden aplicarse y pruebas que
ignoran su propio parámetro. Fecha: 30 de octubre de 2026, rama
`arena/0129689d-otro`.

Todo lo marcado como **corregido** ya está aplicado en esta rama; lo marcado
como **pendiente** queda documentado con el parche propuesto, a la espera de una
decisión (normalmente porque cambia lo que ve el usuario).

## Cómo se auditó

1. `npx eslint .` para variables y funciones sin uso (5 avisos → 1, y ese era de
   una prueba).
2. Analizador propio (`/tmp/audit*.js`, no versionado) que compara:
   - funciones declaradas contra llamadas reales en todo el repositorio;
   - `socket.emit(...)` del servidor contra `socket.on(...)` de **todas** las
     páginas del cliente (`app.js`, `estadio.js`, `admin.js`, `loteria.js`);
   - clases de `styles.css` contra su presencia en HTML/JS, descartando las que
     se componen dinámicamente (`seat-${i}`, `fan-pin-${pin}`, `rank-${n}`…);
   - `getElementById()` contra los `id` existentes en el HTML;
   - variables de entorno documentadas contra las leídas de verdad.
3. Lectura manual de los caminos de la Rueda, Lotería y moderación.

Falsos positivos descartados a propósito (no tocar, ver el final).

## Resumen

| # | Dónde | Qué es | Severidad | Estado |
| --- | --- | --- | --- | --- |
| A1 | `public/app.js` | `initials()` declarada y nunca llamada | baja | corregido |
| A2 | `server.js` | `requireTurn()` declarada y nunca llamada | media | corregido |
| A3 | `server.js` | `activeBlackjackPlayers()` declarada y nunca llamada | baja | corregido |
| A4 | `server.js` | `avatarInfo` importado sin usar | baja | corregido |
| A5 | `public/styles.css` | 24 reglas y 1 `@keyframes` de interfaces retiradas | baja | corregido |
| A6 | `tests/football-admin-guard.test.js` | `runCasino({ role })` ignoraba el rol: todas las pruebas corrían como admin | alta (en pruebas) | corregido |
| B1 | `server.js:147` | `account_moderated` se emite y nadie lo escucha; además se corta la sesión en el acto | alta (usuario) | **pendiente** |
| B2 | `lib/football/*` | `football:goal`, `football:reaction`, `football:chat`, `football:reconcile` sin consumidor | media (Estadio apagado) | **pendiente** |
| C1 | `server.js` `purgeDepartedPlayers` | rama de la Rueda defendida dos veces; nunca se alcanza | baja | pendiente (defensiva) |
| C2 | `public/app.js` | `fortuneEnabled` se lee una sola vez: si el diario cae a mitad de sesión, la tarjeta sigue activa hasta recargar | baja | pendiente |

---

## A. Código muerto (ya eliminado)

### A1 · `initials()` en `public/app.js`

Los avatares se pintan con `avatarEmoji()`/imágenes, así que la función que
fabricaba iniciales quedó huérfana. **Corregido:** se eliminó.

### A2 · `requireTurn()` en `server.js`

```js
function requireTurn(room, player, ack) {          // eliminado
  if (room.turnId !== player.id) { ackError(ack, 'Aún no es tu turno.'); return false; }
  return true;
}
```

**Por qué no funcionaba:** nadie la llamaba. La validación real está en línea en
los dos ejecutores:

- `executeBlackjackAction` (server.js) → `if (room.turnId !== player.id) return actionError('Aún no es tu turno.', 'stale');`
- el ejecutor de póker → misma comprobación con `actionError`.

Además mezclaba dos estilos incompatibles: `requireTurn` respondía con
`ackError` (API de sockets) mientras los ejecutores devuelven `actionError`
(API interna). Si alguien la hubiera "reconectado", habría roto el contrato de
los ejecutores.

**Corregido:** se eliminó. **Arreglo alternativo** (si se prefiere centralizar):
añadir `function assertTurn(room, player) { return room.turnId === player.id ? null : actionError('Aún no es tu turno.', 'stale'); }`
y usarla en los dos ejecutores; así la regla vive en un solo sitio y el linter
la vigila.

### A3 · `activeBlackjackPlayers()` en `server.js`

```js
function activeBlackjackPlayers(room) {            // eliminado
  return room.players.filter(p => p.bet > 0 && ['playing', 'blackjack'].includes(p.status));
}
```

**Por qué no funcionaba:** nadie la llamaba, y la lógica equivalente de
`nextBlackjackTurn()` es ligeramente distinta (`status === 'playing'` sin
`'blackjack'`). Tener dos definiciones de "jugador activo" con reglas distintas
es una trampa: si alguien la usara, el turno saltaría de forma diferente.
**Corregido:** se eliminó `activeBlackjackPlayers`; si hace falta, debe
extenderse `nextBlackjackTurn` y no duplicarse.

### A4 · `avatarInfo` importado sin usar (`server.js`)

`const { AVATARS, avatarInfo } = require('./lib/profile-store')` → solo se usa
`AVATARS`. **Corregido:** el import quedó en `{ AVATARS }`. El helper sigue
existiendo en `lib/profile-store.js` porque la fachada lo reexporta.

### A5 · CSS de interfaces retiradas (`public/styles.css`)

Reglas que no pueden aplicarse a ningún elemento del sitio (clases con **cero**
apariciones en HTML/JS), restos de las tarjetas antiguas del lobby y de la rueda
CSS anterior a la nueva rueda SVG:

| Clase | Líneas antiguas | Qué era |
| --- | --- | --- |
| `.quick-art`, `.quick-art>b` | 340, 341, 622, 847 | miniatura ilustrada de las tarjetas |
| `.mini-wheel`, `.mini-wheel i` | 342, 343, 851 | rueda de juguete de la tarjeta |
| `.mini-die`, `.mini-coin`, `.mini-die-second` | 344, 345, 854, 855 | dados y moneda de juguete |
| `.mini-table-surface`, `.dice-surface`, `.coin-surface` | 848–850 | paño en miniatura |
| `.mini-table-chip`, `.chip-red/gold/cyan`, `.coin-shadow` | 852, 853, 857 | fichas y sombra decorativas |
| `.roulette-wheel`, `::before`, `::after`, `.rolling` | 439–441 | **rueda CSS vieja** (la sustituye la rueda SVG de 54 sectores) |
| `.quick-result-number` (+ `.red`, `.black`) | 442, 443 | marcador central viejo |
| `@keyframes wheelSpin` | 494 | animación que solo usaba la regla anterior |
| `.passport-reward-icon` (+ variante `unlocked`) | 1512, 1513 | icono sustituido por `passportRewardArtwork()` |

**Corregido:** se eliminaron (~40 líneas). **Guardia añadida:** la prueba
`tests/code-hygiene.test.js` falla si alguna de esas clases reaparece en la hoja
sin volver al marcado.

> Ojo con las que **sí se usan** por composición y no deben borrarse:
> `seat-${i}`, `place-${i}`, `rank-${n}`, `animate-${anim}`, `fan-pin-${pin}`
> (`fan-1`… `fan-3`), `cosmetic-style-${style}` y `chat-role-${role}`.

### A6 · `runCasino({ role })` ignoraba el rol

```js
async function runCasino({ adminEnabled = true, role = 'admin' } = {}) {
  const profiles = new Map([['admin1', makeProfile('admin1', 'admin')]]); // siempre admin
```

La utilidad prometía configurar el rol del perfil de pruebas y no lo hacía: una
prueba escrita a futuro con `role: 'moderator'` habría estado validando en
realidad a un administrador (falso verde en permisos, el tipo de fallo más caro
de detectar). **Corregido:** `makeProfile('admin1', role)`; las 12 pruebas del
archivo siguen en verde.

---

## B. Eventos sin consumidor (pendientes)

### B1 · `account_moderated` — el usuario moderado nunca se enteró

`server.js` (callback `onModerated` de las rutas de administración):

```js
io.to(roomName).emit('account_moderated', { status:state.status, until:state.until });
io.in(roomName).disconnectSockets(true);
```

**Por qué no funciona:** ningún cliente escucha `account_moderated`
(`app.js`, `estadio.js`, `admin.js`, `loteria.js`: cero `socket.on`). Y aunque lo
escuchara, la línea siguiente expulsa la sesión en el mismo instante en que se
emite, así que el paquete se descarta al cerrarse el socket. Resultado: la
persona moderada ve "sin conexión" y no el motivo ni la duración.

**Arreglo propuesto (dos pasos):**

1. Cliente — en `public/app.js`, junto a los demás `socket.on`:

```js
socket.on('account_moderated', ({ status, until } = {}) => {
  showToast('Tu cuenta fue moderada',
    status === 'banned' ? 'El acceso quedó suspendido.' : 'Tu cuenta quedó en revisión.',
    'error', 8000);
  // Con la sesión cerrada, el lobby pasa a modo invitado.
  leaveToLobby(false);
});
```

2. Servidor — dar tiempo a que el aviso salga antes de cortar, o no cortar:

```js
onModerated: async (target, state) => {
  const roomName = `account:${target.id}`;
  io.to(roomName).emit('account_moderated', { status: state.status, until: state.until });
  // 250 ms: suficiente para que el paquete se envíe antes de cerrar el socket.
  setTimeout(() => io.in(roomName).disconnectSockets(true), 250);
}
```

Mientras no se aplique, la prueba de higiene lo mantiene listado como deuda
consciente, para que no pase inadvertido y para que nadie lo borre sin decidir.

### B2 · Estadio: cuatro eventos que nadie pinta

`lib/football/sockets.js` y `lib/football/engine.js` emiten:

| Evento | Quién lo emite | Quién lo escucha |
| --- | --- | --- |
| `football:goal` | `sockets.js` (sala del partido) | nadie (el cliente usa `football:event`) |
| `football:reaction` | `sockets.js`, tras aceptar `socket.on('football:reaction')` | nadie |
| `football:chat` | `sockets.js`, tras `socket.on('football:chat')` | nadie |
| `football:reconcile` | `engine.js` (evento interno del motor) | nadie |

**Efecto:** las reacciones y el chat del Estadio se aceptan y se difunden, pero
no se dibujan en ninguna pantalla; `football:goal` duplica información que ya
viaja en `football:event`; `football:reconcile` es un evento interno sin
suscriptor.

**Arreglo propuesto:** antes de encender `FOOTBALL_ENABLED` en producción,
(a) escuchar `football:reaction` y `football:chat` en `public/estadio.js` y
pintarlos en la zona de chat del partido, (b) borrar el `emit('football:goal')`
o usarlo como disparador de la animación de gol en lugar de `football:event`, y
(c) eliminar `football:reconcile` del motor. El Estadio sigue **apagado en
producción**; esta auditoría no lo activa.

---

## C. Casos menores

### C1 · Rama inalcanzable en `purgeDepartedPlayers`

`purgeDepartedPlayers` reembolsa las apuestas de la Rueda de quienes se fueron
durante las apuestas. Pero esa situación ya la resuelve antes
`removeOrDisconnectPlayer` (que devuelve vía el diario y pone `bet = 0`), y
`resetQuickRound` limpia todas las apuestas al abrir ronda. La llamada a
`purgeDepartedPlayers` ocurre siempre en fase `betting`, así que la condición
`player.bet > 0` no puede darse. **No daña nada** (es defensa en profundidad y
la devolución es idempotente), pero conviene decidir: o se deja con un comentario
que diga "defensa; inalcanzable en el flujo normal", o se elimina la rama y se
confía en `removeOrDisconnectPlayer`. Recomendación: dejarla y documentarla,
porque protege ante futuros cambios de fase.

### C2 · La disponibilidad de la Rueda no se refresca

`public/app.js` lee `/healthz` **una sola vez** al cargar. Si el diario de la
Rueda fallara en caliente (`fortune_ledger` caído), la tarjeta del lobby seguiría
activa y el servidor respondería "La Rueda no está disponible en este momento".

**Arreglo propuesto:** al recibir ese error en `create_room`, volver a consultar
`/healthz` y llamar a `setFortuneAvailability(...)`:

```js
const created = await emitAck('create_room', { /* … */ });
if (!created.ok && /no está disponible/i.test(created.error || '')) {
  fetch('/healthz', { cache: 'no-store' }).then(r => r.json())
    .then(data => setFortuneAvailability(data?.fortuneEnabled !== false))
    .catch(() => {});
}
```

---

## Falsos positivos comprobados (no tocar)

- **`loteria_state` / `loteria_you`**: se escuchan en `public/loteria.js`, no en
  `app.js`.
- **`account_chips_updated`**: lo pinta `public/estadio.js` (La Previa).
- **`.seat-0`…`.seat-5`, `.place-1`…`.place-3`, `.rank-1`…`.rank-3`,
  `.animate-float|glow|orbit`, `.fan-pin-fan-1|2|3`, `.cosmetic-style-frame-*`,
  `.chat-role-*`**: se construyen con plantillas (`seat-${index}`,
  `fan-pin-${pin.pin}`…). Parecen muertas para un grep literal y no lo están.
- **`/assets/cards/*.jpg`, avatares y audios del Balón de Oro**: las rutas se
  arman con el id (`/assets/cards/${card.id}.jpg`), no aparecen literales.
- **`HISTORY_LIMITS`, `INACTIVITY_LIMIT_MS`, `FORTUNE_SECTORS`**: son constantes
  exportadas, no variables de entorno.
- **`FORTUNE_TEST_DATABASE_URL`, `LOTERIA_TEST_DATABASE_URL`**: solo las leen las
  pruebas que se omiten sin PostgreSQL.
- **`_view` en `blackjackBetDecision`**: parámetro intencionalmente ignorado
  (el prefijo `_` lo documenta).
- **`raise-amount`, `roulette-canvas`, `slot-strip-${i}`**: se crean en tiempo de
  ejecución dentro del panel de acciones o del marcado de la mesa.

## Cómo evitar que vuelva

- `tests/code-hygiene.test.js` (nuevo) comprueba en cada `npm test`:
  1. todo evento que emite el servidor tiene quien lo escuche (salvo la deuda
     declarada en `EVENTS_WITHOUT_CLIENT`, con su motivo);
  2. todo evento que escucha el cliente lo emite el servidor;
  3. no reaparecen las clases CSS retiradas;
  4. la Rueda conserva sus 54 sectores y su flecha.
- `npm run lint` sigue siendo la primera barrera para declaraciones sin uso:
  hoy el repositorio queda con **cero avisos**.
- Al añadir un `emit` nuevo: añadir su `socket.on` (o la deuda, con motivo, en
  la lista de la prueba).
