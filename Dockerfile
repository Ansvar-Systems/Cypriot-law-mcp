# Cypriot Law MCP — HTTP transport
# Conforms to MCP Infrastructure & Deployment Standard §3 + §13.

# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY data ./data
COPY scripts ./scripts

RUN npm run build && npm run build:db

# ── Stage 2: Runtime ────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Non-root system user with explicit UID/GID 1001 (§3.1)
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nodejs -G nodejs

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data/database.db ./data/database.db

RUN chown -R nodejs:nodejs /app/data
USER nodejs

ENV NODE_ENV=production \
    PORT=3000

# §13.3 — fleet-canonical healthcheck pattern
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http-server.js"]
