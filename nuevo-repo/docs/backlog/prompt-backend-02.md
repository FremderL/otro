# Prompt para generar los tickets de Backend 2

Archivo auxiliar: contiene el texto listo para copiar y pegar en una nueva conversación y que ahí
redacten los 3 tickets de Backend 2 con el mismo formato que el resto de la documentación.
Puedes borrar `docs/backlog/` cuando ya no lo necesites.

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
Saldo inicial: 1.000 fichas. Apuesta mínima: 10 fichas.

Stack: Node.js 18+, Express 4, Socket.IO 4, SQLite en archivo local (data/casino.db, abierta desde
lib/db.js con better-sqlite3) y JavaScript vanilla en el cliente. Pruebas con node:test.

RESTRICCIÓN IMPORTANTE: el proyecto se desarrolla y se ejecuta SOLO EN LOCAL. No hay hosting,
dominio, túneles, contenedores ni servicios en la nube.

ESTADO DEL REPOSITORIO: empieza de cero. Lo único que existe es:
  - public/assets/  → imágenes de los juegos y del casino (ya están, no las toques)
  - docs/           → documentación 01 a 04, README y docs/backlog/ con los tickets ya escritos
Esta es la segunda tanda de tickets. Los tickets BE-01 (conexión a SQLite), BE-02 (tabla
jugadores) y BE-03 (tabla salas) pertenecen a otro compañero y sus tablas se dan por existentes:
no las vuelvas a definir, solo consúmelas.

═══════════════════════════════════════════════════════════════════════════════
2. DOCUMENTOS QUE DEBES RESPETAR (son la fuente de la verdad)
═══════════════════════════════════════════════════════════════════════════════
  - docs/01-alcance-y-requerimientos.md → juegos, salas de 6 jugadores, roles (anfitrión, jugador,
    servidor), flujo de una sala (§8) y reglas transversales (§7).
  - docs/02-reglas-y-pagos.md → TODOS los números: multiplicadores (Cara o Cruz x2, Dados x2 y x6,
    Ruleta x36/x3/x2, Blackjack x2 / x2,5 / x1 / x0 y seguro x3), constantes (SALDO_INICIAL 1000,
    APUESTA_MINIMA 10, JUGADORES_POR_SALA 6, MAZOS_BLACKJACK 4, MAZOS_POKER 1,
    REBARAJAR_SI_QUEDAN_MENOS_DE 52, PLANTARSE_CASA 17, turnos de 25 s y 30 s), el convenio
    "pago total" (pago = truncar(apuesta × multiplicador), ganancia = pago − apuesta), los 20
    casos de prueba (§9) y las 7 validaciones obligatorias (§10).
    NUNCA inventes ni cambies estos números: cítalos tal cual.
  - docs/03-modelo-de-datos.md → tablas jugadores, salas, partidas y apuestas con sus campos,
    tipos y claves; incluye db/schema.sql en SQLite y la forma de usar lib/db.js.
  - docs/04-arquitectura.md → capas, endpoints HTTP, eventos de Socket.IO (§3.2 y §3.3), tiempos,
    reconexión e idempotencia (§5), reglas de seguridad (§6) y estructura de carpetas (§7).

═══════════════════════════════════════════════════════════════════════════════
3. DECISIONES YA TOMADAS (no las cambies, no las discutas, aplícalas)
═══════════════════════════════════════════════════════════════════════════════
  a) Las fases de la ronda son CUATRO y se escriben exactamente así, en minúsculas:
     'espera' · 'apuestas' · 'jugando' · 'resultados'.
     La "vuelta a empezar" NO es un estado: es la transición automática de 'resultados' a
     'apuestas' cuando se abre la siguiente ronda.
  b) 'fase' (de la ronda) y 'estado' (de la sala: 'abierta' o 'cerrada') son DOS CAMPOS DISTINTOS
     de la tabla salas. No los fusiones.
  c) La función de apuesta y liquidación cubre los juegos rápidos (Cara o Cruz, Dados, Ruleta) y
     Blackjack. TEXAS HOLD'EM QUEDA FUERA: el reparto del bote, los botes laterales y la ficha
     sobrante van en otro ticket. La función debe quedar reutilizable para cuando llegue.
  d) Todo resultado aleatorio se genera en el servidor. Nunca en el navegador. Nunca por petición
     del cliente. El cliente solo recibe el resultado ya decidido y lo anima.
  e) Todo corre en local: la base de datos es un archivo, no un servicio de red.

