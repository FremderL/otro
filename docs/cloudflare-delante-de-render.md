# Cloudflare delante de Render — configuración paso a paso

Objetivo: que las imágenes, el audio y las cartas de MonteCristo salgan desde el
borde de Cloudflare en vez de Render, para que el ancho de banda de Render
(5 GB/mes en Hobby, a $0.15/GB de excedente) deje de ser un problema. Coste:
**$0/mes**.

Tiempo estimado: **40–60 minutos**, más lo que tarde en propagar el DNS.

---

## Lo único que necesitas comprar: un dominio

Cloudflare **no puede proxear** el dominio que te da Render (`*.onrender.com`):
para ponerle el naranja hay que tener el DNS delegado en Cloudflare, y eso
requiere ser dueño del dominio. Si aún no tienes uno, compra el más barato que
encuentres (~$10–12/año en Cloudflare Registrar, Namecheap o Porkbun). Da igual
cuál sea; lo que importa es que puedas cambiar sus *nameservers*.

> Si ya tienes un dominio en otro proveedor, no lo muevas: puedes delegar solo
> un subdominio (por ejemplo `juego.tudominio.com`) con un `NS` en Cloudflare y
> te ahorras tocar el resto.

---

## Paso 1 — Dar de alta el dominio en Cloudflare

1. Entra en <https://dash.cloudflare.com> y crea una cuenta gratuita.
2. **Add a domain** → escribe tu dominio → elige el plan **Free**.
3. Cloudflare te mostrará **dos nameservers** (algo como `ada.ns.cloudflare.com`
   y `bob.ns.cloudflare.com`). Cópialos.
4. Ve al panel de tu registrador y cambia los *nameservers* del dominio por esos
   dos. Borra los que hubiera.
5. Vuelve a Cloudflare y pulsa **Check nameservers**. La propagación tarda entre
   5 minutos y 24 horas (normalmente menos de una hora). Recibirás un correo
   cuando esté activo.

**No sigas hasta que Cloudflare diga "Active".**

---

## Paso 2 — Apuntar el dominio a Render

Primero necesitas el host de tu servicio en Render:

1. Render Dashboard → tu servicio **montecristo** → pestaña **Settings**.
2. Copia el valor de **URL** (algo como `montecristo-xxxx.onrender.com`).

Después, en Cloudflare → **DNS → Records → Add record**:

| Campo | Valor |
| --- | --- |
| Type | `CNAME` |
| Name | `@` (para la raíz) o `juego` si usas subdominio |
| Target | `montecristo-xxxx.onrender.com` (el tuyo, **sin `https://`**) |
| Proxy status | **Proxied (naranja)** ← lo más importante de toda la guía |
| TTL | Auto |

> Si tu registrador no deja poner `CNAME` en la raíz (`@`), Cloudflare lo
> resuelve igual: al escribir `@` con destino CNAME te ofrece el *CNAME
> flattening* automáticamente. Acepta.

**Verifica que el naranja está puesto.** Si queda en gris (DNS only), Cloudflare
solo resuelve el nombre y no cachea nada: no habrás ganado nada.

---

## Paso 3 — Registrar el dominio en Render

1. Render → tu servicio → **Settings → Custom Domains → Add Custom Domain**.
2. Escribe `tudominio.com` (o `juego.tudominio.com`).
3. Render te dirá que verifique el dominio / emitirá el certificado TLS. Como el
   DNS ya apunta por Cloudflare, la verificación es casi inmediata.

Con el proxy en naranja, el certificado que ve el visitante lo emite Cloudflare
y Render emite el suyo para el tramo Cloudflare→Render. **No hace falta configurar
SSL/TLS a mano**: deja Cloudflare en **SSL/TLS → Overview → Full (strict)**. Si
lo dejas en *Flexible*, Render te redirigirá en bucle infinito.

---

## Paso 4 — Las reglas de caché (el corazón de la solución)

Cloudflare → **Caching → Cache Rules → Create rule**. Vamos a crear **dos**.

### Regla 1: cachear los assets un mes

