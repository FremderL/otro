# Revisión de seguridad y endurecimiento (noviembre 2026)

Este documento registra los hallazgos de una revisión completa del repositorio y
los cambios aplicados. La primera parte ordena lo más valioso; la segunda explica
qué se corrigió, cómo se comporta ahora el sistema y qué queda pendiente.

Estado: los puntos **P0** (seguridad) y **P1** (arquitectura y experiencia de
desarrollo) están implementados. Los **P2–P4** siguen abiertos y se listan al
final como trabajo futuro.

---

## 1. Hallazgos por valor (P0 → P4)

### P0 — Seguridad

| # | Hallazgo | Dónde | Por qué importa | Estado |
|---|----------|-------|-----------------|--------|
| 1 | Socket.IO con `cors: { origin: true, credentials: true }` y sin comprobar `Origin` en el handshake | `server.js` (creación de `Server`) | Cualquier página de terceros podía abrir un socket con las cookies de la víctima y actuar en su nombre. El token CSRF de `/api/auth` no cubre Socket.IO. | ✅ corregido |
| 2 | Mazos fijos de test controlables por variable de entorno en producción | `server.js` (`TEST_BLACKJACK_DECK`, `TEST_POKER_DECK`) | Definir la variable en el panel del hosting permitía forzar las cartas repartidas. | ✅ corregido |
| 3 | `rejectUnauthorized: false` en 11 pools de Postgres | `lib/*-pg.js`, `lib/community-store.js`, `lib/device-links.js`, `lib/lobby-tournament-store.js` | Sin verificación de certificado, un MITM sobre `DATABASE_URL` obtiene hashes de contraseña, tokens de sesión y secretos MFA. | ✅ corregido |
| 4 | `scryptSync` en el camino de login | `lib/password.js`, `lib/profile-store-base.js`, `lib/account-auth-http.js`, `server.js` | ~60 ms de CPU bloqueando el event loop por intento: 20 logins simultáneos congelan todas las mesas. | ✅ corregido |
| 5 | Política de contraseñas inconsistente y recorte a 72 caracteres | `lib/profile-store-base.js` | El alta pedía 6 caracteres y recortaba a 72; el cambio y el restablecimiento pedían 10–128. El recorte creaba credenciales divergentes (scrypt no tiene el límite de bcrypt). | ✅ corregido |
| 6 | Export de historial sin autorización (IDOR) | `server.js` → `GET /api/perfil/:token/historial` | Cualquiera con el id de un perfil (visible en mesas) descargaba su historial de movimientos. | ✅ corregido |
| 7 | Perfiles nuevos sin límite | `lib/profile-store-base.js` (`getOrCreate`) | Un script con ids aleatorios inflaba el store, agotaba el plan de Postgres y ocupaba asientos como cuentas nuevas. | ✅ corregido |
| 8 | RNG no criptográfico en juegos con cartera | `server.js` (barajado, códigos de sala), `lib/quick-games.js`, `lib/special-events.js` | `Math.random` (xorshift128+) es predecible con suficientes muestras; aplica a ruleta, dados, tragamonedas, cara o cruz y eventos con bono. | ✅ corregido |
| 9 | Clasificación inconsistente de lecturas privadas en el guardián | `lib/socket-identity-guard.js`, `server.js` | `profile_detail_get` devolvía el perfil privado completo pero no estaba en `READ_EVENTS`, así que una sesión caducada recibía un trato distinto al de `account_profile`. | ✅ corregido |

### P1 — Arquitectura, fiabilidad y experiencia de desarrollo

| # | Hallazgo | Dónde | Por qué importa | Estado |
|---|----------|-------|-----------------|--------|
| 10 | `uncaughtException` mantenía vivo un proceso con estado corrupto | `server.js` | Tras un `TypeError`, el heap queda en estado desconocido: se seguía sirviendo con datos posiblemente corruptos. | ✅ corregido |
| 11 | Escrituras de archivo sin `fsync` | `lib/profile-store.js`, `lib/football-store.js`, `lib/device-links.js`, `lib/community-store.js`, `lib/lobby-tournament-store.js` | El `rename` atómico protege de caídas del proceso, no de pérdida de energía. | ✅ corregido |
| 12 | Replay de códigos TOTP | `lib/mfa.js`, `lib/account-auth-http.js` | El mismo código valía ±1 paso (~60–90 s); un código interceptado se podía reutilizar. | ✅ corregido |
| 13 | `findByUsername` O(n) por intento de login y enumeración por tiempo | `lib/profile-store-base.js`, `lib/account-auth-http.js` | El login hacía un barrido completo del mapa de perfiles y respondía al instante si el usuario no existía. | ✅ corregido |
| 14 | Sin CI y script `test:postgres` roto | repositorio, `package.json` | 139 archivos de pruebas, lint y sintaxis nunca corrían automáticamente; `test:postgres` apuntaba a un archivo inexistente. | ✅ corregido |
| 15 | Sin plantilla de entorno ni versión de Node fijada | raíz del repositorio | ~60 variables dispersas por el código, sin `.env.example` ni `.nvmrc`; el runtime real (Docker) es Node 22 y `engines` decía `>=18`. | ✅ corregido |

