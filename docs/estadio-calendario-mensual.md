# Estadio MonteCristo — calendario de cada mes y ciclo del Balón de Oro

**Actualizado · 31-oct-2026** · Horas en la zona del casino (`America/Mexico_City`).

Este documento se genera con la misma función que crea la temporada (`lib/football/fixtures.js`), así
que lo que dice aquí es lo que se juega. Para verlo de un mes concreto, sin tocar datos reales:

```bash
npm run football:calendar                          # mes en curso
npm run football:calendar -- --season 2026-11      # un mes
npm run football:calendar -- --months 6            # el mes y los cinco siguientes
npm run football:calendar -- --json                # datos crudos
```

---

## 1. Cómo se reparte un mes

Una temporada es **240 partidos = 30 jornadas de 8** (16 clubes a doble vuelta). Cada club juega una
vez por jornada; en un día doble, dos.

| Regla | Valor |
| --- | --- |
| Días con fútbol | **días del mes − 1** (el último día se reserva para cierre, liquidación y el desempate) |
| Jornadas | 30, siempre |
| Días dobles | `max(0, 30 − días con fútbol)`, repartidos **uniformemente** para que no se junten al final |
| Segunda oleada del día doble | todos los horarios **+30 min** |
| Zona horaria | la del casino, no la del servidor (Render/Neon corren en UTC) |

### Los tres bloques diarios

| Bloque | Partidos | Horarios |
| --- | --- | --- |
| Matutino | 3 | 13:00 · 14:00 · 15:00 |
| Vespertino | 3 | 17:00 · 18:00 · 19:00 |
| Estelar | 2 | 20:30 · **21:30 (destacado)** |

En un día doble la segunda oleada repite la estructura desplazada media hora:
**13:30 · 14:30 · 15:30 · 17:30 · 18:30 · 19:30 · 21:00 · 22:00**.

Los dos partidos de mayor elo combinado van al bloque Estelar, y el de las **21:30** es el destacado del día
(es el que la portada del Estadio resalta).

## 2. Calendario según el largo del mes

| Mes | Días | Con fútbol | Días dobles | J20 se juega | J30 se juega | Ceremonia | Cierre |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 31 días (ene, mar, may, jul, ago, oct, dic) | 31 | 30 | ninguno | día 20 | día 30 | día 30, 22:00 | día 31, 23:59 |
| 30 días (abr, jun, sep, nov) | 30 | 29 | **día 15** (J15 + J16) | día 19 | día 29 | día 29, 22:00 | día 30, 23:59 |
| 29 días (febrero bisiesto) | 29 | 28 | **días 8 y 22** (J8+J9, J23+J24) | día 19 | día 28 | día 28, 22:00 | día 29, 23:59 |
| 28 días (febrero) | 28 | 27 | **días 5, 14 y 23** (J5+J6, J15+J16, J25+J26) | día 18 | día 27 | día 27, 22:00 | día 28, 23:59 |

En los meses de 31 días cada jornada tiene su día: **J1 el día 1 … J30 el día 30**, y el día 31 queda
para el cierre. En los meses cortos, los días dobles corren las jornadas siguientes una casilla.

## 3. Los próximos meses, día a día

### Octubre 2026 — 31 días, sin días dobles

| Día | Jornada | Horarios |
| --- | --- | --- |
| 1 … 30 | J1 … J30 (una por día) | 13:00 · 14:00 · 15:00 · 17:00 · 18:00 · 19:00 · 20:30 · 21:30 |
| 31 | — cierre y liquidación | hasta las 23:59 |

Ceremonia del Balón de Oro: **30 de octubre, 22:00** (después del partido de las 21:30).

### Noviembre 2026 — 30 días, un día doble

| Día | Jornada |
| --- | --- |
| 1 – 14 | J1 – J14 |
| **15** | **J15 + J16** (oleada 2 a las 13:30 · 14:30 · 15:30 · 17:30 · 18:30 · 19:30 · 21:00 · 22:00) |
| 16 – 29 | J17 – J30 |
| 30 | — cierre y liquidación |

Ceremonia: **29 de noviembre, 22:00**. Cierre de temporada: 30 de noviembre, 23:59.

