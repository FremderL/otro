# MonteCristo News: noticiero diario automático

## Contrato de producto

- La primera apertura segura del Estadio en cada día del casino presenta **MonteCristo News**. La fecha se calcula en `America/Mexico_City` (`CASINO_TIME_ZONE`), no en UTC ni en la zona del navegador.
- El servidor prepara como máximo una edición por fecha: `daily:YYYY-MM-DD`. Todos los perfiles consultan esa misma edición. Una vez guardada no se regenera al recargar, cambiar de pestaña o volver a entrar.
- La presentación automática es por perfil y día. La marca durable vive en `profile.flags.montecristoNewsDaily`; una segunda capa local evita reaperturas en el mismo navegador. Ninguna sustituye a la autoridad del servidor.
- **Ver noticiero de hoy** permite repetición manual aunque ya se haya presentado. La conferencia mensual de fichajes sigue disponible en Estadio → Mercado.
- El día 15 el mercado anunciado tiene prioridad dentro del noticiero. Con el diario activo se desactivan las aperturas automáticas mensuales de mercado/clubes para no mostrar dos noticieros consecutivos.
- Es una **edición informativa**, no una señal en directo. La cartelera y la tabla son el corte del momento de preparación; el estado actual se consulta en el Estadio.

## Contenido y causalidad

`lib/football/daily-news.js` es un constructor puro. Consume la liga vigente, el archivo de temporadas, resultados asentados, `buildClubNews`, `evaluateSeasonManagers`, `publicTransfers` y el ranking público opt-in de Mi afición. No simula encuentros, no ejecuta fichajes, no mueve fichas y no paga premios.

La edición incluye hasta siete piezas y un guion acotado de narrador/analista:

1. Resultados oficiales de la jornada anterior, con hasta dos destacados y un resumen si hay más.
2. Tabla y liderazgo derivados de resultados asentados.
3. Anuncios de clubes con distinción entre novedad, confirmación, actualización y seguimiento.
4. Mercado anunciado desde el día 15, indicando la temporada en que entra en vigor.
5. Cartelera restante de la fecha; si no hay jornada, se explica que es día de cierre sin inventar partidos.

Un resultado distingue `scheduledKickoffAt` (jornada) de `settledAt` (incorporación al archivo). Los partidos `resultOnly` no reciben una crónica inventada. No se publican resultados futuros respecto a `cutoffAt`, semillas, compromisos privados ni datos personales de aficionados.

## Preparación, persistencia y recuperación

`daily-news-service.js` serializa la preparación. Antes de publicar exige:

- concesión de escritor activa, si el backend la utiliza;
- temporada vigente disponible;
- ausencia de deuda de resultados vencidos y de temporadas anteriores sin liquidar (`engine.editorialReadiness`).

Las posposiciones administrativas siguen siendo decisiones válidas y no se convierten en resultados ficticios. Si falta algo, el socket devuelve `preparing` y el cliente reintenta sin bloquear la entrada al Estadio.

El boot deportivo reconcilia y persiste resultados antes de preparar noticias. El barrido de temporada repite el mismo orden: reparar vencidos → asegurar calendario/temporada → preparar edición. No depende de que un timer hubiera estado encendido a medianoche.

### Servidor apagado muchos días

Al despertar no se crea una cola de noticieros atrasados. Se recupera primero el estado deportivo mediante la reconciliación existente y después se publica **una sola edición de regreso** de la fecha actual. Incluye el intervalo operativo cubierto, el número de resultados recuperados y una selección de hechos confirmados. No se inventan emisiones, campeones, mercados ni temporadas intermedias. La generación de temporadas sigue las reglas existentes de continuidad; un salto no contiguo conserva identidades sin fabricar traspasos históricos.

`operational.lastReadyDay/lastReadyAt` registra disponibilidad del servicio, no asistencia de un usuario. Una ausencia del aficionado no convierte el siguiente inicio en una edición de regreso.

### Almacenamiento

- JSON: `store.dailyNews` dentro de `football.json`, guardado atómico con `saveStrict()` antes de anunciar disponibilidad.
- PostgreSQL: tabla singleton `football_daily_news (id=1, data JSONB, updated_at)`, creada por el esquema inline existente; se carga con la foto deportiva y se escribe dentro de la misma transacción con writer fence.
- Archivo limitado a 45 ediciones. El sanitizador compartido rechaza fechas imposibles, guiones inválidos, exceso de piezas/tamaño y claves privadas.
- Si falla la persistencia, la edición no se publica y se reintenta. `/healthz` expone `football.dailyNews` con conteos, última fecha lista y fallos, sin contenido privado.

## Protocolo y múltiples pestañas

Handlers autenticados por la identidad ya establecida en `football:subscribe`:

- `football:daily_news_get`: prepara/reutiliza la edición y devuelve `day`, `edition`, `shouldOpen`, `reserved`.
- `football:daily_news_reserve`: solicita el derecho de apertura. Reserva durable de 30 segundos por perfil, día y socket. Otra pestaña recibe `granted:false`; una reserva abandonada expira.
- `football:daily_news_ack`: confirma al montar la pantalla, no al precargar ni al terminar el audio. Saltar la intro cuenta como presentación. La repetición manual no vuelve a confirmar.

Las operaciones de reserva/confirmación del mismo perfil pasan por la cola serial existente. Un fallo al persistir revierte la marca en memoria y devuelve `save_pending`. El servidor nunca acepta un `profileId` proporcionado por el cliente para estas operaciones.

## Presentación y accesibilidad

El diálogo tiene subtítulos por defecto, transcripción completa, progreso, pausa/reanudación, reinicio y salida. Las voces del navegador solo empiezan tras pulsar **Escuchar**; si fallan, continúan los subtítulos. Cambiar a una pestaña oculta pausa la emisión. Se cancelan locuciones y temporizadores al salir o desconectar.

La apertura automática espera a que no haya intro de entrada, TOS, inauguración/ceremonia BDO, hub, historial, boleta abierta ni partido en vivo. Un fallo del noticiero nunca impide usar el Estadio. El diálogo anuncia su título, contiene el foco, permite Escape y devuelve el foco al control de apertura.

## Configuración y reversión

`FOOTBALL_DAILY_NEWS_ENABLED=on` es el comportamiento nuevo (también es el valor por defecto si no se define). `off` desactiva preparación y handlers automáticos del diario y conserva la conferencia mensual anterior. `render.yaml` declara el flag explícitamente. No requiere borrar datos deportivos para volver atrás.

## Pruebas

- `tests/football-daily-news.test.js`: determinismo, causalidad, día local, mercado, regreso, límites, persistencia, reservas, fallos y barrido tras diez días.
- `tests/football-sockets.test.js`: identidad, dos pestañas, confirmación y supresión de apertura mensual duplicada.
- `tests/football-stadium-ui.test.js`: apertura automática, subtítulos, voz por gesto, pausa, reinicio, repetición, transcripción y no interrupción de un partido vivo.
- `tests/football-store-pg.test.js`: roundtrip JSONB y transacción.
- `tests/football-v2-boot.test.js`: servidor real tras diez días apagado; recuperación deportiva previa, una edición de regreso y ninguna cola.
- `tests/code-hygiene.test.js`: cobertura obligatoria de módulos que afectan a clubes.

Ejecutar `npm run check`, `npm run test:football` y la suite general antes de publicar.