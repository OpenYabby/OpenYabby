# ═══════════════════════════════════════════════════════
# YABBY — Dockerfile
# ═══════════════════════════════════════════════════════
# Multi-stage build. Claude CLI NOT included — use
# task forwarding for Docker deployments.

# ── Build stage ──
FROM node:22-alpine AS builder
WORKDIR /app

# Native build tools for better-sqlite3 (required by mem0ai)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --omit=dev

# ── Runtime stage ──
FROM node:22-alpine
WORKDIR /app

# Create non-root user
RUN addgroup -S yabby && adduser -S yabby -G yabby

# Copy dependencies
COPY --from=builder /app/node_modules ./node_modules

# Copy application
COPY . .

# Create logs directory
RUN mkdir -p logs && chown -R yabby:yabby /app

USER yabby

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
