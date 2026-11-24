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

---

## Regla obligatoria: ninguna actualización gasta recursos de más

**Todo cambio debe optimizarse para no consumir ancho de banda, CPU ni disco innecesarios.** El despliegue corre en Render con ancho de banda medido: cada byte difundido y cada reescritura de estado se pagan.

### Qué revisar antes de dar algo por terminado

1. **Difusión en sockets.** ¿Hace falta mandar el objeto entero a todo el lobby? Por defecto, **sí es una señal**: el mínimo que permita al cliente decidir si necesita pedir el estado (`{ season, jornada, closesAt, carry }` en lugar de un snapshot de 1 KB con ocho partidos). El cliente pide el detalle con su propio evento tipo `*_get` y **solo si el panel está abierto** y la señal cambió respecto de la anterior.
2. **Frecuencia × tamaño.** Un evento que se emite en cada barrido, en cada boleto o por partido multiplica el coste: mide `frecuencia × bytes` antes de decidir. Un payload de 1 KB a un lobby de 200 personas en cada boleto son 200 KB por evento.
3. **Escrituras periódicas.** Un barrido no debe reescribir el estado si no cambió nada. En archivo cada guardado reescribe la liga completa (~650 KB); en PostgreSQL reescribe filas de partidos y ligas. Comparar antes de guardar y agrupar por vuelta es lo normal, no una optimización opcional.
4. **Trabajo repetido por minuto.** Si algo corre cada 10 s, su coste se multiplica por 8.640 al día. Prefiere derivar de una fuente ya en memoria antes que recalcular o volver a serializar.
5. **Pruebas del coste.** Las mejoras de consumo se cubren con una prueba que falla si vuelve el despilfarro: número de guardados en un barrido sin trabajo, tamaño del payload difundido, número de consultas. Ejemplos: `tests/football-quiniela-service.test.js` («el barrido no reescribe la liga cuando no hay nada que liquidar») y `tests/football-sockets.test.js` (el aviso difundido no lleva el snapshot).

### Cómo medirlo antes de afirmarlo

```bash
# Tamaño de lo que se difunde
node -e "console.log(JSON.stringify(payload).length)"
# Escrituras por barrido (instrumenta _serializeLeague o el pool simulado)
# Consultas por vuelta: tests/football-store-pg.test.js usa un pool simulado que las cuenta
```

No se acepta «debería ser más rápido»: se mide antes y después, y el número queda en el PR.