### P2 — Arquitectura (pendiente)

- **`server.js` de 4.500 líneas y `public/estadio.js` de 8.200**: extraer las
  salas, la capa de sockets y el motor de fútbol a módulos con pruebas propias.
  Mientras siga siendo un monolito, cada cambio en una mesa se prueba a través
  de un servidor completo (7–10 s por escenario).
- **Estado en memoria** (`rooms`, invitaciones, limitadores): se pierde en cada
  reinicio y no se comparte entre instancias. El diseño es single-instance por la
  concesión de escritor único del fútbol; documentarlo mejor es lo mínimo.
- **`saveNow()` reescribe el archivo completo** en cada guardado diferido: coste
  O(n) por escritura. Un journal incremental (o Postgres para todo) lo resuelve.

### P3 — Calidad y pruebas (pendiente)

- Los tests de integración levantan un servidor real por archivo: la suite tarda
  ~3 minutos. Un `harness` compartido por proceso la bajaría a la mitad.
- Faltan pruebas de carga/latencia para el login y para el fan-out de sockets.
- Cobertura: no hay medición. Añadir `c8` al job de CI daría una línea base.

### P4 — Documentación (pendiente)

- `docs/` tiene 48 documentos y ~10.500 líneas: falta un índice con "empieza por
  aquí" y marcar cuáles son históricos.
- `AGENTS.md` solo cubre la regla de MonteCristo News; conviene añadir las
  convenciones de pruebas, de escritura de stores y de variables de entorno.

---

## 2. Qué cambió exactamente

### 2.1 Orígenes permitidos (CORS de Socket.IO y handshake)

`lib/socket-origin.js` es la única fuente de verdad:

- `APP_ORIGIN` (el que ya validaba `/api/auth`) siempre se permite.
- `ALLOWED_ORIGINS` admite una lista separada por comas (previews, dominios
  antiguos).
- Con `NODE_ENV=production` un origen desconocido se rechaza en el handshake
  (error `origin_denied`). En desarrollo se tolera `localhost`.
- Los clientes sin cabecera `Origin` (tests, scripts, apps nativas) pasan: no
  arrastran cookies de otro origen.

```js
// antes
new Server(server, { cors: { origin: true, credentials: true } });
// ahora
const allowed = resolveAllowedOrigins(process.env, adminConfig);
new Server(server, { cors: socketCorsOptions(process.env, adminConfig) });
```

### 2.2 Mazos de test

`TEST_BLACKJACK_DECK` / `TEST_POKER_DECK` solo surten efecto con
`ALLOW_TEST_DECK_HOOKS=on` **y** `NODE_ENV` distinto de `production`. Si un
despliegue tiene las variables puestas pero los ganchos apagados, el servidor
escribe un aviso en el log en vez de usar el mazo fijo en silencio. Un JSON
inválido se ignora en lugar de tumbar el arranque.

### 2.3 TLS de Postgres

`lib/pg-ssl.js` centraliza la decisión: `{ rejectUnauthorized: true }` por
defecto, `false` solo con `sslmode=disable` explícito en la URL o con
`PGSSL_REJECT_UNAUTHORIZED=false` (que además emite un aviso). Los 11 stores
de Postgres usan ahora esa función.

> Si tu proveedor usa una CA propia sin bundle disponible, define
> `PGSSL_REJECT_UNAUTHORIZED=false` y acepta el riesgo conscientemente. La
> alternativa correcta es `NODE_EXTRA_CA_CERTS=/ruta/ca.pem`.

### 2.4 Contraseñas: scrypt asíncrono y política única

`lib/password.js` expone ahora dos familias:

- `hashPassword` / `verifyPassword` (síncronas): se mantienen para scripts y
  pruebas.
- `hashPasswordAsync` / `verifyPasswordAsync`: usan `crypto.scrypt` y un semáforo
  de 4 operaciones concurrentes. Es la vía de los handlers.

`validatePassword` unifica la política: **10 a 128 caracteres**, sin recortes.
Se aplica en el alta (`registerAccount*`), el cambio (`changePassword*`) y el
restablecimiento (`resetPassword`). El formulario del cliente
(`public/index.html`, `public/app.js`) usa los mismos límites.

El login asíncrono (`authenticateAsync`) verifica contra un hash señuelo cuando el
usuario no existe, así que el tiempo de respuesta no delata qué cuentas existen.

Compatibilidad: los hashes guardados son `salt:hash` y no cambian de formato, así
que las cuentas existentes siguen entrando. `resetPassword`, `changePassword`,
`registerAccount` y `authenticate` conservan su firma síncrona para no romper
scripts ni pruebas; los handlers usan las variantes `*Async`.

### 2.5 Export de historial

