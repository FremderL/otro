# Casa Montecristo · eventos de carrera, mercado libre y bolsa de clubes

Documento de diseño e implementación. Tres piezas que se sostienen entre sí:

1. **Carreras de jugadores**: novatos prometedores y retiros, como eventos reales.
2. **Lista de inactivos**: jugadores libres y DTs sin banquillo, para que los
   clubes no estén obligados a un cambio *entrada por salida*.
3. **Casa Montecristo**: bolsa de clubes cuyas acciones suben y bajan, y que
   fija **cuánto puede ofrecer** cada club por un jugador o un DT.

La regla de oro del proyecto se mantiene: **todo hecho de club se anuncia en
MonteCristo News** (`AGENTS.md`), con `id`, `type`, `priority`, `seasonMonth`,
`clubId`, `badge`, `headline`, `subtitle`, `summary` y `spoken`.

---

## 1. Por qué hacen falta las tres piezas juntas

Hoy el mercado funciona como una permutación cerrada: ocho clubes se pasan
jugadores en ciclo y cada uno vende exactamente lo que compra. Eso explica el
equilibrio de plantillas (288 jugadores siempre), pero tiene tres consecuencias
que chocan con la realidad:

- **No hay entrada ni salida del sistema**: nadie se retira y no hay cantera.
- **No se puede fichar sin vender**: el DT no puede reforzarse desde un fondo
  de agentes libres.
- **El dinero no existe**: el mercado no tiene presupuesto, así que un club
  "puede comprar" sin que nada lo justifique.

Las tres piezas resuelven una cada una, y la bolsa cierra el circuito
económico: **el valor del club en bolsa determina su presupuesto de fichajes**.

---

## 2. Carreras: novatos y retiros

### 2.1 Edad derivada, nunca almacenada

Los jugadores actuales no tienen edad, y añadir `age` a los 288 jugadores de
temporadas ya persistidas obligaría a migrar. La edad se **deriva**:

```
ageOf(player, seasonMonth) = 19 + (índiceDeTemporada(seasonMonth)
                                 - índiceDeTemporada(debutSeason(player))) % 19
```

- `debutSeason` sale de `hash32(id)` repartido entre las temporadas
  anteriores: determinista, idéntica en cada proceso y sin tocar el PRNG, así
  que **no se desplaza el stream de la semilla** y las temporadas fijas siguen
  dando exactamente los mismos partidos.
- La edad avanza una unidad por temporada y siempre cae en `[19, 37]`.

### 2.2 Retiros

Al generar una temporada nueva (`generateSeason` → `applyTransfers`):

- Un jugador con edad `>= 35` puede retirarse. La decisión es determinista
  (`hash32(`${id}|retiro|${seasonMonth}`)`) con probabilidad creciente por
  edad, y **acotada a 1–2 retiros por temporada en toda la liga**: un retiro es
  noticia, no una purga.
- El club cubre la baja con un **cantero** de su propia cantera: jugador nuevo,
  `id` propio (`<club>_y<nn>`), dorsal del retirado, posición del retirado y
  atributos `18–70` (promesa, no estrella). La plantilla sigue en 18 y los
  dorsales siguen siendo únicos.
- Se anuncia en MonteCristo News (`player_retirement`): quién se va, con qué
  legado verificado (partidos, goles, asistencias acumulados reales) y quién
  sube del filial.

### 2.3 El novato prometedor

"Cada cierta temporada" — no todas. La temporada con promesa se decide con
`hash32(`${seasonMonth}|promesa`)` y aparece aproximadamente **una de cada
dos**. Cuando toca:

- Se crea **un** juvenil excepcional (atributos `72–88`, edad 19) que entra en
  la **lista de inactivos** como agente libre, no en un club.
- Se publica **antes** del mercado, en la previa: `wonderkid_spotlight`.
- Los clubes pujan según su necesidad real (`diagnoseSquadNeed`) y su
  presupuesto (§4). El que gana lo ficha y **libera a un jugador al fondo**,
  que es quien paga la plaza. El resto del fondo no se toca.
- El fichaje se anuncia con el porqué: qué carencia cubre, cuántos puntos sube
  el once del club y a quién desplaza (`describeManagerSigning`).

Sin club que puje (temporada sin presupuesto suficiente) el chico **se queda en
el fondo** y puede ficharse más adelante: el evento no se fuerza.

---

## 3. Lista de inactivos

`league.freeAgents = { players: [...], coaches: [...] }`, persistida con la
liga (JSON y Postgres, ambos guardan el objeto completo de la temporada).

### 3.1 Jugadores libres

Entran al fondo al:
- ser **liberados** por un club que ficha (siempre entra uno por cada uno que
  sale del fondo: el fondo crece solo con bajas reales, nunca por generación),
