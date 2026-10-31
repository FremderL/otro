# Plan incremental: motor de partidos y comentarios V2

**Estado al 31 de octubre de 2026:** el motor causal V2 y una ruta de apuestas están integrados para pruebas con compromisos preparados manualmente. **No existe todavía selección automática V2 para las nuevas jornadas de noviembre y no está listo para activarse oficialmente.** Los partidos sin compromiso V2 siguen usando V1; esto no satisface por sí solo el requisito del usuario. El objetivo pendiente es V2 oficial para simulación y apuestas sin sustituir compromisos existentes ni suspender las apuestas como solución. Véase el estado verificable al final del documento.

**Fecha de auditoría:** 2026-10-10.

**Alcance:** estudiar y planificar una evolución del generador de partidos y su relato, con etapas pequeñas, validación estadística y reversión segura.

> **Regla principal:** no borrar ni sustituir el motor actual en un solo cambio. El V1 sigue siendo la referencia y el respaldo hasta que un V2 aislado demuestre que cumple los invariantes de fútbol, determinismo y cuotas.

## 1. Decisión confirmada y recomendación ejecutiva

La dirección queda definida: **el marcador debe emerger de las jugadas**. El V2 no sortea un 2-1 para después buscar tres goles que lo ilustren; simula posesiones y acciones con causas físicas y futbolísticas, y el marcador resulta de los tiros que esas acciones producen.

La simulación completa se construye y valida de forma privada durante La Previa, se congela antes del kickoff y se **revela gradualmente** desde el inicio oficial. La precomputación no significa que el cliente reciba el resultado futuro: solo el servidor conserva el timeline completo; los espectadores reciben el prefijo permitido por el reloj.

Construir el V2 como módulo aislado y mantener V1 como respaldo. Al principio no se reescriben el scheduler, reloj, liquidación, apuestas, cuotas ni interfaz. Las cuotas sí tendrán que validarse contra la nueva distribución antes de apostar sobre partidos V2; no se debe mantener un modelo de precios que ya no representa los resultados.

Para limitar el riesgo, el primer corte cubre movimiento y decisiones básicas; corners y penales se añaden como transiciones causales antes de considerar el V2 completo. Quedan fuera inicialmente lesiones, fatiga avanzada, táctica adaptativa, prórroga y tanda. No es un simulador de física exhaustiva ni requiere calcular cada frame de pantalla en el servidor.

## 2. Auditoría del estado actual

### Lo que ya existe

- `lib/football/match-engine.js` genera una línea de tiempo completa y determinista desde un PRNG sembrado. El V1 calcula `expectedGoals`, sortea primero el marcador de una matriz Poisson/Dixon–Coles y después construye goles, tiros, penales, disciplina, cambios, balón parado y posesiones.
- `lib/football/match-state.js` normaliza transiciones y deriva el estado visible —jugadores, balón, posesión, marcador y otros datos— de los eventos ya ocurridos.
- `lib/football/engine.js` mantiene el reloj real/simulado, revela el prefijo permitido de la línea de tiempo, recupera partidos y liquida resultados. Es una frontera operativa valiosa y no conviene reescribirla junto al simulador.
- `lib/football/commentary.js` produce en servidor dos voces con plantillas deterministas, datos del evento, memoria anti-repetición y límite de 140 caracteres. Hay repertorios para 25 tipos de evento; nueve tipos son silenciosos por diseño.
- Las pruebas de motor cubren, entre otras cosas, la matriz de resultados, determinismo, eventos, estado derivado, goles, penales y desempate. Las de comentario cubren voces, repetición, placeholders y longitud.

### Diferencia funcional que guía el V2

El V1 protege una propiedad importante: el resultado final procede del mismo modelo Poisson/Dixon–Coles usado por las cuotas. Pero varias familias —tiros, posesiones y acciones a balón parado— se planifican con sorteos separados y luego se mezclan cronológicamente. El marcador no emerge de una secuencia de posesiones.

La dirección confirmada para V2 es cambiar esa causalidad: el PRNG podrá decidir resultados locales de acciones válidas (por ejemplo, si un pase cercano se completa o si un tiro termina en gol), pero **no** podrá teletransportar jugadores, escoger un córner sin que el balón salga por la línea ni añadir un gol para alcanzar un marcador sorteado previamente. La nueva distribución de marcadores tendrá que medirse y alinearse con las cuotas antes de usar dinero/apuestas reales.

### Riesgo de reproducibilidad a proteger

Los partidos guardan un `seed`, pero el objeto generado no registra hoy una versión del motor. Además, `_ensureTimeline()` reconstruye el partido usando ratings y contexto de la temporada disponibles al regenerarlo. Por lo tanto, antes de depender de un generador nuevo para partidos activos hay que verificar que puedan recuperarse **la versión y todas las entradas exactas** con las que se generó su línea de tiempo. Un seed por sí solo no identifica una simulación si cambia el código o alguno de sus datos de entrada.

También hay acoplamiento que el V2 debe evitar: el generador usa flujos aleatorios compartidos entre subsistemas; en particular, el comentario de los 90 minutos se crea antes de generar la prórroga. Un cambio en el consumo aleatorio del relato podría cambiar resultados posteriores del desempate. El V2 debe tener flujos independientes y estables para juego, alineaciones/estado visual y comentarios.

### Retrospectiva prudente de la rama/PR #18

Consulté el PR #18 (mergeado), que la persona usuaria identifica como un intento fallido. Su descripción promete pasos de animación de 700 ms, topes visuales de 8,5 m/s para jugadores y 28 m/s para el balón, y recorrido ordenado de los destinos del balón. El test añadido inyecta cinco eventos de pase con destinos prefijados y comprueba que el balón se vea continuo, respete el orden y no dé saltos.

