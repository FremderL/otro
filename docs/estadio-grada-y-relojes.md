# Estadio — grada, relojes y apertura tardía del Balón de Oro

Cambios de producto de octubre de 2026 sobre el Estadio MonteCristo. Cada apartado explica **qué se
pidió**, **qué hace el código ahora** y **cómo se prueba**.

> **Alcance del reloj:** los cálculos de 15 min 45 s de esta sección describen
> V1. Para encuentros V2 desde noviembre de 2026, la grada permanece abierta
> hasta el estado final real; el cierre de apuestas del Balón de Oro muestra
> una estimación pública de 90 minutos a 15 s/min, sin revelar el final privado
> del partido. El tiempo añadido o una prórroga pueden cambiar el cierre real.

---

## 1. Parrilla reprogramada: ningún partido pisa la clausura del Balón de Oro

### El problema

Con la parrilla anterior el bloque Estelar arrancaba a las **20:30** con el destacado a las **21:30**.
En un día doble la segunda oleada suma **+30 min**, así que el destacado de la segunda jornada caía a
las **22:00 en punto**: la misma hora de la clausura del Balón de Oro. Ese partido seguía en juego
hasta las 22:15, es decir, durante la ceremonia y durante el anuncio del ganador.

Lo detectó un test nuevo que recorre los siete meses de referencia del calendario
(`tests/football-fixtures.test.js`): *«2026-04 m_2026-04_j16_b3_1 empieza a las 22:00»*.

### La corrección

| Bloque | Partidos | Horarios (oleada 1) | Oleada 2 (+30 min) |
| --- | --- | --- | --- |
| Matutino | 3 | 13:00 · 14:00 · 15:00 | 13:30 · 14:30 · 15:30 |
| Vespertino | 3 | 17:00 · 18:00 · 19:00 | 17:30 · 18:30 · 19:30 |
| Estelar | 2 | 20:00 · **21:00 (destacado)** | 20:30 · **21:30** |

- El Estelar se adelanta media hora (`lib/football/fixtures.js`, `DEFAULT_BLOCKS`).
- El **último kickoff del día es 21:30**, también en días dobles. Con la duración real de un partido V1
  (90 minutos simulados a 10 s/min + 45 s de intermedio = **15 min 45 s**, `matchRealMs()`) el último
  partido termina **21:45**, quince minutos antes de la clausura.
- La segunda oleada sigue siendo **+30 min**: no hay dos partidos a la misma hora y el orden
  cronológico entre jornadas se mantiene (J15 siempre antes que J16).

### La regla, como invariante

`tests/football-fixtures.test.js` verifica, para cada mes de referencia, que:

1. ningún kickoff ocurre a las 22:00 o después;
2. con duración V1, el último partido de la jornada del último día **termina** antes de las 22:00.

Si mañana se reprograma un partido a mano con el panel admin, el límite sigue aplicándose en las
pruebas: cualquier cambio de horarios que cruce las 22:00 rompe la suite.

---

## 2. Cuentas regresivas DD:HH:MM:SS

`football:lobby` publica ahora un bloque `countdowns` con instantes absolutos (nada de “faltan 3
días” calculado en el servidor):

```json
"countdowns": {
  "serverNow": 1793500000000,
  "casino":    { "seasonMonth": "2026-10", "endsAt": 1793512800000,
                 "chipsResetAt": 1793512800000, "resetDeferred": false },
  "ballonDor": { "seasonMonth": "2026-10", "status": "active",
                 "betsOpen": true, "betsCloseAfterJornada": 20,
                 "betsCloseAt": 1793420000000,
                 "ceremonyAt": 1793430000000 }
}
```

| Reloj | Lo calcula | Qué marca |
| --- | --- | --- |
| **Fichas y temporada** | `nextMonthStartAt()` en `lib/football/sockets.js` | Inicio del mes siguiente en hora local del casino: cierre de temporada y reinicio de fichas. `resetDeferred` avisa de que el reset se aplaza porque hay apuestas de fútbol abiertas |
| **Balón de Oro** | `ballonDorResultAnnouncementAt()` / `ballonDorFinalizationSchedule()` | Ceremonia de las 22:00 posteriores al último partido. La nota muestra además cuánto falta para el cierre de apuestas de la J20 |

