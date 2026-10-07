# Tickets del proyecto — MonteCristo

40 tickets chicos para repartir en el equipo. Cada uno es una tarea que se puede terminar en una sentada.

Para importarlos a Jira esta el archivo `montecristo-tickets.csv` de esta carpeta (columnas: tipo, titulo y descripcion).

## Equipo

| Integrante | Rol | De que se encarga | Tickets |
| --- | --- | --- | ---: |
| Luis Enrique Rodriguez Gonzalez | Product Owner / lider | Vision del producto, backlog, sprints, enlace con el profesor | 5 |
| Castell Guzman Elian Avishayr | Backend - motor de juegos | Reglas de los juegos, azar del servidor, cobro y pago de apuestas | 10 |
| Alan Emmanuel Oseguera Michel | Backend - API y datos | Servidor, API, base de datos en Neon, saldos y despliegue | 10 |
| Hector Jaime Navarro Guillen | Frontend | Maquetas, estilos, pantallas, animaciones y chat | 9 |
| Josue Angel Carrillo Cruz | Documentacion y QA | Diagramas, salas, plan de pruebas y entregables | 6 |

### Reparto de los tickets

- **Luis Enrique Rodriguez Gonzalez** (Product Owner / lider) - 5 tickets: 1, 2, 5, 16, 40
- **Castell Guzman Elian Avishayr** (Backend - motor de juegos) - 10 tickets: 19, 20, 21, 22, 23, 24, 25, 26, 27, 28
- **Alan Emmanuel Oseguera Michel** (Backend - API y datos) - 10 tickets: 6, 7, 8, 9, 10, 11, 12, 13, 14, 39
- **Hector Jaime Navarro Guillen** (Frontend) - 9 tickets: 29, 30, 31, 32, 33, 34, 35, 36, 37
- **Josue Angel Carrillo Cruz** (Documentacion y QA) - 6 tickets: 3, 4, 15, 17, 18, 38

## Etapas

| Etapa | Tickets |
| --- | ---: |
| Documentacion y planeacion | 5 |
| Base de datos | 5 |
| Servidor | 4 |
| Motor del juego | 8 |
| Juegos | 6 |
| Pantallas y diseno | 8 |
| Extras y cierre | 4 |
| **Total** | **40** |

## Documentacion y planeacion

**1. Escribir el documento de requerimientos**

_Responsable: Luis Enrique Rodriguez Gonzalez (Product Owner / lider)_

Redactar un documento corto con lo que debe hacer la pagina: juegos incluidos, cuantos jugadores por sala y que puede hacer cada jugador. Sirve como base para todos los demas tickets.

**2. Definir las reglas de cada juego**

_Responsable: Luis Enrique Rodriguez Gonzalez (Product Owner / lider)_

Escribir en un documento las reglas y los pagos de cada juego (cara o cruz, dados, ruleta y blackjack). Hay que dejar claro cuanto paga cada apuesta para que despues el codigo y las pruebas usen los mismos numeros.

**3. Hacer el diagrama de la base de datos**

_Responsable: Josue Angel Carrillo Cruz (Documentacion y QA)_

Dibujar el diagrama entidad-relacion con las tablas que vamos a usar (jugadores, salas, partidas) y sus campos. Guardar la imagen en la carpeta de documentacion.

**4. Hacer el diagrama de arquitectura de la pagina**

_Responsable: Josue Angel Carrillo Cruz (Documentacion y QA)_

Dibujar un diagrama sencillo que muestre como se comunican el navegador, el servidor y la base de datos. Agregarlo a la documentacion del proyecto.

**5. Escribir el README del repositorio**

_Responsable: Luis Enrique Rodriguez Gonzalez (Product Owner / lider)_

Explicar en el README que es el proyecto, que tecnologias usa y los pasos para instalarlo y ejecutarlo en la computadora de cualquier integrante.

## Base de datos

**6. Crear la base de datos y conectarla al servidor**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Crear la base de datos del proyecto y escribir el codigo que la conecta desde el servidor. Debe avisar en la consola si la conexion funciono o si fallo.

**7. Crear la tabla de jugadores**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Crear la tabla de jugadores con id, nombre, avatar, saldo y fecha de registro. Dejar el script SQL guardado en el repositorio.