### Diciembre 2026, enero 2027 y marzo 2027 — 31 días, sin días dobles

| Mes | J20 (cierre de mercado) | J30 | Ceremonia | Cierre |
| --- | --- | --- | --- | --- |
| Diciembre 2026 | 20 dic | 30 dic | 30 dic, 22:00 | 31 dic, 23:59 |
| Enero 2027 | 20 ene | 30 ene | 30 ene, 22:00 | 31 ene, 23:59 |
| Marzo 2027 | 20 mar | 30 mar | 30 mar, 22:00 | 31 mar, 23:59 |

### Febrero 2027 — 28 días, tres días dobles

| Día | Jornada |
| --- | --- |
| 1 – 4 | J1 – J4 |
| **5** | **J5 + J6** |
| 6 – 13 | J7 – J14 |
| **14** | **J15 + J16** |
| 15 – 22 | J17 – J24 |
| **23** | **J25 + J26** |
| 24 – 27 | J27 – J30 |
| 28 | — cierre y liquidación |

J20 cae el **18 de febrero** (cierre de mercado) y la ceremonia es el **27 de febrero, 22:00**.

## 4. El ciclo del Balón de Oro, paso a paso

| Momento | Cuándo | Qué pasa |
| --- | --- | --- |
| **Apertura** | **día 1** del mes | El ciclo pasa de `scheduled` a `active` y se publican las primeras cuotas. Si el proceso no lo abre el día 1, el ciclo se **cancela** (`apertura_no_realizada_dia_1`) y se reembolsan las predicciones |
| **Apuestas** | J1 → final de J20 | Se puede predecir al ganador del premio. Las cuotas se **refrescan al completar cada jornada** |
| **Cierre de mercado** | al asentarse el último partido de la **J20** (≈21:30–22:00) | El evento pasa a `locked`: ya no se aceptan predicciones |
| **Acumulación** | J21 → J30 | El premio sigue sumando goles, asistencias, apariciones y tarjetas, pero sin mercado |
| **Resultado** | al asentarse el último partido de la **J30** (y el desempate si hizo falta) | Se calcula el ranking con el bonus por posición final (campeón +5, subcampeón +3, top-4 +1) |
| **Ceremonia y pagos** | **22:00** del día del último partido | Se anuncia el ganador y se liquidan las predicciones. Si el resultado se cierra después de las 22:00, la ceremonia pasa al día siguiente a las 22:00 |
| **Cierre de temporada** | último día del mes, **23:59** | Tabla final, carryover a la temporada siguiente y reset mensual del casino (que se **aplaza** mientras haya apuestas de fútbol abiertas) |

### Desempate (solo si hace falta)

Si el título o el podio quedan empatados en la tabla, se juega **un partido de desempate el último día
del mes a las 13:00**, siempre que quepa antes del cierre de las 23:59. El desempate **no aporta
estadísticas** al Balón de Oro ni a Mi Once: solo decide posiciones (y con ellas el bonus del premio).
Si no se resuelve a tiempo, el ciclo se cancela y las predicciones se reembolsan.

### Motivos por los que un ciclo puede cancelarse (reembolso íntegro)

- `apertura_no_realizada_dia_1` — el proceso no abrió el ciclo el día 1.
- `temporada_no_cerrada_antes_reset` — la J30 (o su desempate) no quedó asentada antes del cierre.
- `temporada_truncada` — la temporada se marcó truncada.
- `desempate_no_resuelto_antes_reset` / `desempate_no_cabe_en_ventana_de_cierre`.
- `calendario_invalido` — la J1 no tiene sus 8 partidos.

## 5. Notas prácticas

- **Las horas son de pared**: un partido de las 21:30 se juega a las 21:30 en México aunque el servidor
  esté en UTC.
- **El día doble duplica la jornada de cada club**: los 16 clubes juegan dos partidos ese día, media
  hora desfasados. Los puntos de Mi Once de las dos jornadas se suman.
- **El último día del mes no tiene fútbol regular** por diseño: es la ventana de cierre, liquidación y
  desempate.
- **Un partido que quede en vuelo al cambiar el mes se asienta antes de rotar la temporada** (ver
  `docs/estadio-auditoria-fuentes-unicas.md`), así que su apuesta se liquida con su resultado.