El cliente (`public/estadio.js`) pinta `DD:HH:MM:SS` con cifras tabulares y descuenta contra el reloj
del servidor que ya recibe en cada tick, así que no se desfasa por la deriva del navegador. Estados
contemplados: `scheduled` (abre el día 1), `active` (apuestas abiertas + cierre de J20), `locked`
(cuotas cerradas, esperando el último partido), `settled` (`00:00:00:00`, ceremonia celebrada) y
`cancelled`.

---

## 3. Votación de la grada: insultos solo si la mayoría acepta

**Pedido:** si la mayoría de los que están viendo el partido acepta, en ese partido se puede insultar
en las gradas.

**Implementación** (`lib/football/stands.js`, cableado en `lib/football/sockets.js`):

| Regla | Valor |
| --- | --- |
| Cuándo se puede pedir | con el partido **en juego** (`live`, `halftime`, `extra_time`, `shootout`) |
| Quórum | **3 votos a favor** (`FOOTBALL_STANDS_QUORUM` configurable en el módulo) |
| Mayoría | hace falta `sí ≥ quórum` **y** `sí > no` |
| Ventana | **90 s**; si vence sin mayoría, la votación queda rechazada |
| Repetición | espera de **2 min** tras un rechazo |
| Un voto por perfil | el segundo intento devuelve `ya_votaste` |
| Duración de la autorización | hasta el **final de ese partido**; al terminar vuelve la censura |
| Alcance | **por partido**, nunca global |

Eventos Socket.IO nuevos: `football:stands_open` (abre la votación y suma el voto a favor de quien la
pide), `football:stands_vote` (`{ matchId, allow }`) y `football:stands_state` (difusión del estado y
consulta puntual). El estado viaja también dentro de `football:match_state`, así que al cambiar de
partido el panel aparece con la información correcta.

### Lo que la votación NO levanta

Aunque la grada vote a favor, siguen censurados los términos de odio y acoso (`HARD_BLOCKED`: insultos
dirigidos a grupos protegidos, amenazas). La votación habilita **tacos**, no agresiones. Además, el
texto siempre se limpia: sin `<`/`>`, sin saltos de línea, máximo 120 caracteres.

### Lo que ve el aficionado

En el panel *Reacciones y charla* hay una franja nueva:

- *«La grada está censurada. Si la mayoría acepta, este partido permite insultos.»* + botón
  **Pedir votación**.
- Con la votación abierta: *«Faltan N voto(s) a favor»*, recuento `A favor X · En contra Y · Quórum 3`
  y los botones **Sí** / **No**.
- Con la votación ganada: *«Grada picante: la mayoría aceptó y en este partido se puede insultar sin
  censura.»* y los mensajes nuevos llegan marcados (`soft: true`).

---

## 4. Comentarios bala sobre la cancha

Los mensajes de la grada cruzan el terreno de juego mientras el partido se juega (`public/estadio.js`,
`pushDanmaku()`; estilos en `public/estadio.css`).

- Recorrido **de derecha a izquierda** (`@keyframes estDanmaku`: `left: 100%` → `left: -100%`), 11 s.
  Solo cruzan la cancha los mensajes de la charla (`football:chat`); las reacciones rápidas se quedan
  en el registro de la grada. El elemento se elimina al terminar la animación, con un temporizador de
  seguridad de 16 s por si la pestaña queda en segundo plano.
- Cada comentario es un elemento independiente con **su propio botón ✕** (etiquetado con el nombre de
  quien lo escribió): se quita *ese* comentario, no todos.

### Control de cantidad: si la grada se acelera, se silencia sola la mayoría

Pedido: los comentarios deben deslizarse por la cancha, pero **la cantidad no puede tapar el partido**.
`pushDanmaku()` no pinta todo lo que llega: lo pasa por una cola corta y unos carriles.

| Límite | Valor | Qué evita |
| --- | --- | --- |
| `DANMAKU_LANES` | 5 carriles (uno por altura) | Dos comentarios nunca comparten altura: la animación solo mueve `left`, así que el carril se conserva todo el trayecto |
| `DANMAKU_MAX` | 5 en pantalla (uno por carril) | Una nube de comentarios sobre la jugada |
| `DANMAKU_MIN_GAP` | 900 ms entre salidas | Ráfagas ilegibles |
| `DANMAKU_QUEUE_MAX` | 3 en espera | Colas infinitas: lo que no cabe **se silencia al momento** |
| `DANMAKU_QUEUE_TTL` | 6 s de espera máxima | Comentarios viejos que llegan cuando ya cambió la jugada |
| `DANMAKU_LIFETIME` | 16 s | Que un comentario se quede pegado si la pestaña se va a segundo plano |