`GET /api/perfil/:token/historial` exige prueba de propiedad:

- sesión de cuenta válida cuyo perfil sea el solicitado, o
- cabecera `X-Device-Token` con el propio id de dispositivo.

El id de la URL deja de ser una credencial. El botón del perfil
(`public/app.js`) descarga por `fetch` enviando esa cabecera, porque un
`<a download>` no puede mandar cabeceras propias.

### 2.6 Tope de perfiles nuevos

`BaseProfileStore.profileCreationIssue(id)` decide si un id desconocido puede
crear perfil; `getOrCreate` lo aplica y lanza un error con `code:
'profile_capacity'`. Los handlers que aceptan ids de cliente
(`loteria_join`, `lobby_tournament_register`, `spectate_room`, chat del lobby,
`account_signup`) responden con un mensaje claro antes de tocar el store. Los
perfiles existentes nunca se bloquean.

### 2.7 Azar criptográfico

- Barajado de cartas y códigos de sala: `crypto.randomInt`.
- Ruleta, dados, cara o cruz, tragamonedas y eventos especiales: función
  `cryptoRandom()` por defecto, con el generador inyectable que ya usaban las
  pruebas deterministas.

### 2.8 Apagado tras errores de programación

`uncaughtException` sigue registrando todo, pero si el error es de programación
(`TypeError`, `ReferenceError`, `RangeError`, `SyntaxError`, `EvalError`,
`URIError`) inicia el apagado ordenado (guarda perfiles y cierra stores) y sale
con código 1 para que el supervisor levante un proceso limpio. Los errores de
operación (E/S, red) se siguen tolerando.

### 2.9 Escritura atómica con fsync

`lib/atomic-file.js` centraliza `tmp → write → fsync → rename → fsync(dir)`.
Lo usan los cinco stores de archivo. Además expone `withFileLock(path, fn)` para
serializar escrituras concurrentes al mismo destino.

### 2.10 TOTP sin replay

`verifyTotpStep(secret, token)` devuelve el paso de 30 s al que pertenece el
código. El perfil guarda `security.mfaLastStep` y solo acepta pasos mayores; un
código repetido se registra como `mfa_code_replayed` y se rechaza.

### 2.11 Límites de intentos que no se pueden vaciar

`FixedWindowRateLimiter` ya no expulsa claves existentes al llenarse (eso permitía
inundar el mapa con claves nuevas y "limpiar" los contadores legítimos). Purga
ventanas caducadas y, si el mapa sigue lleno, rechaza la clave nueva.

### 2.12 CI, entorno y versión de Node

- `.github/workflows/ci.yml`: lint + sintaxis, tests unitarios, tests de
  integración y un servicio PostgreSQL 16 para el backend real.
- `.nvmrc` (22) alineado con el `Dockerfile`; `engines` sube a `>=20`.
- `.env.example`: todas las variables agrupadas, marcando secretos y cómo
  generarlos.
- `npm run test:postgres` → `scripts/test-postgres.js`, que exige una base y
  ejecuta las pruebas que la necesitan (antes apuntaba a un archivo inexistente).

### 2.13 Visor de perfil y espectadores

De paso se corrigió un fallo real encontrado al probar el modal de perfil: el
`room_state` compacto no incluía perfil para espectadores, así que quien miraba
una mesa sin asiento veía el modal vacío. Ahora la tribuna también recibe su
`viewerProfile`.

---

## 3. Cómo verificar

```bash
npm ci
npm run check
npm run test:unit          # incluye tests/security-hardening-review.test.js
npm run test:integration
DATABASE_URL=... npm run test:postgres
```

`tests/security-hardening-review.test.js` cubre: orígenes permitidos, TLS de
Postgres, límite de intentos, política de contraseñas, login asíncrono, índice de
usuarios, anti-replay de TOTP, tope de perfiles y escritura atómica.

---

## 4. Riesgos que quedan abiertos (a propósito)

1. **`style-src 'unsafe-inline'`** en la CSP: la interfaz genera atributos
   `style=` en el servidor y en el cliente. Endurecerlo requiere migrar a clases
   o a `nonce` por respuesta (P2).
2. **Rate limiting en memoria**: se reinicia con cada deploy y no se comparte
   entre instancias. El diseño es single-instance; si se escala, hay que moverlo
   a Postgres/Redis (P2).
3. **Estado de salas en memoria**: un reinicio pierde las partidas en curso (las
   fichas se devuelven en el apagado ordenado). Es una decisión de diseño
   documentada, no un bug (P2).
4. **`saveNow()` reescribe todo el archivo**: con muchos perfiles el guardado se
   vuelve caro; conviene un journal o Postgres para todo (P2).
5. **`mfaLastStep` se guarda por perfil, no por sesión**: dos sesiones del mismo
   usuario no pueden usar el mismo código (correcto), pero un cambio de hora del
   servidor hacia atrás exigiría limpiar el campo. Es aceptable mientras el reloj
   del host esté sincronizado.
