# Mantenimiento trimestral — MonteCristo

Rutina de la fase 9.4. Repetir **cada 3 meses** (o antes si GitHub avisa de una
vulnerabilidad). Última ejecución: **2026-09-28** (express 4.22.3, socket.io 4.8.4,
compression 1.8.2 — `npm audit` en 0 vulnerabilidades).

## 1. Dependencias

```bash
npm outdated            # ¿qué hay de nuevo?
npm audit               # ¿hay vulnerabilidades?
npm audit fix           # parches seguros (no cambia versiones mayores)
npm update express socket.io socket.io-client compression pg
npm test                # 17 suites en verde antes de subir nada (16 no necesitan
                         # base de datos; la de Postgres corre con un simulado)
```

Reglas:
- **Parches y minors** (4.22.x → 4.22.y): se aplican directo si `npm test` pasa.
- **Majors** (express 4 → 5, socket.io 4 → 5): NUNCA en la rutina trimestral.
  Se planifican como una entrega propia, leyendo la guía de migración, porque
  cambian APIs que usa `server.js`.
- El cliente de Socket.IO que carga el navegador lo sirve el propio servidor
  (`/socket.io/socket.io.js`), así que servidor y cliente siempre viajan juntos.

## 2. Tamaño del store de perfiles

Depende de qué backend esté activo (Fase 10): si el log de arranque muestra
`"profileStore":".../profiles.json"` es el archivo; si muestra
`"profileStore":"postgres://..."` es Postgres (Neon u otro).

### Archivo JSON (sin `DATABASE_URL`)

El disco de Render es de 1 GB y `profiles.json` crece con cada jugador nuevo.

```bash
# en el Shell del servicio de Render:
ls -lh /var/data/profiles.json
node -e "const d=require('/var/data/profiles.json');console.log('perfiles:',(d.profiles||d).length)"
```

- Menos de 5 MB: todo bien (≈ miles de perfiles).
- Si crece demasiado: los perfiles con `chips` iniciales y sin actividad en
  90 días pueden depurarse (el reinicio mensual de temporada ya renueva los
  saldos, así que borrar inactivos no afecta el ranking).

### Postgres / Neon (con `DATABASE_URL`)

El free tier de Neon da 0.5 GB, muy por encima de lo que ocupan los perfiles
(unos pocos KB cada uno). Para revisar el tamaño, usa el *SQL Editor* del
panel de Neon:

```sql
SELECT count(*) AS perfiles, pg_size_pretty(pg_total_relation_size('montecristo_profiles')) AS tamano
FROM montecristo_profiles;
```

- Igual que con el archivo: perfiles inactivos 90+ días se pueden depurar con
  un `DELETE FROM montecristo_profiles WHERE (data->>'updatedAt')::bigint < ...`
  si algún día se acerca al límite del free tier — no es necesario hoy.

## 3. Presupuesto de rendimiento

`npm run test:performance` falla solo si algo se pasó del techo. Presupuestos
vigentes (definidos en `tests/performance-smoke.js`): primera carga < 300 KB
gzip, `lobby_state` y `room_state` < 30 KB por mensaje, `/healthz` < 250 ms.
Si un cambio legítimo los rebasa, se ajusta el número **en el mismo PR** y se
explica por qué.

## 4. Revisión rápida de Render

- Logs del servicio sin errores repetidos (`server_error`, reinicios en bucle).
- Métricas de memoria estables (< 400 MB en plan starter).
- El disco `/var/data` con espacio libre.
- Después de cada deploy: `https://<servicio>.onrender.com/healthz` responde `ok`.
