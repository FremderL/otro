# Plan de Diseño Móvil — MonteCristo Social Casino

## Estado actual

MonteCristo es un casino social **exclusivo para escritorio** con un ancho mínimo de **1024 px**. En pantallas más pequeñas se muestra una pantalla de bloqueo (`.desktop-gate`) que invita a volver desde una computadora. No existe ningún `@media` query adaptativo real: los pocos que hay en `estadio.css` (680 px, 960 px) solo reorganizan columnas a modo tablet y no están pensados para celulares.

### Archivos que conforman la interfaz

| Archivo | Líneas | Rol |
|---------|-------:|-----|
| `public/styles.css` | 2 284 | Lobby, mesa de juego, ruleta, modales, perfil |
| `public/app.js` | 5 082 | Lógica de cliente del lobby y todas las mesas |
| `public/index.html` | 891 | Estructura del lobby y mesa |
| `public/estadio.css` | 2 681 | Estadio completo |
| `public/estadio.js` | 7 658 | Lógica del estadio |
| `public/estadio.html` | 852 | Estructura del estadio |
| `public/loteria.css` | 459 | Lotería mexicana |
| `public/loteria.js` | 632 | Lógica de lotería |
| `public/loteria.html` | 155 | Estructura de lotería |
| `public/gate.js` | 14 | Bloqueo de escritorio |
| `public/admin.css/html/js` | — | Panel de administración |

---

## Fases del plan

### Fase 0 — Fundación y variables ✅ COMPLETADA

**Objetivo:** sentar las bases CSS y eliminar la puerta de escritorio sin romper el diseño actual.

| # | Tarea | Archivos | Estado |
|---|-------|----------|--------|
| 0.1 | **Quitar el `min-width: 1024px` del `body`** dentro de un nuevo media query, sin tocar el valor de escritorio | `mobile.css` | ✅ |
| 0.2 | **Reemplazar la puerta de escritorio** por una experiencia móvil real | `gate.js`, `mobile.css` | ✅ |
| 0.3 | **Definir breakpoints oficiales** | `mobile.css` | ✅ |
| 0.4 | **Crear `public/mobile.css`** | nuevo archivo | ✅ |
| 0.5 | **Crear `public/mobile.js`** | nuevo archivo | ✅ |
| 0.6 | **Meta viewport** correcto en todos los HTML | `index.html`, `estadio.html`, `loteria.html` | ✅ |
| 0.7 | **Soporte `safe-area-inset`** para iPhone con notch | `mobile.css` | ✅ |

---

### Fase 1 — Lobby (`index.html` + `styles.css`) ✅ COMPLETADA

**Objetivo:** el lobby es la entrada; debe sentirse nativo en un celular de 375 px sin perder identidad visual.

#### 1.1 Barra de navegación superior
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.nav` con logo + links + acciones en fila | Logo centrado, hamburger menu (☰) que despliega un drawer lateral con las secciones (Juegos, Salas, Ranking, Comunidad, Perfil). |
| `.nav-actions` con varios botones | Solo el botón de perfil visible; el resto dentro del drawer. |
| `.seasonal-theme-pill` | Dentro del drawer, debajo del nombre. |

#### 1.2 Hero principal
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.hero-content` con `grid-template-columns: 1.1fr .9fr` (texto + HUD) | Una sola columna: texto arriba, HUD simplificado abajo. |
| `.hero-actions` (Crear sala + Entrar con código) lado a lado | Dos botones full-width apilados. |
| `.hero-hud` (tarjetas decorativas de sala en curso) | Simplificar a una sola tarjeta resumen; ocultar avatares apilados y barra de progreso. |
| `.hero-proof` (testimoniales) | Ocultar o mover al final del lobby. |
| `.hero-live-link` (explorar salas abiertas) | Mantener como botón destacado. |

