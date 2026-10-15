# Prompt de implementación · Backend 2

Pega este prompt en una conversación de Arena **con este repositorio montado**. Arena debe escribir
el código real de los tickets BE-04, BE-05 y BE-06.

---

## INICIO DEL PROMPT (copia desde aquí)

````text
Eres el desarrollador BACKEND 2 de este repositorio. Tu trabajo es IMPLEMENTAR el código de tres
tickets (no redactar documentos): las fases de una ronda, los resultados al azar y el manejo de
fichas. Son la base que usarán TODOS los juegos.

═══════════════════════════════════════════════════════════════════════════════
1. PROYECTO
═══════════════════════════════════════════════════════════════════════════════
"MonteCristo": casino social multijugador local. Salas de hasta 6 personas, código de 5 caracteres,
juegos Cara o Cruz, Dados, Ruleta (europea 0-36), Blackjack/21 y Texas Hold'em. Fichas 100 %
virtuales: no hay dinero real.

Stack: Node.js 18+, Express 4, Socket.IO 4, SQLite en archivo local (data/casino.db, abierta desde
lib/db.js con better-sqlite3), JavaScript vanilla en el cliente. Todo corre SOLO EN LOCAL.

═══════════════════════════════════════════════════════════════════════════════
2. ESTADO DEL REPOSITORIO
═══════════════════════════════════════════════════════════════════════════════
Trabajan en paralelo tres personas. Da por hecho que existen (o existirán muy pronto):
  - package.json, db/schema.sql, db/migrar.js y lib/db.js  → de BACKEND 1 (no los reescribas)
  - public/styles.css, public/index.html, public/perfil.html, public/app.js → de FRONTEND
Y que otro compañero hará server.js y la pantalla de la sala (integración).

═══════════════════════════════════════════════════════════════════════════════
3. LEE ESTO PRIMERO (es el contrato del proyecto)
═══════════════════════════════════════════════════════════════════════════════
  - docs/02-reglas-y-pagos.md → TU DOCUMENTO PRINCIPAL. Trae el convenio "pago total"
    (pago = truncar(apuesta × multiplicador), ganancia = pago − apuesta), las constantes
    (SALDO_INICIAL 1000, APUESTA_MINIMA 10, JUGADORES_POR_SALA 6, MAZOS_BLACKJACK 4, MAZOS_POKER 1,
    REBARAJAR_SI_QUEDAN_MENOS_DE 52, PLANTARSE_CASA 17, turnos de 25 s y 30 s), la tabla de
    multiplicadores (§8), los 20 casos de prueba (§9) y las 7 validaciones obligatorias (§10).
    NO inventes ni cambies ningún número: cítalos tal cual.
  - docs/03-modelo-de-datos.md → campos de partidas y apuestas (incluido semilla_rng).
  - docs/04-arquitectura.md → eventos de Socket.IO (§3.2 y §3.3), tiempos e idempotencia (§5) y
    reglas de seguridad (§6).
  - docs/01-alcance-y-requerimientos.md → roles y flujo de una sala (§8).

═══════════════════════════════════════════════════════════════════════════════
4. TUS TRES TICKETS
═══════════════════════════════════════════════════════════════════════════════
BE-04 · Programar las fases por las que pasa una ronda. Es la base que usan todos los juegos.
BE-05 · La función que saca los resultados al azar (cara o cruz, dado, ruleta, carta del mazo).
        Siempre corre en el servidor, nunca en el navegador, para que nadie pueda hacer trampa.
BE-06 · La función que descuenta fichas al apostar y acredita el premio según lo que pague el
        juego. Valida mínimo 10 fichas y saldo suficiente. Es la misma para todos los juegos.

═══════════════════════════════════════════════════════════════════════════════
5. ARCHIVOS QUE TE TOCAN (y los que NO)
═══════════════════════════════════════════════════════════════════════════════
CREAS TÚ:
  lib/reglas.js     → constantes compartidas (REGLAS, FASES, PAGOS). Eres el dueño: si otro
                      compañero la necesita, que la importe de aquí.
  lib/ronda.js      → máquina de estados de la ronda y transiciones válidas
  lib/rng.js        → resultados al azar + mazo (crearMazo, barajar, sacarCarta, crearRng)
  lib/fichas.js     → validar, apostar, liquidar, costoSeguro, reembolsar
  tests/ronda.test.js · tests/rng.test.js · tests/fichas.test.js

