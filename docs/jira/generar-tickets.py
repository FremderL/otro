#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera los tickets del proyecto MonteCristo para importar en Jira.

Proyecto escolar: tickets chicos, con titulo y descripcion nada mas.
Sin modulos dificiles (administracion, reportes, seguridad avanzada).

Salidas (en este mismo directorio):
  - montecristo-tickets.csv  -> 40 tickets listos para importar en Jira
  - BACKLOG.md               -> la misma lista, legible, agrupada por etapa

Uso: python3 docs/jira/generar-tickets.py
"""

import csv
import os

# (etapa, titulo, descripcion)
TICKETS = [
    # ---------------------------------------------------- Documentacion
    ("Documentacion y planeacion",
     "Escribir el documento de requerimientos",
     "Redactar un documento corto con lo que debe hacer la pagina: juegos incluidos, "
     "cuantos jugadores por sala y que puede hacer cada jugador. Sirve como base para "
     "todos los demas tickets."),

    ("Documentacion y planeacion",
     "Definir las reglas de cada juego",
     "Escribir en un documento las reglas y los pagos de cada juego (cara o cruz, dados, "
     "ruleta y blackjack). Hay que dejar claro cuanto paga cada apuesta para que despues "
     "el codigo y las pruebas usen los mismos numeros."),

    ("Documentacion y planeacion",
     "Hacer el diagrama de la base de datos",
     "Dibujar el diagrama entidad-relacion con las tablas que vamos a usar (jugadores, "
     "salas, partidas) y sus campos. Guardar la imagen en la carpeta de documentacion."),

    ("Documentacion y planeacion",
     "Hacer el diagrama de arquitectura de la pagina",
     "Dibujar un diagrama sencillo que muestre como se comunican el navegador, el servidor "
     "y la base de datos. Agregarlo a la documentacion del proyecto."),

    ("Documentacion y planeacion",
     "Escribir el README del repositorio",
     "Explicar en el README que es el proyecto, que tecnologias usa y los pasos para "
     "instalarlo y ejecutarlo en la computadora de cualquier integrante."),

    # ---------------------------------------------------- Base de datos
    ("Base de datos",
     "Crear la base de datos y conectarla al servidor",
     "Crear la base de datos del proyecto y escribir el codigo que la conecta desde el "
     "servidor. Debe avisar en la consola si la conexion funciono o si fallo."),

    ("Base de datos",
     "Crear la tabla de jugadores",
     "Crear la tabla de jugadores con id, nombre, avatar, saldo y fecha de registro. "
     "Dejar el script SQL guardado en el repositorio."),

    ("Base de datos",
     "Crear la tabla de salas",
     "Crear la tabla de salas con id, codigo de la sala, juego, anfitrion y estado "
     "(abierta o cerrada). Dejar el script SQL en el repositorio."),

    ("Base de datos",
     "Crear la tabla de partidas jugadas",
     "Crear la tabla donde se guarda cada ronda terminada: sala, juego, jugador, apuesta, "
     "resultado y fecha, junto con la funcion que inserta la fila al acabar la ronda. "
     "Sirve para el historial y las estadisticas."),

    ("Base de datos",
     "Funciones para guardar y consultar jugadores",
     "Programar las funciones basicas para crear un jugador, buscarlo por id y actualizar "
     "su nombre, avatar y saldo. Todo el codigo que necesite jugadores debe usar estas "
     "funciones y no consultas sueltas."),

    # ---------------------------------------------------- Servidor
    ("Servidor",
     "Crear el proyecto de Node con Express",
     "Iniciar el proyecto con npm, instalar Express y dejar un servidor que arranque con "
     "'npm start' en el puerto 3000 y que entregue los archivos de la carpeta public "
     "(HTML, CSS, imagenes y JavaScript del navegador)."),

    ("Servidor",
     "Conectar el servidor y el navegador con Socket.IO",
     "Instalar Socket.IO y dejar la conexion funcionando: cuando el navegador se conecta, "
     "el servidor le manda un mensaje de bienvenida y lo imprime en consola."),

    ("Servidor",
     "Rutas de la API para el jugador",
     "Crear las rutas para registrar un jugador nuevo, consultar sus datos y actualizar su "
     "nombre o avatar. Probarlas antes de conectarlas con la pantalla."),

    ("Servidor",
     "Dar saldo inicial y guardarlo",
     "Cuando se crea un jugador nuevo, darle 1000 fichas virtuales. El saldo se actualiza "
     "en la base de datos cada vez que termina una ronda."),

    # ---------------------------------------------------- Motor del juego
    ("Motor del juego",
     "Crear la estructura de una sala en el servidor",
     "Programar el objeto sala que guarda en memoria el juego elegido, los jugadores "
     "sentados, el anfitrion y la fase en la que va la ronda."),

    ("Motor del juego",
     "Generar el codigo de sala de 5 caracteres",
     "Hacer la funcion que genera un codigo de 5 caracteres para cada sala y revisa que "
     "no este repetido. Con ese codigo los amigos se unen a la mesa."),

    ("Motor del juego",
     "Unir y sacar jugadores de una sala",
     "Programar la logica para que un jugador entre a una sala por su codigo y salga de "
     "ella. Maximo 6 jugadores por sala."),

    ("Motor del juego",
     "Avisar a todos los de la sala cuando algo cambia",
     "Cada vez que cambia el estado de la sala (alguien entra, sale o apuesta), el "
     "servidor manda el estado actualizado a todos los jugadores de esa sala."),

    ("Motor del juego",
     "Ciclo de la ronda: esperar, apostar y resultado",
     "Programar las fases por las que pasa una ronda: esperando jugadores, recibiendo "
     "apuestas, mostrando el resultado y vuelta a empezar. Es la base que van a usar "
     "todos los juegos."),

    ("Motor del juego",
     "Funcion de numeros aleatorios del servidor",
     "Hacer la funcion que saca los resultados al azar (cara o cruz, numero del dado, "
     "numero de la ruleta, carta del mazo). Siempre corre en el servidor, nunca en el "
     "navegador, para que nadie pueda hacer trampa."),

    ("Motor del juego",
     "Funcion que cobra la apuesta y paga el premio",
     "Programar la funcion que descuenta las fichas al apostar y acredita el premio segun "
     "lo que pague el juego. Antes de aceptar la apuesta revisa que sea de minimo 10 fichas "
     "y que al jugador le alcance el saldo. Es la misma funcion para todos los juegos."),

    ("Motor del juego",
     "Turnos con tiempo limite",
     "Poner un limite de tiempo por turno. Si el jugador no hace nada, el servidor decide "
     "por el (se planta o no apuesta) para que la partida no se quede atorada."),

    # ---------------------------------------------------- Juegos
    ("Juegos",
     "Juego de cara o cruz",
     "Programar el juego mas simple: el jugador apuesta a cara o cruz, el servidor lanza "
     "la moneda y paga el doble si le atina. Sirve para probar que el motor de la ronda "
     "funciona bien."),

    ("Juegos",
     "Juego de dados",
     "Programar el juego de dados: se puede apostar a bajo (1-3) o alto (4-6) que paga "
     "doble, o a un numero exacto que paga x6."),

    ("Juegos",
     "Logica de la ruleta",
     "Programar la ruleta: apuestas a rojo o negro, par o impar (pagan doble) y a un "
     "numero exacto del 0 al 36 (paga x36). El cero hace perder las apuestas de color "
     "y de par o impar."),

    ("Juegos",
     "Blackjack: mazo y reparto de cartas",
     "Programar el mazo de 52 cartas, barajarlo y repartir dos cartas a cada jugador y dos "
     "a la casa (una de ellas tapada). Incluir la cuenta de puntos con el as valiendo 1 u 11."),

    ("Juegos",
     "Blackjack: pedir carta y plantarse",
     "Programar las acciones del jugador en su turno: pedir otra carta o plantarse. Si se "
     "pasa de 21 pierde de inmediato."),

    ("Juegos",
     "Blackjack: turno de la casa y ganador",
     "Programar el turno de la casa (pide cartas hasta llegar a 17), comparar las manos, "
     "decidir quien gana y pagar las apuestas."),

    # ---------------------------------------------------- Pantallas
    ("Pantallas y diseno",
     "Hacer la hoja de estilos general",
     "Definir los colores, la tipografia y el estilo de los botones de toda la pagina en "
     "un solo archivo CSS, para que todas las pantallas se vean parecidas."),

    ("Pantallas y diseno",
     "Pantalla de inicio",
     "Hacer el HTML de la pagina de inicio con el nombre del proyecto, una explicacion "
     "corta, los botones de crear sala y entrar con codigo, y un aviso visible de que "
     "las fichas son virtuales y no hay dinero real."),

    ("Pantallas y diseno",
     "Formulario de nombre y avatar",
     "Hacer la pantalla donde el jugador escribe su nombre y elige un avatar antes de "
     "entrar a jugar. Los datos se mandan al servidor para crear su jugador."),

    ("Pantallas y diseno",
     "Pantalla del lobby con la lista de salas",
     "Mostrar las salas abiertas con su juego, el anfitrion y cuantos jugadores tiene "
     "(por ejemplo 3/6), con un boton para entrar a cada una."),

    ("Pantallas y diseno",
     "Pantalla de la mesa de juego",
     "Hacer la pantalla donde se juega: los lugares de los jugadores con su nombre y "
     "avatar, el area del juego al centro y el saldo del jugador."),

    ("Pantallas y diseno",
     "Botones para apostar",
     "Hacer los controles para elegir la apuesta y confirmarla. Se desactivan cuando no "
     "es momento de apostar o cuando no alcanza el saldo."),

    ("Pantallas y diseno",
     "Mostrar mensajes y el resultado de la ronda",
     "Mostrar en pantalla los avisos del servidor: de quien es el turno, el resultado de "
     "la ronda y cuanto gano o perdio cada quien."),

    ("Pantallas y diseno",
     "Animacion simple de la moneda, los dados y la ruleta",
     "Agregar una animacion corta que muestre el resultado que ya mando el servidor. Debe "
     "durar poco y se tiene que poder saltar."),

    # ---------------------------------------------------- Extras y cierre
    ("Extras y cierre",
     "Chat de la sala",
     "Hacer el chat para que los jugadores de una misma sala puedan escribirse durante la "
     "partida. Se manda con Enter y aparece el nombre de quien escribio."),

    ("Extras y cierre",
     "Probar la pagina entre varios y anotar los errores",
     "Juntarse el equipo a probar la pagina con varias computadoras al mismo tiempo: crear "
     "sala, entrar con el codigo y jugar una ronda de cada juego. Anotar los errores que "
     "salgan y corregir los que alcancen a arreglarse en esta entrega."),

    ("Extras y cierre",
     "Subir la pagina a un hosting gratuito",
     "Publicar la pagina en un servicio gratuito para que se pueda abrir desde cualquier "
     "computadora y anotar en el README la direccion y los pasos que se siguieron."),

    ("Extras y cierre",
     "Preparar la presentacion final del proyecto",
     "Armar las diapositivas y el guion de la demostracion: que problema resuelve, como "
     "esta hecho y una partida en vivo. Repartir quien expone cada parte."),
]

# Integrantes del equipo y su rol
EQUIPO = [
    ("Luis", "Luis Enrique Rodriguez Gonzalez", "Product Owner / lider",
     "Vision del producto, backlog, sprints, enlace con el profesor"),
    ("Elian", "Castell Guzman Elian Avishayr", "Backend - motor de juegos",
     "Reglas de los juegos, azar del servidor, cobro y pago de apuestas"),
    ("Alan", "Alan Emmanuel Oseguera Michel", "Backend - API y datos",
     "Servidor, API, base de datos en Neon, saldos y despliegue"),
    ("Hector", "Hector Jaime Navarro Guillen", "Frontend",
     "Maquetas, estilos, pantallas, animaciones y chat"),
    ("Josue", "Josue Angel Carrillo Cruz", "Documentacion y QA",
     "Diagramas, salas, plan de pruebas y entregables"),
]

# Quien hace cada ticket (numero de ticket -> clave del integrante)
RESPONSABLES = {
    1: "Luis", 2: "Luis", 5: "Luis", 16: "Luis", 40: "Luis",
    3: "Josue", 4: "Josue", 15: "Josue", 17: "Josue", 18: "Josue", 38: "Josue",
    6: "Alan", 7: "Alan", 8: "Alan", 9: "Alan", 10: "Alan",
    11: "Alan", 12: "Alan", 13: "Alan", 14: "Alan", 39: "Alan",
    19: "Elian", 20: "Elian", 21: "Elian", 22: "Elian", 23: "Elian",
    24: "Elian", 25: "Elian", 26: "Elian", 27: "Elian", 28: "Elian",
    29: "Hector", 30: "Hector", 31: "Hector", 32: "Hector", 33: "Hector",
    34: "Hector", 35: "Hector", 36: "Hector", 37: "Hector",
}
NOMBRE = {k: n for k, n, _r, _d in EQUIPO}
ROL = {k: r for k, _n, r, _d in EQUIPO}

HERE = os.path.dirname(os.path.abspath(__file__))

assert 35 <= len(TICKETS) <= 40, "Se esperaban entre 35 y 40 tickets, hay %d" % len(TICKETS)

# ------------------------------------------------------------------- CSV
with open(os.path.join(HERE, "montecristo-tickets.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL)
    w.writerow(["Issue Type", "Summary", "Description", "Assignee"])
    for i, (_etapa, titulo, desc) in enumerate(TICKETS, 1):
        w.writerow(["Tarea", titulo, desc, NOMBRE[RESPONSABLES[i]]])

# ------------------------------------------------------------------- MD
etapas = []
for etapa, _t, _d in TICKETS:
    if etapa not in etapas:
        etapas.append(etapa)

lineas = [
    "# Tickets del proyecto — MonteCristo",
    "",
    "%d tickets chicos para repartir en el equipo. Cada uno es una tarea que se puede "
    "terminar en una sentada." % len(TICKETS),
    "",
    "Para importarlos a Jira esta el archivo `montecristo-tickets.csv` de esta carpeta "
    "(columnas: tipo, titulo y descripcion).",
    "",
    "## Equipo",
    "",
    "| Integrante | Rol | De que se encarga | Tickets |",
    "| --- | --- | --- | ---: |",
]
for clave, nombre, rol, desc in EQUIPO:
    mios = sorted(n for n, c in RESPONSABLES.items() if c == clave)
    lineas.append("| %s | %s | %s | %d |" % (nombre, rol, desc, len(mios)))
lineas += [
    "",
    "### Reparto de los tickets",
    "",
]
for clave, nombre, rol, _desc in EQUIPO:
    mios = sorted(n for n, c in RESPONSABLES.items() if c == clave)
    lineas.append("- **%s** (%s) - %d tickets: %s" %
                  (nombre, rol, len(mios), ", ".join(str(n) for n in mios)))
lineas += [
    "",
    "## Etapas",
    "",
    "| Etapa | Tickets |",
    "| --- | ---: |",
]
for e in etapas:
    lineas.append("| %s | %d |" % (e, len([t for t in TICKETS if t[0] == e])))
lineas.append("| **Total** | **%d** |" % len(TICKETS))
lineas.append("")

num = 0
for e in etapas:
    lineas += ["## %s" % e, ""]
    for etapa, titulo, desc in TICKETS:
        if etapa != e:
            continue
        num += 1
        lineas += ["**%d. %s**" % (num, titulo),
                   "",
                   "_Responsable: %s (%s)_" % (NOMBRE[RESPONSABLES[num]],
                                               ROL[RESPONSABLES[num]]),
                   "",
                   desc, ""]

lineas += [
    "## Como importar en Jira",
    "",
    "1. Entrar al proyecto y usar *Import issues from CSV* "
    "(o **Configuracion > Sistema > Importar datos externos > CSV**).",
    "2. Subir `montecristo-tickets.csv`.",
    "3. Mapear las columnas: *Issue Type*, *Summary*, *Description* y *Assignee*.",
    "   La columna *Assignee* trae el nombre de cada integrante. Jira necesita que coincida con "
    "su usuario o su correo: si no los reconoce, deja esa columna sin mapear e "
    "   asignenlos a mano despues de importar (se pueden seleccionar varios a la vez).",
    "4. Importar y despues asignar cada ticket a un integrante del equipo.",
    "",
    "Si el proyecto de Jira esta en ingles, cambiar el valor *Tarea* por *Task* en la "
    "primera columna del CSV antes de importar.",
    "",
    "Para regenerar los archivos: `python3 docs/jira/generar-tickets.py`.",
    "",
]

with open(os.path.join(HERE, "BACKLOG.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(lineas))

# El backlog anterior tenia epics; ya no se usan.
viejo = os.path.join(HERE, "montecristo-epics.csv")
if os.path.exists(viejo):
    os.remove(viejo)

print("OK: %d tickets en %d etapas" % (len(TICKETS), len(etapas)))