#### 1.3 Banner del Estadio
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.estadio-banner` con feature lateral | Layout vertical: copy arriba, CTA full-width abajo. |

#### 1.4 Grid de juegos (`.game-grid`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `grid-template-columns: 1fr 1fr` | **Una sola columna** en móvil (< 640 px), **dos columnas** en tablet (640–900 px). |
| Tarjetas con imagen, descripción, meta y acción | Compactar: ocultar descripción larga, mostrar solo nombre, jugadores y botón. |

#### 1.5 Salas abiertas (`.live-rooms`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `grid-template-columns: repeat(3, 1fr)` | **Una columna** con tarjetas horizontales (info + botón unirse). |
| `.room-occupancy` con avatares apilados | Mantener pero más pequeños. |

#### 1.6 Sección «Cómo jugar» (`.how-section`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Dos columnas con texto + pasos | Una sola columna, pasos en carrusel horizontal deslizable. |

#### 1.7 Chat del lobby (`.lobby-chat-widget`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Burbuja flotante esquina inferior derecha con panel lateral | **Bottom sheet** que sube desde abajo (swipe up para abrir, swipe down para cerrar). Teclado del celular no debe tapar el input. |

#### 1.8 Widget de invitaciones (`.invite-inbox`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Notificaciones flotantes esquina superior derecha | Stack vertical en la parte superior, dismiss con swipe lateral. |

#### 1.9 Efectos estacionales (`.seasonal-effects`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Partículas y adornos sobre toda la pantalla | Reducir intensidad al 50% y densidad al 30%; respetar `prefers-reduced-motion`. |

#### 1.10 Footer
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Links en fila | En columna, con separadores. |

---

### Fase 2 — Mesa de juego (`.room-app` en `index.html`) ✅ COMPLETADA

**Esta es la pantalla más crítica y compleja.** El layout actual es `grid-template-columns: 286px 1fr` (sidebar + escenario de juego).

#### 2.1 Estructura general
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Sidebar izquierda fija de 286 px con chat, jugadores y ranking | **Eliminar la sidebar como panel fijo.** Convertirla en un **drawer deslizable desde la izquierda** (hamburger button visible solo en mesa). |
| Escenario central con mesa + asientos + panel de acciones | Ocupa el **100% del viewport**. |

#### 2.2 Mesa de casino (`.casino-table`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Mesa ovalada con tamaño fijo (ancho 82% / alto 370 px) | **Redimensionar dinámicamente** al viewport: `width: 95vw; height: min(50vh, 300px)`. La mesa se encoje pero mantiene proporción oval. |
| Mesa de póker con borde de madera y tapete verde | Conservar estilo, reducir padding y bordes. |

#### 2.3 Asientos (`.seats-layer` + `.table-seat`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| 6 asientos posicionados con porcentajes absolutos (`.seat-0` a `.seat-5`) alrededor de la mesa | **Recalcular posiciones** para mesa compacta. Los asientos se pegan más al borde de la mesa. En móvil, se muestran como **chips compactos** (avatar + nombre + saldo en una línea, ~110 px de ancho en lugar de 150 px). |
| Cartas del asiento (`.seat-cards`) 34×47 px | Reducir a 26×36 px. |
| Fichas de apuesta (`.seat-bet`) | Mantener, reducir fuente. |
| `.dealer-button` | Más pequeño (16 px). |
| `.seat-status` (etiqueta de estado) | Solo visible en turno activo. |

#### 2.4 Cartas propias y comunitarias
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.play-card` estándar 55×78 px | **40×56 px** en móvil. |
| `.community-cards` centradas sobre la mesa | Se mantienen centradas pero más juntas (`gap: 2px`). |
| Cartas boca abajo con patrón diagonal | Conservar estilo. |

#### 2.5 Panel de acciones (`.action-panel`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Flotante centrado sobre la mesa, ancho 810 px | **Barra fija pegada al fondo** de la pantalla (sticky bottom), full-width, con padding de safe-area. |
| Botones de acción (Fold/Check/Call/Raise en póker; Hit/Stand/Double en blackjack) | Botones más grandes y táctiles (min-height: 48 px para dedo). Layout horizontal con scroll si hay muchos. |
| `.raise-box` con input numérico | Input más grande, teclado numérico del celular. |
| `.bet-options` (fichas rápidas 10/25/50/100) | Fichas como botones circulares táctiles de 44×44 px mínimo. |
| `.turn-clock` (reloj de turno) | Se mueve a la **esquina superior derecha** como mini-widget. |

#### 2.6 Chat de la sala
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Integrado en la sidebar (`.chat-section`) | **Bottom sheet deslizable** con botón 💬 visible en todo momento. Al abrir, ocupa 60% de la pantalla; al cerrar, la mesa vuelve a pantalla completa. |
| Input de chat con botón enviar | Full-width, teclado optimizado, botón enviar visible. |
| Mensajes rápidos y reacciones | Se mantienen como chips debajo del input. |

#### 2.7 Lista de jugadores / Ranking
| Elemento actual | Cambio móvil |
|----------------|--------------|
| En la sidebar (`.players-list`) | Se mueve al **drawer lateral** junto con el chat. También accesible con un botón de 👥 que abre un bottom sheet con la clasificación. |

