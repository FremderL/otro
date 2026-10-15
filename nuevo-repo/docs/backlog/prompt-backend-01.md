# Prompt para generar los tickets de Backend 1

Este archivo es **para ti, no para el repositorio final**: contiene el texto listo para copiar y
pegar en una nueva conversación y que ahí redacten los 3 tickets de Backend 1 con el mismo formato
que el resto de la documentación.

Cuando ya no lo necesites puedes borrar esta carpeta `docs/backlog/` o dejarla como histórico.

---

## INICIO DEL PROMPT (copia desde aquí)

```text
Eres un asistente que redacta tickets de desarrollo para un equipo escolar. Vas a escribir TRES
tickets en archivos Markdown. Tu trabajo es documentar, no programar: cada ticket debe quedar lo
suficientemente claro como para que otra persona lo implemente sin preguntar nada.

═══════════════════════════════════════════════════════════════════════════════
1. CONTEXTO DEL PROYECTO
═══════════════════════════════════════════════════════════════════════════════
"MonteCristo" es un casino social multijugador para jugar con amigos desde el navegador. Una
persona crea una sala, comparte un enlace o un código de 5 caracteres y hasta 6 personas juegan en
tiempo real. Las fichas son 100 % virtuales: no hay dinero real, depósitos ni premios canjeables.

Juegos incluidos: Cara o Cruz, Dados, Ruleta (europea 0-36), Blackjack/21 y Texas Hold'em.
Saldo inicial de cada jugador: 1.000 fichas. Apuesta mínima: 10 fichas.

Stack: Node.js 18 o superior, Express 4 (archivos estáticos y REST), Socket.IO 4 (tiempo real),
SQLite en un archivo local, JavaScript vanilla en el cliente (sin frameworks). Pruebas con node:test.

RESTRICCIÓN IMPORTANTE: el proyecto se desarrolla y se ejecuta SOLO EN LOCAL. No hay hosting,
dominio, túneles (ngrok), contenedores ni servicios en la nube. La base de datos es un archivo
SQLite en la propia computadora de quien corre el servidor.

ESTADO DEL REPOSITORIO: empieza de cero. Lo único que existe es:
  - public/assets/  → imágenes de los juegos y del casino (ya están, no las toques)
  - docs/           → la documentación (01 a 04) y el README
No hay package.json, ni server.js, ni HTML: todo se va a crear a partir de los tickets.

═══════════════════════════════════════════════════════════════════════════════
2. DOCUMENTOS QUE DEBES RESPETAR (son la fuente de la verdad)
═══════════════════════════════════════════════════════════════════════════════
  - docs/01-alcance-y-requerimientos.md → juegos, salas de 6 jugadores, roles (anfitrión, jugador,
    servidor) y reglas transversales. Documento base del proyecto.
  - docs/02-reglas-y-pagos.md → TODOS los números del juego: multiplicadores (Cara o Cruz x2,
    Dados x2 y x6, Ruleta x36/x3/x2, Blackjack x2 / x2,5 / x1 / x0 y seguro x3), constantes
    (SALDO_INICIAL 1000, APUESTA_MINIMA 10, JUGADORES_POR_SALA 6, ciegas 10/20, turnos de 25 s y
    30 s) y 20 casos de prueba. NUNCA inventes ni cambies estos números: si un ticket los
    necesita, cítalos tal cual.
  - docs/03-modelo-de-datos.md → el modelo entidad-relación completo: tablas jugadores, salas,
    partidas y apuestas, con campos, tipos, claves, el script db/schema.sql en SQLite y la forma
    de conectarse desde lib/db.js.
  - docs/04-arquitectura.md → capas (navegador / servidor / datos), endpoints HTTP, eventos de
    Socket.IO y estructura de carpetas.

═══════════════════════════════════════════════════════════════════════════════
3. DECISIONES YA TOMADAS (no las cambies, no las discutas, aplícalas)
═══════════════════════════════════════════════════════════════════════════════
  a) La base de datos es SQLite en un archivo local (data/casino.db). No se usa PostgreSQL,
     MySQL ni nada que haya que instalar o levantar como servicio.
  b) La sala tiene DOS campos distintos y los dos van en la tabla:
       · estado  → 'abierta' o 'cerrada'  (si admite o no participantes)
       · fase    → 'espera', 'apuestas', 'jugando', 'resultados' (momento de la ronda)
  c) Todo corre en local: la conexión se abre a un archivo, no a una red.
  d) La tabla de jugadores se llama "jugadores" y la de salas "salas", en minúsculas.

═══════════════════════════════════════════════════════════════════════════════
4. MATERIAL EN BRUTO QUE TE PASÓ EL COMPAÑERO DE BACKEND 1
═══════════════════════════════════════════════════════════════════════════════
Esto es exactamente lo que él dijo que va a hacer. Conviértelo en tres tickets formales:

  1) "Crear la base de datos del proyecto y escribir el codigo que la conecta desde el servidor.
     Debe avisar en la consola si la conexion funciono o si fallo."

  2) "Crear la tabla de jugadores con id, nombre, avatar, saldo y fecha de registro. Dejar el
     script SQL guardado en el repositorio"

  3) "Crear la tabla de salas con id, codigo de la sala, juego, anfitrion y estado (abierta o
     cerrada). Dejar el script SQL en el repositorio."

═══════════════════════════════════════════════════════════════════════════════
5. QUÉ DEBES ENTREGAR
═══════════════════════════════════════════════════════════════════════════════
Tres archivos Markdown, uno por ticket, en la carpeta docs/backlog/:

  docs/backlog/BE-01-conexion-base-de-datos.md
  docs/backlog/BE-02-tabla-jugadores.md
  docs/backlog/BE-03-tabla-salas.md

Cada archivo usa EXACTAMENTE esta plantilla:

  # Ticket BE-0X · <título corto>

  | Campo | Valor |
  | --- | --- |
  | **ID** | BE-0X |
  | **Área** | Backend 1 |
  | **Tipo** | Implementación |
  | **Estado** | Pendiente · listo para implementar |
  | **Prioridad** | Alta (bloquea a los demás tickets de backend) |
  | **Depende de** | <IDs o "—"> |
  | **Desbloquea** | <IDs o "—"> |
  | **Documento base** | docs/03-modelo-de-datos.md (y docs/01, docs/02, docs/04) |

  ## 1. Objetivo          → qué se logra con este ticket, en 2 o 3 líneas
  ## 2. Alcance           → "Sí incluye" y "No incluye" en dos listas
  ## 3. Especificación    → el detalle técnico (ver punto 6 de abajo)
  ## 4. Archivos a crear o modificar → rutas exactas dentro del repo
  ## 5. Criterios de aceptación → lista de casillas "- [ ]" verificables una por una
  ## 6. Fuera de este ticket → lo que NO le toca y en qué ticket cae
  ## 7. Notas y dudas     → supuestos que tuviste que hacer, o "—" si no hay

═══════════════════════════════════════════════════════════════════════════════
6. CONTENIDO TÉCNICO QUE CADA TICKET DEBE PRECISAR
═══════════════════════════════════════════════════════════════════════════════
BE-01 · Conexión a la base de datos
  · Motor: SQLite sobre el archivo data/casino.db, cuya ruta sale de la variable de entorno
    DB_FILE (valor por defecto: data/casino.db). La carpeta data/ se crea sola si no existe.
  · Librería: better-sqlite3 (API síncrona). Alternativa permitida: el módulo nativo node:sqlite,
    pero solo si el equipo usa Node 22 o superior; en ese caso hay que documentarlo.
  · La conexión se abre UNA SOLA VEZ en lib/db.js y se exporta para reutilizarla en todo el
    servidor. No se abre ni se cierra por consulta.
  · Al arrancar ejecuta: PRAGMA journal_mode = WAL;  y  PRAGMA foreign_keys = ON;
  · Aviso obligatorio en consola:
      - si conecta:  "✅ Base de datos conectada: <ruta>"
      - si falla:    "❌ No se pudo conectar la base de datos: <mensaje del error>"
    El servidor NO debe arrancar en silencio si la conexión falla.
  · Script de migración db/migrar.js que lee db/schema.sql, lo ejecuta de forma idempotente
    (CREATE TABLE IF NOT EXISTS) y registra en consola qué tablas creó o que ya existían.
    Se corre con: npm run db:migrar
  · package.json debe incluir el script "db:migrar": "node db/migrar.js" y la dependencia
    better-sqlite3.

BE-02 · Tabla de jugadores
  · Script SQL guardado en el repositorio (db/schema.sql), con SQLite y CREATE TABLE IF NOT EXISTS.
  · Campos mínimos pedidos por el compañero: id, nombre, avatar, saldo, fecha de registro.
  · Campos que además exige el modelo (docs/03) para que el resto del sistema funcione:
      sala_id (FK a salas), asiento (1-6), es_anfitrion, conectado, device_id (único),
      ultima_actividad.
  · Restricciones: saldo_fichas por defecto 1000 y nunca negativo (CHECK saldo_fichas >= 0);
      nombre obligatorio; avatar por defecto '🙂'; fechas en formato datetime('now').
  · Índice por sala_id para buscar rápido los jugadores de una sala.

BE-03 · Tabla de salas
  · Script SQL guardado en el repositorio (db/schema.sql), con SQLite y CREATE TABLE IF NOT EXISTS.
  · Campos mínimos pedidos: id, codigo, juego, anfitrion, estado (abierta o cerrada).
  · Campos que además exige el modelo: capacidad (por defecto 6, CHECK entre 1 y 6), fase
    (espera/apuestas/jugando/resultados), apuesta_minima (por defecto 10), creada_en,
    actualizada_en.
  · Restricciones: codigo ÚNICO; juego limitado a ('coinflip','dice','roulette','blackjack','poker');
      estado CHECK ('abierta','cerrada'); fase CHECK con los cuatro valores.
  · Deja MUY CLARO en el ticket que "estado" y "fase" son dos cosas distintas: estado dice si la
    sala admite participantes; fase dice en qué momento de la ronda está.
  · Llave foránea anfitrion_id → jugadores(id).

═══════════════════════════════════════════════════════════════════════════════
7. REGLAS PARA REDACTAR
═══════════════════════════════════════════════════════════════════════════════
  1. Escribe en español, en tono directo y sin relleno. Nada de "sería recomendable": usa
     "debe", "crea", "valida".
  2. No inventes reglas de juego ni números. Si el ticket toca pagos, saldos o tiempos, copia los
     valores de docs/02-reglas-y-pagos.md y cítalos.
  3. No agregues tablas que no estén en docs/03-modelo-de-datos.md. Las tablas "partidas" y
     "apuestas" NO son de estos tickets: menciónalas solo en "Fuera de este ticket" como trabajo
     futuro de otro ticket.
  4. Si el material del compañero contradice algo de los documentos, NO lo resuelvas por tu
     cuenta: inclúyelo en una sección "Conflictos detectados" al final del ticket, explicando qué
     dice cada fuente.
  5. Cada criterio de aceptación debe poder comprobarse con un sí o un no, sin interpretación.
  6. No crees código listo para producción: el ticket describe QUÉ hay que hacer; si incluyes un
     ejemplo, que sea corto, claramente marcado como referencia, y que no contradiga docs/03.
  7. No toques public/assets/, el README ni los documentos 01 a 04: solo escribes los tres
     archivos nuevos en docs/backlog/.

═══════════════════════════════════════════════════════════════════════════════
8. AL TERMINAR
═══════════════════════════════════════════════════════════════════════════════
Devuélveme un resumen con: los tres archivos creados, el objetivo de cada uno en una línea, y la
lista de conflictos o dudas que encontraste (o "sin conflictos" si no hubo ninguno). No ejecutes
comandos ni modifiques nada fuera de docs/backlog/.
```

## FIN DEL PROMPT
