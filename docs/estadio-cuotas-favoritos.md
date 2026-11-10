# Favoritos que cotizan como favoritos: recalibración de la fórmula de precios (v2-mc-2)

> **Resumen:** en la jornada 9 casi todas las líneas del 1X2 seguían por encima
> de 2.00 y, en varios partidos, la fórmula declaraba favorito al equipo que el
> motor favorecía menos. La causa no eran los datos: ratings y plantillas ya
> estaban actualizados. La causa era la **fórmula de precios**, que medía mal la
> fuerza de los equipos. Se recalibró contra el simulador oficial y se publicó
> como `v2-estimated-3` / fórmula `v2-mc-2`, sin tocar ninguna cuota comprometida.

## Qué se observaba

En una temporada reproducida con el pipeline real (8 jornadas asentadas con el
simulador `v2-causal-4` y ratings actualizados por `settleMatch`), la jornada 9
quedaba así:

| | Antes (v2-mc-1) | Ahora (v2-mc-2) | Verdad del generador (réplicas) |
| --- | --- | --- | --- |
| Favorito más corto | 2,15 | **1,98** | ferrata visita 55 % (1,82 justo) |
| Favoritos < 2,00 | 0 de 8 | 2 de 8 | los cruces con brecha real |
| Empates publicados | 4,20–4,80 | **3,75–4,30** | 25–28 % reales |
| Lado del favorito | equivocado en 1 de 2 partidos medidos | coincide con el generador | — |

El síntoma («todo sigue en Mayor a 2.00») era la consecuencia de tres errores
medidos de la fórmula de precios, no de falta de datos.

## Los tres errores (medidos contra el simulador, ~350 réplicas por escenario)

Protocolo «baseline gemelos + un factor a la vez» (el de v2-tilt-2, re-hecho
contra `v2-causal-4`), más cruces de plantillas reales y dos climas de goles:

1. **Atributos del once que el motor usa y la fórmula no miraba.**
   La velocidad media del once (`pac`) mueve **+24 puntos porcentuales** de
   victoria local en el simulador y cotizaba **0**. El `def` de los jugadores
   (media defensiva) valía +5,7 pp y tampoco existía. El `gk` del portero
   cotizaba la décima parte de su efecto real. Consecuencia: la fórmula no
   sabía quién era fuerte de verdad y publicaba partidos «parejos» donde el
   generador tenía favorito claro — y al revés.

2. **Ratings subponderados.** `elo` respondía +7,7 pp por ±150 en el simulador
   y la fórmula le daba la cuarta parte de su peso; `att/def` eran algo más
   fuertes de lo medido. Con datos de 9 jornadas acumulados en los ratings, la
   fórmula apenas los notaba.

3. **Clima de goles demasiado agresivo.** `KAPPA_L = 2` hundía los empates
   (4,60+ publicados) solo porque la liga observaba muchos goles; la respuesta
   real del generador al clima es suave (2,08→2,85 goles por partido entre
   `leagueAvg` 1,05 y 1,70, con los empates casi planos).

## Qué cambió

- **`lib/football/v2/estimated-quotes.js`** — nueva fórmula `v2-mc-2`
  (`v2-estimated-3`), calibrada contra `v2-causal-4`. Mismo prior Monte Carlo
  (`score-prior-causal-4.json`), misma forma de tilt; cambian los pesos y los
  features (`defAttr` y `pac` nuevos). La cabecera del archivo lista la tabla de
  calibración completa (respuesta medida del simulador → peso).
- **`lib/football/v2/estimated-quotes-v2.js`** — la fórmula anterior
  `v2-mc-1` (`v2-estimated-2`) queda **congelada**: un compromiso antiguo se
  revalida siempre con la fórmula que lo creó y una cuota comprometida nunca se
  recalcula con otra.
- **`lib/football/v2/quotes.js`** — despacho por versión de modelo (tres
  fórmulas conviviendo: v2-estimated-1/2/3).
- **`lib/football/v2/season-policy.js`** — las políticas con `pricingVersion`
  anterior siguen verificándose y migran con `upgradePolicy` sin tocar
  compromisos ni boletos.

Constantes nuevas (las anteriores van entre paréntesis):