#### 2.8 Panel de bots
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.bot-controls` posicionado sobre la mesa | Se mueve a un **modal de pantalla completa** accesible desde el hamburger menu. |

#### 2.9 Ruleta Nova
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.roulette-felt` con `grid-template-columns: 30px repeat(12, 28px) 34px` (ancho fijo ~430 px) | **Paño redimensionable**: `transform: scale()` para encajar en viewport, o vista alternativa con botones de apuesta por categorías (rojo/negro, par/impar, docenas) en vez del paño completo. |
| Rueda animada en canvas | Canvas redimensionable, `width: min(85vw, 350px)`. |
| Historial de números | Chips compactos en fila horizontal con scroll. |

#### 2.10 Juegos rápidos (Dados, Cara o Cruz, Fortuna, Tragamonedas)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.quick-game-grid` con 4 columnas | **Grid 2×2** en móvil. |
| Canvas de la rueda de la fortuna | Reducir a `min(80vw, 320px)`. |
| Tragamonedas con 3 rodillos | Rodillos más estrechos, símbolos más pequeños. |
| `.chip-button` (fichas de apuesta) | Mínimo 48×48 px para toque cómodo. |

#### 2.11 Perfil y modales
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Modales centrados con overlay | **Bottom sheet** con drag handle en la parte superior. |
| `.profile-stats` con 4 columnas | Grid 2×2. |
| `.progress-columns` con 2 columnas | Una sola columna. |
| Formulario de crear sala (`.segmented`) | Botones apilados verticalmente. |
| Gráfica de saldo (canvas) | Ancho completo, alto reducido. |

---

### Fase 3 — Estadio (`estadio.html` + `estadio.css`) ✅ COMPLETADA

**Objetivo:** el estadio tiene un layout de **3 columnas** (`270px + 1fr + 320px`) que es el más ancho de todo el proyecto.

#### 3.1 Estructura general
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.estadio-shell` con 3 columnas | **Una sola columna** con **barra de navegación inferior**: `⚽ Partido` · `📊 Tabla` · `🎯 Apuestas` · `👤 Zona`. En el flujo queda solo la columna central; Tabla, Apuestas y Zona abren **vistas propias a pantalla completa**. |
| `.est-col-left` (partidos + posiciones) | Deja la columna: la jornada y las posiciones viven en la **vista Tabla** (botón `📊`). |
| `.est-col-center` (cancha + narración + resaltados) | Es el contenido de la vista «Partido». |
| `.est-col-right` (apuestas + mis apuestas) | Deja la columna: mercados y apuestas abiertas viven en la **vista Apuestas** (botón `🎯`). |

#### 3.1b Vistas propias (Tabla y Apuestas) ✅ COMPLETADA
Igual que la Zona de afición, ninguna de las dos ocupa espacio dentro de las columnas: se abren a pantalla completa y la barra inferior sigue visible para cambiar de vista.

| Vista | Contenido | Acceso |
|-------|-----------|--------|
| **Tabla** (`#est-mobile-table`) | Panel «Jornada de hoy» (cuentas regresivas + partidos) y panel «Posiciones». | Botón `📊 Tabla` |
| **Apuestas** (`#est-mobile-bets`) | Sub-pestañas **Apostar** (selector del partido + mercados + boleto) y **Mis apuestas** (abiertas + historial y pagos). | Botón `🎯 Apuestas` |

- Los paneles son **los mismos nodos** del Estadio (`#est-lobby-panel`, `#est-standings-panel`, `#est-bet-panel`, `#est-mybets-panel`): `mobile.js` los traslada a la vista y los devuelve a su columna al volver a escritorio, así que conservan ids, listeners y datos en vivo.
- En **Apostar** hay un selector de partido propio (`#est-mobile-match-picker-list`), alimentado por la misma jornada; al tocar un partido se cargan sus cuotas sin salir de la vista.
- Ambas vistas bloquean el scroll del fondo, atrapan el foco, cierran con `Esc` y con su botón **Cerrar**. Solo puede haber una abierta.