**8. Crear la tabla de salas**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Crear la tabla de salas con id, codigo de la sala, juego, anfitrion y estado (abierta o cerrada). Dejar el script SQL en el repositorio.

**9. Crear la tabla de partidas jugadas**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Crear la tabla donde se guarda cada ronda terminada: sala, juego, jugador, apuesta, resultado y fecha, junto con la funcion que inserta la fila al acabar la ronda. Sirve para el historial y las estadisticas.

**10. Funciones para guardar y consultar jugadores**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Programar las funciones basicas para crear un jugador, buscarlo por id y actualizar su nombre, avatar y saldo. Todo el codigo que necesite jugadores debe usar estas funciones y no consultas sueltas.

## Servidor

**11. Crear el proyecto de Node con Express**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Iniciar el proyecto con npm, instalar Express y dejar un servidor que arranque con 'npm start' en el puerto 3000 y que entregue los archivos de la carpeta public (HTML, CSS, imagenes y JavaScript del navegador).

**12. Conectar el servidor y el navegador con Socket.IO**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Instalar Socket.IO y dejar la conexion funcionando: cuando el navegador se conecta, el servidor le manda un mensaje de bienvenida y lo imprime en consola.

**13. Rutas de la API para el jugador**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Crear las rutas para registrar un jugador nuevo, consultar sus datos y actualizar su nombre o avatar. Probarlas antes de conectarlas con la pantalla.

**14. Dar saldo inicial y guardarlo**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Cuando se crea un jugador nuevo, darle 1000 fichas virtuales. El saldo se actualiza en la base de datos cada vez que termina una ronda.

## Motor del juego

**15. Crear la estructura de una sala en el servidor**

_Responsable: Josue Angel Carrillo Cruz (Documentacion y QA)_

Programar el objeto sala que guarda en memoria el juego elegido, los jugadores sentados, el anfitrion y la fase en la que va la ronda.

**16. Generar el codigo de sala de 5 caracteres**

_Responsable: Luis Enrique Rodriguez Gonzalez (Product Owner / lider)_

Hacer la funcion que genera un codigo de 5 caracteres para cada sala y revisa que no este repetido. Con ese codigo los amigos se unen a la mesa.

**17. Unir y sacar jugadores de una sala**

_Responsable: Josue Angel Carrillo Cruz (Documentacion y QA)_

Programar la logica para que un jugador entre a una sala por su codigo y salga de ella. Maximo 6 jugadores por sala.

**18. Avisar a todos los de la sala cuando algo cambia**

_Responsable: Josue Angel Carrillo Cruz (Documentacion y QA)_

Cada vez que cambia el estado de la sala (alguien entra, sale o apuesta), el servidor manda el estado actualizado a todos los jugadores de esa sala.

**19. Ciclo de la ronda: esperar, apostar y resultado**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar las fases por las que pasa una ronda: esperando jugadores, recibiendo apuestas, mostrando el resultado y vuelta a empezar. Es la base que van a usar todos los juegos.

**20. Funcion de numeros aleatorios del servidor**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Hacer la funcion que saca los resultados al azar (cara o cruz, numero del dado, numero de la ruleta, carta del mazo). Siempre corre en el servidor, nunca en el navegador, para que nadie pueda hacer trampa.

**21. Funcion que cobra la apuesta y paga el premio**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar la funcion que descuenta las fichas al apostar y acredita el premio segun lo que pague el juego. Antes de aceptar la apuesta revisa que sea de minimo 10 fichas y que al jugador le alcance el saldo. Es la misma funcion para todos los juegos.

**22. Turnos con tiempo limite**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Poner un limite de tiempo por turno. Si el jugador no hace nada, el servidor decide por el (se planta o no apuesta) para que la partida no se quede atorada.

## Juegos

**23. Juego de cara o cruz**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar el juego mas simple: el jugador apuesta a cara o cruz, el servidor lanza la moneda y paga el doble si le atina. Sirve para probar que el motor de la ronda funciona bien.

**24. Juego de dados**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar el juego de dados: se puede apostar a bajo (1-3) o alto (4-6) que paga doble, o a un numero exacto que paga x6.

**25. Logica de la ruleta**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar la ruleta: apuestas a rojo o negro, par o impar (pagan doble) y a un numero exacto del 0 al 36 (paga x36). El cero hace perder las apuestas de color y de par o impar.

