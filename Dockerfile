# syntax=docker/dockerfile:1
# Debian slim (glibc), not Alpine: the Temporal core-bridge native module ships glibc builds.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim

# ---- deps: full dependency tree for building --------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: compile TS, copy Lua scripts, pre-bundle workflow code ----------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- prod-deps: runtime dependencies only ------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HEALTHCHECK_URL=http://127.0.0.1:3000/health/live
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# dist/ contains compiled JS, dist/infra/lua/*.lua and dist/workflow-bundle.js
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "dist/healthcheck.js"]
# Default role is the API; the worker service overrides the command.
CMD ["node", "dist/api/server.js"]
