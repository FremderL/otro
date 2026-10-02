# Backlog de reconstruccion — MonteCristo Social Casino

35 tickets que cubren la construccion completa del producto desde cero, en el orden en que
conviene abordarlos. Pensados para importarse a Jira con los CSV de esta misma carpeta.

- `montecristo-epics.csv` — 8 epics. **Importar primero.**
- `montecristo-tickets.csv` — los 35 tickets, enlazados a su epic por nombre (`Epic Link`).

## Resumen

| Epic | Tickets | Puntos |
| --- | ---: | ---: |
| Fundaciones y plataforma | 4 | 21 |
| Salas y tiempo real | 3 | 18 |
| Juegos de casino | 7 | 58 |
| Bots e IA autoritativa | 2 | 18 |
| Perfil, economia y progresion | 4 | 20 |
| Social y descubrimiento | 4 | 23 |
| Cuentas, seguridad y administracion | 8 | 61 |
| Experiencia, legal y operacion | 3 | 15 |
| **Total** | **35** | **234** |

## Tickets

### Epic: Fundaciones y plataforma

Esqueleto del servidor, calidad de codigo, persistencia de perfiles y base de datos.

#### 1. Bootstrap del proyecto, servidor base y observabilidad

`Tarea` · Prioridad **Highest** · **5** puntos · etiquetas: `backend`, `setup`, `observabilidad`

**Contexto.** Sin un esqueleto ejecutable y observable no se puede empezar ninguna otra historia. Este ticket deja el repositorio corriendo en local con un servidor que sirve el cliente estatico, acepta conexiones de tiempo real y es diagnosticable desde el visor de logs del hosting.

**Criterios de aceptacion**

1. Dado el repositorio recien clonado, cuando ejecuto 'npm install && npm start', entonces el servidor levanta en 0.0.0.0 respetando la variable PORT (3000 por defecto).
2. El servidor sirve los archivos de /public (index.html, styles.css, app.js) con compresion habilitada.
3. Socket.IO queda montado sobre el mismo servidor HTTP y un cliente puede conectarse y recibir un evento de bienvenida.
4. package.json declara engines node >= 18 y los scripts start/dev.
5. GET /healthz responde 200 con estado, uptime, numero de salas, jugadores humanos conectados y version de T&C.
6. Los eventos operativos (arranque, sala creada/destruida, jugador entra/sale, apagado) se emiten como JSON por linea, y LOG_JSON=off vuelve a logs legibles.
7. Los logs nunca contienen contrasenas, cookies, tokens completos ni hashes.
8. Ante SIGTERM el servidor avisa a las mesas, guarda el estado y cierra los sockets antes de salir, con margen configurable por SHUTDOWN_GRACE_MS.
9. El README documenta como ejecutar el proyecto en local.

**Notas tecnicas**

- Dependencias: express, socket.io, compression.
- Mantener server.js como punto de entrada y lib/ para modulos de dominio.
- Grace por defecto: 10000 ms con Postgres y 2500 ms con archivo local.

#### 2. Pipeline de calidad: ESLint, verificacion de sintaxis, node:test y CI

`Tarea` · Prioridad **High** · **3** puntos · etiquetas: `calidad`, `ci`

**Contexto.** Se necesita una red de seguridad automatica antes de tocar autenticacion, autorizacion y dinero virtual.

**Criterios de aceptacion**

1. 'npm run lint' ejecuta ESLint sobre todo el repositorio sin errores.
2. 'npm run check:syntax' valida la sintaxis de todos los archivos JavaScript.
3. Existen los scripts test:unit, test:integration y test (check + unit + integration).
4. Las pruebas usan el runner nativo node:test, sin dependencias externas de framework.
5. Un workflow de GitHub Actions ejecuta 'npm test' en cada push y pull request y bloquea el merge si falla.

**Notas tecnicas**

- Las pruebas de integracion deben levantar un servidor aislado con un archivo de perfiles temporal.

#### 3. Almacen de perfiles con interfaz intercambiable (backend de archivo JSON)

`Historia` · Prioridad **Highest** · **5** puntos · etiquetas: `backend`, `persistencia`

**Contexto.** Como jugador quiero que mis fichas y mi progreso sobrevivan a recargas y reinicios del servidor, para no empezar de cero cada vez que entro.

**Criterios de aceptacion**

1. Existe una clase base con la logica comun de perfiles y una implementacion sobre archivo JSON en data/profiles.json.
2. La escritura es diferida y atomica (escribir a temporal + rename), de modo que un corte no deja el archivo corrupto.
3. La ruta del archivo es configurable con PROFILE_STORE_PATH.
4. Una factory decide el backend segun el entorno, y el resto del codigo solo depende de la interfaz, nunca de la implementacion.
5. El metodo publico de progreso devuelve una lista explicita de campos y jamas expone el hash de contrasena.

**Notas tecnicas**

- Archivos de referencia: lib/profile-store-base.js, lib/profile-store.js, lib/profile-store-factory.js.

#### 4. Backend Postgres con migraciones y resiliencia ante arranque en frio

`Historia` · Prioridad **High** · **8** puntos · etiquetas: `backend`, `persistencia`, `postgres`

