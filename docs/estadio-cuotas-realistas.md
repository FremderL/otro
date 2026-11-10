# Cuotas realistas: diagnóstico medido y plan para parecerse a una casa de verdad

> **Alcance de las mediciones:** este diagnóstico se tomó sobre el motor V1 y una
> temporada sintética antes de integrar V2. Desde noviembre de 2026 la auditoría
> usa la matriz estimada V2 del partido (`v2-estimated-2`), no Poisson V1; las
> cifras históricas de este documento no son una medición de la política actual.
> La matriz V2, el descanso/final y el primer goleador son aproximaciones, no
> una garantía de calibración económica o de margen por encuentro.

**Pregunta:** ¿cómo consigo que las cuotas del Estadio se parezcan a las de una casa de apuestas real?

**Respuesta corta:** «realista» son tres cosas distintas y se arreglan en este orden:

1. **Probabilidades calibradas** — que el modelo espere el fútbol que produce el fútbol (goles, empates, ambos marcan).
2. **Estructura del libro** — que cada mercado lleve el margen que llevan las casas reales (no un margen plano).
3. **Comportamiento del libro** — catálogo de mercados, movimiento por dinero y precio en vivo.

Este documento mide las tres con un instrumento que ya está en el repo (`npm run football:odds-audit`) y propone cómo cerrar cada brecha.

## Estado actual de la nueva cotización Monte Carlo (v2-estimated-2)

El prior del motor v4 se generó con **2.048 partidos sintéticos completos** y se contrastó con **2.048 semillas independientes**: 16 espejos de plantillas más 16 cruces de equipos, con 64 réplicas de entrenamiento y 64 de control por cruce. El control difirió como máximo 1,90 puntos porcentuales en 1X2; los goles medios visitantes difirieron 0,047. Son chequeos de estabilidad del simulador, **no una calibración con resultados reales ni con precios de casas**. La proyección sigue ponderando ratings, Elo, atributos y promedio goleador disponibles en el producto.

