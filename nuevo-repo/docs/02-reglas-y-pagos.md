# Ticket 02 · Reglas y pagos de cada juego

| Campo | Valor |
| --- | --- |
| **ID** | DOC-02 |
| **Tipo** | Especificación numérica |
| **Estado** | Propuesta · listo para implementar |
| **Prioridad** | Alta · **bloquea el código y las pruebas** |
| **Depende de** | DOC-01 (alcance) |
| **Desbloquea** | Motor de juego, tests unitarios, interfaz de cada juego |

> **Este documento es la única fuente de los números.** El código debe importar estas constantes
> y las pruebas deben usar estos mismos valores. Si un número cambia aquí, cambia en los dos lados.

---

## 1. Convenio de pago (léelo antes que nada)

En todo el proyecto se usa **pago total** (*total payout*): el multiplicador se aplica sobre la
apuesta **e incluye la devolución de lo apostado**.

```
pago      = truncar(apuesta × multiplicador)     ← fichas que se acreditan al jugador
ganancia  = pago − apuesta                       ← fichas que realmente gana (o pierde)
```

| Ejemplo | Apuesta | Multiplicador | Pago acreditado | Ganancia neta |
| --- | ---: | ---: | ---: | ---: |
| Cara o Cruz acertada | 100 | ×2 | 200 | +100 |
| Cara o Cruz fallada | 100 | ×0 | 0 | −100 |
| Blackjack natural | 15 | ×2,5 | 37 | +22 |
| Empate (push) | 100 | ×1 | 100 | 0 |

- Las apuestas se **descuentan del saldo al confirmar** y el pago se **acredita al liquidar**.
- Todos los importes son **enteros**. Cuando el multiplicador no es entero (×2,5 del blackjack),
  el pago se **trunca** (`Math.floor`), nunca se redondea hacia arriba.
- Ninguna operación puede dejar saldo negativo: el servidor valida antes de aceptar.

---

## 2. Constantes globales (un solo lugar, un solo valor)

| Constante | Valor | Dónde se usa |
| --- | --- | --- |
| `SALDO_INICIAL` | `1000` | Perfil nuevo |
| `APUESTA_MINIMA` | `10` | Todas las apuestas y ciegas |
| `APUESTA_MAXIMA` | saldo disponible | Validación del servidor |
| `JUGADORES_POR_SALA` | `6` | Capacidad de la sala |
| `LONGITUD_CODIGO_SALA` | `5` | Código compartible |
| `TIEMPO_TURNO_BLACKJACK_MS` | `25000` | Reloj de turno |
| `TIEMPO_TURNO_POKER_MS` | `30000` | Reloj de turno |
| `CIEGA_PEQUENA` | `10` | Texas Hold'em |
| `CIEGA_GRANDE` | `20` | Texas Hold'em · subida mínima |
| `MAZOS_BLACKJACK` | `4` (208 cartas) | Blackjack |
| `MAZOS_POKER` | `1` (52 cartas) | Texas Hold'em |
| `REBARAJAR_SI_QUEDAN_MENOS_DE` | `52` | Blackjack y póker |
| `PLANTARSE_CASA` | `17` | Blackjack (la casa se planta con 17, duro o blando) |
| `TIEMPO_HOST_INACTIVO_MS` | `60000` | Migración del rol de anfitrión |

Sugerencia de implementación (`lib/reglas.js`):

```js
const REGLAS = {
  SALDO_INICIAL: 1000,
  APUESTA_MINIMA: 10,
  JUGADORES_POR_SALA: 6,
  LONGITUD_CODIGO_SALA: 5,
  TIEMPO_TURNO_BLACKJACK_MS: 25_000,
  TIEMPO_TURNO_POKER_MS: 30_000,
  CIEGA_PEQUENA: 10,
  CIEGA_GRANDE: 20,
  MAZOS_BLACKJACK: 4,
  MAZOS_POKER: 1,
  REBARAJAR_SI_QUEDAN_MENOS_DE: 52,
  PLANTARSE_CASA: 17,
  TIEMPO_HOST_INACTIVO_MS: 60_000
};

const PAGOS = {
  coinflip: { acierto: 2, fallo: 0 },
  dice:     { bajo: 2, alto: 2, exacto: 6, fallo: 0 },
  roulette: { pleno: 36, docena: 3, columna: 3, simple: 2, fallo: 0 },
  blackjack:{ victoria: 2, natural: 2.5, empate: 1, derrota: 0, seguro: 3 }
};

function liquidar(apuesta, multiplicador) {
  const pago = Math.floor(apuesta * multiplicador);
  return { pago, neto: pago - apuesta };
}
```

