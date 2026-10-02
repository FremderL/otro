# Backlog MVP — MonteCristo Social Casino

35 tickets centrados en **lo primordial de la pagina**, todos de esfuerzo bajo o medio
(1 a 5 puntos). El objetivo del conjunto es un producto jugable de punta a punta:
entrar sin registro, crear una sala, compartirla, jugar y conversar.

- `montecristo-epics.csv` — 6 epics. **Importar primero.**
- `montecristo-tickets.csv` — los 35 tickets, enlazados a su epic por nombre (`Epic Link`).

**Escala de esfuerzo:** 1-2 puntos = bajo · 3-5 puntos = medio. Ningun ticket pasa de 5.

## Resumen

| Epic | Tickets | Puntos |
| --- | ---: | ---: |
| Base tecnica | 5 | 10 |
| Perfil y fichas | 5 | 12 |
| Salas y tiempo real | 6 | 17 |
| Juegos esenciales | 9 | 32 |
| Lobby y social | 5 | 13 |
| Cierre para lanzar | 5 | 13 |
| **Total** | **35** | **97** |

13 tickets de esfuerzo bajo y 22 de esfuerzo medio.

## Fuera de alcance de este MVP

Se deja fuera a proposito para no abarcar todo de una vez; son candidatos a una segunda fase:

- Texas Hold'em y torneos sit & go (es el bloque mas caro del producto; va despues del MVP).
- Bots e IA autoritativa con dificultades y estilos.
- Cuentas con usuario y contrasena, sesiones revocables, roles, MFA.
- Panel administrativo, moderacion, reportes con evidencia y bitacora de auditoria.
- Persistencia en Postgres y migraciones (el MVP usa el archivo JSON).
- Ranking mensual por temporadas, medallas y banner dorado.
- Modo espectador, tragamonedas, retos, logros y eventos especiales.
- Historial descargable y graficas de evolucion de saldo.

## Tickets

### Epic: Base tecnica

Servidor, tiempo real, guardado de perfiles y red de seguridad minima para poder construir.

#### 1. Servir el cliente web desde un servidor Express

`Tarea` · Prioridad **Highest** · **2** puntos · `backend` `setup` `esfuerzo:bajo`

**Contexto.** Primer paso para tener algo que abrir en el navegador: un servidor que entregue la pagina.

**Criterios de aceptacion**

1. 'npm install && npm start' levanta el servidor en 0.0.0.0 respetando la variable PORT (3000 por defecto).
2. Se sirven los archivos de /public: index.html, styles.css y app.js.
3. Abrir la raiz en el navegador muestra la pagina sin errores en consola.
4. package.json declara engines node >= 18 y los scripts start y dev.

**Notas**

- Dependencias: express y compression.

#### 2. Conectar el cliente y el servidor por Socket.IO

`Tarea` · Prioridad **Highest** · **2** puntos · `backend` `tiempo-real` `esfuerzo:bajo`

**Contexto.** Todo el juego depende de un canal en vivo; conviene dejarlo funcionando y probado desde el inicio.

**Criterios de aceptacion**

1. Socket.IO queda montado sobre el mismo servidor HTTP.
2. Al conectar, el cliente recibe un evento de bienvenida con la version del servidor.
3. El cliente reintenta la conexion automaticamente si se cae.
4. La interfaz muestra un indicador visible de conectado / reconectando / sin conexion.

#### 3. Guardar perfiles en un archivo JSON con escritura segura

`Historia` · Prioridad **Highest** · **3** puntos · `backend` `persistencia` `esfuerzo:medio`

**Contexto.** Como jugador quiero que mis fichas sigan ahi cuando vuelva, para no empezar de cero cada vez.

**Criterios de aceptacion**

1. Los perfiles se guardan en data/profiles.json y se cargan al arrancar.
2. La escritura es diferida y atomica (archivo temporal + rename) para que un corte no corrompa el archivo.
3. La ruta es configurable con PROFILE_STORE_PATH.
4. El acceso pasa por un modulo unico, para poder cambiar el backend despues sin tocar el resto del codigo.
5. Lo que se envia al cliente es una lista explicita de campos, nunca el objeto completo del perfil.

