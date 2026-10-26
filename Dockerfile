# syntax=docker/dockerfile:1

# ---- Base: Node + pnpm (via corepack) --------------------------------------
FROM node:22-alpine AS base
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

# ---- Dev: local development image for `docker compose up` ------------------
# The `api` service in docker-compose.yml builds this stage. It carries the
# toolchain only: the repo is bind-mounted at /app, node_modules and the pnpm
# store live in named volumes, and `scripts/dev-setup.mjs --container` installs
# dependencies, prepares the databases and the bucket, then runs
# `pnpm start:dev` with hot reload.
#
# KEEP THIS STAGE ABOVE `runtime`. Railway builds this Dockerfile with no
# target (railway.json), and a build with no target produces the LAST stage, so
# `runtime` has to stay the final stage. Nothing in `runtime` reads from `dev`,
# so BuildKit skips this stage entirely on a production build.
FROM base AS dev
# psql and pg_dump 16 match the postgres:16 service, for the database import
# and setup scripts. tini as PID 1 forwards Ctrl-C and `docker compose stop` to
# node and reaps the watcher's child processes.
RUN apk add --no-cache postgresql16-client tini
# Corepack fetches the pnpm version pinned in package.json on first use; skip
# its interactive "download pnpm?" prompt inside the container.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The pnpm store sits in its own named volume (`pnpm-store` in
# docker-compose.yml), so a recreated container reinstalls from the cache.
ENV npm_config_store_dir=/pnpm/store
WORKDIR /app
# 3000 is the API. 9229 is the Node inspector, for a debugger attached to
# `nest start --debug 0.0.0.0:9229 --watch`.
EXPOSE 3000 9229
ENTRYPOINT ["/sbin/tini", "--"]

# ---- Runtime: minimal image running the compiled output --------------------
# The LAST stage on purpose: Railway builds with no target (see `dev` above).
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# Silence npm's "new version available" notice. The deploy steps below invoke
# `npm run ...` (migrate, storage:cors, preflight); npm prints the update notice
# to stderr on each run, which Railway surfaces in the logs as if it were an
# error. This is cosmetic only — we deliberately do NOT bump npm here.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
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

# Deploy order is preflight -> reconcile-ledger -> migrate -> apply-bucket-CORS
# -> start. Run the out-of-band steps before rollout (all idempotent):
#   docker run ... npm run migration:preflight        # drop leftover INVALID indexes
#   docker run ... npm run migration:reconcile:prod   # repair renamed ledger rows
#   docker run ... npm run migration:run:prod
#   docker run ... npm run storage:cors
# then start the server (this default CMD). The preflight guards the CONCURRENTLY
# index migrations (transaction=false): an interrupted CONCURRENTLY build leaves
# an invalid, unrecorded index whose name then collides with the retry's rebuild
# ("already exists"); the preflight drops it so the retry succeeds. These
# migrations avoid `IF NOT EXISTS` on purpose (it hides drift — see CLAUDE.md).
# `migration:reconcile:prod` renames ledger rows recorded under a migration class
# name no build carries any more, which the stock TypeORM CLI in the next step
# would otherwise read as pending and re-run against a schema that already has
# the change (see src/database/renamed-migrations.ts).
# See README "Deployment".
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
