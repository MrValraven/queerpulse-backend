# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

QueerPulse backend — a [NestJS](https://nestjs.com/) (v11) + TypeScript API for an
invite-only community platform. It is a full domain application (not a scaffold):
Google OAuth + JWT cookie auth, invite-gated membership and vouching, profiles,
connections, messaging (REST + socket.io chat), events with RSVPs, notifications,
S3 uploads, and Mux-backed video ("cinema").

Persistence is **PostgreSQL via TypeORM**. The schema is owned entirely by
migrations in `src/migrations` — `synchronize` is never enabled. Entities use the
`SnakeNamingStrategy`, so `firstName` ↔ `first_name`, `EventCohost` ↔
`event_cohosts`, etc.

## Package manager

Uses **pnpm** (see `pnpm-lock.yaml`). Use `pnpm`, not
`npm` or `yarn`. The repo pins `pnpm@9.15.0` via `package.json#packageManager`
and requires Node `>=20.11` (`package.json#engines`).

## Commands

```bash
pnpm install              # install dependencies
pnpm run start            # run once (no watch)
pnpm run start:dev        # run with watch/hot-reload (development)
pnpm run start:debug      # run with debugger attached + watch
pnpm run start:prod       # run compiled output (node dist/main)
pnpm run build            # nest build -> dist/
pnpm run lint             # eslint with --fix
pnpm run format           # prettier --write over src/ and test/

pnpm run test             # unit tests (*.spec.ts under src/)
pnpm run test:watch       # unit tests in watch mode
pnpm run test:cov         # unit tests with coverage -> coverage/
pnpm run test:e2e         # e2e tests (test/jest-e2e.json, runInBand)

# run a single unit test file / tests matching a name
pnpm run test -- src/auth/auth.service.spec.ts
pnpm run test -- -t "should return"

# database / migrations (schema is migration-owned; never synchronize)
pnpm run migration:run                    # apply pending migrations (dev, ts-node)
pnpm run migration:revert                 # revert the last migration
pnpm run migration:generate src/migrations/<Name>  # diff entities -> migration
pnpm run migration:create   src/migrations/<Name>  # empty migration
pnpm run migration:run:prod               # apply migrations from compiled dist/
pnpm run typeorm ...                       # raw TypeORM CLI (-d src/data-source.ts)
pnpm run seed                              # local fixture members (refuses NODE_ENV=production)
```

## Architecture

NestJS dependency-injection structure:

- `src/main.ts` — bootstrap: `cookie-parser`, `helmet`, CORS (credentialed,
  origin from `FRONTEND_URL`), a global `ValidationPipe`
  (`whitelist` + `forbidNonWhitelisted` + `transform`), `rawBody` for HMAC
  webhooks, shutdown hooks; listens on `PORT`.
- `src/app.module.ts` — root module. Loads config (`@nestjs/config`, validated),
  event emitter, scheduler, throttler, `DatabaseModule`, and the feature modules.
  Register new feature modules here.
- `src/config/*` — namespaced config factories (`app`, `database`, `auth`,
  `storage`, `mux`) plus `env.validation.ts` (class-validator, fails fast at boot).
- `src/database/database.module.ts` — TypeORM async root config: snake naming,
  `autoLoadEntities`, TLS (secure by default; see README) and pg pool/timeout
  tuning. `src/data-source.ts` backs the TypeORM CLI in both dev (ts-node/`src`)
  and prod (compiled `dist`).
- **Global guard chain** (bound via `APP_GUARD`): **Throttler → CSRF → JWT** —
  rate-limit first, then the double-submit CSRF check (`src/security`), then JWT
  auth (`src/auth`). `@Public()` opts a route out of auth; state-changing routes
  require a CSRF token.
- Feature modules (each with controllers, `@Injectable` services, TypeORM
  entities, and DTOs): `auth`, `users`, `profiles`, `membership`, `vouch`,
  `connections`, `messaging`, `chat` (socket.io gateway), `events`,
  `notifications`, `cinema`, `storage`, `security`, `health`. Cross-feature
  reactions go through `@nestjs/event-emitter` (e.g. notifications listen to
  domain events).

Unit tests are colocated as `*.spec.ts` next to source files (jest `rootDir` is
`src`; coverage excludes migrations, `main.ts`, and `*.module.ts`). E2e tests
live in `test/` and boot the full app via supertest against a real Postgres —
see the test-database safety guard below.

## Notes

- TypeScript (`tsconfig.json`) has `strictNullChecks`, `noImplicitAny`, and
  `strictBindCallApply` on; full `strict` is a deliberate follow-up (not yet
  enabled). ESLint promotes `@typescript-eslint/no-floating-promises` to `error`.
- The schema lives in migrations only. Add a migration for every schema change;
  never rely on `synchronize`.
- **An applied migration's name is frozen history — never rename or renumber
  it.** TypeORM identifies a migration solely by the `name` string on the class
  and matches it against the `migrations` ledger table. Renaming a migration
  that has already run anywhere makes it look *pending*, so `up()` re-runs and
  fails on objects it created the first time (e.g. `CREATE TYPE` — Postgres has
  no `CREATE TYPE IF NOT EXISTS`). Because pending migrations run in timestamp
  order, the failure also blocks every migration behind it. Duplicate
  timestamps between migrations are harmless — leave them alone rather than
  renumbering to break the tie. `1782800650000` is shared by `AddSubprofiles`
  and `AddProfileInterests` for exactly this reason.
- Guarding migration DDL with `IF [NOT] EXISTS` is **not** the fix for an
  "already exists" failure. It writes a second ledger row for work already
  recorded (making `down()` runnable twice against one application) and hides
  genuine schema drift — an object existing in the wrong *shape* would pass
  silently. Diagnose the ledger mismatch instead:
  `pnpm run typeorm migration:show`.
- `pnpm run typeorm` already passes `-d src/data-source.ts`. Passing `-d` again
  makes yargs hand `path.resolve` an array, and the command dies with an
  unrelated-looking `ERR_INVALID_ARG_TYPE`.
- **e2e safety:** `test/*.e2e-spec.ts` delete every table between tests. A guard
  (`test/db-safety.ts`, wired from `test/jest-e2e.json`) throws unless the target
  DB name ends in `_test` or `TEST_DATABASE_URL` is set. Use `.env.test` (see
  `.env.test.example`).
- CI (`.github/workflows/ci.yml`) runs lint → build → unit → e2e against a
  Postgres service container. Multi-stage `Dockerfile` + `docker-compose.yml`
  build and run the app; deploy order is migrate (`migration:run:prod`) → start.