**Notas**

- No se usa base de datos en el MVP; Postgres queda fuera de alcance.

#### 4. Red de seguridad minima: lint, verificacion de sintaxis y prueba de humo

`Tarea` · Prioridad **High** · **2** puntos · `calidad` `ci` `esfuerzo:bajo`

**Contexto.** Con poco esfuerzo se evita romper lo que ya funciona en cada cambio.

**Criterios de aceptacion**

1. 'npm run lint' pasa ESLint sobre el repositorio sin errores.
2. 'npm run check:syntax' valida la sintaxis de todos los archivos JavaScript.
3. Existe una prueba de humo con node:test que levanta el servidor y verifica que responde.
4. 'npm test' encadena las tres cosas.
5. Un workflow de GitHub Actions ejecuta 'npm test' en cada push y pull request.

#### 5. Health check y registro de eventos clave

`Tarea` · Prioridad **Medium** · **1** puntos · `backend` `observabilidad` `esfuerzo:bajo`

**Contexto.** Necesario para desplegar sin caidas y para entender que paso cuando algo falle.

**Criterios de aceptacion**

1. GET /healthz responde 200 con estado, uptime, salas activas y jugadores conectados.
2. Se registran arranque, sala creada, sala destruida, jugador entra y jugador sale.
3. Los logs nunca incluyen datos sensibles.

### Epic: Perfil y fichas

Identidad de invitado, saldo virtual y reglas economicas basicas.

#### 6. Perfil de invitado con nombre y avatar

`Historia` · Prioridad **Highest** · **3** puntos · `frontend` `backend` `perfil` `esfuerzo:medio`

**Contexto.** Como visitante quiero entrar y jugar en segundos, sin registro, pero siendo reconocible en la mesa.

**Criterios de aceptacion**

1. Al entrar por primera vez se crea un perfil con un token local de dispositivo guardado en el navegador.
2. Puedo elegir y cambiar mi nombre y mi avatar desde la interfaz.
3. Al volver desde el mismo navegador recupero mi perfil automaticamente.
4. El cambio de nombre o avatar se refleja en la mesa en tiempo real.
5. El token de dispositivo solo da continuidad al perfil: no concede ningun privilegio.

#### 7. Saldo virtual inicial de 1000 fichas que persiste

`Historia` · Prioridad **Highest** · **2** puntos · `backend` `economia` `esfuerzo:bajo`

**Contexto.** Como jugador quiero arrancar con fichas y que mi saldo se conserve entre sesiones, para que las partidas tengan continuidad.

**Criterios de aceptacion**

1. Un perfil nuevo arranca con 1000 fichas virtuales.
2. El saldo se actualiza en el servidor y se persiste tras cada ronda.
3. El saldo visible en la interfaz siempre viene del servidor, nunca se calcula solo en el cliente.
4. Si recargo la pagina, el saldo mostrado es el mismo.

#### 8. Bono diario de 100 fichas

`Historia` · Prioridad **Medium** · **2** puntos · `backend` `economia` `esfuerzo:bajo`

**Contexto.** Como jugador quiero poder seguir jugando aunque me quede sin fichas, para no quedar bloqueado.

**Criterios de aceptacion**

1. Al entrar se otorgan 100 fichas, una sola vez por dia natural.
2. La interfaz avisa con un mensaje breve cuando se recibe el bono.
3. Recargar la pagina varias veces el mismo dia no vuelve a otorgarlo.
4. El calculo del dia usa la zona horaria configurada (America/Mexico_City por defecto).

#### 9. Validacion de apuestas en el servidor

`Historia` · Prioridad **Highest** · **2** puntos · `backend` `economia` `seguridad` `esfuerzo:bajo`

**Contexto.** Como producto necesitamos que nadie pueda apostar fichas que no tiene manipulando el navegador.

**Criterios de aceptacion**

