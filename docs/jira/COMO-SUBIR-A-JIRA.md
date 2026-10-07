# Cómo subir los tickets a Jira

Dentro del zip vienen tres archivos:

- `montecristo-tickets.csv` — los 40 tickets. **Este es el que se sube a Jira.**
- `BACKLOG.md` — la misma lista en texto, para leerla o pegarla en el reporte.
- `COMO-SUBIR-A-JIRA.md` — esta guía.

El CSV tiene solo tres columnas: **Issue Type**, **Summary** y **Description**.

---

## Antes de empezar

1. Necesitas tener ya creado el proyecto en Jira.
2. Tienes que ser **administrador del proyecto** (o del sitio) para ver la opción de importar.
3. Si tu Jira está en **inglés**, abre el CSV y reemplaza la palabra `Historia` por `Story` en
   toda la primera columna (en Excel o Google Sheets: Buscar y reemplazar). Si está en
   español, déjalo como está.

---

## Opción A — Importar desde el proyecto (la más fácil)

1. Entra a tu proyecto en Jira.
2. En el menú de arriba a la derecha del proyecto, haz clic en los **tres puntos (···)**
   y elige **Import issues** / **Importar incidencias**.
   - En algunos proyectos está en **Project settings** → **Import issues**.
3. Elige el archivo `montecristo-tickets.csv` y súbelo.
4. En el paso de mapeo de columnas, deja así:
   - `Issue Type` → **Tipo de incidencia / Issue Type**
   - `Summary` → **Resumen / Summary**
   - `Description` → **Descripción / Description**
5. Dale **Next / Siguiente** y luego **Begin import / Importar**.
6. Al terminar, Jira te muestra un enlace con los 40 tickets creados.

---

## Opción B — Importar desde la configuración del sitio

Úsala si no te aparece la opción anterior.

1. Haz clic en el **engrane ⚙ (Configuración)** de la barra superior.
2. Entra a **Sistema** → en el menú de la izquierda, hasta abajo, **Importar y exportar**
   → **Importar datos externos** → **CSV**.
   - En inglés: **System** → **External System Import** → **CSV**.
3. Sube `montecristo-tickets.csv` y dale **Next**.
4. Selecciona tu **proyecto destino** y, si te lo pide, deja la codificación en **UTF-8**
   y el separador en **coma (,)**.
5. Mapea las tres columnas igual que en la opción A y termina la importación.

---

## Después de importar

1. Revisa que aparezcan los **40 tickets** en el backlog del proyecto.
2. Asigna cada ticket a un integrante del equipo (puedes seleccionarlos en bloque con
   la casilla de la izquierda y usar **Asignar**).
3. Si usan sprints, arrastra al primer sprint los tickets **1 al 14**
   (documentación, base de datos y servidor), que son los que no dependen de nada más.
4. Opcional: crea las etiquetas por etapa (documentación, base de datos, servidor,
   motor, juegos, pantallas) desde la vista de lista.

---

## Si algo sale mal

- **"The issue type is invalid" / tipo de incidencia inválido**
  Tu Jira está en otro idioma: cambia `Historia` por `Story` (o por el nombre exacto que use
  tu proyecto) en la primera columna del CSV y vuelve a importar.

- **Se ven caracteres raros (Ã±, Ã©)**
  En el paso de importación elige la codificación **UTF-8**.

- **Todo se importó en una sola columna**
  El separador debe ser **coma (,)**. Si abriste y guardaste el CSV con Excel en español,
  pudo cambiarlo a punto y coma: vuelve a usar el archivo original del zip.

- **Importaste de más o quedó mal**
  Puedes seleccionar los tickets en la vista de lista y borrarlos en bloque, luego
  repetir la importación.

---

## Orden sugerido de trabajo

1. **Tickets 1 al 5** — documentación y diagramas (se puede hacer desde el día uno).
2. **Tickets 6 al 14** — base de datos y servidor.
3. **Tickets 15 al 28** — motor de la ronda y los cuatro juegos.
4. **Tickets 29 al 37** — pantallas, estilos y chat.
5. **Tickets 38 al 40** — pruebas en equipo, publicación y presentación.
