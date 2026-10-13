# Álbum de cartas — gachapón MonteCristo

**Estado:** implementado en la rama de trabajo. Activo por defecto; `CARD_GACHA_ENABLED=off` lo apaga (el servidor rechaza cápsulas nuevas y la interfaz deja de mostrar la pestaña).
**Naturaleza:** cosmético y virtual. Una cápsula cuesta **5.000 fichas virtuales** y solo añade una carta al álbum del perfil. No da fichas, no cambia las probabilidades de ninguna mesa y no modifica estadísticas, retos, logros ni el Pasaporte.

## 1. Catálogo

54 cartas únicas: los 52 naipes de la baraja (13 rangos × 4 palos) y 2 Jokers.

Cada carta combina tres capas visuales, todas estáticas en `public/card-album.css`:

| Capa | Qué define | Ejemplo |
| --- | --- | --- |
| Palo | Colores propios (`--gc-a`, `--gc-b`) | Picas azul acero · Corazones coral · Diamantes ámbar · Tréboles plata y azul (estilo escudo heráldico) · Jokers naranja |
| Rango | Motivo visual del arte | 2 órbitas · 3 olas · 4 retícula · 5 franjas · 6 anillos · 7 estrellas · 8 chevrones · 9 facetas · 10 sol · J escudo · Q corona · K cruces · A aurora |
| Rareza | Marco, brillo y animación | Común sobrio → Poco común cobre → Raro plata → Épico violeta → Legendario dorado → Mítico con aurora animada |

Como cada par palo + rango es único, no hay dos cartas con el mismo estilo. Los dos Jokers tienen motivo propio (Fuego y Abismo). Las cartas sin copias se muestran como siluetas con «Sin descubrir» hasta que se obtienen.

### Ilustraciones

Cada carta usa una ilustración en `public/assets/cards/<id>.jpg` (sin texto: el rango y el palo se superponen en HTML para que sean exactos). Si una carta no tiene archivo, el servidor envía `art: null` y la interfaz muestra el estilo CSS de respaldo.

Estado: 48 de 54 generadas. Completas: Picas, Corazones, Diamantes del 2 al J, Tréboles del 2 al J, los 2 Jokers. Pendientes (6): Diamantes Q, K, As y Tréboles Q, K, As. Entrega final prevista: 3 Diamantes y 3 Tréboles.

## 2. Rarezas y tasas

Las tasas se publican en la interfaz. Internamente son enteros en unidades de 0,01 % (10.000 unidades = 100 %), para que la suma sea exacta.

| Rareza | Cartas | Tasa del grupo | Tasa por carta |
| --- | --- | --- | --- |
| Común | 2, 3, 4, 5 (16) | 87,39 % | 5,46875 % |
| Poco común | 6, 7, 8, 9 (16) | 10 % | 0,625 % |
| Raro | 10, J (8) | 2 % | 0,25 % |
| Épico | Joker Fuego, Joker Abismo (2) | 0,5 % | 0,25 % |
| Legendario | Reina, Rey (8) | 0,1 % | 0,0125 % |
| Mítico | As (4) | 0,01 % | 0,0025 % |

Decisiones de diseño tomadas al cerrar las reglas:

- **Suma al 100 %.** Las tasas propuestas sumaban 92,61 %. El 7,39 % restante se sumó a las comunes (87,39 %).
- **Tasas por grupo.** El 0,5 % de Épico cubre los dos Jokers; el 0,1 % de Legendario cubre Reina y Rey; el 0,01 % de Mítico cubre las cuatro Ases.
- **Jota (J).** La lista original no asignaba la J. Se colocó en Raro junto al 10, para que el grupo tenga 8 cartas.

## 3. Sorteo y seguridad

- El sorteo ocurre **solo en el servidor**, con `crypto.randomInt` (CSPRNG). El navegador no envía ni la rareza ni la carta.
- El cobro usa un débito real y todo o nada: si no alcanza el saldo, no se sortea nada ni se modifica el perfil.
- El evento `card_gacha_pull` sigue el mismo criterio de perfil que el bono diario: la mesa del jugador o la cuenta autenticada.
- Cada cápsula queda en el historial de fichas del perfil como `Cápsula de cartas`, con su importe de −5.000.
- El álbum se guarda en `profile.cardAlbum.counts` y pasa por `cleanProfile`, así que funciona igual con el archivo JSON que con Postgres (sin migración). Solo se guardan ids del catálogo y se limita a 999 copias por carta.

## 4. Uso responsable

- Es opcional: solo se abre con el botón del álbum; nada se compra automáticamente.
- Las tasas están visibles antes de cada cápsula.
- No hay compras con dinero real ni canje por fichas: el resultado no tiene valor fuera del perfil.
- Pendiente de decidir por el equipo: un tope diario de cápsulas, si se desea reforzar la protección frente a uso compulsivo.

## 5. Piezas técnicas

- `lib/card-gacha.js`: catálogo, tasas, sorteo y saneado del álbum.
- `lib/progression.js`: `openCardCapsule` (cobro + sorteo) y `cardAlbum` en `publicProgress` (solo para el dueño).
- `lib/profile-store-shared.js`: saneado de `cardAlbum` en `cleanProfile`.
- `server.js`: evento `card_gacha_pull` y `cardGachaEnabled` en `/healthz`.
- `public/index.html`, `public/app.js`, `public/card-album.css`: pestaña «Álbum», tasas, cuadrícula y filtros por rareza.
- `public/assets/cards/`: ilustraciones de las cartas.
- `tests/card-gacha.test.js`: catálogo, tasas exactas, enumeración del sorteo, cobro, errores y privacidad.