Consecuencia práctica: si entran 15 mensajes de golpe, **cruzan 4** y los otros 11 se descartan de la
cancha (siguen, todos, en el registro accesible de la grada). Un carril se libera cuando su comentario
termina de cruzar (`getAnimations()`; si el navegador no lo soporta, 11 s por reloj). El contador de
omitidos se anuncia por `role="status"` (*«11 comentarios omitidos: la grada iba demasiado rápido»*),
de modo que el silencio no es silencioso: se explica. Al cambiar de partido la cola se vacía y la
cancha no arrastra comentarios del partido anterior.

Con `prefers-reduced-motion` no hay deslizamiento: los comentarios se apilan como lista breve y **solo
se ven los tres más recientes** (el resto se oculta igual que en el modo animado).

### Silenciar la grada (interruptor global)

Pedido: además del ✕ por comentario, un botón para que cualquier usuario **silencie** los comentarios
bala de una vez. Está en la cabecera del panel *Reacciones y charla*, junto a las reacciones:
**«Silenciar grada» / «Activar grada»** (`#est-danmaku-mute`, `aria-pressed`, `aria-controls="est-danmaku"`).

- Al silenciar se **vacía la capa** y se oculta; los mensajes que sigan llegando **no** cruzan la
  cancha, pero **sí** se apuntan en el registro accesible de la grada: no se pierde la conversación.
- La preferencia se guarda en `localStorage` (`montecristo-danmaku-muted = 'off'`) y sobrevive a
  recargar la página; al arrancar con la grada silenciada se avisa una vez por lector de pantalla.
- Al reactivar **no se rellena** con lo que llegó durante el silencio: la cancha se repuebla con los
  mensajes nuevos.
- Un aviso `role="status"` oculto visualmente (`#est-danmaku-note`, `.est-sr-only`) anuncia el cambio.

**Accesibilidad**: la capa ya **no** es `aria-hidden` —antes lo era y eso dejaba el botón ✕ fuera del
alcance de los lectores de pantalla—. Ahora la capa es un `role="group"` etiquetado
(*«Comentarios de la grada sobre la cancha»*) y cada ✕ se anuncia con el nombre de quien escribió;
el texto no se duplica como texto navegable de la capa, porque ya está en el `role="log"` de la grada.

**Pruebas** (`tests/football-stadium-ui.test.js`): «la charla de la grada cruza la cancha como
comentario bala, de derecha a izquierda», «si la grada se acelera, solo cruzan unos pocos comentarios y
el resto se silencia», «un comentario que esperó demasiado ya no sale cuando la cancha se libera»,
««Silenciar grada» apaga los comentarios bala, los recuerda y se puede reactivar» y «el silencio de la
grada sobrevive a recargar la página».

---

## 5. La ceremonia ocurre aunque el servidor estuviera apagado el día 1

**Pedido:** si el servidor está apagado el día 1 (apertura del ciclo del Balón de Oro), hoy el ciclo se
cancelaba y se reembolsaban las predicciones. La ceremonia debe celebrarse igualmente.

**Antes** (`lib/football/ballon-dor-market.js`): cualquier barrido con el evento en `scheduled` y el día
local distinto de 1 llamaba a `_cancel(..., 'apertura_no_realizada_dia_1')`.

**Ahora**:

1. Si la temporada es de un mes futuro (`currentMonth < seasonMonth`), no se hace nada: se espera.
2. Si falta la J1 completa (8 partidos), se cancela con `calendario_invalido` (es un calendario roto,
   no un servidor apagado).
3. En cualquier otro caso el ciclo **se abre tarde**: `scheduled → active` con el log
   `football_ballon_dor_opened_late` (`lateDays`, `lastCompletedJornada`) y se publican las cuotas.
4. La misma pasada continúa hacia el bloqueo (`locked` al completarse la J20) y hacia la ceremonia, así
   que un servidor que vuelve **después** de la J30 resuelve el premio en ese mismo barrido en vez de
   quedarse esperando al siguiente.

