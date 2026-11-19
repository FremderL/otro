# Alternativas de hosting tras agotar el ancho de banda de Render

Fecha del análisis: **noviembre 2026**. Precios y límites verificados contra las
páginas públicas de cada proveedor en esa fecha; vuélvelos a revisar antes de
contratar, porque cambian seguido (Render mismo cambió las reglas este año).

---

## 1. Qué pasó exactamente

En abril de 2026 Render recortó el ancho de banda incluido: el plan **Hobby**
pasó a **5 GB/mes** y el **Pro a 25 GB/mes**; el excedente se cobra a
**$0.15 por GB**. Antes eran 100 GB. Con un juego que sirve imágenes y audio, ese
límite se rompe en pocos días, no en un mes.

### Por qué MonteCristo lo rompe tan rápido

Medido en este repositorio:

| Qué | Tamaño | Cuándo se sirve |
| --- | --- | --- |
| `public/assets/cards/` (54 JPG) | **14.9 MB** | Álbum de cartas del perfil |
| `ballon-dor-ceremony-theme.wav` | **1.9 MB** | Ceremonia del Balón de Oro (¡es WAV sin comprimir!) |
| `match-ambience.mp3` | 891 KB | Ambiente del partido |
| 7 imágenes `*-lounge.jpg` del lobby | 1.1 MB | Portada, **con `loading="lazy"`** |
| Texto (HTML + JS + CSS, ya con gzip) | ~200 KB | Cada visita |

Un primer ingreso al lobby mueve **~1.3 MB**. Con 5 GB eso son unas **3.800
primeras visitas al mes**; y una persona que abre el Estadio dispara además dos
`setInterval` de 15 s con `cache: 'no-store'`
(`public/estadio.js`: `PROMOTION_ROTATION_MS` y `BALLON_DOR_POLL_MS`), o sea 8
peticiones por minuto por pestaña que nunca se cachean.

**Conclusión incómoda:** cambiar de host sin tocar esto solo mueve el problema.
En un host con egreso medido, el mismo tráfico vuelve a costar. Y las cartas se
pintan en una rejilla de **118 px** (`public/card-album.css`) mientras los JPG
miden **848×1264** y pesan ~300 KB cada uno. Medido: recomprimir a 424 px en
WebP deja cada carta en **75–94 KB (−70 %)**.

---

## 2. Las opciones, ordenadas por lo que te conviene

### Opción A — Quedarte en Render y poner Cloudflare delante ($0, hoy mismo)

**Cloudflare free tiene ancho de banda ilimitado en el CDN y no cobra egreso.**
Render solo factura lo que sale de su red, o sea los *cache miss*. Si cacheas
`/assets/*` en el borde, los 15 MB de cartas y los audios dejan de contar.

Pasos:

1. Dominio propio apuntando a Cloudflare (el `*.onrender.com` no se puede
   proxear; necesitas un dominio, aunque sea de $10 al año).
2. Registro `A`/`CNAME` al host de Render **en naranja (proxied)**.
3. *Caching → Cache Rules*:
   - `/assets/*` → **Cache Everything**, Edge TTL **1 mes**.
   - `/*` → **Bypass cache** (el HTML y el API no se cachean).
4. Render → *Settings → Custom Domain* con ese dominio; HTTPS lo emite
   Cloudflare y Render reconoce el dominio.
5. Si usas cuentas, añade el dominio en `APP_ORIGIN` (debe ser HTTPS sin ruta).

**Ojo con WebSockets:** el plan gratis de Cloudflare sí proxea WebSocket, pero
con timeout de 100 s de inactividad. Socket.IO ya reenvía *heartbeat* cada 25 s,
así que no se cae. No pongas reglas de "Cache Everything" en `/socket.io/`.

**Resultado esperado:** el consumo de Render baja a ~200 KB por visita (solo
texto) → de ~3.800 visitas a **más de 25.000** antes de tocar el límite, más lo
que pase por la regla de 1 mes. Coste: $0.

### Opción B — Sacar los assets a Cloudflare R2 ($0 hasta 10 GB)

