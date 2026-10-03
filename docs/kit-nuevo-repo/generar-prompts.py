#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera PROMPTS-POR-TICKET.txt: un prompt listo para copiar y pegar por cada
uno de los 40 tickets del proyecto.

Cada prompt es independiente (ya trae el contexto adentro) para que cualquier
integrante del equipo lo pegue tal cual y obtenga un resultado parecido.

Uso: python3 docs/kit-nuevo-repo/generar-prompts.py
"""

import os
import textwrap

CONTEXTO = """Trabajo en un proyecto escolar llamado MonteCristo: una pagina web de casino social con \
fichas virtuales (sin dinero real), donde un grupo de amigos crea una sala privada, la comparte con un \
codigo de 5 caracteres y juegan juntos. Maximo 6 jugadores por sala. Los juegos son: cara o cruz, dados, \
ruleta y blackjack. Saldo inicial de cada jugador: 1000 fichas. Apuesta minima: 10 fichas.

Tecnologias: Node.js con Express, Socket.IO para el tiempo real, MySQL para la base de datos, y HTML, CSS \
y JavaScript puro en el navegador (sin frameworks). Estructura del repositorio: server.js en la raiz, el \
codigo del servidor en src/, el del navegador en public/ y la documentacion en docs/.

Importante: todas las decisiones del juego (resultados, pagos, turnos) se calculan en el servidor, nunca \
en el navegador. Es un proyecto de escuela: no quiero panel de administracion, moderacion, reportes, \
login con contrasena ni seguridad avanzada."""

REGLAS_CODIGO = """Reglas de entrega (respetalas al pie de la letra):
- Haz SOLO lo que pide este ticket. No adelantes trabajo de otros tickets.
- No generes documentacion, README, diagramas ni archivos extra: unicamente el codigo de este ticket.
- No hagas commits, no crees ramas y NO abras pull requests. Yo subo los cambios a mano.
- Al terminar, dejame un archivo .zip para descargar con unicamente los archivos nuevos o modificados de
  este ticket, respetando las rutas de carpetas (por ejemplo src/juegos/dados.js).
- Dime en una lista corta que archivo va en que carpeta.
- Explicame en 3 o 4 lineas que hiciste y por que, para poder defenderlo con mi profesor."""

REGLAS_DOC = """Reglas de entrega (respetalas al pie de la letra):
- Haz SOLO lo que pide este ticket.
- No hagas commits, no crees ramas y NO abras pull requests. Yo subo los cambios a mano.
- Entregame dentro de un archivo .zip para descargar todo lo que te pedi: el documento en Markdown
  y, si en los detalles pedi una imagen, tambien el archivo PNG.
