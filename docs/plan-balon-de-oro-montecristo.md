# Plan de principio a fin: Balón de Oro MonteCristo

**Estado:** **Fases 1–8 completadas con limitaciones de entorno documentadas. Fase 9: preparación local completada; piloto real y promoción global pendientes.** El ciclo mensual, las cuotas server-side, predicciones virtuales, liquidación/restitución idempotente, recuperación, inauguración y ceremonia final narradas, controles accesibles y archivo reproducible están integrados y pasaron la QA local. La configuración de release mantiene `FOOTBALL_ENABLED=off` y usa almacenamiento persistente; el ensayo determinista local valida un ciclo completo y su cancelación. No se ha desplegado ni iniciado un piloto real: falta un staging/servicio productivo y una instancia PostgreSQL real (`DATABASE_URL`) para la validación correspondiente. No activar el flag global hasta registrar una edición mensual real y conciliar el ledger.

**Decisiones aprobadas previamente:** ciclo mensual comprimido · un delantero `ST` existente por club · ganador por estadísticas · predicciones con fichas virtuales · fórmula estadística aprobada.

## Decisiones del producto ya cerradas

- **Un ciclo por temporada mensual** de la Liga MonteCristo: 30 jornadas regulares; el evento no se prolonga al siguiente mes.
- **16 candidatos:** un delantero `ST` ya existente por club. Se elige el de mayor `sho`; empate por mayor `pac` y, después, menor dorsal. El candidato queda fijo durante todo el ciclo; no se crea un jugador número 19.
- **Ganador estadístico:** no hay voto comunitario en el MVP. Gana el puntaje más alto después de Jornada 30 y una vez conocido el campeón oficial para aplicar la bonificación de club.
- **Alcance de las estadísticas individuales:** cuentan solo las jornadas regulares 1–30. El partido de desempate del campeonato decide quién recibe la bonificación de campeón, pero sus minutos, goles, asistencias y tarjetas no alteran el puntaje individual. Los goles de prórroga y tanda no cuentan. Un penal convertido durante una jornada regular sí cuenta como gol; no da asistencia.
- **Puntuación:** `5 × goles + 3 × asistencias + 1 × apariciones − 1 × amarillas − 3 × rojas + bonus de equipo`.
  - Aparición = participó al menos un minuto en un partido regular; cuenta una vez por partido, aunque sea suplente o lo expulsen después.
  - Se acredita gol únicamente al ID de goleador del evento `goal` o `penalty_scored`; asistencia solo si el evento regular trae un `assistId` válido.
  - Cada amarilla mostrada resta `1`. La segunda amarilla que causa expulsión suma una segunda amarilla (`−1`) y una sola roja (`−3`): total `−5` por esa expulsión; una roja directa resta `−3`.
  - Bonus **no acumulables** según la tabla final oficial: campeón `+5`, subcampeón `+3`, tercero o cuarto `+1`, resto `0`.
  - Desempate del premio: mayor puntaje total; más goles; más asistencias; menor penalización disciplinaria (`amarillas + 3 × rojas`); por último, menor clave estable `clubId:dorsal`. No se comparte el premio ni se sortea.
- **Predicción virtual:** un único boleto por perfil y ciclo, con una selección de candidato. Sin cambiarlo ni hacer cash-out después de confirmar; esto evita cubrir varios resultados y mantiene el MVP auditable. Boleto duplicado por reintento idempotente no vuelve a descontar fichas.
- **Límites de stake:** se reutiliza la validación común del Estadio: mínimo `10 %` y máximo `50 %` del saldo disponible (ajustado si el saldo es menor), tope absoluto `25 000` fichas y pago máximo `500 000`. Solo fichas virtuales; sin dinero real.
- **Cuotas:** mercado de 16 resultados excluyentes; el servidor estima probabilidades con 2 000 simulaciones sembradas de las jornadas restantes, estadísticas individuales y bonificación de equipo proyectada. Recalcula una vez al asentarse cada jornada hasta J20. Se publica con margen objetivo de `10 %`, cuota máxima `51.0` e invariante antiarbitraje; se muestra cuota y probabilidad implícita. La cuota queda congelada en el boleto al apostar; el cliente no envía ni decide cuota. Sin cash-out.
- **Cierre y resolución:** abre cuando el ciclo y los 16 candidatos quedan publicados el día 1; cierra al asentarse el último partido de la jornada 20. Tras J30 y, si hace falta, el desempate por el campeonato, se persiste el resultado y se liquida al anunciarlo a las 22:00 de Ciudad de México después del último partido. Si no se puede completar una temporada válida antes del cierre mensual, el evento se cancela y se devuelve el stake; el evento jamás retrasa el reset.

## Experiencia audiovisual congelada para el MVP

La inauguración reutiliza la identidad de la entrada al Estadio (túnel, luz dorada y tarjetas dinámicas) y dura unos **45 s**. La ceremonia final añade un escenario de podio propio y una secuencia de **13 pasos** guiada por clips, de aproximadamente **20–21 s** según la duración de los nombres; en ambas, captions y transcripción permiten entenderlo todo sin audio. La inauguración se abre automáticamente una vez por ciclo, incluso con llegada tardía; permite pausar/reanudar la primera vista, pero no repetirla después de completarla. La ceremonia final, a diferencia de la apertura, conserva pausa y replay, y se habilita con gesto únicamente desde el resultado persistido y verificado, después de las **10:00 p. m.** en `America/Mexico_City`. La narración es-MX y el fondo instrumental cinematográfico sutil son capas opcionales, controlables por separado.

