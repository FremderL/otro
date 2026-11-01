# Estado de la integración solicitada

Estado del trabajo en esta rama; no equivale a un despliegue. Las fichas son
virtuales. `FOOTBALL_ENABLED` sigue apagado en producción (`render.yaml`).

| Función | Estado | Pendiente o límite |
| --- | --- | --- |
| Mi Once | Disponible en código integrado a main; prueba de suite existente | Estadio apagado en producción; pines solo en Mi Once; PostgreSQL real y concurrencia distribuida no validados. |
| Mi afición | Selección, progreso, tres retos, pines equipables y clasificación agregada opcional conectados | PostgreSQL real probado de forma aislada; concurrencia entre procesos no validada. La demo separada es ficticia. |
| Escudos | 16 SVG propios conectados al Estadio, Balón de Oro, traspasos, Mi afición, Mi Once e historial; pruebas de asociaciones y vistas | Estadio sigue apagado en producción por decisión del usuario. Ver `docs/escudos.md`. |
| Rueda de la Fortuna | **Jugable**: diario transaccional en disco con cobros/pagos idempotentes, reembolso al salir o cerrar la mesa y recuperación tras reinicio (devuelve lo no resuelto y paga lo confirmado); tarjeta del lobby habilitada, también en producción | Un solo proceso escritor (el archivo de estado no coordina réplicas); retención de 24 h; el cierre mensual no devuelve fichas borradas por el reinicio. Ver `docs/rueda-fortuna.md`. |
| Lotería | **Jugable**: sala común en `/loteria` con inscripción autenticada, cobro/reembolso, canto automático, pagos idempotentes y recuperación tras reinicio; pruebas de reglas, servicio, interfaz y servidor real | Una sola instancia (el archivo de estado no coordina réplicas); el adaptador PostgreSQL experimental no está conectado; el cierre mensual puede coincidir con una ronda en curso. Ver `docs/loteria.md`. |
| Quiniela | Reglas, pantalla de jornada y diario transaccional de boletos, reparto y reembolsos probado en PostgreSQL aislado | Falta conectar ese diario a la cartera compartida, resultados persistidos, interfaz de inscripción y recuperación integral; permanece deshabilitada. |
| Traspasos | Conectado al Estadio: anuncio del día 15 y cambios para el siguiente ciclo | Pruebas JSON, Socket.IO, interfaz y persistencia PostgreSQL real aislada; Estadio apagado en producción. |
| Destacados y horarios | Resúmenes al finalizar desde la cronología oficial; calendario escalonado y día doble a +30 min | Sin resúmenes inventados para partidos antiguos; la nueva parrilla se usa al generar nuevas temporadas. |
| Moderación y seguridad | Migración aditiva y prueba PostgreSQL de reportes, evidencia, acciones y revocación; protección de cuentas verificadas en sockets de Estadio | La administración requiere configuración segura y migración para habilitarse; las rutas legadas y la concurrencia del saldo requieren revisión. |
| Fichas en la mesa | **Disponible en código**: asientos, filas de la clasificación y tribuna abren la ficha pública de la persona; la solicitud de amistad se manda y se responde sin salir de la partida. Pruebas unitarias de la regla (`lib/table-social.js`), de interfaz en JSDOM y de socket real (mismo dispositivo, sesiones de cuenta apagadas) | La petición de amistad exige cuenta verificada a ambos lados; con `ACCOUNT_SESSIONS_ENABLED=off` la ficha se arma solo con lo público de `room_state` y no ofrece amistad. Un flujo completo de dos cuentas necesita PostgreSQL (`DATABASE_URL` + `APP_ORIGIN` HTTPS) y no se probó con dos navegadores reales. |

## Rueda

Los sectores son 25 de 1, 15 de 2, 7 de 5, 4 de 10, 2 de 20 y uno de 40.
Las devoluciones totales son respectivamente x2, x3, x6, x11, x21 y x41;
incluyen la apuesta. No hay eventos especiales ni bonificaciones adicionales, por decisión del usuario. La animación es ilustrativa: el valor
válido es el que entrega el servidor. Rueda cuenta en retos de variedad, pero
no cambia los seis sellos del Pasaporte.

La Rueda **ya está abierta a los usuarios**, también en producción. El modelo de
salas en memoria cobraba la apuesta y pagaba ~1 s después; una caída en medio
dejaba fichas sin resultado ni devolución. `lib/fortune/ledger.js` añade un
diario en disco: la intención se escribe antes de tocar el saldo, cada movimiento
lleva un `operationId` idempotente dentro del perfil, el resultado se confirma
antes de pagar y, al arrancar, se reembolsan las rondas sin resultado y se pagan
las confirmadas. Salir, desconectarse, destruir la mesa o apagar el servidor
devuelven la apuesta en el acto. `FORTUNE_ENABLED=off` la apaga y `GET /healthz`
publica `fortuneEnabled`. Detalles y límites en `docs/rueda-fortuna.md`.

El usuario solicitó un commit de los avances actuales. Este inventario deja
constancia de los límites: un commit no convierte los juegos deshabilitados en
jugables ni equivale a un despliegue. No activar Estadio en producción sin
autorización adicional.

La decisión acordada para recuperación —reembolsar cuando no se haya confirmado
el resultado y pagar el resultado ya confirmado— está implementada para la Rueda
y cubierta por pruebas de caída (`SIGKILL`) y reinicio; el cierre mensual no
devuelve fichas que el reinicio ya borró. Lotería y Rueda son las dos únicas
funciones de esta tabla con recuperación probada; Quiniela sigue pendiente.
