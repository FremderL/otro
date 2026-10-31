# Estadio MonteCristo — por qué el marcador de un partido debe ser el mismo en todas partes

**Corrección de incidente · 31-oct-2026**

## Lo que reportó el jugador

- Apostó **500 fichas a Local (1X2)** en *Bayern Munchies vs Juventus de los Jubilados* (J30), cuota 2.05.
- El boleto se liquidó **ganado** con **1–0** a las 18:32.
- Al entrar al partido, la ficha mostraba **«0 · Final · 2»** para ese mismo partido.
- Lo mismo le ocurrió a **otro partido de la misma hora**.
- La **tabla** quedó con la victoria local (1–0).

## Qué estaba pasando

El diseño del Estadio dice que un partido **no se simula avanzando estado**: se genera completo en el
kickoff con un PRNG sembrado y luego se *revela* contra el reloj de pared
(`estadoVisible = f(seed, now)`). Para que eso sea cierto, `f` tiene que depender **solo del seed**.

No era así. La línea de tiempo se generaba con:

```js
generateTimeline(home, away, {
  leagueAvg: league.ctx.leagueAvg,   // ← cambia con cada resultado asentado
  homeAdv:   league.ctx.homeAdv,     // ← cambia con cada resultado asentado
  ...
}, mulberry32(match.seed));          // ← home.ratings / away.ratings también cambian
```

Los goles esperados (`λ = leagueAvg · att · def · homeAdv`) salen de los ratings de los clubes y del
contexto rodante de la liga, y **los tres se mueven cada vez que se asienta un partido**
(`updateAfterMatch` + `recomputeLeagueStats`). La línea de tiempo tampoco se persiste (§13.2): se
regenera desde el seed cuando hace falta.

Consecuencia: **el mismo seed producía otro partido** en cuanto la liga avanzaba. Los casos que lo
disparaban en producción:

| Disparador | Qué veía el jugador |
| --- | --- |
| Reinicio del proceso (deploy / caída) con el partido ya asentado | La ficha se pinta con `state.score`, que sale de una **regeneración nueva**: mostraba 0–2 mientras el resultado asentado seguía siendo 1–0 |
| Re-derivación por atasco (§15.4) o liquidación forzada | El marcador podía saltar a mitad del partido |

La ficha (`buildMatchState → deriveMatchState → state.score`) y el boleto/tabla (`match.result`) leían
fuentes distintas: la primera re-simulaba, la segunda leía lo asentado. De ahí el «1–0 ganada» en el
boleto y el «0–2» en la cancha, para dos partidos del mismo bloque (el mismo reinicio regeneró ambos
con los ratings ya movidos por las liquidaciones anteriores).

Había además un segundo defecto latente: `FootballEngine._settleResult` ponía `match.status =
'finished'` **antes** de llamar a `store.settleMatch`, y la guarda de idempotencia del store era
`if (match.status === 'settled') return { alreadySettled: true }`. Como el objeto es compartido, la
guarda quedaba desactivada: un segundo asentamiento (reconciliación de arranque con el partido
persistido como `finished`, o la palanca admin `/admin/estadio/matches/:id/settle`) **sobrescribía el
resultado, recalculaba la tabla y volvía a aplicar los ratings** — y las apuestas, ya liquidadas, se
quedaban pagadas con el marcador viejo.

## La corrección

1. **Insumos congelados por partido** (`match.generationInputs`, `lib/football-store-shared.js`).
   La primera vez que se genera la línea de tiempo (pre-generación 5 min antes del kickoff, kickoff o
   arranque tras una caída) se guarda una foto de `leagueAvg`, `homeAdv`, `rho` y los ratings de los
   dos clubes. Todas las generaciones posteriores —reinicio, re-derivación, forzado, admin— usan esa
   foto: `f(seed)` vuelve a ser una función.
   La reconciliación de arranque congela la foto de **todos** los partidos que ya empezaron **antes**
   de asentar ninguno, para que el primer resultado del bloque no mueva los ratings de los demás.

2. **El resultado asentado manda** (`lib/football/engine.js`).
   Si un partido ya tiene `match.result`, la línea de tiempo se genera **para ese marcador**
   (`forcedScore`) y sin volver a añadir prórroga. Esto repara también los partidos viejos, que no
   tienen foto congelada: la ficha, el marcador del campo, la tabla y el boleto dicen siempre lo mismo.

3. **Idempotencia real del asentado** (`lib/football-store.js`).
   La guarda ya no depende de `status`: si el partido tiene `result` o `settledAt`, la llamada devuelve
   `alreadySettled` y no toca resultado, tabla, ratings ni Balón de Oro.

4. **El motor paga con el marcador oficial** (`_settleResult`).
   Nunca marca `'finished'` antes de asentar; si el store responde `alreadySettled`, las apuestas se
   liquidan (idempotente por boleto) con **el marcador asentado**, no con la re-derivación del proceso.
   Cualquier discrepancia queda en el log como `football_score_divergence`.

5. **La ficha nunca pinta un marcador distinto** (`lib/football/sockets.js`).
   Para partidos `finished`/`settled`, `football:subscribe` y `football:state` envían `state.score` con
   el resultado asentado. La lista de la jornada (`public/estadio.js`) muestra por fin el marcador final
   de los partidos cerrados (antes leía `m.result.score`, una forma que el servidor no envía).

## Efecto sobre los datos existentes

- Los partidos ya asentados **no se tocan**: su resultado, la tabla y los pagos quedan como están (el
  boleto, la tabla y el pago ya eran coherentes entre sí; lo que estaba mal era la ficha).
- Al desplegar, la ficha de esos partidos pasa a mostrar el marcador asentado en lugar del
  re-simulado, sin migración ni reproceso.
- Los partidos en juego estrena foto de insumos en su primera generación posterior al despliegue y, a
  partir de ahí, su marcador ya no puede cambiar por más reinicios que haya.

## Pruebas

`tests/football-score-determinism.test.js` (incluida en `npm run test:unit`):

- el marcador derivado no cambia cuando los ratings se mueven después del kickoff;
- la foto de insumos se persiste y sobrevive a un reinicio;
- un bloque entero del mismo horario termina con la ficha igual al resultado asentado (el caso reportado);
- un partido antiguo sin foto se deriva con su marcador oficial;
- asentar dos veces no reescribe resultado, tabla ni ratings (aunque `status` sea `finished`);
- forzar el final de un partido asentado no lo vuelve a liquidar;
- las apuestas se pagan con el marcador asentado, no con una re-derivación.