**Límite de producción actual:** no hay generador nativo de video ni `ffmpeg` instalado; no se promete un MP4. Sí se puede producir voz sintética para líneas fijas e ilustraciones y programar movimiento de cámara simulado, transiciones, luces y tarjetas dinámicas con CSS/Canvas. Un MP4 aportado después podrá integrarse, pero no hace falta para el MVP.

Decisiones audiovisuales cerradas:

- La ceremonia usa una voz narradora en español de México, elegida mediante audición, con tono claro y cinematográfico. Los seis cues y los nombres se entregan como clips cortos; los subtítulos dinámicos reflejan los datos oficiales del ciclo. No se fija un género de voz como requisito.
- Los nombres de los 16 candidatos tienen clips es-MX pregrabados y se selecciona el correspondiente por `playerId` estable según el podio oficial; el club, puesto, puntos y estadísticas se insertan como texto/subtítulos desde el resultado del servidor. No se usa `SpeechSynthesis` para los nombres.
- Se reutilizan 16 avatares vectoriales de estilo editorial, uno por `playerId` estable, con colores del club; las mismas ilustraciones sirven para candidatos y podio en ciclos futuros, sin generar retratos nuevos cada temporada.
- La ceremonia final usa un fondo instrumental original, cinematográfico y sutil, independiente de la voz; se inicia con la ceremonia, se repite en bucle durante los clips y ofrece silencio independiente por pista. Si falla la narración, la secuencia continúa con captions, nombres y revelaciones visuales.
- La inauguración ofrece **pausar/reanudar**, **silenciar narración** y cerrar al terminar; no tiene replay ni botón de reinicio. La ceremonia final conserva sus controles de pausa/replay y silencio independiente de música/narración. Guion/subtítulos y `prefers-reduced-motion` permanecen disponibles en ambas.
- La inauguración se presenta automáticamente una vez por ciclo al entrar al espacio del evento, sin depender de la fecha; al completarse, no puede repetirse desde la interfaz. La ceremonia final abre por gesto y es una lectura/reproducción: no cambia el resultado ni invoca la liquidación.

## Fases, entregables y puertas de salida

No se inicia una fase siguiente hasta que pasen sus pruebas y se cierre su puerta. Esto evita construir assets o interfaces sobre reglas deportivas que todavía cambian.

### Fase 1 — Congelar reglas, calendario y guion **[COMPLETADA]**

Esta fase quedó cerrada con reglas de MVP concretas. Los límites de stake y la cuota siguen la convención del Estadio; se fija un solo boleto para que el evento sea una predicción real y no una cobertura de resultados. En la Fase 1 no se produjeron assets ni lógica funcional; el contrato y la selección determinista se implementaron después, en la Fase 2.

#### 1.1 Reglas deportivas congeladas

- Se conservan el candidato, fórmula, alcance de estadísticas y desempates documentados en **Decisiones del producto ya cerradas**.
- Solo cuentan J1–J30. Un partido extra decide el campeonato y la bonificación, pero no las estadísticas individuales. Un gol de penal en jornada regular sí es gol; una tanda no.
- Se usa el estado final oficial de la clasificación del Estadio para entregar `+5 / +3 / +1 / 0` por club. Ningún candidato puede ganar por voto.

#### 1.2 Calendario relativo al ciclo mensual

- **Día 1, America/Mexico_City:** la temporada y los 16 candidatos se publican; se abre el mercado. Al entrar al espacio dedicado del evento, la inauguración se abre una vez por ciclo sin comprobar el día actual.
- **Jornadas 1–20:** el mercado acepta una predicción por perfil. El marcador estadístico se actualiza al asentarse cada partido; cuotas y probabilidades se refrescan una vez cuando queda completa cada jornada.
- **Cierre de J20:** se bloquea el mercado al liquidarse sus ocho partidos, no al kickoff del último bloque. No se reabre.
- **Jornadas 21–30:** continúa el cálculo estadístico, sin nuevos boletos.
- **Cierre de temporada:** con J30 completo, se determina y persiste el campeón oficial (incluido desempate si aplica) y el puntaje final. El resultado público y la liquidación de los boletos se habilitan una sola vez a las **10:00 p. m. de Ciudad de México**, después del último partido; si el encuentro termina a esa hora o más tarde, se anuncia a las 10:00 p. m. del siguiente día local. El calendario del Estadio ya reserva el último día calendario para el cierre y ejecuta la salvaguarda antes del reset mensual.
- **Cancelación:** temporada truncada antes de J30, o imposibilidad de resolver el campeón oficial dentro de la ventana de cierre, cancela el premio y devuelve el stake completo. El Balón de Oro no pausa ni retrasa el reset de fichas.

#### 1.3 Mercado de predicción congelado

- Un único mercado `balon_de_oro` con exactamente 16 selecciones, identificadas por el ID persistente del candidato.
- Un boleto por perfil y ciclo; una vez confirmado no se puede cambiar, cancelar voluntariamente ni retirar por cash-out. Un reintento idempotente devuelve el boleto existente sin un segundo débito.
- Se reutiliza `validateStake` del Estadio: mínimo 10 % y máximo 50 % del saldo disponible, mínimo ajustado al saldo bajo, límite absoluto 25 000 y pago máximo 500 000 fichas.
- Probabilidades estimadas en el servidor con 2 000 simulaciones sembradas del calendario restante. Las simulaciones proyectan estadísticas individuales y posiciones de los clubes; al cerrar cada jornada se actualiza la estimación. El seed depende del ciclo y número de jornada para que el mismo estado produzca las mismas cuotas.
- Margen objetivo 10 %, cuota decimal máxima 51.0; el redondeo debe conservar el margen mínimo de los mercados del Estadio y evitar arbitraje. La interfaz muestra cuota, probabilidad implícita, stake y pago potencial. El servidor ignora cuotas recibidas desde el cliente y congela la cuota del boleto al aceptarlo.
- Boleto correcto: paga `floor(stake × cuota aceptada)`, sujeto al tope de pago. Incorrecto: stake perdido. Mercado cancelado: reembolso exacto del stake. Sin cash-out ni apuestas múltiples a otros candidatos.