1. La apuesta minima es de 10 fichas.
2. El servidor rechaza apuestas mayores al saldo disponible, con un mensaje claro para el cliente.
3. Las fichas se descuentan al confirmar la apuesta y se acreditan al resolver la ronda.
4. El cliente deshabilita los controles invalidos, pero la decision siempre se revalida en el servidor.
5. Una prueba automatizada intenta apostar mas del saldo y espera un rechazo.

#### 10. Modal de perfil con estadisticas basicas

`Historia` · Prioridad **Low** · **3** puntos · `frontend` `perfil` `esfuerzo:medio`

**Contexto.** Como jugador quiero ver como me ha ido, para tener una sensacion de progreso.

**Criterios de aceptacion**

1. El modal muestra nombre, avatar, saldo actual, rondas jugadas, victorias y mayor ganancia.
2. Las estadisticas se actualizan al terminar cada ronda.
3. Los contadores se persisten junto al perfil.
4. El modal se abre y cierra con teclado y devuelve el foco al elemento que lo abrio.

### Epic: Salas y tiempo real

Crear y compartir una mesa, sincronizar su estado y aguantar desconexiones.

#### 11. Crear una sala con codigo de 5 caracteres y URL compartible

`Historia` · Prioridad **Highest** · **3** puntos · `backend` `frontend` `salas` `esfuerzo:medio`

**Contexto.** Como anfitrion quiero abrir una mesa y pasarle el enlace a mis amigos, que es la razon de ser de la pagina.

**Criterios de aceptacion**

1. Puedo crear una sala eligiendo juego y nombre.
2. El servidor genera un codigo unico de 5 caracteres y una URL compartible.
3. La interfaz muestra el codigo y un boton para copiar el enlace.
4. Quien crea la sala queda como anfitrion.
5. Solo el anfitrion puede iniciar la ronda.

#### 12. Unirse a una sala por codigo o URL con capacidad de 6

`Historia` · Prioridad **Highest** · **3** puntos · `backend` `frontend` `salas` `esfuerzo:medio`

**Contexto.** Como invitado quiero entrar con un clic o escribiendo el codigo, sin crear cuenta.

**Criterios de aceptacion**

1. Puedo unirme pegando la URL o escribiendo el codigo de 5 caracteres.
2. Si la sala no existe, recibo un mensaje claro y vuelvo al lobby.
3. La capacidad maxima es de 6 participantes; el servidor rechaza al septimo con un aviso.
4. No se puede entrar a mitad de una mano en curso: se espera a la siguiente ronda.
5. El codigo no distingue mayusculas de minusculas.

#### 13. Estado de la sala sincronizado desde el servidor

`Historia` · Prioridad **Highest** · **3** puntos · `backend` `tiempo-real` `esfuerzo:medio`

**Contexto.** Como jugador quiero que todos veamos exactamente lo mismo, para que no haya discusiones ni trampas.

**Criterios de aceptacion**

1. El servidor es la unica fuente de verdad: el cliente solo envia intenciones y renderiza lo que recibe.
2. Tras cada cambio relevante se difunde el estado a los participantes de la sala.
3. El servidor revalida turno, fase, importe y saldo antes de aplicar cualquier accion.
4. Al entrar a la sala recibo el estado completo actual, no solo los cambios siguientes.

#### 14. Lista de participantes con asientos, anfitrion y turno

`Historia` · Prioridad **High** · **2** puntos · `frontend` `salas` `esfuerzo:bajo`

**Contexto.** Como jugador quiero ver quien esta en la mesa y a quien le toca, para seguir la partida.

**Criterios de aceptacion**

1. Se muestran hasta 6 asientos con nombre, avatar y saldo de cada participante.
2. El anfitrion esta marcado con una insignia.
3. El asiento de quien tiene el turno esta resaltado.
4. Los asientos vacios se ven claramente como disponibles.
5. La lista se actualiza en vivo cuando alguien entra o sale.

#### 15. Salir de la sala con reembolso y cierre de salas vacias

`Historia` · Prioridad **High** · **3** puntos · `backend` `salas` `esfuerzo:medio`

**Contexto.** Como jugador quiero poder irme sin perder fichas comprometidas, y como operador no quiero mesas fantasma acumulandose en memoria.

**Criterios de aceptacion**