**Contexto.** Como responsable del producto quiero que los perfiles persistan en Postgres en produccion, para no perder cuentas en planes de hosting sin disco persistente.

**Criterios de aceptacion**

1. Si DATABASE_URL esta definida, los perfiles se guardan en Postgres en vez del archivo JSON.
2. Si DATABASE_URL es invalida, el servidor falla al arrancar con un error claro en lugar de caer en silencio al archivo.
3. La carga inicial reintenta con espera creciente mientras la base despierta; si no conecta, el proceso falla al arrancar en vez de continuar con memoria vacia.
4. Cada guardado reintenta ante fallos transitorios y reprograma un reintento en segundo plano si la base sigue caida; ningun cambio se descarta en silencio.
5. Existe un runner de migraciones SQL versionadas ('npm run migrate:db') idempotente y re-ejecutable.
6. Hay pruebas con un Postgres simulado para el fallo transitorio que se recupera y para el fallo permanente que rechaza el arranque.

**Notas tecnicas**

- Pensado para el free tier de Neon (escala a cero tras inactividad).
- Carpeta migrations/ numerada: 000_profile_storage.sql en adelante.

### Epic: Salas y tiempo real

Creacion de salas compartibles, estado autoritativo, sincronizacion y resiliencia de sesion.

#### 5. Crear y unirse a salas privadas mediante URL o codigo de 5 caracteres

`Historia` · Prioridad **Highest** · **5** puntos · etiquetas: `backend`, `frontend`, `salas`

**Contexto.** Como jugador quiero crear una mesa y compartirla con mis amigos por un enlace o un codigo corto, para jugar juntos sin registros ni invitaciones complicadas.

**Criterios de aceptacion**

1. Puedo crear una sala eligiendo juego y nombre; el servidor genera un codigo unico de 5 caracteres y una URL compartible.
2. Puedo unirme pegando la URL o escribiendo el codigo; si la sala no existe o esta llena recibo un mensaje claro.
3. La capacidad maxima es de 6 participantes y el servidor rechaza al septimo.
4. El creador queda como anfitrion y es el unico que puede iniciar rondas y administrar bots.
5. El servidor rechaza crear o unirse si la persona no acepto la version vigente de los Terminos.

**Notas tecnicas**

- La validacion de capacidad y rol se hace siempre en el servidor, nunca ocultando botones en el cliente.

#### 6. Estado autoritativo sincronizado por Socket.IO con privacidad de cartas

`Historia` · Prioridad **Highest** · **8** puntos · etiquetas: `backend`, `tiempo-real`, `seguridad`

**Contexto.** Como jugador quiero que el servidor sea la unica fuente de verdad, para que nadie pueda hacer trampa manipulando el navegador ni espiando las cartas de los demas.

**Criterios de aceptacion**

1. Toda accion del cliente es una intencion: el servidor revalida turno, fase, capacidad, importe y saldo antes de ejecutarla.
2. El estado de la sala se difunde a los participantes tras cada cambio y el cliente solo renderiza lo que recibe.
3. En poker y blackjack cada quien recibe unicamente sus cartas; las ajenas viajan boca abajo (XX) hasta el showdown o los resultados.
4. Las animaciones del cliente (rueda, rodillos, dados) solo representan el resultado ya decidido por el servidor.
5. Una prueba automatizada verifica que el payload enviado a un jugador no contiene las cartas de otro.

**Notas tecnicas**

- Este ticket bloquea a todos los de la epica de Juegos.

#### 7. Reconexion, migracion de anfitrion y limpieza de salas huerfanas

`Historia` · Prioridad **High** · **5** puntos · etiquetas: `backend`, `tiempo-real`, `resiliencia`

**Contexto.** Como jugador quiero recuperar mi asiento si se me cae internet, y como grupo queremos que la mesa siga viva aunque el anfitrion desaparezca.

**Criterios de aceptacion**

1. Si pierdo la conexion y vuelvo con el mismo token de dispositivo, recupero mi asiento, saldo y estado de ronda.
2. Mientras estoy desconectado la interfaz de los demas muestra mi estado como 'reconectando'.
3. Si el anfitrion queda inactivo un minuto, la autoridad de la mesa migra a una persona real activa.
4. Al salir de la mesa, mis apuestas rapidas abiertas se reembolsan.
5. Las salas sin personas reales se destruyen tras su TTL (BOT_ONLY_ROOM_TTL_MS, 5 minutos por defecto), cancelando temporizadores de IA, turnos y limpieza.
6. El cliente reintenta la conexion automaticamente y muestra 'Despertando la sala...' mientras el servicio arranca.

### Epic: Juegos de casino

Motor de rondas y los seis juegos: Hold'em, torneo, Blackjack, Ruleta, juegos rapidos y tragamonedas.

#### 8. Motor de rondas, turnos y relojes autoritativos

`Historia` · Prioridad **Highest** · **8** puntos · etiquetas: `backend`, `motor-juego`

**Contexto.** Como jugador quiero que las rondas avancen solas cuando alguien no responde, para que la partida nunca se quede atorada.

**Criterios de aceptacion**