#### 1.4 Storyboard y guion de inauguración (45 s objetivo)

| Tiempo | Imagen/acción | Locución fija |
| --- | --- | --- |
| 0–5 s | Túnel oscuro; avance de cámara hacia las luces del Estadio; sello dorado del evento. | “La Liga MonteCristo presenta una nueva carrera por el Balón de Oro.” |
| 5–11 s | Título y escudos/colores de los 16 clubes. | “Dieciséis clubes. Dieciséis delanteros. Un solo ganador.” |
| 11–29 s | Cuatro revelaciones consecutivas, cuatro candidatos por escena; cada tarjeta muestra nombre, club, dorsal y atributos iniciales. | “Un representante por club. Cada gol, cada asistencia y cada aparición suman. Las tarjetas restan; el rendimiento del equipo también puede inclinar la balanza.” |
| 29–38 s | Fórmula breve aparece en pantalla; animación de fichas virtuales y reloj hasta J20. | “Tus predicciones se juegan solo con fichas virtuales y cierran al terminar la jornada veinte.” |
| 38–45 s | Luces a pleno, CTA “Ver candidatos / Hacer mi predicción”. | “Observa a los candidatos. Elige tu pronóstico. Que comience la temporada.” |

Los nombres cambian por temporada: se muestran como texto/títulos dinámicos en las cuatro revelaciones; no se incrustan en la pista fija. El guion completo estará disponible como subtítulos/transcripción.

#### 1.5 Secuencia de ceremonia final (13 pasos, duración dinámica)

La ceremonia solo puede ejecutarse después de persistir y verificar el resultado oficial. Cada paso de audio avanza al terminar su clip; la revelación del puesto se produce cuando comienza el clip del nombre correspondiente, no por un temporizador absoluto. Los nombres se eligen por el `playerId` del ranking del servidor.

| Paso | Imagen/acción sincronizada | Audio / comportamiento |
| --- | --- | --- |
| 1/13 | Sello “Resultado oficial · verificado”; podio oculto. | Cue es-MX de verificación. |
| 2/13 | Introducción del tercer puesto, aún sin mostrar la persona. | Cue es-MX de tercer lugar. |
| 3/13 | Se revela el tercer lugar, su avatar, club y puntos. | Clip pregrabado del nombre asociado al `playerId` en tercer lugar. |
| 4/13 | Pausa breve; la tarjeta del tercer puesto permanece visible. | Pausa de 0,9 s. |
| 5/13 | Introducción del segundo puesto, aún oculto. | Cue es-MX de segundo lugar. |
| 6/13 | Se revela el segundo lugar, su avatar, club y puntos. | Clip pregrabado del nombre asociado al `playerId` en segundo lugar. |
| 7/13 | Pausa breve; ambos puestos se mantienen visibles. | Pausa de 0,9 s. |
| 8/13 | Los dos finalistas del podio están confirmados; el ganador sigue oculto. | Cue es-MX de finalistas. |
| 9/13 | Foco de escenario y expectativa por el ganador. | Cue es-MX de introducción del campeón. |
| 10/13 | Pausa antes del reveal; primer puesto aún oculto. | Pausa de 1,1 s. |
| 11/13 | Se revela el ganador, su avatar, club, puntos y desglose oficial. | Clip pregrabado del nombre asociado al `playerId` ganador. |
| 12/13 | Título de campeón y podio completo. | Cue es-MX de felicitación. |
| 13/13 | Cierre; podio y resultado permanecen visibles. | Pausa final de 2,2 s. |

Los seis cues y 16 clips de nombres son WAV locales; el mismo flujo ofrece captions y revelaciones de texto si la narración queda bloqueada. El tema instrumental dura 45 s y se reproduce en bucle bajo la locución, de modo que la ceremonia puede variar ligeramente con la duración real de cada nombre.

#### 1.6 Accesibilidad, interacción y límites de media

- La primera inauguración se muestra automáticamente en la página dedicada, también en una llegada tardía; no se puede saltar/cerrar hasta terminar. El audio puede quedar bloqueado por el navegador sin perder escenas/subtítulos. La ceremonia final, implementada en la Fase 7, abre por gesto después de la hora de anuncio.
- Subtítulos/transcripción, controles de pausa/reproducción/silencio y `prefers-reduced-motion`; si no hay audio, se muestra el mismo contenido en texto.
- Reutilizar el túnel/estética dorada de la animación de entrada existente. Los candidatos se presentan en tarjetas dinámicas con colores de sus clubes, no 16 retratos generados cada mes.
- La experiencia v1 será animación web, no video MP4. Cualquier pista de ambiente es opcional y no debe usar música sin licencia.

#### Cierre de fase

**Entregables completos:** fórmula y fuentes de eventos fijadas; desempates y bonificaciones definidos; ciclo y ventanas de apuesta cerrados; límites, cuotas, pago y cancelación definidos; dos storyboards, guiones, duraciones, captions y política audiovisual documentados.
**Puerta superada:** no queda una decisión de producto de Fase 1 pendiente. La selección de una voz concreta es producción de audio de Fase 6, no una regla abierta. La Fase 2 puede empezar sin volver a preguntar o reconstruir este trabajo.