| Campo | Valor |
| --- | --- |
| Rule name | `MonteCristo assets` |
| When incoming requests match | **Custom filter expression** |
| Field / Operator / Value | `URI Path` · `starts with` · `/assets/` |
| Then → Cache eligibility | **Eligible for cache** |
| Edge TTL | **Ignore cache-control header and use this TTL** → **1 month** |
| Browser TTL | **Respect origin TTL** (el servidor ya manda 1 año) |

Pulsa **Deploy**.

> Por qué "ignore cache-control": el servidor ya manda
> `public, max-age=31536000, immutable`, así que en la práctica *Respect origin
> TTL* también funcionaría. Forzarlo te protege de que un despliegue futuro
> afloje esa cabecera sin que te des cuenta.

### Regla 2: no cachear el HTML ni la API

| Campo | Valor |
| --- | --- |
| Rule name | `MonteCristo shell y API` |
| When incoming requests match | **Custom filter expression** |
| Expression | `URI Path` · `starts with` · `/api/` **OR** `URI Path` · `equals` · `/healthz` **OR** `URI Path` · `equals` · `/socket.io/` |
| Then → Cache eligibility | **Bypass cache** |

Pulsa **Deploy**.

**Por qué esta regla es obligatoria:** el resto del sitio (HTML, JS de la app)
manda `Cache-Control: no-cache, must-revalidate`, así que Cloudflare ya no lo
cachea por su cuenta. Pero `/healthz` decide si Render reinicia el servicio y
`/socket.io/` es el WebSocket del juego: ninguno de los dos debe pasar nunca por
la caché.

> ¿Y el HTML y `app.js`? `server.js` los marca `no-cache, must-revalidate` a
> propósito (`revalidateAppShell`), para que un despliegue se vea al instante.
> Déjalos así: son ~200 KB comprimidos, no son el problema del ancho de banda.

### Comprobación rápida de que las reglas están bien puestas

En la lista de Cache Rules debe verse, en este orden:

1. `MonteCristo shell y API` — Bypass
2. `MonteCristo assets` — Cache

Cloudflare evalúa de arriba abajo y gana la primera que coincide, así que si se
crearon al revés, arrastra la de *Bypass* arriba.

---

## Paso 5 — Apagar lo que rompe el juego (importante)

El servidor manda esta CSP (`lib/security-hardening.js`):

```
script-src 'self'
```

Eso significa que **solo se ejecuta JavaScript servido desde tu propio dominio**.
Cloudflare tiene dos funciones que inyectan JavaScript de terceros en el HTML y
que, con esta CSP, **romperían el juego** (la página carga, pero los botones no
responden y verás errores de CSP en la consola del navegador):

| Función | Dónde está | Qué hacer |
| --- | --- | --- |
| **Rocket Loader** | Speed → Optimization → Content Optimization | **OFF** |
| **Email Address Obfuscation** | Scrape Shield → Email Address Obfuscation | **OFF** |

Comprueba también que **Speed → Optimization → Content Optimization** no tenga
activado *Automatic Minify* agresivo sobre HTML si usas Transform Rules propias.

---

## Paso 6 — Desplegar la versión del repo

Los cambios de caché viven en `server.js`, así que hay que desplegar. En Render,
un push a `main` (o **Manual Deploy**) es suficiente. Los cambios son:

- `/assets/*` ahora responde `Cache-Control: public, max-age=31536000, immutable`
  (antes `max-age=7d` **sin `public`**, que impedía que un CDN compartido lo
  guardara).
- `/healthz` y `/health` mandan `Cache-Control: no-store`.

---

## Paso 7 — Verificar que funciona

Desde tu computadora, con el repo a mano:

```bash
npm run cdn:check -- https://tudominio.com
```

El script comprueba cinco cosas y te dice cuál falla:

```
1) Assets (/assets/cards/card-3-hearts.jpg)
   primera petición  → status 200, cf-cache-status: MISS
   segunda petición  → status 200, cf-cache-status: HIT   ← esto es lo que quieres
   cache-control     → public, max-age=31536000, immutable
   ✅ El asset se sirve desde el borde: Render no cobra este tráfico.
2) Shell de la app (/)                ✅ no se cachea
3) Content-Security-Policy            ✅ script-src 'self' intacto
4) Health check (/healthz)            ✅ 200 y sin caché
5) WebSocket (/socket.io/)            ✅ handshake correcto
```