1. Existe una maquina de estados comun de ronda (espera, apuestas, juego, resolucion, resultados) reutilizada por todos los juegos.
2. Cada turno tiene reloj visible en el cliente y limite autoritativo en el servidor (30 s en poker, 25 s en blackjack).
3. Al expirar el turno el servidor aplica una accion segura por defecto (pasar si es posible, retirar la mano, o plantarse en blackjack).
4. Los temporizadores no bloquean el bucle de eventos y se cancelan al destruir la sala.
5. Humanos, bots y acciones por tiempo agotado pasan exactamente por los mismos ejecutores validados.

#### 9. Evaluador completo de manos de poker

`Tarea` · Prioridad **High** · **5** puntos · etiquetas: `backend`, `motor-juego`

**Contexto.** Hold'em necesita una comparacion de manos exacta y probada antes de poder repartir dinero virtual.

**Criterios de aceptacion**

1. El evaluador clasifica las 10 categorias de mano desde carta alta hasta escalera real.
2. Elige la mejor combinacion de 5 cartas entre las 7 disponibles.
3. Resuelve empates por kickers y detecta empates reales para repartir el bote.
4. La rueda A-2-3-4-5 se reconoce como escalera baja.
5. Hay pruebas unitarias con casos limite: dobles parejas con kicker, color contra escalera, empates exactos.

**Notas tecnicas**

- Archivo de referencia: lib/poker-evaluator.js.

#### 10. Texas Hold'em completo con ciegas, apuestas y botes laterales

`Historia` · Prioridad **Highest** · **13** puntos · etiquetas: `backend`, `frontend`, `juego:poker`

**Contexto.** Como jugador quiero una mesa de Texas Hold'em completa, porque es el juego principal del casino social.

**Criterios de aceptacion**

1. Se reparten dos cartas privadas y las comunitarias por fases: flop, turn y river.
2. Las ciegas rotan por mano y las acciones disponibles son retirarse, pasar, igualar, subir y all-in, validadas por el servidor.
3. Las subidas respetan el minimo legal segun la apuesta previa.
4. Los all-in generan botes laterales correctos cuando hay stacks distintos.
5. En el showdown se revelan las manos implicadas, se declara ganador o empate y se acreditan las fichas.
6. El historial reciente de la sala registra al ganador y el importe.

**Notas tecnicas**

- Depende de MC-9 (motor de rondas) y MC-10 (evaluador).

#### 11. Torneos sit & go en la mesa de poker

`Historia` · Prioridad **Medium** · **8** puntos · etiquetas: `backend`, `frontend`, `juego:poker`

**Contexto.** Como grupo de amigos queremos un formato con eliminacion y un campeon, para darle un cierre emocionante a la sesion sin arriesgar el saldo real del perfil.

**Criterios de aceptacion**

1. La entrada cuesta 200 fichas y cada participante arranca con un stack de torneo de 1000.
2. Las ciegas se duplican cada 3 manos.
3. La eliminacion asigna lugares en orden inverso y el campeon recibe el bote completo.
4. Durante el torneo el saldo del perfil queda protegido: solo se mueve la entrada y el premio final.
5. No existen recompras y la interfaz muestra nivel de ciegas, mano actual y lugares ya definidos.

#### 12. Blackjack con doblar, seguro y split

`Historia` · Prioridad **High** · **8** puntos · etiquetas: `backend`, `frontend`, `juego:blackjack`

**Contexto.** Como jugador quiero un Blackjack con las reglas clasicas completas, para que las decisiones tengan profundidad real.

**Criterios de aceptacion**

1. Apuesta inicial minima de 10 fichas; acciones pedir, plantarse y doblar.
2. El Blackjack natural paga 3:2.
3. Cuando la casa muestra un as puedo contratar seguro por la mitad de mi apuesta, que paga 2:1 contra blackjack natural.
4. Puedo dividir pares del mismo valor en dos manos independientes, cada una con su propia opcion de doblar.
5. La carta oculta de la casa nunca viaja al cliente antes de la resolucion.
6. Cada turno dura 25 segundos; al expirar el jugador se planta automaticamente.

#### 13. Ruleta Nova: pano europeo, pagos y rueda animada

`Historia` · Prioridad **High** · **8** puntos · etiquetas: `backend`, `frontend`, `juego:ruleta`

**Contexto.** Como jugador quiero apostar sobre un pano de ruleta europeo real y ver caer la bola, para que la ronda tenga tension visual sin dejar de ser justa.

**Criterios de aceptacion**

1. El pano permite apostar por clic en numeros 0-36 y apuestas externas, con las fichas visibles sobre la casilla.
2. Pagos: rojo/negro, par/impar, 1-18 y 19-36 pagan x2; docenas y columnas x3; pleno x36 (pago total sobre la apuesta).
3. El cero es verde y hace perder todas las apuestas externas.
4. El servidor decide el numero antes de la animacion; la rueda en canvas desacelera, rebota y cae exactamente en ese numero.
5. La animacion se puede saltar y se respeta prefers-reduced-motion.
6. Puedo retirar o modificar mis apuestas hasta que el anfitrion lanza la ronda.

#### 14. Juegos rapidos: Dados Cosmicos, Cara o Cruz y Tragamonedas

`Historia` · Prioridad **Medium** · **8** puntos · etiquetas: `backend`, `frontend`, `juegos-rapidos`

