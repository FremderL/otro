# Ticket 01 · Alcance y requerimientos de la página

| Campo | Valor |
| --- | --- |
| **ID** | DOC-01 |
| **Tipo** | Documento base |
| **Estado** | Propuesta · listo para implementar |
| **Prioridad** | Alta · **bloquea a los demás tickets** |
| **Depende de** | — |
| **Desbloquea** | DOC-02 (reglas y pagos), DOC-03 (modelo de datos), DOC-04 (arquitectura), README |
| **Decide** | juegos incluidos, jugadores por sala y qué puede hacer cada rol |

> **Este es el documento base del proyecto.** Cualquier duda posterior se resuelve contra lo que dice aquí.
> Si algo cambia, se cambia primero aquí y luego se propagan los números a `02-reglas-y-pagos.md`.

---

## 1. Qué es la página

Una **aplicación web de casino social** para jugar entre amigos en tiempo real. Una persona crea una
sala, recibe un enlace o un código corto, lo comparte y hasta seis personas juegan juntas en el
mismo navegador.

- Es **multijugador en tiempo real**: lo que hace uno lo ven todos al instante.
- Es **social**: sala, chat y ranking de fichas entre los participantes.
- Es **100 % virtual**: las fichas no son dinero, no se compran, no se venden y no se canjean.
- Se usa **solo desde computadora** (escritorio o laptop); no hay versión de celular en la v1.

**Propuesta de nombre:** *MonteCristo* (mismo nombre del repo original; cámbialo si el nuevo
repositorio usa otro).

---

## 2. Alcance de la versión 1

### Sí incluye

1. Registro ligero de jugador (nombre + avatar, sin contraseña).
2. Crear sala, entrar con código o enlace, salir y reconectar.
3. Cinco juegos: **Cara o Cruz, Dados, Ruleta, Blackjack/21 y Texas Hold'em**.
4. Apuestas con fichas virtuales y liquidación automática al final de cada ronda.
5. Chat de sala con mensajes rápidos.
6. Saldo persistente por dispositivo durante la sesión del servidor.
7. Estado autoritativo en el servidor (el navegador nunca decide resultados).
8. **Base de datos SQLite local**: un solo archivo (`data/casino.db`) con las tablas `jugadores`,
   `salas`, `partidas` y `apuestas`. No hay servidor de base de datos que instalar.
9. **Ejecución 100 % local**: un solo proceso de Node en la computadora de quien arranca el
   servidor; se abre en `http://localhost:3000`. No hace falta internet para jugar.

### No incluye (queda para versiones posteriores)

- Dinero real, depósitos, retiros, compras dentro de la app o premios canjeables.
- Cuentas con correo, contraseña, recuperación o verificación en dos pasos.
- Versión móvil o responsiva para celular.
- **Despliegue, hosting, dominio, túneles (ngrok y similares), contenedores ni servicios en la
  nube.** El proyecto se desarrolla y se usa en local; el estado muere con el proceso si no se
  activa el snapshot en disco.
- Bots que ocupen asientos libres.
- Torneos, ligas, ranking global, temporadas y misiones.
- Tragamonedas, jackpots, eventos especiales, colección cosmética o pasaporte.
- Modo espectador y salas públicas con lista tipo lobby.

---

## 2.1 Punto de partida del repositorio

El nuevo repositorio arranca **desde cero**. Lo único que ya existe es:

- `public/assets/` — imágenes de los juegos y del casino, que la interfaz debe reutilizar.
- `docs/` — esta documentación (los tickets).

No existe `package.json`, ni `server.js`, ni HTML alguno: todo se construye a partir de estos
tickets. Ningún documento puede dar por hecho que hay código previo, dependencias instaladas o
base de datos configurada.

---

## 3. Juegos incluidos

| # | Juego | Ronda típica | Jugadores activos | Quién inicia la ronda | Resumen |
| --- | --- | --- | --- | --- | --- |
| 1 | **Cara o Cruz** | 5–10 s | 1 a 6 | Anfitrión | Cada quien elige cara o cruz y apuesta; se lanza una moneda. |
| 2 | **Dados** | 5–10 s | 1 a 6 | Anfitrión | Se apuesta a bajo (1–3), alto (4–6) o a un número exacto del 1 al 6. |
| 3 | **Ruleta** | 15–30 s | 1 a 6 | Anfitrión | Paño europeo (0–36): color, paridad, rango, docenas, columnas o pleno. |
| 4 | **Blackjack / 21** | 1–3 min | 1 a 6 | Anfitrión | Todos contra la casa: pedir, plantarse, doblar, dividir y seguro. |
| 5 | **Texas Hold'em** | 2–5 min | 2 a 6 | Anfitrión | Ciegas 10/20, cuatro calles de apuestas y showdown con botes. |

