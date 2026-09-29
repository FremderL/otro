# Despliegue 100% gratis: Render Free + Neon Free

MonteCristo usa fichas 100% virtuales. Esta receta no requiere blueprint, disco persistente de Render ni tarjeta bancaria. El servicio web de Render sigue siendo efímero para salas y archivos, pero los perfiles se guardan en Neon mediante `DATABASE_URL`.

## 1. Crear la base en Neon

1. Entra en [Neon](https://neon.tech/) y crea una cuenta/proyecto en el plan **Free**.
2. Elige una región cercana a la de Render y crea la base de datos por defecto.
3. En el panel de Neon pulsa **Connect**, selecciona Node.js y copia la cadena de conexión completa. Debe empezar por `postgresql://` y normalmente incluye `sslmode=require`.
4. Guarda esa cadena como secreto: no la publiques en el repositorio ni en el chat.

La aplicación crea automáticamente la tabla `montecristo_profiles` en el primer arranque. Para importar el `data/profiles.json` local antes de publicar:

```bash
DATABASE_URL='postgresql://...' npm run migrate:profiles
```

También se puede migrar desde una máquina que tenga el archivo y Node.js instalado. El script es idempotente: vuelve a ejecutar la importación actualizando los mismos IDs.

## 2. Crear el Web Service a mano en Render

1. En Render selecciona **New → Web Service** y conecta el repositorio de GitHub.
2. Selecciona la rama que contiene esta versión y configura:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
3. No añadas un Persistent Disk y no uses un Blueprint.
4. En la pantalla **Environment**, pulsa **Add Environment Variable** y añade:
   - **Key:** `DATABASE_URL`
   - **Value:** pega la cadena completa copiada de Neon
5. Guarda y pulsa **Create Web Service**. Render hará el build y arrancará el servicio.

`PORT` no hace falta configurarlo: Render lo proporciona y el servidor escucha en `0.0.0.0`. La ruta `/health` permite comprobar que está vivo.

## 3. Verificar la publicación

Abre `https://TU-SERVICIO.onrender.com/health`; debe responder un JSON con `ok: true`. Después abre la URL principal, crea un perfil y reinicia el servicio desde Render. El perfil debe conservar sus fichas, estadísticas y bono diario.

En los logs debe aparecer `Mesa Amiga lista...`. Si aparece un error de conexión, revisa que `DATABASE_URL` esté pegada en **Environment** del Web Service, sin comillas, sin espacios y con la cadena del proyecto correcto de Neon.

## Notas del plan gratuito

- Render Free puede suspender el servicio después de inactividad; el primer acceso posterior puede tardar.
- Neon Free puede suspender la base cuando no se usa. El primer acceso puede tener latencia adicional.
- El plan Free tiene límites de horas, almacenamiento, conexiones y transferencia que pueden cambiar. Revisa los paneles de Render y Neon antes de una campaña con muchos jugadores.
- Las salas, bots y partidas activas viven en memoria y se pierden al reiniciar o suspender Render. Los perfiles son la única parte persistida en Neon.
- Para una instancia única no hace falta Redis. Varias instancias necesitarían además un adaptador compartido de Socket.IO y una coordinación de salas.

## Volver a JSON local

Si se elimina `DATABASE_URL`, el servidor vuelve automáticamente a `data/profiles.json`; no cambia el flujo local ni las pruebas existentes. `PROFILE_STORE_PATH` sigue permitiendo apuntar a un JSON temporal durante pruebas.