Eso protege **la interpolación entre destinos**, pero no demuestra que los destinos sean una consecuencia posible de la jugada. La prueba añade cinco eventos sintéticos y mide el recorrido del balón; no pregunta si el receptor estaba cerca, si el pasador podía llegar a la posición declarada, si el defensor estaba al alcance, si el portero respetó su zona o si el evento narrado coincide con una salida real del balón. Una animación con límite de velocidad todavía puede llevar a todos suavemente hacia coordenadas lógicamente imposibles. Otros comentarios de esos tests elevan la espera de animación a 9,5–16 segundos porque los jugadores parten de posiciones base y un paso puede durar hasta seis segundos; eso también merece una prueba de sincronía/catch-up, aunque no demuestra por sí solo un fallo de producción.

El código actual deja ver causas más concretas de la desconexión que V2 debe eliminar:

- `planSetPieces()` sortea entre 2 y 8 corners por equipo y les asigna minutos; no espera a que un balón cruce la línea de fondo. `planPenalties()` también planea penales aparte de una falta dentro del área. Luego la decoración coloca el balón en la esquina o el punto penal, así que el evento y el comentario pueden tener el tipo correcto mientras la jugada que debía causarlos no existió.
- `planPossessionEvents()` sortea cambios de posesión separados de las disputas; después `match-state.js` selecciona un interceptor cercano. Es decir, identificar al más cercano después del sorteo no demuestra que ese jugador haya estado cerca o haya robado el balón.
- En `pass_sequence`, la distancia influye en el peso de selección, pero los compañeros lejanos no quedan estrictamente excluidos. Esto permite pases largos por la misma ruta lógica que un pase corto.
- `makePlayerStates()` recalcula posiciones desde `formationPosition()` en cada estado y luego puede reemplazarlas directamente con `actorPosition`, receptor o portero del último evento. `setBall()` calcula `ballVelocity` después de elegir el destino. Ninguna de esas operaciones, por sí sola, integra una trayectoria alcanzable del jugador/balón.

Son simplificaciones deliberadas del V1 que facilitan preconstruir eventos, no evidencia de mala intención. Pero explican por qué ponerle límites al tween no basta para cumplir la expectativa de lógica física.

**Conclusión honesta:** la arquitectura visible de #18 parece haber atacado sobre todo el síntoma de render (suavizar y limitar saltos entre destinos), no la generación causal de destinos. Esto es una explicación plausible de por qué no bastó, no una afirmación de que sea el único fallo que se observó: para cerrar la retrospectiva conviene que el usuario comparta el caso concreto —seed, minuto, video o jugada— si lo conserva. El V2 debe probar la lógica del motor y la presentación por separado.

### Cobertura estadística: diferencia entre especificación y pruebas actuales

La especificación `docs/estadio-montecristo.md` plantea calibraciones de 20.000 partidos para ciertas propiedades. En las pruebas actuales se encontró una prueba de 20.000 muestras del **muestreador Poisson**, pero las verificaciones del generador completo usan muestras más pequeñas (por ejemplo, 120 partidos para coherencia de marcador y 200 para error medio de xG). No se debe presentar la calibración de 20.000 partidos completos como algo ya demostrado: debe ser una puerta de aceptación futura, con tiempo de ejecución medido y alcance definido.

La última ejecución completa registrada antes de este estudio pasó **114 pruebas**. Esta es la línea base funcional que se debe conservar; la última comprobación también pasó `git diff --check`.

## 3. Límites y protecciones

### Incluido

1. Contrato de entrada/salida del generador, modelo de acciones y tipos de evento.
2. Determinismo, estado válido de jugadores y reconstrucción de marcador/estadísticas.
3. Generación de comentario ligada a hechos del evento y al estado ya ocurrido.
4. Calibración y comparación con el modelo que publica las cuotas.
5. Versionado, modo de prueba, integración gradual y reversión.

### Fuera del primer alcance

- Rediseñar canvas, relato visual, sockets o la página del Estadio.
- Reescribir `lib/football/engine.js`, scheduler, persistencia, apuestas, liquidación o el motor de cuotas.
- Cambiar ratings, nombres de clubes, calendario o reglas de temporada sin una decisión y una prueba separadas.
- Añadir lesiones, chat de espectadores, datos escritos por usuarios o un servicio de IA/LLM para redactar comentarios.
- Optimizar para muchas instancias o rehacer la infraestructura del servidor.

El texto de comentarios seguirá generándose **en el servidor**, con datos controlados del partido. No se enviarán mensajes diferentes a espectadores distintos ni se incorporará texto del chat al relato. Así se conservan auditabilidad, privacidad, latencia predecible y un resultado repetible.

## 4. Arquitectura propuesta

### V1: referencia intacta

Mantener `match-engine.js` y `commentary.js` como implementación V1. No hacer una refactorización grande para “preparar” el V2. Toda corrección urgente del V1 debe ir como cambio independiente, con su propia prueba, para no mezclarla con el experimento.

### V2: módulo aislado y adaptador pequeño

Propuesta inicial de ubicación: `lib/football/v2/`. Los nombres definitivos se deciden en la primera fase de implementación. Separar, como mínimo, estas responsabilidades:

- **Simulación:** consume entradas congeladas y genera eventos con su propia corriente aleatoria.
- **Estado/eventos:** valida transiciones y deriva el estado a partir del prefijo de eventos.
- **Comentario:** transforma eventos ya validados en mensajes; no modifica ni decide jugadas.
- **Adaptador:** expone el formato que el motor/orquestador actual ya consume. Al principio el adaptador se usa solo en pruebas.

Mantener una salida compatible con el contrato actual —por ejemplo, `timeline`, `score`, `stats`, `clock` y alineaciones cuando correspondan— reduce la superficie que habrá que integrar. Los campos nuevos deben ser aditivos o quedar encapsulados en el adaptador.

