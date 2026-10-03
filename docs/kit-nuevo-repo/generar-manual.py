#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera MANUAL-EQUIPO.pdf: manual paso a paso para los integrantes del equipo.

Uso: python3 docs/kit-nuevo-repo/generar-manual.py
"""

import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, ListFlowable,
                                ListItem, PageBreak, PageTemplate, Paragraph,
                                Preformatted, Spacer, Table, TableStyle)

HERE = os.path.dirname(os.path.abspath(__file__))
SALIDA = os.path.join(HERE, "MANUAL-EQUIPO.pdf")

VERDE = colors.HexColor("#1d7a5f")
VERDE_CLARO = colors.HexColor("#e6f4ef")
GRIS = colors.HexColor("#3c4650")
GRIS_CLARO = colors.HexColor("#f1f3f5")
ROJO = colors.HexColor("#b03030")
ROJO_CLARO = colors.HexColor("#fdecec")
DORADO = colors.HexColor("#8a6d1f")
DORADO_CLARO = colors.HexColor("#fdf6e3")

ss = getSampleStyleSheet()

E = {
    "titulo": ParagraphStyle("titulo", parent=ss["Title"], fontName="Helvetica-Bold",
                             fontSize=26, leading=31, textColor=VERDE, spaceAfter=6),
    "subtitulo": ParagraphStyle("subtitulo", parent=ss["Normal"], fontName="Helvetica",
                                fontSize=13, leading=18, textColor=GRIS,
                                alignment=TA_CENTER, spaceAfter=4),
    "h1": ParagraphStyle("h1", parent=ss["Heading1"], fontName="Helvetica-Bold",
                         fontSize=16, leading=20, textColor=VERDE,
                         spaceBefore=16, spaceAfter=8),
    "h2": ParagraphStyle("h2", parent=ss["Heading2"], fontName="Helvetica-Bold",
                         fontSize=12, leading=16, textColor=GRIS,
                         spaceBefore=12, spaceAfter=5),
    "p": ParagraphStyle("p", parent=ss["BodyText"], fontName="Helvetica",
                        fontSize=10, leading=15, textColor=colors.HexColor("#1f252b"),
                        alignment=TA_JUSTIFY, spaceAfter=7),
    "li": ParagraphStyle("li", parent=ss["BodyText"], fontName="Helvetica",
                         fontSize=10, leading=14.5, spaceAfter=3),
    "code": ParagraphStyle("code", parent=ss["Code"], fontName="Courier",
                           fontSize=8.8, leading=12.5, textColor=colors.HexColor("#17202a")),
    "nota": ParagraphStyle("nota", parent=ss["BodyText"], fontName="Helvetica",
                           fontSize=9.5, leading=13.5, spaceAfter=0),
    "notatit": ParagraphStyle("notatit", parent=ss["BodyText"], fontName="Helvetica-Bold",
                              fontSize=9.5, leading=13.5, spaceAfter=2),
    "pie": ParagraphStyle("pie", parent=ss["Normal"], fontName="Helvetica",
                          fontSize=8, textColor=colors.HexColor("#8a949e")),
    "celda": ParagraphStyle("celda", parent=ss["BodyText"], fontName="Helvetica",
                            fontSize=9, leading=12.5, spaceAfter=0),
    "celdab": ParagraphStyle("celdab", parent=ss["BodyText"], fontName="Helvetica-Bold",
                             fontSize=9, leading=12.5, spaceAfter=0, textColor=colors.white),
}


def p(texto, estilo="p"):
    return Paragraph(texto, E[estilo])


def vinetas(items, numerada=False):
    return ListFlowable(
        [ListItem(Paragraph(t, E["li"]), leftIndent=14) for t in items],
        bulletType="1" if numerada else "bullet",
        bulletFontSize=9, leftIndent=16, bulletColor=VERDE, spaceAfter=8)


def codigo(texto):
    t = Table([[Preformatted(texto, E["code"])]], colWidths=[16.4 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f5f7f9")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#d6dce2")),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return KeepTogether([t, Spacer(1, 9)])


def caja(titulo, texto, fondo, borde):
    inner = [Paragraph(titulo, E["notatit"]), Paragraph(texto, E["nota"])]
    t = Table([[inner]], colWidths=[16.4 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fondo),
        ("BOX", (0, 0), (-1, -1), 0.8, borde),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return KeepTogether([t, Spacer(1, 10)])


def alerta(titulo, texto):
    return caja(titulo, texto, ROJO_CLARO, ROJO)


def tip(titulo, texto):
    return caja(titulo, texto, VERDE_CLARO, VERDE)


def ejemplo(titulo, texto):
    return caja(titulo, texto, DORADO_CLARO, DORADO)


def tabla(encabezados, filas, anchos):
    datos = [[Paragraph(h, E["celdab"]) for h in encabezados]]
    datos += [[Paragraph(c, E["celda"]) for c in fila] for fila in filas]
    t = Table(datos, colWidths=anchos, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), VERDE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, GRIS_CLARO]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9d1d9")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return KeepTogether([t, Spacer(1, 10)])


# ----------------------------------------------------------------- contenido
H = []

# Portada
H += [Spacer(1, 3.6 * cm),
      p("MonteCristo", "titulo"),
      p("Manual del equipo", "subtitulo"),
      Spacer(1, 0.4 * cm),
      p("Cómo trabajar un ticket de principio a fin:<br/>"
        "del repositorio a Arena.ai, y de Arena.ai al pull request", "subtitulo"),
      Spacer(1, 1.6 * cm)]
H.append(tip("Lee esto antes de tocar nada",
             "Este manual explica el único flujo de trabajo que vamos a usar todos. Si cada quien "
             "trabaja a su manera, se nos van a empalmar los cambios y vamos a perder tiempo "
             "arreglando conflictos. Son 10 pasos y la primera vez te toma unos 20 minutos; "
             "después son 5."))
H.append(alerta("La regla más importante",
                "Los pull requests SIEMPRE se abren desde GitHub, con tu propia cuenta. "
                "NUNCA le pidas a Arena.ai que haga commits ni que suba el pull request. "
                "El trabajo lo subimos nosotros: así el historial muestra quién hizo qué y el "
                "profesor ve el esfuerzo repartido entre los cuatro."))
H.append(PageBreak())

# Índice
H.append(p("Contenido", "h1"))
H.append(tabla(
    ["Paso", "Qué vas a hacer"],
    [["Antes de empezar", "Lo que necesitas instalado y las cuentas que debes tener"],
     ["Paso 1", "Aceptar la invitación al repositorio"],
     ["Paso 2", "Clonar el repositorio en tu computadora"],
     ["Paso 3", "Conectar Arena.ai con GitHub y abrir el repositorio"],
     ["Paso 4", "Elegir tu ticket en Jira y copiar su prompt"],
     ["Paso 5", "Pegar el prompt en Arena.ai y revisar lo que te dio"],
     ["Paso 6", "Descargar el .zip (solo el código del ticket)"],
     ["Paso 7", "Copiar los archivos a tu copia y probar que funcione"],
     ["Paso 8", "Crear tu rama y hacer commit"],
     ["Paso 9", "Subir la rama y abrir el pull request en GitHub"],
     ["Paso 10", "Que un compañero lo revise y se haga el merge"],
     ["Ejemplo completo", "Un ticket de principio a fin, con los comandos reales"],
     ["Problemas comunes", "Qué hacer cuando algo sale mal"],
     ["Reglas del equipo", "Lista para revisar antes de pedir el merge"],
     ["Anexos", "Guías de lo que se hace fuera de Arena: diagramas, Neon, Render y pruebas"]],
    [3.6 * cm, 12.8 * cm]))

# Antes de empezar
H.append(p("Antes de empezar", "h1"))
H.append(p("Necesitas tener esto listo. Si te falta algo, instálalo ahora: después, a media tarea, "
           "estorba más."))
H.append(tabla(
    ["Qué", "Para qué", "Dónde"],
    [["Cuenta de GitHub", "Para acceder al repositorio y abrir los pull requests", "github.com"],
     ["Cuenta de Arena.ai", "Para generar el código de tu ticket", "arena.ai"],
     ["Git instalado", "Para bajar y subir cambios desde tu computadora", "git-scm.com"],
     ["Node.js 18 o más", "Para correr el proyecto y probarlo", "nodejs.org"],
     ["Un editor de código", "Para revisar y ajustar lo que te dieron", "VS Code, por ejemplo"],
     ["Acceso a Jira", "Para ver qué ticket te tocó", "El enlace que pasó el equipo"]],
    [4.2 * cm, 7.6 * cm, 4.6 * cm]))
H.append(p("Comprueba que Git y Node estén bien instalados abriendo una terminal "
           "(CMD o PowerShell en Windows, Terminal en Mac) y escribiendo:"))
H.append(codigo("git --version\nnode --version\nnpm --version"))
H.append(p("Si los tres responden con un número de versión, estás listo. Si alguno dice que el "
           "comando no existe, falta instalarlo."))

# Como bajar los archivos del kit
H.append(PageBreak())
H.append(p("Cómo bajar este manual y los prompts", "h1"))
H.append(p("Todos los archivos del kit viven en el repositorio, así que siempre los puedes bajar "
           "desde GitHub aunque no tengas ningún enlace a la mano."))
H.append(p("Bajar un archivo suelto (el PDF o el TXT)", "h2"))
H.append(vinetas([
    "Entra al repositorio en GitHub y abre la carpeta donde están los archivos del kit.",
    "Da clic en el archivo que quieres (por ejemplo <b>PROMPTS-POR-TICKET.txt</b>).",
    "Arriba a la derecha del archivo hay un botón de descarga (<b>Download raw file</b>, el icono "
    "de la flecha hacia abajo). Dale clic y se guarda en tu computadora.",
    "Si es un PDF, GitHub lo muestra en pantalla: usa el mismo botón de descarga.",
], numerada=True))
H.append(p("Bajar todo el proyecto de una vez", "h2"))
H.append(vinetas([
    "En la página principal del repositorio, botón verde <b>Code</b> → <b>Download ZIP</b>.",
    "O, si ya lo clonaste, los archivos ya están en tu carpeta: solo haz "
    "<font face='Courier'>git pull</font>.",
], numerada=True))
H.append(tip("Si te pasan un enlace de vista previa y no te deja descargar",
             "Las vistas previas se abren dentro de un marco que a veces bloquea las descargas. "
             "Busca el botón de abrir en una pestaña nueva (el icono de la flecha diagonal) y "
             "descarga desde ahí. Si aun así no baja, usa GitHub: nunca falla."))

# Paso 1
H.append(PageBreak())
H.append(p("Paso 1. Aceptar la invitación al repositorio", "h1"))
H.append(vinetas([
    "Quien creó el repositorio te invita desde <b>Settings → Collaborators → Add people</b>, "
    "escribiendo tu usuario de GitHub.",
    "Te llega un correo con el asunto <i>“… invited you to collaborate”</i>. También aparece "
    "en github.com/notifications.",
    "Abre el correo y da clic en <b>Accept invitation</b>.",
    "Entra al repositorio: si ya puedes ver el botón verde <b>Code</b> y la pestaña "
    "<b>Pull requests</b>, quedó listo.",
], numerada=True))
H.append(tip("Si no te llegó el correo",
             "Pide que te manden el enlace directo del repositorio y ábrelo estando con tu sesión "
             "de GitHub iniciada. La invitación aparece hasta arriba de la página."))

# Paso 2
H.append(p("Paso 2. Clonar el repositorio en tu computadora", "h1"))
H.append(p("Clonar es bajar una copia del proyecto a tu máquina. Se hace una sola vez."))
H.append(vinetas([
    "En el repositorio, da clic en el botón verde <b>Code</b> y copia la dirección HTTPS.",
    "Abre una terminal en la carpeta donde guardas tus proyectos (por ejemplo Documentos).",
    "Escribe los comandos de abajo, cambiando la dirección por la de nuestro repositorio.",
], numerada=True))
H.append(codigo("cd Documentos\n"
                "git clone https://github.com/USUARIO/montecristo.git\n"
                "cd montecristo\n"
                "npm install"))
H.append(p("A partir de aquí, <b>siempre</b> trabajas dentro de esa carpeta. Cada vez que te "
           "sientes a trabajar, lo primero es actualizar tu copia:"))
H.append(codigo("git checkout main\ngit pull"))
H.append(alerta("No te saltes el git pull",
                "Si trabajas sobre una copia vieja, el código que te dé Arena va a chocar con lo "
                "que tus compañeros ya subieron, y vas a pelearte con conflictos que no tenías "
                "por qué tener."))

# Paso 3
H.append(PageBreak())
H.append(p("Paso 3. Conectar Arena.ai con GitHub y abrir el repositorio", "h1"))
H.append(vinetas([
    "Entra a <b>arena.ai</b> e inicia sesión.",
    "Busca la opción de conectar GitHub (normalmente en la configuración de la cuenta o cuando "
    "abres un proyecto nuevo, con el botón <b>Connect GitHub</b>).",
    "GitHub te va a pedir autorización: acepta y, si te deja elegir, selecciona el repositorio "
    "de MonteCristo. Con permiso solo a ese repositorio es suficiente.",
    "Ya conectado, abre el repositorio en Arena. Debe cargarte los archivos del proyecto: así "
    "el código que te genere va a encajar con el que ya existe.",
    "Confirma que esté en la rama <b>main</b> y actualizada antes de empezar.",
], numerada=True))
H.append(tip("¿Por qué conectarlo si al final bajo un zip?",
             "Porque con el repositorio abierto, Arena ve cómo están escritos los demás archivos "
             "y respeta los nombres, las carpetas y el estilo del proyecto. Sin eso, te inventa "
             "una estructura distinta y luego no embona."))
H.append(alerta("Lo que NO vas a usar de Arena",
                "Aunque Arena pueda crear ramas, hacer commits y abrir pull requests, nosotros no "
                "vamos a usar nada de eso. Solo lo usamos para generar el código y descargar el "
                "zip. Todo lo demás lo haces tú desde tu computadora y desde GitHub."))

# Paso 4
H.append(p("Paso 4. Elegir tu ticket y copiar su prompt", "h1"))
H.append(vinetas([
    "Entra a Jira y busca el ticket que te tocó. Anota su número (por ejemplo, el 24).",
    "Revisa que los tickets de los que depende ya estén terminados y fusionados en main. "
    "Si el tuyo es el de la ruleta y todavía no existe el ciclo de la ronda, espérate o avisa al equipo.",
    "Abre el archivo <b>PROMPTS-POR-TICKET.txt</b> que viene en el kit.",
    "Busca tu número de ticket y copia <b>todo</b> lo que está entre <b>[COPIA DESDE AQUI]</b> y "
    "<b>[HASTA AQUI]</b>, sin quitarle ni agregarle nada.",
], numerada=True))
H.append(ejemplo("Ejemplo",
                 "A Luis le tocó el ticket 24 (Juego de dados). Abre el .txt, busca "
                 "“TICKET 24 - Juego de dados”, selecciona desde [COPIA DESDE AQUI] hasta "
                 "[HASTA AQUI] y lo copia con Ctrl+C."))
H.append(alerta("No improvises el prompt",
                "El prompt ya trae el contexto del proyecto, las tecnologías, los pagos de cada "
                "juego y las reglas de entrega. Si escribes el tuyo “con tus palabras”, te va a "
                "dar algo distinto a lo de tus compañeros y el proyecto va a quedar hecho de parches."))

# Paso 5
H.append(PageBreak())
H.append(p("Paso 5. Pegar el prompt y revisar lo que te dio", "h1"))
H.append(vinetas([
    "Con el repositorio ya abierto en Arena, pega el prompt en el chat y envíalo.",
    "Espera a que termine y <b>lee</b> lo que hizo. No lo bajes a ciegas.",
    "Revisa tres cosas: que sean los archivos de tu ticket y nada más, que las rutas de las "
    "carpetas coincidan con las del proyecto, y que no haya tocado archivos de otros compañeros.",
    "Si algo no cuadra, corrígelo en el mismo chat (abajo hay frases listas para eso).",
    "Si no entiendes una parte del código, pídele que te la explique línea por línea. Lo vas a "
    "necesitar en la exposición.",
], numerada=True))
H.append(p("Frases útiles para corregir, tal cual se pueden pegar:", "h2"))
H.append(tabla(
    ["Si pasa esto…", "Respóndele esto"],
    [["Te generó documentación o README de más",
      "“Quítame la documentación, solo quiero los archivos de código de este ticket en el zip.”"],
     ["Te adelantó trabajo de otros tickets",
      "“Eso es de otro ticket, déjame únicamente lo que pedí.”"],
     ["Hizo commit, rama o pull request",
      "“No hagas commits ni pull requests, yo los subo. Solo dame el zip con los archivos.”"],
     ["Cambió archivos que no eran",
      "“No toques los demás archivos del repositorio, solo los de este ticket.”"],
     ["No te dio el zip",
      "“Déjame los archivos en un .zip para descargar, respetando las rutas de carpetas.”"],
     ["No le entiendes al código",
      "“Explícame este archivo línea por línea como si fuera principiante.”"]],
    [5.6 * cm, 10.8 * cm]))

# Paso 6
H.append(p("Paso 6. Descargar el .zip", "h1"))
H.append(vinetas([
    "Pídelo o búscalo en la respuesta: debe ser un archivo <b>.zip</b> para descargar.",
    "Ábrelo antes de copiar nada y revisa que adentro vengan <b>solo</b> los archivos de tu ticket.",
    "Si trae documentación, diagramas o archivos que no pediste, <b>no los copies</b>: usa solo lo "
    "que corresponde a tu ticket.",
], numerada=True))
H.append(ejemplo("Ejemplo de un zip correcto (ticket 24, dados)",
                 "src/juegos/dados.js &nbsp;·&nbsp; public/juegos/dados.js &nbsp;·&nbsp; "
                 "public/mesa.html (modificado)<br/><br/>"
                 "Si además viniera docs/dados.md o un README.md, eso sobra: no lo copies."))
H.append(tip("Por qué solo el código",
             "La documentación del proyecto ya está repartida en sus propios tickets. Si cada quien "
             "sube su versión de la documentación, terminamos con cinco archivos que dicen cosas "
             "distintas."))

# Paso 7
H.append(PageBreak())
H.append(p("Paso 7. Copiar los archivos y probar que funcione", "h1"))
H.append(vinetas([
    "Descomprime el zip en una carpeta aparte (en Descargas, por ejemplo).",
    "Copia los archivos a tu copia del repositorio <b>respetando las rutas</b>: si el archivo venía "
    "en src/juegos/, va en src/juegos/ del proyecto.",
    "Corre el proyecto y pruébalo de verdad, no solo que “arranque”.",
], numerada=True))
H.append(codigo("npm install        # solo si tu ticket agregó alguna librería nueva\n"
                "npm start\n"
                "# abre http://localhost:3000 en el navegador"))
H.append(p("Revisa que lo de tu ticket funcione y que <b>lo que ya existía siga funcionando</b>. "
           "Si rompiste algo de otro compañero, arréglalo antes de subir."))
H.append(codigo("git status     # te muestra qué archivos cambiaste\n"
                "git diff       # te muestra exactamente qué cambió en cada uno"))
H.append(tip("Dale una pasada tú mismo",
             "Cambia algún nombre de variable que no te guste, acomoda un comentario, borra lo que "
             "sobre. Además de que queda mejor, te obliga a leer el código que vas a tener que "
             "defender frente al profesor."))

# Paso 8
H.append(p("Paso 8. Crear tu rama y hacer commit", "h1"))
H.append(p("Una rama por ticket. El nombre lleva la clave del ticket de Jira para que quede ligado solo."))
H.append(codigo("git checkout main\n"
                "git pull\n"
                "git checkout -b MC-24-juego-de-dados\n"
                "\n"
                "git add .\n"
                'git commit -m "MC-24 Agregar la logica del juego de dados"\n'
                'git commit -m "MC-24 Agregar los botones de apuesta de dados"'))
H.append(p("Haz <b>varios commits chicos</b> mientras avanzas, no uno gigante al final. "
           "Escribe los mensajes tú, en español y explicando qué hiciste."))
H.append(tabla(
    ["Mensaje de commit", "¿Sirve?"],
    [["MC-24 Agregar la logica del juego de dados", "Sí: dice qué se hizo y en qué ticket"],
     ["MC-24 Arreglar el pago del numero exacto", "Sí: concreto y entendible"],
     ["cambios", "No: no dice nada"],
     ["asdasd / update / fix", "No: se nota el relleno"],
     ["Agregar todo el proyecto", "No: es un commit gigante de último día"]],
    [8.6 * cm, 7.8 * cm]))

# Paso 9
H.append(PageBreak())
H.append(p("Paso 9. Subir tu rama y abrir el pull request en GitHub", "h1"))
H.append(alerta("Esto se hace en GitHub, no en Arena.ai",
                "Aquí es donde queda registrado que el trabajo es tuyo. Si el pull request lo abre "
                "una herramienta en lugar de ti, el historial del repositorio deja de reflejar quién "
                "hizo qué, y es justo lo que no queremos."))
H.append(vinetas([
    "Sube tu rama con el comando de abajo.",
    "Entra al repositorio en GitHub. Va a aparecer un aviso amarillo con el botón "
    "<b>Compare &amp; pull request</b>: dale clic. (Si no sale, ve a la pestaña "
    "<b>Pull requests → New pull request</b> y elige tu rama.)",
    "Revisa que la base sea <b>main</b> y que la rama que comparas sea la tuya.",
    "Escribe el título con la clave del ticket y un resumen corto; en la descripción, qué hiciste, "
    "qué archivos tocaste y cómo probarlo.",
    "Dale <b>Create pull request</b> y avísale al equipo para que alguien lo revise.",
], numerada=True))
H.append(codigo("git push -u origin MC-24-juego-de-dados"))
H.append(ejemplo("Ejemplo de pull request bien escrito",
                 "<b>Título:</b> MC-24 Juego de dados<br/><br/>"
                 "<b>Descripción:</b><br/>"
                 "Agregué la lógica del juego de dados en src/juegos/dados.js y los botones de "
                 "apuesta en la mesa. Se puede apostar a bajo, alto o a un número exacto; los pagos "
                 "son x2 y x6 como dice el documento de reglas.<br/><br/>"
                 "Para probarlo: npm start, crear una sala de dados, apostar 10 fichas a “bajo” y "
                 "lanzar la ronda. El resultado lo decide el servidor.<br/><br/>"
                 "Cierra el ticket MC-24."))

# Paso 10
H.append(p("Paso 10. Revisión y merge", "h1"))
H.append(vinetas([
    "Un compañero <b>distinto</b> al autor abre el pull request, lee los cambios en la pestaña "
    "<b>Files changed</b> y prueba que funcione en su computadora.",
    "Deja al menos un comentario real: una duda, una mejora o un “ya lo probé y funciona”.",
    "Si hay que corregir algo, el autor hace más commits en la misma rama y se actualiza solo.",
    "Cuando esté bien, se da <b>Merge pull request</b> y luego <b>Delete branch</b>.",
    "El autor actualiza su copia local y pasa al siguiente ticket.",
], numerada=True))
H.append(codigo("git checkout main\ngit pull\ngit branch -d MC-24-juego-de-dados"))
H.append(tip("Repártanse las revisiones",
             "Que no sea siempre el mismo quien revisa. Es la forma más fácil de que los cuatro "
             "conozcan todo el proyecto y no solo su pedazo, que es exactamente lo que el profesor "
             "va a preguntar en la exposición."))

# Ejemplo completo
H.append(PageBreak())
H.append(p("Ejemplo completo, de principio a fin", "h1"))
H.append(p("Luis tiene el ticket <b>MC-24, Juego de dados</b>. Esto es todo lo que hace:"))
H.append(tabla(
    ["#", "Qué hace Luis"],
    [["1", "Abre Jira y confirma que el ticket 19 (ciclo de la ronda) ya está fusionado en main."],
     ["2", "Abre su terminal: <font face='Courier'>cd montecristo</font>, "
           "<font face='Courier'>git checkout main</font>, <font face='Courier'>git pull</font>."],
     ["3", "Entra a arena.ai con el repositorio de MonteCristo conectado y abierto."],
     ["4", "Abre PROMPTS-POR-TICKET.txt, busca el TICKET 24 y copia el bloque completo."],
     ["5", "Lo pega en el chat de Arena y espera."],
     ["6", "Revisa la respuesta: son dos archivos de dados y un cambio en la mesa. Correcto."],
     ["7", "Descarga el zip y lo descomprime en Descargas."],
     ["8", "Copia src/juegos/dados.js y public/juegos/dados.js a su copia del repositorio."],
     ["9", "Corre <font face='Courier'>npm start</font>, crea una sala de dados y juega una ronda. Funciona."],
     ["10", "<font face='Courier'>git checkout -b MC-24-juego-de-dados</font>"],
     ["11", "<font face='Courier'>git add .</font> y dos commits con mensajes claros."],
     ["12", "<font face='Courier'>git push -u origin MC-24-juego-de-dados</font>"],
     ["13", "En GitHub da <b>Compare &amp; pull request</b>, escribe el título y la descripción, y lo crea."],
     ["14", "Avisa en el grupo. Ana lo revisa, prueba y comenta “funciona, solo acomoda el margen”."],
     ["15", "Luis hace un commit más con el ajuste. Ana da merge y borra la rama."],
     ["16", "Luis mueve el ticket a Terminado en Jira y toma el siguiente."]],
    [1.1 * cm, 15.3 * cm]))

# Problemas comunes
H.append(PageBreak())
H.append(p("Problemas comunes", "h1"))
H.append(tabla(
    ["Problema", "Qué hacer"],
    [["“Permission denied” o no te deja hacer push",
      "Todavía no aceptas la invitación al repositorio, o estás con otra cuenta de GitHub. "
      "Revisa el Paso 1."],
     ["GitHub te pide usuario y contraseña y no la acepta",
      "GitHub ya no acepta contraseñas: usa un token personal (Settings → Developer settings → "
      "Personal access tokens) o instala GitHub Desktop."],
     ["“Your branch is behind main”",
      "Alguien subió cambios antes que tú. Haz <font face='Courier'>git checkout main</font>, "
      "<font face='Courier'>git pull</font>, vuelve a tu rama y "
      "<font face='Courier'>git merge main</font>."],
     ["El pull request dice que hay conflictos",
      "Dos personas tocaron el mismo archivo. Avísale al otro, abran el archivo juntos y dejen la "
      "versión correcta. No borres el trabajo del otro sin avisar."],
     ["El código del zip no embona con el proyecto",
      "Casi siempre es porque trabajaste sobre una copia vieja. Haz git pull, vuelve a pegar el "
      "prompt y agrégale: “Ten en cuenta el código que ya existe en el repositorio”."],
     ["Arena te dio documentación que no pediste",
      "Ignórala: copia solo los archivos de código. O pídele que te regenere el zip sin ella."],
     ["Te equivocaste de rama y commiteaste en main",
      "No hagas push. Avisa al equipo y pide ayuda: se arregla fácil, pero mejor entre dos."],
     ["npm start truena después de copiar el zip",
      "Lee el error completo: casi siempre falta un npm install o un archivo que no copiaste. "
      "Pégale el error a Arena y pídele que te explique la causa."]],
    [5.8 * cm, 10.6 * cm]))

# Reglas
H.append(p("Reglas del equipo", "h1"))
H.append(p("Antes de pedir que te hagan merge, revisa que cumplas todo esto:"))
H.append(vinetas([
    "Hice <font face='Courier'>git pull</font> de main antes de empezar.",
    "Trabajé en mi propia rama, con la clave del ticket en el nombre.",
    "El zip que usé traía solo el código de mi ticket, sin documentación de más.",
    "Probé que mi parte funciona y que no rompí lo que ya existía.",
    "Mis commits son varios, chicos y con mensajes escritos por mí.",
    "El pull request lo abrí yo desde GitHub, no desde Arena.ai.",
    "Escribí en la descripción qué hice y cómo probarlo.",
    "Puedo explicar línea por línea lo que estoy subiendo.",
]))
H.append(alerta("Las dos cosas que no se negocian",
                "1. Nunca hagas commits ni pull requests desde Arena.ai: los subimos nosotros desde "
                "nuestras cuentas.<br/>"
                "2. Nunca subas código que no puedas explicar. Si no le entiendes, pide que te lo "
                "expliquen antes de subirlo; en la exposición no va a haber a quién preguntarle."))
H.append(tip("Una nota sobre la IA y el profesor",
             "Usar IA para planear y resolver dudas está bien y hoy es lo normal; lo que no se vale "
             "es entregar algo que nadie del equipo entiende. Si el profesor permite el uso de IA "
             "declarándolo, lo más sano es anotarlo en el README: cuesta mucho menos que te lo "
             "descubran. Lo que de verdad defiende el proyecto es que ustedes puedan explicar cada "
             "decisión y que el historial muestre el trabajo repartido entre los cuatro."))


# ----------------------------------------------------------------- Anexos
H.append(PageBreak())
H.append(p("Anexos: lo que se hace fuera de Arena", "h1"))
H.append(p("Hay tickets que no se terminan en el chat: hay que entrar a otra página o abrir otro "
           "programa. Aquí están esos pasos explicados. En el archivo "
           "<b>PROMPTS-POR-TICKET.txt</b> cada uno de esos tickets trae el aviso "
           "<i>“OJO: ESTE TICKET NO SE TERMINA DENTRO DE ARENA”</i> con los mismos pasos."))
H.append(tabla(
    ["Anexo", "Para qué tickets", "Dónde hay que entrar"],
    [["A. Exportar un diagrama a imagen", "3 y 4", "mermaid.live"],
     ["B. Crear la base de datos", "6", "neon.tech"],
     ["C. Correr los scripts SQL", "7, 8 y 9", "SQL Editor de Neon"],
     ["D. Probar entre varias computadoras", "38", "Tu red local o la página publicada"],
     ["E. Publicar la página", "39", "render.com"],
     ["F. Armar las diapositivas", "40", "Canva, PowerPoint o Google Slides"]],
    [6.2 * cm, 4.0 * cm, 6.2 * cm]))

H.append(p("Anexo A. Exportar un diagrama a imagen (tickets 3 y 4)", "h2"))
H.append(p("En estos tickets el prompt ya le pide a Arena que genere la imagen en PNG. Si te la dio, "
           "solo cópiala a la carpeta <font face='Courier'>docs/</font> y ya está. Estos pasos son por "
           "si la quieres rehacer tú o cambiarle algo."))
H.append(vinetas([
    "Entra a <b>https://mermaid.live</b> (no hay que registrarse).",
    "Borra el ejemplo del panel izquierdo con Ctrl+A y Suprimir.",
    "Abre el archivo <font face='Courier'>.md</font> que te dio Arena y copia <b>solo</b> lo que está "
    "dentro del bloque de código (empieza con <font face='Courier'>erDiagram</font> o "
    "<font face='Courier'>flowchart</font>), sin las comillas invertidas.",
    "Pégalo en el panel izquierdo: el dibujo aparece a la derecha.",
    "Clic en <b>Actions</b> (abajo del panel derecho) y luego en <b>PNG</b>.",
    "Renombra la imagen y cópiala a la carpeta <font face='Courier'>docs/</font> del repositorio.",
], numerada=True))

H.append(p("Anexo B. Crear la base de datos en Neon (ticket 6)", "h2"))
H.append(p("Nuestra base de datos es <b>PostgreSQL en Neon</b>, que vive en la nube: no hay que "
           "instalar nada en la computadora y el plan gratuito no pide tarjeta."))
H.append(vinetas([
    "Entra a <b>https://neon.tech</b> y da clic en <b>Sign up</b>. Puedes entrar con tu cuenta de GitHub.",
    "Crea un proyecto: nómbralo <font face='Courier'>montecristo</font>, deja la versión de PostgreSQL "
    "por defecto y elige la región más cercana (por ejemplo US East). Clic en <b>Create project</b>.",
    "Al terminar aparece el recuadro <b>Connection string</b>, con algo como "
    "<font face='Courier'>postgresql://usuario:clave@ep-algo.neon.tech/neondb?sslmode=require</font>. "
    "Cópiala completa.",
    "Si cerraste el recuadro, la encuentras en el <b>Dashboard</b> del proyecto, en "
    "<b>Connection Details</b>.",
    "En la carpeta del proyecto crea el archivo <font face='Courier'>.env</font> y pega adentro: "
    "<font face='Courier'>DATABASE_URL=\"la cadena que copiaste\"</font>",
], numerada=True))
H.append(tip("Una sola base para todo el equipo",
             "Solo una persona crea el proyecto en Neon y les pasa la cadena a los demás <b>por "
             "privado</b>. Así los cuatro trabajan sobre la misma base y ven los mismos datos. Y "
             "ojo: en el plan gratis la base se duerme si nadie la usa, así que la primera consulta "
             "después de un rato tarda unos segundos. No está descompuesta."))
H.append(alerta("El archivo .env no se sube nunca",
                "La cadena de conexión trae usuario y contraseña. En el repositorio solo va "
                "<font face='Courier'>.env.example</font> con la variable vacía, y "
                "<font face='Courier'>.env</font> debe estar listado en el "
                "<font face='Courier'>.gitignore</font>. Si subes la cadena real, cualquiera que vea "
                "el repo puede entrar a la base."))

H.append(PageBreak())
H.append(p("Anexo C. Correr los scripts SQL (tickets 7, 8 y 9)", "h2"))
H.append(vinetas([
    "Entra a <b>https://console.neon.tech</b> y abre el proyecto <font face='Courier'>montecristo</font>.",
    "En el menú de la izquierda, clic en <b>SQL Editor</b>.",
    "Abre el archivo <font face='Courier'>.sql</font> que te dio Arena, copia todo y pégalo en el editor.",
    "Clic en <b>Run</b> (o Ctrl+Enter). El resultado sale abajo.",
    "Para comprobar, entra a <b>Tables</b> en el menú de la izquierda: ahí debe aparecer la tabla "
    "con sus campos.",
], numerada=True))
H.append(tip("El orden importa",
             "Primero jugadores (ticket 7), luego salas (8) y al final partidas (9). Las tablas de "
             "salas y partidas apuntan a jugadores con llaves foráneas: si las corres antes, marca "
             "error de <i>foreign key</i>. Y si el script trae "
             "<font face='Courier'>AUTO_INCREMENT</font>, es sintaxis de MySQL: en PostgreSQL va "
             "<font face='Courier'>SERIAL</font>. Pídele a Arena que lo corrija."))

H.append(p("Anexo D. Probar entre varias computadoras (ticket 38)", "h2"))
H.append(vinetas([
    "Conéctense todos a la misma red (el wifi de la escuela o un celular compartiendo datos).",
    "Quien tenga el proyecto corriendo busca su IP local: en Windows, terminal y "
    "<font face='Courier'>ipconfig</font>; es la que dice <i>Dirección IPv4</i> "
    "(algo como 192.168.1.75).",
    "Los demás entran desde su navegador a <font face='Courier'>http://ESA-IP:3000</font>",
    "Si no carga, es el firewall de Windows: cuando salga el aviso, den <b>Permitir acceso</b> para "
    "redes privadas.",
    "Opción más cómoda: hagan las pruebas directo sobre la página ya publicada (ticket 39).",
], numerada=True))

H.append(PageBreak())
H.append(p("Anexo E. Publicar la página (ticket 39)", "h2"))
H.append(p("La base de datos ya está en la nube desde el ticket 6, así que solo falta el servidor.", "p"))
H.append(p("Antes de empezar", "h2"))
H.append(vinetas([
    "Entra a <b>https://console.neon.tech</b> y copia otra vez la cadena de conexión del "
    "<b>Dashboard</b>: la vas a necesitar en Render.",
    "En el <b>SQL Editor</b>, revisa que ya existan las tres tablas (jugadores, salas y partidas). "
    "Si no, corre los scripts de los tickets 7, 8 y 9.",
], numerada=True))
H.append(p("Servidor en Render", "h2"))
H.append(vinetas([
    "Entra a <b>https://render.com</b> e inicia sesión con GitHub.",
    "<b>New +</b> → <b>Web Service</b> → autoriza y elige el repositorio de MonteCristo.",
    "Llena: <b>Name</b> montecristo · <b>Runtime</b> Node · <b>Build Command</b> "
    "<font face='Courier'>npm install</font> · <b>Start Command</b> "
    "<font face='Courier'>npm start</font> · <b>Instance Type</b> Free.",
    "En <b>Environment Variables</b> agrega una sola variable: <b>DATABASE_URL</b>, con la cadena "
    "de conexión de Neon (la que termina en <font face='Courier'>?sslmode=require</font>).",
    "<b>Create Web Service</b> y espera a que el log diga <b>Live</b>.",
    "Arriba aparece la dirección pública (algo como https://montecristo.onrender.com). Anótenla en "
    "el README.",
], numerada=True))
H.append(alerta("Para el día de la exposición",
                "El plan gratis duerme la página tras 15 minutos sin visitas, y la primera carga "
                "después tarda cerca de un minuto. Abran la página 5 minutos antes de exponer para "
                "que ya esté despierta."))

H.append(p("Anexo F. Armar las diapositivas (ticket 40)", "h2"))
H.append(vinetas([
    "Entra a <b>https://www.canva.com</b> (o usa PowerPoint o Google Slides).",
    "Busca <b>Presentación</b> y elige una plantilla oscura y sencilla.",
    "Pasa el guion que te dio Arena diapositiva por diapositiva: título arriba y máximo 4 puntos "
    "cortos. Nada de párrafos.",
    "Mete los diagramas de los tickets 3 y 4 y capturas de la página funcionando (Win+Shift+S).",
    "Descárgala en PDF y súbela a <font face='Courier'>docs/</font>, por si falla el internet.",
    "Ensayen una vez con reloj: 10 minutos entre cuatro se van rapidísimo.",
], numerada=True))


# ------------------------------------------------------------------- armado
def pie_de_pagina(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#8a949e"))
    if doc.page > 1:
        canvas.drawString(2 * cm, 1.3 * cm, "MonteCristo · Manual del equipo")
        canvas.drawRightString(A4[0] - 2 * cm, 1.3 * cm, "Página %d" % doc.page)
        canvas.setStrokeColor(colors.HexColor("#dde3e8"))
        canvas.line(2 * cm, 1.75 * cm, A4[0] - 2 * cm, 1.75 * cm)
    canvas.restoreState()


doc = BaseDocTemplate(SALIDA, pagesize=A4,
                      leftMargin=2 * cm, rightMargin=2 * cm,
                      topMargin=2 * cm, bottomMargin=2.2 * cm,
                      title="MonteCristo - Manual del equipo",
                      author="Equipo MonteCristo")
marco = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
doc.addPageTemplates([PageTemplate(id="todas", frames=[marco], onPage=pie_de_pagina)])
doc.build(H)

print("OK: %s (%.0f KB)" % (os.path.basename(SALIDA), os.path.getsize(SALIDA) / 1024))
