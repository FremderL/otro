# Estadio MonteCristo — Motor de fútbol, liga autónoma y apuestas dinámicas

**Documento de arquitectura · MonteCristo Social Casino**
Estado: **decisiones cerradas** (§23). Listo para arrancar la Fase A. No modifica código del casino.
Fecha: 2026-10-07 · Rama de trabajo: `arena/24a40519-otro`

> Todo lo descrito aquí opera con **fichas virtuales**. No hay dinero real, depósitos ni retiros,
> igual que el resto del casino. Las apuestas deportivas simuladas heredan el mismo aviso.

## Regla de nomenclatura (decisión B2)

| Capa | Vocabulario | Ejemplos |
| --- | --- | --- |
| **Marca** (lo que ve el jugador) | **Estadio MonteCristo** | nav «🏟 Estadio», ruta `/estadio`, `public/estadio.{html,js,css}`, `/api/estadio/*` |
| **Código** (lo que ve quien desarrolla) | **`football`** | `lib/football/*`, `lib/football-engine.js`, sockets `football:*`, env `FOOTBALL_*`, logs `football_*` |
| **Intacto** | `live` sigue siendo del lobby de salas | `#live-lobby`, `.live-section`, «Actualización en vivo» — **no se toca** |

Elegir «Estadio MonteCristo» en vez de «En Vivo» resuelve la colisión de raíz: la palabra «en vivo»
queda reservada para lo que ya significa en el sitio (las salas activas) y no hay que renombrar nada
existente. El estado `status: 'live'` de un partido y los `aria-live` se conservan porque describen
el partido, no la sección.

---

## 1. Resumen ejecutivo

Se agrega al casino una sección **«Estadio MonteCristo»**: una liga de fútbol ficticia de **16 clubes
y 30 jornadas** cuyos partidos **arrancan y se juegan solos**, sin necesidad de humanos conectados,
con **cancha 2D cenital en canvas**, **22 jugadores con nombre y atributos**, **dos comentaristas**
(narrador + analista) y un sistema de apuestas con **cuotas que se mueven solas** según el
rendimiento de los equipos, el dinero apostado y el estado del partido. Incluye **apuestas en vivo,
cash-out, combinadas y apuestas a futuro (campeón de liga)**, más un **flujo de apuestas simulado**
que mantiene vivas las cuotas cuando no hay personas conectadas (§11.6).

La decisión que sostiene todo el diseño:

> **El partido no se simula avanzando estado: se genera completo en el kickoff con un PRNG
> sembrado y se reproduce contra reloj de pared.** El estado visible en cualquier instante es
> `f(seed, now)`.

De esa única decisión se derivan las cuatro propiedades que pidiste:

| Requisito | Cómo lo resuelve el diseño |
| --- | --- |
| Los partidos solos inician y se juegan | Un scheduler derivado del calendario; no depende de sockets ni de cadenas de `setTimeout` |
| Partidos diarios que duren lo de una temporada | Liga de 30 jornadas mapeada 1:1 a los días del mes del casino (`CASINO_TIME_ZONE`) |
| Sistema propio de cuotas según rendimiento | Poisson desde ratings + peso del dinero + recálculo en vivo desde el estado revelado |
| Evitar errores por inactividad del sistema | Estado derivado, no acumulado: un barrido perdido se recupera solo en el siguiente (*catch-up*) |

Tamaño estimado: **~4.500–6.000 líneas nuevas** en 12–14 archivos, más ~400 líneas de integración
en `server.js`. Se entrega en 6 fases independientes y verificables.

---

## 2. Alcance y no-alcance

### En alcance
- Liga ficticia («Liga MonteCristo») con **16 clubes de nombre internacional neutro** (decisión B3),
  plantillas de 18 jugadores.
- Motor determinista de partido: 90 minutos simulados, goles, tarjetas, cambios, córners, xG.
- Reproducción en vivo por Socket.IO + render canvas 2D cenital en página propia `/estadio`.
- Comentario generado en servidor con dos voces, persistido en la línea de tiempo.
- Apuestas: pre-partido, en vivo, cash-out, combinadas (parlays) y futuros (campeón / top 4).
- Motor de cuotas con margen de casa, movimiento por responsabilidad y suspensión de mercados.
- **Flujo de apuestas simulado** (`lib/football/simulated-flow.js`): da volumen al peso del dinero
  para que las cuotas se muevan también cuando no hay personas conectadas. Invisible en la interfaz,
  etiquetado en logs (decisión D8, §11.6).
- Scheduler autónomo, watchdogs, reconciliación al arrancar y apagado limpio.
- Persistencia en archivo JSON o Postgres, con el mismo patrón de fábrica que los perfiles.
- Palancas administrativas: suspender partido, forzar liquidación, anular mercado.

### Fuera de alcance (deliberadamente)
- Nombres de clubes, ligas, escudos o jugadores reales. **Riesgo de marca registrado**; todo el
  universo es ficticio y original, igual que las imágenes del lobby actual.
- Multijugador en la cancha (nadie controla futbolistas): el partido es contenido autoritativo.
- Streaming de video o audio real. Los «comentaristas» son texto generado.
- Dinero real, retiros, conversión de fichas, *skins* apostables.
- Segunda instancia del proceso. Hoy Render corre **un solo servicio**; ver §14.4 y §22-R7.
- Mercado de «primer goleador» y de props de jugador: queda para una fase posterior (requiere
  calibrar la distribución de goleadores por separado del marcador).

---

## 3. Principio rector: simulación determinista pre-generada

### 3.1 El problema del enfoque obvio

La forma intuitiva —un `setInterval` que cada segundo mueve el balón, actualiza posiciones y decide
eventos— acumula estado en memoria. Ese estado es frágil exactamente de las maneras que ya te
quemaron en producción:

1. Si el proceso reinicia (Render hace deploy con SIGTERM en cada push), el partido se pierde o
   queda a medias con apuestas abiertas sin liquidar.
2. Si un barrido tarda más que su periodo, los `setTimeout` encadenados se solapan o se saltan: el
   marcador se desincroniza de forma silenciosa y no hay manera de detectarlo desde fuera.
3. Si el event loop se bloquea 30 s, el partido «vivió» 30 s de menos: los espectadores vieron un
   minuto 60 durante medio minuto real.
4. Cada error dentro del tick es una oportunidad de tumbar el proceso completo. Ya tienes la red de
   `uncaughtException` precisamente porque eso pasó con un `ReferenceError` y borró todas las mesas.

### 3.2 La solución

En el kickoff (o antes, en la creación del partido) el servidor genera **la línea de tiempo
completa** del partido con un generador pseudoaleatorio sembrado:

```
seed        = hash32(matchId + '|' + jornada + '|' + seasonMonth)
random      = mulberry32(seed)
timeline    = generateTimeline(home, away, ratings, random)   // ~120–220 eventos
```

Después, el único trabajo del servidor en tiempo real es **revelar** el prefijo de esa línea cuyo
minuto simulado ya pasó:

```
estadoActual(match, now) = aplicar(timeline[0..k])  donde  k = max{i : simTime(now) >= timeline[i].t}
```

Consecuencias, todas deseables:

- **Idempotencia**: correr el cálculo dos veces da el mismo resultado. Un barrido duplicado no
  corrompe nada; un barrido perdido no deja huecos.
- **Catch-up gratis**: si el sistema estuvo 90 s sin correr, el siguiente barrido revela 9 minutos
  de golpe. Los clientes reciben los eventos acumulados y se ponen al día. Nada se «pierde».
- **Reinicio transparente**: basta persistir `seed`, `kickoffAt` y el estado de liquidación. Al
  arrancar, el partido se reconstruye exactamente donde debe estar (§15.6).
- **Sin deriva de reloj**: el minuto del partido se deriva de `now - kickoffAt`, no de un contador
  incrementado. Nunca se desfasa del reloj de pared.
- **Privacidad del futuro**: al cliente solo se emite el prefijo revelado. Es la misma disciplina
  que ya aplicas con las cartas ajenas viajando como `XX` hasta el showdown.
- **Auditoría perfecta**: el partido completo es reproducible a partir del seed. Cualquier disputa
  («ese gol no contó», «la cuota cambió después del gol») se resuelve regenerando la línea.

### 3.3 Integridad: las cuotas deben salir del mismo modelo que genera el partido

Este es el punto más fácil de arruinar y el que da legitimidad al sistema:

> La probabilidad que se cobra en una cuota **debe ser la probabilidad real** de que el motor
> produzca ese resultado. Si el marcador se genera con un modelo y las cuotas se calculan con otro,
> el margen de casa declarado es falso y el juego está sesgado en una dirección que los jugadores
> terminan detectando.

Por eso el generador **sortea primero el marcador final desde la matriz de Poisson con corrección
Dixon-Coles** (§10.2) y luego reparte esos goles en minutos y goleadores. La matriz que fija el
precio es, literalmente, la distribución de la que se muestrea el partido.

Con el marcador pre-sorteado surge una duda razonable: en el minuto 70 el resultado *ya está
decidido*, así que ¿no es injusto cobrar cuotas «en vivo»? No, y conviene tenerlo escrito:

- El precio en vivo se calcula con **el modelo condicionado únicamente al estado público**
  (marcador, minuto, tarjetas, xG, ratings). Es exactamente el precio que publicaría un bookmaker
  que no conoce el futuro.
- El jugador paga precio justo por la información que tiene. Su EV por ficha apostada es
  `1 / (1 + margen)`, idéntico al pre-partido.
- Promediado sobre todos los futuros pre-generados (que se muestrearon del mismo modelo), la
  probabilidad pública converge a la frecuencia real. Es decir: **no hay fuga sistemática ni a favor
  de la casa ni del jugador, más allá del margen declarado**.
- Prueba obligatoria de calibración (§20-T9): simular 20.000 partidos y verificar que, para cada
  banda de cuota en vivo publicada, la frecuencia observada del resultado coincida con la probabilidad
  implícita dentro del intervalo de confianza. Si no coincide, el modelo en vivo está mal
  especificado y se corrige antes de abrir el mercado.

### 3.4 Lo que NO se pre-genera

- Las cuotas. Dependen del dinero apostado (peso del dinero) y del estado revelado, así que se
  calculan en el momento y se versionan.
- Los espectadores, el chat y las reacciones.
- La posición exacta de los 22 jugadores en cada frame: eso lo interpola el cliente (§8).

---

## 4. Arquitectura general

```
                       ┌───────────────────────────────────────────────┐
                       │              server.js (proceso único)        │
                       │                                               │
  ┌──────────────┐     │  ┌─────────────────────┐   ┌───────────────┐  │
  │ /estadio.html │◀────┼──│  FootballHTTP  (REST)   │   │  football:* socket│  │
  │  estadio.js   │     │  │  /api/estadio/*        │   │  handlers     │  │
  │  canvas 2D   │     │  └─────────┬───────────┘   └───────┬───────┘  │
  └──────────────┘     │            │                       │          │
        ▲              │            ▼                       ▼          │
        │  football:tick   │  ┌──────────────────────────────────────────┐ │
        │  football:event  │  │      FootballEngine (lib/football/*)         │ │
        │  football:odds   │  │                                          │ │
        └──────────────┼──│  scheduler ──▶ match-engine ──▶ odds     │ │
                       │  │      │            │             │        │ │
                       │  │      ▼            ▼             ▼        │ │
                       │  │  fixtures    commentary     betting      │ │
                       │  │      │            │             │        │ │
                       │  │      └────────────┴─────────────┘        │ │
                       │  │                   ▼                      │ │
                       │  │        football-store (JSON | PG)        │ │
                       │  └───────────────────┬──────────────────────┘ │
                       │                      │                        │
                       │        ┌─────────────┴──────────────┐         │
                       │        │  WATCHDOGS (setInterval)   │         │
                       │        │  kickoff · tick · settle   │         │
                       │        │  stuck · season-guard      │         │
                       │        └────────────────────────────┘         │
                       └───────────────────────────────────────────────┘
                                            │
                    reusa: profile-store · progression (credit/recordWager/
                    recordOutcome) · rate-limit · idempotency · audit · terms
```

Reglas de la casa que se conservan:

- **El servidor es la única autoridad.** El cliente nunca decide minuto, marcador, cuota ni
  resultado. Solo renderiza e interpola.
- **Un error no puede tumbar el proceso.** Cada partido se procesa dentro de su propio `try/catch`
  con `logEvent`, igual que `scheduleRoomTask`.
- **Todo timer lleva `unref()`.** Igual que el resto del código.
- **Fichas solo por `lib/progression.js`.** Ningún módulo nuevo toca `profile.chips` directamente.
  *Corregido (§12.7, hallazgo 8):* esa regla **no describe el código real** — `server.js` mueve fichas
  con asignación directa en al menos cinco sitios (`:580`, `:954`, `:1282`, `:1571`, `:1593`), que es
  justo la convención con la que se pagan las rondas. La invariant real, y la que el Estadio adopta,
  es más débil y más útil: **toda mutación de fichas va acompañada de `profiles.touch(profile)`**, que
  es lo único que garantiza que se persista. `debit()` sigue viviendo en `lib/progression.js` junto a
  `credit()`; el pago de una apuesta replicará la convención de las rondas (asignación + `recordOutcome`).

---

## 5. Liga y calendario

### 5.1 Formato

- **16 clubes ficticios**, doble vuelta (ida y vuelta) → `16 × 15 = 240` partidos.
- **30 jornadas** de **8 enfrentamientos** cada una.
- Tabla de posiciones: puntos (3/1/0), diferencia de goles, goles a favor, goles en contra,
  forma de los últimos 5, racha. Desempate: diferencia de goles → goles a favor → resultado
  directo. **Si el empate es por el 1.º puesto** y persiste tras el resultado directo, se juega un
  **partido de desempate** con prórroga y tanda de penales si hace falta (§7.5, decisión A14) — el
  campeón se decide en cancha, no por sorteo. Para cualquier otro puesto (corte de `top4`/`top2`,
  podio menor), el último recurso sigue siendo el sorteo sembrado determinista con el seed de la
  temporada.
- Sin descenso real (la liga se reinicia cada mes), pero las dos últimas posiciones **penalizan el
  rating inicial de la temporada siguiente** y las dos primeras lo mejoran: da continuidad narrativa
  entre meses sin acumular complejidad.
- Al cierre de temporada se publica **campeón, podio y «Bota de Oro»** (máximo goleador), con el
  mismo tratamiento visual que el podio mensual de fichas ya existente.

### 5.2 Aritmética contra la temporada del casino

La temporada del casino es el **mes calendario en `America/Mexico_City`** y el día 1 reinicia todos
los saldos a 1000 fichas (`seasonSweep`, cada 5 min). La liga debe **cerrar antes** de ese reset.

```
diasDelMes        = daysInMonth(seasonMonth, CASINO_TIME_ZONE)      // 28..31
diasDisponibles   = diasDelMes - 1        // el último día queda reservado para cierre y liquidación
jornadas          = 30
dobles            = max(0, jornadas - diasDisponibles)              // días con 2 jornadas
```

| Mes | Días | Disponibles | Dobles necesarias | Resultado |
| --- | --- | --- | --- | --- |
| Enero / marzo / mayo / julio / agosto / octubre / diciembre | 31 | 30 | 0 | 1 jornada exacta por día ✅ |
| Abril / junio / septiembre / noviembre | 30 | 29 | 1 | Un día con doble jornada |
| Febrero | 28 | 27 | 3 | Tres días con doble jornada |
| Febrero bisiesto | 29 | 28 | 2 | Dos días con doble jornada |

Las dobles se reparten uniformemente (`cada floor(diasDisponibles / dobles) días`) para que no se
concentren al final del mes. El calendario se **genera una sola vez por temporada** con el seed
`hash(seasonMonth + 'liga')` y se persiste; si el calendario persistido no corresponde al mes en
curso, se regenera (misma filosofía de «reparación de calendario» que ya existe para temporadas).

**Regla dura de cierre**: a las `00:00` del último día del mes no puede quedar ningún partido en
curso ni ninguna apuesta sin liquidar. El `footballSeasonGuard` (§15.5) lo garantiza y **corre antes**
que el reset de fichas.

### 5.3 Parrilla diaria (bloques de transmisión)

Cada jornada se juega en **3 bloques**, todos con kickoff simultáneo dentro del bloque:

| Bloque | Hora (`America/Mexico_City`) | Partidos | Notas |
| --- | --- | --- | --- |
| Matutino | 13:00 | 3 | |
| Vespertino | 18:00 | 3 | |
| Estelar | 21:30 | 2 | Uno es el **partido destacado** (mejor suma de posiciones en tabla) |

En día de doble jornada, la segunda oleada arranca con **+35 min** de desfase (13:35 / 18:35 /
22:05). Como cada partido dura ~17 min reales (§5.4), nunca se solapan dos oleadas.

Máximo de partidos simultáneos: **3** (6 en día doble). El techo configurado del motor es 12, así
que hay margen para eventos especiales (copa de fin de semana, amistosos de pretemporada).

El partido destacado se muestra en grande en el encabezado de `/estadio` con marcador, reloj y
relato; los demás aparecen en una franja lateral de «otros partidos en vivo» con marcador compacto,
igual que hoy se listan las salas abiertas.

### 5.4 Duración real del partido

```
1 minuto simulado      = 10 s reales              → 90' = 900 s = 15:00
Intermedio             = 45 s reales              → +0:45
Tiempo agregado        = 1–4' sim por mitad       → +0:20 a +1:20
Duración total real    = 16:05 a 17:05            (92–98 min simulados)
```

Configurable con `FOOTBALL_SIM_SECONDS_PER_MINUTE`. A 10 s/min el partido se siente rápido pero
legible; a 6 s/min duraría 25 min y permitiría más apuestas en vivo, a costa de menos partidos por
día. Es la palanca de ritmo más importante del producto y conviene probarla con usuarios reales
antes de fijarla.

### 5.5 Clubes y plantillas

**Decisión B3: nombre internacional neutro.** Universo 100 % ficticio, sin sabor local marcado, para
que la liga se lea como continental y no dependa de un mercado. Los 16 clubes:

| # | Club | Corto | Ciudad | Estadio | Formación | Estilo |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Vantora FC | `VTR` | Vantora | Arena Boreal | 4-3-3 | possession |
| 2 | United Vanguard | `VNG` | Vanguard City | The Bulwark | 4-4-2 | pressing |
| 3 | Olympique Estevin | `EST` | Estevin | Stade d'Estevin | 4-2-3-1 | possession |
| 4 | Atlético Solaris | `SOL` | Solaris | Coliseo Helios | 4-3-3 | direct |
| 5 | Sporting Almar | `ALM` | Almara | Campo Almar | 4-4-2 | balanced |
| 6 | Dynamo Kelvar | `KLV` | Kelvar | Kelvar Park | 3-5-2 | pressing |
| 7 | CS Verdania | `VRD` | Verdania | Foro Verde | 4-2-3-1 | counter |
| 8 | Halcyon Bay FC | `HLC` | Halcyon Bay | The Lighthouse | 4-3-3 | counter |
| 9 | Athletic Ferrata | `FRR` | Ferrata | La Forja | 4-4-2 | direct |
| 10 | Royal Corvane | `CRV` | Corvane | Corona Arena | 4-2-3-1 | possession |
| 11 | SV Talbruck | `TLB` | Talbruck | Talbruck Stadion | 3-5-2 | balanced |
| 12 | Velmar Harbour FC | `VLM` | Velmar | The Dockyard | 4-4-2 | direct |
| 13 | Norvela Sporting | `NVL` | Norvela | Estadio Norvela | 4-3-3 | balanced |
| 14 | Ironvale FC | `IRN` | Ironvale | The Foundry | 4-4-2 | pressing |
| 15 | Peregrine Rovers | `PRG` | Peregrine | Rovers Park | 4-2-3-1 | counter |
| 16 | Puerto Ámbar | `AMB` | Ámbar | Estadio Ámbar | 4-3-3 | possession |

#### Validación de nombres (decisión B3, cerrada el 2026-10-07)

Se verificó cada candidato contra clubes reales. **Siete nombres propuestos originalmente fueron
rechazados** y reemplazados; los reemplazos se volvieron a verificar. Los 16 códigos cortos son
únicos entre sí.

**Rechazados por colisión real:**

| Propuesto | Colisión encontrada | Reemplazo |
| --- | --- | --- |
| FC Nordhavn | **F.C. Nordhavn**, club danés fundado en 2017 en Copenhague (DBU København Serie 2), club asociado del F.C. København | **Vantora FC** |
| Olympique Meridian | **Meridian VP FC** (Inglaterra, pirámide de la FA en Step 7, Kent County League, FA Charter Standard) y **Meridian FC** (Sussex Sunday League) | **Olympique Estevin** |
| Dynamo Kessel | **K.F.C. Kessel** (Bélgica, fundado en 1926) y **Kessel United** (Bélgica, 2019, con perfil en Transfermarkt) | **Dynamo Kelvar** |
| Royal Asteria | **Asteria Football Club** (Francia, fundado en 2017) y **Asteria Sport** (agencia de jugadores) | **Royal Corvane** |
| Aurora Sporting | **Aurora FC** (Guatemala, primera división, fundado en 1945, ocho títulos de liga) y **Aurora FC** (Canadá, League1 Ontario) | **Norvela Sporting** |
| Kelso Harbour FC | **Kelso United F.C.** (Escocia, 1935–2015) y su sucesor **Kelso United Thistle** | **Velmar Harbour FC** |
| Granite City FC | **Granite City FC** (EE. UU., USL League Two) — descartado antes de la tabla | **Ironvale FC** |

**Conservados con riesgo residual bajo y documentado:**

| Club | Hallazgo | Por qué se conserva |
| --- | --- | --- |
| Atlético Solaris | Un `Solaris FC` en Instagram con 986 seguidores | Sin liga, sin federación, sin marca. No es un club constituido |
| Halcyon Bay FC | `Halcyon` aparece como agencia deportiva y en otros rubros | Ningún club de fútbol con ese nombre |
| Velmar Harbour FC | Un `Velmar Football Club` en Instagram con 138 seguidores | Elegido a sabiendas: presencia nula, y se registra aquí para que sea auditable |
| Puerto Ámbar | `Club Ámbar` es un local nocturno en Santiago; `Ámbar` aparece como nombre de una futbolista | Ninguno es un club de fútbol homónimo |

**Limpios** (búsqueda sin resultados): United Vanguard, Sporting Almar, CS Verdania, Athletic
Ferrata, SV Talbruck, Ironvale FC, Peregrine Rovers, Vantora FC, Olympique Estevin, Dynamo Kelvar,
Royal Corvane, Norvela Sporting.

> **Límite del método.** Esto fue verificación por búsqueda web, no un estudio de marcas. Reduce el
> riesgo de forma sustancial —de hecho atrapó siete colisiones que a ojo habrían pasado— pero no es
> un dictamen legal. Si el producto llegara a comercializarse fuera del círculo de amigos, conviene
> una revisión de marcas sobre los 16 nombres definitivos. El riesgo R17 queda así mitigado, no
> eliminado.

Cada club:

```js
{
  id: 'vantora_fc', name: 'Vantora FC', short: 'NRD',
  city: 'Vantora', stadium: 'Arena Boreal', capacity: 41000,
  colors: { primary: '#1de9b6', secondary: '#1f2a30', kit: 'stripes' },
  tactics: { formation: '4-3-3', style: 'possession' },   // possession|counter|pressing|direct|balanced
  ratings: { elo: 1500, att: 1.00, def: 1.00, gk: 1.00 },
  form: [],                                              // últimos 5: 'W'|'D'|'L'
  squad: [ /* 18 jugadores */ ]
}
```

Paleta: los 16 colores primarios se reparten entre las familias de la identidad existente (verde
menta, grafito, dorado) más acentos diferenciables, garantizando que **cualquier pareja de clubes
tenga contraste suficiente** en el canvas a 1024×720. Se valida con ratio de contraste WCAG AA entre
los dos kits y contra el césped, no a ojo.

Jugador:

```js
{ id:'vtr_09', num:9, name:'Iker Valdés', pos:'ST',
  attrs:{ pac:74, sho:81, pas:68, def:34, gk:12, agr:66 },
  season:{ goals:0, assists:0, yellow:0, red:0, minutes:0 } }
```

Los atributos alimentan: probabilidad de ser el goleador de un gol generado, de dar la asistencia,
de recibir tarjeta (por `agr`), y el rendimiento de la formación en el render. Nombres generados con
un pool internacional coherente con el tono neutro de los clubes, sin repetir dentro de la liga y
verificados contra `displayNameIssue` / `nameHasProfanity` para que ninguna combinación aleatoria
produzca algo ofensivo.

Ratings iniciales: se siembran con dispersión controlada (`elo ∈ [1380, 1620]`, `att/def/gk ∈
[0.82, 1.18]`) y se **reinician cada temporada** junto con las fichas, arrastrando solo el ajuste
por campeón/colista (§5.1). Así la liga nunca se vuelve predecible de forma permanente.

Ratings iniciales: se siembran con dispersión controlada (`elo ∈ [1380, 1620]`, `att/def/gk ∈
[0.82, 1.18]`) y se **reinician cada temporada** junto con las fichas, arrastrando solo el ajuste
por campeón/colista (§5.1). Así la liga nunca se vuelve predecible de forma permanente.

---

## 6. Modelo de datos

### 6.1 Estados

**Partido** (`match.status`):

```
scheduled ──▶ live ──▶ halftime ──▶ live ──▶ finished ──▶ settled
    │                                              │
    └────────────────▶ postponed ◀─────────────────┘
                     (por watchdog o admin)
```

Solo el **partido de desempate** (§7.5, decisión A14) alarga el camino entre `live` y `finished` con
dos estados que ningún otro partido alcanza:

```
… live (90') ──▶ extra_time ──▶ shootout ──▶ finished ──▶ settled
                    │              │
              (2 × 15')      (si el 120' sigue empatado)
```

`extra_time` y `shootout` son no-terminales y solo existen si `ctx.esDesempate` y el marcador va
emparedado al 90' (y al 120' para la tanda). Un partido normal **nunca** entra en esos estados: el
empate es un resultado válido (`winner:'draw'`) y se liquida directo.

`postponed` es terminal y exige **reembolso automático** de todas las apuestas (§12.4). Nunca se
deja un partido en `live` sin progreso: el watchdog lo mueve a `finished` o `postponed` (§15.4).

**Apuesta** (`bet.status`):

```
pending ──▶ open ──┬──▶ won      (payout acreditado)
                   ├──▶ lost
                   ├──▶ void     (stake reembolsado)
                   └──▶ cashed   (cash-out acreditado)
```

Transición terminal **exactamente una vez**, protegida por clave única en el store (§12.3).

**Mercado** (`market.status`): `open · suspended · closed · settled · void`.

### 6.2 Partido

```js
{
  id: 'm_2026-10_j12_b3_1',
  seasonMonth: '2026-10', jornada: 12, block: 'estelar', featured: true,
  homeId: 'vantora_fc', awayId: 'united_vanguard',
  seed: 3727194411,
  scheduledKickoffAt: 1792000000000,
  actualKickoffAt: 1792000000123,
  status: 'live',
  halftimeMs: 45000,
  timeline: [ /* §7.2, ~120–220 eventos, inmutable tras generarse */ ],
  revealedIndex: 87,               // último evento ya emitido
  state: {                         // derivado; se puede recalcular desde timeline+now
    minute: 63.4, half: 2, stoppage: 0,
    score: { home: 2, away: 1 },
    cards: { home: [{playerId, type:'yellow', minute:31}], away: [] },
    subs: [], xG: { home: 1.84, away: 0.91 },
    possession: { home: 0.58, away: 0.42 },
    shots: { home: 9, away: 5 }, shotsOnTarget: { home: 5, away: 2 },
    corners: { home: 4, away: 1 }, formation: { home:'4-3-3', away:'4-4-2' },
    ball: { x: 0.62, y: 0.41, zone: 'final_third_home' },
    phase: 'attack_home',          // kickoff|build_up|attack|danger|set_piece|goal_celebration|halftime
                                   // +extra_time|shootout solo en el partido de desempate (§7.5)
    redCards: { home: 0, away: 1 }
  },
  suspended: false, suspendUntil: null,
  markets: { '1x2': {...}, 'ou25': {...}, 'cs': {...}, 'btts': {...}, 'dc': {...}, 'next_goal': {...} },
  exposure: { totalStaked: 18400, liability: { home: 9200, draw: 4100, away: 5100 }, maxLiability: 60000 },
  commentary: [ /* últimos 40 mensajes, anillo */ ],
  viewers: 23,
  lastTickAt: 1792003800000,
  settledAt: null,
  result: null                     // { home, away, winner:'home'|'draw'|'away' } al terminar
}
```

### 6.3 Apuesta

```js
{
  id: 'b_9f3c...',
  idempotencyKey: 'dev_tok:1792003800000:1x2:home:500',   // única en el store
  profileId: 'p_...', deviceToken: null,                   // nunca se expone al navegador
  matchId: 'm_2026-10_j12_b3_1',
  market: '1x2', selection: 'home',
  stake: 500, oddsAtPlacement: 2.35,
  placedAt: 1792003800000, minuteAtPlacement: 12,          // null si fue pre-partido
  inPlay: true,
  status: 'open',
  potentialPayout: 1175,
  cashoutAvailable: true,
  settledAt: null, payout: null,
  parlayId: null
}
```

Combinada:

```js
{
  id: 'pl_...',
  profileId: 'p_...',
  legs: [ { matchId, market, selection, oddsAtPlacement, status } ],  // máx. 6, partidos distintos
  combinedOdds: 11.28, stake: 300, potentialPayout: 3384,
  status: 'open',                  // open|won|lost|void|cashed
  payout: null
}
```

Futuro:

```js
{
  id: 'f_...', profileId: 'p_...', seasonMonth: '2026-10',
  market: 'outright_champion',     // outright_champion|top4|top2
  selection: 'vantora_fc', odds: 6.50, stake: 1000,
  placedAtJornada: 9, status: 'open', settledAt: null, payout: null
}
```

---

## 7. Motor de partido

### 7.1 Pipeline de generación