### Estado de mundo y reglas causales

El estado del V2 debe conservar las posiciones actuales, no reconstruirlas desde cero ante cada evento. La formación será una **referencia flexible** para ocupar espacios, no una orden de teletransporte. El campo puede conservar las coordenadas normalizadas que usa hoy la UI, pero la simulación debe convertirlas a metros (campo de referencia de 105 × 68 m) cuando calcule distancia, velocidad y tiempo.

Reglas iniciales que se convierten en invariantes, no en probabilidades libres:

- **Movimiento y activación:** cada jugador conserva posición, velocidad y estado. Los que están lejos del balón permanecen casi fijos y no calculan decisiones complejas hasta que la jugada pueda afectarlos. Se activan por proximidad/tiempo de llegada, porque la trayectoria prevista del balón/pase cruza su zona o porque son una opción cercana de apoyo/cobertura; no por un sorteo. El grupo activo incluye, cuando la jugada lo permite, un apoyo ofensivo alcanzable y los defensores que sí pueden presionar; así el equipo no se queda inmóvil, pero cada carrera responde a una jugada. Usar umbrales de activación y desactivación con histéresis para que no “parpadeen” entre modos. Al activarse, parten de su posición guardada y se mueven con límite de velocidad/tiempo; nunca se recolocan de golpe. Una pausa permite recolocarse solo si hay tiempo suficiente. Los jugadores se mantienen razonablemente cerca de su zona/rol; los límites del portero son más estrictos.
- **Pase:** inicialmente elegir entre compañeros elegibles y cercanos, con línea/espacio razonables. El balón viaja del pie del pasador al destino con una trayectoria y tiempo de viaje. El receptor no controla el balón antes de alcanzarlo; un defensor solo intercepta si puede llegar al balón o cruzar su trayectoria.
- **Conducción:** el portador avanza el balón en pasos cortos y alcanzables. Puede desviarse de su zona cuando el juego lo justifique, pero no correr una cancha completa por un solo sorteo; en el primer alcance el portero no conduce fuera de su zona.
- **Robo:** solo un rival con proximidad y tiempo para disputar el balón puede intentar quitarlo. Atributos y azar resuelven el duelo, no la distancia ni quién está en posesión.
- **Tiro:** la decisión depende de distancia, ángulo, presión y perfil del jugador. La ocasión y el tiro generan xG; el resultado del tiro —gol, atajada, poste o fuera— modifica el score únicamente si se valida el evento correspondiente.
- **Portero:** parte y se recupera hacia una zona de portería; ataja un balón alcanzable según posición/tiempo/atributos. Un despeje tras controlar el balón apunta a un compañero o a una zona legal y el balón la recorre; no cambia de lado instantáneamente.
- **Córner/penal:** el córner nace de un balón que cruza la línea de fondo con último toque del defensor (si no es gol). El penal nace de una falta validada dentro del área. La adjudicación, la ejecución, el tiro y el comentario son una misma secuencia con identificadores relacionados. No se sortean corners o penales independientes del juego.

Los pases largos, centros aéreos, rebotes complejos, fuera de juego, lesiones y tácticas adaptativas pueden tener reglas explícitas más adelante; no se simulan con atajos que rompan estos invariantes.

### Construcción durante La Previa y publicación

1. Antes de abrir el mercado, congelar la versión del motor y las entradas que los apostadores pueden conocer: equipos, alineaciones/tácticas, ratings y parámetros. Si esos datos cambian después, cancelar/reembolsar según regla explícita y reabrir con precios nuevos; no cambiar el modelo a escondidas.
2. Calcular las cuotas usando la distribución del motor V2 calibrado, no un resultado individual ya seleccionado. Mantener el mercado abierto durante la parte acordada de La Previa.
3. Al cerrar apuestas y antes del kickoff, generar una semilla secreta con un CSPRNG y persistirla. Generar en privado el timeline completo y validar cronología, movimiento, participantes, reglas, marcador, estadísticas y correspondencia de comentarios. La semilla debe ser posterior al cierre para que el sistema no conozca el resultado exacto mientras recibe apuestas.
4. Si pasa, guardar un compromiso verificable (hash de versión + snapshot de entradas + seed/timeline) antes de iniciar. La ventana entre cierre y kickoff se fija midiendo p95 de generación/validación más margen operativo; si no alcanza, retrasar el kickoff de forma visible, no revelar a medias.
5. Al kickoff, revelar solo eventos cuyo tiempo ya llegó. Nunca enviar el timeline completo al navegador, ni siquiera porque ya esté precalculado.
6. Si la validación estructural falla, no buscar seeds nuevos hasta obtener un partido “más bonito”. Anular/reembolsar y corregir el motor en un partido futuro. Si se requiere corregir alineaciones o datos después de abrir el mercado, aplicar también la política de cancelación/reapertura; no rehacer el resultado con apuestas vivas.

#### Qué se considera fallo y qué mensaje recibe el usuario

- **No son fallos:** marcador 0-0, pocos goles, marcador desigual o una varianza normal del modelo. Se valida el proceso, no si el resultado “gustó”.
- **Fallo duro:** posición/velocidad imposible, evento sin causa, participante inválido, timeline que no termina, diferencia entre goles y marcador, o tiempo de preparación agotado. Bloquea kickoff y activa la política de reembolso; jamás se publica un partido inválido.
- **Aviso de calidad:** jugada poco emocionante, apoyo que se movió poco o frase mejorable. Se registra para pruebas y ajustes futuros; no se usa para anular un marcador válido ni para volver a sortear.
- **Mensaje público:** avisar que el inicio se retrasa, indicar la nueva hora/reembolso y usar una explicación breve del universo del Estadio (por ejemplo, revisión del terreno, clima o traslado). El log interno conserva el motivo técnico real. Si el clima/traslado no es una causa simulada real, usar un texto neutral de “revisión previa” y no repetir una excusa ficticia como si fuera un hecho.
- **Evitar retrasos en serie:** antes de producción, cero fallos duros en el corpus de estrés acordado. Durante el piloto, fijar de antemano un umbral de corte; al superarlo —o ante una violación grave— el circuit breaker desactiva V2 para los siguientes partidos. Los próximos partidos pueden volver a V1 solo antes de abrir apuestas y con sus cuotas correctas. Un partido V2 ya apostado no se convierte silenciosamente a V1: se anula/reembolsa o se retrasa una vez bajo la regla publicada. No se reintenta el mismo partido indefinidamente.

