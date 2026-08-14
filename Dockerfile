# syntax=docker/dockerfile:1

# ── Stage 1: compile the TypeScript server ──────────────────────────────
FROM node:22-bookworm-slim AS node-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: production Node dependencies ───────────────────────────────
# dist/index.js imports the MCP SDK and Zod at runtime, so the runtime image
# needs production node_modules (and package.json — the server reads its
# version from it at startup).
FROM node:22-bookworm-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 3: Composer production dependencies ───────────────────────────
# Plugins and scripts are disabled: the install is deterministic and never
# executes package code (including civicrm/composer-compile-plugin).
# composer.lock is copied when present; it is generated later, never invented.
FROM composer:2.8 AS composer-install
WORKDIR /app
COPY composer.json ./
COPY composer.lock* ./
RUN composer install \
      --no-dev \
      --no-interaction \
      --no-progress \
      --no-scripts \
      --no-plugins \
      --optimize-autoloader \
 && mkdir -p vendor/retailcrm/api-client-php/models

# ── Stage 4: runtime — Node + PHP CLI/cURL, non-root ────────────────────
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      php-cli \
      php-curl \
      php-mbstring \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/node/.cache \
 && chown -R node:node /home/node

WORKDIR /app
COPY --from=composer-install --chown=node:node /app/vendor ./vendor
COPY composer.lock* ./
COPY --from=node-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json composer.json ./
COPY --from=node-build --chown=node:node /app/dist ./dist
COPY --chown=node:node bin/retailcrm-api.php ./bin/retailcrm-api.php

USER node

ENV NODE_ENV=production \
    RETAILCRM_PHP_BIN=php \
    RETAILCRM_PHP_BRIDGE=/app/bin/retailcrm-api.php

# stdio is the default entrypoint; append --http (with HOST/PORT env) for
# the Streamable HTTP transport, e.g.: docker run ... retailcrm-mcp --http
ENTRYPOINT ["node", "dist/index.js"]
