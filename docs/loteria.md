# Lotería mexicana: implementación en curso

Las reglas acordadas son: entrada de 50 fichas virtuales, inscripción de 60
segundos, dos a cien personas, cartón de 16 cartas, canto cada dos segundos y
victoria con cartón completo. Si hay empate, se reparten fichas enteras iguales
y el sobrante se conserva para la siguiente partida. El marcado es automático.
Si alguien se desconecta antes del cierre, su entrada se cancela y reembolsa;
después del cierre, su cartón continúa participando y conserva su derecho al
premio. Si al cierre no hay dos participantes, se reembolsan las entradas y se
conserva el acumulado previo.

`lib/loteria/game.js` implementa una máquina de reglas sin efectos económicos:
baraja criptográfica, cartones privados, avance por reloj, cancelación y reparto.
El test cubre límites, privacidad, desconexión, simultaneidad de ganadores,
repetición de liquidación y acumulado. Las salidas `debit`, `refund`, `winners`
y `carry` **no** han sido conectadas a saldos: no son prueba de cobro ni pago.

`lib/loteria/pg-store.js` es un adaptador experimental, **no conectado al
servidor**. En un esquema PostgreSQL aislado se probaron el débito y el asiento
juntos, reintentos concurrentes, reembolso, reapertura de estado desde SQL,
liquidación repetida y rollback completo ante un fallo de pago. Estas pruebas no
validan aún la integración con el resto de la aplicación ni sustituyen pruebas
de interrupción de proceso o del cierre mensual.

Pendiente para ser jugable: un servicio compartido con inscripción autenticada,
Socket.IO y pantalla accesible; un diario persistente con transacción atómica
para saldos y estado de cada ronda, pagos y sobrantes idempotentes, recuperación
tras interrupción en cada fase, límites de concurrencia, control del cierre
mensual y pruebas con PostgreSQL real. También se requiere resolver la escritura
en segundo plano de instantáneas de perfiles para que no sobrescriba saldos de
transacciones más recientes. No habilitar la tarjeta hasta superar esas pruebas.
