# Ticket 04 · Arquitectura y comunicación (navegador ⇄ servidor ⇄ datos)

| Campo | Valor |
| --- | --- |
| **ID** | DOC-04 |
| **Tipo** | Diseño técnico |
| **Estado** | Propuesta · listo para implementar |
| **Prioridad** | Alta |
| **Depende de** | DOC-01 (alcance), DOC-03 (modelo de datos) |
| **Desbloquea** | Implementación de `server.js` y de los eventos de Socket.IO |
| **Imagen** | `docs/diagrama-arquitectura.png` (fuente editable: `docs/diagrama-arquitectura.svg`) |

---

## 1. Diagrama

![Diagrama de arquitectura: navegador, servidor Node.js y capa de datos](diagrama-arquitectura.png)

---

## 2. Las tres capas

| Capa | Qué es | Qué hace | Qué **no** hace |
| --- | --- | --- | --- |
| **Navegador** | HTML + CSS + JavaScript que se descarga al abrir la página | Pide la página, abre el WebSocket, muestra la sala y manda la intención del jugador («apuesto 100 al rojo») | No calcula resultados, no reparte cartas, no mueve fichas por su cuenta |
| **Servidor Node.js** | Un solo proceso **en la computadora de quien lo arranca**: Express + Socket.IO + motor de juego | Guarda el estado real, valida cada acción, genera el resultado con su RNG, liquida pagos y difunde el nuevo estado a todos | No confía en nada que le mande el cliente; no llama a servicios externos |
| **Capa de datos** | **SQLite en archivo local**: `data/casino.db`, en el disco de esa misma máquina | Guarda salas, jugadores, partidas y apuestas del modelo DOC-03 | No usa base de datos remota ni guarda contraseñas, correos ni datos de pago (no existen) |

**Regla de oro:** el servidor es **autoritativo**. El cliente envía intenciones y recibe estados;
el resultado de una ronda se genera una sola vez, en el servidor, y todos los clientes lo reciben.

> **Todo corre en local.** Las tres capas viven en la **misma computadora**: el navegador se abre en
> `http://localhost:3000`, el servidor es un proceso de Node en esa máquina y los datos están en su
> memoria y en `data/casino.db` (SQLite, en su disco). No hay despliegue, hosting, dominio,
> túneles ni servicios en la nube, y **la aplicación no necesita internet para funcionar**.
> Para jugar desde otra computadora basta con usar la IP local de la máquina que corre el servidor
> dentro de la misma red.

---

## 3. Cómo se comunican

| # | Canal | Dirección | Para qué | Formato |
| --- | --- | --- | --- | --- |
| 1 | **HTTP** (`GET`) | navegador → servidor | Descargar la aplicación y consultar salas | HTML, CSS, JS, JSON |
| 2 | **WebSocket** (Socket.IO) | navegador ⇄ servidor | Todo lo que pasa dentro de la sala, en tiempo real | Eventos con JSON |
| 3 | **Lectura/escritura** | servidor → datos | Guardar y leer salas, jugadores, partidas y apuestas | Objetos en memoria (o SQL/JSON si se activa persistencia) |

### 3.1 Endpoints HTTP

| Método | Ruta | Respuesta |
| --- | --- | --- |
| `GET` | `/` | Página principal (`index.html`) |
| `GET` | `/sala/:codigo` | Misma página, abre la sala indicada |
| `GET` | `/api/salas` | Lista de salas activas con juego, fase y ocupación |
| `GET` | `/api/salas/:codigo` | Existe o no la sala y cuántos asientos libres tiene |
| `GET` | `/health` | `{ "ok": true }` para verificar que el servidor vive |

### 3.2 Eventos del navegador al servidor

| Evento | Quién lo manda | Datos |
| --- | --- | --- |
| `crear_sala` | Cualquiera | `{ nombre, avatar, juego }` |
| `entrar_sala` | Cualquiera | `{ codigo, nombre, avatar }` |
| `salir_sala` | Jugador | — |
| `apostar` | Jugador | `{ monto, opcion }` |
| `lanzar` | **Anfitrión** | — |
| `accion_blackjack` | Jugador en turno | `{ accion: 'hit' \| 'stand' \| 'double' \| 'split' }` |
| `tomar_seguro` | Jugador (si la casa muestra As) | — |
| `accion_poker` | Jugador en turno | `{ accion: 'fold' \| 'check' \| 'call' \| 'raise', monto }` |
| `nueva_ronda` | **Anfitrión** | — |
| `chat` | Jugador | `{ texto }` |

### 3.3 Eventos del servidor al navegador

| Evento | Cuándo | Datos |
| --- | --- | --- |
| `estado_sala` | Al entrar y después de **cada** cambio | Sala completa: jugadores, fichas, apuestas, fase, turno |
| `ronda_iniciada` | Al lanzar o repartir | `{ numeroRonda, juego }` |
| `cartas` | Solo al dueño de esas cartas | `{ cartas: [...] }` (nunca las ajenas) |
| `turno` | En blackjack y póker | `{ jugadorId, deadline }` |
| `resultado` | Al liquidar | `{ resultado, apuestas: [{ jugadorId, monto, multiplicador, pago }] }` |
| `chat_mensaje` | Al escribir en el chat | `{ nombre, texto, hora }` |
| `error` | Cuando una acción se rechaza | `{ mensaje, codigo }` |
| `sala_cerrada` | Al cerrar la sala o quedarse vacía | `{ motivo }` |

