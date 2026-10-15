# Prompt de implementación · Integración (servidor y pantalla de la sala)

Este es el cuarto prompt. Es el que convierte las piezas de los demás en algo **jugable**: levanta
el servidor, conecta los módulos de backend y hace la pantalla de la sala.
Se lo das a quien sobre o lo repartes entre dos personas (servidor / sala).

---

## INICIO DEL PROMPT (copia desde aquí)

````text
Eres el desarrollador de INTEGRACIÓN de este repositorio. Los demás compañeros hicieron las piezas:
la base de datos (lib/db.js), las fases (lib/ronda.js), los resultados al azar (lib/rng.js), el
manejo de fichas (lib/fichas.js), las constantes (lib/reglas.js) y las pantallas de inicio y perfil
(public/styles.css, index.html, perfil.html, app.js). TU TRABAJO ES UNIRLAS: crear server.js y la
pantalla de la sala para que el proyecto sea jugable de principio a fin.

═══════════════════════════════════════════════════════════════════════════════
1. PROYECTO
═══════════════════════════════════════════════════════════════════════════════
"MonteCristo": casino social multijugador LOCAL. Salas de hasta 6 personas con código de 5
caracteres. Juegos: Cara o Cruz, Dados, Ruleta (europea 0-36), Blackjack/21 y Texas Hold'em.
Fichas 100 % virtuales, sin dinero real.

Stack: Node.js 18+, Express 4, Socket.IO 4, SQLite en archivo local (lib/db.js con better-sqlite3),
HTML/CSS/JavaScript puro en el cliente. Todo corre SOLO EN LOCAL: sin hosting, sin túneles, sin
servicios en la nube y sin internet.

═══════════════════════════════════════════════════════════════════════════════
2. QUÉ YA EXISTE (no lo reescribas: impórtalo y úsalo)
═══════════════════════════════════════════════════════════════════════════════
  lib/db.js       → conexión SQLite abierta (la exporta por module.exports)
  db/schema.sql   → tablas jugadores, salas, partidas, apuestas
  lib/reglas.js   → REGLAS, FASES, PAGOS (constantes oficiales)
  lib/ronda.js    → máquina de estados de la ronda (usa sus funciones de transición)
  lib/rng.js      → lanzarMoneda, lanzarDado, girarRuleta, crearMazo, sacarCarta, crearRng
  lib/fichas.js   → validarApuesta, apostar, liquidar, acreditar, costoSeguro, reembolsar
  public/styles.css, public/index.html, public/perfil.html, public/app.js → del FRONTEND
Si alguno NO existe todavía, da por hecho su interfaz según docs/03 y docs/04, créalo solo si te
bloquea por completo, y avísalo en tu reporte. Nunca reescribas el de otro.

═══════════════════════════════════════════════════════════════════════════════
3. LEE ESTO PRIMERO (es el contrato)
═══════════════════════════════════════════════════════════════════════════════
  - docs/04-arquitectura.md → TU DOCUMENTO PRINCIPAL: capas, endpoints HTTP (§3.1), eventos del
    cliente al servidor (§3.2) y del servidor al cliente (§3.3), secuencia de una ronda (§4),
    tiempos, reconexión e idempotencia (§5), seguridad (§6) y estructura de carpetas (§7).
  - docs/02-reglas-y-pagos.md → multiplicadores y validaciones. TÚ no calculas pagos: llamas a
    lib/fichas.js y lees los multiplicadores de lib/reglas.js (PAGOS).
  - docs/01-alcance-y-requerimientos.md → roles del anfitrión y del jugador (§6), flujo (§8) y
    reglas transversales (§7).
  - docs/03-modelo-de-datos.md → qué guardar en cada tabla y cuándo.

═══════════════════════════════════════════════════════════════════════════════
4. TUS TICKETS
═══════════════════════════════════════════════════════════════════════════════
INT-01 · server.js: Express + Socket.IO, endpoints HTTP y todos los eventos de la sala, usando los
        módulos de los demás y guardando en SQLite.
INT-02 · Pantalla de la sala (public/sala.html y public/sala.js): mesa, apuestas, botón de lanzar
        del anfitrión, resultados, saldos y chat, con las clases del styles.css del frontend.

ALCANCE DEL PRIMER MVP (respétalo para poder terminar):
  · Jugables de principio a fin: CARA O CRUZ, DADOS y RULETA (los tres juegos rápidos comparten el
    mismo ciclo: todos apuestan → el anfitrión lanza → el servidor resuelve y paga).
  · BLACKJACK y PÓKER quedan para la siguiente vuelta, pero deja los ganchos listos: la fase
    'jugando', el campo turno, el temporizador (25 s en blackjack / 30 s en póker) y el evento
    'turno' emitido sin romper nada. Documenta en comentarios dónde entra cada uno.

