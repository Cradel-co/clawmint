# ── Stage 1: Build del cliente ────────────────────────────────────────────────
FROM node:22-slim AS client-build

WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2: Server con node-pty ─────────────────────────────────────────────
FROM node:22-slim

# Dependencias para compilar node-pty
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# Copiar código del server
COPY server/ ./

# Copiar build del client
COPY --from=client-build /app/client/dist /app/client/dist

# Entrypoint para inicializar datos persistentes
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--stack-size=65536", "index.js"]