- No agregues codigo ni otros documentos que no haya pedido.
- Usa lenguaje claro de estudiante, no de consultora."""

# (numero, titulo, tipo, tarea, detalles[])
TICKETS = [
    (1, "Escribir el documento de requerimientos", "doc",
     "Escribeme el documento de requerimientos del proyecto, de maximo 2 hojas, en el archivo "
     "docs/requerimientos.md.",
     ["Que incluya: objetivo del proyecto, a quien va dirigido y alcance (lo que si va y lo que no va).",
      "Lista de requerimientos funcionales numerados (RF1, RF2...) sobre salas, jugadores, apuestas y chat.",
      "Lista corta de requerimientos no funcionales (navegador de escritorio, tiempo de respuesta, "
      "que las fichas sean virtuales).",
      "Una tabla con los 4 juegos y lo que paga cada apuesta."]),

    (2, "Definir las reglas de cada juego", "doc",
     "Escribeme el documento docs/reglas-de-los-juegos.md con las reglas y los pagos de los cuatro juegos.",
     ["Cara o cruz: apuesta a cara o cruz, paga x2.",
      "Dados: bajo (1-3) o alto (4-6) paga x2; numero exacto paga x6.",
      "Ruleta: rojo/negro y par/impar pagan x2; numero exacto del 0 al 36 paga x36; el cero hace perder "
      "las apuestas de color y de par o impar.",
      "Blackjack: se juega contra la casa, la casa pide hasta 17, el as vale 1 u 11 y el blackjack natural paga 3:2.",
      "Para cada juego: como se apuesta, como se gana y una tabla de pagos con un ejemplo numerico."]),

    (3, "Hacer el diagrama de la base de datos", "doc",
     "Hazme el diagrama entidad-relacion de la base de datos, en texto Y como imagen.",
     ["Tablas: jugadores, salas y partidas.",
      "jugadores: id, nombre, avatar, saldo, fecha_registro.",
      "salas: id, codigo, juego, id_anfitrion, estado, fecha_creacion.",
      "partidas: id, id_sala, id_jugador, juego, apuesta, resultado, ganancia, fecha.",
      "Marca las llaves primarias y foraneas, y explica en 3 lineas como se relacionan.",
      "Primero dame el diagrama en texto con sintaxis de Mermaid (bloque erDiagram) en el archivo "
      "docs/diagrama-base-de-datos.md.",
      "Y ademas GENERAME LA IMAGEN del diagrama en PNG, en docs/diagrama-base-de-datos.png, con las "
      "tres tablas en recuadros, sus campos listados, las llaves marcadas y las lineas de relacion "
      "con su cardinalidad (uno a muchos). Que se vea limpio y se lea bien impreso en blanco y negro.",
      "Incluye los dos archivos (el .md y el .png) en el zip."]),

    (4, "Hacer el diagrama de arquitectura de la pagina", "doc",
     "Hazme el diagrama de arquitectura de la pagina, en texto Y como imagen.",
     ["Debe mostrar: navegador (HTML, CSS, JS), servidor Node con Express y Socket.IO, y la base de datos MySQL.",
      "Marca con flechas que viaja por HTTP y que viaja por Socket.IO.",
      "Primero dame el diagrama en texto con sintaxis de Mermaid (flowchart) en el archivo "
      "docs/diagrama-arquitectura.md.",
      "Y ademas GENERAME LA IMAGEN del diagrama en PNG, en docs/diagrama-arquitectura.png, con los tres "
      "bloques, las flechas etiquetadas y que se entienda de un vistazo.",
      "Abajo del diagrama en el .md, explica en un parrafo corto el recorrido de una apuesta desde que "
      "el jugador da clic hasta que ve el resultado.",
      "Incluye los dos archivos (el .md y el .png) en el zip."]),

    (5, "Escribir el README del repositorio", "doc",
     "Escribeme el README.md del repositorio.",
     ["Secciones: que es el proyecto, tecnologias usadas, como instalarlo, como ejecutarlo y quienes "
      "somos el equipo (dejame los nombres como PENDIENTE para llenarlos yo).",
      "Los pasos de instalacion deben ir numerados e incluir los comandos exactos (npm install, "
      "crear la base de datos, npm start).",
      "Agrega un apartado corto que aclare que las fichas son virtuales y no hay dinero real.",
      "Que sea corto y legible, no un README gigante."]),

    (6, "Crear la base de datos y conectarla al servidor", "codigo",
     "Hazme la conexion a la base de datos MySQL desde el servidor.",
     ["Crea src/db/conexion.js usando el paquete mysql2 con un pool de conexiones.",
      "Los datos de conexion se leen de variables de entorno (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) "
      "con valores por defecto para desarrollo; usa dotenv.",
      "Al arrancar, el servidor debe imprimir en consola si la conexion funciono o el error si fallo.",
      "Incluye tambien el archivo .env.example con las variables vacias y agrega .env al .gitignore.",
      "Dame el comando SQL para crear la base de datos vacia."]),

    (7, "Crear la tabla de jugadores", "codigo",
     "Hazme el script SQL de la tabla de jugadores.",
     ["Archivo: src/db/sql/01_jugadores.sql.",
      "Campos: id (entero autoincremental, llave primaria), nombre (varchar 30), avatar (varchar 50), "
      "saldo (entero, por defecto 1000), fecha_registro (datetime por defecto la fecha actual).",
      "Usa CREATE TABLE IF NOT EXISTS para poder correrlo varias veces sin error.",
      "Agrega 2 INSERT de ejemplo comentados al final."]),

    (8, "Crear la tabla de salas", "codigo",
     "Hazme el script SQL de la tabla de salas.",
     ["Archivo: src/db/sql/02_salas.sql.",
      "Campos: id, codigo (varchar 5, unico), juego (varchar 20), id_anfitrion (entero, llave foranea a "
      "jugadores), estado (varchar 10, 'abierta' o 'cerrada'), fecha_creacion.",
      "Usa CREATE TABLE IF NOT EXISTS y declara la llave foranea.",
      "Explicame en 2 lineas por que el codigo debe ser unico."]),

    (9, "Crear la tabla de partidas jugadas", "codigo",
     "Hazme el script SQL de la tabla de partidas y la funcion que guarda una ronda terminada.",
     ["Archivo SQL: src/db/sql/03_partidas.sql, con campos id, id_sala, id_jugador, juego, apuesta, "
      "resultado (varchar: 'gano', 'perdio', 'empate'), ganancia y fecha.",
      "Archivo JS: src/db/partidas.js con la funcion guardarPartida(datos) que inserta una fila.",
      "La funcion debe usar consultas preparadas (con ?) y no concatenar texto.",
      "Agrega la funcion obtenerUltimasPartidas(idSala, limite) que regresa las ultimas rondas de una sala."]),

    (10, "Funciones para guardar y consultar jugadores", "codigo",
     "Hazme el archivo src/db/jugadores.js con las funciones basicas para manejar jugadores.",
     ["Funciones: crearJugador(nombre, avatar), obtenerJugadorPorId(id), "
      "actualizarPerfil(id, nombre, avatar) y actualizarSaldo(id, nuevoSaldo).",
      "Todas usan el pool de src/db/conexion.js y consultas preparadas con ?.",
      "Las funciones son async y regresan el jugador ya listo como objeto, no el resultado crudo de MySQL.",
      "Si un jugador no existe, que regrese null en vez de lanzar error."]),

    (11, "Crear el proyecto de Node con Express", "codigo",
     "Inicia el proyecto de Node con Express y dejalo arrancando.",
     ["Crea package.json con el script start que corre server.js, y el nombre montecristo.",
      "Crea server.js con un servidor Express que escuche en el puerto 3000 (o el de la variable PORT).",
      "Que sirva los archivos estaticos de la carpeta public.",
      "Crea un public/index.html minimo que diga 'MonteCristo' para comprobar que funciona.",
      "Dime que comandos tengo que correr para instalarlo y probarlo."]),

    (12, "Conectar el servidor y el navegador con Socket.IO", "codigo",
     "Agrega Socket.IO al proyecto y deja la conexion funcionando de los dos lados.",
     ["En server.js: monta Socket.IO sobre el mismo servidor HTTP de Express.",
      "Cuando un navegador se conecta, el servidor imprime en consola el id del socket y le manda un "
      "evento 'bienvenida' con el nombre del servidor.",
      "En public/app.js: conecta con Socket.IO, escucha 'bienvenida' y muestra en pantalla si esta "
      "conectado o desconectado.",
      "Maneja tambien el evento de desconexion en los dos lados."]),

    (13, "Rutas de la API para el jugador", "codigo",
     "Hazme las rutas HTTP para crear y consultar jugadores.",
     ["Archivo: src/rutas/jugadores.js usando express.Router, montado en server.js bajo /api/jugadores.",
      "POST /api/jugadores crea un jugador con nombre y avatar y regresa sus datos con el id.",
      "GET /api/jugadores/:id regresa los datos del jugador o 404 si no existe.",
      "PUT /api/jugadores/:id actualiza nombre y avatar.",
      "Valida que el nombre no venga vacio y que tenga maximo 30 caracteres; si no, responde 400 con un mensaje.",
      "Usa las funciones de src/db/jugadores.js, no escribas SQL aqui."]),

    (14, "Dar saldo inicial y guardarlo", "codigo",
     "Haz que un jugador nuevo arranque con 1000 fichas y que el saldo se guarde en la base de datos.",
     ["Al crear un jugador, el saldo inicial es 1000 (que sea una constante, no un numero suelto en el codigo).",
      "Crea la funcion cambiarSaldo(idJugador, cantidad) que suma o resta fichas y guarda en la base de datos.",
      "La funcion nunca debe dejar el saldo en negativo: si no alcanza, regresa un error.",
      "Agrega la ruta GET /api/jugadores/:id/saldo que regresa el saldo actual."]),

    (15, "Crear la estructura de una sala en el servidor", "codigo",
     "Hazme el archivo src/sala.js con la estructura de una sala en memoria.",
     ["Una sala guarda: codigo, juego, id del anfitrion, lista de jugadores (maximo 6), fase actual y "
      "las apuestas de la ronda.",
      "Las fases posibles son: 'esperando', 'apostando', 'jugando' y 'resultados'.",
      "Incluye un objeto o Map llamado salas donde se guardan todas las salas activas por su codigo.",
      "Funciones: crearSala(juego, anfitrion), obtenerSala(codigo) y eliminarSala(codigo).",
      "Todavia no conectes nada de Socket.IO aqui: solo la estructura y sus funciones."]),

    (16, "Generar el codigo de sala de 5 caracteres", "codigo",
     "Hazme la funcion que genera el codigo de 5 caracteres de cada sala.",
     ["Archivo: src/utilidades/codigo.js con la funcion generarCodigo().",
      "Usa letras mayusculas y numeros, pero quita los caracteres que se confunden (O, 0, I, 1).",
      "Debe revisar que el codigo no exista ya entre las salas activas; si existe, genera otro.",
      "Agrega una funcion normalizarCodigo(texto) que quite espacios y lo pase a mayusculas, para que "
      "entrar con el codigo no distinga mayusculas de minusculas."]),

    (17, "Unir y sacar jugadores de una sala", "codigo",
     "Programa la logica para que un jugador entre y salga de una sala.",
     ["En src/sala.js agrega: unirJugador(codigo, jugador) y sacarJugador(codigo, idJugador).",
      "No se puede entrar si la sala ya tiene 6 jugadores: regresa un error claro.",
      "No se puede entrar dos veces con el mismo jugador.",
      "Si sale el anfitrion, el rol pasa al siguiente jugador de la lista.",
      "Si la sala se queda sin jugadores, se elimina.",
      "Conectalo con los eventos de Socket.IO 'unirse-sala' y 'salir-sala'."]),

    (18, "Avisar a todos los de la sala cuando algo cambia", "codigo",
     "Haz que el servidor mande el estado de la sala a todos sus jugadores cuando algo cambia.",
     ["Usa los rooms de Socket.IO: cada sala es un room con su codigo.",
      "Crea la funcion enviarEstado(codigoSala) que arma el estado y lo manda con el evento 'estado-sala'.",
      "El estado incluye: codigo, juego, fase, lista de jugadores (id, nombre, avatar, saldo) y quien es el anfitrion.",
      "Llamala cada vez que alguien entra, sale o apuesta.",
      "En public/app.js escucha 'estado-sala' y guarda el estado en una variable para dibujarlo despues."]),

    (19, "Ciclo de la ronda: esperar, apostar y resultado", "codigo",
     "Programa el ciclo de una ronda, que van a usar todos los juegos.",
     ["Archivo: src/ronda.js.",
      "Fases en orden: 'esperando' -> 'apostando' -> 'resultados' -> vuelve a 'esperando'.",
      "Solo el anfitrion puede iniciar la ronda (evento 'iniciar-ronda') y lanzarla (evento 'lanzar-ronda').",
      "Cada jugador manda una sola apuesta por ronda con el evento 'apostar' (opcion e importe).",
      "Al lanzar, el servidor calcula el resultado, liquida las apuestas y manda el evento 'resultado-ronda'.",
      "Hazlo generico: que reciba la funcion del juego como parametro, para no repetir este codigo en cada juego."]),

    (20, "Funcion de numeros aleatorios del servidor", "codigo",
     "Hazme el archivo src/utilidades/azar.js con las funciones de azar del juego.",
     ["Funciones: numeroEntre(min, max), elegirDeLista(lista) y revolver(lista) (para barajar).",
      "Usa el modulo crypto de Node (randomInt) en vez de Math.random, y explicame en 2 lineas por que es mejor.",
      "Todas estas funciones solo corren en el servidor; agrega un comentario que lo deje claro.",
      "Dejalas listas para que las usen los cuatro juegos."]),

    (21, "Funcion que cobra la apuesta y paga el premio", "codigo",
     "Hazme la funcion que maneja el dinero virtual de una apuesta.",
     ["Archivo: src/apuestas.js.",
      "Funcion validarApuesta(jugador, importe): revisa que sea un numero entero, de minimo 10 fichas y "
      "que al jugador le alcance el saldo.",
      "Funcion cobrarApuesta(jugador, importe): descuenta las fichas y las guarda en la base de datos.",
      "Funcion pagarPremio(jugador, importe, multiplicador): acredita el premio segun lo que pague el juego.",
      "Que sea la misma funcion para los cuatro juegos; el juego solo le pasa el multiplicador.",
      "Agrega 3 ejemplos de uso en comentarios al final del archivo."]),

    (22, "Turnos con tiempo limite", "codigo",
     "Agrega un limite de tiempo por turno para que la partida no se quede atorada.",
     ["Archivo: src/turnos.js.",
      "Cada turno dura 25 segundos; el servidor avisa el tiempo restante a la sala.",
      "Si el jugador no hace nada, el servidor decide por el: en blackjack se planta, en los juegos "
      "rapidos no apuesta.",
      "El temporizador se cancela si el jugador si actuo, y tambien al eliminar la sala.",
      "Usa setTimeout, no un while con esperas, y explicame en 2 lineas por que."]),

    (23, "Juego de cara o cruz", "codigo",
     "Programa el juego de cara o cruz completo (servidor y navegador).",
     ["Archivo del servidor: src/juegos/caraOCruz.js con la funcion jugarRonda(apuestas) que regresa el "
      "resultado y cuanto gana cada jugador.",
      "El resultado se saca con las funciones de src/utilidades/azar.js.",
      "Acertar paga x2 sobre la apuesta; fallar la pierde.",
      "En el navegador: dos botones (cara y cruz), el campo de la apuesta y el mensaje del resultado.",
      "Usa el ciclo de ronda que ya existe en src/ronda.js, no hagas otro."]),

    (24, "Juego de dados", "codigo",
     "Programa el juego de dados completo (servidor y navegador).",
     ["Archivo del servidor: src/juegos/dados.js.",
      "Apuestas posibles: 'bajo' (1-3) y 'alto' (4-6) pagan x2; numero exacto del 1 al 6 paga x6.",
      "El dado lo tira el servidor con las funciones de src/utilidades/azar.js.",
      "En el navegador: botones para bajo, alto y los numeros del 1 al 6, mas el campo de la apuesta.",
      "Usa el ciclo de ronda de src/ronda.js."]),

    (25, "Logica de la ruleta", "codigo",
     "Programa la logica de la ruleta en el servidor.",
     ["Archivo: src/juegos/ruleta.js.",
      "Numeros del 0 al 36; incluye la lista de cuales son rojos y cuales negros.",
      "Apuestas: rojo, negro, par, impar (pagan x2) y numero exacto (paga x36).",
      "El cero hace perder las apuestas de color y de par o impar.",
      "La funcion jugarRonda(apuestas) regresa el numero ganador, su color y lo que gana cada jugador.",
      "Todavia no hagas la pantalla ni la animacion: solo la logica y su calculo de pagos."]),

    (26, "Blackjack: mazo y reparto de cartas", "codigo",
     "Programa el mazo y el reparto inicial del blackjack.",
     ["Archivo: src/juegos/blackjack/mazo.js.",
      "Crea el mazo de 52 cartas (palo y valor) y la funcion para barajarlo usando src/utilidades/azar.js.",
      "Funcion repartirInicio(jugadores): dos cartas a cada jugador y dos a la casa (la segunda tapada).",
      "Funcion contarPuntos(mano): las figuras valen 10 y el as vale 11 o 1, lo que mas convenga sin pasarse de 21.",
      "La carta tapada de la casa no se debe mandar al navegador todavia; dejalo preparado para eso."]),

    (27, "Blackjack: pedir carta y plantarse", "codigo",
     "Programa el turno del jugador en el blackjack.",
     ["Archivo: src/juegos/blackjack/turnos.js.",
      "Acciones: pedir (recibe una carta mas) y plantarse (termina su turno).",
      "Si el jugador pasa de 21 pierde de inmediato y su turno termina solo.",
      "Los turnos son por orden de asiento; solo puede actuar el jugador al que le toca.",
      "Eventos de Socket.IO: 'pedir-carta' y 'plantarse'; el servidor revisa que si sea su turno.",
      "Reutiliza el temporizador de src/turnos.js para que se plante solo si no responde."]),

    (28, "Blackjack: turno de la casa y ganador", "codigo",
     "Programa el cierre de la mano de blackjack.",
     ["Archivo: src/juegos/blackjack/casa.js.",
      "La casa voltea su carta tapada y pide cartas hasta llegar a 17 o mas, luego se planta.",
      "Compara la mano de cada jugador contra la de la casa y decide gano, perdio o empate.",
      "El blackjack natural (as con figura o diez en las primeras dos cartas) paga 3:2.",
      "En el empate se devuelve la apuesta.",
      "Usa las funciones de src/apuestas.js para pagar y guarda cada resultado con guardarPartida()."]),

    (29, "Hacer la hoja de estilos general", "codigo",
     "Hazme la hoja de estilos general de la pagina en public/styles.css.",
     ["Estilo de casino moderno y oscuro: fondo gris muy oscuro, verde menta como color principal y "
      "dorado para los acentos.",
      "Define los colores como variables CSS en :root para poder cambiarlos en un solo lugar.",
      "Incluye estilos base para: tipografia, titulos, botones (normal, encima, presionado y desactivado), "
      "campos de texto y tarjetas.",
      "Que todo sea para pantalla de computadora, con un ancho maximo centrado.",
      "Solo el CSS general; las pantallas concretas van en otros tickets."]),

    (30, "Pantalla de inicio", "codigo",
     "Hazme la pantalla de inicio en public/index.html.",
     ["Encabezado con el nombre MonteCristo y una frase corta que explique que es.",
      "Dos botones grandes: 'Crear sala' y 'Entrar con codigo' (con su campo de texto para el codigo).",
      "Una fila de tarjetas con los 4 juegos, cada una con su imagen de public/assets/, su nombre y una "
      "descripcion de una linea.",
      "Un aviso visible abajo de que todas las fichas son virtuales y no hay dinero real.",
      "Usa las clases de public/styles.css; no escribas estilos dentro del HTML."]),

    (31, "Formulario de nombre y avatar", "codigo",
     "Hazme la pantalla donde el jugador pone su nombre y elige avatar antes de jugar.",
     ["Puede ser un modal en index.html o una seccion que se muestra al entrar por primera vez.",
      "Campo de nombre (maximo 30 caracteres) y una lista de 6 avatares para elegir con clic.",
      "Al aceptar, manda los datos a POST /api/jugadores y guarda el id que regresa en localStorage.",
      "Si ya hay un id guardado en localStorage, no vuelve a pedir los datos: solo los carga.",
      "Valida en el navegador que el nombre no este vacio antes de mandarlo."]),

    (32, "Pantalla del lobby con la lista de salas", "codigo",
     "Hazme la pantalla del lobby con las salas abiertas.",
     ["Una tabla o lista de tarjetas con: juego, nombre del anfitrion, cuantos jugadores tiene (3/6) y "
      "un boton de entrar.",
      "La lista se actualiza sola con el evento de Socket.IO 'lista-salas'.",
      "Las salas llenas se ven deshabilitadas, no desaparecen.",
      "Si no hay salas abiertas, muestra un mensaje invitando a crear una.",
      "Agrega del lado del servidor el evento que manda la lista de salas abiertas."]),

    (33, "Pantalla de la mesa de juego", "codigo",
     "Hazme la pantalla donde se juega la partida.",
     ["Archivo public/mesa.html (o la seccion de la mesa dentro de index.html, lo que sea mas simple).",
      "Muestra los 6 lugares con el nombre, avatar y saldo de cada jugador; los vacios se ven como libres.",
      "Al centro, el area del juego (ahi se dibuja la moneda, los dados, la ruleta o las cartas).",
      "Arriba: el codigo de la sala con un boton para copiarlo y el nombre del juego.",
      "Resalta el lugar de quien tiene el turno y marca al anfitrion con una insignia.",
      "Dibuja todo a partir del evento 'estado-sala' que ya manda el servidor."]),

    (34, "Botones para apostar", "codigo",
     "Hazme los controles de apuesta de la mesa.",
     ["Campo para el importe con botones rapidos de 10, 50 y 100 fichas, y un boton de confirmar apuesta.",
      "Los controles se desactivan cuando no es la fase de apostar o cuando el importe es mayor al saldo.",
      "Al confirmar, manda el evento 'apostar' con la opcion elegida y el importe.",
      "Despues de apostar, muestra 'Apuesta confirmada' y bloquea los controles hasta la siguiente ronda.",
      "La tecla Enter confirma la apuesta."]),

    (35, "Mostrar mensajes y el resultado de la ronda", "codigo",
     "Haz que la pantalla muestre los avisos del servidor y el resultado de cada ronda.",
     ["Una barra de mensajes que diga de quien es el turno, cuanto tiempo queda y en que fase va la ronda.",
      "Al terminar la ronda, muestra el resultado y una lista de cuanto gano o perdio cada jugador.",
      "Los errores que mande el servidor (saldo insuficiente, no es tu turno) se muestran en rojo y "
      "desaparecen a los 4 segundos.",
      "Usa un contenedor con aria-live para que tambien lo lean los lectores de pantalla.",
      "Nada de alert(): todo se muestra dentro de la pagina."]),

    (36, "Animacion simple de la moneda, los dados y la ruleta", "codigo",
     "Hazme las animaciones de los juegos rapidos, pero sin que decidan el resultado.",
     ["Archivo: public/animaciones.js.",
      "Moneda: gira y cae mostrando el lado que ya mando el servidor.",
      "Dados: ruedan y se detienen en el numero que mando el servidor.",
      "Ruleta: la rueda gira y se detiene en el numero que mando el servidor.",
      "Cada animacion dura maximo 2.5 segundos y se puede saltar con un clic.",
      "Si el navegador tiene prefers-reduced-motion, muestra el resultado directo sin animacion.",
      "Importante: la animacion SIEMPRE recibe el resultado ya decidido; nunca lo calcula."]),

    (37, "Chat de la sala", "codigo",
     "Programa el chat de la sala (servidor y navegador).",
     ["Evento 'mensaje-chat' de Socket.IO: el servidor lo reenvia a todos los de esa sala con el nombre "
      "y avatar de quien escribio.",
      "El servidor valida que el mensaje no este vacio y que tenga maximo 200 caracteres.",
      "Limite antiflood: maximo 3 mensajes cada 5 segundos por jugador.",
      "En el navegador: lista de mensajes con scroll y un campo que se manda con Enter.",
      "La tecla T pone el cursor en el campo del chat."]),

    (38, "Probar la pagina entre varios y anotar los errores", "doc",
     "Hazme un plan de pruebas para que el equipo pruebe la pagina y anote los errores, en el archivo "
     "docs/plan-de-pruebas.md.",
     ["Una tabla de casos de prueba con: numero, que se prueba, pasos, resultado esperado y una columna "
      "vacia para anotar si paso o fallo.",
      "Debe cubrir: crear sala, entrar con el codigo desde otra computadora, apostar sin saldo, jugar una "
      "ronda de cada juego, el chat y que un jugador se salga a media ronda.",
      "Agrega al final una plantilla corta para reportar un error (que paso, como repetirlo, que deberia pasar)."]),

    (39, "Subir la pagina a un hosting gratuito", "doc",
     "Explicame paso a paso como publicar este proyecto en un hosting gratuito, en el archivo "
     "docs/despliegue.md.",
     ["Usa Render (plan gratuito) para el servidor Node y una base de datos MySQL gratuita en la nube.",
      "Pasos numerados con lo que hay que dar clic y que variables de entorno configurar.",
      "Explica como se conecta el repositorio de GitHub para que se publique solo al hacer merge.",
      "Advierte de las limitaciones del plan gratuito (se duerme tras un rato de no usarse).",
      "Deja un espacio para anotar la direccion final de la pagina."]),

    (40, "Preparar la presentacion final del proyecto", "doc",
     "Hazme el guion de la presentacion final en el archivo docs/presentacion.md.",
     ["Entre 8 y 10 diapositivas, con el titulo de cada una y los puntos que lleva.",
      "Debe incluir: problema, objetivo, tecnologias, arquitectura, demostracion en vivo, reparto del "
      "trabajo del equipo, problemas que tuvimos y conclusiones.",
      "Para la demostracion en vivo, dame el orden exacto de que mostrar para que no falle nada.",
      "Agrega 5 preguntas que podria hacer el profesor con una respuesta corta sugerida para cada una.",
      "La presentacion dura 10 minutos entre 4 personas."]),
]

# Tickets que requieren salir de Arena y hacer algo en otra pagina o programa.
# {numero: (titulo del apartado, [pasos])}
FUERA = {
    3: ("Guardar la imagen del diagrama y, si la necesitas a mano, exportarla desde mermaid.live", [
        "Si Arena ya te dio el PNG en el zip, solo copialo a la carpeta docs/ del proyecto y listo. "
        "Los pasos siguientes son por si quieres rehacerla tu o cambiarle algo.",
        "Abre tu navegador y entra a https://mermaid.live (no hay que registrarse).",
        "Borra el ejemplo que aparece en el panel izquierdo (selecciona todo con Ctrl+A y Suprimir).",
        "Abre el archivo docs/diagrama-base-de-datos.md que te dio Arena, copia SOLO lo que esta "
        "adentro del bloque de codigo (empieza con 'erDiagram') y pegalo en el panel izquierdo.",
        "El diagrama aparece dibujado del lado derecho. Si marca error, revisa que no hayas copiado "
        "las comillas invertidas (```) del inicio y del final.",
        "Da clic en el boton 'Actions' que esta abajo del panel derecho y elige 'PNG'.",
        "Se descarga la imagen. Renombrala como diagrama-base-de-datos.png y copiala a la carpeta "
        "docs/ de tu copia del repositorio.",
        "Esa imagen es la que va en el documento que entregan al profesor.",
    ]),
    4: ("Exportar la imagen del diagrama de arquitectura", [
        "Igual que en el ticket 3: si Arena ya te dio el PNG, solo copialo a docs/ y terminaste.",
        "Para hacerlo a mano: entra a https://mermaid.live, borra el ejemplo y pega el contenido del "
        "bloque de codigo de docs/diagrama-arquitectura.md.",
        "Revisa el dibujo del lado derecho y, si algo se ve encimado, acomoda el texto del diagrama.",
        "Clic en 'Actions' y luego en 'PNG' para descargarlo.",
        "Renombra el archivo como diagrama-arquitectura.png y copialo a la carpeta docs/.",
    ]),
    6: ("Instalar MySQL y crear la base de datos vacia en tu computadora", [
        "Descarga XAMPP desde https://www.apachefriends.org (trae MySQL y phpMyAdmin juntos y es lo "
        "mas facil para la escuela). Si prefieres MySQL solo, bajalo de https://dev.mysql.com/downloads/",
        "Instala XAMPP con las opciones por defecto.",
        "Abre el 'XAMPP Control Panel' y dale 'Start' a los modulos Apache y MySQL. Los dos deben "
        "quedar en verde.",
        "En el renglon de MySQL da clic en 'Admin': se abre phpMyAdmin en el navegador, en la "
        "direccion http://localhost/phpmyadmin",
        "En phpMyAdmin, clic en la pestania 'Bases de datos' (arriba a la izquierda).",
        "Escribe el nombre montecristo, elige el cotejamiento utf8mb4_general_ci y da clic en 'Crear'.",
        "Con XAMPP, el usuario es root y la contrasenia esta vacia. Esos son los datos que van en tu "
        "archivo .env (DB_USER=root y DB_PASSWORD= vacio).",
        "Importante: el archivo .env NO se sube al repositorio. Cada quien tiene el suyo en su "
        "computadora; en el repo solo va .env.example.",
        "Deja XAMPP prendido mientras trabajas: si apagas MySQL, el servidor no se va a poder conectar.",
    ]),
    7: ("Correr el script SQL en phpMyAdmin", [
        "Abre el XAMPP Control Panel y asegurate de que MySQL este en verde.",
        "Entra a http://localhost/phpmyadmin y selecciona la base de datos montecristo en la lista "
        "de la izquierda.",
        "Da clic en la pestania 'SQL' de arriba.",
        "Abre el archivo .sql que te dio Arena con el Bloc de notas o VS Code, copia todo el contenido "
        "y pegalo en el recuadro.",
        "Da clic en 'Continuar'. Si todo salio bien, aparece un mensaje verde y la tabla aparece en la "
        "lista de la izquierda.",
        "Si marca error, lee el mensaje: casi siempre es que no seleccionaste la base de datos antes "
        "de pegar el script.",
    ]),
    8: ("Correr el script SQL en phpMyAdmin", [
        "Mismos pasos del ticket 7: phpMyAdmin, selecciona la base montecristo, pestania 'SQL', pega "
        "el contenido del archivo .sql y 'Continuar'.",
        "Ojo con el orden: la tabla de salas tiene una llave foranea hacia jugadores, asi que la tabla "
        "de jugadores (ticket 7) ya debe existir. Si no, te va a marcar error de 'foreign key'.",
    ]),
    9: ("Correr el script SQL en phpMyAdmin", [
        "Mismos pasos del ticket 7.",
        "Esta tabla depende de salas y de jugadores: corre primero los scripts de los tickets 7 y 8.",
        "Para comprobar que quedo, da clic en la tabla partidas y luego en la pestania 'Estructura': "
        "deben aparecer todos los campos.",
    ]),
    11: ("Instalar Node.js si todavia no lo tienes", [
        "Entra a https://nodejs.org y descarga la version LTS (la del boton de la izquierda).",
        "Instalala con las opciones por defecto, dandole siguiente a todo.",
        "Cierra y vuelve a abrir la terminal (si no, no reconoce el comando).",
        "Comprueba que quedo escribiendo: node --version y npm --version. Los dos deben responder con "
        "un numero de version.",
    ]),
    38: ("Probar entre varias computadoras", [
        "Opcion facil: que todos se conecten a la misma red (el wifi de la escuela o un celular "
        "compartiendo internet).",
        "Quien tenga el proyecto corriendo busca su direccion IP local: en Windows abre la terminal y "
        "escribe ipconfig; es el numero que dice 'Direccion IPv4' (algo como 192.168.1.75).",
        "Los demas entran desde su navegador a http://ESA-IP:3000 (por ejemplo http://192.168.1.75:3000).",
        "Si no carga, es el firewall de Windows: cuando salga el aviso de 'Permitir acceso', acepten "
        "para redes privadas.",
        "Opcion mas comoda: hagan las pruebas directo sobre la pagina ya publicada (ticket 39), asi no "
        "dependen de la red.",
        "Mientras prueban, llenen la tabla del plan de pruebas y anoten cada error con los pasos para "
        "repetirlo.",
    ]),
    39: ("Publicar la pagina en Render y crear la base de datos en la nube", [
        "BASE DE DATOS: entra a https://railway.app (o https://aiven.io) e inicia sesion con GitHub.",
        "Crea un proyecto nuevo y elige 'Provision MySQL' (o 'MySQL' en el catalogo de servicios).",
        "Cuando termine, entra al servicio y abre la pestania 'Variables' o 'Connect': ahi vienen el "
        "host, el usuario, la contrasenia, el puerto y el nombre de la base. Copialos a un bloc de notas.",
        "Conectate a esa base desde phpMyAdmin o MySQL Workbench con esos datos y corre los tres "
        "scripts .sql del proyecto para crear las tablas.",
        "SERVIDOR: entra a https://render.com e inicia sesion con GitHub.",
        "Da clic en 'New +' y luego en 'Web Service'.",
        "Autoriza a Render para que vea tus repositorios y elige el repositorio de MonteCristo.",
        "Llena el formulario: Name = montecristo; Runtime = Node; Build Command = npm install; "
        "Start Command = npm start; Instance Type = Free.",
        "Baja a 'Environment Variables' y agrega una por una: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME "
        "y DB_PORT, con los datos que copiaste de la base de datos.",
        "Da clic en 'Create Web Service' y espera a que el log diga 'Live' (tarda unos minutos).",
        "Arriba aparece la direccion publica, algo como https://montecristo.onrender.com. Esa es la "
        "que le pasan al profesor.",
        "Ojo con el plan gratis: la pagina se duerme si nadie la usa por 15 minutos y la primera "
        "visita despues tarda como un minuto en despertar. No se asusten el dia de la exposicion: "
        "abranla 5 minutos antes.",
        "Anoten la direccion final en el README y en el documento de despliegue.",
    ]),
    40: ("Armar las diapositivas", [
        "Entra a https://www.canva.com e inicia sesion con tu cuenta de Google o correo escolar "
        "(tambien sirve PowerPoint o Google Slides si prefieren).",
        "Busca 'Presentacion' y elige una plantilla oscura y sencilla; eviten las muy cargadas.",
        "Pasa el guion que te dio Arena diapositiva por diapositiva: el titulo arriba y maximo 4 "
        "puntos cortos por lamina. No peguen parrafos.",
        "Mete las imagenes del proyecto: los diagramas de los tickets 3 y 4, y capturas de pantalla "
        "de la pagina funcionando (en Windows se toman con la tecla Impr Pant o con Win+Shift+S).",
        "Para la demostracion en vivo, abran la pagina ya publicada antes de empezar a exponer.",
        "Descarga la presentacion en PDF ('Compartir' -> 'Descargar' -> 'PDF estandar') y subela a la "
        "carpeta docs/ del repositorio, por si falla el internet el dia de la exposicion.",
        "Ensayen una vez completa con reloj: 10 minutos entre 4 personas se van rapidisimo.",
    ]),
}

HERE = os.path.dirname(os.path.abspath(__file__))


def envolver(texto, ancho=92, sangria=""):
    salida = []
    for parrafo in texto.split("\n"):
        if not parrafo.strip():
            salida.append("")
            continue
        salida.extend(textwrap.wrap(parrafo, width=ancho,
                                    initial_indent=sangria, subsequent_indent=sangria))
    return "\n".join(salida)


lineas = []
lineas.append("=" * 96)
lineas.append("PROMPTS POR TICKET - PROYECTO MONTECRISTO")
lineas.append("=" * 96)
lineas.append("")
lineas.append(envolver(
    "Aqui hay un prompt por cada uno de los 40 tickets. Cada prompt ya trae el contexto del proyecto "
    "adentro, asi que se copia y se pega tal cual, sin agregarle nada. La idea es que todos usemos el "
    "mismo texto para que el codigo salga parejo y no se arme un desorden entre lo que hace cada quien."))
lineas.append("")
lineas.append("COMO SE USA")
lineas.append("-" * 96)
lineas.append(envolver(
    "1. Busca el numero de tu ticket en la lista de abajo.\n"
    "2. Copia TODO lo que esta entre las lineas [COPIA DESDE AQUI] y [HASTA AQUI].\n"
    "3. Pegalo en el chat de Arena.ai con el repositorio del proyecto abierto.\n"
    "4. Cuando termine, descarga el .zip que te deje y descomprimelo en tu copia local.\n"
    "5. Crea tu rama, prueba que funcione, haz commit y sube el pull request desde GitHub.\n"
    "6. Nunca pidas que haga el commit ni el pull request: eso lo hacemos nosotros."))
lineas.append("")
lineas.append("REGLA DEL EQUIPO")
lineas.append("-" * 96)
lineas.append(envolver(
    "Antes de empezar tu ticket, revisa que los tickets de los que depende ya esten fusionados en main "
    "y actualiza tu copia con 'git pull'. Si trabajas sobre codigo viejo, el zip que te den va a chocar "
    "con lo que ya subieron tus companeros."))
lineas.append("")
lineas.append("")
lineas.append("INDICE")
lineas.append("-" * 96)
for num, titulo, _tipo, _t, _d in TICKETS:
    lineas.append("  Ticket %2d .... %s" % (num, titulo))
lineas.append("")
lineas.append("")

for num, titulo, tipo, tarea, detalles in TICKETS:
    lineas.append("=" * 96)
    lineas.append("TICKET %d - %s" % (num, titulo))
    lineas.append("=" * 96)
    lineas.append("")
    lineas.append("[COPIA DESDE AQUI]")
    lineas.append("")
    lineas.append(envolver(CONTEXTO))
    lineas.append("")
    lineas.append(envolver("Mi tarea de hoy (ticket %d): %s" % (num, tarea)))
    lineas.append("")
    lineas.append("Detalles de lo que necesito:")
    for d in detalles:
        lineas.append(envolver("- " + d, ancho=92, sangria="")
                      .replace("\n", "\n  "))
    lineas.append("")
    lineas.append(REGLAS_DOC if tipo == "doc" else REGLAS_CODIGO)
    lineas.append("")
    lineas.append("[HASTA AQUI]")
    lineas.append("")
    if num in FUERA:
        titulo_fuera, pasos = FUERA[num]
        lineas.append("  +" + "-" * 92 + "+")
        lineas.append("  | OJO: ESTE TICKET NO SE TERMINA DENTRO DE ARENA" + " " * 46 + "|")
        lineas.append("  +" + "-" * 92 + "+")
        lineas.append("")
        lineas.append(envolver(titulo_fuera, ancho=88, sangria="  "))
        lineas.append("")
        for i, paso in enumerate(pasos, 1):
            texto = envolver("%d. %s" % (i, paso), ancho=86, sangria="   ")
            lineas.append(texto.replace("\n   ", "\n      "))
        lineas.append("")
    lineas.append("")

lineas.append("=" * 96)
lineas.append("SI ALGO SALE MAL")
lineas.append("=" * 96)
lineas.append("")
lineas.append(envolver(
    "Te dio documentacion de mas: responde 'Quitame la documentacion, solo quiero los archivos de codigo "
    "de este ticket en el zip'.\n\n"
    "Te dio codigo de otros tickets: responde 'Eso es de otro ticket, dejame unicamente lo que pedi'.\n\n"
    "Hizo commit o pull request solo: responde 'No hagas commits ni pull requests, yo los subo; solo "
    "dame el zip'.\n\n"
    "El codigo choca con lo que ya esta en main: actualiza tu copia con 'git pull', vuelve a pegar el "
    "prompt y agregale al final: 'Ten en cuenta el codigo que ya existe en el repositorio y no lo rompas'.\n\n"
    "No entiendes el codigo que te dio: pide 'Explicame este archivo linea por linea como si fuera "
    "principiante'. No subas codigo que no puedas explicar en la exposicion."))
lineas.append("")

with open(os.path.join(HERE, "PROMPTS-POR-TICKET.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(lineas))

print("OK: PROMPTS-POR-TICKET.txt con %d prompts" % len(TICKETS))
