# Guía de despliegue en Render — MonteCristo

Esta guía explica **las dos formas** de configurar la persistencia de perfiles y el health check en Render, paso a paso, y **qué hace exactamente cada cosa**. Solo necesitas seguir **una** de las dos opciones.

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

## ¿Y si me quedo en el plan free?

El plan free **no admite discos**, así que los perfiles seguirán siendo efímeros (se pierden en cada deploy o reinicio; los jugadores simplemente vuelven a empezar con 1000 fichas). Además, free **suspende el servicio tras ~15 minutos sin visitas** y despertarlo tarda ~50 segundos — la pantalla de carga del cliente ya lo explica con el mensaje «Despertando la sala…» y los reintentos visibles.

Si usas free con el blueprint, edita `render.yaml` antes de aplicarlo:

1. Cambia `plan: starter` por `plan: free`.
2. Borra el bloque `disk:` completo (las 4 líneas).
3. Borra la variable `PROFILE_STORE_PATH` de `envVars` (el servidor usará `data/profiles.json` efímero sin quejarse).

El health check en `/healthz` sí funciona en free y conviene dejarlo.

---

## Resumen de decisiones

| | Opción A (blueprint) | Opción B (a mano) |
|---|---|---|
| Configuración versionada en Git | ✅ | ❌ |
| Sirve para un servicio ya existente | ❌ (crea uno nuevo) | ✅ |
| Disco + variable + health check | Todo automático | Tres pasos manuales |
| Riesgo de error de tipeo | Bajo | Medio (rutas exactas) |

Cualquiera de las dos deja el sistema igual: perfiles en disco persistente, deploys sin caída y apagado limpio (el servidor ya guarda los perfiles y avisa a las mesas cuando Render envía `SIGTERM`).