**26. Blackjack: mazo y reparto de cartas**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar el mazo de 52 cartas, barajarlo y repartir dos cartas a cada jugador y dos a la casa (una de ellas tapada). Incluir la cuenta de puntos con el as valiendo 1 u 11.

**27. Blackjack: pedir carta y plantarse**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar las acciones del jugador en su turno: pedir otra carta o plantarse. Si se pasa de 21 pierde de inmediato.

**28. Blackjack: turno de la casa y ganador**

_Responsable: Castell Guzman Elian Avishayr (Backend - motor de juegos)_

Programar el turno de la casa (pide cartas hasta llegar a 17), comparar las manos, decidir quien gana y pagar las apuestas.

## Pantallas y diseno

**29. Hacer la hoja de estilos general**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Definir los colores, la tipografia y el estilo de los botones de toda la pagina en un solo archivo CSS, para que todas las pantallas se vean parecidas.

**30. Pantalla de inicio**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Hacer el HTML de la pagina de inicio con el nombre del proyecto, una explicacion corta, los botones de crear sala y entrar con codigo, y un aviso visible de que las fichas son virtuales y no hay dinero real.

**31. Formulario de nombre y avatar**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Hacer la pantalla donde el jugador escribe su nombre y elige un avatar antes de entrar a jugar. Los datos se mandan al servidor para crear su jugador.

**32. Pantalla del lobby con la lista de salas**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Mostrar las salas abiertas con su juego, el anfitrion y cuantos jugadores tiene (por ejemplo 3/6), con un boton para entrar a cada una.

**33. Pantalla de la mesa de juego**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Hacer la pantalla donde se juega: los lugares de los jugadores con su nombre y avatar, el area del juego al centro y el saldo del jugador.

**34. Botones para apostar**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Hacer los controles para elegir la apuesta y confirmarla. Se desactivan cuando no es momento de apostar o cuando no alcanza el saldo.

**35. Mostrar mensajes y el resultado de la ronda**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Mostrar en pantalla los avisos del servidor: de quien es el turno, el resultado de la ronda y cuanto gano o perdio cada quien.

**36. Animacion simple de la moneda, los dados y la ruleta**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Agregar una animacion corta que muestre el resultado que ya mando el servidor. Debe durar poco y se tiene que poder saltar.

## Extras y cierre

**37. Chat de la sala**

_Responsable: Hector Jaime Navarro Guillen (Frontend)_

Hacer el chat para que los jugadores de una misma sala puedan escribirse durante la partida. Se manda con Enter y aparece el nombre de quien escribio.

**38. Probar la pagina entre varios y anotar los errores**

_Responsable: Josue Angel Carrillo Cruz (Documentacion y QA)_

Juntarse el equipo a probar la pagina con varias computadoras al mismo tiempo: crear sala, entrar con el codigo y jugar una ronda de cada juego. Anotar los errores que salgan y corregir los que alcancen a arreglarse en esta entrega.

**39. Subir la pagina a un hosting gratuito**

_Responsable: Alan Emmanuel Oseguera Michel (Backend - API y datos)_

Publicar la pagina en un servicio gratuito para que se pueda abrir desde cualquier computadora y anotar en el README la direccion y los pasos que se siguieron.

**40. Preparar la presentacion final del proyecto**

_Responsable: Luis Enrique Rodriguez Gonzalez (Product Owner / lider)_

Armar las diapositivas y el guion de la demostracion: que problema resuelve, como esta hecho y una partida en vivo. Repartir quien expone cada parte.

## Como importar en Jira

1. Entrar al proyecto y usar *Import issues from CSV* (o **Configuracion > Sistema > Importar datos externos > CSV**).
2. Subir `montecristo-tickets.csv`.
3. Mapear las columnas: *Issue Type*, *Summary*, *Description* y *Assignee*.
   La columna *Assignee* trae el nombre de cada integrante. Jira necesita que coincida con su usuario o su correo: si no los reconoce, deja esa columna sin mapear e    asignenlos a mano despues de importar (se pueden seleccionar varios a la vez).
4. Importar y despues asignar cada ticket a un integrante del equipo.

Si el proyecto de Jira esta en ingles, cambiar el valor *Historia* por *Story* en la primera columna del CSV antes de importar.

Para regenerar los archivos: `python3 docs/jira/generar-tickets.py`.