Los **juegos rápidos** son Cara o Cruz, Dados y Ruleta: todos apuestan al mismo tiempo, un solo
lanzamiento y liquidación inmediata para toda la sala.

---

## 4. Salas

| Regla | Valor |
| --- | --- |
| Jugadores por sala | **6 como máximo** (mínimo 1 para que la sala exista) |
| Mínimo para jugar | 1 en juegos rápidos y blackjack · **2 en Texas Hold'em** |
| Código de sala | **5 caracteres** alfanuméricos en mayúsculas (ej. `K7Q2M`), único entre salas activas |
| Acceso | Enlace directo `/sala/K7Q2M` o escribiendo el código en el inicio |
| Juego por sala | **Uno solo**, elegido al crearla; no se cambia con la sala llena |
| Duración | La sala se elimina automáticamente cuando queda vacía |
| Estado de la sala | `abierta` o `cerrada` | `cerrada` cuando el anfitrión la cierra o se vacía |
| Fase de la ronda | `espera` → `apuestas` → `jugando` → `resultados` → (nueva ronda) | Es la que usa el motor de juego |

Cada sala tiene un **anfitrión**: la persona que la creó. Si el anfitrión se desconecta más de
60 segundos, el rol pasa automáticamente al siguiente jugador conectado.

---

## 5. Roles

### Anfitrión (host)

Es un jugador más: apuesta, juega y gana o pierde igual que los demás. Además es el único que:

- Crea y cierra la sala.
- Inicia cada ronda (**repartir** en blackjack y póker, **lanzar** en los juegos rápidos).
- Expulsa a un jugador de la sala.

### Jugador (player)

Cualquier persona que se unió a la sala y ocupa un asiento.

### Espectador

**No existe en la v1.** Las salas llenas simplemente rechazan la entrada con el mensaje
«Sala llena (máximo 6)».

---

## 6. Qué puede hacer cada persona

### Anfitrión

| # | Acción | Cuándo |
| --- | --- | --- |
| 1 | Crear sala eligiendo juego | Siempre |
| 2 | Compartir enlace o código de 5 caracteres | Siempre |
| 3 | Apostar y jugar sus propias manos/rondas | Igual que cualquier jugador |
| 4 | **Iniciar la ronda** (lanzar la moneda/dado/ruleta o repartir cartas) | Cuando al menos una persona apostó |
| 5 | **Abrir la siguiente ronda** tras ver resultados | En fase `resultados` |
| 6 | Expulsar a un jugador | Fase `espera` o `resultados` |
| 7 | Cerrar la sala | Fase `espera` o `resultados` |
| 8 | Escribir en el chat y usar mensajes rápidos | Siempre |

### Jugador

| # | Acción | Cuándo |
| --- | --- | --- |
| 1 | Entrar con enlace o código | Si hay asiento libre |
| 2 | Ver la sala: asientos, fichas, apuestas, turno y resultados | Siempre |
| 3 | **Elegir opción y confirmar una apuesta por ronda** | Fase `apuestas` |
| 4 | Jugar su turno: pedir, plantarse, doblar, dividir (blackjack) o pasar/igualar/subir/retirarse (póker) | Cuando es su turno |
| 5 | Ver **solo sus cartas**; las ajenas llegan boca abajo | Siempre |
| 6 | Salir de la sala (se le reembolsa la apuesta si la ronda no se lanzó) | Entre rondas o en `espera` |
| 7 | Reconectar y recuperar su asiento y su saldo | Siempre |
| 8 | Escribir en el chat y usar mensajes rápidos | Siempre |

### Servidor (no es una persona, pero conviene dejarlo claro)

| # | Responsabilidad |
| --- | --- |
| 1 | Generar **todos** los resultados (moneda, dado, ruleta, cartas). |
| 2 | Validar turno, fase, monto y saldo antes de aceptar cualquier acción. |
| 3 | Calcular y acreditar los pagos con las tablas de `02-reglas-y-pagos.md`. |
| 4 | Difundir el estado actualizado a toda la sala tras cada evento. |
| 5 | Aplicar los tiempos de turno y las acciones automáticas por inactividad. |
| 6 | **Nunca** enviar a un cliente las cartas de otro jugador. |

---

## 7. Reglas transversales (aplican a todos los juegos)