### Fase 2 — Contrato de datos y candidatos **[COMPLETADA]**

**Implementado**
- `lib/football/ballon-dor.js` selecciona determinísticamente un `ST` por club: mayor `sho`, después `pac`, después dorsal menor. Rechaza plantillas que no sean de 16 clubes o no tengan candidato válido.
- Cada ciclo nuevo crea `league.ballonDor` con ID `bdo_AAAA-MM`; candidato con ID `bdo:AAAA-MM:clubId:playerId`. El snapshot conserva identidad y presentación (jugador, club, dorsal, colores y atributos de desempate), estadísticas iniciales en cero y desglose de puntos.
- Contrato versionado (`formulaVersion: 1`) con estados `scheduled → active → locked → settled` o `cancelled`; las transiciones inválidas, tiempo fuera de orden, cancelación sin motivo y resultado incompleto se rechazan. `getBallonDor()` y `transitionBallonDor()` permiten a las fases siguientes consultar y persistir el ciclo.
- El resultado final define candidato ganador, puntaje, fecha y ranking completo 1–16; se valida que el ganador esté en la lista, que ranks e IDs sean únicos y que el puntaje no aumente hacia abajo en la tabla.
- El evento se guarda dentro de la liga: archivo JSON en `leagues[]` y Postgres dentro de `football_leagues.data JSONB`. No se agrega tabla ni migración; se comparte la limpieza del contrato en ambos backends.
- Temporadas preexistentes sin `ballonDor` permanecen con `null`: no se crea un premio retroactivo ni se inicializa una temporada a mitad de ciclo.

**Pruebas/puerta superada**
- Selección de 16 candidatos, uno por club, atributos y orden deterministas incluso si cambia el orden de entrada; cobertura de desempates `sho`, `pac`, dorsal.
- Contrato y transiciones válidas/ inválidas, resultado, compatibilidad de `cleanLeague` y legado sin premio.
- Ida y vuelta JSON; snapshot y rehidratación Postgres con pool de prueba simulado; persistencia de una transición en `football_leagues.data`.
- Las pruebas dirigidas de Balón de Oro y stores pasaron al cerrar esta fase. Las estadísticas se añadieron en la Fase 3; el mercado y la automatización del ciclo se completaron en la Fase 4.

### Fase 3 — Acumular estadísticas de forma autoritativa **[COMPLETADA]**

**Implementado**
- `lib/football/ballon-dor-stats.js` extrae estadísticas de la timeline final y las alineaciones. Solo acepta jornadas regulares 1–30; omite partidos marcados como `desempate` y cualquier evento fuera de las mitades 1–2.
- Gol acreditado al `playerId` de `goal` o `penalty_scored`; asistencia solo si `assistId` pertenece a la misma plantilla, está activo y difiere del goleador en un `goal` regular. Un penal convertido no da asistencia.
- Deriva minutos desde titularidad, sustituciones y expulsiones hasta el silbatazo de tiempo regular. La aparición suma una vez si jugó al menos un minuto. `second_yellow` agrega una amarilla y una roja; `red_card` agrega solo roja.
- `FootballEngine._settleResult()` entrega al store el mismo resultado, timeline y lineup que usó el motor. `FootballStore.settleMatch()` valida que el marcador regular coincida con los eventos, calcula la nueva copia del evento antes de mutar y persiste partido + estadísticas + desglose de puntos con un único `saveNow()`. El early-return de un partido ya asentado impide duplicados tras replay/reinicio. Los asentados directos sin timeline usan una timeline determinista de fixture con el marcador recibido.
- `calculateBallonDorPoints()` mantiene el desglose auditable de cada término de la fórmula; `calculateBallonDorResult()` aplica el bonus oficial `+5 / +3 / +1 / 0` y ordena por puntaje, goles, asistencias, disciplina y clave estable `clubId:dorsal`.
- `finalizeBallonDorEvent()` calcula y valida el ranking completo; `FootballStore.finalizeBallonDor()` lo persiste solo si el evento está bloqueado, terminaron los 240 partidos regulares y cualquier partido marcado como desempate está asentado. No agrega automatización de calendario ni mercado, que pertenecen a Fase 4.
- La limpieza del contrato valida que cada desglose cuadre con las estadísticas y que el resultado coincida exactamente con el ranking/desempate. El agregado sigue dentro de `football_leagues.data JSONB` o del snapshot JSON y se guarda junto al asentado del partido.

**Pruebas/puerta superada**
- Fixtures cubren gol regular, asistencia válida/inválida, penal convertido sin asistencia, sustituciones, minutos, aparición, amarilla + segunda amarilla + roja, roja directa y exclusión de prórroga.
- Replay inmediato y tras rehidratar JSON no duplica; el test de Postgres con pool simulado verifica que el resultado del partido y las estadísticas del evento se escriben en el mismo snapshot/transaction.
- Se asentaron 240 partidos generados y se compararon los 16 agregados contra una reconstrucción independiente de la temporada; se verificó el cierre, bonus oficial y ranking final completo.

**Entregables**: agregador puro, actualización persistida y ranking final testeable.
**Puerta**: superada; reintentos no duplican estadísticas y la agregación coincide con la reconstrucción independiente.

### Fase 4 — Ciclo de evento, calendario y predicciones **[COMPLETADA]**