R2 cobra **$0 de egreso, siempre**, y el plan gratis da 10 GB de almacenamiento
(los assets son 23 MB: entras con muchísimo margen) y 10 M lecturas al mes.

1. Crea el bucket, sube `public/assets` conservando rutas.
2. Conecta un subdominio (`assets.tudominio.com`) al bucket.
3. Redirige `/assets/*` a R2 con una *Origin Rule* o *Redirect Rule* en
   Cloudflare, para no tocar el código ni las rutas que ya usa `lib/card-gacha.js`
   (`/assets/cards/<id>.jpg`).
4. Opcional: sube además las cartas ya optimizadas y quédate con las originales
   en el repo para las pruebas.

Esta opción **se combina con cualquier host**: es la que hace que un host con
egreso caro deje de importar, porque las imágenes nunca salen de él.

### Opción C — Hetzner Cloud: el que no tiene problema de ancho de banda

Si el juego va a crecer, este es el destino final razonable.

| | Hetzner CX22 |
| --- | --- |
| Precio | **~€3.79/mes + IVA ≈ €4.50** (~$5) |
| Cómputo | 2 vCPU, 4 GB RAM, 40 GB NVMe |
| Tráfico | **20 TB/mes incluidos** (~€1/TB de excedente) |
| Extras | Volumen extra a €0.044/GB/mes, IPv4 incluida, firewall gratis |

20 TB es **4.000 veces** los 5 GB de Render y unas 15 millones de primeras
visitas. Un solo servidor corre Node + Socket.IO + el disco de `/var/data` y,
si quieres, Postgres y Redis en el mismo sitio (4 GB dan de sobra para este
proyecto). Nota: los centros están en Alemania, Finlandia y EE. UU. (Ashburn);
para México, Ashburn da latencia decente.

Cómo se monta (resumen):

1. Crea el servidor con Ubuntu 24.04 y tu llave SSH.
2. Instala Docker y Caddy (Caddy saca el certificado HTTPS solo).
3. Clona el repo, `docker build -t montecristo .`, y levanta con un volumen
   montado en `/var/data` (mismas rutas que `render.yaml`).
4. `Caddyfile`: `montecristo.tudominio.com { reverse_proxy localhost:3000 }` —
   Caddy pasa WebSocket sin configuración extra.
5. Pon `NODE_ENV=production`, las rutas `/var/data/*` y `FOOTBALL_ENABLED=on`.
6. Si prefieres no administrar nada, puedes seguir usando Neon para Postgres.

**Contra:** tú eres el sysadmin (actualizaciones, backups). A cambio, los
respaldos son un `tar` del volumen y el coste es plano y predecible.

### Opción D — Fly.io: PaaS con egreso 7× más barato que Render

Ya no hay capa gratis (solo prueba de 2 h de cómputo o 7 días), pero el egreso
en Norteamérica es **$0.02/GB** contra los $0.15/GB de Render.

| Línea | Coste |
| --- | --- |
| `shared-cpu-1x` 512 MB encendido todo el mes | ~$3.32 |
| Volumen 3 GB | ~$0.45 |
| Egreso 50 GB (EE. UU.) | ~$1.00 |
| **Total realista** | **~$5/mes** |

Con 50 GB de tráfico pagas un dólar: el mismo volumen en Render serían **$6.75**
solo de excedente. Buen punto medio entre PaaS y VPS.

### Opción E — Railway: la migración más rápida ($5/mes)

Hobby son **$5/mes con $5 de crédito incluido**; egreso **$0.05/GB** (3× más
barato que Render), volúmenes de 5 GB. Detecta el repo de GitHub y despliega
solo. Es el sitio donde el `Dockerfile` de este repo deja todo listo en un clic.

Contra: el cómputo se cobra por segundo y una instancia siempre encendida de
1 GB de RAM ya se come los $5 de crédito. Para este juego (que corre bots y
torneos) el plan gratis de $1/mes **no alcanza**: presupuesta $5–10.

### Opción F — Koyeb (gratis, 100 GB de egreso) — **sí aplica, con dos condiciones**

