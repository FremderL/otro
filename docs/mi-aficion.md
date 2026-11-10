# Mi afición (alcance actual)

Una adhesión privada de club se guarda en el perfil; no acepta ni publica
identificadores de otras personas. Cuenta victorias de liga asentadas desde la
adhesión, con los resultados conservados de las temporadas. Excluye empates,
partidos sin resultado asentado y desempates. Los niveles se alcanzan con 0,
1, 3, 5, 10 y 20 victorias, además de la insignia conmemorativa de campeón
cuando el club apoyado gana una liga liquidada tras la adhesión. La clasificación por clubes es opcional y revocable y
solo publica club, suma de victorias, número de participantes e hitos agregados para *MonteCristo News*.

El cambio de club requiere confirmación explícita y compara el club actual con
el esperado para evitar un cambio con una pantalla desactualizada. La adhesión,
sus victorias, nivel, títulos y pines quedan reemplazados, incluso si se vuelve al club;
el ranking se desactiva hasta que se active de nuevo. No modifica Mi Once,
saldo ni la colección independiente. Los retos de lealtad (1, 3, 5, 10 y 20
victorias oficiales desde la adhesión, más el título oficial de liga) desbloquean pines con marco progresivo y títulos equipables de hincha, además del
pin básico del club y dos estandartes de perfil: el **Estandarte oficial del club** (`club-banner`, con el escudo SVG y colores del club sobre arte de seda) y el **Estandarte de Campeón Vigente** (`champion-banner`, temporal con laureles dorados, disponible únicamente mientras el club sea el campeón de la última liga liquidada y solo para hinchas cuya adhesión sea previa o igual al cierre de ese título). Los pines, títulos y banners se equipan en Mi afición (y los banners también desde el Perfil del Casino) y se muestran en mesas
del Casino, el perfil, el **Ranking del mes**, la Lotería, la cabecera y la grada del Estadio; no tienen valor en fichas (ver `docs/recompensas-clubes.md`).
Las victorias y temporadas campeonas procesadas se guardan en el perfil para conservar el progreso
cuando se archivan temporadas. Cambiar de club borra el progreso y retira el pin, el título y el banner.

La versión JSON usa `persistProfile` con reemplazo de archivo, y PostgreSQL usa
el UPSERT confirmado existente del perfil. Los tests cubren perfil JSON, handlers de Socket.IO e interfaz, y también
una prueba aislada de persistencia con PostgreSQL real. No se ha demostrado
seguridad frente a múltiples procesos que escriban el mismo perfil concurrentemente. En modo de sesión verificada se usa el perfil de la
sesión; el modo legado conserva el riesgo de suplantación documentado. Ante un
fallo de confirmación se informa al usuario y se debe volver a consultar el
perfil, porque el guardado de fondo podría terminar después.

Esta función no implementa Lotería, Quiniela ni traspasos. Rueda se integra por separado en el Casino. El flag
`FOOTBALL_ENABLED` permanece apagado por defecto en producción.