**Qué se hace**
- Crear el ciclo automáticamente al generar la liga del mes.
- Abrir predicciones el día 1 y cerrarlas después de la jornada 20. Actualizar cuotas como máximo al asentarse una jornada, nunca cada 500 ms.
- Validar en servidor mercado, candidato, stake, límite por perfil/ciclo, cuota e idempotency key. El cliente no decide la cuota.
- Persistir el ganador después de jornada 30 y cualquier operación de cierre; revelar el resultado y liquidar boletos a las 22:00, después del último partido. Al truncarse/cancelarse la liga, devolver stakes y registrar la razón.
- Atender el evento y sus futuros antes del reset mensual. Los créditos terminales que coincidan con el reset se recuperan después de reiniciar el saldo; un fallo del premio nunca bloquea el casino.

**Entregables completados**: ciclo de vida idempotente con barrido inicial y periódico; cierre automático J20; 2.000 simulaciones sembradas, margen objetivo del 10 %, cuota máxima 51.0 y protección antiarbitraje; apuesta única por perfil/ciclo con cuota congelada y clave idempotente; liquidación, reembolso exacto y recuperación tras reinicio. La cuota y la jornada del cliente se ignoran.
**Puerta superada**: 11 pruebas de mercado con reloj falso cubren apertura, actualización/cierre, J30, desempate, cancelación, carrera con J20, reset, reembolso exacto y créditos concurrentes con recuperación tras reinicio. También pasaron `npm run check`, `npm run test:unit` y `npm run test:integration`; Postgres se validó con pool simulado, no contra una base real.

### Fase 5 — Interfaz funcional del evento **[COMPLETADA]**

**Implementado**
- Puerta desde la navegación del Estadio y panel responsive del Balón de Oro con estado del ciclo y clasificación de los 16 candidatos: puntos, goles, asistencias, apariciones y tarjetas; cuotas y probabilidad implícita cuando están disponibles.
- Flujo de predicción virtual con saldo, límites comunes de stake, selección, cuota vigente, confirmación explícita, clave idempotente, recibo y actualización de la liquidación. El historial existente sigue siendo la fuente de verdad al volver o recargar.
- El panel informa el corte tras asentarse los ocho partidos de J20, explica los motivos de cancelación y comunica el reembolso exacto. No admite un segundo boleto ni cash-out.
- Carga inicial por HTTP, estado visible de Socket.IO y consulta HTTP periódica de respaldo cuando el socket falta o se desconecta. El mercado se vuelve a emitir tras cada partido asentado; el cliente ignora actualizaciones atrasadas.
- El respaldo `POST /api/estadio/ballon-dor/bet` exige mismo origen, perfil existente y aceptación de los Términos vigentes; la cuota y la jornada las determina el servidor. Una apuesta HTTP aceptada también actualiza el ranking combinado sin contar reintentos idempotentes dos veces.
- Estados accesibles de carga, ciclo vacío, error/reintento, corte y devolución; controles utilizables con teclado y sin depender de animaciones. Fichas exclusivamente virtuales.

**Pruebas/puerta superada**
- UI cubre apuesta y recibo, error/reintento con la misma clave, fallback sin Socket.IO, error de carga y reintento, cuota actualizada en vivo, cierre J20, estado liquidado y reembolso exacto; también verifica el gate de Términos y el ranking combinado con métricas personales.
- HTTP cubre origen, identidad estricta, Términos, cuota server-side, rechazo de mercado cerrado, idempotencia y notificación del ranking. Socket.IO verifica difusión del mercado tras cada `full_time`.
- Validación al cerrar la Fase 5: `npm run check` (0 errores, 5 warnings; sintaxis válida en 164 archivos), `npm run test:unit` (344/344), `npm run test:integration` (158/158) y `npm run test:football` (338/338). Las pruebas UI de Estadio pasaban 30/30 y HTTP + Socket.IO 52/52. Postgres se verificó con pool simulado, no contra una base real.

**Entregables**: flujo funcional sin animaciones obligatorias, con textos y estados vacíos/error completos.
**Puerta**: superada; las pruebas UI cubren apostar, error/reintento, actualización en vivo, cierre y devolución.

### Fase 6 — Inauguración y presentación de candidatos **[COMPLETADA]**

**Storyboard realizado**
1. El túnel existente del Estadio abre la escena con movimiento de cámara CSS, luz dorada y título del ciclo.
2. La narración presenta el premio, sus reglas y el cierre de predicciones.
3. Los 16 delanteros ST ya existentes se revelan individualmente; cada tarjeta se construye con identidad, club, dorsal, colores, atributos y estadísticas actuales del mercado.
4. Se conserva una explicación narrativa breve del ciclo, sin cuadros genéricos de valores `gol +5`, `asistencia +3` u otros términos de fórmula. La fórmula de puntos del mercado no cambia.
5. La escena final ofrece el CTA **Ver candidatos y hacer mi predicción**.

