# Prompts para generar los tickets del repositorio nuevo

Guía para que cualquier integrante del equipo genere tickets con una IA y obtenga
resultados parejos, sin tener que explicar el proyecto desde cero cada vez.

**Cómo se usa:** copias el *bloque de contexto* de abajo, le pegas enseguida el prompt
que necesites y lo mandas. Nada más.

---

## 0. Bloque de contexto (pégalo SIEMPRE antes del prompt)

> Somos un equipo de 4 estudiantes de universidad haciendo un proyecto para la materia
> de [MATERIA]. Estamos construyendo una página web llamada MonteCristo: un casino
> social con fichas virtuales (sin dinero real) donde un grupo de amigos crea una sala
> privada, comparte un código de 5 caracteres y juegan juntos.
>
> Tecnologías: Node.js con Express en el servidor, Socket.IO para el tiempo real,
> [MySQL / PostgreSQL / SQLite] para la base de datos, y HTML, CSS y JavaScript puro
> en el navegador (sin frameworks).
>
> Juegos incluidos: cara o cruz, dados, ruleta y blackjack. Máximo 6 jugadores por sala.
>
> Reglas para los tickets que me generes:
> - Tickets chicos: cada uno debe poderse terminar en una sentada de trabajo.
> - Solo título y descripción. Nada de criterios de aceptación, puntos ni etiquetas.
> - Descripción de 2 a 4 líneas, en español, lenguaje sencillo, explicando qué hay que hacer.
> - Es un proyecto escolar: NO incluyas panel de administración, moderación, reportes,
>   autenticación con contraseñas, roles ni seguridad avanzada.
> - Nunca juntes en un solo ticket "toda la página", "todo el motor" o "todos los estilos".

Ajusta lo que está entre corchetes antes de usarlo.

---

## 1. Generar el backlog inicial completo

> [BLOQUE DE CONTEXTO]
>
> Genérame entre 35 y 40 tickets que cubran todo el proyecto, agrupados en estas etapas:
> documentación y planeación, base de datos, servidor, motor del juego, los juegos,
> pantallas y diseño, y cierre (pruebas, publicación y presentación).
>
> Ordénalos en el orden en que conviene hacerlos y entrégamelos en una tabla con dos
> columnas: título y descripción.

**Tip:** si te da tickets demasiado grandes, responde: *"El ticket número X es muy grande,
pártelo en 3 tickets más chicos"*.

---

## 2. Partir un ticket que salió muy grande

> [BLOQUE DE CONTEXTO]
>
> Este ticket está demasiado grande para una sola persona:
>
> Título: [TÍTULO DEL TICKET]
> Descripción: [DESCRIPCIÓN]
>
> Pártelo en 3 o 4 tickets más chicos que se puedan hacer uno tras otro, cada uno con
> título y descripción. Dime también en qué orden hay que hacerlos.

---

## 3. Sacar los tickets de una sección específica

Útil cuando van avanzando y necesitan detallar solo una parte.

> [BLOQUE DE CONTEXTO]
>
> Ya tenemos listo el servidor y la base de datos. Ahora necesito los tickets nada más
> de [la pantalla de la mesa de juego / el blackjack / el chat].
>
> Dame entre 4 y 7 tickets chicos con título y descripción, en el orden en que hay que
> hacerlos.

---

## 4. Convertir los tickets a CSV para importar a Jira

> Convierte esta lista de tickets a un archivo CSV con exactamente tres columnas:
> Issue Type, Summary, Description.
>
> El valor de Issue Type siempre es "Tarea". Usa comillas dobles en todos los campos,
> codificación UTF-8 y coma como separador. No agregues ninguna otra columna.
>
> [PEGA AQUÍ TU LISTA DE TICKETS]

---

## 5. Levantar tickets de los errores que encuentren al probar

> [BLOQUE DE CONTEXTO]
>
> Probamos la página entre varios y encontramos estos problemas:
>
> 1. [describe el error con tus palabras]
> 2. [...]
>
> Conviértelos en tickets de tipo error, uno por problema, con título corto y una
> descripción que diga: qué pasa, cómo repetirlo y qué debería pasar en su lugar.