Instancia gratis: 512 MB de RAM, **0.1 vCPU**, 2 GB de disco, **100 GB de salida
al mes** (veinte veces el límite de Render y sin cobro por egreso). Se duerme
tras **1 hora** sin tráfico, no 15 min.

Tienes razón en que la parte del disco se reduce a la Lotería y la Fortuna: los
perfiles, la comunidad, los torneos del lobby, el fútbol, los device-links y las
sesiones **ya** escriben en Postgres con `DATABASE_URL`. Lo que no se arregla
con eso, medido sobre este repo (Node 22, `FOOTBALL_ENABLED=on`):

| Medición | Valor | Qué implica |
| --- | --- | --- |
| RAM en reposo | **148–200 MB** | Cabe en 512 MB con ~2× de margen… si no hay más |
| **Pico con una sala y un bot** | **211 MB** | Añade 1–2 salas simultáneas y roza el techo |
| CPU en reposo | 0.52 % de 1 núcleo | Los `setInterval` no cuestan nada: no es problema |
| Partido completo del Estadio | 4.73 ms de CPU | Los ~10 partidos/mes no son problema |
| **Arranque en tibio** (store ya escrito) | **1.8 s de CPU** | A 0.1 vCPU ≈ **18 s**; aceptable |
| **Arranque en frío** (store vacío) | **18.5 s de CPU** | A 0.1 vCPU ≈ **185 s ≈ 3 minutos** |

El número que decide es el último. En el plan gratis **no hay volúmenes**: cada
despliegue y cada instancia nueva nace sin `football.json`, así que el arranque
siempre es en frío. Un build de 3 minutos contra el health check hace que el
despliegue falle antes de estar sano, y el primer jugador que entre tras
cualquier reinicio espera su minuto largo con la sala despertando.

**Las dos condiciones para que Koyeb funcione:**

1. **Persistir el bus de fútbol.** No basta con la Lotería y la Fortuna: el
   `football.json` es hoy la **fuente autoritativa primaria** (`lib/football/`
   lo lee al arrancar; Postgres es solo su espejo). Sin volumen se regenera en
   cada arranque; con volúmenes ya no es vía gratuita (Koyeb no los ofrece en el
   plan free). Si lo mueves a PG de verdad, el arranque en frío baja a los ~9 s
   y el plan gratis pasa a ser defendible.
2. **Subir a la instancia `Micro` (1 GB, ~$5.36/mes).** Con 512 MB y picos de
   211 MB, dos o tres salas a la vez te dejan sin aire. Si el público será de
   un puñado de personas, 512 MB sí aguanta.

**Veredicto honesto:** para *probar* Koyeb sirve hoy, porque el plan gratis no
tiene permanencia; para producción de un juego con bots, torneos y el Estadio,
la RAM y el arranque en frío lo vuelven frágil. Y en cuanto empiezas a pagar, un
Hetzner a €4.50 con 20 TB de egreso sale mejor que un Koyeb Micro a $5.36 con
100 GB. Por eso lo puse después de Hetzner: no porque el egreso sea malo, sino
porque el cómputo gratis está dimensionado para una API, no para un casino en
tiempo real.

### Opción G — Northflank Developer Sandbox (gratis y sin dormir)

2 servicios + 1 base **siempre encendidos** sin costo, egreso a $0.06/GB.
Requiere tarjeta para verificar. Es la mejor opción si el requisito es "gratis y
que no se duerma", pero es más complejo de configurar que Render.

### Opción H — Oracle Cloud Always Free (gratis, mucha máquina, con asteriscos)

2 OCPU ARM / 12 GB RAM (recortado en junio de 2026 desde 4/24), 200 GB de disco
y **10 TB de egreso al mes**. El problema es la letra chica: piden tarjeta,
el *capacity error* al crear instancias ARM es legendario, y desde agosto de
2026 Oracle apaga y deshabilita instancias que excedan el nuevo límite. Sirve
como plan B o para correr el entorno de pruebas, no como producción de la que
dependas.

### Lo que NO sirve para este proyecto