1. Al salir, mis apuestas abiertas de la ronda en curso se reembolsan.
2. Si sale el anfitrion, el rol pasa a otra persona de la mesa.
3. Una sala sin participantes se destruye y deja de aparecer en el lobby.
4. Al destruir la sala se cancelan sus temporizadores de turno y de ronda.
5. Los demas ven un mensaje breve de que alguien salio.

#### 16. Reconexion por token de dispositivo

`Historia` · Prioridad **High** · **3** puntos · `backend` `tiempo-real` `resiliencia` `esfuerzo:medio`

**Contexto.** Como jugador quiero recuperar mi asiento si se me cae el internet un momento, en lugar de perder la partida y las fichas.

**Criterios de aceptacion**

1. Si vuelvo con el mismo token de dispositivo dentro de la ventana de gracia, recupero asiento, saldo y estado de ronda.
2. Mientras estoy desconectado, los demas ven mi asiento marcado como 'reconectando'.
3. Si no vuelvo dentro de la ventana, se libera mi asiento y se reembolsan mis apuestas abiertas.
4. El cliente reintenta la conexion solo y muestra el progreso.

### Epic: Juegos esenciales

Motor de ronda comun y los cuatro juegos del MVP: Cara o Cruz, Dados, Ruleta y Blackjack.

#### 17. Motor de ronda comun para los juegos de apuesta unica

`Historia` · Prioridad **Highest** · **5** puntos · `backend` `motor-juego` `esfuerzo:medio`

**Contexto.** Como equipo queremos una sola maquina de estados reutilizable, para no reimplementar el ciclo de la ronda en cada juego.

**Criterios de aceptacion**

1. Existe una maquina de estados con las fases: espera, apuestas, resolucion y resultados.
2. Cada participante confirma una sola apuesta por ronda (opcion e importe).
3. Solo el anfitrion abre y lanza la ronda, pero el servidor genera y liquida el resultado.
4. Los resultados se calculan con una fuente aleatoria del servidor, nunca en el cliente.
5. Al terminar, se acreditan los pagos, se difunde el resultado y la sala vuelve a espera.
6. Los tres juegos rapidos del MVP se montan sobre este motor sin duplicar logica.

**Notas**

- Archivo de referencia: lib/quick-games.js.

#### 18. Cara o Cruz

`Historia` · Prioridad **Highest** · **2** puntos · `backend` `frontend` `juego` `esfuerzo:bajo`

**Contexto.** Como grupo queremos el juego mas simple posible para probar el circuito completo de apuesta y pago.

**Criterios de aceptacion**

1. Puedo apostar a cara o a cruz con un importe valido.
2. Acertar paga x2 sobre la apuesta; fallar la pierde.
3. El resultado lo decide el servidor antes de cualquier animacion.
4. El resultado y el pago de cada participante se muestran al cerrar la ronda.

**Notas**

- Primer juego a implementar: valida el motor de ronda de punta a punta.

#### 19. Dados Cosmicos

`Historia` · Prioridad **High** · **3** puntos · `backend` `frontend` `juego` `esfuerzo:medio`

**Contexto.** Como jugador quiero una apuesta con mas de dos opciones, para variar el ritmo entre rondas.

**Criterios de aceptacion**

1. Puedo apostar a bajo (1-3) o alto (4-6) con pago x2.
2. Puedo apostar a un numero exacto con pago x6.
3. El dado lo tira el servidor y el mismo valor llega a todos los participantes.
4. La interfaz muestra claramente mi apuesta antes de lanzar y puedo cambiarla hasta que se cierra la mesa.

#### 20. Animaciones de moneda y dados sobre el resultado del servidor

`Tarea` · Prioridad **Medium** · **3** puntos · `frontend` `ux` `esfuerzo:medio`

**Contexto.** La tension visual es parte de la experiencia, pero no debe poder alterar ni adelantar el resultado.

**Criterios de aceptacion**

1. La moneda gira y los dados ruedan antes de revelar el valor que ya envio el servidor.
2. La animacion dura menos de 3 segundos y se puede saltar.
3. Se respeta prefers-reduced-motion: sin animacion, revelado directo.
4. Ninguna animacion bloquea el chat ni el resto de la interfaz.

