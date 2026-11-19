# Optimización de consumo — qué se cambió y cuánto ahorra

Fecha: **noviembre 2026**. Todas las cifras están medidas sobre este repositorio
en un sandbox con Node 22, no estimadas.

---

## Resumen

| Métrica | Antes | Ahora | Ahorro |
| --- | --- | --- | --- |
| `public/assets` en el repo | 25 MB | **8.3 MB** | −67 % |
| Primera visita al lobby | **1,304 KB** | **475 KB** | **−64 %** |
| Álbum de cartas (54) | 14.9 MB | **4.4 MB** | **−70 %** |
| Audio de la ceremonia y efectos | 4.6 MB | **0.4 MB** | **−91 %** |
| Imágenes del lobby | 1.4 MB | **0.3 MB** | **−78 %** |
| Peticiones del Estadio con pestaña oculta | ~8/min | **~1/min** | **−87 %** |
| RAM en reposo (Estadio apagado) | 84 MB | 84 MB | — |
| Arranque en frío (Estadio apagado) | 0.3 s de CPU | 0.3 s de CPU | — |

La RAM y el arranque no cambian: lo que se optimizó es **tráfico**, que es lo que
se factura en Render y lo que espera el visitante.

---

## 1. Audio: WAV → MP3 (4.6 MB → 0.4 MB)

El proyecto tenía **23 archivos WAV** (4.6 MB). El tema del Balón de Oro eran
1.9 MB de PCM mono a 22 kHz — el mismo audio en MP3 a 48 kbps pesa 264 KB.

- Todos convertidos con LAME (vía `lameenc`) a **MP3 mono 48 kbps**.
- `estadio.js` pide ahora `names/<id>.mp3` y `cues/<clave>.mp3`.
- `estadio.html` apunta el tema a `.mp3` (dos etiquetas `<audio>`).
- Los WAV se eliminaron: nada los pedía ya.

Regenerar: `npm run assets:audio` (usa ffmpeg si existe; si no, `lameenc`).

## 2. Cartas: 848×1264 JPG → 464 px WebP (14.9 MB → 4.4 MB)

Las cartas se pintan en una rejilla de **118 px** (`card-album.css`), pero se
servían JPG de 848 px y ~300 KB cada una.

- WebP de **464 px** (cubre pantallas 4x) a calidad 80: **~80 KB** cada una.
- `lib/card-gacha.js` sirve `.webp` y cae a `.jpg` solo si el WebP no existe.
- Los JPG se conservan como respaldo de `<picture>` y como fuente.

Regenerar: `npm run assets:img`.

## 3. Imágenes del lobby con `<picture>` (1.4 MB → 0.3 MB)

Las 7 imágenes del lobby y las tarjetas del Estadio se envuelven en `<picture>`
con `source type="image/webp"`, así que **cada navegador elige el formato** y el
JPG queda como respaldo. Sin JavaScript y sin romper nada.

Detalle importante de CSS: `<picture>` es transparente con `display: contents`,
porque en el lobby era hijo directo de un grid y, sin eso, la imagen perdía su
`position: absolute` y el diseño se rompía.

## 4. Polling del Estadio según la visibilidad (≈8/min → ≈1/min)

`public/estadio.js` tenía dos bucles de 15 s (`promoPollId` y
`ballonDorPollingId`) con `cache: 'no-store'`. Ahora:

- Pestaña **visible**: 15 s (igual que antes, no se pierde frescura).
- Pestaña **oculta**: **120 s**, y al volver se recarga al instante vía
  `visibilitychange`.

Si alguien deja el Estadio abierto en otra solapa, deja de generar 6 de cada 7
peticiones.

## 5. `Save-Data` (ahorro de datos del navegador)

Si el cliente manda `Save-Data: on` (Chrome móvil con Ahorro de datos):

