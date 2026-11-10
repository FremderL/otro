# Diseño de Recompensas de Clubes — MonteCristo

Este documento especifica la arquitectura funcional, económica y visual de recompensas para los **dos sistemas de clubes** de la plataforma:

1. **Estadio — *Mi Afición*** (`lib/football/fan-club.js`, `lib/football/fan-club-profile.js`, `lib/football/club-news.js`, `public/estadio.js`): lealtad deportiva **100 % cosmética y de prestigio** (`0` fichas virtuales).
2. **Casino / Comunidad — *Clubes Sociales*** (`lib/community.js`, `lib/club-missions.js`, `lib/profile-store-base.js`, `lib/community-http.js`, `public/app.js`): hermandades cooperativas con **misiones semanales**, **reparto equitativo de tesorería**, **podio mensual con trofeos permanentes** y **Salón de la Fama**.

---

## 1. Principios e invariantes de diseño

1. **Separación estricta entre prestigio deportivo y economía de fichas**
   - *Mi Afición* (Estadio) jamás otorga fichas, multiplicadores ni ventajas en apuestas o Fantasy (`docs/mi-aficion.md`).
   - Toda recompensa con impacto en fichas vive en los *Clubes Sociales* bajo las reglas contables de `BaseProfileStore` (enteros seguros, `Idempotency-Key`, bloqueo si hay mano activa `canMoveChips`, y tope `MAX_CLUB_MOVEMENT = 100000`).
2. **Cierre mensual limpio (`trophies_and_reset`)**
   - Al cambiar de mes en `CASINO_TIME_ZONE`, el saldo de tesorería de los clubes sociales determina el **Top 10 histórico** y acredita **trofeos permanentes de Oro, Plata y Bronce** a los 3 mejores clubes, reiniciando después todas las cuentas de tesorería a `0` para impedir trasvase de fichas entre temporadas.
3. **Causalidad verificable en el servidor**
   - En *Mi Afición*, tanto las victorias como los campeonatos de liga exigen liquidación oficial verificada (`settledAt <= asOf` y posterior a `joinedAt`).
   - En *Misiones Cooperativas*, solo cuentan rondas elegibles (`eligible === true`) jugadas por integrantes reales a partir de su ingreso al club (`at >= member.joinedAt`), y cada cuenta puede reclamar cada misión semanal como máximo una vez por semana ISO (`weekKey`), evitando el farmeo multicuentas o el salto entre clubes.
4. **Privacidad por defecto**
   - En *Mi Afición*, ningún perfil individual aparece en rankings ni en boletines de *MonteCristo News*; solo se agregan conteos de quienes activan `publicOptIn`.
   - En *Clubes Sociales*, los clubes con `visibility === 'private'` nunca exponen su nombre ni su saldo en `/api/social/v1/clubs/ranking` ni en el Salón de la Fama público.
5. **Cobertura obligatoria en *MonteCristo News***
   - Todo cambio que impacte a los clubes del Estadio declara sus categorías en `CLUB_IMPACT_REGISTRY` (`lib/football/club-news.js`) y emite boletines deterministas con locución en español (`spoken`).

---

## 2. Sistema A — Clubes del Estadio (*Mi Afición*)

### 2.1 Escalera de pines cosméticos (`PIN_IDS`)

Cada pin muestra el escudo oficial del club con un tratamiento visual progresivo (marco, insignia superpuesta y halo) visible en Casino, Estadio y Lotería:

| ID | Nivel | Requisito causal | Etiqueta | Distintivo visual |
| --- | :---: | --- | --- | --- |
| `club-pin` | 0 | Elegir club (`0` victorias) | Pin del club | Escudo limpio |
| `fan-1` | 1 | `1` victoria desde adhesión | Primera victoria | Borde bronce cálido + `•` |
| `fan-2` | 2 | `3` victorias desde adhesión | Tribuna fiel | Halo dorado + `✦` |
| `fan-3` | 3 | `5` victorias desde adhesión | Afición de leyenda | Halo doble ámbar + `★` |
| `fan-4` | 4 | `10` victorias desde adhesión | Guardián del escudo | Halo esmeralda/platino + `❖` |
| `fan-5` | 5 | `20` victorias desde adhesión | Patrimonio del club | Halo imperial + `♛` |
| `fan-champ` | Especial | `≥ 1` título oficial de liga desde adhesión | Estrella de campeón | Aureola dorada de campeón + `🏆` |

### 2.2 Títulos equipables de hincha (`TITLE_IDS`)

Además del pin gráfico, la afición desbloquea títulos textuales equipables de forma independiente (`equippedTitle`):