```
1. λ_home = leagueAvg · att_home · def_away · homeAdv
   λ_away = leagueAvg · att_away · def_home
2. Matriz de marcadores P(i,j) = Pois(i;λh)·Pois(j;λa)·τ_DC(i,j,λh,λa,ρ)   // 0..8 goles
3. SORTEAR marcador final (h,a) desde esa matriz  ← misma distribución que fija las cuotas
4. Repartir los goles en minutos con la curva empírica de minutos de gol
5. Asignar goleador/asistencia por peso de atributos y formación
6. Generar la trama de posesiones, tiros, córners, faltas y tarjetas coherente con xG objetivo
7. Derivar la posición del balón y la formación por posesión
8. Asociar comentario a cada evento relevante
9. Sellar la línea de tiempo (inmutable) y calcular stoppage por mitad
```

El paso 6 genera **tiros** cuyo `xG` suma aproximadamente el `xG` objetivo de cada equipo
(`xG_target ≈ λ ajustado`), de modo que las estadísticas que ve el espectador son coherentes con el
marcador: si el marcador dice 2-1 pero el xG dice 0.3 contra 3.8, el analista lo comenta y se siente
un partido real («el fútbol no entiende de merecimientos»).

### 7.2 Catálogo de eventos

Cada evento lleva su minuto simulado (float), posición de balón e instantánea de formación:

```js
{ i: 42, t: 31.4, type: 'yellow_card',
  team: 'home', playerId: 'apu_04',
  ball: { x: 0.44, y: 0.61 }, formation: { home: '4-3-3', away: '4-4-2' },
  importance: 3,
  commentary: [
    { voice: 'narrador', text: 'Amarilla para Iker Valdés. Llegó tarde y el árbitro no dudó.' },
    { voice: 'analista', text: 'Valdés queda condicionado: 59 minutos por delante con una amarilla.' }
  ] }
```

Tipos: `kickoff`, `pass_sequence`, `possession_change`, `shot`, `shot_on_target`, `goal`,
`goal_disallowed`, `big_chance`, `save`, `corner`, `foul`, `yellow_card`, `red_card`, `second_yellow`,
`penalty_awarded`, `penalty_scored`, `penalty_missed`, `substitution`, `injury`, `offside`,
`throw_in`, `goal_kick`, `halftime`, `second_half`, `stoppage_start`, `full_time`,
`formation_change`, `tactic_change`, `momentum_shift`. Solo en el partido de desempate (§7.5, decisión
A14): `extra_time_start`, `extra_time_end`, `shootout_kick` (`{team, anotó, lanzador, suddenDeath}`),
`shootout_end`.

Los de baja relevancia (`pass_sequence`, `throw_in`, `goal_kick`) se generan en densidad alta pero
se emiten al cliente **agrupados** en el tick positional; los de alta relevancia (`goal`, `red_card`,
`penalty_*`, `shootout_kick`, `halftime`, `full_time`) se emiten **de inmediato** con evento dedicado.

### 7.3 Pseudocódigo del generador

```js
function generateTimeline(home, away, ctx, random) {
  const lambdas = expectedGoals(home, away, ctx);            // { home, away }
  const matrix  = scoreMatrix(lambdas, ctx.rho);             // 9×9, suma 1
  const score   = sampleScore(matrix, random);               // ← coherente con las cuotas
  const events  = [];

  events.push(evt(0, 'kickoff', { team: 'home' }));

  const goals = spreadGoals(score, random);                  // [{team, minute}] con curva real
  const shotsPlan = planShots(lambdas, goals, random);       // tiros y xG coherentes
  const pensPlan  = planPenalties(score, goals, lambdas, random); // §7.4: re-etiqueta goles + xG 0.79
  const cardsPlan = planCards(home, away, ctx, random);      // ~4.1 amarillas, 0.09 rojas por partido
  const subsPlan  = planSubs(home, away, random);            // 3–5 cambios por equipo
  const possession = planPossession(home, away, ctx, random);// tramos de 20–90 s sim

  for (const block of possession) {
    events.push(...buildAttackSequence(block, shotsPlan, random));
  }
  mergeChronologically(events, goals, pensPlan, cardsPlan, subsPlan);
  attachCommentary(events, home, away, ctx, random);
  events.push(evt(45, 'halftime'), evt(90 + stoppage(2), 'full_time'));
  return seal(events, random);                               // índices + stoppage por mitad
}
```

`mulberry32` como PRNG sembrado, inyectado por parámetro siguiendo la convención que ya usa
`lib/quick-games.js` (`roll(game, random = Math.random)`). Eso hace el motor testeable con seeds
fijos y reproducible en los tests.

### 7.4 Penales (decisión A13)

El catálogo de §7.2 ya lista `penalty_awarded`, `penalty_scored` y `penalty_missed`, y §10.6 ya
suspende las cuotas cuando se señala uno, pero el generador de §7.3 **no los producía**: faltaba el
plan que los coloca. Sin él, los tres tipos de evento eran letra muerta y un partido de 180 eventos
nunca tenía un penal, que en el fútbol real aparece en ~1 de cada 4 partidos.

`planPenalties(score, goals, lambdas, random)` cierra ese hueco con tres números calibrados y una
regla de consistencia que protege R3:

```
FOOTBALL_PENALTY_RATE       = 0.25    // penales SEÑALADOS por partido (≈ 1 cada 4)
FOOTBALL_PENALTY_CONVERSION = 0.76    // tasa de conversión real (≈ 75-78 %)
FOOTBALL_PENALTY_XG         = 0.79    // xG de un penal (el tiro más caro del fútbol)
```

```
planPenalties(score, goals, lambdas, random):
  n = min(2, samplePoisson(FOOTBALL_PENALTY_RATE, random))   // 0, 1 o (raro) 2 por partido
  para cada penal:
    team = elegirEquipo(peso = xG_team + 0.10·localía, random)   // ataca más → gana más penales
    minuto = sortearConCurva(20..88, random)                     // no en el arranque ni en el 90
    convierte = (random() < FOOTBALL_PENALTY_CONVERSION)
    si convierte Y quedan goles sin etiquetar en score[team]:
       re-etiquetar UN gol de team como penalty_scored           // el gol YA estaba en el marcador
       xG[team] += FOOTBALL_PENALTY_XG - xG_del_tiro_reetiquetado
    si no:
       penalty_awarded + penalty_missed (atajado / desviado / al palo), SIN gol
       xG[team] += FOOTBALL_PENALTY_XG                           // «merecieron más»: xG > goles
```

**La regla que no se puede romper: un penal convertido re-etiqueta un gol ya sorteado, nunca añade
uno nuevo.** El marcador se muestrea primero de la matriz de Poisson con Dixon-Coles (§3.3, §7.1 paso
3) y esa matriz es, literalmente, la distribución que fija las cuotas. Si `planPenalties` sumara
goles por su cuenta, la distribución real de marcadores dejaría de coincidir con la que se cobró y el
margen declarado sería falso —que es justo R3. Re-etiquetar mantiene intacta la distribución de
goles totales: un penal anotado **es** uno de los goles de Poisson, solo que narrado desde el punto
penal. Corolario: un equipo con `score = 0` no puede tener un penal convertido (no hay gol que
re-etiquetar); si el dado dice «convierte», se degrada a `penalty_missed` (lo atajaron). Esto baja
ligeramente la conversión efectiva por debajo de 0.76, sesgo aceptable y medido en T41.

**Efectos aguas abajo, todos ya cableados:**
- **xG (§7.1 paso 6):** el penal suma `0.79` de xG al equipo, convertido o no. Un penal fallado es la
  forma más limpia de producir el «merecieron más» que el analista comenta (xG 2.1 contra 1 gol).
- **Cuotas en vivo (§10.6):** `penalty_awarded` ya dispara `suspended = true` hasta que se resuelve;
  un `penalty_scored` cambia el marcador y repricia todo el libro en vivo; un `penalty_missed`
  reanuda sin cambio de marcador.
- **Relato (§9):** los tres eventos llevan su línea de narrador + analista como cualquier evento de
  alta relevancia, y se emiten **de inmediato** (§7.2), no agrupados en el tick positional.

La tanda de penales que decide un desempate es **otra cosa** y vive en §7.5 (decisión A14): no es un
penal de partido, es una secuencia de muerte súbita al final de una prórroga.

### 7.5 Prórroga y tanda de penales — el partido de desempate (decisión A14)

**Cuándo existe.** Solo cuando el **1.º puesto** queda empatado tras agotar los desempates de tabla
de §5.1 (diferencia de goles → goles a favor → resultado directo). Es un caso raro —en una liga de
240 partidos el empate en la cima con todos los desempates iguales ocurre en < 1 % de las
temporadas—, pero cuando ocurre decide el campeón, el podio y las medallas, así que no puede
resolverse con un sorteo: **se juega un partido**. `top4`/`top2` **no** tienen desempate en cancha:
si el corte queda empatado, la apuesta de futuros se anula y reembolsa (§11.5), porque definir un
mercado de dinero por sorteo o por un partido extra fuera del calendario no es justificable.

**Es un partido normal con dos fases extra.** Reutiliza el generador de §7.3 entero (misma matriz de
Poisson, mismos ratings, mismo relato) y le añade dos fases que solo este partido puede tener:

```
generateTimeline(home, away, ctx, random)          // 90' reglamentarios, idéntico a cualquier partido
  └─ si score queda empatado al 90' Y ctx.esDesempate:
       generateExtraTime(...)                       // 2 × 15' = 30' (FOOTBALL_EXTRA_TIME_MINUTES)
         └─ si SIGUE empatado al 120':
              generateShootout(...)                  // tanda: 5 por equipo, luego muerte súbita
```

**Prórroga.** λ se recalcula para 30 minutos con fatiga: los dos equipos rinden menos, así que
`λ_prórroga = λ_90 · (30/90) · FOOTBALL_EXTRA_TIME_FATIGUE` (fatiga ≈ 0.85). Se sortean goles de
prórroga de esa matriz reducida y se reparten entre el 91' y el 120'. No hay «gol de oro»: se juegan
los 30 minutos completos y gana quien va arriba al 120'. Si al 120' hay ganador, **se acabó**: no hay
tanda.

**Tanda de penales.** Solo si el 120' termina empatado. Es una secuencia determinista, no un partido:

```
generateShootout(home, away, random):
  // 5 lanzamientos por equipo, alternos (ABABABABAB)
  marcadores = { home: 0, away: 0 }
  para ronda = 1..FOOTBALL_SHOOTOUT_INITIAL:
     para team en [home, away]:
        anotó = (random() < FOOTBALL_SHOOTOUT_CONVERSION)      // ≈ 0.75, menor que en partido: presión
        events.push(evt(t, 'shootout_kick', { team, anotó, lanzador }))
        marcadores[team] += anotó
     // regla de eliminación temprana: si uno ya no puede ser alcanzado, se corta
     si inalcanzable(marcadores, rondasRestantes): break
  // muerte súbita si siguen iguales tras 5
  mientras marcadores.home == marcadores.away:
     para team en [home, away]:
        anotó = (random() < FOOTBALL_SHOOTOUT_CONVERSION)
        events.push(evt(t, 'shootout_kick', { team, anotó, lanzador, suddenDeath: true }))
        marcadores[team] += anotó
     si marcadores.home != marcadores.away: break              // uno falló y el otro no → ganador
  return { ganador, marcadores, events }
```

**Nueva fase y nuevos eventos.** El estado del partido (§6.2 `state.phase`) gana `extra_time` y
`shootout`, y el catálogo de §7.2 gana `extra_time_start`, `extra_time_end`, `shootout_kick` (con
`{team, anotó, lanzador, suddenDeath}`) y `shootout_end`. `shootout_kick` es de alta relevancia: se
emite de inmediato, suspende las cuotas en vivo y lleva relato propio («¡Atajado! El portero adivinó
el palo»). La tanda **siempre** produce ganador: la muerte súbita no puede empatar dos rondas
seguidas indefinidamente con un PRNG de período finito, y el lazo termina.

**Determinismo y auditoría.** El partido de desempate tiene su propio seed
`hash32('desempate' | seasonMonth | equipo1 | equipo2)`, derivado igual que los demás (§3.2), así que
su resultado —incluida la tanda— es reproducible byte a byte y estaba comprometido antes del saque
inicial. Se publica `hash32(seed)` al abrir y el `seed` al terminar, como cualquier partido (§15.9).
Esto importa más aquí que en ningún otro sitio: el desempate decide el campeón, y un jugador que
pierda una apuesta de futuros debe poder verificar que la tanda no se manipuló.

**Dónde cabe en el calendario.** El partido de desempate se juega **después de la jornada 30 y antes
del cierre mensual**, en la ventana que §5.2 ya reserva (`diasDisponibles = diasDelMes - 1`, el último
día queda para cierre y liquidación). Concreto: se programa en el bloque Estelar del último día
disponible, ~30 min de prórroga + tanda sobre los ~16 min normales → **~22-24 min reales** en total.
Si la temporada se **truncó** (§15.9, no alcanzaron los días), **no hay desempate**: el campeón sale
de la tabla parcial con los desempates estadísticos de §5.1 y el último recurso es el sorteo sembrado
determinista —no se añade un partido a un calendario que ya no tiene días.

### 7.6 Rendimiento del generador

Un partido completo: ~2.000–6.000 operaciones y ~180 eventos. Medido en Node moderno, **< 8 ms**.
Generar 6 partidos en un día doble: < 50 ms, hecho una sola vez por partido. No se genera nada en
el camino caliente del tick.

---

## 8. Render 2D cenital (canvas)

### 8.1 Contrato cliente/servidor

El servidor **no** envía las coordenadas de 22 jugadores a 60 fps. Envía:

| Paquete | Frecuencia | Contenido | Tamaño |
| --- | --- | --- | --- |
| `football:tick` | cada 2 s por partido | balón `{x,y}`, `phase`, posesión, minuto, marcador, ids de 3–6 jugadores con destino `{x,y}` | 250–450 B |
| `football:event` | inmediato | evento de alta relevancia + comentario | 300–800 B |
| `football:odds` | al cambiar | mercados con precios nuevos y `movement` | 200–900 B |

El cliente interpola en `requestAnimationFrame` (mismo patrón que la ruleta y las slots en
`public/app.js:1286` y `:1414`):

1. Mantiene un estado local de los 22 jugadores: posición actual + posición destino + `t0`.
2. En cada frame avanza `p = ease(clamp((now - t0) / duration))` hacia el destino.
3. Cuando llega un tick nuevo, los destinos se actualizan y `t0 = now`.
4. Añade **movimiento procedural local** (desmarques cortos, oscilación de la línea defensiva,
   rotación del balón) derivado de `phase` y del seed público del partido, para que la escena se
   sienta viva entre paquetes sin necesidad de más tráfico.
5. Con `prefers-reduced-motion`, desactiva el movimiento procedural y reduce el tween a cortes
   secos entre destinos.

Los jugadores que no vienen en el tick se posicionan por **plantilla de formación**: cada formación
(4-4-2, 4-3-3, 3-5-2, 4-2-3-1) tiene 11 slots normalizados por zona del campo, desplazados según
`phase` y según la posición del balón (el bloque se comprime/estira). Esto da la ilusión de un
equipo que se mueve junto, con 0 bytes extra de red.

### 8.2 Escena

- Cancha cenital 105×68 m normalizada a `[0,1]²`, con franjas de césped alternas, círculo central,
  áreas, punto penal y arcos. Paleta coherente con la identidad existente (grafito, verde menta,
  dorado): césped en verdes profundos desaturados, líneas en menta tenue, acento dorado para balón
  y marcador.
- Jugadores como círculos con dorsal, color de kit del club (`colors.primary/secondary`, patrones
  `stripes|solid|hoops|sash`), sombra suave y contorno del equipo en posesión.
- Balón con estela corta y destello en tiros.
- Overlays: marcador y reloj arriba al centro, indicadores de tarjetas y cambios en los laterales,
  destello de pantalla y banner «¡GOOOL!» en goles, viñeta roja momentánea en expulsiones.
- **Modo destacado**: el partido estelar ocupa ~65 % del ancho; los otros en vivo van en una franja
  de marcadores compactos (2 líneas: escudos, marcador, minuto, cuota 1X2 en vivo).
- **Modo compacto**: al abrir la ventana de apuestas o en resoluciones de 1024×720, la cancha se
  reduce y el relato textual gana espacio. Nunca se rompe el layout: el sitio es solo escritorio y
  la resolución mínima soportada es 1024×720.

### 8.3 Relato y accesibilidad

Junto al canvas, un panel de relato con los últimos mensajes (narrador a la izquierda, analista a la
derecha, con avatar/etiqueta de voz). Además:

- `role="img"` + `aria-label` descriptivo en el canvas, actualizado con el estado del partido.
- Región `aria-live="polite"` para el relato y `aria-live="assertive"` solo para goles, tarjetas
  rojas y penales.
- Fallback **solo texto** completo (marcador + minuto + relato + estadísticas) para quien desactive
  el canvas, para `prefers-reduced-motion` extremo y para lectores de pantalla. El partido debe ser
  100 % comprensible sin ver la cancha.
- Atajos de teclado coherentes con los existentes: `M` silencia el relato, `O` enfoca el panel de
  cuotas, `B` abre la boleta de apuesta, `?` muestra la guía.

---

## 9. Comentaristas

Dos voces generadas **en el servidor** y persistidas en la línea de tiempo (todos los espectadores
leen el mismo relato, y el partido es reproducible en auditoría):

| Voz | Rol | Registro | Cuándo habla |
| --- | --- | --- | --- |
| `narrador` | Play-by-play | Exclamativo, presente, frases cortas | Cada evento relevante, goles con intensidad |
| `analista` | Táctica y contexto | Sobrio, con datos, segunda voz | ~35 % de los eventos, siempre tras goles/expulsiones y en el descanso |

Generación por plantillas con variables `{jugador}`, `{equipo}`, `{rival}`, `{minuto}`,
`{marcador}`, `{estadística}`, `{racha}`:

```js
const POOLS = {
  goal: {
    narrador: [
      '¡GOOOL de {equipo}! {jugador} la mandó a guardar al {minuto}.',
      '¡{jugador}! ¡{jugador}! Grita {estadio}: {marcador} al {minuto}.',
      'Definición de {jugador} y {equipo} lo gana {marcador}.'
    ],
    analista: [
      'Son {goles} goles de {jugador} en la temporada. Vive de ese perfil.',
      'El xG decía {xgFavor} para {rival}; el fútbol no entiende de merecimientos.',
      '{equipoRival} queda {puestoRival} con esta derrota parcial; necesita reaccionar.'
    ]
  },
  // ... 22 tipos de evento × 6–10 plantillas por voz
};
```

Reglas de calidad:

- **Memoria anti-repetición**: se guardan las últimas 3 plantillas usadas por `(tipo, voz)` y se
  excluyen de la siguiente elección. Con 6–10 plantillas por tipo, la repetición inmediata es imposible.
