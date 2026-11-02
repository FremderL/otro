# Plantillas e identidad del Estadio

Cada temporada guarda sus 16 plantillas de 18 jugadores en `league.config`.
Ese registro —no el prefijo del ID ni el dorsal— determina el club actual. Los
nombres, IDs, posiciones y atributos ya se generan en la primera temporada y
se conservan desde la plantilla anterior. No se renombran jugadores de ligas
existentes ni se modifican partidos ya comprometidos. Cada jugador tiene seis
atributos: ritmo, tiro, pase, defensa, portería y agresividad.

En la columna de posiciones, «Plantillas y estadísticas» permite elegir un club
y consultar las 18 fichas, con dorsal, ID, atributos, valor orientativo y
acumulados de partidos regulares asentados. Los acumulados se calculan a partir
de `fantasyStats` verificado, no del campo histórico `player.season` (que no se
actualiza). Si faltan registros o detalles de partidos antiguos se indica que
son parciales; no se extrapolan ni se inventan resultados. La pantalla se puede
actualizar manualmente y usa siempre la temporada actual del servidor.

El mercado conserva la identidad al cambiar de club y asigna al fichaje el
número liberado en su nuevo equipo. Los movimientos anunciados solo se aplican
al generar la temporada siguiente. Si faltan meses intermedios se mantiene el
último plantel guardado sin inventar acuerdos; una plantilla anterior inválida
impide generar la temporada, en lugar de reutilizar IDs con otros nombres.

El catálogo es específico de la liga almacenada: un despliegue que parte sin
historial genera sus propios nombres deterministas. Los datos ya guardados y los
compromisos V2 no se migran ni se reescriben. El traspaso previsto se consulta
por separado en la conferencia; el catálogo muestra el club efectivo actual.