- `title-hincha` (`1` victoria): *«Grada de {Club}»*
- `title-fiel` (`3` victorias): *«Tribuna Fiel · {ABBR}»*
- `title-leyenda` (`5` victorias): *«Leyenda de {Club}»*
- `title-guardian` (`10` victorias): *«Guardián de {Club}»*
- `title-campeon` (`≥ 1` liga ganada desde adhesión): *«Campeón con {Club}»*

### 2.3 Reconocimiento de Campeón de Liga y celebración en vivo

- `fan-club.js` inspecciona las ligas cerradas cuya liquidación final ocurrió tras `fan.joinedAt` usando `officialPositions(league)`. Si el club apoyado finalizó en `1.º` puesto oficial, la temporada (`seasonMonth`) queda registrada de forma persistente en `profile.footballFanClub.championSeasons` (se conserva aunque la liga antigua salga de la ventana activa; se reinicia únicamente si la persona decide cambiar de club).
- En `public/estadio.js`, al recibir `football:status` con `code === 'full_time'`, el cliente refresca automáticamente `football:fan_state` y muestra una notificación de celebración si aumentaron las victorias o se desbloqueó un nuevo pin, título o campeonato.
- Presencia transversal:
  - **Casino**: asientos de mesa, perfil propio, modal social de mesa y chat del lobby (`publicFanPin`).
  - **Estadio**: insignia activa en cabecera (`#est-active-fan-pin` con nivel y título) y pin del club junto al nombre en la grada (`football:chat` y `football:reaction`).
  - **Lotería**: pin del club junto a cada participante en la lista de cartones activos (`lib/loteria/service.js` + `public/loteria.js`).

### 2.4 Cobertura en *MonteCristo News*

- `CLUB_IMPACT_REGISTRY['fan-club.js']` cubre `['fan_pulse', 'fan_milestone']`.
- `fan_pulse`: destaca a la hinchada con más victorias colectivas celebradas (`publicOptIn`).
- `fan_milestone`: anuncia hitos colectivos de lealtad cuando una afición pública alcanza umbrales emblemáticos de victorias acumuladas o celebra hinchas con rango de leyenda/campeón, manteniendo causalidad estricta (`asOf`) y cero datos personales.

---

## 3. Sistema B — Clubes Sociales (*Comunidad del Casino*)

### 3.1 Misiones cooperativas semanales (`lib/club-missions.js`)

Cada semana ISO (`weekKey` en `CASINO_TIME_ZONE`) todos los clubes sociales comparten 4 misiones cooperativas alimentadas automáticamente por `recordOutcome` (`eligible === true`, excluyendo bots y rondas sin apuesta):

| ID | Misión | Meta semanal colectiva | Premio personal por reclamar | Bono único al fondo del club |
| --- | --- | --- | :---: | :---: |
| `coop_rounds` | Mesa compartida | `15` rondas válidas en el club | `+150` fichas | `+200` fichas |
| `coop_wins` | Racha de hermandad | `8` victorias válidas en el club | `+200` fichas | `+300` fichas |
| `coop_variety` | Gira MonteCristo | `4` juegos distintos jugados | `+250` fichas | `+350` fichas |
| `coop_teamwork` | Círculo activo | `2+` integrantes activos y `6` rondas | `+200` fichas | `+250` fichas |

**Reglas antifarmeo y seguridad:**
- Solo suman rondas con `entry.at >= member.joinedAt` (entrar a un club a mitad de semana no inyecta rondas previas).
- Para reclamar la recompensa personal de una misión completada, la persona debe haber aportado **al menos 1 ronda válida** al club durante esa semana y no haber reclamado ya esa misma `missionId` en `profile.clubWeekly.claimed` (máximo 1 reclamo por misión y semana por cuenta, incluso si pertenece a hasta 3 clubes).
- El bono al fondo común (`treasuryReward`) se acredita **una sola vez por club, misión y semana** en `seasons.clubTreasury.missions`, quedando registrado en `movements` con `type: 'reward'`.
- Endpoint: `POST /api/social/v1/clubs/:clubId/missions/:missionId/claim` (requiere sesión, CSRF, `Idempotency-Key` y `canMoveChips(actor.id)`).

### 3.2 Tesorería mejorada: Reparto equitativo y aviso de cierre

- **Reparto equitativo (`POST /api/social/v1/clubs/:clubId/distribute-equal`)**:
  - Exclusivo para quien lidera el club (`ownerId === actor.id`).
  - Permite repartir un monto total (`amount`, hasta `MAX_CLUB_MOVEMENT` y `<= balance`) en partes enteras iguales (`perMember = Math.floor(amount / eligibleIds.length)`) entre integrantes disponibles (`canMoveChips(memberId)`).
  - El sobrante entero (`amount - perMember * eligibleIds.length`) permanece intacto en la tesorería del club: jamás se crean ni se destruyen fichas por redondeo.
  - Si algún integrante está sentado en una mesa activa, se le omite de forma segura informando `skippedCount` y repartiendo solo entre quienes pueden recibir fichas.