El motivo `apertura_no_realizada_dia_1` queda retirado (solo aparece en eventos históricos ya
cancellados). Los demás motivos de cancelación siguen intactos: temporada truncada, temporada no
cerrada antes del reset y desempate sin resolver.

Pruebas: `tests/football-ballon-dor-market.test.js` — «si el proceso no llega el día 1, el ciclo se abre
tarde en vez de cancelarse» y «un servidor apagado varios días no impide la ceremonia: se resuelve en la
misma pasada».

---

## 6. Resumen de archivos

| Archivo | Cambio |
| --- | --- |
| `lib/football/fixtures.js` | Estelar 20:00/21:00 (destacado 21:00); `matchRealMs()` exportado |
| `lib/football/stands.js` | Módulo de moderación opt-in (votación, censura dura, limpieza de texto) |
| `lib/football/sockets.js` | `countdowns` en el lobby, `stands` en el estado del partido, eventos de votación, chat con `soft` |
| `lib/football/ballon-dor-market.js` | Apertura tardía del ciclo en vez de cancelación |
| `public/estadio.html` | Relojes DD:HH:MM:SS, capa de comentarios bala (ya accesible), botón «Silenciar grada», franja de votación |
| `public/estadio.js` | `tickSeasonCountdowns()`, `pushDanmaku()` con cola y carriles (`drainDanmaku()`), `setDanmakuMuted()` / `renderDanmakuMute()`, `renderStands()` y cableado de sockets |
| `public/estadio.css` | Estilos de relojes, comentarios bala, interruptor de silencio (`.est-crowd-mute`, `.est-sr-only`) y votación |
| `tests/football-stands.test.js` | 9 pruebas del módulo de grada |
| `tests/football-stadium-ui.test.js` | 5 pruebas de los comentarios bala, el control de cantidad y el botón de silencio |
| `tests/football-fixtures.test.js` | Invariante del muro de las 22:00 + `matchRealMs` |
| `tests/football-ballon-dor-market.test.js` | Apertura tardía y ceremonia con el servidor apagado |

---

## 7. Partido de prueba para la vista previa

El store de fútbol nace vacío y la parrilla es determinista a partir de la fecha, así que un entorno
recién creado puede no tener **ningún partido en juego** donde probar la grada, el «Silenciar grada» o
los comentarios bala. `scripts/estadio-partido-demo.js` (`npm run football:demo-match`) escribe ese
partido de prueba **sin tocar el calendario oficial ni el motor**:

```bash
node scripts/estadio-partido-demo.js              # kickoff en 2 minutos
node scripts/estadio-partido-demo.js --in 5       # kickoff en 5 minutos
node scripts/estadio-partido-demo.js --status=live --elapsed 2   # ya en juego
node scripts/estadio-partido-demo.js --remove     # quitar el partido de demo
```

- Crea un partido `scheduled` marcado `demo: true`, con `id` `m_demo_<AAAAMM>_<día>` y dos clubes de la
  temporada en curso. **No** entra en ninguna jornada (`jornada: 0`), así que no altera la tabla, el
  Balón de Oro ni la quiniela.
- El barrido de kickoff del scheduler lo arranca solo al llegar su hora, igual que un partido real: a
  partir de ahí la ficha, la grada y los comentarios bala se comportan igual que con un partido de
  parrilla.
- Es idempotente: reejecutarlo reemplaza el partido de demo del día; `--remove` lo elimina.
- **Ejecutar con el servidor parado** (o reiniciarlo después): el servidor mantiene el store en
  memoria y al guardar pisaría el archivo. Lo mismo vale para el reloj: si la fecha del sandbox cae
  fuera del mes de la temporada (p. ej. ya es noviembre), arranca el servidor con un reloj desplazado
  (`NODE_OPTIONS=--require=./reloj-demo.cjs`) para que «hoy» siga dentro de la temporada que quieres
  probar.

Flujo completo usado en la vista previa: parar el servidor → `football:demo-match --in 2` → arrancar el
servidor → esperar el kickoff → abrir `/estadio`, elegir el partido y escribir en la grada. Cada mensaje
se desliza por la cancha de derecha a izquierda; con una ráfaga, solo cruzan unos pocos y el aviso de
omitidos aparece en la grada.