### Reproducibilidad versionada

Antes de permitir V2 en partidos con apuestas:

1. Asignar a cada partido una versión de simulación explícita (`v1` o `v2`) y no cambiarla después de iniciado el partido ni después de abrir el mercado.
2. Congelar o poder reconstruir todas las entradas relevantes: ratings, tácticas, atributos/alineación, contexto de liga y parámetros del modelo. Puede ser una instantánea o una referencia inmutable versionada más un hash verificable; decidirlo tras auditar el store.
3. Para partidos con apuestas, generar el seed de resultado con CSPRNG después del cierre del mercado y persistirlo de forma privada. No reutilizar sin revisión el hash determinista del calendario del V1: al derivarse de identificadores, podría hacer predecible el resultado si también se conocen las entradas. Derivar luego streams estables por subsistema desde ese seed, versión y nombre del subsistema.
4. Añadir una plantilla de comentario no debe cambiar el marcador, y añadir una acción visual no debe cambiar la probabilidad de gol. Si una versión o entrada necesaria no está disponible, no simular silenciosamente con el código actual: fallar de forma segura y aplicar la política operativa definida.

Los partidos existentes continúan en V1. La selección de versión solo se habilita para partidos futuros y de prueba, con una ruta clara de vuelta a V1 antes de que un V2 tenga partidos reales.

## 5. Fases de trabajo y puertas de aceptación

Cada fase debe ser un cambio pequeño y revisable. Una fase no aprobada no bloquea el sitio: se conserva V1 y se corrige o se pausa el V2.

### Fase 0 — Cerrar objetivos, reproducir #18 y medir la línea base

**Trabajo:**

- Elegir 10–20 seeds representativos del V1 y registrar marcador, tiros, xG, posesión, corners, faltas, tarjetas, cambios, número de eventos, comentarios y tiempo de generación. Incluir explícitamente un 0-0 y verificar que se acepta como resultado válido.
- Reproducir el fallo observado en #18 si se conserva un seed/video. Si no, construir casos de prueba que expongan explícitamente los riesgos: pase a un compañero lejano, receptor aún sin alcanzar el balón, rival lejos que roba, portero desplazado, jugador cruzando media cancha en un evento, balón demasiado veloz y comentario de córner sin balón fuera.
- Revisar en pareja eventos, posiciones y relato; anotar **qué hecho lo dispara**, no solo “se ve raro”. Guardar los casos como fixtures pequeños, no snapshots gigantes.
- Auditar qué entradas del partido pueden cambiar durante una recuperación tras reinicio y cuándo se abren los mercados.

**Aceptar cuando:** existe un informe corto con baseline, la causa exacta de los fallos confirmados y no más de tres prioridades del primer corte. La explicación de PR #18 queda marcada como hipótesis hasta reproducir el caso real.

### Fase 1 — Contratos de estado, versión y validador

**Trabajo:**

- Definir estado autoritativo: reloj simulado, balón (posición/velocidad/control), posesión, marcador, fase, alineación y posición/velocidad/estado de cada jugador.
- Definir eventos y secuencias causales (`pass` → `ball_in_flight` → `reception` o `interception`; `shot` → `goal`/`save`/`out`; `foul` dentro del área → `penalty_awarded`). No convertir comentarios o animaciones en fuente de verdad.
- Especificar distancias en unidades coherentes, topes de movimiento/velocidad, radios de control/intercepción, zonas de rol, reglas de salida por líneas y terminación segura. Calibrar números después; no inventar cifras porque “parecen realistas”.
- Crear un validador puro para orden temporal, trayectorias alcanzables, participantes activos, reglas de reinicio, score y estadísticas reconstruibles.
- Definir versión e inputs congelados sin activar V2 en producción.

**Aceptar cuando:** hay contrato legible, fixtures inválidos que el validador rechaza, casos positivos de V1 conservados, un 0-0 que pasa sin excepción, y una estrategia documentada para recuperar exactamente las entradas. El resultado numérico no es criterio de rechazo.

### Fase 2 — Prototipo de movimiento y posesión, aislado

**Trabajo:**

- Crear el estado inicial natural: jugadores en formación, saque de centro y balón bajo control del ejecutor.
- Conservar posiciones entre decisiones. Mover hacia objetivos cercanos con velocidad/tiempo limitados; la formación define zonas de referencia. Al acercarse el balón, activar apoyos ofensivos y coberturas defensivas alcanzables para que haya movimiento con propósito. Ningún jugador aparece en una coordenada nueva porque un sorteo lo seleccionó.
- Implementar pase corto a compañero elegible, trayectoria del balón, recepción solo al llegar, conducción corta y disputa/robo solo por rival alcanzable.
- Mantener al portero en su área de rol y darle una acción de despeje hacia un compañero/zona válida después de controlar el balón.
- Terminar cada posesión en transición real: pérdida, balón fuera o decisión de tiro. Poner límite a decisiones/eventos y garantizar cierre de cada periodo.
- Mantener casi fijos a los jugadores fuera de la zona de influencia; activar sus decisiones cuando el balón o su trayectoria se acerque. Conservar su ubicación previa y avanzar desde allí, sin reubicar desde la formación. Derivar snapshots/keyframes escasos; el navegador anima entre ellos y el servidor no simula ni emite 60 frames × 22 jugadores.