#### 21. Ruleta: apuestas simples y pleno

`Historia` · Prioridad **High** · **5** puntos · `backend` `frontend` `juego` `esfuerzo:medio`

**Contexto.** Como jugador quiero la ruleta, que es el juego de casino mas reconocible, en una version acotada pero correcta.

**Criterios de aceptacion**

1. Puedo apostar a rojo, negro, par, impar, 1-18 o 19-36, con pago x2.
2. Puedo apostar a un numero exacto de 0 a 36 (pleno), con pago x36.
3. El cero es verde y hace perder todas las apuestas externas.
4. El numero ganador lo decide el servidor y la rueda se detiene exactamente en el.
5. La animacion se puede saltar y respeta prefers-reduced-motion.

**Notas**

- Docenas, columnas y el pano completo quedan fuera del MVP.

#### 22. Blackjack: reparto, pedir, plantarse y casa a 17

`Historia` · Prioridad **Highest** · **5** puntos · `backend` `frontend` `juego` `esfuerzo:medio`

**Contexto.** Como jugador quiero un juego con decisiones por turno y no solo azar, que es lo que da profundidad a la mesa.

**Criterios de aceptacion**

1. Cada jugador apuesta y recibe dos cartas; la casa recibe una visible y una oculta.
2. Puedo pedir carta o plantarme en mi turno.
3. Pasarse de 21 pierde la apuesta de inmediato.
4. La casa pide hasta 17 y se planta, segun reglas fijas del servidor.
5. Se comparan manos, se declaran ganadores y empates y se acreditan los pagos.
6. El as vale 1 u 11 segun convenga a la mano.

#### 23. Blackjack: doblar y pago 3:2 del blackjack natural

`Historia` · Prioridad **Medium** · **3** puntos · `backend` `frontend` `juego` `esfuerzo:medio`

**Contexto.** Como jugador quiero las dos reglas que mas cambian la estrategia, sin complicar el MVP con seguro ni split.

**Criterios de aceptacion**

1. Puedo doblar la apuesta con mis dos primeras cartas y recibir exactamente una carta mas.
2. No puedo doblar si no me alcanza el saldo.
3. Un blackjack natural (as + figura o diez) paga 3:2.
4. Si la casa tambien tiene blackjack natural, la mano es empate y se devuelve la apuesta.

**Notas**

- Seguro y split quedan fuera del MVP.

#### 24. Temporizador de turno con accion segura por defecto

`Historia` · Prioridad **High** · **3** puntos · `backend` `motor-juego` `esfuerzo:medio`

**Contexto.** Como jugador no quiero que la partida se congele porque alguien se fue a hacer otra cosa.

**Criterios de aceptacion**

1. Cada turno tiene un limite de 25 segundos, visible como cuenta regresiva en la interfaz.
2. Al expirar, el servidor aplica una accion segura: plantarse en blackjack, o no apostar en los juegos rapidos.
3. Los temporizadores no bloquean el bucle de eventos y se cancelan al destruir la sala.
4. La accion automatica pasa por el mismo validador que la accion manual.
5. Los demas participantes ven que la accion fue automatica.

#### 25. Privacidad de cartas garantizada por el servidor

`Historia` · Prioridad **Highest** · **3** puntos · `backend` `seguridad` `esfuerzo:medio`

**Contexto.** Como jugador quiero certeza de que nadie puede ver mis cartas abriendo la consola del navegador.

**Criterios de aceptacion**

1. La carta oculta de la casa no viaja al cliente hasta la resolucion.
2. Cada jugador recibe unicamente sus propias cartas; las ajenas viajan boca abajo como XX.
3. El estado se filtra por destinatario en el servidor, no se oculta con CSS en el cliente.
4. Una prueba automatizada verifica que el payload de un jugador no contiene cartas de otro ni la carta oculta de la casa.

### Epic: Lobby y social

Descubrir salas, entrar rapido y conversar durante la partida.

#### 26. Lobby con tarjetas de juego y accesos directos

