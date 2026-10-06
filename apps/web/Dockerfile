# Build from the REPO ROOT (npm workspaces): docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=apps/web
COPY apps/web apps/web
# NEXT_PUBLIC_* vars are baked into the client bundle at BUILD time
ARG NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
# Self-hosted Umami. Both must be set for analytics to render at all; leaving
# them unset ships no tracker and no analytics origin in the CSP.
ARG NEXT_PUBLIC_UMAMI_SRC
ENV NEXT_PUBLIC_UMAMI_SRC=$NEXT_PUBLIC_UMAMI_SRC
ARG NEXT_PUBLIC_UMAMI_WEBSITE_ID
ENV NEXT_PUBLIC_UMAMI_WEBSITE_ID=$NEXT_PUBLIC_UMAMI_WEBSITE_ID
# Code-retention window shown in the privacy policy. Must match the backend's
# CONTEXT_RETENTION_HOURS, since the policy states it as a fact.
ARG NEXT_PUBLIC_CODE_RETENTION_HOURS
ENV NEXT_PUBLIC_CODE_RETENTION_HOURS=$NEXT_PUBLIC_CODE_RETENTION_HOURS
RUN npm run --workspace=apps/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# Standalone output mirrors the monorepo layout: server.js lives under apps/web/
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