**Aceptar cuando:** hay escenarios deterministas que comprueban velocidad/distancia, pases cercanos, recepción/intercepción alcanzable, límites de zona del portero y ausencia de teletransporte; mismo seed + versión + inputs produce los mismos eventos. Una revisión de varios seeds confirma que el apoyo y la presión se activan cuando la jugada se acerca y que el resto no queda totalmente congelado ni se mueve por ruido aleatorio. No se conecta aún a cuotas ni partidos reales.

### Fase 3 — Tiros y marcador emergente

**Trabajo:**

- Permitir tiro solo cuando la ubicación/ángulo y el estado de la jugada lo justifiquen; primero tiros cercanos y después, si hace falta, tiros lejanos con probabilidad menor.
- Derivar calidad/xG de posición, presión, atributos y guardameta. Resolver gol, atajada, poste o fuera como continuación de ese tiro; el score se actualiza una sola vez al validar un gol.
- Ajustar la frecuencia de llegadas, tiros y goles por separado; no cambiar todos los parámetros a la vez.
- Comparar la distribución resultante con los mercados existentes (1X2, totales, ambos anotan, marcador exacto). Si hay desviación, no se puede asumir que Poisson/Dixon–Coles siga describiendo el V2: se calibra el modelo de precios contra las salidas del V2 o no se habilita V2 para apuestas.
- Mantener tests estadísticos rápidos en CI y una batería grande separada.

**Aceptar cuando:** cada gol corresponde a un tiro que recorrió una trayectoria válida y superó al portero; se fijan tolerancias antes de ejecutar Monte Carlo; se puede repetir cada seed fallido; y simulación y precios usan la misma distribución calibrada. Si alinear cuotas exige rehacer además la economía o el scheduler, se detiene y se replantea el alcance.

### Fase 4 — Balón fuera, corners, penales y reglas de reinicio

Añadir una mecánica a la vez, después de validar el ciclo normal de pase/tiro:

1. Cruce de líneas y último toque; saque de banda, saque de meta y corner se derivan de esa causa.
2. Secuencia de corner: balón colocado → ejecución → trayectoria/centro → disputa, despeje o tiro. El comentario de corner se adjunta a `corner_awarded`, no a una etiqueta aleatoria.
3. Faltas por disputa físicamente cercana; tiro libre fuera del área o penal dentro. Secuencia de penal: infracción → adjudicación → ejecución → gol/atajada/poste/fuera → reanudación.
4. Reposicionamiento para saques: todos se desplazan durante el tiempo de pausa con velocidad acotada; no se teletransportan a la formación para reanudar.
5. Después: tarjetas/expulsiones y sustituciones, probando disponibilidad del jugador antes y después. Prórroga/tanda solo cuando el partido regular esté estable.

Lesiones, fatiga avanzada, centros aéreos y tácticas que cambian ante el marcador quedan fuera hasta que las métricas muestren una necesidad clara.

**Aceptar cuando:** cada reinicio tiene una causa verificable y secuencia completa; el evento, balón, marcador y relato están de acuerdo; invariantes de movimiento y participantes pasan en escenarios dirigidos y seeds aleatorios.

### Fase 5 — Comentarios anclados a eventos reales

**Trabajo:**

- Crear primero el evento confirmado (`eventId`, tipo, minuto, equipo, jugador, ubicación, outcome, score-after); después renderizar los mensajes desde ese evento. El comentario jamás crea una jugada ni intenta adivinar su resultado.
- Mantener las dos voces en español como valor por defecto: narrador para la acción y analista para contexto comprobable. Conservar el límite actual de 140 caracteres salvo una decisión explícita distinta.
- Atar cada plantilla a su condición: solo decir “tiro de esquina” ante `corner_awarded`; “atajada” ante un evento de parada del guardameta; “gol” después de la validación y actualización del score. Si una jugada se cancela o termina de otra manera, usar el relato de ese outcome.
- Pasar al comentarista únicamente el estado ocurrido hasta ese evento; no la línea futura completa, ni rachas/estadísticas que todavía no se hayan acumulado.
- Mantener elección reproducible y anti-repetición con stream de comentarios independiente del juego. Medir frecuencia real por minuto de partido.

**Aceptar cuando:** pruebas evento→texto para éxitos y fallos; ningún mensaje contradice tipo, equipo, resultado, minuto o marcador; no hay placeholders ni datos futuros; cambiar plantillas no afecta el partido; lectura manual de partidos completos.

### Fase 6 — Modo sombra y adaptación

**Trabajo:**

- Ejecutar V1 y V2 con el mismo conjunto de entradas en pruebas/offline. Publicar únicamente V1; no crear apuestas, cuotas, liquidaciones ni eventos públicos desde la comparación.
- Comparar informes por seed y por distribución, no elegir el motor ganador por una sola reproducción.
- Conservar fallos y seeds como casos de regresión.
- Integrar el selector de versión en la frontera más pequeña posible, con V1 por defecto y V2 solo para partidos sintéticos internos. Verificar persistencia, reinicio y recuperación para ambas versiones.

**Aceptar cuando:** el modo sombra no modifica store, perfiles, cuotas, sockets ni resultados públicos; los tests completos siguen pasando; una prueba de reinicio recupera la misma línea de tiempo usando la versión y entradas originales.

### Fase 7 — Activación controlada o descarte

**Trabajo:**

