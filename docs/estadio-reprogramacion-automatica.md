# Reprogramación automática de kickoff

Cada cinco segundos se revisan los partidos programados. Si uno sigue sin señal
persistida de inicio dos minutos después de su hora, se propone una nueva hora
30 minutos después de la detección. Al confirmarse el guardado se notifica a la
sala y al lobby. Si vuelve a fallar, el proceso puede volver a reprogramarlo tras
el mismo margen; la reprogramación no repara por sí sola la causa del bloqueo.

Se conservan el ID, los boletos ya aceptados y, si existe, el compromiso V2 con
sus entradas, cuotas y semilla. No se cambia un resultado asentado. Un partido
con estado en juego, `actualKickoffAt` o una apuesta en vivo registrada sigue la
recuperación normal, no esta política. Al reiniciar se conserva como programado
un encuentro vencido sin esas señales, en vez de liquidarlo por el reloj.

No se exponen jugadas ni marcador de un partido aún programado. Como las
versiones anteriores pudieron haber mostrado parte del replay antes de la
corrección, se suspenden nuevas apuestas del partido (incluido en vivo) y las
nuevas predicciones de temporada hasta que termine o se posponga. La quiniela
no reabre una jornada que incluya un encuentro reprogramado. Las apuestas y
predicciones anteriores siguen su flujo normal de liquidación.

Si la persistencia no confirma la operación, no se anuncia el nuevo horario ni
se permite arrancar el partido: se reintenta. En el límite entre temporadas,
si +30 minutos cruzaría a otro mes, se mantiene pendiente y se registra
`football_auto_reschedule_season_boundary` para revisión; no se mueve a otra
liga. También se registran `football_auto_rescheduled` y
`football_auto_reschedule_persist_error` para diagnóstico.

**Limitación de datos anteriores:** un estado antiguo `scheduled` sin hora real
ni apuestas en vivo no demuestra por sí solo que nadie hubiera visto el inicio
antes de una caída. Por ello no se reabre el mercado, pero puede ser necesario
revisar los registros del servidor para determinar lo ocurrido en un caso real.