- El audio de ambiente (890 KB) y el tema de la ceremonia responden **204**.
- Las creatividades subidas responden **204** (el cliente ya tiene fondo CSS).
- El resto se sirve normal: el HTML y las cartas no se tocan.

Estas reglas van **antes** de `express.static`; si se ponen después, nunca se
ejecutan (lo detectamos probándolo: la primera versión no funcionaba).

## 6. Cabeceras de caché (lo que hace posible Cloudflare)

- `/assets/*` → `Cache-Control: public, max-age=31536000, immutable`
  (antes `max-age=7d` y sin `public`, que impide cachear en un CDN compartido).
- `/healthz` y `/health` → `no-store`.

Ver `docs/cloudflare-delante-de-render.md`.

---

## Qué NO se hizo, y por qué

- **Minificar el CSS**: `clean-css` solo baja 269 KB → 240 KB (−11 %) porque
  gzip ya hacía casi todo el trabajo, y hay 960 clases con nombres construidos
  dinámicamente (`cosmetic-style-*`, `animate-*`, `fan-pin-*`) donde un minifier
  agresivo podría romper estilos. No vale el riesgo por ~2 KB gzip.
- **Borrar CSS muerto**: el análisis marca 51 clases sin referencia, pero son
  justamente las generadas en runtime. Falsos positivos.
- **Minificar JS**: `app.js` son 96 KB gzip; la ganancia no compensa perder la
  legibilidad de un archivo que el proyecto mantiene a mano.
- **Borrar los JPG de las cartas**: se conservan porque `lib/card-gacha.js` los
  usa como respaldo si falta un WebP, y son la fuente para re-encodar.

---

## Cómo reproducir las mediciones

```bash
# Peso de una primera visita (con gzip)
for f in / /styles.css /app.js; do
  curl -s -H "Accept-Encoding: gzip" -o /dev/null -w "$f %{size_download}\n" http://localhost:3000$f
done

# Que Cloudflare cachee de verdad
npm run cdn:check -- https://tu-dominio.com
```

## Pruebas

`npm run test:unit` → **825 pasan, 1 falla**. La que falla
(`fan-zone-demo.test.js`, "la selección de clubes es local…") **ya fallaba antes
de estos cambios**: se comprobó con `git stash` y falla igual en el commit base.
No está relacionada con assets, audio ni caché.

Las pruebas que sí se actualizaron, porque comprobaban las rutas viejas:
`card-gacha`, `card-book`, `banners-and-keybindings`, `football-stadium-ui`.

---

## 7. `room_state` compacto: el mayor ahorro de tráfico (medido después)

Al medir una sesión de juego real apareció el verdadero consumidor: **no eran las
imágenes, era el estado de la mesa**. `publicRoom()` incluye `viewerProfile` con
`publicProgress(profile, true)`, es decir el perfil **completo** —álbum de 54
cartas con textos, colecciones, 18 logros, 15 retos, historial— y se emitía en
**cada acción** de la mesa.

| | Antes | Ahora |
| --- | --- | --- |
| Un `room_state` | 34.3 KB | **12 KB** |
| `viewerProfile` dentro | 25.9 KB | **4.3 KB** |
| Sesión de 10 acciones (socket) | 391 KB | **143 KB** (−63 %) |

Qué cambió:

- `publicProgress(profile, true, { compact: true })` (nuevo parámetro opcional).
  En compacto, el álbum viaja **solo con las cartas obtenidas** (sin textos ni
  tasas), y se omiten `allAchievements`, `challenges`, `gameStats`,
  `balanceHistory`, `collection` completa y `fanBanners`.
- `room_state` usa el modo compacto; `publicProgress(profile, true)` **sin**
  compacto no cambió, así que el modal, la API y las pruebas del perfil siguen
  recibiendo todo.
- Nuevo evento **`profile_detail_get`**: el cliente lo pide al abrir el modal
  estando en una mesa. Devuelve el perfil completo (25.9 KB) **una vez por
  apertura**, no una vez por acción. Con eso el álbum sigue mostrando las 54
  cartas, incluidas las siluetas de las no obtenidas.

