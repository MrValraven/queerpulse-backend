# QueerPulse Backend

The API for QueerPulse — an invite-only community platform. Built with
[NestJS](https://nestjs.com/) (v11) + TypeScript, PostgreSQL via
[TypeORM](https://typeorm.io/), Google OAuth + JWT cookie sessions, WebSocket
chat (socket.io), and Mux-backed video ("cinema").

## Prerequisites

- **Node.js** `>= 20.11`
- **pnpm** `>= 9` (this repo pins `pnpm@9.15.0` via `packageManager`; run
  `corepack enable` to have the right version selected automatically)
- **PostgreSQL** `>= 14` (16 recommended)

## Quickstart

```bash
# 1. Install dependencies (required — recent changes added new dependencies,
#    so re-run this even if you have an older node_modules).
pnpm install

# 2. Configure environment
cp .env.example .env
#    then edit .env — at minimum set DATABASE_URL and the JWT/Google values.

# 3. Create the schema (migrations own the schema; `synchronize` is never on)
pnpm run migration:run

# 4. (Optional) seed local fixture members
pnpm run seed

# 5. Run the API
pnpm run start:dev        # watch mode
```

The server listens on `PORT` (default `3000`). Health check:
`GET http://localhost:3000/health`.

## Environment variables

Copy `.env.example` and fill these in. Required values are validated at boot
(`src/config/env.validation.ts`) — the app refuses to start if any are missing
or malformed.

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `development` \| `production` \| `test` |
| `PORT` | yes | HTTP port (e.g. `3000`) |
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/db` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | yes | signing secrets |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | no | e.g. `15m` / `30d` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | yes | OAuth |
| `FRONTEND_URL` | no | CORS origin + post-login redirect base |
| `COOKIE_DOMAIN` | no | leave unset for localhost |
| `API_URL` | prod | this API's own public origin; required when `NODE_ENV=production` — see below |
| `ENDPOINT` / `REGION` / `BUCKET` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` | prod | Railway Buckets storage — see below |
| `MUX_*` | no | video features |
| `INVITE_MONTHLY_QUOTA` | no | membership tuning |

### Database TLS & connection pool

TLS defaults to **on in production with certificate verification enabled**. The
same settings apply to the app and to the migration CLI — both resolve TLS
through `src/config/database-ssl.ts`, so `migration:run:prod` can never connect
differently from the server it is migrating for.

> **Managed Postgres (Railway, Render, Fly, …): the default will not connect.**
> Verification-on TLS fails against these providers and the app crash-loops at
> boot with no useful error. Set one of:
>
> - `DATABASE_SSL=false` — reaching the DB over the provider's **private
>   network** (e.g. `postgres.railway.internal`), which speaks plaintext.
>   Traffic never leaves their network.
> - `DATABASE_SSL_INSECURE=true` — reaching it over a **public proxy /
>   external host**, which presents a self-signed cert. Still encrypted; only
>   certificate verification is skipped.
>
> Prefer `DATABASE_SSL_CA` wherever the provider publishes a CA bundle — that
> keeps verification on.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_SSL` | (prod → on) | explicit `true`/`false` override for TLS negotiation |
| `DATABASE_SSL_CA` | — | CA bundle: inline PEM or a file path |
| `DATABASE_SSL_INSECURE` | `false` | `true` keeps TLS but skips cert verification (self-signed managed Postgres) |
| `DATABASE_POOL_MAX` | `10` | max pool connections |
| `DATABASE_POOL_MIN` | `0` | min pool connections |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `10000` | acquire timeout |
| `DATABASE_IDLE_TIMEOUT_MS` | `30000` | idle client timeout |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000` | per-statement server timeout |

### Observability / feature flags

| Variable | Notes |
| --- | --- |
| `SENTRY_DSN` | enables Sentry error reporting when set |
| `LOG_LEVEL` | pino level (`info`, `debug`, …) |
| `LOG_PRETTY` | `true` for pino-pretty output; defaults on when `NODE_ENV=development`. **Never set in a deployed environment** — `pino-pretty` is a devDependency, absent from the production image, and selecting it crashes at boot |
| `ENABLE_SWAGGER` | serve the OpenAPI/Swagger UI when set |

### Object storage — Railway Buckets

Uploads (avatars, work images, story covers, gathering photos) go to a
[Railway Bucket](https://docs.railway.com/reference/buckets) — S3-compatible
object storage, kept **private** (no public URL). Linking a Bucket to this
service in the Railway dashboard auto-injects all five variables below; set
them by hand only for local development.

| Variable | Notes |
| --- | --- |
| `ENDPOINT` | e.g. `https://storage.railway.app` |
| `REGION` | Railway's buckets are region `auto` — do not guess a different region |
| `BUCKET` | bucket name |
| `ACCESS_KEY_ID` | |
| `SECRET_ACCESS_KEY` | |

These five are **required when `NODE_ENV=production`** — boot fails without
all of them rather than letting every upload route fail at runtime on a server
that reports itself healthy.

Images are never served from a public bucket URL. The client uploads via a
presigned `PUT`, then sends the object's storage `key` back on the normal
domain payload; the server resolves that key to `GET /files/<key>` — an
authenticated route on this API — whenever it builds a response containing an
image.

`API_URL` (this API's own public origin) **must be set in production** — every
`GET /files/<key>` URL in a response is built from it, so a wrong or missing
value silently produces unreachable images rather than an error.

## Database & migrations

The schema is owned entirely by migrations under `src/migrations`. **Never**
enable `synchronize`.

> **An applied migration's name is frozen history — never rename or renumber
> one.** TypeORM identifies a migration solely by the `name` string on its class
> and matches that against the `migrations` ledger table. Renaming one that has
> already run anywhere makes it look *pending*, so `up()` re-runs and fails on
> objects it created the first time. Because pending migrations run in timestamp
> order, that failure blocks every migration behind it too.
>
> Duplicate timestamps are **harmless** — ties fall back to filename order.
> `1782800650000` is deliberately shared by `AddSubprofiles` and
> `AddProfileInterests`; leave it alone rather than renumbering to break the tie.
>
> If you hit an "already exists" failure, do **not** paper over it with
> `IF NOT EXISTS` — that writes a second ledger row for work already recorded and
> hides genuine schema drift. Diagnose the ledger mismatch instead:
> `pnpm run typeorm migration:show`.

```bash
pnpm run migration:run                     # apply pending migrations (dev, ts-node)
pnpm run migration:revert                   # revert the last migration
pnpm run migration:generate src/migrations/<Name>   # diff entities -> migration
pnpm run migration:create   src/migrations/<Name>   # empty migration
pnpm run migration:run:prod                 # apply migrations from compiled dist/
pnpm run seed                               # local fixture members (refuses NODE_ENV=production)
```

`pnpm run typeorm ...` is the raw CLI wrapper (`-d src/data-source.ts`). The
`*:prod` variants run the TypeORM CLI against `dist/data-source.js` and are what
you use in a built/containerized deploy.

## Running

```bash
pnpm run start:dev        # watch/hot-reload
pnpm run start            # run once (no watch)
pnpm run build            # compile to dist/
pnpm run start:prod       # node dist/main (from a build)
```

## Tests

```bash
pnpm run test             # unit tests (*.spec.ts, colocated under src/)
pnpm run test:cov         # unit tests + coverage
pnpm run test:e2e         # e2e tests (boots the full app, runInBand)
```

### e2e test database safety

The e2e suites (`test/*.e2e-spec.ts`) **delete every table between tests**. A
guard (`test/db-safety.ts`, wired via `test/jest-e2e.json`) refuses to run
unless the target database name ends in `_test`, or a dedicated
`TEST_DATABASE_URL` is set.

```bash
cp .env.test.example .env.test    # point DATABASE_URL at a *_test database
createdb queerpulse_test          # (or however you provision it)
pnpm run migration:run            # with DATABASE_URL pointing at the test DB
pnpm run test:e2e
```

`.env.test` overrides `.env` for e2e runs; any variable it omits falls back to
`.env`. `.env.test` is git-ignored.

## Deployment

Order matters: **build → migrate → start**.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run migration:run:prod        # apply migrations against the target DB
pnpm run start:prod                # node dist/main
```

Run `migration:run:prod` as a discrete step before rolling out new app
instances so the schema is in place before any new code serves traffic.

> After dependency changes, run `pnpm install` and **commit the updated
> `pnpm-lock.yaml`** — CI installs with `--frozen-lockfile` and fails on a stale
> lockfile.

### Run exactly ONE replica

The app holds shared state in process and has no distributed backing store. At
two or more replicas these break, quietly:

| State | Where | Effect at N replicas |
| --- | --- | --- |
| Rate-limit counters | `ThrottlerModule` (in-memory) | every limit becomes N× — including the 10/60s on `POST /auth/refresh`, the only abuse control there |
| Socket.io rooms / session revocation | `ChatGateway` (no Redis adapter) | a logged-out or **suspended** member keeps a live socket on every instance that didn't handle the logout |
| Chat presence | `PresenceService` (in-memory `Map`) | members appear offline to anyone on another instance |
| WS rate limiter | `TokenBucketLimiter` (process-local) | per-socket limits multiply by N |
| Cron jobs | `@nestjs/schedule` | every replica runs every job — the event-reminder claim is race-safe, the refresh purge is idempotent, but nothing else is guaranteed |

Scaling out requires a shared store: `@nest-lab/throttler-storage-redis` for the
throttler, `@socket.io/redis-adapter` via `app.useWebSocketAdapter` for the
gateway and presence, and a distributed lock (or a dedicated worker) for the
crons. Until then, keep the replica count at 1.

### Health probes

- `GET /health` — full check incl. DB ping (backwards-compatible)
- `GET /health/live` — liveness (no external deps)
- `GET /health/ready` — readiness (DB reachable)

## Docker

```bash
docker compose up --build     # app + postgres; app migrates then starts
```

Or build just the image (multi-stage; runs `node dist/main`):

```bash
docker build -t queerpulse-backend .
docker run --rm -p 3000:3000 --env-file .env queerpulse-backend
# migrate first: docker run --rm --env-file .env queerpulse-backend npm run migration:run:prod
```

## CI

`.github/workflows/ci.yml` runs on push/PR to `main`: pnpm install → lint →
build → unit tests → e2e against a Postgres service container using a
`queerpulse_test` database. Node and pnpm versions are pinned.