NO TOQUES: package.json (salvo agregar un script "test" si no existe), db/**, lib/db.js,
public/**, server.js ni docs/**. Si necesitas la base de datos, usa require('../lib/db.js') y da
por hecho que las tablas de docs/03 ya existen.

═══════════════════════════════════════════════════════════════════════════════
6. ESPECIFICACIÓN TÉCNICA
═══════════════════════════════════════════════════════════════════════════════
a) lib/reglas.js
   Exporta al menos:
     REGLAS = { SALDO_INICIAL: 1000, APUESTA_MINIMA: 10, JUGADORES_POR_SALA: 6,
                LONGITUD_CODIGO_SALA: 5, TIEMPO_TURNO_BLACKJACK_MS: 25000,
                TIEMPO_TURNO_POKER_MS: 30000, CIEGA_PEQUENA: 10, CIEGA_GRANDE: 20,
                MAZOS_BLACKJACK: 4, MAZOS_POKER: 1, REBARAJAR_SI_QUEDAN_MENOS_DE: 52,
                PLANTARSE_CASA: 17, TIEMPO_HOST_INACTIVO_MS: 60000 }
     FASES  = { ESPERA: 'espera', APUESTAS: 'apuestas', JUGANDO: 'jugando',
                RESULTADOS: 'resultados' }
     PAGOS  = { coinflip: { acierto: 2 }, dice: { bajo: 2, alto: 2, exacto: 6 },
                roulette: { pleno: 36, docena: 3, columna: 3, simple: 2 },
                blackjack: { victoria: 2, natural: 2.5, empate: 1, derrota: 0, seguro: 3 } }

b) BE-04 · Fases de la ronda (lib/ronda.js)
   · La fase se guarda en salas.fase y SOLO puede valer: 'espera', 'apuestas', 'jugando',
     'resultados'. La "vuelta a empezar" NO es un estado: es la transición de 'resultados' a
     'apuestas' al abrir la siguiente ronda.
   · No confundir con salas.estado ('abierta'/'cerrada'): son dos campos distintos.
   · Transiciones válidas (quién las dispara y la condición):
       (crear sala)      → 'espera'
       'espera'          → 'apuestas'  : automático al cumplirse el mínimo (1 jugador en rápidos y
                                         blackjack; 2 en Texas Hold'em) o al pulsar "Comenzar"
       'apuestas'        → 'jugando'   : SOLO el anfitrión (lanzar o repartir) y solo si al menos
                                         una persona confirmó apuesta
       'jugando'         → 'resultados': lo hace el SERVIDOR al generar el resultado y liquidar, o
                                         al terminar todos los turnos
       'resultados'      → 'apuestas'  : el anfitrión abre la nueva ronda; limpia apuestas, manos y
                                         temporizadores y incrementa numero_ronda
   · Reglas duras:
       - Toda acción fuera de su fase se rechaza con un error y sin cambiar el estado.
       - No se puede pasar de 'apuestas' a 'resultados' sin pasar por 'jugando'.
       - Nadie entra ni sale de la sala durante 'jugando'.
       - Temporizadores: 25 s por turno en blackjack (al vencer, se planta) y 30 s en póker (al
         vencer, pasa si puede y si no se retira). Juegos rápidos sin reloj.
       - Al cerrar la sala se cancelan temporizadores y tareas pendientes.
   · Expón funciones claras, por ejemplo: puedeTransicionar(desde, hasta), cambiarFase(sala, fase,
     motivo), fasePermiteAccion(fase, accion), abrirNuevaRonda(sala).
   · Deja el módulo listo para que server.js emita 'estado_sala', 'ronda_iniciada', 'turno' y
     'resultado' (docs/04 §3.3). Tú no creas esos eventos; solo el estado y las reglas.

c) BE-05 · Resultados al azar (lib/rng.js)
   · Funciones puras que reciben el generador por parámetro (por defecto Math.random) para poder
     probarlas con semilla:
       lanzarMoneda(rng) → 'cara' | 'cruz'   (50 % / 50 %)
       lanzarDado(rng)   → entero 1 a 6      (uniforme)
       girarRuleta(rng)  → { numero: 0..36, color: 'verde' | 'rojo' | 'negro' }
       crearMazo(cuantasBarajas, rng) → arreglo barajado
       sacarCarta(mazo)  → siguiente carta sin reposición (null si el mazo se vació)
       crearRng(semilla) → generador determinista (por ejemplo mulberry32)
   · Ruleta EUROPEA de 37 casillas. El 0 es 'verde'. Rojos exactos:
     1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36. El resto, negros.
   · Mazos: blackjack 4 barajas (208 cartas), póker 1 baraja (52). Se rebaraja cuando quedan menos
     de 52 cartas, antes de repartir. Carta = rango + palo (ejemplos: 'A♠', '10♥', 'K♦').
     Valores: A = 11 (o 1 si se pasa de 21), K/Q/J = 10, numéricas su valor.
   · Seguridad (déjalo por escrito en comentarios del código):
       - Ningún evento ni endpoint permite que el cliente envíe, elija o adelante un resultado.
       - El cliente recibe el resultado YA decidido y solo lo anima.
       - El mazo nunca se envía completo; cada quien recibe solo sus cartas.
   · Guarda la semilla de la ronda para poder repetir un caso (partidas.semilla_rng, docs/03).

d) BE-06 · Fichas (lib/fichas.js)
   · validarApuesta(saldo, monto) → { ok: true } | { ok: false, error }
       Rechaza si no es entero, si es menor que 10, si es mayor que el saldo, o si el jugador ya
       apostó en la ronda. Mensaje: "Apuesta entre 10 y tus fichas disponibles."
   · apostar({ jugadorId, partidaId, monto, opcion }) → descuenta del saldo, inserta la fila en
     apuestas y suma a partidas.bote_total. Todo dentro de una transacción de better-sqlite3
     (db.transaction(...)) para que ocurra completo o no ocurra.
   · liquidar(monto, multiplicador) → { pago, neto }
       pago = Math.floor(monto * multiplicador);  neto = pago − monto.
       Los multiplicadores salen de PAGOS (lib/reglas.js), nunca escritos a mano.
   · acreditar({ apuestaId, multiplicador, resultado }) → actualiza apuestas
     (multiplicador, pago, resultado) y suma el pago al saldo del jugador. Idempotente: si la
     apuesta ya está liquidada, no la vuelva a pagar.
   · costoSeguro(monto) → Math.ceil(monto / 2)   (blackjack, docs/02 §6)
   · reembolsar(apuestaId) → devuelve el monto si el jugador sale antes del lanzamiento.
   · Reglas: el saldo NUNDA queda negativo; una sola apuesta por jugador y ronda; una ronda se
     liquida una sola vez; truncar, no redondear (15 × 2,5 = 37).
   · TEXAS HOLD'EM QUEDA FUERA: el reparto del bote va en otro ticket. Deja liquidar() lista para
     reutilizarse y documenta con un comentario dónde entrará el póker.

═══════════════════════════════════════════════════════════════════════════════
7. REGLAS DE CONVIVENCIA
═══════════════════════════════════════════════════════════════════════════════
  1. No modifiques db/**, lib/db.js, public/**, server.js ni docs/**.
  2. No inventes reglas ni números: todo viene de docs/02.
  3. Código en español (nombres y mensajes), comillas simples, 2 espacios, punto y coma.
  4. Cada función pura y testeable por separado: sin depender de sockets ni de Express.

═══════════════════════════════════════════════════════════════════════════════
8. CÓMO VERIFICAR QUE TERMINASTE
═══════════════════════════════════════════════════════════════════════════════
  1. npm install
  2. npm run db:migrar   (si aún no existe la base, créala con el script de Backend 1)
  3. node --test tests/  →  todas las pruebas pasan:
       FASES:  las transiciones inválidas se rechazan (apuestas → resultados, resultados →
               jugando, espera → jugando); las válidas pasan; ninguna acción permitida fuera de
               su fase.
       RNG:    10 000 monedas dan entre 45 % y 55 % de caras; el dado solo da 1 a 6; la ruleta
               solo da 0 a 36 y el 0 es verde; con la misma semilla el resultado se repite; el
               mazo de blackjack tiene 208 cartas únicas; sacarCarta no devuelve la misma dos
               veces; se rebaraja al bajar de 52.
       FICHAS: los casos 1 a 18 de docs/02 §9 dan exactamente el pago y la ganancia indicados
               (incluido 15 × 2,5 = 37); apuesta de 9 se rechaza; apuesta mayor que el saldo se
               rechaza; el saldo nunca queda negativo; liquidar dos veces la misma apuesta solo
               paga una; reembolsar devuelve el monto íntegro.
  4. Comprueba que ningún módulo tuyo abre sockets ni toca Express.

═══════════════════════════════════════════════════════════════════════════════
9. REPORTE FINAL
═══════════════════════════════════════════════════════════════════════════════
  · Archivos creados y qué exporta cada uno (nombres de funciones y firmas).
  · Resultado de las verificaciones del punto 8.
  · Dudas o conflictos con los documentos (por ejemplo: si crees que falta algún estado en FASES,
    dilo por escrito, pero NO lo agregues sin autorización).
  · Qué debe llamar server.js para avanzar de fase, generar un resultado y liquidar una apuesta.
````

## FIN DEL PROMPT
