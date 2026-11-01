# Vista aislada del Estadio V2

Esta vista abre la **interfaz y el servidor reales del Estadio**, utilizando el motor oficial configurado en `lib/football/v2/versions.js`, sus snapshots, relato y mercados. El reloj se adelanta a noviembre de 2026 y se preparan resultados históricos, perfiles y fichas **ficticios** en un directorio temporal. No usa `DATABASE_URL`, datos de producción ni cuentas reales. Las apuestas que se hagan aquí son pruebas aisladas y desaparecen al detener la vista.

```sh
npm ci
PORT=3001 node preview/estadio-v2/server.js
```

Abrir `http://localhost:3001/`. Se abre automáticamente un partido en vivo y los demás comienzan a intervalos. El proxy inserta un aviso de prueba y conecta un perfil ficticio en el origen de la vista para evitar el acceso con cuentas reales; no modifica la aceptación de términos del sitio de producción. El servidor completo y su socket son privados: solo el proxy escucha en el puerto público. La vista conserva el ritmo oficial, por lo que no incluye los controles de velocidad del laboratorio local anterior.

## Reloj acelerado (opcional)

```sh
ESTADIO_PREVIEW_SPEED=4 node preview/estadio-v2/server.js
```

`ESTADIO_PREVIEW_SPEED` fija los segundos reales por minuto simulado (por
defecto, el ritmo oficial de 15 s/min). Sirve para revisar jugadas concretas —un
gol, un cambio, una falta y su relato— sin esperar el partido completo: con
`4`, un encuentro dura unos seis minutos y los siguientes se encadenan al
terminar el anterior en vez de dejar huecos de doce minutos. Solo afecta a esta
vista aislada; no cambia el motor, las cuotas ni el servidor de producción.
