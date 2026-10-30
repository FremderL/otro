# Mi afición (alcance actual)

Una adhesión privada de club se guarda en el perfil; no acepta ni publica
identificadores de otras personas. Cuenta victorias de liga asentadas desde la
adhesión, con los resultados conservados de las temporadas. Excluye empates,
partidos sin resultado asentado y desempates. Los niveles se alcanzan con 0,
1, 3 y 5 victorias. La clasificación por clubes es opcional y revocable y
solo publica club, suma de victorias y número de participantes.

El cambio de club requiere confirmación explícita y compara el club actual con
el esperado para evitar un cambio con una pantalla desactualizada. La adhesión,
sus victorias, nivel y pines quedan reemplazados, incluso si se vuelve al club;
el ranking se desactiva hasta que se active de nuevo. No modifica Mi Once,
saldo ni la colección independiente. Los tres retos son obtener 1, 3 y 5
victorias oficiales desde la adhesión. Cada reto desbloquea un pin, además del
pin básico del club. Los pines se equipan en Mi afición y se muestran en mesas
del Casino, el perfil y la cabecera del Estadio; no tienen valor en fichas.
Las victorias procesadas se guardan en el perfil para conservar el progreso
cuando se archivan temporadas. Cambiar de club borra el progreso y retira el pin.

La versión JSON usa `persistProfile` con reemplazo de archivo, y PostgreSQL usa
el UPSERT confirmado existente del perfil. Los tests cubren perfil JSON, handlers de Socket.IO e interfaz, y también
una prueba aislada de persistencia con PostgreSQL real. No se ha demostrado
seguridad frente a múltiples procesos que escriban el mismo perfil concurrentemente. En modo de sesión verificada se usa el perfil de la
sesión; el modo legado conserva el riesgo de suplantación documentado. Ante un
fallo de confirmación se informa al usuario y se debe volver a consultar el
perfil, porque el guardado de fondo podría terminar después.

Esta función no implementa Lotería, Quiniela ni traspasos. Rueda se integra por separado en el Casino. El flag
`FOOTBALL_ENABLED` permanece apagado por defecto en producción.