**Implementado**
- Audición y selección de una voz narradora femenina `es-MX`, tono de relato claro/cinematográfico. Se generó la pista fija `public/assets/ballon-dor-opening-es-mx.mp3` (44.54 s) con el guion definido; el texto idéntico está disponible como transcripción.
- Se reutiliza `public/assets/estadio-tunnel.jpg` —ya disponible— como fondo; CSS añade dolly, luces, transiciones y tarjetas dinámicas con colores de club. No se generan retratos por temporada.
- La página dedicada `/balon-de-oro` abre automáticamente la primera inauguración de cada ciclo, incluso con llegada tardía; la clave local distingue `started` de `completed`, de modo que una vista interrumpida se completa al volver. Tras completarla se ocultan los accesos de inicio/reproducción y no puede repetirse durante ese ciclo.
- Los subtítulos accesibles siguen el progreso del audio y la secuencia de 45 s muestra 16 tarjetas individuales —una por ST existente— con nombre, club/colores, dorsal, atributos y estadísticas del ciclo. Se quitaron las cajas de fórmula y no se cambió la fórmula subyacente.
- La primera presentación conserva controles de pausa/reanudación y silencio, pero cerrar, omitir o usar Escape queda bloqueado hasta terminar. Después solo se ofrecen cierre y CTA; el replay de la ceremonia final no cambia y es independiente. El guion completo y el foco accesible están disponibles.
- Si el navegador bloquea el audio automático, la inauguración continúa con subtítulos y movimiento compatible; se ofrece un gesto **Activar narración** para volver a intentar el audio. `prefers-reduced-motion` elimina el dolly y las entradas animadas.
- El Estadio general conserva una tarjeta de entrada al evento. La página `/balon-de-oro` oculta el lobby y las columnas ajenas, y concentra clasificación, predicción virtual, anuncio final y archivo. El aviso de cierre toma la fecha del último partido de J30 (o del desempate oficial si existe) y comunica **10:00 p. m., hora de Ciudad de México**, después de ese partido; la ceremonia final queda detallada en la Fase 7.

**Pruebas/puerta superada**
- UI verifica la página dedicada, el acceso desde Estadio, la apertura automática tardía por ciclo, el bloqueo de omitir/cerrar durante la primera vista, las 16 tarjetas individuales sin cajas de puntos, horario del anuncio, ausencia de replay de apertura tras completarse, replay separado de la ceremonia final, controles, fallback de audio y movimiento reducido.
- Validación final: `npm run check` (0 errores, 5 warnings preexistentes; sintaxis válida en 164 archivos), `npm run test:unit` (345/345), `npm run test:integration` (163/163), `npm run test:football` (344/344) y UI de Estadio (34/34). `git diff --check` pasó.

**Entregables**: inauguración narrada de una sola vista completada por ciclo dentro del espacio dedicado, con fondo reutilizado, tarjetas dinámicas por jugador, subtítulos/transcripción, aviso de cierre y controles accesibles.
**Puerta**: superada; la primera visita del ciclo se presenta automáticamente incluso si llega tarde, los 16 candidatos se identifican uno por uno y el anuncio se programa a las 22:00 de Ciudad de México después del último partido. La ceremonia final se completa en la Fase 7.

### Fase 7 — Ceremonia final y anuncio del ganador **[COMPLETADA]**

**Implementación**
- `BallonDorMarketService.getMarket()` parte del evento persistido y valida que los 16 puestos oficiales coincidan con candidatos y puntos. Antes del anuncio oculta el resultado y también las estadísticas/puntos finales que podrían revelar al ganador. La hora de anuncio queda a las **22:00 de Ciudad de México**, después de la finalización persistida del último partido; si el juego termina a las 22:00 o después, se mueve a las 22:00 del siguiente día local. En ese momento la UI vuelve a consultar al servidor.
- La liquidación de boletos y la acreditación de fichas se difieren hasta la hora oficial de anuncio; el historial personal conserva el boleto abierto antes de esa hora para no filtrar el ganador. El barrido posterior liquida y acredita de forma idempotente, incluso si el reset mensual ocurre antes del anuncio.
- `/api/estadio/ballon-dor?seasonMonth=YYYY-MM` lee el ciclo actual o uno histórico; `/api/estadio/ballon-dor/archive` publica el índice de ediciones. `getArchive()` se deriva de temporadas guardadas y no contiene `profileId`, IDs de boletos, selecciones personales ni saldos individuales. El detalle histórico sobrevive al reset y a recargas.
- La ceremonia verifica de nuevo `eventId`, ciclo, fecha, clasificación completa (rangos 1–16 sin duplicados), puntajes y ganador antes de permitir la reproducción. Usa exclusivamente `market.result`/`market.candidates` del servidor; no guarda resultados en `localStorage` ni acepta ranking aportado por el cliente.
- La ceremonia final usa una secuencia de 13 pasos guiada por eventos de audio, no por un cronómetro total. Los seis cues es-MX y 16 clips WAV de nombres se cargan por separado; el nombre de cada puesto se selecciona por `playerId` estable y su tarjeta/avatar se revela al comenzar el clip correspondiente. El fondo instrumental original, cinematográfico y sutil, dura 45 s, se reproduce en bucle a bajo volumen y puede silenciarse por separado de la narración; la secuencia completa puede pausarse y repetirse. La duración total es dinámica, aproximadamente 20–21 s.
- La capa de pagos solo lee un agregado server-side de predicciones/liquidación y fichas virtuales acreditadas, sin datos personales. Si la conciliación sigue pendiente, se indica con claridad; repetir, cerrar tarde o recargar nunca llama a liquidación ni acredita fichas.
- Captions/subtítulos dinámicos, transcripción final, foco y cierre accesibles, `prefers-reduced-motion` y fallback visual mantienen la ceremonia comprensible sin audio. Los avatares aparecen junto con cada reveal. El archivo enlaza a cada edición para repetirla en modo de solo lectura.

