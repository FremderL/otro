# Reglas de Arquitectura y Desarrollo del Proyecto

## Regla obligatoria: Cobertura en MonteCristo News para todo cambio que afecte a clubes

**Cualquier funcionalidad, sistema o cambio que se desarrolle en el futuro y que afecte a los clubes del Estadio MonteCristo DEBE incluirse obligatoriamente en MonteCristo News.**

### Alcance de la regla
Aplica sin excepción a todo desarrollo que cree, modifique o exponga hechos relevantes de uno o varios clubes, incluyendo —pero sin limitarse a—:
- **Dirección técnica (DT)**: contrataciones, despidos por mal rendimiento, renovaciones, interinatos, sanciones o presión sobre el banquillo (`lib/football/managers.js`).
- **Pizarra y táctica**: cambios de formación, ajustes de estilo de juego o planes tácticos de temporada (`lib/football/managers.js`, `lib/football/match-state.js`).
- **Mercado y plantillas**: fichajes, ventas, préstamos, dorsales, ascensos de cantera, bajas, lesiones o suspensiones (`lib/football/transfers.js`, `lib/football/roster.js`, `lib/football/teams.js`).
- **Méritos deportivos y prestigio**: campeonatos, desempates por el título, rachas históricas, liderato, premios individuales ligados al club (como Balón de Oro) y ajustes de prestigio/Elo entre temporadas (`lib/football/ratings.js`, `lib/football/ballon-dor.js`).
- **Institución, estadio, finanzas o afición**: mejoras de estadio, patrocinios, tesorería/presupuesto de club, hitos públicos de *Mi afición* o cualquier otro evento institucional (`lib/football/fan-club.js`, `lib/football/club-profile.js`).

### Checklist obligatorio al desarrollar algo que afecte a clubes
1. **Registrar el módulo** en `CLUB_IMPACT_REGISTRY` dentro de `lib/football/club-news.js` indicando su dominio y los tipos de anuncio (`newsTypes`) que emite. *(Si un módulo nuevo de `lib/football/` es puramente técnico/infraestructura y no afecta a clubes, debe declararse justificadamente en `NON_CLUB_NEWS_MODULES`).*
2. **Emitir anuncios verificables y deterministas** en `buildClubNews(...)` (`lib/football/club-news.js`) con:
   - `id`, `type`, `priority`, `seasonMonth`, `clubId`, `clubName`, `badge`, `headline`, `subtitle`, `summary` y `spoken` (guion listo para locución de narrador/analista en español).
   - Respetar causalidad estricta (`settledAt <= asOf`, nunca filtrar hechos futuros ni datos privados de perfiles de usuario).
3. **Renderizar y narrar en MonteCristo News** (`public/estadio.js`): asegurar que el anuncio aparezca tanto en la transmisión audiovisual/subtitulada de **MonteCristo News** como en el tablero editorial de clubes.
4. **Cubrir con pruebas automatizadas**: añadir pruebas del nuevo anuncio y mantener en verde la auditoría automática de gobernanza en `tests/code-hygiene.test.js`.

Consulta el detalle técnico completo en `docs/montecristo-news-regla-clubes.md`.
