# Prompt de implementación · Backend 1

Pega este prompt en una conversación de Arena **con este repositorio montado**. Arena debe escribir
el código real de los tickets BE-01, BE-02 y BE-03.

---

## INICIO DEL PROMPT (copia desde aquí)

````text
Eres el desarrollador BACKEND 1 de este repositorio. Tu trabajo es IMPLEMENTAR el código de tres
tickets (no redactar documentos): la base de datos y sus dos primeras tablas. Al terminar, los
demás compañeros pueden leer y escribir en la base de datos desde su propio código.

═══════════════════════════════════════════════════════════════════════════════
1. PROYECTO
═══════════════════════════════════════════════════════════════════════════════
"MonteCristo": casino social multijugador local. Una persona crea una sala, comparte un enlace o un
código de 5 caracteres y hasta 6 personas juegan en tiempo real desde el navegador. Juegos: Cara o
Cruz, Dados, Ruleta (europea 0-36), Blackjack/21 y Texas Hold'em. Las fichas son 100 % virtuales:
no hay dinero real ni premios canjeables.

Stack: Node.js 18+, Express 4, Socket.IO 4, SQLite en archivo local, JavaScript vanilla en el
cliente. Todo se ejecuta SOLO EN LOCAL: sin hosting, sin dominio, sin túneles y sin servicios en la
nube. La base de datos es un archivo en la propia computadora.

═══════════════════════════════════════════════════════════════════════════════
2. ESTADO DEL REPOSITORIO
═══════════════════════════════════════════════════════════════════════════════
Empieza de cero. Hoy solo existe:
  - public/assets/  → imágenes de los juegos y del casino (NO las toques, NO las renombres)
  - docs/           → documentación 01 a 04 y README (NO las reescribas)
  - docs/backlog/   → los prompts de cada compañero (NO los modifiques)
No hay package.json ni server.js todavía: TÚ creas el package.json.

═══════════════════════════════════════════════════════════════════════════════
3. LEE ESTO PRIMERO (es el contrato del proyecto)
═══════════════════════════════════════════════════════════════════════════════
  - docs/03-modelo-de-datos.md → las cuatro tablas (jugadores, salas, partidas, apuestas) con todos
    sus campos, tipos, claves, el db/schema.sql de referencia y la forma de usar lib/db.js. ES TU
    DOCUMENTO PRINCIPAL.
  - docs/01-alcance-y-requerimientos.md → alcance, salas de 6 jugadores, roles y reglas
    transversales (§7).
  - docs/02-reglas-y-pagos.md → constantes (SALDO_INICIAL 1000, APUESTA_MINIMA 10) y multiplicadores.
  - docs/04-arquitectura.md → estructura de carpetas (§7) y capas.

═══════════════════════════════════════════════════════════════════════════════
4. TUS TRES TICKETS
═══════════════════════════════════════════════════════════════════════════════
BE-01 · Crear la base de datos del proyecto y el código que la conecta desde el servidor.
        Debe avisar en la consola si la conexión funcionó o si falló.
BE-02 · Tabla de jugadores: id, nombre, avatar, saldo y fecha de registro (más los campos que exige
        docs/03). El script SQL queda guardado en el repositorio.
BE-03 · Tabla de salas: id, código, juego, anfitrión y estado ('abierta' o 'cerrada'), más la fase
        de la ronda y los campos de docs/03. El script SQL queda guardado en el repositorio.

