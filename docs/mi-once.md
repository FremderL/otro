# Mi Once del Estadio

Mi Once es una clasificación cosmética, sin fichas ni premios de dinero. Cada
persona elige 11 futbolistas distintos en formación 1-4-4-2 (portero, defensas,
medios y delanteros de cualquier club). El equipo guardado entra en vigor en
la primera jornada aún no iniciada y se mantiene en las siguientes hasta el
próximo cambio. El cierre es el primer kickoff de la jornada; si hay jornadas
solapadas, el cambio nunca modifica una jornada ya iniciada.

Por partido de liga regular: 2 puntos por participar (incluso menos de un
minuto), 5 por gol, 3 por asistencia y −1 por roja. Se usan hechos asentados
provenientes de la alineación y timeline autoritativas del partido. Un partido
antiguo o manual sin fuente válida se muestra como sin datos y no produce puntos
inventados. Los desempates no cuentan.

Hay tres retos con pines de temporada visibles en Mi Once; no se acreditan al
saldo ni al inventario del Casino. El ranking es optativo y revocable; sus filas
solo contienen puesto y puntos, sin nombres ni identificadores. Se reinicia con
la temporada. El perfil conserva las alineaciones mediante el store existente y
las estadísticas por partido viajan con los resultados del Estadio.

En modo de sesiones verificadas se usa el perfil de la cookie. El modo legado
conserva el riesgo de suplantación y multicuentas documentado en seguridad.
El Estadio continúa protegido por `FOOTBALL_ENABLED`: un despliegue del código
no habilita por sí solo el Estadio si la variable sigue en `off`. Postgres se
ha probado con un pool simulado, no con una base real.
