# Revisión de calidad — Fase 9 (2026-09-28)

Tres miradas sobre el producto completo: una **usuaria real**, un **diseñador
profesional** y un **QA adversarial**. Cada hallazgo indica si quedó corregido
en esta entrega o si es una recomendación para más adelante.

---

## 1. Recorrido desde el punto de vista de una usuaria

Automatizado en `tests/user-journey-smoke.js` (navegador simulado con jsdom que
solo usa la interfaz: clics, teclado y formularios, nunca el protocolo interno):

1. Abre la página, ve el aviso de solo-escritorio y pulsa «Entrar de todos modos».
2. El modal de Términos y Condiciones la detiene hasta que acepta con un clic.
3. Crea una mesa de ruleta desde la tarjeta del lobby, con su nombre y el de la sala.
4. Apuesta 50 fichas al rojo con los controles reales y lanza la ronda como anfitriona.
5. Puede saltar la animación y ve su resultado con su nombre en la mesa.
6. Chatea (incluso intenta pegar HTML malicioso: se publica como texto plano).
7. Vuelve al lobby y se encuentra en el ranking mensual.

**Resultado: el recorrido completo funciona sin errores de consola.** El test
corre en cada push, así que cualquier regresión que rompa el flujo de una
persona nueva se detecta antes de desplegar.

## 2. Revisión de diseño (estilo)

### Corregido en esta entrega

| Hallazgo | Antes | Ahora |
|---|---|---|
| **Tipografía ilegible**: 75+ reglas entre 6 y 9 px; el microcopy (etiquetas, chat, estados) era casi ilegible incluso en 1920×1080. | mínimo 6 px | escala reajustada preservando la jerarquía: piso de 8 px solo para micro-etiquetas en mayúsculas; cuerpos de texto en 9.5–11 px |
| **Contraste bajo** en textos secundarios (`--muted-2 #536469` ≈ 4:1 sobre el fondo; mensajes de sistema y placeholders aún más oscuros). | ≈ 4:1 | `--muted-2 #66787e` y grises de chat/placeholders elevados (≈ 5.5:1, en línea con WCAG AA para texto pequeño) |
| **Imágenes del lobby sin diferir**: las 6 fotos (≈ 900 KB) cargaban de inmediato aunque están bajo el pliegue. | carga inmediata | `loading="lazy"` + `decoding="async"`; además ahora viajan con caché de 7 días |

### Lo que ya estaba bien (se conserva tal cual)

- **Tokens de diseño** centralizados en `:root` (paleta menta/dorado/coral sobre
  fieltro oscuro, coherente con la identidad de casino nocturno).
- **Estados completos** en los controles: hover, active, disabled, loading con
  spinner y `:focus-visible` en botones, fichas, filtros y chat.
- **Accesibilidad de movimiento**: `prefers-reduced-motion` desactiva las
  animaciones de ruleta/tragamonedas; hay skip-link y atajos de teclado con ayuda (`?`).
- **Privacidad visual**: cartas rivales siempre boca abajo; la información
  sensible ni siquiera llega al navegador.

### Recomendaciones para una futura pasada (no bloqueantes)

- Migrar la escala tipográfica a `rem` con una escala modular definida en
  `:root`, en lugar de píxeles sueltos por componente.
- La fuente display «Arial Narrow» depende del sistema operativo; un webfont
  condensado propio (p. ej. Archivo Narrow) haría la marca idéntica en
  Windows/macOS/Linux.
- Unificar los radios de borde en 2–3 tokens (`--radius` ya existe pero varios
  componentes usan valores propios).

## 3. Auditoría QA

### Corregido en esta entrega

1. **Inundación de chat**: no había límite de frecuencia; un cliente podía
   spamear broadcasts a toda la mesa. → Límite de 6 mensajes/reacciones cada
   4 s por conexión, con mensaje amable.
2. **2 CVE moderadas** en `qs` (vía express). → `npm audit fix`: express
   4.22.3, socket.io 4.8.4; `npm audit` queda en 0.
3. **Sin compresión ni caché**: todo viajaba sin gzip y sin `Cache-Control`.
   → middleware `compression` + caché de 7 días para imágenes y 5 min para
   estáticos. Primera carga: **96 KB gzip** (presupuesto: < 300 KB → < 2 s
   incluso a 3 Mbps).
4. **Sin presupuesto de rendimiento vigilado** → `tests/performance-smoke.js`
   falla si el HTML/CSS/JS engordan, si las imágenes pierden la caché o si los
   payloads de Socket.IO (`lobby_state`/`room_state`, hoy < 6 KB) superan 30 KB.

### Verificado y aprobado (sin cambios necesarios)

- **XSS, doble defensa**: el servidor recorta y quita `<>` de nombres, salas y
  mensajes; el cliente además escapa todo con `escapeHtml` antes de pintar.
- **Validación económica**: toda apuesta pasa por `Number.isFinite` + rango
  (NaN, negativos, `Infinity`, decimales y montos mayores a las fichas se
  rechazan sin tocar el saldo). Verificado en `tests/qa-hardening-smoke.js`.
- **Permisos**: solo el anfitrión reparte/lanza/reabre rondas; acciones de un
  juego en la mesa de otro se rechazan.
- **Robustez del cliente**: APIs del navegador (AudioContext, canvas,
  IntersectionObserver) siempre con guardas; sin errores en navegador simulado.
- **Juego desconocido en `create_room`** degrada a póker en vez de fallar:
  decisión deliberada para clientes con caché vieja (documentada aquí).

### Riesgos aceptados (casino social, sin dinero real)

- El **token de dispositivo** identifica al perfil; quien copie el token de otra
  persona podría usar su perfil. Aceptable sin dinero real; si algún día hay
  cuentas, tocaría firmar tokens en el servidor.
- **Sin cuota de salas por origen**: alguien podría abrir muchas mesas; la
  limpieza automática de mesas vacías lo mitiga. Añadir cuota solo si aparece
  abuso real.

## 4. Calidad continua instalada (fase 9)

- **CI**: `.github/workflows/ci.yml` corre las 15 suites en cada push/PR.
  En Render, activar «Wait for CI» para que el auto-deploy espere el verde.
- **Previews por PR**: bloque `previews` en `render.yaml` (disco nuevo y vacío
  por preview; se destruyen solas).
- **Presupuesto de rendimiento**: vigilado por test, techos documentados en
  `MANTENIMIENTO.md`.
- **Rutina trimestral** de dependencias y tamaño del store: `MANTENIMIENTO.md`.
