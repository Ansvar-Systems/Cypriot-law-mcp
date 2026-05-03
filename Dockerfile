# Cypriot Law MCP — HTTP transport
#
# Two-image pattern (per MCP Infrastructure Standard §3.4.4):
#
#   * cypriot-law-mcp-data:latest   — populated SQLite DB. Built weekly
#                                     by .github/workflows/refresh-data.yml
#                                     using Dockerfile.data. Hits EU servers.
#   * cypriot-law-mcp:latest        — this image. Pulls the DB from above.
#                                     Build does NO external HTTP.
#
# Refreshing data and shipping a code change are independent operations.
# A single EU outage cannot block code releases, and a code release no
# longer hammers cysec.gov.cy / EUR-Lex / gdprhub.eu.

# ── Data layer (pre-built, refreshed on a separate schedule) ────────────
FROM ghcr.io/ansvar-systems/cypriot-law-mcp-data:latest AS data

# ── Stage 1: Build code ─────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Non-root system user with explicit UID/GID 1001 (§3.1)
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nodejs -G nodejs

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=data /database.db ./data/database.db

RUN chown -R nodejs:nodejs /app/data
USER nodejs

ENV NODE_ENV=production \
    PORT=3000

# §13.3 — fleet-canonical healthcheck pattern
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http-server.js"]
