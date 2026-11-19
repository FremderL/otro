# MonteCristo — imagen de producción.
#
# Pensada para los hosts que corren un contenedor propio (Hetzner con Docker,
# Railway, Fly.io). No cambia nada de lo que ya hace `npm start`: el proceso
# escucha en 0.0.0.0:$PORT y sirve `public/` desde el sistema de archivos.
#
# Datos persistentes: monta un volumen en /var/data y apunta ahí las rutas
# (PROFILE_STORE_PATH, LOTERIA_STATE_PATH, FORTUNE_STATE_PATH,
# LOBBY_TOURNAMENT_STORE_PATH, FOOTBALL_STORE_PATH, PROMOTION_MEDIA_DIR),
# exactamente como en render.yaml.

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Solo dependencias de ejecución: ESLint, jsdom y socket.io-client son de
# desarrollo y no hacen falta en el servidor.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# El proyecto no tiene paso de compilación: se copia tal cual.
COPY . .

# Usuario sin privilegios; el volumen /var/data se crea con ese dueño para que
# los stores JSON puedan escribir aunque el volumen venga vacío.
RUN mkdir -p /var/data \
 && chown -R node:node /var/data /app

USER node
EXPOSE 3000

# El mismo health check que usa Render en render.yaml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
