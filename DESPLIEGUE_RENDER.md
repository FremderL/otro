# Guía de despliegue en Render — MonteCristo

Esta guía explica **tres formas** de configurar la persistencia de perfiles y el health check en Render, paso a paso, y **qué hace exactamente cada cosa**. Solo necesitas seguir **una** de las tres opciones.

> **¿Vas a usar el plan Free de Render, sin blueprint, sin disco y sin poner una tarjeta?** Ve directo a la sección **«Opción C»** más abajo: web service Free de Render (a mano) + base de datos Postgres gratis en Neon (tampoco pide tarjeta). Las opciones A y B de abajo requieren un **disco persistente**, que **no existe en el plan Free** de Render.

---

## ¿Qué problema resuelve esto?

El disco donde corre tu servicio en Render es **efímero**: cada deploy o reinicio arranca con una copia limpia del repositorio. Por defecto, MonteCristo guarda los perfiles (fichas, logros, rachas, avatares) en `data/profiles.json`, dentro de ese disco efímero — así que **cada deploy borraba el progreso de todos los jugadores**.

La solución tiene dos piezas:

| Pieza | Qué hace |
|---|---|
| **Disco persistente** | Un volumen de Render que sobrevive deploys y reinicios, montado en una ruta fija (usamos `/var/data`). |
| **Variable `PROFILE_STORE_PATH`** | Le dice al servidor *dónde* leer y escribir los perfiles. Al apuntarla a `/var/data/profiles.json` (dentro del disco), los perfiles sobreviven. El código ya lee esta variable; no hay que tocar nada más. |

Además configuramos el **Health Check Path** en `/healthz`: Render consulta esa URL y solo enruta el tráfico a la instancia nueva cuando ya responde, logrando deploys sin caída (zero-downtime). El endpoint devuelve estado, uptime, salas activas y jugadores conectados.

> ⚠️ **Requisito de plan:** los discos persistentes **no están disponibles en el plan free**. Necesitas plan **Starter** o superior. Al final de la guía se explica qué hacer si te quedas en free.

---

## Opción A — Aplicar el blueprint `render.yaml` (recomendada)

**Qué hace:** el archivo `render.yaml` en la raíz del repo es *infraestructura como código*. Render lo lee y crea/configura el servicio completo por ti: tipo de servicio, comandos de build y arranque, el disco persistente de 1 GB montado en `/var/data`, la variable `PROFILE_STORE_PATH` y el health check en `/healthz`. Ventaja: la configuración queda versionada en Git — cualquier cambio futuro se hace editando el archivo, y es reproducible si algún día recreas el servicio.

**Pasos:**