- **Vercel / Netlify / Cloudflare Pages.** Son para sitios estáticos y funciones
  sin estado. MonteCristo necesita un proceso Node permanente: `server.js` guarda
  salas, bots, turnos y temporizadores en memoria y habla Socket.IO. Meterlo ahí
  obliga a reescribir medio juego.
- **Render free.** No admite discos, se duerme a los 15 min y ahora el egreso es
  aún más restrictivo.

---

---

## 2 bis. La opción de $0 de verdad: Koyeb + Estadio apagado

Si el requisito es **no gastar nada**, hay una combinación que sí aguanta con
los números medidos sobre este repo, y no depende del ancho de banda (que ya
resuelve Cloudflare):

**Koyeb plan Free + `FOOTBALL_ENABLED=off` + `DATABASE_URL` (Neon free) +
Cloudflare delante.** Coste total: **$0/mes**, y sin tarjeta en Koyeb ni en Neon.

El Estadio es lo que hace inviable el plan gratis de 512 MB / 0.1 vCPU. Medido
en frío (store vacío, que es como arranca siempre un host sin volúmenes):

| | `FOOTBALL_ENABLED=on` | `FOOTBALL_ENABLED=off` | Mejora |
| --- | --- | --- | --- |
| CPU de arranque en frío | 22.2 s | **0.3 s** | 74× menos |
| Arranque a 0.1 vCPU | ~222 s (falla el health check) | **~3 s** | viable |
| RAM en reposo | 195 MB | **84 MB** | −57 % |
| RAM con 1 sala + 1 bot | 211 MB | **95 MB** | cabe 5× en 512 MB |
| Archivos en disco | 6 (6.1 MB de `football.json`) | 2 (531 bytes) | nada que perder |

Con 95 MB de pico te entran **cuatro o cinco salas simultáneas** en 512 MB, y el
arranque de 3 segundos pasa el health check sin drama. Y el disco deja de
importar: lo que queda son `loteria.json` (480 B) y `fortune.json` (51 B), dos
archivos que se regeneran solos y que el diario de la Fortuna reconcilia por
diseño al arrancar sin costar fichas.

**Qué conservas:** Póker, Blackjack, ruleta, dados, monedas, tragamonedas,
Lotería, Rueda de la Fortuna, el lobby con amistades, clubes, torneos relámpago,
cosméticos, gachapón y álbum de cartas, Pasaporte y cuentas.

**Qué pierdes:** el Estadio completo — MonteCristo News, la quiniela, el Balón de
Oro, los clubes y los partidos. La pestaña no se rompe: `server.js` la apaga de
forma limpia (`{ enabled: false }` en `/healthz`) y el cliente no la ofrece.

**Qué condiciones tiene:**

1. `DATABASE_URL` con Neon free: sin él, los perfiles viven en un JSON y cada
   reinicio de Koyeb (que no tiene volúmenes) los borra.
2. El plan gratis de Koyeb duerme a la hora: la primera visita tras ese rato
   tarda unos segundos en despertar (con el Estadio apagado, segundos, no
   minutos).
3. Cloudflare delante sigue siendo la pieza que evita el problema de egreso, y
   de paso te da el HTTPS y la caché de assets.

**Si algún día quieres el Estadio de vuelta**, el mismo código es el que corre en
un Hetzner de ~$5 con 20 TB: ahí sí hay RAM y CPU para los 22 s de generación
del calendario. No es un cambio de código, es cambiar `FOOTBALL_ENABLED` y el
host.

## 3. Recomendación

| Si tu prioridad es… | Elige | Coste |
| --- | --- | --- |
| **Gastar $0 y resolverlo esta semana** | **A** (Cloudflare delante de Render) y luego **B** (assets a R2) | $0 |
| **No volver a pensar en el ancho de banda** | **C** (Hetzner CX22) | ~$5/mes |
| **Seguir en PaaS, migrando en una tarde** | **E** (Railway) o **D** (Fly.io) | $5–8/mes |
| **$0 y sin dormir, pero sin Estadio** | **Koyeb free + `FOOTBALL_ENABLED=off`** (sección 2 bis) | $0 |
| **$0 con el Estadio completo** | **A + B** (Cloudflare sobre Render): el plan de Render ya está pagado | $0 extra |
| **Probar Koyeb sin pagar** | **F**, asumiendo arranques de ~3 min y pocas salas a la vez | $0 |

