# Pasaporte MonteCristo — propuesta de producto y alcance MVP

**Estado:** MVP implementado en la rama de trabajo; `PASSPORT_ENABLED` sigue apagado por defecto. Las pruebas automatizadas están verdes. La revisión visual en navegador real y la activación en producción quedan pendientes de una salida controlada.
**Fecha:** 2026-10-11.
**Propuesta:** progresión de temporada gratuita, enfocada en explorar los juegos y desbloquear cosméticos.

## 1. Resumen

El **Pasaporte MonteCristo** da a cada jugador una meta de progreso compartida entre los seis juegos de mesa del casino. Las rondas válidas generan puntos; jugar cada juego al menos una vez llena un sello del pasaporte. Los puntos y sellos desbloquean recompensas cosméticas fijas que el jugador conserva y puede equipar desde su perfil.

La propuesta no cambia cómo se juega, apuesta o gana. No entrega fichas, no aumenta probabilidades y no depende del tamaño de la apuesta ni de ganar. Todo el progreso lo calcula el servidor.

> **Principio de producto:** recompensar la participación y la variedad, no el gasto, el riesgo ni la suerte.

## 2. Objetivos

- Dar una meta visible de corto plazo y otra de temporada.
- Animar a probar Poker, Blackjack, Ruleta, Dados, Cara o Cruz y Tragamonedas.
- Hacer que logros y actividad se reflejen en la identidad del perfil mediante cosméticos.
- Reutilizar el perfil y los resultados autoritativos existentes, sin convertirlo en otro sistema de saldo.
- Mantener reglas transparentes: cada acción que suma progreso se explica en la interfaz.

## 3. Fuera de los objetivos

El Pasaporte no busca:

- Aumentar el tiempo de juego mediante presión, rachas punitivas o avisos insistentes.
- Incentivar apuestas más altas, pérdidas, partidas sin límite o juego compulsivo.
- Reemplazar los retos diarios/semanales, logros permanentes, recompensa diaria ni ranking mensual actuales.
- Crear por ahora un sistema social de equipos, clubes, torneos o clasificación competitiva del Pasaporte.

## 4. Alcance propuesto para el MVP

### 4.1 Temporada

- Una temporada dura **un mes calendario**, alineada con la temporada mensual del casino y su zona `CASINO_TIME_ZONE` (por defecto, `America/Mexico_City`).
- La interfaz muestra el nombre de la temporada y sus fechas de inicio y fin.
- Al cambiar de temporada se reinician únicamente los puntos y sellos de temporada. Los cosméticos desbloqueados se conservan.
- El primer período comienza cuando se active la función mediante `PASSPORT_ENABLED=on`; el flag está apagado por defecto para permitir una activación controlada. **No se acreditan puntos retroactivos** por partidas anteriores.

### 4.2 Puntos de progreso

- Propuesta inicial: **1 punto por ronda resuelta** en la que participe una persona real y haya realizado una apuesta válida.
- Cuentan las rondas ganadas, perdidas o empatadas por igual. El importe de la apuesta no modifica los puntos.
- Jugar contra bots sí cuenta para la persona real; las cuentas de bots no obtienen progreso.
- No cuentan espectadores, rondas sin apuesta, rondas no resueltas ni actividades fuera de los seis juegos indicados.
- Los puntos los concede el servidor al resolver la ronda. El navegador nunca envía el total ni el incremento que desea obtener.

### 4.3 Sellos de variedad

El Pasaporte tiene un sello por cada juego ya disponible en `AVAILABLE_GAMES`:

- Poker
- Blackjack
- Ruleta
- Dados
- Cara o Cruz
- Tragamonedas

Un sello se obtiene al completar la primera ronda válida de ese juego durante la temporada. Cada sello se obtiene una sola vez por temporada. Completar los seis desbloquea una insignia de exploración de esa temporada.

**Estadio MonteCristo / fútbol queda fuera del MVP**: tiene un motor de resultados y un ciclo de apuestas distintos. Su posible inclusión se decide después, no se suma automáticamente por compartir el perfil.

### 4.4 Recompensas cosméticas

Las recompensas de hitos y la insignia de los seis sellos son **fijas y visibles de antemano**. Catálogo inicial adoptado para el MVP:

