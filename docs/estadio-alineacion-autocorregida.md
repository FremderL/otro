# Alineación autocorregida: un dato suelto no cuesta el partido

> Incidente que motiva este documento: el primer día del motor V2 un equipo no
> pudo alinear («once titular inválido») y su partido no se jugó. Al día
> siguiente ya no se recuperó: la tabla se quedó con un cruce de menos y las
> apuestas de ese partido se anularon. Con el motor V1 el mismo dato no impedía
> nada: el partido se jugaba igual y, tras días con el servidor apagado, al
> entrar todo aparecía jugado con sus resultados.

## Qué cambió

| | Motor V1 (`match-engine.js`) | Motor V2 antes de esta corrección |
| --- | --- | --- |
| Dorsal fuera de 1–11 | Se ignoraba | `once titular inválido` / `banquillo inválido` |
| Atributo ausente o corrupto | Se leía como `undefined` y el cálculo seguía | `once titular inválido` / `banquillo inválido` |
| Nombre vacío | Se usaba tal cual | `banquillo inválido` |
| Jugador duplicado | Pasaba | `jugadores duplicados entre equipos` |
| Resultado del primer fallo | Ninguno: se jugaba | El partido **no se prepara**, no arranca y no se asienta |

El V2 valida el once antes de comprometer la simulación
(`validateSnapshot` → `createMatch` → `makePlayers`/`makeBench`) porque un
compromiso guardado debe poder liquidarse después, aunque el proceso se reinicie.
La validación es correcta; el problema era **dónde fallaba**: un solo jugador
—incluido un suplente que no iba a jugar— invalidaba el partido entero.

## La corrección

`createTeamLineup` (`lib/football/match-state.js`) ahora construye el once sobre
una copia saneada de la plantilla (`cleanLineupPlayers`):

- **Atributos**: cada uno de los seis (`pac`, `sho`, `pas`, `def`, `gk`, `agr`)
  se toma del jugador; si falta, es texto o está fuera de rango, se usa el
  perfil medio de su posición (los mismos rangos con los que nace una plantilla).
- **Dorsal**: se acota a 1–99; si falta, se asigna la posición en la lista.
- **Nombre e ID**: vacíos o repetidos se completan sin descartar al futbolista.
- **Once**: sin DT se seguía prefiriendo a los dorsales 1–11; si un plantel corto
  o renumerado se quedaba sin candidatos, el hueco se cubría con el resto de la
  plantilla. La prioridad del dorsal **ordena, no excluye**.

Nada de esto inventa futbolistas: el once sale siempre de la plantilla
persistida, y la alineación sigue siendo determinista. Si de verdad no hay once
jugadores (plantilla de menos de 11), el partido **sí** falla cerrado en lugar de
simularse con jugadores ficticios.

Además, `engine.settleOverdueMatch` libera la marca de cuarentena del runtime
antes de asentar un vencido: un partido que quedó «en juego» y acumuló tres
errores ya no queda bloqueado para siempre; el barrido de vencidos lo asienta.

## Recuperación de lo ya perdido

No hace falta intervención manual: `engine.repairOverdueMatches` recorre todas
las temporadas cada minuto (y al arrancar) y, con el once ya saneado, reintenta
el mismo compromiso hasta asentarlo. El partido entra a la tabla con su PJ y su
marcador. Los boletos anulados cuando el motor pospuso el encuentro siguen
`void`: nadie cobra dos veces.

Si un cruce ya quedó **pospuesto por administración** (`by: 'admin'`) no se
recupera solo, porque es una decisión editorial; se devuelve al ciclo desde el
panel con `POST /admin/estadio/matches/:id/reopen`.

## Qué revisar en producción

1. `football_v2_prepare_error` con `message` de alineación: indica la plantilla
   concreta que estaba incompleta. Ya no bloquea, pero conviene corregir el dato.
2. `football_overdue_recovered` / `football_overdue_settled` para los cruces que
   se recuperan solos tras desplegar.
3. `football_overdue_recommit_blocked` sigue significando que hay obligaciones
   activas o un reembolso sin confirmar: ese caso no se resuelve solo.

## Pruebas

- `tests/football-teams.test.js`: la alineación se completa con la plantilla
  disponible (atributo ausente, dorsal 120, dorsal 0, sin DT, renumerado).
- `tests/football-v2-official.test.js`: un atributo corrupto en toda la plantilla
  no impide preparar ni jugar; un once imposible (6 jugadores) sigue fallando
  cerrado.
- `tests/football-overdue-repair.test.js`: un vencido con la plantilla
  incompleta se asienta, suma su PJ y no queda reintentando; un partido en
  cuarentena se recupera al vencer.