Cada evento del cliente se responde con un **acknowledgement**: `{ ok: true }` o
`{ ok: false, error }`. Si llega `ok: false`, la interfaz muestra el mensaje y no cambia nada.

---

## 4. Secuencia de una ronda (juego rápido)

```
Jugador A                Servidor                       Jugador B
   │                         │                              │
   │── apostar {100,'rojo'} ─▶                              │
   │                         │── valida fase, monto, saldo  │
   │                         │── descuenta 100 del saldo    │
   │◀────── ok ──────────────│                              │
   │                         │──── estado_sala ─────────────▶ (ve la apuesta de A)
   │                         │                              │
   │               (anfitrión) lanzar                       │
   │                         │── genera número 17 (RNG)     │
   │                         │── calcula multiplicadores    │
   │                         │── acredita pagos             │
   │◀──── resultado ─────────│─────── resultado ────────────▶
   │◀──── estado_sala ───────│─────── estado_sala ──────────▶
```

En **blackjack** y **póker** el mismo esquema se repite por turno: el servidor manda `turno`,
espera la acción (o vence el reloj), aplica la jugada y vuelve a difundir `estado_sala`.

---

## 5. Tiempos, reconexión y errores

| Situación | Comportamiento |
| --- | --- |
| Turno sin respuesta (blackjack) | A los 25 s el servidor planta al jugador |
| Turno sin respuesta (póker) | A los 30 s pasa si puede; si no, se retira |
| Anfitrión inactivo 60 s | El rol de anfitrión migra al siguiente jugador conectado |
| Desconexión breve | Socket.IO reintenta solo; el jugador conserva asiento y saldo |
| Salida voluntaria | Se libera el asiento; si la ronda no se lanzó, se reembolsa la apuesta |
| Sala vacía | Se elimina la sala y se cancelan sus temporizadores |
| Acción inválida | Se responde `ok:false` con mensaje; el estado no cambia |
| Apagado del servidor | Si el snapshot está activo, guarda `data/estado.json` y lo recupera al arrancar |

---

## 6. Seguridad mínima de la v1

1. **Autoridad del servidor:** el cliente nunca envía un resultado, solo una intención.
2. **Validación en cada acción:** fase, turno, monto, saldo y existencia del jugador.
3. **Privacidad de cartas:** `cartas` se emite por socket individual (`socket.emit`), nunca en la
   difusión de la sala.
4. **Idempotencia:** una ronda se liquida una sola vez aunque lleguen dos `lanzar`.
5. **Límites:** máximo 50 salas, 6 jugadores por sala, 200 caracteres por mensaje de chat.
6. **Sin datos sensibles:** no se piden correo, contraseña ni datos de pago.
7. **Aviso permanente** de que las fichas son virtuales y no tienen valor monetario.

---

## 7. Estructura de carpetas propuesta

```
/
├─ server.js              # por crear: Express + Socket.IO + arranque
├─ package.json           # por crear
├─ public/
│  ├─ assets/             # YA EXISTE: imágenes de los juegos y del casino
│  ├─ index.html          # inicio: crear sala / entrar con código
│  ├─ index.html          # inicio: crear sala / entrar con código
│  ├─ perfil.html         # nombre y avatar antes de entrar a jugar
│  ├─ sala.html           # la mesa: asientos, apuestas y resultados
│  ├─ styles.css          # sistema visual completo (variables y botones)
│  ├─ app.js              # inicio y perfil: socket.io-client y localStorage
│  └─ sala.js             # lógica de la mesa (integración)
├─ db/
│  ├─ schema.sql          # CREATE TABLE de las 4 tablas (SQLite)
│  └─ migrar.js           # crea/actualiza data/casino.db y avisa en consola
├─ lib/
│  ├─ db.js               # conexión a SQLite y consultas (DOC-03)
│  ├─ reglas.js           # constantes y pagos de DOC-02
│  ├─ rng.js              # generador con semilla
│  ├─ salas.js            # estado en memoria (DOC-03)
│  ├─ snapshot.js         # guardar/cargar data/estado.json
│  └─ juegos/
│     ├─ coinflip.js
│     ├─ dice.js
│     ├─ roulette.js
│     ├─ blackjack.js
│     └─ poker.js
├─ data/                  # snapshot JSON (opcional, se crea solo)
├─ docs/                  # esta documentación (ya existe)
└─ tests/                 # pruebas con los casos de DOC-02
```

> **Punto de partida:** el repositorio arranca **desde cero**. Lo único que ya existe es
> `public/assets/` (las imágenes de los juegos y del casino) y esta carpeta `docs/`. No hay
> `package.json`, ni `server.js`, ni `public/index.html`: todo eso se crea con estos tickets.
> Las imágenes de `public/assets/` se consumen por ruta relativa (`assets/...`) y el servidor debe
> servirlas como archivos estáticos.

---

## 8. Criterios de aceptación

- [ ] El navegador se conecta por WebSocket y recibe `estado_sala` completo al entrar.
- [ ] Cualquier cambio de estado se difunde a **todos** los clientes de la sala.
- [ ] Ningún cliente recibe cartas de otro jugador antes del showdown o del cierre de la mano.
- [ ] Dos `lanzar` seguidos solo liquidan una vez (idempotencia).
- [ ] Una acción inválida devuelve `ok:false` y no altera saldos ni fase.
- [ ] Los relojes de turno aplican la acción automática a los 25 s (blackjack) y 30 s (póker).
- [ ] Al perder la conexión y volver, el jugador recupera asiento, saldo y apuesta pendiente.
- [ ] `GET /health` responde `{ "ok": true }` mientras el servidor está vivo.
