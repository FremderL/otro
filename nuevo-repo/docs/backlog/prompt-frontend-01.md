# Prompt de implementación · Frontend

Pega este prompt en una conversación de Arena **con este repositorio montado**. Arena debe escribir
el código real de los tickets FE-01, FE-02 y FE-03.

---

## INICIO DEL PROMPT (copia desde aquí)

````text
Eres el desarrollador FRONTEND de este repositorio. Tu trabajo es IMPLEMENTAR las tres primeras
pantallas (no redactar documentos): el sistema visual en un solo CSS, la página de inicio y la
pantalla de nombre y avatar.

═══════════════════════════════════════════════════════════════════════════════
1. PROYECTO
═══════════════════════════════════════════════════════════════════════════════
"MonteCristo": casino social multijugador local. Salas de hasta 6 personas con código de 5
caracteres. Juegos: Cara o Cruz, Dados, Ruleta (europea 0-36), Blackjack/21 y Texas Hold'em.
Fichas 100 % virtuales: no hay dinero real ni premios canjeables.

Stack del cliente: HTML, CSS y JAVASCRIPT PURO. Sin React, Vue, TypeScript, bundlers ni frameworks.
El servidor es Node.js con Express y Socket.IO, pero TÚ no lo programas.

RESTRICCIÓN CRÍTICA: el proyecto corre SOLO EN LOCAL y sin internet. Por eso:
  · Nada de CDNs, Google Fonts ni librerías externas: sin internet no cargarían.
  · La tipografía viene de una pila de fuentes del sistema.
  · Las únicas imágenes son las de public/assets/ (ya están en el repo) y se usan por ruta
    relativa: assets/nombre-del-archivo.ext
  · Se diseña para ventanas de 1024 px de ancho o más: no hay versión de celular.

═══════════════════════════════════════════════════════════════════════════════
2. ESTADO DEL REPOSITORIO
═══════════════════════════════════════════════════════════════════════════════
Hoy solo existe:
  - public/assets/  → imágenes del casino y los juegos (YA ESTÁN; no las muevas ni las renombres;
                      si no sabes el nombre exacto de un archivo, listalas y pregunta en tu
                      reporte en vez de inventarlo)
  - docs/           → 01 a 04 y README (no los reescribas)
  - docs/backlog/   → prompts de los compañeros
Trabajan en paralelo: BACKEND 1 (base de datos, lib/db.js) y BACKEND 2 (lib/reglas.js, fases, RNG y
fichas). Otro compañero hará server.js y la pantalla de la sala. Tú eres el dueño de TODO lo que hay
dentro de public/, salvo public/sala.html y public/sala.js, que son de integración.

═══════════════════════════════════════════════════════════════════════════════
3. LEE ESTO PRIMERO (es el contrato del proyecto)
═══════════════════════════════════════════════════════════════════════════════
  - docs/01-alcance-y-requerimientos.md → alcance, roles, flujo de la sala (§8) y reglas
    transversales (§7): "Pantalla: 1024 px o más", "Recursos: todos locales" y "Dinero real:
    ninguno, aviso visible".
  - docs/04-arquitectura.md → estructura de carpetas (§7), endpoints HTTP y eventos de Socket.IO
    (§3.2 y §3.3). El cliente usa socket.io-client servido por el propio servidor en
    /socket.io/socket.io.js (no lo descargues de internet).
  - docs/03-modelo-de-datos.md → los campos del jugador: nombre (hasta 24 caracteres), avatar
    (un emoji, VARCHAR(8)) y device_id (único por navegador).
  - docs/02-reglas-y-pagos.md → los números del juego. TÚ NO CALCULAS PAGOS: solo muestras lo que
    mande el servidor.

═══════════════════════════════════════════════════════════════════════════════
4. TUS TRES TICKETS
═══════════════════════════════════════════════════════════════════════════════
FE-01 · Definir colores, tipografía y estilo de botones de TODA la página en un solo archivo CSS,
        para que todas las pantallas se vean parecidas.
FE-02 · HTML de la página de inicio: nombre del proyecto, explicación corta, botones de crear sala
        y entrar con código, y un aviso visible de que las fichas son virtuales y no hay dinero real.
FE-03 · Pantalla donde el jugador escribe su nombre y elige un avatar antes de entrar a jugar.
        Los datos se mandan al servidor para crear su jugador.