---

## 3. Cara o Cruz

**Mecánica.** Cada jugador elige `cara` o `cruz` y apuesta. El anfitrión lanza; el servidor
genera un valor aleatorio con probabilidad 50/50 y liquida a toda la sala con el mismo resultado.

| Apuesta | Paga | Multiplicador | Probabilidad | Retorno (RTP) |
| --- | --- | ---: | ---: | ---: |
| Cara | Cara | **×2** | 50 % | 100 % |
| Cruz | Cruz | **×2** | 50 % | 100 % |
| Cualquiera | No acierta | ×0 | 50 % | — |

**Reglas:** una sola apuesta por jugador y ronda · apuesta mínima 10 · se puede elegir cara o cruz
libremente (no hace falta que haya apuestas en los dos lados).

---

## 4. Dados

**Mecánica.** Se lanza **un dado de 6 caras** (1–6), el mismo para toda la sala.

| Apuesta | Gana si sale | Multiplicador | Probabilidad | RTP |
| --- | --- | ---: | ---: | ---: |
| Bajo | 1, 2 o 3 | **×2** | 3/6 (50 %) | 100 % |
| Alto | 4, 5 o 6 | **×2** | 3/6 (50 %) | 100 % |
| Número exacto (1–6) | ese número | **×6** | 1/6 (16,7 %) | 100 % |

**Reglas:** una sola opción por jugador y ronda · apuesta mínima 10 · el 1 **no** es comodín
(a diferencia del 0 de la ruleta, el 1 simplemente es «bajo»).

---

## 5. Ruleta (europea, 37 casillas)

**Mecánica.** Rueda con los números **0 al 36** (un solo cero). El servidor elige el número; el
cliente solo anima la rueda hasta ese número.

| Apuesta | Casillas que cubre | Multiplicador | Probabilidad | RTP |
| --- | ---: | ---: | ---: | ---: |
| **Pleno** (un número exacto, 0–36) | 1 | **×36** | 1/37 | 97,30 % |
| **Docena** (1–12 · 13–24 · 25–36) | 12 | **×3** | 12/37 | 97,30 % |
| **Columna** (1ª, 2ª o 3ª) | 12 | **×3** | 12/37 | 97,30 % |
| **Rojo** | 18 | **×2** | 18/37 | 97,30 % |
| **Negro** | 18 | **×2** | 18/37 | 97,30 % |
| **Par** (2, 4, …, 36) | 18 | **×2** | 18/37 | 97,30 % |
| **Impar** (1, 3, …, 35) | 18 | **×2** | 18/37 | 97,30 % |
| **Bajo** (1–18) | 18 | **×2** | 18/37 | 97,30 % |
| **Alto** (19–36) | 18 | **×2** | 18/37 | 97,30 % |

**Reglas del cero.** Si sale **0** pierden **todas** las apuestas externas (color, paridad, rango),
las docenas y las columnas. **Solo gana** quien apostó al pleno 0, que cobra ×36.

**Números rojos** (los demás, salvo el 0, son negros):
`1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36`

**Columnas.** 1ª: 1, 4, 7, …, 34 · 2ª: 2, 5, 8, …, 35 · 3ª: 3, 6, 9, …, 36.
Definición corta para el código: `numero % 3 === 1` → columna 1 · `=== 2` → columna 2 · `=== 0` → columna 3.

---

## 6. Blackjack / 21

**Mecánica.** Cada jugador juega **contra la casa**, no contra los demás. Todos apuestan, el
anfitrión reparte y cada quien decide por turno.

### Valor de las cartas

| Carta | Valor |
| --- | --- |
| 2–10 | su número |
| J, Q, K | 10 |
| A | 11, o 1 si con 11 se pasa de 21 |

### Tabla de pagos