`Historia` · Prioridad **High** · **3** puntos · `frontend` `lobby` `esfuerzo:medio`

**Contexto.** Como visitante quiero entender en 5 segundos que es la pagina y como empezar a jugar.

**Criterios de aceptacion**

1. La portada explica en una frase que es un casino social con fichas virtuales, sin dinero real.
2. Hay accesos directos a crear sala y a entrar con codigo.
3. Hay una tarjeta por juego del MVP con imagen, descripcion breve y duracion estimada.
4. La accion principal de cada tarjeta crea una sala de ese juego.
5. Las imagenes son locales, sin depender de CDNs externos.

#### 27. Lista de salas abiertas en vivo

`Historia` · Prioridad **Medium** · **3** puntos · `frontend` `backend` `lobby` `esfuerzo:medio`

**Contexto.** Como visitante que llega solo quiero unirme a una mesa existente, para no depender de que alguien me invite.

**Criterios de aceptacion**

1. El lobby lista las salas abiertas con juego, anfitrion, fase y ocupacion (por ejemplo 3/6).
2. La lista se actualiza en vivo cuando se crean, llenan o cierran salas.
3. Las salas llenas se muestran deshabilitadas en vez de desaparecer.
4. Puedo filtrar por juego.
5. Si no hay salas abiertas, se muestra un estado vacio que invita a crear una.

#### 28. Chat de sala

`Historia` · Prioridad **High** · **3** puntos · `frontend` `backend` `social` `esfuerzo:medio`

**Contexto.** Como grupo de amigos queremos comentar la jugada: la conversacion es la mitad de la diversion.

**Criterios de aceptacion**

1. Puedo escribir y enviar mensajes visibles para toda la sala, con mi nombre y avatar.
2. Enter envia el mensaje y la tecla T enfoca el campo de chat.
3. El servidor valida longitud maxima y aplica un limite antiflood por remitente.
4. Los mensajes nuevos se anuncian a lectores de pantalla mediante una region en vivo.
5. El historial del chat se conserva mientras la sala exista.

#### 29. Mensajes rapidos y reacciones

`Historia` · Prioridad **Low** · **2** puntos · `frontend` `social` `esfuerzo:bajo`

**Contexto.** Como jugador quiero reaccionar sin dejar de mirar la mesa, con un solo clic.

**Criterios de aceptacion**

1. Hay botones de mensajes rapidos predefinidos que se envian al chat.
2. Hay reacciones con emoji que aparecen brevemente sobre la mesa.
3. Las reacciones tienen un limite de frecuencia por persona.
4. Funcionan con teclado y tienen etiqueta accesible.

#### 30. Historial de ganadores recientes de la sala

`Historia` · Prioridad **Low** · **2** puntos · `frontend` `backend` `social` `esfuerzo:bajo`

**Contexto.** Como jugador quiero ver como viene la racha de la mesa, para darle continuidad a la sesion.

**Criterios de aceptacion**

1. La sala muestra las ultimas rondas con juego, ganador e importe.
2. Se conservan al menos las 10 rondas mas recientes mientras la sala exista.
3. Las ganancias grandes se destacan con una celebracion breve que no bloquea la partida.
4. El historial se envia como parte del estado de la sala a quien entra.

### Epic: Cierre para lanzar

Avisos legales, estados de error, accesibilidad minima y despliegue.

#### 31. Aviso de juego virtual y terminos con aceptacion

`Historia` · Prioridad **Highest** · **3** puntos · `legal` `frontend` `backend` `esfuerzo:medio`

**Contexto.** Como operador en Mexico necesito dejar claro que no hay dinero real y que el uso es para mayores de edad, antes de abrir la pagina al publico.

**Criterios de aceptacion**

1. Existe la pagina /terminos con naturaleza recreativa, requisito 18+, deslinde de responsabilidad y aviso de privacidad.
2. Al entrar por primera vez debo aceptar los terminos para poder crear o unirme a una sala.
3. La aceptacion queda registrada con su version; el servidor rechaza crear o unirse sin la aceptacion vigente.
4. La interfaz repite de forma visible que las fichas son virtuales y que no hay depositos, retiros ni premios canjeables.

