# Dirección Técnica (DT) y Regla Obligatoria de MonteCristo News

## 1. Funciones reales del Director Técnico (`lib/football/managers.js`)

Cada uno de los 16 clubes cuenta con un **Director Técnico (DT)** con identidad, estilo y perfil táctico propios (`preferredFormation`, `secondaryFormation`, `style`, `subProfile`, `marketFocus`). Sus cuatro funciones activas en el motor son:

1. **Elección del once titular (`scoreStarterForCoach` / `createTeamLineup`)**:
   - Evalúa a los **18 jugadores** del plantel (incluidos suplentes y fichajes con dorsales `12–18`) según su puesto natural, atributos individuales, estilo táctico del DT (`possession`, `pressing`, `direct`, `counter`, `balanced`), foco (`ataque`, `creacion`, `solidez`, `equilibrio`) y rendimiento goleador/asistidor.
2. **Cambios de formación entre jornadas y durante el partido (`resolveClubTactics` y `simulator.js`)**:
   - **Entre jornadas (causal)**: si en los últimos 3 partidos regulares asentados (`settledAt <= asOf`) el equipo entra en mala racha (pocos puntos, sequía goleadora o fragilidad defensiva), el DT cambia el dibujo titular a su formación alternativa (`4-3-3`, `4-4-2`, `4-2-3-1` o `3-5-2`) y adapta el estilo.
   - **En vivo (2.º tiempo en motor V2)**: según el marcador y el minuto, el DT puede modificar la formación sobre la marcha (pasar a dibujo ofensivo si va perdiendo o cerrar líneas con `4-2-3-1` / `3-5-2` si defiende ventaja mínima en el tramo final).
3. **Sustituciones tácticas de jugadores (`maybeSubstitute` en V2 y `planSubs` en V1)**:
   - Ajusta los minutos de ventana según su temperamento (`proactivo`, `equilibrado`, `conservador`) y urgencia del marcador.
   - Prioriza retirar jugadores amonestados con amarilla (riesgo de expulsión) o de menor aporte en la faceta requerida, dando entrada a delanteros/mediapuntas si busca remontar o defensores/mediocentros si protege resultado.
4. **Compras de jugadores en el mercado (`diagnoseSquadNeed` / `scoreTransferTarget` en `lib/football/transfers.js`)**:
   - En cada ventana de traspasos, el DT del club comprador diagnostica la línea más débil de su plantilla respecto a su formación y foco táctico, y elige al jugador objetivo respetando la integridad estructural de los planteles.
5. **Evaluación de rendimiento, despido y nueva contratación (`evaluateSeasonManagers` / `applyManagerChanges`)**:
   - Al cerrar una temporada con mal rendimiento verificado (`>= 5` partidos asentados y zona baja `14.º–16.º`, promedio `< 0,95 pts/PJ`, campaña sin victorias o déficit severo de goles), hasta 4 clubes despiden a su DT y contratan de forma determinista a un entrenador libre acorde a la carencia deportiva detectada, implantando su nueva formación para la nueva temporada.

---

## 2. Anuncios de clubes incluidos en MonteCristo News (`lib/football/club-news.js`)

Además de los 8 fichajes del mercado de traspasos (con mención al DT que solicitó cada compra), **MonteCristo News** transmite y publica:
- **`coach_change`**: Despido del DT saliente por mal rendimiento y contratación oficial del nuevo DT con su formación para la nueva temporada.
- **`season_champion`**: Coronación verificada del club campeón de la temporada previa (incluido si ganó en partido de desempate) y su impulso competitivo.
- **`tactical_shift`**: Cambio táctico de formación ordenado por un DT tras la racha reciente del club.
- **`coach_pressure`**: Alerta de banquillo en riesgo cuando un DT acumula malos resultados a mitad de temporada.
- **`season_leader`**: Liderato actual de la liga, puntos, goles y pizarra del puntero.
- **`prestige_alert`**: Clubes que inician temporada en operación revancha tras penalización de prestigio (`carryover` Elo).
- **`ballon_dor_spotlight`**: Club cuyo delantero encabeza la carrera al Balón de Oro o defiende el galardón vigente.
- **`fan_pulse`**: Club líder en respaldo agregado público de *Mi afición* (solo totales opt-in, sin datos personales).

---

## 3. Regla explícita para futuros desarrollos

> **REGLA OBLIGATORIA**: Cualquier cosa que se desarrolle en el futuro y que afecte a clubes DEBE incluirse en **MonteCristo News** (`lib/football/club-news.js` + `public/estadio.js`).

### Guardia automatizada (`tests/code-hygiene.test.js`)
La suite `tests/code-hygiene.test.js` verifica en cada ejecución de `npm test` que:
1. `AGENTS.md` y este documento mantengan vigente la regla explícita.
2. **Todos** los archivos `.js` de `lib/football/` estén clasificados explícitamente en `CLUB_IMPACT_REGISTRY` (si afectan a clubes, declarando sus tipos de anuncio en MonteCristo News) o en `NON_CLUB_NEWS_MODULES` (si son infraestructura pura sin impacto institucional en clubes).
3. Todo tipo listado en `CLUB_NEWS_TYPES` esté respaldado por al menos un módulo registrado en `CLUB_IMPACT_REGISTRY`.