#### 3.2 Barra de navegación del estadio
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.estadio-nav` con tag, chips, historial, navegación | Compactar: logo + chips + hamburger con las opciones secundarias. |
| `.est-nav-ledger` (historial de apuestas) | Vive en la vista Apuestas › **Mis apuestas** («Historial y pagos»). |
| Cuentas regresivas | Se mueven a un **expandible** debajo de la nav (tap para ver). |

#### 3.3 Panel de partidos (`.est-match-list`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Lista vertical con equipos y hora | Mantener como lista, tarjetas más compactas. |
| Countdown por partido | Badge compacto. |

#### 3.4 Cancha / Pitch (`.est-pitch`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Canvas `1050×680` con render de cancha | **Canvas responsivo** que se ajusta al ancho: `width: 100vw; height: auto`. Las formaciones y el balón se reescalan. |
| Marcador (`.est-score`) sobre la cancha | Se mantiene arriba, centrado, más compacto. |
| Comentarios bala de la grada | **Se desactivan en móvil** o se reducen a 1 carril (en escritorio son varios). |
| Narración textual | Panel colapsable debajo de la cancha. |

#### 3.5 Panel de apuestas (`.est-bet-panel`)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Mercados en lista con cuotas lado a lado | **Un mercado por fila**, cuotas como botones grandes (min 48 px de alto). |
| `.est-bet-slip` (boleto de apuesta) | Dentro de la vista **Apuestas › Apostar**, debajo de los mercados; al abrirse se lleva a la vista. |
| `.est-mybets-panel` (apuestas abiertas) | Vista **Apuestas › Mis apuestas**: cards compactas con cash-out e historial. |

#### 3.6 Grada / Chat del estadio
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Chat integrado en la columna derecha | **Bottom sheet** o tab dedicado. |
| Botón «Silenciar grada» | Visible en la barra superior del tab. |
| Votación de moderación (`.est-stands-vote`) | Inline en el chat, botones grandes. |

#### 3.7 Zona de afición (Hub, Fantasy, Club)
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.est-hub` modal con sidebar de navegación | **Pantalla completa** con tabs internos. |
| `.est-fantasy-layout` con columna lateral | Una sola columna, jugadores en grid 2×2. |
| `.est-club-dossier` | Cards apiladas verticalmente. |

#### 3.8 Mercado de traspasos y noticias
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Grid de noticias con feature grande | Una sola columna, feature como card horizontal. |
| `.est-transfer-list` | Cards verticales. |

#### 3.9 Balón de Oro
| Elemento actual | Cambio móvil |
|----------------|--------------|
| Mercado con retratos grandes | Retratos más pequeños, grid 2 columnas. |
| Ceremonia (canvas + audio) | Canvas full-width, controles más grandes. |