Comprobado de extremo a extremo contra el servidor: `room_state` trae 4.3 KB sin
`allAchievements` ni `rates`, y `profile_detail_get` devuelve 25.9 KB con las 54
cartas, 18 logros y 6 tasas.

## 8. ¿Cuánto duran los 5 GB de Render?

Con las cifras medidas (primera visita 475 KB, revalidación 304 sin cuerpo,
sesión de 10 acciones 143 KB):

| Escenario | Tráfico/día | Duración de 5 GB | Con Cloudflare |
| --- | --- | --- | --- |
| 10 personas/día, 1 sesión | 6.0 MB | **~848 días** | ~2.203 días |
| 50 personas/día, 2 sesiones | 44 MB | **~116 días** | ~200 días |
| 200 personas/día, 2–3 sesiones | 232 MB | **~22 días** | ~34 días |
| 1.000 personas/día | 1.163 MB | **~4 días** | ~7 días |

Sin las optimizaciones de esta sesión, los mismos escenarios daban 309, 42 y
**8 días**. El tráfico de juego (socket) es ahora el que manda: con 200 personas
al día, las imágenes ya solo son una parte menor del consumo.

### 8 bis. Tu caso concreto: 50 personas

**La cuota no "tarda" en recargarse: se reinicia el día 1 de cada mes.** Lo que
importa es si llegas al tope antes del reinicio. Con 50 personas, no:

| Escenario (50 personas) | Consumo/mes | % de 5 GB |
| --- | --- | --- |
| 50 registradas, 10 entran al día, 1 sesión | 0.05 GB | **1 %** |
| 50 al día, 1 sesión de 10 acciones | 0.27 GB | **5 %** |
| 50 al día, 2 sesiones de 20 acciones | 0.48 GB | **10 %** |
| 50 al día, 3 sesiones de 30 acciones (intenso) | 0.68 GB | **14 %** |

(Cifras con Cloudflare delante, que absorbe el 90 % de las imágenes.)

**Cuántas personas cabrían de verdad en los 5 GB:**

| Uso | Capacidad |
| --- | --- |
| 1 sesión de 10 acciones | **917 personas/día** |
| 2 sesiones de 20 acciones | **524 personas/día** |
| 3 sesiones de 30 acciones | **366 personas/día** |
| 2 sesiones de 20 acciones, sin Cloudflare | 230 personas/día |
| 2 sesiones de 20 acciones, **sin las mejoras de esta sesión** | **84 personas/día** |

Es decir: antes de optimizar, con 50 personas intensas estabas al **60 % de la
cuota**; ahora estás al **14 %**, y te sobra margen para multiplicar por 7 el
tráfico antes de acercarte al límite.

### 8 ter. El límite real no es el ancho de banda

En el plan **free** de Render hay un tope que llega antes y que no se arregla
optimizando: **750 horas de instancia al mes por workspace**. Un servicio
encendido 24/7 consume ~744 horas, o sea que **casi todo el presupuesto se va en
mantenerlo despierto**. Consecuencias:

- Si tocas cualquier otro servicio free (otra web, un cron), te quedas sin horas
  y **Render suspende todos los servicios free hasta el mes siguiente**.
- El servicio **se duerme a los 15 minutos** sin tráfico y tarda ~1 minuto en
  despertar (con el Estadio apagado, unos segundos).
- Lo que **sí** protege el ancho de banda: desde febrero de 2026, un servicio
  free **no se duerme mientras reciba mensajes de WebSocket**. Como este juego
  mantiene el socket abierto, mientras alguien esté jugando el servicio sigue
  despierto y no consume el minuto de despertar.

**Si hay gente jugando, el ancho de banda ya no es el problema: las 750 horas y
el sueño a los 15 minutos son la experiencia real.**