- no ser firmados en el mercado del novato.

Salen del fondo cuando un club los ficha. Regla: **el fondo puede estar vacío;
nunca se rellena solo**. Un DT que necesita un portero y no encuentra recambio
en el fondo vuelve al intercambio con otro club (lo que ya existe).

### 3.2 DTs libres

`FREE_AGENT_COACHES` deja de ser una bolsa fija: pasa a ser el **estado
inicial** del fondo. Un DT despedido **vuelve al fondo** con su historial
(`sackedAfterSeason`, récord) en lugar de desaparecer. La contratación elige del
fondo con el mismo criterio actual (encaje de formación/estilo/necesidad) y se
anuncia como `coach_change` con el motivo.

Efecto práctico que pide el usuario: los banquillos ya no rotan entre los
mismos 16; un DT del fondo puede llegar a cualquier club y uno despedido puede
esperar su segunda oportunidad.

---

## 4. Casa Montecristo

### 4.1 Qué es

Una **casa de acciones de clubes**: cada uno de los 16 clubes cotiza con un
precio en fichas virtuales, y ese precio **sube y baja** con resultados
verificados. La casa tiene dos funciones:

1. **Deporte**: los usuarios compran y venden acciones de clubes con fichas.
2. **Económica**: el precio fija el **presupuesto de fichajes** del club, que es
   la razón por la que un club puede pagar por un jugador o por un DT.

### 4.2 El precio

Todo se calcula de datos ya verificados y deterministas (nada aleatorio, nada
privado):

```
valorDeportivo = 60 % posición en la tabla + 40 % Elo de la temporada
valorPlantilla = valor de los 18 jugadores del plantel (player-value.js)
forma          = puntos de las últimas 5 jornadas asentadas

precio = 100 × (0.45·valorDeportivo + 0.35·valorPlantilla + 0.20·forma)
```

Cada partido asentado mueve el precio: **no hay simulación de mercado**, el
precio es una lectura de la realidad deportiva, igual que la tabla o el Balón
de Oro. Por eso un club que ficha bien sube y puede pagar más; uno que pierde
baja y ficha peor. Es el bucle que el usuario quiere que exista.

Rango: `40–260` fichas por acción. Redondeo a 0,5.

### 4.3 El presupuesto

```
presupuesto = precioAcción × 100 × factorPrestigio
```

`factorPrestigio` va de `0.55` (recién ascendido/último) a `1.45` (campeón). El
presupuesto **limita la oferta**:

- Fichar jugador: se ofrece `playerValue × multiplicador`, con
  `multiplicador ∈ [0.9, 1.4]` según necesidad y urgencia del DT. Si la oferta
  supera el presupuesto disponible, el fichaje **no se hace** y la noticia lo
  dice (`incomingManager`/`transfer` con `blocked: 'presupuesto'`).
- Contratar DT: el costo del DT sale de su prestigio (títulos, temporadas,
  récord). Un club con el arco en crisis no puede pagar al mejor DT del fondo.

Consecuencia de diseño: **la Casa y el mercado no pueden desincronizarse**,
porque el mercado lee el mismo precio que ve el usuario.

### 4.4 Las acciones de los usuarios

- Compra: `acciones = floor(fichas / precio)`, mínimo 1 acción, débito real
  con `debit()` (todo o nada) y transacción explicada.
- Venta: crédito al precio actual, nunca al de compra.
- Posición en `profile.clubShares = { [clubId]: { shares, costoChips, updatedAt } }`,
  limpiada en `profile-store-shared.cleanProfile` (entero ≥ 0, 16 clubes como
  máximo, sin campos desconocidos).
- Límite por perfil: **200 acciones por club** y **600 en total**, para que la
  casa no se convierta en un casino paralelo al margen del resto.
- Sin comisiones ocultas ni apalancamiento. El histórico de precios viaja con
  la liga (`league.clubShares.history` por jornada) y es público.

### 4.5 Por qué esto justifica los fichajes

Antes: "un club compra a otro jugador" sin más. Ahora:

- El club A tiene precio 180 → presupuesto 18 000 fichas → puede ofrecer 34 M
  por un delantero de 27 M.
- El club B tiene precio 62 → presupuesto 6 200 → **no llega** a la oferta del
  club A y pierde el fichaje, aunque el jugador preferiría B.
- La noticia explica las dos cosas: por qué A puede pagar y por qué B no.

---

## 5. Superficie pública