#### 3.10 Studio de medios
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.est-studio-grid-2/3` con múltiples paneles | Paneles apilados verticalmente, previsualizaciones más pequeñas. |

---

### Fase 4 — Lotería mexicana (`loteria.html` + `loteria.css`) ✅ COMPLETADA

| Elemento actual | Cambio móvil |
|----------------|--------------|
| Cartón 4×4 con cartas grandes | Cartón ocupa **todo el ancho**, cartas de ~70×70 px. |
| Panel lateral con últimas cartas cantadas | **Fila horizontal** sobre el cartón con scroll. |
| Cuenta atrás e inscripción | Badge fijo en la parte superior. |
| Resultado y celebración | Overlay full-screen. |

---

### Fase 5 — Componentes transversales ✅ COMPLETADA

#### 5.1 Modales → Bottom Sheets
Todos los modales del sistema se convierten en bottom sheets en móvil:
- Crear sala
- Perfil propio y ajeno (`.table-profile`)
- Invitaciones de amistades
- Comunidad (búsqueda, clubes)
- Panel de bots
- Pasaporte y cosméticos
- Colección de cartas (álbum)
- Términos y condiciones

#### 5.2 Toasts
| Elemento actual | Cambio móvil |
|----------------|--------------|
| `.toast-stack` esquina superior derecha, ancho 350 px | Stack **centrado en la parte superior**, ancho `calc(100vw - 32px)`, dismiss con swipe. |

#### 5.3 Teclado virtual
| Problema | Solución |
|----------|----------|
| El teclado del celular tapa inputs | Usar `visualViewport` API para ajustar el layout cuando aparece el teclado. Los bottom sheets se encogen automáticamente. |

#### 5.4 Gestos táctiles
| Gesto | Acción |
|-------|--------|
| Swipe down en bottom sheet | Cerrar |
| Swipe up en burbuja de chat | Abrir |
| Swipe lateral en toast | Dismiss |
| Pinch en canvas de cancha | Zoom (opcional) |
| Long-press en asiento | Ver ficha del jugador |
| Double-tap en mesa | Zoom a cartas propias |

#### 5.5 Tipografía
| Contexto | Escritorio | Móvil |
|----------|-----------|-------|
| Títulos hero | 42 px | 28 px |
| Títulos de panel | 16–19 px | 14–16 px |
| Texto base | 11–12 px | 13–14 px (mejor legibilidad) |
| Labels / meta | 8.5–10 px | 10–11 px |
| Botones | 9.5–12 px | 13–14 px |

#### 5.6 Objetivos táctiles
Todos los elementos interactivos deben tener un **área mínima de toque de 44×44 px** (estándar Apple/Google):
- Botones de acción del juego
- Fichas de apuesta
- Avatares y asientos
- Links de navegación
- Controles del canvas

---

### Fase 6 — Panel de administración (`admin.html`)

| Elemento actual | Cambio móvil |
|----------------|--------------|
| Panel con tablas de datos y formularios | **No es prioridad para móvil.** Se mantiene la puerta de escritorio para admin. Solo se adapta la lectura básica: tablas con scroll horizontal, formularios en columna. |

---

## Orden de ejecución sugerido

```
Fase 0  →  Fundación CSS y eliminar gate          (2–3 días)
Fase 1  →  Lobby responsive                        (3–4 días)
Fase 5.1→  Modales → bottom sheets (transversal)   (2 días)
Fase 2  →  Mesa de juego responsive                (5–7 días) ← más compleja
Fase 3  →  Estadio responsive                      (4–5 días)
Fase 4  →  Lotería responsive                      (1–2 días)
Fase 5  →  Gestos, teclado, toasts, tipografía     (2–3 días)
Fase 6  →  Admin básico (si alcanza)               (1 día)
```

**Total estimado: 20–27 días de desarrollo**

---

## Principios de diseño móvil

1. **La mesa es lo primero.** En la mesa de juego, nada compite con la mesa y las acciones. El chat, los jugadores y el ranking se mueven a drawers/sheets.
2. **Un foco por pantalla.** En el estadio, el usuario ve una pestaña a la vez: partidos, tabla, apuestas o grada.
3. **Nada de scroll horizontal.** Ningún elemento se sale del viewport; si hay overflow, se usa scroll vertical o carruseles.
4. **Bottom sheets > modales.** Los bottom sheets se sienten nativos y dejan ver el contexto detrás.
5. **Botones táctiles grandes.** Mínimo 44×44 px con separación de al menos 8 px entre ellos.
6. **Canvas responsivos.** Todos los canvas (mesa, cancha, ruleta, fortuna) se reescalan al viewport.
7. **Conservar la identidad.** Grafito, verde menta y dorado se mantienen. Las fuentes y la estética futurista no cambian, solo se adaptan.
8. **No romper escritorio.** Todo el CSS móvil vive en `mobile.css` con `@media (max-width: 900px)`. El escritorio no se toca.
9. **Progresivo.** Si `mobile.css` no carga (o el navegador no soporta media queries), la experiencia de escritorio se mantiene intacta.
10. **Accesibilidad.** Respetar `prefers-reduced-motion`, mantener `aria-live`, foco visible y navegación por teclado (cuando haya teclado físico).

---

## Resumen visual de cambios por zona

```
┌─────────────────────────────────────────────────────────────┐
│                    ESCRITORIO (≥ 1024 px)                    │
│                                                             │
│  Lobby:    [Nav ──────────────────────────────────────]     │
│            [Hero 2col] [Games 2col] [Rooms 3col]            │
│            [How 2col]  [Footer ──────────────]              │
│                                                             │
│  Mesa:     [Sidebar 286px │ Game Stage ──────────]          │
│            [  Chat       │  [Mesa + Asientos]    ]          │
│            [  Jugadores  │  [Panel Acciones]     ]          │
│            [  Ranking    │                       ]          │
│                                                             │
│  Estadio:  [Left 270 │ Center ───────── │ Right 320]        │
│            [Partidos  │ Cancha + Narr.   │ Apuestas ]       │
│            [Tabla     │                  │ Boleto   ]       │
│            [Plantillas│                  │ Public.  ]       │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────────┐
│   MÓVIL (≤ 640 px)      │
│                          │
│  Lobby:                  │
│  [☰ Nav + Perfil]        │
│  [Hero 1col]             │
│  [Games 1col]            │
│  [Rooms 1col]            │
│  [How carrusel]          │
│  [💬 Bottom Sheet]       │
│                          │
│  Mesa:                   │
│  [☰ │ Mesa compacta]     │
│  [  │ + Asientos mini]   │
│  [──┴──────────────]     │
│  [Action Bar fixed]      │
│  [💬 Sheet] [👥 Sheet]   │
│                          │
│  Estadio:                │
│  [Partido: cancha+relato]│
│  [⚽│📊│🎯│👤 bottom nav]  │
│  📊 Tabla → vista propia │
│  🎯 Apuestas → vista     │
│    (selector + cuotas +  │
│     mis apuestas)        │
│                          │
│  Lotería:                │
│  [Cartón full width]     │
│  [Cantadas scroll horiz] │
│  [Badge countdown]       │
└──────────────────────────┘
```
