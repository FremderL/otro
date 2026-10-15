# Ticket 03 · Modelo de datos (diagrama entidad–relación)

| Campo | Valor |
| --- | --- |
| **ID** | DOC-03 |
| **Tipo** | Diseño de datos |
| **Estado** | Propuesta · listo para implementar |
| **Prioridad** | Alta |
| **Depende de** | DOC-01 (alcance), DOC-02 (reglas y pagos) |
| **Desbloquea** | Estructuras en memoria, eventos de Socket.IO, snapshot JSON |
| **Imagen** | `docs/diagrama-er.png` (fuente editable: `docs/diagrama-er.svg`) |

> **Motor: SQLite en un archivo local** (`data/casino.db`). No hay que instalar ni levantar ningún
> servidor de base de datos: el archivo se crea solo al ejecutar el script de migración. La ronda en
> curso puede mantenerse en memoria y solo se persiste al cerrar cada ronda.

---

## 1. Diagrama

![Diagrama entidad–relación: jugadores, salas, partidas y apuestas](diagrama-er.png)

---

## 2. Entidades y campos

### `jugadores`

Un registro por persona conectada (o que estuvo en la sala durante la sesión).

| Campo | Tipo | Clave | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID / string | **PK** | Identificador único del jugador | `p_7f3a91` |
| `nombre` | VARCHAR(24) | | Nombre visible en la sala | `Ana` |
| `avatar` | VARCHAR(8) | | Emoji o clave del avatar elegido | `🦊` |
| `saldo_fichas` | INTEGER | | Fichas virtuales disponibles; inicia en 1000 | `1000` |
| `sala_id` | UUID | **FK** → `salas.id` | Sala en la que está sentado (null si no está en ninguna) | `s_K7Q2M` |
| `asiento` | SMALLINT | | Lugar en la mesa, de 1 a 6 | `3` |
| `es_anfitrion` | BOOLEAN | | `true` si es quien creó la sala | `false` |
| `conectado` | BOOLEAN | | `false` si se desconectó y está en periodo de reconexión | `true` |
| `device_id` | VARCHAR(64) | **U** | Identificador del navegador; permite recuperar el saldo | `d_9c2b…` |
| `creado_en` | TIMESTAMP | | Primera vez que entró | `2026-10-14T20:10:00Z` |
| `ultima_actividad` | TIMESTAMP | | Último evento recibido | `2026-10-14T20:42:11Z` |

### `salas`

Una sala por mesa activa. Se crea al pedirla y se elimina cuando queda vacía.

| Campo | Tipo | Clave | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID | **PK** | Identificador interno | `s_K7Q2M` |
| `codigo` | CHAR(5) | **U** | Código compartible, 5 caracteres en mayúsculas | `K7Q2M` |
| `juego` | ENUM | | `coinflip` · `dice` · `roulette` · `blackjack` · `poker` | `roulette` |
| `anfitrion_id` | UUID | **FK** → `jugadores.id` | Quién creó la sala | `p_7f3a91` |
| `capacidad` | SMALLINT | | Máximo de jugadores: **6** | `6` |
| `estado` | ENUM | | `abierta` · `cerrada` — si la sala admite o no participantes | `abierta` |
| `fase` | ENUM | | `espera` · `apuestas` · `jugando` · `resultados` | `apuestas` |
| `apuesta_minima` | INTEGER | | Mínimo permitido en la sala: **10** | `10` |
| `creada_en` | TIMESTAMP | | Cuándo se creó | `2026-10-14T20:10:00Z` |
| `actualizada_en` | TIMESTAMP | | Último cambio de estado | `2026-10-14T20:42:11Z` |

### `partidas`

Una fila por **ronda** jugada. Es el registro histórico y la fuente del resultado autoritativo.

| Campo | Tipo | Clave | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID | **PK** | Identificador de la ronda | `r_0042` |
| `sala_id` | UUID | **FK** → `salas.id` | Sala a la que pertenece | `s_K7Q2M` |
| `numero_ronda` | INTEGER | | Consecutivo dentro de la sala, empieza en 1 | `7` |
| `juego` | ENUM | | Copia del juego (la sala no cambia de juego) | `roulette` |
| `fase` | ENUM | | `apuestas` · `jugando` · `resultados` | `resultados` |
| `resultado` | JSON | | Resultado autoritativo: número, cartas o manos del showdown | `{"numero":17,"color":"negro"}` |
| `bote_total` | INTEGER | | Suma apostada en la ronda (o bote en póker) | `450` |
| `semilla_rng` | VARCHAR(64) | | Semilla aleatoria usada; permite repetir la ronda en pruebas | `sd_1f9a…` |
| `iniciada_en` | TIMESTAMP | | Cuándo arrancó | `2026-10-14T20:41:00Z` |
| `finalizada_en` | TIMESTAMP | | Cuándo se liquidó | `2026-10-14T20:41:35Z` |

