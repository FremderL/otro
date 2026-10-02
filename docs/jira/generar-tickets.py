#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera el backlog de reconstruccion de MonteCristo en formato importable a Jira.

Salidas (en este mismo directorio):
  - montecristo-epics.csv    -> 8 epics (importar PRIMERO)
  - montecristo-tickets.csv  -> 35 tickets (importar DESPUES, enlazan por "Epic Link")
  - BACKLOG.md               -> el mismo backlog legible para humanos

Uso: python3 docs/jira/generar-tickets.py
"""

import csv
import os

EPICS = [
    ("MC-FUND", "Fundaciones y plataforma",
     "Esqueleto del servidor, calidad de codigo, persistencia de perfiles y base de datos."),
    ("MC-SALA", "Salas y tiempo real",
     "Creacion de salas compartibles, estado autoritativo, sincronizacion y resiliencia de sesion."),
    ("MC-JUEG", "Juegos de casino",
     "Motor de rondas y los seis juegos: Hold'em, torneo, Blackjack, Ruleta, juegos rapidos y tragamonedas."),
    ("MC-BOTS", "Bots e IA autoritativa",
     "Jugadores automaticos configurables que nunca deciden resultados ni ven informacion privilegiada."),
    ("MC-PERF", "Perfil, economia y progresion",
     "Perfil por dispositivo, fichas virtuales, retos, logros, eventos y estadisticas."),
    ("MC-SOCI", "Social y descubrimiento",
     "Lobby, chat, ranking mensual por temporadas y modo espectador."),
    ("MC-SEG", "Cuentas, seguridad y administracion",
     "Cuentas opcionales, sesiones revocables, roles, MFA, moderacion, reportes, panel y auditoria."),
    ("MC-OPS", "Experiencia, legal y operacion",
     "Accesibilidad y soporte solo-escritorio, terminos y privacidad, despliegue y observabilidad."),
]

# (num, tipo, resumen, epic_key, prioridad, puntos, labels, contexto, criterios[], notas[])
T = []


def add(num, tipo, resumen, epic, prioridad, puntos, labels, contexto, criterios, notas):
    T.append(dict(num=len(T) + 1, tipo=tipo, resumen=resumen, epic=epic, prioridad=prioridad,
                  puntos=puntos, labels=labels, contexto=contexto,
                  criterios=criterios, notas=notas))


# ---------------------------------------------------------------- FUNDACIONES
add(1, "Tarea", "Bootstrap del proyecto, servidor base y observabilidad",
    "MC-FUND", "Highest", 5, ["backend", "setup", "observabilidad"],
    "Sin un esqueleto ejecutable y observable no se puede empezar ninguna otra historia. Este ticket "
    "deja el repositorio corriendo en local con un servidor que sirve el cliente estatico, acepta "
    "conexiones de tiempo real y es diagnosticable desde el visor de logs del hosting.",
    ["Dado el repositorio recien clonado, cuando ejecuto 'npm install && npm start', entonces el "
     "servidor levanta en 0.0.0.0 respetando la variable PORT (3000 por defecto).",
     "El servidor sirve los archivos de /public (index.html, styles.css, app.js) con compresion habilitada.",
     "Socket.IO queda montado sobre el mismo servidor HTTP y un cliente puede conectarse y recibir un evento de bienvenida.",
     "package.json declara engines node >= 18 y los scripts start/dev.",
     "GET /healthz responde 200 con estado, uptime, numero de salas, jugadores humanos conectados y version de T&C.",
     "Los eventos operativos (arranque, sala creada/destruida, jugador entra/sale, apagado) se emiten como JSON por linea, y LOG_JSON=off vuelve a logs legibles.",
     "Los logs nunca contienen contrasenas, cookies, tokens completos ni hashes.",
     "Ante SIGTERM el servidor avisa a las mesas, guarda el estado y cierra los sockets antes de salir, con margen configurable por SHUTDOWN_GRACE_MS.",
     "El README documenta como ejecutar el proyecto en local."],
    ["Dependencias: express, socket.io, compression.",
     "Mantener server.js como punto de entrada y lib/ para modulos de dominio.",
     "Grace por defecto: 10000 ms con Postgres y 2500 ms con archivo local."])

add(3, "Tarea", "Pipeline de calidad: ESLint, verificacion de sintaxis, node:test y CI",
    "MC-FUND", "High", 3, ["calidad", "ci"],
    "Se necesita una red de seguridad automatica antes de tocar autenticacion, autorizacion y dinero virtual.",
    ["'npm run lint' ejecuta ESLint sobre todo el repositorio sin errores.",
     "'npm run check:syntax' valida la sintaxis de todos los archivos JavaScript.",
     "Existen los scripts test:unit, test:integration y test (check + unit + integration).",
     "Las pruebas usan el runner nativo node:test, sin dependencias externas de framework.",
     "Un workflow de GitHub Actions ejecuta 'npm test' en cada push y pull request y bloquea el merge si falla."],
    ["Las pruebas de integracion deben levantar un servidor aislado con un archivo de perfiles temporal."])

add(4, "Historia", "Almacen de perfiles con interfaz intercambiable (backend de archivo JSON)",
    "MC-FUND", "Highest", 5, ["backend", "persistencia"],
    "Como jugador quiero que mis fichas y mi progreso sobrevivan a recargas y reinicios del servidor, "
    "para no empezar de cero cada vez que entro.",
    ["Existe una clase base con la logica comun de perfiles y una implementacion sobre archivo JSON en data/profiles.json.",
     "La escritura es diferida y atomica (escribir a temporal + rename), de modo que un corte no deja el archivo corrupto.",
     "La ruta del archivo es configurable con PROFILE_STORE_PATH.",
     "Una factory decide el backend segun el entorno, y el resto del codigo solo depende de la interfaz, nunca de la implementacion.",
     "El metodo publico de progreso devuelve una lista explicita de campos y jamas expone el hash de contrasena."],
    ["Archivos de referencia: lib/profile-store-base.js, lib/profile-store.js, lib/profile-store-factory.js."])

add(5, "Historia", "Backend Postgres con migraciones y resiliencia ante arranque en frio",
    "MC-FUND", "High", 8, ["backend", "persistencia", "postgres"],
    "Como responsable del producto quiero que los perfiles persistan en Postgres en produccion, "
    "para no perder cuentas en planes de hosting sin disco persistente.",
    ["Si DATABASE_URL esta definida, los perfiles se guardan en Postgres en vez del archivo JSON.",
     "Si DATABASE_URL es invalida, el servidor falla al arrancar con un error claro en lugar de caer en silencio al archivo.",
     "La carga inicial reintenta con espera creciente mientras la base despierta; si no conecta, el proceso falla al arrancar en vez de continuar con memoria vacia.",
     "Cada guardado reintenta ante fallos transitorios y reprograma un reintento en segundo plano si la base sigue caida; ningun cambio se descarta en silencio.",
     "Existe un runner de migraciones SQL versionadas ('npm run migrate:db') idempotente y re-ejecutable.",
     "Hay pruebas con un Postgres simulado para el fallo transitorio que se recupera y para el fallo permanente que rechaza el arranque."],
    ["Pensado para el free tier de Neon (escala a cero tras inactividad).",
     "Carpeta migrations/ numerada: 000_profile_storage.sql en adelante."])

# ------------------------------------------------------------- SALAS / TIEMPO REAL
add(6, "Historia", "Crear y unirse a salas privadas mediante URL o codigo de 5 caracteres",
    "MC-SALA", "Highest", 5, ["backend", "frontend", "salas"],
    "Como jugador quiero crear una mesa y compartirla con mis amigos por un enlace o un codigo corto, "
    "para jugar juntos sin registros ni invitaciones complicadas.",
    ["Puedo crear una sala eligiendo juego y nombre; el servidor genera un codigo unico de 5 caracteres y una URL compartible.",
     "Puedo unirme pegando la URL o escribiendo el codigo; si la sala no existe o esta llena recibo un mensaje claro.",
     "La capacidad maxima es de 6 participantes y el servidor rechaza al septimo.",
     "El creador queda como anfitrion y es el unico que puede iniciar rondas y administrar bots.",
     "El servidor rechaza crear o unirse si la persona no acepto la version vigente de los Terminos."],
    ["La validacion de capacidad y rol se hace siempre en el servidor, nunca ocultando botones en el cliente."])

add(7, "Historia", "Estado autoritativo sincronizado por Socket.IO con privacidad de cartas",
    "MC-SALA", "Highest", 8, ["backend", "tiempo-real", "seguridad"],
    "Como jugador quiero que el servidor sea la unica fuente de verdad, para que nadie pueda hacer trampa "
    "manipulando el navegador ni espiando las cartas de los demas.",
    ["Toda accion del cliente es una intencion: el servidor revalida turno, fase, capacidad, importe y saldo antes de ejecutarla.",
     "El estado de la sala se difunde a los participantes tras cada cambio y el cliente solo renderiza lo que recibe.",
     "En poker y blackjack cada quien recibe unicamente sus cartas; las ajenas viajan boca abajo (XX) hasta el showdown o los resultados.",
     "Las animaciones del cliente (rueda, rodillos, dados) solo representan el resultado ya decidido por el servidor.",
     "Una prueba automatizada verifica que el payload enviado a un jugador no contiene las cartas de otro."],
    ["Este ticket bloquea a todos los de la epica de Juegos."])

add(8, "Historia", "Reconexion, migracion de anfitrion y limpieza de salas huerfanas",
    "MC-SALA", "High", 5, ["backend", "tiempo-real", "resiliencia"],
    "Como jugador quiero recuperar mi asiento si se me cae internet, y como grupo queremos que la mesa "
    "siga viva aunque el anfitrion desaparezca.",
    ["Si pierdo la conexion y vuelvo con el mismo token de dispositivo, recupero mi asiento, saldo y estado de ronda.",
     "Mientras estoy desconectado la interfaz de los demas muestra mi estado como 'reconectando'.",
     "Si el anfitrion queda inactivo un minuto, la autoridad de la mesa migra a una persona real activa.",
     "Al salir de la mesa, mis apuestas rapidas abiertas se reembolsan.",
     "Las salas sin personas reales se destruyen tras su TTL (BOT_ONLY_ROOM_TTL_MS, 5 minutos por defecto), cancelando temporizadores de IA, turnos y limpieza.",
     "El cliente reintenta la conexion automaticamente y muestra 'Despertando la sala...' mientras el servicio arranca."],
    [])

# ---------------------------------------------------------------------- JUEGOS
add(9, "Historia", "Motor de rondas, turnos y relojes autoritativos",
    "MC-JUEG", "Highest", 8, ["backend", "motor-juego"],
    "Como jugador quiero que las rondas avancen solas cuando alguien no responde, para que la partida "
    "nunca se quede atorada.",
    ["Existe una maquina de estados comun de ronda (espera, apuestas, juego, resolucion, resultados) reutilizada por todos los juegos.",
     "Cada turno tiene reloj visible en el cliente y limite autoritativo en el servidor (30 s en poker, 25 s en blackjack).",
     "Al expirar el turno el servidor aplica una accion segura por defecto (pasar si es posible, retirar la mano, o plantarse en blackjack).",
     "Los temporizadores no bloquean el bucle de eventos y se cancelan al destruir la sala.",
     "Humanos, bots y acciones por tiempo agotado pasan exactamente por los mismos ejecutores validados."],
    [])

add(10, "Tarea", "Evaluador completo de manos de poker",
    "MC-JUEG", "High", 5, ["backend", "motor-juego"],
    "Hold'em necesita una comparacion de manos exacta y probada antes de poder repartir dinero virtual.",
    ["El evaluador clasifica las 10 categorias de mano desde carta alta hasta escalera real.",
     "Elige la mejor combinacion de 5 cartas entre las 7 disponibles.",
     "Resuelve empates por kickers y detecta empates reales para repartir el bote.",
     "La rueda A-2-3-4-5 se reconoce como escalera baja.",
     "Hay pruebas unitarias con casos limite: dobles parejas con kicker, color contra escalera, empates exactos."],
    ["Archivo de referencia: lib/poker-evaluator.js."])

add(11, "Historia", "Texas Hold'em completo con ciegas, apuestas y botes laterales",
    "MC-JUEG", "Highest", 13, ["backend", "frontend", "juego:poker"],
    "Como jugador quiero una mesa de Texas Hold'em completa, porque es el juego principal del casino social.",
    ["Se reparten dos cartas privadas y las comunitarias por fases: flop, turn y river.",
     "Las ciegas rotan por mano y las acciones disponibles son retirarse, pasar, igualar, subir y all-in, validadas por el servidor.",
     "Las subidas respetan el minimo legal segun la apuesta previa.",
     "Los all-in generan botes laterales correctos cuando hay stacks distintos.",
     "En el showdown se revelan las manos implicadas, se declara ganador o empate y se acreditan las fichas.",
     "El historial reciente de la sala registra al ganador y el importe."],
    ["Depende de MC-9 (motor de rondas) y MC-10 (evaluador)."])

add(12, "Historia", "Torneos sit & go en la mesa de poker",
    "MC-JUEG", "Medium", 8, ["backend", "frontend", "juego:poker"],
    "Como grupo de amigos queremos un formato con eliminacion y un campeon, para darle un cierre "
    "emocionante a la sesion sin arriesgar el saldo real del perfil.",
    ["La entrada cuesta 200 fichas y cada participante arranca con un stack de torneo de 1000.",
     "Las ciegas se duplican cada 3 manos.",
     "La eliminacion asigna lugares en orden inverso y el campeon recibe el bote completo.",
     "Durante el torneo el saldo del perfil queda protegido: solo se mueve la entrada y el premio final.",
     "No existen recompras y la interfaz muestra nivel de ciegas, mano actual y lugares ya definidos."],
    [])

add(13, "Historia", "Blackjack con doblar, seguro y split",
    "MC-JUEG", "High", 8, ["backend", "frontend", "juego:blackjack"],
    "Como jugador quiero un Blackjack con las reglas clasicas completas, para que las decisiones tengan profundidad real.",
    ["Apuesta inicial minima de 10 fichas; acciones pedir, plantarse y doblar.",
     "El Blackjack natural paga 3:2.",
     "Cuando la casa muestra un as puedo contratar seguro por la mitad de mi apuesta, que paga 2:1 contra blackjack natural.",
     "Puedo dividir pares del mismo valor en dos manos independientes, cada una con su propia opcion de doblar.",
     "La carta oculta de la casa nunca viaja al cliente antes de la resolucion.",
     "Cada turno dura 25 segundos; al expirar el jugador se planta automaticamente."],
    [])

add(14, "Historia", "Ruleta Nova: pano europeo, pagos y rueda animada",
    "MC-JUEG", "High", 8, ["backend", "frontend", "juego:ruleta"],
    "Como jugador quiero apostar sobre un pano de ruleta europeo real y ver caer la bola, "
    "para que la ronda tenga tension visual sin dejar de ser justa.",
    ["El pano permite apostar por clic en numeros 0-36 y apuestas externas, con las fichas visibles sobre la casilla.",
     "Pagos: rojo/negro, par/impar, 1-18 y 19-36 pagan x2; docenas y columnas x3; pleno x36 (pago total sobre la apuesta).",
     "El cero es verde y hace perder todas las apuestas externas.",
     "El servidor decide el numero antes de la animacion; la rueda en canvas desacelera, rebota y cae exactamente en ese numero.",
     "La animacion se puede saltar y se respeta prefers-reduced-motion.",
     "Puedo retirar o modificar mis apuestas hasta que el anfitrion lanza la ronda."],
    [])

add(15, "Historia", "Juegos rapidos: Dados Cosmicos, Cara o Cruz y Tragamonedas",
    "MC-JUEG", "Medium", 8, ["backend", "frontend", "juegos-rapidos"],
    "Como grupo queremos rondas de menos de un minuto para jugar entre partidas largas, "
    "con superficies visuales propias y pagos claros.",
    ["Dados Cosmicos: apuesta a bajo (1-3) o alto (4-6) con pago x2, o a numero exacto con pago x6.",
     "Cara o Cruz: apuesta a cara o cruz con pago x2.",
     "Tragamonedas: tres rodillos con cinco simbolos ponderados (cereza, trebol, campana, diamante y el premium MonteCristo, el mas raro).",
     "Pagos de tragamonedas: tres iguales x5/x8/x12/x20/x40 segun simbolo; dos iguales devuelven la apuesta (x1); tres distintos pierden. La tabla de pagos esta visible.",
     "Cada participante confirma una sola apuesta por ronda, con minimo de 10 fichas.",
     "Solo el anfitrion lanza la ronda, pero el servidor genera y liquida el resultado.",
     "Las animaciones (dados, moneda y rodillos que se detienen en secuencia izquierda-centro-derecha) muestran exactamente el resultado ya decidido y se pueden saltar."],
    [])

# ------------------------------------------------------------------------ BOTS
add(17, "Historia", "Framework de bots autoritativos con dificultades, estilos y estrategias por juego",
    "MC-BOTS", "High", 13, ["backend", "bots"],
    "Como anfitrion quiero rellenar la mesa con jugadores automaticos creibles, para no depender de "
    "juntar seis personas al mismo tiempo.",
    ["Solo el anfitrion puede abrir el panel de bots, agregarlos, completar asientos libres o retirarlos; la capacidad total sigue siendo 6.",
     "El roster no puede alterarse durante una mano o lanzamiento activo.",
     "Cuatro dificultades (facil, normal, dificil, experto) con tiempos de reaccion distintos, multiplicables por BOT_SPEED_FACTOR en pruebas.",
     "Cinco estilos (conservador, agresivo, equilibrado, arriesgado, impredecible) que modifican riesgo, tamanos y frecuencia, nunca cartas ni reglas.",
     "Estrategias por juego: poker (retirarse/pasar/igualar/subir/all-in sobre informacion publica), blackjack (pedir/plantarse/doblar) y juegos rapidos (opcion e importe antes del lanzamiento).",
     "Ningun bot ve manos rivales, la carta oculta de la casa ni resultados futuros; las simulaciones generan cartas desconocidas y no consultan el mazo real.",
     "Si una estrategia falla, se registra el error, se intenta una alternativa valida y finalmente una accion segura; BOT_FORCE_DECISION_ERROR=1 permite probarlo.",
     "Los datos de los bots viven con la sala y no contaminan los perfiles persistentes."],
    ["Carpeta de referencia: lib/bots/."])

add(18, "Historia", "Mesas siempre vivas: autorelleno de asientos y cesion a personas reales",
    "MC-BOTS", "Medium", 5, ["backend", "bots", "retencion"],
    "Como jugador que entra solo a una sala quiero encontrar la mesa llena y jugando, "
    "para no esperar a que llegue alguien mas.",
    ["Al entrar a una sala, los asientos libres se completan automaticamente con bots expertos.",
     "Cuando llega una persona real, un bot cede su asiento al terminar la ronda en curso.",
     "Si no quedan personas, un bot puede asumir temporalmente el rol de anfitrion para automatizar rondas.",
     "La mesa se elimina tras el TTL si no vuelve ninguna persona real.",
     "Los asientos de bot muestran insignia BOT, dificultad, estilo, estado 'Pensando...' y su ultima accion, sin saturar la interfaz de avisos."],
    [])

# -------------------------------------------------------- PERFIL / ECONOMIA
add(19, "Historia", "Perfil persistente por dispositivo",
    "MC-PERF", "Highest", 5, ["backend", "frontend", "perfil"],
    "Como jugador quiero conservar mi nombre, avatar y fichas entre sesiones sin tener que registrarme, "
    "para entrar y jugar en segundos.",
    ["Al entrar por primera vez se crea un perfil con token local de dispositivo, nombre editable y avatar elegible.",
     "El perfil guarda saldo, victorias, rondas jugadas, mayor ganancia, rachas y juegos probados.",
     "El token de dispositivo solo sirve para continuidad del perfil invitado: no concede roles ni privilegios.",
     "El modal de perfil permite cambiar nombre y avatar y refleja los cambios en la mesa en tiempo real.",
     "Los cambios se persisten mediante el almacen de perfiles con escritura diferida."],
    ["Depende de MC-4."])

add(20, "Historia", "Economia de fichas virtuales y liquidacion de apuestas",
    "MC-PERF", "Highest", 5, ["backend", "economia"],
    "Como jugador quiero reglas economicas claras y justas, para confiar en que ninguna ficha se pierde ni se duplica.",
    ["Saldo inicial de 1000 fichas virtuales para cada perfil nuevo.",
     "Bono diario de 100 fichas, una sola vez por dia al entrar.",
     "Apuesta minima de 10 fichas en blackjack y juegos rapidos.",
     "Las fichas apostadas se descuentan en el servidor al confirmar la apuesta y los pagos se acreditan al resolver la ronda.",
     "Ninguna apuesta puede superar el saldo disponible; los intentos se rechazan con mensaje claro.",
     "Cada movimiento queda registrado como transaccion con juego, importe y resultado.",
     "La interfaz deja explicito que todo es virtual: no hay dinero real, depositos, retiros ni premios canjeables."],
    [])

add(21, "Historia", "Retos, logros y eventos especiales",
    "MC-PERF", "Medium", 5, ["frontend", "backend", "progresion"],
    "Como jugador quiero objetivos y sorpresas durante la sesion, para tener motivos de volver mas alla de ganar la mano.",
    ["Retos: jugar 3 rondas (+75), ganar una ronda (+50), apostar 250 fichas (+75), probar 2 juegos (+100).",
     "Logros: primera victoria (+50), racha de 3 (+100), recuperarse tras dos derrotas (+100), ganar 500 o mas en una ronda (+150), probar los 5 juegos (+250).",
     "Eventos especiales sorteados al abrir ronda: jackpot virtual (+500), ganancia x2 y ronda bonus (+75).",
     "Los eventos solo entregan fichas cuando existe una ganancia neta positiva.",
     "Los otorgamientos se calculan en el servidor y se notifican con una celebracion breve que no bloquea la partida.",
     "Un logro ya obtenido no se vuelve a pagar."],
    ["Archivos de referencia: lib/progression.js, lib/special-events.js."])

add(22, "Historia", "Estadisticas ampliadas, grafica de saldo e historial descargable",
    "MC-PERF", "Low", 5, ["frontend", "backend", "perfil"],
    "Como jugador quiero ver mi evolucion con datos, para saber en que juego me va bien y cuanto he mejorado.",
    ["El perfil muestra porcentaje de victorias y una grafica de evolucion del saldo persistida entre sesiones.",
     "Hay un desglose por juego con rondas, victorias y balance neto.",
     "Los topes de historial viven en una constante compartida: 60/20 puntos con archivo JSON y 2000/500 con Postgres activo.",
     "GET /api/perfil/:token/historial descarga en JSON el historial completo del propio perfil, con enlace en el modal de perfil.",
     "Un perfil no puede descargar el historial de otro."],
    ["Constante de referencia: HISTORY_LIMITS en lib/profile-store-shared.js."])

# ---------------------------------------------------------------------- SOCIAL
add(23, "Historia", "Lobby en vivo con tarjetas de juego y salas abiertas",
    "MC-SOCI", "High", 5, ["frontend", "lobby"],
    "Como visitante quiero ver de un vistazo que se esta jugando y entrar con un clic, "
    "para no depender de que alguien me pase un codigo.",
    ["El hero ofrece accesos directos a crear sala, entrar con codigo y explorar salas abiertas.",
     "Hay cinco tarjetas de juego con imagen original, descripcion, cantidad de jugadores, bots y duracion estimada.",
     "La lista de salas abiertas muestra fase, anfitrion, ocupacion, asientos libres y barra de capacidad, y se actualiza en vivo.",
     "Puedo filtrar por juego, fase y ocupacion.",
     "Las salas llenas muestran la accion 'Ver mesa' en lugar de 'Entrar'."],
    [])

add(24, "Historia", "Chat de sala con mensajes rapidos y reacciones",
    "MC-SOCI", "Medium", 5, ["frontend", "backend", "social"],
    "Como jugador quiero comentar la jugada en el momento, porque la gracia de jugar con amigos es la conversacion.",
    ["Chat libre por sala con nombre y avatar de quien escribe.",
     "Botones de mensajes rapidos predefinidos y reacciones (fuego, aplausos, risa, trebol, susto, diamante).",
     "La tecla T enfoca el chat y Enter envia.",
     "Los mensajes se validan en el servidor: longitud maxima, antiflood por remitente y filtro de contenido.",
     "Los espectadores participan con el prefijo de ojo.",
     "Los mensajes quedan disponibles como evidencia para reportes durante la ventana de retencion definida."],
    ["Coordinar con MC-31 (reportes): la evidencia en memoria no debe perderse al destruir la sala."])

add(25, "Historia", "Ranking mensual por temporadas con premios de fin de temporada",
    "MC-SOCI", "Medium", 8, ["frontend", "backend", "ranking"],
    "Como jugador competitivo quiero una tabla mensual con un cierre claro, para tener una meta "
    "que no dependa de jugar desde el primer dia.",
    ["El lobby muestra el top 10 de puntos de la temporada en curso y el podio del mes anterior.",
     "Los puntos se reinician el dia 1 de cada mes y todos vuelven a 1000 fichas; el bono diario de 100 se mantiene.",
     "El calendario de la temporada usa la zona horaria de CASINO_TIME_ZONE (America/Mexico_City por defecto), cerrando a medianoche local y no a las 00:00 UTC.",
     "Quien termina en primer lugar recibe un banner dorado unico de por vida y una medalla de oro acumulable por temporada ganada.",
     "Banner y medallas se muestran junto al nombre en el ranking y en el perfil.",
     "Al cerrar la temporada se descarta por completo la grafica de saldo de esa temporada; transacciones, estadisticas y logros no se tocan.",
     "El cambio de mes se vigila periodicamente, no solo al arrancar el servidor."],
    [])

add(26, "Historia", "Modo espectador en mesas llenas",
    "MC-SOCI", "Low", 5, ["frontend", "backend", "social"],
    "Como visitante quiero poder ver una mesa llena y tomar asiento cuando se libere un lugar, "
    "en lugar de quedarme fuera.",
    ["Las salas llenas muestran 'Ver mesa' en el lobby.",
     "Hasta 12 espectadores por mesa ven la partida en vivo, con las cartas ajenas siempre ocultas.",
     "Los espectadores participan en el chat con prefijo de ojo y no pueden apostar ni actuar.",
     "Puedo tomar asiento cuando se libera un lugar o cuando un bot lo cede, respetando el orden de llegada.",
     "El conteo de espectadores es visible para la mesa."],
    [])

# ------------------------------------------------------------ SEGURIDAD / ADMIN
add(27, "Historia", "Cuentas opcionales con usuario y contrasena",
    "MC-SEG", "High", 8, ["backend", "seguridad", "cuentas"],
    "Como jugador quiero poder vincular mi perfil a un usuario y contrasena, "
    "para recuperar mis fichas y logros desde otra computadora.",
    ["El modo invitado sigue funcionando igual: la cuenta es opcional y nunca obligatoria.",
     "Desde el lobby puedo crear una cuenta con mi perfil actual y despues iniciar sesion desde otra computadora recuperando fichas, logros e historial.",
     "Las contrasenas se guardan con scrypt y sal aleatoria; jamas en texto plano ni reversibles.",
     "Hay politica minima de contrasena y mensajes de error que no revelan si el usuario existe.",
     "Existe bloqueo temporal tras varios intentos fallidos, combinado con limite por IP para que un tercero no pueda bloquear a una victima.",
     "El login no devuelve el identificador del perfil como token de sesion."],
    ["No hay proveedor SMTP en el entorno: sin correo ni verificacion por correo."])

add(28, "Historia", "Sesiones de cuenta revocables con cookie HttpOnly y proteccion CSRF",
    "MC-SEG", "Highest", 8, ["backend", "seguridad", "sesiones"],
    "Como responsable de seguridad quiero sesiones reales del lado del servidor, "
    "porque ninguna funcion administrativa puede apoyarse en un identificador que aporta el cliente.",
    ["La sesion usa un token aleatorio opaco; en la base solo se guarda su hash.",
     "El token viaja en cookie HttpOnly, Secure en produccion y SameSite=Strict para administracion.",
     "Las sesiones tienen caducidad, renovacion controlada y pueden revocarse una a una o todas a la vez.",
     "Cerrar sesion invalida el token en el servidor, no solo en el navegador.",
     "Las peticiones que cambian estado validan origen y token CSRF.",
     "Socket.IO valida la sesion de cuenta al conectar y al reconectar.",
     "Existe migracion SQL para la tabla de sesiones y pruebas de expiracion, revocacion y carrera de snapshot de perfil."],
    ["Regla de ejecucion del plan: no empezar panel ni endpoints de moderacion antes de completar este ticket.",
     "Archivos de referencia: lib/account-sessions.js, lib/account-session-store-pg.js."])

add(29, "Historia", "Roles, permisos, MFA para personal y bootstrap del primer administrador",
    "MC-SEG", "High", 8, ["backend", "seguridad", "autorizacion"],
    "Como responsable de seguridad quiero autorizacion calculada en el servidor y segundo factor para el personal, "
    "para que una contrasena filtrada no entregue el panel completo.",
    ["Existen los roles user, moderator y admin, con una matriz de permisos explicita.",
     "El permiso se calcula siempre desde el rol vigente en base de datos, nunca desde datos del cliente, y se reautoriza en cada peticion.",
     "El personal (moderator y admin) requiere MFA TOTP obligatorio, con alta por codigo QR y codigos de respaldo.",
     "El primer administrador se promueve mediante una CLI ejecutada en el servidor ('npm run admin:role'), no por ruta web ni variable con contrasena.",
     "Existe una CLI para restablecer el MFA de una cuenta bloqueada ('npm run admin:mfa-reset').",
     "Ocultar botones en el navegador no se considera autorizacion: hay pruebas que llaman a los endpoints directamente con rol insuficiente y esperan 403."],
    ["Archivos de referencia: lib/permissions.js, lib/mfa.js, scripts/admin-role.js."])

add(30, "Historia", "Moderacion: suspension, baneo, desbaneo y expulsion en tiempo real",
    "MC-SEG", "High", 8, ["backend", "moderacion"],
    "Como moderador quiero poder sacar de inmediato a quien rompe las reglas, "
    "para que el dano no continue mientras se revisa el caso.",
    ["Puedo suspender temporalmente una cuenta con motivo y fecha de fin, y banearla de forma permanente.",
     "Al aplicar la sancion, las sesiones de esa cuenta se revocan y sus sockets se expulsan de inmediato de todas las salas.",
     "Una cuenta suspendida o baneada no puede crear ni unirse a salas y recibe un mensaje con el motivo y la fecha de fin.",
     "Puedo desbanear, lo que restituye el acceso sin devolver sesiones antiguas.",
     "Toda accion de moderacion exige motivo y queda auditada con autor, objetivo, motivo y fecha.",
     "Las acciones son idempotentes: reintentar la misma peticion no duplica la sancion.",
     "Existe migracion SQL para las acciones de moderacion y pruebas de cada transicion de estado."],
    ["Archivos de referencia: lib/moderation.js, lib/idempotency-http.js."])

add(31, "Historia", "Reportes de usuarios con evidencia de chat",
    "MC-SEG", "Medium", 8, ["backend", "frontend", "moderacion"],
    "Como jugador quiero reportar a alguien o un mensaje concreto, y como moderador quiero recibir "
    "el caso con su evidencia, para resolver con contexto y no de oidas.",
    ["Puedo reportar a un usuario o un mensaje desde la mesa, eligiendo categoria y agregando una descripcion.",
     "El reporte guarda la evidencia relevante (mensajes del contexto) de forma persistente, aunque la sala se destruya.",
     "Los reportes tienen estados: recibido, en revision, resuelto y descartado, con responsable asignado.",
     "Hay limite de reportes por persona y ventana de tiempo para evitar abuso.",
     "La evidencia aplica minimizacion de datos: solo lo necesario y con plazo de retencion definido.",
     "Existe migracion SQL para reportes y evidencia, con pruebas unitarias y de integracion HTTP."],
    ["Archivos de referencia: lib/reports.js, lib/report-http.js."])

add(32, "Historia", "Panel administrativo /admin separado del juego",
    "MC-SEG", "Medium", 8, ["frontend", "admin"],
    "Como administrador quiero una interfaz dedicada para operar, "
    "para no mezclar herramientas sensibles con la interfaz de los jugadores.",
    ["El panel vive en /admin con su propio HTML, CSS y JS, separado del cliente de juego.",
     "Vistas minimas: buscar cuentas, detalle de cuenta con acciones, bandeja de reportes, bitacora de auditoria y gestion de roles.",
     "Cada accion pide confirmacion y motivo, y muestra el resultado real devuelto por el servidor.",
     "El panel solo funciona sobre HTTPS en produccion y exige sesion de personal con MFA vigente.",
     "La interfaz no asume permisos: si el servidor responde 403, se muestra el estado correcto sin romper la vista.",
     "El panel no muestra contrasenas, hashes ni tokens completos en ningun momento."],
    ["Archivos de referencia: public/admin.html, public/admin.js, lib/admin-auth-http.js."])

add(33, "Historia", "Restablecimiento de contrasena y bitacora de auditoria",
    "MC-SEG", "Medium", 8, ["backend", "seguridad", "auditoria"],
    "Como administrador quiero poder devolver el acceso a una cuenta sin conocer nunca su contrasena, "
    "y que todo movimiento sensible quede registrado.",
    ["Un administrador puede iniciar un restablecimiento que genera un reto de un solo uso y con caducidad; nunca ve ni fija la contrasena existente.",
     "La persona completa el restablecimiento en /reset-password y elige una contrasena nueva, lo que revoca todas sus sesiones activas.",
     "Existe cambio voluntario de contrasena que exige la contrasena actual.",
     "La bitacora registra como minimo: login y logout de personal, cambios de rol, suspensiones, baneos, desbaneos, resoluciones de reportes y restablecimientos.",
     "Cada entrada guarda autor, accion, objetivo, motivo, fecha y origen, y es de solo anadir (no editable ni borrable desde la aplicacion).",
     "La bitacora es consultable y filtrable desde el panel, y existe migracion SQL dedicada."],
    ["Archivos de referencia: lib/password-reset-http.js, lib/audit-store.js."])

add(34, "Tarea", "Endurecimiento de seguridad: cabeceras, limites por IP e idempotencia",
    "MC-SEG", "High", 5, ["backend", "seguridad", "hardening"],
    "Antes de exponer el panel en produccion hay que cerrar las vias de abuso genericas.",
    ["Cabeceras de seguridad activas: CSP sin dependencias de CDN externos, HSTS en produccion, X-Content-Type-Options, Referrer-Policy y X-Frame-Options.",
     "Rate limiting por IP y por cuenta en login, registro, restablecimiento y endpoints administrativos.",
     "Los endpoints administrativos aceptan una clave de idempotencia para que un reintento no duplique la accion.",
     "Validacion estricta de origen y tipo de contenido en peticiones que cambian estado.",
     "Un preflight de despliegue ('npm run admin:preflight') falla si falta una variable critica o si el panel quedaria expuesto sin HTTPS.",
     "Existe documentacion de modelo de amenazas, rotacion de secretos y respuesta a incidentes."],
    ["Archivos de referencia: lib/security-hardening.js, lib/rate-limit.js, lib/deployment-preflight.js."])

# ---------------------------------------------------------------------- OPS/UX
add(35, "Historia", "Soporte exclusivo para escritorio, accesibilidad y atajos de teclado",
    "MC-OPS", "Medium", 5, ["frontend", "accesibilidad"],
    "Como producto decidimos soportar solo computadoras, y eso debe comunicarse bien "
    "sin dejar fuera a quien navega con teclado o necesita menos animacion.",
    ["Con ventanas menores a 1024 px de ancho se muestra una pantalla de bloqueo que invita a volver desde una computadora.",
     "La pantalla de bloqueo incluye 'Entrar de todos modos', cuya decision se recuerda en el navegador; en ese caso la pagina se desplaza horizontalmente.",
     "Resolucion minima soportada 1024x720 y diseno optimo desde 1280x800.",
     "Atajos en mesa: F/C/R/A en poker, H/S/D en blackjack, Enter confirma apuestas rapidas, T enfoca el chat y ? muestra la guia.",
     "Navegacion completa por teclado con foco visible, regiones en vivo para anuncios y contraste suficiente.",
     "Se respeta prefers-reduced-motion en todas las animaciones y ninguna animacion larga bloquea la partida.",
     "Estados visuales definidos para conexion, reconexion, desconexion, carga, foco, seleccion, deshabilitado, victoria, derrota y recepcion de fichas."],
    [])

add(36, "Historia", "Terminos, aviso de privacidad y retencion de datos",
    "MC-OPS", "High", 5, ["legal", "backend", "privacidad"],
    "Como operador en Mexico necesito dejar claro que el juego es recreativo y cumplir con la LFPDPPP, "
    "para operar sin ambiguedad legal.",
    ["Existe la pagina /terminos con naturaleza recreativa, requisito 18+, deslinde de responsabilidad y Aviso de Privacidad conforme a la LFPDPPP.",
     "La aceptacion es obligatoria y versionada; el servidor rechaza crear o unirse a salas sin la aceptacion vigente.",
     "Al publicar una version nueva de los terminos se vuelve a pedir la aceptacion.",
     "Se borran por completo los perfiles sin actividad por mas de ~3 meses, incluida su fila en Postgres, no solo la copia en memoria.",
     "La limpieza corre periodicamente y existe un comando para revisar ('npm run retention:check') y ejecutar ('npm run retention:cleanup').",
     "Los plazos de retencion de reportes, evidencia y auditoria estan documentados y se aplican automaticamente."],
    ["Archivos de referencia: lib/terms.js, lib/retention.js, public/terminos.html."])

add(37, "Tarea", "Despliegue en Render con infraestructura versionada y pruebas de operacion",
    "MC-OPS", "High", 5, ["devops", "despliegue"],
    "El proyecto debe poder desplegarse de forma reproducible y sobrevivir a reinicios, deploys y planes gratuitos.",
    ["render.yaml versiona el servicio: build, start, health check en /healthz, variables de entorno y disco persistente en /var/data.",
     "Esta documentada la opcion 100% gratuita sin tarjeta (Render Free + Postgres de Neon mediante DATABASE_URL, sin disco).",
     "Los deploys son sin caida gracias al health check y al apagado ordenado con SIGTERM.",
     "Una prueba de operacion verifica que dos arranques con el mismo almacenamiento no pierden perfiles y que SIGTERM produce una salida ordenada.",
     "La guia de despliegue paso a paso esta en el repositorio y el README enlaza a ella.",
     "Los entornos de vista previa por pull request estan configurados y se destruyen solos."],
    ["Nota: el plan free de Render no admite discos y suspende el servicio tras ~15 min."])

assert len(T) == 35, "Se esperaban 35 tickets, hay %d" % len(T)

HERE = os.path.dirname(os.path.abspath(__file__))
EPIC_NAME = {k: n for k, n, _ in EPICS}


def descripcion(t):
    partes = ["*Contexto*", t["contexto"], "", "*Criterios de aceptacion*"]
    partes += ["%d. %s" % (i + 1, c) for i, c in enumerate(t["criterios"])]
    if t["notas"]:
        partes += ["", "*Notas tecnicas*"] + ["- %s" % n for n in t["notas"]]
    partes += ["", "*Definicion de terminado*",
               "- Codigo revisado y fusionado en main.",
               "- Pruebas automatizadas cubriendo los criterios, en verde en CI.",
               "- Validado manualmente en un entorno de vista previa.",
               "- Documentacion (README o docs/) actualizada si cambia el comportamiento."]
    return "\n".join(partes)


# --------------------------------------------------------------- CSV de epics
with open(os.path.join(HERE, "montecristo-epics.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL)
    w.writerow(["Issue Type", "Summary", "Epic Name", "Description", "Priority"])
    for key, nombre, desc in EPICS:
        w.writerow(["Epic", nombre, nombre, desc, "High"])

# ------------------------------------------------------------- CSV de tickets
with open(os.path.join(HERE, "montecristo-tickets.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL)
    w.writerow(["Issue Type", "Summary", "Description", "Priority", "Story Points",
                "Epic Link", "Labels", "Labels", "Labels", "Component"])
    for t in T:
        labels = (t["labels"] + ["", "", ""])[:3]
        w.writerow([t["tipo"], t["resumen"], descripcion(t), t["prioridad"], t["puntos"],
                    EPIC_NAME[t["epic"]], labels[0], labels[1], labels[2],
                    EPIC_NAME[t["epic"]]])

# -------------------------------------------------------------------- BACKLOG
lineas = [
    "# Backlog de reconstruccion — MonteCristo Social Casino",
    "",
    "35 tickets que cubren la construccion completa del producto desde cero, en el orden en que",
    "conviene abordarlos. Pensados para importarse a Jira con los CSV de esta misma carpeta.",
    "",
    "- `montecristo-epics.csv` — 8 epics. **Importar primero.**",
    "- `montecristo-tickets.csv` — los 35 tickets, enlazados a su epic por nombre (`Epic Link`).",
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
lineas += ["", "## Tickets", ""]

for key, nombre, desc in EPICS:
    lineas += ["### Epic: %s" % nombre, "", desc, ""]
    for t in [x for x in T if x["epic"] == key]:
        lineas += [
            "#### %d. %s" % (t["num"], t["resumen"]),
            "",
            "`%s` · Prioridad **%s** · **%d** puntos · etiquetas: %s" %
            (t["tipo"], t["prioridad"], t["puntos"], ", ".join("`%s`" % l for l in t["labels"])),
            "",
            "**Contexto.** " + t["contexto"],
            "",
            "**Criterios de aceptacion**",
            "",
        ]
        lineas += ["%d. %s" % (i + 1, c) for i, c in enumerate(t["criterios"])]
        if t["notas"]:
            lineas += ["", "**Notas tecnicas**", ""] + ["- %s" % n for n in t["notas"]]
        lineas.append("")

lineas += [
    "## Como importar en Jira",
    "",
    "1. **Configuracion > Sistema > Importar y exportar > Importar datos externos > CSV** "
    "(o *Project settings > Import issues* en un proyecto de equipo).",
    "2. Sube primero `montecristo-epics.csv` y mapea `Epic Name`.",
    "3. Sube despues `montecristo-tickets.csv` y mapea las columnas: *Issue Type, Summary, "
    "Description, Priority, Story Points, Epic Link, Labels (x3), Component*.",
    "4. Si tu proyecto usa nombres de prioridad distintos (p. ej. *Highest/High/Medium/Low*), "
    "ajusta el mapeo de valores en el paso de importacion.",
    "5. En proyectos *team-managed*, `Epic Link` puede llamarse `Parent`: renombra la columna "
    "antes de importar o usa el mapeo equivalente.",
    "",
    "Para regenerar estos archivos: `python3 docs/jira/generar-tickets.py`.",
    "",
]

with open(os.path.join(HERE, "BACKLOG.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(lineas))

print("OK: %d epics, %d tickets, %d puntos" %
      (len(EPICS), len(T), sum(t["puntos"] for t in T)))
