# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

QueerPulse backend — a [NestJS](https://nestjs.com/) (v11) application written in TypeScript. The repository is currently the default NestJS starter scaffold (`AppModule` / `AppController` / `AppService`); real domain code has not been added yet.

## Package manager

Uses **pnpm** (see `pnpm-lock.yaml` and `pnpm-workspace.yaml`). Use `pnpm`, not `npm` or `yarn`.

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
pnpm run test:debug       # jest --runInBand under node --inspect-brk
pnpm run test:e2e         # e2e tests (test/jest-e2e.json)

# run a single unit test file
pnpm run test -- src/app.controller.spec.ts
# run tests matching a name
pnpm run test -- -t "should return"
```

## Architecture

NestJS dependency-injection structure:

- `src/main.ts` — bootstrap; creates the Nest app and listens on `process.env.PORT ?? 3000`.
- `src/app.module.ts` — root module; register new feature modules, controllers, and providers here (or import feature modules).
- Controllers (`*.controller.ts`) handle HTTP routing; services (`*.service.ts`, `@Injectable`) hold business logic and are injected into controllers.

Unit tests are colocated as `*.spec.ts` next to source files (jest `rootDir` is `src`). E2e tests live in `test/` and use a separate Jest config that boots the full app via supertest.

## Notes

- TypeScript config (`tsconfig.json`) has `strictNullChecks` on but `noImplicitAny` off and `strict` not fully enabled.
- `pnpm-workspace.yaml` has `allowBuilds.unrs-resolver: set this to true or false` — a placeholder string left from scaffolding. Replace with a real boolean (`true`/`false`) before relying on it.
