FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# download analytics log lives on a mounted volume in production
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