#### 32. Estados de carga, error y reconexion en el cliente

`Historia` · Prioridad **High** · **2** puntos · `frontend` `ux` `esfuerzo:bajo`

**Contexto.** Como visitante quiero entender que esta pasando cuando algo tarda o falla, en lugar de ver una pantalla muerta.

**Criterios de aceptacion**

1. Hay una pantalla de carga mientras el servidor despierta, con los reintentos visibles.
2. Los errores del servidor se muestran como mensajes legibles, nunca como un fallo silencioso.
3. Perder la conexion muestra un aviso persistente y recuperarla lo retira.
4. Las acciones en curso deshabilitan su boton para evitar envios duplicados.

#### 33. Bloqueo para pantallas menores a 1024 px

`Historia` · Prioridad **Medium** · **2** puntos · `frontend` `ux` `esfuerzo:bajo`

**Contexto.** Como producto decidimos soportar solo computadoras; hay que comunicarlo bien en vez de mostrar una interfaz rota en el telefono.

**Criterios de aceptacion**

1. Con ventanas de menos de 1024 px de ancho se muestra una pantalla que invita a volver desde una computadora.
2. Hay un boton 'Entrar de todos modos' cuya decision se recuerda en el navegador.
3. En ese caso la pagina permite desplazamiento horizontal en vez de romper el diseno.
4. La resolucion minima soportada es 1024x720 y el diseno es optimo desde 1280x800.
5. El README indica que es un sitio solo para escritorio.

#### 34. Accesibilidad minima y atajos de teclado

`Tarea` · Prioridad **Medium** · **3** puntos · `frontend` `accesibilidad` `esfuerzo:medio`

**Contexto.** Con poco esfuerzo la pagina se vuelve usable con teclado y comoda para quien prefiere menos movimiento.

**Criterios de aceptacion**

1. Toda accion se puede ejecutar con teclado y el foco es siempre visible.
2. Atajos en mesa: H/S/D en blackjack, Enter confirma la apuesta rapida, T enfoca el chat y ? muestra la guia.
3. Los cambios de estado importantes se anuncian mediante regiones en vivo.
4. Se respeta prefers-reduced-motion en todas las animaciones.
5. El contraste de texto cumple el nivel AA.

#### 35. Despliegue en Render y guia de ejecucion

`Tarea` · Prioridad **High** · **3** puntos · `devops` `despliegue` `esfuerzo:medio`

**Contexto.** El MVP no sirve de nada si no esta en linea y nadie sabe como levantarlo.

**Criterios de aceptacion**

1. render.yaml versiona el servicio: build, start, health check en /healthz y variables de entorno.
2. El health check permite deploys sin caida y ante SIGTERM el servidor guarda los perfiles antes de salir.
3. Esta documentada la opcion gratuita y su limitacion (suspension tras inactividad y perfiles efimeros sin disco).
4. El README explica como ejecutar en local y como desplegar, en pasos numerados.
5. La URL de produccion queda probada de punta a punta: crear sala, entrar desde otro navegador y jugar una ronda.

## Orden sugerido

Los tickets ya estan numerados en el orden en que conviene tomarlos. Tres hitos naturales:

1. **Tickets 1-10** — la pagina abre, hay perfil con fichas y todo se guarda.
2. **Tickets 11-24** — se puede crear una sala, invitar y jugar los cuatro juegos.
3. **Tickets 25-35** — lobby, chat y todo lo necesario para publicarla.

## Como importar en Jira

1. **Configuracion > Sistema > Importar y exportar > Importar datos externos > CSV** (o *Project settings > Import issues* en un proyecto de equipo).
2. Sube primero `montecristo-epics.csv` y mapea `Epic Name`.
3. Sube despues `montecristo-tickets.csv` y mapea: *Issue Type, Summary, Description, Priority, Story Points, Epic Link, Labels (x4), Component*.
4. En proyectos *team-managed*, `Epic Link` puede llamarse `Parent`: renombra la columna antes de importar o usa el mapeo equivalente.

Para regenerar estos archivos: `python3 docs/jira/generar-tickets.py`.