═══════════════════════════════════════════════════════════════════════════════
5. ARCHIVOS QUE TE TOCAN (y los que NO)
═══════════════════════════════════════════════════════════════════════════════
CREAS TÚ:
  package.json          → dependencias y scripts (tú eres el dueño de este archivo)
  db/schema.sql         → CREATE TABLE de las CUATRO tablas
  db/migrar.js          → aplica el esquema y avisa por consola
  lib/db.js             → la conexión compartida
  .gitignore            → node_modules/, data/*.db, data/*.db-wal, data/*.db-shm
  tests/db.test.js      → prueba que las tablas existen y que las restricciones funcionan

NO TOQUES (son de otros compañeros; si necesitas algo de ahí, dalo por hecho e intégralo después):
  server.js · lib/reglas.js · lib/ronda.js · lib/rng.js · lib/fichas.js · public/**  · docs/**

Nota: crea las CUATRO tablas (incluidas partidas y apuestas) aunque tus tickets solo mencionen dos.
Están en docs/03 y así los demás no tienen que esperarte.

═══════════════════════════════════════════════════════════════════════════════
6. ESPECIFICACIÓN TÉCNICA
═══════════════════════════════════════════════════════════════════════════════
a) Motor y librería
   · SQLite sobre un archivo. Librería: better-sqlite3 (API síncrona).
   · Ruta: variable de entorno DB_FILE, por defecto data/casino.db (relativa a la raíz del repo).
   · La carpeta data/ se crea sola si no existe (fs.mkdirSync con recursive: true).
   · Excepción permitida: si el equipo usa Node 22+, puedes usar el módulo nativo node:sqlite en
     lugar de better-sqlite3; en ese caso documéntalo. Si usas better-sqlite3, agrégalo a las
     dependencias.

b) lib/db.js
   · Abre la conexión UNA SOLA VEZ y la exporta. Nada de abrir y cerrar por consulta.
   · Al abrir ejecuta:  PRAGMA journal_mode = WAL;   y   PRAGMA foreign_keys = ON;
   · Aviso obligatorio en consola:
       éxito →  ✅ Base de datos conectada: <ruta>
       fallo →  ❌ No se pudo conectar la base de datos: <mensaje del error>
   · Si la conexión falla, el módulo debe lanzar el error: el servidor no debe arrancar en
     silencio sin base de datos.
   · Ejemplo de referencia (adáptalo, no lo copies sin revisar):
     const Database = require('better-sqlite3');
     let db;
     try {
       db = new Database(archivo);
       db.pragma('journal_mode = WAL');
       db.pragma('foreign_keys = ON');
       console.log(`✅ Base de datos conectada: ${archivo}`);
     } catch (error) {
       console.error(`❌ No se pudo conectar la base de datos: ${error.message}`);
       throw error;
     }
     module.exports = db;

c) db/schema.sql
   · Sintaxis SQLite, SIEMPRE con CREATE TABLE IF NOT EXISTS (idempotente).
   · Cuatro tablas con los campos, tipos y restricciones EXACTOS de docs/03 §5. En resumen:
     jugadores: id TEXT PK, nombre TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '🙂',
       saldo_fichas INTEGER NOT NULL DEFAULT 1000 CHECK (saldo_fichas >= 0), sala_id TEXT
       REFERENCES salas(id), asiento INTEGER CHECK (asiento BETWEEN 1 AND 6),
       es_anfitrion INTEGER NOT NULL DEFAULT 0 CHECK (es_anfitrion IN (0,1)),
       conectado INTEGER NOT NULL DEFAULT 1 CHECK (conectado IN (0,1)), device_id TEXT UNIQUE,
       creado_en TEXT NOT NULL DEFAULT (datetime('now')),
       ultima_actividad TEXT NOT NULL DEFAULT (datetime('now'))
     salas: id TEXT PK, codigo TEXT UNIQUE NOT NULL,
       juego TEXT NOT NULL CHECK (juego IN ('coinflip','dice','roulette','blackjack','poker')),
       anfitrion_id TEXT REFERENCES jugadores(id),
       capacidad INTEGER NOT NULL DEFAULT 6 CHECK (capacidad BETWEEN 1 AND 6),
       estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
       fase TEXT NOT NULL DEFAULT 'espera' CHECK (fase IN ('espera','apuestas','jugando','resultados')),
       apuesta_minima INTEGER NOT NULL DEFAULT 10,
       creada_en TEXT NOT NULL DEFAULT (datetime('now')),
       actualizada_en TEXT NOT NULL DEFAULT (datetime('now'))
     partidas: id TEXT PK, sala_id TEXT NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
       numero_ronda INTEGER NOT NULL, juego TEXT NOT NULL, fase TEXT NOT NULL, resultado TEXT,
       bote_total INTEGER NOT NULL DEFAULT 0, semilla_rng TEXT,
       iniciada_en TEXT NOT NULL DEFAULT (datetime('now')), finalizada_en TEXT,
       UNIQUE (sala_id, numero_ronda)
     apuestas: id TEXT PK, partida_id TEXT NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
       jugador_id TEXT NOT NULL REFERENCES jugadores(id) ON DELETE CASCADE,
       monto INTEGER NOT NULL CHECK (monto >= 10), opcion TEXT NOT NULL,
       multiplicador REAL NOT NULL DEFAULT 0, pago INTEGER NOT NULL DEFAULT 0,
       resultado TEXT CHECK (resultado IN ('gana','pierde','empate')),
       creada_en TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (partida_id, jugador_id)
   · Índices: jugadores(sala_id), partidas(sala_id), apuestas(partida_id), apuestas(jugador_id).
   · MUY IMPORTANTE: 'estado' ('abierta'/'cerrada') y 'fase' (momento de la ronda) son DOS CAMPOS
     DISTINTOS. No los fusiones ni los elimines.

d) db/migrar.js
   · Lee db/schema.sql, lo ejecuta y registra en consola qué tablas creó y cuáles ya existían.
   · Debe poder ejecutarse mil veces sin romper nada.
   · Se corre con:  npm run db:migrar

e) package.json (tú lo creas; si ya existiera, agrega sin borrar lo de los demás)
   · "name": "montecristo", "private": true, "main": "server.js", "engines": { "node": ">=18" }
   · scripts: "start": "node server.js", "dev": "node server.js",
     "db:migrar": "node db/migrar.js", "test": "node --test tests/"
   · dependencies: express ^4, socket.io ^4, better-sqlite3 ^11 (o la versión que instales)
   · devDependencies: si usas pruebas con jsdom u otra, agrégala; si no, déjalo vacío.

═══════════════════════════════════════════════════════════════════════════════
7. REGLAS DE CONVIVENCIA
═══════════════════════════════════════════════════════════════════════════════
  1. No modifiques server.js, lib/ronda.js, lib/rng.js, lib/fichas.js, lib/reglas.js, public/** ni
     docs/**. Si necesitas que exista algo de ahí, créalo solo si no existe y avísalo en tu reporte.
  2. No inventes reglas de juego. Todo número ya está en docs/02-reglas-y-pagos.md.
  3. Código en español (nombres de variables y mensajes), comentarios solo donde aporten.
  4. Un solo estilo: punto y coma al final, comillas simples, 2 espacios de sangría.

═══════════════════════════════════════════════════════════════════════════════
8. CÓMO VERIFICAR QUE TERMINASTE
═══════════════════════════════════════════════════════════════════════════════
  1. npm install
  2. npm run db:migrar  →  debe imprimir ✅ y listar las tablas creadas.
  3. npm run db:migrar  →  segunda vez debe decir que ya existían y NO fallar.
  4. DB_FILE=/ruta/que/no/existe/casino.db node -e "require('./lib/db.js')"
     →  debe imprimir ❌ con el mensaje del error (así se prueba el aviso de fallo).
  5. node --test tests/  →  tus pruebas pasan:
       · las cuatro tablas existen;
       · insertar un jugador con saldo_fichas -1 falla por el CHECK;
       · insertar una sala con juego 'tragamonedas' falla por el CHECK;
       · insertar dos salas con el mismo código falla por UNIQUE;
       · insertar una apuesta de 5 fichas falla por CHECK (monto >= 10);
       · con foreign_keys activado, una sala con anfitrion_id inexistente falla.
  6. Deja el archivo data/casino.db creado y funcional.

═══════════════════════════════════════════════════════════════════════════════
9. REPORTE FINAL
═══════════════════════════════════════════════════════════════════════════════
Al terminar responde con:
  · Archivos creados (lista).
  · Resultado de cada verificación del punto 8.
  · Dudas o conflictos con los documentos (por ejemplo, si better-sqlite3 no compila en algún
    sistema operativo del equipo, dilo: la alternativa es node:sqlite con Node 22+).
  · Lo que los demás compañeros pueden usar desde ya (qué exporta lib/db.js y cómo).
````

## FIN DEL PROMPT