**Contexto.** Como grupo queremos rondas de menos de un minuto para jugar entre partidas largas, con superficies visuales propias y pagos claros.

**Criterios de aceptacion**

1. Dados Cosmicos: apuesta a bajo (1-3) o alto (4-6) con pago x2, o a numero exacto con pago x6.
2. Cara o Cruz: apuesta a cara o cruz con pago x2.
3. Tragamonedas: tres rodillos con cinco simbolos ponderados (cereza, trebol, campana, diamante y el premium MonteCristo, el mas raro).
4. Pagos de tragamonedas: tres iguales x5/x8/x12/x20/x40 segun simbolo; dos iguales devuelven la apuesta (x1); tres distintos pierden. La tabla de pagos esta visible.
5. Cada participante confirma una sola apuesta por ronda, con minimo de 10 fichas.
6. Solo el anfitrion lanza la ronda, pero el servidor genera y liquida el resultado.
7. Las animaciones (dados, moneda y rodillos que se detienen en secuencia izquierda-centro-derecha) muestran exactamente el resultado ya decidido y se pueden saltar.

### Epic: Bots e IA autoritativa

Jugadores automaticos configurables que nunca deciden resultados ni ven informacion privilegiada.

#### 15. Framework de bots autoritativos con dificultades, estilos y estrategias por juego

`Historia` · Prioridad **High** · **13** puntos · etiquetas: `backend`, `bots`

**Contexto.** Como anfitrion quiero rellenar la mesa con jugadores automaticos creibles, para no depender de juntar seis personas al mismo tiempo.

**Criterios de aceptacion**

1. Solo el anfitrion puede abrir el panel de bots, agregarlos, completar asientos libres o retirarlos; la capacidad total sigue siendo 6.
2. El roster no puede alterarse durante una mano o lanzamiento activo.
3. Cuatro dificultades (facil, normal, dificil, experto) con tiempos de reaccion distintos, multiplicables por BOT_SPEED_FACTOR en pruebas.
4. Cinco estilos (conservador, agresivo, equilibrado, arriesgado, impredecible) que modifican riesgo, tamanos y frecuencia, nunca cartas ni reglas.
5. Estrategias por juego: poker (retirarse/pasar/igualar/subir/all-in sobre informacion publica), blackjack (pedir/plantarse/doblar) y juegos rapidos (opcion e importe antes del lanzamiento).
6. Ningun bot ve manos rivales, la carta oculta de la casa ni resultados futuros; las simulaciones generan cartas desconocidas y no consultan el mazo real.
7. Si una estrategia falla, se registra el error, se intenta una alternativa valida y finalmente una accion segura; BOT_FORCE_DECISION_ERROR=1 permite probarlo.
8. Los datos de los bots viven con la sala y no contaminan los perfiles persistentes.

**Notas tecnicas**

- Carpeta de referencia: lib/bots/.

#### 16. Mesas siempre vivas: autorelleno de asientos y cesion a personas reales

`Historia` · Prioridad **Medium** · **5** puntos · etiquetas: `backend`, `bots`, `retencion`

**Contexto.** Como jugador que entra solo a una sala quiero encontrar la mesa llena y jugando, para no esperar a que llegue alguien mas.

**Criterios de aceptacion**

1. Al entrar a una sala, los asientos libres se completan automaticamente con bots expertos.
2. Cuando llega una persona real, un bot cede su asiento al terminar la ronda en curso.
3. Si no quedan personas, un bot puede asumir temporalmente el rol de anfitrion para automatizar rondas.
4. La mesa se elimina tras el TTL si no vuelve ninguna persona real.
5. Los asientos de bot muestran insignia BOT, dificultad, estilo, estado 'Pensando...' y su ultima accion, sin saturar la interfaz de avisos.

### Epic: Perfil, economia y progresion

Perfil por dispositivo, fichas virtuales, retos, logros, eventos y estadisticas.

#### 17. Perfil persistente por dispositivo

`Historia` · Prioridad **Highest** · **5** puntos · etiquetas: `backend`, `frontend`, `perfil`

**Contexto.** Como jugador quiero conservar mi nombre, avatar y fichas entre sesiones sin tener que registrarme, para entrar y jugar en segundos.

**Criterios de aceptacion**

1. Al entrar por primera vez se crea un perfil con token local de dispositivo, nombre editable y avatar elegible.
2. El perfil guarda saldo, victorias, rondas jugadas, mayor ganancia, rachas y juegos probados.
3. El token de dispositivo solo sirve para continuidad del perfil invitado: no concede roles ni privilegios.
4. El modal de perfil permite cambiar nombre y avatar y refleja los cambios en la mesa en tiempo real.
5. Los cambios se persisten mediante el almacen de perfiles con escritura diferida.

**Notas tecnicas**

- Depende de MC-4.

#### 18. Economia de fichas virtuales y liquidacion de apuestas

`Historia` · Prioridad **Highest** · **5** puntos · etiquetas: `backend`, `economia`

**Contexto.** Como jugador quiero reglas economicas claras y justas, para confiar en que ninguna ficha se pierde ni se duplica.

**Criterios de aceptacion**