1. Entra a [dashboard.render.com](https://dashboard.render.com) e inicia sesión.
2. Pulsa **New +** (arriba a la derecha) → **Blueprint**.
3. Conecta/elige el repositorio de MonteCristo y la rama que despliegas.
4. Render detecta el `render.yaml` automáticamente y te muestra un resumen: un servicio web `montecristo` con su disco `montecristo-datos`. Revisa que aparezcan ambos.
5. Pulsa **Apply** (o **Deploy Blueprint**). Render creará el servicio, el disco y las variables, y lanzará el primer deploy.
6. Verifica (sección "Cómo comprobar que funcionó" más abajo).

> **Si ya tenías el servicio creado a mano:** el blueprint crea un servicio *nuevo* llamado `montecristo`. Puedes (a) migrar el dominio al servicio nuevo y borrar el viejo, o (b) ignorar el blueprint y usar la Opción B sobre tu servicio existente. No apliques las dos a la vez sobre servicios distintos con el mismo repo si no quieres dos copias corriendo.

---

## Opción B — Configurar a mano en el dashboard

**Qué hace:** exactamente lo mismo que el blueprint, pero clic a clic sobre tu servicio ya existente. Útil si no quieres crear un servicio nuevo. Desventaja: la configuración vive solo en el dashboard (no queda versionada en Git).

**Pasos:**

### B.1 Crear el disco persistente

1. En el dashboard, abre tu servicio de MonteCristo.
2. Ve a la pestaña **Disks** (en el menú lateral del servicio).
3. Pulsa **Add Disk** y llena:
   - **Name:** `montecristo-datos` (el nombre es libre).
   - **Mount Path:** `/var/data` ← importante, es la ruta que usará la variable.
   - **Size:** `1 GB` (de sobra: los perfiles pesan unos pocos KB).
4. Guarda. Render reiniciará el servicio para montar el disco (los discos requieren que el servicio no sea free y desactivan el autoescalado horizontal, lo cual está bien: MonteCristo usa una sola instancia porque las salas viven en memoria).

### B.2 Crear la variable de entorno

1. En el mismo servicio, ve a la pestaña **Environment**.
2. Pulsa **Add Environment Variable**:
   - **Key:** `PROFILE_STORE_PATH`
   - **Value:** `/var/data/profiles.json`
3. Guarda los cambios. Render redesplegará con la variable activa.

### B.3 Configurar el health check

1. Ve a **Settings** del servicio.
2. Busca **Health Check Path** y escribe: `/healthz`
3. Guarda. A partir de ahora, en cada deploy Render esperará a que la instancia nueva responda `200` en `/healthz` antes de mandarle tráfico y apagar la vieja.

---

## Cómo comprobar que funcionó (para ambas opciones)

1. **Health check:** abre `https://TU-SERVICIO.onrender.com/healthz` en el navegador. Debes ver algo como:
   ```json
   {"status":"ok","uptimeSeconds":42,"rooms":0,"humanPlayers":0,"botTasks":0,"tosVersion":"2026-09-28"}
   ```
2. **Ruta del archivo:** en la pestaña **Logs** del servicio, busca la línea JSON del arranque:
   ```json
   {"event":"server_listening","port":10000,"profileStore":"/var/data/profiles.json", ...}
   ```
   Si `profileStore` dice `/var/data/profiles.json`, la variable está bien puesta. Si dice `.../data/profiles.json` (dentro del repo), la variable no llegó: revisa B.2.
3. **Persistencia real:** entra al casino, juega una ronda (para que cambien tus fichas), luego en el dashboard pulsa **Manual Deploy → Deploy latest commit**. Cuando termine, vuelve a entrar desde el mismo navegador: tus fichas y logros deben seguir ahí.

---

## ¿Y si me quedo en el plan free (sin usar Postgres)?

El plan free **no admite discos**, así que los perfiles seguirán siendo efímeros (se pierden en cada deploy o reinicio; los jugadores simplemente vuelven a empezar con 1000 fichas). Además, free **suspende el servicio tras ~15 minutos sin visitas** y despertarlo tarda ~50 segundos — la pantalla de carga del cliente ya lo explica con el mensaje «Despertando la sala…» y los reintentos visibles.

Si usas free con el blueprint, edita `render.yaml` antes de aplicarlo:

1. Cambia `plan: starter` por `plan: free`.
2. Borra el bloque `disk:` completo (las 4 líneas).
3. Borra la variable `PROFILE_STORE_PATH` de `envVars` (el servidor usará `data/profiles.json` efímero sin quejarse).

El health check en `/healthz` sí funciona en free y conviene dejarlo.

> Si en vez de vivir con perfiles efímeros prefieres que sobrevivan sin pagar nada ni poner una tarjeta, sigue la **Opción C** de abajo: es exactamente este mismo escenario (free, sin blueprint, sin disco) más una base de datos gratuita.

---

## Opción C — 100% gratis: Render free (sin tarjeta) + Neon free (Postgres)

**Qué hace:** en vez de un disco persistente (que Render solo ofrece en planes de pago), los perfiles (fichas, logros, rachas, avatares, temporadas) se guardan en una base de datos **Postgres gratuita de [Neon](https://neon.tech)**. Ni Render Free ni Neon Free piden tarjeta de crédito. El servidor ya trae el soporte: si la variable de entorno `DATABASE_URL` existe, `server.js` usa automáticamente el backend de Postgres (`lib/profile-store-pg.js`); si no existe, sigue usando el archivo JSON de siempre. No hay que tocar una línea de código, solo variables de entorno.

| Pieza | Qué hace |
|---|---|
| **Base de datos Neon (free)** | Postgres gestionado, 0.5 GB de almacenamiento, sin tarjeta, no caduca. De sobra para los perfiles de MonteCristo (unos pocos KB por jugador). |
| **Variable `DATABASE_URL`** | La cadena de conexión que te da Neon. En cuanto el servidor la detecta, guarda y lee los perfiles ahí en vez del disco. |
| **Web Service Free de Render (a mano)** | Igual que cualquier deploy normal de Node: `npm install` como build, `npm start` como arranque. Sin blueprint, sin disco. |

### C.1 Crear la base de datos en Neon

1. Entra a [neon.tech](https://neon.tech) y crea una cuenta gratuita (con correo o GitHub) — **no pide tarjeta**.
2. Crea un proyecto nuevo (por ejemplo, `montecristo`). Neon lo aprovisiona en segundos.
3. En el panel del proyecto, busca la sección **Connection string** (a veces llamada *Connection Details*). Copia la cadena completa: tiene esta forma —
   ```
   postgres://usuario:contraseña@ep-algo-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Guarda esa cadena completa: es tu `DATABASE_URL`. (Neon ya incluye `sslmode=require`, que es justo lo que necesita MonteCristo — no hace falta agregar nada más.)

> Neon "duerme" la base tras un rato sin uso (similar al plan free de Render) y despierta sola con la primera consulta, en menos de un segundo casi siempre. No requiere ninguna acción de tu parte.

### C.2 Crear el Web Service en Render (a mano, plan Free)

1. En [dashboard.render.com](https://dashboard.render.com), pulsa **New +** → **Web Service**.
2. Conecta el repositorio de MonteCristo y la rama que vas a desplegar.
3. Configura:
   - **Name:** el que prefieras (por ejemplo, `montecristo`).
   - **Runtime:** Node.
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type / Plan:** **Free**.
4. **No** agregues ningún disco (el plan Free no lo permite y no lo necesitamos: los perfiles van a Postgres).
5. Antes de crear el servicio (o justo después, en la pestaña **Environment**), agrega la variable de entorno con la cadena de Neon:
   - **Key:** `DATABASE_URL`
   - **Value:** pega ahí la cadena completa que copiaste en el paso C.1.4 (la de `postgres://usuario:contraseña@...neon.tech/neondb?sslmode=require`).
6. En **Settings**, define **Health Check Path** como `/healthz`.
7. Pulsa **Create Web Service** (o **Save Changes** si ya existía). Render instala dependencias, arranca `npm start` y el servidor detecta `DATABASE_URL` automáticamente: crea las tablas que necesita en Neon la primera vez que arranca (no hace falta ejecutar SQL a mano).

### C.3 (Opcional) Migrar los perfiles que ya tuvieras en `data/profiles.json`

Si ya jugaste localmente o en un deploy anterior con disco y quieres conservar esos perfiles, migra el archivo a Neon **antes o después** de crear el servicio (el orden no importa, el script solo agrega/actualiza filas):

```bash
# Desde tu máquina o el mismo repo, con la cadena de Neon a mano:
DATABASE_URL="postgres://usuario:contraseña@...neon.tech/neondb?sslmode=require" \
  node scripts/migrate-profiles-to-postgres.js

# Para ver qué haría sin escribir nada todavía:
DATABASE_URL="postgres://usuario:contraseña@...neon.tech/neondb?sslmode=require" \
  node scripts/migrate-profiles-to-postgres.js --dry-run
```

El script lee `data/profiles.json` (o la ruta que le pases como argumento), limpia cada perfil con las mismas reglas que usa el servidor y lo sube a Postgres. Si la base ya tenía perfiles con el mismo id, los actualiza; si la base ya tenía su propio historial de temporadas, no lo pisa con el del archivo.

> Como este repo se publica limpio (sin jugadores de prueba, ver más abajo), lo normal es que **no** necesites este paso: la base de Neon empieza vacía y los perfiles se crean solos según la gente entra a jugar.

### Cómo comprobar que funcionó (Opción C)

1. **Health check:** `https://TU-SERVICIO.onrender.com/healthz` debe responder `{"status":"ok", ...}`.
2. **Backend correcto en los logs:** en la pestaña **Logs** de Render busca la línea de arranque:
   ```json
   {"event":"server_listening", ..., "profileStore":"postgres://ep-algo-12345.us-east-2.aws.neon.tech/neondb"}
   ```
   Si `profileStore` empieza con `postgres://`, Postgres está activo. Si en cambio muestra una ruta de archivo (termina en `.json`), `DATABASE_URL` no llegó: revisa el paso C.2.5 (nombre exacto `DATABASE_URL`, sin espacios de más).
3. **Persistencia real:** entra al casino, juega una ronda para que cambien tus fichas, y en Render pulsa **Manual Deploy → Deploy latest commit**. Cuando termine, vuelve a entrar: tus fichas y logros deben seguir ahí (antes, con el archivo JSON efímero, se habrían perdido).
4. **En Neon:** el panel del proyecto tiene un editor SQL (*SQL Editor*) donde puedes correr `SELECT id, data->>'name', data->>'chips' FROM montecristo_profiles;` para ver los perfiles guardados.

### Preguntas frecuentes de la Opción C

- **¿Se pierde algo respecto al disco persistente (Opción A/B)?** No para lo que importa: los perfiles sobreviven igual a deploys y reinicios. Sigue aplicando el arranque en frío del plan Free de Render (~50 s tras 15 min sin visitas) y ahora también el de Neon (¡pero Neon despierta en menos de un segundo, así que no se nota!).
- **¿Puedo combinarlo con un disco más adelante?** Sí: si algún día pasas a un plan de pago de Render, puedes seguir usando `DATABASE_URL` (Postgres) o volver al archivo con disco — basta con quitar o poner esa variable de entorno, el código ya soporta ambos.
- **¿Qué pasa si `DATABASE_URL` está mal escrita o Neon no responde?** El servidor **no** cae en silencio al archivo JSON: falla al arrancar con un error claro en los logs (para detectarlo de inmediato en vez de perder datos sin darte cuenta). Revisa que copiaste la cadena completa, incluido `?sslmode=require`.
- **¿Hace falta correr SQL a mano en Neon?** No. El servidor crea las tablas (`montecristo_profiles`, `montecristo_seasons`) solo, la primera vez que arranca con `DATABASE_URL` definida.

---

## Resumen de decisiones

| | Opción A (blueprint) | Opción B (a mano) | Opción C (100% gratis) |
|---|---|---|---|
| Costo | Requiere plan pago (disco) | Requiere plan pago (disco) | **$0, sin tarjeta** |
| Dónde viven los perfiles | Disco persistente de Render | Disco persistente de Render | Postgres gratuito (Neon) |
| Configuración versionada en Git | ✅ | ❌ | ❌ (solo una variable de entorno) |
| Sirve para un servicio ya existente | ❌ (crea uno nuevo) | ✅ | ✅ |
| Pasos manuales | Ninguno (aplica blueprint) | Disco + variable + health check | Cuenta en Neon + variable `DATABASE_URL` + health check |
| Requiere tarjeta de crédito | Sí (plan Starter o superior) | Sí (plan Starter o superior) | **No** |

Las tres opciones dejan el sistema funcionalmente igual: perfiles que sobreviven a deploys y reinicios, deploys sin caída (`/healthz`) y apagado limpio (el servidor guarda los perfiles — en disco o en Postgres, según el backend activo — y avisa a las mesas cuando Render envía `SIGTERM`).