- **Aviso preventivo de cierre mensual**:
  - En los últimos 5 días del mes (`daysUntilSeasonClose <= 5`), la vista de tesorería advierte del reinicio mensual a `0` y recuerda cómo funciona la conversión a trofeos y el reparto previo.

### 3.3 Podio mensual, Trofeos permanentes y Salón de la Fama

- Al cerrarse el mes (`closeClubTreasurySeason` en `lib/profile-store-base.js`):
  1. Se conserva `history` (`top` hasta 10 clubes con `{ clubId, balance }`) para auditoría y Salón de la Fama.
  2. Los clubes elegibles en los puestos `1.º`, `2.º` y `3.º` suman un trofeo permanente en `seasons.clubTreasury.trophies[clubId]` (`gold`, `silver`, `bronze` + historial `honors`), que persiste entre temporadas igual que `history`.
  3. Cuando el servidor ejecuta `onAfterSeasonReset`, quienes integran los 3 mejores clubes públicos al cierre reciben además una insignia conmemorativa permanente en `profile.clubSeasonBadges`.
  4. Todas las cuentas `accounts` de `clubTreasury` pasan limpia y atómicamente a la nueva temporada con saldo `0`.
- En `GET /api/social/v1/clubs/ranking`:
  - Cada club del ranking incluye su vitrina `trophies` (`gold`, `silver`, `bronze`).
  - Se expone `hallOfFame`: las últimas temporadas cerradas filtradas estrictamente a clubes con `visibility === 'public'`, renderizadas en la pestaña **Ranking de clubes** junto a un podio visual destacado para el Top 3 activo.

---

## 4. Banners de Club, Campeón Vigente y Visibilidad en el Ranking del Mes

- **Estandarte oficial del club (`club-banner`)**:
  - Se desbloquea de inmediato al adherirse a cualquier club en *Mi afición*.
  - Combina el fondo panorámico `/assets/banners/club-banner-bg.jpg` con los colores oficiales primario/secundario del club y su escudo `/assets/escudos/<ABBR>.svg`.
- **Estandarte especial de Campeón Vigente (`champion-banner`, temporal)**:
  - Combina el fondo de gala `/assets/banners/champion-banner-bg.jpg` (laureles dorados y destellos de campeonato), emblema `♛ CAMPEÓN VIGENTE · <TEMPORADA>` y el escudo oficial del club.
  - **Regla de lealtad y vigencia temporal**: solo está desbloqueado y visible cuando `(a)` el club del jugador es el campeón oficial de la **última temporada de liga liquidada** (`reigningLeagueChampion`) **y** `(b)` la adhesión del jugador ocurrió antes o en el instante de liquidación de ese título (`fan.joinedAt <= reigning.settledAt`). En cuanto una nueva liga finaliza y corona a otro club, el banner de campeón vigente expira automáticamente en perfil, mesas y rankings.
- **Equipamiento y visualización**:
  - Se puede equipar o retirar tanto desde **Estadio → Mi afición** (`football:fan_equip` con `{ banner }`) como desde **Casino → Tu perfil** (`fan_banner_equip`).
  - Se muestra en la cabecera de **Tu perfil**, la tarjeta lateral de sala, la ficha pública de asiento en mesa (`table-profile-modal`) y en **🏅 Ranking del mes** (`#season-ranking`: fondo panorámico en la tarjeta del Líder #1 y distintivo de estandarte + pin en cada fila de la clasificación).

## 5. Ventana independiente de Preferencias y Controles de Teclado

- **Ventana propia (`#preferences-modal`)**:
  - Separada de `#profile-modal`, accesible desde la barra superior del lobby (`⚙`), la barra lateral de cada mesa (`⚙`), el acceso `Preferencias ↗` del perfil y la guía rápida de atajos (`?`).
- **Configuración de botones y teclado (`lib/keybindings.js`, `keybindings_update`)**:
  - Permite reasignar desde interfaz las 19 acciones de juego (empezar partida/nueva ronda, enfocar cantidad de apuesta, confirmar apuesta, **duplicar apuesta y confirmar al instante**, duplicar monto `×2`, pedir, plantarse, doblar, dividir, seguro, fold, pasar/igualar, escribir subida, confirmar subida, all-in, cambiar opción rápida, saltar animación y abrir chat) con intercambio automático ante teclas repetidas y botón de restablecimiento.
  - Los dígitos `0–9` quedan reservados para teclear directamente el monto de apuesta desde teclado en Blackjack, juegos rápidos y Póker, acompañados en mesa por los botones `⌨ Cantidad` y `⚡ ×2 y confirmar`.

