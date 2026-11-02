# Reprogramación automática y cierre de kickoffs vencidos

Cada cinco segundos (y al reactivarse el servidor tras inactividad) se revisan
los partidos programados que superaron su hora sin señal persistida de inicio
(`actualKickoffAt` ni apuestas en vivo):

- **Dentro de los primeros 30 minutos posteriores a la hora prevista** (desde 2
  minutos de margen de kickoff hasta 30 minutos después del horario original):
  el partido se reprograma para **30 minutos después de la detección**
  (`football_auto_rescheduled`). Al confirmarse el guardado se notifica a la
  sala y al lobby.
- **Si superó la ventana de 30 minutos** (ya sea con el servidor encendido o al
  despertar tras haberse apagado/suspendido por inactividad durante horas o días):
  **no se reprograma ni se reproduce en vivo**. Se obtienen directamente los
  resultados y estadísticas necesarias del encuentro (ganador, marcador final y
  al descanso, goles y asistencias, primer goleador, faltas, tarjetas, archivo de
  Mi Once, destacados, tabla, ratings y acumulado del Balón de Oro) y se asienta
  de inmediato (`settled`), liquidando boletos y quiniela (`football_overdue_settled`).

Se conservan el ID, los boletos ya aceptados y, si existe, el compromiso V2 con
sus entradas, cuotas y semilla. Si el servidor estuvo suspendido más allá del
horizonte previo de 24 horas en V2, los encuentros vencidos se preparan y
asientan por orden cronológico de jornada antes de rotar temporada o preparar el
horizonte próximo. Un partido con estado en juego, `actualKickoffAt` o una
apuesta en vivo registrada sigue la recuperación normal.

Mientras un encuentro reprogramado sigue pendiente, no se exponen jugadas ni
marcador y se suspenden nuevas apuestas del partido (incluido en vivo) y las
nuevas predicciones de temporada hasta que termine o se posponga. La quiniela
no reabre una jornada que incluya un encuentro reprogramado. Las apuestas y
predicciones anteriores siguen su flujo normal de liquidación.

Si la persistencia no confirma una reprogramación, no se anuncia el nuevo
horario ni se permite arrancar el partido: se reintenta mientras permanezca
dentro de la ventana de 30 minutos y, si la supera, pasa a liquidación directa.
En el límite entre temporadas, si +30 minutos cruzaría a otro mes, se mantiene
pendiente dentro de los primeros 30 minutos (`football_auto_reschedule_season_boundary`)
y, superado ese margen, se liquida dentro de su propia temporada.
