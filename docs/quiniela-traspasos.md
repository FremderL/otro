# Quiniela y traspasos: estado actual

## Traspasos

El mercado muestra cuatro cambios entre cuatro clubes ficticios, como dos
intercambios de mediocampistas. Se anuncia desde el día 15 en horario de Ciudad
de México. El plan se deriva de la temporada actual de forma determinista y no
muta sus partidos, jugadores ni cuotas. Al generar la temporada inmediatamente
siguiente, se conservan identidades y atributos de toda la plantilla, se ponen las
estadísticas de temporada en cero y se intercambian los cuatro jugadores. Cada
club conserva 18 jugadores, dorsales sin repetir y sus delanteros originales.
Si falta una temporada previa consecutiva y válida, no se inventan traspasos.
Las 16 identidades se sirven con sus escudos en la vista de mercado.

Pruebas: generación, fechas, no mutación, identidad, JSON, socket, interfaz y
una prueba aislada que guarda y recarga temporadas en PostgreSQL real. No se ha
validado la concurrencia entre varias instancias ni un despliegue real.

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