═══════════════════════════════════════════════════════════════════════════════
5. ARCHIVOS QUE TE TOCAN (y los que NO)
═══════════════════════════════════════════════════════════════════════════════
CREAS TÚ:
  server.js          → Express + Socket.IO + wiring de todo
  lib/salas.js       → estado de las salas en memoria (Map) y su persistencia en SQLite
  public/sala.html   → pantalla de la sala (estructura)
  public/sala.js     → lógica de la sala (socket, render y eventos)
  tests/servidor.test.js → prueba básica del ciclo completo sin navegador
NO TOQUES: db/**, lib/db.js, lib/reglas.js, lib/ronda.js, lib/rng.js, lib/fichas.js,
public/styles.css, public/index.html, public/perfil.html, public/app.js ni docs/**.
Usa las clases ya definidas en styles.css: no inventes colores nuevos.

═══════════════════════════════════════════════════════════════════════════════
6. ESPECIFICACIÓN TÉCNICA
═══════════════════════════════════════════════════════════════════════════════
a) Express (server.js)
   · Archivos estáticos: express.static('public').
   · GET /health            → { "ok": true }
   · GET /api/salas         → salas activas: codigo, juego, fase, ocupación y asientos libres
   · GET /api/salas/:codigo → si existe y cuántos asientos libres tiene
   · GET /                  → public/index.html
   · GET /sala/:codigo      → public/sala.html
   · Puerto de process.env.PORT, por defecto 3000. Al arrancar imprime la URL local.
   · El cliente de Socket.IO se sirve solo desde /socket.io/socket.io.js (no lo descargues).

b) Estado
   · Las salas viven en memoria en lib/salas.js (Map por código) para responder rápido, y se
     guardan en SQLite con lib/db.js en cada cambio importante (crear sala, entrar, salir,
     apostar, liquidar).
   · Al arrancar, carga de SQLite las salas con estado 'abierta' y sus jugadores.

c) Eventos del cliente al servidor (docs/04 §3.2). Todos responden con ack:
   { ok: true, ... } o { ok: false, error: '<mensaje en español>' }
   · crear_sala  { nombre, avatar, juego, deviceId? } → crea la sala con código de 5 caracteres
     (mayúsculas y números, único), fase 'espera', estado 'abierta', capacidad 6, apuesta mínima
     10; crea o recupera al jugador (saldo 1.000 si es nuevo) y lo marca anfitrión; une el socket a
     la sala y devuelve el código.
   · entrar_sala { codigo, nombre, avatar, deviceId? } → valida que exista, que esté 'abierta' y
     que no esté llena (máximo 6); asigna asiento libre; rechaza con mensaje claro si no.
   · salir_sala  → si la ronda no se lanzó, reembolsa la apuesta con lib/fichas.reembolsar; libera
     el asiento; si la sala queda vacía, pon estado 'cerrada' y elimínala.
   · apostar     { monto, opcion } → solo en fase 'apuestas'; valida con validarApuesta (entero,
     ≥ 10 y ≤ saldo); descuenta con apostar(); una sola apuesta por ronda; opciones válidas según
     el juego: coinflip 'cara'|'cruz'; dados 'bajo'|'alto'|'n:1'…'n:6'; ruleta 'rojo'|'negro'|
     'par'|'impar'|'bajo'|'alto'|'d1'|'d2'|'d3'|'c1'|'c2'|'c3'|'n:0'…'n:36'.
   · lanzar      → SOLO el anfitrión y solo en fase 'apuestas'; exige al menos una apuesta;
     cambia a 'jugando'; genera el resultado con lib/rng.js NUNCA con datos del cliente; liquida
     cada apuesta con lib/fichas (pago = truncar(monto × multiplicador)); guarda la ronda en
     partidas (con la semilla) y cada apuesta en apuestas; cambia a 'resultados' y emite el
     resultado. IDEMPOTENTE: si ya hay un lanzamiento en curso, ignora el segundo.
   · nueva_ronda → SOLO el anfitrión y solo en 'resultados': limpia manos y apuestas, incrementa
     numero_ronda y vuelve a 'apuestas'.
   · chat        { texto } → máximo 200 caracteres; se reenvía a la sala con nombre y hora.
   · Reservados para la siguiente vuelta (déjalos definidos pero sin lógica de juego):
     accion_blackjack, tomar_seguro, accion_poker.

d) Eventos del servidor al cliente (docs/04 §3.3)
   · estado_sala     → la sala completa (jugadores, fichas, fase, turno, apuestas) al entrar y
     después de CADA cambio.
   · ronda_iniciada  → { numeroRonda, juego }
   · resultado       → { resultado, apuestas: [{ jugadorId, monto, multiplicador, pago }] }
   · turno           → { jugadorId, deadline }   (reservado para blackjack y póker)
   · chat_mensaje    → { nombre, texto, hora }
   · error           → { mensaje, codigo }
   · sala_cerrada    → { motivo }
   · NUNCA envíes cartas de un jugador a otro (docs/04 §6).

e) Reglas que el servidor debe aplicar siempre
   · Validar fase, turno, monto, saldo y existencia del jugador antes de aceptar cualquier acción.
   · Solo el anfitrión lanza y abre rondas; si el anfitrión se desconecta más de 60 segundos, el
     rol migra al siguiente jugador conectado.
   · El saldo nunca queda negativo. Una ronda se liquida una sola vez.
   · Al desconectarse alguien, avisa a la sala; al reconectar, devuelve su asiento y su saldo.
   · Los mensajes de error van en español y son accionables ("Apuesta entre 10 y tus fichas
     disponibles.", "Solo el anfitrión puede lanzar.", "La sala está llena (máximo 6).").

f) Pantalla de la sala (public/sala.html y public/sala.js)
   · Lee el código de la sala de la URL (/sala/CODIGO) y el nombre, avatar y deviceId del jugador
     de localStorage; si no hay datos, vuelve a perfil.html.
   · Cabecera: nombre de la sala, juego, código con botón "Copiar enlace", y el aviso de fichas
     virtuales sin dinero real.
   · Mesa: hasta 6 asientos con avatar, nombre, fichas y estado (esperando / apostó X / listo).
     El asiento del anfitrión se marca.
   · Panel de apuesta: monto (mínimo 10, máximo el saldo) y las opciones del juego:
       Cara o Cruz → Cara / Cruz
       Dados       → Bajo (1-3) / Alto (4-6) / número exacto 1-6
       Ruleta      → Rojo / Negro / Par / Impar / 1-18 / 19-36 / docenas / columnas / pleno 0-36
     Botón "Confirmar apuesta". Tras confirmar, la apuesta queda bloqueada y se ve cuánto apostó.
   · Anfitrión: botón "Lanzar" (solo si hay al menos una apuesta y la fase es 'apuestas') y botón
     "Nueva ronda" cuando esté en 'resultados'. Los demás ven los botones deshabilitados.
   · Resultado: muestra el resultado (cara/cruz, número del dado, número y color de la ruleta) con
     una animación corta del resultado que MANDA el servidor, y una tabla con quién ganó, cuánto
     pagó y el saldo actualizado de cada quien.
   · Chat simple: lista de mensajes y campo para escribir.
   · Estados de conexión visibles: Conectando…, Conectado, Desconectado (reintento automático).
   · Todo con las clases de styles.css (sin colores propios) y navegable con teclado.

═══════════════════════════════════════════════════════════════════════════════
7. REGLAS DE CONVIVENCIA
═══════════════════════════════════════════════════════════════════════════════
  1. No modifiques los módulos de los demás ni las pantallas del frontend: impórtalos.
  2. No calcules pagos ni resultados: usa lib/fichas.js, lib/rng.js y lib/reglas.js.
  3. El servidor es la autoridad: ningún dato del cliente decide un resultado.
  4. Código en español, comillas simples, 2 espacios de sangría, punto y coma.

═══════════════════════════════════════════════════════════════════════════════
8. CÓMO VERIFICAR QUE TERMINASTE
═══════════════════════════════════════════════════════════════════════════════
  1. npm install && npm run db:migrar && npm start  → imprime la URL y "Base de datos conectada".
  2. Abre http://localhost:3000 → inicio → Crear sala → perfil (nombre y avatar) → sala.
  3. Abre una SEGUNDA ventana (normal o incógnito) → inicio → Entrar con código → misma sala.
     Ambas ventanas deben verse sincronizadas: asientos, fichas y avisos.
  4. Los dos apuestan; el anfitrión lanza; ambos ven el MISMO resultado y sus saldos cambian según
     docs/02 (por ejemplo 100 al rojo y sale rojo → +100).
  5. El anfitrión pulsa "Nueva ronda" y pueden volver a apostar.
  6. Cierra una ventana y recarga la otra: la sala sigue, el saldo se conserva (SQLite).
  7. Reinicia el servidor: los saldos y las salas 'abierta' siguen ahí.
  8. Prueba los errores: apostar 9 (rechaza), apostar más del saldo (rechaza), que un no anfitrión
     intente lanzar (rechaza), entrar con un código inexistente (rechaza), sala llena con 6
     (rechaza al séptimo).
  9. GET /health responde { "ok": true } y node --test tests/ pasa al menos la prueba del ciclo:
     crear sala → entrar → apostar → lanzar → liquidar → saldos correctos en SQLite.

═══════════════════════════════════════════════════════════════════════════════
9. REPORTE FINAL
═══════════════════════════════════════════════════════════════════════════════
  · Archivos creados y cómo se conectan con los módulos de los demás.
  · Resultado de las 9 verificaciones.
  · Qué módulo de otro compañero te faltó y cómo lo resolviste (qué diste por hecho).
  · Qué queda pendiente para blackjack y póker y dónde están los ganchos listos.
````

## FIN DEL PROMPT
