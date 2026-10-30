# Escudos del Estadio

Los 16 clubes ficticios tienen un SVG local y autocontenido en
`public/assets/escudos/`, identificado por su abreviatura visible. Son
ilustraciones creadas para estos clubes ficticios, no los escudos oficiales de
los clubes que inspiran sus nombres. No se cargan imágenes de terceros.

Los escudos se muestran en partidos, posiciones, marcador y comparativa;
Quiniela y traspasos; selección, confirmación, ranking y pines de Mi afición;
y la selección de jugadores de Mi Once. También aparecen en la tabla,
inauguración, nominados, revelaciones, recibos y archivo del Balón de Oro,
y en las apuestas abiertas, liquidadas, futuras y combinadas del historial.
En los controles nativos de selección el escudo se muestra junto al club ya
seleccionado, porque los elementos `<option>` no admiten imágenes portables.
Los subtítulos, las locuciones, las etiquetas accesibles y las transcripciones
permanecen como texto; el escudo es decorativo y no sustituye el nombre.

Las pruebas verifican los 16 archivos y asociaciones, imágenes y nombres en
las vistas principales, menú de afición, historial, inauguración y archivo,
así como que no se revele antes de tiempo al ganador. El uso en producción
sigue sujeto a la activación independiente del Estadio ya acordada.