**Pruebas / puerta**
- Unitarias de mercado: resultado persistido verificado, puntos/estadísticas finales ocultos, pagos agregados, privacidad, archivo y ranking inconsistente o duplicado rechazado.
- Ciclo integral con reloj falso: resultado persistido antes del anuncio, boletos personales todavía abiertos y sin crédito antes de las 22:00; anuncio, liquidación/acreditación idempotente y agregado después de la hora.
- HTTP/Socket: consulta de mes archivado, validación del formato y proyección pública del archivo; la difusión se activa al anunciar, incluso si no hubo apuestas.
- UI: se bloquea el spoiler antes de las 22:00, también se ocultan estadísticas en la inauguración tardía, se vuelve a leer el resultado a la hora anunciada y cada avatar/puesto del podio se revela al iniciar su clip de nombre; el fallback sin audio mantiene la secuencia. El replay es de solo lectura y no llama a apuesta/liquidación.
- La misma edición puede abrirse tarde y repetirse después de un reset; el backend devuelve el resultado y pagos ya persistidos, sin operación de escritura desde la ceremonia.
- Validación de cierre: `npm run check` (0 errores, 5 warnings ya existentes; sintaxis válida en 164 archivos); `npm test` (unitarias 347/347 e integración 167/167); `npm run test:football` (350/350); suite dirigida de mercado/HTTP/Socket/UI (105/105); `git diff --check` sin errores. La vista de ceremonia se mantiene separada del QA visual integral de Fase 8.

**Entregables**: ceremonia final narrada con música original, reveal de podio/ganador, estadísticas y desglose, agregado de pagos y archivo histórico reproducible.
**Puerta**: superada; el resultado y los pagos solo proceden del servidor, coinciden en el archivo/replay y no se vuelven a aplicar al repetir.

### Fase 8 — QA, accesibilidad y estabilidad **[COMPLETADA · PostgreSQL real pendiente de infraestructura]**

**Cobertura y regresiones añadidas**
- La temporada determinista de 240 partidos se contrasta contra una reconstrucción independiente por jugador: los 16 candidatos, minutos, goles, asistencias, apariciones, tarjetas y desglose de puntos deben coincidir. Se comprueba el bonus de campeón, el cierre prematuro rechazado y que un replay de finalización no vuelva a puntuar.
- Se agregó un ciclo de recuperación que persiste el resultado y el boleto abierto, pasa el reset de noviembre a diciembre, reinicia stores JSON como tras una caída y acredita el boleto ganador a las 22:00 locales. Barridos posteriores no pagan dos veces. El gate de reset ignora los futuros BDO, conserva la protección de otras apuestas de fútbol y devuelve `null` si el servicio está apagado.
- La suite cubre tiendas JSON y PgFootballStore mediante pool simulado, rehidratación, idempotencia, cuotas server-side, límite de apuesta, boleto repetido, empate/desempate, mercado cerrado y temporada truncada con reembolso. Una petición de liquidación que incluye marcador inventado se ignora: el resultado procede del motor. La difusión pública no agrega IDs personales.
- UI verifica reconexión Socket.IO, bloqueo/reintento de cuotas, audio bloqueado para inauguración y ceremonia, silencio independiente de música/voz, captions/transcripción, pausa/reanudación de la inauguración sin replay, replay de la ceremonia y `prefers-reduced-motion`. En el browser de QA se revisó escritorio y móvil; la página no excede el ancho disponible.
- HTML/CSS prueba `loading="lazy"`, `decoding="async"` y dimensiones de las cinco miniaturas y la vista previa; los audios mantienen `preload="none"`. Las pruebas comprueban los 16 avatares, los seis cues y los clips de nombre por `playerId`; Socket.IO solo transmite datos y no URLs, bytes ni contenido de audio/video.

**Assets y carga medidos**
- La inauguración conserva su MP3 de `356.328` bytes. La ceremonia usa 16 clips de nombres (`1.834.382` bytes), seis cues (`1.015.446` bytes) y un tema instrumental WAV mono de 45 s (`1.984.544` bytes; 22,05 kHz). Las pistas mantienen `preload="none"` y se cargan durante la reproducción; el tema suave se repite en bucle. Los avatares SVG suman `45.665` bytes. El túnel existente mide `146.461` bytes.
- En Chromium headless se inspeccionaron capturas de la inauguración y ceremonia a `1365×900` y `390×844`, con movimiento reducido. No hubo desbordamiento horizontal; el bloqueo de audio mostró el fallback visual, mensaje de estado, captions y transcripción, sin impedir la secuencia.

**Checklist operativa de cierre**
1. Mantener `FOOTBALL_ENABLED=off` por defecto; con el flag apagado, las rutas del Estadio/Balón de Oro responden `404` y no se instala el gate de fútbol sobre el reset normal.
2. Antes de publicar cada ciclo, verificar 16 candidatos (uno por club), calendario completo y estado del mercado. No habilitar predicciones hasta tener la instantánea de cuotas calculada en el servidor.
3. Tras J30/desempate, comprobar que el resultado sigue oculto y los boletos abiertos hasta `resultAnnouncementAt`; el anuncio y la liquidación son a las 22:00 de `America/Mexico_City` según la última finalización real.
4. Vigilar `football_ballon_dor_announcement_available`, `football_ballon_dor_payouts_updated`, `football_ballon_dor_cancelled`, `football_ballon_dor_pre_reset_error` y `football_ballon_dor_post_reset_recovery`; reintentar barridos es seguro. Una temporada truncada devuelve el stake.
5. Confirmar que el audio de inauguración, el tema WAV, los seis cues y los 16 clips de nombres es-MX responden desde `public/assets/`; verificar `preload="none"`, captions, transcripción, movimiento reducido y reveal sincronizado por `playerId`.

**Validación final**
- `npm run check`: 0 errores, 5 warnings preexistentes; sintaxis válida en 165 archivos.
- `npm test`: 349/349 unitarias y 171/171 de integración.
- `npm run test:football`: 356/356; suite dirigida mercado/HTTP/Socket/UI: 111/111.
- QA visual headless desktop/móvil; parser CSS y carga de assets verificados; `git diff --check` sin errores.