| Capa | Pieza |
|---|---|
| Módulo | `lib/football/careers.js` (edades, retiros, cantera, promesa) |
| Módulo | `lib/football/free-agents.js` (fondo de jugadores y DTs) |
| Módulo | `lib/football/club-stock.js` (Casa Montecristo: precios, presupuesto, compra/venta) |
| Mercado | `lib/football/transfers.js` lee el fondo y el presupuesto |
| DT | `lib/football/managers.js` contrata del fondo y devuelve al fondo |
| Noticias | `club-news.js`: `player_retirement`, `youth_debut`, `wonderkid_spotlight`, `club_stock_move`, `transfer_signing` |
| Sockets | `football:careers_get`, `football:free_agents_get`, `football:club_shares_get`, `football:club_shares_trade` |
| UI | `public/estadio.js`: panel **Casa Montecristo** en la zona de afición |

### Eventos de noticia (registro obligatorio)

- `player_retirement` — se retira un jugador; legado verificado y cantero que sube.
- `youth_debut` — el cantero ocupa el dorsal y la posición del retirado.
- `wonderkid_spotlight` — aparece la promesa de la temporada en el fondo.
- `club_stock_move` — el club sube o baja en la Casa (solo movimientos ≥ 8 %).
- `transfer_signing` — fichaje con el porqué, ahora también desde el fondo y
  con el presupuesto como límite.

---

## 6. Invariantes que no se rompen

1. **288 jugadores únicos** en la liga; cada club con **18** y dorsales 1–18.
2. Identidad de jugador inmutable: quien se mueve conserva `name`, `attrs` y
   `pos` (`docs/estadio-plantillas-identidad.md`).
3. Determinismo total: misma semilla ⇒ mismos retiros, misma promesa, mismos
   precios. Nada de `Math.random()`.
4. Causalidad: una noticia nunca anuncia algo posterior a `asOf`.
5. El casino no se toca: la Casa usa `debit`/`credit` con las mismas garantías
   de idempotencia y las fichas siguen siendo virtuales.
6. Si falla cualquier pieza nueva, el mercado antiguo sigue funcionando: el
   fondo puede estar vacío y no se fuerza ningún evento.

---

## 7. Implementación (hecha)

1. **`careers.js`** — edad derivada, retiros y cantera. Integrado en
   `generateSeason` vía `careers-season.js`, después de los traspasos y antes
   del calendario (el calendario consume el PRNG; aquí no se toca ni un número).
2. **`free-agents.js`** — lista de inactivos. El mercado ficha de ahí
   (`planFreeAgentSignings`) y los DT despedidos vuelven al fondo con su último
   club (`coachesAfterSeason`).
3. **`club-stock.js`** — Casa Montecristo: precios, presupuesto y operaciones.
   `transfers.js` consulta `canAfford()` antes de cerrar un fichaje libre.
4. **Sockets** — `football:club_shares_get`, `football:club_shares_trade`,
   `football:free_agents_get`, `football:careers_get`.
5. **UI** — panel *Casa Montecristo* en la zona de afición de `estadio.html`,
   con parqué de los 16 clubes, cartera, lista de inactivos y carreras.

### Lo que se midió

| Comprobación | Resultado |
|---|---|
| Edades del plantel en la temporada ancla | 19–37, media **28,2** |
| Retiros por temporada | **0–2**, no en todas (10 de 24 temporadas en una muestra) |
| Plantillas tras retiros | **siempre 18**, dorsales 1–18 únicos |
| Precio de una acción | **89–138** fichas (banda 40–260) |
| Presupuesto de fichajes | **17 M el más pobre · 48 M el más rico** |
| Catálogo de jugadores | 7–31 M → el rico rompe el mercado, el pobre no llega |
| Fondo de jugadores | nace vacío y solo crece con bajas reales |
| DT en el fondo | **20** al inicio; un despedido vuelve con su último club |
| Suite | **840/840** en verde (incluye 14 de `casa-montecristo` y 4 de socket) |

### Decisiones que se tomaron al implementar

- **La edad es monótona y se satura en 37**, con retiro seguro a esa edad. Sin
  esto, un jugador "rejuvenecía" al pasar el techo de la banda.
- **Las carreras solo se juegan entre temporadas adyacentes.** Un salto de mes
  conserva plantillas y personas exactamente como estaban, igual que
  `retainPreviousSquads`.
- **Los fichajes libres se aplican antes del intercambio entre clubes**, porque
  sustituyen en su plaza a un suplente que no participa en él. Así los índices
  del intercambio siguen siendo válidos y nadie se mueve dos veces.
- **`_serializeLeague` debe incluir `freeAgents` y `careers`.** Fue el fallo más
  silencioso del desarrollo: sin esos campos el fondo se perdía en cada guardado
  y el jugador fichado se duplicaba.
- **El cupo de noticias de club subió de 8 a 12** para que las carreras y los
  movimientos de la Casa no desplacen la cobertura del Balón de Oro.
- **`club-shares.js` existe separado de `club-stock.js`** para que la
  normalización del perfil no arrastre el motor de plantillas al arranque ni
  cree un ciclo perfil → fútbol → perfil.