═══════════════════════════════════════════════════════════════════════════════
4. MATERIAL EN BRUTO QUE TE PASÓ EL COMPAÑERO DE BACKEND 2
═══════════════════════════════════════════════════════════════════════════════
Esto es exactamente lo que él dijo que va a hacer. Conviértelo en tres tickets formales:

  1) "Programar las fases por las que pasa una ronda: esperando jugadores, recibiendo apuestas,
     mostrando el resultado y vuelta a empezar. Es la base que van a usar todos los juegos."

  2) "Hacer la funcion que saca los resultados al azar (cara o cruz, numero del dado, numero de la
     ruleta, carta del mazo). Siempre corre en el servidor, nunca en el navegador, para que nadie
     pueda hacer trampa."

  3) "Programar la funcion que descuenta las fichas al apostar y acredita el premio segun lo que
     pague el juego. Antes de aceptar la apuesta revisa que sea de minimo 10 fichas y que al
     jugador le alcance el saldo. Es la misma funcion para todos los juegos."

═══════════════════════════════════════════════════════════════════════════════
5. QUÉ DEBES ENTREGAR
═══════════════════════════════════════════════════════════════════════════════
Tres archivos Markdown, uno por ticket, en la carpeta docs/backlog/:

  docs/backlog/BE-04-fases-de-la-ronda.md
  docs/backlog/BE-05-resultados-al-azar.md
  docs/backlog/BE-06-apostar-y-liquidar.md

Cada archivo usa EXACTAMENTE esta plantilla:

  # Ticket BE-0X · <título corto>

  | Campo | Valor |
  | --- | --- |
  | **ID** | BE-0X |
  | **Área** | Backend 2 |
  | **Tipo** | Implementación |
  | **Estado** | Pendiente · listo para implementar |
  | **Prioridad** | Alta |
  | **Depende de** | BE-01 (conexión), BE-02 (tabla jugadores), BE-03 (tabla salas) |
  | **Desbloquea** | <IDs de los tickets de juegos, o "todos los juegos"> |
  | **Documento base** | docs/02-reglas-y-pagos.md y docs/04-arquitectura.md |

  ## 1. Objetivo
  ## 2. Alcance            → "Sí incluye" y "No incluye" en dos listas
  ## 3. Especificación     → el detalle técnico (ver punto 6)
  ## 4. Archivos a crear o modificar → rutas exactas dentro del repo
  ## 5. Criterios de aceptación → lista de casillas "- [ ]" verificables una por una
  ## 6. Fuera de este ticket → lo que NO le toca y en qué ticket cae
  ## 7. Notas y dudas      → supuestos que hiciste, o "—"