- Empezar con partidos de demostración sin apuestas. Después, si todos los gates pasan, habilitar solo partidos futuros seleccionados explícitamente; la versión queda fijada desde antes de abrir el mercado.
- Vigilar métricas y errores por versión. No cambiar un partido en vivo de V2 a V1: el rollback afecta únicamente a partidos aún no iniciados.
- Si V2 supera el umbral de fallos duros, activar el circuit breaker y dejar de asignarlo a nuevos partidos; no mantener una cadena de aplazamientos. Usar V1 para partidos futuros solo antes de abrir apuestas y con su mercado/precios correctos.
- Retirar V1 solo tras un periodo operativo acordado y una decisión explícita. Si los resultados/calibración o la experiencia del relato empeoran, apagar V2 y mantener V1 sin pérdida de funcionalidades.

**Aceptar cuando:** determinismo tras reinicio, distribución, latencia, integridad de apuestas y comentarios pasan los criterios acordados en partidos de prueba; hay instrucciones de rollback ensayadas; no queda ningún camino que use una versión implícita.

## 6. Matriz mínima de pruebas

| Área | Prueba de aceptación |
| --- | --- |
| Determinismo | Igual seed, versión e inputs → mismo timeline, score, stats y relato; prueba repetida tras reconstruir el generador. |
| Independencia de subsistemas | Cambiar la semilla/configuración de comentarios no cambia el partido; cambiar presentación no altera el score. |
| Cronología y privacidad | Tiempo monótono; `deriveState` y cualquier payload solo muestran el prefijo permitido, nunca eventos futuros. |
| Previa | Timeline V2 generado/validado/sellado antes del kickoff; al empezar se revela el prefijo, no se regenera ni se envía el futuro al cliente. |
| Marcador | Conteo de `goal` y tipos de penal anotado coincide exactamente con el score final. |
| Movimiento | Para cada segmento, distancia ≤ velocidad permitida × tiempo; jugador lejano conserva su posición, se activa por alcance/trayectoria sin salto y no oscila en el umbral; portero permanece en su zona; recolocación tras pausa también tiene duración. |
| Balón | Todo pase/tiro/despeje tiene origen, trayectoria y llegada coherentes; velocidad y tiempo de vuelo acotados; la recepción/intercepción ocurre cerca del balón. |
| Causalidad | Pase, robo, tiro, corner y penal solo existen cuando se cumplieron sus condiciones de distancia/posesión/línea/área; marcador sale de goles validados. |
| Estadísticas | Marcador, tiros, xG, posesión, corners y tarjetas se reconstruyen del timeline y coinciden con el resumen. |
| Distribución | Monte Carlo reproduce métricas predefinidas por banda y mercado; reporte de seeds y tolerancias, no solo promedio general. |
| Comentario | Todo texto referencia un evento confirmado; dos voces, longitud, variables, anti-repetición, minuto/marcador correctos y ningún dato futuro. |
| Integración | `npm run test:football`, `npm test`, recuperación de partido tras reinicio y no alteración de apuestas/liquidación. |
| Rendimiento | Medición separada del costo de generar el timeline, validar movimiento y derivar un estado. Comparar con V1, pero sin exigir <8 ms si cambió sustancialmente el modelo: V2 se prepara antes del kickoff y su presupuesto se fija con mediciones. |

En cada PR, ejecutar pruebas deterministas y una muestra estadística pequeña. Ejecutar el objetivo de hasta 20.000 partidos en un job nocturno o de liberación solo después de medir el costo. Si el job resulta demasiado lento, no presentar una muestra pequeña como calibración completa: reportar el límite, optimizar y decidir el tamaño de muestra con intervalos de confianza antes de habilitar apuestas. Los umbrales deben tener tolerancias y semillas reproducibles, no depender de que un test aleatorio “salga bien”.

## 7. Escalabilidad: evaluación sin promesas infundadas

La parte favorable es que la simulación se hace una vez por partido, no una vez por espectador. El servidor conserva un timeline sellado y distribuye eventos; el cliente interpola posiciones. El calendario actual contempla 240 partidos mensuales y pocos kickoffs concurrentes. Eso hace **plausible** escalar un motor de eventos moderado en una instancia, pero no es una garantía: hay que medir con el host y la persistencia reales.

La parte peligrosa es intentar física continua completa. Como orden de magnitud, integrar 22 jugadores a 10 Hz durante 90 minutos simulados implica 54.000 pasos de reloj y cerca de 1,19 millones de posiciones de jugador por partido; para 240 partidos son unos 285 millones de posiciones, antes de contar balón, reglas y estadísticas. Guardar todos esos snapshots también dispara memoria y tamaño de JSON. A 60 Hz la cifra es seis veces mayor. **No recomiendo 60 Hz ni persistir el campo entero en cada paso.** Son cálculos de escala, no benchmarks de Node ni límites medidos.

La arquitectura de menor riesgo es híbrida: resolver decisiones en eventos discretos; integrar solo los movimientos necesarios entre ellas con tiempo/distancia acotados; guardar eventos y segmentos/keyframes escasos; interpolar la representación en el cliente. No actualizar 22 objetos para cada frame que ve un usuario. Medir por partido: generación p50/p95, memoria pico, eventos/keyframes, validación, costo de Monte Carlo y preparación a tiempo para el kickoff.

