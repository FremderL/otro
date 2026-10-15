# Prompt para generar los tickets de Frontend 1

Archivo auxiliar: contiene el texto listo para copiar y pegar en una nueva conversación y que ahí
redacten los 3 tickets de Frontend con el mismo formato que el resto de la documentación.
Puedes borrar `docs/backlog/` cuando ya no lo necesites.

---

## INICIO DEL PROMPT (copia desde aquí)

```text
Eres un asistente que redacta tickets de desarrollo para un equipo escolar. Vas a escribir TRES
tickets de FRONTEND en archivos Markdown. Tu trabajo es documentar, no programar la solución
completa: cada ticket debe quedar lo suficientemente claro como para que otra persona lo
implemente sin preguntar nada.

═══════════════════════════════════════════════════════════════════════════════
1. CONTEXTO DEL PROYECTO
═══════════════════════════════════════════════════════════════════════════════
"MonteCristo" es un casino social multijugador para jugar con amigos desde el navegador. Una
persona crea una sala, comparte un enlace o un código de 5 caracteres y hasta 6 personas juegan en
tiempo real. Las fichas son 100 % virtuales: no hay dinero real, depósitos ni premios canjeables.
Juegos: Cara o Cruz, Dados, Ruleta (europea 0-36), Blackjack/21 y Texas Hold'em.

Stack: Node.js 18+, Express 4, Socket.IO 4, SQLite en archivo local y JAVASCRIPT VANILLA en el
cliente (sin React, Vue ni ningún framework; sin TypeScript). HTML y CSS puros.

RESTRICCIÓN CRÍTICA PARA FRONTEND: el proyecto corre SOLO EN LOCAL y sin internet. Por eso:
  · No se pueden usar CDNs, Google Fonts, ni librerías cargadas por internet.
  · La tipografía debe venir de una pila de fuentes del sistema.
  · Las únicas imágenes disponibles son las de public/assets/ (las del casino y los juegos), y se
    referencian por ruta relativa: assets/nombre-del-archivo.ext
  · No hay versión de celular: se diseña para ventanas de 1024 px de ancho o más.

ESTADO DEL REPOSITORIO: empieza de cero. Lo único que existe es:
  - public/assets/  → imágenes de los juegos y del casino (YA ESTÁN; no las muevas ni las renombres)
  - docs/           → documentación 01 a 04, README y docs/backlog/ con los tickets ya escritos
Otros compañeros están haciendo el backend (BE-01 a BE-06: base de datos, fases de la ronda,
resultados al azar y manejo de fichas). Tú documentas las tres primeras pantallas.

═══════════════════════════════════════════════════════════════════════════════
2. DOCUMENTOS QUE DEBES RESPETAR (son la fuente de la verdad)
═══════════════════════════════════════════════════════════════════════════════
  - docs/01-alcance-y-requerimientos.md → qué hace la página, juegos, salas de 6 jugadores, roles
    (anfitrión, jugador, servidor), flujo de una sala (§8) y reglas transversales (§7), incluidas
    "Pantalla: 1024 px o más", "Recursos: todos locales" y "Dinero real: ninguno, aviso visible".
  - docs/02-reglas-y-pagos.md → TODOS los números del juego (multiplicadores, saldo inicial 1.000,
    apuesta mínima 10). El frontend NO calcula pagos: solo muestra lo que manda el servidor. Si un
    ticket necesita un número, tómalo de aquí y cítalo.
  - docs/03-modelo-de-datos.md → los campos del jugador que recoge la pantalla de perfil:
    nombre (hasta 24 caracteres), avatar (VARCHAR(8), un emoji) y device_id (único por navegador).
  - docs/04-arquitectura.md → estructura de carpetas (§7), endpoints HTTP y eventos de Socket.IO
    (§3.2 y §3.3), y la regla de oro: el servidor es autoritativo, el cliente solo pinta.

═══════════════════════════════════════════════════════════════════════════════
3. DECISIONES YA TOMADAS (no las cambies, no las discutas, aplícalas)
═══════════════════════════════════════════════════════════════════════════════
  a) NO se crea ningún evento nuevo. El nombre y el avatar se envían DENTRO de los eventos que ya
     existen en docs/04 §3.2:
        crear_sala  { nombre, avatar, juego }
        entrar_sala { codigo, nombre, avatar }
     La pantalla de perfil guarda los datos en el navegador y la acción de crear o entrar los manda
     junto con lo demás. Nadie debe inventar "crear_jugador".
  b) Identidad visual: GRAFITO (fondos oscuros), VERDE MENTA (acción principal) y DORADO (acentos y
     premios). Se define como variables CSS en un solo archivo. Valores de referencia:
        --fondo #14181d · --superficie #1c2229 · --superficie-2 #252d36 · --borde #2f3a45
        --texto #e8eef3 · --texto-suave #9aa7b4
        --menta #3ddc97 · --menta-oscuro #2bb87c · --dorado #d9a441 · --peligro #e2574c
     Contraste mínimo 4.5:1 en texto normal. Puedes ajustar matices, pero no la idea general.
  c) Avatares: CATÁLOGO FIJO DE 8 EMOJIS. Sugerencia: 🙂 🦊 🐱 🦉 🐼 🦁 🐸 🐺. La lista vive en un
     solo lugar (constante AVATARES en public/app.js) para que todas las pantallas usen la misma.
  d) Tipografía: pila de fuentes del sistema (system-ui, "Segoe UI", Roboto, Helvetica Neue, Arial),
     sin descargar nada de internet.
  e) Orden de las pantallas: inicio (FE-02) → nombre y avatar (FE-03) → sala de juego.

═══════════════════════════════════════════════════════════════════════════════
4. MATERIAL EN BRUTO QUE TE PASÓ EL COMPAÑERO DE FRONTEND
═══════════════════════════════════════════════════════════════════════════════
Esto es exactamente lo que él dijo que va a hacer. Conviértelo en tres tickets formales:

  1) "Definir los colores, la tipografia y el estilo de los botones de toda la pagina en un solo
     archivo CSS, para que todas las pantallas se vean parecidas."

  2) "Hacer el HTML de la pagina de inicio con el nombre del proyecto, una explicacion corta, los
     botones de crear sala y entrar con codigo, y un aviso visible de que las fichas son virtuales
     y no hay dinero real."

  3) "Hacer la pantalla donde el jugador escribe su nombre y elige un avatar antes de entrar a
     jugar. Los datos se mandan al servidor para crear su jugador."

═══════════════════════════════════════════════════════════════════════════════
5. QUÉ DEBES ENTREGAR
═══════════════════════════════════════════════════════════════════════════════
Tres archivos Markdown, uno por ticket, en la carpeta docs/backlog/:

  docs/backlog/FE-01-sistema-visual.md
  docs/backlog/FE-02-pagina-de-inicio.md
  docs/backlog/FE-03-nombre-y-avatar.md

Cada archivo usa EXACTAMENTE esta plantilla:

  # Ticket FE-0X · <título corto>

  | Campo | Valor |
  | --- | --- |
  | **ID** | FE-0X |
  | **Área** | Frontend |
  | **Tipo** | Implementación |
  | **Estado** | Pendiente · listo para implementar |
  | **Prioridad** | Alta (FE-01 bloquea a FE-02 y FE-03) |
  | **Depende de** | docs/04-arquitectura.md (estructura) y, para funcionar, del backend |
  | **Desbloquea** | <IDs o "—"> |
  | **Documento base** | docs/01-alcance-y-requerimientos.md |

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
FE-01 · Sistema visual (un solo CSS)
  · Archivo ÚNICO: public/styles.css. Ninguna pantalla define colores por su cuenta: todo sale de
    variables CSS declaradas en :root. Prohíbe explícitamente los colores "a mano" fuera de :root.
  · Variables mínimas que debe definir:
      Colores:      --fondo, --superficie, --superficie-2, --borde, --texto, --texto-suave,
                    --menta, --menta-oscuro, --dorado, --peligro, --exito
      Tipografía:   --fuente (pila del sistema), --tam-h1, --tam-h2, --tam-cuerpo, --tam-pequeno,
                    --peso-normal, --peso-fuerte, --interlineado
      Espaciado:    --esp-1 a --esp-6 (escala de 4, 8, 12, 16, 24 y 32 px)
      Bordes:       --radio (10 px), --radio-grande (16 px), --sombra
      Movimiento:   --transicion (150 ms)
  · Tipografía: escala concreta (h1 ≈ 32 px, h2 ≈ 24 px, cuerpo 16 px, etiquetas 13 px),
    interlineado cómodo y peso fuerte solo en títulos y cifras importantes.
  · Botones: UNA clase base .btn y variantes .btn--primario (menta), .btn--secundario (borde menta
    sobre superficie), .btn--dorado (dorado, para premios y acciones de dinero) y
    .btn--fantasma (sin fondo). Cada una con tamaño (--grande, normal), y los estados:
      :hover, :focus-visible (contorno visible de 2 px en dorado), :active, :disabled
      (opacidad 0.5 y cursor not-allowed) y carga (texto "Cargando…" y bloqueo de doble clic).
    Los botones se navegan con Tab y se activan con Enter y Espacio.
  · Componentes que el CSS debe dejar listos (aunque aún no se usen todos): .tarjeta, .campo
    (label + input), .selector-avatar, .aviso (información) y .aviso--peligro, .badge, .pie.
  · Layout: contenedor centrado de ancho máximo 1200 px, rejilla simple de 2 columnas para el
    inicio, y cabecera y pie fijos.
  · Escritorio obligatorio: con la ventana a menos de 1024 px se muestra un aviso de "abre la
    página en una computadora" en lugar de la interfaz (clase .solo-escritorio).
  · Accesibilidad: foco siempre visible, contraste AA (4.5:1), nada que dependa solo del color
    (acompañar con texto o icono), y respetar prefers-reduced-motion (sin animaciones largas).
  · No incluye: animaciones de juegos, la pantalla de la sala, ni el manejo de eventos.

FE-02 · Página de inicio (HTML)
  · Archivo: public/index.html (más el arranque en public/app.js). Debe ser HTML semántico:
    <header>, <main>, <footer>, un solo <h1> con el nombre del proyecto, y <label> en cada campo.
  · Contenido obligatorio:
      1. Nombre del proyecto: "MonteCristo".
      2. Explicación corta (2 o 3 líneas): casino social para jugar con amigos en salas de hasta
         6 personas; fichas virtuales; sin dinero real.
      3. Botón principal "Crear sala" (clase .btn--primario).
      4. "Entrar con código": campo de texto + botón. El código son 5 caracteres (letras y
         números, ver docs/01 §4); el campo debe limitar a 5, convertir a mayúsculas y no aceptar
         espacios ni símbolos.
      5. Aviso PERMANENTE y visible en el pie: las fichas son virtuales, no hay dinero real, no hay
         depósitos ni premios canjeables, y es para mayores de 18 años (docs/01 §7 y §9).
      6. Galería de los cinco juegos con las imágenes de public/assets/ y una línea por juego
         (Cara o Cruz, Dados, Ruleta, Blackjack/21, Texas Hold'em).
  · Comportamiento: "Crear sala" y "Entrar con código" llevan a la pantalla de nombre y avatar
    (FE-03) y conservan la intención (crear o entrar + el código escrito). Los errores del
    servidor se muestran en una región con aria-live, con el mensaje que llegue en el evento
    'error' (docs/04 §3.3).
  · Restricciones: sin CDNs, sin fuentes externas, sin peticiones a internet. Las imágenes se
    referencian como assets/… (ruta relativa). IMPORTANTE: si no sabes el nombre exacto de un
    archivo dentro de public/assets/, no lo inventes: pon el nombre como PENDIENTE en el ticket.
  · No incluye: la pantalla de la sala, el chat, ni la lógica de juego.

FE-03 · Pantalla de nombre y avatar
  · Archivo: public/perfil.html (más la lógica en public/app.js).
  · Campos:
      Nombre:  <input type="text"> obligatorio, máximo 24 caracteres (docs/03), sin espacios al
               inicio o al final, y no vacío. Mensaje de error en español si no cumple.
      Avatar:  los 8 emojis del catálogo fijo, en una sola fila, con selección visible (borde
               dorado) y navegables con teclado. Debe quedar uno seleccionado antes de continuar.
  · Envío: los datos NO se mandan solos. Se guardan en el navegador (localStorage: nombre, avatar,
    device_id) y viajan dentro del evento que corresponda (docs/04 §3.2):
        crear_sala  { nombre, avatar, juego }        → si venía de "Crear sala"
        entrar_sala { codigo, nombre, avatar }       → si venía de "Entrar con código"
    device_id se genera una sola vez por navegador (crypto.randomUUID o similar) y se reutiliza
    para recuperar el saldo en visitas siguientes (docs/03).
  · Estados de la pantalla: normal, enviando (botones deshabilitados y texto "Cargando…"), y error
    (muestra el mensaje del evento 'error' sin borrar lo que el jugador escribió).
    Al recibir { ok: true } se pasa a la sala; al recibir { ok: false } se queda y muestra el error.
  · Detalle: si el jugador ya escribió su nombre antes, la pantalla llega precargada y puede
    cambiarlo; el botón "Continuar" siempre disponible.
  · No incluye: la mesa de juego, el saldo en pantalla, ni el registro con contraseña.

═══════════════════════════════════════════════════════════════════════════════
7. REGLAS PARA REDACTAR
═══════════════════════════════════════════════════════════════════════════════
  1. Español, tono directo, sin relleno. Usa "debe", "crea", "valida".
  2. No inventes nombres de archivos dentro de public/assets/: si el ticket necesita una imagen y
     no conoces el nombre exacto, escríbelo como PENDIENTE y explica para qué se usa.
  3. No inventes reglas ni números del juego: los pagos, saldos y tiempos vienen de
     docs/02-reglas-y-pagos.md. El frontend no calcula nada de eso.
  4. No crees eventos de Socket.IO nuevos: usa solo los de docs/04 §3.2 y §3.3. Si el material del
     compañero sugiere uno ("crear jugador"), explícalo en la sección "Conflictos detectados" y
     documenta la solución acordada (se manda dentro de crear_sala / entrar_sala).
  5. Cada criterio de aceptación se comprueba con sí o no, sin interpretación.
  6. Si incluyes código, que sea un fragmento corto y marcado como referencia (variables CSS,
     estructura del HTML), nunca la implementación completa.
  7. No toques public/assets/, el README, los documentos 01 a 04 ni los tickets de backend:
     solo escribes los tres archivos nuevos en docs/backlog/.

═══════════════════════════════════════════════════════════════════════════════
8. AL TERMINAR
═══════════════════════════════════════════════════════════════════════════════
Devuélveme un resumen con: los tres archivos creados, el objetivo de cada uno en una línea, y la
lista de conflictos o dudas (o "sin conflictos"). No ejecutes comandos ni modifiques nada fuera de
docs/backlog/.
```

## FIN DEL PROMPT