Si el punto 1 sigue en `MISS` tras varias peticiones, revisa en este orden:
el naranja del DNS, que la Cache Rule diga *starts with* `/assets/` (con barra
final), y que no haya una regla de *Bypass* arriba que la tape.

### Verificación manual (30 segundos)

```bash
curl -sI https://tudominio.com/assets/cards/card-3-hearts.jpg | grep -i cf-cache-status
curl -sI https://tudominio.com/assets/cards/card-3-hearts.jpg | grep -i cf-cache-status
```

La segunda debe decir `HIT`. Y para el HTML:

```bash
curl -sI https://tudominio.com/ | grep -i cf-cache-status
```

Debe decir `MISS` o `DYNAMIC`, **nunca `HIT`**.

### Confirmación final en el panel

Cloudflare → **Caching → Analytics**: la gráfica *Bandwidth saved* debe subir
mientras navegas el juego. Ese número es exactamente el tráfico que ya no toca
Render.

---

## Resultado esperado

| | Antes | Después |
| --- | --- | --- |
| Primera visita | ~1.3 MB desde Render | ~200 KB (solo texto) |
| Segunda visita | ~1.3 MB otra vez | ~200 KB |
| Álbum de cartas (54 JPG) | 14.9 MB | 14.9 MB **una vez**, luego 0 |
| Visitas antes de agotar 5 GB | ~3.800 | **más de 25.000** |

---

## Problemas típicos

**«El juego carga pero nada responde»**
Rocket Loader o Email Obfuscation están activos. Apágalos (paso 5). En la consola
del navegador verás `Refused to execute inline script` o
`Refused to load the script ... because it violates CSP`.

**«Bucle de redirecciones» / `ERR_TOO_MANY_REDIRECTS`**
SSL/TLS está en *Flexible*. Cámbialo a **Full (strict)**.

**«La UI se quedó en una versión vieja tras desplegar»**
Alguna regla de caché está cacheando el HTML. Revisa que la regla de *Bypass*
cubra `/*` o al menos `/`, y purga: Caching → Configuration → **Purge Everything**.

**«Los WebSockets se cortan cada minuto y medio»**
El plan gratis de Cloudflare corta conexiones WebSocket inactivas a los 100 s.
Socket.IO manda *heartbeat* cada 25 s, así que en condiciones normales no pasa;
si lo ves, revisa que `/socket.io/` esté en *Bypass* y que no haya una regla de
*Cache Everything* sobre `/*`.

**«`cf-cache-status: MISS` siempre»**
El asset tarda en entrar en caché si Cloudflare tiene poco tráfico reciente. Haz
tres peticiones seguidas o usa *Cache Everything* con Edge TTL. Comprueba
también `curl -sI` que llegue `cf-ray`; si no llega, el DNS está en gris.

**«Render sigue marcando consumo de ancho de banda»**
Render cuenta lo que **sale de su red**, y eso incluye el tráfico de
Cloudflare→Render de cada *cache miss*. Con la caché de un mes, ese tráfico es
una fracción del total. Compara las dos gráficas (Render y Cloudflare Analytics)
tras 24 h.

---

## Qué queda fuera de esta guía

- **Las cartas siguen pesando 300 KB cada una.** Con Cloudflare dejas de pagarlas,
  pero tus visitantes siguen tardando en ver el álbum. Convertirlas a WebP de
  424 px las deja en 75–94 KB (−70 %). Está en
  `docs/despliegue-alternativas-render.md`, sección 4.
- **`ballon-dor-ceremony-theme.wav` son 1.9 MB de WAV.** Igual de cacheable, pero
  convertirlo a MP3 lo deja en ~250 KB.
- **Los polling de 15 s del Estadio** (`estadio.js`) siguen golpeando Render.
  Con 100 s de timeout de WebSocket conviene pasarlos a eventos si algún día
  quieres reducir también el tráfico dinámico.
