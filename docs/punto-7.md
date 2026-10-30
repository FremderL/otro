# Cambios adicionales y límites operativos

- **Horarios**: cada jornada nueva se genera a las 13:00, 14:00 y 15:00;
  17:00, 18:00 y 19:00; y 20:30 y 21:30 (destacado), en
  `America/Mexico_City`. En un día doble la segunda jornada inicia 30 minutos
  después de cada partido de la primera. J30 queda en día sencillo. Las
  temporadas ya guardadas mantienen sus horarios para no alterar partidos,
  apuestas y promociones existentes.
- **Destacados**: se generan únicamente al asentar un partido regular con su
  cronología y alineaciones reales; incluyen goles y asistencias, hasta tres
  jugadas y figura estadística. El resumen se guarda con el resultado, se
  muestra después del final y puede narrarse con una voz es-MX del dispositivo.
  Si el navegador no tiene esa voz, sigue disponible como texto. No se inventan
  resúmenes para partidos anteriores sin fuente verificada ni para desempates.
- **Balón de Oro**: la finalización programada conserva las 22:00 posteriores
  al último partido, con retraso al siguiente día si termina a las 22:00 o
  después. La inauguración inicial y la ceremonia final mantienen sus reglas.
- **Torneos relámpago**: se conservan premios por persona y se señalan como
  compartidos los lugares empatados por ronda; hay pruebas existentes.
- **Moderación**: reportes, evidencias, sanciones y auditoría tienen migración
  para PostgreSQL y prueba real aislada. El área administrativa no se activa
  solo por incorporar código; debe ejecutarse la migración y cumplir la
  configuración segura del entorno.

Los límites de Rueda, Lotería, Quiniela y Mi afición figuran por separado en
`docs/estado-integracion.md`. No se realizó despliegue de producción.