| Hito de puntos | Recompensa de ejemplo |
| ---: | --- |
| 5 | Insignia de la temporada |
| 15 | Marco de perfil |
| 30 | Título decorativo junto al nombre |
| 50 | Segundo marco o variante visual |
| 75 | Emblema destacado de temporada |
| 6 sellos | Insignia «Explorador» de la temporada |

Los nombres y umbrales de esta tabla se implementan como catálogo inicial del MVP. Las recompensas y los seis sellos usan arte vectorial SVG original, estático, ligero y servido desde el propio sitio; no añade animaciones complejas ni recursos externos. Los premios son **cosméticos, deterministas y anunciados de antemano**.

- Los premios se desbloquean automáticamente al llegar al hito; no requieren otra reclamación.
- Se pueden equipar o quitar desde el perfil.
- Los objetos desbloqueados quedan asociados al perfil y sobreviven al cambio de temporada.
- Para el MVP se limita la presentación a elementos del perfil (marcos, títulos e insignias). No alteran cartas, fichas, mesa, cuotas ni acciones del juego.

### 4.5 Interfaz

En el perfil del usuario habrá una sección **Pasaporte** con:

- progreso actual y siguiente hito;
- temporada activa y fechas;
- los seis sellos, con el requisito de cada uno;
- catálogo de recompensas, indicando cuáles están bloqueadas o desbloqueadas;
- selector para equipar o quitar los elementos ganados.

Si se equipa un marco, título o insignia, se muestra en el perfil y en los lugares donde ya se presenta la identidad del jugador. No se agrega una tienda ni una pantalla social nueva en el MVP.

## 5. Reglas de elegibilidad y protección contra abuso

1. **Solo cuentan resultados autoritativos del servidor.** Una llamada del cliente, una animación o abrir una mesa no genera puntos.
2. **Una ronda debe estar resuelta y tener una apuesta válida de la persona real.** La derrota también suma; el importe apostado nunca suma más.
3. **Un mismo resultado no se acredita dos veces.** La implementación deberá identificar la ronda y al jugador con una clave estable del lado del servidor antes de otorgar puntos o sellos.
4. **No hay premios aleatorios.** No hay sobres, ruletas de premios ni cajas con contenido desconocido.
5. **Equipar no equivale a desbloquear.** El servidor valida que cada cosmético equipado pertenezca al catálogo y esté desbloqueado por ese perfil.
6. **Sin borrado accidental.** La temporada nueva reinicia el progreso temporal, pero no elimina inventario permanente ni logros existentes.

## 6. Fuera del alcance del MVP

- Pase premium, suscripción, compras, publicidad recompensada o moneda premium.
- Fichas, premios canjeables, dinero real, depósitos, retiros o conversión de cosméticos a saldo.
- Cajas de botín, recompensas aleatorias, intercambio, regalo o venta de objetos.
- Ventajas de juego: mejores cartas, cuotas, probabilidades, turnos, límites de apuesta o fichas iniciales.
- Puntos por tamaño de apuesta, cantidad perdida, racha de victorias o resultado deportivo.
- Progreso por Estadio MonteCristo, apuestas de fútbol o liquidaciones de sus mercados.
- Clubes, metas cooperativas, torneos de lobby, brackets y rankings del Pasaporte.
- Recuperar temporadas anteriores, acreditar progreso pasado o transferir objetos entre perfiles.
- Editor de cosméticos, carga de imágenes propias, marketplace, animaciones complejas o un sistema para personalizar/crear arte desde el cliente.
- Rehacer el sistema de logros, retos diarios/semanales, bono diario o ranking mensual.

Estas ideas pueden evaluarse en una fase posterior separada, después de medir el MVP.

## 7. Requisitos técnicos y activación controlada

### 7.1 Flag de despliegue

