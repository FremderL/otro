# Calendario estacional del lobby

La decoración del lobby se configura desde **Administración → Temporadas**. El calendario contiene una configuración independiente para cada mes; al iniciar un mes nuevo se elige automáticamente su tema de acuerdo con `CASINO_TIME_ZONE` (por defecto, `America/Mexico_City`). La rotación empieza apagada y un administrador con MFA puede activarla, desactivar meses, elegir otro diseño y ajustar animación e intensidad antes de guardar.

## Diseños iniciales

| Mes | Diseño | Animación predeterminada |
| --- | --- | --- |
| Enero | Brindis dorado | Destellos |
| Febrero | Noche de los corazones | Corazones |
| Marzo | Jardín de primavera | Pétalos |
| Abril | Lluvia de cristal | Lluvia |
| Mayo | Luna de flores | Pétalos |
| Junio | Solsticio esmeralda | Luciérnagas |
| Julio | Jardín de luciérnagas | Luciérnagas |
| Agosto | Lluvia de estrellas | Estrellas fugaces |
| Septiembre | Noche tricolor | Confeti |
| Octubre | Noche de Halloween | Brasas |
| Noviembre | Altar de cempasúchil | Cempasúchil |
| Diciembre | Invierno esmeralda | Nieve |

Cualquier mes puede usar cualquiera de los doce diseños, además de elegir `Automática`, `Sin animación` u otra animación disponible. La intensidad puede ser **Sutil** o **Festiva**. Las fechas opcionales de inicio y fin pausan el calendario completo; se introducen en la zona horaria local del navegador administrador, mientras que los cambios de mes siempre siguen la zona del casino.

## Operación y seguridad

- La API pública es de solo lectura y devuelve el tema vigente, el mes de calendario y la hora del siguiente cambio.
- Las escrituras administrativas requieren permiso específico, MFA reciente, origen válido, CSRF e idempotencia; cada actualización deja auditoría del calendario.
- Las preferencias y doce configuraciones se guardan en el estado de comunidad JSON o Postgres. La primera lectura migra de manera segura una configuración antigua de tema único al mes en que se actualizó.
- Un identificador de zona horaria de despliegue inválido usa UTC como último recurso para que no falle el servidor.
- El lobby respeta `prefers-reduced-motion`; las partículas no capturan interacciones y la capa visual se oculta mientras se juega en una mesa.
