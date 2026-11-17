# Optional Express server that serves ../docs with a shared cache + download proxy.
FROM node:22-alpine

WORKDIR /app/azyron-website
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0

COPY azyron-website/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY docs /app/docs
COPY azyron-website /app/azyron-website

RUN mkdir -p /app/azyron-website/data
VOLUME ["/app/azyron-website/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