- El Pasaporte se controla con la variable de entorno del servidor `PASSPORT_ENABLED`. Está **apagado por defecto**; solo `on`, `true`, `1` o `yes` (sin distinguir mayúsculas y minúsculas y permitiendo espacios alrededor) lo activan. Cualquier otro valor, incluido uno ausente, lo deja apagado.
- Para activarlo en un despliegue, configura `PASSPORT_ENABLED=on` en el entorno del proceso Node y reinicia o redepliega el servidor. El flag se lee al arrancar; no cambia en caliente. `/healthz` informa el estado mediante el booleano `passportEnabled`.
- **Apagado:** no se conceden puntos, sellos ni desbloqueos nuevos; el servidor rechaza equipar o quitar cosméticos y no publica la identidad cosmética en las salas. La sección del Pasaporte y sus adornos visuales se ocultan en el perfil. La colección y el equipamiento guardado no se borran. El progreso temporal sigue el calendario mensual normal: si cambia el mes durante la pausa, los puntos y sellos se reinician como en cualquier cambio de temporada.
- **Encendido:** solo cuentan rondas elegibles liquidadas desde ese momento. Si se reactiva durante el mismo mes, se conserva el progreso de esa temporada; si cambió el mes mientras estuvo apagado, la temporada vigente empieza sin progreso. En ambos casos, no se acreditan rondas del período apagado.
- La interfaz consulta `/healthz` y se mantiene oculta si el servidor no confirma explícitamente `passportEnabled: true`; el control de elegibilidad y equipamiento permanece del lado del servidor.

### 7.2 Requisitos de progresión y persistencia

- La regla de elegibilidad debe conectarse al punto donde se resuelve una ronda, no al cliente ni a la fase de apuesta.
- La lógica de puntos y sellos debe ser pura y tener pruebas unitarias para cada juego, resultado y duplicado.
- Los campos nuevos del perfil deben normalizarse en el limpiador compartido para mantener paridad entre JSON y Postgres.
- El catálogo de cosméticos es una lista cerrada del servidor. El cliente solo solicita equipar un identificador ya obtenido.
- No guardar un historial ilimitado de eventos por ronda en cada perfil. La clave de liquidación usa un UUID de sesión de mesa más el número de ronda; cada perfil conserva una ventana acotada de los últimos 128 identificadores para rechazar repeticiones.
- Mantener separadas las recompensas del Pasaporte y las fichas, y no cambiar los campos del ranking mensual.

## 8. Criterios de aceptación

El MVP se considera listo cuando se verifica que:

- una ronda válida humana suma exactamente un punto y una ronda repetida no vuelve a sumarlo;
- ganar, perder o empatar aporta lo mismo, y aumentar la apuesta no aumenta el progreso;
- una persona obtiene como máximo un sello por juego y temporada;
- una persona puede completar los seis sellos jugando los seis juegos incluidos;
- el cambio de mes en la zona del casino reinicia puntos/sellos y conserva cosméticos desbloqueados;
- el perfil presenta temporada, progreso, requisitos y recompensas sin ambigüedad;
- solo se equipan objetos desbloqueados y valores incluidos en el catálogo;
- perfiles persistidos en archivo y Postgres conservan la misma forma de datos;
- pruebas de integración confirman que el cliente no puede otorgarse puntos ni desbloqueos;
- `PASSPORT_ENABLED` está apagado por defecto y los modos activado/desactivado se verifican: apagado impide progreso y equipamiento, oculta la identidad cosmética y esconde la sección del perfil sin borrar datos.

## 9. Fases de trabajo sugeridas

1. **Cerrar decisiones de producto:** duración, hitos definitivos, catálogo inicial y visibilidad de cosméticos.
2. **Progresión y persistencia:** campos normalizados, elegibilidad e idempotencia; pruebas unitarias y de stores.
3. **Desbloqueos y equipamiento:** catálogo fijo, validación de servidor y persistencia de selección.
4. **Perfil:** sección Pasaporte, sellos, hitos e inventario/equipamiento.
5. **Verificación y salida gradual:** pruebas unitarias/de integración para el flag apagado y encendido, revisión de saldos/ranking, prueba visual y activación controlada.

No se implementan clubes ni torneos como parte de estas fases.

## 10. Decisiones confirmadas para el MVP

La implementación adopta estas decisiones:

1. **Temporada mensual local**, alineada con el ranking del casino: sí.
2. **Solo recompensas cosméticas, sin fichas:** sí.
3. **Una ronda humana válida = un punto, sin multiplicador por importe ni victoria:** sí.
4. **Partidas contra bots cuentan para la persona real:** sí.
5. **Estadio/fútbol queda fuera hasta una fase posterior:** sí.
6. **Los cosméticos del Pasaporte se pueden mostrar en salas públicas:** sí, con opción de quitarlos en el perfil.
7. **Hitos 5 / 15 / 30 / 50 / 75 puntos, más insignia al completar los seis sellos:** sí; se usan los valores de la tabla como catálogo inicial del MVP.

El desarrollo autorizado implementa estas decisiones y mantiene los límites de alcance de las secciones 3 y 6.