**Evaluación honesta:** CPU en producción probablemente no sea el mayor bloqueo si la generación es previa y escasa. La dificultad alta es la corrección combinatoria (22 jugadores × geometría × reglas × resultados × comentario) y mantener alineadas cuotas/fairness. Si el prototipo requiere excepciones del tipo “mover al jugador aquí para que se vea bien” o rompe invariantes al agregar cada jugada, no escala aunque corra rápido: hay que reducir mecánicas, no acumular parches.

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| La distribución de marcadores no coincide con las cuotas | No activar V2 para apuestas; calibrar el modelo de precios contra el V2 o pausar su lanzamiento. Mantener V1 como motor productivo mientras tanto, sin cambiar el enfoque causal elegido para V2. |
| El resultado queda fijado o es predecible mientras aún se aceptan apuestas | Congelar modelo/entradas antes de abrir; crear un seed secreto con CSPRNG solo después del cierre; persistirlo y comprometer hash antes del kickoff. |
| El motor provoca retrasos repetidos | Cero fallos duros en el corpus previo; límite/umbral definido antes del piloto, circuit breaker para V2 y no reintentar indefinidamente el mismo partido. |
| Un deploy cambia el replay de un partido activo | Versión explícita e inputs congelados; V1 intacto; test de reinicio por versión. |
| Cambios de comentario alteran una tanda o un gol | Streams aleatorios independientes por subsistema y prueba de aislamiento. |
| La simulación queda atrapada o genera demasiados eventos | Límites de acciones, eventos y tiempo; fallback de terminación comprobado. |
| Se rompe el dinero o el calendario al integrar | No cambiar apuestas, settlement, store o scheduler durante el prototipo; pruebas integrales antes del selector. |
| Jugadores alejados parecen congelados o se activan tarde | Aceptar esa simplificación en el primer prototipo, pero activar por trayectoria/tiempo de llegada además de distancia; probar ataques, contras y cambios de banda; usar histéresis y nunca snap al activarse. |
| V2 se vuelve demasiado ambicioso | Primer alcance limitado; incorporar una mecánica por fase; pausar si exige cambios simultáneos de cuotas, economía y datos. |
| La migración obliga a borrar V1 antes de probar V2 | Modo sombra, V1 por defecto, activación por partido futuro y rollback probado. |

## 9. Requisitos confirmados y pendientes

### Confirmado por el usuario

- El marcador **emerge de las jugadas**, no de un resultado final sorteado de antemano.
- El partido completo se simula y valida durante La Previa; el servidor lo libera gradualmente desde el kickoff oficial.
- Se conserva un plantel de 11 contra 11, pero el motor razona en detalle sobre el grupo que puede intervenir en la jugada; los jugadores alejados se mantienen casi fijos hasta que el balón o su trayectoria se acerca. Los apoyos y coberturas cercanos se activan con movimientos útiles para que el partido no se vea inmóvil.
- Sin teletransporte: pases inicialmente a compañeros cercanos, conducción acotada al rol, robos por proximidad y portero dentro de una zona razonable.
- El balón debe viajar a velocidad/tiempo plausibles; despejes del portero deben dirigirse a un compañero o zona válida.
- Corners y penales deben provenir de eventos que los causen; el comentario describe el evento que realmente ocurrió.
- Un 0-0 es válido y nunca dispara un retraso. Si falla una validación dura, informar al usuario, gestionar las apuestas según la regla de aplazamiento/reembolso y activar un corte para que el motor no retrase muchos partidos consecutivos.
- Se permite proponer ideas adicionales, pero el alcance debe ser crítico y no repetir el intento fallido de #18.

### Pendiente útil, pero no bloqueante para iniciar

Si conserva un ejemplo del fallo de #18 (seed/minuto, captura o descripción exacta), usarlo en la Fase 0 como regresión. Revisé el PR #18 y anoté en la retrospectiva el hueco que se aprecia en el repositorio; no puedo asegurar que esa sea la única causa sin ver la jugada que falló.

Por ahora el plan conserva dos voces en español y el límite actual de 140 caracteres como valor por defecto. Cambiarlo sería una decisión editorial separada, no un prerrequisito para comenzar el prototipo.

## 10. Cierre del análisis original (histórico)

La sesión inicial terminó en análisis y planificación. Los avances posteriores de implementación se describen a continuación; esta sección histórica no representa el estado actual.

## Estado de implementación y riesgos abiertos — 31 de octubre de 2026

### Implementado y comprobado

- `v2-causal-2` genera los goles desde jugadas y dispone de faltas, tarjetas, cambios, tiempo añadido y comentarios. La versión anterior permanece disponible para reproducir compromisos anteriores. La demo 2D y el adaptador del Estadio muestran solo el prefijo revelado; el replay completo y la clave no se envían al cliente.
- Los compromisos manuales congelan alineaciones, ratings, entradas, versión y clave privada; se guardan y rehidratan en archivo y en PostgreSQL real para el recorrido de una instancia. Los compromisos existentes y los boletos incompatibles impiden cambiar silenciosamente de motor. **Todavía no hay selector automático ni preparación de las jornadas nuevas.**
- La ruta experimental cotiza mercados prepartido y 1X2 en vivo desde muestras del mismo motor, liquida simples y combinadas contra el replay V2 y aplica cash-out. `v2-quotes-2` añade límites conservadores de Wilson y conserva la lectura de `v2-quotes-1`; cuando no hay cuota de venta segura, puede omitirse una selección. Esto no equivale a cobertura completa ni es una solución de lanzamiento para la instrucción de mantener apuestas.
- El escrow recuperable de simples, combinadas y futuros ordinarios registra intentos, débitos y pagos idempotentes. Se probaron interrupciones, reinicios, reintentos de cash-out, conflictos de claves y pagos sin duplicar en proceso único. Los futuros ordinarios usan cuotas del servidor, no del cliente; su liquidación trata campeón, top 2/top 4 y goleador, y conserva el futuro de campeón mientras se disputa un desempate pendiente incluso al cambiar de mes.
- Los barridos recuperan partidos antiguos asociados a apuestas y sus desempates pendientes. La protección del reset espera pagos o boletos ordinarios abiertos; si no pueden reconciliarse, puede requerir reparación manual.
- En PostgreSQL, con Estadio habilitado, el servidor adquiere antes de leer perfiles una concesión de escritor único. Las escrituras de fútbol y perfiles conectadas a ella comprueban un token de *fencing* dentro de la transacción; si se pierde la concesión, el proceso termina. Una segunda instancia protegida no arranca hasta que la primera libera la concesión. Se comprobó con dos procesos de servidor reales, dos procesos Node y transacciones que se solapan; no suspende selectivamente las apuestas, afecta al proceso duplicado completo.