| Situación | Multiplicador | Ejemplo con apuesta de 100 |
| --- | ---: | --- |
| **Blackjack natural** (21 con las 2 primeras cartas) y la casa **no** tiene natural | **×2,5** | pago 250 · ganancia +150 |
| **Victoria** (más que la casa sin pasarse, o la casa se pasa) | **×2** | pago 200 · ganancia +100 |
| **Empate** (push, mismo valor) | **×1** | pago 100 · ganancia 0 |
| **Derrota** (menos que la casa) | **×0** | pago 0 · ganancia −100 |
| **Bust** (más de 21) | **×0** | pago 0 · ganancia −100 |
| **Seguro acertado** (la casa tiene natural) | **×3 sobre el seguro** | ver abajo |

### Reglas de la casa

- La casa **pide carta con 16 o menos** y **se planta con 17 o más**, incluido el 17 blando.
- Si la casa tiene **blackjack natural**, los jugadores pierden su apuesta **excepto** quien
  también tenga natural, que empata (×1).
- Mazo de **4 barajas**; se rebaraja antes de repartir si quedan menos de **52 cartas**.

### Jugadas del participante

| Jugada | Qué hace | Cuándo está disponible | Efecto en fichas |
| --- | --- | --- | --- |
| **Pedir** (`hit`) | recibe una carta | En su turno | — |
| **Plantarse** (`stand`) | cierra su mano | En su turno | — |
| **Doblar** (`double`) | duplica la apuesta, recibe **una sola** carta y cierra la mano | Solo con 2 cartas y si tiene fichas para igualar la apuesta | −1 apuesta extra |
| **Dividir** (`split`) | separa dos cartas del **mismo valor** en dos manos independientes | Solo con 2 cartas del mismo valor, una vez por ronda, con fichas para igualar | −1 apuesta extra |
| **Seguro** (`insurance`) | apuesta aparte contra el blackjack de la casa | Solo si la casa muestra un **As**, antes de la primera jugada | −`redondear_arriba(apuesta / 2)` |

### Seguro, paso a paso

1. Costo: `costoSeguro = Math.ceil(apuesta / 2)` → apuesta 100 → 50 · apuesta 15 → 8.
2. Si la casa tiene **blackjack natural**: se acredita `costoSeguro × 3` (ganancia neta `+2 × costoSeguro`).
3. Si no lo tiene: el seguro se pierde (ganancia neta `−costoSeguro`) y la ronda continúa normal.

### Ejemplos numéricos completos

| Caso | Apuesta | Resultado | Pago | Ganancia |
| --- | ---: | --- | ---: | ---: |
| 21 natural, casa 18 | 100 | ×2,5 | 250 | +150 |
| 21 natural, casa 21 natural | 100 | ×1 | 100 | 0 |
| 19 vs casa 17 | 100 | ×2 | 200 | +100 |
| 19 vs casa 19 | 100 | ×1 | 100 | 0 |
| 19 vs casa 20 | 100 | ×0 | 0 | −100 |
| 23 (bust) | 100 | ×0 | 0 | −100 |
| 21 natural con apuesta 15 | 15 | ×2,5 | `Math.floor(37,5)` = 37 | +22 |
| Seguro de 50 acertado | 100 | +seguro ×3 | 150 | +100 (sobre el seguro) |
| Seguro de 50 fallido | 100 | seguro ×0 | 0 | −50 (sobre el seguro) |

---

## 7. Texas Hold'em

**Mecánica.** Se juega **entre jugadores** (no contra la casa), así que **no hay multiplicadores**:
el ganador se lleva el bote. Esta sección fija los importes y el orden de manos.

| Concepto | Valor |
| --- | --- |
| Ciega pequeña | 10 |
| Ciega grande | 20 |
| Subida mínima | 20 (la ciega grande) |
| Fichas mínimas para jugar una mano | 20 |
| Baraja | 1 mazo de 52 cartas |
| Calles | Preflop (2 cartas) → Flop (3) → Turn (1) → River (1) → Showdown |
| Comisión de la casa (rake) | **0 %** |
| Tiempo por turno | 30 s (al vencer: pasa si puede, si no se retira) |

**Acciones:** `pasar` (check) · `igualar` (call) · `subir` (raise, mínimo +20 sobre la apuesta
actual) · `retirarse` (fold) · `all-in` (con botes laterales si hay distintos niveles de apuesta).

**Orden de manos, de mayor a menor** (para el evaluador y sus pruebas):

1. Escalera real · 2. Escalera de color · 3. Póker · 4. Full house · 5. Color · 6. Escalera ·
7. Trío · 8. Doble par · 9. Par · 10. Carta alta.

