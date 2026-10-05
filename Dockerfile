FROM node:22-slim

WORKDIR /app
COPY package*.json ./
# Instala dependencias; ffmpeg-static descarga aquí el binario de FFmpeg
# (la misma versión con la que se prueba la app).
RUN npm ci --omit=dev \
  && node -e "const p=require('ffmpeg-static'); require('fs').accessSync(p); console.log('FFmpeg:', p)"
COPY . .

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
