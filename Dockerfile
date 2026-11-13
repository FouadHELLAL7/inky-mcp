# Multi-stage build, mirroring the WYRE-AI MCP server images.
FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./
# --ignore-scripts: no lifecycle scripts run before the source is copied.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine AS production

# Pull latest Alpine package fixes even when the base layer is cached.
RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S inky && adduser -S inky -u 1001 -G inky

WORKDIR /app
COPY --from=builder --chown=inky:inky /app/package.json ./
COPY --from=builder --chown=inky:inky /app/dist ./dist
COPY --from=builder --chown=inky:inky /app/node_modules ./node_modules

# npm/npx are not needed at runtime (CMD runs node directly).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER inky

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${MCP_HTTP_PORT:-8080}/health || exit 1

# Gateway defaults. 0.0.0.0 is safe only because HTTP startup refuses to
# listen without a real CONDUIT_S2S_SECRET; AUTH_MODE=gateway never falls back
# to environment credentials. Override MCP_TRANSPORT=stdio for local use.
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=8080 \
    MCP_HTTP_HOST=0.0.0.0 \
    AUTH_MODE=gateway

CMD ["node", "dist/index.js"]

ARG VERSION="1.0.0"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
LABEL io.modelcontextprotocol.server.name="io.github.FouadHELLAL7/inky-mcp" \
      org.opencontainers.image.title="inky-mcp" \
      org.opencontainers.image.description="MCP server for the INKY email security External API" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/FouadHELLAL7/inky-mcp" \
      org.opencontainers.image.licenses="Apache-2.0"
