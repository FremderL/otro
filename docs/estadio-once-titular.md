# El once titular, visible en la previa

## 1. El problema

El usuario pide, con sus palabras: *«Durante la previa o en algún lugar, se pueda
enterar el usuario de cuál es el once que jugará, ya que actualmente no sabe
cuáles o quiénes son los que están jugando del 11.»*

Hoy el once **existe, es determinista y es autoritativo**, pero no se publica en
ninguna superficie de la previa:

| Dónde se podría ver | Estado actual |
|---|---|
| Carrusel de La Previa (`#est-showcase`) | solo indicadores y anuncios: formación y estilo, **ningún nombre** |
| Cabina (`buildPregameScript`) | dice «4-4-2 y posesión», **nunca el once** |
| Ficha del club (`clubProfile`) | `lineup` trae `{id, role, initialStatus}`, **sin nombre ni dorsal** |
| Cancha | pinta a los 11 en el campo, pero sin lista legible y solo en vivo |

## 2. De dónde sale el once (y por qué no se inventa nada)

El once que el simulador usa **ya está calculado** en dos lugares, y la regla de
este trabajo es no crear una tercera verdad:

1. **Partido ya comprometido (V2, el caso normal).** El compromiso `match.simulation`
   congela las alineaciones en `match.simulation.inputs.{home,away}.lineup`
   (`lib/football/v2/official.js` → `snapshot()` → `lib/football/v2/inputs.js`).
   Ese JSON es *exactamente* el que `generateReplay()` convierte en frames y
   eventos. Si el once publicado no fuese éste, la previa mentiría.
2. **Partido aún sin compromiso (proyección).** Se replica la precedencia de
   `v2/inputs.js:63`, que es la única que el Estadio considera correcta:

   ```js
   const t     = resolveClubTactics(club, league, asOf);
   const club2 = { ...club, tactics: { formation: t.formation, style: t.style }, manager: t.manager };
   const lineup = createTeamLineup(club2);
   ```

   `createTeamLineup()` (`lib/football/match-state.js:125`) marca 11 jugadores con
   `initialStatus:'active'` y `slotIndex 0..10`; el resto es banquillo. No hay
   sorteo: mismo plantel + misma pizarra ⇒ mismo once.

En ambos casos el resultado es el mismo objeto de alineación, así que **la previa
y la simulación no pueden divergir**. La proyección se etiqueta como tal
(`source: 'projected'`) para no anunciar como definitivo algo que todavía puede
cambiar con un fichaje o un ajuste del DT; cuando el compromiso existe,
`source: 'commitment'` y ya no cambia.

## 3. Capa única: `lib/football/lineups.js`

```
matchLineups(store, match, at) -> {
  matchId, seasonMonth, asOf,
  source: 'commitment' | 'projected',
  home: teamView, away: teamView
}
teamView = {
  clubId, name, short, formation, style,
  manager: { id, name } | null,
  starters: [{ id, name, number, pos, role, slotIndex }],   // 11, slotIndex 0..10
  bench:    [{ id, name, number, pos, role }]
}
```

Reglas que aplica:

* **Fuente 1:** si `match.simulation` verifica con `verifyCommitment()` y trae
  `inputs.home.lineup`, se publica *tal cual* (sin recalcular). Si el compromiso
  está marcado inválido o no verifica, **no se usa**.
* **Fuente 2 (respaldo):** proyección con `resolveClubTactics` + `createTeamLineup`,
  la misma precedencia de `v2/inputs.js`.
* Sin liga, sin clubes o sin plantilla: `null` (la superficie muestra «no
  disponible»). **Nunca** un once de relleno.
* Orden estable: por `slotIndex` (portero primero). Determinista y auditable.

## 4. Superficies que lo muestran

### 4.1 Ficha nueva del carrusel de La Previa (la principal)

`public/estadio.js` → `lineupSlideMarkup()`, añadida a `items` en
`renderShowcase()` **antes** de los anuncios, con `key: 'lineup'` y
`type: 'lineup'`. Dos columnas (local / visitante) con formación y DT en la
cabecera y las once filas `dorsal · nombre · puesto`. En móvil las columnas se
apilan. Es el único sitio donde los 22 nombres caben legibles.

* Nombre de la ficha: «Onces titulares». Kicker distingue
  `Confirmado` (compromiso) de `Proyección` (sin compromiso), con el matiz
  «puede cambiar hasta el saque inicial».
* El punto del carrusel dice «once titular» y su `aria-label` lo anuncia.

### 4.2 Una línea en la cabina

`buildPregameScript()` gana un bloque 7 (antes del cierre) con **dos**
intervenciones de 140 caracteres máximo centradas en los protagonistas, porque
los 11 nombres no caben en una línea:

* narrador: «El once de {club} ({formación}): {portero}, {2 nombres}…» → se
  limita a portero + tres nombres y remite a la ficha.
* analista: el nombre que el DT deja fuera (el mejor del banquillo, si existe) y
  por qué importa.

Si el once no se puede resolver, no se dice nada (no se improvisa).