1. Saldo inicial de 1000 fichas virtuales para cada perfil nuevo.
2. Bono diario de 100 fichas, una sola vez por dia al entrar.
3. Apuesta minima de 10 fichas en blackjack y juegos rapidos.
4. Las fichas apostadas se descuentan en el servidor al confirmar la apuesta y los pagos se acreditan al resolver la ronda.
5. Ninguna apuesta puede superar el saldo disponible; los intentos se rechazan con mensaje claro.
6. Cada movimiento queda registrado como transaccion con juego, importe y resultado.
7. La interfaz deja explicito que todo es virtual: no hay dinero real, depositos, retiros ni premios canjeables.

#### 19. Retos, logros y eventos especiales

`Historia` · Prioridad **Medium** · **5** puntos · etiquetas: `frontend`, `backend`, `progresion`

**Contexto.** Como jugador quiero objetivos y sorpresas durante la sesion, para tener motivos de volver mas alla de ganar la mano.

**Criterios de aceptacion**

1. Retos: jugar 3 rondas (+75), ganar una ronda (+50), apostar 250 fichas (+75), probar 2 juegos (+100).
2. Logros: primera victoria (+50), racha de 3 (+100), recuperarse tras dos derrotas (+100), ganar 500 o mas en una ronda (+150), probar los 5 juegos (+250).
3. Eventos especiales sorteados al abrir ronda: jackpot virtual (+500), ganancia x2 y ronda bonus (+75).
4. Los eventos solo entregan fichas cuando existe una ganancia neta positiva.
5. Los otorgamientos se calculan en el servidor y se notifican con una celebracion breve que no bloquea la partida.
6. Un logro ya obtenido no se vuelve a pagar.

**Notas tecnicas**

- Archivos de referencia: lib/progression.js, lib/special-events.js.

#### 20. Estadisticas ampliadas, grafica de saldo e historial descargable

`Historia` · Prioridad **Low** · **5** puntos · etiquetas: `frontend`, `backend`, `perfil`

**Contexto.** Como jugador quiero ver mi evolucion con datos, para saber en que juego me va bien y cuanto he mejorado.

**Criterios de aceptacion**

1. El perfil muestra porcentaje de victorias y una grafica de evolucion del saldo persistida entre sesiones.
2. Hay un desglose por juego con rondas, victorias y balance neto.
3. Los topes de historial viven en una constante compartida: 60/20 puntos con archivo JSON y 2000/500 con Postgres activo.
4. GET /api/perfil/:token/historial descarga en JSON el historial completo del propio perfil, con enlace en el modal de perfil.
5. Un perfil no puede descargar el historial de otro.

**Notas tecnicas**

- Constante de referencia: HISTORY_LIMITS en lib/profile-store-shared.js.

### Epic: Social y descubrimiento

Lobby, chat, ranking mensual por temporadas y modo espectador.

#### 21. Lobby en vivo con tarjetas de juego y salas abiertas

`Historia` · Prioridad **High** · **5** puntos · etiquetas: `frontend`, `lobby`

**Contexto.** Como visitante quiero ver de un vistazo que se esta jugando y entrar con un clic, para no depender de que alguien me pase un codigo.

**Criterios de aceptacion**

1. El hero ofrece accesos directos a crear sala, entrar con codigo y explorar salas abiertas.
2. Hay cinco tarjetas de juego con imagen original, descripcion, cantidad de jugadores, bots y duracion estimada.
3. La lista de salas abiertas muestra fase, anfitrion, ocupacion, asientos libres y barra de capacidad, y se actualiza en vivo.
4. Puedo filtrar por juego, fase y ocupacion.
5. Las salas llenas muestran la accion 'Ver mesa' en lugar de 'Entrar'.

#### 22. Chat de sala con mensajes rapidos y reacciones

`Historia` · Prioridad **Medium** · **5** puntos · etiquetas: `frontend`, `backend`, `social`

**Contexto.** Como jugador quiero comentar la jugada en el momento, porque la gracia de jugar con amigos es la conversacion.

**Criterios de aceptacion**

1. Chat libre por sala con nombre y avatar de quien escribe.
2. Botones de mensajes rapidos predefinidos y reacciones (fuego, aplausos, risa, trebol, susto, diamante).
3. La tecla T enfoca el chat y Enter envia.
4. Los mensajes se validan en el servidor: longitud maxima, antiflood por remitente y filtro de contenido.
5. Los espectadores participan con el prefijo de ojo.
6. Los mensajes quedan disponibles como evidencia para reportes durante la ventana de retencion definida.

**Notas tecnicas**

- Coordinar con MC-31 (reportes): la evidencia en memoria no debe perderse al destruir la sala.

#### 23. Ranking mensual por temporadas con premios de fin de temporada

`Historia` · Prioridad **Medium** · **8** puntos · etiquetas: `frontend`, `backend`, `ranking`

**Contexto.** Como jugador competitivo quiero una tabla mensual con un cierre claro, para tener una meta que no dependa de jugar desde el primer dia.

**Criterios de aceptacion**