### Prueba económica exploratoria, no certificación

`node scripts/calibrate-football-v2.js --demo --samples=2048` usó **dos grupos independientes de 2.048 partidos sintéticos**, para un único enfrentamiento, en **377,4 s**. El filtro agregado de cinco métricas pasó (diferencia máxima 2,54 puntos porcentuales). Con `v2-quotes-2`, 0 de 44 selecciones ofertadas tuvieron retorno positivo observado en ese grupo de control. La cobertura de estados observados con cotización live fue **62,18 %**. Una versión anterior de cuotas mostró 6 de 45 selecciones con retorno positivo; la comparación no valida todos los mercados ni justifica el despliegue. Los límites de Wilson no corrigen sesgos estructurales, información visible durante una jugada, cash-out, exposición ni futuros.

La calibración actual se realiza por enfrentamiento; el tiempo de esta muestra hace inviable ejecutar 240 enfrentamientos secuencialmente en el arranque sin un diseño de preparación y coste diferente. En otro ensayo exploratorio de siete enfrentamientos con plantillas de noviembre y 192 muestras por partido, por ejemplo, Celtic de Cómic–Real Suciedad produjo medias V2 de **1,203–1,906** goles frente a lambdas V1 de **1,501–1,256**. Una distribución agrupada, contrastada dejando fuera cada enfrentamiento y con margen del 15 %, llegó a un retorno observado de **+107,2 %** en un marcador 0–1. Las muestras son pequeñas: no demuestran ese retorno como propiedad estable, pero sí desaconsejan sustituir la calibración por las cuotas V1 o por una cohorte global sin más pruebas. Otros 32 enfrentamientos con 64 muestras cada uno se usaron para explorar ajustes, sin convertirlos en cuotas oficiales. No hay datos reales de octubre en este checkout: no se han inventado estadísticas de producción.

### Bloqueantes para cumplir el pedido

1. Seleccionar y preparar automáticamente V2 desde noviembre sin cambiar un partido o boleto ya comprometido. Debe resolverse la preparación previa a futuros/BDO, el coste de calibración y su persistencia durable.
2. Diseñar y contrastar una cotización live completa que contemple el estado visible sin filtrar la trayectoria privada. Cubrir estados poco frecuentes; la cobertura parcial actual no cumple la petición de mantener apuestas operativas.
3. Calibrar los futuros de temporada, Bota de Oro y Balón de Oro frente al mismo motor y sus reglas de liquidación. El proyector actual es aproximado; el mercado de futuros ordinarios todavía no cotiza durante partidos activos o con datos necesarios ausentes. Esto es una limitación pendiente, no una solución de producto.
4. Extender y verificar la protección de escritura en todos los despliegues y rutas. La concesión y el fencing protegen las rutas de perfil/fútbol conectadas en servidores nuevos con PostgreSQL y `FOOTBALL_ENABLED=on`, pero no versiones antiguas que la ignoren, procesos con el flag apagado, backend de archivo ni escrituras directas de otros stores, incluidos `password-reset-store-pg.js` y `moderation-store-pg.js`. Una primera actualización con instancias antiguas simultáneas necesita coordinación operacional; no se ha demostrado una garantía universal multiproceso. `season-admission.js` por sí solo sigue coordinando una copia.
5. Acordar y verificar la política de generación y custodia de la clave privada: el prototipo actual crea la clave antes de aceptar boletos y la guarda en el servidor; el plan original requería crear el seed tras el cierre prepartido. Hay que resolver esa diferencia antes de activar el producto.
6. Implementar y probar prórroga y tanda en V2, incluidos los compromisos de los futuros de campeón; actualmente V2 rechaza el desempate y no desvincula completamente V1.

### Comprobaciones ejecutadas

Con PostgreSQL 18 temporal real, la suite completa pasó **491/491 unitarias y 224/224 de integración**, sin omisiones ni TODO; también pasaron lint y sintaxis. La prueba V2 cubre confirmación incierta de `COMMIT`, reintento conservando la clave, apuesta, reinicio, reconstrucción y pago idempotente en una instancia. La prueba de la carrera ya no está marcada TODO: con la concesión activa, la segunda instancia fue rechazada, la siguiente recargó el saldo correcto y el token anterior dejó de escribir; se comprobó que el cambio de dueño espera una escritura protegida en curso. También se comprobó la exclusión en procesos Node independientes y en dos servidores completos con Estadio habilitado. Después de la suite completa se amplió esa prueba para terminar desde PostgreSQL la conexión que mantenía la concesión: el servidor anterior terminó con error y un tercero pudo arrancar. El archivo focalizado pasó **5/5** tras esa ampliación. El diagnóstico anterior sin concesión sí produjo dos apuestas de 500 con saldo persistido de 500 en lugar de 0. Las pruebas económicas de integración usan muestras sintéticas, no cuotas validadas para producción.

La primera ejecución real de V2 descubrió que JSONB reordena las claves y podía invalidar el hash de entradas. El guardado PostgreSQL conserva ahora el compromiso serializado como cadena para mantener su orden y valida el hash al rehidratar. Un compromiso escrito previamente como objeto JSONB con el orden ya alterado no se reinterpreta ni se reemplaza automáticamente: requiere recuperar el original o reparación explícita. Las pruebas de escritor único cubren las rutas y condiciones descritas arriba, no autorizan por sí solas la activación oficial.
