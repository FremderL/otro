# Laboratorio de partidos 2D

Demostración **local y sin apuestas** del motor en `lib/football/v2/simulator.js`, con la presentación original de laboratorio. No arranca el scheduler, los sockets ni los almacenes de liga; sus jugadores y atributos son sintéticos. No se guarda el partido ni se modifican fichas o posiciones. Para ver el **Estadio integrado con V2**, su interfaz y el servidor reales, usa [`preview/estadio-v2`](../estadio-v2/README.md).

Para abrirla aisladamente:

```sh
npm ci
PORT=3001 node preview/simulador-2d/server.js
```

Abrir `http://localhost:3001/`. El selector consulta solo metadatos públicos de clubes; si no están disponibles usa dos clubes de ejemplo. Se puede pausar, cambiar velocidad y comenzar otro partido. Para repetir una simulación de prueba en una URL se admite, por ejemplo, `/?seed=12`; esa semilla no es secreta y **no sirve para partidos con apuestas**.

El motor avanza en pasos de 0,5 segundos simulados sobre 105 × 68 m. Los jugadores y el balón se desplazan con límites de velocidad; pases, intercepciones, entradas y atajadas necesitan contacto, y las intercepciones verifican que jugador y balón coincidan en espacio y tiempo; el marcador cambia cuando un tiro (incluido un desvío) cruza entre los postes. Las faltas en el área producen penales y el último toque en una salida de fondo decide el córner. Los eventos se publican en la demo al llegar su instante, no al generar el siguiente paso de interpolación. Las pruebas también cubren un 0–0 sin reintentos.

Esta demo local conserva su propia presentación y no utiliza el reloj, las plantillas, los ratings ni las cuotas oficiales. No implementa las garantías de persistencia y privacidad del servidor. El motor oficial, las entradas congeladas, el scheduler y los mercados están descritos en `docs/plan-motor-partido-comentarios-v2.md`. La vista nueva de Estadio usa datos y perfiles ficticios, separados de producción.

Pruebas focalizadas:

```sh
node --test tests/football-v2-simulator.test.js tests/football-v2-demo.test.js
```
