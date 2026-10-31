# Laboratorio de partidos 2D

Demostración experimental **local y sin apuestas** del motor en `lib/football/v2/simulator.js`. No arranca el motor oficial, el scheduler, los sockets ni los almacenes de liga. Los jugadores y sus atributos de esta vista son sintéticos. No se guarda el partido, no modifica fichas ni posiciones y no liquida apuestas. En el Estadio se accede desde «Laboratorio de fichas 2D»; los partidos oficiales continúan en V1.

Para abrirla aisladamente:

```sh
npm ci
PORT=3001 node preview/simulador-2d/server.js
```

Abrir `http://localhost:3001/`. El selector consulta solo metadatos públicos de clubes; si no están disponibles usa dos clubes de ejemplo. Se puede pausar, cambiar velocidad y comenzar otro partido. Para repetir una simulación de prueba en una URL se admite, por ejemplo, `/?seed=12`; esa semilla no es secreta y **no sirve para partidos con apuestas**.

El motor avanza en pasos de 0,5 segundos simulados sobre 105 × 68 m. Los jugadores y el balón se desplazan con límites de velocidad; pases, intercepciones, entradas y atajadas necesitan contacto, y las intercepciones verifican que jugador y balón coincidan en espacio y tiempo; el marcador cambia cuando un tiro (incluido un desvío) cruza entre los postes. Las faltas en el área producen penales y el último toque en una salida de fondo decide el córner. Los eventos se publican en la demo al llegar su instante, no al generar el siguiente paso de interpolación. Las pruebas también cubren un 0–0 sin reintentos.

Esto es un primer corte, no un motor apto para ligas o mercados: esta vista no utiliza las plantillas, ratings ni cuotas oficiales; no implementa fuera de juego, cambios, fatiga o xG, y no persiste una reproducción. El motor experimental ya acepta alineaciones y ratings explícitos; `lib/football/v2/inputs.js` prepara copias de los datos del almacén y, si hay partidos asentados del mes anterior, incorpora su rendimiento. Es una preparación aún **no conectada al scheduler ni persistida**; los coeficientes son experimentales, no una calibración. Antes de activar partidos oficiales deben cumplirse las puertas de `docs/plan-motor-partido-comentarios-v2.md`, en especial versionado e inputs congelados, semilla secreta posterior al cierre de apuestas, validación y reembolso seguro, recuperación, privacidad del futuro, compatibilidad con consumidores y calibración de cuotas. La simulación de prueba en el navegador no ofrece esas garantías ni pretende hacerlo.

Pruebas focalizadas:

```sh
node --test tests/football-v2-simulator.test.js tests/football-v2-demo.test.js
```

La integración experimental del Estadio conserva un compromiso manual en pruebas y muestra posiciones V2, pero todavía no selecciona las jornadas nuevas automáticamente ni acepta apuestas. El análisis reproducible de muestras y las puertas pendientes están en `docs/plan-motor-partido-comentarios-v2.md`.