**Limitación explícita**: no había `DATABASE_URL`, `psql` ni servidor PostgreSQL disponible. Las pruebas del store PG usan pool simulado y pasan; queda correr una comprobación contra una instancia PostgreSQL real cuando el entorno la proporcione. Esto no se presenta como validación de una base real.

**Entregables**: suites verdes, QA visual headless desktop/móvil y checklist de operación.
**Puerta**: el flag apagado conserva las rutas/comportamiento normales y el Balón de Oro no bloquea el reset; la apuesta pendiente sobrevive al reset y se recupera una sola vez después.

### Fase 9 — Lanzamiento gradual y cierre

**Preparación técnica local — completada**
- `render.yaml` mantiene `FOOTBALL_ENABLED=off` por defecto y `FOOTBALL_STORE_PATH=/var/data/football.json` dentro del disco persistente. El flag no se ha activado en producción.
- `lib/football/rollout-telemetry.js`, la ruta same-origin `/api/estadio/telemetry/audio` y `/healthz` exponen contadores agregados de sweeps y audio. La telemetría de audio acepta únicamente mes, pista y resultado; no registra identidad, selección, apuesta ni saldo. El logger productivo excluye eventos por boleto y omite importes de reembolsos/pagos en observabilidad; el ledger sigue privado y las notificaciones se envían por el socket del perfil dueño.
- `npm run test:football-release` reúne ensayo determinista de ciclo/cancelación, pruebas HTTP, telemetría, configuración del rollout y UI. El ensayo recorre 240 partidos, observa cierre J20, anuncio 22:00 `America/Mexico_City`, pago/reembolso idempotente y reset/apertura del siguiente mes. El barrido repetido ya no emite un segundo log `bet_refunded` cuando el reembolso ya se aplicó.
- La inauguración de cada ciclo mantiene su primera vista automática aunque se llegue tarde; tras completarla se elimina el inicio/replay y solo se permite cerrar. El replay de la ceremonia final permanece como lectura sin modificar el resultado ni los pagos.
- La revisión visual local usa `/balon-de-oro?seasonMonth=2026-09&demo=1`, con avisos visibles de datos sintéticos en la página, inauguración y ceremonia. El resultado es ficticio, vive en stores aislados de `/tmp` y no representa una edición real; `render.yaml` conserva `FOOTBALL_ENABLED=off`.
- Runbook y borrador de aviso: `docs/lanzamiento-balon-de-oro-montecristo.md`; plantilla reutilizable: `docs/plantilla-edicion-balon-de-oro.md`; reporte con mediciones, limitaciones y mejoras: `docs/informe-fase9-balon-de-oro.md`.
- Validación final: `npm run test:football-release` 77/77 (incluye UI; 42/42); `npm run check` sin errores (5 warnings preexistentes); `npm test` 357/357 unitarias y 174/174 de integración; `git diff --check` limpio.

**Pendiente para la puerta real — no simular como lanzamiento**
- [ ] Desplegar un staging aislado con almacenamiento persistente y dejarlo activo durante una edición mensual real; observar sweeps, errores, apuestas y audio.
- [ ] Ejecutar QA de UI/compatibilidad, suites completas y, cuando haya instancia disponible, validar PostgreSQL real y reconciliar ledger persistido.
- [ ] Confirmar que el cierre real se liquidó una sola vez o, si se canceló, cada stake se reembolsó una sola vez; verificar que el reset de fichas y la siguiente temporada no se retrasaron.
- [ ] Aprobar y publicar una fecha de piloto junto con reglas, política de fichas virtuales y duración audiovisual. El borrador no se publica y no promete una fecha hasta tener staging aprobado.
- [ ] Solo después del reporte y aprobación operativa, cambiar manualmente el flag para todos; no hay promoción automática.

**Evidencia local:** ensayo sintético noviembre de 2099: 240 partidos, 16 boletos, 33 sweeps, 0 errores, p95 192,356 ms y máximo 280,037 ms en la validación completa final; se validó pago único, reembolso idempotente y apertura del siguiente ciclo. Son tiempos del runner local, no un SLO productivo. No es un piloto real, no valida persistencia de hosting/PostgreSQL ni sustituye una edición observada con fichas virtuales de perfiles reales. En este entorno falta acceso/configuración del servicio de despliegue y una base PostgreSQL real; por eso el rollout queda apagado.

**Estado de la puerta final:** comportamiento aprobado por simulación local; promoción general **bloqueada** hasta confirmar el ciclo real de staging, el cierre/reembolso persistido y el reset mensual a tiempo.

## Riesgos que este orden evita

- **Cambiar fórmula después de producir escenas:** se congela en Fase 1.
- **Repetir stats al reintentar asentados:** se resuelve y prueba en Fase 3 antes de abrir predicciones.
- **Pagar dos veces o exponer cuotas manipulables:** mercado server-side y liquidación idempotente en Fase 4.
- **Spoilear al ganador antes del cierre:** la ceremonia solo lee resultado persistido, después de bloquear el mercado.
- **Accesibilidad audiovisual:** la inauguración dura 45 s y permite pausa/reanudación sin repetición; la ceremonia final dura aproximadamente 20–21 s, según el clip de nombre, y sí permite replay. Ambas ofrecen captions/transcripción y movimiento reducido; la música y la narración no son requisito para entender los datos.
- **Escalar costos de media:** el piloto usa imágenes estáticas animadas y audio comprimido, no streaming ni video por Socket.IO.
