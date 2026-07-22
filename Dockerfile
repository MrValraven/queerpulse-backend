# syntax=docker/dockerfile:1

# ---- Base: Node + pnpm (via corepack) --------------------------------------
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- Dependencies: full install (incl. dev) for the build ------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- Build: compile TypeScript -> dist/ ------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# ---- Prod deps: production-only node_modules for the runtime image ---------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- Runtime: minimal image running the compiled output --------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini as PID 1: forwards SIGTERM to node and reaps zombies. Without an init,
# node runs as PID 1, where the default signal dispositions do not apply — the
# platform's SIGTERM on redeploy risks skipping graceful shutdown (in-flight
# requests, socket drain, Sentry flush) until the kill timeout expires.
RUN apk add --no-cache tini

# package.json + lockfile are kept so `npm run migration:run:prod` works in the
# container (npm ships with Node; the typeorm bin is a production dependency).
COPY --chown=node:node package.json pnpm-lock.yaml ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
# One-off provisioning scripts (e.g. `npm run storage:cors`) run as deploy steps
# alongside migrations, so they must exist in the runtime image.
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 3000

# Deploy order is migrate -> apply-bucket-CORS -> start. Run the out-of-band
# steps before rollout (both are idempotent):
#   docker run ... npm run migration:run:prod
#   docker run ... npm run storage:cors
# then start the server (this default CMD). See README "Deployment".
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
