# Flujo de trabajo para el repositorio nuevo

Cómo arrancar el repo, cómo trabajar por tickets y cómo subir los pull requests.

---

## 1. Crear el repositorio

1. Que **un solo integrante** cree el repositorio en GitHub (público o privado) con un
   README inicial.
2. Que invite a los demás en **Settings → Collaborators**.
3. Cada quien lo clona:
   ```bash
   git clone https://github.com/USUARIO/REPO.git
   cd REPO
   ```

### Estructura sugerida de carpetas

```
REPO/
├── public/            páginas, estilos y JavaScript del navegador
│   ├── assets/        las imágenes (ya vienen en este kit)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/               código del servidor
│   ├── juegos/        cara o cruz, dados, ruleta, blackjack
│   └── db/            conexión y consultas
├── docs/              requerimientos, diagramas, manual
├── server.js
├── package.json
└── README.md
```

### Las imágenes

En la carpeta `imagenes/` de este kit vienen las 7 imágenes ya generadas. Cópienlas a
`public/assets/` del repo nuevo y listo, no hay que volver a generarlas:

| Archivo | Para qué |
| --- | --- |
| `casino-hero.jpg` | Imagen grande de la página de inicio |
| `poker-lounge.jpg` | Tarjeta de póker |
| `blackjack-lounge.jpg` | Tarjeta de blackjack |
| `roulette-lounge.jpg` | Tarjeta de ruleta |
| `dice-lounge.jpg` | Tarjeta de dados |
| `coin-lounge.jpg` | Tarjeta de cara o cruz |
| `slots-lounge.jpg` | Tarjeta de tragamonedas |

Son imágenes generadas con IA; si el profesor pide declarar los recursos, menciónenlo
en el README junto con las demás herramientas.

---

## 2. Un ticket = una rama = un pull request

Esta es la parte que hace que el trabajo se vea repartido y ordenado.

```bash
# 1. Antes de empezar, actualiza tu copia
git checkout main
git pull

# 2. Crea tu rama con el número del ticket de Jira
git checkout -b MC-12-tabla-de-jugadores

# 3. Trabaja y ve haciendo commits chicos
git add .
git commit -m "Crear la tabla de jugadores con sus campos"
git commit -m "Agregar el script SQL al repositorio"

# 4. Sube tu rama
git push -u origin MC-12-tabla-de-jugadores
```

Luego en GitHub: **Compare & pull request** → describe qué hiciste → **Create pull request**.

### Reglas que conviene acordar

- Nadie hace commits directos a `main`. Todo pasa por pull request.
- Cada PR lo revisa **otro** integrante y deja al menos un comentario antes del merge.
- El nombre de la rama lleva el número del ticket, para que Jira lo relacione solo.
- Commits chicos y seguidos, no uno gigante al final.

### Mensajes de commit

Escríbanlos ustedes, en español y en una línea. Que digan qué hicieron:

```
Crear la tabla de jugadores
Arreglar el error al unirse con código en minúsculas
Agregar los botones de apuesta en la mesa
```

---

## 3. Conectar Jira con GitHub (opcional pero se ve muy bien)

Si en el mensaje del commit o en el título de la rama ponen la clave del ticket
(por ejemplo `MC-12`), Jira enlaza solo los commits y los PR con el ticket.

Para activarlo: en Jira, **Apps → GitHub for Jira** → conectar la organización o la
cuenta donde está el repositorio.

```bash
git commit -m "MC-12 Crear la tabla de jugadores"
```

---

## 4. Ritmo de trabajo sugerido

| Semana | En qué enfocarse |
| --- | --- |
| 1 | Documentación, diagramas y crear el repositorio |
| 2 | Base de datos y servidor básico |
| 3 | Motor de la ronda y salas |
| 4 | Los cuatro juegos |
| 5 | Pantallas, estilos y chat |
| 6 | Pruebas entre todos, publicación y presentación |

Ajusten las semanas a lo que les haya dado el profesor.

---

## 5. Antes de entregar, revisen esto

- [ ] El repositorio se clona y corre con `npm install` y `npm start` sin pasos secretos.
- [ ] El README explica qué es, cómo instalarlo y quiénes lo hicieron.
- [ ] Están los diagramas (entidad-relación y arquitectura) en `docs/`.
- [ ] Todos los integrantes tienen commits y pull requests a su nombre.
- [ ] No hay contraseñas ni datos de conexión subidos al repositorio (usen un `.env`
      y agréguenlo al `.gitignore`).
- [ ] Los cuatro juegos terminan una ronda completa sin errores en consola.
- [ ] Hay un aviso visible de que las fichas son virtuales.