- **Intensidad contextual**: la longitud y el número de mensajes escalan con `importance` del evento,
  con el minuto (los goles después del 80' reciben doble mensaje) y con la cercanía en la tabla
  (un partido entre 1.º y 2.º es «clásico» y recibe líneas especiales).
- **Continuidad**: el analista retoma datos del partido en curso (tiros, posesión, xG, forma,
  jornada, qué se juega cada equipo en la tabla), no frases aisladas.
- **Límite de longitud**: 140 caracteres por mensaje, para que el panel no se desborde.
- **Sin entrada de usuario**: las plantillas solo interpolan datos del servidor (clubes y jugadores
  ficticios). Si en el futuro se quiere mencionar el nombre de un espectador, debe pasar por
  `censorProfanity` y `displayNameIssue` antes de entrar al relato.
- Volumen objetivo: **1 mensaje cada 25–45 s simulados** (~2,5–4 mensajes por minuto real), con
  picos en goles. Suficiente para sentir transmisión continua sin saturar.

---

## 10. Motor de cuotas

### 10.1 Ratings

Después de cada partido:

```
E_home  = 1 / (1 + 10^(-((elo_home - elo_away) + HFA) / 400))      // HFA ≈ 60
S       = 1 | 0.5 | 0  (ganó | empató | perdió)
elo'    = elo + K · (S - E)                                        // K = 20

att'    = att · (1 - α) + α · (goles_a_favor   / λ_esperado_a_favor)   // α = 0.18
def'    = def · (1 - α) + α · (goles_en_contra / λ_esperado_en_contra)
```

`att/def` se acotan a `[0.70, 1.35]`. `leagueAvg` (goles por equipo por partido, ~1.35) y `homeAdv`
(~1.12) se recalculan de forma rodante sobre los últimos 60 partidos de la liga, con suelo y techo
para que un arranque de temporada con pocos datos no dispare los precios.

### 10.2 Probabilidades justas

Matriz de marcadores con **corrección Dixon-Coles** para los marcadores bajos (0-0, 1-0, 0-1, 1-1),
donde la independencia de Poisson puro sobreestima:

```
P(i,j) = Pois(i; λh) · Pois(j; λa) · τ(i, j, λh, λa, ρ)     // ρ ≈ -0.06
```

De la matriz se derivan todos los mercados: 1X2, doble oportunidad, hándicap, altas/bajas 1.5/2.5/3.5,
ambos anotan, marcador exacto, gana a cero, total de goles por equipo, descanso/final.

### 10.3 Del precio justo al precio publicado

```
precio_justo_k = 1 / p_k
precio_k       = precio_justo_k / (1 + margen_k)     // suma de probabilidades implícitas = 1 + margen
precio_k       = clamp(precio_k, 1.05, 101)
precio_k       = redondeoBook(precio_k)              // <2 → 0.01 · 2–4 → 0.05 · >4 → 0.10
```

Márgenes por mercado (`FOOTBALL_MARGIN_*`) — **decisión C4: se conserva el 7 %** aunque es más duro
que cualquier juego del casino actual:

| Mercado | Margen | Ventaja real de la casa |
| --- | --- | --- |
| 1X2, doble oportunidad, hándicap | **7 %** | 6,54 % |
| Altas/bajas, ambos anotan | **8 %** | 7,41 % |
| Marcador exacto, descanso/final | **12 %** | 10,71 % |
| En vivo (todos) | base **+1 %** | +0,93 pp |
| Futuros (campeón, top 4, bota de oro) | **10 %** | 9,09 % |
| Combinadas | compuesto por pata | se multiplica |
| Cash-out | **8 %** sobre valor esperado | — |
| `FOOTBALL_MIN_MARGIN_INVARIANT` | **4 %** | piso que nunca se puede romper |

> **Consecuencia aceptada, por escrito.** La ventaja medida de los juegos actuales es:
> ruleta 2,59–3,25 %, tragamonedas 2,26 %, dados ~0 %, cara o cruz ~0 %. Con margen 7 %, el Estadio
> queda en **6,54 %: más del doble que lo más caro del casino y muy por encima de un juego que hoy es
> esencialmente justo**. Es una decisión de producto legítima (el fútbol simulado ofrece más mercados
> y más tiempo de exposición que una mano de blackjack), pero tiene tres efectos que hay que gestionar
> en vez de ignorar:
>
> 1. **Drena fichas más rápido que el resto del casino.** Con el reinicio mensual a 1000 fichas, un
>    jugador que se concentre en el Estadio llegará a fin de mes con menos saldo que uno que juegue
>    dados. Si el ranking mensual es competitivo, el Estadio se vuelve una trampa de puntos.
> 2. **Exige transparencia máxima.** La interfaz debe mostrar siempre la probabilidad implícita junto
>    a la cuota («2.35 · ~43 %»), y el panel de ayuda debe explicar el margen. Con una ventaja alta y
>    opaca, el jugador que hace cuentas se siente estafado; con la ventaja visible, es una elección
>    informada.
> 3. **Debe poder bajarse sin desplegar código.** Todos los márgenes viven en variables de entorno y
>    se validan al arrancar. Si a las dos semanas se ve que el Estadio concentra saldo perdido, se
>    baja a 4 % (ventaja 3,85 %, alineada con la ruleta) con un cambio de configuración.
>
> Métrica a vigilar desde el día 1: `chips_netos_perdidos_por_juego` comparando Estadio contra el
> resto. Si el Estadio drena más de 2× por ficha apostada, el margen se revisa.

**Invariante no negociable**: después de cualquier movimiento, `Σ (1/precio_k) ≥ 1 + margenMínimo`.
Si un ajuste la rompiera, se renormaliza antes de publicar y se registra `odds_invariant_repair`.
Sin esto, el peso del dinero puede crear un **libro arbitrable** (apostar a todos los resultados y
ganar siempre), que es el bug económico más grave posible aquí. Con margen 7 % y piso 4 % hay 3 puntos
de recorrido para el movimiento por peso del dinero antes de tocar el piso.

### 10.4 Movimiento por peso del dinero (pre-partido)

El mercado abre con las cuotas del modelo y se mueve según la responsabilidad acumulada:

```
share_k    = stake_k / Σ stake                        // 0 si aún no hay dinero
desvio_k   = w · (share_k - p_k)                      // w = 0.30, ajustable
p_ajust_k  = normalizar(p_k + desvio_k)               // lo muy apostado sube de probabilidad → baja su cuota
precio_k   = publicar(p_ajust_k, margen_k)
```

Límites de movimiento (anti-manipulación y anti-nerviosismo visible):

- Máximo **±6 %** de cambio de precio por actualización.
- Máximo **1 actualización cada 20 s** por mercado, o inmediata si entra una apuesta ≥ 5 % del total
  apostado en el mercado.
- Máximo **±25 %** de desviación acumulada respecto del precio de apertura. Al llegar al tope, el
  mercado deja de moverse y, si la responsabilidad sigue creciendo, se **suspende** ese resultado
  (`selection_closed`) en lugar de publicar un precio absurdo.
- Cada cambio se audita con razón: `reason: 'weight_of_money' | 'rating_update' | 'lineup' |
  'liability_cap' | 'admin' | 'inplay_state'`, precio anterior, nuevo, stake detonante.

### 10.5 Cuotas en vivo

En cada cambio de estado revelado se recalcula el partido restante:

```
minRestantes = 90 + agregado - minutoActual
λ_rem_local  = λ_home · (minRestantes / 90) · estadoJuego · tarjetas · fatiga
λ_rem_visita = λ_away · (minRestantes / 90) · estadoJuego · tarjetas · fatiga
```

Factores de `estadoJuego`:

| Situación | Efecto |
| --- | --- |
| Equipo perdiendo por 1 | +9 % ataque, +7 % defensa vulnerable (se adelanta) |
| Equipo perdiendo por 2+ | +14 % ataque, +12 % vulnerable |
| Equipo ganando en los últimos 15' | −8 % ataque, −6 % vulnerable (administra) |
| Expulsión propia | −22 % ataque, +26 % goles esperados en contra |
| Expulsión del rival | inverso |
| Momentum: xG de los últimos 10' | ±6 % según diferencia |
| Últimos 5' + agregado | +5 % a ambos (partido roto) |

Con esas λ restantes se arma la matriz condicional y se suma el marcador actual para obtener
`P(gana local)`, `P(empate)`, `P(gana visita)`, totales restantes, próximo gol, marcador exacto
final. Margen en vivo = base + 1 %.

### 10.6 Suspensión y retardo de aceptación

Reglas tomadas del funcionamiento real de los libros en vivo, porque evitan las dos peores clases de
bug y de abuso:

- **`suspended = true`** durante: gol (hasta reanudar, ~15 s reales), penal señalado, tarjeta roja,
  revisión tipo VAR, descanso, tiempo agregado final y entre el silbatazo final y la liquidación.
- Con el mercado suspendido se rechaza toda apuesta con `code: 'market_suspended'` y el botón se
  muestra bloqueado con contador de segundos.
- **Retardo de aceptación de 4 s** en apuestas en vivo (`FOOTBALL_BET_DELAY_MS`): la apuesta se
  valida contra las cuotas vigentes **al momento de procesarse**, no al de enviarse. Si en ese
  lapso la cuota cambió más de 5 %, se responde `odds_changed` con el nuevo precio y el cliente
  debe reconfirmar. Esto elimina el abuso de «apostar a la cuota vieja después del gol» y el
  problema de doble clic / reintento de red.
- **`closed` definitivo** para mercados que ya no tienen sentido (`next_goal` tras el 90',
  altas/bajas cuando el total ya se superó, `first_half` al descanso). Se cierran y liquidan solos.

### 10.7 Cash-out

```
valorActual  = stake · cuotaColocada · p_actual(selection)      // valor esperado del boleto
cashout      = valorActual · (1 - margenCashout)                // margenCashout = 0.10
cashout      = clamp(cashout, 0, payoutPotencial)
```

Disponible solo si: la apuesta está `open`, el mercado del partido no está `suspended`, el partido
no terminó y `p_actual` se pudo calcular. Durante suspensión el botón muestra «No disponible» con
explicación breve. Cada cash-out se liquida como terminal (`status: 'cashed'`) y libera la
responsabilidad del mercado.

---

## 11. Mercados y apuestas

### 11.1 Pre-partido (abren al publicar la jornada, cierran al kickoff)

| Mercado | Selecciones | Margen |
| --- | --- | --- |
| Resultado final (1X2) | local / empate / visita | 7 % |
| Doble oportunidad | 1X / 12 / X2 | 6 % |
| Hándicap simple | local −1 / local +1 / visita −1 / visita +1 | 7 % |
| Altas/Bajas | 1.5 · 2.5 · 3.5 goles (ambas puntas) | 7 % |
| Ambos anotan | sí / no | 8 % |
| Marcador exacto | 12 celdas más frecuentes + «otro» | 12 % |
| Equipo gana a cero | sí / no por equipo | 9 % |
| Total goles por equipo | altas/bajas 0.5 · 1.5 por equipo | 8 % |
| Descanso/Final | 9 combinaciones | 12 % |

### 11.2 En vivo

| Mercado | Notas |
| --- | --- |
| Resultado final desde el estado actual | El más líquido; se recalcula en cada tick relevante |
| Próximo gol | local / visita / sin goles; se cierra al 90' |
| Altas/Bajas del total restante | Línea dinámica según minuto |
| Marcador exacto final | Solo celdas alcanzables desde el marcador actual |
| Gana el resto del partido | local / empate / visita considerando solo los minutos restantes |

### 11.2-bis Mercado del partido de desempate (decisión A14)

El partido de desempate (§7.5) es el único que **no puede terminar en empate**: hay prórroga y tanda
hasta que salga un ganador. Eso cambia su mercado principal respecto del 1X2 de un partido normal:

| Mercado | Selecciones | Margen | Nota |
| --- | --- | --- | --- |
| **Gana el desempate** (clasifica) | local / visita — **2 vías, sin empate** | 7 % | Cubre 90' + prórroga + tanda. Es el mercado equivalente al «to qualify» de una eliminatoria |
| Resultado a los 90' | local / empate / visita | 7 % | 1X2 normal, solo el tiempo reglamentario; el empate aquí **no** reembolsa, pierde |
| Altas/Bajas 90' · ambos anotan · marcador exacto 90' | como §11.1 | como §11.1 | Sobre el tiempo reglamentario |
| En vivo (todos los de §11.2) | — | base +1 % | Durante la prórroga y la tanda el mercado «Gana el desempate» sigue vivo; el 1X2 a 90' se cierra al silbatazo del 90' |

**Regla de oro: «Gana el desempate» se liquida por el ganador final (tras tanda si hace falta), no
por el marcador a los 90'.** Un 1-1 al 90' que termina 3-2 en penales paga a quien apostó por el
ganador de la tanda. El precio justo sale de la **misma** matriz de Poisson que genera el partido
(R3/§3.3): `P(gana local) = P(gana a los 90') + P(empata a los 90') · P(gana en prórroga o tanda)`,
donde la segunda parte se integra sobre la matriz de prórroga y la conversión de la tanda
(`FOOTBALL_SHOOTOUT_CONVERSION`). Como la tanda es simétrica por construcción, `P(gana en tanda |
empate al 120') ≈ 0.50` con una leve ventaja de localía; el generador la resuelve con el seed, no con
esa aproximación, pero el **precio** usa la aproximación analítica para no tener que simular 2.000
prórrogas en el camino caliente.

Si la temporada se **truncó** no hay desempate (§7.5, §15.5): este mercado nunca llega a abrirse.

### 11.3 Reglas generales de apuesta

**Decisión C5: tope del 25 % del saldo.** El documento original proponía `min(5000, 2 % del saldo)`,
que era inutilizable: con el reinicio mensual a 1000 fichas, el 2 % dejaba a un jugador nuevo
apostando **máximo 20 fichas**, apenas encima del mínimo y por debajo de las denominaciones de la
interfaz. Se corrige a un modelo intermedio:

```
stakeMáximoPorApuesta = min( 25 % del saldo , FOOTBALL_MAX_STAKE )
stakeMínimo           = min( 10 , saldo )
```

| Saldo del jugador | Rango de apuesta |
| --- | --- |
| 1.000 (recién reiniciado) | 10 – 250 |
| 5.000 | 10 – 1.250 |
| 50.000 | 10 – 12.500 |
| 200.000+ | 10 – 25.000 (techo absoluto) |

Denominaciones en la interfaz: **`[10, 25, 50, 100, 250, 500, 1000]` filtradas por el tope vigente**,
igual que el patrón existente de `public/app.js:1531`. Más un campo libre para cantidad exacta.

Dos efectos que hay que comunicar, no esconder:

1. **Es más restrictivo que tus juegos rápidos.** En `server.js:1311` una apuesta rápida acepta hasta
   el 100 % del stack; en el Estadio el tope es 25 %. La boleta debe decir explícitamente
   «Máximo 25 % de tu saldo por apuesta» para que no se lea como un fallo.
2. **Funciona como limitador de pérdida natural.** Al caer el saldo, cae el tope: quien va perdiendo
   no puede duplicar indefinidamente para recuperarse. Es una protección real de juego responsable
   dentro de un casino de fichas virtuales, y conviene mencionarla en los T&C como característica.

Límites agregados:

| Límite | Valor | Para qué existe |
| --- | --- | --- |
| Apuestas abiertas por perfil y partido | 20 | Evita acaparar mercados |
| Exposición por perfil y partido | 50.000 fichas | Que nadie domine un partido solo |
| Exposición de la casa por partido | 250.000 fichas | Techo de responsabilidad del libro |
| Exposición de la casa por jornada | 1.000.000 fichas | Techo agregado del día |
| Pago máximo por apuesta | 500.000 fichas | Protege la integridad del ranking mensual |
| Cuota máxima publicable | 101 | — |

Al llegar a un techo de exposición, el mercado no publica precios absurdos: cierra esa selección con
`selection_closed` y lo explica en la interfaz («Apuestas agotadas en este resultado»).

Los valores anteriores son **provisionales por diseño**: la economía real depende de cuántas fichas
haya en circulación, y eso solo se sabe con la sección operando. Todos van en variables de entorno y
se ajustan sin desplegar código.

Otras reglas:

- Cuotas en formato **decimal**, mostradas siempre junto a la probabilidad implícita («2.35 · ~43 %»).
  Con un margen del 7 % esto deja de ser un detalle de cortesía y pasa a ser obligatorio (§10.3).
- Saldo insuficiente → `insufficient_chips`; se muestra el bono diario disponible si aplica.
- Rate limit: **10 intentos / 10 s por perfil** con `FixedWindowRateLimiter` (`lib/rate-limit.js`).
- Verificación de T&C vigente (`verifyTosAcceptance`) antes de apostar, igual que para crear salas.
- **Decisión C6, corregida**: el fútbol **no** se agrega a `AVAILABLE_GAMES` en
  `lib/progression.js:3`. Pero eso **no basta** para excluirlo de los retos «prueba N juegos» — ver
  §12.7. Hace falta además filtrar en `trackPeriod`. Con ambas cosas, el historial y la gráfica de
  saldo funcionan solos, y el panel «Historial por juego» necesita **una línea** en `GAME_META`
  (`public/app.js:68`) para poder mostrar el fútbol.

### 11.4 Combinadas (parlays)

- **2 a 6 patas**, todas de **partidos distintos**. Prohibido combinar mercados del mismo partido:
  son resultados correlacionados y permitirían construir arbitrajes con las cuotas dinámicas.
- Cuota combinada = `Π cuota_pata`, con tope de **100.0** y pago máximo **500.000 fichas**.
- Se valida y congela en el momento de la colocación: si alguna pata está `suspended` o `closed`, se
  rechaza la combinada completa con la pata problemática identificada.
- **Pata anulada → cuota 1.00** para esa pata (regla estándar): la combinada sigue viva con las
  demás. Si todas se anulan, se reembolsa el stake completo.
- La combinada gana solo si ganan **todas** las patas no anuladas; pierde en cuanto una pierde
  (liquidación temprana, se acredita `lost` y se libera responsabilidad).
- Cash-out de combinada = `stake · cuotaCombinada · Π p_actual(pata) · (1 - margenCashout)`.
- Exposición: la responsabilidad de una combinada se reparte proporcionalmente entre sus patas para
  que el control de exposición por partido siga siendo correcto.

### 11.5 Futuros (apuestas de temporada)

| Mercado | Cuándo se liquida |
| --- | --- |
| Campeón de liga | Al terminar la jornada 30, **o tras el partido de desempate si el 1.º empató** (§7.5) |
| Termina en top 4 | Al terminar la jornada 30 |
| Termina en top 2 | Al terminar la jornada 30 |
| Bota de Oro (máximo goleador) | Al terminar la jornada 30 (los goles de la prórroga/tanda **no** cuentan: es un premio de liga regular) |

Precio: **Monte Carlo sembrado** sobre el calendario restante.

```
para n = 1..2000:
   simular las jornadas pendientes con la matriz de Poisson actual (ratings al día)
   registrar campeón y top 4
p_campeon_k = conteo_k / 2000
```

2.000 simulaciones de ~180 partidos restantes ≈ 300–500 ms. Se ejecuta **una vez al cerrar cada
jornada** (no en el camino caliente), se persiste y se publica. Reglas:

- Se abre en la jornada 1 y **se cierra en la jornada 20** (después, el riesgo de cola es demasiado
  grande para un mercado mensual).
- Márgenes 10 %; tope de cuota 51; stake máximo 2.000 fichas por selección.
- **Empate en la cima**: si los desempates de tabla (§5.1) declaran un campeón, ese es el resultado.
  Si el empate por el 1.º persiste, se juega el **partido de desempate** (§7.5, A14) y el campeón
  futuro se liquida con su ganador —la apuesta de «Campeón de liga» **espera** a ese partido, no se
  liquida en la jornada 30. Para `top4`/`top2` con empate en el corte **no hay partido**: la apuesta
  se **anula y reembolsa** (no se define por sorteo ni por cancha un mercado de dinero de posiciones
  intermedias).
- Si la temporada se trunca (el watchdog no pudo completar las 30 jornadas antes del cierre
  mensual), **todas las apuestas de futuros se anulan y reembolsan**, y **no hay partido de
  desempate** aunque la tabla parcial muestre empate en la cima: el campeón sale de los desempates
  estadísticos de §5.1 con sorteo sembrado como último recurso (§7.5). Nunca se liquidan con una
  tabla incompleta.

### 11.6 Flujo de apuestas simulado (decisión D8)

**El problema.** El movimiento de cuotas depende del peso del dinero (§10.4). Sin personas
conectadas, las cuotas se quedarían congeladas en el precio del modelo durante horas, y la sección
se vería estática justo cuando alguien entra a mirar: un mercado que nunca se mueve no parece vivo.

**La solución.** Un generador de flujo sintético que aporta volumen al cálculo del peso del dinero.
**Invisible en la interfaz**: nunca aparece como jugador, ni en el chat, ni en rankings, ni en el
historial de ganadores. Existe solo como un número que empuja las cuotas.

```
pesoSimulado = FOOTBALL_SIM_WEIGHT · decaimiento(realTotal)
decaimiento(x) = 1 / (1 + x / FOOTBALL_SIM_SOFTENER)

share_k = (realStake_k + simStake_k · pesoSimulado)
          ─────────────────────────────────────────────
          (realTotal   + simTotal   · pesoSimulado)
```

Con `SIM_WEIGHT = 0.6` y `SIM_SOFTENER = 2.000` fichas:

| Fichas reales apostadas en el mercado | Influencia del flujo simulado |
| --- | --- |
| 0 | 100 % — el simulado mueve solo las cuotas |
| 2.000 | 50 % |
| 10.000 | 17 % |
| 40.000 | 5 % — el dinero real domina por completo |

**Regla de oro: el dinero real siempre termina mandando.** El decaimiento garantiza que en cuanto
hay personas apostando, el flujo simulado se vuelve irrelevante. Nunca compite con el jugador.

**Contabilidad separada — esto es lo crítico.** El flujo simulado **no cuenta para la exposición ni
para la responsabilidad de la casa**:

- `exposure.totalStaked`, `exposure.liability` y todos los techos de §11.3 se calculan **solo con
  fichas reales**. Si no fuera así, el dinero sintético consumiría los topes y un mercado cerraría
  con `selection_closed` sin que nadie real hubiera apostado.
- No hay fichas moviéndose: el flujo simulado nunca llama a `credit` ni toca un perfil. Es un
  contador por mercado, nada más.
- La invariante anti-arbitraje (§10.3) se aplica igual: el flujo simulado no puede producir un libro
  arbitrable, porque el piso de margen se verifica antes de publicar cualquier precio.

**Dirección del flujo.** No es aleatorio puro: se sesga para que los movimientos tengan motivo y, de
paso, reproduzcan un patrón real de los mercados de apuestas:

| Componente | Efecto |
| --- | --- |
| Diferencia de ratings | El favorito atrae más dinero (realista) |
| **Sesgo de público** | Se sobreapuesta al favorito y al «altas de goles» más de lo justo |
| Forma y narrativa | Un equipo con 4 victorias seguidas atrae dinero |
| Ruido sembrado | Variación por mercado y por franja |

El sesgo de público tiene una consecuencia deseable: empuja la cuota del favorito hacia abajo y
**deja valor en el lado impopular**, exactamente como en un mercado real. Un jugador que apueste al
no-favorito encuentra precios ligeramente mejores, y eso recompensa mirar la tabla en vez de apostar
siempre al mismo.

**Volumen y cadencia.** Entre 500 y 5.000 fichas sintéticas por partido en la ventana pre-partido
(más en el bloque estelar y en jornadas que definen la tabla), llegando en aportes cada 30–60 s. En
vivo, el volumen baja a ~20 %. Todo se genera con el seed del partido (`seed + '|flow'`), así que es
**reproducible en auditoría**: se puede regenerar exactamente qué flujo movió una cuota.

**Transparencia.** Cada aporte se registra con `logEvent('football_simulated_flow', { match, market,
selection, stake, reason })` y se agrega un total por partido en `/healthz`. Los T&C (decisión B1)
deben declararlo: *«Los movimientos de las cuotas pueden incorporar un flujo de referencia simulado,
generado por el servidor, que no representa apuestas de otras personas y no interviene en el pago de
apuestas ni en la responsabilidad de la casa.»* Ocultarlo sería el único punto de este documento que
podría leerse como engañoso; declarado, es simplemente cómo funciona un mercado simulado.

**Pruebas asociadas**: T18 (el flujo simulado no altera exposición ni paga nada) y T19 (ningún
payload dirigido al cliente contiene datos del flujo simulado).

---

## 12. Integridad de las fichas

### 12.1 Escrow en la colocación

Al apostar, las fichas **salen del perfil inmediatamente**. Nunca se promete un pago que no esté
respaldado: un reinicio, un deploy o una caída a mitad del partido no pueden crear fichas de la nada.

> **Corrección verificada contra el código (2026-10-07).** La versión anterior de este documento
> decía que el débito se hacía con `credit(profile, -stake)`. **Eso no funciona.**
> `lib/progression.js:154` abre con:
>
> ```js
> amount = Math.max(0, Math.floor(Number(amount) || 0));
> if (!amount) return 0;
> ```
>
> Un monto negativo se convierte en `0` y la función retorna sin tocar nada. La apuesta se habría
> registrado con fichas que **nunca salieron del perfil**: apuestas ilimitadas con saldo intacto. Es
> exactamente la clase de bug que este documento existe para prevenir, y lo había introducido yo.

Cómo se debita de verdad en el casino hoy, y por qué ningún mecanismo existente sirve tal cual:

| Mecanismo | Qué hace realmente | ¿Sirve para el Estadio? |
| --- | --- | --- |
| `player.chips -= n` (`server.js:316`) | Setter que escribe `profile.chips` con clamp y `profiles.touch` | No: exige un objeto `player` de mesa |
| `takeChips()` (`server.js:907`) | `Math.min(player.chips, amount)` → permite **all-in parcial** | No: un llenado parcial es incorrecto en una apuesta |
| `recordWager()` (`lib/progression.js:195`) | **Solo estadística.** Su propio comentario lo dice: no debita para no duplicar el movimiento | Sí, pero no debita nada |
| `credit()` (`lib/progression.js:153`) | Solo acredita; clamp a `>= 0` | Solo para el pago, nunca para el stake |

**Solución: exportar `debit()` desde `lib/progression.js`.** Son ~10 líneas, simétricas a `credit`, y
viven junto a él en el módulo que ya es dueño de las fichas. (La regla de §4 tal como estaba redactada
—«las fichas solo se mueven dentro de ese módulo»— no describe el código real; ver §12.7, hallazgo 8.)

```js
function debit(profile, amount, reason) {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return { ok: false, amount: 0, error: 'monto_invalido' };
  // Fail-closed: se comprueba ANTES de mutar. Nunca se debita parcialmente.
  if (amount > profile.chips) return { ok: false, amount: 0, error: 'saldo_insuficiente' };
  profile.chips -= amount;
  snapshotBalance(profile);
  return { ok: true, amount, reason };
}
```

> **Obligatorio y fácil de omitir (§12.7, hallazgo 7).** `lib/progression.js` es un módulo puro: no
> tiene referencia al store, así que `debit()` —igual que `credit()`— **solo muta memoria**. Quien
> llama debe ejecutar `profiles.touch(profile)` acto seguido, que es lo que agenda la escritura
> (debounce de 180 ms). Es la convención real del repo: `server.js:590` lo hace tras `recordOutcome`,
> `server.js:1091` tras `credit`. `executeQuickBet` no lo necesita solo porque asigna a
> `player.chips`, cuyo setter (`server.js:316`) ya llama a `touch`; `debit()` recibe el `profile`
> crudo y no pasa por ningún setter.
>
> Sin ese `touch()`, la fila de la apuesta se escribe *write-through* y las fichas no se descuentan
> nunca: al reiniciar, la apuesta se liquida contra un saldo que aún contiene el stake. Cubierto por
> T33. El orden completo de la colocación (intención → WAL → débito → `touch` → confirmación) está en
> la decisión A8.

Tres diferencias deliberadas con `takeChips`:

1. **Todo o nada.** `takeChips` acepta un all-in parcial porque en póker es legal. En una apuesta,
   un llenado parcial cobraría una cuota sobre un stake distinto del solicitado: se rechaza.
2. **Falla cerrado.** Devuelve `{ ok: false }` y **no muta** el perfil. Quien llama no puede
   olvidarse de comprobar: si `ok` es falso, la apuesta no se crea.
3. **Sin transacción propia.** Sigue la convención existente: el débito no genera entrada en
   `profile.transactions`; el movimiento se explica al liquidar, con el `net` de `recordOutcome`. Lo
   que el jugador ve mientras la apuesta está abierta es el panel **«Mis apuestas»** (stake, cuota,
   pago potencial), que es más útil que una línea de historial. `snapshotBalance` sí se llama, para
   que la gráfica de saldo no muestre un saldo viejo durante los ~17 min que dura el partido.

**Convención de liquidación.** Cada apuesta liquidada llama a
`recordOutcome(profile, { game: 'football', net: payout - stake, eligible: false })`.

`eligible: false` es deliberado y conviene entender por qué: un jugador puede tener 20 apuestas
abiertas sobre el mismo partido y las 20 se liquidan en el mismo instante. Con `eligible: true` eso
fabricaría una racha de 20 victorias (o 20 derrotas) de golpe en `eligibleBestStreak`, que es justo
la métrica que alimenta la medalla de platino. Las estadísticas generales (`roundsPlayed`,
`gameStats.football`) sí cuentan cada apuesta; la racha elegible, no.

Alternativa considerada y descartada: registrar una transacción en la colocación y acreditar el pago
**bruto** al liquidar. Da un historial más explícito, pero rompe la convención de `net` de
`recordOutcome` y duplicaría el movimiento en la gráfica de saldo.

### 12.2 Idempotencia

Cada apuesta lleva `idempotencyKey = hash(deviceToken + placedAtRedondeado + market + selection +
stake)` validada contra `lib/idempotency-store*`. Un reintento de red o un doble clic devuelve la
apuesta original en vez de crear una segunda. Es el mismo mecanismo que ya protege las operaciones
administrativas.

### 12.3 Liquidación exactamente una vez

```
liquidar(bet):
  if bet.status !== 'open': return { yaLiquidada: true }
  reclamar clave única (store.settled[betId])     // atómica en memoria; UNIQUE INDEX en PG
  calcular payout
  profile.chips += payout                        // convención de las rondas (server.js:954),
                                                 // NO credit(): duplicaría el historial (§12.7 h.8)
  recordOutcome(profile, { game:'football', net: payout - stake, eligible: false })
  profiles.touch(profile)                        // obligatorio (§12.7 h.7)
  bet.status = 'won'|'lost'|'void'|'cashed'
  auditar
```

En Postgres, `UPDATE ... WHERE status = 'open' RETURNING` da la atomicidad real. En el store de
archivo, el Map en memoria del proceso único la da. Un `footballSettlementSweep` duplicado o un arranque
que reconcilie dos veces **no puede pagar dos veces**.

### 12.4 Anulación y reembolso

`void` se aplica cuando: el partido pasa a `postponed`, el mercado se cierra por error detectado, la
temporada se trunca, o una pata de combinada se anula (solo esa pata). Reembolso = stake completo,
registrado en el historial de transacciones del perfil con motivo legible (`Anulación: partido
pospuesto`). El jugador debe poder ver **por qué** le devolvieron las fichas.

### 12.5 Invariantes verificadas por watchdog

| Invariante | Acción si se rompe |
| --- | --- |
| `Σ stake de apuestas open == fichas en escrow del partido` | Log `football_ledger_mismatch` + suspensión del mercado + alerta en `/healthz` |
| `Σ (1/cuota_k) ≥ 1 + margenMínimo` en cada mercado abierto | Renormalizar antes de publicar + log `odds_invariant_repair` |
| Ninguna apuesta `open` en partido `finished` por más de 60 s | Forzar liquidación |
| Ningún partido `live` con `now - lastTickAt > 15 s` | Re-derivar desde el seed (auto-reparación) |
| Ningún perfil con saldo negativo | Bloquear nuevas apuestas + log crítico |
| Ninguna apuesta de la temporada anterior `open` tras el cierre | Anular y reembolsar antes del reset |

### 12.6 Orden crítico con el reset mensual

Este es un bug silencioso con potencial de destruir confianza, y hoy no existe porque no hay nada que
liquidar al cierre:

> El `seasonSweep` pone a todos en 1000 fichas el día 1 a las 00:00. Si en ese instante hay stakes
> escrow-eados, **se evaporan**: el jugador apostó 4.000 fichas, llegó el reset y su apuesta se
> liquidó contra un saldo que ya no las contiene.

Solución: `footballSeasonGuard` (§15.5) corre **antes** y garantiza que a las 23:59 del último día no
queda nada abierto. Además, el reset lleva un **gate acotado** registrado por el motor (§12.7,
hallazgo 6, decisión A7): mientras queden apuestas abiertas del mes que cierra, `ensureSeason()`
devuelve `{type:'deferred'}` **sin tocar `profile.chips`** y reintenta en el próximo acceso.

El gate va dentro de `ensureSeason()` (`lib/profile-store-base.js:94`) y **no** en `seasonSweep`,
porque `ensureSeason()` tiene dos disparadores: el barrido de 5 min (`server.js:2220`) y
`getOrCreate()` (`profile-store-base.js:178`), que corre en cada conexión de socket. El segundo gana
la carrera casi siempre: el primer jugador que reconecte a las 00:00:00.3 del día 1 dispara el reset.
Proteger solo `seasonSweep` dejaba abierto el camino principal.

Y el veto es **acotado** por `SEASON_RESET_MAX_DEFERRALS` (12 barridos ≈ 1 h). Al agotarse, el motor
anula y reembolsa al contado lo que quede (`forceSettle`) y el reset procede. Sin ese techo, una sola
apuesta atascada congelaría el reset mensual para siempre: el fútbol puede **retrasar** el reset,
nunca **impedirlo**.

### 12.7 Verificación contra el código real (2026-10-07)

Toda afirmación de integración de este documento se contrastó contra el código, función por función.
**Once resultaron falsas o inviables tal como estaban escritas.** Se corrigen aquí porque las once
habrían producido bugs silenciosos, no errores visibles: ninguna habría fallado en una prueba
unitaria del motor, todas fallaban solo al conectarse con el código existente.

Cinco eran citas incorrectas de funciones reales (1, 2, 3, 4, 5), una era un defecto de diseño del
propio documento (6), tres eran las dos cosas a la vez —una cita mal leída que además invalidaba un
diseño ya escrito— (7, 8, 9), una era un **hueco**: algo que el documento nunca especificó y cuya
omisión dejaba libre el camino más peligroso (10), y una era un **hueco en una corrección previa**: el
11 anula la decisión A7 que el propio hallazgo 6 había introducido, porque el reset tiene un tercer
disparador que corre antes de que cualquier guarda pueda registrarse. Los hallazgos 6, 7 y 8
comparten además un patrón reconocible: **dos secciones del documento describían comportamientos
incompatibles y cada una era correcta por separado**, así que ninguna revisión sección por sección los
habría encontrado. El 10 y el 11 son de otra clase: no había nada mal escrito, había algo **sin
escribir**, y eso no lo detecta ninguna verificación de citas — el 10 solo aparece al intentar
implementar el handler, y el 11 solo aparece al preguntar qué pasa cuando el servidor está caído.

Seis de los once tocan dinero o acceso de forma crítica: R20 (hallazgo 1, apuestas sin descontar),
R27 (6, reset que evapora stakes o congela el casino), R28 (7, la casa paga fichas que nunca cobró),
R31 (9, lockout total sin salida visible), R32 (10, fichas infinitas por token inventado) y R34 (11,
apagón que cruza fin de mes y evapora los stakes antes de que exista la guarda). Los cinco restantes
degradan la experiencia o el mantenimiento sin romper la economía.

De los seis críticos, **cinco van en contra de la casa o de todos los jugadores** (1, 7, 9, 10, 11) y
uno puede ir en ambas direcciones (6). Esa asimetría es la razón por la que la barrida valió la pena:
un documento de arquitectura que se lee bien y se implementa tal cual habría entregado una sección
que regala fichas, duplica historiales, puede bloquear el casino entero en un deploy y paga apuestas
que nunca cobró —sin que ninguna prueba unitaria del motor fallara en ningún momento.

| # | Hallazgo | Qué habría pasado | Severidad |
| --- | --- | --- | --- |
| 1 | `credit()` no puede debitar | Apuestas creadas sin descontar fichas | Crítica |
| 2 | `AVAILABLE_GAMES` no excluye de los retos | Decisión C6 sin efecto real | Media |
| 3 | El desglose itera `GAME_META`, no `gameStats` | Datos guardados e invisibles | Media |
| 4 | La vía de migración PG no existe ni corre | DDL que no se aplica nunca | Alta |
| 5 | El fail-closed funciona por posición, no por mecanismo | Proceso zombi que no escucha | Alta |
| 6 | La guarda del reset estaba en un consumidor y sin techo | Stakes evaporados o casino congelado | Crítica |
| 7 | `debit()` no persiste y la apuesta sí | La casa paga fichas que nunca cobró | Crítica |
| 8 | `credit()` + `recordOutcome()` duplican el historial | Historial y gráfica al doble | Media |
| 9 | `TOS_VERSION` está duplicada en el cliente | Lockout total sin modal | Crítica |
| 10 | `token`→`profile` sin especificar; el camino obvio usa `getOrCreate` | 1000 fichas gratis por token inventado, sin techo | Crítica |
| 11 | El reset corre **durante la construcción del store** (archivo: constructor; PG/Neon: `_init()`), antes de que exista cualquier guarda | Un apagón que cruza fin de mes evapora los stakes | Crítica |

#### Hallazgo 1 — `credit()` no puede debitar (crítico)

`lib/progression.js:153`:

```js
function credit(profile, amount, reason) {
  amount = Math.max(0, Math.floor(Number(amount) || 0));   // ← clamp a cero
  if (!amount) return 0;                                    // ← retorna sin tocar nada
  profile.chips += amount;
```

El documento decía que el escrow se hacía con `credit(profile, -stake)`. Con ese clamp, un stake de
500 fichas se convierte en `0` y la función retorna sin debitar: **la apuesta se registraba con
fichas que nunca salieron del perfil**. Apuestas ilimitadas con saldo intacto, y sin ningún error en
los logs porque `credit` devuelve `0` en silencio. Corregido en §12.1 con un `debit()` nuevo.

#### Hallazgo 2 — `AVAILABLE_GAMES` no excluye al fútbol de los retos (invalida la decisión C6)

La decisión C6 se tomó sobre una premisa falsa. `lib/progression.js:72`, dentro de `trackPeriod`:

```js
if (game && !period.games.includes(game)) period.games.push(game);
```

`trackPeriod` agrega **cualquier** clave de juego que reciba, sin consultar `AVAILABLE_GAMES`. Y los
retos rotatorios leen justo esa lista:

```js
{ id: 'daily_games',  name: 'Turista del día',  description: 'Prueba 2 juegos hoy.',      value: p => p.games.length }
{ id: 'weekly_games', name: 'Ruta del casino',  description: 'Prueba 4 juegos esta semana.', value: p => p.games.length }
```

Entonces, si `recordOutcome` recibe `game: 'football'`, el Estadio **sí** cuenta para esos dos retos
aunque no esté en `AVAILABLE_GAMES`. Un jugador podría completar «Turista del día» apostando al
fútbol y tocando una sola mesa — justo lo que C6 quería evitar.

`AVAILABLE_GAMES` solo se usa en un lugar (`lib/progression.js:102`), el logro `explorer`:

```js
test: p => AVAILABLE_GAMES.every(game => p.gamesPlayed.includes(game))
```

Ahí sí aplica la decisión: no agregar `'football'` mantiene «Tour del casino» exigiendo los seis
juegos de mesa.

**Corrección.** Para honrar la intención real de C6 hay que filtrar también en `trackPeriod`. La
forma menos invasiva, que no cambia el comportamiento de los seis juegos actuales:

```js
const CHALLENGE_GAMES = new Set(AVAILABLE_GAMES);
// en trackPeriod:
if (game && CHALLENGE_GAMES.has(game) && !period.games.includes(game)) period.games.push(game);
```

Es una línea en `lib/progression.js`. Sin ella, C6 no hace lo que dice. Con ella, el fútbol queda
fuera de los retos rotatorios y del logro `explorer`, pero sigue alimentando `gameStats`, el
historial y la gráfica de saldo, que es lo que se quería.

#### Hallazgo 3 — el panel «Historial por juego» no mostraría el fútbol

`public/app.js:2030`:

```js
const rows = Object.keys(GAME_META)
  .filter(game => gameStats[game]?.rounds > 0)
```

Itera sobre `GAME_META`, no sobre `gameStats`. Y `GAME_META` (`public/app.js:68`) tiene solo seis
entradas:

```js
const GAME_META = {
  poker: {...}, blackjack: {...}, roulette: {...}, dice: {...}, coinflip: {...}, slots: {...}
};
```

Así que aunque `recordOutcome` guarde `gameStats.football` correctamente, **el panel nunca lo
renderiza**: los datos existen y son invisibles. La decisión E10 («la gráfica se alimenta sola») es
cierra para la gráfica de saldo —esa sí se alimenta vía `snapshotBalance`— pero falsa para el
desglose por juego.

**Corrección.** Una entrada en `GAME_META`:

```js
football: { icon: '🏟', name: 'ESTADIO' }
```

Ojo con un efecto secundario deseable: `GAME_META` también alimenta el icono del modal
(`public/app.js:621` y `:651`), así que agregar la entrada no rompe nada y completa la identidad
visual del Estadio en el resto del sitio.

#### Hallazgo 4 — la vía de migración a Postgres está rota de punta a punta (el más grave)

El documento decía: *«agregar el DDL a `scripts/migrate-db.js` con guardas `IF NOT EXISTS`,
siguiendo el estilo de las migraciones existentes»*. **Las tres partes de esa frase son falsas.**

Lo que hay realmente:

1. `scripts/migrate-db.js` **no contiene DDL**: es un *runner* bien escrito que lee archivos
   `migrations/*.sql` (regex `/^\d+_[a-z0-9_-]+\.sql$/i`), los ordena, verifica checksums contra
   `montecristo_schema_migrations`, toma un `pg_advisory_lock` y aplica cada uno en una transacción.
   El DDL va en `migrations/`, no en el runner.
2. **El directorio `migrations/` no existe y nunca se commiteó.** Correr hoy
   `npm run migrate:db` falla con:
   ```
   ENOENT: no such file or directory, scandir 'migrations'
   ```
   No hay «migraciones existentes» cuyo estilo seguir.
3. **Nada ejecuta el runner.** Ni `server.js` ni `lib/` llaman a `migrate()`, y `render.yaml` tiene
   `buildCommand: npm install --omit=dev` y `startCommand: npm start`: ninguna fase de deploy corre
   migraciones. Aunque se creara `migrations/001_football.sql`, **las tablas nunca se crearían en
   producción**.

El efecto sobre las seis tablas del Estadio sería total: el store PG arrancaría, la primera consulta
fallaría con `relation "football_matches" does not exist`, y el watchdog de arranque (§15.6) pondría
el motor en cuarentena. La sección no funcionaría en absoluto con `DATABASE_URL` activa.

**Y esto no es un problema nuevo del Estadio — es un bug preexistente del repo.** Siete tablas que
usan seis stores PG no las crea nadie:

| Tabla | Store que la usa | ¿Quién la crea? |
| --- | --- | --- |
| `montecristo_account_sessions` | `account-session-store-pg.js` | **Nadie** |
| `montecristo_admin_idempotency` | `idempotency-store-pg.js` | **Nadie** |
| `montecristo_audit_log` | `audit-store-pg.js` | **Nadie** |
| `montecristo_moderation_actions` | `moderation-store-pg.js` | **Nadie** |
| `montecristo_password_reset_challenges` | `password-reset-store-pg.js` | **Nadie** |
| `montecristo_reports` / `montecristo_report_evidence` | `report-store-pg.js` | **Nadie** |
| `montecristo_profiles` / `montecristo_seasons` | `profile-store-pg.js` | ✅ El propio store, inline |

**Por qué nadie lo notó:** esos seis stores están detrás del flag administrativo, que nace apagado y
*fail-closed*. `createAuditStore(config)` hace `if (!config?.enabled) return null;` antes de tocar
Postgres. Con `ADMIN_FEATURE_ENABLED` apagado (el valor por defecto), esos stores nunca se
instancian y las tablas ausentes nunca se consultan. Es un fallo **latente**: el día que alguien
encienda la administración con `DATABASE_URL` puesta, los seis stores se construyen y fallan en su
primera consulta.

`profile-store-pg.js` es la única excepción, y la única que funciona en producción hoy, precisamente
porque **crea sus tablas inline** con `CREATE TABLE IF NOT EXISTS` al construirse.

**Corrección adoptada para el Estadio (decisión A4).** Seguir el único precedente que funciona:

```js
// lib/football-store-pg.js, en el constructor / ensureSchema()
await pool.query(`CREATE TABLE IF NOT EXISTS football_leagues (…)`);
await pool.query(`CREATE TABLE IF NOT EXISTS football_matches (…)`);
// … las 6 tablas
```

Razones, en orden de peso:

- Es el patrón del único store PG que hoy funciona de punta a punta sin intervención manual.
- Cero cambios en `render.yaml`: no hay que tocar el deploy para que la feature exista.
- Es idempotente y seguro en arranques concurrentes (`IF NOT EXISTS`), igual que los perfiles.
- El runner de migraciones, aun si se arreglara, no corre en ningún deploy.

**Costo aceptado y su límite.** `CREATE TABLE IF NOT EXISTS` crea, pero **no altera**. Si el esquema
del Estadio necesita evolucionar (una columna nueva, un índice), el patrón inline no alcanza y habrá
que arreglar la vía de migraciones: crear `migrations/`, escribir los `.sql`, y agregar
`preDeployCommand: npm run migrate:db` a `render.yaml`. Eso queda registrado como R24 y como
prerrequisito de la **primera** alteración de esquema, no de la Fase A.

**Fuera del alcance de este documento, pero hay que reportarlo:** arreglar el runner de migraciones y
escribir el DDL faltante de las siete tablas administrativas. Es un bug preexistente, independiente
del Estadio, y toca la administración — no debe mezclarse con esta feature. Se registra como A5.

#### Hallazgo 5 — el fail-closed de la admin funciona por accidente de posición, no por mecanismo

El documento prescribía para la validación de `FOOTBALL_*`: *«Si algo falla: `process.exit(1)` con
mensaje claro, igual que la admin»*. **La admin no hace eso.** `lib/admin-config.js` no contiene una
sola llamada a `process.exit`; termina con:

```js
if (errors.length) {
  throw new Error(`Configuración administrativa insegura:\n- ${errors.join('\n- ')}`);
}
```

Y ese `throw` **sí** mata el proceso, pero solo por dónde está parado:

| Línea | Qué ocurre |
| --- | --- |
| `server.js:35` | `const adminConfig = loadAdminConfig();` → si la config es inválida, **throw** |
| `server.js:60` | `process.on('uncaughtException', …)` instala la red que **mantiene el proceso vivo** |

La validación corre en la línea 35, **antes** de que exista la red de la línea 60. Por eso el throw
llega hasta Node sin interceptor y el proceso muere con su stack: fail-closed real.

**El peligro de copiar el patrón sin entenderlo.** Si la validación de `FOOTBALL_*` se pusiera en
cualquier punto del módulo **después** de la línea 60, el mismo `throw` sería tragado por la red:

```
[CRITICO] Excepción no capturada (el servidor sigue vivo): …
```

El proceso seguiría vivo con el resto del módulo sin evaluar —sin `server.listen()`, sin rutas, sin
sockets—: un zombi que no responde `/healthz`. Render lo reiniciaría en bucle con un mensaje que
dice «el servidor sigue vivo» mientras el servidor está muerto. **Fail-closed convertido en
fail-open por 25 líneas de distancia.**

**Corrección adoptada (decisión A6).** La validación de `FOOTBALL_*` va en
`lib/football-config.js` y se invoca en uno de estos dos lugares, ambos verificados:

1. **Junto a `loadAdminConfig()`, antes de la línea 60** — mismo mecanismo (`throw`), misma garantía.
2. **Dentro de `bootstrap()`**, cuyo `catch` ya hace `process.exit(1)` explícito:
   ```js
   bootstrap().catch(error => { console.error('No se pudo iniciar MonteCristo:', error); process.exit(1); });
   ```

Lo que **no** se hace: lanzar la validación desde cualquier otro punto del cuerpo del módulo. Se
agrega T30 para que la posición quede fijada por una prueba y no por un comentario.

#### Hallazgo 6 — la protección contra R1 estaba puesta en el lugar equivocado (invalida la mitigación de R1)

Este no es una cita falsa: es un **defecto de diseño del propio documento**, y afecta al riesgo que el
documento señalaba como el más importante de toda la integración.

§12.6 y §15.5 prescribían: *que `seasonSweep` consulte `footballEngine.hasOpenBets(month)` y posponga
el reset*. La premisa implícita es que `seasonSweep` (`server.js:2220`) es el único camino que reinicia
las fichas. **No lo es.** El reset vive dentro de `ensureSeason()`, en
`lib/profile-store-base.js:94`, y ese método tiene un segundo disparador:

```js
// lib/profile-store-base.js:177
getOrCreate(id, name, avatar) {
  this.ensureSeason(); // Fase 8.7: verifica el cambio de mes en cada acceso.
```

`getOrCreate()` se llama en cada conexión de socket y en cada acceso a un perfil. O sea: **el primer
jugador que reconecte a las 00:00:00.3 del día 1 dispara el reset**, mucho antes de que el
`seasonSweep` de 5 minutos llegue a correr. Poner la guarda en `seasonSweep` protege un camino y deja
el otro —que es el que casi siempre gana la carrera— completamente abierto. Los stakes escrow-eados se
evaporan igual, y el `logEvent('season_reset_deferred')` que debía avisar nunca se emite porque la
función que lo emitía no llegó a ejecutarse.

**Segunda parte del defecto, y es de vivacidad.** Aun moviendo la guarda al lugar correcto, un veto
sin límite congela el casino: basta **una** apuesta atascada (partido en cuarentena por §15.2, bug,
crash a mitad de liquidación) para que `hasOpenBets()` devuelva `true` para siempre. El reset mensual
no correría nunca, la temporada no cerraría, no habría podio ni medallas ni banner, y las fichas de
todos los jugadores quedarían congeladas en el mes anterior. Un módulo nuevo y opcional tendría
poder de veto permanente sobre la economía central del casino. Eso es peor que el bug que se quería
evitar.

**Corrección adoptada (decisión A7).** La guarda va **dentro del camino del reset**, no en un
consumidor del reset, y es **acotada**:

1. `lib/profile-store-base.js` gana un punto de extensión mínimo (~12 líneas), compartido por los dos
   backends porque ambos heredan `ensureSeason()`:
   ```js
   // registro
   onBeforeSeasonReset(fn) { this._seasonResetGates.push(fn); }

   // dentro de ensureSeason(), justo después de detectar el cambio de mes
   // y ANTES de tocar cualquier profile.chips:
   for (const gate of this._seasonResetGates) {
     const verdict = gate({ closingMonth: this.seasons.current, openingMonth: now });
     if (verdict?.defer) {
       this._seasonResetDeferrals = (this._seasonResetDeferrals || 0) + 1;
       if (this._seasonResetDeferrals <= SEASON_RESET_MAX_DEFERRALS) {
         return { type: 'deferred', month: this.seasons.current, reason: verdict.reason,
                  deferrals: this._seasonResetDeferrals };
       }
       verdict.forceSettle?.();   // último recurso: liquidar/void + reembolsar YA
     }
   }
   this._seasonResetDeferrals = 0;
   ```
2. El motor del Estadio registra **un** gate: `defer` mientras queden apuestas abiertas del mes que
   cierra; `forceSettle` las anula y reembolsa al contado cuando se agota el presupuesto.
3. `SEASON_RESET_MAX_DEFERRALS` acota el veto. Con barridos de 5 min, `12` da ~1 h de margen —de sobra
   para liquidar 240 apuestas— y garantiza que el reset **siempre** termina ocurriendo. La propiedad
   que importa: **el fútbol puede retrasar el reset, nunca impedirlo.**
4. `server.js` ya no necesita la guarda en `seasonSweep`: el nuevo `type:'deferred'` se trata ahí solo
   para loguear (`season_reset_deferred`) y reintentar en el siguiente barrido. `getOrCreate()`
   reintenta solo, porque vuelve a llamar a `ensureSeason()` en el próximo acceso.

Costo real: ~12 líneas en `lib/profile-store-base.js` + ~20 en el motor + ~6 en `server.js`, en vez de
las ~10 en `server.js` que prometía el documento. A cambio, la protección cubre **los dos** caminos y
no puede congelar el casino. Cubierto por T31 (reset vía `getOrCreate` respetando el gate) y T32
(vivacidad: el veto acotado termina cediendo).

#### Hallazgo 7 — el `debit()` que prescribe §12.1 no persiste nada, y la apuesta sí

Este es el hallazgo que **crea dinero de la nada**, y estaba enterrado en la sección que el documento
trataba como ya resuelta.

`lib/progression.js` es un módulo **puro**: su único `require` en todo el archivo es

```js
const { HISTORY_LIMITS } = require('./profile-store-shared');
```

No tiene referencia al store. Ni `credit()` ni el `debit()` que propone §12.1 pueden persistir: solo
mutan el objeto `profile` en memoria. La durabilidad la aporta **el llamador**, y esa es la convención
real del repo, visible en los tres sitios que hoy mueven fichas:

```js
// server.js:589-590 — completePlayerRound
const events = recordOutcome(player._profile, { game: room.game, net: finalNet, eligible: … });
if (!player.isBot) profiles.touch(player._profile);        // ← la persistencia vive AQUÍ

// server.js:1091 — premio de torneo
credit(winner._profile, t.prize, 'Premio del torneo sit & go'); profiles.touch(winner._profile);

// server.js:316 — el setter de player.chips
set: value => { profile.chips = …; profiles.touch(profile); }   // ← por eso executeQuickBet sí persiste
```

`touch(profile)` hace `profile.updatedAt = Date.now(); this.scheduleSave()`, y `scheduleSave()` es un
**debounce de 180 ms** (`profile-store-base.js:27`). `executeQuickBet` funciona sin escribir `touch`
solo porque asigna a `player.chips`, que pasa por el setter. **Mi `debit()` recibe el `profile`
crudo, no el `player`, así que no pasa por ningún setter.**

El listado de §12.1 no menciona `touch()` en ninguna parte, y el punto 3 de «Tres diferencias
deliberadas» discute `profile.transactions` sin mencionar nunca la durabilidad. La única aparición de
`profiles.touch` en todo el documento estaba en una tabla comparativa. Un implementador que siguiera
el documento al pie de la letra escribiría el débito, lo llamaría desde la colocación de apuesta, y
**el descuento de fichas viviría solo en memoria** hasta que algún otro camino tocara ese perfil.

**Por qué eso crea dinero.** §13.2 asigna durabilidades distintas a las dos mitades de una misma
operación:

| Mitad | Durabilidad según el documento |
| --- | --- |
| Fila de la apuesta (`football_bets`) | **Write-through inmediato** — «es dinero» |
| Débito de las fichas (`profile.chips`) | Debounce de 180 ms, **y solo si alguien llama a `touch()`** |

La apuesta es duradera al instante; el débito no. Un crash en esa ventana —o simplemente un servidor
ocioso donde nada toca ese perfil— deja **la apuesta persistida y las fichas sin descontar**. Al
reiniciar, §15.6 liquida esa apuesta contra un saldo que todavía contiene el stake. El jugador cobra
un premio por fichas que nunca pagó. Es la dirección más peligrosa de las dos: el otro orden
(débito duradero, apuesta perdida) le cuesta el stake a un jugador y se nota; este le cuesta fichas a
la casa y no lo nota nadie.

**Segunda mitad del defecto: TOCTOU en la propia colocación.** El camino natural es asíncrono, y el
orden ingenuo abre una carrera:

```js
if (stake > profile.chips) return reject;   // comprueba
await footballStore.insertBet(bet);         // ← AWAIT: otro request entra aquí
debit(profile, stake, reason);              // debita contra un saldo ya stale
```

Dos apuestas simultáneas del mismo perfil pasan ambas la comprobación contra el mismo saldo y ambas se
debitan después. `executeQuickBet` no tiene este bug porque es **enteramente síncrono**: comprueba y
asigna sin ningún `await` en medio. Cualquier camino de apuesta que inserte en el store antes de
debitar pierde esa propiedad.

**Corrección adoptada (decisión A8).** Dos reglas, ambas con precedente en el repo:

1. **Intención antes que dinero, y confirmación después.** La fila de apuesta nace en
   `status:'pending'`, luego se debita, luego se confirma a `'open'`. Es el mismo patrón de dos fases
   que ya usa `MemoryIdempotencyStore` (`state:'processing'` → `'completed'`) y que `applyMfaResetAtomic`
   materializa en SQL con `WHERE … AND state='processing'` + `if(!completed.rowCount) throw`.
   El débito y su `touch()` van **entre** dos escrituras del store, sin `await` entre la comprobación
   de saldo y el `debit()`:
   ```js
   const claim = await idempotency.begin({ … });                 // 1. intención
   if (claim.state !== 'started') return replay(claim);
   await footballStore.insertBet({ …bet, status: 'pending' });   // 2. WAL de la apuesta
   if (stake > profile.chips) return rejectAndVoid(bet);         // 3. comprueba…
   const d = debit(profile, stake, 'Apuesta Estadio');           // 4. …y debita SIN await entre medio
   if (!d.ok) return rejectAndVoid(bet);
   profiles.touch(profile);                                      // 5. OBLIGATORIO: agenda la durabilidad
   await footballStore.confirmBet(bet.id);                       // 6. pending → open
   await idempotency.complete({ … });
   ```
   Si el proceso muere entre 2 y 6 queda un `pending` huérfano, que es **inofensivo**: la
   reconciliación de arranque (§15.6) lo anula. Nunca queda una apuesta viva sin débito.

2. **En Postgres, una sola transacción sobre las dos tablas.** El repo ya hace exactamente esto en
   cuatro sitios (`applyMfaResetAtomic`, `moderation-store.applyAtomic`,
   `password-reset-store.consumeAndApply`, `report-store.updateWithAudit`), todos con
   `BEGIN` / varias tablas / `COMMIT` sobre **un mismo `client`**. Y `consumeAndApply` muestra el
   cerrojo correcto para read-modify-write de un perfil:
   ```sql
   SELECT data FROM montecristo_profiles WHERE id=$1 FOR UPDATE
   ```
   `FOR UPDATE` serializa además las apuestas concurrentes del mismo perfil, cerrando el TOCTOU de
   raíz. Para compartir el `client` hace falta que `football-store-pg` reciba el pool del store de
   perfiles en vez de crear el suyo — patrón ya existente en `password-reset-store-pg.js`:
   `constructor(connectionString, pepper, { pool } = {}) { this.ownsPool = !pool; this.pool = pool || new Pool(…) }`,
   con `profiles.pool` disponible en el backend PG.

**Consecuencia para §13.2:** la frase «con Postgres, las escrituras de dinero son transaccionales»
era cierta **dentro de cada store** y falsa **entre** stores. Con A8 pasa a ser cierta también entre
ellos. Con el backend de archivo no hay transacciones posibles, y la garantía la da el orden
WAL + la reconciliación de arranque, no el disco.

**Nota de alcance.** `lib/progression.js` **sigue siendo puro**: no se le inyecta el store. La
convención del repo es que el llamador persiste, y romperla para esta feature habría hecho que
`debit()` fuera el único mutador de fichas con un contrato distinto al de `credit()`. Lo que se
corrige es el documento, que no decía que hubiera que llamar a `touch()`.

#### Hallazgo 8 — `credit(payout) + recordOutcome(net)` contabiliza cada liquidación dos veces

§12.3 prescribe el seudocódigo de liquidación como `credit(profile, payout) + recordOutcome(...)`.
Leídas las dos funciones, esa combinación **escribe el historial dos veces**:

```js
function credit(profile, amount, reason) {
  profile.chips += amount;
  addTransaction(profile, amount, reason);   // ← línea 1: payout BRUTO
  snapshotBalance(profile);                  // ← punto 1 en la gráfica
}

function recordOutcome(profile, { game, net = 0, eligible = true } = {}) {
  // …actualiza stats, rachas, trackPeriod, gameStats…
  // NO escribe profile.chips en ningún punto (verificado: cero apariciones de `chips`)
  addTransaction(profile, net, `Ganancia en ${game}`);   // ← línea 2: neto
  snapshotBalance(profile);                              // ← punto 2 en la gráfica
}
```

Cada apuesta liquidada produciría **dos entradas en `profile.transactions` y dos puntos en
`balanceHistory`**. Y contradice frontalmente lo que §12.1 afirma dos páginas antes: *«el débito no
genera entrada en `profile.transactions`; el movimiento se explica al liquidar, con el `net` de
`recordOutcome`»*. Las dos secciones son correctas por separado y mutuamente excluyentes —el mismo
patrón que los hallazgos 6 y 7.

El agravante es el techo del historial: `HISTORY_LIMITS = { transactions: 20, balance: 60 }` con el
backend de archivo (`profile-store-shared.js:28`), elevado a 500/2000 solo con Postgres
(`server.js:2338`). Duplicar cada liquidación **empuja fuera del historial el doble de rápido**, así
que con el backend de archivo un jugador ve sus últimas ~10 apuestas en vez de ~20.

**La convención real del casino no usa `credit()` para pagar.** `awardSinglePokerWinner`
(`server.js:952`) hace:

```js
player.chips += payout;                       // mueve fichas (pasa por el setter → touch)
completePlayerRound(room, participant, baseNet);   // → recordOutcome(net) + profiles.touch()
```

O sea: **asignación directa para mover fichas, `recordOutcome` como única línea de historial**. El
mismo patrón en `:580`, `:1282`, `:1571`, `:1593`. `credit()` se usa para premios que no pasan por
una ronda (`:1091`, torneo sit & go), donde no hay `recordOutcome` que duplicar.

**Corrección adoptada (decisión A9).** La liquidación del Estadio replica la convención de las rondas:

```js
profile.chips += payout;                                     // sin addTransaction
const events = recordOutcome(profile, { game: 'football', net: payout - stake, eligible: false });
profiles.touch(profile);                                     // §12.7 h.7: obligatorio
```

Una sola línea de historial (el neto), un solo punto en la gráfica, y coherente con §12.1. El
reembolso por anulación (§12.4) sí usa `credit(profile, stake, 'Anulación: partido pospuesto')`
**sin** `recordOutcome`, porque no hay resultado deportivo que registrar: es la misma distinción que
hace el casino entre `:1091` y `:952`.

De paso, esto corrige una afirmación de §4: *«las fichas solo se mueven dentro de `lib/progression.js`»*
es falsa. `server.js` mueve fichas directamente en al menos cinco sitios. La invariant real es más
débil y más útil: **toda mutación de fichas pasa por el setter `player.chips` o va acompañada de
`profiles.touch()`**, que es lo que garantiza que se persista (hallazgo 7).

#### Hallazgo 9 — subir `TOS_VERSION` solo en el servidor bloquea el casino entero sin salida visible

§16 fila 10 prescribe: *`lib/terms.js:6` `TOS_VERSION` → subir la versión*. **Ese cambio incompleto
deja a todos los jugadores fuera, sin que aparezca el modal para volver a aceptar.** La versión está
duplicada a propósito en el cliente:

```js
// public/app.js:80-81
// Debe coincidir con TOS_VERSION en lib/terms.js; al cambiar, se pide aceptar de nuevo.
const TOS_VERSION = '2026-09-28';
```

y el cliente la usa para las dos puntas del protocolo:

```js
function tosAccepted() { return localStorage.getItem(TOS_KEY) === TOS_VERSION; }   // :87
if (!tosAccepted()) showTosModal();                                                // :105
emitAck('account_signup', { …, tos: TOS_VERSION })                                  // :2189
```

El servidor, por su lado (`server.js:371`):

```js
function verifyTosAcceptance(profile, tosVersion) {
  if (String(tosVersion || '') === TOS_VERSION) { …marcar aceptado…; return true; }
  return profile.flags?.tosVersion === TOS_VERSION;      // lo que el perfil ya tenía
}
```

Si se sube **solo** `lib/terms.js`, en el siguiente deploy pasa esto:

| Paso | Resultado |
| --- | --- |
| Cliente con bundle viejo/nuevo sin tocar | `TOS_VERSION` cliente sigue en `2026-09-28` |
| `tosAccepted()` | `localStorage` tiene `2026-09-28` → **`true`** → **el modal nunca aparece** |
| Cliente envía `tos: '2026-09-28'` | servidor compara contra la versión **nueva** → no coincide |
| `verifyTosAcceptance` cae al `return` final | `profile.flags.tosVersion` es la vieja → **`false`** |
| Las 6 entradas que la consultan (`:1701`, `:1722`, `:1751`, `:1795`, `:1859`, `:1980`) | `ackError(ack, TOS_REQUIRED_MESSAGE)` |

Resultado: **«Debes aceptar los Términos y Condiciones vigentes para jugar» en cada acción, y ninguna
pantalla para aceptarlos.** El jugador no tiene forma de salir: el cliente cree que ya aceptó. Es un
lockout total y silencioso, y lo provoca exactamente el cambio que la decisión B1 manda hacer.

Nótese que `/healthz` ya publica `tosVersion` (`server.js:122`), así que el cliente *podría* leer la
versión autoritativa del servidor; no lo hace, la tiene hardcodeada.

**Corrección adoptada (decisión A10).** Subir la versión es un cambio de **dos archivos en el mismo
commit**: `lib/terms.js:6` **y** `public/app.js:81`. Se agrega T36 como prueba de bloqueo, que lee
ambas constantes y falla si difieren — es la única forma de que el olvido se detecte antes del deploy
y no después. Y se documenta en §16 fila 10 y en la Fase F, porque B1 («lanzarla junto con la
sección») depende de que ese par viaje siempre junto.

Queda señalado, fuera del alcance de esta feature: la duplicación hardcodeada es frágil por diseño.
Que el cliente consuma `tosVersion` del payload de arranque eliminaría la clase de bug entera. Es una
mejora del casino, no del Estadio (A5, mismo criterio).

#### Hallazgo 10 — §14 nunca dice cómo `token` se vuelve `profile`, y el camino obvio regala fichas infinitas

La tabla de §14.1 define `football:bet` con payload `{ matchId, market, selection, stake, idemKey, token }`
y una columna «Valida» que dice *saldo, límites, mercado abierto, no suspendido, retardo en vivo*.
**En ningún lugar del documento se dice cómo se pasa de `token` a `profile`.** Ese hueco es el
hallazgo, porque el camino obvio —copiar el único handler room-less que existe— abre tres agujeros a
la vez.

El precedente room-less es `lobby_chat_join` (`server.js:1855-1864`):

```js
const chatProfile = profiles.profiles.get(id);          // lectura estricta, solo para validar el nombre
const lobbyIssue = nameIssue(name, { room: roomOfProfile(chatProfile), exceptId: id });
if (lobbyIssue) return ackError(ack, lobbyIssue);
const profile = profiles.getOrCreate(id, name);          // ← AQUÍ se crea
if (!verifyTosAcceptance(profile, tos)) return ackError(ack, TOS_REQUIRED_MESSAGE);
```

Y `getOrCreate` (`profile-store-base.js:177`) **crea** cuando el id no existe:

```js
getOrCreate(id, name, avatar) {
  this.ensureSeason();
  id = String(id || '').slice(0, 80);
  let profile = this.profiles.get(id);
  if (!profile) {
    profile = cleanProfile({ id, name, avatar, chips: INITIAL_CHIPS });   // 1000 fichas gratis
    this.profiles.set(id, profile);
  } else { … }
  this.touch(profile);
  return profile;
}
```

con `INITIAL_CHIPS = 1000` (`profile-store-shared.js:7`) y `cleanProfile` defaulteando el nombre a
`'Jugador'` cuando no llega ninguno. En el chat eso es **legítimo**: es la puerta de entrada al
casino, y está protegida por `nameIssue` (unicidad global) y por `verifyTosAcceptance`. Puesto en un
handler de apuesta, es una catástrofe en tres frentes:

**1. Fichas infinitas.** El `token` es un string que elige el cliente. Si `football:bet` resuelve con
`getOrCreate(token)`, cada token inventado llega con **1000 fichas nuevas**. Con el tope del 25 %
(decisión C5) son 250 fichas apostables por token, y no hay ningún límite de cuántos tokens se pueden
inventar. Un bucle `for (i=0;;i++) emit('football:bet', { token: 'x'+i, stake: 250, … })` es una
fuente inagotable de saldo. Los límites de §11.5 (20 apuestas abiertas y 50.000 de exposición **por
perfil y partido**) no lo frenan: se aplican por perfil, y cada request trae un perfil nuevo. La casa
queda expuesta sin techo real, y el flujo simulado de §11.6 —calibrado sobre `realTotal`— se distorsiona
porque `realTotal` cuenta apostadores que no existen.

**2. Contaminación del podio mensual.** `_rankedProfiles()` ordena `[...this.profiles.values()]`, o
sea **todos** los perfiles, sin filtrar. Un perfil sintético llamado `'Jugador'` con fichas ganadas
puede quedar primero en el cierre de temporada: `ensureSeason()` le suma `winner.medals++` y le marca
`championBanner = true`, y su nombre aparece en el podio público y en el banner dorado. Y como
`nameIssue` no corre en el camino ingenuo, nada impide miles de perfiles `'Jugador'` idénticos,
rompiendo la invariant de unicidad global que `findProfileByName` existe para proteger (ver el
comentario de `server.js:207`).

**3. Crecimiento sin cota del store.** Cada perfil falso se persiste. Con el backend de archivo,
`saveNow()` reescribe el JSON **completo** en cada guardado (`profile-store.js:40`), así que inundar
tokens convierte cada debounce de 180 ms en una escritura de un archivo que no para de crecer: DoS de
disco sin necesidad de tumbar nada. `pruneInactiveAccounts` limpia a los 90 días
(`INACTIVITY_LIMIT_MS`, `profile-store-shared.js:34`), que es mucho después del cierre mensual donde
esos perfiles ya contaminaron el podio.

**Corrección adoptada (decisión A11).** El repo ya tiene el patrón correcto, y es el mismo que usa el
chat para su segundo handler: **resolver la identidad una sola vez y después leerla del socket**.
`lobby_chat` (`server.js:1866`) nunca vuelve a mirar el token:

```js
socket.on('lobby_chat', ({ text } = {}, ack) => {
  const author = socket.data.lobbyChat;
  if (!author) return ackError(ack, 'Primero elige un apodo y acepta los Términos para entrar al chat.');
```

El Estadio replica eso:

1. **`football:subscribe` es la única puerta que crea identidad.** Resuelve con `getOrCreate` **pero**
   pasando por `nameIssue` (unicidad global) y `verifyTosAcceptance`, exactamente como
   `lobby_chat_join`, y guarda `socket.data.football = { profileId }`.
2. **Los cuatro handlers de dinero (`bet`, `cashout`, `parlay`, `future`) no reciben `token` en el
   payload.** Leen `socket.data.football` y rechazan si no está:
   ```js
   const identity = socket.data.football;
   if (!identity) return ackError(ack, 'Primero entra al Estadio para apostar.');
   const profile = profiles.profiles.get(identity.profileId);   // lectura ESTRICTA: nunca getOrCreate
   if (!profile) return ackError(ack, 'Tu sesión expiró: vuelve a entrar al Estadio.');
   ```
   `profiles.profiles.get(id)` es la lectura estricta que el repo ya usa en los cinco sitios donde
   crear sería un error: `server.js:1640`, `:1855`, `:1921`, `:1955`, `:1973`.
3. **Regla general que queda escrita:** en el Estadio, `getOrCreate` aparece **una sola vez** (en
   `football:subscribe`); en cualquier otro handler es un bug. Y ningún handler de dinero acepta un
   identificador elegido por el cliente en el payload.

Esto cambia la tabla de §14.1: `token` sale de `football:bet`, `football:cashout`, `football:parlay`
y `football:future`. También hace que la autenticación de cuenta existente (`socket.data.accountProfileId`,
`server.js:1643`) sea compatible: si el socket ya está autenticado, `football:subscribe` puede tomar
el perfil de ahí en vez de exigir token.

Nota: `getOrCreate` llama a `ensureSeason()` en su primera línea, así que cada subscribe también
dispara la comprobación de cambio de mes. Con la guarda del hallazgo 6 puesta **dentro** de
`ensureSeason()`, ese camino queda cubierto automáticamente — otra razón por la que la guarda debía ir
ahí y no en `seasonSweep`.

#### Hallazgo 11 — ambos backends disparan el reset antes de que `bootstrap()` pueda registrar la guarda (y producción es Neon/PG)

Este lo destapó la pregunta por el apagón prolongado (§15.9), y **anula la decisión A7 en el camino
más importante de todos**: el arranque tras una caída que cruza fin de mes.

> **Corregido contra el código (2026-10-07).** La primera versión de este hallazgo afirmaba que
> producción corre el backend de **archivo** y que el PG era inmune. **Las dos premisas eran falsas**
> y se corrigen aquí: producción corre **PG/Neon**, y PG **no** es inmune. El mecanismo es el mismo
> en ambos backends y el que falla es justo el de producción.

A7 puso la guarda dentro de `ensureSeason()` para cubrir los dos disparadores conocidos
(`seasonSweep` y `getOrCreate`). Pero hay un **tercero**, y corre antes que el fútbol exista:

```js
// lib/profile-store.js:11-18 — backend de ARCHIVO
class ProfileStore extends BaseProfileStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'profiles.json')) {
    super();
    this.backend = 'file';
    this.filePath = filePath;
    this.load();
    this.ensureSeason();      // ← reset de TODAS las fichas, dentro del constructor
  }
```

Y `bootstrap()` construye el store en su **primera línea**:

```js
async function bootstrap() {
  profiles = await createProfileStore(process.env.PROFILE_STORE_PATH);   // ← ensureSeason() ya corrió
  accountSessionStore = createAccountSessionStore(adminConfig);
  …                                                                      // el fútbol se crea mucho después
```

Es un huevo y una gallina: la guarda se registra **sobre** el store (`store.onBeforeSeasonReset(fn)`),
así que necesita que el store exista; pero el store ya ejecutó el reset antes de devolver la
instancia. **Ningún orden de registro dentro de `bootstrap()` puede llegar a tiempo.**

Y no es un problema del backend de archivo nada más. El PG hace exactamente lo mismo, solo que dentro
de `_init()` en vez del constructor:

```js
// lib/profile-store-pg.js — backend PG/Neon
constructor(connectionString, options = {}) {
  …
  this.ready = this._init();      // :102 — el factory espera esta promesa
}
async _init() {
  await withRetries(() => this.pool.query(SCHEMA_SQL), …);   // crear tablas
  await withRetries(() => this._loadOnce(), …);              // cargar perfiles
  this.ensureSeason();                                       // :116 ← reset, igual que en archivo
}

// lib/profile-store-factory.js:15-19
if (databaseUrl) {
  const store = new PgProfileStore(databaseUrl, poolOptions);
  await store.ready;               // ← espera _init(), que YA llamó a ensureSeason()
  return store;
}
```

Tres hechos que lo vuelven el caso de producción real y no una curiosidad:

1. **Producción corre PG/Neon.** `DATABASE_URL` no aparece en `render.yaml` porque vive en el
   *dashboard* de Render apuntando a Neon; el blueprint solo lista lo declarado ahí
   (`PROFILE_STORE_PATH`, `NODE_ENV`, `CASINO_TIME_ZONE`). Con `DATABASE_URL` presente,
   `createProfileStore` (`profile-store-factory.js:14`) toma la rama PG. **El backend afectado es el
   de producción**, no el de archivo.
2. **PG no es inmune.** El constructor no llama a `ensureSeason()`, pero `_init()` sí
   (`profile-store-pg.js:116`), y la fábrica hace `await store.ready` (`:18`) **antes** de devolver el
   store a `bootstrap()`. O sea: el reset corre durante el arranque en **ambos** backends —en archivo
   dentro del constructor, en PG dentro de `_init()`— y en ambos gana la carrera contra la guarda. La
   diferencia de forma no cambia el fondo.
3. El escenario que lo dispara es exactamente el de la pregunta: **un apagón de varios días que cruza
   el fin de mes**. Al arrancar, `_init()` (o el constructor, en archivo) detecta el cambio de mes y
   pone a todos en `INITIAL_CHIPS = 1000` antes de que el fútbol pueda reclamar sus stakes
   escrow-eados. Es R1/R27 materializado por una tercera vía que A7 no cubría.

**Corrección adoptada (decisión A12).** Sacar el chequeo de temporada de los dos caminos de arranque
—el constructor de archivo y el `_init()` de PG— y volverlo un paso explícito de `bootstrap()`,
**después** de registrar la guarda y **después** de reconciliar el fútbol. `deferSeasonCheck` se pasa
por el `poolOptions`/`options` que ambos constructores ya aceptan.

```js
// lib/profile-store.js — el constructor deja de llamar a ensureSeason()
constructor(filePath = …, { deferSeasonCheck = false } = {}) {
  super(); this.backend = 'file'; this.filePath = filePath; this.load();
  if (!deferSeasonCheck) this.ensureSeason();   // por defecto, idéntico a hoy
}

// lib/profile-store-pg.js — _init() deja de llamar a ensureSeason()
async _init() {
  await withRetries(() => this.pool.query(SCHEMA_SQL), …);
  await withRetries(() => this._loadOnce(), …);
  if (!this.deferSeasonCheck) this.ensureSeason();   // por defecto, idéntico a hoy
}

// server.js bootstrap() — orden explícito. El flag viaja en el options que la
// fábrica ya propaga a ambos constructores (databaseUrl sigue siendo el de Neon).
profiles = await createProfileStore(process.env.PROFILE_STORE_PATH, process.env.DATABASE_URL, { deferSeasonCheck: true });
…
await footballEngine.reconcile();        // 1. liquida contra los saldos que CONTIENEN los stakes
profiles.onBeforeSeasonReset(footballEngine.seasonGate);   // 2. registra la guarda
if (profiles.lastSeasonRepair) { … }     // 3. el chequeo que hoy vive tras createProfileStore
profiles.ensureSeason();                 // 4. AHORA sí: reset, con la guarda puesta
```

El orden 1→4 es el que importa: reconciliar **antes** del reset significa liquidar contra saldos que
todavía contienen los stakes escrow-eados. Con el orden actual, el reset va primero y la liquidación
paga sobre un saldo que ya no los tiene —que es R1 palabra por palabra.

`deferSeasonCheck` nace en `false`, así que **el comportamiento por defecto no cambia** y ningún test
existente se rompe: solo `bootstrap()` lo activa. La fábrica ya acepta un tercer parámetro
(`poolOptions`/`options`) que propaga a los dos constructores, así que el flag no necesita una firma
nueva. Costo: ~4 líneas en `lib/profile-store.js`, ~4 en `lib/profile-store-pg.js`, ~6 en `server.js`,
y mover el bloque `lastSeasonRepair` después de la llamada explícita.

**Nota sobre `lastSeasonRepair`.** `bootstrap()` ya inspecciona ese campo justo después de
`createProfileStore`, lo que prueba que el `ensureSeason()` del constructor tiene efectos observables
que el arranque consume después. Al diferirlo, ese bloque debe moverse tras la llamada explícita; si
no, leería un `lastSeasonRepair` todavía vacío y el aviso de calendario corregido se perdería en
silencio.

#### Lo que sí se verificó como cierto

| Afirmación del documento | Veredicto |
| --- | --- |
| `recordWager` no debita, solo registra estadística | ✅ Cierto, y su comentario lo confirma explícitamente |
| `recordOutcome` acepta una clave de juego arbitraria y crea `gameStats[game]` | ✅ Cierto |
| Las fichas se mueven por el setter `player.chips` → `profile.chips` con clamp y `touch` | ✅ Cierto (`server.js:316`) |
| `takeChips` permite all-in parcial | ✅ Cierto (`Math.min(player.chips, amount)`) — por eso no sirve para apuestas |
| `FixedWindowRateLimiter` existe y es reutilizable | ✅ Cierto (`lib/rate-limit.js`) |
| `MemoryIdempotencyStore` tiene `begin`/`complete` con detección de conflicto | ✅ Cierto |
| `snapshotBalance` alimenta la gráfica de evolución del saldo | ✅ Cierto |
| `verifyTosAcceptance` guarda la versión aceptada en `profile.flags` y hace `touch()` | ✅ Cierto (`server.js:371`) |
| Las 6 entradas de juego consultan `verifyTosAcceptance` antes de aceptar la acción | ✅ Cierto (`:1701`, `:1722`, `:1751`, `:1795`, `:1859`, `:1980`) |
| `/healthz` ya publica `tosVersion` | ✅ Cierto (`server.js:122`) — el cliente podría consumirla, pero la hardcodea en `app.js:81` |
| La convención real de pago de rondas es `player.chips += payout` + `completePlayerRound` | ✅ Cierto (`server.js:954`, y `:580`, `:1282`, `:1571`, `:1593`) |
| `recordOutcome` **no** escribe `profile.chips` en ningún punto | ✅ Verificado: cero apariciones de `chips` en su cuerpo |
| `credit()` escribe `addTransaction` + `snapshotBalance` además de mover fichas | ✅ Cierto (`progression.js:153`) — por eso duplica si se combina con `recordOutcome` |
| `HISTORY_LIMITS = { transactions: 20, balance: 60 }`, subido a 500/2000 solo con Postgres | ✅ Cierto (`profile-store-shared.js:28`, `server.js:2338`) |
| `executeQuickBet` es enteramente síncrono (por eso no tiene TOCTOU) | ✅ Cierto (`server.js:1305-1318`: ningún `await`) |
| El repo ya hace transacciones multi-tabla con un `client` compartido | ✅ Cierto: `applyMfaResetAtomic`, `moderation-store.applyAtomic`, `password-reset-store.consumeAndApply`, `report-store.updateWithAudit` |
| `password-reset-store-pg` acepta `{ pool }` y marca `ownsPool` | ✅ Cierto — es el patrón a replicar en `football-store-pg` (A8) |
| `profile-store-pg` ya expone `this.pool` | ✅ Cierto (`:93`) — no requiere cambios |
| `getOrCreate()` llama a `this.touch(profile)` al final | ✅ Cierto (`profile-store-base.js:188`) |
| `scheduleSave()` es un debounce de 180 ms con `unref()` | ✅ Cierto (`profile-store-base.js:27`, `:326`) |
| `saveNow()` de archivo escribe atómico (`.tmp` + `renameSync`) | ✅ Cierto (`profile-store.js:40`) |
| `saveNow()` de PG reintenta 3 veces y luego cada 10 s en segundo plano | ✅ Cierto (`profile-store-pg.js:150-178`) |
| La red `uncaughtException` mantiene el proceso vivo | ✅ Cierto (`server.js:60`) — de ahí el hallazgo 5 |
| `loadAdminConfig()` falla con `throw`, no con `process.exit` | ✅ Cierto (`admin-config.js:60`) — de ahí el hallazgo 5 |
| `ensureSeason()` reinicia `profile.chips` de todos los perfiles | ✅ Cierto (`profile-store-base.js:94`, bucle al final) |
| `seasonSweep` **no** tiene guarda de reentrancia (solo `try/catch` y `if (!profiles) return`) | ✅ Verificado — la guarda `sweepRunning` de §15.1 es código nuevo del Estadio, no una cita |
| `gracefulShutdown` sí tiene guarda (`shuttingDown`) y `SHUTDOWN_GRACE_MS` | ✅ Cierto (`server.js:2257`, `:2263`, `:2284`) |

**Lección para la Fase A**: ninguna afirmación de integración entra al código sin leer la función.
Las **once** falsas eran plausibles, estaban bien redactadas y habrían pasado una revisión
superficial. Ninguna habría fallado en pruebas unitarias del motor: todas fallaban **solo** al
conectarse con el código existente, que es justo lo que nadie prueba hasta que ya está en producción.

Y tres de ellas (6, 7 y 8) fallaban además al conectarse **consigo mismas**: dos secciones del
documento describían comportamientos incompatibles y cada una era correcta por separado. Eso no lo
detecta ninguna revisión sección por sección; solo se encuentra leyendo las dos funciones reales a la
vez, que es lo que se hizo aquí.

---

## 13. Persistencia

### 13.1 Patrón

`lib/football-store-factory.js` elige backend exactamente igual que `lib/profile-store-factory.js`:

- Sin `DATABASE_URL` → `football-store.js`, archivo JSON en `FOOTBALL_STORE_PATH`
  (por defecto `data/football.json`; en Render `/var/data/football.json`, junto a `profiles.json`).
- Con `DATABASE_URL` → `football-store-pg.js`.

Ambos comparten limpieza y normalización en `lib/football-store-shared.js`, igual que los perfiles.

### 13.2 Estrategia de guardado

El volumen de escritura es el riesgo principal: un partido en vivo cambia de estado 2 veces por
segundo.

| Dato | Cuándo se escribe |
| --- | --- |
| Liga, clubes, plantillas, calendario, tabla | Al generar la temporada y al cerrar cada jornada |
| Partido: `seed`, `kickoffAt`, `status`, `result` | En cada transición de estado (pocas) |
| Línea de tiempo completa | **No se persiste**: se regenera desde el seed. Ahorra ~40 KB por partido |
| Estado en vivo (`minute`, `score`, `revealedIndex`) | Debounce 10 s + en cada evento de alta relevancia |
| Apuestas, combinadas, futuros | **Write-through inmediato** (es dinero) |
| Liquidaciones | Write-through inmediato |
| Cuotas publicadas | Debounce 30 s + en cada cambio con razón `admin` o `liability_cap` |
| Auditoría de cuotas | Append al `audit-store` existente |

Con el backend de archivo, guardar es reescribir el JSON completo, así que el debounce es
obligatorio; con Postgres, las escrituras de dinero son transaccionales y el resto va en lote.
Igual que `profiles.saveNow()` en el apagado limpio, el store de fútbol debe tener su `saveNow()` y
su `close()` llamados desde `gracefulShutdown` (§15.7).

**Corrección (§12.7, hallazgo 7).** La frase anterior era cierta **dentro de cada store** y falsa
**entre** stores: la colocación de una apuesta toca dos —la fila en `football_bets` y el débito en
`profile.chips`— con durabilidades distintas (write-through inmediato vs. debounce de 180 ms que
además exige un `profiles.touch()` explícito). Esa asimetría es la que permite que sobreviva la
apuesta y no el débito. Se resuelve con la decisión A8:

- **Postgres:** las dos mitades en **una sola transacción** sobre un `client` compartido, con
  `SELECT data FROM montecristo_profiles WHERE id=$1 FOR UPDATE` —el patrón que ya usa
  `password-reset-store.consumeAndApply`, y que de paso serializa apuestas concurrentes del mismo
  perfil. Requiere que `football-store-pg` reciba el pool por parámetro en vez de crear el suyo,
  como ya hace `password-reset-store-pg.js` con `{ pool }` y `ownsPool`.
- **Archivo:** no hay transacciones posibles. La garantía la da el **orden WAL** (fila `pending` →
  débito + `touch` → `confirmBet`) más la reconciliación de arranque, que anula los `pending`
  huérfanos (§15.6, paso 4b). Nunca queda una apuesta viva sin débito.

### 13.3 Esquema Postgres

```sql
CREATE TABLE football_leagues (
  season_month   TEXT PRIMARY KEY,          -- '2026-10'
  seed           BIGINT NOT NULL,
  config         JSONB NOT NULL,            -- 16 clubes, formaciones, colores
  calendar       JSONB NOT NULL,            -- jornada → día → bloque → partidos
  standings      JSONB NOT NULL,
  status         TEXT NOT NULL,             -- active|closed|truncated
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);

CREATE TABLE football_matches (
  id              TEXT PRIMARY KEY,
  season_month    TEXT NOT NULL REFERENCES football_leagues(season_month),
  jornada         INT  NOT NULL,
  block           TEXT NOT NULL,
  featured        BOOLEAN NOT NULL DEFAULT false,
  home_id         TEXT NOT NULL,
  away_id         TEXT NOT NULL,
  seed            BIGINT NOT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  kickoff_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL,             -- scheduled|live|halftime|finished|settled|postponed
  score_home      INT, score_away INT,
  state           JSONB NOT NULL DEFAULT '{}'::jsonb,
  markets         JSONB NOT NULL DEFAULT '{}'::jsonb,
  exposure        JSONB NOT NULL DEFAULT '{}'::jsonb,
  settled_at      TIMESTAMPTZ
);
CREATE INDEX ON football_matches (season_month, status);
CREATE INDEX ON football_matches (status, scheduled_at);

CREATE TABLE football_bets (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,      -- ← exactly-once en la base
  profile_id      TEXT NOT NULL,
  match_id        TEXT NOT NULL REFERENCES football_matches(id),
  parlay_id       TEXT,
  market          TEXT NOT NULL,
  selection       TEXT NOT NULL,
  stake           INT  NOT NULL CHECK (stake > 0),
  odds_at_placement NUMERIC(6,2) NOT NULL,
  in_play         BOOLEAN NOT NULL DEFAULT false,
  minute_at_placement INT,
  status          TEXT NOT NULL DEFAULT 'open',  -- open|won|lost|void|cashed
  payout          INT,
  placed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ
);
CREATE INDEX ON football_bets (profile_id, status);
CREATE INDEX ON football_bets (match_id, status);

CREATE TABLE football_parlays (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, season_month TEXT NOT NULL,
  legs JSONB NOT NULL, combined_odds NUMERIC(8,2) NOT NULL, stake INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', payout INT,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(), settled_at TIMESTAMPTZ
);

CREATE TABLE football_futures (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, season_month TEXT NOT NULL,
  market TEXT NOT NULL, selection TEXT NOT NULL,
  odds NUMERIC(6,2) NOT NULL, stake INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', payout INT,
  placed_at_jornada INT NOT NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(), settled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ON football_futures_open ON football_futures (profile_id, market, selection)
  WHERE status = 'open';

CREATE TABLE football_odds_audit (
  id BIGSERIAL PRIMARY KEY, match_id TEXT NOT NULL, market TEXT NOT NULL,
  selection TEXT NOT NULL, odds_before NUMERIC(6,2), odds_after NUMERIC(6,2),
  reason TEXT NOT NULL, stake_trigger INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON football_odds_audit (match_id, created_at);
```

**Creación del esquema (corregido, §12.7 hallazgo 4).** Las seis tablas se crean **inline en
`lib/football-store-pg.js`** con `CREATE TABLE IF NOT EXISTS` al construir el store, igual que hace
`lib/profile-store-pg.js` — el único store PG que hoy funciona de punta a punta en producción.

**No** se usa `scripts/migrate-db.js`: ese archivo es un *runner* que lee `migrations/*.sql`, el
directorio `migrations/` no existe en el repo, y ningún deploy lo ejecuta (`render.yaml` solo corre
`npm install --omit=dev` y `npm start`). Una migración escrita ahí no se aplicaría nunca.

Límite aceptado: `IF NOT EXISTS` crea pero **no altera**. La primera vez que el esquema del Estadio
necesite una columna o un índice nuevo habrá que arreglar la vía de migraciones (crear `migrations/`,
escribir los `.sql`, agregar `preDeployCommand: npm run migrate:db` a `render.yaml`). Registrado como
R24; no es prerrequisito de la Fase A.

---

## 14. Protocolo

### 14.1 Socket.IO (cliente → servidor)

Todos con `ack` en la forma existente `{ ok, error?, code? }` vía `ackOk` / `ackError`.

| Evento | Payload | Valida |
| --- | --- | --- |
| `football:subscribe` | `{ scope: 'lobby' \| 'match', matchId?, name?, token, tos }` | **Única puerta que resuelve identidad**: `nameIssue` (unicidad global) + `verifyTosAcceptance` + rate limit + cupo. Guarda `socket.data.football = { profileId }` |
| `football:unsubscribe` | `{ scope, matchId? }` | — |
| `football:bet` | `{ matchId, market, selection, stake, idemKey }` | **Identidad desde `socket.data.football`, nunca del payload** (§12.7 h.10). Saldo, límites, mercado abierto, no suspendido, retardo en vivo |
| `football:cashout` | `{ betId }` | Idem: identidad del socket. Propiedad de la apuesta, mercado no suspendido |
| `football:parlay` | `{ legs[], stake, idemKey }` | Idem. 2–6 patas, partidos distintos, todas abiertas |
| `football:future` | `{ market, selection, stake, idemKey }` | Idem. Mercado de futuros abierto, jornada ≤ 20 |
| `football:reaction` | `{ matchId, emoji }` | Identidad del socket. Mismos emojis y límites del casino |
| `football:chat` | `{ matchId, text }` | Identidad del socket. `cleanMessage` + anti-duplicado + rate limit del chat existente |

**Regla de identidad (decisión A11, §12.7 hallazgo 10).** Ningún handler del Estadio acepta un
identificador elegido por el cliente en el payload. `getOrCreate` aparece **una sola vez** en toda la
sección —en `football:subscribe`—, y en cualquier otro handler es un bug: crearía un perfil nuevo con
`INITIAL_CHIPS = 1000` por cada `token` inventado. El resto lee `socket.data.football` y resuelve con
la lectura estricta `profiles.profiles.get(profileId)` —el patrón que el repo ya usa en `server.js:1640`,
`:1855`, `:1921`, `:1955`, `:1973`—, rechazando si no está. Es exactamente lo que hace `lobby_chat`
(`:1866`) respecto de `lobby_chat_join` (`:1858`).

Rooms de Socket.IO: `football:lobby` y `football:m:{matchId}`. Límite de **40 espectadores suscritos por
partido** y **200 en `football:lobby`** (configurable), con lista de espera y mensaje claro al superar el
cupo — mismo criterio que los 12 espectadores por mesa actual.

### 14.2 Socket.IO (servidor → cliente)

| Evento | Frecuencia | Contenido |
| --- | --- | --- |
| `football:lobby` | al suscribir + cada 10 s | partidos de hoy con bloque y estado, cuenta regresiva al próximo kickoff, tabla de posiciones, destacados |
| `football:match_state` | al suscribir / reconectar | prefijo revelado completo: estado, estadísticas, últimos 40 comentarios, mercados con cuotas, apuestas propias |
| `football:tick` | 2 s por partido suscrito | minuto, marcador, balón, `phase`, destinos de 3–6 jugadores |
| `football:event` | inmediato | evento de alta relevancia + comentario + `importance` |
| `football:commentary` | inmediato | mensaje de narrador o analista (puede viajar sin evento, en pausas) |
| `football:odds` | al cambiar | mercados con precios, `movement: 'up'|'down'|'flat'`, `suspended`, `betDelay` |
| `football:bet_ack` | respuesta | apuesta creada o error con código |
| `football:settlement` | al liquidar | resultado, payout, motivo; también notifica al perfil (`profile_event`) |
| `football:status` | puntual | avisos del motor: `restarting`, `match_postponed`, `market_reopened`, `season_closing` |

**Regla de privacidad**: `football:match_state` y `football:tick` **solo contienen eventos ya revelados**.
El campo `timeline` completo nunca viaja. Se agrega un test que inspecciona los payloads emitidos y
falla si aparece cualquier evento con `t > minutoActual` (§20-T7).

### 14.3 HTTP

| Ruta | Uso |
| --- | --- |
| `GET /estadio` | Página propia. **Debe registrarse antes del catch-all `app.get('*')`**, igual que `/terminos` |
| `GET /api/estadio/state` | Instantánea de lobby sin socket (para la primera pintura y para reconexiones) |
| `GET /api/estadio/matches/:id` | Estado revelado + mercados; útil para depurar y para el historial |
| `GET /api/estadio/standings` | Tabla de la temporada en curso |
| `GET /healthz` | Se extiende (§15.8) |
| `POST /admin/estadio/matches/:id/suspend` | Palanca operativa (requiere sesión admin + auditoría) |
| `POST /admin/estadio/matches/:id/settle` | Forzar liquidación |
| `POST /admin/estadio/matches/:id/postpone` | Posponer y reembolsar |
| `POST /admin/estadio/markets/:matchId/:market/close` | Cerrar un mercado por precio incorrecto |

Las rutas admin van por `installAdminRoutes` y quedan **apagadas por defecto** con `ADMIN_FEATURE_ENABLED`,
fiel a la filosofía *fail-closed* de `lib/admin-config.js`.

### 14.4 Restricción de despliegue

Render corre **un solo servicio web** (`render.yaml`). Todo el diseño asume proceso único, igual que
las mesas actuales. Si algún día se escala a 2+ instancias:

- Los schedulers ejecutarían partidos duplicados y liquidaciones dobles.
- Solución prevista: **lock de líder** con `pg_try_advisory_lock(clave)` al arrancar; solo el líder
  corre los barridos del motor, las demás instancias sirven lectura y reenvían apuestas.
- Se deja documentado como prerrequisito obligatorio, no como mejora opcional.

---

## 15. Scheduler autónomo y watchdogs

Esta sección es la respuesta directa a «evitar los errores por parte de inactividad del sistema».

### 15.1 Filosofía

Tres reglas, heredadas de las lecciones ya escritas en tu código:

1. **Derivar, no acumular.** Todo estado crítico se calcula desde `(seed, calendario, now)`. Nada
   importante depende de que un timer haya disparado a tiempo.
2. **`setInterval` de barrido, nunca cadenas de `setTimeout`.** Una cadena se rompe en silencio; un
   barrido se recupera solo en la siguiente vuelta.
3. **Aislar por partido.** Cada partido se procesa en su propio `try/catch` con `logEvent`. Un
   partido raro se pierde; el motor y los otros 11 siguen. Es exactamente la lección de
   `scheduleRoomTask` y de los barridos de anfitrión y temporada.

### 15.2 `footballSchedulerSweep` — 500 ms

```js
const footballSchedulerSweep = setInterval(() => {
  if (!footballStore || !footballEngine) return;
  if (sweepRunning) return;                    // anti-reentrancia si una vuelta tarda de más
  sweepRunning = true;
  const now = Date.now();
  try {
    footballEngine.ensureTodayScheduled(now);      // autoaprovisiona la jornada del día si falta
    for (const match of footballEngine.active()) {
      try {
        footballEngine.advance(match, now);        // derivar estado, revelar eventos, emitir ticks
      } catch (error) {
        logEvent('football_match_error', { match: match.id, message: String(error?.message || error) });
        footballEngine.quarantine(match);          // lo saca del ciclo sin tocar a los demás
      }
    }
  } catch (error) {
    logEvent('football_scheduler_error', { message: String(error?.message || error) });
  } finally {
    sweepRunning = false;
  }
}, Number(process.env.FOOTBALL_SWEEP_MS) || 500);
footballSchedulerSweep.unref?.();
```

`advance()` emite:
- eventos pendientes desde `revealedIndex` (todos, en lote ordenado, aunque sean varios por catch-up);
- un `football:tick` si pasaron ≥ 2 s desde el último;
- recalcula cuotas en vivo si cambió el estado relevante;
- actualiza `lastTickAt`.

### 15.3 `footballKickoffSweep` — 5 s

Arranca partidos cuyo `scheduledKickoffAt <= now` y `status === 'scheduled'`. Al arrancar: genera la
línea de tiempo (si no estaba pre-generada), abre mercados en vivo, emite `football:status
{code:'kickoff'}`. Si un kickoff se retrasa más de 120 s (por ejemplo, el proceso estaba caído), el
partido **arranca igual con el minuto que corresponde** y se emite `football:status
{code:'late_kickoff', minute}` para que la interfaz lo explique en vez de mostrar un reloj roto.

También **pre-genera** los partidos del bloque siguiente con 5 min de anticipación, para que el
kickoff no pague los ~8 ms de generación en el camino caliente y para que las cuotas pre-partido ya
estén publicadas.

### 15.4 `footballStuckSweep` — 30 s

Detecta y auto-repara. Cada caso es idempotente:

| Anomalía detectada | Auto-reparación | Log |
| --- | --- | --- |
| `status === 'live'` y `now - lastTickAt > 15 s` | Re-derivar estado completo desde el seed | `football_match_stalled` |
| `status === 'live'` y `now > kickoffAt + 45 min` | Forzar `finished` con el marcador derivado del minuto 90' | `football_match_forced_finish` |
| `status === 'finished'` con apuestas `open` > 60 s | Liquidar de inmediato | `football_settlement_forced` |
| Mercado `suspended` con `suspendUntil` vencido hace > 30 s | Reabrir | `football_market_reopened` |
| Partido en `postponed` con apuestas sin reembolsar | Reembolsar | `football_refund_forced` |
| 3 errores seguidos en el mismo partido | Cuarentena: partido a `postponed`, reembolsos, no reintenta | `football_match_quarantined` |
| `footballSchedulerSweep` sin correr hace > 10 s (marca de tiempo del último ciclo) | Reintentar arranque del barrido; exponer `status: 'degraded'` en `/healthz` | `football_engine_degraded` |
| Línea de tiempo regenerada no coincide con la revelada | Mantener la revelada hasta el último índice y continuar desde ahí (nunca reescribir el pasado visible) | `football_timeline_divergence` |

### 15.5 `footballSeasonGuardSweep` — 1 min

Coordina la liga con la temporada del casino. Es el watchdog más importante desde el punto de vista
de confianza del jugador:

Los momentos son relativos al **reset mensual** (00:00 del día 1 siguiente), que es el límite duro.

| Momento | Acción |
| --- | --- |
| Día 1 del mes, al arrancar | Generar liga, clubes, plantillas, calendario y tabla; publicar futuros |
| Último día − 24 h | Dejar de programar nuevas jornadas; la jornada 30 ya terminó (§5.2). Calcular la tabla final. **Si el 1.º empata tras los desempates de tabla → programar el partido de desempate (§7.5) en el bloque Estelar de hoy** y avisar `football:status {code:'playoff_scheduled'}`. Avisar también `season_closing` y mostrarlo en la interfaz |
| Último día − 6 h | Cerrar mercados de futuros **pre-partido**; suspender apuestas de temporada siguiente. El futuro «Campeón de liga» ya colocado **no** se cierra: queda pendiente de liquidación hasta que se resuelva el título |
| Último día, bloque Estelar (~21:30) | **Partido de desempate** si fue programado: 90' + prórroga + tanda si hace falta, ~25-30 min reales (§7.5). Mercado «Gana el desempate» 2-vías abierto hasta el kickoff (§11.2-bis) |
| Último día − 2 h | Verificar que la jornada 30 terminó **y que el desempate, si lo hubo, se resolvió**; si no se pudo completar, marcar la temporada `truncated` y **anular/reembolsar todos los futuros** (incluido el campeón, que vuelve a los desempates estadísticos de §5.1) |
| Último día − 1 h | Liquidar todo lo pendiente (el futuro «Campeón» espera al ganador del desempate), publicar campeón, podio, Bota de Oro y banner |
| Reset mensual | Solo entonces el `seasonSweep` puede reiniciar fichas |

El desempate cabe holgado en la ventana: se detecta al iniciar el día de cierre (la jornada 30 ya
terminó la víspera), se juega en el bloque Estelar (~21:30, termina ~22:00) y la liquidación es a
−1 h (~23:00). Si un apagón o un `stuck` impide jugarlo a tiempo, el −2 h marca `truncated` y el
campeón vuelve a los desempates estadísticos: **el reset nunca se retrasa por esperar un partido**
(misma regla de vivacidad que A7).

Cambio asociado en el camino del reset: un **gate acotado** dentro de `ensureSeason()`
(`lib/profile-store-base.js:94`), no en `seasonSweep` — porque `getOrCreate()` (línea 178) también lo
dispara en cada conexión y gana la carrera. Mientras haya apuestas abiertas del mes que cierra devuelve
`{type:'deferred'}` sin tocar `chips`; `server.js:2220` lo registra como `season_reset_deferred` y
reintenta. Tras `SEASON_RESET_MAX_DEFERRALS` el motor ejecuta `forceSettle` (anula y reembolsa al
contado) y el reset procede. **El fútbol puede retrasar el reset, nunca impedirlo** (§12.7, hallazgo 6,
decisión A7, pruebas T31/T32).

### 15.6 Reconciliación al arrancar (`bootstrap()`)

Después de crear el store y **antes** de `server.listen`. El **orden de estos pasos es parte del
diseño**, no un detalle (§12.7, hallazgo 11, decisión A12): el paso 0 debe correr antes que el reset
mensual, y por eso `createProfileStore` se llama con `deferSeasonCheck: true` y `ensureSeason()` se
invoca explícitamente al final.

```
0. createProfileStore(…, { deferSeasonCheck: true })   // NO dispara el reset mensual (A12)
1. Cargar liga y partidos persistidos
2. Si la temporada persistida no es el mes en curso → cerrar/anular la anterior y generar la nueva
3. Para cada partido no terminal: recalcular estado desde (seed, now)
     · si now > kickoffAt + duración → finished, y liquidar
     · si ahora está dentro de la ventana → live, emitir catch-up al primer suscriptor
     · si el kickoff ya pasó por más de 45 min → postponed + reembolsos
     · si la jornada entera quedó vencida por un apagón → política de §15.9 (comprimir o truncar)
4. Para cada apuesta open cuyo partido ya terminó → liquidar
4b. Para cada apuesta en `status:'pending'` → **anular sin reembolso** (§12.7 h.7, A8). Un `pending`
     huérfano significa que el proceso murió entre el WAL y el débito, o entre el débito y la
     confirmación; en ambos casos la apuesta nunca llegó a `open` y no hay stake que devolver. Si el
     débito sí alcanzó a persistirse, el paso 5 lo detecta como apuesta de temporada anterior o el
     cuadre de escrow del paso 7b lo reembolsa
5. Para cada apuesta open de una temporada anterior → anular y reembolsar
6. Reprogramar los bloques restantes del día
7. Reiniciar los barridos
7b. Cuadre de escrow: para cada perfil, `Σ stake de apuestas open` debe coincidir con el total
     escrow-eado registrado. Una discrepancia se loguea como `football_escrow_mismatch` y se
     reembolsa la diferencia. Es la red que atrapa un débito perdido por omitir `profiles.touch()`
8. logEvent('football_boot_reconcile', { partidos, liquidados, reembolsados, pendientes_anulados,
     reprogramados, escrow_mismatch, ms })
   ── hasta aquí, TODAS las fichas siguen siendo las del mes anterior: los stakes escrow-eados
      están intactos y las liquidaciones de los pasos 3-5 se pagaron contra saldos reales ──
9. profiles.onBeforeSeasonReset(footballEngine.seasonGate)   // registra la guarda de A7
10. if (profiles.lastSeasonRepair) → logEvent('season_calendar_repaired')   // MOVIDO aquí (A12):
     antes lo leía bootstrap justo tras createProfileStore, cuando aún estaba vacío
11. profiles.ensureSeason()          // AHORA sí el reset mensual, con la guarda puesta
12. server.listen()
```

Los pasos 9-11 son el corazón de la decisión A12 y su orden no es negociable: **reconciliar antes de
resetear**. Con el orden actual del repo —`ensureSeason()` durante la construcción del store (archivo:
constructor; PG/Neon: `_init()`, que la fábrica espera con `await store.ready`), todo en la línea 1 de
`bootstrap()`— el reset corre primero y los pasos 3 a 5 liquidarían contra saldos ya puestos en
`INITIAL_CHIPS`, que es R1 palabra por palabra (§12.7, hallazgo 11).

Nadie puede quedar con fichas atrapadas por un deploy. Esto es exactamente lo que hoy hace
`gracefulShutdown` + `bootstrap` con los perfiles, extendido al motor.

### 15.7 Apagado limpio

Extensión de `gracefulShutdown` (`server.js:2262`), en el orden existente:

1. Avisar a los suscriptores: `football:status {code:'restarting'}` + mensaje en el relato
   («🔄 El servidor se está actualizando; el partido continúa donde debe en unos segundos»).
2. `await footballStore.saveNow()` con la misma gracia extendida para Postgres (`SHUTDOWN_GRACE_MS`).
3. `await footballStore.close?.()`.
4. Los partidos **no** se marcan como interrumpidos: al volver, `f(seed, now)` los pone donde
   corresponde. Esta es la ventaja concreta del diseño determinista frente a un deploy.

### 15.8 Observabilidad

`/healthz` se extiende (Render lo usa como health check, así que debe seguir respondiendo rápido y
nunca debe fallar por culpa del motor):

```json
{
  "status": "ok",
  "football": {
    "enabled": true,
    "seasonMonth": "2026-10",
    "jornada": 12,
    "matchesActive": 3,
    "matchesScheduledToday": 8,
    "lastSweepAgeMs": 412,
    "lastTickAgeMs": 1180,
    "openBets": 47,
    "escrowChips": 18400,
    "ledgerBalanced": true,
    "quarantined": 0,
    "degraded": false
  }
}
```

`degraded: true` o `ledgerBalanced: false` son señales de alarma operativas. Se agregan eventos de
log estructurados (`football_*`) con el mismo formato JSON por línea que ya consume el visor de Render,
y un contador de errores por partido para que la cuarentena sea visible en los logs.

---

### 15.9 Apagón prolongado (varios días sin servidor)

**La pregunta correcta no es «cómo recupero la ejecución», porque no hay ejecución que recuperar.**
Un partido nunca fue un proceso: es una función pura `estado = f(seed, now)` (§3.2). El resultado
quedó determinado en el instante en que se generó el calendario, con
`seed = hash32(matchId | jornada | seasonMonth)`. Si el servidor está caído tres días, al arrancar no
se «reproduce» nada: se **evalúa** la función con el `now` actual y el partido ya está terminado, con
sus ~180 eventos, marcador, goleadores y relato completos.

Eso es más fuerte que mostrar solo el resultado, y cuesta lo mismo:

| Lo que se podría mostrar | Costo | Recomendación |
| --- | --- | --- |
| Solo el marcador final | Cero | Insuficiente: el jugador no puede verificar nada |
| Resultado + línea de tiempo completa | **Cero** (se regenera desde el seed, ~40 KB que nunca se persisten) | **Esta**: replay instantáneo a velocidad normal o saltando al final |

**Propiedad de confianza que conviene explotar.** Como el seed se derivó al generar el calendario —
**antes** del apagón—, liquidar un partido que terminó durante la caída no es la casa decidiendo un
resultado a posteriori. Para hacerlo auditable: publicar `hash32(seed)` al abrir el mercado y el
`seed` al terminar. Cualquiera puede entonces regenerar la línea de tiempo y comprobar que el
resultado estaba comprometido antes del saque inicial. Es la diferencia entre «confía en mí» y
«verifícalo», y no cuesta nada porque el generador ya es determinista.

#### Los cuatro casos al arrancar

| Caso | Qué había | Qué se hace |
| --- | --- | --- |
| Partido **en vivo** al caer | Apuestas abiertas, minuto 34 | `f(seed, now)` → minuto 78. Sin drift, sin replay. Se reanuda y se emite catch-up al primer suscriptor |
| Partido **terminó** durante la caída | Apuestas abiertas | `finished` desde el seed → **liquidar siempre**. Nunca anular: el resultado estaba pre-comprometido |
| Jornada **nunca alcanzada** (el servidor cayó antes de programarla) | Sin apuestas | Política de calendario (abajo) |
| Partidos del **día en curso** aún no jugados | Sin apuestas | Reprogramar los bloques restantes (§15.6 paso 6) |

#### Política de calendario: nunca se salta una jornada

La restricción dura es que la temporada debe cerrar **1 día antes del reset mensual de fichas**. Un
apagón de N días se come N días de ese presupuesto. Hay dos salidas y se elige por aritmética:

```
díasRestantes  = días hasta (reset mensual − 1)
jornadasDebidas = jornadas cuyo día programado ya pasó y no se completaron

si díasRestantes >= jornadasDebidas  → COMPRIMIR
si no                                → TRUNCAR en el último límite de jornada completado
```

- **Comprimir**: repartir las jornadas debidas en los días restantes, reutilizando la maquinaria de
  doble jornada que ya existe (§5.2, `dobles`). Hay holgura: el motor soporta 12 partidos
  concurrentes y el calendario normal usa 3.
- **Truncar**: marcar la temporada `truncated`, **reembolsar todos los futuros** (misma regla que el
  cierre a −2 h de §15.5) y dar campeón y Bota de Oro sobre la tabla parcial.

**Por qué truncar es justo y saltarse jornadas no.** En un round-robin de 16 equipos **cada jornada
juegan los 16**: al cerrar en el límite de la jornada 20, los 16 tienen exactamente 20 partidos. La
tabla es comparable y el campeón es legítimo. Saltarse jornadas sueltas, en cambio, deja equipos con
15 partidos y otros con 14, y obliga a decidir el título por puntos-por-partido —una regla que ningún
jugador va a entender y que parece un parche. Regla que queda: **o se juega la jornada completa, o la
temporada termina en la última jornada completa**. Nunca una jornada parcial.

Los ajustes de rating del mes siguiente (E12, sin descenso real) se calculan sobre la tabla final,
que es válida en ambos casos.

#### Liquidación silenciosa (modifica D9)

Un apagón de tres días puede hacer que el arranque liquide de golpe 24 partidos y cientos de
apuestas. Si cada una dispara la campana de D9, el jugador recibe una avalancha de notificaciones por
partidos que terminaron hace dos días. Regla:

- **Liquidaciones hechas por la reconciliación de arranque → sin campana.** Se resumen en un único
  aviso: *«3 apuestas liquidadas durante la interrupción: +1.240 fichas»*, con enlace al detalle.
- Campana normal solo para liquidaciones que ocurren con el servidor en marcha y el jugador presente.
- Los replays de partidos terminados durante la caída **no** emiten `football:goal` en tiempo real: se
  marcan como replay y se ofrecen a velocidad acelerada o con salto al final.

Sin esto, D9 («campana solo para apuestas liquidadas y saque inicial con apuesta abierta») se
convertiría en spam exactamente en el momento de mayor fragilidad de confianza.

#### Límites de la recuperación

- **Apagón que cruza fin de mes**: el caso más peligroso, y no por el calendario sino por el reset de
  fichas. Ver §12.7 **hallazgo 11**: **ambos** backends llaman a `ensureSeason()` durante la
  construcción del store —archivo en el constructor, PG/Neon (el de producción) en `_init()`, que la
  fábrica espera con `await store.ready`—, antes de que el fútbol pueda registrar su guarda. Decisión
  A12 (`deferSeasonCheck` en los dos backends).
- **Apagón más largo que el mes**: la temporada persistida ya no es el mes en curso; §15.6 paso 2 la
  cierra/anula y genera la nueva. Todo lo pendiente se reembolsa.
- **Store corrupto o vacío**: si `data/football.json` no carga, se regenera la temporada desde cero
  con el seed del mes. Los partidos ya terminados vuelven a dar **el mismo resultado** (el seed no
  depende del store), así que la regeneración es inocua para las apuestas liquidadas. Solo se pierden
  las apuestas abiertas, que se reembolsan. Esta es la ventaja concreta de no persistir la línea de
  tiempo: no hay estado que pueda corromperse.

## 16. Integración con el casino existente

Puntos de contacto concretos, con la ubicación actual en el código:

| # | Archivo / línea | Cambio | Riesgo |
| --- | --- | --- | --- |
| 1 | `server.js:1655` `io.on('connection')` | Registrar los handlers `football:*` | Bajo |
| 2 | `lib/profile-store-base.js:94` `ensureSeason()` | **Gate acotado** antes de tocar `profile.chips`: `onBeforeSeasonReset(fn)` + `SEASON_RESET_MAX_DEFERRALS`, devolviendo `{type:'deferred'}` | **Crítico si se omite o si se pone en `seasonSweep`** (§12.7 h.6, A7) |
| 2b | `server.js:2220` `seasonSweep` | Solo **loguear** el nuevo `type:'deferred'` como `season_reset_deferred` y reintentar. No es el lugar de la guarda | Bajo |
| 2c | `lib/profile-store.js:17` (constructor, archivo) | **`deferSeasonCheck`**: el constructor deja de llamar a `ensureSeason()` cuando se pide. Nace en `false`, así el comportamiento por defecto no cambia (§12.7 h.11, A12) | Medio: backend local/tests, no el de producción |
| 2c-bis | `lib/profile-store-pg.js:116` (`_init()`, PG/Neon) | **Mismo `deferSeasonCheck`**: `_init()` deja de llamar a `ensureSeason()` cuando se pide. La fábrica hace `await store.ready` antes de devolver el store, así que sin esto el reset corre durante el arranque igual que en archivo (§12.7 h.11, A12) | **Crítico**: es el backend de producción |
| 2d | `server.js:2321` `bootstrap()` | **Orden explícito**: `createProfileStore(…, DATABASE_URL, {deferSeasonCheck:true})` → reconciliar fútbol → `onBeforeSeasonReset` → `lastSeasonRepair` → `ensureSeason()` → `listen`. El bloque `lastSeasonRepair` **debe moverse** o leería un campo todavía vacío (§15.6 pasos 0-12) | **Crítico** |
| 3 | `server.js:2262` `gracefulShutdown` | `saveNow()` + `close()` del store de fútbol | Medio |
| 4 | `server.js:2321` `bootstrap()` | Crear el store, reconciliar y arrancar el motor antes de `listen` | Medio |
| 5 | `server.js:113` `/healthz` | Extender el payload | Bajo |
| 6 | Antes de `app.get('*')` | Servir `/estadio` y `/api/estadio/*` | Bajo, pero el orden importa |
| 7 | `public/index.html:35` nav | Agregar el acceso «🏟 Estadio» apuntando a `/estadio` | Bajo |
| 8 | `public/index.html:178` `#live-lobby` | **Ningún cambio** (decisión B2): la sección se llama «Estadio MonteCristo», así que «en vivo» sigue significando salas activas y no hay colisión que resolver | Nulo |
| 9 | `lib/progression.js:3` `AVAILABLE_GAMES` | **No agregar** `'football'` (decisión C6). Solo afecta al logro `explorer` | Bajo |
| 9b | `lib/progression.js:72` `trackPeriod` | **Obligatorio**: filtrar por `CHALLENGE_GAMES` o el Estadio contará para «Turista del día» y «Ruta del casino» (§12.7, hallazgo 2) | **Alto si se omite** |
| 9c | `lib/progression.js:153` | **Exportar `debit()` nuevo**: `credit()` hace `Math.max(0, …)` y no puede debitar (§12.7, hallazgo 1). El módulo **sigue puro**: no se le inyecta el store | **Crítico si se omite** |
| 9d | Todo llamador de `debit()` | **`profiles.touch(profile)` obligatorio** acto seguido: `lib/progression.js` no persiste (su único `require` es `HISTORY_LIMITS`). Es la convención del repo en `server.js:590` y `:1091`; `executeQuickBet` se salva solo porque su setter ya toca (§12.7, hallazgo 7, A8) | **Crítico si se omite** |
| 10 | `lib/terms.js:6` `TOS_VERSION` | **Subir la versión** y agregar la cláusula de apuestas deportivas simuladas: eventos ficticios generados por el servidor, tope del 25 % del saldo por apuesta y **declaración del flujo simulado** (§11.6) | **Alto**: fuerza re-aceptación de todos |
| 10b | `public/app.js:81` `TOS_VERSION` | **Subirla en el MISMO commit que la fila 10.** El cliente la tiene hardcodeada y la usa para decidir si muestra el modal (`tosAccepted()`, `:87`/`:105`) y qué versión envía (`:2189`) | **Crítico si se omite**: lockout total sin modal (§12.7 h.9, A10, T36) |
| 11 | `scripts/migrate-db.js` | **Ningún cambio** (§12.7 hallazgo 4). El DDL de las 6 tablas va **inline** en `lib/football-store-pg.js`, como en `profile-store-pg.js`. El runner lee un `migrations/` que no existe y ningún deploy lo ejecuta | Nulo |
| 11b | `lib/football-store-pg.js` + `football-store-factory.js` | Aceptar `{ pool }` por parámetro en vez de crear el propio, y colocar la apuesta en **una sola transacción** con `SELECT data FROM montecristo_profiles … FOR UPDATE`. Patrones ya existentes: `password-reset-store-pg.js` (`ownsPool`) y su `consumeAndApply` (§12.7, hallazgo 7, A8) | **Crítico si se omite** |
| 11c | `lib/profile-store-pg.js` | **Ningún cambio de código**: ya expone `this.pool`. Solo se pasa a la factoría del store de fútbol | Nulo |
| 12 | `render.yaml` | `FOOTBALL_*` env vars | Bajo |
| 13 | `package.json` | Scripts de test del motor | Bajo |
| 14 | `public/app.js:68` `GAME_META` | **Agregar** `football: { icon: '🏟', name: 'ESTADIO' }` o el panel «Historial por juego» no lo muestra (§12.7, hallazgo 3). Además, enlace al nuevo módulo; nada de lógica de fútbol aquí | Bajo, pero obligatorio |

Sobre el punto 10: agregar apuestas deportivas simuladas es una **categoría nueva de juego** dentro
de unos T&C redactados a conciencia para México (naturaleza recreativa, 18+, aviso de privacidad
LFPDPPP). Debería subir `TOS_VERSION`, agregar cláusula explícita de que los eventos deportivos son
**simulados y ficticios** (no son eventos reales, no hay información privilegiada posible, los
resultados los genera el servidor) y forzar re-aceptación. Ese último punto es además una protección
para el propio casino: deja por escrito que no se apuesta sobre hechos del mundo real.

Nota del estado actual del repo: `package.json` referencia `tests/*.test.js` pero **el directorio
`tests/` no existe en este checkout**, así que `npm test` falla hoy. No es causado por esta
propuesta, pero conviene resolverlo antes de agregar el plan de pruebas de §22.

---

## 17. Configuración

Feature flag con la misma filosofía *fail-closed* de `lib/admin-config.js`: **apagado por defecto** y,
si se activa, el proceso falla al arrancar si falta algo crítico.

```
FOOTBALL_ENABLED=off                 # off por defecto; on activa motor, sockets y /estadio
FOOTBALL_STORE_PATH=/var/data/football.json
FOOTBALL_LEAGUE_TEAMS=16
FOOTBALL_SIM_SECONDS_PER_MINUTE=10
FOOTBALL_HALFTIME_MS=45000
FOOTBALL_SWEEP_MS=500
FOOTBALL_TICK_MS=2000
FOOTBALL_BLOCKS=[{"id":"matutino","time":"13:00","matches":3},
                 {"id":"vespertino","time":"18:00","matches":3},
                 {"id":"estelar","time":"21:30","matches":2,"featured":true}]
FOOTBALL_MAX_CONCURRENT_MATCHES=12
# --- Margen de casa (decisión C4: 7 %, el más duro del casino; ver §10.3) ---
FOOTBALL_MARGIN_1X2=0.07
FOOTBALL_MARGIN_TOTALS=0.08
FOOTBALL_MARGIN_EXOTIC=0.12
FOOTBALL_MARGIN_INPLAY_EXTRA=0.01
FOOTBALL_MARGIN_CASHOUT=0.08
FOOTBALL_MARGIN_FUTURES=0.10
FOOTBALL_MIN_MARGIN_INVARIANT=0.04     # piso anti-arbitraje; nunca se puede romper
# --- Movimiento por peso del dinero ---
FOOTBALL_WOM_WEIGHT=0.30
FOOTBALL_WOM_MAX_MOVE=0.06
FOOTBALL_WOM_MIN_INTERVAL_MS=20000
FOOTBALL_WOM_MAX_DRIFT=0.25
# --- Límites de apuesta (decisión C5: 25 % del saldo; ver §11.3) ---
FOOTBALL_MIN_STAKE=10
FOOTBALL_STAKE_PCT_OF_BALANCE=0.25
FOOTBALL_MAX_STAKE=25000
FOOTBALL_MAX_PROFILE_EXPOSURE_PER_MATCH=50000
FOOTBALL_MAX_MATCH_EXPOSURE=250000
FOOTBALL_MAX_JORNADA_EXPOSURE=1000000
FOOTBALL_MAX_PAYOUT_PER_BET=500000
FOOTBALL_MAX_OPEN_BETS_PER_MATCH=20
FOOTBALL_BET_DELAY_MS=4000
FOOTBALL_DENOMINATIONS=[10,25,50,100,250,500,1000]
# --- Combinadas y futuros ---
FOOTBALL_PARLAY_MAX_LEGS=6
FOOTBALL_PARLAY_MAX_ODDS=100
FOOTBALL_PARLAY_MAX_PAYOUT=500000
FOOTBALL_FUTURES_CLOSE_JORNADA=20
FOOTBALL_FUTURES_SIMS=2000
# --- Flujo simulado (decisión D8; ver §11.6) ---
FOOTBALL_SIM_FLOW_ENABLED=on
FOOTBALL_SIM_WEIGHT=0.6                # influencia máxima cuando no hay fichas reales
FOOTBALL_SIM_SOFTENER=2000             # fichas reales a partir de las cuales la influencia cae a la mitad
FOOTBALL_SIM_PUBLIC_BIAS=0.15          # sobreapuesta al favorito y al «altas»
FOOTBALL_SIM_VOLUME_PREMATCH=5000      # techo de fichas sintéticas por partido antes del kickoff
FOOTBALL_SIM_INTERVAL_MS=45000
# --- Penales de partido (decisión A13; ver §7.4) ---
FOOTBALL_PENALTY_RATE=0.25             # penales señalados por partido (≈ 1 cada 4)
FOOTBALL_PENALTY_CONVERSION=0.76       # tasa de conversión (≈ real 75-78 %)
FOOTBALL_PENALTY_XG=0.79               # xG de un penal
# --- Desempate de campeonato (decisión A14; ver §7.5) ---
FOOTBALL_PLAYOFF_ENABLED=on            # prórroga + tanda si el 1.º empata tras los desempates de tabla
FOOTBALL_EXTRA_TIME_MINUTES=30         # 2 × 15' de prórroga
FOOTBALL_SHOOTOUT_INITIAL=5            # tanda: 5 por equipo, luego muerte súbita
FOOTBALL_SHOOTOUT_CONVERSION=0.75      # tasa de conversión en la tanda (menor que en partido: presión)
# --- Capacidad ---
FOOTBALL_VIEWERS_PER_MATCH=40
FOOTBALL_VIEWERS_LOBBY=200
```

Validación al arrancar: `FOOTBALL_ENABLED=on` exige que `FOOTBALL_BLOCKS` sea JSON válido y sume 8
partidos por jornada (o el número que corresponda a `FOOTBALL_LEAGUE_TEAMS`), que los márgenes estén
en `[0.02, 0.25]`, que `FOOTBALL_MIN_MARGIN_INVARIANT` sea menor que todos los márgenes, y que el
store sea escribible.

**Dónde se ejecuta esa validación importa más que qué valida** (§12.7, hallazgo 5). Vive en
`lib/football-config.js` y hace `throw`, igual que `loadAdminConfig()`. Debe invocarse **o bien
junto a la línea 35 de `server.js`** —antes de que la línea 60 instale la red `uncaughtException`—
**o bien dentro de `bootstrap()`**, cuyo `catch` ya hace `process.exit(1)`. En cualquier otra
posición del módulo, el `throw` lo traga la red y el proceso queda vivo pero sin escuchar: un zombi
que no responde `/healthz`. Cubierto por T30.

---

## 18. Seguridad y abuso

| Vector | Mitigación |
| --- | --- |
| Libro arbitrable por movimiento de cuotas | Invariante `Σ 1/cuota ≥ 1 + margenMínimo` verificada antes de publicar (§10.3) |
| Combinadas correlacionadas del mismo partido | Prohibidas por regla (§11.4) |
| Apuesta con cuota vieja tras un gol | `suspended` + retardo de aceptación de 4 s + revalidación de precio (§10.6) |
| Doble clic / reintento de red | `idempotencyKey` única (§12.2) |
| Doble liquidación | Transición terminal atómica + clave única (§12.3) |
| Fuga del resultado futuro | Solo se emite el prefijo revelado; test que lo verifica (§20-T7) |
| Spam de apuestas | Rate limit 10/10 s + límites por partido y jornada (§11.3) |
| Inflar exposición de la casa | Techos por mercado, por partido y por jornada; `selection_closed` al llegar al tope |
| Chat del partido | Reutiliza `cleanMessage`, anti-duplicado y rate limit del chat existente |
| Nombres de clubes/jugadores generados | Pasan por `nameHasProfanity` al generar la temporada |
| Cliente que miente el stake o la cuota | El servidor ignora todo precio enviado por el cliente; solo acepta `matchId + market + selection + stake` |
| Enumeración de perfiles vía apuestas | Los payouts se notifican solo al dueño; nunca se publican nombres con stakes ajenos |
| Escalado a varias instancias | Lock de líder obligatorio antes de escalar (§14.4) |

---

## 19. Presupuesto de rendimiento

Con 3 partidos simultáneos (6 en día doble) y 100 espectadores repartidos:

| Concepto | Costo |
| --- | --- |
| Barrido de scheduler | ~0,4 ms por vuelta (derivar 3 partidos) cada 500 ms → < 0,1 % de CPU |
| Generación de línea de tiempo | ~8 ms por partido, una vez |
| Monte Carlo de futuros | ~400 ms, una vez por jornada (fuera del camino caliente) |
| Tráfico Socket.IO | 3 partidos × 0,5 tick/s × ~350 B × espectadores ≈ 15 KB/s con 30 espectadores |
| Recálculo de cuotas en vivo | ~0,5 ms por mercado; 6 mercados × 3 partidos por evento relevante |
| Memoria por partido en vivo | ~120 KB (línea de tiempo + estado + mercados) |
| Memoria total del motor | < 5 MB con 12 partidos |
| Escritura a disco | Debounce 10 s (estado) + write-through de apuestas |

Nada de esto compite con las mesas de póker. El único costo nuevo perceptible es el de render en el
cliente, y el canvas 2D con 22 círculos y tweening es de los casos más ligeros que hay.

---

## 20. Plan de pruebas

Se agrega `tests/football-*.test.js` con `node --test`, siguiendo el estilo existente. Son **42
pruebas**; las marcadas con (C4), (C5) o (D8) sostienen decisiones de producto que se tomaron a
conciencia, **T23–T40 son pruebas de regresión contra los once hallazgos de §12.7**, y **T41–T42
cubren las decisiones A13/A14** (penales y partido de desempate). Las de regresión existen para
que nadie vuelva a usar `credit()` como débito, a confiar en `AVAILABLE_GAMES` para excluir un juego
de los retos, a olvidar `GAME_META`, a depender de una vía de migraciones que no corre en ningún
deploy, a validar config después de instalada la red `uncaughtException`, a poner la guarda del reset
en un consumidor, a debitar sin `profiles.touch()`, a pagar con `credit()` + `recordOutcome()`, a
subir `TOS_VERSION` en un solo archivo, ni a resolver identidad con `getOrCreate` fuera de
`football:subscribe`.

> Nota (decisión A2): el directorio `tests/` **no existe en el repo** y nunca se commiteó, aunque
> `package.json` referencia 25 archivos `tests/*.test.js`. Por eso el motor trae su propio script
> `npm run test:football` y no se cuelga de `npm test`, que hoy falla por razones ajenas a este
> trabajo.

| # | Prueba | Qué garantiza |
| --- | --- | --- |
| T1 | Matriz de Poisson: suma 1, simetría con ratings iguales, Dixon-Coles eleva 0-0 y 1-1 | Modelo de probabilidades sano |
| T2 | Margen: `Σ 1/cuota == 1 + margen ± 0.001` tras redondeo y clamp | Precio de casa correcto |
| T3 | Peso del dinero: tras 1.000 apuestas concentradas, el libro nunca queda arbitrable | Invariante económica |
| T4 | Determinismo: mismo seed → misma línea de tiempo byte a byte | Auditoría y reproducción |
| T5 | Catch-up: pausar 60 s y reanudar produce el mismo estado que correr sin pausa | **La propiedad anti-inactividad** |
| T6 | Reinicio: matar el store y reconstruir desde seed + now recupera minuto, marcador y eventos | Recuperación ante deploy |
| T7 | Privacidad: ningún payload emitido contiene eventos con `t > minutoActual` | Sin fuga del futuro |
| T8 | Liquidación exactamente una vez: 50 llamadas concurrentes a `liquidar` pagan una sola vez | Dinero |
| T9 | Calibración en vivo: 20.000 partidos, frecuencia observada vs probabilidad implícita por banda de cuota | Honradez del mercado en vivo (§3.3) |
| T10 | Combinadas: pata anulada → cuota 1.00; todas anuladas → reembolso; una perdida → `lost` inmediato | Reglas de parlay |
| T11 | Futuros: Monte Carlo reproducible con seed; truncar la temporada anula y reembolsa todo | Reglas de temporada |
| T12 | Guarda de temporada: el reset de fichas nunca corre con apuestas abiertas | §12.6, el bug caro |
| T13 | Watchdog: partido `live` con `lastTickAt` viejo se auto-repara en un barrido | §15.4 |
| T14 | Cuarentena: 3 errores seguidos posponen el partido y reembolsan sin tocar a los demás | Aislamiento |
| T15 | Límites: stake, exposición, rate limit y mercados suspendidos rechazan con el código correcto | Reglas de apuesta |
| T16 | Integración socket: `subscribe → tick → bet → goal → settlement → payout en perfil` | Punta a punta |
| T17 | Calendario: febrero, febrero bisiesto y meses de 31 días producen 30 jornadas sin solapes | §5.2 |
| T18 | Flujo simulado: no mueve fichas de ningún perfil, no cuenta en exposición ni responsabilidad, y nunca provoca `selection_closed` | §11.6 (D8) |
| T19 | Ningún payload `football:*` dirigido al cliente contiene datos del flujo simulado | §11.6 (D8) |
| T20 | Con 0 fichas reales el simulado mueve cuotas; con 40.000 reales su influencia cae por debajo del 5 % | §11.6 (D8) |
| T21 | Tope de stake: con saldo 1.000 el máximo es 250 y las denominaciones se filtran; con saldo 20 el mínimo se ajusta | §11.3 (C5) |
| T22 | Margen 7 %: ventaja real medida por simulación = 6,54 % ± 0,2 pp en 1X2 | §10.3 (C4) |
| T23 | `debit()`: con saldo insuficiente devuelve `{ok:false}` y **no muta** el perfil; con saldo suficiente debita exacto y nunca deja saldo negativo | §12.7 hallazgo 1 |
| T24 | Regresión de `credit()`: `credit(profile, -500)` devuelve 0 y no cambia el saldo — la prueba existe para que nadie vuelva a usarlo como débito | §12.7 hallazgo 1 |
| T25 | `trackPeriod` con `game:'football'` **no** agrega a `period.games`; con los seis juegos de mesa sí. Los retos «Turista del día» y «Ruta del casino» quedan inalcanzables solo con el Estadio | §12.7 hallazgo 2 (C6) |
| T26 | Todo `gameStats[game]` con rondas > 0 tiene entrada en `GAME_META` — falla si el fútbol queda guardado pero invisible | §12.7 hallazgo 3 (E10) |
| T27 | 20 apuestas sobre el mismo partido liquidadas a la vez no alteran `eligibleBestStreak` (`eligible:false`), pero sí `gameStats.football.rounds` | §12.1 |
| T28 | `football-store-pg` crea sus 6 tablas al construirse contra un Postgres vacío, y construirla dos veces no falla (`IF NOT EXISTS`) | §12.7 hallazgo 4 (A4) |
| T29 | Regresión de la vía de migraciones: el store PG **no** depende de que exista `migrations/` ni de que corra `migrate:db` — falla si alguien reintroduce esa dependencia sin arreglar el deploy | §12.7 hallazgo 4 (A4) |
| T30 | `loadFootballConfig()` con config inválida **mata el proceso**: se invoca antes de que exista la red `uncaughtException` o dentro de `bootstrap()`. Falla si alguien la mueve a otra posición del módulo | §12.7 hallazgo 5 (A6) |
| T31 | El gate del reset protege **ambos** disparadores: con apuestas abiertas, ni `seasonSweep` ni `getOrCreate()` tocan `profile.chips`; `ensureSeason()` devuelve `{type:'deferred'}` y el stake escrow-eado sigue intacto | §12.7 hallazgo 6 (A7) |
| T32 | **Vivacidad**: tras `SEASON_RESET_MAX_DEFERRALS` el gate ejecuta `forceSettle` (anula y reembolsa al contado) y el reset procede. Una apuesta atascada para siempre **no** puede congelar la temporada: podio, medallas y banner se otorgan | §12.7 hallazgo 6 (A7) |
| T33 | Colocar una apuesta llama a `profiles.touch()`: tras `debit()`, el perfil queda con escritura agendada. Simular un reinicio inmediato y comprobar que **el stake sigue descontado** y la apuesta se liquida contra el saldo correcto | §12.7 hallazgo 7 (A8) |
| T34 | **No se crea dinero**: matar el proceso en cada uno de los 5 puntos del orden WAL (intención → `pending` → débito → `touch` → `confirmBet`) y verificar que la reconciliación de arranque nunca deja una apuesta `open` cuyo stake no esté descontado. Cubre también el TOCTOU: dos apuestas simultáneas del mismo perfil no pueden superar el saldo | §12.7 hallazgo 7 (A8) |
| T35 | Una liquidación escribe **exactamente una** entrada en `profile.transactions` y **un** punto en `balanceHistory`. Falla si alguien reintroduce `credit(payout)` junto a `recordOutcome(net)` | §12.7 hallazgo 8 (A9) |
| T36 | **Bloqueo de deploy**: `lib/terms.js:6` y `public/app.js:81` contienen la misma cadena `TOS_VERSION`. Falla si se sube una sin la otra, que es el lockout total del hallazgo 9 | §12.7 hallazgo 9 (A10) |
| T37 | **No se regalan fichas**: 10.000 `football:bet` con `token` inventados y distintos no crean **ningún** perfil ni mueven ninguna ficha. Los handlers de dinero leen `socket.data.football` y rechazan sin identidad; `getOrCreate` no aparece en su camino | §12.7 hallazgo 10 (A11) |
| T38 | El podio mensual no se contamina: perfiles creados solo por `football:subscribe` con nombre duplicado son rechazados por `nameIssue`, y `_rankedProfiles()` no contiene perfiles sin nombre válido. Cubre también que el store no crezca sin cota ante una inundación de tokens | §12.7 hallazgo 10 (A11) |
| T39 | **Apagón que cruza fin de mes**: con `deferSeasonCheck`, el arranque reconcilia el fútbol y liquida **antes** de `ensureSeason()`. Los stakes escrow-eados se pagan contra saldos que aún los contienen; nadie queda en `INITIAL_CHIPS` con una apuesta sin liquidar | §12.7 hallazgo 11 (A12) |
| T40 | **Apagón de varios días**: 3 jornadas vencidas se resuelven desde el seed sin reproducir nada — mismo resultado que si hubieran corrido en vivo (el seed no depende del store). Con días suficientes se comprimen; sin ellos se trunca en límite de jornada y **todos** los equipos quedan con la misma cantidad de partidos | §15.9 |
| T41 | **Penales**: en 20.000 partidos, ~0.25 penales señalados/partido y conversión efectiva ≤ 0.76 (el sesgo a la baja por `score=0` está acotado y medido). Un `penalty_scored` **nunca** suma un gol fuera del marcador muestreado de Poisson: el total de goles del partido es idéntico con y sin `planPenalties` para el mismo seed (protege R3). Un equipo con `score=0` no tiene penales convertidos. Cada penal añade 0.79 de xG | §7.4 (A13) |
| T42 | **Desempate**: un partido con `ctx.esDesempate` que empata al 90' entra en `extra_time`, y si sigue empatado al 120' entra en `shootout`; la tanda **siempre** produce ganador (la muerte súbita termina). Mismo seed → misma tanda byte a byte, reproducible. Un partido **normal** empatado al 90' termina en `finished` con `winner:'draw'` y **nunca** entra en `extra_time`/`shootout`. El futuro «Campeón» se liquida con el ganador del desempate, no en la jornada 30 | §7.5, §11.5 (A14) |

---

## 21. Fases de entrega

Cada fase es independiente, verificable y deja el casino funcionando.

### Fase A — Liga y datos (~700 líneas)
`lib/football/ratings.js`, `fixtures.js`, `teams.js` (16 clubes + 18 jugadores cada uno),
`football-store-shared.js`, `football-store.js`, `football-store-factory.js`.
**Aceptación**: generar una temporada completa para cualquier mes, calendario válido (T17), tabla de
posiciones que se actualiza al asentar resultados, persistencia JSON de ida y vuelta. Sin UI, sin
sockets.

### Fase B — Motor de partido (~900 líneas)
`match-engine.js` (generador determinista), `commentary.js`.
**Aceptación**: T1, T4, T7. Línea de tiempo reproducible, marcador muestreado de la matriz de
Poisson, comentario con dos voces y sin repeticiones inmediatas.

### Fase C — Scheduler y watchdogs (~500 líneas)
`scheduler.js`, sweeps, reconciliación al arrancar, extensión de `gracefulShutdown` y `/healthz`.
**Aceptación**: T5, T6, T13, T14. Los partidos arrancan y terminan solos con el proceso reiniciándose
en medio, sin intervención y sin apuestas huérfanas.

### Fase D — Cuotas y apuestas pre-partido (~1.000 líneas + ~15 en `lib/progression.js`)
`odds.js` (Poisson, Dixon-Coles, margen 7 %, peso del dinero), `simulated-flow.js` (flujo sintético
con decaimiento y contabilidad separada), `betting.js` (escrow, idempotencia, liquidación, tope del
25 % del saldo), integración con `rate-limit`.

**Prerrequisito de esta fase, no opcional**: los dos cambios en `lib/progression.js` verificados en
§12.7 — exportar `debit()` (porque `credit()` no puede debitar) y filtrar `trackPeriod` por
`CHALLENGE_GAMES` (porque `AVAILABLE_GAMES` no excluye al fútbol de los retos rotatorios).

**Aceptación**: T2, T3, T8, T15, T18, T20, T21, T22, T23, T24, T25, T27. Apuestas pre-partido de
punta a punta con fichas reales del perfil que **sí se descuentan**, cuotas moviéndose por peso del
dinero real **y** simulado, y verificado que el flujo simulado no toca la exposición ni paga nada.

### Fase E — Frontend `/estadio` (~1.200 líneas)
`public/estadio.html`, `public/estadio.js`, `public/estadio.css`, render canvas 2D con los 16 kits,
panel de relato de dos voces, tabla de posiciones, boleta de apuesta con denominaciones filtradas y
aviso del tope del 25 %, «mis apuestas», enlace «🏟 Estadio» desde el nav.
**Aceptación**: partido visible en canvas con tweening fluido a 60 fps, relato en vivo, apuesta
pre-partido colocable desde la interfaz, probabilidad implícita visible junto a cada cuota, contraste
de kits validado, usable a 1024×720, accesible con teclado y con `prefers-reduced-motion`.

### Fase F — En vivo, cash-out, combinadas, futuros, admin (~800 líneas + ~12 en `lib/profile-store-base.js`)
Mercados en vivo con suspensión y retardo, cash-out, parlays, futuros con Monte Carlo, palancas
admin, `footballSeasonGuard`, subida de `TOS_VERSION` con la cláusula de eventos simulados **y la
declaración del flujo simulado**, y las 6 tablas PG creadas **inline** en `football-store-pg.js`
(hallazgo 4: no hay vía de migraciones usable).

**La subida de `TOS_VERSION` son DOS archivos en el mismo commit**: `lib/terms.js:6` y
`public/app.js:81`. Subir solo el servidor deja a toda la base bloqueada sin modal para re-aceptar
(§12.7, hallazgo 9, decisión A10). T36 lo bloquea en CI, y es prerrequisito de esta fase porque B1
manda lanzar la cláusula junto con la sección.

**Prerrequisito no opcional de esta fase:** el **gate acotado del reset mensual** en
`lib/profile-store-base.js` (`onBeforeSeasonReset` + `SEASON_RESET_MAX_DEFERRALS` + `forceSettle`),
más el registro del gate y el log `season_reset_deferred` en `server.js`. Sin esto, el primer
jugador que reconecte tras la medianoche del día 1 dispara `ensureSeason()` vía `getOrCreate()` y
evapora los stakes escrow-eados (§12.7, hallazgo 6, decisión A7). Es la razón por la que R1 es
**Crítica** y no Alta.

**Aceptación**: T9, T10, T11, T12, T16, T19, **T31, T32**. Temporada completa simulada de día 1 a
cierre sin fichas atrapadas **y sin que el reset pueda quedar congelado**.

**Total: ~5.200 líneas + ~400 de integración.** Las fases A–C se pueden entregar y validar sin que
ningún jugador vea nada (feature flag apagado), lo que reduce muchísimo el riesgo de la primera
iteración.

**Prerrequisito cumplido**: los 16 nombres de clubes ya fueron validados contra clubes reales
(§5.5); siete candidatos fueron rechazados y reemplazados en el proceso. La Fase A puede arrancar
sin pasos humanos pendientes.

---

## 22. Registro de riesgos

| # | Riesgo | Sev. | Mitigación |
| --- | --- | --- | --- |
| R1 | El reset mensual pisa stakes escrow-eados | **Crítica** | `footballSeasonGuard` + **gate acotado dentro de `ensureSeason()`**, no en `seasonSweep` (que no es el único disparador: `getOrCreate()` también lo llama y gana la carrera). Techo `SEASON_RESET_MAX_DEFERRALS` para que el fútbol pueda *retrasar* el reset pero nunca *impedirlo* (§12.6, §15.5, §12.7 h.6, T31/T32) |
| R27 | Poner la guarda del reset en un consumidor (`seasonSweep`) en vez de en el camino del reset, o ponerla sin techo | **Crítica** | La primera deja abierto `getOrCreate()` y los stakes se evaporan igual sin emitir log. La segunda congela el casino: una apuesta atascada veta el reset para siempre. Ambas se materializaron en este documento y se corrigieron (§12.7 h.6, A7) |
| R28 | `debit()` no persiste: `lib/progression.js` es puro y la apuesta sí se escribe *write-through*. Un crash en la ventana de 180 ms deja apuesta viva sin débito → la casa paga fichas que nunca cobró | **Crítica** | `profiles.touch(profile)` obligatorio tras `debit()` + orden WAL (`pending` → débito → `confirmBet`) + una sola transacción con `FOR UPDATE` en Postgres. Reconciliación de arranque anula `pending` huérfanos y cuadra el escrow (§12.7 h.7, A8, T33/T34) |
| R29 | TOCTOU en la colocación: un `await` entre comprobar saldo y debitar permite que dos apuestas simultáneas del mismo perfil pasen ambas contra el mismo saldo | Alta | `executeQuickBet` es síncrono y por eso no lo tiene. En el Estadio: comprobación y `debit()` sin `await` entre medio, o `SELECT … FOR UPDATE` en PG, que serializa por perfil (§12.7 h.7, A8, T34) |
| R30 | `credit(payout)` + `recordOutcome(net)` duplica el historial: dos transacciones y dos puntos de gráfica por apuesta, y con `HISTORY_LIMITS.transactions=20` en archivo el jugador ve la mitad de su historial | Media | Convención de las rondas (`server.js:954`): asignación directa para mover fichas + `recordOutcome` como única línea. `credit()` queda solo para reembolsos por anulación, donde no hay `recordOutcome` (A9, T35) |
| R31 | Subir `TOS_VERSION` solo en `lib/terms.js` produce **lockout total sin salida visible**: el cliente cree que ya aceptó (no muestra el modal) y el servidor rechaza las 6 entradas que consultan `verifyTosAcceptance` | **Crítica** | Los dos archivos viajan en el mismo commit (A10) y T36 lo bloquea en CI. Fuera de alcance: que el cliente consuma `tosVersion` de `/healthz` (`server.js:122`) en vez de hardcodearla, que eliminaría la clase de bug (§12.7 h.9) |
| R32 | Resolver `token`→`profile` con `getOrCreate` en un handler de apuesta regala **1000 fichas por token inventado**, sin techo: los límites de §11.5 son por perfil y cada request trae uno nuevo | **Crítica** | `getOrCreate` aparece **una sola vez** en el Estadio (`football:subscribe`, protegido por `nameIssue` + TOS). Los cuatro handlers de dinero no reciben `token`: leen `socket.data.football` y resuelven con `profiles.profiles.get()`, la lectura estricta que el repo ya usa en `:1640`, `:1855`, `:1921`, `:1955`, `:1973` (§12.7 h.10, A11, T37/T38) |
| R33 | Perfiles sintéticos `'Jugador'` contaminan `_rankedProfiles()`, que no filtra: pueden ganar la medalla y el banner dorado, e inundar el store reescrito completo en cada `saveNow()` de archivo | Alta | Mismo remedio que R32 (no se crean perfiles fuera de `subscribe`) + `nameIssue` exige nombre único global. `pruneInactiveAccounts` a 90 días llega **después** del cierre mensual, así que no es defensa (§12.7 h.10, T38) |
| R34 | Un apagón que cruza fin de mes dispara el reset **durante el arranque del store** —en archivo dentro del constructor, en PG/Neon dentro de `_init()` que la fábrica espera con `await store.ready`—, antes de que el fútbol pueda registrar su guarda: A7 no llega a tiempo y los stakes se evaporan | **Crítica** | `deferSeasonCheck` saca `ensureSeason()` de los **dos** caminos de arranque y la vuelve un paso explícito de `bootstrap()`, **después** de reconciliar y de registrar la guarda. Por defecto `false`, así nada más cambia. Afecta al backend de producción: `DATABASE_URL` vive en el dashboard de Render apuntando a Neon, no en `render.yaml` (§12.7 h.11, A12, T39) |
| R35 | Un apagón largo hace liquidar de golpe cientos de apuestas y dispara la campana D9 por partidos de hace días | Media | Liquidaciones de la reconciliación de arranque **sin campana**: un solo aviso resumen con enlace al detalle. Los replays no emiten `football:goal` en tiempo real (§15.9) |
| R36 | El partido de desempate no se resuelve antes del reset mensual (un `stuck`, un apagón o una prórroga+tanda que se alarga) y retrasa el cierre, o peor, el futuro «Campeón» queda sin liquidar | Media | Se juega en el bloque Estelar del día de cierre con ~2 h de holgura antes de la liquidación (−1 h). Si el −2 h lo encuentra sin resolver, la temporada pasa a `truncated`: el campeón vuelve a los desempates estadísticos de §5.1 y **todos** los futuros se anulan/reembolsan. El reset **nunca** se retrasa por esperar el partido (misma vivacidad que A7). La tanda termina siempre (muerte súbita con PRNG finito) (§7.5, §15.5, T42) |
| R2 | Movimiento de cuotas produce libro arbitrable | **Alta** | Invariante verificada antes de publicar + renormalización (T3) |
| R3 | Cuotas calculadas con un modelo distinto al generador | **Alta** | Marcador muestreado de la misma matriz que fija el precio (§3.3) |
| R4 | Fuga de eventos futuros al cliente | **Alta** | Solo prefijo revelado + test de inspección de payloads (T7) |
| R5 | Subir `TOS_VERSION` fuerza re-aceptación de toda la base | Media | Comunicarlo en el lobby con anticipación; es obligatorio legalmente |
| R6 | `server.js` ya tiene 2.357 líneas y esto suma ~400 | Media | Toda la lógica vive en `lib/football/*`; en `server.js` solo cableado |
| R7 | Escalar a 2 instancias duplica partidos y pagos | Media | Lock de líder obligatorio antes de escalar (§14.4) |
| R8 | `tests/` no existe en el checkout actual | Media | Restaurar o crear el directorio antes de la Fase A |
| R9 | El ritmo de 10 s/min no engancha (demasiado rápido o lento) | Media | `FOOTBALL_SIM_SECONDS_PER_MINUTE` configurable; probar con usuarios en la Fase E |
| R10 | Escribir el JSON completo en cada tick satura el disco | Media | Debounce 10 s + write-through solo para dinero (§13.2) |
| R11 | Colisión de nombres con `#live-lobby` / «Actualización en vivo» | Baja | Renombrar a «Salas activas» (§16, punto 8) |
| R12 | Exposición de la casa en una jornada con cuota larga | Baja | Techos por mercado, partido y jornada + `selection_closed` |
| R13 | Un partido con error bloquea el barrido completo | Baja | `try/catch` por partido + cuarentena + anti-reentrancia (§15.2) |
| R14 | Nombres generados ofensivos por combinación aleatoria | Baja | Pasar por `nameHasProfanity` al generar la temporada |
| R15 | El margen del 7 % (ventaja 6,54 %) drena fichas mucho más rápido que el resto del casino y degrada el ranking mensual | **Alta** | Probabilidad implícita siempre visible, métrica `chips_netos_perdidos_por_juego` desde el día 1, márgenes en env vars para bajarlos sin desplegar código (§10.3, decisión C4) |
| R16 | El flujo simulado se filtra a la interfaz o se confunde con jugadores reales | **Alta** | Nunca viaja en payloads (T19), no cuenta en exposición (T18), se declara en los T&C (§11.6, decisión D8) |
| R17 | Un nombre de club coincide con uno real | **Baja** (era Media) | **Mitigado**: los 16 nombres se validaron por búsqueda y siete candidatos fueron rechazados y reemplazados (§5.5). Residual: no es un estudio de marcas, así que cuatro clubes quedan con riesgo bajo documentado. Si el producto se comercializa, hacer revisión de marcas |
| R18 | El tope del 25 % del saldo se percibe como un fallo frente a los juegos rápidos, que aceptan el 100 % del stack | Media | La boleta lo dice explícitamente y el panel de ayuda explica por qué (decisión C5) |
| R19 | Los 16 kits no se distinguen bien en canvas a 1024×720 | Baja | Validación de contraste WCAG AA entre pares de kits y contra el césped, no a ojo (§5.5) |
| R20 | Usar `credit()` para debitar el stake: no descuenta fichas y no falla, devuelve 0 en silencio | **Crítica** | **Ya materializada en este documento y corregida.** `debit()` nuevo en `lib/progression.js` + T23 y T24 de regresión (§12.7, hallazgo 1) |
| R21 | Confiar en `AVAILABLE_GAMES` para excluir al fútbol de los retos: `trackPeriod` no lo consulta | Media | **Ya materializada en la decisión C6 y corregida.** Filtro `CHALLENGE_GAMES` + T25 (§12.7, hallazgo 2) |
| R22 | Guardar `gameStats.football` sin entrada en `GAME_META`: datos correctos e invisibles | Media | **Ya materializada en la decisión E10 y corregida.** Una línea en `public/app.js:68` + T26 (§12.7, hallazgo 3) |
| R23 | Que queden más afirmaciones de integración sin verificar contra el código | **Alta** | Regla de la Fase A: **ninguna afirmación de integración entra al código sin leer la función**, más sus tres corolarios —toda mitigación se verifica contra los dos extremos (el fallo que evita y el que puede causar); toda mutación de fichas se verifica contra su camino de persistencia, no solo su aritmética; toda constante duplicada servidor/cliente lleva una prueba que compare ambas copias. **Nueve** afirmaciones resultaron falsas o inviables al aplicar la regla; las nueve eran plausibles y habrían pasado una revisión superficial (§12.7) |
| R24 | El esquema del Estadio necesitará alterarse y el patrón inline (`IF NOT EXISTS`) crea pero no altera | Media | Se materializa en la **primera** alteración de esquema, no en la Fase A. Ahí hay que arreglar la vía de migraciones: crear `migrations/`, escribir los `.sql` y agregar `preDeployCommand: npm run migrate:db` a `render.yaml`. T29 impide reintroducir la dependencia a medias (§12.7 hallazgo 4) |
| R25 | Siete tablas administrativas no las crea nadie y fallarán al encender `ADMIN_FEATURE_ENABLED` con `DATABASE_URL` | Media | **Bug preexistente, no del Estadio.** Latente porque el flag nace apagado y los stores no se instancian. Reportar y arreglar por separado (decisión A5); no mezclar con esta feature |
| R26 | Validar la config del Estadio después de `server.js:60` convierte el arranque fail-closed en un proceso zombi que no escucha | **Alta** | `loadFootballConfig()` se invoca junto a la línea 35 o dentro de `bootstrap()`, nunca en otro punto del módulo. T30 fija la posición con una prueba, no con un comentario (§12.7 hallazgo 5, decisión A6) |

---

## 23. Decisiones cerradas

Todo lo que estaba abierto quedó resuelto el 2026-10-07. Se registra aquí con su consecuencia, para
que no se vuelva a discutir sin motivo y para que quien retome el trabajo sepa **por qué** es así.

| # | Decisión | Resolución | Consecuencia que hay que respetar |
| --- | --- | --- | --- |
| **A1** | No existe `.gitignore` en el repo | **Crearlo** en esta misma rama | Hecho: `node_modules/`, `.env`, `*.log`, `.DS_Store`, coberturas |
| **A2** | `tests/` nunca se commiteó (2 commits, cero rastros) y `npm test` falla desde el inicio | **Crear el directorio** con las pruebas del motor y un script propio `test:football`; no se intenta restaurar lo irrecuperable | Los 25 archivos `tests/*.test.js` que referencia `package.json` siguen sin existir. Arreglarlos es trabajo aparte y no bloquea nada |
| **A3** | `data/profiles.json` trackeado como semilla; correr el servidor local lo ensucia | **Dejarlo como está** | Menor. Solo saber que `git status` puede mostrarlo modificado tras una corrida local |
| **A4** | La vía de migración PG está rota: `migrations/` no existe, `npm run migrate:db` falla con ENOENT y ningún deploy la ejecuta | **Crear las 6 tablas inline** en `lib/football-store-pg.js` con `CREATE TABLE IF NOT EXISTS`, como hace `profile-store-pg.js` | Es el único store PG que funciona hoy en producción sin intervención manual. Límite: `IF NOT EXISTS` crea pero **no altera** — la primera alteración de esquema obliga a arreglar la vía de migraciones (R24). §12.7 hallazgo 4 |
| **A5** | Siete tablas administrativas (`montecristo_audit_log`, `montecristo_reports`, `montecristo_account_sessions`, etc.) no las crea nadie | **Fuera del alcance de esta feature**: reportarlo por separado | Bug **preexistente y latente**: esos stores están tras `ADMIN_FEATURE_ENABLED`, que nace apagado, así que nunca se instancian. El día que alguien encienda la administración con `DATABASE_URL`, fallan en su primera consulta. No debe mezclarse con el Estadio |
| **A6** | El fail-closed de la admin funciona por `throw` en `server.js:35`, **antes** de que la línea 60 instale la red `uncaughtException` — no por `process.exit(1)`, que no aparece en `lib/admin-config.js` | **`loadFootballConfig()` se invoca junto a la línea 35 o dentro de `bootstrap()`**, nunca en otro punto del módulo | Copiar el `throw` sin copiar la posición lo hace tragar por la red: proceso vivo sin `server.listen()`, zombi que no responde `/healthz`. Fail-closed convertido en fail-open por 25 líneas de distancia (§12.7 hallazgo 5, T30, R26) |
| **A7** | La guarda contra R1 estaba en `seasonSweep`, que **no** es el único camino del reset: `getOrCreate()` también llama a `ensureSeason()` en cada conexión y gana la carrera. Y un veto sin techo congela el casino | **Gate acotado dentro de `ensureSeason()`** (`onBeforeSeasonReset` + `SEASON_RESET_MAX_DEFERRALS=12`), con `forceSettle` al agotarse | Cubre los dos disparadores y garantiza vivacidad: **el fútbol puede retrasar el reset, nunca impedirlo**. Cuesta ~12 líneas en `profile-store-base.js` + ~20 en el motor + ~6 en `server.js`, no las ~10 en `server.js` que prometía el documento (§12.7 hallazgo 6, T31/T32, R27) |
| **A8** | `debit()` no persiste (módulo puro) mientras la apuesta sí se escribe *write-through*: un crash en la ventana de 180 ms deja apuesta viva sin débito. Y un `await` entre comprobar saldo y debitar abre un TOCTOU | **Orden WAL** (`pending` → débito + `profiles.touch()` → `confirmBet`) **y, en Postgres, una sola transacción** con `SELECT … FOR UPDATE` sobre un `client` compartido | `lib/progression.js` **sigue puro**: no se le inyecta el store, porque la convención del repo es que el llamador persiste (`server.js:590`, `:1091`). Ambos patrones ya existen: dos fases en `MemoryIdempotencyStore` (`processing`→`completed`) y transacción multi-tabla en `applyMfaResetAtomic` / `consumeAndApply`. `football-store-pg` recibe el pool por parámetro como `password-reset-store-pg` (§12.7 h.7, T33/T34, R28/R29) |
| **A9** | `credit(payout)` + `recordOutcome(net)` escribe dos transacciones y dos puntos de gráfica por liquidación; con `HISTORY_LIMITS.transactions=20` en archivo el jugador ve la mitad de su historial. Y contradecía lo que §12.1 afirmaba dos páginas antes | **Convención de las rondas**: `profile.chips += payout` (asignación directa, como `server.js:954`) + `recordOutcome` como **única** línea de historial + `profiles.touch()`. `credit()` queda solo para reembolsos por anulación, donde no hay `recordOutcome` | Es exactamente la distinción que ya hace el casino entre `:954` (rondas) y `:1091` (premio de torneo sin ronda). De paso corrige §4: «las fichas solo se mueven dentro de `lib/progression.js`» es falso, `server.js` las mueve directo en ≥5 sitios (§12.7 h.8, T35, R30) |
| **A10** | Subir `TOS_VERSION` solo en `lib/terms.js` —lo que prescribía §16 fila 10 y ordena la decisión B1— deja a toda la base fuera **sin modal para volver a aceptar** | **Los dos archivos en el mismo commit**: `lib/terms.js:6` **y** `public/app.js:81`, más T36 como prueba de bloqueo en CI | El cliente hardcodea la versión y la usa para las dos puntas del protocolo (`tosAccepted()` `:87`/`:105` y el `tos:` que envía `:2189`). Con versiones distintas el modal nunca aparece y las 6 entradas que consultan `verifyTosAcceptance` rechazan todo. Fuera de alcance: que el cliente consuma `tosVersion` de `/healthz` (`server.js:122`), que eliminaría la clase de bug (§12.7 h.9, T36, R31) |
| **A11** | §14 nunca decía cómo `token` se vuelve `profile`. El camino obvio —copiar `lobby_chat_join` y usar `getOrCreate`— regala `INITIAL_CHIPS = 1000` por cada token inventado, sin techo, porque los límites de §11.5 son **por perfil** y cada request trae uno nuevo | **`getOrCreate` aparece una sola vez en el Estadio**: en `football:subscribe`, protegido por `nameIssue` + `verifyTosAcceptance`. Los cuatro handlers de dinero **no reciben `token`**: leen `socket.data.football` y resuelven con `profiles.profiles.get()` | Es el patrón que el repo ya usa: `lobby_chat` (`:1866`) lee `socket.data.lobbyChat` y nunca vuelve a mirar el token; la lectura estricta `profiles.profiles.get()` está en `:1640`, `:1855`, `:1921`, `:1955`, `:1973`. Además evita contaminar `_rankedProfiles()` (que no filtra) y el crecimiento sin cota del store (§12.7 h.10, T37/T38, R32/R33) |
| **A12** | A7 no llega a tiempo en el arranque: **ambos** backends llaman a `ensureSeason()` durante la construcción —archivo en el constructor (`profile-store.js:17`), PG/Neon en `_init()` (`profile-store-pg.js:116`), que la fábrica espera con `await store.ready` (`:18`)—, y `bootstrap()` construye el store en su primera línea, así que el reset corre antes de que el fútbol pueda registrar su guarda. Es huevo y gallina: la guarda se registra *sobre* el store | **`deferSeasonCheck`** saca el chequeo de los **dos** caminos de arranque y lo vuelve un paso explícito de `bootstrap()`, en orden: reconciliar fútbol → registrar guarda → `lastSeasonRepair` → `ensureSeason()`. Viaja en el `options`/`poolOptions` que la fábrica ya propaga a ambos constructores | El backend de **producción es PG/Neon**: `DATABASE_URL` vive en el dashboard de Render, no en `render.yaml`. Una versión anterior de este hallazgo creía que producción corría archivo y que PG era inmune; **las dos premisas eran falsas** (ver §12.7 h.11). Nace en `false` para que nada más cambie. Mover `lastSeasonRepair` es obligatorio o el aviso se pierde en silencio (§12.7 h.11, T39, R34) |
| **A13** | El catálogo de §7.2 listaba `penalty_awarded/scored/missed` y §10.6 suspendía cuotas con un penal, pero el generador de §7.3 **nunca los producía**: no había `planPenalties`. Los tres tipos eran letra muerta y ningún partido tenía penales (≈1 de cada 4 en el fútbol real) | **`planPenalties` en §7.4**: ~0.25 señalados/partido, conversión 0.76, xG 0.79. Un penal convertido **re-etiqueta un gol ya sorteado**, nunca añade uno nuevo | La regla de re-etiquetado protege R3/§3.3: el marcador se muestrea de la matriz de Poisson que fija las cuotas, así que sumar goles por fuera la falsearía. Corolario: `score=0` no puede tener penal convertido (se degrada a `penalty_missed`), lo que baja levemente la conversión efectiva —sesgo aceptable, medido en T41 (§7.4, T41) |
| **A14** | El campeón se definía por **sorteo sembrado** si empataba en la cima tras los desempates de tabla. Es anticlimático y débil: el título de una liga se decide en cancha | **Partido de desempate** (prórroga 2×15' + tanda de penales si hace falta) cuando el **1.º puesto** empata tras diferencia de goles → goles a favor → resultado directo (§7.5) | Solo el 1.º puesto; `top4`/`top2` empatados se anulan y reembolsan (no se definen por sorteo ni por cancha). Se juega en el bloque Estelar del día de cierre, ~25-30 min, y **debe resolverse antes del −2 h** o la temporada pasa a `truncated` y el campeón vuelve a los desempates estadísticos. Seed propio `hash32('desempate'│mes│eq1│eq2)`, tanda reproducible y auditable. Mercado «Gana el desempate» 2-vías (§11.2-bis). El reset **nunca** se retrasa por esperarlo (§7.5, §11.2-bis, §15.5, T42) |
| **B1** | `TOS_VERSION` debe subir por agregar apuestas deportivas simuladas | **Subir la versión y lanzarla junto con la sección**, una sola re-aceptación | La cláusula debe decir: eventos **simulados y ficticios**, resultado generado por el servidor, y **declarar el flujo simulado** de §11.6 |
| **B2** | «En Vivo» colisiona con el lobby de salas | **«Estadio MonteCristo»**, ruta `/estadio`, `public/estadio.*`, `/api/estadio/*` | `#live-lobby` y `.live-section` **no se tocan**. Vocabulario interno único: `football` |
| **B3** | Sabor de los 16 clubes | **Internacional neutro** (Vantora FC, United Vanguard…), **ya validados contra clubes reales** | Tabla y validación en §5.5. Siete candidatos fueron rechazados por colisión real y reemplazados. Cambiar nombres después de publicada la jornada 1 rompe la continuidad, así que esta lista se considera definitiva |
| **C4** | Margen de casa | **7 %** en mercados principales | Queda en **6,54 % de ventaja**, más del doble que la ruleta (2,6–3,25 %) y que las slots (2,26 %), y muy por encima de dados y cara o cruz (~0 %). Obliga a: probabilidad implícita siempre visible, métrica de drenaje comparada por juego desde el día 1, y márgenes en env vars para poder bajarlos sin desplegar código (§10.3) |
| **C5** | Límites de apuesta | **Máximo 25 % del saldo**, techo absoluto 25.000 | Jugador recién reiniciado: 10–250 fichas. Es **más restrictivo que los juegos rápidos**, que aceptan el 100 % del stack (`server.js:1311`): la boleta debe decirlo explícitamente. Funciona como limitador de pérdida natural (§11.3) |
| **C6** | ¿Cuenta fútbol para los retos «prueba N juegos»? | **No se agrega a `AVAILABLE_GAMES`**, y además se filtra en `trackPeriod` | **Corregido**: `AVAILABLE_GAMES` por sí solo **no** excluye al fútbol de esos retos (§12.7). Sin el filtro extra, «Turista del día» y «Ruta del casino» contarían el Estadio como un juego más |
| **D7** | Ritmo del partido | **10 s por minuto simulado** → 16:05 a 17:05 reales | Es la palanca que más cambia la sensación del producto. Configurable; conviene validarla con usuarios reales mirando un partido antes de fijarla |
| **D8** | Apostadores simulados | **Sí**: flujo sintético invisible, etiquetado en logs como `football_simulated_flow` | **Nunca** aparece como jugador real en interfaz, chat o rankings. **No** cuenta para exposición ni responsabilidad. Su influencia decae con el dinero real y **se declara en los T&C** (§11.6) |
| **D9** | Notificaciones con la campana | **Solo dos**: apuesta liquidada y comienzo de un partido con apuesta abierta | Nada de avisar movimientos de cuota: satura y entrena a ignorar la campana |
| **E10** | Historial descargable y gráfica de saldo | **Incluir el fútbol** | **Corregido**: la gráfica de saldo sí se alimenta sola (vía `snapshotBalance`), pero el panel «Historial por juego» itera `GAME_META`, no `gameStats`, así que exige **una línea** en `public/app.js:68` o los datos quedan guardados e invisibles (§12.7, hallazgo 3) |
| **E11** | Escalar a varias instancias | **Nada ahora**; queda como prerrequisito obligatorio | El *lock* de líder con `pg_try_advisory_lock` es **requisito antes** de escalar, no una mejora. Sin él, dos instancias duplican partidos y pagan dos veces (§14.4) |
| **E12** | Descenso y continuidad entre meses | **Sin descenso real**; campeón y colista ajustan el rating inicial del mes siguiente | Continuidad narrativa sin acumular complejidad |
| **E13** | Riesgos bloqueantes R1–R3 | **No son decisiones**: son invariantes con prueba automática | Guarda del reset mensual (T12), invariante anti-arbitraje (T3), coherencia modelo-generador (T9) |
| **E14** | Orden de entrega | **Fases A–C con el flag apagado**, invisibles para el jugador | Solo después se abre la Fase E con la interfaz |

### No queda nada abierto

Las 28 decisiones están cerradas y la validación de nombres de clubes que era el único prerrequisito
humano **ya se hizo** (§5.5): siete candidatos chocaron con clubes reales y fueron reemplazados por
nombres verificados a su vez.

Lo único que no se puede cerrar desde aquí es un **estudio formal de marcas**, que solo tendría
sentido si el producto llegara a comercializarse más allá de su círculo actual. Está registrado como
riesgo residual bajo en R17, con los cuatro clubes de riesgo documentado identificados uno por uno.

**La Fase A puede arrancar sin pasos previos.**

---

## 24. Anexo A — Mapa de archivos

### Nuevos

```
lib/football/prng.js                 mulberry32 + hash32 determinista
lib/football-config.js               Validación fail-closed de FOOTBALL_* (§12.7 h.5, decisión A6)
lib/football/ratings.js              Elo, ataque/defensa, ventaja de local, actualización
lib/football/teams.js                16 clubes neutros (§5.5) + generador de plantillas
lib/football/fixtures.js             Calendario doble vuelta y parrilla diaria (§5)
lib/football/match-engine.js         Generador determinista de línea de tiempo (§7), incluidos
                                     planPenalties (§7.4, A13) y la prórroga + tanda del partido
                                     de desempate (§7.5, A14)
lib/football/commentary.js           Dos voces, plantillas, memoria anti-repetición (§9)
lib/football/odds.js                 Poisson, Dixon-Coles, margen, WOM, en vivo, cash-out (§10),
                                     y el precio 2-vías del mercado «Gana el desempate» (§11.2-bis)
lib/football/simulated-flow.js       Flujo sintético con decaimiento y contabilidad separada (§11.6)
lib/football/betting.js              Mercados, escrow, idempotencia, liquidación, parlays, futuros (§11).
                                     Orden WAL en la colocación: pending → debit + profiles.touch()
                                     → confirmBet (§12.7 h.7, decisión A8)
lib/football/scheduler.js            Sweeps, watchdogs, reconciliación (§15)
lib/football-store-shared.js         Limpieza y normalización compartidas
lib/football-store.js                Backend de archivo JSON
lib/football-store-pg.js             Backend Postgres. Recibe { pool } del store de perfiles en vez de
                                     crear el suyo, y coloca la apuesta en UNA transacción con
                                     SELECT … FOR UPDATE (§12.7 h.7, A8). Crea sus 6 tablas inline (h.4)
lib/football-store-factory.js        Selección de backend (DATABASE_URL); en PG propaga profiles.pool
lib/football-engine.js               Fachada que une motor + cuotas + apuestas + scheduler
public/estadio.html                  Página de la sección
public/estadio.js                    Render canvas 2D, relato, boleta, tabla
public/estadio.css                   Estilos de la sección
public/assets/estadio-hero.jpg       Imagen original para el nav/hero
public/assets/estadio-pitch.jpg      Textura de césped (opcional)
tests/football-*.test.js             T1–T32
docs/estadio-montecristo.md          Este documento
```

### Modificados

```
server.js                            Cableado: sockets football:*, rutas /estadio y /api/estadio/*,
                                     sweeps, bootstrap, shutdown, healthz, registro del gate de
                                     temporada y log de season_reset_deferred      (~400 líneas)
lib/profile-store.js                 deferSeasonCheck en el constructor (backend de archivo):
                                     ensureSeason() deja de correr antes de que el fútbol pueda
                                     registrar su guarda (§12.7 h.11, A12)          (~4 líneas)
lib/profile-store-pg.js              deferSeasonCheck en _init() (backend PG/Neon, el de
                                     producción): la fábrica hace await store.ready antes de
                                     devolver el store, así que ensureSeason() (:116) corría en el
                                     arranque igual que en archivo (§12.7 h.11, A12) (~4 líneas)
lib/profile-store-factory.js         Propaga deferSeasonCheck por el options/poolOptions que ya
                                     acepta a ambos constructores; sin firma nueva  (~2 líneas)
lib/profile-store-base.js            Gate ACOTADO del reset mensual: onBeforeSeasonReset() +
                                     SEASON_RESET_MAX_DEFERRALS dentro de ensureSeason(),
                                     ANTES de tocar profile.chips (§12.7 h.6, A7)   (~12 líneas)
lib/progression.js                   Exportar debit() nuevo + filtrar trackPeriod por
                                     CHALLENGE_GAMES (§12.7, hallazgos 1 y 2)      (~15 líneas)
public/app.js                        GAME_META += football (§12.7, hallazgo 3) + enlace al Estadio;
                                     sin lógica de fútbol                            (~5 líneas)
                                     + línea 81: TOS_VERSION debe subir EN EL MISMO
                                     commit que lib/terms.js (§12.7 h.9, A10, T36)
public/index.html                    Enlace «🏟 Estadio» en el nav (decisión B2: #live-lobby intacto)
lib/terms.js                         TOS_VERSION + cláusula de eventos simulados y flujo simulado
public/terminos.html                 Texto legal actualizado
scripts/migrate-db.js                SIN CAMBIOS: el DDL va inline en football-store-pg.js (§12.7 h.4)
render.yaml                          Variables FOOTBALL_*
package.json                         Script test:football (los test:* existentes siguen rotos, A2)
README.md                            Sección «Estadio MonteCristo» documentada
```

`AVAILABLE_GAMES` en cambio **no se toca**: la decisión C6 sigue en pie y su efecto real es sobre el
logro `explorer` («Tour del casino»), que continúa exigiendo los seis juegos de mesa.

Los dos cambios en `lib/progression.js` son obligatorios, no opcionales. Sin `debit()` el escrow no
existe (apuestas sin descontar fichas); sin el filtro en `trackPeriod` la decisión C6 no produce el
efecto que se buscaba. Ambos están verificados contra el código en §12.7 y cubiertos por T23–T27.

---

## 25. Anexo B — Ciclo de vida de un partido (línea de tiempo real)

```
Ejemplo con 2' de agregado en el primer tiempo y 3' en el segundo (95 minutos simulados totales
= 950 s + 45 s de intermedio ≈ **16:35 reales**). Todos los tiempos son reales desde el kickoff;
entre paréntesis, el minuto simulado.

```
T-5:00     footballKickoffSweep pre-genera la línea de tiempo y publica cuotas pre-partido
           → mercados 1X2, doble oportunidad, altas/bajas, marcador exacto, combinadas habilitadas
           → las cuotas empiezan a moverse por peso del dinero
T-0:00     kickoff (0'). status: scheduled → live. Mercados pre-partido cierran. Abren los en vivo.
           → football:event {type:'kickoff'} + narrador: «¡Rueda el balón en el Arena Boreal!»
T+0:02     primer football:tick. El canvas arranca el tweening.
...        eventos revelados según su minuto simulado; cuotas en vivo recalculadas en cada cambio
T+3:20     ¡Gol! (20') → suspended = true (15 s), mercados bloqueados, banner en pantalla,
           narrador + analista, recálculo de λ restantes
T+3:35     suspended = false. Se reanudan apuestas y cash-out con cuotas nuevas.
T+7:50     halftime (47' = 45 + 2 de agregado). status: live → halftime.
           → mercados de primer tiempo se liquidan; el analista hace el balance:
             posesión, tiros, xG y qué necesita cada equipo según la tabla
T+8:35     second_half, tras 45 s de intermedio. status → live.
T+11:15    Tarjeta roja (63') → suspended, cuotas en vivo con factor de expulsión, relato especial
T+16:35    full_time (95'). status → finished. Todos los mercados en vivo cierran. suspended = true.
T+16:37    footballSettlementSweep liquida: ganadoras pagan, perdedoras cierran, combinadas resuelven
           patas, cash-outs ya cerrados. → football:settlement + profile_event
T+16:40    ratings actualizados (Elo + att/def), tabla de posiciones y forma recalculadas
T+16:45    status → settled. El partido sigue visible en «Resultados» y se poda de memoria a las 2 h.
T+17:30    Si ya se jugó toda la jornada: Monte Carlo de futuros (~400 ms) y cuotas de campeón
           republicadas para el día siguiente.
```

Los bloques diarios están separados por horas (13:00 / 18:00 / 21:30) y la segunda oleada de un día
de doble jornada arranca a +35 min: con ~17 min de partido real nunca se solapan dos transmisiones.
```

---

## 26. Conclusión

El diseño es viable y encaja con las convenciones que el repo ya estableció: módulos en `lib/` con
patrón de fábrica para persistencia, servidor como única autoridad, barridos con `try/catch` y
`unref`, fichas moviéndose solo por `lib/progression.js`, idempotencia y auditoría reutilizadas, y
feature flag *fail-closed*.

La apuesta arquitectónica importante —y la que hace que el resto sea sencillo— es la **línea de
tiempo determinista pre-generada**. Convierte «un sistema que debe estar vivo siempre» en «un
sistema cuyo estado se puede recalcular en cualquier momento», que es la única forma honesta de
prometer que los partidos nunca se quedan colgados, que un deploy no pierde dinero de nadie y que
las cuotas en vivo no mienten.

Los tres riesgos que hay que tratar como bloqueantes, no como detalles: la **guarda del reset
mensual** (R1), la **invariante anti-arbitraje** (R2) y la **coherencia entre el modelo que genera
el partido y el modelo que fija el precio** (R3). Los tres tienen prueba automática asignada. R1 subió
de **Alta** a **Crítica** cuando la verificación mostró que su mitigación original no funcionaba
(hallazgo 6).

A esos tres se sumaron otros once que no estaban previstos y que salieron de contrastar cada
afirmación de integración contra el código (§12.7). Cinco eran citas falsas de funciones existentes,
uno era un defecto de diseño del propio documento, y los tres últimos eran las dos cosas a la vez —una
cita mal leída que además invalidaba un diseño ya escrito:

1. **R20 (crítico).** `credit()` hace `Math.max(0, …)` y por tanto **no puede debitar**. El escrow
   tal como estaba descrito habría creado apuestas sin descontar una sola ficha, devolviendo `0` en
   silencio y sin dejar rastro en los logs. Es el bug más grave de todos los que aparecen en este
   documento, y lo había introducido yo al escribirlo.
2. **R21.** `AVAILABLE_GAMES` **no** excluye al fútbol de los retos rotatorios: `trackPeriod` no
   consulta esa lista. Esto invalidaba la premisa sobre la que tomaste la decisión C6.
3. **R22.** El desglose por juego itera `GAME_META`, no `gameStats`: sin una línea en
   `public/app.js:68` los datos del Estadio se guardarían correctamente y no se verían nunca.
4. **R24/R25 (estructural).** La vía de migración a Postgres está rota de punta a punta:
   `migrations/` no existe, `npm run migrate:db` falla con ENOENT y ningún deploy la ejecuta. Mi
   instrucción de migración era inejecutable, y de paso apareció que **siete tablas administrativas
   del casino no las crea nadie** — un bug preexistente y latente, separado de esta feature (A5).

5. **R26 (el más sutil).** Prescribí `process.exit(1)` «igual que la admin», pero
   `lib/admin-config.js` no contiene un solo `process.exit`: hace `throw`. Y ese throw mata el proceso
   **solo porque corre en `server.js:35`, antes de que la línea 60 instale la red
   `uncaughtException`**. Copiar el mecanismo sin copiar la posición hace que la red se trague el
   error: proceso vivo, sin `server.listen()`, zombi que no responde `/healthz`. Fail-closed
   convertido en fail-open por 25 líneas de distancia.

6. **R27 (el más grave, y de otra naturaleza).** No era una cita falsa sino un **defecto de diseño
   del propio documento**, y estaba en la mitigación del riesgo que el documento llamaba el más
   importante de toda la integración. La guarda contra R1 iba en `seasonSweep`, suponiendo que ese era
   el único camino que reinicia las fichas. No lo es: el reset vive en `ensureSeason()`
   (`profile-store-base.js:94`), que también se dispara desde `getOrCreate()` (línea 178) en **cada
   conexión de socket**. El primer jugador que reconecte a las 00:00:00.3 del día 1 gana la carrera y
   evapora los stakes sin que el `logEvent('season_reset_deferred')` llegue nunca a emitirse. Y aun
   puesta en el lugar correcto, la guarda era un **veto sin techo**: una sola apuesta atascada
   congelaba el reset mensual para siempre —sin podio, sin medallas, sin banner—, dándole a un módulo
   nuevo y opcional poder de veto permanente sobre la economía central del casino. Corregido con un
   gate **dentro** del camino del reset y **acotado** por `SEASON_RESET_MAX_DEFERRALS`, tras el cual
   el motor anula y reembolsa al contado: el fútbol puede retrasar el reset, nunca impedirlo.

7. **R28/R29 (el que crea dinero).** `lib/progression.js` es un módulo **puro** —su único `require`
   en todo el archivo es `HISTORY_LIMITS`—, así que el `debit()` que prescribía §12.1 **no persiste
   nada**: solo muta memoria. La durabilidad la aporta el llamador con `profiles.touch(profile)`, que
   es la convención real del repo (`server.js:590` tras `recordOutcome`, `:1091` tras `credit`);
   `executeQuickBet` no lo necesita solo porque asigna a `player.chips`, cuyo setter ya toca. Mi
   listado de `debit()` no mencionaba `touch()` en ninguna parte, y §13.2 afirmaba que «con Postgres
   las escrituras de dinero son transaccionales» — cierto **dentro** de cada store, falso **entre**
   stores. El resultado: la apuesta se escribe *write-through* al instante y las fichas quedan en un
   debounce de 180 ms que nadie agenda. Un crash en esa ventana deja **la apuesta viva y el stake sin
   descontar**, y al reiniciar se liquida contra un saldo que todavía lo contiene: la casa paga fichas
   que nunca cobró. Es la dirección silenciosa —el orden inverso le cuesta el stake a un jugador y se
   nota. De paso, un `await` entre comprobar saldo y debitar abría un TOCTOU por el que dos apuestas
   simultáneas del mismo perfil pasaban ambas contra el mismo saldo. Corregido con orden WAL
   (`pending` → débito + `touch` → `confirmBet`), una sola transacción con `SELECT … FOR UPDATE` en
   Postgres, y dos pasos nuevos en la reconciliación de arranque.

8. **R30 (el que duplica el historial).** §12.3 prescribía liquidar con
   `credit(profile, payout) + recordOutcome(…)`. Leídas las dos funciones, `credit()` escribe
   `addTransaction(payout)` y `snapshotBalance()`, y `recordOutcome()` —que **no toca `profile.chips`
   en ningún punto**— escribe `addTransaction(net)` y `snapshotBalance()` otra vez. Cada apuesta
   liquidada habría producido **dos líneas de historial y dos puntos de gráfica**, contradiciendo de
   frente lo que §12.1 afirmaba dos páginas antes («el movimiento se explica al liquidar, con el `net`
   de `recordOutcome`»). Con `HISTORY_LIMITS.transactions = 20` en el backend de archivo, el jugador
   veía sus últimas ~10 apuestas en vez de ~20. La convención real del casino no usa `credit()` para
   pagar rondas: `awardSinglePokerWinner` (`server.js:954`) hace `player.chips += payout` y luego
   `completePlayerRound` → `recordOutcome`. Corregido replicando esa convención (A9).

9. **R31 (el que bloquea el casino entero).** §16 fila 10 mandaba subir `TOS_VERSION` en
   `lib/terms.js:6`. La versión está **duplicada a propósito** en `public/app.js:81`, y el cliente la
   usa para las dos puntas del protocolo: decidir si muestra el modal (`tosAccepted()`, `:87`/`:105`)
   y qué versión envía (`:2189`). Subiendo solo el servidor, el cliente sigue creyendo que el jugador
   ya aceptó —**el modal nunca aparece**— mientras `verifyTosAcceptance` cae a su `return` final y
   devuelve `false`, así que las seis entradas que la consultan (`:1701`, `:1722`, `:1751`, `:1795`,
   `:1859`, `:1980`) rechazan todo con «Debes aceptar los Términos y Condiciones vigentes para jugar».
   **Lockout total sin ninguna pantalla para salir**, provocado exactamente por el cambio que la
   decisión B1 manda hacer. Corregido: los dos archivos viajan en el mismo commit y T36 lo bloquea en
   CI (A10).

10. **R32/R33 (el que regala fichas, y era un hueco, no un error).** La tabla de §14.1 definía
    `football:bet` con un `token` en el payload y una columna «Valida» que decía *saldo, límites…*,
    pero **en ningún lugar del documento se decía cómo se pasa de `token` a `profile`**. El camino
    obvio es copiar el único handler room-less que existe (`lobby_chat_join`, `server.js:1858`), que
    resuelve con `profiles.getOrCreate(id, name)` — y `getOrCreate`
    (`profile-store-base.js:177`) **crea** cuando el id no existe, con `INITIAL_CHIPS = 1000` y el
    nombre defaulteado a `'Jugador'`. En el chat eso es legítimo: es la puerta de entrada al casino y
    está protegida por `nameIssue` y `verifyTosAcceptance`. Puesto en un handler de apuesta es una
    fuente inagotable de saldo, porque el `token` lo elige el cliente y los límites de §11.5 (20
    apuestas y 50.000 de exposición) son **por perfil**: cada request con un token nuevo trae un
    perfil nuevo con 1000 fichas. Además `_rankedProfiles()` ordena `[...this.profiles.values()]` sin
    filtrar, así que esos perfiles sintéticos pueden ganar la medalla y el banner dorado del cierre
    mensual, y cada uno se persiste —con el backend de archivo, `saveNow()` reescribe el JSON completo
    cada 180 ms, así que una inundación de tokens es también un DoS de disco. `pruneInactiveAccounts`
    limpia a los 90 días, mucho después del podio que ya se contaminó. Corregido con la decisión A11:
    `getOrCreate` aparece **una sola vez** en el Estadio (`football:subscribe`), los cuatro handlers de
    dinero **no reciben `token`** y leen `socket.data.football` con la lectura estricta
    `profiles.profiles.get()`.

11. **R34 (el que anula una corrección anterior — y que yo mismo escribí mal la primera vez).** Salió
    de responder una pregunta operativa —¿qué pasa si el servidor está caído varios días?— y no de
    verificar una cita. A7 había puesto la guarda del reset **dentro** de `ensureSeason()` para cubrir
    sus dos disparadores conocidos. Pero hay un tercero: **ambos** backends llaman a `ensureSeason()`
    durante la construcción del store —el de archivo dentro del constructor (`profile-store.js:17`), el
    PG/Neon dentro de `_init()` (`profile-store-pg.js:116`), que la fábrica espera con `await
    store.ready` (`:18`) antes de devolver la instancia—, y `bootstrap()` construye el store en su
    primera línea. La guarda se registra *sobre* el store, así que necesita que la instancia exista — y
    para cuando existe, el reset ya corrió. **Ningún orden de registro dentro de `bootstrap()` llega a
    tiempo.** La primera versión de este hallazgo afirmaba que producción corre el backend de archivo
    (porque `render.yaml` no lista `DATABASE_URL`) y que el PG era inmune. **Las dos premisas eran
    falsas**: `DATABASE_URL` vive en el dashboard de Render apuntando a Neon, así que producción corre
    PG, y PG **no** es inmune —`_init()` llama a `ensureSeason()` igual que el constructor de archivo.
    El error no cambiaba la conclusión, la volvía más grave: el backend que falla es justo el de
    producción. El disparador es un apagón de varios días que cruza fin de mes: al arrancar, todo el
    mundo queda en `INITIAL_CHIPS = 1000` antes de que el fútbol pueda reclamar sus stakes. Corregido
    con `deferSeasonCheck` en los **dos** backends (nace en `false`, nada más cambia) y un orden
    explícito de 13 pasos en §15.6 donde reconciliar va **antes** de resetear.

Las once estaban bien redactadas, eran plausibles y habrían pasado una revisión superficial. Ninguna
habría fallado en pruebas unitarias del motor: todas fallaban **solo** al conectarse con el código
existente —y la sexta, la séptima y la octava fallaban además al conectarse consigo mismas, porque dos secciones
del documento describían comportamientos incompatibles y cada una era correcta por separado. De ahí la
regla que queda para la Fase A, registrada como R23: **ninguna afirmación de integración entra al
código sin leer la función**, y sus tres corolarios:

- **Toda mitigación se verifica contra los dos extremos** —el fallo que evita y el fallo que puede
  causar— (hallazgo 6: la guarda protegía un camino de dos y, de haber funcionado, podía congelar el
  casino).
- **Toda mutación de fichas se verifica contra su camino de persistencia**, no solo contra su
  aritmética (hallazgos 1, 7 y 8: las tres veces la cuenta daba bien y el dinero no llegaba a disco,
  o llegaba dos veces al historial).
- **Toda constante duplicada entre servidor y cliente lleva una prueba que compare ambas copias**
  (hallazgo 9: `TOS_VERSION` existe en dos archivos y nada verificaba que coincidieran; el comentario
  «debe coincidir» era la única defensa).

Dos decisiones de producto se tomaron en contra de la recomendación técnica y quedan registradas con
su consecuencia en §23, no para reabrirlas sino para gestionarlas: el **margen del 7 %** deja al
Estadio en 6,54 % de ventaja frente al 0–3,25 % del resto del casino (R15), y el **tope del 25 % del
saldo** es más restrictivo que los juegos rápidos, que aceptan el 100 % del stack (R18). Ambos se
mitigan con transparencia en la interfaz y con configurables en variables de entorno, de modo que
pueden ajustarse sin desplegar código si los datos de las primeras semanas lo piden.

Otras dos decisiones no salieron de la verificación contra el código sino de tu retroalimentación
directa, y por eso no figuran entre los once hallazgos: **A13** y **A14**. La primera cerró un hueco
que señalaste en el propio diseño —el catálogo de §7.2 declaraba los eventos `penalty_*` y §10.6
suspendía las cuotas con un penal, pero el generador de §7.3 nunca los producía, así que ningún
partido tenía penales—. La segunda es un mandato de producto tuyo que fue en contra de mi
recomendación (yo proponía conservar el sorteo sembrado determinista): si el título empata en la cima
tras los desempates de tabla, se define **en cancha** con prórroga y tanda de penales (§7.5). Ninguna
modifica el código existente del casino: son diseño nuevo, y ambas quedaron incorporadas al documento
con sus pruebas (T41, T42) y su riesgo (R36).

**Estado: las 28 decisiones de §23 están cerradas**, incluida la validación de los 16 nombres de
clubes contra clubes reales (§5.5), que era el único prerrequisito humano del plan. Esa validación
encontró siete colisiones reales —entre ellas un club danés asociado al F.C. København y un club de
primera división guatemalteca fundado en 1945— que a ojo habrían pasado desapercibidas hasta
publicada la liga. Dos decisiones (C6 y E10) quedaron cerradas **con su consecuencia corregida** tras
la verificación contra el código.

Siguiente paso: arrancar la Fase A —liga, clubes, calendario y store—, que es
invisible para los jugadores y deja validada la temporada completa antes de escribir una sola línea
de canvas. La Fase D no puede empezar sin los dos cambios en `lib/progression.js` (`debit()` y el
filtro `CHALLENGE_GAMES`), que son prerrequisito y no parte del trabajo opcional.