Si lo que te atrae de Koyeb es el **egreso** (100 GB gratis), la opción B
—assets en Cloudflare R2— te da egreso ilimitado a $0 sobre *cualquier* host, y
la opción A te lo da también para el HTML. El egreso es la parte fácil de
resolver; el cómputo es lo que Koyeb no regala. Y si vas a pagar de todas
formas, Hetzner cuesta menos que un Koyeb Micro y no tiene ninguna de estas
limitaciones.

Mi orden concreto: **A + B ahora** (una tarde, $0, y descomprime Render lo
suficiente para terminar el mes), y **C en cuanto el tráfico se estabilice**. Si
te da flojera administrar un servidor, **D** o **E** con el `Dockerfile` de este
repo es el camino más corto.

---

## 4. Optimizaciones que valen más que el cambio de host

Hazlas antes de migrar; si no, pagas lo mismo en el host nuevo.

1. **Cartas de 848×1264 a ~424 px en WebP.** Se muestran a 118 px de ancho. De
   ~300 KB a **75–94 KB cada una**: los 14.9 MB bajan a ~4–5 MB. Si además usas
   `srcset`, el álbum completo pasa de 15 MB a menos de 5.
2. **Convertir `ballon-dor-ceremony-theme.wav` (1.9 MB) a MP3/OGG.** Un WAV de
   un tema musical pesa 8–10× más que el mismo audio comprimido: baja a ~250 KB.
3. **Recomprimir las 7 imágenes del lobby** (1.1 MB → ~350 KB en WebP).
4. **Cachear las respuestas del Estadio.** `loadPromotion()` y
   `loadBallonDorMarket()` piden cada 15 s con `cache: 'no-store'`. Con
   `ETag`/`304` o subiendo el intervalo a 60 s mientras la pestaña está oculta
   (`document.hidden`) se recorta una buena parte del tráfico de API.
5. **Servir `/assets` con `immutable: true`.** Hoy `server.js` usa
   `maxAge: '7d', immutable: false`; con nombres que no cambian, un año es
   seguro y evita revalidaciones.
6. **Poner Cloudflare delante en cualquier host.** Aunque migres, el CDN gratis
   absorbe las imágenes.

---

## 5. Checklist de migración (aplica a C, D y E)

- `DATABASE_URL` → Neon u otro Postgres (los perfiles, la comunidad, los torneos
  del lobby, el fútbol y las sesiones ya tienen backend Postgres).
- Rutas persistentes en el volumen, con las **mismas rutas** de `render.yaml`:
  `PROFILE_STORE_PATH`, `LOTERIA_STATE_PATH`, `FORTUNE_STATE_PATH`,
  `LOBBY_TOURNAMENT_STORE_PATH`, `FOOTBALL_STORE_PATH` y `PROMOTION_MEDIA_DIR`
  apuntando a `/var/data/...`.
- `NODE_ENV=production`, `CASINO_TIME_ZONE=America/Mexico_City`,
  `FOOTBALL_ENABLED=on`, `FOOTBALL_DAILY_NEWS_ENABLED=on`.
- `APP_ORIGIN` con el dominio nuevo y HTTPS (obligatorio para activar cuentas).
- `FOOTBALL_WRITER_WAIT_MS=180000`: solo hace falta si el host hace despliegues
  solapados (Render y Railway sí). En un VPS con parada limpia es inocuo.
- El health check va a **`/healthz`**.
- `PORT` lo inyectan todos los PaaS; en el VPS con Docker se expone 3000.

---

## 6. Resumen en una línea

Render te quitó el ancho de banda gratis; **Cloudflare delante cuesta $0 y
arregla el 90 % hoy**, y si quieres dejar de preocuparte para siempre,
**Hetzner CX22 a ~$5/mes te da 20 TB de tráfico**: 4.000 veces lo que tienes
ahora.