═══════════════════════════════════════════════════════════════════════════════
5. ARCHIVOS QUE TE TOCAN (y los que NO)
═══════════════════════════════════════════════════════════════════════════════
CREAS TÚ:
  public/styles.css    → sistema visual completo
  public/index.html    → página de inicio
  public/perfil.html   → nombre y avatar
  public/app.js        → lógica de esas dos pantallas, constante AVATARES y el cliente de Socket.IO
NO TOQUES: server.js, db/**, lib/**, package.json, public/sala.html, public/sala.js ni docs/**.

═══════════════════════════════════════════════════════════════════════════════
6. ESPECIFICACIÓN TÉCNICA
═══════════════════════════════════════════════════════════════════════════════
a) FE-01 · public/styles.css
   · UN SOLO ARCHIVO. Ninguna pantalla define colores por su cuenta: todo sale de variables en
     :root. Queda prohibido escribir colores "a mano" fuera de :root.
   · Identidad: GRAFITO (fondos oscuros), VERDE MENTA (acción principal) y DORADO (acentos y
     premios). Valores de referencia:
       --fondo #14181d · --superficie #1c2229 · --superficie-2 #252d36 · --borde #2f3a45
       --texto #e8eef3 · --texto-suave #9aa7b4
       --menta #3ddc97 · --menta-oscuro #2bb87c · --dorado #d9a441 · --peligro #e2574c
     Contraste mínimo 4.5:1 en texto normal. Puedes matizar, no cambiar la idea.
   · Variables mínimas:
       Colores (las de arriba) · Tipografía: --fuente (pila del sistema: system-ui, "Segoe UI",
       Roboto, "Helvetica Neue", Arial, sans-serif), --tam-h1 (~32 px), --tam-h2 (~24 px),
       --tam-cuerpo (16 px), --tam-pequeno (13 px), --peso-normal, --peso-fuerte, --interlineado
       Espaciado: --esp-1 a --esp-6 (4, 8, 12, 16, 24, 32 px)
       Bordes: --radio (10 px), --radio-grande (16 px), --sombra · Movimiento: --transicion (150 ms)
   · Botones: clase base .btn y variantes .btn--primario (menta), .btn--secundario (borde menta),
     .btn--dorado (dorado, para premios) y .btn--fantasma (sin fondo). Cada una con tamaño
     (--grande y normal) y estados :hover, :focus-visible (contorno de 2 px en dorado), :active,
     :disabled (opacidad 0.5 y cursor not-allowed) y carga (texto "Cargando…" y sin doble clic).
     Se navegan con Tab y se activan con Enter y Espacio.
   · Componentes listos (aunque aún no se usen): .tarjeta, .campo (label + input),
     .selector-avatar, .aviso, .aviso--peligro, .badge, .pie, .solo-escritorio.
   · Layout: contenedor centrado de máximo 1200 px, rejilla simple de dos columnas, cabecera y pie.
   · Con la ventana a menos de 1024 px se muestra .solo-escritorio ("abre la página en una
     computadora") en lugar de la interfaz.
   · Accesibilidad: foco siempre visible, contraste AA, nada que dependa solo del color (texto o
     icono acompañando) y respeto a prefers-reduced-motion.

b) FE-02 · public/index.html
   · HTML semántico: <header>, <main>, <footer>, un solo <h1> con el nombre del proyecto, y
     <label> en cada campo.
   · Contenido:
       1. Nombre: "MonteCristo".
       2. Explicación corta (2-3 líneas): casino social para jugar con amigos en salas de hasta 6
          personas, con fichas virtuales y sin dinero real.
       3. Botón principal "Crear sala" (.btn--primario).
       4. "Entrar con código": campo + botón. El código son 5 caracteres (letras y números):
          limita a 5, convierte a mayúsculas y rechaza espacios y símbolos.
       5. Aviso PERMANENTE y visible en el pie: fichas virtuales, sin dinero real, sin depósitos ni
          premios canjeables, para mayores de 18 años.
       6. Galería de los cinco juegos con imágenes de public/assets/ y una línea por juego.
   · Ambos botones llevan a public/perfil.html conservando la intención (crear o entrar + el
     código). Pásalo por la URL, por ejemplo: perfil.html?accion=crear  o
     perfil.html?accion=entrar&codigo=K7Q2M
   · Errores del servidor en una región con aria-live, mostrando el mensaje del evento 'error'
     (docs/04 §3.3).

c) FE-03 · public/perfil.html
   · Nombre: input obligatorio, máximo 24 caracteres, sin espacios al inicio ni al final y no vacío.
     Mensaje de error en español si no cumple.
   · Avatar: CATÁLOGO FIJO DE 8 EMOJIS — 🙂 🦊 🐱 🦉 🐼 🦁 🐸 🐺 — en una fila, con selección
     visible (borde dorado), navegables con teclado y uno seleccionado antes de continuar. La lista
     vive en la constante AVATARES de public/app.js para que todas las pantallas usen la misma.
   · Los datos NO se mandan solos: se guardan en localStorage (nombre, avatar y un device_id que se
     genera una sola vez con crypto.randomUUID y se reutiliza) y viajan DENTRO de los eventos que
     ya están definidos en docs/04 §3.2:
         crear_sala  { nombre, avatar, juego }     → si venía de "Crear sala"
         entrar_sala { codigo, nombre, avatar }    → si venía de "Entrar con código"
     NO inventes un evento "crear_jugador".
   · Estados: normal, enviando (botones deshabilitados y "Cargando…") y error (muestra el mensaje
     del evento 'error' sin borrar lo que escribió el jugador).
   · Al recibir { ok: true } con el código de la sala, redirige a:  /sala/<CODIGO>
     (esa pantalla la hace el compañero de integración; si no existe todavía, muestra el código y
     un mensaje de "Sala lista" para poder probar).
   · Si el jugador ya se registró antes, la pantalla llega precargada y puede cambiar los datos.
   · Conexión: carga el cliente de Socket.IO desde /socket.io/socket.io.js (lo sirve el propio
     servidor). SI NO HAY SERVIDOR TODAVÍA, la página no debe romperse: muestra "Conectando…" o
     "Servidor no disponible" y deja navegar la interfaz.

═══════════════════════════════════════════════════════════════════════════════
7. REGLAS DE CONVIVENCIA
═══════════════════════════════════════════════════════════════════════════════
  1. No modifiques server.js, db/**, lib/** ni docs/**.
  2. No inventes nombres de archivos dentro de public/assets/: si no sabes cómo se llama una
     imagen, dilo en tu reporte como PENDIENTE.
  3. No calcules pagos, saldos ni resultados: eso lo manda el servidor (docs/02 y docs/04).
  4. Código en español, comillas simples, 2 espacios de sangría, sin frameworks ni dependencias.

═══════════════════════════════════════════════════════════════════════════════
8. CÓMO VERIFICAR QUE TERMINASTE
═══════════════════════════════════════════════════════════════════════════════
  1. Abre public/index.html y public/perfil.html directamente en el navegador (doble clic). Deben
     verse bien SIN servidor; si el servidor ya existe, también desde http://localhost:3000.
  2. En la pestaña Red de las herramientas de desarrollo: CERO peticiones a internet (sin CDNs,
     sin fuentes externas). Todo es local.
  3. Recorre la página entera con Tab: el foco se ve siempre y los botones responden a Enter y
     Espacio.
  4. Reduce la ventana a menos de 1024 px: aparece el aviso de "solo escritorio".
  5. Inicio → "Crear sala" llega a perfil.html?accion=crear; "Entrar con código" con un código de
     5 caracteres llega a perfil.html?accion=entrar&codigo=XXXXX. El campo rechaza más de 5
     caracteres y los convierte a mayúsculas.
  6. En perfil: dejar el nombre vacío o de más de 24 caracteres muestra error y no continúa; elegir
     avatar es obligatorio; al continuar se guarda en localStorage y al recargar sigue ahí.
  7. El aviso de "fichas virtuales, sin dinero real" se ve en el pie de TODAS las pantallas.

═══════════════════════════════════════════════════════════════════════════════
9. REPORTE FINAL
═══════════════════════════════════════════════════════════════════════════════
  · Archivos creados.
  · Resultado de las 7 verificaciones.
  · Nombres de imágenes de public/assets/ que usaste y cuáles quedaron PENDIENTES por no conocer el
    nombre exacto.
  · Dudas o conflictos (por ejemplo, si necesitas que el servidor devuelva algo que no está en
    docs/04, dilo por escrito pero NO inventes el evento).
````

## FIN DEL PROMPT