### `apuestas`

Una fila por jugador y ronda. Es el detalle que permite auditar cada ficha.

| Campo | Tipo | Clave | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID | **PK** | Identificador de la apuesta | `b_0913` |
| `partida_id` | UUID | **FK** → `partidas.id` | Ronda a la que pertenece | `r_0042` |
| `jugador_id` | UUID | **FK** → `jugadores.id` | Quién apostó | `p_7f3a91` |
| `monto` | INTEGER | | Fichas apostadas (mínimo 10) | `100` |
| `opcion` | VARCHAR(16) | | Opción elegida: `cara`, `alto`, `n:17`, `rojo`, … | `n:17` |
| `multiplicador` | NUMERIC(5,2) | | Multiplicador aplicado (tabla de DOC-02) | `36.00` |
| `pago` | INTEGER | | Fichas acreditadas al liquidar | `3600` |
| `resultado` | ENUM | | `gana` · `pierde` · `empate` | `gana` |
| `creada_en` | TIMESTAMP | | Cuándo se confirmó | `2026-10-14T20:41:10Z` |

---

## 3. Relaciones y cardinalidad

| Desde | Hasta | Cardinalidad | Significado |
| --- | --- | --- | --- |
| `salas` | `jugadores` | 1 ── N (**0 a 6**) | Una sala tiene entre 0 y 6 jugadores sentados |
| `salas` | `partidas` | 1 ── N | Una sala acumula tantas rondas como se jueguen |
| `partidas` | `apuestas` | 1 ── N | Cada ronda tiene una apuesta por jugador participante |
| `jugadores` | `apuestas` | 1 ── N | Cada jugador registra una apuesta por ronda |

Reglas que el diagrama no dibuja pero el código debe cumplir:

- Un `jugador` pertenece a **una sola sala activa** (`sala_id` único en la práctica).
- `asiento` es único dentro de la sala (1…6).
- `codigo` es único entre salas activas.
- Solo puede haber **una apuesta por `jugador_id` + `partida_id`**.

---

## 4. Implementación con SQLite (v1)

El esquema vive en **`db/schema.sql`** y se aplica con **`db/migrar.js`**
(`npm run db:migrar`), que crea `data/casino.db` y **avisa en consola** si la conexión funcionó o
si falló. La conexión se abre una sola vez, en `lib/db.js`, y se comparte en todo el servidor.

```js
// lib/db.js — apertura de la conexión y aviso en consola
const Database = require('better-sqlite3');
const path = require('path');

const archivo = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'casino.db');

let db;
try {
  db = new Database(archivo);
  db.pragma('journal_mode = WAL');   // mejor rendimiento en escrituras frecuentes
  db.pragma('foreign_keys = ON');    // respeta las claves foráneas
  console.log(`✅ Base de datos conectada: ${archivo}`);
} catch (error) {
  console.error(`❌ No se pudo conectar la base de datos: ${error.message}`);
  throw error;                       // el servidor no arranca sin base de datos
}

module.exports = db;
```

**Cómo se reparte el estado:**

| Dónde vive | Qué se guarda ahí | Cuándo se escribe |
| --- | --- | --- |
| **Memoria del servidor** | La ronda en curso: turno, cartas repartidas, temporizadores y apuestas ya confirmadas | Cada evento de Socket.IO |
| **SQLite (`data/casino.db`)** | `jugadores`, `salas`, `partidas` y `apuestas` | Al crear la sala, al entrar o salir alguien, al confirmar una apuesta y al liquidar la ronda |

De este modo el servidor no depende de la base de datos durante cada animación, pero **nada se
pierde al reiniciar**: los saldos y el historial quedan en el archivo.

- **Cero instalación:** SQLite es un archivo, así que no hay que instalar ni levantar un servidor de
  base de datos. `data/` se crea sola al ejecutar la migración.
- **Respaldo opcional:** con `GUARDAR_ESTADO=true` se escribe además `data/estado.json` al apagar.
- **Migrar a PostgreSQL en el futuro:** basta con cambiar `lib/db.js` por `pg` y ajustar los tipos
  (`TEXT` → `VARCHAR`, `INTEGER` → `BOOLEAN/SMALLINT`, `TEXT` con `datetime('now')` → `TIMESTAMPTZ`).
  Ni las reglas ni los eventos cambian.

---