1. El lobby muestra el top 10 de puntos de la temporada en curso y el podio del mes anterior.
2. Los puntos se reinician el dia 1 de cada mes y todos vuelven a 1000 fichas; el bono diario de 100 se mantiene.
3. El calendario de la temporada usa la zona horaria de CASINO_TIME_ZONE (America/Mexico_City por defecto), cerrando a medianoche local y no a las 00:00 UTC.
4. Quien termina en primer lugar recibe un banner dorado unico de por vida y una medalla de oro acumulable por temporada ganada.
5. Banner y medallas se muestran junto al nombre en el ranking y en el perfil.
6. Al cerrar la temporada se descarta por completo la grafica de saldo de esa temporada; transacciones, estadisticas y logros no se tocan.
7. El cambio de mes se vigila periodicamente, no solo al arrancar el servidor.

#### 24. Modo espectador en mesas llenas

`Historia` · Prioridad **Low** · **5** puntos · etiquetas: `frontend`, `backend`, `social`

**Contexto.** Como visitante quiero poder ver una mesa llena y tomar asiento cuando se libere un lugar, en lugar de quedarme fuera.

**Criterios de aceptacion**

1. Las salas llenas muestran 'Ver mesa' en el lobby.
2. Hasta 12 espectadores por mesa ven la partida en vivo, con las cartas ajenas siempre ocultas.
3. Los espectadores participan en el chat con prefijo de ojo y no pueden apostar ni actuar.
4. Puedo tomar asiento cuando se libera un lugar o cuando un bot lo cede, respetando el orden de llegada.
5. El conteo de espectadores es visible para la mesa.

### Epic: Cuentas, seguridad y administracion

Cuentas opcionales, sesiones revocables, roles, MFA, moderacion, reportes, panel y auditoria.

#### 25. Cuentas opcionales con usuario y contrasena

`Historia` · Prioridad **High** · **8** puntos · etiquetas: `backend`, `seguridad`, `cuentas`

**Contexto.** Como jugador quiero poder vincular mi perfil a un usuario y contrasena, para recuperar mis fichas y logros desde otra computadora.

**Criterios de aceptacion**

1. El modo invitado sigue funcionando igual: la cuenta es opcional y nunca obligatoria.
2. Desde el lobby puedo crear una cuenta con mi perfil actual y despues iniciar sesion desde otra computadora recuperando fichas, logros e historial.
3. Las contrasenas se guardan con scrypt y sal aleatoria; jamas en texto plano ni reversibles.
4. Hay politica minima de contrasena y mensajes de error que no revelan si el usuario existe.
5. Existe bloqueo temporal tras varios intentos fallidos, combinado con limite por IP para que un tercero no pueda bloquear a una victima.
6. El login no devuelve el identificador del perfil como token de sesion.

**Notas tecnicas**

- No hay proveedor SMTP en el entorno: sin correo ni verificacion por correo.

#### 26. Sesiones de cuenta revocables con cookie HttpOnly y proteccion CSRF

`Historia` · Prioridad **Highest** · **8** puntos · etiquetas: `backend`, `seguridad`, `sesiones`

**Contexto.** Como responsable de seguridad quiero sesiones reales del lado del servidor, porque ninguna funcion administrativa puede apoyarse en un identificador que aporta el cliente.

**Criterios de aceptacion**

1. La sesion usa un token aleatorio opaco; en la base solo se guarda su hash.
2. El token viaja en cookie HttpOnly, Secure en produccion y SameSite=Strict para administracion.
3. Las sesiones tienen caducidad, renovacion controlada y pueden revocarse una a una o todas a la vez.
4. Cerrar sesion invalida el token en el servidor, no solo en el navegador.
5. Las peticiones que cambian estado validan origen y token CSRF.
6. Socket.IO valida la sesion de cuenta al conectar y al reconectar.
7. Existe migracion SQL para la tabla de sesiones y pruebas de expiracion, revocacion y carrera de snapshot de perfil.

**Notas tecnicas**

- Regla de ejecucion del plan: no empezar panel ni endpoints de moderacion antes de completar este ticket.
- Archivos de referencia: lib/account-sessions.js, lib/account-session-store-pg.js.

#### 27. Roles, permisos, MFA para personal y bootstrap del primer administrador

`Historia` · Prioridad **High** · **8** puntos · etiquetas: `backend`, `seguridad`, `autorizacion`

**Contexto.** Como responsable de seguridad quiero autorizacion calculada en el servidor y segundo factor para el personal, para que una contrasena filtrada no entregue el panel completo.

**Criterios de aceptacion**

1. Existen los roles user, moderator y admin, con una matriz de permisos explicita.
2. El permiso se calcula siempre desde el rol vigente en base de datos, nunca desde datos del cliente, y se reautoriza en cada peticion.
3. El personal (moderator y admin) requiere MFA TOTP obligatorio, con alta por codigo QR y codigos de respaldo.
4. El primer administrador se promueve mediante una CLI ejecutada en el servidor ('npm run admin:role'), no por ruta web ni variable con contrasena.
5. Existe una CLI para restablecer el MFA de una cuenta bloqueada ('npm run admin:mfa-reset').
6. Ocultar botones en el navegador no se considera autorizacion: hay pruebas que llaman a los endpoints directamente con rol insuficiente y esperan 403.

**Notas tecnicas**

- Archivos de referencia: lib/permissions.js, lib/mfa.js, scripts/admin-role.js.

