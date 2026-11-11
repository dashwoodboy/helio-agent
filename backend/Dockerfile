# Deye backend — Fastify + TypeScript (run with tsx, no build step)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

# su-exec: the entrypoint starts as root (to read root-owned TLS cert mounts)
# and drops to the "node" user before running the app.
RUN apk add --no-cache su-exec
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 3001 = HTTP API, 10000 = logger gateway (Solarman sticks connect here)
EXPOSE 3001 10000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
