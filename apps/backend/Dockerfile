# Build from the REPO ROOT (npm workspaces): docker build -f apps/backend/Dockerfile .
FROM node:22-alpine AS build
# Prisma engines need openssl on alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
RUN npm ci --workspace=apps/backend
COPY apps/backend apps/backend
RUN npm run --workspace=apps/backend prisma:generate \
  && npm run --workspace=apps/backend build \
  # workspaces split deps between root and workspace node_modules — the
  # runtime stage copies both; guarantee the dir exists for the COPY
  && mkdir -p apps/backend/node_modules

FROM node:22-alpine
RUN apk add --no-cache openssl
# The Semgrep SAST probe is opt-in per repo (`security.semgrep`) and off by
# default, so the binary is not shipped unless asked for. Build with
# `--build-arg INSTALL_SEMGREP=true` to bake it in; otherwise set SEMGREP_BIN to
# a binary mounted into the container, or the probe auto-skips.
ARG INSTALL_SEMGREP=false
RUN if [ "$INSTALL_SEMGREP" = "true" ]; then \
      apk add --no-cache python3 py3-pip && \
      pip install --break-system-packages --no-cache-dir semgrep; \
    fi
ENV NODE_ENV=production
WORKDIR /app
# Keep the full workspace node_modules: it includes the generated Prisma client
# and the prisma CLI, which the entrypoint uses for `migrate deploy` on boot.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build --chown=node:node /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build --chown=node:node /app/apps/backend/dist ./apps/backend/dist
COPY --chown=node:node apps/backend/prisma ./apps/backend/prisma

EXPOSE 4000
WORKDIR /app/apps/backend
USER node
# Apply pending migrations, then start the API (+ worker + poller, same process)
CMD ["sh", "-c", "npx --no-install prisma migrate deploy --schema prisma/schema.prisma && node dist/index.js"]
