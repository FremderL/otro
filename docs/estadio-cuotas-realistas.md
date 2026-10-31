# Cuotas realistas: diagnóstico medido y plan para parecerse a una casa de verdad

**Pregunta:** ¿cómo consigo que las cuotas del Estadio se parezcan a las de una casa de apuestas real?

**Respuesta corta:** «realista» son tres cosas distintas y se arreglan en este orden:

1. **Probabilidades calibradas** — que el modelo espere el fútbol que produce el fútbol (goles, empates, ambos marcan).
2. **Estructura del libro** — que cada mercado lleve el margen que llevan las casas reales (no un margen plano).
3. **Comportamiento del libro** — catálogo de mercados, movimiento por dinero y precio en vivo.

Este documento mide las tres con un instrumento que ya está en el repo (`npm run football:odds-audit`) y propone cómo cerrar cada brecha.

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