El As cierra la escalera alta (`A-K-Q-J-10`) y abre la baja (`A-2-3-4-5`), donde el As vale 1.

**Reparto del bote:** el ganador lo recibe completo; en empate se divide en partes iguales y, si
sobra una ficha, va al jugador más cercano a la izquierda del repartidor.

---

## 8. Resumen de multiplicadores (para tests)

| Juego | Opción | Multiplicador |
| --- | --- | ---: |
| `coinflip` | acierto | 2 |
| `dice` | bajo / alto | 2 |
| `dice` | número exacto | 6 |
| `roulette` | pleno | 36 |
| `roulette` | docena / columna | 3 |
| `roulette` | rojo / negro / par / impar / 1–18 / 19–36 | 2 |
| `roulette` | cualquier externa si sale 0 | 0 |
| `blackjack` | victoria | 2 |
| `blackjack` | natural | 2,5 |
| `blackjack` | empate | 1 |
| `blackjack` | derrota o bust | 0 |
| `blackjack` | seguro acertado (sobre el seguro) | 3 |
| `poker` | no aplica: el ganador se lleva el bote | — |

Retorno teórico al jugador: Cara o Cruz **100 %** · Dados **100 %** · Ruleta **97,30 %** ·
Blackjack **≈ 99,5 %** con estas reglas · Póker **100 %** (sin comisión). No hay dinero real:
el retorno solo describe el comportamiento de las fichas virtuales.

---

## 9. Casos de prueba mínimos

Las pruebas deben usar **exactamente** estos valores. Cada fila es un caso:

| # | Juego | Apuesta | Opción | Resultado del servidor | Multiplicador | Pago | Ganancia |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: |
| 1 | coinflip | 100 | `cara` | `cara` | 2 | 200 | +100 |
| 2 | coinflip | 100 | `cara` | `cruz` | 0 | 0 | −100 |
| 3 | dice | 50 | `bajo` | 3 | 2 | 100 | +50 |
| 4 | dice | 50 | `bajo` | 4 | 0 | 0 | −50 |
| 5 | dice | 50 | `n:5` | 5 | 6 | 300 | +250 |
| 6 | dice | 50 | `n:5` | 2 | 0 | 0 | −50 |
| 7 | roulette | 100 | `n:17` | 17 | 36 | 3.600 | +3.500 |
| 8 | roulette | 100 | `rojo` | 12 (rojo) | 2 | 200 | +100 |
| 9 | roulette | 100 | `rojo` | 0 | 0 | 0 | −100 |
| 10 | roulette | 100 | `d2` | 20 | 3 | 300 | +200 |
| 11 | roulette | 100 | `c3` | 21 | 3 | 300 | +200 |
| 12 | roulette | 100 | `d2` | 25 | 0 | 0 | −100 |
| 13 | blackjack | 100 | — | 19 vs casa 17 | 2 | 200 | +100 |
| 14 | blackjack | 15 | — | natural vs casa 18 | 2,5 | 37 | +22 |
| 15 | blackjack | 100 | — | 19 vs casa 19 | 1 | 100 | 0 |
| 16 | blackjack | 100 | — | 24 (bust) | 0 | 0 | −100 |
| 17 | blackjack | 100 | seguro 50 | casa con natural | 3 | 150 | +100 |
| 18 | blackjack | 100 | seguro 50 | casa sin natural | 0 | 0 | −50 |
| 19 | validación | 5 | cualquier | — | — | — | **rechazada** (< 10) |
| 20 | validación | 9.999 | cualquier | — | — | — | **rechazada** (saldo insuficiente) |

---

## 10. Reglas de validación que el servidor debe aplicar siempre

1. La fase de la sala permite la acción (`apuestas`, `jugando`, `resultados`).
2. Le toca a ese jugador (en blackjack y póker).
3. El monto es entero, `>= APUESTA_MINIMA` y `<= saldo disponible`.
4. El jugador no había apostado ya en esa ronda.
5. La ronda no fue liquidada antes (idempotencia: una liquidación por ronda y por jugador).
6. La opción elegida existe en el juego (`cara`/`cruz`, `bajo`/`alto`/`n:1`…`n:6`, `n:0`…`n:36`, etc.).
7. Solo el anfitrión puede lanzar, repartir o abrir la siguiente ronda.
