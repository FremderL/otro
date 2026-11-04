# Quiniela y traspasos: estado actual

## Traspasos y MonteCristo News

El mercado ejecuta ocho operaciones en dos ciclos de cuatro clubes, donde el
**Director Técnico (DT)** de cada club comprador solicita el fichaje según las
carencias tácticas de su plantilla (`lib/football/managers.js`). Se anuncia desde
el día 15 en horario de Ciudad de México y entra en vigor al generar la temporada
inmediatamente siguiente. Además, **MonteCristo News** (`lib/football/club-news.js`)
cubre durante toda la temporada los anuncios oficiales que afectan a clubes:
despidos de DT por mal rendimiento y contrataciones para la nueva temporada,
cambios tácticos de formación, banquillos bajo presión, campeón vigente, liderato,
carrera al Balón de Oro y pulso público de *Mi afición*.

> **Regla obligatoria**: Cualquier funcionalidad futura que afecte a clubes debe
> registrarse y anunciarse en MonteCristo News (`AGENTS.md` y
> `docs/montecristo-news-regla-clubes.md`).

### Noticiero diario y conferencia de prensa

El noticiero diario automático incluye el mercado desde el día 15 y sustituye las aperturas mensuales automáticas duplicadas. La conferencia bajo demanda permanece en Mercado. Detalles en `docs/montecristo-news-noticiero-diario.md`.

### Conferencia de prensa del mercado

La vista de mercado del Estadio es una conferencia de prensa: cada acuerdo se
presenta con los escudos de los dos clubes, la posición del jugador y su
**valoración de mercado** (`lib/football/player-value.js`). La cifra sale de los
atributos que ya deciden quién marca, asiste y defiende, más la posición, y es de
**solo lectura**: no mueve fichas, no altera cuotas, apuestas ni premios. Se
calcula al consultar (no se guarda), así que un cambio de criterio no obliga a
migrar datos, y el jugador conserva su valor al cambiar de club porque la
valoración es del jugador, no del escudo.

### Candidatos del Balón de Oro y traspasos

El mercado mueve mediocampistas, y los 16 candidatos del Balón de Oro son los
delanteros `ST`, así que un traspaso nunca deja a un candidato con el club
equivocado. Además, el orden de generación de temporada es
`buildSeasonClubs → applyTransfers → createBallonDorEvent`: la lista de candidatos
se elige de las plantillas **ya** traspasadas. `tests/football-player-value.test.js`
lo comprueba en la temporada siguiente: el traspasado no figura en su club de
origen, no aparece como candidato y cada tarjeta apunta al club donde el jugador
juega de verdad.

Pruebas: generación, fechas, no mutación, identidad, JSON, socket, interfaz,
valoraciones y candidatos tras los traspasos, y una prueba aislada que guarda y
recarga temporadas en PostgreSQL real. No se ha validado la concurrencia entre
varias instancias ni un despliegue real.

## Quiniela

Las reglas están implementadas como funciones sin efectos económicos: una
selección por cada uno de los ocho partidos, 50 fichas, una entrada por persona,
cierre al primer arranque, ocho aciertos para ganar, reparto entero, acumulación
cuando no hay ganadores y reembolso si un partido queda pospuesto sin resultado.
El acumulado anterior se conserva al cancelar.

La pantalla consulta la próxima jornada real, pero informa explícitamente que
no se aceptan inscripciones. Todavía no se conectan boletos, cartera, base de
datos, recuperación ni reset mensual; no es jugable. Esas reglas aisladas no
prueban ni realizan cobros o pagos.


El diario `lib/football/quiniela-pg.js` conserva boletos, movimientos, bote
y estados de jornada en PostgreSQL. Serializa operaciones entre procesos,
impide duplicados, liquida en orden, recupera respuestas perdidas y protege el
bote anterior al reembolsar. Se probó con PostgreSQL real y una cartera de
prueba transaccional aislada; **no usa todavía la cartera de la aplicación**.

Para conectarlo con seguridad hace falta que la cartera real confirme el
movimiento en la misma transacción y que las escrituras de perfiles y el reset
mensual no puedan sustituir el saldo confirmado con una copia de memoria.
También hay que leer resultados de partidos ya persistidos, ejecutar el barrido
de recuperación al arrancar y en cada liquidación, conectar la compra y el
recibo a Socket.IO/interfaz y ensayar caídas en todos esos puntos. Mientras eso
no esté resuelto, la inscripción permanece cerrada.