#### 28. Moderacion: suspension, baneo, desbaneo y expulsion en tiempo real

`Historia` · Prioridad **High** · **8** puntos · etiquetas: `backend`, `moderacion`

**Contexto.** Como moderador quiero poder sacar de inmediato a quien rompe las reglas, para que el dano no continue mientras se revisa el caso.

**Criterios de aceptacion**

1. Puedo suspender temporalmente una cuenta con motivo y fecha de fin, y banearla de forma permanente.
2. Al aplicar la sancion, las sesiones de esa cuenta se revocan y sus sockets se expulsan de inmediato de todas las salas.
3. Una cuenta suspendida o baneada no puede crear ni unirse a salas y recibe un mensaje con el motivo y la fecha de fin.
4. Puedo desbanear, lo que restituye el acceso sin devolver sesiones antiguas.
5. Toda accion de moderacion exige motivo y queda auditada con autor, objetivo, motivo y fecha.
6. Las acciones son idempotentes: reintentar la misma peticion no duplica la sancion.
7. Existe migracion SQL para las acciones de moderacion y pruebas de cada transicion de estado.

**Notas tecnicas**

- Archivos de referencia: lib/moderation.js, lib/idempotency-http.js.

#### 29. Reportes de usuarios con evidencia de chat

`Historia` · Prioridad **Medium** · **8** puntos · etiquetas: `backend`, `frontend`, `moderacion`

**Contexto.** Como jugador quiero reportar a alguien o un mensaje concreto, y como moderador quiero recibir el caso con su evidencia, para resolver con contexto y no de oidas.

**Criterios de aceptacion**

1. Puedo reportar a un usuario o un mensaje desde la mesa, eligiendo categoria y agregando una descripcion.
2. El reporte guarda la evidencia relevante (mensajes del contexto) de forma persistente, aunque la sala se destruya.
3. Los reportes tienen estados: recibido, en revision, resuelto y descartado, con responsable asignado.
4. Hay limite de reportes por persona y ventana de tiempo para evitar abuso.
5. La evidencia aplica minimizacion de datos: solo lo necesario y con plazo de retencion definido.
6. Existe migracion SQL para reportes y evidencia, con pruebas unitarias y de integracion HTTP.

**Notas tecnicas**

- Archivos de referencia: lib/reports.js, lib/report-http.js.

#### 30. Panel administrativo /admin separado del juego

`Historia` · Prioridad **Medium** · **8** puntos · etiquetas: `frontend`, `admin`

**Contexto.** Como administrador quiero una interfaz dedicada para operar, para no mezclar herramientas sensibles con la interfaz de los jugadores.

**Criterios de aceptacion**

1. El panel vive en /admin con su propio HTML, CSS y JS, separado del cliente de juego.
2. Vistas minimas: buscar cuentas, detalle de cuenta con acciones, bandeja de reportes, bitacora de auditoria y gestion de roles.
3. Cada accion pide confirmacion y motivo, y muestra el resultado real devuelto por el servidor.
4. El panel solo funciona sobre HTTPS en produccion y exige sesion de personal con MFA vigente.
5. La interfaz no asume permisos: si el servidor responde 403, se muestra el estado correcto sin romper la vista.
6. El panel no muestra contrasenas, hashes ni tokens completos en ningun momento.

**Notas tecnicas**

- Archivos de referencia: public/admin.html, public/admin.js, lib/admin-auth-http.js.

#### 31. Restablecimiento de contrasena y bitacora de auditoria

`Historia` · Prioridad **Medium** · **8** puntos · etiquetas: `backend`, `seguridad`, `auditoria`

**Contexto.** Como administrador quiero poder devolver el acceso a una cuenta sin conocer nunca su contrasena, y que todo movimiento sensible quede registrado.

**Criterios de aceptacion**

1. Un administrador puede iniciar un restablecimiento que genera un reto de un solo uso y con caducidad; nunca ve ni fija la contrasena existente.
2. La persona completa el restablecimiento en /reset-password y elige una contrasena nueva, lo que revoca todas sus sesiones activas.
3. Existe cambio voluntario de contrasena que exige la contrasena actual.
4. La bitacora registra como minimo: login y logout de personal, cambios de rol, suspensiones, baneos, desbaneos, resoluciones de reportes y restablecimientos.
5. Cada entrada guarda autor, accion, objetivo, motivo, fecha y origen, y es de solo anadir (no editable ni borrable desde la aplicacion).
6. La bitacora es consultable y filtrable desde el panel, y existe migracion SQL dedicada.

**Notas tecnicas**

- Archivos de referencia: lib/password-reset-http.js, lib/audit-store.js.

#### 32. Endurecimiento de seguridad: cabeceras, limites por IP e idempotencia

`Tarea` · Prioridad **High** · **5** puntos · etiquetas: `backend`, `seguridad`, `hardening`

**Contexto.** Antes de exponer el panel en produccion hay que cerrar las vias de abuso genericas.

**Criterios de aceptacion**

