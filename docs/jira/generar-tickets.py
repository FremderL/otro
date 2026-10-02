#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera el backlog MVP de MonteCristo en formato importable a Jira.

Alcance: lo primordial de la pagina, en tickets de esfuerzo bajo y medio
(1 a 5 puntos cada uno). Lo avanzado queda listado como fuera de alcance.

Salidas (en este mismo directorio):
  - montecristo-epics.csv    -> 6 epics (importar PRIMERO)
  - montecristo-tickets.csv  -> 35 tickets (importar DESPUES, enlazan por "Epic Link")
  - BACKLOG.md               -> el mismo backlog legible para humanos

Uso: python3 docs/jira/generar-tickets.py
"""

import csv
import os

EPICS = [
    ("BASE", "Base tecnica",
     "Servidor, tiempo real, guardado de perfiles y red de seguridad minima para poder construir."),
    ("PERF", "Perfil y fichas",
     "Identidad de invitado, saldo virtual y reglas economicas basicas."),
    ("SALA", "Salas y tiempo real",
     "Crear y compartir una mesa, sincronizar su estado y aguantar desconexiones."),
    ("JUEG", "Juegos esenciales",
     "Motor de ronda comun y los cuatro juegos del MVP: Cara o Cruz, Dados, Ruleta y Blackjack."),
    ("SOCI", "Lobby y social",
     "Descubrir salas, entrar rapido y conversar durante la partida."),
    ("LANZ", "Cierre para lanzar",
     "Avisos legales, estados de error, accesibilidad minima y despliegue."),
]

FUERA_DE_ALCANCE = [
    "Texas Hold'em y torneos sit & go (es el bloque mas caro del producto; va despues del MVP).",
    "Bots e IA autoritativa con dificultades y estilos.",
    "Cuentas con usuario y contrasena, sesiones revocables, roles, MFA.",
    "Panel administrativo, moderacion, reportes con evidencia y bitacora de auditoria.",
    "Persistencia en Postgres y migraciones (el MVP usa el archivo JSON).",
    "Ranking mensual por temporadas, medallas y banner dorado.",
    "Modo espectador, tragamonedas, retos, logros y eventos especiales.",
    "Historial descargable y graficas de evolucion de saldo.",
]

T = []


def add(tipo, resumen, epic, prioridad, puntos, labels, contexto, criterios, notas):
    esfuerzo = "bajo" if puntos <= 2 else "medio"
    T.append(dict(num=len(T) + 1, tipo=tipo, resumen=resumen, epic=epic,
                  prioridad=prioridad, puntos=puntos,
                  labels=labels + ["esfuerzo:" + esfuerzo],
                  contexto=contexto, criterios=criterios, notas=notas))


# ------------------------------------------------------------------ BASE (5)
add("Tarea", "Servir el cliente web desde un servidor Express",
    "BASE", "Highest", 2, ["backend", "setup"],
    "Primer paso para tener algo que abrir en el navegador: un servidor que entregue la pagina.",
    ["'npm install && npm start' levanta el servidor en 0.0.0.0 respetando la variable PORT (3000 por defecto).",
     "Se sirven los archivos de /public: index.html, styles.css y app.js.",
     "Abrir la raiz en el navegador muestra la pagina sin errores en consola.",
     "package.json declara engines node >= 18 y los scripts start y dev."],
    ["Dependencias: express y compression."])

add("Tarea", "Conectar el cliente y el servidor por Socket.IO",
    "BASE", "Highest", 2, ["backend", "tiempo-real"],
    "Todo el juego depende de un canal en vivo; conviene dejarlo funcionando y probado desde el inicio.",
    ["Socket.IO queda montado sobre el mismo servidor HTTP.",
     "Al conectar, el cliente recibe un evento de bienvenida con la version del servidor.",
     "El cliente reintenta la conexion automaticamente si se cae.",
     "La interfaz muestra un indicador visible de conectado / reconectando / sin conexion."],
    [])

add("Historia", "Guardar perfiles en un archivo JSON con escritura segura",
    "BASE", "Highest", 3, ["backend", "persistencia"],
    "Como jugador quiero que mis fichas sigan ahi cuando vuelva, para no empezar de cero cada vez.",
    ["Los perfiles se guardan en data/profiles.json y se cargan al arrancar.",
     "La escritura es diferida y atomica (archivo temporal + rename) para que un corte no corrompa el archivo.",
     "La ruta es configurable con PROFILE_STORE_PATH.",
     "El acceso pasa por un modulo unico, para poder cambiar el backend despues sin tocar el resto del codigo.",
     "Lo que se envia al cliente es una lista explicita de campos, nunca el objeto completo del perfil."],
    ["No se usa base de datos en el MVP; Postgres queda fuera de alcance."])

add("Tarea", "Red de seguridad minima: lint, verificacion de sintaxis y prueba de humo",
    "BASE", "High", 2, ["calidad", "ci"],
    "Con poco esfuerzo se evita romper lo que ya funciona en cada cambio.",
    ["'npm run lint' pasa ESLint sobre el repositorio sin errores.",
     "'npm run check:syntax' valida la sintaxis de todos los archivos JavaScript.",
     "Existe una prueba de humo con node:test que levanta el servidor y verifica que responde.",
     "'npm test' encadena las tres cosas.",
     "Un workflow de GitHub Actions ejecuta 'npm test' en cada push y pull request."],
    [])

add("Tarea", "Health check y registro de eventos clave",
    "BASE", "Medium", 1, ["backend", "observabilidad"],
    "Necesario para desplegar sin caidas y para entender que paso cuando algo falle.",
    ["GET /healthz responde 200 con estado, uptime, salas activas y jugadores conectados.",
     "Se registran arranque, sala creada, sala destruida, jugador entra y jugador sale.",
     "Los logs nunca incluyen datos sensibles."],
    [])

# ------------------------------------------------------------------ PERF (5)
add("Historia", "Perfil de invitado con nombre y avatar",
    "PERF", "Highest", 3, ["frontend", "backend", "perfil"],
    "Como visitante quiero entrar y jugar en segundos, sin registro, pero siendo reconocible en la mesa.",
    ["Al entrar por primera vez se crea un perfil con un token local de dispositivo guardado en el navegador.",
     "Puedo elegir y cambiar mi nombre y mi avatar desde la interfaz.",
     "Al volver desde el mismo navegador recupero mi perfil automaticamente.",
     "El cambio de nombre o avatar se refleja en la mesa en tiempo real.",
     "El token de dispositivo solo da continuidad al perfil: no concede ningun privilegio."],
    [])

add("Historia", "Saldo virtual inicial de 1000 fichas que persiste",
    "PERF", "Highest", 2, ["backend", "economia"],
    "Como jugador quiero arrancar con fichas y que mi saldo se conserve entre sesiones, "
    "para que las partidas tengan continuidad.",
    ["Un perfil nuevo arranca con 1000 fichas virtuales.",
     "El saldo se actualiza en el servidor y se persiste tras cada ronda.",
     "El saldo visible en la interfaz siempre viene del servidor, nunca se calcula solo en el cliente.",
     "Si recargo la pagina, el saldo mostrado es el mismo."],
    [])

add("Historia", "Bono diario de 100 fichas",
    "PERF", "Medium", 2, ["backend", "economia"],
    "Como jugador quiero poder seguir jugando aunque me quede sin fichas, para no quedar bloqueado.",
    ["Al entrar se otorgan 100 fichas, una sola vez por dia natural.",
     "La interfaz avisa con un mensaje breve cuando se recibe el bono.",
     "Recargar la pagina varias veces el mismo dia no vuelve a otorgarlo.",
     "El calculo del dia usa la zona horaria configurada (America/Mexico_City por defecto)."],
    [])

add("Historia", "Validacion de apuestas en el servidor",
    "PERF", "Highest", 2, ["backend", "economia", "seguridad"],
    "Como producto necesitamos que nadie pueda apostar fichas que no tiene manipulando el navegador.",
    ["La apuesta minima es de 10 fichas.",
     "El servidor rechaza apuestas mayores al saldo disponible, con un mensaje claro para el cliente.",
     "Las fichas se descuentan al confirmar la apuesta y se acreditan al resolver la ronda.",
     "El cliente deshabilita los controles invalidos, pero la decision siempre se revalida en el servidor.",
     "Una prueba automatizada intenta apostar mas del saldo y espera un rechazo."],
    [])

add("Historia", "Modal de perfil con estadisticas basicas",
    "PERF", "Low", 3, ["frontend", "perfil"],
    "Como jugador quiero ver como me ha ido, para tener una sensacion de progreso.",
    ["El modal muestra nombre, avatar, saldo actual, rondas jugadas, victorias y mayor ganancia.",
     "Las estadisticas se actualizan al terminar cada ronda.",
     "Los contadores se persisten junto al perfil.",
     "El modal se abre y cierra con teclado y devuelve el foco al elemento que lo abrio."],
    [])

# ------------------------------------------------------------------ SALA (6)
add("Historia", "Crear una sala con codigo de 5 caracteres y URL compartible",
    "SALA", "Highest", 3, ["backend", "frontend", "salas"],
    "Como anfitrion quiero abrir una mesa y pasarle el enlace a mis amigos, "
    "que es la razon de ser de la pagina.",
    ["Puedo crear una sala eligiendo juego y nombre.",
     "El servidor genera un codigo unico de 5 caracteres y una URL compartible.",
     "La interfaz muestra el codigo y un boton para copiar el enlace.",
     "Quien crea la sala queda como anfitrion.",
     "Solo el anfitrion puede iniciar la ronda."],
    [])

add("Historia", "Unirse a una sala por codigo o URL con capacidad de 6",
    "SALA", "Highest", 3, ["backend", "frontend", "salas"],
    "Como invitado quiero entrar con un clic o escribiendo el codigo, sin crear cuenta.",
    ["Puedo unirme pegando la URL o escribiendo el codigo de 5 caracteres.",
     "Si la sala no existe, recibo un mensaje claro y vuelvo al lobby.",
     "La capacidad maxima es de 6 participantes; el servidor rechaza al septimo con un aviso.",
     "No se puede entrar a mitad de una mano en curso: se espera a la siguiente ronda.",
     "El codigo no distingue mayusculas de minusculas."],
    [])

add("Historia", "Estado de la sala sincronizado desde el servidor",
    "SALA", "Highest", 3, ["backend", "tiempo-real"],
    "Como jugador quiero que todos veamos exactamente lo mismo, para que no haya discusiones ni trampas.",
    ["El servidor es la unica fuente de verdad: el cliente solo envia intenciones y renderiza lo que recibe.",
     "Tras cada cambio relevante se difunde el estado a los participantes de la sala.",
     "El servidor revalida turno, fase, importe y saldo antes de aplicar cualquier accion.",
     "Al entrar a la sala recibo el estado completo actual, no solo los cambios siguientes."],
    [])

add("Historia", "Lista de participantes con asientos, anfitrion y turno",
    "SALA", "High", 2, ["frontend", "salas"],
    "Como jugador quiero ver quien esta en la mesa y a quien le toca, para seguir la partida.",
    ["Se muestran hasta 6 asientos con nombre, avatar y saldo de cada participante.",
     "El anfitrion esta marcado con una insignia.",
     "El asiento de quien tiene el turno esta resaltado.",
     "Los asientos vacios se ven claramente como disponibles.",
     "La lista se actualiza en vivo cuando alguien entra o sale."],
    [])

add("Historia", "Salir de la sala con reembolso y cierre de salas vacias",
    "SALA", "High", 3, ["backend", "salas"],
    "Como jugador quiero poder irme sin perder fichas comprometidas, y como operador no quiero "
    "mesas fantasma acumulandose en memoria.",
    ["Al salir, mis apuestas abiertas de la ronda en curso se reembolsan.",
     "Si sale el anfitrion, el rol pasa a otra persona de la mesa.",
     "Una sala sin participantes se destruye y deja de aparecer en el lobby.",
     "Al destruir la sala se cancelan sus temporizadores de turno y de ronda.",
     "Los demas ven un mensaje breve de que alguien salio."],
    [])

add("Historia", "Reconexion por token de dispositivo",
    "SALA", "High", 3, ["backend", "tiempo-real", "resiliencia"],
    "Como jugador quiero recuperar mi asiento si se me cae el internet un momento, "
    "en lugar de perder la partida y las fichas.",
    ["Si vuelvo con el mismo token de dispositivo dentro de la ventana de gracia, recupero asiento, saldo y estado de ronda.",
     "Mientras estoy desconectado, los demas ven mi asiento marcado como 'reconectando'.",
     "Si no vuelvo dentro de la ventana, se libera mi asiento y se reembolsan mis apuestas abiertas.",
     "El cliente reintenta la conexion solo y muestra el progreso."],
    [])

# ------------------------------------------------------------------ JUEG (9)
add("Historia", "Motor de ronda comun para los juegos de apuesta unica",
    "JUEG", "Highest", 5, ["backend", "motor-juego"],
    "Como equipo queremos una sola maquina de estados reutilizable, para no reimplementar el ciclo "
    "de la ronda en cada juego.",
    ["Existe una maquina de estados con las fases: espera, apuestas, resolucion y resultados.",
     "Cada participante confirma una sola apuesta por ronda (opcion e importe).",
     "Solo el anfitrion abre y lanza la ronda, pero el servidor genera y liquida el resultado.",
     "Los resultados se calculan con una fuente aleatoria del servidor, nunca en el cliente.",
     "Al terminar, se acreditan los pagos, se difunde el resultado y la sala vuelve a espera.",
     "Los tres juegos rapidos del MVP se montan sobre este motor sin duplicar logica."],
    ["Archivo de referencia: lib/quick-games.js."])

add("Historia", "Cara o Cruz",
    "JUEG", "Highest", 2, ["backend", "frontend", "juego"],
    "Como grupo queremos el juego mas simple posible para probar el circuito completo de apuesta y pago.",
    ["Puedo apostar a cara o a cruz con un importe valido.",
     "Acertar paga x2 sobre la apuesta; fallar la pierde.",
     "El resultado lo decide el servidor antes de cualquier animacion.",
     "El resultado y el pago de cada participante se muestran al cerrar la ronda."],
    ["Primer juego a implementar: valida el motor de ronda de punta a punta."])

add("Historia", "Dados Cosmicos",
    "JUEG", "High", 3, ["backend", "frontend", "juego"],
    "Como jugador quiero una apuesta con mas de dos opciones, para variar el ritmo entre rondas.",
    ["Puedo apostar a bajo (1-3) o alto (4-6) con pago x2.",
     "Puedo apostar a un numero exacto con pago x6.",
     "El dado lo tira el servidor y el mismo valor llega a todos los participantes.",
     "La interfaz muestra claramente mi apuesta antes de lanzar y puedo cambiarla hasta que se cierra la mesa."],
    [])

add("Tarea", "Animaciones de moneda y dados sobre el resultado del servidor",
    "JUEG", "Medium", 3, ["frontend", "ux"],
    "La tension visual es parte de la experiencia, pero no debe poder alterar ni adelantar el resultado.",
    ["La moneda gira y los dados ruedan antes de revelar el valor que ya envio el servidor.",
     "La animacion dura menos de 3 segundos y se puede saltar.",
     "Se respeta prefers-reduced-motion: sin animacion, revelado directo.",
     "Ninguna animacion bloquea el chat ni el resto de la interfaz."],
    [])

add("Historia", "Ruleta: apuestas simples y pleno",
    "JUEG", "High", 5, ["backend", "frontend", "juego"],
    "Como jugador quiero la ruleta, que es el juego de casino mas reconocible, en una version "
    "acotada pero correcta.",
    ["Puedo apostar a rojo, negro, par, impar, 1-18 o 19-36, con pago x2.",
     "Puedo apostar a un numero exacto de 0 a 36 (pleno), con pago x36.",
     "El cero es verde y hace perder todas las apuestas externas.",
     "El numero ganador lo decide el servidor y la rueda se detiene exactamente en el.",
     "La animacion se puede saltar y respeta prefers-reduced-motion."],
    ["Docenas, columnas y el pano completo quedan fuera del MVP."])

add("Historia", "Blackjack: reparto, pedir, plantarse y casa a 17",
    "JUEG", "Highest", 5, ["backend", "frontend", "juego"],
    "Como jugador quiero un juego con decisiones por turno y no solo azar, que es lo que da profundidad a la mesa.",
    ["Cada jugador apuesta y recibe dos cartas; la casa recibe una visible y una oculta.",
     "Puedo pedir carta o plantarme en mi turno.",
     "Pasarse de 21 pierde la apuesta de inmediato.",
     "La casa pide hasta 17 y se planta, segun reglas fijas del servidor.",
     "Se comparan manos, se declaran ganadores y empates y se acreditan los pagos.",
     "El as vale 1 u 11 segun convenga a la mano."],
    [])

add("Historia", "Blackjack: doblar y pago 3:2 del blackjack natural",
    "JUEG", "Medium", 3, ["backend", "frontend", "juego"],
    "Como jugador quiero las dos reglas que mas cambian la estrategia, sin complicar el MVP con seguro ni split.",
    ["Puedo doblar la apuesta con mis dos primeras cartas y recibir exactamente una carta mas.",
     "No puedo doblar si no me alcanza el saldo.",
     "Un blackjack natural (as + figura o diez) paga 3:2.",
     "Si la casa tambien tiene blackjack natural, la mano es empate y se devuelve la apuesta."],
    ["Seguro y split quedan fuera del MVP."])

add("Historia", "Temporizador de turno con accion segura por defecto",
    "JUEG", "High", 3, ["backend", "motor-juego"],
    "Como jugador no quiero que la partida se congele porque alguien se fue a hacer otra cosa.",
    ["Cada turno tiene un limite de 25 segundos, visible como cuenta regresiva en la interfaz.",
     "Al expirar, el servidor aplica una accion segura: plantarse en blackjack, o no apostar en los juegos rapidos.",
     "Los temporizadores no bloquean el bucle de eventos y se cancelan al destruir la sala.",
     "La accion automatica pasa por el mismo validador que la accion manual.",
     "Los demas participantes ven que la accion fue automatica."],
    [])

add("Historia", "Privacidad de cartas garantizada por el servidor",
    "JUEG", "Highest", 3, ["backend", "seguridad"],
    "Como jugador quiero certeza de que nadie puede ver mis cartas abriendo la consola del navegador.",
    ["La carta oculta de la casa no viaja al cliente hasta la resolucion.",
     "Cada jugador recibe unicamente sus propias cartas; las ajenas viajan boca abajo como XX.",
     "El estado se filtra por destinatario en el servidor, no se oculta con CSS en el cliente.",
     "Una prueba automatizada verifica que el payload de un jugador no contiene cartas de otro ni la carta oculta de la casa."],
    [])

# ------------------------------------------------------------------ SOCI (5)
add("Historia", "Lobby con tarjetas de juego y accesos directos",
    "SOCI", "High", 3, ["frontend", "lobby"],
    "Como visitante quiero entender en 5 segundos que es la pagina y como empezar a jugar.",
    ["La portada explica en una frase que es un casino social con fichas virtuales, sin dinero real.",
     "Hay accesos directos a crear sala y a entrar con codigo.",
     "Hay una tarjeta por juego del MVP con imagen, descripcion breve y duracion estimada.",
     "La accion principal de cada tarjeta crea una sala de ese juego.",
     "Las imagenes son locales, sin depender de CDNs externos."],
    [])

add("Historia", "Lista de salas abiertas en vivo",
    "SOCI", "Medium", 3, ["frontend", "backend", "lobby"],
    "Como visitante que llega solo quiero unirme a una mesa existente, para no depender de que alguien me invite.",
    ["El lobby lista las salas abiertas con juego, anfitrion, fase y ocupacion (por ejemplo 3/6).",
     "La lista se actualiza en vivo cuando se crean, llenan o cierran salas.",
     "Las salas llenas se muestran deshabilitadas en vez de desaparecer.",
     "Puedo filtrar por juego.",
     "Si no hay salas abiertas, se muestra un estado vacio que invita a crear una."],
    [])

add("Historia", "Chat de sala",
    "SOCI", "High", 3, ["frontend", "backend", "social"],
    "Como grupo de amigos queremos comentar la jugada: la conversacion es la mitad de la diversion.",
    ["Puedo escribir y enviar mensajes visibles para toda la sala, con mi nombre y avatar.",
     "Enter envia el mensaje y la tecla T enfoca el campo de chat.",
     "El servidor valida longitud maxima y aplica un limite antiflood por remitente.",
     "Los mensajes nuevos se anuncian a lectores de pantalla mediante una region en vivo.",
     "El historial del chat se conserva mientras la sala exista."],
    [])

add("Historia", "Mensajes rapidos y reacciones",
    "SOCI", "Low", 2, ["frontend", "social"],
    "Como jugador quiero reaccionar sin dejar de mirar la mesa, con un solo clic.",
    ["Hay botones de mensajes rapidos predefinidos que se envian al chat.",
     "Hay reacciones con emoji que aparecen brevemente sobre la mesa.",
     "Las reacciones tienen un limite de frecuencia por persona.",
     "Funcionan con teclado y tienen etiqueta accesible."],
    [])

add("Historia", "Historial de ganadores recientes de la sala",
    "SOCI", "Low", 2, ["frontend", "backend", "social"],
    "Como jugador quiero ver como viene la racha de la mesa, para darle continuidad a la sesion.",
    ["La sala muestra las ultimas rondas con juego, ganador e importe.",
     "Se conservan al menos las 10 rondas mas recientes mientras la sala exista.",
     "Las ganancias grandes se destacan con una celebracion breve que no bloquea la partida.",
     "El historial se envia como parte del estado de la sala a quien entra."],
    [])

# ------------------------------------------------------------------ LANZ (5)
add("Historia", "Aviso de juego virtual y terminos con aceptacion",
    "LANZ", "Highest", 3, ["legal", "frontend", "backend"],
    "Como operador en Mexico necesito dejar claro que no hay dinero real y que el uso es para mayores de edad, "
    "antes de abrir la pagina al publico.",
    ["Existe la pagina /terminos con naturaleza recreativa, requisito 18+, deslinde de responsabilidad y aviso de privacidad.",
     "Al entrar por primera vez debo aceptar los terminos para poder crear o unirme a una sala.",
     "La aceptacion queda registrada con su version; el servidor rechaza crear o unirse sin la aceptacion vigente.",
     "La interfaz repite de forma visible que las fichas son virtuales y que no hay depositos, retiros ni premios canjeables."],
    [])

add("Historia", "Estados de carga, error y reconexion en el cliente",
    "LANZ", "High", 2, ["frontend", "ux"],
    "Como visitante quiero entender que esta pasando cuando algo tarda o falla, en lugar de ver una pantalla muerta.",
    ["Hay una pantalla de carga mientras el servidor despierta, con los reintentos visibles.",
     "Los errores del servidor se muestran como mensajes legibles, nunca como un fallo silencioso.",
     "Perder la conexion muestra un aviso persistente y recuperarla lo retira.",
     "Las acciones en curso deshabilitan su boton para evitar envios duplicados."],
    [])

add("Historia", "Bloqueo para pantallas menores a 1024 px",
    "LANZ", "Medium", 2, ["frontend", "ux"],
    "Como producto decidimos soportar solo computadoras; hay que comunicarlo bien en vez de mostrar "
    "una interfaz rota en el telefono.",
    ["Con ventanas de menos de 1024 px de ancho se muestra una pantalla que invita a volver desde una computadora.",
     "Hay un boton 'Entrar de todos modos' cuya decision se recuerda en el navegador.",
     "En ese caso la pagina permite desplazamiento horizontal en vez de romper el diseno.",
     "La resolucion minima soportada es 1024x720 y el diseno es optimo desde 1280x800.",
     "El README indica que es un sitio solo para escritorio."],
    [])

add("Tarea", "Accesibilidad minima y atajos de teclado",
    "LANZ", "Medium", 3, ["frontend", "accesibilidad"],
    "Con poco esfuerzo la pagina se vuelve usable con teclado y comoda para quien prefiere menos movimiento.",
    ["Toda accion se puede ejecutar con teclado y el foco es siempre visible.",
     "Atajos en mesa: H/S/D en blackjack, Enter confirma la apuesta rapida, T enfoca el chat y ? muestra la guia.",
     "Los cambios de estado importantes se anuncian mediante regiones en vivo.",
     "Se respeta prefers-reduced-motion en todas las animaciones.",
     "El contraste de texto cumple el nivel AA."],
    [])

add("Tarea", "Despliegue en Render y guia de ejecucion",
    "LANZ", "High", 3, ["devops", "despliegue"],
    "El MVP no sirve de nada si no esta en linea y nadie sabe como levantarlo.",
    ["render.yaml versiona el servicio: build, start, health check en /healthz y variables de entorno.",
     "El health check permite deploys sin caida y ante SIGTERM el servidor guarda los perfiles antes de salir.",
     "Esta documentada la opcion gratuita y su limitacion (suspension tras inactividad y perfiles efimeros sin disco).",
     "El README explica como ejecutar en local y como desplegar, en pasos numerados.",
     "La URL de produccion queda probada de punta a punta: crear sala, entrar desde otro navegador y jugar una ronda."],
    [])

assert len(T) == 35, "Se esperaban 35 tickets, hay %d" % len(T)
assert all(t["puntos"] <= 5 for t in T), "Hay tickets de mas de 5 puntos"

HERE = os.path.dirname(os.path.abspath(__file__))
EPIC_NAME = {k: n for k, n, _ in EPICS}


def descripcion(t):
    partes = ["*Contexto*", t["contexto"], "", "*Criterios de aceptacion*"]
    partes += ["%d. %s" % (i + 1, c) for i, c in enumerate(t["criterios"])]
    if t["notas"]:
        partes += ["", "*Notas*"] + ["- %s" % n for n in t["notas"]]
    partes += ["", "*Definicion de terminado*",
               "- Codigo revisado y fusionado en main.",
               "- Prueba automatizada del criterio principal, en verde en CI.",
               "- Probado a mano en el navegador.",
               "- README actualizado si cambia la forma de usar o ejecutar la pagina."]
    return "\n".join(partes)


with open(os.path.join(HERE, "montecristo-epics.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL)
    w.writerow(["Issue Type", "Summary", "Epic Name", "Description", "Priority"])
    for key, nombre, desc in EPICS:
        w.writerow(["Epic", nombre, nombre, desc, "High"])

with open(os.path.join(HERE, "montecristo-tickets.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL)
    w.writerow(["Issue Type", "Summary", "Description", "Priority", "Story Points",
                "Epic Link", "Labels", "Labels", "Labels", "Labels", "Component"])
    for t in T:
        labels = (t["labels"] + ["", "", "", ""])[:4]
        w.writerow([t["tipo"], t["resumen"], descripcion(t), t["prioridad"], t["puntos"],
                    EPIC_NAME[t["epic"]]] + labels + [EPIC_NAME[t["epic"]]])

lineas = [
    "# Backlog MVP — MonteCristo Social Casino",
    "",
    "35 tickets centrados en **lo primordial de la pagina**, todos de esfuerzo bajo o medio",
    "(1 a 5 puntos). El objetivo del conjunto es un producto jugable de punta a punta:",
    "entrar sin registro, crear una sala, compartirla, jugar y conversar.",
    "",
    "- `montecristo-epics.csv` — 6 epics. **Importar primero.**",
    "- `montecristo-tickets.csv` — los 35 tickets, enlazados a su epic por nombre (`Epic Link`).",
    "",
    "**Escala de esfuerzo:** 1-2 puntos = bajo · 3-5 puntos = medio. Ningun ticket pasa de 5.",
    "",
    "## Resumen",
    "",
    "| Epic | Tickets | Puntos |",
    "| --- | ---: | ---: |",
]
for key, nombre, _ in EPICS:
    ts = [t for t in T if t["epic"] == key]
    lineas.append("| %s | %d | %d |" % (nombre, len(ts), sum(x["puntos"] for x in ts)))
lineas.append("| **Total** | **%d** | **%d** |" % (len(T), sum(t["puntos"] for t in T)))

bajo = len([t for t in T if t["puntos"] <= 2])
lineas += ["",
           "%d tickets de esfuerzo bajo y %d de esfuerzo medio." % (bajo, len(T) - bajo),
           "",
           "## Fuera de alcance de este MVP",
           "",
           "Se deja fuera a proposito para no abarcar todo de una vez; son candidatos a una segunda fase:",
           ""]
lineas += ["- %s" % x for x in FUERA_DE_ALCANCE]
lineas += ["", "## Tickets", ""]

for key, nombre, desc in EPICS:
    lineas += ["### Epic: %s" % nombre, "", desc, ""]
    for t in [x for x in T if x["epic"] == key]:
        lineas += [
            "#### %d. %s" % (t["num"], t["resumen"]),
            "",
            "`%s` · Prioridad **%s** · **%d** puntos · %s" %
            (t["tipo"], t["prioridad"], t["puntos"],
             " ".join("`%s`" % l for l in t["labels"])),
            "",
            "**Contexto.** " + t["contexto"],
            "",
            "**Criterios de aceptacion**",
            "",
        ]
        lineas += ["%d. %s" % (i + 1, c) for i, c in enumerate(t["criterios"])]
        if t["notas"]:
            lineas += ["", "**Notas**", ""] + ["- %s" % n for n in t["notas"]]
        lineas.append("")

lineas += [
    "## Orden sugerido",
    "",
    "Los tickets ya estan numerados en el orden en que conviene tomarlos. Tres hitos naturales:",
    "",
    "1. **Tickets 1-10** — la pagina abre, hay perfil con fichas y todo se guarda.",
    "2. **Tickets 11-24** — se puede crear una sala, invitar y jugar los cuatro juegos.",
    "3. **Tickets 25-35** — lobby, chat y todo lo necesario para publicarla.",
    "",
    "## Como importar en Jira",
    "",
    "1. **Configuracion > Sistema > Importar y exportar > Importar datos externos > CSV** "
    "(o *Project settings > Import issues* en un proyecto de equipo).",
    "2. Sube primero `montecristo-epics.csv` y mapea `Epic Name`.",
    "3. Sube despues `montecristo-tickets.csv` y mapea: *Issue Type, Summary, Description, "
    "Priority, Story Points, Epic Link, Labels (x4), Component*.",
    "4. En proyectos *team-managed*, `Epic Link` puede llamarse `Parent`: renombra la columna "
    "antes de importar o usa el mapeo equivalente.",
    "",
    "Para regenerar estos archivos: `python3 docs/jira/generar-tickets.py`.",
    "",
]

with open(os.path.join(HERE, "BACKLOG.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(lineas))

print("OK: %d epics, %d tickets, %d puntos (%d bajos / %d medios)" %
      (len(EPICS), len(T), sum(t["puntos"] for t in T), bajo, len(T) - bajo))