═══════════════════════════════════════════════════════════════════════════════
6. CONTENIDO TÉCNICO QUE CADA TICKET DEBE PRECISAR
═══════════════════════════════════════════════════════════════════════════════
BE-04 · Fases de la ronda
  · Estado único de la ronda: un campo 'fase' en la sala, con los cuatro valores del punto 3a.
    Debe vivir en un solo lugar (constante FASES en lib/reglas.js) para que ningún módulo invente
    un quinto nombre. El valor se persiste en salas.fase.
  · Tabla obligatoria de transiciones. Para cada una indica: fase de origen, fase destino, quién la
    dispara y la condición:
      - (crear sala) → 'espera'
      - 'espera' → 'apuestas': automático al cumplirse el mínimo de jugadores (1 en juegos rápidos
        y blackjack; 2 en Texas Hold'em) o cuando el anfitrión pulse "Comenzar".
      - 'apuestas' → 'jugando': solo el ANFITRIÓN (lanzar la moneda/dado/ruleta o repartir cartas)
        y solo si al menos una persona confirmó apuesta. Rechaza a cualquier otro con un error.
      - 'jugando' → 'resultados': lo hace el SERVIDOR, nunca el cliente: cuando se generó el
        resultado y se liquidó la ronda, o cuando terminaron todos los turnos.
      - 'resultados' → 'apuestas': el anfitrión pulsa "Nueva ronda" (o automático tras N segundos,
        indícalo como decisión abierta). Limpia apuestas, manos y temporizadores, y incrementa
        numero_ronda en partidas.
  · Reglas de la máquina de estados:
      - Ninguna acción válida fuera de su fase: apostar solo en 'apuestas'; pedir/plantarse/igualar
        solo en 'jugando'; abrir otra ronda solo en 'resultados'. Toda acción fuera de fase se
        rechaza con un mensaje, sin cambiar el estado.
      - No se puede pasar de 'apuestas' a 'resultados' sin pasar por 'jugando'.
      - Nadie entra ni sale de la sala durante 'jugando' (plantilla bloqueada); si alguien se
        desconecta en 'jugando', su mano se marca inactiva y continúa la ronda.
      - Temporizadores: 25 s por turno en blackjack (al vencer se planta) y 30 s en póker (al
        vencer pasa si puede, si no se retira). Los juegos rápidos no tienen reloj.
      - Al cerrar una sala (estado='cerrada') se cancelan temporizadores y tareas pendientes.
  · Difusión: después de CADA cambio de fase el servidor emite 'estado_sala' con la sala completa,
    y los eventos 'ronda_iniciada', 'turno' y 'resultado' según corresponda (docs/04 §3.3).
  · Archivos sugeridos: lib/ronda.js (máquina de estados y transiciones válidas), lib/reglas.js
    (constante FASES), integración en server.js y en lib/juegos/*.js.

BE-05 · Resultados al azar en el servidor
  · Módulo lib/rng.js con funciones puras que reciben el generador por parámetro (por defecto
    Math.random) para poder probarlas con una semilla fija:
      lanzarMoneda(rng) → 'cara' | 'cruz'          (50 % / 50 %)
      lanzarDado(rng)   → entero de 1 a 6          (uniforme)
      girarRuleta(rng)  → { numero: 0..36, color: 'verde'|'rojo'|'negro' }
      crearMazo(cuantasBarajas) → arreglo barajado (solo servidor)
      sacarCarta(mazo)  → la siguiente carta, sin reposición, o null si el mazo se vació
  · La ruleta es EUROPEA: 37 casillas (0-36). El 0 es 'verde'. Los rojos son exactamente:
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36. El resto son negros.
  · El mazo: BLACKJACK usa 4 barajas (208 cartas) y PÓKER 1 baraja (52). Se rebaraja cuando quedan
    MENOS de 52 cartas, antes de repartir. Carta = rango + palo (ejemplos: 'A♠', '10♥', 'K♦').
    Valores: A = 11 (o 1 si se pasa de 21), K/Q/J = 10, numéricas su valor.
  · Semilla y pruebas: cada función debe poder recibir una semilla (crearRng(semilla)) y el
    servidor guarda la semilla de la ronda en partidas.semilla_rng (docs/03) para poder repetir un
    caso exacto. Incluye casos de prueba con semilla fija.
  · Seguridad (déjalo explícito en el ticket):
      - Ningún evento ni endpoint permite que el cliente envíe, elija o adelante un resultado.
      - El cliente recibe el resultado YA decidido y solo lo anima (docs/04 regla de oro).
      - El mazo nunca se envía completo al cliente; cada quien recibe solo sus cartas.
      - Las animaciones de ruleta y dados no pueden cambiar el número: muestran el del servidor.
  · Archivos sugeridos: lib/rng.js y su prueba tests/rng.test.js.

BE-06 · Apostar y liquidar fichas (juegos rápidos y blackjack; SIN póker)
  · Módulo lib/fichas.js con UNA SOLA función de validación y liquidación reutilizable:
      validarApuesta(saldo, monto) → { ok: true } | { ok: false, error: '<mensaje>' }
        Rechaza si: no es entero, es menor que 10 (APUESTA_MINIMA), es mayor que el saldo
        disponible, o el jugador ya apostó en esta ronda. Mensaje sugerido:
        "Apuesta entre 10 y tus fichas disponibles."
      apostar(jugadorId, partidaId, monto, opcion)
        Descuenta las fichas al confirmar, crea la fila en 'apuestas' y suma a partidas.bote_total.
      liquidar(monto, multiplicador) → { pago, neto }
        pago = Math.floor(monto * multiplicador);  neto = pago − monto.   (docs/02 §1)
      costoSeguro(monto) → Math.ceil(monto / 2)      (blackjack, docs/02 §6)
      reembolsar(apuestaId) → devuelve el monto si el jugador sale antes del lanzamiento.
  · Los multiplicadores NO se escriben aquí: se leen de la tabla de docs/02 §8. El ticket debe
    incluir la tabla resumen (Cara o Cruz x2; Dados x2 y x6; Ruleta x36, x3 y x2; Blackjack x2,
    x2,5, x1, x0 y seguro x3) y decir que el valor sale de lib/reglas.js.
  · Persistencia (depende de BE-02 y BE-03): al apostar, UPDATE jugadores.saldo_fichas e INSERT en
    apuestas (monto, opcion); al liquidar, UPDATE apuestas (multiplicador, pago, resultado) y
    UPDATE jugadores.saldo_fichas. Usa una transacción de better-sqlite3 para que el descuento y
    el registro de la apuesta ocurran juntos o no ocurran.
  · Reglas que el ticket debe dejar claras:
      - El saldo NUNCA puede quedar negativo (CHECK de la tabla + validación previa).
      - Una sola apuesta por jugador por ronda (UNIQUE partida_id + jugador_id).
      - Idempotencia: una ronda se liquida UNA SOLA vez, aunque lleguen dos "lanzar" repetidos.
      - Si el jugador sale antes del lanzamiento se le reembolsa; si ya se lanzó, no.
      - Truncar, no redondear: apuesta 15 × 2,5 = 37 fichas (no 38).
      - Texas Hold'em NO entra: el reparto del bote va en otro ticket, pero liquidar() debe quedar
        lista para reutilizarse.
  · Mensajes de error en español y accionables: "Apuesta entre 10 y tus fichas disponibles.",
    "Ya confirmaste tu apuesta para esta ronda.", "Ahora no se puede apostar."
  · Archivos sugeridos: lib/fichas.js y tests/fichas.test.js con los casos 1 a 20 de docs/02 §9
    (los de blackjack y validación incluidos; omite el 7 si prefieres no usar póker).

═══════════════════════════════════════════════════════════════════════════════
7. REGLAS PARA REDACTAR
═══════════════════════════════════════════════════════════════════════════════
  1. Español, tono directo, sin relleno. Usa "debe", "crea", "valida"; evita "sería recomendable".
  2. No inventes reglas ni números: si el ticket toca pagos, saldos, tiempos, mazos o
     multiplicadores, copia los valores de docs/02-reglas-y-pagos.md y cítalos.
  3. No redefinas las tablas jugadores ni salas: son de BE-02 y BE-03. Solo consúmelas.
  4. Si el material del compañero contradice los documentos, NO lo resuelvas por tu cuenta:
     ponlo en una sección "Conflictos detectados" al final del ticket explicando ambas fuentes.
     (Ya hay uno identificado: él describe cuatro fases sin la fase 'jugando' y con otros nombres;
     usa el enum de docs/03 y explica el cambio en esa sección.)
  5. Cada criterio de aceptación se comprueba con sí o no, sin interpretación.
  6. Si incluyes código, que sea un ejemplo corto y marcado como referencia, nunca una
     implementación completa.
  7. No toques public/assets/, el README, los documentos 01 a 04 ni los tickets BE-01 a BE-03:
     solo escribes los tres archivos nuevos en docs/backlog/.

═══════════════════════════════════════════════════════════════════════════════
8. AL TERMINAR
═══════════════════════════════════════════════════════════════════════════════
Devuélveme un resumen con: los tres archivos creados, el objetivo de cada uno en una línea, y la
lista de conflictos o dudas (o "sin conflictos"). No ejecutes comandos ni modifiques nada fuera de
docs/backlog/.
```

## FIN DEL PROMPT