1. Cabeceras de seguridad activas: CSP sin dependencias de CDN externos, HSTS en produccion, X-Content-Type-Options, Referrer-Policy y X-Frame-Options.
2. Rate limiting por IP y por cuenta en login, registro, restablecimiento y endpoints administrativos.
3. Los endpoints administrativos aceptan una clave de idempotencia para que un reintento no duplique la accion.
4. Validacion estricta de origen y tipo de contenido en peticiones que cambian estado.
5. Un preflight de despliegue ('npm run admin:preflight') falla si falta una variable critica o si el panel quedaria expuesto sin HTTPS.
6. Existe documentacion de modelo de amenazas, rotacion de secretos y respuesta a incidentes.

**Notas tecnicas**

- Archivos de referencia: lib/security-hardening.js, lib/rate-limit.js, lib/deployment-preflight.js.

### Epic: Experiencia, legal y operacion

Accesibilidad y soporte solo-escritorio, terminos y privacidad, despliegue y observabilidad.

#### 33. Soporte exclusivo para escritorio, accesibilidad y atajos de teclado

`Historia` · Prioridad **Medium** · **5** puntos · etiquetas: `frontend`, `accesibilidad`

**Contexto.** Como producto decidimos soportar solo computadoras, y eso debe comunicarse bien sin dejar fuera a quien navega con teclado o necesita menos animacion.

**Criterios de aceptacion**

1. Con ventanas menores a 1024 px de ancho se muestra una pantalla de bloqueo que invita a volver desde una computadora.
2. La pantalla de bloqueo incluye 'Entrar de todos modos', cuya decision se recuerda en el navegador; en ese caso la pagina se desplaza horizontalmente.
3. Resolucion minima soportada 1024x720 y diseno optimo desde 1280x800.
4. Atajos en mesa: F/C/R/A en poker, H/S/D en blackjack, Enter confirma apuestas rapidas, T enfoca el chat y ? muestra la guia.
5. Navegacion completa por teclado con foco visible, regiones en vivo para anuncios y contraste suficiente.
6. Se respeta prefers-reduced-motion en todas las animaciones y ninguna animacion larga bloquea la partida.
7. Estados visuales definidos para conexion, reconexion, desconexion, carga, foco, seleccion, deshabilitado, victoria, derrota y recepcion de fichas.

#### 34. Terminos, aviso de privacidad y retencion de datos

`Historia` · Prioridad **High** · **5** puntos · etiquetas: `legal`, `backend`, `privacidad`

**Contexto.** Como operador en Mexico necesito dejar claro que el juego es recreativo y cumplir con la LFPDPPP, para operar sin ambiguedad legal.

**Criterios de aceptacion**

1. Existe la pagina /terminos con naturaleza recreativa, requisito 18+, deslinde de responsabilidad y Aviso de Privacidad conforme a la LFPDPPP.
2. La aceptacion es obligatoria y versionada; el servidor rechaza crear o unirse a salas sin la aceptacion vigente.
3. Al publicar una version nueva de los terminos se vuelve a pedir la aceptacion.
4. Se borran por completo los perfiles sin actividad por mas de ~3 meses, incluida su fila en Postgres, no solo la copia en memoria.
5. La limpieza corre periodicamente y existe un comando para revisar ('npm run retention:check') y ejecutar ('npm run retention:cleanup').
6. Los plazos de retencion de reportes, evidencia y auditoria estan documentados y se aplican automaticamente.

**Notas tecnicas**

- Archivos de referencia: lib/terms.js, lib/retention.js, public/terminos.html.

#### 35. Despliegue en Render con infraestructura versionada y pruebas de operacion

`Tarea` · Prioridad **High** · **5** puntos · etiquetas: `devops`, `despliegue`

**Contexto.** El proyecto debe poder desplegarse de forma reproducible y sobrevivir a reinicios, deploys y planes gratuitos.

**Criterios de aceptacion**

1. render.yaml versiona el servicio: build, start, health check en /healthz, variables de entorno y disco persistente en /var/data.
2. Esta documentada la opcion 100% gratuita sin tarjeta (Render Free + Postgres de Neon mediante DATABASE_URL, sin disco).
3. Los deploys son sin caida gracias al health check y al apagado ordenado con SIGTERM.
4. Una prueba de operacion verifica que dos arranques con el mismo almacenamiento no pierden perfiles y que SIGTERM produce una salida ordenada.
5. La guia de despliegue paso a paso esta en el repositorio y el README enlaza a ella.
6. Los entornos de vista previa por pull request estan configurados y se destruyen solos.

**Notas tecnicas**

- Nota: el plan free de Render no admite discos y suspende el servicio tras ~15 min.

## Como importar en Jira

1. **Configuracion > Sistema > Importar y exportar > Importar datos externos > CSV** (o *Project settings > Import issues* en un proyecto de equipo).
2. Sube primero `montecristo-epics.csv` y mapea `Epic Name`.
3. Sube despues `montecristo-tickets.csv` y mapea las columnas: *Issue Type, Summary, Description, Priority, Story Points, Epic Link, Labels (x3), Component*.
4. Si tu proyecto usa nombres de prioridad distintos (p. ej. *Highest/High/Medium/Low*), ajusta el mapeo de valores en el paso de importacion.
5. En proyectos *team-managed*, `Epic Link` puede llamarse `Parent`: renombra la columna antes de importar o usa el mapeo equivalente.

Para regenerar estos archivos: `python3 docs/jira/generar-tickets.py`.