Para 1X2 el sistema publica el **15 % de overround** (era 6 % hasta noviembre de 2026; ver [§8](#8-noviembre-de-2026-el-1x2-pasa-al-15--decisión-de-producto)): si las probabilidades justas son `pᵢ`, los precios parten de `1 / pᵢ` y se acortan para que `Σ(1 / cuotaᵢ) ≈ 1,15`. La probabilidad justa se conserva separada del porcentaje implícito de la cuota; la interfaz/API devuelve ambos, junto al overround y el hold teórico. El hold proporcional es `(overround − 1) / overround`: con 1,15 equivale a `0,15 / 1,15 ≈ 13,04 %`, no a 15 %.

**¿Todos los partidos deberían tener Local 2.00 / Empate 4.00 / Visitante 2.00? No.** Esos precios implican 50 % + 25 % + 50 % = **125 %** (25 % de overround, hold proporcional de 20 %). Al quitar el margen representan un partido con probabilidades 40/20/40. Además, no reflejan la fuerza de cada equipo; un favorito claro no debe cotizar igual que un duelo parejo.

Como referencia de metodología, Pinnacle explica la conversión `1/cuota`, la incorporación de margen y el uso de información de equipo y mercado para ajustar precios ([guía de cuotas](https://pinnacle.com/en/betting-articles/betting-strategy/betting-odds-explained/qen2dcqrvncnv4jf), [cómo operan los bookmakers](https://pinnacle.com/en/betting-articles/Betting-Strategy/how-bookmakers-make-money/MFT2YXK5C98V4HT5)). Pinnacle publica márgenes estrechos en mercados líquidos (su tabla histórica anuncia 1,5 % para 1X2 de Premier League), mientras que esta simulación usa 15 % en el 1X2 por decisión de producto (el 6 % anterior sí caía en la banda recreativa) ([tabla de márgenes de Pinnacle](https://pinnacle.com/en/betting-articles/Soccer/new-soccer-season/L5K2F8FLQU43428L)). No se copian cuotas en vivo ni se afirma que el simulador tenga sus datos: no tenemos feed de lesiones, árbitros, apuestas o movimiento de mercado. También Betfair Exchange es distinto: sus precios los emparejan participantes y cobra comisión, no es el mismo esquema de overround fijo ([ayuda de Betfair Exchange](https://content.betfair.com/xgHelp/?product=games&sWhichKey=cdr.general)).

---

## 1. Foto de hoy (medida, no estimada)

`npm run football:odds-audit -- --season 2026-11` sobre los 240 partidos de una temporada:

| Mercado | Margen medio | Banda real | Veredicto |
| --- | --- | --- | --- |
| 1X2 | 7,00 % | 2–8 % | en banda (alto dentro de la banda) |
| Doble oportunidad | 6,00 % | 3–8 % | en banda |
| Hándicap europeo −1 / +1 | 7,00 % | 4–7 % | **alto** |
| Altas/bajas 1.5 | 7,00 % | 4–6 % | **alto** |
| Altas/bajas 2.5 | 7,00 % | 4–6 % | **alto** |
| Altas/bajas 3.5 | 7,00 % | 4–7 % | en banda |
| Ambos marcan | 7,96 % | 4–8 % | en banda (techo) |
| Gana a cero (local / visita) | 8,95 % / 8,60 % | 5–9 % | en banda (techo) |
| Goles del equipo (0.5 / 1.5) | 8,00 % | 5–8 % | en banda (techo) |
| **Marcador exacto** | **12,00 %** | **15–25 %** | **bajo** |

Y la calibración del modelo, sobre los mismos 240 partidos:

| Métrica | Modelo | Fútbol real (5 grandes ligas, 2025/26) | Veredicto |
| --- | --- | --- | --- |
| Victorias locales | 40,8 % | 44 % (rango 38,3 %–48,2 %) | en banda |
| Empates | 25,7 % | 25,0 % | en banda |
| Victorias visitantes | 33,5 % | 31 % | en banda |
| **Goles por partido** | **2,94** | **2,75** | **alto** |
| Altas 2.5 | 56,0 % | 52 % | en banda (techo) |
| **Ambos marcan** | **59,0 %** | **52 %** | **alto** |

### Diagnóstico

- **El margen es plano.** Todos los mercados rondan el 7–8 % y el marcador exacto el 12 %. Eso no existe en ninguna casa: el mercado más popular (1X2) es el más barato y el de veinte resultados es el más caro.
- **El mercado más «generoso» es justo el más caro de producir.** Un marcador exacto al 12 % es **más barato** que cualquier casa del mundo (15–25 %): el jugador tiene una ventaja estructural en el único mercado donde el modelo tiene más error (13 celdas + *otro*).
- **El modelo mete más goles de los que existen.** `expectedGoals` aplica la ventaja de local **solo al local** (`λ_local = media · att · def · 1,12`), sin devolver esa probabilidad al visitante. Cada partido espera ~2,94 goles donde el fútbol real produce 2,75; eso infla altas 2.5 y, sobre todo, ambos marcan (59 % vs 52 %).

---

## 2. Qué hacen las casas reales (la referencia)

### 2.1 El margen depende del mercado, no de la casa

| Mercado | Casa afilada (Pinnacle) | Casa recreativa | Fuente |
| --- | --- | --- | --- |
| 1X2 | 2–3 % | 5–8 % (hasta 12 % en ligas menores) | [bet.report](https://bet.report/en/blog/bookmaker-margins-explained/), [bettingtools](https://bettingtools.com/bookie/pinnacle/) |
| Hándicap asiático | 1–3 % | 3–5 % | [odds-academy](https://odds-academy.com/compare/asian-handicap-vs-1x2/), [soccernews](https://www.soccernews.com/asian-handicap-betting/401985/) |
| Altas/bajas 2.5 | 4–6 % | 4–6 % | [smartmatchpick](https://smartmatchpick.com/guides/bookmaker-overround-explained) |
| Ambos marcan | 5–8 % | 5–8 % | smartmatchpick |
| **Marcador exacto** | 15–20 % | 15–25 % (hasta 30 %) | [soccernews](https://www.soccernews.com/correct-score-betting-how-it-works-and-whether-it-is-worth-it/402622/), bet.report |
| Primer goleador | 20–30 % | 20–40 % | bet.report |

El patrón es siempre el mismo: **cuanto más líquido y más comparado es el mercado, más fino el margen**; cuanto más resultados tiene y menos se compara, más grueso. Un mismo partido puede costar 2,8 % en hándicap asiático y 4,1 % en 1X2 ([ejemplo numérico](https://www.soccernews.com/asian-handicap-betting/401985/)).

### 2.2 «Muchas casas se basan en el mismo sitio» — es cierto, y es replicable

Lo que ves como cuotas casi idénticas entre casas no es casualidad:

- El mercado se ancla en **la línea de cierre de las casas afiladas** (Pinnacle, Betfair Exchange). Las casas recreativas **copian el movimiento** («Pinny lean») y añaden margen encima.
- Por eso las cuotas se mueven *juntas* y difieren solo en el margen y en el momento de captura.

Para el Estadio eso significa una arquitectura concreta: **un solo ancla** (nuestro modelo calibrado) → **margen por mercado** → **movimiento por dinero y por reloj**. Si algún día hay «varias casas» en el juego, todas deben salir del mismo ancla con un ruido pequeño: se verán parecidas entre sí y distintas del ancla solo por margen, exactamente como en la realidad.

### 2.3 El modelo de probabilidades

Las casas no adivinan precios: parten de un modelo de goles (Poisson bivariado con corrección **Dixon-Coles** para los marcadores bajos, o xG/ratings con ajuste por rival) y lo corrigen con información (alineaciones, bajas, clima) y con el dinero. El Estadio ya usa Poisson + Dixon-Coles (`lib/football/match-engine.js`, `RHO`), que es la base correcta; lo que falta es la calibración y la estructura del libro.

---

## 3. Las seis palancas, por impacto

### Palanca 1 — Normalizar la ventaja de local (impacto alto, riesgo medio)

**Qué está mal.** `lib/football/ratings.js`:

```js
const lambdaHome = Math.max(0.05, leagueAvg * home.att * away.def * homeAdv);
const lambdaAway = Math.max(0.05, leagueAvg * away.att * home.def);          // sin compensación
```

La ventaja de local (1,12) se suma al total de goles en vez de **repartirlo**. En el fútbol real el local marca 1,53 y el visitante 1,23 (total 2,76; ratio 1,24): la ventaja **mueve** goles de un lado al otro, no los inventa.

**Qué hacer.** Repartir el factor de forma simétrica:

```js
const homeAdv = ...;                       // 1,24 en lugar de 1,12
const lambdaHome = leagueAvg * home.att * away.def * Math.sqrt(homeAdv);
const lambdaAway = leagueAvg * away.att * home.def / Math.sqrt(homeAdv);
```

Así el total esperado es `2 · leagueAvg` (2,70–2,80 con la media actual) y el ratio local/visitante queda en 1,24.

**Cómo se mide.** El propio auditor: goles/partido 2,55–2,90, ambos marcan 47–56 %, altas 2.5 47–56 %, victorias locales 38–48 %.

**Riesgo.** Cambia *todos* los partidos simulados (marcadores, tabla, Balón de Oro). Debe entrar con versión de fórmula (el evento del premio ya tiene `formulaVersion`) y aplicarse solo a temporadas nuevas; las viejas se quedan con su fórmula y sus récords.

### Palanca 2 — Márgenes por mercado según la banda real (impacto alto, riesgo bajo)

**Qué hacer.** Recalibrar `MARGINS` en `lib/football/odds.js`:

| Mercado | Hoy | Propuesto | Razón |
| --- | --- | --- | --- |
| `1x2` | 7 % | **6 %** | banda real 5–8 % en casa recreativa; 6 % deja aire al movimiento por dinero sin salirse |
| `double_chance` | 6 % | 6 % | ya en banda |
| `handicap` (europeo 3 vías) | 7 % | **6 %** | 6 % es el centro del 4–7 % |
| `over_under` | 7 % | **5 %** | banda 4–6 % |
| `btts` | 8 % | **6 %** | banda 5–8 % |
| `correct_score` | 12 % | **18 %** | banda 15–25 %; hoy somos la casa más barata del mundo en el mercado más difícil |
| `win_to_nil` | 9 % | 7 % | banda 5–9 % |
| `team_total` | 8 % | 6,5 % | banda 5–8 % |

**Efecto lateral bueno.** Subir el marcador exacto del 12 % a 18 % sube el margen del único mercado donde el modelo tiene más varianza; bajarlo en altas y hándicap hace que el jugador vea cuotas más competitivas donde la casa real las tiene.

**Cómo se mide.** `npm run football:odds-audit`: cada fila debe dar `en banda`. Y el invariante `Σ 1/precio ≥ 1 + MIN_MARGIN` sigue intacto porque el margen se reparte dentro del mismo libro.

### Palanca 3 — Cómo se reparte el margen entre selecciones (impacto medio, es una decisión de producto)

Hoy el margen es **proporcional**: cada precio se divide por (1 + margen), así que la devolución esperada es idéntica en todas las selecciones. Es lo que hacen las casas afiladas y es lo *más justo*.

Las casas recreativas cargan más el largo plazo (sesgo favorito-longshot): el favorito a 1,30 lleva un 4 % de margen y el tapado a 12,00 un 12 %. Se modela con **Shin (1993)** o con el método de **odds-ratio**, ambos con el mismo overround total.

**Decisión:** si el objetivo es «que se vea como una casa real», se puede activar `marginModel: 'shin'` con `z ≈ 0,03`; si el objetivo es «que sea justo», se queda proporcional. Recomendación: dejarlo configurable (`FOOTBALL_ODDS_MARGIN_MODEL=proportional|shin`, por defecto `proportional`) y documentado, porque cambia cuánto pierde el jugador a largo plazo.

### Palanca 4 — Catálogo de mercados (impacto alto en la sensación, riesgo medio)

Lo que hoy no existe y cualquier casa tiene:

- **Hándicap asiático de dos vías** (`-0.5`, `-1`, `-1.5`, y líneas de cuarto `-0.75`) con margen 1,5–3 %. Hoy solo hay hándicap **europeo** de tres vías (con empate), que las casas ofrecen poco.
- **Totales por línea** en el mismo partido (ya hay 1.5/2.5/3.5: bien) y **totales por equipo** (ya están).
- **Descanso / final** (`ht_ft`, el margen ya está definido al 12 %, pero el mercado no se publica) y **resultado al descanso**.
- **Primer goleador** (20–40 % de margen): es el mercado que más «suena» a casa real y el motor ya sabe quién marca en cada minuto (`match.timeline`).
- **Tarjetas y córners** por línea, con margen 8–15 %.

Cada mercado nuevo debe salir de la **misma matriz** (no de una fórmula paralela) y publicarse con `publishMarket`, que ya garantiza el piso anti-arbitraje.

### Palanca 5 — Precio en vivo (impacto alto, riesgo medio)

Hoy solo se mueve el 1X2 en vivo con **+1 %** de margen. Una casa real: 5–8 % en vivo, con **suspensión** en goles/expulsiones y reprecio por minuto restante y marcador. El motor ya tiene `publishLive` y `liveLambdas`; falta:

- margen en vivo por mercado (no solo 1X2): altas, siguiente gol, ambos marcan a estas alturas;
- **suspensión** por evento (hoy existe `playStopped`, pero la cuota no se congela explícitamente por mercado);
- límites de stake distintos en vivo.

### Palanca 6 — Movimiento, límites y deriva (impacto medio)

Una cuota real se mueve. Hoy hay peso del dinero (`MONEY_WEIGHT = 0,30`, tope ±6 % por actualización y ±25 % acumulado) y un flujo simulado. Para que se sienta real falta que el movimiento tenga **memoria** (apertura → cierre) y que existan **límites**: cada casa limita el stake en mercados de cola larga y en cuotas altas. Sin límites, un mercado al 18 % sigue siendo explotable por un bot que sepa más que el modelo.

> **Hecho en noviembre de 2026 (§9).** El movimiento ya tiene memoria: la cuota abre en el precio del modelo y los apostadores simulados la llevan, aporte a aporte, hasta el precio de cierre durante las doce horas previas al partido. Los límites de stake por mercado siguen pendientes.

---

## 4. Cómo saber que ya es realista (criterios de aceptación)

1. **Márgenes**: todos los mercados en banda (`npm run football:odds-audit` sin desviaciones de tipo `margen_*`).
2. **Calibración**: goles/partido 2,55–2,90; ambos marcan 47–56 %; altas 2.5 47–56 %; 1X2 dentro de 38–48 / 23–28 / 27–36.
3. **Cierre por resultado**: simular una temporada completa y comparar la probabilidad media que el modelo daba a cada partido con lo que pasó (Brier score y log-loss por mercado). Un libro realista *no* es un libro perfecto: el Brier esperado de un 1X2 bien calibrado está en ~0,58–0,62.
4. **Anti-arbitraje**: `Σ 1/precio ≥ 1,04` en todos los mercados y en todas las actualizaciones (ya hay test).
5. **Estabilidad**: el precio de cierre no se aleja del de apertura más del ±25 % (ya implementado) y el movimiento no rompe el margen objetivo.

Todo eso ya está automatizado salvo el punto 3, que es el siguiente instrumento natural (`npm run football:odds-scorecard`).

---

## 5. Plan propuesto

| Fase | Qué | Esfuerzo | Riesgo | Qué se toca |
| --- | --- | --- | --- | --- |
| **A** | Márgenes por mercado según la banda real (Palanca 2) | 1 h | bajo | `MARGINS` en `odds.js` + 1 test por mercado |
| **B** | Normalizar la ventaja de local con versión de fórmula (Palanca 1) | 3–4 h | medio | `ratings.js`, `formulaVersion`, tests de distribución |
| **C** | Catálogo: hándicap asiático 2 vías + `ht_ft` + primer goleador (Palanca 4) | 1–2 días | medio | `odds.js`, `betting.js`, UI, tests |
| **D** | En vivo: margen 5–8 %, más mercados, suspensión explícita (Palanca 5) | 1–2 días | medio | `odds.js`, `sockets.js`, UI |
| **E** | Margen configurable Shin/odds-ratio (Palanca 3) | 4 h | bajo | `odds.js` + flag |
| **F** | Scorecard de calibración (Brier/log-loss por mercado) | 4 h | bajo | auditor + CLI nuevo |

Recomendación de orden: **A** (barato, visible, sin riesgo), luego **B** (es la raíz de que los goles no cuadren), luego **C** y **D**.

---

## 6. El instrumento

```bash
npm run football:odds-audit                       # temporada actual
npm run football:odds-audit -- --season 2026-11   # una temporada concreta
npm run football:odds-audit -- --json             # para encadenar en CI
npm run football:odds-audit -- --margins          # solo márgenes
```

- Usa un **store temporal**: nunca abre la temporada real.
- Mide con los **precios de apertura del modelo** (sin dinero apostado), que es lo comparable con una casa.
- Bandas, medidas y veredictos viven en `lib/football/odds-audit.js`; el método y las fuentes, aquí.
- El contexto de precio (`lib/football/match-context.js`) es **uno solo** para cuotas, liquidación y auditoría: si la fórmula cambia, cambia en un sitio.

**Archivos**

| Archivo | Qué hace |
| --- | --- |
| `lib/football/odds-audit.js` | Bandas reales, medición de margen por mercado, calibración y hallazgos |
| `lib/football/match-context.js` | Única definición de λ/matriz de un partido (la usan betting y el auditor) |
| `scripts/estadio-cuotas.js` | CLI `football:odds-audit` |
| `tests/football-odds-realism.test.js` | 7 pruebas: contexto único, divisor de mercados solapados, piso anti-arbitraje, bandas y hallazgos |
| `tests/football-market-catalog.test.js` | 8 pruebas del catálogo: escalera asiática, empujes y medias victorias, descanso/final, primer goleador y archivo del asentado |

**Fuentes de las bandas**: [bet.report · márgenes por mercado](https://bet.report/en/blog/bookmaker-margins-explained/) · [smartmatchpick · overround por mercado](https://smartmatchpick.com/guides/bookmaker-overround-explained) · [soccernews · hándicap asiático vs 1X2](https://www.soccernews.com/asian-handicap-betting/401985/) · [soccernews · marcador exacto](https://www.soccernews.com/correct-score-betting-how-it-works-and-whether-it-is-worth-it/402622/) · [odds-academy · márgenes Pinnacle vs casa blanda](https://odds-academy.com/compare/asian-handicap-vs-1x2/) · [bettingtools · Pinnacle 2 %](https://bettingtools.com/bookie/pinnacle/) · [statpair · 5 grandes ligas 2025/26](https://statpair.com/blog/home-away-stats-location-matters) · [balanceofplay · la ventaja de local se desvanece](https://balanceofplay.substack.com/p/home-advantage-is-fading-across-european).

---

## 7. Estado de la ejecución: A, B y C hechas

### Fase A — márgenes por mercado (`lib/football/odds.js`)

`MARGINS` ya no es un número único: cada mercado cotiza en la banda que publica una casa recreativa.

| Mercado | Antes | Ahora | Banda real | Medido (2026-11, 240 partidos) |
| --- | --- | --- | --- | --- |
| 1X2 | 7 % | 6 % | 5–8 % | 6,01 % |
| Doble oportunidad | 6 % | 6 % | 3–8 % | 5,99 % |
| Hándicap europeo | 7 % | 6 % | 4–7 % | 6,00 % |
| **Hándicap asiático** | — | **2,5 %** | 1–4 % | 2,52–2,55 % |
| Altas/bajas | 7 % | 5 % | 4–6 % | 4,99–5,02 % |
| Ambos marcan | 8 % | 6 % | 5–8 % | 6,02 % |
| Gana a cero | 9 % | 7 % | 5–9 % | 6,82–6,99 % |
| Goles por equipo | 8 % | 6,5 % | 5–8 % | 6,50–6,51 % |
| **Descanso/final** | — | **14 %** | 12–20 % | 14,00 % |
| Marcador exacto | 12 % | 18 % | 15–25 % | 18,00 % |
| **Primer goleador** | — | **22 %** | 20–40 % | 22,00 % |

El piso anti-arbitraje sigue siendo un invariante **por mercado**: 4 % general y 2 % en el hándicap asiático
(`ASIAN_MIN_MARGIN`). En ambos casos el libro tiene margen positivo — nunca es arbitrable.

> El 6 % del 1X2 de esta tabla es el de la fase A. Desde noviembre de 2026 el 1X2 cotiza al 15 % ([§8](#8-noviembre-de-2026-el-1x2-pasa-al-15--decisión-de-producto)); los demás mercados siguen como aquí.

### Fase B — ventaja de local normalizada (`lib/football/ratings.js`)

`λ_local = leagueAvg · att · def · √homeAdv` y `λ_visita = leagueAvg · att · def / √homeAdv`.
Con `homeAdv = 1,24` la ventaja se queda en el **reparto de goles** en vez de inflar el total: el modelo
antiguo esperaba 2,24·L goles, el nuevo 2,01·L.

| Métrica | Antes | Ahora | Banda real |
| --- | --- | --- | --- |
| Goles por partido | 2,92 | **2,77** | 2,55–2,90 |
| Victorias locales | 40,7 % | **43,4 %** | 38–48 % |
| Empates | 26 % | **26,4 %** | 23–28 % |
| Altas 2.5 | 54 % | **52,5 %** | 47–56 % |
| Ambos marcan | 59 % | **56,0 %** | 47–56 % |

### Fase C — catálogo (`odds.js`, `betting.js`, `estadio.js`)

**Hándicap asiático de dos vías**, con escalera centrada en la línea justa del modelo:

- Claves `asian_handicap_home_minus|plus<línea>` en cuartos (`minus0.75`, `plus0`, `plus1.5`…).
- Se publican **cinco líneas**: la principal (la supremacía esperada redondeada al cuarto) y sus dos
  vecinas a cada lado. La escalera viaja con el partido, no es una constante: `betting.marketKeysFor()`.
- Probabilidad cotizada **condicionada a que no haya empuje**:
  `q_local = P(gana) / (1 − P(empuje))`; así el libro de dos vías suma 1 y el margen declarado es el real.
- **Liquidación** (`resolveSelection`): línea entera o de medio punto → `won` / `lost` / `void` (empuje).
  Línea de cuarto → dos medias apuestas a las líneas vecinas, con desenlaces **`half_won`** y
  **`half_lost`**: media cuota cobrada + media devuelta, o media devuelta. `_payoutBet` paga el parcial.
- Las líneas de cuarto **no se combinan en parlays** (`linea_cuarto_no_combinable`): el empuje parcial no
  se puede multiplicar sin un estado de pata parcial. Las de medio punto sí.

**Descanso / final (`ht_ft`)**: nueve resultados `home|draw|away` × `home|draw|away`. Se modela cada
tiempo como Poisson independiente con su parte de λ (45 % antes del descanso) y se publica con 14 %.
Se liquida con el **marcador del descanso archivado en el resultado asentado** (`match.result.halftime`);
si el partido se asentó sin cronología verificada, el boleto se anula en vez de adivinar.

**Primer goleador (`first_scorer`)**: doce nombres (peso de tiro = el mismo `shootWeight` con el que el
motor elige rematador) + `other` («otro jugador») + `none` («sin goles»). Se publica solo si hay
alineaciones (son deterministas desde la plantilla, así que existen desde antes del partido) y con 22 %.
Se liquida con `match.result.firstScorer` (`{ id, name, team, minute }`, `null` en un 0-0, `ownGoal` si el
primer gol fue en propia puerta → anulado). La selección `other` se resuelve contra la **lista archivada
con el boleto** (`bet.firstScorerIds`), igual que las celdas del marcador exacto.

**Lo que el asentado archiva ahora** (`lib/football-store.js`): además de marcador, ganador, estadísticas
y destacados, `result.halftime` y `result.firstScorer` salen de la MISMA cronología verificada. Es la
fuente autoritativa de liquidación (§15.4); `cleanMatch` los preserva al recargar. La recuperación
(`reconcileEscrow`) y las combinadas usan exactamente el mismo contexto (`_contextForBet`).

**Pendiente de la palanca C (no incluido):** tarjetas y córners por línea (necesitan su propio modelo de
λ por equipo y su archivo en el asentado) y precio en vivo de los mercados nuevos (hoy en vivo solo 1X2).

---

## 8. Noviembre de 2026: el 1X2 pasa al 15 % (decisión de producto)

**Qué se pidió.** Las cuotas del resultado se seguían viendo demasiado altas (capturas con 2.65 / 3.35 / 2.40 y
2.25 / 3.60 / 2.65). Se eligió que **todas las selecciones del 1X2 paguen menos**, con un margen del **15 %**, y
**solo en ese mercado**.

**Qué cambió.** Un número: `MARGINS['1x2']` en `lib/football/odds.js` pasa de `0.06` a `0.15`. El 1X2 en vivo sigue
siendo «base + 1 %», así que queda en 16 %. No cambian las probabilidades, el motor del partido ni la fórmula de
precios: es el mismo partido, cobrado más caro. Los boletos ya vendidos conservan la cuota con la que se compraron.

**Medido** (`2026-11`, 240 partidos, pipeline real `v2-estimated-3`). Hay dos fotos porque el precio que ve el
jugador no se queda en el de apertura: los apostadores simulados (§11.6) cargan al favorito y la regla
`min(modelo, movido)` solo deja bajar precios respecto a la apertura, así que al cierre el margen efectivo es unos
2,5 puntos mayor que el configurado. Eso ya pasaba con el 6 % (las capturas sumaban 109–110 %) y no cambió.
Desde §9 ese recorrido se ve: la cuota **abre** en la primera tabla y **cierra** en la segunda, moviéndose durante
las doce horas previas al saque inicial. Antes se publicaba el precio de cierre desde el primer momento.

*Precio de apertura* (lo que mide `npm run football:odds-audit`):

| | Antes (6 %) | Ahora (15 %) |
| --- | --- | --- |
| Favorito, mediana | 2.20 | **2.05** |
| Favorito, mitad central de los partidos | 1.97–2.45 | 1.81–2.15 |
| Favorito, mínimo–máximo | 1.52–2.50 | 1.42–2.40 |
| Partidos con favorito por debajo de 2.00 | 65 de 240 (27 %) | **110 de 240 (46 %)** |
| No favorito, mediana | 3.05 | 2.75 |
| Empate, mediana | 3.60 | 3.35 |
| Margen medido | 6,0 % | 15,0 % |
| Parte de lo apostado que retiene la casa (hold) | 5,7 % | 13,0 % |

*Precio de cierre en pantalla* (servicio de apuestas con el libro simulado completo y sin apuestas reales: lo que
se ve al saque inicial):

| | Antes (6 %) | Ahora (15 %) |
| --- | --- | --- |
| Favorito, mediana | 2.15 | **1.95** |
| Favorito, mitad central de los partidos | 1.85–2.30 | 1.71–2.10 |
| Favorito, mínimo–máximo | 1.42–2.50 | 1.30–2.40 |
| Partidos con favorito por debajo de 2.00 | 96 de 240 (40 %) | **147 de 240 (61 %)** |
| No favorito, mediana | 3.05 | 2.75 |
| Empate, mediana | 3.60 | 3.35 |
| Margen publicado, media | 8,6 % | 17,6 % |
| Parte de lo apostado que retiene la casa (hold) | 8,0 % | 15,0 % |

(La columna «Ahora» está medida con el peso del dinero proporcional de §9; con la fórmula anterior daba 1.72–2.10,
145 de 240, 17,7 % y 15,1 %: el nivel de cierre es el mismo.)

**Lo que este cambio no hace.** No convierte a los favoritos en favoritos de 1.50: el motor sigue viendo la liga muy
pareja (la probabilidad justa del favorito va de 37 % a 62 %, con mediana 42 %). Para eso hay que separar más a los
equipos fuertes de los débiles en el generador, que es otro trabajo (ver `docs/estadio-cuotas-favoritos.md`).

**Efectos que conviene tener presentes.**

- El 15 % queda **por encima** de la banda de las casas reales (2–8 %) a propósito. La banda no se movió: el
  auditor muestra el 1X2 como `decisión de producto` y deja de proponer bajarlo, pero solo mientras lo publicado
  coincida con lo decidido (`PRODUCT_MARGIN_DECISIONS` en `lib/football/odds-audit.js`, ±0,5 puntos). Si alguien
  cambia el margen sin actualizar esa tabla, vuelve a salir como desviación.
- Los mercados vecinos **no** cambiaron con el margen (comprobado sobre las 19.920 selecciones del resto del
  catálogo: ninguna movió su precio; el ajuste posterior de §9 sí retoca algunos precios de cierre, en ambos
  sentidos y sin cambiar el nivel), y uno de ellos vende **la misma apuesta**: en los 240 partidos hay una línea ±0.5 de hándicap
  asiático que equivale a «gana el local» (local −0.5) o a «gana la visita» (visita −0.5), y sigue al 2,5 %. Medido
  en pantalla al cierre, paga una mediana de **+15,4 %** más que el 1X2 por el mismo resultado (mínimo +4 %, nueve
  de cada diez casos por debajo de +22 %; en la apertura la mediana es +9,6 %; antes del cambio ya pagaba +6,1 %):
  por ejemplo 1.85 en el 1X2 y 2.15 en el asiático. La doble oportunidad (6 %) y la
  línea 0 del asiático («gana o se devuelve») tampoco se encarecieron. Quien conozca esos mercados esquiva el
  margen nuevo; cerrarlo es subir `MARGINS.asian_handicap` (y, si se quiere, `double_chance`), que quedó fuera de
  esta decisión.
- El cambio solo baja precios —de las 720 selecciones de 1X2, 712 bajan, 8 se quedan igual por el redondeo de la
  rejilla y ninguna sube—, así que no puede abrir un arbitraje que no existiera antes.
- En vivo el favorito toca el precio mínimo (1.05) antes: cuando su probabilidad pasa de ~82 % (con el 7 %
  anterior era ~89 %). De ahí en adelante el margen efectivo va bajando hacia el piso del 4 %, igual que antes;
  el mercado no se cierra ni queda arbitrable.
- El cash-out no usa el margen del mercado (paga `apuesta × cuota comprada × probabilidad actual × 0,90`), pero
  como la cuota comprada es más baja, retirarse nada más apostar devuelve cerca del 78 % de lo apostado en vez del
  85 %.
- Los partidos ya comprometidos **también** cambian de precio al desplegar: el compromiso congela la matriz de
  probabilidades, no el margen, que se aplica al publicar.

**Cómo volver a ajustarlo.** Cambiar el número en `MARGINS['1x2']` y el mismo valor en `PRODUCT_MARGIN_DECISIONS`
(la prueba `tests/football-odds-realism.test.js` exige que coincidan). Referencia medida sobre la misma temporada,
con precios de apertura (al cierre el favorito queda unas 5–10 centésimas por debajo):

| Margen | Favorito, mediana | Favorito bajo 2.00 | Hold |
| --- | --- | --- | --- |
| 6 % | 2.20 | 27 % | 5,7 % |
| 15 % (vigente) | 2.05 | 46 % | 13,0 % |
| 20 % | 1.96 | 58 % | 16,7 % |
| 25 % | 1.90 | 71 % | 20,0 % |
| 30 % | 1.82 | 93 % | 23,1 % |

---

## 9. Noviembre de 2026: los apostadores simulados apuestan de verdad en el tiempo

**Qué se pidió.** «Se supone que hay bots para que apuesten y puedan cambiar el porcentaje de apuestas.» Los había
—el flujo simulado de §11.6 del diseño—, pero no hacían lo que el diseño prometía («llegando en aportes cada
30–60 s»): `SimulatedFlow` calculaba **una sola vez** el reparto de cada mercado y lo dejaba fijo. Resultado: la
cuota previa y su «impl. N %» (el único porcentaje que se ve) nacían ya en su valor final y no se movían nunca
solas; `football:odds` solo salía tras una apuesta real o, en vivo, para el 1X2.

**Qué hace ahora.** El mismo dinero simulado llega **repartido en el tiempo**:

1. Cada mercado previo tiene un **calendario determinista de aportes** (`schedule` en
   `lib/football/simulated-flow.js`): entre 14 y 30 boletos por mercado, el triple en el 1X2 (y los que hagan falta
   para que ninguno sea demasiado grande, ver abajo), de tamaños desiguales, colocados dentro de las **doce horas
   previas** al saque inicial. Cada selección recibe su dinero a su propio ritmo, así que por el camino la cuota
   sube y baja en vez de deslizarse en línea recta.
2. La suma de los aportes es **exactamente** el libro de antes (`distribute`): no cambia cuánto dinero simulado
   hay ni a qué selección va, solo cuándo llega. Lo que todavía no llegó cuenta como dinero **neutro** (repartido
   según la probabilidad del modelo, que no empuja ninguna cuota), así que el volumen es constante y la influencia
   frente al dinero real (tabla de §11.6, prueba T20) es la misma a cualquier hora.
3. Por lo tanto la cuota **abre** en el precio del modelo, **se mueve** con cada aporte y **cierra** en el precio
   que antes se veía desde el principio.
4. El libro vigente es una función pura de (seed del partido, mercado, saque inicial, hora): no se guarda nada, un
   reinicio da el mismo precio en el mismo instante y un partido reprogramado arrastra su calendario.
5. Un barrido del scheduler (`runOddsSweep`, cada 2 s) difunde `football:odds` a las salas de partidos **por
   empezar que tengan gente dentro**, y solo para los mercados cuyo precio visible cambió. Antes de recalcular
   pregunta si llegó algún aporte a ese mercado desde la vuelta anterior (`arrivedBetween`); casi siempre la
   respuesta es «no» y no se calcula nada. En vivo no interviene: ahí manda el motor del partido.

**El precio se mueve de forma proporcional.** `applyMoneyWeight` volvía a publicar el mercado entero buscando en la
rejilla la combinación más cercana al margen objetivo. Eso es discontinuo: con el libro anterior, un boleto de 63
fichas a la visita bajaba su cuota de 2.65 a 2.40 (−9,4 %) y podía **subir** la del local. Con un libro fijo no se
notaba; con aportes llegando a cada rato, la cuota habría dado saltos. Ahora cada precio es
`apertura × probabilidad del modelo / probabilidad ajustada por el dinero`, redondeado a la rejilla, con el mismo
tope acumulado de ±25 % y el mismo piso de margen del 4 %. Más dinero en una selección baja **su** cuota y nunca
la de las demás; un libro neutro deja la apertura intacta (salvo en el hándicap asiático: su margen del 2,5 %
queda bajo el piso del 4 %, así que el piso recorta el precio haya o no dinero, igual que antes: 2.50 se publica
como 2.40 hasta que el dinero carga el otro lado). Aplica igual al dinero real. Además, ningún aporte
simulado mueve por sí solo una cuota más de ~4 % (`MAX_APORTE_MOVE`), por debajo del 6 % por actualización de
§10.4 del diseño. Medido en el 1X2 de los 240 partidos (16.154 aportes): el 43 % no llega a cambiar el precio
visible, el 90 % lo mueve un 2 % o menos y el mayor salto fue de 3,1 %.

La fórmula nueva no cambia el nivel de precios, solo cómo se llega a él. Comparando el precio de cierre de todo el
catálogo con la fórmula anterior (60 partidos, 5.160 selecciones): cambia el 24 % de los precios, casi siempre por
un paso de rejilla (el 98 % de las diferencias queda entre −2,4 % y +2,7 %), 551 a la baja y 710 al alza, con una
media de +0,06 %.

**Medido** (`2026-11`, 240 partidos, servicio de apuestas como en producción, sin apuestas reales). 1X2 en
pantalla según la hora:

| Momento | Favorito: mitad central | Favorito, mediana | Favorito bajo 2.00 | Margen publicado | Hold |
| --- | --- | --- | --- | --- | --- |
| Apertura (más de 12 h antes) | 1.81–2.15 | 2.05 | 110 de 240 (46 %) | 15,0 % | 13,0 % |
| 6 h antes | 1.81–2.15 | 2.00 | 120 (50 %) | 16,1 % | 13,9 % |
| 3 h antes | 1.79–2.15 | 1.98 | 124 (52 %) | 16,7 % | 14,3 % |
| 1 h antes | 1.75–2.15 | 1.96 | 136 (57 %) | 17,2 % | 14,7 % |
| 15 min antes | 1.73–2.10 | 1.94 | 143 (60 %) | 17,5 % | 14,9 % |
| Cierre (saque inicial) | 1.71–2.10 | 1.95 | 147 (61 %) | 17,6 % | 15,0 % |

El empate (mediana 3.35) y el no favorito (2.75) oscilan alrededor de su apertura y terminan casi donde empezaron;
el favorito baja en promedio un 4,3 % (el sesgo de público de §11.6). Cuánto dinero ha llegado: 9 % nueve horas
antes, 21 % a seis horas, 41 % a tres, 68 % a una, 88 % a quince minutos.

Ritmo. El 1X2 de cada partido recibe entre 46 y 90 aportes (mediana 67), que producen una mediana de **40 cambios
de precio visibles** (de 23 a 53 en nueve de cada diez partidos; mínimo 11, máximo 67). Contando los 26 mercados
son unos 1.300 aportes y unos 830 cambios por partido (muestra de 10 partidos, igual que la tabla siguiente):

| Tramo antes del saque inicial | Un cambio en el 1X2 cada… | Un cambio en la página cada… |
| --- | --- | --- |
| 12 h a 6 h | 50 min | 104 s |
| 6 h a 3 h | 22 min | 63 s |
| 3 h a 1 h | 13 min | 34 s |
| 1 h a 15 min | 6 min | 17 s |
| Últimos 15 min | 3 min | 11 s |

En los dos sentidos: en esa muestra, 181 precios del 1X2 subieron y 224 bajaron.

**Consecuencia que conviene tener presente.** Antes el jugador veía el precio de cierre desde que abría el
partido; ahora quien apuesta temprano encuentra el precio de apertura, que para el favorito es algo mejor (2.05
de mediana en vez de 1.95) y con el que la casa retiene 13 % en vez de 15 %. El precio de cierre no cambió. Si se
quiere que ni siquiera la apertura pase de ahí, la palanca es el margen (§8), no los simulados.

**En pantalla.** El protocolo no cambia (`football:odds` lleva lo mismo de siempre: clave, precio y probabilidad
implícita). En `public/estadio.js`:

- la flecha ▲/▼ aparece desde el **primer** cambio (antes hacía falta un segundo, porque el primero no tenía con
  qué compararse);
- si la cuota se mueve con la **boleta abierta**, la boleta pasa a mostrar el precio vigente y avisa («La cuota
  cambió de 2.10 a 2.05.»). Antes se quedaba con el precio del clic aunque el servidor cobrara el nuevo;
- el precio lo sigue poniendo el servidor al confirmar. Si cambia justo en ese instante, la apuesta no se cobra y
  el jugador lee «La cuota cambió justo al confirmar…» en vez de un código.

Lo que **no** se añadió: ningún indicador de «% de apuestas por selección» ni volumen apostado. La decisión D8 y
la prueba T19 lo prohíben a propósito (el flujo simulado es invisible: no aparece como jugador ni como dato), y
mostrar como «apuestas de la gente» un reparto que es sintético sería engañoso. Si se quiere ese indicador, es
una decisión de producto aparte.

**Lo que no cambia.** El dinero simulado sigue sin ser dinero: no mueve fichas, no cuenta para la exposición ni
para los topes (T18), no viaja en ningún payload (T19) y pierde influencia en cuanto hay apuestas reales (T20).
Los boletos vendidos conservan su cuota. Los T&C del Estadio ya declaran que las cuotas incorporan un flujo de
referencia simulado.

**Auditoría.** `football_simulated_flow` se registra **una vez por partido y mercado**, con el libro completo, el
número de aportes y la ventana (`aportes`, `opensAt`, `closesAt`); el total por partido de `/healthz` tampoco se
duplica. No hay una línea de log por aporte (serían ~1.300 por partido): el calendario se regenera exactamente con
`schedule(match, mercado, probabilidades)` a partir del seed.

**Cómo ajustarlo.**

| Qué | Dónde | Valor |
| --- | --- | --- |
| Cuánto antes empiezan a apostar | `FOOTBALL_SIM_WINDOW_MS` | 12 h. `0` = libro completo desde el principio (comportamiento anterior) |
| Cada cuánto se avisa a las salas | `FOOTBALL_ODDS_SWEEP_MS` | 2000 ms |
| Cuántos boletos por mercado | `APORTES_MIN`, `APORTES_MAX`, `MAIN_MARKET_FACTOR` | 14–30, ×3 en el 1X2 |
| Cuánto se concentran al final | `ARRIVAL_CURVE` | 3 (más alto = más dinero a última hora) |
| Cuánto mueve un solo boleto | `MAX_APORTE_MOVE` | 4 % |
| Cuánto dinero simulado hay y hacia dónde va | `VOLUME_MIN`/`VOLUME_MAX`, `PUBLIC_BIAS` | 500–5.000 fichas, exponente 1,6 |
| Cuánto pesa frente al dinero real | `FOOTBALL_SIM_WEIGHT`, `FOOTBALL_SIM_SOFTENER` | 0,6 y 2.000 fichas |
| Cuánto mueve el dinero una cuota | `MONEY_WEIGHT` en `lib/football/odds.js` | 0,30 |

Las constantes sin variable de entorno están en `lib/football/simulated-flow.js`.

**Pruebas.** `tests/football-simulated-flow.test.js` (calendario, suma exacta, ventana, tope por aporte,
determinismo, registro único), `tests/football-odds.test.js` (movimiento monótono y continuo),
`tests/football-betting.test.js` (apertura = modelo, cierre = libro completo, sin exposición),
`tests/football-sockets.test.js` (el barrido solo difunde cambios reales, a salas ocupadas y antes del partido),
`tests/football-pregame.test.js` (scheduler) y `tests/football-stadium-ui.test.js` (flecha y boleta).