---

## 6. Tickets de documentación y entregables de la materia

> [BLOQUE DE CONTEXTO]
>
> Además del código tenemos que entregar documentación. Dame tickets chicos para:
> el documento de requerimientos, el diagrama entidad-relación, el diagrama de
> arquitectura, el manual de usuario, el README del repositorio y la presentación final.
>
> Solo título y descripción.

---

## 7. Repartir los tickets entre el equipo

> Somos [N] integrantes y tenemos [N] semanas. Esta es nuestra lista de tickets:
>
> [PEGA LA LISTA]
>
> Repártelos en partes parejas, procurando que cada quien toque tanto servidor como
> pantallas, y que nadie quede bloqueado esperando el trabajo de otro. Dime también
> qué tickets pueden hacerse en paralelo desde la primera semana.

---

## 8. Revisar que un ticket esté bien escrito

> Revisa este ticket y dime si está lo bastante claro y lo bastante chico para que una
> persona lo termine en una sentada. Si no, reescríbelo.
>
> Título: [TÍTULO]
> Descripción: [DESCRIPCIÓN]

---

## 9. Redactar el pull request de un ticket terminado

Para que el PR se lea como trabajo de ustedes y no como un volcado automático.

> Terminé el ticket "[TÍTULO]". Esto fue lo que hice: [explícalo con tus palabras, aunque
> sea mal escrito].
>
> Escríbeme la descripción del pull request en español, en 3 o 4 líneas: qué cambia, en
> qué archivos y cómo lo pueden probar mis compañeros. Nada de listas larguísimas.

---

## 10. Prompts de apoyo durante el desarrollo

Estos no generan tickets, pero son los que más van a usar:

> Explícame qué hace este código línea por línea, como si nunca hubiera usado Socket.IO:
> [PEGA EL CÓDIGO]

> Este error me sale al correr el servidor. Explícame la causa y cómo lo arreglo, pero
> no me des el código completo: quiero entenderlo y escribirlo yo.
> [PEGA EL ERROR]

> Hazme 5 preguntas sobre nuestro proyecto como si fueras el profesor en la exposición
> final, para que practiquemos las respuestas.

---

## Consejos para que los tickets salgan bien

1. **Entre más contexto, mejor.** El bloque de contexto es lo que evita que te invente
   tecnologías que no están usando.
2. **Pide poco a la vez.** Es mejor pedir los tickets de una sección que los 40 de golpe:
   salen más aterrizados.
3. **Corrige en el mismo chat.** "Están muy grandes", "no uses palabras técnicas",
   "quítame los de seguridad" funciona mejor que volver a empezar.
4. **Revisen cada ticket antes de subirlo a Jira.** Si algo no lo entiende el equipo, no
   sirve como ticket. Reescríbanlo con sus palabras.
5. **El ticket se escribe antes de programar, no después.** Si ya está hecho el código y
   luego inventan el ticket, se nota en las fechas de Jira y en los commits.

---

## Sobre el uso de IA en la entrega

La idea de este kit es que la IA les ayude a **organizar y planear**, mientras el código,
los commits y los pull requests los hacen ustedes. Eso es lo que hace que el proyecto sea
suyo y lo que les va a servir el día de la exposición, cuando el profesor pregunte por qué
hicieron las cosas de cierta manera.

Un par de cosas prácticas:

- Suban commits chicos y seguidos, con mensajes escritos por ustedes. Un repositorio con
  tres commits gigantes el último día se ve raro sin importar quién lo haya escrito.
- Que cada integrante tenga commits propios y sea el autor de sus pull requests.
- Antes de hacer merge, que un compañero distinto lo revise y comente algo real.
- Si el profesor permite usar IA (muchos ya lo permiten si se declara), lo más seguro es
  decirlo en el README: "usamos IA para planear el backlog y resolver dudas". Declararlo
  suele costar mucho menos que que lo descubran.
