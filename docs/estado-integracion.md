# Estado de la integración solicitada

Estado del trabajo en esta rama; no equivale a un despliegue. Las fichas son
virtuales. `FOOTBALL_ENABLED` sigue apagado en producción (`render.yaml`).

| Función | Estado | Pendiente o límite |
| --- | --- | --- |
| Mi Once | Disponible en código integrado a main; prueba de suite existente | Estadio apagado en producción; pines solo en Mi Once; PostgreSQL real y concurrencia distribuida no validados. |
| Mi afición | Selección, progreso, tres retos, pines equipables y clasificación agregada opcional conectados | PostgreSQL real probado de forma aislada; concurrencia entre procesos no validada. La demo separada es ficticia. |
| Escudos | 16 SVG propios conectados al Estadio, Balón de Oro, traspasos, Mi afición, Mi Once e historial; pruebas de asociaciones y vistas | Estadio sigue apagado en producción por decisión del usuario. Ver `docs/escudos.md`. |
| Rueda de la Fortuna | En desarrollo; reglas y pagos exactos implementados para una vista local de prueba | Pausada en producción y PostgreSQL hasta integrar recuperación transaccional; una mesa de 1 a 6, sin eventos especiales. |
| Lotería | **Jugable en código**: partida compartida del lobby conectada (servicio + sockets + interfaz), con saldos solo vía `ProfileStore`, diario persistente con pagos idempotentes, recuperación por reloj y puerta del reset mensual; pruebas unitarias, de UI y de integración con caída del proceso | Activa por defecto tras el despliegue (`LOTERIA_ENABLED=off` la apaga). La prueba con PostgreSQL real del diario y concurrencia entre procesos no se ha corrido: el servicio asume un solo proceso, como el resto del casino. Ver `docs/loteria.md`. |
| Quiniela | Reglas, pantalla de jornada y diario transaccional de boletos, reparto y reembolsos probado en PostgreSQL aislado | Falta conectar ese diario a la cartera compartida, resultados persistidos, interfaz de inscripción y recuperación integral; permanece deshabilitada. |
| Traspasos | Conectado al Estadio: anuncio del día 15 y cambios para el siguiente ciclo | Pruebas JSON, Socket.IO, interfaz y persistencia PostgreSQL real aislada; Estadio apagado en producción. |
| Destacados y horarios | Resúmenes al finalizar desde la cronología oficial; calendario escalonado y día doble a +30 min | Sin resúmenes inventados para partidos antiguos; la nueva parrilla se usa al generar nuevas temporadas. |
| Moderación y seguridad | Migración aditiva y prueba PostgreSQL de reportes, evidencia, acciones y revocación; protección de cuentas verificadas en sockets de Estadio | La administración requiere configuración segura y migración para habilitarse; las rutas legadas y la concurrencia del saldo requieren revisión. |

## Rueda

Los sectores son 25 de 1, 15 de 2, 7 de 5, 4 de 10, 2 de 20 y uno de 40.
Las devoluciones totales son respectivamente x2, x3, x6, x11, x21 y x41;
incluyen la apuesta. No hay eventos especiales ni bonificaciones adicionales, por decisión del usuario. La animación es ilustrativa: el valor
válido es el que entrega el servidor. Rueda cuenta en retos de variedad, pero
no cambia los seis sellos del Pasaporte. El juego reutiliza el modelo existente
de salas en memoria: no se ha demostrado recuperación ante caída durante una
apuesta o liquidación. Por ello, está bloqueada tanto en producción como con PostgreSQL; solo se abre en una prueba local explícita de archivo (`FORTUNE_PREVIEW_UNSAFE=on`, nunca en `NODE_ENV=production`). Una prueba con PostgreSQL real verifica el bloqueo, no la recuperación.

El usuario solicitó un commit de los avances actuales. Este inventario deja
constancia de los límites: un commit no convierte los juegos deshabilitados en
jugables ni equivale a un despliegue. No activar Estadio en producción sin
autorización adicional.

La decisión acordada para recuperación es reembolsar cuando no se haya confirmado
el resultado, y pagar el resultado ya confirmado. **Aún no está implementada**:
se requiere persistencia transaccional con el saldo y la ronda, garantías frente
a escrituras del perfil y al cierre mensual, y ensayos de caída/reinicio.