## 5. `db/schema.sql` (SQLite)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jugadores (
  id               TEXT PRIMARY KEY,
  nombre           TEXT    NOT NULL,
  avatar           TEXT    NOT NULL DEFAULT '🙂',
  saldo_fichas     INTEGER NOT NULL DEFAULT 1000 CHECK (saldo_fichas >= 0),
  sala_id          TEXT    REFERENCES salas(id),
  asiento          INTEGER CHECK (asiento BETWEEN 1 AND 6),
  es_anfitrion     INTEGER NOT NULL DEFAULT 0 CHECK (es_anfitrion IN (0, 1)),
  conectado        INTEGER NOT NULL DEFAULT 1 CHECK (conectado IN (0, 1)),
  device_id        TEXT    UNIQUE,
  creado_en        TEXT    NOT NULL DEFAULT (datetime('now')),
  ultima_actividad TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS salas (
  id             TEXT PRIMARY KEY,
  codigo         TEXT    UNIQUE NOT NULL,
  juego          TEXT    NOT NULL CHECK (juego IN ('coinflip','dice','roulette','blackjack','poker')),
  anfitrion_id   TEXT    REFERENCES jugadores(id),
  capacidad      INTEGER NOT NULL DEFAULT 6 CHECK (capacidad BETWEEN 1 AND 6),
  estado         TEXT    NOT NULL DEFAULT 'abierta'  CHECK (estado IN ('abierta','cerrada')),
  fase           TEXT    NOT NULL DEFAULT 'espera'   CHECK (fase IN ('espera','apuestas','jugando','resultados')),
  apuesta_minima INTEGER NOT NULL DEFAULT 10,
  creada_en      TEXT    NOT NULL DEFAULT (datetime('now')),
  actualizada_en TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partidas (
  id             TEXT PRIMARY KEY,
  sala_id        TEXT    NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
  numero_ronda   INTEGER NOT NULL,
  juego          TEXT    NOT NULL,
  fase           TEXT    NOT NULL,
  resultado      TEXT,                       -- JSON: número, cartas o manos del showdown
  bote_total     INTEGER NOT NULL DEFAULT 0,
  semilla_rng    TEXT,
  iniciada_en    TEXT    NOT NULL DEFAULT (datetime('now')),
  finalizada_en  TEXT,
  UNIQUE (sala_id, numero_ronda)
);

CREATE TABLE IF NOT EXISTS apuestas (
  id            TEXT PRIMARY KEY,
  partida_id    TEXT    NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
  jugador_id    TEXT    NOT NULL REFERENCES jugadores(id) ON DELETE CASCADE,
  monto         INTEGER NOT NULL CHECK (monto >= 10),
  opcion        TEXT    NOT NULL,
  multiplicador REAL    NOT NULL DEFAULT 0,
  pago          INTEGER NOT NULL DEFAULT 0,
  resultado     TEXT    CHECK (resultado IN ('gana','pierde','empate')),
  creada_en     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (partida_id, jugador_id)
);

CREATE INDEX IF NOT EXISTS idx_jugadores_sala    ON jugadores(sala_id);
CREATE INDEX IF NOT EXISTS idx_partidas_sala     ON partidas(sala_id);
CREATE INDEX IF NOT EXISTS idx_apuestas_partida  ON apuestas(partida_id);
CREATE INDEX IF NOT EXISTS idx_apuestas_jugador  ON apuestas(jugador_id);
```

> **Nota sobre `estado` y `fase`:** son dos cosas distintas y las dos van en la tabla. `estado`
> (`abierta`/`cerrada`) dice si la sala admite participantes; `fase` dice en qué momento de la ronda
> está (`espera`, `apuestas`, `jugando`, `resultados`). Una sala puede estar `abierta` y en
> `apuestas`, o `cerrada` y en `resultados`.

---

## 6. Criterios de aceptación

- [ ] Existen las cuatro tablas con los campos y tipos de este documento.
- [ ] `db/schema.sql` está en el repositorio y `npm run db:migrar` crea `data/casino.db` sin errores.
- [ ] `lib/db.js` imprime en consola un mensaje claro cuando conecta y otro cuando falla.
- [ ] La relación `salas → jugadores` respeta el máximo de **6** y rechaza el séptimo ingreso.
- [ ] Cada ronda crea **una** fila en `partidas` y **una** en `apuestas` por jugador que apostó.
- [ ] `multiplicador` y `pago` se guardan en la apuesta y coinciden con `02-reglas-y-pagos.md`.
- [ ] Al salir un jugador sin lanzar la ronda, su apuesta desaparece y su saldo vuelve al valor previo.
- [ ] Al reiniciar el servidor se conservan saldos, salas abiertas e historial de rondas.
- [ ] `estado` y `fase` de `salas` se actualizan juntos, sin pisarse entre sí.