| Constante | v2-mc-2 | v2-mc-1 | Por qué |
| --- | --- | --- | --- |
| `KAPPA0` | −0,14 | −0,20 | nivel de goles del baseline (2,48) |
| `EDGE0` | −0,03 | +0,034 | residuo de local del motor, ahora NEGATIVO |
| `KAPPA_Q` | 0,6 | 0,5 | los cruces desiguales suben goles (2,23–3,23) |
| `KAPPA_L` | 0,55 | 2 | respuesta suave del clima medida |
| `elo` | 0,14 | 0,04 | +7,7 pp medidos por ±150 |
| `att` / `oneMinusDef` | 0,20 / 0,20 | 0,27 / 0,27 | +8 pp medidos por ±0,18 espejo |
| `gk` (rating) | 0,27 | 0,25 | +8 pp medidos por ±0,18 |
| `sho` (media once) | 0,008 | 0,0065 | +9,4 pp por ±10 |
| `pas` (media once) | 0,007 | 0,0028 | +2,6 pp por ±10 |
| `defAttr` (nuevo) | 0,009 | — | +5,7 pp por ±10 |
| `pac` (nuevo) | 0,017 | — | **+24 pp por ±10** (el efecto ignorado) |
| `gkAttr` (portero) | 0,009 | 0,0006 | +8,3 pp por 92/70 |

El error por escenario queda dentro de ~±3,5 pp en la mayoría de los cruces
(ruido de medición ~±2,5 pp). Persiste un desfase de hasta ~9 pp en algunos
cruces de plantillas reales cuya fuerza no capturan las medias de atributos por
puesto (p. ej. un delantero muy rápido en una formación de un solo punta).

## Por qué los favoritos no «suben» hasta 1,50 como en una casa real

La cuota debe reflejar **lo que el generador produce** (regla R3/§3.3: el modelo
que genera el partido y el que fija la cuota no pueden divergir, o el margen
dejaria de ser cierto y habría selecciones con ventaja oculta). El motor actual
(`v2-causal-4`) es menos sensible a la fuerza que el fútbol real: un líder de 22
puntos ante un equipo de mitad de tabla gana ~55 % de las réplicas, no el 65–70 %
de las ligas reales. Con esa verdad, el favorito justo ronda 1,8–2,0, y eso es lo
que ahora se publica. Para favoritos de 1,50 hace falta que el **generador**
separe más a los fuertes de los débiles (una futura versión `v2-causal-5`), no
que la fórmula mienta.

## Hallazgo aparte: el realismo del generador, medido por la auditoría

`npm run football:odds-audit` sobre el modelo recalibrado:

| Métrica | Modelo | Fútbol real | Veredicto |
| --- | --- | --- | --- |
| Victorias locales | 34 % | 44 % | **BAJO** |
| Empates | 26 % | 25 % | en banda |
| Victorias visitantes | 40 % | 31 % | **ALTO** |
| Goles por partido | 2,6 | 2,75 | en banda |
| Ambos marcan | 51 % | 52 % | en banda |

El simulador `v2-causal-4` **no tiene ventaja de local**: en partidos de equipos
idénticos el visitante gana ~39–41 % y el local ~35 % (medido con ~1.400
réplicas; el prior agregado da 36/39). La fórmula anterior lo enmascaraba con un
EDGE0 positivo inventado; v2-mc-2 cotiza el residuo real (−0,03) porque
inventar una ventaja de local que el generador no produce crearía selecciones
locales sistemáticamente caras y visitantes con valor oculto (la herramienta
`economicReport` de `scripts/calibrate-football-v2.js` lo detectaría como
retorno positivo del jugador en el visitante). Recomendación: dar ventaja de
sede al generador en su próxima versión y, solo entonces, volver a fijar EDGE0
positivo con la misma metodología de este documento.

Además, los partidos de temporada con plantillas y ratings reales se acercan a
3,5 goles por partido (el clima rodante `leagueAvg` queda clavado en su tope
1,85 y `homeAdv` en su suelo 1,0). Las cuotas van consistentes con el generador
(mismo `context` congelado en el compromiso), pero conviene vigilarlo con
`npm run football:odds-audit` por jornada.

## Cómo se reprodujo todo (auditoría)

1. Reproducir una temporada con el pipeline real (calendario de `fixtures.js`,
   resultados del `simulator` v2-causal-4 con las mismas semillas que
   `generateReplay`, ratings actualizados con `updateAfterMatch` +
   `recomputeLeagueStats` como `settleMatch`).
2. Cotizar la jornada siguiente con `prepareMatchInputs` → `createEstimatedModel`
   → `preMatchMarket('1x2')`.
3. Medir la verdad de cada cruce con 120–350 réplicas del mismo `createMatch`
   que usa `generateReplay`.
4. Ajustar los pesos minimizando el error cuadrático entre las probabilidades de
   la fórmula y las medidas del simulador (escenarios factor-a-factor + cruces
   de plantillas reales + climas), y redondear las constantes sin perder el
   ajuste (comprobación por escenario en la tabla de la cabecera del módulo).