| Concepto | Valor | Nota |
| --- | --- | --- |
| Saldo inicial | **1.000 fichas** | Se asigna al entrar por primera vez |
| Apuesta mínima | **10 fichas** | Todas las apuestas y ciegas |
| Apuesta máxima | **El saldo disponible del jugador** | No hay tope de mesa en la v1 |
| Apuestas por ronda | **1 por jugador** | No se puede cambiar ni cancelar tras confirmar |
| Cobro de la apuesta | Al confirmar | Las fichas salen del saldo en ese momento |
| Acreditación del pago | Al liquidar | `pago = apuesta × multiplicador` |
| Fichas | Enteras, sin decimales | Si un pago da fracción, se redondea hacia abajo |
| Saldo negativo | Imposible | El servidor rechaza apostar más de lo que se tiene |
| Tiempo de turno | **25 s** en blackjack · **30 s** en póker | Juegos rápidos: sin reloj |
| Inactividad en el turno | Blackjack: se planta · Póker: pasa si puede, si no se retira | Lo ejecuta el servidor |
| Baraja | Blackjack: 4 barajas (208 cartas) · Póker: 1 baraja (52 cartas) | Se rebaraja al quedarse corta |
| Resultados | Los decide **el servidor** | El cliente solo anima el resultado recibido |
| Privacidad de cartas | Cada cliente recibe únicamente las suyas | En póker y blackjack |
| Chat | Texto libre + mensajes rápidos, solo dentro de la sala | Máximo 200 caracteres por mensaje |
| Dinero real | **Ninguno** | Aviso visible en el pie de la página |
| Entorno | **Local** | Corre en `http://localhost:3000`; sin hosting, dominio ni túnel |
| Pantalla | **1024 px de ancho o más** | Solo escritorio y laptop; no hay versión de celular |
| Recursos | **Todos locales** | Imágenes de `public/assets/`, tipografías del sistema; sin CDNs ni peticiones externas |
| Datos | **En la propia máquina** | SQLite en `data/casino.db`; el respaldo JSON queda opcional |

---

## 8. Flujo de una sala (de principio a fin)

1. **Inicio:** la persona escribe su nombre y elige un avatar.
2. **Crear sala:** elige el juego; el servidor devuelve el código de 5 caracteres y el enlace.
3. **Invitar:** comparte el enlace; hasta 5 personas más entran.
4. **Fase `apuestas`:** cada quien elige una opción y un monto y confirma.
5. **Fase `jugando`:** el anfitrión lanza o reparte; el servidor genera el resultado y, en
   blackjack y póker, va turno por turno.
6. **Fase `resultados`:** el servidor liquida y acredita; se muestran ganancia/pérdida y el
   ranking de la sala.
7. **Nueva ronda:** el anfitrión abre la siguiente; se vuelve al paso 4.
8. **Salida:** al salir se liberan el asiento y las apuestas pendientes; si la sala queda vacía,
   se elimina.

---

## 9. Criterios de aceptación

- [ ] Una sala acepta exactamente hasta **6 jugadores** y rechaza el séptimo con un mensaje claro.
- [ ] El código de sala tiene **5 caracteres** y funciona tanto por enlace como escrito a mano.
- [ ] Los **5 juegos** son seleccionables al crear la sala y cada uno corre su propia ronda.
- [ ] Cada jugador confirma **una sola apuesta por ronda**; un segundo intento se rechaza.
- [ ] Nadie puede apostar menos de **10 fichas** ni más de su saldo.
- [ ] Solo el **anfitrión** puede lanzar/repartir; cualquier otro intento se rechaza.
- [ ] Los resultados los genera **el servidor**: dos clientes distintos reciben siempre el mismo.
- [ ] En póker y blackjack **ningún cliente recibe cartas ajenas** antes del showdown o del cierre.
- [ ] Al salir antes del lanzamiento se **reembolsa** la apuesta; al salir en juego, no.
- [ ] Si el anfitrión se desconecta **60 s**, el rol migra a otro jugador conectado.
- [ ] La página muestra de forma permanente que **no hay dinero real** de por medio.

---

## 10. Decisiones tomadas y pendientes

### Tomadas en este documento

| Decisión | Motivo |
| --- | --- |
| 6 jugadores por sala | Mesa suficiente para póker sin que el turno sea lento |
| 5 juegos (Cara o Cruz, Dados, Ruleta, Blackjack, Texas Hold'em) | Cubren rápidos, de cartas y de mesa |
| Un solo juego por sala | Simplifica el estado y la interfaz |
| Base de datos **SQLite en archivo local** | Persistencia real sin instalar ni configurar un servidor de base de datos |
| Saldo inicial 1.000 y apuesta mínima 10 | Deja margen para ~100 apuestas mínimas |
| El anfitrión también juega | Evita mesas con una persona fuera de la partida |

### Pendientes (decidir antes de programar)

1. ¿El saldo se conserva al reiniciar el servidor o vuelve a 1.000? → **decidido: se conserva,
   porque ahora hay base de datos SQLite (`data/casino.db`)**.
2. ¿Se guarda el historial de rondas o solo el saldo actual? → **propuesta: solo saldo + últimas
   20 rondas en memoria**.
3. ¿Límite de salas simultáneas por servidor? → **propuesta: 50**.
4. Idioma de la interfaz: **español (México)**.