### 4.3 Ficha del club, completa

`clubProfile()` publica el `lineup` con `name` y `number` además de
`{id, role, initialStatus}`, y el cliente pinta «Inicial» ya con nombre y dorsal
(el campo ya está). Cambio aditivo: no rompe a quien solo lee `id/role`.
Además, el texto «Once inicial orientativo…» pasa a decir de qué fuente sale.

### 4.4 Canal de datos

* Socket `football:lineups_get` `{ matchId }` → `ack({ ok, lineups })`, con la
  misma puerta de identidad que `football:roster_get` (sin identidad:
  `no_identity`). Solo lectura, sin efectos sobre el perfil.
* El cliente lo pide al entrar a un partido y lo refresca mientras la previa
  está abierta **si** `source === 'projected'` (como mucho una vez por minuto);
  con `source === 'commitment'` se cachea porque ya no cambia.

## 5. Qué queda fuera (a propósito)

* No se toca `football:tick` ni el estado derivado del partido: el once es de la
  previa, no del relato.
* No se re-simula nada ni se adelanta el resultado. `matchLineups` **no** genera
  la línea de tiempo; solo lee lo ya congelado.
* No se inventa un nombre ni se completa con suplentes un once incompleto: si la
  plantilla no da, se publica lo que el simulador alinearía y se dice.

## 6. Verificación

* `tests/football-lineups.test.js`:
  * 11 titulares, `slotIndex` 0..10 sin huecos ni repetidos, todos del plantel,
    todos con nombre, portero en el 0;
  * con compromiso, el once **es** el del compromiso: cambiar el plantel después
    no lo altera;
  * sin compromiso, el once coincide con `createTeamLineup(resolveClubTactics…)`
    (misma precedencia que `v2/inputs.js`);
  * sin liga/clubes → `null`;
  * handler `football:lineups_get`: sin identidad `no_identity`, con identidad
    devuelve el partido pedido y nada más;
  * la cabina nombra jugadores reales del once y respeta los 140 caracteres.
* `tests/football-stadium-ui.test.js`: la ficha del carrusel aparece, contiene a
  los 11 de cada lado, el contador pasa de `1 / 5` a `1 / 6` y el punto permite
  volver a ella.
* `npm run test:unit` en verde y `eslint` limpio.
* e2e real contra `FOOTBALL_ENABLED=1 PORT=399x node server.js`: buscar el
  partido con compromiso, pedir el once por socket y comparar los 11 ids con
  `match.simulation.inputs.home.lineup`.

## 7. Implementación (hecha)

| Pieza | Archivo | Qué hace |
|---|---|---|
| Capa única del once | `lib/football/lineups.js` (nuevo) | `matchLineups(store, match, at)` → `{ source: 'commitment' \| 'projected', home, away }`, con 11 titulares (`slotIndex 0..10`), banquillo, formación, estilo y DT |
| Canal | `lib/football/sockets.js` | `football:lineups_get { matchId }` → `{ ok, lineups }`; misma puerta de identidad que `roster_get` |
| Ficha del carrusel | `public/estadio.js` + `.css` | Ficha «Onces titulares» (dos columnas, 11 filas por lado con dorsal, nombre y puesto); es la **primera** ficha y el carrusel abre ahí la primera vez |
| Cabina | `lib/football/pregame.js` | Bloque nuevo: dos intervenciones que nombran a los titulares que caben en 140 caracteres (nombre completo, nunca cortado) |
| Ficha del club | `lib/football/club-profile.js` + cliente | El `lineup` publica `name`, `number` y `slotIndex`; la ficha pinta la lista «Once titular · formación» |
| Registro editorial | `lib/football/club-news.js` | `lineups.js` declarado como módulo sin hechos nuevos de club (regla obligatoria de MonteCristo News) |

## 8. Resultados verificados

* `npm run test:unit`: **846/846** (seis pruebas nuevas de `tests/football-lineups.test.js`; antes eran 840).
* `tests/football-stadium-ui.test.js`: 118/119; el único fallo es previo y ajeno
  (`casino-hero.jpg` vs `.webp` en la galería de anuncios, ya fallaba en `7d8864b`).
* `eslint` limpio en los archivos tocados.
* e2e contra `FOOTBALL_ENABLED=1 PORT=3993 node server.js` (partido con compromiso
  V2, `m_2026-11_j19_b3_1`):

  ```
  sin identidad → false no_identity
  subscribe ok
   m_2026-11_j19_b3_1 · commitment · Borussia Dormund 4-3-3 vs Real Mandril 4-3-3
     home: 11 titulares, 7 suplentes, DT Iván Faro
     #1 Marek Moreno (GK) · #2 Fideo Jabón (DF) … #16 Zoran Bergström (FW)
  inexistente → false no_match
  ```

  Los 11 nombres publicados coinciden **uno por uno** con
  `match.simulation.inputs.{home,away}.lineup` (los `initialStatus:'active'`
  ordenados por `slotIndex`) del archivo de datos: la previa y el motor dicen lo
  mismo.

